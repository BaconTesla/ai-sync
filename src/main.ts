import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { hostname, homedir, networkInterfaces, tmpdir } from 'node:os';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { scan } from './core/files';
import { fetchSnapshot, isTailnetIPv4, startPeer, validateToken } from './core/peer';
import { SyncEngine } from './core/sync';

const smoke = process.argv.includes('--smoke-test');
let home = homedir();
let smokeRoot: string | undefined;
let window: BrowserWindow | undefined;
let server: Server | undefined;
let token = '';
let bind = '';
let port = 47191;
let changingShare = false;
let engine: SyncEngine;
let backups: string;
let tokenPath: string;
const page = path.join(__dirname, '../ui/index.html');
const pageURL = pathToFileURL(page).href;

function addresses(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap(list => list ?? []).map(n => n.address).filter(isTailnetIPv4))];
}
async function stopSharing(): Promise<void> {
  const current = server;
  server = undefined;
  if (current) await new Promise<void>(resolve => { current.closeAllConnections(); current.close(() => resolve()); });
}
async function saveToken(): Promise<void> {
  await writeFile(tokenPath, token, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
}
function handle<K extends keyof SyncAPI>(channel: K, callback: SyncAPI[K]): void {
  ipcMain.handle(`sync:${channel}`, async (event, ...args: unknown[]) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageURL) throw new Error('不允许的 IPC 来源');
    return (callback as (...params: unknown[]) => unknown)(...args);
  });
}
function registerHandlers(): void {
  handle('state', async () => ({ device: hostname(), addresses: addresses(), sharing: Boolean(server), bind, port, token, inventory: await scan(home), backupDirectory: backups }));
  handle('share', async input => {
    if (changingShare) throw new Error('共享状态正在变化，请稍后');
    if (!input || typeof input.enabled !== 'boolean') throw new Error('共享参数无效');
    changingShare = true;
    try {
      await stopSharing();
      if (input.enabled) {
        server = await startPeer(home, input.host, input.port, token);
        server.on('error', () => { void stopSharing(); });
        bind = input.host;
        port = input.port;
      }
    } finally { changingShare = false; }
  });
  handle('rotateToken', async () => {
    if (changingShare) throw new Error('共享状态正在变化，请稍后');
    changingShare = true;
    try {
      await stopSharing();
      token = randomBytes(32).toString('hex');
      await saveToken();
    } finally { changingShare = false; }
  });
  handle('preview', async peer => engine.preview(await fetchSnapshot(peer)));
  handle('apply', async input => {
    if (!input || typeof input.id !== 'string') throw new Error('同步参数无效');
    return engine.apply(input.id, input.paths);
  });
  handle('openBackups', async () => {
    await mkdir(backups, { recursive: true, mode: 0o700 });
    const error = await shell.openPath(backups);
    if (error) throw new Error(error);
  });
}
function createWindow(): void {
  window = new BrowserWindow({
    title: 'AI Sync', width: 1320, height: 900, minWidth: 1020, minHeight: 740,
    backgroundColor: '#10141b',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, partition: smoke ? 'ai-sync-smoke' : undefined },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('closed', () => { window = undefined; });
  void window.loadFile(page);
}

async function runSmoke(): Promise<void> {
  if (!window || !smokeRoot) return;
  await new Promise<void>(resolve => window!.webContents.once('did-finish-load', () => resolve()));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript("document.querySelector('#file-count')?.textContent === '2'");
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const result = await window.webContents.executeJavaScript(`(() => {
    const rows = document.querySelectorAll('#inventory .file-row');
    if (rows.length !== 2) throw new Error('Inventory did not load');
    if (typeof window.sync.state !== 'function') throw new Error('Bridge missing');
    if (typeof window.require !== 'undefined') throw new Error('Node exposed');
    document.querySelector('#inventory .file-row').click();
    if (!document.querySelector('#local-content').textContent.includes('Demo')) throw new Error('Preview did not render');
    document.querySelector('[data-filter="Skill"]').click();
    if (document.querySelectorAll('#inventory .file-row').length !== 1) throw new Error('Filter broken');
    return 'inventory, preview, filters, context isolation passed';
  })()`);
  console.log(`Electron smoke: ${result}`);
  const host = addresses()[0];
  if (host) {
    const peerHome = path.join(smokeRoot, 'peer');
    const relative = '.claude/skills/demo/SKILL.md';
    await mkdir(path.join(peerHome, '.claude/skills/demo'), { recursive: true });
    await writeFile(path.join(peerHome, relative), '# Demo Skill v2\n\nPulled over the local Tailscale interface.');
    await writeFile(path.join(peerHome, '.claude/settings.json'), '{"model":"SMOKE_SOURCE_PRIVATE", "mcpServers":{"Demo":{"command":"demo-v2"}}}');
    const freePort = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, host, () => { const address = probe.address(); const value = typeof address === 'object' && address ? address.port : 0; probe.close(() => resolve(value)); });
    });
    const remoteToken = randomBytes(32).toString('hex');
    const peer = await startPeer(peerHome, host, freePort, remoteToken);
    try {
      await window.webContents.executeJavaScript(`document.querySelector('#peer-host').value = ${JSON.stringify(host)}; document.querySelector('#peer-port').value = ${freePort}; document.querySelector('#peer-token').value = ${JSON.stringify(remoteToken)}; document.querySelector('#preview').click();`);
      await waitForUI("document.querySelector('#inventory-title').textContent.includes('同步预览') && document.body.getAttribute('aria-busy') === 'false'");
      const confirmation = await window.webContents.executeJavaScript("(() => { try { document.querySelector('[data-filter=all]').click(); const checks = document.querySelectorAll('#inventory input[type=checkbox]'); if (checks.length !== 2) throw new Error('Missing Skill or MCP checkbox'); if (document.querySelector('#remote-content').textContent.includes('SMOKE_SOURCE_PRIVATE')) throw new Error('Private settings reached preview'); checks.forEach(check => check.click()); document.querySelector('#apply').click(); if (!document.querySelector('#confirm-dialog').open) throw new Error('Confirmation missing'); document.querySelector('#confirm-apply').click(); return 'ok'; } catch (error) { return error.message; } })()");
      if (confirmation !== 'ok') throw new Error(confirmation);
      await waitForUI("document.querySelector('#message').textContent.includes('已拉取 2 个文件') && document.body.getAttribute('aria-busy') === 'false'");
      if (!(await readFile(path.join(home, relative), 'utf8')).includes('v2')) throw new Error('GUI pull did not update file');
      const merged = JSON.parse(await readFile(path.join(home, '.claude/settings.json'), 'utf8'));
      if (merged.model !== 'SMOKE_LOCAL_PRIVATE' || merged.mcpServers.Demo.command !== 'demo-v2') throw new Error('MCP merge did not preserve local settings');
      console.log('Electron smoke: Skill pull, MCP-only preview and merge, local preference preservation over local Tailscale interface passed');
    } finally { peer.closeAllConnections(); await new Promise<void>(resolve => peer.close(() => resolve())); }
  } else console.log('Electron smoke: Tailscale interface unavailable; network GUI test skipped');
  await new Promise(resolve => setTimeout(resolve, 200));
  await window.webContents.capturePage().then(image => writeFile(path.join(tmpdir(), 'ai-sync-smoke.png'), image.toPNG()));
  console.log(`Screenshot: ${path.join(tmpdir(), 'ai-sync-smoke.png')}`);
  app.quit();
}

