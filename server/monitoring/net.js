// The address policy for monitoring checks — "resolve once, validate, then connect to exactly that
// address".
//
// This is the module that makes "OpusHub monitors things" different from "OpusHub fetches
// arbitrary URLs". Three rules are implemented here and nowhere else:
//
//   1. **Validate the literal, then pin it.** A hostname is resolved by us, every address it yields
//      is classified (server/lib/ipPolicy.js), and the check then connects to the validated address
//      itself (`lookup` is overridden for the HTTP client; the TCP check connects to the address,
//      not the name). A DNS answer that changes between validation and connection cannot move the
//      destination — that is DNS-rebinding protection, and it is a property of the code path, not
//      a promise.
//   2. **Refuse the classes that can never be a service**: loopback, link-local (which is where
//      169.254.169.254 lives), multicast, unspecified, documentation/benchmark/discard space, and
//      anything unparseable. Private (RFC1918), CGNAT and IPv6 ULA addresses are **allowed** —
//      that is where a homelab's services actually live, and monitoring them is the entire point.
//      The safety here is that the *target* is not attacker-chosen: it is either resolved from the
//      canonical inventory or explicitly configured and validated, and no API accepts an arbitrary
//      URL to check (see server/monitoringApi.js).
//   3. **Revalidate every redirect.** Each hop is parsed again (http/https only, no credentials),
//      re-resolved, re-classified, and https→http downgrades are refused. A redirect to somewhere
//      that was never validated ends the check with a reason instead of a request.
import dns from 'node:dns/promises';
import net from 'node:net';
import { ADDRESS_CLASSES, BLOCKED_FOR_MONITOR, classifyIp, describeClass, isInternalAddress } from '../lib/ipPolicy.js';

/** Redirect hops a single HTTP check may follow. */
export const MAX_REDIRECTS = 3;
/** Addresses we are willing to consider for one hostname. */
export const MAX_ADDRESSES = 8;

let lookupFn = dns.lookup;
/** Tests inject a resolver; production uses the system one. */
export function __setLookup(fn) { lookupFn = fn || dns.lookup; }

/**
 * Classify one address for monitoring. Returns a refusal reason or null.
 *
 * Two layers, and they mean different things:
 *   · a class in `BLOCKED_FOR_MONITOR` (loopback, link-local/metadata, multicast, unspecified,
 *     documentation/benchmark/discard, invalid) is refused outright and can never be configured;
 *   · private/CGNAT/ULA addresses are *allowed by default* — a homelab's services live there — but
 *     they are internal targets: the monitor records that fact (`target.scope`), the UI shows it,
 *     and `allowInternal: false` turns the whole class off server-side without touching the
 *     always-blocked list.
 */
export function addressRefusal(ip, { allowInternal = true } = {}) {
  const cls = classifyIp(ip);
  if (BLOCKED_FOR_MONITOR.has(cls)) return { code: 'blocked_address', klass: cls, reason: `${ip} is in ${describeClass(cls)} space, which monitoring never reaches.` };
  if (!allowInternal && isInternalAddress(ip)) {
    return { code: 'internal_blocked', klass: cls, reason: `${ip} is on the local network, and this instance has been configured to monitor public endpoints only.` };
  }
  return null;
}

const KNOWN_CLASSES = new Set(ADDRESS_CLASSES);
/** An address (or an already-classified entry) → its class. */
const classOf = (a) => {
  const raw = typeof a === 'string' ? a : a?.address;
  return KNOWN_CLASSES.has(raw) ? raw : classifyIp(raw);
};

/**
 * The network scope of the addresses a check actually resolved to. Recorded on the target, so
 * "internal endpoint" is a fact on the record rather than something the reader has to infer.
 * Accepts addresses (`'10.0.0.9'`), resolved entries (`{ address }`) or class names (`'private'`).
 */
export function scopeOf(addresses) {
  const classes = (Array.isArray(addresses) ? addresses : [])
    .map(classOf)
    .filter((c) => c !== 'invalid');
  if (!classes.length) return null;
  const internal = classes.filter((c) => c === 'private' || c === 'shared' || c === 'unique-local').length;
  if (internal === classes.length) return 'internal';
  return internal === 0 ? 'public' : 'mixed';
}

/**
 * Resolve a host and validate every address it yields.
 * Returns `{ ok: true, host, addresses, pinned }` — `pinned` is the address the caller must
 * actually connect to — or `{ ok: false, code, reason }`.
 */
