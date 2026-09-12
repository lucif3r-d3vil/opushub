// "What address would a browser use to reach this machine?" — resolved once, then cached.
// Deliberately conservative: no default domain, no guess. Signals, in order:
//   1. OPUSHUB_HOST_ADDRESS (operator intent — wins, and skips probing entirely)
//   2. the outbound interface the kernel would route through (UDP connect: no packets are sent,
//      this only asks the routing table) — correct whenever OpusHub shares the host's netns,
//      which is the normal deployment for a tool that mounts /var/run/docker.sock
//   3. the first non-internal IPv4 on a physical-looking interface
// A bridge/veth address (172.17.x.…) is *not* an answer: it names the container, not the host.
import os from 'node:os';
import dgram from 'node:dgram';

const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|br[0-9]|cni|flannel|kube|lo$|lo@)/i;

function outboundAddress(timeoutMs = 150) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.close(); } catch { /* already */ } resolve(v); } };
    let sock;
    try {
      sock = dgram.createSocket('udp4');
      sock.once('error', () => finish(null));
      sock.setTimeout(timeoutMs, () => finish(null));
      // connect() on a UDP socket performs no I/O; it just consultes the routing table so
      // `sock-address` reports the source address a real packet would use.
      sock.connect(53, '8.8.8.8', () => {
        try { finish(sock.address().address || null); } catch { finish(null); }
      });
    } catch { finish(null); }
  });
}

const USELESS = (ip) => !ip || ip.startsWith('169.254.') || ip.startsWith('127.') || ip === '0.0.0.0';
const SITE_LOCAL = (ip) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

function physicalAddress() {
  const ifaces = os.networkInterfaces();
  let any = null;
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || USELESS(a.address)) continue;
      if (SITE_LOCAL(a.address)) return a.address;
      any ||= a.address;
    }
  }
  return any;
}

let cache = null;

/** { address: string|null, source: 'env'|'outbound'|'interface'|'none', interfaces } */
export async function hostAddress({ force = false } = {}) {
  if (cache && !force) return cache;
  const fromEnv = String(process.env.OPUSHUB_HOST_ADDRESS || '').trim();
  const interfaces = os.networkInterfaces();
  let out = null;
  if (!fromEnv) out = await outboundAddress();
  const probe = out && !USELESS(out) ? out : null;
  const fallback = probe ? null : physicalAddress();
  cache = {
    address: fromEnv || probe || fallback || null,
    source: fromEnv ? 'env' : out ? 'outbound' : fallback ? 'interface' : 'none',
    interfaces,
  };
  return cache;
}

export function describe() {
  return cache ? { address: cache.address, source: cache.source } : { address: null, source: 'not-resolved' };
}
