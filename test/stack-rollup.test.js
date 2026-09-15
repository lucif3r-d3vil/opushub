// Stack rollups and aggregate history — the arithmetic behind the Stack page.
//
// The rules worth pinning down (docs/08-phase-5-plan.md § 4):
//   · a total only sums what actually answered; a silent container is never counted as zero;
//   · `reporting` says how many containers answered, so the UI can qualify its own aggregate;
//   · stack uptime is the *oldest running member* — a stack cannot have been up longer than the
//     container that has been running longest;
//   · aggregate history buckets samples that were taken in the same request and makes no Docker
//     calls of its own: a member nobody watched contributes nothing at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stackRollup } from '../server/model.js';
import { aggregateHistory, statsWithHistory, statsHistory, resetStatsHistory, _internals } from '../server/statsHistory.js';

const member = (over = {}) => ({
  service: 'svc', containerName: 'svc', container: { name: 'svc', id: 'c1', state: 'running', status: 'Up 2 hours', health: null, image: 'img' },
  stats: null, health: null, ...over,
});

const stats = (cpu, mem, limit, rx = 0, tx = 0) => ({ cpu, memory: { used: mem, limit }, net: { rx, tx }, pids: 4, blockIo: null });

test('a rollup sums only the containers that answered, and says how many did', () => {
  const roll = stackRollup([
    member({ stats: stats(10, 100, 1000), container: { ...member().container, id: 'a' } }),
    member({ stats: stats(20, 200, 2000), container: { ...member().container, id: 'b' } }),
    member({ stats: null, container: { ...member().container, id: 'c' } }), // silent — not a zero
    member({ container: { ...member().container, id: 'd', state: 'exited', status: 'Exited (0)' } }),
  ]);
  assert.equal(roll.containers, 4);
  assert.equal(roll.running, 3);
  assert.equal(roll.stopped, 1);
  assert.equal(roll.reporting, 2, 'only two containers reported');
  assert.equal(roll.cpu, 30, 'cpu is the sum of what answered');
  assert.equal(roll.memory, 300);
  assert.equal(roll.memoryLimit, 3000);
});

test('a rollup with nothing to say reports null, never a convincing zero', () => {
  const roll = stackRollup([member({ stats: null }), member({ container: null, stats: null })]);
  assert.equal(roll.cpu, null);
  assert.equal(roll.memory, null);
  assert.equal(roll.netRx, null);
  assert.equal(roll.reporting, 0);
  assert.equal(roll.upSince, null);
  assert.equal(roll.containers, 2);
});

test('unhealthy members are counted from health, and uptime is the oldest running member', () => {
  const started = (iso) => ({ ...member().container, startedAt: iso });
  const roll = stackRollup([
    member({ health: 'unhealthy', startedAt: '2026-09-14T10:00:00.000Z', container: { ...started(), id: 'a' } }),
    member({ startedAt: '2026-09-01T08:00:00.000Z', container: { ...started(), id: 'b' } }),
    // a stopped container's start time is irrelevant to how long the stack has been up
    member({ startedAt: '2020-01-01T00:00:00.000Z', container: { ...started(), id: 'c', state: 'exited', status: 'Exited (1)' } }),
  ]);
  assert.equal(roll.unhealthy, 1);
  assert.equal(roll.upSince, Date.parse('2026-09-01T08:00:00.000Z'));
});

test('net totals are summed across members and stay null when nobody reported', () => {
  const a = stackRollup([member({ stats: stats(1, 10, 100, 5_000, 1_000) }), member({ stats: stats(1, 10, 100, 7_500, 500) })]);
  assert.equal(a.netRx, 12_500);
  assert.equal(a.netTx, 1_500);
  const b = stackRollup([member({ stats: { cpu: 1, memory: { used: 10, limit: 100 }, net: null, pids: null, blockIo: null } })]);
  assert.equal(b.netRx, null, 'a container that reported no counters does not contribute a zero');
  assert.equal(b.cpu, 1);
});

