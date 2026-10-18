import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { networkInterfaces } from 'node:os';
import { detectTailnetAddresses, parseTailscaleIPv4Output, tailnetFromInterfaces, tailscaleIPv4 } from '../core/tailscale';

type Interfaces = ReturnType<typeof networkInterfaces>;
type Entry = { address: string; netmask: string; family: string; internal: boolean; cidr: string | null };
function iface(entries: Entry[]) { return entries.map(entry => ({ ...entry, mac: '00:00:00:00:00:00' })); }
function interfaces(value: Record<string, Entry[]>): Interfaces { return Object.fromEntries(Object.entries(value).map(([name, entries]) => [name, iface(entries)])) as Interfaces; }
const v4 = (address: string, prefix: number, netmask: string): Entry => ({ address, netmask, family: 'IPv4', internal: false, cidr: `${address}/${prefix}` });
const ula = (address: string): Entry => ({ address, netmask: 'ffff:ffff:ffff::', family: 'IPv6', internal: false, cidr: `${address}/48` });

test('tailscale ip -4 output is parsed and validated', () => {
  assert.equal(parseTailscaleIPv4Output('100.101.5.6\n'), '100.101.5.6');
  assert.equal(parseTailscaleIPv4Output('\n  100.127.255.254  \r\n'), '100.127.255.254');
  assert.equal(parseTailscaleIPv4Output('fd7a:115c:a1e0::1:2\n100.101.5.6\n'), '100.101.5.6');
  for (const output of ['', 'not logged in', '100.128.0.1', '100.064.0.1', '100.64.0.999\n', 'fd7a:115c:a1e0::1\n']) assert.equal(parseTailscaleIPv4Output(output), null);
});
test('missing CLI degrades to null instead of throwing', async () => {
  assert.equal(await tailscaleIPv4(200, ['/nonexistent/tailscale-test-binary']), null);
});
test('carrier-grade NAT on a physical interface is not mistaken for a tailnet address', () => {
  // 复现本机现场：en1 拿到运营商 CGNAT（/17 带广播），Tailscale 在 utun4 上是 /32 主机路由。
  const detected = tailnetFromInterfaces(interfaces({
    lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, cidr: '127.0.0.1/8' }],
    en1: [v4('100.72.31.44', 17, '255.255.128.0'), ula('2001:db8::1')],
    utun4: [v4('100.101.5.6', 32, '255.255.255.255'), ula('fd7a:115c:a1e0::1:2')],
  }));
  assert.deepEqual(detected, ['100.101.5.6']);
});
test('a /32 tailnet address on an unusual interface still wins over CGNAT', () => {
  const detected = tailnetFromInterfaces(interfaces({
    en0: [v4('100.72.31.44', 17, '255.255.128.0')],
    utun9: [v4('100.101.5.6', 32, '255.255.255.255')],
  }));
  assert.deepEqual(detected, ['100.101.5.6']);
});
test('without any trustworthy interface the old 100.64/10 fallback is kept', () => {
  const detected = tailnetFromInterfaces(interfaces({
    en1: [v4('100.72.31.44', 17, '255.255.128.0')],
    en0: [v4('192.168.1.20', 24, '255.255.255.0')],
  }));
  assert.deepEqual(detected, ['100.72.31.44']);
  assert.deepEqual(tailnetFromInterfaces(interfaces({ lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, cidr: '127.0.0.1/8' }] })), []);
});
test('CLI answer is authoritative, interfaces are only the fallback', async () => {
  assert.deepEqual(await detectTailnetAddresses(async () => '100.101.5.6', () => ['100.72.31.44']), ['100.101.5.6']);
  assert.deepEqual(await detectTailnetAddresses(async () => null, () => ['100.72.31.44', '100.72.31.44']), ['100.72.31.44']);
  assert.deepEqual(await detectTailnetAddresses(async () => { throw new Error('spawn failed'); }, () => ['100.101.5.6']), ['100.101.5.6']);
  assert.deepEqual(await detectTailnetAddresses(async () => 'not-an-ip', () => []), []);
});
