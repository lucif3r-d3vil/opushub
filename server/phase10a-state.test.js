// Phase 10A — the state machine, incidents and uptime arithmetic.
//
// These are the rules that decide what OpusHub is allowed to claim: three failed checks make an
// outage, two good ones end it, one bad answer never does. Everything here is pure, so the exact
// sequence is reproducible rather than "observed once on a real host".
import test from 'node:test';
import assert from 'node:assert/strict';

const { BAD_STATES, QUIET_STATES, TRANSITION_EVENTS, evaluateState } = await import('./monitoring/state.js');
const { MAX_INCIDENTS, applyState, closeFor, markRecovering, openIncident, publicIncident, resolveIncident, trimIncidents } = await import('./monitoring/incidents.js');
const { computeUptime } = await import('./monitoring/engine.js');

const T0 = 1_800_000_000_000;
const monitor = (over = {}) => ({ id: 'mon-abcdef123456', name: 'Jellyfin', type: 'http', status: 'pending', consecutiveFailures: 0, consecutiveSuccesses: 0, failureCount: 0, successCount: 0, intervalMs: 60_000, target: { service: { group: 'Media', name: 'jellyfin' } }, ...over });
const result = (kind, over = {}) => ({ kind, at: T0, reason: kind === 'ok' ? 'HTTP 200' : kind === 'fail' ? 'No response (refused).' : kind === 'degraded' ? 'HTTP 500 (expected 200–399).' : 'The Docker engine is not reachable.', statusCode: over.statusCode ?? (kind === 'ok' ? 200 : kind === 'degraded' ? 500 : null), latencyMs: over.latencyMs ?? (kind === 'ok' ? 12 : null), ...over });

/** Fold a sequence of results into the monitor's own fields, exactly as the engine does. */
function fold(states, kinds, { failureThreshold = 3, recoveryThreshold = 2 } = {}) {
  let m = monitor();
  const transitions = [];
  for (const kind of kinds) {
    const out = evaluateState(m, { ...result(kind), at: T0 + transitions.length + 1 }, { failureThreshold, recoveryThreshold, now: T0 + transitions.length + 1 });
    m = { ...m, status: out.state, consecutiveFailures: out.consecutiveFailures, consecutiveSuccesses: out.consecutiveSuccesses, failureCount: out.totalFailures, successCount: out.totalSuccesses };
    transitions.push(out.transition ? (TRANSITION_EVENTS[out.transition.kind] ?? out.transition.kind) : null);
  }
  return { monitor: m, transitions };
}

test('one failed check is not an outage: three are', () => {
  const { monitor: afterOne } = fold([], ['ok', 'fail']);
  assert.equal(afterOne.status, 'up', 'a single transient failure does not move the state');
  assert.equal(afterOne.consecutiveFailures, 1, 'but it is counted, so the UI can say "1 failed check"');
  assert.equal(afterOne.failureCount, 1);

  const { monitor: afterThree, transitions } = fold([], ['ok', 'fail', 'fail', 'fail']);
  assert.equal(afterThree.status, 'down');
  assert.equal(afterThree.consecutiveFailures, 3);
  assert.deepEqual(transitions.slice(0, 4), [TRANSITION_EVENTS.recovered, null, null, TRANSITION_EVENTS.down], 'a first success is a transition; a failed check below the threshold is not');
  assert.equal(afterThree.successCount, 1);
  assert.equal(afterThree.failureCount, 3);
});

test('recovery needs two good checks, and a stumble during recovery is still the same outage', () => {
  const { monitor: one, transitions: t1 } = fold([], ['ok', 'fail', 'fail', 'fail', 'ok']);
  assert.equal(one.status, 'recovering');
  assert.equal(t1.at(-1), TRANSITION_EVENTS.recovering);
  const { monitor: two, transitions: t2 } = fold([], ['ok', 'fail', 'fail', 'fail', 'ok', 'ok']);
  assert.equal(two.status, 'up');
  assert.equal(t2.at(-1), TRANSITION_EVENTS.recovered);
  // a failure while recovering goes straight back to down — the failure count is not reset
  const { monitor: flapped, transitions: t3 } = fold([], ['ok', 'fail', 'fail', 'fail', 'ok', 'fail']);
  assert.equal(flapped.status, 'down');
  assert.equal(t3.at(-1), TRANSITION_EVENTS.down);
  assert.equal(flapped.consecutiveSuccesses, 0);
  // and two successes after a longer outage still end it
  const { monitor: later } = fold([], ['ok', 'fail', 'fail', 'fail', 'ok', 'fail', 'ok', 'ok']);
  assert.equal(later.status, 'up');
});

