import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { hash, scan } from '../core/files';
import { extractMcp, mergeMcp, validateMcpFragment } from '../core/mcp';
import { SyncEngine } from '../core/sync';
import { startPeer, fetchSnapshot } from '../core/peer';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-sync-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  return { root, home, backups: path.join(root, 'backups') };
}
function snapshot(relative: string, content: string) {
  return { version: 2, files: [{ path: relative, content, hash: hash(content) }], skipped: [] };
}
const definition = { demo: { command: 'demo', args: ['--read-only'] } };

test('scan sends only MCP definitions, not private settings, history, permissions, or model', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, '.claude.json'), JSON.stringify({
    mcpServers: definition, model: 'PRIVATE_MODEL', history: ['PRIVATE_HISTORY'],
    permissions: { allow: ['PRIVATE_PERMISSION'] }, apiKey: 'PRIVATE_API_KEY',
    projects: { '/private/project': { mcpServers: { hidden: { command: 'PRIVATE_PROJECT_MCP' } } } },
  }));
  const result = await scan(f.home);
  assert.equal(result.files.length, 1);
  assert.deepEqual(JSON.parse(result.files[0]!.content), { mcpServers: definition });
  for (const value of ['PRIVATE_MODEL', 'PRIVATE_HISTORY', 'PRIVATE_PERMISSION', 'PRIVATE_API_KEY', 'PRIVATE_PROJECT_MCP']) assert.ok(!JSON.stringify(result).includes(value));
});
test('files with no MCP section do not appear, even if they contain private preferences', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, '.claude/settings.json'), '{"model":"private", "apiKey":"private-key"}');
  assert.deepEqual(await scan(f.home), { files: [], skipped: [] });
});
test('JSONC MCP extraction and merge preserve other local setting values and local-only services', () => {
  const relative = '.config/opencode/opencode.jsonc';
  const source = '{ // PRIVATE_COMMENT\n model: "PRIVATE_MODEL", provider: {secret: "PRIVATE_PROVIDER"}, mcp: {demo: {type: "local", command: ["demo"]}}, }';
  const fragment = extractMcp(relative, source)!;
  assert.ok(!fragment.includes('PRIVATE_'));
  const target = '{ // local comment\n model:"my-model", permission:{bash:"ask"}, mcp:{localOnly:{enabled:false}}, }';
  const merged = JSON.parse(mergeMcp(relative, target, fragment));
  assert.equal(merged.model, 'my-model');
  assert.deepEqual(merged.permission, { bash: 'ask' });
  assert.deepEqual(merged.mcp.localOnly, { enabled: false });
  assert.deepEqual(merged.mcp.demo.command, ['demo']);
});
test('TOML transfers only mcp_servers and preserves unrelated values, integer precision, and floats', () => {
  const relative = '.codex/config.toml';
  const source = 'model = "PRIVATE_MODEL"\napi_key = "PRIVATE_KEY"\n[mcp_servers.demo]\ncommand = "demo"\nstartup_timeout_sec = 30\n[mcp_servers.demo.env]\nAPI_KEY = "${DEMO_API_KEY}"\n';
  const fragment = extractMcp(relative, source)!;
  assert.ok(!fragment.includes('PRIVATE_'));
  const target = 'model = "my-model"\nbig = 9223372036854775807\nfloat = 1.0\n[permissions]\nmode = "ask"\n[mcp_servers.localOnly]\ncommand = "keep"\n';
  const before = parseToml(target, { integersAsBigInt: true });
  const after = parseToml(mergeMcp(relative, target, fragment), { integersAsBigInt: true });
  for (const key of ['model', 'big', 'float', 'permissions']) assert.deepEqual(after[key], before[key]);
  assert.equal(typeof after.float, 'number');
  assert.equal(after.big, 9223372036854775807n);
  const mcp = after.mcp_servers as Record<string, Record<string, unknown>>;
  assert.equal(mcp.localOnly?.command, 'keep');
  assert.equal(mcp.demo?.startup_timeout_sec, 30n);
});
test('unsupported local TOML dates fail closed instead of changing non-MCP values', () => {
  assert.throws(() => mergeMcp('.codex/config.toml', 'timestamp = 1979-05-27T07:32:00.123456Z\n', '{"mcp_servers":{"demo":{"command":"demo"}}}'));
});
test('MCP merge preserves local preferences and credentials, replaces same-name service and saves raw backup', async t => {
  const f = await fixture(t);
  const relative = '.claude/settings.json';
  const original = JSON.stringify({ model: 'local-model', apiKey: 'local-private-key', permissions: { allow: ['local-only'] }, mcpServers: { demo: { command: 'old' }, localOnly: { command: 'local', env: { TOKEN: 'local-secret' } } } });
  await writeFile(path.join(f.home, relative), original);
  const engine = new SyncEngine(f.home, f.backups);
  const plan = await engine.preview(snapshot(relative, JSON.stringify({ mcpServers: definition })));
  assert.equal(plan.rows[0]?.kind, 'MCP');
  assert.ok(!plan.rows[0]!.local.includes('local-model'));
  assert.ok(!plan.rows[0]!.local.includes('local-private-key'));
  const result = await engine.apply(plan.id, [relative]);
  const merged = JSON.parse(await readFile(path.join(f.home, relative), 'utf8'));
  assert.equal(merged.model, 'local-model');
  assert.equal(merged.apiKey, 'local-private-key');
  assert.deepEqual(merged.permissions, { allow: ['local-only'] });
  assert.deepEqual(merged.mcpServers.demo, definition.demo);
  assert.equal(merged.mcpServers.localOnly.env.TOKEN, 'local-secret');
  assert.equal(await readFile(path.join(result.backupDirectory, relative), 'utf8'), original);
});
test('new MCP section is merged into an existing private document without erasing its settings', async t => {
  const f = await fixture(t);
  const relative = '.claude/settings.json';
  await writeFile(path.join(f.home, relative), '{"model":"local", "apiKey":"local-secret"}');
  const engine = new SyncEngine(f.home, f.backups);
  const plan = await engine.preview(snapshot(relative, JSON.stringify({ mcpServers: definition })));
  assert.equal(plan.rows[0]?.status, '新增');
  await engine.apply(plan.id, [relative]);
  const result = JSON.parse(await readFile(path.join(f.home, relative), 'utf8'));
  assert.equal(result.model, 'local');
  assert.equal(result.apiKey, 'local-secret');
  assert.deepEqual(result.mcpServers, definition);
});
test('changes to private local settings after preview also stop the entire write', async t => {
  const f = await fixture(t);
  const relative = '.claude/settings.json';
  await writeFile(path.join(f.home, relative), '{"model":"local"}');
  const engine = new SyncEngine(f.home, f.backups);
  const plan = await engine.preview(snapshot(relative, JSON.stringify({ mcpServers: definition })));
  await writeFile(path.join(f.home, relative), '{"model":"edited"}');
  await assert.rejects(engine.apply(plan.id, [relative]), /已变化/);
  assert.equal(await readFile(path.join(f.home, relative), 'utf8'), '{"model":"edited"}');
});
test('local-only MCP services do not create a false conflict', async t => {
  const f = await fixture(t);
  const relative = '.claude/settings.json';
  await writeFile(path.join(f.home, relative), JSON.stringify({ mcpServers: { ...definition, extra: { command: 'keep' } } }));
  const plan = await new SyncEngine(f.home, f.backups).preview(snapshot(relative, JSON.stringify({ mcpServers: definition })));
  assert.equal(plan.rows[0]?.status, '相同');
});
test('rejects old snapshots and fragments containing non-MCP fields or prototype keys', async t => {
  const f = await fixture(t);
  const engine = new SyncEngine(f.home, f.backups);
  await assert.rejects(engine.preview({ version: 1, files: [] }), /版本/);
  await assert.rejects(engine.preview(snapshot('.claude/settings.json', '{"model":"DO_NOT_ACCEPT", "mcpServers":{}}')), /MCP 以外/);
  for (const content of ['{"mcpServers":{"__proto__":{"command":"bad"}}}', '{"mcpServers":[],"model":"bad"}', '{"mcpServers":{"demo":"not-a-definition"}}']) assert.throws(() => validateMcpFragment('.claude/settings.json', content));
});
test('malformed source and credential-bearing MCP entries never leak raw content or parser diagnostics', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, '.claude/settings.json'), 'PRIVATE_INVALID_SOURCE_SECRET');
  let result = await scan(f.home);
  assert.equal(result.files.length, 0);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_INVALID_SOURCE_SECRET'));
  await writeFile(path.join(f.home, '.claude/settings.json'), '{"mcpServers":{"demo":{"env":{"API_KEY":"PRIVATE_SECRET"}}}}');
  result = await scan(f.home);
  assert.equal(result.files.length, 0);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SECRET'));
});
test('HTTP v2 wire excludes private settings; v1 endpoint is disabled', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, '.claude/settings.json'), JSON.stringify({ model: 'WIRE_PRIVATE_MODEL', permissions: ['WIRE_PRIVATE_PERMISSIONS'], mcpServers: definition }));
  const probe = http.createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const token = randomBytes(32).toString('hex');
  const server = await startPeer(f.home, '127.0.0.1', port, token, true);
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const wire = JSON.stringify(await fetchSnapshot({ host: '127.0.0.1', port, token }, true));
  assert.ok(!wire.includes('WIRE_PRIVATE_'));
  assert.ok(wire.includes('demo'));
  const status = await new Promise<number | undefined>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/v1/snapshot', headers: { Authorization: `Bearer ${token}` } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 404);
});
