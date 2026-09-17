// Phase 9G — health aggregation, alert conditions and activity transitions.
//
// The headline rule: an optional provider that is not configured must never make OpusGrid
// unhealthy. "OPNsense: Not configured" is a fact about an install, not a problem with it, so the
// aggregator excludes it from the verdict instead of ranking it as a bad state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9health-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9health-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const { aggregateHealth, domainHealth } = await import('./infrastructure/health.js');
const { evaluateAlerts } = await import('./alerts.js');
const state = await import('./infrastructure/state.js');
const { readEvents } = await import('./activity.js');
const { THRESHOLDS } = await import('./infrastructure/model.js');

test.after(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const provider = (id, domain, status, { optional = false, reason = null } = {}) => ({
  id, name: id, domain, optional, status,
  error: reason ? { code: 'unreachable', reason } : null,
});

/* ------------------------------------------------------------------ */
/* aggregation                                                         */
/* ------------------------------------------------------------------ */

test('an install with only what it needs is healthy, not "missing things"', () => {
  const health = aggregateHealth({
    providers: [
      provider('docker', 'compute', 'connected'),
      provider('filesystem', 'storage', 'available'),
      provider('network', 'network', 'available'),
      provider('opnsense', 'external', 'not-configured', { optional: true }),
      provider('ups', 'power', 'not-configured', { optional: true }),
      provider('pdu', 'power', 'not-configured', { optional: true }),
    ],
  });
  assert.equal(health.status, 'healthy');
  assert.equal(health.domains.external.status, 'not-configured');
  assert.equal(health.domains.power.status, 'not-configured');
  assert.equal(health.counts.notConfigured, 2);
  assert.match(health.note, /not configured/i);
});

test('an optional provider that is *configured and broken* does count — absence is not the same as failure', () => {
  const health = aggregateHealth({
    providers: [
      provider('docker', 'compute', 'connected'),
      provider('filesystem', 'storage', 'available'),
      provider('network', 'network', 'available'),
      provider('opnsense', 'external', 'unavailable', { optional: true, reason: 'The firewall did not answer.' }),
      provider('ups', 'power', 'not-configured', { optional: true }),
      provider('pdu', 'power', 'not-configured', { optional: true }),
    ],
  });
  assert.equal(health.status, 'degraded', 'a configured provider that stopped answering is a problem');
  assert.equal(health.domains.external.status, 'degraded');
  assert.match(health.domains.external.reasons[0], /did not answer/);
});

test('a required provider being unavailable makes its domain unavailable, and OpusGrid with it', () => {
  const health = aggregateHealth({
    providers: [
      provider('docker', 'compute', 'unavailable', { reason: 'The Docker engine is not responding.' }),
      provider('filesystem', 'storage', 'available'),
      provider('network', 'network', 'available'),
    ],
  });
  assert.equal(health.status, 'unavailable');
  assert.equal(health.domains.compute.status, 'unavailable');
  assert.equal(health.domains.storage.status, 'healthy');
});

test('unknown and not-checked providers are never called healthy', () => {
  assert.equal(domainHealth([]).status, 'unknown');
  const health = aggregateHealth({ providers: [provider('docker', 'compute', 'unknown')] });
  assert.equal(health.domains.compute.status, 'degraded', 'never checked is not the same as fine');
  assert.match(health.domains.compute.reasons[0], /not been checked/);
});

test('an open alert degrades its domain without pretending the provider failed', () => {
  const providers = [
    provider('docker', 'compute', 'connected'),
    provider('filesystem', 'storage', 'available'),
    provider('zfs', 'storage', 'available', { optional: true }),
  ];
  const before = aggregateHealth({ providers });
  assert.equal(before.domains.storage.status, 'healthy');
  const after = aggregateHealth({
    providers,
    alerts: [{ area: 'storage', title: 'ZFS pool backup is DEGRADED', severity: 'warning' }],
  });
  assert.equal(after.domains.storage.status, 'degraded');
  assert.equal(after.domains.compute.status, 'healthy', 'an alert does not leak into other domains');
});

/* ------------------------------------------------------------------ */
/* alerts                                                             */
/* ------------------------------------------------------------------ */

const baseInputs = { dockerAvailable: true, services: [], stacks: [], system: null, authFailures: 0 };

test('ZFS pool conditions come from ZFS health, and only from ZFS health', () => {
  const storage = {
    zfs: {
      pools: [
        { name: 'tank', health: 'ONLINE', capacityPct: 40 },
        { name: 'backup', health: 'DEGRADED', capacityPct: 60 },
        { name: 'cold', health: 'FAULTED', capacityPct: 70 },
        { name: 'unknown-pool', health: null, capacityPct: 80 },
      ],
      datasets: [],
    },
    filesystems: { mounts: [] },
  };
  const alerts = evaluateAlerts({ ...baseInputs, storage });
  const poolAlerts = alerts.filter((a) => a.signature.startsWith('zfs.pool.'));
  assert.equal(poolAlerts.length, 2, 'a healthy pool and an unmeasured pool produce no alert');
  const byPool = Object.fromEntries(poolAlerts.map((a) => [a.evidence.pool, a]));
  assert.equal(byPool.backup.severity, 'warning');
  assert.equal(byPool.cold.severity, 'critical');
  assert.equal(byPool.cold.area, 'storage');
  assert.match(byPool.cold.links[0].href, /pool=cold/);
});

test('filesystem thresholds use the same numbers the UI shows', () => {
  const storage = { zfs: { pools: [], datasets: [] }, filesystems: { mounts: [{ mount: '/', usedPct: 40 }, { mount: '/srv', usedPct: 92 }, { mount: '/tank', usedPct: 97 }] } };
  const alerts = evaluateAlerts({ ...baseInputs, storage });
  assert.equal(alerts.filter((a) => a.signature.includes('storage.filesystem')).length, 2);
  const critical = alerts.find((a) => a.signature.includes('/tank'));
  assert.equal(critical.severity, 'critical');
  assert.ok(THRESHOLDS.critical === 95 && THRESHOLDS.warning === 90);
});

test('a quota alert only fires when a quota is actually set', () => {
  const storage = {
    zfs: {
      pools: [],
      datasets: [
        { name: 'tank/a', quotaUsedPct: 50, quota: 100 },
        { name: 'tank/b', quotaUsedPct: 96, quota: 100 },
        { name: 'tank/c', quotaUsedPct: null, quota: null },
      ],
    },
    filesystems: { mounts: [] },
  };
  const alerts = evaluateAlerts({ ...baseInputs, storage });
  const quota = alerts.filter((a) => a.signature.startsWith('storage.quota'));
  assert.equal(quota.length, 1);
  assert.equal(quota[0].evidence.dataset, 'tank/b');
});

test('a down interface alerts only when it carries an address', () => {
  const network = {
    interfaces: [
      { name: 'eth0', state: 'down', addresses: [{ address: '198.51.100.20' }] },
      { name: 'eth1', state: 'down', addresses: [] },          // a spare port is not a fault
      { name: 'eth2', state: 'up', addresses: [{ address: '10.0.0.5' }] },
    ],
  };
  const alerts = evaluateAlerts({ ...baseInputs, network });
  const ifAlerts = alerts.filter((a) => a.signature.startsWith('network.interface.down'));
  assert.equal(ifAlerts.length, 1);
  assert.equal(ifAlerts[0].evidence.interface, 'eth0');
  assert.equal(ifAlerts[0].area, 'network');
});

test('a provider that is not configured is never an alert; one that failed is', () => {
  const providers = [
    provider('docker', 'compute', 'connected'),
    provider('opnsense', 'external', 'not-configured', { optional: true }),
    provider('zfs', 'storage', 'unavailable', { optional: true, reason: 'The ZFS command-line tools are not available to OpusHub.' }),
    provider('network', 'network', 'degraded'),
  ];
  const alerts = evaluateAlerts({ ...baseInputs, providers });
  const providerAlerts = alerts.filter((a) => a.signature.startsWith('provider.'));
  // zfs is optional and unavailable → skipped (absence of an optional provider is not a fault)
  // network is degraded → alerted
  assert.deepEqual(providerAlerts.map((a) => a.signature), ['provider.degraded:network']);
  assert.ok(!alerts.some((a) => a.signature.includes('opnsense')), 'an unconfigured optional provider is not an alert');
});

/* ------------------------------------------------------------------ */
/* activity transitions                                                */
/* ------------------------------------------------------------------ */

test('a pool health change is recorded once, with the before and after', () => {
  state._resetInfrastructureState();
  const before = readEvents({ limit: 500 }).items.filter((e) => e.type === 'zfs.pool.health').length;
  state.notePoolHealth([{ name: 'tank', health: 'ONLINE' }]);
  state.notePoolHealth([{ name: 'tank', health: 'ONLINE' }]);
  state.notePoolHealth([{ name: 'tank', health: 'DEGRADED' }]);
  state.notePoolHealth([{ name: 'tank', health: 'DEGRADED' }]);
  const events = readEvents({ limit: 500 }).items.filter((e) => e.type === 'zfs.pool.health');
  assert.equal(events.length, before + 1, 'one event for one change, not one per observation');
  const ev = events[0];
  assert.deepEqual({ from: ev.meta.from, to: ev.meta.to }, { from: 'ONLINE', to: 'DEGRADED' });
  assert.equal(ev.category, 'storage');
  assert.equal(ev.severity, 'warning');
  assert.match(ev.message, /tank is DEGRADED/);
});

test('crossing a usage threshold is an event; sitting there is not', () => {
  state._resetInfrastructureState();
  const before = readEvents({ limit: 500 }).items.filter((e) => e.type === 'storage.threshold').length;
  const mounts = [{ mount: '/srv', usedPct: 50 }];
  state.noteFilesystemThresholds(mounts);
  state.noteFilesystemThresholds(mounts);
  state.noteFilesystemThresholds([{ mount: '/srv', usedPct: 91 }]);
  state.noteFilesystemThresholds([{ mount: '/srv', usedPct: 93 }]);
  state.noteFilesystemThresholds([{ mount: '/srv', usedPct: 96 }]);
  const events = readEvents({ limit: 500 }).items.filter((e) => e.type === 'storage.threshold');
  // 91% warning, 96% critical: two crossings, and staying above the line is not re-reported
  assert.equal(events.length, before + 2);
  assert.deepEqual(events.map((e) => e.meta.to).sort(), ['critical', 'warning']);
});

test('a dataset quota crossing is recorded with the dataset it happened to', () => {
  state._resetInfrastructureState();
  state.noteDatasetQuotas([{ name: 'tank/media', quotaUsedPct: 50 }]);
  const before = readEvents({ limit: 500 }).items.filter((e) => e.type === 'storage.quota').length;
  state.noteDatasetQuotas([{ name: 'tank/media', quotaUsedPct: 91 }]);
  const events = readEvents({ limit: 500 }).items.filter((e) => e.type === 'storage.quota');
  assert.equal(events.length, before + 1);
  assert.equal(events[0].subject, 'tank/media');
  assert.equal(events[0].category, 'storage');
});

test('an interface going down is a warning only once, and coming back up is a notice', () => {
  state._resetInfrastructureState();
  const before = readEvents({ limit: 500 }).items.filter((e) => e.type === 'network.interface').length;
  state.noteInterfaceStates([{ name: 'eth0', state: 'up', addresses: [{ address: '10.0.0.5' }] }]);
  state.noteInterfaceStates([{ name: 'eth0', state: 'down', addresses: [{ address: '10.0.0.5' }] }]);
  state.noteInterfaceStates([{ name: 'eth0', state: 'down', addresses: [{ address: '10.0.0.5' }] }]);
  state.noteInterfaceStates([{ name: 'eth0', state: 'up', addresses: [{ address: '10.0.0.5' }] }]);
  const events = readEvents({ limit: 500 }).items.filter((e) => e.type === 'network.interface');
  assert.equal(events.length, before + 2);
  const down = events.find((e) => e.meta.to === 'down');
  const up = events.find((e) => e.meta.to === 'up');
  assert.equal(down.severity, 'warning', 'an interface with an address going down is a warning');
  assert.equal(up.severity, 'info');
  assert.equal(down.category, 'network');
});

test('the threshold vocabulary is one list, shared by the engine and the UI', () => {
  assert.deepEqual({ ...THRESHOLDS }, { warning: 90, critical: 95 });
  assert.equal(state.thresholdLevel(50), null);
  assert.equal(state.thresholdLevel(90), 'warning');
  assert.equal(state.thresholdLevel(96), 'critical');
  assert.equal(state.thresholdLevel(null), null, 'an unmeasured value is not "below the line"');
});
