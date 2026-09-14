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
  // a named host address, so the published-port tier resolves the same way on every machine
  process.env.OPUSHUB_HOST_ADDRESS = '198.51.100.20';
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
  const { json } = await get('/api/services/Other/vaultwarden');
  assert.ok(json.container, 'vaultwarden fixture links');
  assert.match(json.container.command, /••••/);
  assert.ok(!JSON.stringify(json).includes('MOCK-FIXTURE-NOT-A-REAL-SECRET'));
  assert.ok(!('entrypoint' in json.container));
});

test('GET /api/stacks: compose projects + standalone present; reasons public-safe', async () => {
  const { json } = await get('/api/stacks');
  assert.equal(json.live, true);
  assert.ok(json.stacks.every((s) => s.project), 'every live stack is backed by a compose project');
  assert.ok(Array.isArray(json.standalone));
  assert.ok(json.standalone.some((c) => c.name === 'traefik'));
  const blob = JSON.stringify(json);
  assert.ok(!blob.includes('.sock'));
  assert.ok(!blob.includes('opt/stacks'), 'compose file paths stay server-side');
  assert.ok(!blob.includes('rawLabels'));
});

test('GET /api/services: URLs come from Docker metadata, never from a baked-in domain', async () => {
  const { json } = await get('/api/services');
  const all = json.groups.flatMap((g) => g.services);
  const seer = all.find((s) => s.name === 'seerr');
  assert.equal(seer.url, 'https://seerr.lab.internal');
  assert.equal(seer.urlSource, 'traefik');
  const radarr = all.find((s) => s.name === 'radarr');
  assert.match(radarr.url, /^https?:\/\/[^/]+:7878$/);
  assert.equal(radarr.urlSource, 'published-port');
  const sonarr = all.find((s) => s.name === 'sonarr');
  assert.equal(sonarr.url, null);
  assert.equal(sonarr.urlSource, 'none');
});

test('GET /api/discovery: counters + URL sources, no engine internals', async () => {
  const { json } = await get('/api/discovery');
  assert.equal(json.engine.ok, true);
  assert.equal(json.engine.version, '26.1.0-mock');
  assert.equal(json.engine.containers, 25);
  assert.ok(json.urlDiscovery.sources.traefik >= 4);
  assert.ok(json.inventory.applications > 0);
  const blob = JSON.stringify(json);
  assert.ok(!blob.includes('.sock') && !blob.includes('registry-mock') && !blob.includes('proxy-mock'));
});

test('GET /api/search: one canonical inventory behind search', async () => {
  const { json } = await get('/api/search?q=wave');
  const hit = json.results.find((r) => r.kind === 'service');
  assert.equal(hit.title, 'Wave', 'the opushub.displayName label is what search offers');
  assert.match(hit.href, /\/services\/.+\/navidrome$/);
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
