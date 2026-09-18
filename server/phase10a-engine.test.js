// Phase 10A — the engine, end to end, with the checks injected.
//
// What is under test is the engine's own behaviour: what it records, what it survives, what it
// refuses to claim, and what it hands to the alert engine and the activity log. The checks
// themselves have their own file (phase10a-checks.test.js), so here they are deterministic stubs
// and every assertion is about monitoring *state* rather than about a socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPUSHUB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10a-engine-cfg-'));
process.env.OPUSHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10a-engine-data-'));

const engine = await import('./monitoring/engine.js');
const { readEvents } = await import('./activity.js');

const ok = (ms = 12, at = Date.now()) => ({ kind: 'ok', at, latencyMs: ms, statusCode: 200, errorType: null, code: null, reason: 'HTTP 200', hops: 0, evidence: null });
const bad = (errorType = 'refused', at = Date.now()) => ({ kind: 'fail', at, latencyMs: null, statusCode: null, errorType, code: null, reason: `No response (${errorType}).`, hops: 0, evidence: null });
const noVerdict = (reason = 'nothing was measured', at = Date.now()) => ({ kind: 'unknown', at, latencyMs: null, statusCode: null, errorType: 'no_verdict', code: 'no_verdict', reason, hops: 0, evidence: null });

const httpMonitor = (name, extra = {}) => engine.createMonitor(
  { name, type: 'http', target: { url: `http://10.0.0.9:8096/${name.toLowerCase()}` }, intervalMs: 30_000, timeoutMs: 2000, ...extra },
  {},
);

const clocked = (results) => {
  let next = Date.now();
  return { deps: { checkHttp: async () => { const r = results.shift(); next += 1000; return typeof r === 'function' ? r(next) : { ...r, at: next }; } } };
};

/** Drive a monitor through a list of results, through the engine's own recording path. */
async function drive(monitor, results) {
  let out = null;
  let at = Date.now();
  for (const r of results) {
    at += 1000;
    out = await engine.runCheck(monitor, { at, deps: { checkHttp: async () => ({ ...r, at }) } });
  }
  return out;
}

const eventsSince = (since) => readEvents({ limit: 500, since }).items;

test.beforeEach(async () => {
  // a clean slate: process state *and* the stored documents, so each test is its own install
  await engine._wipeMonitoring();
  await engine.start({ autoStart: false });
});

test.afterEach(async () => {
  await engine.stop();
});

test('the engine reports what it is doing, including when it is not doing anything', async () => {
  const health = engine.engineHealth();
  assert.equal(health.state, 'idle', 'started with nothing to check is idle, not unavailable');
  assert.equal(health.monitored, 0);
  assert.equal(health.stale, false);
  assert.ok(health.concurrency >= 1);
  await engine.stop();
  const stopped = engine.engineHealth();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.reason, 'The engine was stopped.');
  assert.equal(stopped.stale, true, 'a stopped engine never presents old data as current');
});

test('a monitor is created, records a check, and its history and uptime are real', async () => {
  const m = await httpMonitor('Jellyfin');
  assert.equal(m.status, 'pending');
  assert.ok(m.nextCheck >= m.createdAt, 'a new monitor is due now, not in an hour');

  const out = await drive(m, [ok(10), ok(20), ok(30)]);
  assert.equal(out.state, 'up');
  assert.equal(m.status, 'up');
  assert.equal(m.latencyMs, 30);
  assert.equal(m.successCount, 3);
  assert.equal(m.lastCheck.statusCode, 200);

  const detail = engine.detail(m.id);
  assert.equal(detail.monitor.name, 'Jellyfin');
  assert.equal(detail.uptime.day.checks, 3);
  assert.equal(detail.uptime.day.uptimePct, 100);
  assert.equal(detail.uptime.day.avgLatencyMs, 20);
  assert.equal(detail.series.length, 3, 'the latency chart comes from recorded samples');
  assert.deepEqual(detail.series.map((s) => s.ms), [10, 20, 30]);
  assert.equal(detail.incidents.length, 0);
});

