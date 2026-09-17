// NetworkProvider — read-only host network intelligence, straight from the kernel's own files.
//
// Nothing here runs a command, opens a socket, or accepts a target: interfaces, addresses,
// counters and routes are read from /sys and /proc, and DNS from /etc/resolv.conf. There is no
// configuration surface, no write surface, and no way for a caller to name an interface that the
// kernel did not report (a requested name is matched against our own discovered set, exactly like
// ZFS dataset names and Docker operation targets).
//
// What is deliberately NOT exposed:
//   • no MAC addresses — they identify hardware on the LAN and nothing in OpusHub needs one
//   • no raw routing table — only the default route and a count, because "here is every route on
//     your router-facing host" is reconnaissance, not a dashboard
//   • no /etc/hosts, no ARP/ND tables, no connection tracking, no socket listing
//
// Container honesty: when OpusHub runs in a container it reads *that* network namespace. The
// document says so instead of implying it can see the host's interfaces.
import fs from 'node:fs';
import os from 'node:os';

const SYS_NET = '/sys/class/net';
const PROC_NET_DEV = '/proc/net/dev';
const PROC_ROUTE = '/proc/net/route';
const PROC_ROUTE6 = '/proc/net/ipv6_route';
const RESOLV = '/etc/resolv.conf';

/** Interfaces the kernel always has that tell an operator nothing about their LAN. */
const NOISE = new Set(['lo']);

const STATE_WORDS = new Set(['up', 'down', 'unknown', 'dormant', 'lowerlayerdown', 'testing', 'notpresent']);

const defaultRead = {
  readText: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
  readDir: (p) => { try { return fs.readdirSync(p); } catch { return null; } },
  isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  addresses: () => { try { return os.networkInterfaces(); } catch { return {}; } },
  containerized: () => {
    try {
      return fs.existsSync('/.dockerenv') || /docker|kubepods/i.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
    } catch { return false; }
  },
};

const num = (s) => {
  const n = Number(String(s ?? '').trim());
  return Number.isFinite(n) ? n : null;
};

/** A kernel-reported device type. Absent DEVTYPE means "a plain interface", not a guess. */
function deviceKind(read, name, uevent) {
  const m = /^DEVTYPE=(.+)$/m.exec(String(uevent || ''));
  const devtype = m ? m[1].trim().toLowerCase() : null;
  if (devtype) return devtype;                                  // bridge, vlan, veth, bond, tun…
  if (read.isDir(`${SYS_NET}/${name}/wireless`)) return 'wireless';
  if (read.isDir(`${SYS_NET}/${name}/bridge`)) return 'bridge';
  return 'ethernet';
}

function parseNetDev(text) {
  const out = new Map();
  if (!text) return out;
  for (const line of text.split('\n').slice(2)) {
    const m = line.trim().match(/^([^:]+):\s+(.*)$/);
    if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length < 16) continue;
    out.set(m[1], {
      rxBytes: f[0], rxPackets: f[1], rxErrors: f[2], rxDropped: f[3],
      txBytes: f[8], txPackets: f[9], txErrors: f[10], txDropped: f[11],
    });
  }
  return out;
}

/** /proc/net/route: the default IPv4 route, and nothing else. */
function parseDefaultRoute(text) {
  if (!text) return null;
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    const [iface, destination, gateway] = f;
    const mask = f[7];                       // columns: iface dst gateway flags ref use metric mask
    if (destination !== '00000000' || mask !== '00000000') continue;
    if (!gateway || gateway === '00000000') return { via: null, iface, protocol: 'ipv4' };
    // the kernel writes the gateway as four little-endian hex bytes
    const bytes = gateway.match(/../g)?.reverse() || [];
    if (bytes.length !== 4) return null;
    return { via: bytes.map((b) => parseInt(b, 16)).join('.'), iface, protocol: 'ipv4' };
  }
  return null;
}

/** /proc/net/ipv6_route: same question, IPv6. Fields: dst dstplen src srcplen nexthop metric … */
function parseDefaultRoute6(text) {
  if (!text) return null;
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [dst, dstplen, , , nexthop, , , , , iface] = f;
    if (!/^0+$/.test(dst) || dstplen !== '00') continue;
    if (!iface || iface === 'lo') continue;
    const via = /^0+$/.test(nexthop || '0')
      ? null
      : (nexthop.match(/.{4}/g) || []).join(':').replace(/\b0+/g, (m) => m).replace(/:{2,}/g, '::');
    return { via: via === '::' ? null : via, iface, protocol: 'ipv6' };
  }
  return null;
}

function parseResolv(text) {
  const nameservers = [];
  const search = [];
  if (text) {
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const [word, ...rest] = line.split(/\s+/);
      const value = rest.join(' ').trim();
      if (word === 'nameserver' && rest.length) {
        const ip = rest[0];
        if (/^[0-9a-f:.]+$/i.test(ip) && nameservers.length < 4) nameservers.push(ip);
      } else if (word === 'search' && value && search.length < 3) {
        search.push(value.slice(0, 200));
      } else if (word === 'domain' && value && !search.length) {
        search.push(value.slice(0, 200));
      }
    }
  }
  return { nameservers, search };
}

/* ------------------------------------------------------------------ */
/* the provider                                                        */
/* ------------------------------------------------------------------ */

