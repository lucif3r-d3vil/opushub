// Phase 10B — /api/events routes

import { readEvents, getEventById, stats as eventStats } from './events/store.js';
import { toPublicEvent } from './events/model.js';
import { handleSSE } from './events/sse.js';
import { bus } from './events/bus.js';
import * as auth from './auth.js';

export async function handleEvents({ p, method, send, query, sessionHandle }) {
  // GET /api/events — history
  if (p === '/api/events' && method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 100));
    const before = query.get('before') ? Number(query.get('before')) : null;
    const after = query.get('after') ? Number(query.get('after')) : null;
    const since = query.get('since') ? Number(query.get('since')) : null;
    const types = query.get('types') ? query.get('types').split(',').map((s) => s.trim()).filter(Boolean) : null;
    const severity = query.get('severity') || null;
    const source = query.get('source') || null;

    const items = readEvents({ limit, before, after, since, types, severity, source });
    const publicItems = items.map(toPublicEvent).filter(Boolean);
    return send(200, {
      events: publicItems,
      count: publicItems.length,
      total: eventStats().count,
      filters: { types, severity, source, since, before, after },
    });
  }

  // GET /api/events/:id
  const idMatch = p.match(/^\/api\/events\/([^/]+)$/);
  if (idMatch && method === 'GET') {
    const id = decodeURIComponent(idMatch[1]);
    const evt = getEventById(id);
    if (!evt) return send(404, { error: 'no such event', code: 'not_found' });
    const pub = toPublicEvent(evt);
    if (!pub) return send(404, { error: 'event not public', code: 'not_public' });
    return send(200, { event: pub });
  }

  // GET /api/events/stats
  if (p === '/api/events/stats' && method === 'GET') {
    return send(200, {
      store: eventStats(),
      bus: bus.stats(),
    });
  }

  // GET /api/events/stream — SSE (handled separately because it hijacks res)
  // This route is detected in api.js and delegates to handleSSE directly with raw res
  return null; // not handled
}

// For api.js to detect SSE route
export function isSSERoute(p, method) {
  return p === '/api/events/stream' && method === 'GET';
}

export async function handleEventsSSE(req, res, { query, session, sessionHandle }) {
  // Auth already verified by caller
  return handleSSE(req, res, { sessionHandle, query });
}
