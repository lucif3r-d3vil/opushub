// /api/monitoring — the monitoring surface.
//
// Every route here sits behind the same session and CSRF gate as the rest of /api (api.js calls
// this from inside the gate, exactly as it does for infrastructure and operations). What that means
// for the security story:
//
//   · the browser never supplies a URL to fetch, a host to connect to, a container to inspect, an
//     ID to look up in Docker, or a path to read. A monitor is created from a *name* plus either a
//     service reference (resolved against the canonical inventory) or an endpoint that
//     model.js validates against the address policy;
//   · there is no "check this for me" endpoint that takes a target. The one manual trigger is
//     `POST …/check`, which names an existing monitor and re-runs its stored, validated target;
//   · nothing here can start, stop, restart or otherwise operate anything: the writes in this file
//     are monitor definitions, monitor state (pause/resume) and a maintenance window.
import {
  applySuggestions, checkNow, createMonitor, deleteMonitor, detail, engineHealth, getSettings,
  incidents, overview, pauseMonitor, resumeMonitor, searchEntries, setMaintenance, suggestions,
  updateMonitor, updateSettings,
} from './monitoring/engine.js';
import { BOUNDS, MonitorError, normalizeMaintenance, publicMonitor } from './monitoring/model.js';

const ID_RE = /^mon-[a-z0-9]{6,32}$/;

const isId = (raw) => typeof raw === 'string' && ID_RE.test(raw);
/** One monitor, projected the same way the list and detail endpoints project them. */
const pub = (monitor) => publicMonitor(monitor, { now: Date.now() });

/** `group/name` or `group` + `name` query parameters → a service reference, or null. */
function serviceFilter(query) {
  const raw = query.get('service');
  if (raw) {
    const [group, ...rest] = String(raw).split('/');
    if (rest.length) return { group: group || null, name: rest.join('/') };
    return { group: null, name: group };
  }
  const name = query.get('name');
  if (!name) return null;
  return { group: query.get('group') || null, name };
}

const matchesService = (monitor, ref) => {
  const s = monitor.target?.service;
  if (!s || !ref) return false;
  if (String(s.name).toLowerCase() !== String(ref.name).toLowerCase()) return false;
  if (ref.group && String(s.group || '').toLowerCase() !== String(ref.group).toLowerCase()) return false;
  return true;
};

function boolParam(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).toLowerCase();
  if (s === '1' || s === 'true' || s === 'open') return true;
  if (s === '0' || s === 'false' || s === 'resolved') return false;
  return null;
}

/**
 * Handle the monitoring routes.
 * @returns true when the path belonged to this surface (so api.js does not 404 it).
 */
