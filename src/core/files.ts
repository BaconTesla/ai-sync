import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MAX_FILE = 256 * 1024;
export const MAX_TOTAL = 4 * 1024 * 1024;
export const MAX_FILES = 500;
export const ROOTS = [
  { agent: 'Claude Code', skill: '.claude/skills', configs: ['.claude/settings.json', '.claude.json'] },
  { agent: 'Codex', skill: '.codex/skills', configs: ['.codex/config.toml'] },
  { agent: 'Gemini CLI', skill: '.gemini/skills', configs: ['.gemini/settings.json'] },
  { agent: 'OpenCode', skill: '.config/opencode/skills', configs: ['.config/opencode/opencode.json', '.config/opencode/opencode.jsonc'] },
  { agent: 'Shared', skill: '.agents/skills', configs: [] as string[] },
];
export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

export function describe(relative: string): { agent: string; kind: SyncFile['kind'] } {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0') || path.posix.normalize(relative) !== relative || relative.startsWith('/') || relative.split('/').some(p => p === '..' || p === '.')) {
    throw new Error('不安全的文件路径');
  }
  const root = ROOTS.find(r => r.configs.includes(relative) || relative.startsWith(`${r.skill}/`));
  if (!root || /(^|\/)(\.|node_modules(?:\/|$)|\.git(?:\/|$))/.test(relative.replace(/^\.(claude|codex|gemini|agents|config)\//, '').replace(/^\.claude\.json$/, 'claude.json')) || /(?:^|\/)(?:auth|credentials|secrets?)(?:\.|\/|$)/i.test(relative)) {
    throw new Error('文件不在同步白名单中');
  }
  return { agent: root.agent, kind: relative.startsWith(`${root.skill}/`) ? 'Skill' : 'MCP / 配置' };
}

export function assertSafeContent(content: string): void {
  if (Buffer.byteLength(content) > MAX_FILE || content.includes('\0') || content.includes('\uFFFD')) throw new Error('非 UTF-8 文本或文件过大');
  // Conservative heuristic, not a secret scanner guarantee. Environment references are safe to transport.
  if (/-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})/.test(content)) throw new Error('疑似密钥，已排除');
  for (const match of content.matchAll(/["']?(?:[\w-]*(?:token|secret|password|api[_-]?key|authorization)[\w-]*)["']?\s*[:=]\s*["']([^"'\r\n]+)["']/gi)) {
    const value = match[1]!;
    if (value.trim() && !/^(\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|\{env:[^}]+\}|<[^>]+>)$/.test(value)) throw new Error('疑似内嵌凭据，请改为环境变量后再同步');
  }
}

/** Reject symlinks in every existing component, not only the final filename. */
export async function safePath(home: string, relative: string, createParents = false): Promise<string> {
  describe(relative);
  let current = home;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error('拒绝符号链接或非普通文件');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (createParents && i < parts.length - 1) await mkdir(current, { mode: 0o700 });
    }
  }
  return current;
}

export async function readLocal(home: string, relative: string): Promise<string | null> {
  const target = await safePath(home, relative);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('文件类型或大小不受支持');
    const buffer = Buffer.alloc(MAX_FILE + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    assertSafeContent(text);
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

export async function scan(home: string): Promise<ScanResult> {
  const result: ScanResult = { files: [], skipped: [] };
  let size = 0;
  const collect = async (relative: string): Promise<void> => {
    try {
      const info = describe(relative);
      const content = await readLocal(home, relative);
      if (content === null) return;
      if (result.files.length >= MAX_FILES || size + Buffer.byteLength(content) > MAX_TOTAL) throw new Error('达到扫描总量上限');
      result.files.push({ path: relative, ...info, hash: hash(content), content });
      size += Buffer.byteLength(content);
    } catch (e) { result.skipped.push(`${relative}：${(e as Error).message}`); }
  };
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 12 || result.files.length >= MAX_FILES) { result.skipped.push(`${relative}：达到扫描上限`); return; }
    // Use a fake child to validate every directory component before readdir.
    try { await safePath(home, `${relative}/_scan_`); }
    catch (e) { result.skipped.push(`${relative}：${(e as Error).message}`); return; }
    let entries;
    try { entries = await readdir(path.join(home, relative), { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') result.skipped.push(`${relative}：无法读取`); return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) result.skipped.push(`${child}：不跟随符号链接`);
      else if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.isFile()) await collect(child);
    }
  };
  for (const root of ROOTS) {
    for (const config of root.configs) await collect(config);
    await walk(root.skill, 0);
  }
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

export async function writeSynced(home: string, backups: string, relative: string, content: string, expected: string | null): Promise<void> {
  assertSafeContent(content);
  const current = await readLocal(home, relative);
  if ((current === null ? null : hash(current)) !== expected) throw new Error(`${relative} 已变化，请重新预览`);
  const target = await safePath(home, relative, true);
  if (current !== null) {
    const backup = path.join(backups, relative);
    await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
    await writeFile(backup, current, { flag: 'wx', mode: 0o600 });
  }
  const temporary = `${target}.ai-sync-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    const latest = await readLocal(home, relative);
    if ((latest === null ? null : hash(latest)) !== expected) throw new Error(`${relative} 写入前发生变化，请重新预览`);
    // A new file must never replace one created concurrently after preview.
    if (expected === null) await link(temporary, target);
    else await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}