export async function resolveHost(host, { lookup = lookupFn, allowInternal = true } = {}) {
  const name = String(host || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!name) return { ok: false, code: 'invalid_host', reason: 'No host to reach.' };

  if (net.isIP(name)) {
    const refusal = addressRefusal(name, { allowInternal });
    if (refusal) return { ok: false, ...refusal };
    return { ok: true, host: name, addresses: [{ address: name, family: net.isIPv6(name) ? 6 : 4, klass: classifyIp(name) }], pinned: name };
  }

  let records;
  try {
    records = await lookup(name, { all: true, verbatim: true });
  } catch {
    return { ok: false, code: 'dns', reason: `Could not resolve ${name}.` };
  }
  const list = Array.isArray(records) ? records : (records ? [records] : []);
  if (!list.length) return { ok: false, code: 'dns', reason: `${name} resolved to no address.` };

  const addresses = [];
  for (const r of list.slice(0, MAX_ADDRESSES)) {
    const address = String(r?.address || '');
    const refusal = addressRefusal(address, { allowInternal });
    if (refusal) {
      // A name that points at a refused class is refused as a whole: monitoring must not "use the
      // other answer" and quietly talk to a host that also publishes a loopback address.
      return { ok: false, code: refusal.code, reason: `${name} resolves to ${refusal.reason}` };
    }
    addresses.push({ address, family: Number(r?.family) || (net.isIPv6(address) ? 6 : 4), klass: classifyIp(address) });
  }
  if (!addresses.length) return { ok: false, code: 'dns', reason: `${name} resolved to no usable address.` };
  return { ok: true, host: name, addresses, pinned: addresses[0].address };
}

/**
 * Validate one redirect hop. `from` is the URL that answered with the redirect, `location` its
 * Location header. Returns `{ ok: true, url }` or `{ ok: false, code, reason }`.
 *
 * Refused: a scheme that is not http(s), credentials, a downgrade from https to http, a target
 * whose name resolves into a refused address class, and an unparseable Location.
 */
export async function validateRedirect(from, location, { resolveHost: resolve = resolveHost, allowInternal = true } = {}) {
  let next;
  try { next = new URL(String(location), String(from)); } catch { return { ok: false, code: 'redirect', reason: 'The redirect target is not a URL.' }; }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    return { ok: false, code: 'redirect_scheme', reason: `The redirect target uses ${next.protocol}//, which is never followed.` };
  }
  if (next.username || next.password) {
    return { ok: false, code: 'redirect_credentials', reason: 'The redirect target carries credentials, which are never followed.' };
  }
  if (String(from).startsWith('https:') && next.protocol === 'http:') {
    return { ok: false, code: 'redirect_downgrade', reason: 'The redirect downgrades an https check to http, which is never followed.' };
  }
  const resolved = await resolve(next.hostname, { allowInternal });
  if (!resolved.ok) return { ok: false, code: `redirect_${resolved.code}`, reason: `The redirect target was refused: ${resolved.reason}` };
  next.hash = '';
  return { ok: true, url: next.toString(), pinned: resolved.pinned, addresses: resolved.addresses };
}

/**
 * A `lookup` function that always answers with one validated address, so the client connects
 * exactly where validation looked. Node calls it as `lookup(host, options, cb)`; depending on the
 * agent, `options.all` may be set — both shapes are handled.
 */
export function pinnedLookup(address, family) {
  const fam = Number(family) || 4;
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options || {});
    if (opts.all) return process.nextTick(() => cb(null, [{ address, family: fam }]));
    return process.nextTick(() => cb(null, address, fam));
  };
}

/** Non-throwing parse of an http(s) endpoint — the check layer never trusts its caller's string. */
export function parseHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, code: 'invalid_url', reason: 'Not a URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, code: 'scheme', reason: `${u.protocol}// is not a monitored protocol.` };
  if (u.username || u.password) return { ok: false, code: 'credentials', reason: 'Credential-bearing URLs are never checked.' };
  if (!u.hostname) return { ok: false, code: 'invalid_url', reason: 'The URL has no host.' };
  return { ok: true, url: u };
}

/** A single explicit TCP endpoint — validated, never a range, never a list. */
const HOST_GRAMMAR = /^[a-z0-9]([a-z0-9._:-]*[a-z0-9])?$/i;
export function parseTcpEndpoint(host, port) {
  const h = String(host ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  // one host: no separators, no CIDR, no lists, no URLs. A monitor is not a scanner.
  // `10.0.0.1-10.0.0.50` is a range that happens to look like a hostname: a scanner's input, and
  // never a monitor's. The model refuses it at configuration time; the check refuses it again.
  if (!h || /[\s,]/.test(h) || /\d\s*-\s*\d/.test(h) || !HOST_GRAMMAR.test(h) || h.includes('*')) {
    return { ok: false, code: 'invalid_host', reason: 'The TCP monitor needs a single explicit host.' };
  }
  const p = String(port ?? '').trim();
  if (!/^\d{1,5}$/.test(p)) return { ok: false, code: 'invalid_port', reason: 'The TCP monitor needs a single explicit port (no ranges, no lists).' };
  const n = Number(p);
  if (n < 1 || n > 65535) return { ok: false, code: 'invalid_port', reason: 'The port must be between 1 and 65535.' };
  return { ok: true, host: h, port: n };
}
