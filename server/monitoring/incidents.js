// Incidents — the persistence of an outage, as opposed to the state of a monitor.
//
// A monitor's `status` is "what is true now". An incident is "what was true between these two
// moments", which is the thing a person actually wants at 3am and the thing that has to survive a
// restart. The two are deliberately separate: restarting OpusHub must not lose the fact that
// Vaultwarden was down for three minutes, and pausing a monitor must not silently delete it.
//
// Lifecycle
//   open ──(the monitor starts answering again, below the recovery threshold)──► recovering
//   open|recovering ──(the monitor is up)──► resolved        (recoveredAt + duration recorded)
//   open|recovering ──(the monitor is paused or deleted)──► resolved  (recorded as such)
//
// Two timestamps, because they are different facts:
//   startedAt   when the first failing check of the streak was taken — "when it broke"
//   detectedAt  when the threshold was crossed and the monitor was called down — "when we knew"
//
// An incident opened while a maintenance window is open is marked `suppressed`. It is still
// recorded (history is history), it still shows on the monitor, but it is not alert noise — see
// §21 of the brief and the alert integration in engine.js.
import crypto from 'node:crypto';

export const INCIDENT_STATUSES = Object.freeze(['open', 'recovering', 'resolved']);

/** How many resolved incidents are kept. Open incidents are never dropped. */
export const MAX_INCIDENTS = 2000;

const newId = () => `inc-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** A service reference, when the monitor watches one — for grouping incidents by service. */
const serviceOf = (monitor) => {
  const ref = monitor?.target?.service;
  return ref ? { group: ref.group || null, name: ref.name } : null;
};

export function openIncident({ monitor, at = Date.now(), startedAt = null, reason = null, failureCount = 1, maintenance = false }) {
  const started = Number.isFinite(startedAt) ? startedAt : at;
  return {
    id: newId(),
    monitorId: monitor.id,
    monitorName: monitor.name,
    monitorType: monitor.type,
    service: serviceOf(monitor),
    startedAt: Math.min(started, at),
    detectedAt: at,
    recoveredAt: null,
    durationMs: null,
    status: 'open',
    reason: reason || 'the check did not succeed',
    failureCount: Math.max(1, Math.trunc(failureCount)),
    maintenance: !!maintenance,
    suppressed: !!maintenance,
    resolvedBy: null,
  };
}

const touch = (incident, patch) => ({ ...incident, ...patch });

/** Move an open incident to `recovering` — the monitor is answering, but not yet confirmed. */
export function markRecovering(incident, { at = Date.now(), reason = null } = {}) {
  if (incident.status !== 'open') return incident;
  return touch(incident, { status: 'recovering', recoveringAt: at, reason: reason || incident.reason });
}

/** Close an incident. `why` is one of recovered | paused | deleted | monitor-removed. */
export function resolveIncident(incident, { at = Date.now(), why = 'recovered', reason = null } = {}) {
  if (incident.status === 'resolved') return incident;
  const recoveredAt = Math.max(at, incident.startedAt);
  return touch(incident, {
    status: 'resolved',
    recoveredAt,
    durationMs: recoveredAt - incident.startedAt,
    resolvedBy: why,
    reason: reason || incident.reason,
  });
}

/**
 * Apply a monitor state change to its open incident (or open one). Pure: returns the list that
 * should be stored, so the caller owns persistence and the timeline is testable.
 *
 * `monitor.status` is the *state after* the transition; `previous` the state before it.
 */
export function applyState(incidents, { monitor, previous = null, at = Date.now(), maintenance = false, startedAt = null }) {
  const state = monitor.status;
  const open = incidents.find((i) => i.monitorId === monitor.id && i.status !== 'resolved') || null;
  const out = incidents.slice();
  const reason = monitor.lastCheck?.reason || null;

  if (state === 'down') {
    if (open) {
      const idx = out.indexOf(open);
      out[idx] = open.status === 'open'
        ? touch(open, { reason: reason || open.reason })
        : touch(open, { status: 'open', recoveringAt: null, reason: reason || open.reason });
      return out;
    }
    out.push(openIncident({
      monitor, at, startedAt: startedAt ?? monitor.lastCheck?.at ?? at,
      reason, failureCount: monitor.consecutiveFailures || 1, maintenance,
    }));
    return out;
  }

  if (state === 'recovering') {
    if (open) {
      const idx = out.indexOf(open);
      out[idx] = markRecovering(open, { at, reason });
    }
    return out;
  }

  if (state === 'up' || state === 'degraded') {
    // `degraded` can be the first thing that ever happens to a monitor (a 500 from the start):
    // that is an incident too, but a soft one — recorded, not alerted.
    if (open) {
      const idx = out.indexOf(open);
      out[idx] = state === 'up'
        ? resolveIncident(open, { at, why: 'recovered' })
        : touch(open, { reason: reason || open.reason });
      return out;
    }
    if (state === 'degraded') {
      out.push(openIncident({
        monitor, at, startedAt: startedAt ?? monitor.lastCheck?.at ?? at,
        reason, failureCount: monitor.consecutiveFailures || 1, maintenance,
      }));
    }
    return out;
  }

  return out; // pending / unknown / paused carry no incident decision
}

/** Close every incident belonging to a monitor (pause, delete). Returns the new list. */
export function closeFor(incidents, monitorId, { at = Date.now(), why = 'paused' } = {}) {
  return incidents.map((i) => (i.monitorId === monitorId && i.status !== 'resolved' ? resolveIncident(i, { at, why }) : i));
}

/**
 * Bounded retention: resolved incidents are kept newest-first up to `max`; anything still open is
 * always kept (an outage that is still happening is not history yet).
 */
export function trimIncidents(incidents, max = MAX_INCIDENTS) {
  if (incidents.length <= max) return incidents;
  const open = incidents.filter((i) => i.status !== 'resolved');
  const resolved = incidents.filter((i) => i.status === 'resolved')
    .sort((a, b) => (b.recoveredAt || b.detectedAt) - (a.recoveredAt || a.detectedAt));
  const kept = resolved.slice(0, Math.max(0, max - open.length));
  const keepIds = new Set([...open, ...kept].map((i) => i.id));
  return incidents.filter((i) => keepIds.has(i.id));
}

/** Public projection. `now` is the server clock, so a live duration is never a browser's guess. */
export function publicIncident(incident, { now = Date.now() } = {}) {
  if (!incident) return null;
  return {
    id: incident.id,
    monitorId: incident.monitorId,
    monitorName: incident.monitorName,
    monitorType: incident.monitorType,
    // the type again, spelled the way the monitor spells it: a client rendering a list of
    // incidents should not have to join against monitors.json to say "HTTP"
    type: incident.monitorType,
    service: incident.service || null,
    startedAt: incident.startedAt,
    detectedAt: incident.detectedAt,
    recoveredAt: incident.recoveredAt,
    durationMs: incident.status === 'resolved' ? incident.durationMs : Math.max(0, now - incident.startedAt),
    open: incident.status !== 'resolved',
    status: incident.status,
    reason: incident.reason,
    failureCount: incident.failureCount,
    maintenance: !!incident.maintenance,
    suppressed: !!incident.suppressed,
    resolvedBy: incident.resolvedBy,
  };
}
