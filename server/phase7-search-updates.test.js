// Phase 7F — update check (explicit, cached, honest failures), extended search
// (alerts + infrastructure), and the palette's performance bounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine } from '../test/mock-engine.js';

const OLD_ENV = { ...process.env };
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p7f-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p7f-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const { compareVersions, checkForUpdates, lastUpdateCheck, _resetUpdateCheck } = await import('./updateCheck.js');
const { refreshAlerts, _resetAlerts } = await import('./alerts.js');
const { _resetActivity } = await import('./activity.js');

let ENGINE = null;
let handleApi;
let COOKIE = null;
let searchAll;

function req(method, body = undefined) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return {
    method,
    headers: { ...(COOKIE ? { cookie: COOKIE } : {}), ...(payload ? { 'content-length': String(payload.length) } : {}) },
    [Symbol.asyncIterator]() {
      let done = false;
      return { next: async () => (done || !payload ? { value: undefined, done: true } : (done = true, { value: payload, done: false })) };
    },
  };
}
function res() {
  const state = { status: 200, body: '' };
  return { state, setHeader: () => {}, writeHead: (s) => { state.status = s; }, end: (b) => { state.body = String(b ?? ''); } };
}
async function call(method, pathname, body) {
  const r = res();
  await handleApi(req(method, body), r, new URL(pathname, 'http://x'));
  return { status: r.state.status, json: JSON.parse(r.state.body || '{}') };
}

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  ({ handleApi } = await import('./api.js'));
  ({ searchAll } = await import('./search.js'));
  const { seedSession } = await import('../test/auth-helper.js');
  COOKIE = await seedSession();
});

test.after(async () => {
  await ENGINE?.stop();
  process.env = OLD_ENV;
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// --- version comparison ---------------------------------------------------------

test('compareVersions orders dotted versions and refuses garbage', () => {
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('v0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('latest', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0', null), 0);
});

// --- update check -----------------------------------------------------------------

test('checkForUpdates reports available/current from the release tag', async () => {
  _resetUpdateCheck();
  const newer = await checkForUpdates({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v9.9.9', html_url: 'https://example.test/r' }) }),
  });
  assert.equal(newer.state, 'available');
  assert.equal(newer.latest, '9.9.9');
  assert.ok(newer.checkedAt);

  _resetUpdateCheck();
  const { versionInfo } = await import('./version.js');
  const same = await checkForUpdates({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: `v${versionInfo().version}`, html_url: 'https://example.test/r' }) }),
  });
  assert.equal(same.state, 'current');
});

test('checkForUpdates turns every failure into unknown with a reason', async () => {
  _resetUpdateCheck();
  const offline = await checkForUpdates({ fetchImpl: async () => { throw new Error('boom'); } });
  assert.equal(offline.state, 'unknown');
  assert.match(offline.reason, /github\.com/);

  _resetUpdateCheck();
  const limited = await checkForUpdates({ fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.equal(limited.state, 'unknown');
  assert.match(limited.reason, /rate-limited/);

  _resetUpdateCheck();
  const none = await checkForUpdates({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(none.state, 'unknown');
  assert.match(none.reason, /no releases/);
});

test('checkForUpdates caches for six hours; force re-checks', async () => {
  _resetUpdateCheck();
  let calls = 0;
  const stub = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ tag_name: 'v9.9.9' }) }; };
  await checkForUpdates({ fetchImpl: stub });
  await checkForUpdates({ fetchImpl: stub });
  assert.equal(calls, 1);
  assert.ok(lastUpdateCheck());
  await checkForUpdates({ fetchImpl: stub, force: true });
  assert.equal(calls, 2);
});

test('GET /api/updates answers from cache; POST checks through the override endpoint', async () => {
  _resetUpdateCheck();
  const server = http.createServer((q, s) => {
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end(JSON.stringify({ tag_name: 'v8.8.8', html_url: 'http://127.0.0.1/releases' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.OPUSHUB_RELEASES_URL = `http://127.0.0.1:${server.address().port}/latest`;
  try {
    const before = await call('GET', '/api/updates');
    assert.equal(before.status, 200);
    assert.equal(before.json.check, null);
    assert.ok(before.json.repo && before.json.install);

    const checked = await call('POST', '/api/updates/check', {});
    assert.equal(checked.status, 200);
    assert.equal(checked.json.check.latest, '8.8.8');
    assert.equal(checked.json.check.state, 'available');

    const after = await call('GET', '/api/updates');
    assert.equal(after.json.check.latest, '8.8.8');
  } finally {
    delete process.env.OPUSHUB_RELEASES_URL;
    server.close();
  }
});

// --- extended search ----------------------------------------------------------------

test('searchAll surfaces active alerts as destinations', async () => {
  _resetAlerts();
  _resetActivity();
  refreshAlerts({
    dockerAvailable: true,
    services: [{ group: 'Media', name: 'wave', displayName: 'Wave', health: 'unhealthy', state: 'running' }],
    stacks: [], system: null, authFailures: 0,
  });
  const results = await searchAll('wave');
  const hit = results.find((r) => r.kind === 'alert');
  assert.ok(hit, 'the firing alert is indexed');
  assert.match(hit.subtitle, /unhealthy|Alert/);
  assert.ok(hit.href.includes('/services/Media/wave'), 'the alert links at its own evidence');
  _resetAlerts();
});

test('searchAll indexes infrastructure names with tab deep-links', async () => {
  const results = await searchAll('proxy');
  const infra = results.filter((r) => r.kind === 'infra');
  assert.ok(infra.some((r) => r.title === 'proxy'), 'the mock engine proxy network is indexed');
  assert.ok(infra.every((r) => r.href.startsWith('/infrastructure?tab=')));
  assert.ok(infra.every((r) => r.title && r.subtitle));
});

test('searchAll is bounded: at most 24 results, oversized needles truncated', async () => {
  const results = await searchAll('e'.repeat(500));
  assert.ok(results.length <= 24);
  assert.ok(results.every((r) => r.title && r.href && r.kind));
  const { status, json } = await call('GET', `/api/search?q=${'x'.repeat(200)}`);
  assert.equal(status, 200);
  assert.ok(json.query.length <= 80, 'the route truncates the needle');
  assert.ok(json.results.length <= 24);
});