export function createNetworkProvider({ read = defaultRead } = {}) {
  function interfaces() {
    const names = read.readDir(SYS_NET);
    if (!names) return null;
    const counters = parseNetDev(read.readText(PROC_NET_DEV));
    const addrMap = read.addresses() || {};
    const out = [];
    for (const name of names) {
      if (typeof name !== 'string' || !name || NOISE.has(name)) continue;
      if (!/^[A-Za-z0-9_.@:-]{1,32}$/.test(name)) continue; // kernel names only
      const base = `${SYS_NET}/${name}`;
      const operstate = String(read.readText(`${base}/operstate`) || '').trim().toLowerCase();
      const uevent = read.readText(`${base}/uevent`);
      const countersFor = counters.get(name) || null;
      const addrs = (addrMap[name] || [])
        .filter((a) => a && typeof a.address === 'string')
        .slice(0, 8)
        .map((a) => ({
          address: a.address,
          family: a.family === 'IPv6' ? 'ipv6' : 'ipv4',
          // a link-local address is real but not routable; say which it is rather than hiding it
          scope: a.family === 'IPv6' ? (/^fe80:/i.test(a.address) ? 'link' : 'global') : (a.internal ? 'host' : 'global'),
          prefixLength: typeof a.cidr === 'string' && a.cidr.includes('/') ? Number(a.cidr.split('/')[1]) || null : null,
        }));
      const speed = num(read.readText(`${base}/speed`));
      out.push({
        name,
        kind: deviceKind(read, name, uevent),
        state: STATE_WORDS.has(operstate) ? operstate : 'unknown',
        up: operstate === 'up' || operstate === 'unknown' ? operstate === 'up' : false,
        mtu: num(read.readText(`${base}/mtu`)),
        // -1 is what a virtual or wireless link reports for "link speed"; that is not 1 Mbps
        speedMbps: speed != null && speed > 0 && speed < 1_000_000 ? speed : null,
        addresses: addrs,
        rx: countersFor ? { bytes: countersFor.rxBytes, packets: countersFor.rxPackets, errors: countersFor.rxErrors, dropped: countersFor.rxDropped } : null,
        tx: countersFor ? { bytes: countersFor.txBytes, packets: countersFor.txPackets, errors: countersFor.txErrors, dropped: countersFor.txDropped } : null,
      });
    }
    out.sort((a, b) => (b.addresses.length - a.addresses.length) || a.name.localeCompare(b.name));
    return out;
  }

  function routes() {
    const table = read.readText(PROC_ROUTE);
    const table6 = read.readText(PROC_ROUTE6);
    const count = table ? Math.max(0, table.trim().split('\n').length - 1) : null;
    const count6 = table6 ? table6.trim().split('\n').filter(Boolean).length : null;
    const ipv4 = parseDefaultRoute(table);
    const ipv6 = parseDefaultRoute6(table6);
    const defaults = [ipv4, ipv6].filter(Boolean);
    return {
      defaultRoute: defaults[0] || null,
      defaultRoutes: defaults,
      routeCount: count,
      routeCount6: count6,
      // the table itself is never published — a homelab dashboard does not need it, and a
      // reader with an account is not automatically a reader of everything
      tableAvailable: false,
      note: 'Only the default route is shown. The full routing table is not exposed.',
    };
  }

  function dns() {
    const text = read.readText(RESOLV);
    const { nameservers, search } = parseResolv(text);
    return {
      available: !!text,
      nameservers,
      search,
      source: 'resolv.conf',
      // A stub resolver talks to something else (commonly a local resolver daemon). OpusHub
      // reports the address it was given and does not claim to know what is behind it.
      viaStubResolver: nameservers.length > 0 && nameservers.every((n) => /^127\./.test(n) || n === '::1'),
      note: text ? null : 'The resolver configuration is not readable from here.',
    };
  }

  async function check() {
    const list = interfaces();
    if (!list) {
      return {
        status: 'unavailable',
        capabilities: [],
        version: null,
        error: { code: 'not_supported', reason: 'This host does not expose interface information to OpusHub.' },
        data: null,
      };
    }
    const rt = routes();
    const resolv = dns();
    const containerized = !!read.containerized?.();
    const data = {
      interfaces: list,
      routes: rt,
      dns: resolv,
      counts: {
        interfaces: list.length,
        up: list.filter((i) => i.state === 'up').length,
        withAddress: list.filter((i) => i.addresses.length).length,
      },
      scope: containerized ? 'container' : 'host',
      // Honest, and it matters: with the default compose file this is OpusHub's own namespace.
      scopeNote: containerized
        ? 'OpusHub is reading the network namespace it runs in. With the default container setup that is the container namespace, not the host’s.'
        : null,
      at: Date.now(),
    };
    const capabilities = ['interfaces'];
    if (rt.defaultRoute) capabilities.push('routes');
    if (resolv.available) capabilities.push('dns');
    return { status: 'available', capabilities, version: null, error: null, data };
  }

  return {
    id: 'network',
    methods: { interfaces, routes, dns },
    check,
    _internals: { parseNetDev, parseDefaultRoute, parseDefaultRoute6, parseResolv, deviceKind },
  };
}

export const networkProvider = createNetworkProvider();
