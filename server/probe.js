// Safe HTTP health probing — strictly bounded, never an arbitrary fetch.
//
// ONLY URLs from trusted discovery may be probed: a service's own resolved URL whose source is
// `traefik`, `published-port`, or `manual` (the last is operator configuration that passed
// validation). There is no endpoint that accepts a URL — callers name a *service*, and the
// server resolves which URL (if any) that service owns. A service with no URL is `not-checked`,
// which is an honest answer, not a failure.
//
// Bounds (every one of them load-bearing):
//   · timeout 5s per attempt; at most 3 redirects, each re-validated (http/https only, no
//     userinfo, no downgrade surprises beyond what the hop limit allows)
//   · response body is drained to at most 64 KB and then discarded — status + timing only,
//     nothing is stored
//   · one in-flight probe per URL (single-flight), one result cached per URL for 60 s, global
//     concurrency cap of 4 — a page showing 30 services cannot probe-storm the LAN
//   · per-URL minimum interval of 30 s between real attempts
//
// Private addresses are LEGITIMATE targets here (LAN services live on RFC1918 space) — unlike
// the background-image fetcher, which must never touch them. The SSRF boundary for THIS module
// is origin trust (discovery/config only) plus the bounds above, not address filtering.
import http from 'node:http';
import https from 'node:https';

export const PROBE_TIMEOUT_MS = 5000;
export const PROBE_MAX_REDIRECTS = 3;
export const PROBE_MAX_BYTES = 64 * 1024;
export const PROBE_CACHE_MS = 60_000;
export const PROBE_MIN_INTERVAL_MS = 30_000;
const MAX_CONCURRENT = 4;

const TRUSTED_SOURCES = new Set(['traefik', 'published-port', 'manual']);

/** url → { at, value } — the shared verdict cache. */
const cache = new Map();
/** url → in-flight promise (single-flight). */
const inflight = new Map();
let active = 0;
const waiting = [];

function acquire() {
  if (active < MAX_CONCURRENT) { active += 1; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  active -= 1;
  const next = waiting.shift();
  if (next) { active += 1; next(); }
}

/** Validate one hop. Returns a URL, or throws with a public-safe message. */
function checkedHop(raw) {
  let u;
  try { u = new URL(String(raw)); }
  catch { throw Object.assign(new Error('not a usable URL'), { errorType: 'invalid-url' }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error(`refused scheme ${u.protocol}`), { errorType: 'scheme' });
  }
  if (u.username || u.password) {
    throw Object.assign(new Error('credential-bearing URLs are never probed'), { errorType: 'credentials' });
  }
  if (!u.hostname) throw Object.assign(new Error('no host to probe'), { errorType: 'invalid-url' });
  return u;
}

function classifyError(err) {
  const code = err?.cause?.code || err?.code || '';
  const msg = String(err?.message || err);
  if (/timeout|timed out|abort/i.test(msg) || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|dns|resolve/i.test(msg)) return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
  if (/certificate|tls|ssl|CERT_/i.test(msg) || String(code).startsWith('CERT_') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'tls';
  if (err?.errorType) return err.errorType;
  return 'network';
}

function oneAttempt(target) {
  return new Promise((resolve, reject) => {
    const lib = target.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = lib.request(target, { method: 'GET', timeout: PROBE_TIMEOUT_MS }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes >= PROBE_MAX_BYTES) res.destroy(); // enough: status + timing only
      });
      res.on('end', () => resolve({ res, latencyMs: Date.now() - started }));
      res.on('close', () => resolve({ res, latencyMs: Date.now() - started }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('probe timed out'), { errorType: 'timeout' })));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Probe one trusted URL. `source` must name where the URL came from; untrusted origins are
 * refused without a single packet. Returns:
 *   { checked: true, reachable, statusCode, latencyMs, checkedAt, source, hops, errorType }
 * or { checked: false, code: 'not_checked', reason, source } when no attempt was made.
 */
export async function probeUrl(rawUrl, { source = null, fetchImpl = null } = {}) {
  const checkedAt = new Date().toISOString();
  if (!TRUSTED_SOURCES.has(source)) {
    return { checked: false, code: 'not_checked', reason: `URLs from “${source || 'unknown'}” are not probed.`, source, checkedAt };
  }
  let first;
  try { first = checkedHop(rawUrl); }
  catch (err) {
    return { checked: true, reachable: false, statusCode: null, latencyMs: null, checkedAt, source, hops: 0, errorType: err.errorType || 'invalid-url' };
  }
  const key = first.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < PROBE_CACHE_MS) return { ...hit.value, cached: true };
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    await acquire();
    try {
      let current = first;
      let hops = 0;
      for (;;) {
        let attempt;
        try {
          attempt = fetchImpl ? await fetchImpl(current.toString()) : await oneAttempt(current);
        } catch (err) {
          const errorType = classifyError(err);
          const value = { checked: true, reachable: false, statusCode: null, latencyMs: null, checkedAt, source, hops, errorType };
          cache.set(key, { at: Date.now(), value });
          return value;
        }
        const { res, latencyMs } = attempt;
        const statusCode = res.statusCode ?? null;
        const location = res.headers?.location;
        const redirect = statusCode >= 300 && statusCode < 400 && location;
        if (redirect) {
          hops += 1;
          if (hops > PROBE_MAX_REDIRECTS) {
            const value = { checked: true, reachable: true, statusCode, latencyMs, checkedAt, source, hops, errorType: 'redirect-limit' };
            cache.set(key, { at: Date.now(), value });
            return value;
          }
          try {
            current = checkedHop(new URL(location, current).toString());
          } catch {
            const value = { checked: true, reachable: true, statusCode, latencyMs, checkedAt, source, hops, errorType: 'redirect-target' };
            cache.set(key, { at: Date.now(), value });
            return value;
          }
          continue;
        }
        // Any final response (even a 500) proves reachability; the health MODEL judges the code.
        const value = { checked: true, reachable: true, statusCode, latencyMs, checkedAt, source, hops, errorType: null };
        cache.set(key, { at: Date.now(), value });
        return value;
      }
    } finally {
      release();
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

/** Test helper — verdict caches are process-global state. */
export function _resetProbes() { cache.clear(); inflight.clear(); }
