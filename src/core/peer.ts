import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { MAX_TOTAL, scan } from './files';

export const MAX_WIRE = MAX_TOTAL * 3;
export function isTailnetIPv4(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every(p => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255) && Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127;
}
export function validateEndpoint(host: string, port: number, test = false): void {
  if ((!isTailnetIPv4(host) && !(test && host === '127.0.0.1')) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('请使用 Tailscale IPv4（100.64.0.0/10）和 1024–65535 端口');
}
export function validateToken(token: string): void {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('配对令牌必须是 64 位十六进制字符串');
}
function authorized(actual: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(actual ?? '');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
export async function startPeer(home: string, host: string, port: number, token: string, test = false): Promise<http.Server> {
  validateEndpoint(host, port, test);
  validateToken(token);
  let busy = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!authorized(req.headers.authorization, token)) { res.writeHead(401).end('{"error":"Unauthorized"}'); return; }
    if (req.method !== 'GET' || req.url !== '/v1/snapshot') { res.writeHead(404).end('{}'); return; }
    if (busy) { res.writeHead(429).end('{"error":"Busy"}'); return; }
    busy = true;
    try {
      const snapshot = await scan(home);
      const body = JSON.stringify({ version: 1, ...snapshot });
      if (Buffer.byteLength(body) > MAX_WIRE) throw new Error('快照过大');
      res.end(body);
    } catch { res.writeHead(500).end('{"error":"Snapshot failed"}'); }
    finally { busy = false; }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}
export async function fetchSnapshot(peer: PeerInput, test = false): Promise<unknown> {
  validateEndpoint(peer.host, peer.port, test);
  validateToken(peer.token);
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: peer.host, port: peer.port, path: '/v1/snapshot', headers: { Authorization: `Bearer ${peer.token}` }, agent: false }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`对端返回 ${response.statusCode}，请检查配对令牌和共享状态`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_WIRE) { response.destroy(new Error('远程快照超过大小上限')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('远程快照格式无效')); }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('连接超时，请检查两台设备的 Tailscale 状态与 ACL')), 15_000);
    request.once('close', () => clearTimeout(deadline));
    request.on('error', reject);
  });
}
