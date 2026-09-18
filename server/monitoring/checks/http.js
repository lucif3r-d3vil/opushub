// The HTTP check — one request, bounded in every direction, and never a fetch proxy.
//
//   · the URL is parsed and validated on every check (scheme, credentials, host) — the stored
//     target is data, not a promise about the future;
//   · the host is resolved through monitoring/net.js, every address is classified, and the request
//     is then pinned to the validated address, so a second DNS answer cannot move it;
//   · redirects are followed at most MAX_REDIRECTS times, and *every hop is revalidated*: scheme,
//     credentials, downgrade, address class;
//   · the response **body is never read**. The socket is destroyed the moment the status line and
//     headers have arrived, so a 4 GB response costs one TCP round trip, and nothing from a
//     monitored service ever enters OpusHub's memory, let alone its database;
//   · the deadline is the monitor's own timeout, enforced twice (socket timeout + a hard deadline).
//
// What is recorded is exactly what a person needs to understand the result: when, how it ended,
// how long it took, and why. No bodies, no headers, no titles, no credentials.
import http from 'node:http';
import https from 'node:https';
import { MAX_REDIRECTS, parseHttpUrl, pinnedLookup, resolveHost as resolveHostDefault, validateRedirect } from '../net.js';

/** Result kinds this check may produce. */
const OK = 'ok';
const DEGRADED = 'degraded';
const FAIL = 'fail';
const UNKNOWN = 'unknown';

const USER_AGENT = 'OpusHub/0.1 (monitoring; +https://github.com/lucif3r-d3vil/opushub)';

/** One request attempt against a *pinned* address. Returns the status line and throws on transport errors. */
export function oneRequest(url, { timeoutMs, pinned } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const started = Date.now();
    let deadline = null;
    const finish = (fn, value) => { if (deadline) clearTimeout(deadline); fn(value); };
    const options = {
      method: 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: { 'user-agent': USER_AGENT, accept: '*/*', connection: 'close' },
      agent: false,
      // where the socket actually goes (see monitoring/net.js): the validated address. The Host
      // header and TLS SNI still carry the name, so a name-based service is reached correctly.
      lookup: pinned ? pinnedLookup(pinned.address, pinned.family) : undefined,
    };
    const req = lib.request(options, (res) => {
      const latencyMs = Date.now() - started;
      const statusCode = res.statusCode ?? null;
      const location = res.headers?.location ?? null;
      // the body is never wanted: dropping the socket here means a huge response costs nothing
      res.destroy();
      finish(resolve, { statusCode, headers: { location }, latencyMs });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('check timed out'), { code: 'ETIMEDOUT', errorType: 'timeout' })));
    req.on('error', (err) => finish(reject, err));
    // A second, transport-independent deadline: a socket that never answers must not hold a worker.
    deadline = setTimeout(() => req.destroy(Object.assign(new Error('check timed out'), { code: 'ETIMEDOUT', errorType: 'timeout' })), timeoutMs + 250);
    if (deadline && typeof deadline.unref === 'function') deadline.unref();
    req.end();
  });
}

const classifyError = (err) => {
  const code = err?.code || err?.cause?.code || '';
  const msg = String(err?.message || err);
  if (err?.errorType) return err.errorType;
  if (code === 'ETIMEDOUT' || /timed out|timeout|deadline/i.test(msg)) return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
  if (/certificate|self.signed|tls|ssl/i.test(msg) || String(code).startsWith('CERT_')) return 'tls';
  return 'network';
};

const failure = (kind, { at, latencyMs = null, statusCode = null, errorType = null, code = null, reason, hops = 0, evidence = null }) => ({
  kind, at, latencyMs, statusCode, errorType, code, reason, hops, evidence,
});

/**
 * Run one HTTP check.
 *
 * @param {object} target      `{ url }` — the endpoint to check (already resolved from the monitor)
 * @param {object} opts        `{ expected, timeoutMs, now, resolveHost, requestOne }`
 * @returns the canonical check result
 */