test('thresholds are honoured, so a stricter operator gets a stricter engine', () => {
  const { monitor: strict } = fold([], ['ok', 'fail'], { failureThreshold: 1, recoveryThreshold: 1 });
  assert.equal(strict.status, 'down', 'a threshold of one means one failed check is an outage');
  const { monitor: flappy } = fold([], ['ok', 'fail', 'fail', 'fail', 'ok'], { failureThreshold: 3, recoveryThreshold: 1 });
  assert.equal(flappy.status, 'up', 'a recovery threshold of one ends the outage on the first good check');
  const { monitor: slow } = fold([], ['ok', 'fail', 'fail', 'fail', 'ok', 'ok', 'ok'], { failureThreshold: 3, recoveryThreshold: 5 });
  assert.equal(slow.status, 'recovering', 'five good checks are needed before it is called up');
});

test('an answer that is wrong but present is degraded immediately — and still becomes down eventually', () => {
  const { monitor: soft, transitions } = fold([], ['ok', 'degraded']);
  assert.equal(soft.status, 'degraded', 'a 500 while the service is answering is real evidence, not a network blip');
  assert.equal(transitions.at(-1), TRANSITION_EVENTS.degraded);
  const { monitor: worse, transitions: t2 } = fold([], ['ok', 'degraded', 'degraded', 'degraded']);
  assert.equal(worse.status, 'down', 'the failure threshold still applies');
  assert.equal(t2.at(-1), TRANSITION_EVENTS.down);
  // and clearing it needs the recovery threshold, because "it answered once" is not a recovery
  const { monitor: cleared, transitions: t3 } = fold([], ['ok', 'degraded', 'ok']);
  assert.equal(cleared.status, 'recovering');
  assert.equal(t3.at(-1), TRANSITION_EVENTS.recovering);
});

test('no measurement never moves the counters: unknown is not a failure and not a success', () => {
  const { monitor: m, transitions } = fold([], ['ok', 'unknown', 'unknown', 'fail']);
  assert.equal(m.status, 'up');
  assert.equal(m.consecutiveFailures, 1, 'only the real failure counted');
  assert.equal(m.failureCount, 1);
  assert.equal(m.successCount, 1);
  assert.deepEqual(transitions, [TRANSITION_EVENTS.recovered, null, null, null]);
  // a monitor that has never produced a verdict says so
  const { monitor: fresh } = fold([], ['unknown']);
  assert.equal(fresh.status, 'unknown');
  assert.equal(fresh.failureCount, 0);
  assert.equal(fresh.successCount, 0);
  // a stale target or an unreachable engine must never open an outage on its own
  const { monitor: stale } = fold([], ['ok', 'unknown', 'unknown', 'unknown', 'unknown']);
  assert.equal(stale.status, 'up');
});

test('pausing outranks every result, and resuming does not invent one', () => {
  const paused = evaluateState(monitor({ status: 'up', consecutiveFailures: 2 }), result('fail'), { paused: true, now: T0 });
  assert.equal(paused.state, 'paused');
  assert.equal(paused.consecutiveFailures, 2, 'the counters are preserved for when it resumes');
  const already = evaluateState(monitor({ status: 'paused' }), result('ok'), { paused: true, now: T0 });
  assert.equal(already.state, 'paused');
  assert.equal(already.transition, null);
  // a paused monitor that comes back starts from what it knew: the first good check is an up
  const resumed = evaluateState(monitor({ status: 'paused' }), result('ok'), { now: T0 });
  assert.equal(resumed.state, 'up');
  assert.equal(resumed.transition.kind, 'recovered', 'a first success is a transition out of "no verdict"');
  assert.equal(TRANSITION_EVENTS[resumed.transition.kind], 'monitor.recovered');
});

test('every state is classified: what is wrong, and what merely has no verdict', () => {
  assert.deepEqual([...BAD_STATES], ['down', 'degraded', 'recovering']);
  assert.deepEqual([...QUIET_STATES], ['pending', 'paused', 'unknown']);
  assert.equal(BAD_STATES.includes('recovering'), true);
  assert.equal(QUIET_STATES.includes('paused'), true);
  assert.ok(Object.values(TRANSITION_EVENTS).includes('monitor.down'));
});

/* ==================================================================== */
/* incidents                                                            */
/* ==================================================================== */

