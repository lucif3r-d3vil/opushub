// Alerts — small, honest conditions over data OpusHub already holds. Every alert has a
// stable signature (dedupe key), a severity, a human title/detail, and the evidence behind
// it. refreshAlerts() diffs the new evaluation against the active set and logs
// alert.fired / alert.resolved transitions to the activity log exactly once per transition,
// so the log — not an in-memory flag — is the record. Acks are in-memory conveniences for
// the current process; a restart forgets them, which is stated wherever they are shown.
//
// Bounds: MAX_ALERTS active alerts (worst-first), evaluation is pure over its inputs and
// runs at most once per MIN_INTERVAL_MS no matter how often it is asked.
import { logEvent, readEvents } from './activity.js';
import { dispatch } from './notify.js';

export const MAX_ALERTS = 50;
export const MIN_INTERVAL_MS = 30_000;

/** signature → active alert record */
const active = new Map();
let lastRunAt = 0;
let lastInputsHash = '';

const SEV_RANK = { info: 0, notice: 1, warning: 2, critical: 3 };

function alert({ signature, severity, title, detail, evidence = null, links = [] }) {
  return { id: signature, signature, severity, title, detail, evidence, links, firedAt: Date.now(), acknowledged: false, ackAt: null };
}

/**
 * Pure evaluation. Inputs are plain snapshots the caller already has:
 *   { dockerAvailable, services: [...], stacks: [...], system, authFailures }
 * services: [{ group, name, displayName, health, state }] — the discovered inventory.
 * stacks: [{ project, services: [...], running, stopped }] — compose rollups.
 * system: collectSystem() snapshot or null. authFailures: number observed in the window.
 */
export function evaluateAlerts({ dockerAvailable = true, services = [], stacks = [], system = null, authFailures = 0 } = {}) {
  const out = [];
  if (!dockerAvailable) {
    out.push(alert({
      signature: 'docker.unavailable', severity: 'critical',
      title: 'Docker is not connected',
      detail: 'The engine socket is unreachable, so every inventory page is showing its last-known state. Nothing below can update until the connection is fixed.',
      links: [{ label: 'Check the connection', href: '/settings/environment' }],
    }));
  }
  const unhealthy = services.filter((s) => s.health === 'unhealthy');
  for (const s of unhealthy.slice(0, 10)) {
    out.push(alert({
      signature: `service.unhealthy:${s.group}/${s.name}`, severity: 'warning',
      title: `${s.displayName || s.name} is unhealthy`,
      detail: 'Its container healthcheck is failing. The service page shows the container state and recent history.',
      evidence: { state: s.state || null, health: s.health },
      links: [{ label: 'Open the service', href: `/services/${encodeURIComponent(s.group)}/${encodeURIComponent(s.name)}` }],
    }));
  }
  if (unhealthy.length > 10) {
    out.push(alert({
      signature: 'service.unhealthy:overflow', severity: 'warning',
      title: `${unhealthy.length - 10} more unhealthy services`,
      detail: 'The list is capped so one bad deployment cannot flood this page — the Services page shows all of them.',
      links: [{ label: 'Open Services', href: '/services' }],
    }));
  }
  for (const st of (stacks || []).slice(0, 20)) {
    const members = Array.isArray(st.services) ? st.services.length : 0;
    const running = Number(st.running || 0);
    if (members > 1 && running > 0 && running < members) {
      out.push(alert({
        signature: `stack.degraded:${st.project}`, severity: 'warning',
        title: `Stack ${st.project} is degraded`,
        detail: `${running} of ${members} members are running. The rest stopped or never started.`,
        evidence: { running, members },
        links: [{ label: 'Open the stack', href: `/stacks/${encodeURIComponent(st.project)}` }],
      }));
    }
  }
  const memPct = system?.memory?.pct;
  if (typeof memPct === 'number') {
    if (memPct >= 95) {
      out.push(alert({
        signature: 'host.memory.critical', severity: 'critical',
        title: `Memory is ${Math.round(memPct)}% used`,
        detail: 'Above 95% the kernel starts killing processes. Close workloads or add memory.',
        evidence: { pct: Math.round(memPct * 10) / 10 },
        links: [{ label: 'Open Infrastructure', href: '/infrastructure' }],
      }));
    } else if (memPct >= 90) {
      out.push(alert({
        signature: 'host.memory.warning', severity: 'warning',
        title: `Memory is ${Math.round(memPct)}% used`,
        detail: 'Above 90%. Worth watching before it becomes critical.',
        evidence: { pct: Math.round(memPct * 10) / 10 },
        links: [{ label: 'Open Infrastructure', href: '/infrastructure' }],
      }));
    }
  }
  const diskPct = system?.disk?.pct;
  if (typeof diskPct === 'number') {
    if (diskPct >= 95) {
      out.push(alert({
        signature: 'host.disk.critical', severity: 'critical',
        title: `Disk is ${Math.round(diskPct)}% used`,
        detail: 'Above 95% containers and logs can fail to write. Free space or expand the volume.',
        evidence: { pct: Math.round(diskPct * 10) / 10, mount: system.disk.mount || null },
        links: [{ label: 'Open Infrastructure', href: '/infrastructure' }],
      }));
    } else if (diskPct >= 90) {
      out.push(alert({
        signature: 'host.disk.warning', severity: 'warning',
        title: `Disk is ${Math.round(diskPct)}% used`,
        detail: 'Above 90%. Docker images and logs are the usual occupants.',
        evidence: { pct: Math.round(diskPct * 10) / 10, mount: system.disk.mount || null },
        links: [{ label: 'Open Infrastructure', href: '/infrastructure' }],
      }));
    }
  }
  if (Number(authFailures) >= 5) {
    out.push(alert({
      signature: 'auth.failures', severity: 'warning',
      title: `${authFailures} failed logins in the last 15 minutes`,
      detail: 'Either a forgotten password or somebody guessing. The Activity page lists each attempt.',
      evidence: { failures: authFailures, windowMs: 15 * 60_000 },
      links: [{ label: 'Open Activity', href: '/activity' }],
    }));
  }
  out.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.signature.localeCompare(b.signature));
  return out.slice(0, MAX_ALERTS);
}

