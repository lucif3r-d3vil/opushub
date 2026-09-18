// The state machine — the only place a monitor's state changes.
//
//   pending ──(first good check)──► up
//   up ──(threshold failures)──► down          (a single transient failure does NOT take it down)
//   up ──(a wrong-but-answering check)──► degraded
//   down ──(any success)──► recovering ──(recovery threshold)──► up
//   recovering ──(any failure)──► down          (one bad check ends the recovery claim)
//   * ──(paused by the operator)──► paused ──(resume)──► unknown
//   * ──(no verdict: engine/target unavailable)──► unknown
//
// Rules that matter, and why:
//
//   · A hard failure is *counted*, not announced. `failureThreshold` consecutive failures are
//     required before a monitor that was up may be called down — that is what stops a single
//     dropped packet from opening an incident.
//   · A `degraded` result (the thing answered, but not as configured: a 500 where a 200 was
//     expected, an unhealthy healthcheck) moves an up monitor to `degraded` immediately. It is
//     real evidence from a real response, not a transient network event, and hiding it behind a
//     threshold would be the dishonesty this whole engine exists to avoid.
//   · `unknown` is never a success and never a failure. A monitor whose engine is unreachable, or
//     whose target no longer exists, must not be reported as down — nothing was measured.
//   · Paused monitors do not run, do not open incidents, and are not down. Their counters are
//     preserved so resuming continues rather than restarts the story.
//   · Recovery requires `recoveryThreshold` consecutive successes (or one, if that is what the
//     operator configured). Until then the monitor is `recovering`, which is a distinct, visible
//     state rather than a premature "all clear".
import { MONITOR_STATES } from './model.js';

/** The transitions that are worth telling someone about. */
export const TRANSITION_EVENTS = Object.freeze({
  down: 'monitor.down',
  recovered: 'monitor.recovered',
  degraded: 'monitor.degraded',
  degradedCleared: 'monitor.degraded_cleared',
  recovering: 'monitor.recovering',
  unknown: 'monitor.unknown',
});

/** A state change worth recording. `kind` is one of the keys above, or null for no change. */
function change(kind, from, to, at, reason) {
  return { kind, from, to, at, reason: reason || null };
}

/**
 * Pure evaluation.
 *
 * @param {object} monitor            the stored monitor (status + counters + thresholds' source)
 * @param {object} result             { kind: ok|degraded|fail|unknown, reason, statusCode, latencyMs, at }
 * @param {object} opts               { failureThreshold, recoveryThreshold, now, paused }
 * @returns {{ state: string, consecutiveFailures: number, consecutiveSuccesses: number, totalFailures: number, totalSuccesses: number, transition: object|null }}
 */
export function evaluateState(monitor, result, { failureThreshold = 3, recoveryThreshold = 2, now = Date.now(), paused = false } = {}) {
  const from = MONITOR_STATES.includes(monitor?.status) ? monitor.status : 'pending';
  let failures = Math.max(0, monitor?.consecutiveFailures || 0);
  let successes = Math.max(0, monitor?.consecutiveSuccesses || 0);
  let totalFailures = Math.max(0, monitor?.failureCount || 0);
  let totalSuccesses = Math.max(0, monitor?.successCount || 0);
  const thresholdF = Math.max(1, failureThreshold);
  const thresholdR = Math.max(1, recoveryThreshold);

  const settle = (state, transition) => ({
    state, consecutiveFailures: failures, consecutiveSuccesses: successes,
    totalFailures, totalSuccesses, transition: transition || null,
  });

  // Paused: the operator said so. It outranks any result, and it is not a verdict.
  if (paused) {
    return settle('paused', from === 'paused' ? null : change('paused', from, 'paused', now, 'paused by the operator'));
  }

  const kind = ['ok', 'degraded', 'fail', 'unknown'].includes(result?.kind) ? result.kind : 'unknown';

  if (kind === 'unknown') {
    // No measurement happened. The counters stand still: nothing was learned.
    const next = from === 'pending' ? 'unknown' : from;
    return settle(next, next === from ? null : change('unknown', from, next, now, result?.reason));
  }

  if (kind === 'ok') {
    totalSuccesses += 1;
    successes += 1;
    failures = 0;
    if (from === 'pending' || from === 'unknown' || from === 'paused') {
      return settle('up', change('recovered', from, 'up', now, 'first successful check'));
    }
    if (from === 'up') return settle('up', null);
    if (from === 'degraded' && successes >= thresholdR) {
      return settle('up', change('degradedCleared', 'degraded', 'up', now, `${successes} successful checks in a row`));
    }
    if (from === 'degraded') return settle('recovering', change('recovering', 'degraded', 'recovering', now, result?.reason));
    // down or recovering
    if (successes >= thresholdR) {
      return settle('up', change('recovered', from, 'up', now, `${successes} successful checks in a row`));
    }
    return settle('recovering', from === 'recovering' ? null : change('recovering', from, 'recovering', now, result?.reason));
  }

  // degraded | fail: the thing did not do what it was configured to do.
  totalFailures += 1;
  failures += 1;
  successes = 0;

  if (from === 'recovering') {
    // A recovery that stumbles is an outage that is still on, not a fresh count.
    return settle('down', change('down', 'recovering', 'down', now, result?.reason));
  }
  if (failures >= thresholdF) {
    return settle('down', from === 'down' ? null : change('down', from, 'down', now, `${failures} consecutive failed checks`));
  }
  if (kind === 'degraded') {
    return settle('degraded', from === 'degraded' ? null : change('degraded', from, 'degraded', now, result?.reason));
  }
  // A hard failure below threshold: the state holds, the counter is visible.
  return settle(from === 'down' ? 'down' : from, null);
}

/** The states that mean "something is wrong right now", used by UI grouping and alerting. */
export const BAD_STATES = Object.freeze(['down', 'degraded', 'recovering']);

/** The states a monitor can be in without the engine having a verdict. */
export const QUIET_STATES = Object.freeze(['pending', 'paused', 'unknown']);
