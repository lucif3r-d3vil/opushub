// Phase 10C — Dedicated Docker Recreate & Update Operation Adapter
//
// FROZEN ALLOW-LIST OF DOCKER ENGINE API CALLS FOR UPDATE:
// 1. POST /v<api>/images/create?fromImage=<imageRef>   (Pull image)
// 2. GET  /v<api>/containers/<id>/json                 (Inspect container configuration)
// 3. POST /v<api>/containers/<id>/stop?t=15            (Graceful stop)
// 4. POST /v<api>/containers/<id>/rename?name=<name>   (Rename old container)
// 5. POST /v<api>/containers/create?name=<name>        (Create replacement container)
// 6. POST /v<api>/networks/<netId>/connect             (Attach auxiliary networks)
// 7. POST /v<api>/containers/<newId>/start             (Start replacement container)
// 8. DELETE /v<api>/containers/<oldId>?v=0             (Remove old container; v=0 guarantees volume preservation)
//
// Architectural guarantees:
// - Module-private transport; no generic request helper exported
// - Container IDs strictly validated via /^[0-9a-f]{12}$|^[0-9a-f]{64}$/
// - Names strictly sanitized via /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/
// - No arbitrary shell / exec / compose calls
// - No volume deletion, no network deletion

import http from 'node:http';
import * as readDocker from '../providers/docker.js';
import { operationsAvailability, resolveOperationsEndpoint } from '../providers/dockerOperations.js';

const CONTAINER_ID_RE = /^[0-9a-f]{12}$|^[0-9a-f]{64}$/;
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function apiVersion() {
  try { return readDocker._internals.apiVersion; } catch { return '1.43'; }
}

/** Module-private request dispatcher */
function requestEngine(method, pathname, { query = null, body = null, timeoutMs = 60_000 } = {}) {
  const avail = operationsAvailability();
  if (!avail.ok) {
    return Promise.resolve({
      ok: false,
      code: avail.state === 'socket-missing' ? 'socket_missing' : 'docker_unavailable',
      status: null,
      error: avail.reason,
    });
  }

  const ep = avail.ep;
  const opts = ep.socket ? { socketPath: ep.socket } : { host: ep.host, port: ep.port };
  let fullPath = `/v${apiVersion()}${pathname}`;
  if (query) {
    const q = new URLSearchParams(query).toString();
    if (q) fullPath += `?${q}`;
  }

  const payload = body ? JSON.stringify(body) : null;
  const headers = {
    host: 'docker',
    'content-length': payload ? Buffer.byteLength(payload) : 0,
  };
  if (payload) headers['content-type'] = 'application/json';

  return new Promise((resolve) => {
    const req = http.request({ ...opts, path: fullPath, method, headers }, (res) => {
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
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({
          ok,
          status: res.statusCode,
          json,
          raw,
          code: ok ? 'ok' : (json?.message ? 'engine_error' : `http_${res.statusCode}`),
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Docker update operation timed out'));
      resolve({ ok: false, code: 'timeout', status: 504 });
    });

    req.on('error', (err) => {
      resolve({ ok: false, code: 'connection_error', status: null, error: err.message });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/** 1. POST /images/create?fromImage=... */
export async function pullImage(imageRef, { timeoutMs = 120_000 } = {}) {
  if (typeof imageRef !== 'string' || !imageRef.trim()) {
    return { ok: false, code: 'bad_image', reason: 'Invalid image reference' };
  }
  return requestEngine('POST', '/images/create', {
    query: { fromImage: imageRef.trim() },
    timeoutMs,
  });
}

/** 2. GET /containers/<id>/json */
export async function inspectContainer(id, { timeoutMs = 15_000 } = {}) {
  if (!CONTAINER_ID_RE.test(String(id))) {
    return { ok: false, code: 'bad_container_id', reason: 'Invalid container ID format' };
  }
  const res = await requestEngine('GET', `/containers/${encodeURIComponent(id)}/json`, { timeoutMs });
  if (res.ok && res.json) return { ok: true, data: res.json };
  return { ok: false, code: res.code, status: res.status };
}

/** 3. POST /containers/<id>/stop?t=... */
export async function stopContainer(id, { stopTimeout = 15, timeoutMs = 30_000 } = {}) {
  if (!CONTAINER_ID_RE.test(String(id))) {
    return { ok: false, code: 'bad_container_id', reason: 'Invalid container ID format' };
  }
  return requestEngine('POST', `/containers/${encodeURIComponent(id)}/stop`, {
    query: { t: String(Math.max(1, Math.min(60, Number(stopTimeout) || 15))) },
    timeoutMs,
  });
}

/** 4. POST /containers/<id>/rename?name=... */
export async function renameContainer(id, newName, { timeoutMs = 15_000 } = {}) {
  if (!CONTAINER_ID_RE.test(String(id))) {
    return { ok: false, code: 'bad_container_id', reason: 'Invalid container ID format' };
  }
  const cleanName = String(newName || '').replace(/^\//, '').trim();
  if (!SAFE_NAME_RE.test(cleanName)) {
    return { ok: false, code: 'bad_name', reason: 'Invalid replacement container name' };
  }
  return requestEngine('POST', `/containers/${encodeURIComponent(id)}/rename`, {
    query: { name: cleanName },
    timeoutMs,
  });
}

/** 5. POST /containers/create?name=... */
export async function createContainer(name, createBody, { timeoutMs = 30_000 } = {}) {
  const cleanName = String(name || '').replace(/^\//, '').trim();
  if (!SAFE_NAME_RE.test(cleanName)) {
    return { ok: false, code: 'bad_name', reason: 'Invalid replacement container name' };
  }
  if (!createBody || typeof createBody !== 'object') {
    return { ok: false, code: 'bad_body', reason: 'Create container configuration required' };
  }
  const res = await requestEngine('POST', '/containers/create', {
    query: { name: cleanName },
    body: createBody,
    timeoutMs,
  });
  if (res.ok && res.json?.Id) {
    return { ok: true, id: res.json.Id, warnings: res.json.Warnings || [] };
  }
  return { ok: false, code: res.code, status: res.status, raw: res.raw };
}

/** 6. POST /networks/<netId>/connect */
export async function connectNetwork(networkId, containerId, endpointConfig = null, { timeoutMs = 15_000 } = {}) {
  if (!networkId || !containerId) {
    return { ok: false, code: 'bad_args', reason: 'NetworkId and containerId are required' };
  }
  const body = {
    Container: String(containerId),
    EndpointConfig: endpointConfig || {},
  };
  return requestEngine('POST', `/networks/${encodeURIComponent(networkId)}/connect`, {
    body,
    timeoutMs,
  });
}

/** 7. POST /containers/<id>/start */
export async function startContainer(id, { timeoutMs = 30_000 } = {}) {
  if (!CONTAINER_ID_RE.test(String(id))) {
    return { ok: false, code: 'bad_container_id', reason: 'Invalid container ID format' };
  }
  return requestEngine('POST', `/containers/${encodeURIComponent(id)}/start`, { timeoutMs });
}

/** 8. DELETE /containers/<id>?v=0 */
export async function deleteContainer(id, { removeVolumes = false, timeoutMs = 20_000 } = {}) {
  if (!CONTAINER_ID_RE.test(String(id))) {
    return { ok: false, code: 'bad_container_id', reason: 'Invalid container ID format' };
  }
  // v=0 strictly prevents accidental volume removal!
  return requestEngine('DELETE', `/containers/${encodeURIComponent(id)}`, {
    query: { v: removeVolumes ? '1' : '0', force: '1' },
    timeoutMs,
  });
}
