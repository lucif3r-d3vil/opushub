// API offline tests — the no-engine boundary. Runs in its own process (no mock engine)
// so the availability cache starts cold and stays offline.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OPUSHUB_DOCKER_SOCKET = '/tmp/opushub-offline-probe.sock';
delete process.env.DOCKER_HOST;

const { handleApi } = await import('./api.js');

function req(method) {
  return {
    method,
    headers: {},
    [Symbol.asyncIterator]() {
      return { next: async () => ({ value: undefined, done: true }) };
    },
  };
}

function res() {
  const headers = {};
  const state = { status: 200, headers, body: '' };
  return {
    state,
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
    writeHead: (s) => { state.status = s; },
    end: (b) => { state.body = b == null ? '' : String(b); },
  };
}

async function get(pathname) {
  const r = res();
  await handleApi(req('GET'), r, new URL(pathname, 'http://x'));
  return { status: r.state.status, json: JSON.parse(r.state.body || '{}') };
}

test('GET /api/health offline: socket-missing state, no paths anywhere', async () => {
  const { json } = await get('/api/health');
  assert.equal(json.providers.docker.ok, false);
  assert.equal(json.providers.docker.state, 'socket-missing');
  assert.ok(!JSON.stringify(json.providers.docker).includes('/tmp/'));
  assert.ok(!JSON.stringify(json.providers.docker).includes('offline-probe'));
  assert.ok(!JSON.stringify(json).includes('offline-probe'));
});

test('GET /api/services offline: nothing is displayed, and the reason is public', async () => {
  const { json } = await get('/api/services');
  assert.equal(json.live, false);
  assert.equal(json.statusSource, 'unavailable');
  assert.ok(json.statusReason && !json.statusReason.includes('/tmp/'));
  // the whole point of the discovery model: a config entry cannot render a card for a
  // container we cannot see. An empty list is honest; a phantom is not.
  assert.deepEqual(json.groups, []);
  assert.deepEqual(json.services, []);
  assert.deepEqual(json.infrastructure, []);
  assert.deepEqual(json.stats.containers === 0, true);
  // no engine → no comparison to make, so overlays are not blamed for it
  assert.deepEqual(json.unmatched, []);
});

test('GET /api/services/:group/:name offline: 404, because the service is not known to exist', async () => {
  const r = await get('/api/services/Media/jellyfin');
  assert.equal(r.status, 404);
});

test('GET /api/stacks offline: no stacks, no standalone, one clear reason', async () => {
  const { json } = await get('/api/stacks');
  assert.equal(json.live, false);
  assert.deepEqual(json.stacks, []);
  assert.deepEqual(json.standalone, []);
  assert.deepEqual(json.unmatched, []);
  assert.ok(json.statusReason && !json.statusReason.includes('/tmp/'));
});

test('GET /api/discovery offline: the diagnostic says the engine is the problem', async () => {
  const { status, json } = await get('/api/discovery');
  assert.equal(status, 200, 'the diagnostics page must work precisely when discovery is broken');
  assert.equal(json.engine.ok, false);
  assert.notEqual(json.engine.state, 'connected');
  assert.deepEqual(json.engine, { ...json.engine, containers: 0, running: 0, stopped: 0 });
  assert.equal(json.urlDiscovery.withoutUrl, 0);
  assert.equal(json.overlays.unmatched, 0);
  assert.ok(!JSON.stringify(json).includes('/tmp/'), 'no socket path in any diagnostic field');
  assert.ok(!JSON.stringify(json).toLowerCase().includes('token'));
});

test('GET /api/docker/containers offline: unavailable, public reason', async () => {
  const { json } = await get('/api/docker/containers');
  assert.equal(json.status, 'unavailable');
  assert.ok(!json.reason.includes('/tmp/'));
  assert.deepEqual(json.containers, []);
});

test('GET logs offline: unavailable, no lines', async () => {
  const { json } = await get('/api/docker/containers/jellyfin/logs?tail=5');
  assert.equal(json.status, 'unavailable');
  assert.deepEqual(json.lines, []);
});
