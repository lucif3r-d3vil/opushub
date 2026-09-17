// Phase 9C — the host network provider: interfaces, addresses, counters, the default route and
// the resolver, read from the kernel's own files. Plus the parts it deliberately does not expose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9net-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9net-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const { createNetworkProvider } = await import('./providers/network.js');

test.after(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const SYS_NET = '/sys/class/net';

const FILES = {
  [`${SYS_NET}/eth0/operstate`]: 'up\n',
  [`${SYS_NET}/eth0/mtu`]: '1500\n',
  [`${SYS_NET}/eth0/speed`]: '1000\n',
  [`${SYS_NET}/eth0/uevent`]: 'INTERFACE=eth0\nIFINDEX=2\n',
  [`${SYS_NET}/docker0/operstate`]: 'up\n',
  [`${SYS_NET}/docker0/mtu`]: '1500\n',
  [`${SYS_NET}/docker0/speed`]: '-1\n',           // a virtual link: not a 1 Mbps link
  [`${SYS_NET}/docker0/uevent`]: 'INTERFACE=docker0\nIFINDEX=3\nDEVTYPE=bridge\n',
  [`${SYS_NET}/wlan0/operstate`]: 'down\n',
  [`${SYS_NET}/wlan0/mtu`]: '1500\n',
  [`${SYS_NET}/wlan0/uevent`]: 'INTERFACE=wlan0\nIFINDEX=4\n',
  '/proc/net/dev': [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 1000     10    0    0    0     0          0         0     1000     10    0    0    0     0       0          0',
    '  eth0: 40000000000 30000000    0    0    0     0          0         0  12000000000  9000000    0    0    0     0       0          0',
    'docker0: 1000000    2000    0    0    0     0          0         0   2000000    3000    0    0    0     0       0          0',
    ' wlan0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0',
  ].join('\n'),
  '/proc/net/route': [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask',
    // gateway 192.168.0.1 as the kernel writes it: four little-endian hex bytes
    'eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000',
    'docker0\t00A011AC\t00000000\t0001\t0\t0\t0\t0000FFFF',
  ].join('\n'),
  '/proc/net/ipv6_route': [
    '00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe8000000000000000021c42fffe123456 00000400 00000001 00000000 00000001 eth0',
  ].join('\n'),
  '/etc/resolv.conf': '# managed by the operator\nnameserver 192.0.2.53\nnameserver 2001:db8::53\nsearch lan example\noptions ndots:2\n',
};

const ADDRESSES = {
  eth0: [{ address: '198.51.100.20', family: 'IPv4', cidr: '198.51.100.20/24', internal: false }],
  docker0: [{ address: '172.17.0.1', family: 'IPv4', cidr: '172.17.0.1/16', internal: false }],
  wlan0: [],
  lo: [{ address: '127.0.0.1', family: 'IPv4', cidr: '127.0.0.1/8', internal: true }],
};

function fakeRead({ files = FILES, addresses = ADDRESSES, containerized = false, dirs = [`${SYS_NET}/wlan0/wireless`] } = {}) {
  return {
    readText: (p) => (p in files ? files[p] : null),
    readDir: (p) => (p === SYS_NET ? ['eth0', 'docker0', 'wlan0', 'lo'] : null),
    isDir: (p) => dirs.includes(p),
    addresses: () => addresses,
    containerized: () => containerized,
  };
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

test('interfaces come from the kernel, with the state, mtu and addresses it reports', async () => {
  const p = createNetworkProvider({ read: fakeRead() });
  const list = p.methods.interfaces();
  const names = list.map((i) => i.name);
  assert.deepEqual(names, ['docker0', 'eth0', 'wlan0'], 'loopback is filtered out; nothing is hardcoded');
  const eth0 = list.find((i) => i.name === 'eth0');
  assert.equal(eth0.state, 'up');
  assert.equal(eth0.up, true);
  assert.equal(eth0.mtu, 1500);
  assert.equal(eth0.speedMbps, 1000);
  assert.equal(eth0.kind, 'ethernet');
  assert.equal(eth0.addresses[0].address, '198.51.100.20');
  assert.equal(eth0.addresses[0].scope, 'global');
});

test('a link with no speed reports no speed — -1 is not one megabit', async () => {
  const p = createNetworkProvider({ read: fakeRead() });
  const docker0 = p.methods.interfaces().find((i) => i.name === 'docker0');
  assert.equal(docker0.speedMbps, null);
  assert.equal(docker0.kind, 'bridge', 'DEVTYPE is the kernel’s word, not a guess from the name');
});

test('traffic counters are read as numbers, per interface, and never estimated', async () => {
  const p = createNetworkProvider({ read: fakeRead() });
  const eth0 = p.methods.interfaces().find((i) => i.name === 'eth0');
  assert.equal(eth0.rx.bytes, 40_000_000_000);
  assert.equal(eth0.tx.bytes, 12_000_000_000);
  assert.equal(eth0.rx.packets, 30_000_000);
  assert.equal(eth0.rx.errors, 0);
});

test('routing publishes the default route and a count — never the table', async () => {
  const p = createNetworkProvider({ read: fakeRead() });
  const routes = p.methods.routes();
  assert.ok(routes.defaultRoute, 'a default route was reported');
  assert.equal(routes.defaultRoute.via, '192.168.0.1', 'the gateway is converted from the kernel’s hex');
  assert.equal(routes.defaultRoute.iface, 'eth0');
  assert.equal(routes.defaultRoute.protocol, 'ipv4');
  assert.equal(routes.routeCount, 2);
  assert.equal(routes.tableAvailable, false, 'the routing table is never published');
  assert.match(routes.note, /full routing table/);
});

test('an IPv6 default route is reported as its own fact when the kernel lists one', () => {
  const { parseDefaultRoute6 } = createNetworkProvider({})._internals;
  const r6 = parseDefaultRoute6(FILES['/proc/net/ipv6_route']);
  assert.ok(r6, 'the IPv6 default route was parsed');
  assert.equal(r6.iface, 'eth0');
  assert.equal(r6.protocol, 'ipv6');
  assert.equal(parseDefaultRoute6(null), null, 'no file, no route — not an empty guess');
});

test('with no default route the answer is null, not a plausible gateway', () => {
  const p = createNetworkProvider({
    read: fakeRead({ files: { ...FILES, '/proc/net/route': 'Iface\tDestination\tGateway\n', '/proc/net/ipv6_route': '' } }),
  });
  assert.equal(p.methods.routes().defaultRoute, null);
  assert.deepEqual(p.methods.routes().defaultRoutes, []);
});

test('DNS is reported with its source, and a stub resolver is called a stub resolver', async () => {
  const p = createNetworkProvider({ read: fakeRead() });
  const dns = p.methods.dns();
  assert.equal(dns.available, true);
  assert.deepEqual(dns.nameservers, ['192.0.2.53', '2001:db8::53']);
  assert.deepEqual(dns.search, ['lan example']);
  assert.equal(dns.source, 'resolv.conf');
  assert.equal(dns.viaStubResolver, false);

  const stub = createNetworkProvider({ read: fakeRead({ files: { ...FILES, '/etc/resolv.conf': 'nameserver 127.0.0.53\n' } }) });
  const stubDns = stub.methods.dns();
  assert.equal(stubDns.viaStubResolver, true);
  assert.equal(stubDns.source, 'resolv.conf', 'the source is stated; what answers behind it is not guessed');
});

test('no MAC address, no ARP table, no raw table: the provider reads what it publishes', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/providers/network.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  for (const banned of ['address"', '/address', 'arp', 'neigh', 'conntrack', 'tcp', 'udp']) {
    assert.ok(!src.includes(`/${banned}'`), `the provider reads /${banned}`);
  }
  assert.ok(src.includes('NOISE'), 'loopback is filtered');
  assert.ok(!/process\.env/.test(src), 'the provider takes no configuration from the environment');
});

test('the provider says which namespace it is reading when it runs in a container', async () => {
  const host = createNetworkProvider({ read: fakeRead({ containerized: false }) });
  const container = createNetworkProvider({ read: fakeRead({ containerized: true }) });
  const hostResult = await host.check();
  const containerResult = await container.check();
  assert.equal(hostResult.data.scope, 'host');
  assert.equal(hostResult.data.scopeNote, null);
  assert.equal(containerResult.data.scope, 'container');
  assert.match(containerResult.data.scopeNote, /namespace/);
});

test('an unreadable /sys answers unavailable with a reason, not an empty list', async () => {
  const p = createNetworkProvider({ read: { ...fakeRead(), readDir: () => null } });
  const result = await p.check();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error.code, 'not_supported');
  assert.match(result.error.reason, /does not expose interface information/);
  assert.equal(result.data, null);
});

test('capabilities are reported only when the matching information was actually read', async () => {
  const full = await createNetworkProvider({ read: fakeRead() }).check();
  assert.deepEqual(full.capabilities, ['interfaces', 'routes', 'dns']);

  const noRoutes = await createNetworkProvider({
    read: fakeRead({ files: { ...FILES, '/proc/net/route': null, '/proc/net/ipv6_route': null } }),
  }).check();
  assert.deepEqual(noRoutes.capabilities, ['interfaces', 'dns'], 'no default route, no routing capability');

  const noDns = await createNetworkProvider({ read: fakeRead({ files: { ...FILES, '/etc/resolv.conf': null } }) }).check();
  assert.deepEqual(noDns.capabilities, ['interfaces', 'routes']);
});

test('the real host answers, or says it cannot — either way it does not invent', async () => {
  const { networkProvider } = await import('./providers/network.js');
  const result = await networkProvider.check();
  assert.ok(['available', 'unavailable'].includes(result.status));
  if (result.status === 'available') {
    for (const i of result.data.interfaces) {
      assert.ok(i.name && i.state);
      assert.ok(Array.isArray(i.addresses));
    }
    assert.equal(typeof result.data.counts.interfaces, 'number');
  }
});