test('an incident records when the trouble started and when it was detected — two different facts', () => {
  const m = monitor({ status: 'down', consecutiveFailures: 3, lastCheck: { at: T0 + 120_000, reason: 'No response (refused).' } });
  const incident = openIncident({ monitor: m, at: T0 + 120_000, startedAt: T0, reason: 'No response (refused).', failureCount: 3 });
  assert.equal(incident.startedAt, T0, 'the first failed check of the streak');
  assert.equal(incident.detectedAt, T0 + 120_000, 'the check that crossed the threshold');
  assert.equal(incident.status, 'open');
  assert.equal(incident.failureCount, 3);
  assert.equal(incident.service.name, 'jellyfin', 'the incident remembers the service it belongs to');
  const live = publicIncident(incident, { now: T0 + 300_000 });
  assert.equal(live.durationMs, 300_000, 'a duration is measured with the server clock');
  assert.equal(live.open, true);
});

test('an incident moves open → recovering → resolved, and its duration is the outage', () => {
  const m = monitor({ status: 'down', consecutiveFailures: 3 });
  let list = applyState([], { monitor: m, at: T0, startedAt: T0 - 120_000, previous: 'up' });
  assert.equal(list.length, 1);
  const id = list[0].id;
  list = applyState(list, { monitor: { ...m, status: 'recovering' }, at: T0 + 60_000 });
  assert.equal(list[0].status, 'recovering');
  list = applyState(list, { monitor: { ...m, status: 'up', lastCheck: { at: T0 + 120_000, reason: 'HTTP 200' } }, at: T0 + 120_000 });
  assert.equal(list[0].status, 'resolved');
  assert.equal(list[0].id, id, 'the same incident, closed — not a second one');
  assert.equal(list[0].durationMs, 240_000);
  assert.equal(list[0].resolvedBy, 'recovered');
  // and further good checks do not open anything
  list = applyState(list, { monitor: { ...m, status: 'up' }, at: T0 + 180_000 });
  assert.equal(list.length, 1);
});

test('a repeated outage is a new incident, and a first soft degrade is recorded without an alert', () => {
  const down = monitor({ status: 'down', consecutiveFailures: 3 });
  let list = applyState([], { monitor: down, at: T0, startedAt: T0 });
  list = applyState(list, { monitor: { ...down, status: 'up' }, at: T0 + 60_000 });
  list = applyState(list, { monitor: down, at: T0 + 600_000, startedAt: T0 + 480_000 });
  assert.equal(list.length, 2, 'the second outage is its own incident');
  assert.notEqual(list[0].id, list[1].id);
  assert.equal(list[1].startedAt, T0 + 480_000);

  const soft = applyState([], { monitor: monitor({ status: 'degraded', lastCheck: { at: T0, reason: 'unhealthy' } }), at: T0 });
  assert.equal(soft.length, 1);
  assert.equal(soft[0].status, 'open');
  assert.equal(soft[0].reason, 'unhealthy');
});

test('a failure during recovery reopens the incident rather than creating a second one', () => {
  const down = monitor({ status: 'down', consecutiveFailures: 3 });
  let list = applyState([], { monitor: down, at: T0, startedAt: T0 });
  list = applyState(list, { monitor: { ...down, status: 'recovering' }, at: T0 + 60_000 });
  list = applyState(list, { monitor: { ...down, status: 'down', consecutiveFailures: 1, lastCheck: { at: T0 + 90_000, reason: 'No response (timeout).' } }, at: T0 + 90_000 });
  assert.equal(list.length, 1, 'still the same outage');
  assert.equal(list[0].status, 'open');
  assert.equal(list[0].reason, 'No response (timeout).');
  assert.equal(list[0].startedAt, T0);
});

test('maintenance is recorded but not alarmed, and pausing closes what was open', () => {
  const down = monitor({ status: 'down', consecutiveFailures: 3 });
  const list = applyState([], { monitor: down, at: T0, startedAt: T0, maintenance: true });
  assert.equal(list[0].maintenance, true);
  assert.equal(list[0].suppressed, true, 'a planned outage is not alert noise');

  const open = openIncident({ monitor: down, at: T0, startedAt: T0 });
  const closed = closeFor([open], down.id, { at: T0 + 30_000, why: 'paused' });
  assert.equal(closed[0].status, 'resolved');
  assert.equal(closed[0].resolvedBy, 'paused');
  assert.equal(closed[0].durationMs, 30_000);
  // pausing already-resolved history changes nothing
  const resolved = resolveIncident(open, { at: T0 + 60_000, why: 'recovered' });
  assert.equal(resolveIncident(resolved, { at: T0 + 90_000 }).durationMs, 60_000, 'resolving twice is idempotent');
  assert.equal(closeFor([resolved], down.id, { at: T0 + 120_000 })[0].resolvedBy, 'recovered');
});

