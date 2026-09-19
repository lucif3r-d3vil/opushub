// The monitoring engine — wiring, history, uptime and the honest answer to "what is true now?".
//
// One engine per process. It owns:
//   · the monitor set (loaded from data/monitoring/monitors.json at boot, so a restart resumes
//     rather than forgets);
//   · the centralized scheduler (server/monitoring/scheduler.js) — one timer, bounded pool;
//   · the checks (checks/http.js, checks/tcp.js, checks/docker.js) — each one read-only;
//   · the state machine (state.js), incidents (incidents.js) and bounded history (store.js);
//   · activity events, but only for transitions that actually mean something;
//   · the alert inputs the existing alert engine consumes (server/alerts.js) — this engine does not
//     evaluate alerts itself and does not have a notification channel of any kind.
//
// What the engine can NOT do, and will not grow the ability to do:
//   · it never imports the Phase 8 operations engine, dockerOperations.js or child_process —
//     a static proof (server/phase10a-proof.test.js) asserts the absence mechanically;
//   · it never executes a Docker write of any kind; the Docker check is a read through
//     providers/docker.js;
//   · it never writes anywhere but data/monitoring/ (server/monitoring/store.js enforces the name
//     list);
//   · it never accepts a URL, host or port from a request without validating it in model.js.
import * as model from '../model.js';
import * as docker from '../providers/docker.js';
import { logEvent } from '../activity.js';
import { STORE_FILES, createFlusher, docExists, readDoc, removeDoc, writeDoc } from './store.js';

// Phase 10B — best-effort publish onto the canonical event bus. Not circular: events/index
// depends on the activity log and its store, never on the monitoring engine.
import { publishEventSafe } from '../events/index.js';
import {
  BOUNDS, MONITOR_TYPES, MonitorError, describeExpected, maintenanceActive, makeMonitor,
  monitorError, newMonitorId, normalizeSettings, normalizeStoredMonitor, publicMonitor,
} from './model.js';
import { evaluateState } from './state.js';
import { MAX_INCIDENTS, applyState, closeFor, publicIncident, trimIncidents } from './incidents.js';
import { createScheduler } from './scheduler.js';
import { scopeOf } from './net.js';
import { checkHttp } from './checks/http.js';
import { checkTcp } from './checks/tcp.js';
import { checkDocker } from './checks/docker.js';
import { suggestMonitors } from './discovery.js';

export const STORE_VERSION = 1;

/** A monitor whose last check is older than this multiple of its interval is *stale*, not current. */
export const STALE_FACTOR = 2.5;
/** The engine is considered not-running if no tick has happened for this long. */
export const ENGINE_STALE_MS = 120_000;
/** Minimum gap between two manual "check now" requests for the same monitor. */
export const MANUAL_MIN_GAP_MS = 5_000;
/** Latency history kept for the detail chart is the raw sample ring — see retention in model.js. */
const DEFAULT_NOT_STARTED = 'The monitoring engine has not been started in this process.';

/* ------------------------------------------------------------------ */
/* process state                                                       */
/* ------------------------------------------------------------------ */

const state = {
  monitors: new Map(),      // id → monitor record (the engine's own copy, not the store's)
  history: new Map(),       // id → { samples: [], hours: [] }
  incidents: [],
  settings: normalizeSettings({}),
  engine: { startedAt: null, stoppedAt: null, lastTickAt: null, lastCheckAt: null, bootCount: 0, lastError: null },
  loaded: false,
};
let scheduler = null;
let flusher = null;
let stopped = false;
/** A snapshot of the inventory for one tick, shared by every Docker monitor in it. */
let inventorySnapshot = null;

const now = () => Date.now();

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

function loadMonitors() {
  const doc = readDoc(STORE_FILES[0], null);
  if (!doc) return { monitors: [], settings: normalizeSettings({}), reboots: 0 };
  const settings = normalizeSettings(doc.settings || {});
  const monitors = Array.isArray(doc.monitors)
    ? doc.monitors.map((m) => normalizeStoredMonitor(m, { defaults: settings })).filter(Boolean)
    : [];
  return { monitors, settings, reboots: Number(doc.engine?.bootCount) || 0 };
}

function loadHistory() {
  const doc = readDoc('history.json', null);
  const out = new Map();
  if (!doc || typeof doc.monitors !== 'object' || !doc.monitors) return out;
  for (const [id, entry] of Object.entries(doc.monitors)) {
    if (!entry || typeof entry !== 'object') continue;
    out.set(id, {
      samples: Array.isArray(entry.samples) ? entry.samples.filter(sampleOk).slice(-BOUNDS.retentionSamples.max) : [],
      hours: Array.isArray(entry.hours) ? entry.hours.filter(hourOk).slice(-BOUNDS.retentionHours.max) : [],
    });
  }
  return out;
}

const sampleOk = (s) => s && typeof s === 'object' && Number.isFinite(Number(s.t)) && typeof s.k === 'string';
const hourOk = (h) => h && typeof h === 'object' && Number.isFinite(Number(h.h));

function loadIncidents() {
  const doc = readDoc('incidents.json', null);
  if (!doc || !Array.isArray(doc.incidents)) return [];
  return trimIncidents(doc.incidents.filter((i) => i && typeof i === 'object' && typeof i.id === 'string' && typeof i.monitorId === 'string'), MAX_INCIDENTS);
}

/** Persist everything the engine owns. Called through a debounced flusher, and on shutdown. */
function persist() {
  writeDoc(STORE_FILES[0], {
    version: STORE_VERSION,
    settings: state.settings,
    engine: { bootCount: state.engine.bootCount, startedAt: state.engine.startedAt },
    monitors: [...state.monitors.values()],
  });
  const history = { version: STORE_VERSION, monitors: {} };
  for (const [id, entry] of state.history) history.monitors[id] = entry;
  writeDoc('history.json', history);
  writeDoc('incidents.json', { version: STORE_VERSION, incidents: state.incidents });
  writeDoc('engine.json', {
    version: STORE_VERSION,
    startedAt: state.engine.startedAt,
    stoppedAt: state.engine.stoppedAt,
    lastTickAt: state.engine.lastTickAt,
    lastCheckAt: state.engine.lastCheckAt,
    bootCount: state.engine.bootCount,
    ...(state.engine.lastError ? { lastError: state.engine.lastError } : {}),
  });
}

