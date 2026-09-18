// The centralized scheduler — one timer, a bounded pool, and no way to run the same check twice.
//
// Why not `setInterval` per monitor: a hundred monitors with a hundred intervals is a hundred
// timers that drift into each other, a hundred stack frames at the same instant, and no single
// place that knows how much work is actually in flight. This module is that place.
//
//   scheduler.tick()
//        ↓  which monitors are due? (nextCheck <= now, not already running, enabled)
//        ↓  take at most (concurrency − inFlight) of them, oldest due first
//        ↓  run each through onDue(), which is where the actual check happens
//        ↓  nextCheck = now + interval + jitter, and one timer is armed for the next due time
//
// Properties this file is responsible for, and the tests that hold it to them:
//   · **bounded concurrency** — `concurrency` may never be exceeded (`maxInFlight` is observable),
//     and the whole pool is capped again by the settings bounds in model.js;
//   · **no duplicate checks** — a monitor that is already running is skipped, whatever the clock says;
//   · **timeout** — the check owns its deadline; the scheduler adds a hard stop so a wedged socket
//     can never hold a worker forever;
//   · **jitter** — the first check of each monitor is spread out and every subsequent interval gets
//     a bounded random offset, so a hundred monitors do not synchronise into a thundering herd;
//   · **graceful shutdown** — stop() arms nothing new and resolves once the in-flight checks are
//     done, so a restart never leaves a check half-reported;
//   · **restart-safe** — `nextCheck` comes from the stored monitor; after a restart the scheduler
//     finds the overdue ones and spreads them rather than firing everything in the same second.
import { BOUNDS } from './model.js';

/** The real clock, with one concession: timers do not keep the process alive on their own. */
export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    if (typeof handle.unref === 'function') handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Largest gap between ticks. A monitor due in an hour is still noticed at most this late. */
export const MAX_TICK_MS = 30_000;
/** How long a graceful shutdown waits for running checks before it gives up on them. */
export const STOP_GRACE_MS = 5000;