test('incident retention is bounded, and an outage that is still happening is never dropped', () => {
  const make = (i, status = 'resolved') => ({
    id: `inc-${i}`, monitorId: 'mon-abcdef123456', monitorName: 'x', monitorType: 'http', service: null,
    startedAt: i, detectedAt: i, recoveredAt: status === 'resolved' ? i + 1000 : null,
    durationMs: status === 'resolved' ? 1000 : null, status, reason: 'r', failureCount: 3,
    maintenance: false, suppressed: false, resolvedBy: status === 'resolved' ? 'recovered' : null,
  });
  const open = [0, 1, 2].map((i) => make(MAX_INCIDENTS + i, 'open'));
  const resolved = Array.from({ length: MAX_INCIDENTS + 40 }, (_, i) => make(i));
  const trimmed = trimIncidents([...open, ...resolved], 100);
  assert.equal(trimmed.length, 100);
  assert.equal(trimmed.filter((i) => i.status === 'open').length, 3, 'every open incident survives');
  assert.ok(trimmed.some((i) => i.id === `inc-${MAX_INCIDENTS + 39}`), 'the newest resolved incidents are kept');
  assert.ok(!trimmed.some((i) => i.id === 'inc-0'), 'the oldest resolved are dropped first');
  assert.equal(trimIncidents([make(1)], MAX_INCIDENTS).length, 1, 'under the cap, nothing is touched');
});

/* ==================================================================== */
/* uptime                                                               */
/* ==================================================================== */

const entry = (samples) => ({ samples, hours: [] });
const sample = (t, k, ms = null) => ({ t, k, ms, code: k === 'ok' ? 200 : null });

test('uptime counts judged checks only, and missing data is never a success', () => {
  const at = T0;
  const mixed = computeUptime(entry([
    sample(at - 600_000, 'ok', 10), sample(at - 540_000, 'ok', 12), sample(at - 480_000, 'fail'),
    sample(at - 420_000, 'ok', 14), sample(at - 360_000, 'unknown'), sample(at - 300_000, 'degraded'),
  ]), { at });
  assert.equal(mixed.checks, 6);
  assert.equal(mixed.ok, 3);
  assert.equal(mixed.fail, 1);
  assert.equal(mixed.degraded, 1);
  assert.equal(mixed.unknown, 1);
  assert.equal(mixed.judged, 5, 'the unknown result is not judged');
  assert.equal(mixed.uptimePct, 60, '3 of 5 judged checks succeeded, and the unknown neither helped nor hurt');
  assert.equal(mixed.avgLatencyMs, 12);
  assert.equal(mixed.minLatencyMs, 10);
  assert.equal(mixed.maxLatencyMs, 14);
  assert.equal(mixed.noData, false);
});

test('a window with nothing in it answers null, not 100%', () => {
  const empty = computeUptime(entry([]), { at: T0 });
  assert.equal(empty.uptimePct, null);
  assert.equal(empty.noData, true);
  assert.equal(empty.checks, 0);
  const onlyUnknown = computeUptime(entry([sample(T0 - 60_000, 'unknown')]), { at: T0 });
  assert.equal(onlyUnknown.uptimePct, null, 'no verdict is not 100% up');
  assert.equal(onlyUnknown.judged, 0);
  assert.equal(onlyUnknown.noData, false, 'there *is* data — it just contains no verdicts');
});

test('a paused monitor reports itself as paused, and the window only counts what is inside it', () => {
  const at = T0;
  const p = computeUptime(entry([sample(at - 30 * 3_600_000, 'fail'), sample(at - 60_000, 'ok', 9)]), { at, status: 'paused' });
  assert.equal(p.paused, true);
  assert.equal(p.checks, 1, 'the 30-hour-old sample is outside a 24h window');
  assert.equal(p.uptimePct, 100);
  assert.equal(p.coverageFrom, at - 60_000);
  assert.equal(p.coverageTo, at - 60_000);
  const week = computeUptime(entry([sample(at - 30 * 3_600_000, 'fail'), sample(at - 60_000, 'ok', 9)]), { at, windowMs: 7 * 24 * 3_600_000 });
  assert.equal(week.checks, 2);
  assert.equal(week.uptimePct, 50);
});
