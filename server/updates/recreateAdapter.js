// DockerControlAdapter — Phase 10C's dedicated recreate adapter, extended in Phase 10D into the
// single enumerated create/recreate/remove surface of OpusHub.
//
// FROZEN ALLOW-LIST OF DOCKER ENGINE API CALLS (the table below is the boundary; nothing else in
// this file, or anywhere else, can spell an engine mutation):
//
//   pull               POST   /images/create?fromImage=<ref>          (+ X-Registry-Auth, server-side only)
//   inspect            GET    /containers/<id>/json
//   stop               POST   /containers/<id>/stop?t=<1..60>
//   rename             POST   /containers/<id>/rename?name=<safe>
//   create             POST   /containers/create?name=<safe>          (allow-listed body, see containers/spec.js)
//   start              POST   /containers/<id>/start
//   remove             DELETE /containers/<id>?v=0&force=<0|1>        (v=0 ALWAYS — volumes are never deleted)
//   update             POST   /containers/<id>/update                 (in-place: restart policy, resources)
//   networkConnect     POST   /networks/<net>/connect
//   networkDisconnect  POST   /networks/<net>/disconnect
//   networkCreate      POST   /networks/create                        (stack-owned networks only)
//   networkRemove      DELETE /networks/<net>                         (stack-owned networks only)
//   volumeCreate       POST   /volumes/create                         (named volumes; never removed)
//
// Architectural guarantees:
// - Module-private transport; no generic request helper is exported and `op` must be a key of
//   ENDPOINTS — the transport throws before a socket is touched otherwise
// - Container ids strictly validated via /^[0-9a-f]{12}$|^[0-9a-f]{64}$/
// - Names strictly sanitized via /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/
// - No exec, no attach, no shell, no compose CLI, no volume deletion, no prune, no commit
// - Engine error bodies are never returned to callers verbatim beyond a bounded, sanitized detail

import http from 'node:http';
import * as readDocker from '../providers/docker.js';
import { operationsAvailability } from '../providers/dockerOperations.js';

const CONTAINER_ID_RE = /^[0-9a-f]{12}$|^[0-9a-f]{64}$/;
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
// a network reference: a full/short id or a name (compose network names contain `_` and `-`)
const NETWORK_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const IMAGE_REF_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:(?::[0-9]+)?\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

/** The complete, frozen set of engine calls this module can make. */
const ENDPOINTS = Object.freeze({
  pull: Object.freeze({ method: 'POST', path: () => '/images/create' }),
  inspect: Object.freeze({ method: 'GET', path: (id) => `/containers/${encodeURIComponent(id)}/json` }),
  stop: Object.freeze({ method: 'POST', path: (id) => `/containers/${encodeURIComponent(id)}/stop` }),
  rename: Object.freeze({ method: 'POST', path: (id) => `/containers/${encodeURIComponent(id)}/rename` }),
  create: Object.freeze({ method: 'POST', path: () => '/containers/create' }),
  start: Object.freeze({ method: 'POST', path: (id) => `/containers/${encodeURIComponent(id)}/start` }),
  remove: Object.freeze({ method: 'DELETE', path: (id) => `/containers/${encodeURIComponent(id)}` }),
  update: Object.freeze({ method: 'POST', path: (id) => `/containers/${encodeURIComponent(id)}/update` }),
  networkConnect: Object.freeze({ method: 'POST', path: (net) => `/networks/${encodeURIComponent(net)}/connect` }),
  networkDisconnect: Object.freeze({ method: 'POST', path: (net) => `/networks/${encodeURIComponent(net)}/disconnect` }),
  networkCreate: Object.freeze({ method: 'POST', path: () => '/networks/create' }),
  networkRemove: Object.freeze({ method: 'DELETE', path: (net) => `/networks/${encodeURIComponent(net)}` }),
  volumeCreate: Object.freeze({ method: 'POST', path: () => '/volumes/create' }),
});

function apiVersion() {
  try { return readDocker._internals.apiVersion; } catch { return '1.43'; }
}