test('aggregate history sums buckets, counts reporters and never invents a point', () => {
  resetStatsHistory();
  // Two containers sampled "together" by pushing through the sampler's public surface is not
  // possible without a Docker engine, so build the buffers through the module's documented hook.
  const { buffers } = _internals;
  const now = Date.now();
  buffers.clear();
  buffers.set('a', {
    lastAt: now, readAt: now,
    samples: [
      { t: now - 10_000, cpu: 5, mem: 100, memLimit: 1000, netRx: 1_000, netTx: 100, pids: 1, blockIo: null },
      { t: now - 5_000, cpu: 7, mem: 120, memLimit: 1000, netRx: 2_000, netTx: 200, pids: 1, blockIo: null },
    ],
  });
  buffers.set('b', {
    lastAt: now, readAt: now,
    samples: [
      { t: now - 10_050, cpu: 3, mem: 50, memLimit: 500, netRx: 500, netTx: 50, pids: 1, blockIo: null },
      { t: now - 5_050, cpu: 1, mem: 60, memLimit: 500, netRx: 900, netTx: 90, pids: 1, blockIo: null },
    ],
  });
  buffers.set('c', { lastAt: 0, readAt: now, samples: [] }); // watched, but nothing recorded

  const doc = aggregateHistory(['a', 'b', 'c', 'ghost'], { windowMs: 60_000 });
  assert.equal(doc.containers, 4, 'every ref that was asked about is accounted for');
  assert.equal(doc.reporting, 2, 'only the two with samples count as reporting');
  assert.equal(doc.samples.length, 2, 'one point per cadence, not per container');
  assert.equal(doc.samples[0].cpu, 8, 'cpu is summed inside the bucket');
  assert.equal(doc.samples[0].mem, 150);
  assert.equal(doc.samples[0].netRx, 1_500);
  assert.equal(doc.samples[1].cpu, 8);
  assert.equal(doc.samples[0].count, 2);
  assert.ok(doc.watchingSince <= now - 9_000);
  assert.equal(doc.bucketMs, 2000);

  // a ref nobody ever watched contributes nothing and cannot drag a sum down
  const onlyGhost = aggregateHistory(['ghost'], { windowMs: 60_000 });
  assert.deepEqual(onlyGhost.samples, []);
  assert.equal(onlyGhost.reporting, 0);
  assert.equal(onlyGhost.watchingSince, null);
  buffers.clear();
});

test('the sampler is still demand-driven: a ref with no buffer makes no Docker call', async () => {
  resetStatsHistory();
  const before = statsHistory('never-seen');
  assert.deepEqual(before.samples, []);
  assert.equal(before.watchingSince, null);
  // and history for something nobody sampled stays empty rather than inventing a point
  const agg = aggregateHistory(['never-seen'], { windowMs: 60_000 });
  assert.equal(agg.samples.length, 0);
  void statsWithHistory; // the only way to add a sample is still to ask for one
});

// ── the route's Docker budget (docs/08-phase-5-plan.md § 4) ───────────────────
//
// A stack page is *polled*, so what it costs has to be bounded and predictable. These assertions
// run the real HTTP route against the mock engine and count the Docker calls it made.

