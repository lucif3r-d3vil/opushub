// Phase 10A — the centralized scheduler.
//
// A fake clock, so every property is tested deterministically: due monitors, bounded concurrency,
// duplicate prevention, the hard timeout guard, jitter, graceful shutdown and restart-safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPUSHUB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10a-sched-cfg-'));
process.env.OPUSHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10a-sched-data-'));

const { createScheduler, MAX_TICK_MS } = await import('../server/monitoring/scheduler.js');

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** A clock the test drives by hand. */
function fakeClock() {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const waiting = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (!waiting.length) break;
        const [id, timer] = waiting[0];
        timers.delete(id);
        t = Math.max(t, timer.at);
        await timer.fn();
        await flush();
      }
      t = target;
      await flush();
    },
  };
}

const monitor = (i, extra = {}) => ({
  id: `mon-${String(i).padStart(12, '0')}`,
  name: `m${i}`,
  type: 'tcp',
  target: { host: 'h', port: 1 },
  intervalMs: 60_000,
  timeoutMs: 5_000,
  enabled: true,
  nextCheck: null,
  status: 'pending',
  ...extra,
});

test('only due monitors run, and each one runs at its own interval', async () => {
  const clock = fakeClock();
  const ran = [];
  const s = createScheduler({ clock, concurrency: 4, jitterMs: 0, onDue: async (m) => { ran.push(`${m.id}@${clock.now()}`); } });
  const a = monitor(1, { nextCheck: clock.now() + 10_000 });
  const b = monitor(2, { nextCheck: clock.now() + 120_000 });
  s.sync([a, b]);
  s.start();
  await clock.advance(15_000);
  assert.deepEqual(ran, [`${a.id}@1010000`], 'only the due monitor ran');
  await clock.advance(60_000);
  assert.equal(ran.length, 2, 'the interval came round again');
  assert.ok(ran.every((r) => r.startsWith(a.id)), 'the second monitor is still not due');
  await clock.advance(60_000);
  assert.equal(ran.filter((r) => r.startsWith(b.id)).length, 1, 'the long-interval monitor ran exactly once');
  await s.stop();
});

test('a stored nextCheck in the past makes a monitor due at the first tick (restart-safety)', async () => {
  const clock = fakeClock();
  const ran = [];
  const s = createScheduler({ clock, concurrency: 4, jitterMs: 0, onDue: async (m) => { ran.push(m.id); } });
  // this is what a restart looks like: the engine loads monitors whose nextCheck predates the boot
  s.sync([monitor(1, { nextCheck: clock.now() - 3_600_000 }), monitor(2, { nextCheck: clock.now() - 30_000 })]);
  s.start();
  await clock.advance(100);
  assert.equal(ran.length, 2, 'both overdue monitors were picked up');
  await s.stop();
});

test('concurrency is bounded, however many monitors are due', async () => {
  const clock = fakeClock();
  let live = 0;
  let peak = 0;
  const done = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = createScheduler({
    clock, concurrency: 2, jitterMs: 0,
    onDue: async (m) => { live += 1; peak = Math.max(peak, live); await gate; live -= 1; done.push(m.id); },
  });
  s.sync([1, 2, 3, 4, 5].map((i) => monitor(i, { nextCheck: clock.now() })));
  s.start();
  await clock.advance(100);
  assert.equal(peak, 2, 'never more than the configured pool');
  assert.equal(live, 2);
  assert.equal(done.length, 0, 'nothing finished while the gate is closed');
  release();
  await clock.advance(100);
  assert.equal(peak <= 2, true);
  assert.equal(s.stats().maxInFlight, 2, 'the pool ceiling is observable');
  await s.stop();
});

test('a monitor that is still running is never checked twice', async () => {
  const clock = fakeClock();
  let calls = 0;
  let live = 0;
  let peak = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = createScheduler({
    clock, concurrency: 4, jitterMs: 0,
    onDue: async () => { calls += 1; live += 1; peak = Math.max(peak, live); await gate; live -= 1; },
  });
  s.sync([monitor(1, { nextCheck: clock.now(), intervalMs: 1_000 })]);
  s.start();
  await clock.advance(5_000);
  assert.equal(calls, 1, 'the long check did not stack up, even though its interval passed four times');
  release();
  await clock.advance(5_000);
  assert.ok(calls >= 2, 'and once it finished, the next interval ran');
  assert.equal(peak, 1, 'two checks for one monitor never overlapped');
  await s.stop();
});