/** A short, sanitized version of the daemon's own message — never a host path, never a token. */
function safeDetail(json, raw) {
  const msg = json?.message || (typeof raw === 'string' ? raw : '');
  return String(msg || '')
    .replace(/\/[^\s"']+/g, '<path>')
    .replace(/(token|secret|password|authorization)[^\s]*/gi, '<redacted>')
    .slice(0, 200) || null;
}

/** Module-private transport. `op` MUST be a key of ENDPOINTS. */
function requestEngine(op, ref = null, { query = null, body = null, headers: extraHeaders = null, timeoutMs = 60_000 } = {}) {
  const ep = Object.prototype.hasOwnProperty.call(ENDPOINTS, op) ? ENDPOINTS[op] : null;
  if (!ep) throw new Error(`docker control: refused unlisted endpoint: ${String(op).slice(0, 40)}`);
  const avail = operationsAvailability();
  if (!avail.ok) {
    return Promise.resolve({
      ok: false,
      code: avail.state === 'socket-missing' ? 'socket_missing' : 'docker_unavailable',
      status: null,
      error: avail.reason,
    });
  }

  const endpoint = avail.ep;
  const opts = endpoint.socket ? { socketPath: endpoint.socket } : { host: endpoint.host, port: endpoint.port };
  let fullPath = `/v${apiVersion()}${ep.path(ref)}`;
  if (query) {
    const q = new URLSearchParams(query).toString();
    if (q) fullPath += `?${q}`;
  }

  const payload = body ? JSON.stringify(body) : null;
  const headers = {
    host: 'docker',
    'content-length': payload ? Buffer.byteLength(payload) : 0,
    ...(extraHeaders || {}),
  };
  if (payload) headers['content-type'] = 'application/json';

  return new Promise((resolve) => {
    const req = http.request({ ...opts, path: fullPath, method: ep.method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size <= 512 * 1024) chunks.push(c); // cap at 512 KB
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        const status = res.statusCode || 0;
        const ok = status >= 200 && status < 300;
        // a pull streams progress JSON lines; an error inside the stream still ends with 200
        if (ok && op === 'pull' && /"error"\s*:/.test(raw)) {
          const line = raw.split('\n').reverse().find((l) => /"error"\s*:/.test(l));
          let errJson = null;
          try { errJson = JSON.parse(line); } catch {}
          return resolve({ ok: false, status, code: 'pull_failed', detail: safeDetail({ message: errJson?.error }, line) });
        }
        if (process.env.OPUSHUB_DEBUG && !ok) console.warn(`[docker-control] ${ep.method} ${op} → ${status}: ${raw.slice(0, 300)}`);
        resolve({
          ok,
          status,
          json: ok ? json : null,
          code: ok ? 'ok'
            : status === 404 ? 'not_found'
              : status === 409 ? 'conflict'
                : status === 304 ? 'unchanged'
                  : status === 401 || status === 403 ? 'permission_denied'
                    : status === 400 ? 'bad_request'
                      : 'engine_error',
          detail: ok ? null : safeDetail(json, raw),
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Docker control operation timed out'));
      resolve({ ok: false, code: 'timeout', status: 504 });
    });

    req.on('error', (err) => {
      resolve({ ok: false, code: 'connection_error', status: null, detail: String(err?.message || '').slice(0, 120) });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/** Whether a string is an image reference this adapter will pass to the daemon. */
export function isValidImageRef(ref) {
  return typeof ref === 'string' && ref.length <= 300 && IMAGE_REF_RE.test(ref.trim());
}

/** Whether a string is a container name this adapter will pass to the daemon. */
export function isSafeName(name) {
  return typeof name === 'string' && SAFE_NAME_RE.test(String(name).replace(/^\//, ''));
}

/**
 * Pull an image. `registryAuth` is an optional base64url-encoded X-Registry-Auth document minted
 * server-side by the registries module — it is a header, never logged, never returned.
 */
export async function pullImage(imageRef, { timeoutMs = 120_000, registryAuth = null } = {}) {
  if (!isValidImageRef(imageRef)) {
    return { ok: false, code: 'bad_image', reason: 'Invalid image reference' };
  }
  const headers = registryAuth ? { 'x-registry-auth': String(registryAuth) } : null;
  const res = await requestEngine('pull', null, { query: { fromImage: imageRef.trim() }, headers, timeoutMs });
  if (!res.ok) return { ...res, reason: res.detail || 'Failed to pull image' };
  return res;
}

/** GET /containers/<id>/json — the full inspect, for the recreate engine and the editor only. */
export async function inspectContainer(id, { timeoutMs = 15_000 } = {}) {
  if (!CONTAINER_ID_RE.test(String(id))) {
    return { ok: false, code: 'bad_container_id', reason: 'Invalid container ID format' };
  }
  const res = await requestEngine('inspect', id, { timeoutMs });
  if (res.ok && res.json) return { ok: true, data: res.json };
  return { ok: false, code: res.code, status: res.status };
}

export async function stopContainer(id, { stopTimeout = 15, timeoutMs = 30_000 } = {}) {
  if (!CONTAINER_ID_RE.test(String(id))) {
    return { ok: false, code: 'bad_container_id', reason: 'Invalid container ID format' };
  }
  const res = await requestEngine('stop', id, {
    query: { t: String(Math.max(1, Math.min(60, Number(stopTimeout) || 15))) },
    timeoutMs,
  });
  // 304: already stopped — that is the state we wanted
  if (!res.ok && res.status === 304) return { ...res, ok: true, unchanged: true };
  return res;
}

export async function renameContainer(id, newName, { timeoutMs = 15_000 } = {}) {
  if (!CONTAINER_ID_RE.test(String(id))) {
    return { ok: false, code: 'bad_container_id', reason: 'Invalid container ID format' };
  }
  const cleanName = String(newName || '').replace(/^\//, '').trim();
  if (!SAFE_NAME_RE.test(cleanName)) {
    return { ok: false, code: 'bad_name', reason: 'Invalid container name' };
  }
  return requestEngine('rename', id, { query: { name: cleanName }, timeoutMs });
}

export async function createContainer(name, createBody, { timeoutMs = 30_000 } = {}) {
  const cleanName = String(name || '').replace(/^\//, '').trim();
  if (!SAFE_NAME_RE.test(cleanName)) {
    return { ok: false, code: 'bad_name', reason: 'Invalid container name' };
  }
  if (!createBody || typeof createBody !== 'object') {
    return { ok: false, code: 'bad_body', reason: 'Create container configuration required' };
  }
  const res = await requestEngine('create', null, { query: { name: cleanName }, body: createBody, timeoutMs });
  if (res.ok && res.json?.Id) {
    return { ok: true, id: res.json.Id, warnings: res.json.Warnings || [] };
  }
  return { ok: false, code: res.code, status: res.status, detail: res.detail || null };
}

export async function connectNetwork(networkId, containerId, endpointConfig = null, { timeoutMs = 15_000 } = {}) {
  if (!NETWORK_REF_RE.test(String(networkId || '')) || !CONTAINER_ID_RE.test(String(containerId || ''))) {
    return { ok: false, code: 'bad_args', reason: 'A valid network and container id are required' };
  }
  return requestEngine('networkConnect', networkId, {
    body: { Container: String(containerId), EndpointConfig: endpointConfig || {} },
    timeoutMs,
  });
}

/** Phase 10D — detach a container from a network. Never forces. */
export async function disconnectNetwork(networkId, containerId, { timeoutMs = 15_000 } = {}) {
  if (!NETWORK_REF_RE.test(String(networkId || '')) || !CONTAINER_ID_RE.test(String(containerId || ''))) {
    return { ok: false, code: 'bad_args', reason: 'A valid network and container id are required' };
  }
  return requestEngine('networkDisconnect', networkId, {
    body: { Container: String(containerId), Force: false },
    timeoutMs,
  });
}

export async function startContainer(id, { timeoutMs = 30_000 } = {}) {
  if (!CONTAINER_ID_RE.test(String(id))) {
    return { ok: false, code: 'bad_container_id', reason: 'Invalid container ID format' };
  }
  const res = await requestEngine('start', id, { timeoutMs });
  if (!res.ok && res.status === 304) return { ...res, ok: true, unchanged: true };
  return res;
}

/**
 * DELETE /containers/<id>?v=0&force=<0|1>
 *
 * `v=0` is not a parameter: it is a constant. This adapter has no way to delete a volume.
 */
export async function deleteContainer(id, { force = false, timeoutMs = 20_000 } = {}) {
  if (!CONTAINER_ID_RE.test(String(id))) {
    return { ok: false, code: 'bad_container_id', reason: 'Invalid container ID format' };
  }
  return requestEngine('remove', id, { query: { v: '0', force: force ? '1' : '0' }, timeoutMs });
}

/** In-place update. The body is built by containers/spec.js from an allow-list; this only sends it. */
export async function updateContainer(id, updateBody, { timeoutMs = 20_000 } = {}) {
  if (!CONTAINER_ID_RE.test(String(id))) {
    return { ok: false, code: 'bad_container_id', reason: 'Invalid container ID format' };
  }
  if (!updateBody || typeof updateBody !== 'object' || !Object.keys(updateBody).length) {
    return { ok: false, code: 'bad_body', reason: 'Nothing to update' };
  }
  return requestEngine('update', id, { body: updateBody, timeoutMs });
}

/** Create a network. Stack deployments own the networks they create (labelled with the project). */
export async function createNetwork(body, { timeoutMs = 20_000 } = {}) {
  if (!body || !NETWORK_REF_RE.test(String(body.Name || ''))) {
    return { ok: false, code: 'bad_name', reason: 'Invalid network name' };
  }
  const res = await requestEngine('networkCreate', null, { body, timeoutMs });
  if (res.ok && res.json?.Id) return { ok: true, id: res.json.Id };
  return { ok: false, code: res.code, status: res.status, detail: res.detail || null };
}

/** Remove a network. Callers must have verified the network carries the stack's project label. */
export async function removeNetwork(networkRef, { timeoutMs = 20_000 } = {}) {
  if (!NETWORK_REF_RE.test(String(networkRef || ''))) {
    return { ok: false, code: 'bad_name', reason: 'Invalid network reference' };
  }
  return requestEngine('networkRemove', networkRef, { timeoutMs });
}

/** Create a named volume. Idempotent on the daemon side. There is no removeVolume. */
export async function createVolume(body, { timeoutMs = 20_000 } = {}) {
  if (!body || !SAFE_NAME_RE.test(String(body.Name || ''))) {
    return { ok: false, code: 'bad_name', reason: 'Invalid volume name' };
  }
  const res = await requestEngine('volumeCreate', null, { body, timeoutMs });
  if (res.ok) return { ok: true, name: res.json?.Name || body.Name };
  return { ok: false, code: res.code, status: res.status, detail: res.detail || null };
}

/** Test/ops visibility — the endpoint set is the security boundary, so let tests read it. */
export const _internals = Object.freeze({
  ENDPOINTS,
  CONTAINER_ID_RE,
  SAFE_NAME_RE,
  NETWORK_REF_RE,
  IMAGE_REF_RE,
});
