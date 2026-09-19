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
import { THRESHOLDS } from './infrastructure/model.js';

// Phase 10B — event bus publish (lazy)
let _publishEvent = null;
async function getPublish() {
  if (_publishEvent) return _publishEvent;
  try {
    const mod = await import('./events/index.js');
    _publishEvent = mod.publishEvent;
    return _publishEvent;
  } catch { return null; }
}
function publishEventSafe(desc) {
  getPublish().then((fn) => { if (fn) try { fn(desc); } catch {} }).catch(() => {});
}

export const MAX_ALERTS = 50;
export const MIN_INTERVAL_MS = 30_000;

/** signature → active alert record */
const active = new Map();
let lastRunAt = 0;
let lastInputsHash = '';

const SEV_RANK = { info: 0, notice: 1, warning: 2, critical: 3 };

/**
 * One alert. `area` is which part of the OpusGrid it belongs to (storage, network, power,
 * docker, provider, system, security, service, stack) — the health aggregator groups by it, and
 * the Activity page can filter by it. It is optional so older call sites stay valid.
 */
function alert({ signature, severity, title, detail, evidence = null, links = [], area = null }) {
  return { id: signature, signature, severity, title, detail, evidence, links, area, firedAt: Date.now(), acknowledged: false, ackAt: null };
}

/**
 * Pure evaluation. Inputs are plain snapshots the caller already has:
 *   { dockerAvailable, services: [...], stacks: [...], system, authFailures }
 * services: [{ group, name, displayName, health, state }] — the discovered inventory.
 * stacks: [{ project, services: [...], running, stopped }] — compose rollups.
 * system: collectSystem() snapshot or null. authFailures: number observed in the window.
 */