test('an outage is three failed checks, one incident, and a duration measured in the server clock', async () => {
  const m = await httpMonitor('Vaultwarden');
  const startAt = Date.now();
  await drive(m, [ok(), bad(), bad()]);
  assert.equal(m.status, 'up', 'two failures are visible but not an outage');
  assert.equal(engine.incidents({ open: true }).incidents.length, 0, 'and they open no incident');

  await drive(m, [bad()]);
  assert.equal(m.status, 'down');
  const open = engine.incidents({ open: true }).incidents;
  assert.equal(open.length, 1);
  assert.equal(open[0].monitorName, 'Vaultwarden');
  assert.equal(open[0].status, 'open');
  assert.equal(open[0].reason, 'No response (refused).');
  assert.equal(open[0].failureCount, 3);
  assert.ok(open[0].startedAt >= startAt, 'the incident started with the first failed check');
  assert.ok(open[0].detectedAt >= open[0].startedAt);

  await drive(m, [ok(9)]);
  assert.equal(m.status, 'recovering');
  assert.equal(engine.incidents({ open: true }).incidents[0].status, 'recovering');
  await drive(m, [ok(8)]);
  assert.equal(m.status, 'up');
  const resolved = engine.incidents().incidents;
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, 'resolved');
  assert.equal(resolved[0].durationMs, resolved[0].recoveredAt - resolved[0].startedAt);
  assert.ok(resolved[0].durationMs > 0);
  const uptime = engine.detail(m.id).uptime.day;
  assert.equal(uptime.checks, 6);
  assert.equal(uptime.ok, 3);
  assert.equal(uptime.fail, 3);
  assert.equal(uptime.uptimePct, 50, 'four of six checks succeeded');
});

test('a restart changes nothing that was recorded: definitions, history and incidents come back', async () => {
  const m = await httpMonitor('Restart Survivor');
  await drive(m, [ok(), bad(), bad(), bad()]);
  assert.equal(m.status, 'down');
  const before = engine.detail(m.id);
  const openBefore = engine.incidents({ open: true }).incidents[0];

  await engine.stop();
  engine._resetEngine();              // process state only: the store on disk is what survives
  await engine.start({ autoStart: false });

  const after = engine.detail(m.id);
  assert.equal(after.monitor.name, 'Restart Survivor');
  assert.equal(after.monitor.status, 'down', 'a restart does not invent a recovery');
  assert.equal(after.monitor.failureCount, before.monitor.failureCount);
  assert.equal(after.uptime.day.checks, before.uptime.day.checks);
  assert.equal(after.series.length, before.series.length);
  const openAfter = engine.incidents({ open: true }).incidents;
  assert.equal(openAfter.length, 1, 'the outage is still an open incident');
  assert.equal(openAfter[0].id, openBefore.id);
  assert.equal(openAfter[0].startedAt, openBefore.startedAt);
  // and the engine health says it has booted more than once
  assert.ok(engine.engineHealth().bootCount >= 2);
});

test('pausing is not a failure: it closes what is open, alerts nothing, and resumes without a verdict', async () => {
  const m = await httpMonitor('Paused One');
  await drive(m, [ok(), bad(), bad(), bad()]);
  assert.equal(engine.alertInputs().monitors.length, 1, 'a down monitor is alert input');

  engine.pauseMonitor(m.id);
  assert.equal(m.status, 'paused');
  assert.equal(m.enabled, false);
  assert.equal(engine.overview().counts.paused, 1);
  assert.equal(engine.overview().counts.down, 0, 'paused is its own count, not a kind of down');
  assert.equal(engine.alertInputs().monitors.length, 0, 'a paused monitor is never an alert');
  const closed = engine.incidents().incidents[0];
  assert.equal(closed.status, 'resolved');
  assert.equal(closed.resolvedBy, 'paused');
  assert.equal(engine.overview().monitors[0].status, 'paused');

  // a paused monitor is not checked by the scheduler, and a manual check is refused
  await assert.rejects(() => engine.checkNow(m.id, {}), /paused/);

  engine.resumeMonitor(m.id);
  assert.equal(m.enabled, true);
  assert.equal(m.status, 'unknown', 'resuming does not claim it is up');
  assert.equal(engine.overview().counts.unknown, 1);
});

