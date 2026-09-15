// Phase 7B — infrastructure API: /api/host, /api/docker, /api/networks, /api/volumes,
// /api/images, /api/storage, /api/version, /api/v1/* aliases, and degraded-mode lastKnown.
// Calls handleApi directly with stub req/res; docker joins run against the mock engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine } from '../test/mock-engine.js';

const OLD_ENV = { ...process.env };
let ENGINE = null;
let handleApi;
let COOKIE = null;

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p7infra-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p7infra-data-'));

function req(method, p, body = null) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return {
    method,
    headers: { ...(COOKIE ? { cookie: COOKIE } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
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

test('GET /api/host: canonical shape with engine, traefik and version', async () => {
  const { status, json } = await get('/api/host');
  assert.equal(status, 200);
  assert.ok(json.host.hostname);
  assert.equal(json.docker.version, '26.1.0-mock');
  assert.equal(json.traefik.detected, true);
  assert.equal(json.opushub.name, 'OpusHub');
  assert.ok(json.address.effective);
});

test('GET /api/docker: engine status plus inventory counts', async () => {
  const { status, json } = await get('/api/docker');
  assert.equal(status, 200);
  assert.equal(json.status.ok, true);
  assert.ok(json.counts.containers > 0);
  assert.ok(json.counts.networks >= 3);
  assert.ok(json.counts.volumes >= 3);
  assert.ok(json.counts.images >= 1);
  assert.equal(json.live, true);
});

test('GET /api/networks|volumes|images: live slices with counts', async () => {
  const n = await get('/api/networks');
  assert.equal(n.json.live, true);
  assert.ok(n.json.networks.some((x) => x.name === 'proxy'));
  const v = await get('/api/volumes');
  assert.equal(v.json.live, true);
  assert.ok(v.json.volumes.some((x) => x.name === 'jellyfin-config'));
  const i = await get('/api/images');
  assert.equal(i.json.live, true);
  assert.ok(i.json.images.length >= 1);
  const blob = JSON.stringify([n.json, v.json, i.json]);
  assert.doesNotMatch(blob, /Mountpoint/);
  assert.doesNotMatch(blob, /\/var\/lib\/docker/);
  assert.doesNotMatch(blob, /hunter2/);
});

test('GET /api/storage + /api/version: providers and build identity', async () => {
  const s = await get('/api/storage');
  assert.deepEqual(s.json.providers.map((p) => p.id), ['filesystem', 'zfs']);
  const v = await get('/api/version');
  assert.equal(v.json.name, 'OpusHub');
  assert.ok(v.json.version);
});

test('/api/v1/* mirrors the unversioned shapes exactly', async () => {
  for (const name of ['host', 'docker', 'networks', 'volumes', 'images', 'storage', 'version']) {
    const a = await get(`/api/${name}`);
    const b = await get(`/api/v1/${name}`);
    assert.equal(b.status, 200, name);
    assert.deepEqual(Object.keys(b.json).sort(), Object.keys(a.json).sort(), name);
  }
});

test('/api/v1 refuses routes that were not deliberately versioned', async () => {
  // handleApi throws its 404 (index.js renders it); the point is v1 lends no alias.
  for (const name of ['health', 'auth/me', 'settings', 'activity']) {
    await assert.rejects(() => get(`/api/v1/${name}`), /no route: GET \/api\/v1\//, name);
  }
});

test('degraded mode: dead engine serves labelled last-known state, never live data', async () => {
  // One live pass first, so there IS a last-known state to serve.
  await get('/api/services');
  await get('/api/networks');
  process.env.OPUSHUB_DOCKER_SOCKET = '/tmp/opushub-p7infra-dead.sock';
  const { invalidateDiscovery, _resetLastKnown } = await import('./model.js');
  void _resetLastKnown;
  invalidateDiscovery();
  const { hostDocument, _resetHost } = await import('./host.js');
  void hostDocument;
  _resetHost();
  const dead = await get('/api/services');
  assert.equal(dead.json.live, false);
  assert.ok(dead.json.lastKnown, 'last-known summary is present');
  assert.ok(dead.json.lastKnown.at);
  assert.ok(dead.json.lastKnown.containers > 0);
  const nets = await get('/api/networks');
  assert.equal(nets.json.live, false);
  assert.ok(nets.json.stale, 'stale infra is labelled, not silent');
  assert.ok(nets.json.stale.networks.length >= 3);
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  invalidateDiscovery();
});
