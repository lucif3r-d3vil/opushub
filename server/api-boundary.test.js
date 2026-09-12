// API boundary tests — what the browser is allowed to see (§4, §21).
// Calls handleApi directly with stub req/res; docker joins run against the mock engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockEngine } from '../test/mock-engine.js';

const OLD_ENV = { ...process.env };
let ENGINE = null;
let handleApi;

function req(method, p, body = null) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return {
    method,
    headers: {},
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
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
  await handleApi(req('GET', pathname), r, new URL(pathname, 'http://x'));
  return { status: r.state.status, json: JSON.parse(r.state.body || '{}') };
}

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  ({ handleApi } = await import('./api.js'));
});

test.after(async () => {
  await ENGINE?.stop();
  process.env = OLD_ENV;
});

test('GET /api/health: connected engine reports version, no paths', async () => {
  const { json } = await get('/api/health');
  assert.equal(json.providers.docker.ok, true);
  assert.equal(json.providers.docker.version, '26.1.0-mock');
  assert.equal(json.providers.docker.state, 'connected');
});


test('GET /api/docker/status mirrors the safe shape', async () => {
  const { json } = await get('/api/docker/status');
  assert.equal(json.ok, true);
  assert.deepEqual(Object.keys(json).sort(), ['api', 'ok', 'state', 'version']);
});

test('GET /api/services: status reasons are public-safe; no env/ids leak', async () => {
  const { json } = await get('/api/services');
  assert.equal(json.live, true);
  const blob = JSON.stringify(json);
  assert.ok(!blob.includes('.sock'));
  assert.ok(!blob.includes('MOCK-FIXTURE'));
  assert.ok(!blob.includes('hunter2'));
});

test('GET /api/services/:group/:name: command is redacted end to end', async () => {
  const { json } = await get('/api/services/Security/Vault');
  assert.ok(json.container, 'vaultwarden fixture links');
  assert.match(json.container.command, /••••/);
  assert.ok(!JSON.stringify(json).includes('MOCK-FIXTURE-NOT-A-REAL-SECRET'));
  assert.ok(!('entrypoint' in json.container));
});

test('GET /api/stacks: discovered + standalone present; reasons public-safe', async () => {
  const { json } = await get('/api/stacks');
  assert.equal(json.live, true);
  assert.ok(json.stacks.some((s) => s.source === 'configured'));
  assert.ok(Array.isArray(json.standalone));
  assert.ok(json.standalone.some((c) => c.name === 'traefik'));
  assert.ok(!JSON.stringify(json).includes('.sock'));
});

test('GET /api/docker/containers/:ref/logs caps tail and validates refs', async () => {
  const ok = await get('/api/docker/containers/jellyfin/logs?tail=5');
  assert.equal(ok.json.status, 'ok');
  assert.ok(ok.json.lines.length <= 5);
  const evil = await get('/api/docker/containers/..%2F..%2Fversion/logs?tail=5');
  assert.equal(evil.json.status, 'error');
  const huge = await get('/api/docker/containers/jellyfin/logs?tail=999999');
  assert.ok(huge.json.lines.length <= 500);
});

test('GET /api/docker/containers/:ref/logs?timestamps=1 passes stamps through', async () => {
  const { json } = await get('/api/docker/containers/seerr/logs?tail=2&timestamps=1');
  assert.equal(json.status, 'ok');
  assert.ok(json.lines.every((l) => /^\d{4}-\d{2}-\d{2}T/.test(l)));
});
