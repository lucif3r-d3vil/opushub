// The canonical Monitor model — one shape, validated in one place.
//
// A monitor is a *declaration of intent*: "tell me whether this thing answers". It is not a URL
// fetcher, not a scanner and not a Docker client. Everything the engine may later do is decided
// by the fields below, and every field is validated here before it is ever stored:
//
//   id          server-generated (`mon-…`). Never taken from a request.
//   name        operator-supplied label, bounded, control characters refused.
//   type        http | tcp | docker. The list is closed; future types are future phases.
//   target      a *validated canonical reference* — see validateTarget() below.
//   interval    how often it is checked, clamped into BOUNDS.intervalMs.
//   timeout     per-attempt deadline, clamped into BOUNDS.timeoutMs and never ≥ the interval.
//   enabled     false ⇒ the monitor is PAUSED (visible, quiet, no incidents).
//   expected    what "answering correctly" means for this type (status codes for HTTP).
//   status      the current state — one of MONITOR_STATES, owned by state.js.
//   latency     the last measured latency in ms, or null. Never invented.
//   lastCheck   the last check result, verbatim (timestamp, kind, code, latency, reason).
//   nextCheck   when the scheduler intends to look again (server clock).
//   counters    consecutive/aggregate failure and success counts.
//   provenance  discovered | configured | imported — where this monitor came from.
//   source      the *endpoint* provenance (e.g. reverse-proxy/Traefik) when a provider supplied the
//               endpoint. Informational only: no code path branches on the provider's name.
//   maintenance a bounded suppression window, or null.
//
// Security posture, stated once and enforced below:
//   · a target is either a service reference that the canonical inventory resolves, or an
//     explicitly configured endpoint that passes the address policy in server/lib/ipPolicy.js;
//   · arbitrary container ids, port ranges, port lists, schemes other than http(s), credentials in
//     URLs, wildcards and control characters are all refused — with reasons, not bare errors;
//   · the model has no concept of an "action": there is no field a monitoring check could use to
//     start, stop or restart anything.
import crypto from 'node:crypto';
import { BLOCKED_FOR_MONITOR, classifyIp, isInternalAddress } from '../lib/ipPolicy.js';

export const MONITOR_TYPES = Object.freeze(['http', 'tcp', 'docker']);

/** The whole state vocabulary. `pending` = never checked; `unknown` = checked, no verdict. */
export const MONITOR_STATES = Object.freeze(['pending', 'up', 'degraded', 'down', 'recovering', 'paused', 'unknown']);

/** Where a monitor came from. Not cosmetic: the UI groups and filters by it. */
export const PROVENANCE = Object.freeze(['discovered', 'configured', 'imported']);

/**
 * The network scope of a target, as *observed* by the last check (see net.js `scopeOf`):
 *   · `public`   — every validated address was a public one;
 *   · `internal` — every validated address is RFC1918 / CGNAT / ULA: the homelab's own network;
 *   · `mixed`    — a name that resolves into both. Recorded, never hidden.
 * `null` means "not measured yet" — never "public".
 */
export const TARGET_SCOPES = Object.freeze(['public', 'internal', 'mixed']);

/** Result kinds a check may return. `unknown` is "no verdict", never a silent failure. */
export const RESULT_KINDS = Object.freeze(['ok', 'degraded', 'fail', 'unknown']);

/**
 * Server-side bounds. These are *not* defaults the client may exceed: every value that arrives
 * from a request is clamped into the range below, and the effective settings document says so.
 */
export const BOUNDS = Object.freeze({
  intervalMs: Object.freeze({ min: 10_000, max: 86_400_000, default: 60_000 }),
  timeoutMs: Object.freeze({ min: 500, max: 30_000, default: 5_000 }),
  failureThreshold: Object.freeze({ min: 1, max: 10, default: 3 }),
  recoveryThreshold: Object.freeze({ min: 1, max: 10, default: 2 }),
  retentionSamples: Object.freeze({ min: 30, max: 2000, default: 360 }),
  retentionHours: Object.freeze({ min: 24, max: 2000, default: 336 }),
  retentionIncidents: Object.freeze({ min: 20, max: 2000, default: 400 }),
  maxMonitors: Object.freeze({ min: 1, max: 500, default: 200 }),
  maxConcurrent: Object.freeze({ min: 1, max: 8, default: 3 }),
  jitterMs: Object.freeze({ min: 0, max: 60_000, default: 5_000 }),
  autoCreateMax: Object.freeze({ min: 0, max: 100, default: 10 }),
  maintenanceMaxMs: Object.freeze({ min: 60_000, max: 30 * 86_400_000, default: 86_400_000 }),
});