export async function handleMonitoring({ p, method, send, jsonBody, query, actor = null }) {
  if (!p.startsWith('/api/monitoring')) return false;

  const notFound = (what = 'endpoint') => { send(404, { error: `No such ${what}.`, code: 'not_found' }); return true; };
  const badRequest = (err) => {
    const statusCode = err instanceof MonitorError ? err.status : (err?.status || 400);
    send(statusCode, { error: err?.message || 'The request could not be applied.', code: err?.code || 'invalid_request' });
    return true;
  };

  /* ---------------- reads ---------------- */
  if (method === 'GET' || method === 'HEAD') {
    if (p === '/api/monitoring') {
      const ref = serviceFilter(query);
      const doc = overview({ includeHistory: query.get('include') === 'uptime' });
      if (ref) {
        doc.monitors = doc.monitors.filter((m) => matchesService(m, ref));
        doc.filter = ref;
      }
      return send(200, doc), true;
    }
    if (p === '/api/monitoring/engine') return send(200, engineHealth()), true;
    if (p === '/api/monitoring/settings') {
      return send(200, { settings: getSettings(), bounds: BOUNDS }), true;
    }
    if (p === '/api/monitoring/suggestions') return send(200, await suggestions()), true;
    if (p === '/api/monitoring/search') return send(200, { results: searchEntries() }), true;
    if (p === '/api/monitoring/incidents') {
      const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 100));
      const monitorId = query.get('monitorId') || null;
      if (monitorId && !isId(monitorId)) return notFound('monitor');
      return send(200, incidents({ limit, monitorId, open: boolParam(query.get('open')) })), true;
    }
    const detailMatch = p.match(/^\/api\/monitoring\/monitors\/([^/]+)$/);
    if (detailMatch) {
      if (!isId(detailMatch[1])) return notFound('monitor');
      const doc = detail(detailMatch[1]);
      if (!doc) return notFound('monitor');
      return send(200, doc), true;
    }
    if (p === '/api/monitoring/monitors') return send(200, overview()), true;
    return notFound('monitoring endpoint');
  }

  /* ---------------- writes ---------------- */
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    try {
      if (p === '/api/monitoring/monitors' && method === 'POST') {
        const body = await jsonBody();
        const monitor = await createMonitor(body?.monitor ?? body, { actor });
        return send(201, { monitor: pub(monitor) }), true;
      }
      if (p === '/api/monitoring/settings' && method === 'PUT') {
        const body = await jsonBody();
        return send(200, { settings: updateSettings(body?.settings ?? body, { actor }) }), true;
      }
      if (p === '/api/monitoring/suggestions/apply' && method === 'POST') {
        const body = await jsonBody();
        const created = await applySuggestions(body?.ids, { actor });
        return send(201, { created: created.map(pub) }), true;
      }

      const action = p.match(/^\/api\/monitoring\/monitors\/([^/]+)\/(pause|resume|check|maintenance|maintenance\/clear)$/);
      if (action) {
        const [, id, what] = action;
        if (!isId(id)) return notFound('monitor');
        if (what === 'pause' && method === 'POST') return send(200, { monitor: pub(pauseMonitor(id, { actor })) }), true;
        if (what === 'resume' && method === 'POST') return send(200, { monitor: pub(resumeMonitor(id, { actor })) }), true;
        if (what === 'check' && method === 'POST') {
          const outcome = await checkNow(id, {});
          // the check's own result is returned with it: the operator asked for this one, and the
          // evidence is the answer to "did it actually run?" — recorded state is not synthesized
          return send(200, { monitor: pub(outcome.monitor), result: outcome.result, state: outcome.state }), true;
        }
        if (what === 'maintenance' && method === 'POST') {
          // the monitor is looked up before the window is parsed: an unknown id is a 404 whatever
          // the body says, and the body is only validated once there is something to attach it to
          if (!detail(id)) return notFound('monitor');
          const body = await jsonBody();
          const window = normalizeMaintenance(body?.maintenance ?? body);
          return send(200, { monitor: pub(setMaintenance(id, window, { actor })) }), true;
        }
        if (what === 'maintenance/clear' && (method === 'POST' || method === 'DELETE')) {
          return send(200, { monitor: pub(setMaintenance(id, null, { actor })) }), true;
        }
        return notFound('monitoring action');
      }

      const oneMatch = p.match(/^\/api\/monitoring\/monitors\/([^/]+)$/);
      if (oneMatch) {
        const id = oneMatch[1];
        if (!isId(id)) return notFound('monitor');
        if (method === 'PUT') {
          const body = await jsonBody();
          const monitor = await updateMonitor(id, body?.monitor ?? body, { actor });
          return send(200, { monitor: pub(monitor) }), true;
        }
        if (method === 'DELETE') return send(200, deleteMonitor(id, { actor })), true;
        return notFound('monitoring action');
      }
    } catch (err) {
      return badRequest(err);
    }
    return notFound('monitoring endpoint');
  }

  // GET/HEAD and the validated writes above are the entire surface.
  send(405, { error: 'Monitoring accepts GET, POST, PUT and DELETE on named resources.', code: 'method_not_allowed' });
  return true;
}
