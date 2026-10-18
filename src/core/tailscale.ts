import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { isTailnetIPv4 } from './peer';

/**
 * 本机 Tailscale IPv4 的探测。
 *
 * 只按 100.64.0.0/10 猜地址并不可靠：该段是运营商 CGNAT，物理网卡
 * （4G/5G CPE、部分宽带）也会拿到同一段地址，且 networkInterfaces()
 * 的返回顺序无保证。这里优先读 Tailscale 自己的答案（等同 `tailscale ip -4`），
 * 只有 CLI 不可用时才回落到接口启发式。
 */

/** 所有 tailnet 节点 IPv6 都在这个 ULA 前缀下，用作接口判定的强信号。 */
const TAILSCALE_ULA = /^fd7a:115c:a1e0:/i;
const DEFAULT_TIMEOUT = 1500;

/**
 * 必须使用绝对路径：从 Finder 启动的 .app 只有 /usr/bin:/bin:/usr/sbin:/sbin，
 * 找不到 Homebrew 或 pkg 安装的 `tailscale`。最后一项保留 PATH 查找作为兜底。
 */
export const TAILSCALE_BINARIES = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  'tailscale',
];

export function parseTailscaleIPv4Output(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const value = line.trim();
    if (isTailnetIPv4(value)) return value;
  }
  return null;
}

type Probe = { stdout: string } | { missing: true } | { failed: true };

function execText(bin: string, args: string[], timeout: number, maxBuffer = 64 * 1024): Promise<Probe> {
  return new Promise(resolve => {
    execFile(bin, args, { timeout, maxBuffer, windowsHide: true }, (error, stdout) => {
      if (!error) return resolve({ stdout });
      resolve((error as NodeJS.ErrnoException).code === 'ENOENT' ? { missing: true } : { failed: true });
    });
  });
}

/**
 * 依次尝试已知安装位置，返回第一个有效的 tailnet IPv4；不可用则 null。
 * 一旦某个二进制存在（非 ENOENT）就不再试其它路径：它们指向同一个 CLI，
 * 这样可以避免 daemon 无响应时把超时叠加成数十秒。
 */
export async function tailscaleIPv4(timeout = DEFAULT_TIMEOUT, binaries: string[] = TAILSCALE_BINARIES): Promise<string | null> {
  for (const bin of binaries) {
    const result = await execText(bin, ['ip', '-4'], timeout);
    if ('missing' in result) continue;
    return 'failed' in result ? null : parseTailscaleIPv4Output(result.stdout);
  }
  return null;
}

/** 从 CLI 读取一次命令输出的通用入口：找不到二进制返回 null，失败返回 null。 */
async function tailscaleOutput(args: string[], timeout: number, maxBuffer: number, binaries: string[]): Promise<string | null> {
  for (const bin of binaries) {
    const result = await execText(bin, args, timeout, maxBuffer);
    if ('missing' in result) continue;
    return 'failed' in result ? null : result.stdout;
  }
  return null;
}

export interface TailnetPeer {
  /** 展示名：优先 HostName，其次 MagicDNS 首段，最后 IP。 */
  name: string;
  /** MagicDNS 完整名称（不含结尾点），可能为空。 */
  dnsName: string;
  /** tailnet IPv4，100.64.0.0/10。 */
  ipv4: string;
  os: string;
  online: boolean;
}

/**
 * 解析 `tailscale status --json`。只读取展示与连接所需的字段：
 * 对端名称、IPv4、系统、在线状态，不保留密钥、流量、relay 等信息。
 */
export function parseTailscaleStatus(output: string): TailnetPeer[] {
  let status: unknown;
  try { status = JSON.parse(output); } catch { return []; }
  if (!status || typeof status !== 'object') return [];
  const peers = (status as { Peer?: unknown }).Peer;
  if (!peers || typeof peers !== 'object' || Array.isArray(peers)) return [];
  const found: TailnetPeer[] = [];
  for (const value of Object.values(peers as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const peer = value as Record<string, unknown>;
    const addresses = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs : [];
    const ipv4 = addresses.find(address => typeof address === 'string' && isTailnetIPv4(address)) as string | undefined;
    if (!ipv4) continue;
    const hostName = typeof peer.HostName === 'string' ? peer.HostName.trim() : '';
    const dnsName = typeof peer.DNSName === 'string' ? peer.DNSName.replace(/\.$/, '') : '';
    found.push({
      name: hostName || dnsName.split('.')[0] || ipv4,
      dnsName,
      ipv4,
      os: typeof peer.OS === 'string' ? peer.OS : '',
      online: peer.Online === true,
    });
  }
  const unique = new Map(found.map(peer => [peer.ipv4, peer]));
  return [...unique.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name) || a.ipv4.localeCompare(b.ipv4));
}

/**
 * 列出 tailnet 内其他设备，等价于 `tailscale status` 的 Peer 部分。
 * 只在本地读取并展示，不发送给任何对端。
 */
export async function listTailnetPeers(timeout = 3000, binaries: string[] = TAILSCALE_BINARIES): Promise<TailnetPeer[]> {
  const output = await tailscaleOutput(['status', '--json'], timeout, 8 * 1024 * 1024, binaries);
  return output === null ? [] : parseTailscaleStatus(output);
}

type Interfaces = ReturnType<typeof networkInterfaces>;

/**
 * 脱离 CLI 的启发式：Tailscale 在 macOS 上是 utun* 上的主机路由（/32），
 * 且同一接口带有 fd7a:115c:a1e0::/48 的 IPv6。运营商 CGNAT 在物理网卡上，
 * 是带广播地址的子网（例如 /17），两者可以区分。
 *
 * 只有完全找不到可信接口时，才退回“所有 100.64/10 地址”，避免比旧行为更差。
 */
export function tailnetFromInterfaces(ifaces: Interfaces = networkInterfaces()): string[] {
  const trusted: { address: string; score: number }[] = [];
  const untrusted: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    const entries = list ?? [];
    const ula = entries.some(entry => entry.address.includes(':') && TAILSCALE_ULA.test(entry.address));
    for (const entry of entries) {
      if (entry.internal || !isTailnetIPv4(entry.address)) continue;
      const tun = /^utun\d+$/.test(name);
      const hostRoute = entry.netmask === '255.255.255.255' || entry.cidr === `${entry.address}/32`;
      const score = (tun ? 2 : 0) + (hostRoute ? 2 : 0) + (ula ? 4 : 0);
      if (score > 0) trusted.push({ address: entry.address, score });
      else untrusted.push(entry.address);
    }
  }
  const ranked = trusted.sort((a, b) => b.score - a.score).map(item => item.address);
  return [...new Set(ranked.length ? ranked : untrusted)];
}

/**
 * CLI 有答案时以 CLI 为准（与 `tailscale ip -4` 完全一致，且能应付
 * 多 tailnet / 自定义接口命名）；CLI 不可用或未登录时才看网卡。
 */
export async function detectTailnetAddresses(cli: () => Promise<string | null> = tailscaleIPv4, guess: () => string[] = tailnetFromInterfaces): Promise<string[]> {
  const reported = await cli().catch(() => null);
  if (reported && isTailnetIPv4(reported)) return [reported];
  return [...new Set(guess())];
}