function schedulePersist() {
  if (!flusher) return;
  flusher.schedule();
}

/* ------------------------------------------------------------------ */
/* history + uptime                                                    */
/* ------------------------------------------------------------------ */

function historyFor(id) {
  if (!state.history.has(id)) state.history.set(id, { samples: [], hours: [] });
  return state.history.get(id);
}

const hourOf = (t) => Math.floor(t / 3_600_000) * 3_600_000;

/** Append one check to the bounded ring and fold it into the current hourly bucket. */
function recordHistory(monitor, result) {
  const entry = historyFor(monitor.id);
  const sample = { t: result.at, k: result.kind, ms: Number.isFinite(result.latencyMs) ? result.latencyMs : null, code: result.statusCode ?? null };
  entry.samples.push(sample);
  const maxSamples = state.settings.retentionSamples;
  if (entry.samples.length > maxSamples) entry.samples = entry.samples.slice(-maxSamples);

  const h = hourOf(result.at);
  let bucket = entry.hours[entry.hours.length - 1];
  if (!bucket || bucket.h !== h) {
    bucket = { h, ok: 0, degraded: 0, fail: 0, unknown: 0, msSum: 0, msCount: 0, msMin: null, msMax: null };
    entry.hours.push(bucket);
  }
  if (result.kind === 'ok') bucket.ok += 1;
  else if (result.kind === 'degraded') bucket.degraded += 1;
  else if (result.kind === 'fail') bucket.fail += 1;
  else bucket.unknown += 1;
  if (Number.isFinite(result.latencyMs)) {
    bucket.msSum += result.latencyMs;
    bucket.msCount += 1;
    bucket.msMin = bucket.msMin == null ? result.latencyMs : Math.min(bucket.msMin, result.latencyMs);
    bucket.msMax = bucket.msMax == null ? result.latencyMs : Math.max(bucket.msMax, result.latencyMs);
  }
  const maxHours = state.settings.retentionHours;
  if (entry.hours.length > maxHours) entry.hours = entry.hours.slice(-maxHours);
}

/**
 * Uptime and latency over a window, computed from recorded checks only.
 *
 * The honesty rules from the brief, expressed in the arithmetic:
 *   · `unknown` results (no verdict: engine down, target stale) are NOT successes and NOT
 *     failures — they are counted separately and excluded from the percentage;
 *   · a window with no checks at all answers `uptimePct: null` with `noData: true`, never 100%;
 *   · paused periods produce no samples, so they neither help nor hurt — `excluded` says so;
 *   · everything is measured with server timestamps (the sample's own `t`).
 */
export function computeUptime(entry, { windowMs = 24 * 3_600_000, at = now(), status = 'up' } = {}) {
  const since = at - windowMs;
  const samples = (entry?.samples || []).filter((s) => s.t >= since);
  let ok = 0; let degraded = 0; let fail = 0; let unknown = 0;
  let msSum = 0; let msCount = 0; let msMin = null; let msMax = null;
  for (const s of samples) {
    if (s.k === 'ok') ok += 1;
    else if (s.k === 'degraded') degraded += 1;
    else if (s.k === 'fail') fail += 1;
    else unknown += 1;
    if (Number.isFinite(s.ms)) {
      msSum += s.ms; msCount += 1;
      msMin = msMin == null ? s.ms : Math.min(msMin, s.ms);
      msMax = msMax == null ? s.ms : Math.max(msMax, s.ms);
    }
  }
  const judged = ok + degraded + fail;
  return {
    windowMs,
    from: at - windowMs,
    to: at,
    checks: samples.length,
    ok, degraded, fail, unknown,
    // "missing data does not count as a successful check": the denominator is judged checks only
    judged,
    uptimePct: judged > 0 ? Math.round((ok / judged) * 10_000) / 100 : null,
    degradedPct: judged > 0 ? Math.round((degraded / judged) * 10_000) / 100 : null,
    avgLatencyMs: msCount ? Math.round(msSum / msCount) : null,
    minLatencyMs: msMin,
    maxLatencyMs: msMax,
    noData: samples.length === 0,
    paused: status === 'paused',
    // samples older than the window still exist in the ring; saying how far back the window goes is
    // what stops a 99.9% over "the last hour" being read as a lifetime number
    coverageFrom: samples.length ? samples[0].t : null,
    coverageTo: samples.length ? samples[samples.length - 1].t : null,
  };
}