export function createScheduler({
  clock = realClock,
  concurrency = BOUNDS.maxConcurrent.default,
  jitterMs = BOUNDS.jitterMs.default,
  random = Math.random,
  onDue = async () => {},
  onError = null,
  onTick = null,
  stopGraceMs = STOP_GRACE_MS,
} = {}) {
  const limit = Math.max(BOUNDS.maxConcurrent.min, Math.min(BOUNDS.maxConcurrent.max, Math.round(concurrency) || 1));
  const jitter = Math.max(0, Math.min(BOUNDS.jitterMs.max, Math.round(jitterMs) || 0));

  /** id → monitor (the engine owns the records; the scheduler owns only their timing). */
  const monitors = new Map();
  /** id → promise of the check currently running. */
  const inFlight = new Map();
  let timer = null;
  let running = false;
  let stopped = false;
  let resolveStop = null;
  const stats = { ticks: 0, checks: 0, lastTickAt: null, lastCheckAt: null, maxInFlight: 0, failures: 0 };

  const offset = () => (jitter > 0 ? Math.floor(random() * jitter) : 0);

  /**
   * Register (or re-register) a monitor. `at` is used to spread the first check.
   *
   * A newly tracked monitor may be due sooner than whatever is already armed (a monitor created in
   * the UI must not wait up to MAX_TICK_MS for its first check), so the timer is re-aimed.
   */
  function track(monitor, { now = clock.now() } = {}) {
    monitors.set(monitor.id, monitor);
    if (!Number.isFinite(monitor.nextCheck)) monitor.nextCheck = now + offset();
    wake();
    return monitor;
  }

  /** Re-aim the single timer at the earliest due monitor, if one is armed for later. */
  function wake() {
    if (stopped || !running) return;
    const next = nextDueAt();
    if (next == null) return;
    if (timer) { clock.clearTimeout(timer); timer = null; }
    arm(next);
  }

  /** Apply the engine's current monitors, dropping the ones that are gone. */
  function sync(list) {
    const seen = new Set();
    const now = clock.now();
    for (const m of list) { seen.add(m.id); track(m, { now }); }
    for (const id of [...monitors.keys()]) if (!seen.has(id)) monitors.delete(id);
    wake();
    return monitors.size;
  }

  function forget(id) { monitors.delete(id); }

  function due(now) {
    const out = [];
    for (const m of monitors.values()) {
      if (!m.enabled) continue;
      if (inFlight.has(m.id)) continue;             // never two checks for one monitor
      if (!Number.isFinite(m.nextCheck)) continue;
      if (m.nextCheck <= now) out.push(m);
    }
    out.sort((a, b) => a.nextCheck - b.nextCheck || a.id.localeCompare(b.id));
    return out;
  }

  /**
   * When the next *startable* monitor is due. Monitors already running are skipped: their own
   * completion reschedules them, so waiting on them here would just burn ticks.
   */
  function nextDueAt() {
    let min = Infinity;
    for (const m of monitors.values()) {
      if (!m.enabled || !Number.isFinite(m.nextCheck)) continue;
      // A monitor that is already running is skipped: its completion re-arms the timer (see
      // runOne), so waiting on it here would only produce a tick that can start nothing.
      if (inFlight.has(m.id)) continue;
      if (m.nextCheck < min) min = m.nextCheck;
    }
    return min === Infinity ? null : min;
  }

  function arm(when) {
    if (timer || stopped) return;
    const now = clock.now();
    // never busier than 40 ticks/second, never later than MAX_TICK_MS
    const delay = Math.max(25, Math.min(MAX_TICK_MS, when - now));
    timer = clock.setTimeout(() => { timer = null; void tick(); }, delay);
  }

  function runOne(monitor, now) {
    stats.checks += 1;
    stats.lastCheckAt = now;
    // The check owns its own deadline; this guard only guarantees that a wedged socket cannot hold
    // a worker slot forever. If it fires, the slot is released and the late result (if it ever
    // arrives) is still recorded by the engine — a check that finished is a fact either way.
    const guardMs = Math.max(1000, Number(monitor.timeoutMs || 5000) + 2000);
    const work = (async () => {
      try {
        return await onDue(monitor);
      } catch (err) {
        stats.failures += 1;
        if (onError) { try { onError(err, monitor); } catch { /* never break the pool */ } }
        return null;
      }
    })();
    let guard = null;
    const job = new Promise((resolve) => {
      guard = clock.setTimeout(() => resolve('scheduler-timeout'), guardMs);
      work.then((value) => {
        if (guard) { clock.clearTimeout(guard); guard = null; }
        resolve(value);
      });
    });
    inFlight.set(monitor.id, job);
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight.size);
    job.then(() => {
      inFlight.delete(monitor.id);
      // Reschedule from *completion*, so a slow check cannot queue up its successor.
      const done = clock.now();
      monitor.nextCheck = done + monitor.intervalMs + offset();
      if (stopped && inFlight.size === 0 && resolveStop) { resolveStop(); resolveStop = null; }
      else if (!stopped) arm(nextDueAt() ?? done + MAX_TICK_MS);
    });
    return job;
  }

  async function tick() {
    if (stopped) return { ran: 0 };
    stats.ticks += 1;
    stats.lastTickAt = clock.now();
    const capacity = limit - inFlight.size;
    const ready = due(clock.now()).slice(0, Math.max(0, capacity));
    if (onTick) { try { onTick({ due: ready.length, inFlight: inFlight.size, limit }); } catch { /* ignore */ } }
    const started = [];
    for (const monitor of ready) started.push(runOne(monitor, clock.now()));
    if (!started.length) {
      const next = nextDueAt();
      arm(next ?? clock.now() + MAX_TICK_MS);
    }
    return { ran: started.length };
  }

  /** Start the timer chain. Idempotent. */
  function start({ now = clock.now() } = {}) {
    if (running || stopped) return false;
    running = true;
    arm(now);              // the first tick spreads overdue monitors across the pool
    return true;
  }

  /**
   * Stop arming new work and wait for what is already running — bounded, because a graceful
   * shutdown that can hang forever is not graceful. If the in-flight checks have not finished
   * within their own guard window, stop() resolves anyway and the caller exits.
   */
  function stop() {
    stopped = true;
    running = false;
    if (timer) { clock.clearTimeout(timer); timer = null; }
    if (!inFlight.size) return Promise.resolve();
    return new Promise((resolve) => {
      resolveStop = resolve;
      // The bound is wall-clock, not scheduler time: a shutdown deadline must not depend on the
      // thing it is trying to stop.
      // deliberately NOT unref'd: a shutdown deadline that the event loop can skip is not a deadline
      setTimeout(() => { if (resolveStop) { resolveStop = null; resolve(); } }, stopGraceMs);
    });
  }

  return {
    track,
    sync,
    forget,
    start,
    stop,
    tick,
    /** Read-only view of what the scheduler is doing — this is what the engine-health API reports. */
    stats: () => ({
      inFlight: inFlight.size,
      monitored: monitors.size,
      concurrency: limit,
      jitterMs: jitter,
      running,
      stopped,
      nextDueAt: nextDueAt(),
      ...stats,
    }),
    _inFlightIds: () => [...inFlight.keys()],
  };
}