export async function checkHttp(target, {
  expected = null,
  timeoutMs = 5000,
  now = Date.now(),
  resolveHost = resolveHostDefault,
  requestOne = oneRequest,
  allowInternal = true,
} = {}) {
  const at = now;
  const parsed = parseHttpUrl(target?.url);
  if (!parsed.ok) return failure(UNKNOWN, { at, code: parsed.code, reason: `The endpoint is not checkable: ${parsed.reason}` });
  let current = parsed.url;

  const matched = (statusCode) => {
    if (statusCode == null) return false;
    if (expected?.status != null) return statusCode === expected.status;
    const min = expected?.min ?? 200;
    const max = expected?.max ?? 399;
    return statusCode >= min && statusCode <= max;
  };
  const expectedWords = expected?.status != null
    ? `HTTP ${expected.status}`
    : `HTTP ${expected?.min ?? 200}–${expected?.max ?? 399}`;

  let hops = 0;
  for (;;) {
    const resolved = await resolveHost(current.hostname, { allowInternal });
    if (!resolved.ok) {
      // A refused address class is a configuration problem, not an outage: it must never read as
      // "the service is down" (and must never open an incident).
      // A refused address class is a configuration problem (or a policy), not an outage: it must
      // never read as "the service is down" and must never open an incident.
      const refused = resolved.code === 'blocked_address' || resolved.code === 'internal_blocked';
      const kind = refused ? UNKNOWN : FAIL;
      return failure(kind, {
        at, code: resolved.code, errorType: refused ? resolved.code : 'dns',
        reason: resolved.reason, hops,
        evidence: { url: `${current.protocol}//${current.host}${current.pathname}` },
      });
    }

    let response;
    try {
      response = await requestOne(current, {
        timeoutMs,
        pinned: resolved.pinned ? { address: resolved.pinned, family: resolved.addresses[0].family } : null,
      });
    } catch (err) {
      const errorType = classifyError(err);
      return failure(FAIL, {
        at, errorType,
        reason: `No response (${errorType}).`,
        hops,
        evidence: { host: current.hostname, addressClass: resolved.addresses[0].klass, addressClasses: resolved.addresses.map((a) => a.klass) },
      });
    }

    const statusCode = response.statusCode;
    const location = response.headers?.location ?? null;
    const isRedirect = statusCode >= 300 && statusCode < 400 && !!location;

    if (isRedirect && hops < MAX_REDIRECTS) {
      hops += 1;
      const next = await validateRedirect(current.toString(), location, { resolveHost, allowInternal });
      if (!next.ok) {
        return failure(DEGRADED, {
          at, latencyMs: response.latencyMs, statusCode, code: next.code, errorType: 'redirect',
          reason: next.reason, hops,
          evidence: { redirectedFrom: `${current.protocol}//${current.host}${current.pathname}` },
        });
      }
      current = new URL(next.url);
      continue;
    }
    if (isRedirect && hops >= MAX_REDIRECTS) {
      return failure(DEGRADED, {
        at, latencyMs: response.latencyMs, statusCode, code: 'redirect_limit', errorType: 'redirect',
        reason: `More than ${MAX_REDIRECTS} redirects.`, hops,
        evidence: { redirectedFrom: current.host },
      });
    }

    if (matched(statusCode)) {
      return {
        kind: OK, at, latencyMs: response.latencyMs, statusCode, errorType: null, code: null,
        reason: `HTTP ${statusCode}`, hops,
        evidence: { addressClass: resolved.addresses[0].klass, addressClasses: resolved.addresses.map((a) => a.klass), hops },
      };
    }
    return failure(DEGRADED, {
      at, latencyMs: response.latencyMs, statusCode, code: 'unexpected_status', errorType: 'status',
      reason: `HTTP ${statusCode} (expected ${expectedWords}).`, hops,
      evidence: { addressClass: resolved.addresses[0].klass, addressClasses: resolved.addresses.map((a) => a.klass), expected: expectedWords },
    });
  }
}