function hashInputs({ dockerAvailable, services, stacks, system, authFailures }) {
  const svc = (services || []).map((s) => `${s.group}/${s.name}:${s.health}:${s.state}`).sort().join(',');
  const st = (stacks || []).map((x) => `${x.project}:${x.running}/${Array.isArray(x.services) ? x.services.length : 0}`).sort().join(',');
  const mem = Math.round(system?.memory?.pct ?? -1);
  const disk = Math.round(system?.disk?.pct ?? -1);
  return `${dockerAvailable}|${svc}|${st}|${mem}|${disk}|${authFailures}`;
}

/**
 * Evaluate and reconcile with the active set. Returns the active alerts.
 * Firing alerts are dispatched to notification channels (best-effort) and logged;
 * resolved ones are logged once and forgotten (along with their ack).
 */
export function refreshAlerts(inputs = {}) {
  const now = Date.now();
  const hash = hashInputs(inputs);
  if (now - lastRunAt < MIN_INTERVAL_MS && hash === lastInputsHash) return [...active.values()];
  lastRunAt = now;
  lastInputsHash = hash;

  const evaluated = evaluateAlerts(inputs);
  const seen = new Set();
  for (const a of evaluated) {
    seen.add(a.signature);
    const prev = active.get(a.signature);
    if (prev) {
      // Ongoing: keep the original firedAt and any ack; refresh the facts.
      prev.title = a.title; prev.detail = a.detail; prev.evidence = a.evidence;
      prev.severity = a.severity; prev.links = a.links;
    } else {
      active.set(a.signature, a);
      // No dedupe signature: the active-set diff above already guarantees one log per
      // transition, and a re-fire after a resolve is a new fact that must be told.
      logEvent({
        source: 'system', type: 'alert.fired', subject: a.title, message: a.detail,
        meta: { signature: a.signature, severity: a.severity, evidence: a.evidence },
        severity: a.severity === 'critical' ? 'critical' : 'warning', category: 'system',
      });
      try { dispatch(a); } catch { /* channels must never break alerting */ }
    }
  }
  for (const [sig, prev] of active) {
    if (seen.has(sig)) continue;
    active.delete(sig);
    logEvent({
      source: 'system', type: 'alert.resolved', subject: prev.title,
      message: `${prev.title} — resolved.`,
      meta: { signature: sig, severity: prev.severity },
      severity: 'notice', category: 'system',
    });
  }
  return [...active.values()];
}

export function getActiveAlerts() { return [...active.values()]; }

export function ackAlert(signature) {
  const a = active.get(String(signature));
  if (!a) return null;
  a.acknowledged = true;
  a.ackAt = Date.now();
  return a;
}

/** Count failed logins in the trailing window, for the auth-burst condition. */
export function countRecentAuthFailures(windowMs = 15 * 60_000) {
  try {
    const { items } = readEvents({ limit: 500, type: 'auth', since: Date.now() - windowMs });
    return items.filter((e) => e.type === 'auth.login_failed').length;
  } catch {
    return 0;
  }
}

/** Test helper. */
export function _resetAlerts() { active.clear(); lastRunAt = 0; lastInputsHash = ''; }
