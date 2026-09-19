// Infrastructure state transitions — the events worth writing down.
//
// OpusHub watches things that change slowly. Recording "pool tank is ONLINE" once a minute is
// noise; recording "pool tank went from ONLINE to DEGRADED" is the whole point of an activity
// log. So this module keeps the previous observation of each fact and only emits an event on a
// real transition, using the activity log's own signature dedupe as a second line of defence
// against a flapping provider filling the log.
//
// Every event here comes from something a provider actually measured. Nothing is inferred, and
// there is no remediation hook: an event is recorded, never acted upon.
import { logEvent } from '../activity.js';
import { THRESHOLDS } from './model.js';

// Phase 10B — best-effort publish onto the canonical event bus (the failure-isolated
// wrapper lives with the bus; every producer used to carry an identical local copy).
import { publishEventSafe } from '../events/index.js';

const lastPoolHealth = new Map();   // pool name → health word
const lastIfaceState = new Map();   // interface name → operstate
const lastThreshold = new Map();    // subject → 'warning' | 'critical' | null
const lastDatasetQuota = new Map(); // dataset → threshold level

/** Test helper. */
export function _resetInfrastructureState() {
  lastPoolHealth.clear();
  lastIfaceState.clear();
  lastThreshold.clear();
  lastDatasetQuota.clear();
}

/** Which side of a threshold a percentage sits on, or null when it is comfortably below. */
export function thresholdLevel(pct, thresholds = THRESHOLDS) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  if (pct >= thresholds.critical) return 'critical';
  if (pct >= thresholds.warning) return 'warning';
  return null;
}

/**
 * ZFS pool health changes. A pool that was never seen before is recorded as an observation, not
 * as a change — the first time we look is not an event.
 */
export function notePoolHealth(pools = []) {
  for (const pool of pools) {
    if (!pool?.name || !pool.health) continue;
    const prev = lastPoolHealth.get(pool.name);
    lastPoolHealth.set(pool.name, pool.health);
    if (prev == null || prev === pool.health) continue;
    const ok = pool.health === 'ONLINE';
    logEvent({
      source: 'system',
      type: 'zfs.pool.health',
      subject: pool.name,
      message: `ZFS pool ${pool.name} is ${pool.health} (was ${prev})`,
      meta: { pool: pool.name, from: prev, to: pool.health },
      severity: ok ? 'notice' : 'warning',
      category: 'storage',
      signature: `zfs.pool.health:${pool.name}:${prev}>${pool.health}`,
      dedupeWindowMs: 10 * 60_000,
    });
    publishEventSafe({
      type: 'infrastructure.storage.health_changed',
      severity: ok ? 'notice' : 'warning',
      source: 'infrastructure',
      subject: { kind: 'storage', id: pool.name, label: `ZFS pool ${pool.name}`, href: '/infrastructure?tab=storage' },
      message: `ZFS pool ${pool.name} is ${pool.health} (was ${prev})`,
      payload: { pool: pool.name, from: prev, to: pool.health },
      correlation: { provider: 'zfs' },
    });
  }
}

