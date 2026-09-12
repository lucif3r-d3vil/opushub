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

test('GET /api/services offline: live=false with the public reason', async () => {
  const { json } = await get('/api/services');
  assert.equal(json.live, false);
  assert.ok(json.statusReason && !json.statusReason.includes('/tmp/'));
  assert.ok(json.groups.every((g) => g.services.every((s) => s.status === 'unavailable')));
});

test('GET /api/stacks offline: config-only, no standalone', async () => {
  const { json } = await get('/api/stacks');
  assert.equal(json.live, false);
  assert.deepEqual(json.standalone, []);
  assert.ok(json.stacks.length > 0);
  assert.ok(json.stacks.every((s) => s.source === 'configured' && s.status === 'unavailable'));
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