export function evaluateAlerts({
  dockerAvailable = true, services = [], stacks = [], system = null, authFailures = 0,
  // Phase 10A: the monitoring engine reports its own verdicts (state, reason, since). This function
  // does not run checks, does not know what a monitor *is*, and never reads a monitor's history —
  // it turns "this monitor says it is down" into the same kind of condition everything else here is.
  // Monitors that are paused or inside a maintenance window are filtered out by the caller.
  monitors = [],
  // Phase 9: infrastructure domains. All three are plain snapshots — this function stays pure and
  // never fetches anything, so the conditions below can only ever fire on real provider evidence.
  storage = null, network = null, providers = [],
} = {}) {
  const out = [];
  if (!dockerAvailable) {
    out.push(alert({
      signature: 'docker.unavailable', severity: 'critical',
      title: 'Docker is not connected',
      detail: 'The engine socket is unreachable, so every inventory page is showing its last-known state. Nothing below can update until the connection is fixed.',
      area: 'docker',
      links: [{ label: 'Check the connection', href: '/settings/environment' }],
    }));
  }
  const unhealthy = services.filter((s) => s.health === 'unhealthy');
  for (const s of unhealthy.slice(0, 10)) {
    out.push(alert({
      signature: `service.unhealthy:${s.group}/${s.name}`, severity: 'warning',
      title: `${s.displayName || s.name} is unhealthy`,
      detail: 'Its container healthcheck is failing. The service page shows the container state and recent history.',
      area: 'service',
      evidence: { state: s.state || null, health: s.health },
      links: [{ label: 'Open the service', href: `/services/${encodeURIComponent(s.group)}/${encodeURIComponent(s.name)}` }],
    }));
  }
  if (unhealthy.length > 10) {
    out.push(alert({
      signature: 'service.unhealthy:overflow', severity: 'warning', area: 'service',
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
        area: 'stack',
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
        area: 'system',
        evidence: { pct: Math.round(memPct * 10) / 10 },
        links: [{ label: 'Open Infrastructure', href: '/infrastructure' }],
      }));
    } else if (memPct >= 90) {
      out.push(alert({
        signature: 'host.memory.warning', severity: 'warning',
        title: `Memory is ${Math.round(memPct)}% used`,
        detail: 'Above 90%. Worth watching before it becomes critical.',
        area: 'system',
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
        area: 'system',
        evidence: { pct: Math.round(diskPct * 10) / 10, mount: system.disk.mount || null },
        links: [{ label: 'Open Infrastructure', href: '/infrastructure' }],
      }));
    } else if (diskPct >= 90) {
      out.push(alert({
        signature: 'host.disk.warning', severity: 'warning',
        title: `Disk is ${Math.round(diskPct)}% used`,
        detail: 'Above 90%. Docker images and logs are the usual occupants.',
        area: 'system',
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
      area: 'security',
      evidence: { failures: authFailures, windowMs: 15 * 60_000 },
      links: [{ label: 'Open Activity', href: '/activity' }],
    }));
  }
  /* ---- Phase 10A: monitors -------------------------------------------- */
  // One condition per monitor that says it is down or degraded. The incident is the monitoring
  // engine's record of the outage; this is the alert *condition* over it, which is what the Alerts
  // surface groups, sorts and acknowledges. Same signature → same dedupe → one event per transition.
  for (const m of (monitors || []).slice(0, 40)) {
    if (!m || (m.status !== 'down' && m.status !== 'degraded')) continue;
    const down = m.status === 'down';
    const since = Number.isFinite(Number(m.since)) ? Number(m.since) : null;
    out.push(alert({
      signature: `monitor.${m.status}:${m.id}`,
      severity: down ? 'critical' : 'warning',
      area: 'monitoring',
      title: `${m.name} is ${down ? 'down' : 'degraded'}`,
      detail: m.reason || (down ? 'The monitor is not getting the answer it expects.' : 'The monitor is getting an answer it did not expect.'),
      evidence: { monitorId: m.id, type: m.type, status: m.status, since, latencyMs: m.latencyMs ?? null },
      links: [{ label: 'Open the monitor', href: `/monitoring/${encodeURIComponent(m.id)}` }],
    }));
  }
  if ((monitors || []).filter((m) => m?.status === 'down' || m?.status === 'degraded').length > 40) {
    out.push(alert({
      signature: 'monitor.overflow', severity: 'warning', area: 'monitoring',
      title: `${(monitors || []).filter((m) => m?.status === 'down' || m?.status === 'degraded').length - 40} more monitors are not well`,
      detail: 'The list is capped so one bad network cannot flood this page — the Monitoring page shows all of them.',
      links: [{ label: 'Open Monitoring', href: '/monitoring' }],
    }));
  }

  /* ---- Phase 9: storage ------------------------------------------------ */
  // Only measurements are alerted on. A provider that cannot measure (no ZFS tools, no quota set)
  // produces no alert at all, because an alert for something that was never measured is noise
  // dressed up as information.
  const pools = Array.isArray(storage?.zfs?.pools) ? storage.zfs.pools : [];
  const badPools = pools.filter((p) => p?.health && p.health !== 'ONLINE');
  for (const p of badPools.slice(0, 8)) {
    const critical = ['FAULTED', 'UNAVAIL', 'REMOVED', 'OFFLINE', 'SUSPENDED'].includes(p.health);
    out.push(alert({
      signature: `zfs.pool.${String(p.health).toLowerCase()}:${p.name}`,
      severity: critical ? 'critical' : 'warning',
      area: 'storage',
      title: `ZFS pool ${p.name} is ${p.health}`,
      detail: critical
        ? 'The pool is not serving data. ZFS will keep the pool imported but reads and writes are affected — check the disks before anything else.'
        : 'The pool is still serving data with reduced redundancy. Another failure could take it offline.',
      evidence: { pool: p.name, health: p.health, capacityPct: p.capacityPct ?? null },
      links: [{ label: 'Open the pool', href: `/infrastructure?tab=storage&pool=${encodeURIComponent(p.name)}` }],
    }));
  }
  if (badPools.length > 8) {
    out.push(alert({
      signature: 'zfs.pool:overflow', severity: 'warning', area: 'storage',
      title: `${badPools.length - 8} more ZFS pools need attention`,
      detail: 'The list is capped so one bad shelf cannot flood this page — Storage → ZFS pools shows all of them.',
      links: [{ label: 'Open Storage', href: '/infrastructure?tab=storage' }],
    }));
  }
  for (const m of (storage?.filesystems?.mounts || [])) {
    if (typeof m?.usedPct !== 'number' || m.usedPct < THRESHOLDS.warning) continue;
    const critical = m.usedPct >= THRESHOLDS.critical;
    out.push(alert({
      signature: `storage.filesystem.${critical ? 'critical' : 'warning'}:${m.mount}`,
      severity: critical ? 'critical' : 'warning',
      area: 'storage',
      title: `${m.mount} is ${Math.round(m.usedPct)}% full`,
      detail: `Above ${critical ? THRESHOLDS.critical : THRESHOLDS.warning}%. Containers, images and logs all write here.`,
      evidence: { mount: m.mount, usedPct: Math.round(m.usedPct), free: m.free ?? null },
      links: [{ label: 'Open Storage', href: '/infrastructure?tab=storage' }],
    }));
  }
  const overQuota = (storage?.zfs?.datasets || []).filter((d) => typeof d?.quotaUsedPct === 'number' && d.quotaUsedPct >= THRESHOLDS.warning);
  for (const d of overQuota.slice(0, 5)) {
    const critical = d.quotaUsedPct >= THRESHOLDS.critical;
    out.push(alert({
      signature: `storage.quota.${critical ? 'critical' : 'warning'}:${d.name}`,
      severity: critical ? 'critical' : 'warning',
      area: 'storage',
      title: `Dataset ${d.name} is at ${Math.round(d.quotaUsedPct)}% of its quota`,
      detail: 'A quota is a hard limit: writes fail once the dataset reaches it.',
      evidence: { dataset: d.name, usedPct: Math.round(d.quotaUsedPct), quota: d.quota ?? null },
      links: [{ label: 'Open the dataset', href: `/infrastructure?tab=storage&dataset=${encodeURIComponent(d.name)}` }],
    }));
  }

  /* ---- Phase 9: network ------------------------------------------------ */
  // An interface with no address and no carrier is a spare port, not a fault. Only interfaces that
  // carry an address and are not up are alerted on — that is what the kernel reported, twice.
  const down = (network?.interfaces || []).filter((i) => i?.state && i.state !== 'up' && (i.addresses || []).length > 0);
  for (const i of down.slice(0, 5)) {
    out.push(alert({
      signature: `network.interface.down:${i.name}`,
      severity: 'warning',
      area: 'network',
      title: `Interface ${i.name} is ${i.state}`,
      detail: 'It has an address configured but the link is not up, so anything reaching the host through it is unreachable.',
      evidence: { interface: i.name, state: i.state, addresses: (i.addresses || []).map((a) => a.address).slice(0, 2) },
      links: [{ label: 'Open Network', href: '/infrastructure?tab=network' }],
    }));
  }

  /* ---- Phase 9: providers ---------------------------------------------- */
  // A provider that is simply not configured is NOT an alert: an install without OPNsense is a
  // choice, not a fault. Only a provider that was configured and then stopped answering is one.
  for (const p of providers) {
    if (p.status !== 'unavailable' && p.status !== 'degraded') continue;
    if (p.status === 'unavailable' && p.optional) continue; // optional + absent is configuration, not failure
    out.push(alert({
      signature: `provider.${p.status}:${p.id}`,
      severity: p.status === 'unavailable' ? 'warning' : 'warning',
      area: p.domain === 'compute' ? 'docker' : p.domain === 'storage' ? 'storage'
        : p.domain === 'network' ? 'network' : p.domain === 'power' ? 'power' : 'provider',
      title: `${p.name} is ${p.status === 'unavailable' ? 'unavailable' : 'degraded'}`,
      detail: p.error?.reason || 'OpusHub cannot read this provider right now.',
      evidence: { provider: p.id, status: p.status },
      links: [{ label: 'Open Connections', href: '/settings/connections' }],
    }));
  }

  out.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.signature.localeCompare(b.signature));
  return out.slice(0, MAX_ALERTS);
}

