// Model tests — service status mapping, stack discovery merge, and edge cases (§19).
// Live joins run against the mock engine; pure mapping is tested with canned containers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockEngine } from '../test/mock-engine.js';

const OLD_ENV = { ...process.env };
let ENGINE = null;

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  // model + configStore resolve paths at import; import after env is set
  const model = await import('./model.js');
  globalThis.__model = model;
});

test.after(async () => {
  await ENGINE?.stop();
  process.env = OLD_ENV;
});

const model = () => globalThis.__model;
const C = (name, state, extra = {}) => ({
  id: 'abc123def456', name, image: `${name}:latest`, state, status: `Up (${state})`, health: null,
  labels: {}, ports: [], ...extra,
});

// --- serviceStatus: every container state maps to an honest UI state ----------

test('serviceStatus maps running/stopped/paused/restarting/unhealthy', () => {
  const m = model();
  const svc = { name: 'x', container: 'x' };
  assert.equal(m.serviceStatus(svc, [C('x', 'running')]).state, 'up');
  assert.equal(m.serviceStatus(svc, [C('x', 'running', { health: 'unhealthy' })]).state, 'unhealthy');
  assert.equal(m.serviceStatus(svc, [C('x', 'running', { health: 'healthy' })]).state, 'up');
  assert.equal(m.serviceStatus(svc, [C('x', 'exited')]).state, 'down');
  assert.equal(m.serviceStatus(svc, [C('x', 'paused')]).state, 'paused');
  assert.equal(m.serviceStatus(svc, [C('x', 'restarting')]).state, 'restarting');
  assert.equal(m.serviceStatus(svc, [C('x', 'created')]).state, 'created');
  assert.equal(m.serviceStatus(svc, [C('other', 'running')]).state, 'unmanaged');
});

test('serviceStatus without an engine is unavailable with the public reason', () => {
  const m = model();
  const st = m.serviceStatus({ name: 'x' }, null);
  assert.equal(st.state, 'unavailable');
  assert.doesNotMatch(st.reason || '', /\.sock/);
});

test('container matching prefers explicit ref, then name, then compose service', async () => {
  const m = model();
  const { containers } = await m.dockerContainers({ refreshMs: 0 });
  assert.ok(containers.length > 0);
  // explicit container field in services.yaml (jellyfin) must resolve
  const { groups } = await m.getServicesWithStatus();
  const stream = groups.flatMap((g) => g.services).find((s) => s.name === 'Stream');
  assert.ok(stream, 'Stream service exists in fixture config');
  assert.equal(stream.status, 'up');
  assert.equal(stream.statusDetail.name, 'jellyfin');
  const docs = groups.flatMap((g) => g.services).find((s) => s.name === 'Docs');
  assert.equal(docs.status, 'down'); // paperless fixture is exited
});

// --- stacks document ----------------------------------------------------------

test('getStacksDoc merges configured + discovered + standalone', async () => {
  const m = model();
  const doc = await m.getStacksDoc();
  assert.equal(doc.live, true);
  assert.equal(doc.statusReason, null);
  const byName = new Map(doc.stacks.map((s) => [s.name, s]));
  // configured stacks keep their identity and link live containers
  const media = byName.get('Media');
  assert.ok(media);
  assert.equal(media.source, 'configured');
  assert.ok(media.containerCount >= 2);
  assert.ok(['operational', 'degraded'].includes(media.status));
  // mock projects that collide with configured names are absorbed, not duplicated
  const names = doc.stacks.map((s) => s.name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  // standalone containers surface separately, never force-fit into a stack
  assert.ok(doc.standalone.some((c) => c.name === 'traefik'));
  assert.ok(doc.standalone.some((c) => c.name.startsWith('nightly-backup')));
  assert.ok(!doc.standalone.some((c) => c.name === 'jellyfin'));
});

test('getStacksDoc without an engine is config-only with a public reason', async () => {
  const m = model();
  process.env.OPUSHUB_DOCKER_SOCKET = '/tmp/opushub-absent-for-model-test.sock';
  const doc = await m.dockerContainers({ refreshMs: 0 }).then(() => m.getStacksDoc());
  assert.equal(doc.live, false);
  assert.ok(doc.statusReason && !doc.statusReason.includes('/tmp/'));
  assert.deepEqual(doc.standalone, []);
  assert.ok(doc.stacks.every((s) => s.status === 'unavailable'));
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
});

test('enrichStackMembers adds inspect detail per member', async () => {
  const m = model();
  await m.dockerContainers({ refreshMs: 0 }); // drop the unavailable cache from the prior test
  const doc = await m.getStacksDoc();
  const media = doc.stacks.find((s) => s.name === 'Media');
  const members = await m.enrichStackMembers(media);
  const jf = members.find((x) => x.container?.name === 'jellyfin');
  assert.ok(jf.ports.length >= 2);
  assert.ok(jf.networks.length >= 1);
  assert.ok(jf.mounts.length >= 1);
  assert.ok(jf.stats && jf.stats.cpu != null);
  assert.ok(jf.startedAt);
});

// --- edge cases (§19): no containers, one container, odd shapes ---------------

test('edge: empty fleet degrades every stack to unlinked, not error', () => {
  const m = model();
  const st = m.serviceStatus({ name: 'x' }, []);
  assert.equal(st.state, 'unmanaged');
});

test('stackStatus matrix: live/empty/mixed/offline', () => {
  const m = model();
  const run = { state: 'running' };
  const stop = { state: 'exited' };
  assert.equal(m.stackStatus([run, run], true), 'operational');
  assert.equal(m.stackStatus([run, stop], true), 'degraded');
  assert.equal(m.stackStatus([stop, stop], true), 'attention');
  assert.equal(m.stackStatus([null, null], true), 'unlinked');
  assert.equal(m.stackStatus([], true), 'unlinked'); // engine up, zero containers
  assert.equal(m.stackStatus([run], false), 'unavailable'); // engine down
  assert.equal(m.stackStatus([], false), 'unavailable');
});

test('edge: containers with missing/odd fields do not crash status', () => {
  const m = model();
  const weird = [
    { id: '1', name: 'a', image: null, state: 'running', status: '', health: undefined, labels: null, ports: null },
    { id: '2', name: 'b', state: 'exited', status: null },
  ];
  assert.equal(m.serviceStatus({ name: 'a', container: 'a' }, weird).state, 'up');
  assert.equal(m.serviceStatus({ name: 'b', container: 'b' }, weird).state, 'down');
});
