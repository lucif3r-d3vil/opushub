// Phase 7C — safe HTTP probing, unified health aggregation, and the per-service endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine } from '../test/mock-engine.js';
import { probeUrl, _resetProbes } from './probe.js';
import { aggregateHealth, evaluateServiceHealth } from './healthModel.js';
import { publicError, ERROR_CODES } from './errors.js';

const ok200 = async () => ({ res: { statusCode: 200, headers: {} }, latencyMs: 12 });

// --- probe: trust boundary ----------------------------------------------------

test('probe refuses untrusted URL origins without a single packet', async () => {
  _resetProbes();
  let calls = 0;
  const r = await probeUrl('http://example.com/', { source: 'user-input', fetchImpl: async () => { calls += 1; return ok200(); } });
  assert.equal(r.checked, false);
  assert.equal(r.code, 'not_checked');
  assert.equal(calls, 0);
});

test('probe refuses credential-bearing and non-http URLs', async () => {
  _resetProbes();
  const creds = await probeUrl('http://user:pass@example.com/', { source: 'manual', fetchImpl: ok200 });
  assert.equal(creds.reachable, false);
  assert.equal(creds.errorType, 'credentials');
  const scheme = await probeUrl('ftp://example.com/x', { source: 'manual', fetchImpl: ok200 });
  assert.equal(scheme.reachable, false);
  assert.equal(scheme.errorType, 'scheme');
});

test('probe reports reachability, status and latency; caches the verdict', async () => {
  _resetProbes();
  let calls = 0;
  const impl = async () => { calls += 1; return ok200(); };
  const a = await probeUrl('http://svc.lab.internal/', { source: 'traefik', fetchImpl: impl });
  assert.equal(a.checked, true);
  assert.equal(a.reachable, true);
  assert.equal(a.statusCode, 200);
  assert.equal(a.latencyMs, 12);
  const b = await probeUrl('http://svc.lab.internal/', { source: 'traefik', fetchImpl: impl });
  assert.equal(b.cached, true);
  assert.equal(calls, 1);
});

test('probe follows redirects within bounds, then stops honestly', async () => {
  _resetProbes();
  const loop = async () => ({ res: { statusCode: 302, headers: { location: '/again' } }, latencyMs: 3 });
  const r = await probeUrl('http://loop.lab.internal/', { source: 'traefik', fetchImpl: loop });
  assert.equal(r.errorType, 'redirect-limit');
  assert.ok(r.hops > 3);
  const evil = async () => ({ res: { statusCode: 302, headers: { location: 'ftp://evil.invalid/x' } }, latencyMs: 3 });
  const r2 = await probeUrl('http://hop.lab.internal/', { source: 'traefik', fetchImpl: evil });
  assert.equal(r2.errorType, 'redirect-target');
});

test('probe classifies network failures without leaking internals', async () => {
  _resetProbes();
  const refused = async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:8080'), { code: 'ECONNREFUSED' }); };
  const r = await probeUrl('http://down.lab.internal:8080/', { source: 'published-port', fetchImpl: refused });
  assert.equal(r.reachable, false);
  assert.equal(r.errorType, 'refused');
  assert.doesNotMatch(JSON.stringify(r), /10\.0\.0\.9/);
});

// --- aggregation: the state matrix ---------------------------------------------

test('a running container alone is available, never healthy', () => {
  const v = aggregateHealth({ state: 'running' });
  assert.equal(v.state, 'available');
});

test('health aggregation across the full evidence matrix', () => {
  assert.equal(aggregateHealth({ state: 'running', healthcheck: 'healthy' }).state, 'healthy');
  assert.equal(aggregateHealth({ state: 'running', healthcheck: 'unhealthy' }).state, 'unhealthy');
  assert.equal(aggregateHealth({ state: 'running', healthcheck: 'starting' }).state, 'starting');
  assert.equal(aggregateHealth({ state: 'exited' }).state, 'stopped');
  assert.equal(aggregateHealth({ state: 'dead' }).state, 'stopped');
  assert.equal(aggregateHealth({ state: 'created' }).state, 'starting');
  assert.equal(aggregateHealth({ state: 'restarting' }).state, 'starting');
  assert.equal(aggregateHealth({ state: 'paused' }).state, 'degraded');
  assert.equal(aggregateHealth({ state: null }).state, 'unknown');
  assert.equal(aggregateHealth({ state: 'running', probe: { checked: true, reachable: true, statusCode: 200 } }).state, 'healthy');
  assert.equal(aggregateHealth({ state: 'running', probe: { checked: true, reachable: true, statusCode: 500 } }).state, 'degraded');
  assert.equal(aggregateHealth({ state: 'running', probe: { checked: true, reachable: false, errorType: 'refused' } }).state, 'unreachable');
  // explicit negative evidence outranks a serving HTTP endpoint
  assert.equal(aggregateHealth({ state: 'running', healthcheck: 'unhealthy', probe: { checked: true, reachable: true, statusCode: 200 } }).state, 'unhealthy');
});