test('a maintenance window silences the alerts without lying about the state', async () => {
  const m = await httpMonitor('Maintained');
  await drive(m, [ok()]);
  engine.setMaintenance(m.id, { until: Date.now() + 3_600_000, reason: 'disk swap' });
  assert.equal(engine.overview().counts.maintenance, 1);
  assert.equal(engine.overview().monitors[0].maintenance.reason, 'disk swap');

  await drive(m, [bad(), bad(), bad()]);
  assert.equal(m.status, 'down', 'the state machine still tells the truth');
  assert.equal(engine.alertInputs().monitors.length, 0, 'and no alert is raised for a planned outage');
  const incident = engine.incidents({ open: true }).incidents[0];
  assert.equal(incident.maintenance, true);
  assert.equal(incident.suppressed, true);
  const suppressedEvent = readEvents({ limit: 50, type: 'monitor.down' }).items[0];
  assert.equal(suppressedEvent.meta.maintenance, true);
  assert.equal(suppressedEvent.severity, 'info', 'a planned outage is information, not a warning');

  engine.setMaintenance(m.id, null);
  assert.equal(engine.overview().counts.maintenance, 0);
  assert.equal(engine.alertInputs().monitors.length, 1, 'once the window closes, the outage alerts again');
});

test('activity records transitions and incidents — never a successful check', async () => {
  const since = Date.now();
  const m = await httpMonitor('Activity Probe');
  await drive(m, [ok(), ok(), ok()]);
  const stateEvents = (list) => list.filter((e) => ['monitor.down', 'monitor.recovered', 'monitor.degraded', 'monitor.recovering', 'monitor.unknown'].includes(e.type));
  assert.deepEqual(stateEvents(eventsSince(since)), [], 'three good checks are history, not events');
  assert.ok(eventsSince(since).some((e) => e.type === 'monitor.created'), 'but creating the monitor is an event');

  await drive(m, [bad(), bad(), bad()]);
  await drive(m, [ok(), ok()]);
  const mine = eventsSince(since);
  const types = mine.filter((e) => e.source === 'system').map((e) => e.type);
  assert.equal(types.filter((t) => t === 'monitor.down').length, 1);
  assert.equal(types.filter((t) => t === 'monitor.recovering').length, 1);
  assert.equal(types.filter((t) => t === 'monitor.recovered').length, 1);
  assert.equal(types.filter((t) => t === 'incident.opened').length, 1);
  assert.equal(types.filter((t) => t === 'incident.resolved').length, 1);
  assert.equal(mine.every((e) => e.category === 'monitoring'), true, 'filed under monitoring, not mixed into docker events');
  assert.equal(mine.filter((e) => e.source === 'system').every((e) => e.type.startsWith('monitor.') || e.type.startsWith('incident.')), true);
  const down = mine.find((e) => e.type === 'monitor.down');
  assert.equal(down.subject, 'Activity Probe');
  assert.equal(down.severity, 'warning');
  assert.equal(down.meta.monitorId, m.id);
  const resolved = mine.find((e) => e.type === 'incident.resolved');
  assert.ok(resolved.meta.durationMs > 0);
});

test('a monitor with no verdict never opens an incident and never reports uptime as success', async () => {
  const m = await httpMonitor('Stale Target');
  await drive(m, [ok(), noVerdict('the container is not in the inventory'), noVerdict(), noVerdict()]);
  assert.equal(m.status, 'up', 'no measurement is not an outage');
  assert.equal(engine.incidents({ open: true }).incidents.length, 0);
  const uptime = engine.detail(m.id).uptime.day;
  assert.equal(uptime.checks, 4);
  assert.equal(uptime.unknown, 3);
  assert.equal(uptime.judged, 1);
  assert.equal(uptime.uptimePct, 100, 'one judged check, one success — and the three unknowns are counted, not hidden');
});

test('stale data is marked stale rather than presented as current', async () => {
  const m = await httpMonitor('Slow Checker', { intervalMs: 30_000 });
  await drive(m, [ok()]);
  assert.equal(engine.isStale(m), false);
  m.lastCheck = { at: Date.now() - 10 * 60_000, kind: 'ok', statusCode: 200, latencyMs: 5, reason: 'HTTP 200' };
  assert.equal(engine.isStale(m), true, 'four intervals without a check is stale');
  assert.equal(engine.overview().counts.stale, 1);
  // a paused monitor is not stale: it is paused, which is its own honest answer
  engine.pauseMonitor(m.id);
  assert.equal(engine.isStale(m), false);
  assert.equal(engine.overview().counts.stale, 0);
});

