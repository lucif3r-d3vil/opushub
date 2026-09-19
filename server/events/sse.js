// Phase 10B — SSE transport (authenticated, bounded, sanitized)
// Handles /api/events/stream

import { bus } from './bus.js';
import { readEvents } from './store.js';
import { SEVERITY_ORDER, toPublicEvent } from './model.js';

const MAX_GLOBAL_CONNECTIONS = 50;
const MAX_PER_SESSION = 10;
const PER_CLIENT_QUEUE = 100;
const HEARTBEAT_MS = 15_000;

let globalConnections = 0;
const perSession = new Map(); // sessionHandle -> count
const activeClients = new Set();

function incSession(handle) {
  const c = perSession.get(handle) || 0;
  perSession.set(handle, c + 1);
  globalConnections++;
}
function decSession(handle) {
  const c = perSession.get(handle) || 0;
  if (c <= 1) perSession.delete(handle);
  else perSession.set(handle, c - 1);
  globalConnections = Math.max(0, globalConnections - 1);
}

function formatSSE({ id, event, data }) {
  let out = '';
  if (id) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  const json = JSON.stringify(data);
  // split data by newline for SSE spec
  for (const line of json.split('\n')) {
    out += `data: ${line}\n`;
  }
  out += '\n';
  return out;
}

function sendComment(res, text) {
  try { res.write(`: ${text}\n\n`); } catch {}
}

export function handleSSE(req, res, { sessionHandle, query } = {}) {
  // Auth already checked by caller (handleApi gate). This function assumes authenticated.
  if (globalConnections >= MAX_GLOBAL_CONNECTIONS) {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'too many event streams', code: 'too_many_connections' }));
    return;
  }
  const per = perSession.get(sessionHandle) || 0;
  if (per >= MAX_PER_SESSION) {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'too many streams for this session', code: 'too_many_per_session' }));
    return;
  }

  // Parse Last-Event-ID for replay
  const lastEventId = req.headers['last-event-id'] || query.get('lastEventId') || query.get('last_event_id') || null;
  const sinceParam = query.get('since');
  const since = sinceParam ? Number(sinceParam) : null;

  // Filters from query
  const typesParam = query.get('types');
  const types = typesParam ? typesParam.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const severity = query.get('severity') || null;
  const source = query.get('source') || null;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
    // CORS not needed (same-origin), but ensure no sniff
    'x-content-type-options': 'nosniff',
  });

  incSession(sessionHandle);

  const client = {
    res,
    handle: sessionHandle,
    queue: [],
    closed: false,
    filter: (evt) => {
      if (types && types.length && !types.includes(evt.type)) return false;
      if (source && evt.source !== source) return false;
      if (severity) {
        const order = SEVERITY_ORDER;
        if ((order[evt.severity] ?? 0) < (order[severity] ?? 0)) return false;
      }
      return true;
    },
  };

  activeClients.add(client);

  // Helper to send event safely, respecting backpressure via bounded queue
  function sendEvent(evt) {
    if (client.closed) return;
    const pub = toPublicEvent(evt);
    if (!pub) return;
    if (!client.filter(evt)) return;
    // If queue is full, drop oldest
    if (client.queue.length >= PER_CLIENT_QUEUE) client.queue.shift();
    const chunk = formatSSE({ id: pub.id, event: pub.type, data: pub });
    client.queue.push(chunk);
    flush();
  }

  function flush() {
    if (client.closed) return;
    while (client.queue.length) {
      const chunk = client.queue.shift();
      try {
        res.write(chunk);
      } catch {
        close();
        break;
      }
    }
  }

  // Replay logic: if Last-Event-ID present, try to find it and replay after it
  let replayed = 0;
  try {
    if (lastEventId) {
      // Find events after lastEventId from store
      const all = readEvents({ limit: 500 });
      const idx = all.findIndex((e) => e.id === lastEventId);
      if (idx >= 0) {
        const after = all.slice(idx + 1);
        for (const evt of after) {
          if (replayed >= 100) break; // cap replay
          const pub = toPublicEvent(evt);
          if (!pub) continue;
          if (!client.filter(evt)) continue;
          const chunk = formatSSE({ id: pub.id, event: pub.type, data: pub });
          client.queue.push(chunk);
          replayed++;
        }
      } else {
        // If not found, fallback to since or last 20
        const recent = readEvents({ limit: 50, since: since || (Date.now() - 60_000) });
        for (const evt of recent) {
          const pub = toPublicEvent(evt);
          if (!pub) continue;
          if (!client.filter(evt)) continue;
          const chunk = formatSSE({ id: pub.id, event: pub.type, data: pub });
          client.queue.push(chunk);
        }
      }
    } else if (since) {
      const recent = readEvents({ limit: 100, since });
      for (const evt of recent) {
        const pub = toPublicEvent(evt);
        if (!pub) continue;
        if (!client.filter(evt)) continue;
        const chunk = formatSSE({ id: pub.id, event: pub.type, data: pub });
        client.queue.push(chunk);
      }
    }
  } catch {}

  // Initial hello + flush
  sendComment(res, 'connected');
  flush();

  // Subscribe to bus
  const sub = bus.subscribe((evt) => {
    // filter applied in sendEvent, but also quick check here to avoid queueing filtered
    if (types && types.length && !types.includes(evt.type)) return false;
    if (source && evt.source !== source) return false;
    if (severity) {
      const order = SEVERITY_ORDER;
      if ((order[evt.severity] ?? 0) < (order[severity] ?? 0)) return false;
    }
    return true;
  }, (evt) => {
    sendEvent(evt);
  });

  // Heartbeat
  const hb = setInterval(() => {
    if (client.closed) return;
    sendComment(res, `heartbeat ${Date.now()}`);
  }, HEARTBEAT_MS);

  function close() {
    if (client.closed) return;
    client.closed = true;
    clearInterval(hb);
    try { sub.unsubscribe(); } catch {}
    activeClients.delete(client);
    decSession(sessionHandle);
    try { res.end(); } catch {}
  }

  req.on('close', close);
  req.on('error', close);
  res.on('close', close);
  res.on('error', close);

  // Return close handle for graceful shutdown
  return { close };
}

export function closeAllSSE() {
  for (const c of [...activeClients]) {
    try { c.res.end(); } catch {}
    c.closed = true;
  }
  activeClients.clear();
  globalConnections = 0;
  perSession.clear();
}

export function sseStats() {
  return {
    global: globalConnections,
    perSession: Object.fromEntries(perSession.entries()),
    active: activeClients.size,
  };
}