/** Filesystem usage crossing 90% / 95%. */
export function noteFilesystemThresholds(mounts = []) {
  for (const m of mounts) {
    if (!m?.mount) continue;
    const level = thresholdLevel(m.usedPct);
    const prev = lastThreshold.get(`fs:${m.mount}`) || null;
    lastThreshold.set(`fs:${m.mount}`, level);
    if (level === prev) continue;
    if (level == null) {
      if (prev == null) continue;
      logEvent({
        source: 'system', type: 'storage.threshold', subject: m.mount,
        message: `${m.mount} is back below the ${THRESHOLDS.warning}% usage threshold`,
        meta: { mount: m.mount, from: prev, to: null, usedPct: m.usedPct },
        severity: 'notice', category: 'storage',
        signature: `storage.threshold:${m.mount}:${prev}>none`,
        dedupeWindowMs: 30 * 60_000,
      });
      publishEventSafe({
        type: 'infrastructure.health_changed',
        severity: 'notice',
        source: 'infrastructure',
        subject: { kind: 'storage', id: m.mount, label: m.mount, href: '/infrastructure?tab=storage' },
        message: `${m.mount} is back below the ${THRESHOLDS.warning}% usage threshold`,
        payload: { mount: m.mount, from: prev, to: null, usedPct: m.usedPct },
      });
      continue;
    }
    logEvent({
      source: 'system', type: 'storage.threshold', subject: m.mount,
      message: `${m.mount} is ${Math.round(m.usedPct)}% used`,
      meta: { mount: m.mount, from: prev, to: level, usedPct: m.usedPct },
      severity: level === 'critical' ? 'warning' : 'info',
      category: 'storage',
      signature: `storage.threshold:${m.mount}:${prev}>${level}`,
      dedupeWindowMs: 30 * 60_000,
    });
    publishEventSafe({
      type: 'infrastructure.health_changed',
      severity: level === 'critical' ? 'warning' : 'info',
      source: 'infrastructure',
      subject: { kind: 'storage', id: m.mount, label: m.mount, href: '/infrastructure?tab=storage' },
      message: `${m.mount} is ${Math.round(m.usedPct)}% used`,
      payload: { mount: m.mount, from: prev, to: level, usedPct: m.usedPct },
    });
  }
}

/** Dataset quota thresholds — only when a quota is actually set. */
export function noteDatasetQuotas(datasets = []) {
  for (const d of datasets) {
    if (!d?.name || d.quotaUsedPct == null) continue;
    const level = thresholdLevel(d.quotaUsedPct);
    const prev = lastDatasetQuota.get(d.name) || null;
    lastDatasetQuota.set(d.name, level);
    if (level === prev || level == null) continue;
    logEvent({
      source: 'system', type: 'storage.quota', subject: d.name,
      message: `Dataset ${d.name} has used ${Math.round(d.quotaUsedPct)}% of its quota`,
      meta: { dataset: d.name, from: prev, to: level, usedPct: d.quotaUsedPct },
      severity: level === 'critical' ? 'warning' : 'info',
      category: 'storage',
      signature: `storage.quota:${d.name}:${level}`,
      dedupeWindowMs: 60 * 60_000,
    });
  }
}

/**
 * Interface state changes.
 *
 * Only interfaces that have already been observed are eligible: at startup everything looks like
 * a change, and "twelve interfaces appeared" is not an event. An interface going down is worth a
 * warning only when it carries an address — an unused port with no configuration is not a fault.
 */
export function noteInterfaceStates(interfaces = []) {
  for (const i of interfaces) {
    if (!i?.name) continue;
    const prev = lastIfaceState.get(i.name);
    lastIfaceState.set(i.name, i.state);
    if (prev == null || prev === i.state) continue;
    const inUse = (i.addresses || []).length > 0;
    const down = i.state !== 'up';
    logEvent({
      source: 'system',
      type: 'network.interface',
      subject: i.name,
      message: `Interface ${i.name} is ${i.state} (was ${prev})`,
      meta: { interface: i.name, from: prev, to: i.state, hasAddress: inUse },
      severity: down && inUse ? 'warning' : 'info',
      category: 'network',
      signature: `network.interface:${i.name}:${prev}>${i.state}`,
      dedupeWindowMs: 10 * 60_000,
    });
    publishEventSafe({
      type: 'infrastructure.network.changed',
      severity: down && inUse ? 'warning' : 'info',
      source: 'infrastructure',
      subject: { kind: 'network', id: i.name, label: `Interface ${i.name}`, href: '/infrastructure?tab=network' },
      message: `Interface ${i.name} is ${i.state} (was ${prev})`,
      payload: { interface: i.name, from: prev, to: i.state, hasAddress: inUse },
    });
  }
}

/** Called once per refresh of the storage + network domains. Never throws. */
export function noteInfrastructureState({ pools = [], datasets = [], mounts = [], interfaces = [] } = {}) {
  try {
    notePoolHealth(pools);
    noteFilesystemThresholds(mounts);
    noteDatasetQuotas(datasets);
    noteInterfaceStates(interfaces);
  } catch { /* the activity log must never break a provider refresh */ }
}
