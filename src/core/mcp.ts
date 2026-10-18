import JSON5 from 'json5';
import { parse as parseToml, stringify as stringifyToml, TomlDate, type TomlTable } from 'smol-toml';

type RecordValue = Record<string, unknown>;
function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function mcpKey(relative: string): string {
  return relative === '.codex/config.toml' ? 'mcp_servers' : relative.startsWith('.config/opencode/') ? 'mcp' : 'mcpServers';
}
function parseDocument(relative: string, text: string): RecordValue {
  try {
    const result: unknown = relative.endsWith('.toml') ? parseToml(text, { integersAsBigInt: true }) : relative.endsWith('.jsonc') ? JSON5.parse(text) : JSON.parse(text);
    if (!isRecord(result)) throw new Error();
    return result;
  } catch {
    // Parser diagnostics can contain raw private settings: never propagate them to the network.
    throw new Error('MCP 所在文件无法安全解析，未共享原文');
  }
}
/** MCP payloads are JSON-only, with no prototype keys, dates or lossy numeric conversions. */
function jsonValue(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new Error('MCP 定义嵌套过深');
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error('MCP 整数超出安全范围');
    return number;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (Array.isArray(value)) return value.map(v => jsonValue(v, depth + 1));
  if (!isRecord(value)) throw new Error('MCP 包含不支持的数据类型');
  const result: RecordValue = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('MCP 包含不安全字段');
    result[key] = jsonValue(value[key], depth + 1);
  }
  return result;
}
function servers(value: unknown): RecordValue {
  if (!isRecord(value)) throw new Error('MCP 服务列表必须是对象');
  for (const server of Object.values(value)) if (!isRecord(server)) throw new Error('MCP 服务定义必须是对象');
  return jsonValue(value) as RecordValue;
}
function encode(relative: string, value: RecordValue): string {
  return JSON.stringify({ [mcpKey(relative)]: value }, null, 2);
}
/** Only the top-level MCP field is selected; model, permissions, history, etc. never leave this function. */
export function extractMcp(relative: string, text: string): string | null {
  const doc = parseDocument(relative, text);
  const key = mcpKey(relative);
  const value = Object.hasOwn(doc, key) ? servers(doc[key]) : {};
  return Object.keys(value).length ? encode(relative, value) : null;
}
export function validateMcpFragment(relative: string, content: string): RecordValue {
  let doc: unknown;
  try { doc = JSON.parse(content); } catch { throw new Error('MCP 片段必须为 JSON，旧版整文件同步已禁用'); }
  const key = mcpKey(relative);
  if (!isRecord(doc) || Object.keys(doc).length !== 1 || !Object.hasOwn(doc, key)) throw new Error('拒绝 MCP 以外的配置字段');
  return servers(doc[key]);
}
export function containsMcp(relative: string, local: string | null, incoming: string): boolean {
  const remote = validateMcpFragment(relative, incoming);
  const existing = local === null ? {} : validateMcpFragment(relative, local);
  return Object.entries(remote).every(([name, value]) => Object.hasOwn(existing, name) && JSON.stringify(existing[name]) === JSON.stringify(value));
}
function toToml(value: unknown, depth = 0, integerNumbers = false): unknown {
  if (depth > 80) throw new Error('本机配置嵌套过深，无法安全写入');
  // Smol TOML dates have millisecond precision; fail closed instead of truncating private settings.
  if (value instanceof TomlDate || value === null) throw new Error('本机 TOML 含日期或不支持的值，暂不支持安全合并');
  if (integerNumbers && typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map(v => toToml(v, depth + 1, integerNumbers));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toToml(v, depth + 1, integerNumbers)]));
  return value;
}
export function mergeMcp(relative: string, current: string | null, incoming: string): string {
  const remote = validateMcpFragment(relative, incoming);
  const doc = current === null ? {} : parseDocument(relative, current);
  const key = mcpKey(relative);
  // Keep local-only MCP services, including local credentials; do not run the outgoing secret filter on them.
  const local = Object.hasOwn(doc, key) ? doc[key] : {};
  if (!isRecord(local)) throw new Error('本机 MCP 服务列表无法合并');
  doc[key] = { ...local, ...(relative.endsWith('.toml') ? toToml(remote, 0, true) as RecordValue : remote) };
  try {
    if (relative.endsWith('.toml')) return stringifyToml(toToml(doc) as TomlTable, { numbersAsFloat: true });
    // JSONC is written as ordinary JSON, which remains valid JSONC. Settings retain values, not comments/layout.
    jsonValue(doc); // Refuse values that would be silently lost by JSON.stringify.
    return JSON.stringify(doc, null, 2) + '\n';
  } catch { throw new Error('无法在保留本机设置值的前提下合并 MCP，未写入'); }
}