test('evaluateServiceHealth probes only trusted URL sources', async () => {
  let probed = [];
  const probeFn = async (url, opts) => { probed.push([url, opts]); return { checked: true, reachable: true, statusCode: 200, latencyMs: 5, checkedAt: new Date().toISOString(), source: opts.source }; };
  const svc = { name: 'jellyfin', displayName: 'Jellyfin', url: 'http://stream.lab.internal', urlSource: 'traefik', container: { state: 'running', health: null } };
  const r = await evaluateServiceHealth(svc, { probeFn });
  assert.equal(r.health.state, 'healthy');
  assert.equal(probed.length, 1);
  probed = [];
  const noUrl = { name: 'sonarr', displayName: 'Sonarr', url: null, urlSource: 'none', container: { state: 'running', health: null } };
  const r2 = await evaluateServiceHealth(noUrl, { probeFn });
  assert.equal(r2.health.state, 'available');
  assert.equal(r2.probe.checked, false);
  assert.equal(probed.length, 0);
});

// --- error model ----------------------------------------------------------------

test('publicError speaks in stable codes with public-safe prose', () => {
  for (const code of Object.keys(ERROR_CODES)) {
    const e = publicError(code);
    assert.equal(e.code, code);
    assert.ok(e.reason.length > 8);
  }
  assert.equal(publicError('nope').code, 'not_available');
});

// --- endpoint --------------------------------------------------------------------

const OLD_ENV = { ...process.env };
let ENGINE = null;
let handleApi;
let COOKIE = null;
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p7health-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p7health-data-'));

function req(method) {
  return { method, headers: COOKIE ? { cookie: COOKIE } : {}, [Symbol.asyncIterator]() { return { next: async () => ({ value: undefined, done: true }) }; } };
}
function res() {
  const state = { status: 200, body: '' };
  return { state, setHeader: () => {}, writeHead: (s) => { state.status = s; }, end: (b) => { state.body = String(b ?? ''); } };
}
async function get(pathname) {
  const r = res();
  await handleApi(req('GET'), r, new URL(pathname, 'http://x'));
  return { status: r.state.status, json: JSON.parse(r.state.body || '{}') };
}

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
  process.env.OPUSHUB_DATA_DIR = DATA_DIR;
  process.env.OPUSHUB_HOST_ADDRESS = '198.51.100.20';
  ({ handleApi } = await import('./api.js'));
  const { seedSession } = await import('../test/auth-helper.js');
  COOKIE = await seedSession();
});

test.after(async () => {
  await ENGINE?.stop();
  process.env = OLD_ENV;
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('GET /api/services/:group/:name/health returns a unified verdict', async () => {
  const inv = await get('/api/services');
  const svc = inv.json.services.find((s) => s.urlSource === 'traefik' && s.container.state === 'running');
  assert.ok(svc, 'fixture has a running traefik-routed service');
  const { status, json } = await get(`/api/services/${encodeURIComponent(svc.group)}/${encodeURIComponent(svc.name)}/health`);
  assert.equal(status, 200);
  assert.equal(json.service, svc.name);
  assert.ok(['healthy', 'available', 'degraded', 'unhealthy', 'unreachable', 'stopped', 'starting', 'unknown'].includes(json.health.state));
  assert.ok(json.health.evidence);
  assert.ok(json.probe);
  assert.ok(json.evaluatedAt);
});

test('degraded responses carry the structured error code', async () => {
  process.env.OPUSHUB_DOCKER_SOCKET = '/tmp/opushub-p7health-dead.sock';
  const { invalidateDiscovery } = await import('./model.js');
  invalidateDiscovery();
  const dead = await get('/api/networks');
  assert.equal(dead.json.live, false);
  assert.equal(dead.json.code, 'docker_unavailable');
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  invalidateDiscovery();
});
