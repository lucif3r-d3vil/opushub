// Address policy — one classifier, two policies.
//
// OpusHub has two places that must decide "may we talk to this address?", and they need *different*
// answers:
//
//   · the remote asset fetcher (providers/background.js) may only reach the public internet —
//     it is fetching a wallpaper, so loopback, LAN space and the cloud-metadata address must all
//     be refused;
//   · the monitoring engine (Phase 10A) monitors the operator's OWN services, which legitimately
//     live on RFC1918 space and ULA IPv6. It must still refuse the addresses that can never be a
//     service and are the classic SSRF pivots: loopback, link-local (169.254.169.254 lives there),
//     multicast, unspecified, documentation/benchmark space, and the IPv4-mapped/NAT64 forms of
//     all of the above.
//
// Two copies of "is 169.254.0.0/16 blocked?" is how one of them eventually stops being updated, so
// the classification lives here — once — and each caller states only *which classes it refuses*.
// Everything about an address is decided from the literal, never from a name: a caller that needs
// a hostname resolved validates every address the name yields (and monitoring then connects to the
// validated address itself — see monitoring/net.js — so a second DNS answer cannot change the
// destination).
import net from 'node:net';

/** The whole vocabulary. `invalid` means "not an address we could parse" — refused by everyone. */
export const ADDRESS_CLASSES = Object.freeze([
  'public',        // globally routable
  'private',       // RFC1918 10/8, 172.16/12, 192.168/16
  'shared',        // CGNAT 100.64/10
  'loopback',      // 127/8, ::1
  'link-local',    // 169.254/16 (incl. 169.254.169.254), fe80::/10
  'multicast',     // 224/4, ff00::/8
  'unspecified',   // 0/8, ::
  'benchmark',     // 198.18/15
  'documentation', // 192.0.2/24, 198.51.100/24, 203.0.113/24, 2001:db8::/32
  'unique-local',  // fc00::/7
  'discard',       // 100::/64
  'reserved',      // 240/4 and anything else not a unicast destination
  'invalid',       // not an IP at all
]);

/**
 * Classes the *remote asset fetcher* refuses. This is exactly the set the shipped background
 * checker has always refused — it is stated as data so that a change here is a visible change
 * to a security boundary rather than a rewrite of it.
 */
export const BLOCKED_FOR_REMOTE_FETCH = Object.freeze(new Set([
  'private', 'shared', 'loopback', 'link-local', 'multicast', 'unspecified',
  'benchmark', 'documentation', 'unique-local', 'discard', 'reserved', 'invalid',
]));

/**
 * Classes the *monitoring engine* refuses. Private (RFC1918), CGNAT and ULA addresses are
 * deliberately NOT here: those are where homelab services actually live.
 */
export const BLOCKED_FOR_MONITOR = Object.freeze(new Set([
  'loopback', 'link-local', 'multicast', 'unspecified', 'benchmark',
  'documentation', 'discard', 'reserved', 'invalid',
]));

/**
 * Classes that are a homelab's normal habitat: RFC1918, CGNAT (100.64/10) and IPv6 ULA. They are
 * reachable by monitoring (that is the point of a monitor on OpusGrid) and never by the remote
 * asset fetcher, and a monitor's target records which of the two worlds it lives in.
 */
export const INTERNAL_CLASSES = Object.freeze(new Set(['private', 'shared', 'unique-local']));

/**
 * Expand an IPv6 literal to eight 16-bit groups (handles `::`, an embedded dotted-quad tail and
 * a `%zone` suffix), else null.
 *
 * Phase 10A note: the parser inherited from the background fetcher sliced a dotted tail at the
 * *last dot*, so `::ffff:10.0.0.1` and `2001:db8::1` both came back unrecognised (and were
 * therefore refused by the fetch policy — conservatively, but by accident). The block lists are
 * unchanged; this only makes the classification of compressed addresses correct, which the
 * monitoring engine needs in order to allow a legitimate public IPv6 service.
 */