/** The monitor name/label cap. Longer than this and it stops being a label. */
export const MAX_NAME = 80;
/** URLs are bounded: past this length a target is a payload, not an endpoint. */
export const MAX_URL = 500;
const MAX_PATH = 300;
const MAX_HOST = 253;

/**
 * Ports a *monitor* may not be pointed at.
 *
 * These are the ports that are never an HTTP application UI and are the classic pivots for
 * turning "monitor a URL" into "reach something I was never meant to reach": SSH/Telnet/SMTP and
 * friends, LDAP/SMB, the Docker daemon (2375/2376), Redis/Memcached/Mongo/Postgres/MySQL, VNC and
 * a SOCKS proxy. TCP monitors may still use any port — they are explicitly configured single
 * endpoints, and the operator knows what they are watching. This list only constrains the HTTP
 * monitor, where a *URL* is supplied.
 */
export const UNSAFE_HTTP_PORTS = Object.freeze(new Set([
  22, 23, 25, 110, 111, 135, 137, 138, 139, 143, 389, 445, 465, 514, 587, 636, 993, 995,
  1080, 1433, 1521, 2049, 2375, 2376, 3306, 3389, 5432, 5900, 6379, 11211, 27017,
]));

/** A validation failure the API can answer with a 400 and a sentence a person can act on. */
export class MonitorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MonitorError';
    this.code = code;
    this.status = status;
  }
}

export const monitorError = (code, message, status = 400) => new MonitorError(code, message, status);

/* ------------------------------------------------------------------ */
/* small validators                                                    */
/* ------------------------------------------------------------------ */

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** A bounded, printable string. */
function text(value, { max, label, required = true }) {
  if (value == null || value === '') {
    if (!required) return null;
    throw monitorError('invalid_field', `${label} is required.`);
  }
  if (typeof value !== 'string') throw monitorError('invalid_field', `${label} must be text.`);
  const s = value.trim();
  if (!s) {
    if (!required) return null;
    throw monitorError('invalid_field', `${label} is required.`);
  }
  if (s.length > max) throw monitorError('invalid_field', `${label} is longer than ${max} characters.`);
  if (CONTROL_CHARS.test(s)) throw monitorError('invalid_field', `${label} contains control characters.`);
  return s;
}

/** Clamp an integer into a bound, with a usable fallback for "not supplied". */
export function clampSetting(name, value) {
  const bound = BOUNDS[name];
  if (!bound) throw monitorError('invalid_field', `unknown setting: ${name}`, 500);
  const n = Number(value);
  if (!Number.isFinite(n)) return bound.default;
  return Math.min(bound.max, Math.max(bound.min, Math.round(n)));
}

/** The effective settings document, with every value clamped — the answer to "what will it do?". */
export function normalizeSettings(raw = {}) {
  const auto = raw?.autoCreate && typeof raw.autoCreate === 'object' ? raw.autoCreate : {};
  return {
    // the one setting that is a boolean, and the bound that makes "internal targets" explicit:
    // with it off, no monitor — configured, discovered or imported — may reach a private, CGNAT or
    // ULA address, and the fix is a setting rather than an edit to the block list.
    allowInternal: raw?.allowInternal !== false,
    intervalMs: clampSetting('intervalMs', raw?.intervalMs),
    timeoutMs: clampSetting('timeoutMs', raw?.timeoutMs),
    failureThreshold: clampSetting('failureThreshold', raw?.failureThreshold),
    recoveryThreshold: clampSetting('recoveryThreshold', raw?.recoveryThreshold),
    retentionSamples: clampSetting('retentionSamples', raw?.retentionSamples),
    retentionHours: clampSetting('retentionHours', raw?.retentionHours),
    retentionIncidents: clampSetting('retentionIncidents', raw?.retentionIncidents),
    maxMonitors: clampSetting('maxMonitors', raw?.maxMonitors),
    maxConcurrent: clampSetting('maxConcurrent', raw?.maxConcurrent),
    jitterMs: clampSetting('jitterMs', raw?.jitterMs),
    autoCreate: {
      enabled: auto?.enabled === true,
      max: clampSetting('autoCreateMax', auto?.max),
    },
    // the bounds are part of the answer: a settings page that shows a value without its range is
    // inviting somebody to wonder why their 30-second interval became 10
    bounds: Object.fromEntries(Object.entries(BOUNDS).map(([k, v]) => [k, { min: v.min, max: v.max, default: v.default }])),
  };
}

