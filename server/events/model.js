// Phase 10B — canonical Event model (internal, trusted producers only).
// The public projection exposed to browsers (via SSE / /api/events) is a sanitized subset.
// This file is the one place that decides what an event is.

import { randomUUID } from 'node:crypto';

export const SEVERITIES = Object.freeze(['info', 'notice', 'warning', 'critical']);
export const SEVERITY_ORDER = Object.freeze({ info: 0, notice: 1, warning: 2, critical: 3 });

const ALLOWED_SOURCES = new Set([
  'monitor', 'incident', 'alert', 'operation', 'infrastructure', 'service',
  'system', 'auth', 'docker', 'config', 'user', 'provider',
]);

// Explicit allow-list of event types that may ever reach a browser. Anything not here
// is internal-only and will be filtered before SSE/history exposure.
export const PUBLIC_EVENT_TYPES = new Set([
  // monitoring
  'monitor.state_changed',
  'monitor.check.failed',
  'monitor.incident.opened',
  'monitor.incident.recovered',
  'monitor.incident.acknowledged',
  'monitor.maintenance.started',
  'monitor.maintenance.ended',
  // alerts
  'alert.created',
  'alert.resolved',
  'alert.acknowledged',
  // operations
  'operation.requested',
  'operation.started',
  'operation.completed',
  'operation.failed',
  'operation.timed_out',
  // infrastructure
  'infrastructure.health_changed',
  'infrastructure.provider.state_changed',
  'infrastructure.storage.health_changed',
  'infrastructure.network.changed',
  // service / docker (public, safe)
  'service.unhealthy',
  'service.healthy',
  'service.down',
  'service.up',
  // Phase 10C: container recovery & updates
  'container.update_available',
  'container.updated',
  'container.update_failed',
  'container.autoheal.restarted',
  'container.autoheal.failed',
  // system / auth (public safe subset)
  'system.boot',
  'system.shutdown',
  'auth.login_failed',
  'config.updated',
]);

// For internal bus, we allow a superset (still bounded) — anything starting with known source
// or explicitly allowed. This prevents arbitrary strings from becoming event types.
const INTERNAL_TYPE_RE = /^(monitor|incident|alert|operation|infrastructure|service|system|auth|docker|config|user|provider)\.[a-z0-9_.]+$/;

function isValidType(type) {
  if (PUBLIC_EVENT_TYPES.has(type)) return true;
  // allow internal types that match grammar and are not overly long
  if (typeof type !== 'string') return false;
  if (type.length > 80) return false;
  if (!INTERNAL_TYPE_RE.test(type)) return false;
  // block any type that contains secrets or credentials in name
  if (/password|secret|token|credential|cookie|session/i.test(type)) return false;
  return true;
}

function sanitizeSeverity(s) {
  const v = String(s || 'info').toLowerCase();
  return SEVERITIES.includes(v) ? v : 'info';
}

function sanitizeSource(src) {
  const v = String(src || 'system').toLowerCase();
  return ALLOWED_SOURCES.has(v) ? v : 'system';
}

// Keys that must never appear in any payload that reaches the browser.
const FORBIDDEN_PAYLOAD_KEYS = [
  'password', 'passwd', 'pwd', 'secret', 'token', 'cookie', 'session',
  'authorization', 'auth', 'credential', 'apiKey', 'api_key', 'privateKey',
  'env', 'environment', 'dockerSocket', 'socketPath',
];

function containsForbiddenKey(obj, seen = new Set()) {
  if (!obj || typeof obj !== 'object') return false;
  if (seen.has(obj)) return false;
  seen.add(obj);
  for (const k of Object.keys(obj)) {
    const lk = k.toLowerCase();
    for (const fk of FORBIDDEN_PAYLOAD_KEYS) {
      if (lk.includes(fk.toLowerCase())) return true;
    }
    const v = obj[k];
    if (v && typeof v === 'object') {
      if (containsForbiddenKey(v, seen)) return true;
    }
  }
  return false;
}

function sanitizeString(s, max = 500) {
  if (s == null) return null;
  let str = String(s);
  // strip control chars except newline? For events we want single line safe.
  str = str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (str.length > max) str = str.slice(0, max);
  return str;
}

function sanitizeSubject(sub) {
  if (!sub) return null;
  if (typeof sub === 'string') {
    return { kind: 'unknown', id: sanitizeString(sub, 120), label: sanitizeString(sub, 120), href: null };
  }
  if (typeof sub !== 'object') return null;
  const kind = sanitizeString(sub.kind || 'unknown', 40) || 'unknown';
  const id = sanitizeString(sub.id || sub.name || '', 120);
  const label = sanitizeString(sub.label || sub.name || id || '', 120);
  let href = null;
  if (sub.href && typeof sub.href === 'string') {
    const h = sub.href.trim();
    // only allow internal app hrefs, not arbitrary URLs
    if (h.startsWith('/') && !h.startsWith('//') && h.length <= 300) href = h;
  }
  return { kind, id, label, href };
}