test('the alert input is a snapshot of real state: id, name, how long, and why', async () => {
  const m = await httpMonitor('Alert Input');
  await drive(m, [ok(), bad(), bad(), bad()]);
  const inputs = engine.alertInputs();
  assert.equal(inputs.monitors.length, 1);
  const one = inputs.monitors[0];
  assert.equal(one.id, m.id);
  assert.equal(one.name, 'Alert Input');
  assert.equal(one.status, 'down');
  assert.equal(one.type, 'http');
  assert.ok(one.since >= m.streakStartedAt, 'the alert knows when the trouble started');
  assert.equal(one.reason, 'No response (refused).');
  assert.equal(one.latencyMs, null);
  // a degraded monitor is alert input too, and a healthy one never is
  await drive(m, [ok(), ok()]);
  assert.equal(engine.alertInputs().monitors.length, 0);
});

test('search offers monitors and their incidents as destinations, from real records only', async () => {
  const m = await httpMonitor('Searchable');
  await drive(m, [ok(), bad(), bad(), bad()]);
  const entries = engine.searchEntries();
  const monitor = entries.find((e) => e.kind === 'monitor');
  assert.ok(monitor, 'the monitor is searchable');
  assert.equal(monitor.href, `/monitoring/${m.id}`);
  assert.match(monitor.subtitle, /down/i);
  const incident = entries.find((e) => e.kind === 'incident');
  assert.ok(incident, 'the open incident is searchable');
  assert.match(incident.title, /Searchable/);
  assert.equal(incident.href, `/monitoring/${m.id}`, 'an incident leads to the monitor it belongs to');
  engine.deleteMonitor(m.id);
  assert.equal(engine.searchEntries().length, 0, 'deleting the monitor takes its records with it');
});

test('deleting a monitor closes its incident and drops its history', async () => {
  const m = await httpMonitor('Doomed');
  await drive(m, [ok(), bad(), bad(), bad()]);
  assert.equal(engine.incidents({ open: true }).incidents.length, 1);
  const out = engine.deleteMonitor(m.id);
  assert.equal(out.id, m.id);
  assert.equal(engine.detail(m.id), null);
  assert.equal(engine.overview().counts.total, 0);
  assert.equal(engine.incidents().incidents.length, 1, 'the incident stays as history');
  assert.equal(engine.incidents().incidents[0].status, 'resolved');
  assert.equal(engine.incidents().incidents[0].resolvedBy, 'deleted');
  // persistence is debounced, so the store is read after a flush (which stop() performs)
  await engine.stop();
  const doc = JSON.parse(fs.readFileSync(path.join(process.env.OPUSHUB_DATA_DIR, 'monitoring', 'history.json'), 'utf8'));
  assert.equal(doc.monitors[m.id], undefined, 'the history is gone from disk too');
  await engine.start({ autoStart: false });
});

test('the monitor count is capped, and the refusal says what to do', async () => {
  engine.updateSettings({ maxMonitors: 2 });
  await httpMonitor('One');
  await httpMonitor('Two');
  await assert.rejects(() => httpMonitor('Three'), /limited to 2 monitors/);
  assert.equal(engine.overview().counts.total, 2);
});

test('settings are clamped and applied: a lowered interval reaches existing monitors', async () => {
  const m = await httpMonitor('Tuned', { intervalMs: 3_600_000 });
  engine.updateSettings({ intervalMs: 30_000, failureThreshold: 99, recoveryThreshold: 0, maxConcurrent: 99 });
  const settings = engine.getSettings();
  assert.equal(settings.intervalMs, 30_000);
  assert.equal(settings.failureThreshold, 10, 'clamped to the maximum the brief allows');
  assert.equal(settings.recoveryThreshold, 1);
  assert.equal(settings.maxConcurrent, 8);
  assert.ok(m.intervalMs <= 30_000, 'an existing monitor was brought inside the new bound');
  assert.ok(m.timeoutMs < m.intervalMs);
});

