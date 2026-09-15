// Phase 7D — resource model, /api/resources, and the topology join invariant.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine } from '../test/mock-engine.js';
import { resourcesDocument } from './resources.js';

test('resourcesDocument summarizes current, average and peak per resource', () => {
  const system = {
    at: 1_700_000_000_000,
    cpu: { usage: 42, cores: 8, load1: 1.2, load5: 0.9, load15: 0.5 },
    memory: { total: 8_000, available: 2_000, free: 1_000, cached: 500 },
    network: [{ name: 'eth0', rxPerSec: 1000, txPerSec: 500 }],
    gpu: { present: false },
  };
  const points = [
    { t: 1, cpu: 10, memUsedPct: 50, rx: 100, tx: 50 },
    { t: 2, cpu: 30, memUsedPct: 70, rx: 300, tx: 150 },
  ];
  const storage = { at: 1, providers: [{ id: 'filesystem', available: true, totals: { mounts: 2, total: 100, used: 40, free: 60 }, mounts: [{}, {}], at: 1 }, { id: 'zfs', available: 'not-implemented', at: 1 }] };
  const doc = resourcesDocument({ system, points, storage });
  assert.equal(doc.cpu.current, 42);
  assert.equal(doc.cpu.average, 20);
  assert.equal(doc.cpu.peak, 30);
  assert.equal(doc.memory.averagePct, 60);
  assert.equal(doc.memory.peakPct, 70);
  assert.equal(doc.network.averageRx, 200);
  assert.equal(doc.network.peakTx, 150);
  assert.equal(doc.storage.mounts, 2);
  assert.equal(doc.gpu.availability, 'unavailable');
  assert.equal(doc.gpu.reason, 'Not available');
});

test('resourcesDocument reports unavailable, never zeros, without data', () => {
  const doc = resourcesDocument({ system: null, points: [], storage: null });
  assert.equal(doc.cpu.availability, 'unavailable');
  assert.equal(doc.cpu.current, null);
  assert.equal(doc.memory.availability, 'unavailable');
  assert.equal(doc.network.current, null);
  assert.equal(doc.storage.availability, 'unavailable');
  assert.equal(doc.gpu.current, null);
});

// --- endpoint + topology join -------------------------------------------------

const OLD_ENV = { ...process.env };
let ENGINE = null;
let handleApi;
let COOKIE = null;
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p7res-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p7res-data-'));

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

test('GET /api/resources answers in the consistent resource shape', async () => {
  const { status, json } = await get('/api/resources');
  assert.equal(status, 200);
  for (const key of ['cpu', 'memory', 'network', 'storage', 'gpu']) {
    assert.ok(json[key].availability, key);
    assert.ok(json[key].source, key);
  }
  const v1 = await get('/api/v1/resources');
  assert.equal(v1.status, 200);
  assert.deepEqual(Object.keys(v1.json).sort(), Object.keys(json).sort());
});

test('topology join: every network attachment resolves to a real container', async () => {
  const nets = await get('/api/networks');
  const inv = await get('/api/services');
  assert.equal(nets.json.live, true);
  const known = new Set(inv.json.services.map((s) => s.name));
  const dangling = [];
  for (const n of nets.json.networks) {
    for (const c of n.containers) {
      if (!known.has(c.name)) dangling.push(`${n.name} → ${c.name}`);
    }
  }
  assert.deepEqual(dangling, [], 'no edge may point at a container Docker did not list');
  assert.ok(nets.json.networks.some((n) => n.containers.length > 0), 'the map is not empty');
});