// Public projection: what a browser is allowed to see. Strips any secret-bearing fields.
export function toPublicEvent(evt) {
  if (!evt || typeof evt !== 'object') return null;
  // only public types
  if (!PUBLIC_EVENT_TYPES.has(evt.type)) return null;
  // ensure no forbidden keys leaked
  if (evt.payload && containsForbiddenKey(evt.payload)) {
    // if payload contains forbidden keys, drop it entirely rather than attempt partial sanitization
    // to avoid accidental leakage via nested structures
    return {
      id: evt.id,
      t: evt.t,
      type: evt.type,
      severity: evt.severity,
      source: evt.source,
      subject: evt.subject,
      message: evt.message,
      correlation: evt.correlation || null,
      payload: null,
    };
  }
  return {
    id: evt.id,
    t: evt.t,
    type: evt.type,
    severity: evt.severity,
    source: evt.source,
    subject: evt.subject,
    message: evt.message,
    correlation: evt.correlation || null,
    payload: evt.payload || null,
  };
}

export function makeEvent({
  type,
  severity = 'info',
  source = 'system',
  subject = null,
  message = '',
  payload = null,
  correlation = null,
  metadata = null,
  id = null,
  t = null,
} = {}) {
  if (!isValidType(type)) {
    throw Object.assign(new Error(`invalid event type: ${type}`), { status: 400, code: 'invalid_event_type' });
  }
  const sev = sanitizeSeverity(severity);
  const src = sanitizeSource(source);

  // message is safe, truncated
  const safeMessage = sanitizeString(message, 500) || '';

  // subject sanitized
  const safeSubject = sanitizeSubject(subject);

  // payload: must be object or null, bounded size, no forbidden keys
  let safePayload = null;
  if (payload != null) {
    if (typeof payload !== 'object') {
      safePayload = { value: sanitizeString(payload, 500) };
    } else {
      // quick size bound via JSON length
      try {
        const json = JSON.stringify(payload);
        if (json.length > 16_000) {
          // truncate: keep only shallow safe fields
          safePayload = { truncated: true, keys: Object.keys(payload).slice(0, 20) };
        } else if (containsForbiddenKey(payload)) {
          safePayload = null; // drop secret-bearing payload entirely
        } else {
          // shallow clone with string sanitization for top-level string values
          safePayload = {};
          for (const [k, v] of Object.entries(payload)) {
            if (typeof v === 'string') safePayload[k] = sanitizeString(v, 500);
            else if (typeof v === 'number' || typeof v === 'boolean' || v == null) safePayload[k] = v;
            else if (Array.isArray(v)) safePayload[k] = v.slice(0, 20).map((x) => (typeof x === 'string' ? sanitizeString(x, 200) : x));
            else safePayload[k] = sanitizeString(JSON.stringify(v), 500);
          }
        }
      } catch {
        safePayload = null;
      }
    }
  }

  let safeCorrelation = null;
  if (correlation && typeof correlation === 'object') {
    safeCorrelation = {};
    for (const [k, v] of Object.entries(correlation)) {
      if (['monitorId', 'incidentId', 'checkId', 'alertId', 'operationId', 'service', 'provider', 'target'].includes(k)) {
        safeCorrelation[k] = sanitizeString(v, 120);
      }
    }
    if (!Object.keys(safeCorrelation).length) safeCorrelation = null;
  }

  const now = t != null ? Number(t) : Date.now();
  const eventId = id || `evt-${randomUUID()}`;

  return {
    id: eventId,
    t: Number.isFinite(now) ? now : Date.now(),
    type,
    severity: sev,
    source: src,
    subject: safeSubject,
    message: safeMessage,
    payload: safePayload,
    correlation: safeCorrelation,
    // metadata is internal-only, never exposed via toPublicEvent unless explicitly allowed
    _meta: metadata ? { ...metadata } : null,
  };
}

// For store: minimal line format
export function serializeEvent(evt) {
  return JSON.stringify({
    id: evt.id,
    t: evt.t,
    type: evt.type,
    severity: evt.severity,
    source: evt.source,
    subject: evt.subject,
    message: evt.message,
    payload: evt.payload,
    correlation: evt.correlation,
  });
}

export function deserializeEvent(line) {
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== 'object') return null;
    if (!obj.id || !obj.t || !obj.type) return null;
    // re-validate type
    if (!isValidType(obj.type)) return null;
    return obj;
  } catch {
    return null;
  }
}

export function isPublicType(type) {
  return PUBLIC_EVENT_TYPES.has(type);
}