test('the scheduler frees a worker when a check overruns its own deadline', async () => {
  const clock = fakeClock();
  let started = 0;
  const s = createScheduler({
    clock, concurrency: 1, jitterMs: 0, stopGraceMs: 50,
    onDue: async () => { started += 1; return new Promise(() => { /* never resolves */ }); },
  });
  s.sync([monitor(1, { nextCheck: clock.now(), timeoutMs: 1_000, intervalMs: 1_000 }), monitor(2, { nextCheck: clock.now() + 60_000, intervalMs: 1_000 })]);
  s.start();
  await clock.advance(100);
  assert.equal(started, 1);
  assert.equal(s.stats().inFlight, 1);
  // the check never resolves; its guard (timeout + 2s) must free the worker
  await clock.advance(4_000);
  assert.ok(started >= 2, 'the wedged check released its slot and the monitor was checked again');
  await clock.advance(10_000);
  await s.stop();
  assert.equal(s.stats().running, false);
});

test('jitter spreads the first checks and every interval, within its bound', async () => {
  const clock = fakeClock();
  const s = createScheduler({ clock, concurrency: 8, jitterMs: 5_000, random: () => 0.5, onDue: async () => {} });
  // through the public surface: a fresh monitor is not due immediately when jitter is set
  const fresh = monitor(3);
  s.track(fresh, { now: clock.now() });
  assert.equal(fresh.nextCheck, clock.now() + 2_500, 'the first check is offset by the jitter');
  assert.ok(fresh.nextCheck - clock.now() <= 5_000);
  await s.stop();
});

test('graceful shutdown stops arming work and waits for what is running', async () => {
  const clock = fakeClock();
  let started = 0;
  let finished = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = createScheduler({ clock, concurrency: 2, jitterMs: 0, onDue: async () => { started += 1; await gate; finished += 1; } });
  s.sync([monitor(1, { nextCheck: clock.now() }), monitor(2, { nextCheck: clock.now() })]);
  s.start();
  await clock.advance(50);
  assert.equal(started, 2);
  let stopped = false;
  const stopping = s.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false, 'stop() waits for the in-flight checks');
  release();
  await stopping;
  assert.equal(finished, 2);
  await clock.advance(10 * 60_000);
  assert.equal(started, 2, 'no new checks were started after stop()');
  assert.equal(s.stats().running, false);
});

test('forget() drops a monitor, sync() reconciles the set, enabled=false is never run', async () => {
  const clock = fakeClock();
  const ran = [];
  const s = createScheduler({ clock, concurrency: 4, jitterMs: 0, onDue: async (m) => { ran.push(m.id); } });
  const paused = monitor(2, { enabled: false, nextCheck: clock.now() - 1_000 });
  s.sync([monitor(1, { nextCheck: clock.now() - 1_000 }), paused]);
  s.start();
  await clock.advance(100);
  assert.deepEqual(ran, ['mon-000000000001'], 'a paused monitor is never checked');
  s.forget('mon-000000000001');
  s.sync([monitor(3, { nextCheck: clock.now() - 1_000 })]);
  await clock.advance(100);
  assert.deepEqual(ran, ['mon-000000000001', 'mon-000000000003']);
  assert.equal(s.stats().monitored, 1);
  await s.stop();
});

test('there is exactly one timer, whatever the monitor count', async () => {
  const clock = fakeClock();
  const s = createScheduler({ clock, concurrency: 4, jitterMs: 0, onDue: async () => {} });
  s.sync(Array.from({ length: 50 }, (_, i) => monitor(i + 1, { nextCheck: clock.now() + i * 1_000 })));
  s.start();
  await flush();
  assert.equal(clock.pending(), 1, 'a hundred monitors must not mean a hundred timers');
  assert.ok(s.stats().nextDueAt <= clock.now() + MAX_TICK_MS);
  await s.stop();
});

test('an error inside a check is contained: the pool keeps working', async () => {
  const clock = fakeClock();
  const errors = [];
  let ok = 0;
  const s = createScheduler({
    clock, concurrency: 1, jitterMs: 0,
    onDue: async (m) => { if (m.id.endsWith('1')) throw new Error('boom'); ok += 1; },
    onError: (err) => errors.push(String(err.message)),
  });
  s.sync([monitor(1, { nextCheck: clock.now(), intervalMs: 10_000 }), monitor(2, { nextCheck: clock.now() + 20_000, intervalMs: 10_000 })]);
  s.start();
  await clock.advance(25_000);
  assert.ok(errors.length >= 1 && errors.every((e) => e === 'boom'), `errors were: ${errors.join(',')}`);
  assert.ok(ok >= 1, 'the other monitor still ran');
  await s.stop();
});