async function waitForUI(expression: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await window!.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`UI condition timed out: ${expression}`);
}

if (!smoke && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void (async () => {
    if (smoke) {
      smokeRoot = await mkdtemp(path.join(tmpdir(), 'ai-sync-ui-'));
      home = path.join(smokeRoot, 'home');
      await mkdir(path.join(home, '.claude/skills/demo'), { recursive: true });
      await writeFile(path.join(home, '.claude/skills/demo/SKILL.md'), '# Demo Skill\n\nOnly a test fixture.');
      await writeFile(path.join(home, '.claude/settings.json'), '{"model":"SMOKE_LOCAL_PRIVATE", "mcpServers":{"Demo":{"command":"demo"}}}');
      await mkdir(path.join(smokeRoot, 'app', 'Shared Dictionary', 'cache'), { recursive: true });
      app.setPath('userData', path.join(smokeRoot, 'app'));
      process.once('exit', () => { if (smokeRoot) rmSync(smokeRoot, { recursive: true, force: true }); });
    }
    await app.whenReady();
    await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
    tokenPath = path.join(app.getPath('userData'), 'pairing-token');
    backups = path.join(app.getPath('userData'), 'backups');
    try { token = (await readFile(tokenPath, 'utf8')).trim(); validateToken(token); await chmod(tokenPath, 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('配对令牌文件损坏或不可读，请检查应用数据目录');
      token = randomBytes(32).toString('hex');
      await saveToken();
    }
    bind = addresses()[0] ?? '';
    engine = new SyncEngine(home, backups);
    registerHandlers();
    createWindow();
    if (smoke) await runSmoke();
    app.on('activate', () => { if (!window) createWindow(); });
  })().catch(error => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => { void stopSharing().finally(() => app.quit()); });
  app.on('before-quit', () => { server?.closeAllConnections(); server?.close(); });
}