/* ------------------------------------------------------------------ */
/* targets                                                             */
/* ------------------------------------------------------------------ */

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A bare hostname or IP literal (no scheme, no path, no credentials, no wildcard). */
export function parseHost(raw, { label = 'Host', allowInternal = true } = {}) {
  const s = text(raw, { max: MAX_HOST, label });
  let host = s;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.includes('/') || host.includes('\\') || host.includes('@') || /\s/.test(host)) {
    throw monitorError('invalid_host', `${label} must be a hostname or IP address, not a URL.`);
  }
  if (host.includes('*')) throw monitorError('invalid_host', `${label} cannot contain a wildcard.`);
  // a host is one host. `10.0.0.1-10.0.0.50` is a range with a hostname's syntax, and a range is a
  // scanner's input, not a monitor's.
  if (/\d\s*-\s*\d/.test(host)) throw monitorError('invalid_host', `${label} must be a single host — ranges belong to a scanner, not a monitor.`);
  if (IPV4_RE.test(host) && classifyIp(host) === 'invalid') throw monitorError('invalid_host', `${label} is not a valid IP address.`);
  if (!IPV4_RE.test(host) && !host.includes(':') && !HOSTNAME_RE.test(host)) {
    throw monitorError('invalid_host', `${label} is not a valid hostname.`);
  }
  if (host.includes(':')) {
    // an IPv6 literal: it must actually be one, and it must be in the refused address classes'
    // mirror — a loopback/link-local literal is caught by the address policy at connect time, but
    // it is caught here too so the operator is told at the moment of configuration
    const cls = classifyIp(host);
    if (cls === 'invalid') throw monitorError('invalid_host', `${label} is not a valid IPv6 address.`);
  }
  if (!allowInternal && isInternalAddress(host)) {
    throw monitorError('internal_blocked', `${label} is on the local network, and this instance has been configured to monitor public endpoints only.`);
  }
  return host.toLowerCase();
}

/** A single TCP port. Ranges, lists and protocols are refused: this is a monitor, not a scanner. */
export function parsePort(raw, { label = 'Port' } = {}) {
  if (raw == null || raw === '') throw monitorError('invalid_port', `${label} is required.`);
  const s = String(raw).trim();
  if (!/^\d{1,5}$/.test(s)) {
    throw monitorError('invalid_port', `${label} must be a single number between 1 and 65535 (no ranges, no lists).`);
  }
  const n = Number(s);
  if (n < 1 || n > 65535) throw monitorError('invalid_port', `${label} must be between 1 and 65535.`);
  return n;
}

/**
 * An HTTP endpoint, validated as an endpoint rather than as a string.
 * Refuses: non-http(s) schemes, credentials in the URL, wildcards, oversized URLs, unsafe ports
 * and any host whose literal is in a class the address policy blocks.
 */