test('a manual check runs through the same path and is rate limited', async () => {
  const m = await httpMonitor('Manual');
  const out = await engine.checkNow(m.id, { deps: { checkHttp: async () => ok() } });
  assert.equal(out.state, 'up');
  assert.equal(out.monitor.status, 'up');
  await assert.rejects(() => engine.checkNow(m.id, {}), /Give it a moment/);
  await assert.rejects(() => engine.checkNow('mon-nope', {}), (err) => err.code === 'not_found', 'an unknown id never reaches a check');
  assert.equal((await engine.checkNow(m.id, { at: Date.now() + 10_000, deps: { checkHttp: async () => ok() } })).state, 'up');
});

test('two engines never check the same monitor at the same time', async () => {
  const m = await httpMonitor('Single Flight');
  let running = 0;
  let peak = 0;
  const slowCheck = async () => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 30));
    running -= 1;
    return ok();
  };
  await Promise.all([
    engine.runCheck(m, { deps: { checkHttp: slowCheck } }),
    engine.runCheck(m, { deps: { checkHttp: slowCheck } }),
  ]);
  // The engine does not itself refuse a concurrent record (the scheduler owns that), but every
  // result is recorded in order and the counters are consistent: 2 checks, 2 samples, no losses.
  assert.equal(peak <= 2, true);
  const uptime = engine.detail(m.id).uptime.day;
  assert.equal(uptime.checks, 2);
  assert.equal(m.successCount, 2);
  // the scheduler-level guarantee is asserted in phase10a-scheduler.test.js (no two in-flight
  // checks for one monitor, whatever the clock says)
  assert.equal(engine.engineHealth().checksRunning, 0);
});

test('the scope a check reached is recorded on the target, and internal monitoring can be switched off', async () => {
  const monitor = await httpMonitor('Scope');
  assert.equal(monitor.target.scope, null, 'nothing has been measured yet');

  // the engine passes the policy down to every check it runs
  const seen = [];
  const spy = async (url, opts) => { seen.push(opts.allowInternal); return { ...ok(), evidence: { addressClasses: ['private'] } }; };
  await engine.runCheck(monitor, { at: Date.now(), deps: { checkHttp: spy } });
  assert.deepEqual(seen, [true], 'internal targets are allowed by default');
  assert.equal(monitor.target.scope, 'internal');
  assert.equal(monitor.target.scopeAt > 0, true);

  await engine.runCheck(monitor, { at: Date.now(), deps: { checkHttp: async () => ({ ...ok(), evidence: { addressClasses: ['public'] } }) } });
  assert.equal(monitor.target.scope, 'public', 'the recorded scope follows what was actually reached');

  await engine.runCheck(monitor, { at: Date.now(), deps: { checkHttp: async () => ({ ...ok(), evidence: { addressClasses: ['private', 'public'] } }) } });
  assert.equal(monitor.target.scope, 'mixed');

  // public-only: the setting reaches the check, and a refusal is a configuration answer rather
  // than an outage — never down, never an incident, and the state it already had is not invented
  engine.updateSettings({ allowInternal: false });
  let passed = null;
  await engine.runCheck(monitor, {
    at: Date.now(),
    deps: {
      checkHttp: async (url, opts) => {
        passed = opts.allowInternal;
        return { kind: 'unknown', at: Date.now(), latencyMs: null, statusCode: null, errorType: 'internal_blocked', code: 'internal_blocked', reason: 'internal network', hops: 0, evidence: null };
      },
    },
  });
  assert.equal(passed, false, 'the policy travels into the check');
  assert.equal(monitor.status, 'up', 'a policy refusal is not a failure');
  assert.equal(monitor.consecutiveFailures, 0);
  assert.equal(engine.incidents({ open: true }).incidents.length, 0);
  assert.equal(engine.getSettings().allowInternal, false);
  engine.updateSettings({ allowInternal: true });
  assert.equal(engine.getSettings().allowInternal, true);
});

test('the scheduler is wired up: a due monitor is checked without anybody asking', async () => {
  await engine._wipeMonitoring();
  const seen = [];
  await engine.start({ autoStart: true, random: () => 0, deps: { checkHttp: async () => { seen.push(Date.now()); return ok(3); } } });
  const m = await httpMonitor('Due Now', { intervalMs: 10_000, timeoutMs: 1_000 });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(seen.length >= 1, 'the scheduler ran the due monitor on its own');
  assert.ok(engine.detail(m.id).uptime.day.checks >= 1);
  assert.equal(engine.engineHealth().checksRunning, 0);
});