function hashInputs({ dockerAvailable, services, stacks, system, authFailures, storage, network, providers, monitors }) {
  const svc = (services || []).map((s) => `${s.group}/${s.name}:${s.health}:${s.state}`).sort().join(',');
  const st = (stacks || []).map((x) => `${x.project}:${x.running}/${Array.isArray(x.services) ? x.services.length : 0}`).sort().join(',');
  const mem = Math.round(system?.memory?.pct ?? -1);
  const disk = Math.round(system?.disk?.pct ?? -1);
  // Phase 9: the infrastructure inputs, hashed the same way — a stable string over the facts that
  // can actually change an alert, so a poll that changes nothing is not a re-evaluation.
  const zfsPools = (storage?.zfs?.pools || []).map((p) => `${p.name}:${p.health}`).sort().join(',');
  const mounts = (storage?.filesystems?.mounts || []).map((m) => `${m.mount}:${Math.round(m.usedPct ?? -1)}`).sort().join(',');
  const quotas = (storage?.zfs?.datasets || []).filter((d) => d?.quotaUsedPct != null).map((d) => `${d.name}:${Math.round(d.quotaUsedPct)}`).sort().join(',');
  const ifaces = (network?.interfaces || []).map((i) => `${i.name}:${i.state}:${(i.addresses || []).length}`).sort().join(',');
  const provs = (providers || []).map((p) => `${p.id}:${p.status}`).sort().join(',');
  // Phase 10A: monitor verdicts participate in the hash, so a monitor going down re-evaluates the
  // alert set immediately instead of waiting out MIN_INTERVAL_MS.
  const mons = (monitors || []).map((m) => `${m.id}:${m.status}`).sort().join(',');
  return `${dockerAvailable}|${svc}|${st}|${mem}|${disk}|${authFailures}|${zfsPools}|${mounts}|${quotas}|${ifaces}|${provs}|${mons}`;
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
      publishEventSafe({
        type: 'alert.created',
        severity: a.severity === 'critical' ? 'critical' : 'warning',
        source: 'alert',
        subject: { kind: 'alert', id: a.signature, label: a.title, href: a.links?.[0]?.href || '/' },
        message: a.detail,
        payload: { signature: a.signature, evidence: a.evidence, area: a.area || null },
        correlation: { alertId: a.signature },
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
    publishEventSafe({
      type: 'alert.resolved',
      severity: 'notice',
      source: 'alert',
      subject: { kind: 'alert', id: sig, label: prev.title, href: '/' },
      message: `${prev.title} — resolved.`,
      payload: { signature: sig },
      correlation: { alertId: sig },
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
  publishEventSafe({
    type: 'alert.acknowledged',
    severity: 'info',
    source: 'alert',
    subject: { kind: 'alert', id: a.signature, label: a.title, href: '/' },
    message: `${a.title} acknowledged`,
    payload: { signature: a.signature },
    correlation: { alertId: a.signature },
  });
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