export function v6Groups(ip) {
  const addr = String(ip).toLowerCase().split('%')[0];
  let v4tail = null;
  let body = addr;
  const lastDot = addr.lastIndexOf('.');
  if (lastDot !== -1) {
    const colon = addr.lastIndexOf(':', lastDot);
    if (colon === -1) return null;
    const parts = addr.slice(colon + 1).split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    v4tail = [(parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]];
    body = addr.slice(0, colon + 1); // keep the trailing colon so `::` splitting still works
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const split = (h) => (h ? h.split(':').filter((g) => g !== '') : []);
  const left = split(halves[0]);
  const right = halves.length === 2 ? split(halves[1]) : [];
  for (const g of [...left, ...right]) if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  const known = left.length + right.length + (v4tail ? 2 : 0);
  if (halves.length === 1 && known !== 8) return null;   // no `::`: all eight groups must be present
  if (halves.length === 2 && known > 7) return null;     // `::` must stand for at least one group
  const groups = [
    ...left.map((g) => parseInt(g, 16)),
    ...new Array(8 - known).fill(0),
    ...right.map((g) => parseInt(g, 16)),
    ...(v4tail || []),
  ];
  return groups.length === 8 ? groups : null;
}

/** The four dotted octets of an embedded IPv4 inside a v6 group pair. */
const embeddedV4 = (g6, g7) => `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;

/** Classify one IPv4 literal. */
function classifyV4(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return 'invalid';
  const [a, b, c] = parts;
  if (a === 0) return 'unspecified';                       // 0.0.0.0/8
  if (a === 10) return 'private';                          // 10/8
  if (a === 127) return 'loopback';                        // 127/8
  if (a === 169 && b === 254) return 'link-local';         // 169.254/16 (incl. cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return 'shared';   // CGNAT 100.64/10
  if (a === 172 && b >= 16 && b <= 31) return 'private';   // 172.16/12
  if (a === 192 && b === 168) return 'private';            // 192.168/16
  if (a === 192 && b === 0 && c === 2) return 'documentation';   // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return 'documentation'; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'documentation';  // TEST-NET-3
  if (a === 198 && (b === 18 || b === 19)) return 'benchmark';    // 198.18/15
  if (a >= 224 && a <= 239) return 'multicast';            // 224/4
  if (a >= 240) return 'reserved';                         // 240/4 + 255.255.255.255
  return 'public';
}

/**
 * Classify one IP literal (v4 or v6). IPv4-mapped (`::ffff:a.b.c.d`) and NAT64
 * (`64:ff9b::/96`) addresses are classified by the IPv4 address they carry — that is the address
 * that will actually be connected to, so that is the address whose class matters.
 */
export function classifyIp(ip) {
  const s = String(ip ?? '').trim();
  if (!s) return 'invalid';
  if (net.isIPv4(s)) return classifyV4(s);
  if (!net.isIPv6(s)) return 'invalid';
  const g = v6Groups(s);
  if (!g) return 'invalid';
  const [g0, g1] = g;
  if (g.every((x) => x === 0)) return 'unspecified';                        // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback'; // ::1
  if ((g0 & 0xff00) === 0xff00) return 'multicast';                         // ff00::/8
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local';                        // fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return 'unique-local';                      // fc00::/7
  if (g0 === 0x0100 && g1 === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return 'discard'; // 100::/64
  if (g0 === 0x2001 && g1 === 0x0db8) return 'documentation';               // 2001:db8::/32
  // v4-mapped ::ffff:a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return classifyV4(embeddedV4(g[6], g[7]));
  // NAT64 64:ff9b::/96
  if (g0 === 0x0064 && g1 === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0) return classifyV4(embeddedV4(g[6], g[7]));
  return 'public';
}

/** Is this literal an address on the operator's own network (RFC1918 / CGNAT / ULA)? */
export const isInternalAddress = (ip) => INTERNAL_CLASSES.has(classifyIp(ip));

/**
 * The *shipped* rule set the remote asset fetcher has always used, expressed in terms of the
 * classifier where the two agree.
 *
 * Three checks are deliberately coarser than the classifier, and they stay that way:
 *   · `169.0.0.0/8` (not only `169.254/16`),
 *   · `100::/8` (not only `100::/64`),
 *   · `ff00:…` as a first group (the classifier blocks all of `ff00::/8`).
 * They were refused before Phase 10A; a tidier taxonomy is not a reason to start allowing an
 * address class that the background fetcher never reached.
 */
export function remoteFetchBlocked(ip) {
  const s = String(ip ?? '').trim();
  if (net.isIPv4(s) && classifyIp(s) !== 'invalid') {
    const a = Number(s.split('.')[0]);
    if (a === 169) return true;   // coarse, shipped behaviour (see above)
    if (a >= 224) return true;    // multicast + reserved
  }
  if (net.isIPv6(s) && classifyIp(s) !== 'invalid') {
    const g = v6Groups(s);
    if (g && (g[0] === 0xff00 || g[0] === 0x0100)) return true; // coarse, shipped behaviour
  }
  return BLOCKED_FOR_REMOTE_FETCH.has(classifyIp(s));
}

/** May the remote asset fetcher reach this address? (The name the background module uses.) */
export const allowedForRemoteFetch = (ip) => !remoteFetchBlocked(ip);

/** May the monitoring engine reach this address? */
export const allowedForMonitor = (ip) => !BLOCKED_FOR_MONITOR.has(classifyIp(ip));

/** Human wording for a refusal — never the address alone, always the reason. */
export function describeClass(cls) {
  switch (cls) {
    case 'loopback': return 'loopback (this host)';
    case 'link-local': return 'link-local (this includes the 169.254.169.254 metadata address)';
    case 'multicast': return 'multicast';
    case 'unspecified': return 'the unspecified address';
    case 'private': return 'private address space';
    case 'shared': return 'carrier-grade NAT space';
    case 'unique-local': return 'IPv6 unique-local space';
    case 'benchmark': return 'benchmarking space';
    case 'documentation': return 'documentation space';
    case 'discard': return 'discard-only space';
    case 'reserved': return 'reserved space';
    case 'invalid': return 'not an address OpusHub recognises';
    default: return String(cls);
  }
}