/** Latency/state series for the detail chart, from raw samples (bounded by retention). */
function seriesFor(id, { windowMs = 24 * 3_600_000, at = now(), max = 240 } = {}) {
  const entry = state.history.get(id);
  if (!entry) return [];
  const since = at - windowMs;
  const samples = entry.samples.filter((s) => s.t >= since);
  if (samples.length <= max) return samples;
  const step = Math.ceil(samples.length / max);
  const out = [];
  for (let i = 0; i < samples.length; i += step) {
    // one point per bucket: the *worst* state and the average latency of the bucket, so a spike is
    // never averaged away in the chart
    const bucket = samples.slice(i, i + step);
    const worst = bucket.some((s) => s.k === 'fail' || s.k === 'degraded') ? bucket.find((s) => s.k === 'fail' || s.k === 'degraded') : bucket[bucket.length - 1];
    const lat = bucket.filter((s) => Number.isFinite(s.ms));
    out.push({
      t: worst.t,
      k: worst.k,
      code: worst.code ?? null,
      ms: lat.length ? Math.round(lat.reduce((a, s) => a + s.ms, 0) / lat.length) : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* checks                                                              */
/* ------------------------------------------------------------------ */

/** Resolve an HTTP monitor's endpoint for *this* check. Service targets are resolved fresh. */
async function httpTargetFor(monitor, { inventory }) {
  const ref = monitor.target.service;
  if (ref) {
    const all = [...(inventory?.groups || []).flatMap((g) => g.services || []), ...(inventory?.services || [])];
    const key = ref.name.toLowerCase();
    const gkey = ref.group ? ref.group.toLowerCase() : null;
    const service = all.find((s) => (s.name?.toLowerCase() === key || s.displayName?.toLowerCase() === key) && (!gkey || s.group?.toLowerCase() === gkey))
      || all.find((s) => s.name?.toLowerCase() === key || s.displayName?.toLowerCase() === key)
      || null;
    if (!service) {
      return { ok: false, code: 'stale_target', reason: `${ref.group ? `${ref.group}/` : ''}${ref.name} is not in the current inventory.`, stale: true };
    }
    if (service.url && ['manual', 'traefik', 'published-port'].includes(service.urlSource)) {
      return { ok: true, url: service.url, source: service.urlSource, service };
    }
    if (monitor.target.url) return { ok: true, url: monitor.target.url, source: 'configured', service };
    return { ok: false, code: 'no_endpoint', reason: service.urlNote || `${service.displayName || service.name} has no endpoint OpusHub can reach.` };
  }
  return { ok: true, url: monitor.target.url, source: 'configured', service: null };
}

/** Fetch the inventory once per tick — Docker monitors share it, and it is cached by the model. */
async function inventoryForTick({ force = false } = {}) {
  if (!force && inventorySnapshot && now() - inventorySnapshot.at < 5_000) return inventorySnapshot.value;
  let value = null;
  try { value = await model.getInventory({ refreshMs: 5_000 }); } catch { value = null; }
  inventorySnapshot = { at: now(), value };
  return value;
}

/** Run one monitor's check. Never throws; every outcome is a recorded result. */
export async function runCheck(monitor, { at = now(), inventory = null, deps = {} } = {}) {
  const settings = state.settings;
  const inv = inventory ?? await inventoryForTick({ force: monitor.type === 'docker' });
  const dockerAvailable = deps.dockerAvailable ?? docker.availability().ok;

  let result;
  try {
    if (monitor.type === 'http') {
      const target = await httpTargetFor(monitor, { inventory: inv });
      if (!target.ok) {
        result = { kind: 'unknown', at, latencyMs: null, statusCode: null, errorType: target.code, code: target.code, reason: target.reason, hops: 0, evidence: null, stale: target.stale === true };
      } else {
        result = await (deps.checkHttp || checkHttp)({ url: target.url }, {
          expected: monitor.expected,
          timeoutMs: monitor.timeoutMs,
          now: at,
          allowInternal: settings.allowInternal !== false,
          ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
          ...(deps.requestOne ? { requestOne: deps.requestOne } : {}),
        });
        result.evidence = { ...(result.evidence || {}), urlSource: target.source };
      }
    } else if (monitor.type === 'tcp') {
      result = await (deps.checkTcp || checkTcp)({ host: monitor.target.host, port: monitor.target.port }, {
        timeoutMs: monitor.timeoutMs,
        now: at,
        allowInternal: settings.allowInternal !== false,
        ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
        ...(deps.connect ? { connect: deps.connect } : {}),
      });
    } else if (monitor.type === 'docker') {
      result = await (deps.checkDocker || checkDocker)(monitor.target, {
        inventory: inv,
        now: at,
        dockerAvailable,
        ...(deps.inspect ? { inspect: deps.inspect } : {}),
      });
    } else {
      result = { kind: 'unknown', at, latencyMs: null, statusCode: null, errorType: 'invalid_type', code: 'invalid_type', reason: `Unsupported monitor type: ${monitor.type}`, hops: 0, evidence: null };
    }
  } catch (err) {
    // A check that threw is a check that produced no verdict — never a silent "down".
    result = {
      kind: 'unknown', at, latencyMs: null, statusCode: null, errorType: 'engine_error', code: 'engine_error',
      reason: `The check could not be run (${err?.message || err}).`, hops: 0, evidence: null,
    };
  }
  return record(monitor, result, { settings });
}

/* ------------------------------------------------------------------ */
/* recording a result                                                  */
/* ------------------------------------------------------------------ */

function record(monitor, result, { settings = state.settings } = {}) {
  const previous = monitor.status;
  const maintenanceOpen = maintenanceActive(monitor, result.at);
  const paused = monitor.enabled === false;
  const streakStart = monitor.streakStartedAt ?? null;

  const evaluated = evaluateState(monitor, result, {
    failureThreshold: settings.failureThreshold,
    recoveryThreshold: settings.recoveryThreshold,
    now: result.at,
    paused,
  });

  monitor.status = evaluated.state;
  monitor.consecutiveFailures = evaluated.consecutiveFailures;
  monitor.consecutiveSuccesses = evaluated.consecutiveSuccesses;
  monitor.failureCount = evaluated.totalFailures;
  monitor.successCount = evaluated.totalSuccesses;
  monitor.latencyMs = Number.isFinite(result.latencyMs) ? result.latencyMs : null;
  monitor.lastCheck = {
    at: result.at,
    kind: result.kind,
    statusCode: result.statusCode ?? null,
    latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : null,
    reason: result.reason || null,
    code: result.code || null,
    errorType: result.errorType || null,
    hops: result.hops ?? 0,
    evidence: result.evidence || null,
  };
  monitor.targetStale = result.stale === true;
  // Where the check actually went: recorded on the target as evidence, so an internal endpoint is
  // a fact on the monitor rather than something a reader has to infer (see net.js `scopeOf`).
  const observedClasses = result.evidence?.addressClasses;
  if (Array.isArray(observedClasses) && observedClasses.length) {
    const scope = scopeOf(observedClasses);
    if (scope) {
      monitor.target.scope = scope;
      monitor.target.scopeAt = result.at;
    }
  }
  // The first failing check of the current streak — used as an incident's `startedAt`, so an
  // incident says when it began rather than when the threshold happened to be crossed.
  if (evaluated.consecutiveFailures === 1) monitor.streakStartedAt = result.at;
  if (evaluated.consecutiveFailures === 0) monitor.streakStartedAt = null;
  monitor.updatedAt = result.at;
  monitor.nextCheck = result.at + monitor.intervalMs;

  recordHistory(monitor, result);

  const suppression = maintenanceOpen;
  const nextIncidents = applyState(state.incidents, {
    monitor, previous, at: result.at,
    selected: null, maintenance: suppression, startedAt: streakStart,
  });
  const opened = nextIncidents.find((i) => i.monitorId === monitor.id && i.status !== 'resolved' && !state.incidents.includes(i));
  const before = state.incidents.find((i) => i.monitorId === monitor.id && i.status !== 'resolved') || null;
  state.incidents = trimIncidents(nextIncidents, state.settings.retentionIncidents);

  logTransitions(monitor, { previous, result, maintenanceOpen: suppression });
  if (opened) {
    logEvent({
      source: 'system', type: 'incident.opened', subject: monitor.name,
      message: `${monitor.name} incident opened: ${opened.reason}`,
      meta: { monitorId: monitor.id, incidentId: opened.id, type: monitor.type, severity: suppression ? 'info' : 'warning', maintenance: suppression, startedAt: opened.startedAt },
      severity: suppression ? 'info' : 'warning', category: 'monitoring',
      signature: `incident.opened:${opened.id}`,
    });
    publishEventSafe({
      type: 'monitor.incident.opened',
      severity: suppression ? 'info' : 'warning',
      source: 'monitor',
      subject: { kind: 'monitor', id: monitor.id, label: monitor.name, href: `/monitoring/${monitor.id}` },
      message: `${monitor.name} incident opened: ${opened.reason}`,
      payload: { reason: opened.reason, type: monitor.type, maintenance: suppression },
      correlation: { monitorId: monitor.id, incidentId: opened.id },
    });
  }
  if (before && !state.incidents.some((i) => i.id === before.id && i.status !== 'resolved')) {
    const resolved = state.incidents.find((i) => i.id === before.id) || before;
    logEvent({
      source: 'system', type: 'incident.resolved', subject: monitor.name,
      message: `${monitor.name} incident resolved after ${Math.round((resolved.durationMs || 0) / 1000)}s`,
      meta: { monitorId: monitor.id, incidentId: resolved.id, durationMs: resolved.durationMs, resolvedBy: resolved.resolvedBy },
      severity: 'notice', category: 'monitoring',
      signature: `incident.resolved:${resolved.id}`,
    });
    publishEventSafe({
      type: 'monitor.incident.recovered',
      severity: 'notice',
      source: 'monitor',
      subject: { kind: 'monitor', id: monitor.id, label: monitor.name, href: `/monitoring/${monitor.id}` },
      message: `${monitor.name} incident resolved after ${Math.round((resolved.durationMs || 0) / 1000)}s`,
      payload: { durationMs: resolved.durationMs, reason: resolved.reason || null },
      correlation: { monitorId: monitor.id, incidentId: resolved.id },
    });
  }

  state.engine.lastCheckAt = result.at;
  schedulePersist();
  return { monitor, result, state: evaluated.state, previous, transition: evaluated.transition };
}

/** Activity only for meaningful transitions — never for a successful check. */
function logTransitions(monitor, { previous, result, maintenanceOpen }) {
  const badge = maintenanceOpen ? ' (maintenance)' : '';
  const base = {
    subject: monitor.name,
    meta: { monitorId: monitor.id, type: monitor.type, state: monitor.status, previous, reason: result.reason || null, maintenance: maintenanceOpen, service: monitor.target?.service || null },
    category: 'monitoring',
  };
  if (monitor.status === previous) return;
  if (monitor.status === 'down') {
    logEvent({ ...base, source: 'system', type: 'monitor.down', message: `${monitor.name} monitor went down${badge}: ${result.reason || 'the check failed'}`, severity: maintenanceOpen ? 'info' : 'warning', signature: `monitor.down:${monitor.id}` });
    publishEventSafe({
      type: 'monitor.state_changed',
      severity: maintenanceOpen ? 'info' : 'warning',
      source: 'monitor',
      subject: { kind: 'monitor', id: monitor.id, label: monitor.name, href: `/monitoring/${monitor.id}` },
      message: `${monitor.name} went down${badge}: ${result.reason || 'the check failed'}`,
      payload: { from: previous, to: 'down', reason: result.reason || null, maintenance: maintenanceOpen, service: monitor.target?.service || null },
      correlation: { monitorId: monitor.id },
    });
    return;
  }
  if (monitor.status === 'up') {
    // A brand-new monitor passing its first check is not a recovery — nothing was ever claimed to
    // be broken. Announcing it would put an event in Activity for every monitor ever created.
    if (previous === 'pending' || previous === 'paused') return;
    logEvent({ ...base, source: 'system', type: 'monitor.recovered', message: `${monitor.name} recovered${badge}`, severity: 'notice', signature: `monitor.recovered:${monitor.id}` });
    publishEventSafe({
      type: 'monitor.state_changed',
      severity: 'notice',
      source: 'monitor',
      subject: { kind: 'monitor', id: monitor.id, label: monitor.name, href: `/monitoring/${monitor.id}` },
      message: `${monitor.name} recovered${badge}`,
      payload: { from: previous, to: 'up', maintenance: maintenanceOpen, service: monitor.target?.service || null },
      correlation: { monitorId: monitor.id },
    });
    return;
  }
  if (monitor.status === 'degraded') {
    logEvent({ ...base, source: 'system', type: 'monitor.degraded', message: `${monitor.name} is degraded${badge}: ${result.reason || 'the check responded outside its expectations'}`, severity: maintenanceOpen ? 'info' : 'warning', signature: `monitor.degraded:${monitor.id}` });
    publishEventSafe({
      type: 'monitor.state_changed',
      severity: maintenanceOpen ? 'info' : 'warning',
      source: 'monitor',
      subject: { kind: 'monitor', id: monitor.id, label: monitor.name, href: `/monitoring/${monitor.id}` },
      message: `${monitor.name} is degraded${badge}: ${result.reason || 'check outside expectations'}`,
      payload: { from: previous, to: 'degraded', reason: result.reason || null, maintenance: maintenanceOpen },
      correlation: { monitorId: monitor.id },
    });
    return;
  }
  if (monitor.status === 'recovering') {
    logEvent({ ...base, source: 'system', type: 'monitor.recovering', message: `${monitor.name} is answering again — waiting for ${state.settings.recoveryThreshold} successful checks`, severity: 'notice', signature: `monitor.recovering:${monitor.id}` });
    return;
  }
  if (monitor.status === 'unknown' && ['up', 'down', 'degraded', 'recovering'].includes(previous)) {
    logEvent({ ...base, source: 'system', type: 'monitor.unknown', message: `${monitor.name} has no verdict: ${result.reason || 'nothing was measured'}`, severity: 'info', signature: `monitor.unknown:${monitor.id}` });
  }
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

/** Load persisted state, wire the scheduler and (optionally) start ticking. */
export async function start({ autoStart = true, concurrent = null, clock = null, random = Math.random, deps = {} } = {}) {
  if (state.loaded) return engineHealth();
  const loaded = loadMonitors();
  state.settings = loaded.settings;
  state.history = loadHistory();
  state.incidents = loadIncidents();
  const engineDoc = readDoc('engine.json', null);
  state.engine.bootCount = (Number(engineDoc?.bootCount) || 0) + 1;
  state.engine.startedAt = now();
  state.engine.stoppedAt = null;
  for (const m of loaded.monitors) state.monitors.set(m.id, m);
  state.loaded = true;
  stopped = false;

  flusher = createFlusher({ write: persist });
  scheduler = createScheduler({
    ...(clock ? { clock } : {}),
    concurrency: concurrent ?? state.settings.maxConcurrent,
    jitterMs: state.settings.jitterMs,
    random,
    onDue: (monitor) => runCheck(monitor, { deps }),
    onError: (err) => { state.engine.lastError = String(err?.message || err).slice(0, 200); },
    onTick: (info) => { state.engine.lastTickAt = now(); state.engine.lastTickInfo = info; },
  });
  scheduler.sync([...state.monitors.values()]);
  if (autoStart) scheduler.start();
  schedulePersist();
  // Discovery is bounded and opt-in: nothing is created unless the operator asked for it, and then
  // only up to the configured maximum, each one tagged `provenance: discovered`.
  if (state.settings.autoCreate.enabled && state.settings.autoCreate.max > 0) {
    void autoCreateFromSuggestions({ actor: 'opushub' }).catch(() => {});
  }
  return engineHealth();
}

/** Graceful shutdown: stop arming work, let the running checks finish, flush what is on disk. */
export async function stop() {
  stopped = true;
  state.engine.stoppedAt = now();
  if (scheduler) await scheduler.stop();
  if (flusher) flusher.stop();
  return { stoppedAt: state.engine.stoppedAt };
}

/**
 * Test helper — clear process state but leave the store on disk. This is what a *restart* looks
 * like, which is exactly what the persistence tests need.
 */
export function _resetEngine() {
  state.monitors.clear();
  state.history.clear();
  state.incidents = [];
  state.settings = normalizeSettings({});
  state.engine = { startedAt: null, stoppedAt: null, lastTickAt: null, lastCheckAt: null, bootCount: 0, lastError: null };
  state.loaded = false;
  scheduler = null;
  flusher = null;
  stopped = false;
  inventorySnapshot = null;
}

/** Test helper — drop process state *and* the stored documents (test isolation). */
export function _wipeMonitoring() {
  _resetEngine();
  for (const name of STORE_FILES) removeDoc(name);
}

/* ------------------------------------------------------------------ */
/* monitor CRUD (all writes validated in model.js)                     */
/* ------------------------------------------------------------------ */

const find = (id) => state.monitors.get(String(id || '')) || null;

function assertCapacity() {
  if (state.monitors.size >= state.settings.maxMonitors) {
    throw monitorError('too_many_monitors', `This install is limited to ${state.settings.maxMonitors} monitors. Remove one, or raise the limit in Settings → Monitoring.`, 409);
  }
}

/**
 * A Docker monitor's target must resolve *now*: creating a monitor for a service that does not
 * exist would be a monitor that can only ever say "unknown".
 */
async function assertTargetResolvable(monitor) {
  if (monitor.type !== 'docker' && !(monitor.type === 'http' && monitor.target.service)) return;
  const inv = await inventoryForTick({ force: true });
  if (!inv || inv.live === false) {
    throw monitorError('docker_unavailable', 'Docker is not reachable, so the service in this monitor cannot be verified yet. Try again once the engine is connected.', 503);
  }
  const ref = monitor.target.service;
  const all = [...(inv.groups || []).flatMap((g) => g.services || []), ...(inv.services || [])];
  const key = ref.name.toLowerCase();
  const gkey = ref.group ? ref.group.toLowerCase() : null;
  const match = all.find((s) => (s.name?.toLowerCase() === key || s.displayName?.toLowerCase() === key || s.slug === key) && (!gkey || s.group?.toLowerCase() === gkey));
  if (!match) {
    throw monitorError('unknown_target', `No service named “${ref.name}”${ref.group ? ` in ${ref.group}` : ''} was found in the current inventory.`, 400);
  }
}

export async function createMonitor(draft, { actor = null, at = now() } = {}) {
  assertCapacity();
  const monitor = makeMonitor(draft, { defaults: state.settings, id: newMonitorId(), now: at });
  if (state.monitors.has(monitor.id)) throw monitorError('duplicate_id', 'That monitor already exists.', 409);
  await assertTargetResolvable(monitor);
  monitor.nextCheck = at; // due immediately; the scheduler's jitter spreads the first checks
  state.monitors.set(monitor.id, monitor);
  if (scheduler) scheduler.track(monitor, { now: at });
  logEvent({
    source: 'user', type: 'monitor.created', subject: monitor.name,
    message: `${monitor.type.toUpperCase()} monitor created${actor ? ` by ${actor}` : ''}`,
    meta: { monitorId: monitor.id, type: monitor.type, intervalMs: monitor.intervalMs, expected: describeExpected(monitor.expected) },
    severity: 'notice', category: 'monitoring',
  });
  schedulePersist();
  return monitor;
}

/** Edit a monitor in place. State, counters and history are preserved unless the type changes. */
export async function updateMonitor(id, patch, { actor = null, at = now() } = {}) {
  const existing = find(id);
  if (!existing) throw monitorError('not_found', 'No such monitor.', 404);
  const merged = { ...existing, ...(patch || {}) };
  const rebuilt = makeMonitor(merged, { defaults: state.settings, id: existing.id, now: existing.createdAt });
  await assertTargetResolvable(rebuilt);
  const typeChanged = rebuilt.type !== existing.type;
  const next = {
    ...rebuilt,
    status: typeChanged ? 'pending' : existing.status,
    latencyMs: typeChanged ? null : existing.latencyMs,
    lastCheck: typeChanged ? null : existing.lastCheck,
    failureCount: existing.failureCount,
    successCount: existing.successCount,
    consecutiveFailures: typeChanged ? 0 : existing.consecutiveFailures,
    consecutiveSuccesses: typeChanged ? 0 : existing.consecutiveSuccesses,
    streakStartedAt: typeChanged ? null : existing.streakStartedAt,
    targetStale: typeChanged ? false : existing.targetStale,
    nextCheck: at,
    updatedAt: at,
  };
  state.monitors.set(next.id, next);
  if (scheduler) scheduler.track(next, { now: at });
  logEvent({
    source: 'user', type: 'monitor.updated', subject: next.name,
    message: `${next.name} monitor updated${actor ? ` by ${actor}` : ''}`,
    meta: { monitorId: next.id, intervalMs: next.intervalMs, expected: describeExpected(next.expected) },
    category: 'monitoring',
  });
  schedulePersist();
  return next;
}

export function pauseMonitor(id, { actor = null, at = now() } = {}) {
  const monitor = find(id);
  if (!monitor) throw monitorError('not_found', 'No such monitor.', 404);
  monitor.enabled = false;
  monitor.status = 'paused';
  monitor.nextCheck = null;
  monitor.updatedAt = at;
  state.incidents = trimIncidents(closeFor(state.incidents, monitor.id, { at, why: 'paused' }), state.settings.retentionIncidents);
  logEvent({ source: 'user', type: 'monitor.paused', subject: monitor.name, message: `${monitor.name} monitor paused${actor ? ` by ${actor}` : ''}`, meta: { monitorId: monitor.id }, category: 'monitoring' });
  schedulePersist();
  return monitor;
}

export function resumeMonitor(id, { actor = null, at = now() } = {}) {
  const monitor = find(id);
  if (!monitor) throw monitorError('not_found', 'No such monitor.', 404);
  monitor.enabled = true;
  monitor.status = 'unknown';           // resuming is not a verdict: the next check decides
  monitor.consecutiveFailures = 0;
  monitor.consecutiveSuccesses = 0;
  monitor.streakStartedAt = null;
  monitor.nextCheck = at;
  monitor.updatedAt = at;
  if (scheduler) scheduler.track(monitor, { now: at });
  logEvent({ source: 'user', type: 'monitor.resumed', subject: monitor.name, message: `${monitor.name} monitor resumed${actor ? ` by ${actor}` : ''}`, meta: { monitorId: monitor.id }, severity: 'notice', category: 'monitoring' });
  schedulePersist();
  return monitor;
}

export function deleteMonitor(id, { actor = null, at = now() } = {}) {
  const monitor = find(id);
  if (!monitor) throw monitorError('not_found', 'No such monitor.', 404);
  state.monitors.delete(id);
  state.incidents = trimIncidents(closeFor(state.incidents, id, { at, why: 'deleted' }), state.settings.retentionIncidents);
  state.history.delete(id);
  if (scheduler) scheduler.forget(id);
  logEvent({ source: 'user', type: 'monitor.deleted', subject: monitor.name, message: `${monitor.name} monitor deleted${actor ? ` by ${actor}` : ''}`, meta: { monitorId: id, type: monitor.type }, severity: 'notice', category: 'monitoring' });
  schedulePersist();
  return { id };
}

/** Open or close a maintenance window. During one, incidents are recorded but not alerted. */
export function setMaintenance(id, window, { actor = null, at = now() } = {}) {
  const monitor = find(id);
  if (!monitor) throw monitorError('not_found', 'No such monitor.', 404);
  monitor.maintenance = window ? { ...window, startedAt: at } : null;
  monitor.updatedAt = at;
  logEvent({
    source: 'user', type: window ? 'monitor.maintenance_started' : 'monitor.maintenance_ended', subject: monitor.name,
    message: window
      ? `${monitor.name} is in maintenance until ${new Date(window.until).toISOString()}${actor ? ` (${actor})` : ''}`
      : `${monitor.name} maintenance ended${actor ? ` (${actor})` : ''}`,
    meta: { monitorId: monitor.id, until: window?.until ?? null, reason: window?.reason ?? null },
    severity: 'notice', category: 'monitoring',
  });
  publishEventSafe({
    type: window ? 'monitor.maintenance.started' : 'monitor.maintenance.ended',
    severity: 'notice',
    source: 'monitor',
    subject: { kind: 'monitor', id: monitor.id, label: monitor.name, href: `/monitoring/${monitor.id}` },
    message: window ? `${monitor.name} entered maintenance until ${new Date(window.until).toISOString()}` : `${monitor.name} maintenance ended`,
    payload: { until: window?.until ?? null, reason: window?.reason ?? null },
    correlation: { monitorId: monitor.id },
  });
  schedulePersist();
  return monitor;
}

/** A manual check, through the same bounded path, rate-limited per monitor. */
export async function checkNow(id, { deps = {}, at = now() } = {}) {
  const monitor = find(id);
  if (!monitor) throw monitorError('not_found', 'No such monitor.', 404);
  if (!monitor.enabled) throw monitorError('paused', 'This monitor is paused.', 409);
  if (monitor.lastManualCheckAt && at - monitor.lastManualCheckAt < MANUAL_MIN_GAP_MS) {
    throw monitorError('rate_limited', `A manual check was run ${Math.round((at - monitor.lastManualCheckAt) / 1000)}s ago. Give it a moment.`, 429);
  }
  if (scheduler?._inFlightIds?.().includes(monitor.id)) {
    throw monitorError('in_flight', 'A check is already running for this monitor.', 409);
  }
  monitor.lastManualCheckAt = at;
  return runCheck(monitor, { at, deps });
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

export function getSettings() { return state.settings; }

export function updateSettings(patch, { actor = null, at = now() } = {}) {
  const next = normalizeSettings({ ...state.settings, ...(patch || {}), autoCreate: { ...state.settings.autoCreate, ...(patch?.autoCreate || {}) } });
  const changed = JSON.stringify(next) !== JSON.stringify(state.settings);
  state.settings = next;
  // apply the new bounds to every stored monitor, so a lowered limit is enforced, not just stored
  for (const monitor of state.monitors.values()) {
    monitor.intervalMs = Math.min(monitor.intervalMs, next.intervalMs) === monitor.intervalMs ? monitor.intervalMs : next.intervalMs;
    monitor.timeoutMs = Math.max(BOUNDS.timeoutMs.min, Math.min(monitor.timeoutMs, Math.max(500, monitor.intervalMs - 1000)));
    if (!monitor.enabled) monitor.nextCheck = null;
    if (scheduler) scheduler.track(monitor, { now: at });
  }
  if (scheduler && next.maxConcurrent !== scheduler.stats().concurrency) restartScheduler();
  if (changed) {
    logEvent({ source: 'user', type: 'monitor.settings_updated', subject: 'monitoring', message: `Monitoring defaults updated${actor ? ` by ${actor}` : ''}`, meta: { settings: next }, category: 'monitoring' });
  }
  schedulePersist();
  return next;
}

function restartScheduler() {
  if (!scheduler) return;
  const previous = scheduler;
  scheduler = createScheduler({
    concurrency: state.settings.maxConcurrent,
    jitterMs: state.settings.jitterMs,
    onDue: (monitor) => runCheck(monitor),
    onError: (err) => { state.engine.lastError = String(err?.message || err).slice(0, 200); },
    onTick: (info) => { state.engine.lastTickAt = now(); state.engine.lastTickInfo = info; },
  });
  scheduler.sync([...state.monitors.values()].map((m) => ({ ...m, nextCheck: m.enabled ? (m.nextCheck ?? now()) : null })));
  previous.stop().catch(() => {});
  scheduler.start();
}

/* ------------------------------------------------------------------ */
/* reads: overview, detail, engine health, alert inputs, search         */
/* ------------------------------------------------------------------ */

/** Is this monitor's data too old to be described as "current"? */
export function isStale(monitor, at = now()) {
  if (!monitor.enabled || monitor.status === 'paused') return false;
  if (!monitor.lastCheck?.at) return true;
  return at - monitor.lastCheck.at > monitor.intervalMs * STALE_FACTOR;
}

function countsAt(at = now()) {
  const counts = { total: 0, up: 0, degraded: 0, down: 0, recovering: 0, pending: 0, paused: 0, unknown: 0, stale: 0, maintenance: 0, suggested: 0 };
  for (const m of state.monitors.values()) {
    counts.total += 1;
    const shown = m.enabled ? m.status : 'paused';
    if (counts[shown] != null) counts[shown] += 1;
    if (isStale(m, at)) counts.stale += 1;
    if (maintenanceActive(m, at)) counts.maintenance += 1;
  }
  return counts;
}

/** The Monitoring page's document: engine health, counts, and the monitors themselves. */
export function overview({ at = now(), includeHistory = false } = {}) {
  const monitors = [...state.monitors.values()].map((m) => publicMonitor(m, {
    now: at,
    incidents: state.incidents.filter((i) => i.monitorId === m.id).length,
    ...(includeHistory ? { uptime: computeUptime(state.history.get(m.id), { windowMs: 24 * 3_600_000, at, status: m.enabled ? m.status : 'paused' }) } : {}),
  }));
  return { at, engine: engineHealth({ at }), counts: countsAt(at), monitors, settings: state.settings };
}

/** One monitor's detail document. Everything here is recorded data — nothing is synthesised. */
export function detail(id, { at = now() } = {}) {
  const monitor = find(id);
  if (!monitor) return null;
  const entry = state.history.get(monitor.id) || { samples: [], hours: [] };
  const incidents = state.incidents
    .filter((i) => i.monitorId === monitor.id)
    .sort((a, b) => b.startedAt - a.startedAt);
  const uptime = {
    day: computeUptime(entry, { windowMs: 24 * 3_600_000, at, status: monitor.enabled ? monitor.status : 'paused' }),
    week: computeUptime(entry, { windowMs: 7 * 24 * 3_600_000, at, status: monitor.enabled ? monitor.status : 'paused' }),
    month: computeUptime(entry, { windowMs: 30 * 24 * 3_600_000, at, status: monitor.enabled ? monitor.status : 'paused' }),
  };
  return {
    at,
    monitor: publicMonitor(monitor, { now: at, incidents: incidents.length, uptime: uptime.day }),
    stale: isStale(monitor, at),
    expected: describeExpected(monitor.expected),
    uptime,
    series: seriesFor(monitor.id, { at }),
    buckets: entry.hours.slice(-24),
    incidents: incidents.slice(0, 50).map((i) => publicIncident(i, { at })),
    engine: engineHealth({ at }),
  };
}

/**
 * Engine health — the answer to "is monitoring actually working?", which is a different question
 * from "is everything up?". A stopped engine (or one that has not ticked for two minutes) says so.
 */
export function engineHealth({ at = now() } = {}) {
  const s = scheduler?.stats?.() || { inFlight: 0, monitored: state.monitors.size, concurrency: state.settings.maxConcurrent, running: false, ticks: 0, checks: 0, lastTickAt: null, lastCheckAt: null, maxInFlight: 0 };
  const lastTickAt = state.engine.lastTickAt ?? null;
  const lastCheckAt = state.engine.lastCheckAt ?? null;
  const staleTick = lastTickAt != null && at - lastTickAt > ENGINE_STALE_MS;
  const notStarted = !state.engine.startedAt;
  const stoppedNow = stopped && state.engine.stoppedAt != null;
  const stateWord = notStarted ? 'unavailable' : stoppedNow ? 'stopped' : staleTick ? 'unavailable' : state.monitors.size ? 'running' : 'idle';
  const reason = notStarted ? DEFAULT_NOT_STARTED
    : stoppedNow ? 'The engine was stopped.'
    : staleTick ? `No scheduler tick for ${Math.round((at - lastTickAt) / 1000)}s.`
    : state.engine.lastError ? state.engine.lastError
    : null;
  return {
    at,
    state: stateWord,
    reason,
    startedAt: state.engine.startedAt,
    stoppedAt: state.engine.stoppedAt,
    lastTickAt,
    lastCheckAt,
    bootCount: state.engine.bootCount,
    checksRun: s.checks ?? 0,
    ticks: s.ticks ?? 0,
    checksRunning: s.inFlight ?? 0,
    maxChecksRunning: s.maxInFlight ?? 0,
    concurrency: s.concurrency ?? state.settings.maxConcurrent,
    monitored: state.monitors.size,
    active: [...state.monitors.values()].filter((m) => m.enabled).length,
    paused: [...state.monitors.values()].filter((m) => !m.enabled).length,
    // anything that is not currently ticking is stale data, whether it stopped or never started
    stale: stateWord !== 'running' && stateWord !== 'idle' ? true : staleTick,
    openIncidents: state.incidents.filter((i) => i.status !== 'resolved').length,
  };
}

/**
 * The snapshot the existing alert engine consumes. Only monitors that are genuinely down or
 * degraded, not paused, and not inside a maintenance window, are offered — so a maintenance window
 * is exactly as quiet as it is expected to be.
 */
export function alertInputs({ at = now() } = {}) {
  const monitors = [];
  for (const m of state.monitors.values()) {
    if (!m.enabled || m.status === 'paused') continue;
    if (maintenanceActive(m, at)) continue;
    if (m.status !== 'down' && m.status !== 'degraded') continue;
    monitors.push({
      id: m.id,
      name: m.name,
      type: m.type,
      status: m.status,
      service: m.target?.service || null,
      since: m.status === 'down' ? (m.streakStartedAt || m.lastCheck?.at || null) : (m.lastCheck?.at || null),
      reason: m.lastCheck?.reason || null,
      latencyMs: m.latencyMs,
      intervalMs: m.intervalMs,
    });
  }
  return { monitors };
}

/** Suggestions from the canonical inventory, minus what is already monitored. */
export async function suggestions({ at = now(), limit = 40 } = {}) {
  const inv = await inventoryForTick({ force: true });
  const { suggestions: list, reason } = suggestMonitors(inv, [...state.monitors.values()], { limit });
  return { at, suggestions: list, reason: reason || null, autoCreate: state.settings.autoCreate };
}

/** Create monitors from accepted suggestions. Never more than `max`, never outside the bounds. */
export async function applySuggestions(ids, { actor = null, at = now() } = {}) {
  const { suggestions: list } = await suggestions({ at });
  const wanted = new Set(Array.isArray(ids) ? ids.map(String) : []);
  const chosen = wanted.size ? list.filter((s) => wanted.has(s.id)) : [];
  if (!chosen.length) throw monitorError('unknown_suggestion', 'None of those suggestions are available any more.', 404);
  const created = [];
  for (const s of chosen) {
    if (state.monitors.size >= state.settings.maxMonitors) break;
    try {
      created.push(await createMonitor({ ...s, provenance: 'discovered' }, { actor, at }));
    } catch { /* a suggestion that no longer resolves is simply not created */ }
  }
  return created;
}

/** Bounded, opt-in creation from discovery. Called at boot only when the operator enabled it. */
export async function autoCreateFromSuggestions({ actor = 'opushub', at = now() } = {}) {
  const max = state.settings.autoCreate.max;
  if (!state.settings.autoCreate.enabled || max < 1) return [];
  const { suggestions: list } = await suggestions({ at });
  const room = Math.max(0, Math.min(max, state.settings.maxMonitors - state.monitors.size));
  const created = [];
  for (const s of list.slice(0, room)) {
    try { created.push(await createMonitor({ ...s, provenance: 'discovered' }, { actor, at })); } catch { /* skip */ }
  }
  return created;
}

/** Search entries for the global palette: monitors and incidents, from real records only. */
export function searchEntries({ at = now() } = {}) {
  const out = [];
  for (const m of state.monitors.values()) {
    out.push({
      title: `${m.name} monitor`,
      subtitle: `${m.type.toUpperCase()} · ${m.enabled ? m.status : 'paused'}`,
      href: `/monitoring/${m.id}`,
      kind: 'monitor',
      status: m.enabled ? m.status : 'paused',
      keywords: ['monitor', m.type, m.name, m.target?.service?.name || ''].filter(Boolean),
    });
  }
  const open = state.incidents.filter((i) => i.status !== 'resolved').slice(0, 25);
  for (const i of open) {
    out.push({
      title: `${i.monitorName} incident`,
      subtitle: `open since ${new Date(i.startedAt).toISOString().slice(11, 16)}`,
      href: `/monitoring/${i.monitorId}`,
      kind: 'incident',
      status: 'down',
      keywords: ['incident', 'outage', i.monitorName],
    });
  }
  return out.filter((e) => e.title);
}

/** Incidents across every monitor, newest first — the Incidents view. */
export function incidents({ at = now(), limit = 100, monitorId = null, open = null } = {}) {
  let list = state.incidents.slice();
  if (monitorId) list = list.filter((i) => i.monitorId === monitorId);
  if (open === true) list = list.filter((i) => i.status !== 'resolved');
  if (open === false) list = list.filter((i) => i.status === 'resolved');
  list.sort((a, b) => b.startedAt - a.startedAt);
  return {
    at,
    incidents: list.slice(0, Math.max(1, Math.min(500, limit))).map((i) => publicIncident(i, { at })),
    open: state.incidents.filter((i) => i.status !== 'resolved').length,
    total: state.incidents.length,
  };
}

/** Internal accessors for tests and for the engine-health route. */
export const _internals = {
  state,
  runCheck,
  record,
  scheduler: () => scheduler,
  types: MONITOR_TYPES,
  MonitorError,
};
