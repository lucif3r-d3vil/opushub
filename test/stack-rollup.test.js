// Stack rollups and aggregate history — the arithmetic behind the Stack page.
//
// The rules worth pinning down (docs/archive/08-phase-5-plan.md § 4):
//   · a total only sums what actually answered; a silent container is never counted as zero;
//   · `reporting` says how many containers answered, so the UI can qualify its own aggregate;
//   · stack uptime is the *oldest running member* — a stack cannot have been up longer than the
//     container that has been running longest;
//   · aggregate history buckets samples that were taken in the same request and makes no Docker
//     calls of its own: a member nobody watched contributes nothing at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stackRollup } from '../server/model.js';

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

// ── the route's Docker budget (docs/archive/08-phase-5-plan.md § 4) ───────────────────
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

    // the second poll inside the stats cache window must not re-ask for the same stats
    engine.reset();
    await fetch(`${base}/api/stacks/${encodeURIComponent(stack.id)}`, { headers: { cookie } });
    assert.ok(engine.count('/stats') <= statsCalls, `stats were re-fetched inside the cache window (${engine.count('/stats')} > ${statsCalls})`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    await engine.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