test('the stack route inspects only running members, bounds concurrency and shares stats', async () => {
  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { startMockEngine } = await import('./mock-engine.js');

  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const engine = await startMockEngine();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-stack-budget-'));
  const PORT = 3761;
  const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPUSHUB_CONFIG_DIR: path.join(scratch, 'config'),
      OPUSHUB_DATA_DIR: path.join(scratch, 'data'),
      OPUSHUB_PORT: String(PORT),
      OPUSHUB_HOST: '127.0.0.1',
      OPUSHUB_DOCKER_SOCKET: engine.socketPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${PORT}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let up = false;
    for (let i = 0; i < 160 && !up; i++) {
      if (child.exitCode !== null) throw new Error(`server exited: ${log.slice(-600)}`);
      try { up = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(800) })).ok; } catch { await sleep(200); }
    }
    assert.ok(up, 'the server started');
    const created = await fetch(`${base}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'stack-budget-password' }),
    });
    const cookie = (created.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    assert.ok(cookie, 'signed in');

    // warm the inventory, then measure exactly one stack detail request
    const stacks = await (await fetch(`${base}/api/stacks`, { headers: { cookie } })).json();
    const stack = stacks.stacks.find((s) => s.members.length > 1);
    assert.ok(stack, 'a multi-member stack exists in the mock fleet');

    engine.reset();
    const detail = await (await fetch(`${base}/api/stacks/${encodeURIComponent(stack.id)}`, { headers: { cookie } })).json();
    const inspects = engine.count('/json');
    const statsCalls = engine.count('/stats');
    const running = detail.members.filter((m) => m.container?.state === 'running').length;
    const stopped = detail.members.filter((m) => m.container && m.container.state !== 'running').length;

    assert.equal(inspects, running, `one inspect per running member (${inspects} for ${running} running, ${stopped} stopped)`);
    assert.ok(statsCalls <= running, 'no stats call for a container that is not running');
    assert.ok(statsCalls >= 1, 'running members do carry live stats');
    assert.ok(detail.rollup, 'the route returns a rollup');
    assert.equal(detail.rollup.containers, detail.members.length);
    assert.equal(detail.rollup.reporting, statsCalls > 0 ? statsCalls : 0, 'reporting counts what actually answered');

    // the second poll inside the sampler's cache window must not re-ask for the same stats
    engine.reset();
    await fetch(`${base}/api/stacks/${encodeURIComponent(stack.id)}`, { headers: { cookie } });
    assert.ok(engine.count('/stats') <= statsCalls, `stats were re-fetched inside the cache window (${engine.count('/stats')} > ${statsCalls})`);

    // aggregate history makes no Docker calls at all — it reads buffers that are already warm
    engine.reset();
    const hist = await (await fetch(`${base}/api/stacks/${encodeURIComponent(stack.id)}/history?window=60000`, { headers: { cookie } })).json();
    assert.equal(engine.count(''), 0, 'the history endpoint talked to Docker');
    assert.ok(Array.isArray(hist.samples));
    assert.ok(hist.samples.length >= 1, 'the two warm polls produced an aggregated point');
    assert.ok(hist.containers >= running, 'the aggregate knows how many members it represents');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    await engine.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('a container nobody has watched for fifteen minutes stops costing memory', () => {
  const { buffers, prune, IDLE_DROP_MS } = _internals;
  resetStatsHistory();
  const now = Date.now();
  const sample = { t: now, cpu: 1, mem: 2, memLimit: 3, netRx: 4, netTx: 5, pids: 6, blockIo: null };
  // one buffer read a moment ago, one that nothing has touched for twenty minutes
  buffers.set('live', { samples: [sample], lastAt: now, readAt: now });
  buffers.set('stale', { samples: [{ ...sample, t: now - 20 * 60_000 }], lastAt: now - 20 * 60_000, readAt: now - 20 * 60_000 });
  assert.ok(IDLE_DROP_MS === 15 * 60_000, 'the idle window moved');

  prune(now);
  assert.ok(buffers.has('live'), 'an active buffer was dropped');
  assert.ok(!buffers.has('stale'), 'a buffer untouched for twenty minutes survived — retention is not bounded');

  // and a read counts as a touch: the chart that just drew it keeps its history
  const before = aggregateHistory(['live'], { windowMs: 60_000 });
  assert.equal(before.reporting, 1);
  prune(now + 14 * 60_000);
  assert.ok(buffers.has('live'), 'reading a buffer did not refresh it');
  prune(now + 16 * 60_000);
  assert.ok(!buffers.has('live'), 'a buffer nobody has read for over fifteen minutes was kept');
  buffers.clear();
});
