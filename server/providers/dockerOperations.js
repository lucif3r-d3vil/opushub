// DockerOperationsAdapter — the ONLY module in OpusHub that can change anything on the engine.
//
// Why it is separate from server/providers/docker.js
// -------------------------------------------------
// The read provider is GET-only by construction, and a mechanical proof asserts that (see
// server/phase7-proof.test.js). Mixing writes into it would either weaken that proof or make it
// unreadable. So: two modules, two guarantees.
//
//   DockerReadProvider        (docker.js)             GET only; no mutation endpoint exists in it
//   DockerOperationsAdapter   (this file)             three endpoints, three methods, no more
//
// What exists here
// ----------------
//   POST /v<api>/containers/<id>/start
//   POST /v<api>/containers/<id>/stop
//   POST /v<api>/containers/<id>/restart
//
// What does NOT exist here, and must never be added without revisiting the whole phase
// ------------------------------------------------------------------------------------
//   • no request(method, path) / dockerCall(...) / execute(...) — there is no generic helper, and
//     `post()` below is module-private and takes only a path suffix from a frozen allow-list
//   • no `/exec`, `/kill`, `/remove`, `/prune`, `/commit`, `/rename`, `/update`, `/pause`,
//     `/unpause`, `/attach`, `/resize`, `/copy`, `/archive`, no `/images/*`, `/volumes/*`,
//     `/networks/*`, `/containers/create`, no compose endpoints
//   • no query parameters at all (no `t=`, no `force=`, no `signal=`) — every call is exactly
//     the daemon's default lifecycle behaviour for that endpoint
//   • no request body
//   • no way for a caller to choose an endpoint: the three exported functions are the interface
//
// The container id is validated before it is ever interpolated into a path: 12 or 64 lowercase
// hex characters, nothing else. It comes from OpusHub's own inventory (see operations/targets.js),
// never from a request body.
//
// Engine error bodies are logged server-side (under OPUSHUB_DEBUG) and never returned: the
// browser receives our own classification plus the HTTP status code, and nothing else.
import fs from 'node:fs';
import http from 'node:http';
import * as readDocker from './docker.js';

/** The complete set of mutation endpoints OpusHub can reach. Frozen. Exhaustive. */
const OP_PATHS = Object.freeze({
  start: '/start',
  stop: '/stop',
  restart: '/restart',
});

const CONTAINER_ID = /^[0-9a-f]{12}$|^[0-9a-f]{64}$/;
const MAX_BODY = 4096; // lifecycle responses are empty; anything larger is not one

/**
 * Where the write channel lives.
 *
 * Default: the same endpoint discovery uses. That is the small, honest architecture — one socket,
 * one code path that can write, and a read path that provably cannot.
 *
 * Optional: `OPUSHUB_OPERATIONS_SOCKET` points the write channel at a *different* socket, for
 * operators who want the separation enforced outside OpusHub as well (a Filtering socket proxy
 * that exposes only container lifecycle). OpusHub ships no sidecar of its own: a second service
 * is a second thing to secure, update and trust, and the boundary here is enforced in code.
 */
export function resolveOperationsEndpoint() {
  const explicit = String(process.env.OPUSHUB_OPERATIONS_SOCKET || '').trim();
  if (explicit) return { socket: explicit, dedicated: true };
  const ep = readDocker.resolveEndpoint();
  if (ep?.socket) return { socket: ep.socket, dedicated: false };
  if (ep?.host) return { host: ep.host, port: ep.port, dedicated: false };
  return { missing: true, dedicated: false };
}

const PUBLIC_REASONS = {
  'not-configured': 'Docker operations are not available — no engine endpoint is configured.',
  'socket-missing': 'The Docker operations socket is configured but not present on the server.',
  unreachable: 'The Docker engine is not responding, so no operation can run.',
};

/** Whether the write channel is usable right now. Never leaks a socket path. */
export function operationsAvailability() {
  const ep = resolveOperationsEndpoint();
  if (ep.missing) {
    return { ok: false, state: 'not-configured', reason: 'no operations endpoint resolved', public: PUBLIC_REASONS['not-configured'], dedicated: false };
  }
  if (ep.socket) {
    try {
      if (!fs.statSync(ep.socket).isSocket()) {
        return { ok: false, state: 'socket-missing', reason: 'operations path is not a socket', public: PUBLIC_REASONS['socket-missing'], dedicated: ep.dedicated };
      }
    } catch {
      return { ok: false, state: 'socket-missing', reason: 'operations socket not present', public: PUBLIC_REASONS['socket-missing'], dedicated: ep.dedicated };
    }
  }
  return { ok: true, state: 'connected', ep, dedicated: ep.dedicated };
}

/** The availability shape allowed across the API boundary: a verdict and a sentence. No paths. */
export function publicOperationsStatus(probed) {
  const a = operationsAvailability();
  if (!a.ok) return { ok: false, state: a.state, reason: a.public, dedicated: a.dedicated };
  if (probed === false) return { ok: false, state: 'unreachable', reason: PUBLIC_REASONS.unreachable, dedicated: a.dedicated };
  return { ok: true, state: 'connected', reason: null, dedicated: a.dedicated };
}