export function parseHttpEndpoint(raw, { label = 'Endpoint', allowInternal = true } = {}) {
  const s = text(raw, { max: MAX_URL, label });
  let u;
  try { u = new URL(s); } catch { throw monitorError('invalid_url', `${label} is not a valid URL.`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw monitorError('invalid_url', `${label} must be http:// or https:// — ${u.protocol}// is not a monitored protocol.`);
  }
  if (u.username || u.password) {
    throw monitorError('invalid_url', `${label} must not contain credentials.`);
  }
  if (!u.hostname) throw monitorError('invalid_url', `${label} has no host.`);
  if (u.hostname.includes('*')) throw monitorError('invalid_url', `${label} cannot contain a wildcard host.`);
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw monitorError('invalid_url', `${label} has an unusable port.`);
  if (UNSAFE_HTTP_PORTS.has(port)) {
    throw monitorError('unsafe_port', `${label} points at port ${port}, which is never an HTTP application — monitoring it would make OpusHub a probe for that service.`);
  }
  if (u.pathname.length > MAX_PATH) throw monitorError('invalid_url', `${label} has a path longer than ${MAX_PATH} characters.`);
  // a literal address must not be in a refused class; a hostname is checked when it resolves
  const literal = u.hostname.replace(/^\[|\]$/g, '');
  if (literal.includes(':') || IPV4_RE.test(literal)) {
    const cls = classifyIp(literal);
    if (cls === 'invalid') throw monitorError('invalid_url', `${label} contains an address OpusHub cannot read.`);
    if (BLOCKED_FOR_MONITOR.has(cls)) {
      throw monitorError('blocked_address', `${label} points at ${cls} space, which monitors never reach.`);
    }
    if (!allowInternal && isInternalAddress(literal)) {
      throw monitorError('internal_blocked', `${label} points at the local network, and this instance has been configured to monitor public endpoints only.`);
    }
  }
  u.hash = '';
  return u.toString().replace(/\/$/, '') || u.toString();
}

/* ------------------------------------------------------------------ */
/* monitor normalization                                               */
/* ------------------------------------------------------------------ */

/** The `expected` block for HTTP: a single status, a range, and nothing else. */
export function normalizeExpected(type, raw, defaults) {
  if (type !== 'http') {
    // only HTTP has a status code to compare; the others are documented as "answers or does not"
    return { status: null, min: null, max: null };
  }
  const src = raw && typeof raw === 'object' ? raw : {};
  const status = src.status == null || src.status === '' ? null : Number(src.status);
  if (status != null && (!Number.isInteger(status) || status < 100 || status > 599)) {
    throw monitorError('invalid_expected', 'Expected status must be a number between 100 and 599.');
  }
  const min = src.min == null || src.min === '' ? (status == null ? 200 : null) : Number(src.min);
  const max = src.max == null || src.max === '' ? (status == null ? 399 : null) : Number(src.max);
  for (const v of [min, max]) {
    if (v != null && (!Number.isInteger(v) || v < 100 || v > 599)) {
      throw monitorError('invalid_expected', 'An expected status range must stay between 100 and 599.');
    }
  }
  if (min != null && max != null && min > max) throw monitorError('invalid_expected', 'The expected status range runs backwards.');
  return { status, min, max };
}

/** Human summary of `expected`, used by the UI and by the settings pane. */
export function describeExpected(expected) {
  if (!expected) return 'any response below 400';
  if (expected.status != null) return `HTTP ${expected.status}`;
  if (expected.min != null && expected.max != null) return `HTTP ${expected.min}–${expected.max}`;
  return 'any response below 400';
}

/**
 * Validate a target for a monitor type.
 *
 * HTTP   — a service reference (preferred: the canonical endpoint is resolved per check) and an
 *          optional validated endpoint override. At least one of them must be present.
 * TCP    — an explicitly configured host and port.
 * Docker — a canonical service/container reference resolved against the inventory.
 */
export function validateTarget(type, raw, { allowInternal = true } = {}) {
  const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (type === 'http') {
    const service = normalizeServiceRef(t.service, { required: false });
    const url = t.url == null || t.url === '' ? null : parseHttpEndpoint(t.url, { allowInternal });
    if (!service && !url) {
      throw monitorError('invalid_target', 'An HTTP monitor needs either a service to watch or an endpoint to check.');
    }
    return { kind: 'http', service, url, ...normalizeScope(t) };
  }
  if (type === 'tcp') {
    return { kind: 'tcp', host: parseHost(t.host, { allowInternal }), port: parsePort(t.port), ...normalizeScope(t) };
  }
  if (type === 'docker') {
    const ref = t.service ?? t;
    if (ref == null || typeof ref !== 'object' || Array.isArray(ref) || !ref.name) {
      throw monitorError('invalid_target', 'A Docker monitor needs a discovered service to watch.');
    }
    // a Docker target has no address of its own: it is resolved through the canonical inventory
    return { kind: 'docker', service: normalizeServiceRef(ref, { required: true }), ...normalizeScope(t) };
  }
  throw monitorError('invalid_type', `Unknown monitor type: ${String(type).slice(0, 24)}.`);
}

/**
 * The observed scope of a target, carried through validation. This is evidence from the last
 * check — a stored record keeps it, and a fresh target has none (`null`, i.e. "not measured").
 */
function normalizeScope(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const scope = TARGET_SCOPES.includes(t.scope) ? t.scope : null;
  const at = Number.isFinite(Number(t.scopeAt)) ? Number(t.scopeAt) : null;
  return { scope, scopeAt: scope ? at : null };
}

/** `{ group, name }` — a reference, never a target. Bounded, printable, no ids supplied by hand. */
export function normalizeServiceRef(raw, { required = true } = {}) {
  if (raw == null || raw === '' || typeof raw !== 'object') {
    if (required) throw monitorError('invalid_target', 'A Docker monitor needs a discovered service to watch.');
    return null;
  }
  const name = text(raw.name, { max: MAX_NAME, label: 'Service', required });
  if (!name) return null;
  if (/[\\/]/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) {
    // a container name, never a path, a socket or an endpoint — the inventory is the only thing
    // allowed to name a container, and nothing here may look like a route into the host
    throw monitorError('invalid_target', 'Service names are container names — not paths or endpoints.');
  }
  const group = text(raw.group, { max: MAX_NAME, label: 'Group', required: false });
  if (group && (/[\\/]/.test(group) || /[\u0000-\u001f\u007f]/.test(group))) throw monitorError('invalid_target', 'Group names are labels — not paths or endpoints.');
  if (/^[0-9a-f]{12}$|^[0-9a-f]{64}$/i.test(name)) {
    // a bare container id is not a reference OpusHub accepts: the inventory is the only thing that
    // may name a container, and it names them by service
    throw monitorError('invalid_target', 'Name a service, not a container id — OpusHub resolves the container itself.');
  }
  return { group: group || null, name };
}

/** Provenance where a provider supplied the endpoint. Purely descriptive. */
export function normalizeSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = text(raw.kind, { max: 40, label: 'Source', required: false });
  if (!kind) return null;
  return {
    kind,
    provider: text(raw.provider, { max: 40, label: 'Provider', required: false }),
    urlSource: text(raw.urlSource, { max: 40, label: 'URL source', required: false }),
    note: text(raw.note, { max: 200, label: 'Source note', required: false }),
  };
}

