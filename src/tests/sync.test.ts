import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { assertSafeContent, describe, hash, readLocal, scan } from '../core/files';
import { fetchSnapshot, isTailnetIPv4, startPeer, validateEndpoint } from '../core/peer';
import { SyncEngine } from '../core/sync';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-sync-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await mkdir(path.join(home, '.claude/skills/demo'), { recursive: true });
  return { root, home, file: '.claude/skills/demo/SKILL.md', backups: path.join(root, 'backups') };
}
function snapshot(file: string, content: string) { return { version: 2, files: [{ path: file, content, hash: hash(content) }], skipped: [] }; }

test('whitelist rejects traversal, private paths, hidden skill files and credentials', () => {
  for (const file of ['../.ssh/id_rsa', '/tmp/test', '.claude/skills/../../auth.json', '.codex/auth.json', '.claude/skills/a/.env', '.claude/skills/a/credentials.json', '.claude/skills/a\\x', '.claude/skills/a//b']) assert.throws(() => describe(file));
  assert.equal(describe('.claude.json').agent, 'Claude Code');
  assert.equal(describe('.codex/config.toml').kind, 'MCP');
});
test('secret heuristic blocks embedded credentials but allows environment references', () => {
  for (const value of ['{"API_KEY":"real-key"}', 'token = "abc123"', '-----BEGIN RSA PRIVATE KEY-----']) assert.throws(() => assertSafeContent(value));
  assert.doesNotThrow(() => assertSafeContent('{"API_KEY":"${API_KEY}"}'));
  assert.throws(() => assertSafeContent('binary\0'));
});
test('scan includes skills and MCP configuration but excludes unsafe content', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, f.file), '# Demo');
  await writeFile(path.join(f.home, '.claude/settings.json'), '{"model":"private-model", "mcpServers":{"demo":{"command":"demo"}}}');
  await writeFile(path.join(f.home, '.claude/skills/demo/key.json'), '{"token":"secret-value"}');
  const result = await scan(f.home);
  assert.equal(result.files.length, 2);
  assert.ok(result.skipped.some(s => s.includes('key.json')));
});
test('symlinked files and parent directories are never read', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'outside'), 'private');
  await symlink(path.join(f.root, 'outside'), path.join(f.home, f.file));
  await assert.rejects(readLocal(f.home, f.file), /符号链接/);
  await symlink(f.root, path.join(f.home, '.claude/skills/link'));
  await assert.rejects(readLocal(f.home, '.claude/skills/link/outside'), /符号链接/);
});
test('preview and apply back up overwritten content, preserve other files and expire plan', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, f.file), 'old');
  const engine = new SyncEngine(f.home, f.backups);
  const plan = await engine.preview(snapshot(f.file, 'new'));
  assert.equal(plan.rows[0]?.status, '不同');
  const applied = await engine.apply(plan.id, [f.file]);
  assert.equal(applied.count, 1);
  assert.equal(await readFile(path.join(f.home, f.file), 'utf8'), 'new');
  assert.equal(await readFile(path.join(applied.backupDirectory, f.file), 'utf8'), 'old');
  await assert.rejects(engine.apply(plan.id, [f.file]), /失效/);
});
test('local edits after preview stop overwrite before backup or write', async t => {
  const f = await fixture(t);
  const engine = new SyncEngine(f.home, f.backups);
  const plan = await engine.preview(snapshot(f.file, 'remote'));
  await writeFile(path.join(f.home, f.file), 'edited locally');
  await assert.rejects(engine.apply(plan.id, [f.file]), /已变化/);
  assert.equal(await readFile(path.join(f.home, f.file), 'utf8'), 'edited locally');
});
test('rejects malicious, corrupt and duplicate snapshots', async t => {
  const f = await fixture(t);
  const engine = new SyncEngine(f.home, f.backups);
  await assert.rejects(engine.preview(snapshot('../../x', 'bad')));
  await assert.rejects(engine.preview({ version: 2, files: [{ path: f.file, content: 'x', hash: 'bad' }] }));
  const data = snapshot(f.file, 'valid');
  data.files.push(data.files[0]!);
  await assert.rejects(engine.preview(data), /重复/);
  await assert.rejects(engine.preview(snapshot(f.file, '{"password":"private"}')), /凭据/);
});
test('new file synchronization creates parents and does not create unnecessary backup', async t => {
  const f = await fixture(t);
  const engine = new SyncEngine(f.home, f.backups);
  const file = '.codex/skills/new/SKILL.md';
  const plan = await engine.preview(snapshot(file, '# New'));
  assert.equal(plan.rows[0]?.status, '新增');
  await engine.apply(plan.id, [file]);
  assert.equal(await readLocal(f.home, file), '# New');
  await assert.rejects(readdir(f.backups), { code: 'ENOENT' });
});
test('production endpoints only allow Tailscale IPv4 and valid ports', () => {
  assert.ok(isTailnetIPv4('100.64.0.1'));
  assert.ok(isTailnetIPv4('100.127.255.254'));
  for (const host of ['127.0.0.1', '0.0.0.0', '100.128.0.1', '100.64.0.999', 'example.com', '100.064.0.1']) assert.throws(() => validateEndpoint(host, 47191));
  assert.throws(() => validateEndpoint('100.64.0.1', 80));
});
test('authenticated read-only HTTP snapshot works across two temporary devices', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, f.file), '# Remote skill');
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const address = s.address(); const port = typeof address === 'object' && address ? address.port : 0; s.close(() => resolve(port)); });
  });
  const token = randomBytes(32).toString('hex');
  const server = await startPeer(f.home, '127.0.0.1', port, token, true);
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  await assert.rejects(fetchSnapshot({ host: '127.0.0.1', port, token: '0'.repeat(64) }, true), /401/);
  const data = await fetchSnapshot({ host: '127.0.0.1', port, token }, true);
  const receiver = path.join(f.root, 'receiver');
  await mkdir(receiver);
  const engine = new SyncEngine(receiver, f.backups);
  const plan = await engine.preview(data);
  await engine.apply(plan.id, [f.file]);
  assert.equal(await readLocal(receiver, f.file), '# Remote skill');
});