/** Prove the write channel answers before we promise anything. One GET, short timeout. */
export async function probeOperations({ timeoutMs = 3000 } = {}) {
  const a = operationsAvailability();
  if (!a.ok) return false;
  try {
    const { status } = await get('/version', timeoutMs);
    return status >= 200 && status < 400;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* transport                                                           */
/* ------------------------------------------------------------------ */

/** A read on the operations channel — used only to prove the daemon answers. */
function get(pathname, timeoutMs) {
  const a = operationsAvailability();
  if (!a.ok) return Promise.reject(Object.assign(new Error(a.reason), { unavailable: true }));
  const ep = a.ep;
  const opts = ep.socket ? { socketPath: ep.socket } : { host: ep.host, port: ep.port };
  return new Promise((resolve, reject) => {
    const req = http.get({ ...opts, path: `/v${apiVersion()}${pathname}`, headers: { host: 'docker' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('docker operations request timed out')));
    req.on('error', reject);
  });
}

/**
 * The one place an HTTP method is written in this file.
 *
 * `op` must be a key of `OP_PATHS`; anything else throws before a socket is touched. `id` must be
 * a full container id. No body, no query string, no headers beyond Host.
 *
 * @returns {Promise<{ok:true, status:number} | {ok:false, code:string, status:number}>}
 */
function post(op, id, timeoutMs) {
  const suffix = Object.prototype.hasOwnProperty.call(OP_PATHS, op) ? OP_PATHS[op] : null;
  if (!suffix) throw new Error(`docker operations: refused unlisted endpoint: ${String(op).slice(0, 40)}`);
  if (typeof id !== 'string' || !CONTAINER_ID.test(id)) {
    throw new Error('docker operations: refused a container id that is not a full container id');
  }
  const a = operationsAvailability();
  if (!a.ok) {
    return Promise.resolve({ ok: false, code: a.state === 'socket-missing' ? 'socket_missing' : 'docker_unavailable', status: null });
  }
  const ep = a.ep;
  const opts = ep.socket ? { socketPath: ep.socket } : { host: ep.host, port: ep.port };
  const path = `/v${apiVersion()}/containers/${encodeURIComponent(id)}${suffix}`;
  const started = Date.now();

  return new Promise((resolve) => {
    const req = http.request({ ...opts, path, method: 'POST', headers: { host: 'docker', 'content-length': 0 } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c);
      });
      res.on('end', () => {
        const status = res.statusCode || 0;
        const body = Buffer.concat(chunks).toString('utf8').trim();
        const ms = Date.now() - started;
        // The daemon's own text is for the server log only: it can name host paths.
        if (status >= 400 && process.env.OPUSHUB_DEBUG) {
          console.warn(`[docker-ops] POST …${suffix} → ${status} in ${ms}ms: ${body.slice(0, 300)}`);
        }
        if (status >= 200 && status < 300) return resolve({ ok: true, status, ms });
        if (status === 304) return resolve({ ok: true, status, ms, unchanged: true }); // already in that state
        if (status === 404) return resolve({ ok: false, code: 'container_missing', status, ms });
        if (status === 409) return resolve({ ok: false, code: 'conflict', status, ms });
        if (status === 401 || status === 403) return resolve({ ok: false, code: 'permission_denied', status, ms });
        if (status === 429) return resolve({ ok: false, code: 'engine_busy', status, ms });
        return resolve({ ok: false, code: 'engine_error', status, ms });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
      resolve({ ok: false, code: 'timeout', status: null });
    });
    req.on('error', (err) => {
      const code = /EACCES|EPERM/.test(String(err?.message)) ? 'permission_denied'
        : /ENOENT/.test(String(err?.message)) ? 'socket_missing'
          : /ECONNREFUSED|ECONNRESET/.test(String(err?.message)) ? 'docker_unavailable'
            : err?.message === 'timeout' ? 'timeout' : 'docker_unavailable';
      if (process.env.OPUSHUB_DEBUG) console.warn(`[docker-ops] POST …${suffix} failed: ${err?.message}`);
      resolve({ ok: false, code, status: null });
    });
    req.end();
  });
}

/** The API version the read client negotiated — one negotiated version for both channels. */
function apiVersion() {
  try { return readDocker._internals.apiVersion; } catch { return '1.43'; }
}

/* ------------------------------------------------------------------ */
/* the interface                                                       */
/* ------------------------------------------------------------------ */

/** Start a stopped container. */
export function startContainer(id, { timeoutMs = 10_000 } = {}) {
  return post('start', id, timeoutMs);
}

/** Stop a running container. The daemon's own stop sequence (SIGTERM, then SIGKILL) applies. */
export function stopContainer(id, { timeoutMs = 15_000 } = {}) {
  return post('stop', id, timeoutMs);
}

/** Restart a container. */
export function restartContainer(id, { timeoutMs = 25_000 } = {}) {
  return post('restart', id, timeoutMs);
}

/** Test/ops visibility — the endpoint set is the security boundary, so let tests read it. */
export const _internals = {
  OP_PATHS,
  CONTAINER_ID,
  get apiVersion() { return apiVersion(); },
};