/** A maintenance window: bounded, explicit, and never longer than the configured maximum. */
export function normalizeMaintenance(raw, { now = Date.now() } = {}) {
  if (raw == null) return null;
  if (typeof raw !== 'object') throw monitorError('invalid_maintenance', 'Maintenance must be an object.');
  const until = Number(raw.until);
  if (!Number.isFinite(until)) throw monitorError('invalid_maintenance', 'A maintenance window needs an end time.');
  const maxMs = BOUNDS.maintenanceMaxMs.max;
  const boundedUntil = Math.min(until, now + maxMs);
  if (boundedUntil <= now) throw monitorError('invalid_maintenance', 'The maintenance window has already ended.');
  return {
    until: boundedUntil,
    reason: text(raw.reason, { max: 200, label: 'Reason', required: false }),
    startedAt: Number.isFinite(Number(raw.startedAt)) ? Number(raw.startedAt) : now,
  };
}

/** True while a monitor's maintenance window is open. Server clock only. */
export const maintenanceActive = (monitor, now = Date.now()) => !!(monitor?.maintenance && monitor.maintenance.until > now);

export function newMonitorId() {
  return `mon-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Build a stored monitor from a validated draft. `defaults` is the effective settings document.
 * `id` and `createdAt` are supplied by the caller (the store), never by a request.
 */
export function makeMonitor(draft, { defaults, id = newMonitorId(), now = Date.now() } = {}) {
  const d = normalizeSettings(defaults);
  const type = typeof draft?.type === 'string' ? draft.type.trim().toLowerCase() : '';
  if (!MONITOR_TYPES.includes(type)) {
    throw monitorError('invalid_type', `Monitor type must be one of ${MONITOR_TYPES.join(', ')}.`);
  }
  const name = text(draft?.name, { max: MAX_NAME, label: 'Name' });
  const target = validateTarget(type, draft?.target, { allowInternal: d.allowInternal !== false });
  const intervalMs = draft?.intervalMs == null ? d.intervalMs : clampSetting('intervalMs', draft.intervalMs);
  const requestedTimeout = draft?.timeoutMs == null ? d.timeoutMs : clampSetting('timeoutMs', draft.timeoutMs);
  // a timeout that can outlive its own interval is how a scheduler grows a backlog
  const timeoutMs = Math.max(BOUNDS.timeoutMs.min, Math.min(requestedTimeout, Math.max(500, intervalMs - 1000)));
  const provenance = PROVENANCE.includes(draft?.provenance) ? draft.provenance : 'configured';
  return {
    id,
    name,
    type,
    target,
    intervalMs,
    timeoutMs,
    enabled: draft?.enabled !== false,
    expected: normalizeExpected(type, draft?.expected, d),
    provenance,
    source: normalizeSource(draft?.source),
    // description is presentation only — it never reaches a check
    description: text(draft?.description, { max: 200, label: 'Description', required: false }),
    status: 'pending',
    latencyMs: null,
    lastCheck: null,
    nextCheck: null,
    failureCount: 0,
    successCount: 0,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    targetStale: false,
    maintenance: normalizeMaintenance(draft?.maintenance, { now }),
    createdAt: now,
    updatedAt: now,
  };
}

/** Everything the model guarantees about a *stored* record, applied on load. Used by the store. */
export function normalizeStoredMonitor(raw, { defaults } = {}) {
  const d = normalizeSettings(defaults);
  if (!raw || typeof raw !== 'object' || !MONITOR_TYPES.includes(raw.type)) return null;
  if (typeof raw.id !== 'string' || !/^mon-[a-z0-9]{6,32}$/.test(raw.id)) return null;
  let monitor;
  try {
    // A stored record is re-validated with internal targets *allowed*, always: turning the setting
    // off must stop new checks, not silently delete the monitors an operator already has.
    monitor = makeMonitor(raw, { defaults: { ...d, allowInternal: true }, id: raw.id, now: Number(raw.createdAt) || Date.now() });
  } catch {
    return null; // an unreadable record is dropped rather than half-trusted
  }
  const state = MONITOR_STATES.includes(raw.status) ? raw.status : 'pending';
  return {
    ...monitor,
    status: state,
    latencyMs: Number.isFinite(Number(raw.latencyMs)) ? Number(raw.latencyMs) : null,
    lastCheck: raw.lastCheck && typeof raw.lastCheck === 'object' ? raw.lastCheck : null,
    nextCheck: Number.isFinite(Number(raw.nextCheck)) ? Number(raw.nextCheck) : null,
    failureCount: Math.max(0, Math.trunc(Number(raw.failureCount) || 0)),
    successCount: Math.max(0, Math.trunc(Number(raw.successCount) || 0)),
    consecutiveFailures: Math.max(0, Math.trunc(Number(raw.consecutiveFailures) || 0)),
    consecutiveSuccesses: Math.max(0, Math.trunc(Number(raw.consecutiveSuccesses) || 0)),
    targetStale: raw.targetStale === true,
    enabled: raw.enabled !== false,
    createdAt: Number(raw.createdAt) || monitor.createdAt,
    updatedAt: Number(raw.updatedAt) || monitor.updatedAt,
  };
}

/** The public projection of a monitor: everything the UI needs, nothing the engine keeps private. */
export function publicMonitor(monitor, { now = Date.now(), incidents = null, uptime = null } = {}) {
  if (!monitor) return null;
  return {
    id: monitor.id,
    name: monitor.name,
    type: monitor.type,
    target: monitor.target,
    intervalMs: monitor.intervalMs,
    timeoutMs: monitor.timeoutMs,
    enabled: monitor.enabled,
    expected: monitor.expected,
    provenance: monitor.provenance,
    source: monitor.source,
    description: monitor.description ?? null,
    status: monitor.enabled ? monitor.status : 'paused',
    storedStatus: monitor.status,
    latencyMs: monitor.latencyMs,
    lastCheck: monitor.lastCheck,
    nextCheck: monitor.nextCheck,
    failureCount: monitor.failureCount,
    successCount: monitor.successCount,
    consecutiveFailures: monitor.consecutiveFailures,
    consecutiveSuccesses: monitor.consecutiveSuccesses,
    targetStale: monitor.targetStale === true,
    maintenance: maintenanceActive(monitor, now) ? monitor.maintenance : null,
    createdAt: monitor.createdAt,
    updatedAt: monitor.updatedAt,
    incidents,
    uptime,
  };
}
