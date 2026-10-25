// The Uptime ribbons: pure segment logic, and GET /api/monitoring/ribbons through the real gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRibbons, segmentState, segmentsFor, summarise } from './monitoringRibbons.js';
import { startMockEngine } from '../test/mock-engine.js';

const HOUR = 3_600_000;
const MIN = 60_000;
const at = Math.floor(Date.now() / HOUR) * HOUR + 40 * MIN;          // 40 minutes into an hour
const sample = (t, k = 'ok', ms = 50) => ({ t, k, ms: k === 'unknown' ? null : ms, code: k === 'ok' ? 200 : null });
const hour = (h, over = {}) => ({ h, ok: 60, degraded: 0, fail: 0, unknown: 0, msSum: 3000, msCount: 60, msMin: 40, msMax: 80, ...over });

test('a segment is down when most judged checks failed, unhealthy when some did, and unknown with no verdict', () => {
  assert.equal(segmentState({ ok: 9, degraded: 0, fail: 0 }), 'ok');
  assert.equal(segmentState({ ok: 8, degraded: 1, fail: 0 }), 'degraded');
  assert.equal(segmentState({ ok: 8, degraded: 0, fail: 1 }), 'degraded', 'one failed check in nine is not "down"');
  assert.equal(segmentState({ ok: 2, degraded: 0, fail: 3 }), 'fail');
  assert.equal(segmentState({ ok: 0, degraded: 0, fail: 0 }), 'unknown');
});

test('24 h: raw checks on a 5-minute grid, hourly buckets for the part older than the ring, and a gap where nothing was recorded', () => {
  const from = at - 24 * HOUR;
  const ringStart = at - 3 * HOUR;
  const ring = [];
  for (let t = ringStart; t <= at; t += MIN) ring.push(sample(t, t > at - 20 * MIN && t < at - 10 * MIN ? 'fail' : 'ok'));
  const hours = [];
  for (let h = Math.floor((at - 10 * HOUR) / HOUR) * HOUR; h + HOUR <= ringStart; h += HOUR) hours.push(hour(h));
  const segs = segmentsFor({ samples: ring, hours }, { from, to: at, stepMs: 5 * MIN });
  assert.ok(segs[0].a >= at - 10 * HOUR - HOUR, 'nothing is drawn before the first recorded hour');
  const coarse = segs.filter((s) => s.b - s.a === HOUR);
  const fine = segs.filter((s) => s.b - s.a === 5 * MIN);
  assert.ok(coarse.length >= 6 && coarse.every((s) => s.b <= ringStart), 'hourly buckets stop where the raw ring begins');
  assert.ok(fine.length >= 30, `raw checks give 5-minute segments (${fine.length})`);
  assert.ok(fine.some((s) => s.k === 'fail') && fine.some((s) => s.k === 'ok'), 'a failure window is drawn as a different state');
  for (let i = 1; i < segs.length; i++) assert.ok(segs[i].a >= segs[i - 1].b - 1, 'segments never overlap');
  assert.equal(segmentsFor({ samples: [], hours: [] }, { from, to: at, stepMs: 5 * MIN }).length, 0, 'no history is no segments, not a green bar');
});

test('7 d is the hourly buckets only, and a bucket with no verdict is unknown, never up', () => {
  const hours = [hour(at - 3 * HOUR), hour(at - 2 * HOUR, { ok: 0, unknown: 12, msSum: 0, msCount: 0 }), hour(at - HOUR, { ok: 30, fail: 30 })];
  const ring = [sample(at - 5 * MIN)];
  const segs = segmentsFor({ samples: ring, hours }, { from: at - 7 * 24 * HOUR, to: at, stepMs: HOUR });
  assert.deepEqual(segs.map((s) => s.k), ['ok', 'unknown', 'fail']);
  assert.equal(segs[1].ms, null, 'no latency is invented for an hour without measurements');
});

test('slow means everything answered, but over the threshold; uptime counts ok over judged checks only', () => {
  const entry = { samples: [], hours: [hour(at - 2 * HOUR, { msSum: 60 * 2500, msCount: 60 }), hour(at - HOUR, { ok: 50, degraded: 10 }), hour(at - 3 * HOUR, { ok: 0, unknown: 10, msSum: 0, msCount: 0 })] };
  const segs = segmentsFor(entry, { from: at - 7 * 24 * HOUR, to: at, stepMs: HOUR, slowMs: 1000 });
  assert.equal(segs.find((s) => s.a === at - 2 * HOUR).slow, true);
  assert.equal(segs.find((s) => s.a === at - HOUR).slow, false, 'an unhealthy hour is not also "slow"');
  const sum = summarise(segs);
  assert.equal(sum.judged, 120);
  assert.equal(sum.uptimePct, Math.round((110 / 120) * 10_000) / 100, 'degraded checks and unknown hours are not counted as up');
  assert.equal(summarise([]).uptimePct, null, 'no data is null, not 100');
});

test('buildRibbons: summary, incidents in range, and one row per monitor with its own state', () => {
  const monitors = [
    { id: 'mon-aaaaaa', name: 'Up one', type: 'http', enabled: true, latencyMs: 40, target: { service: { group: 'g', name: 'up-one' } }, intervalMs: 60000 },
    { id: 'mon-bbbbbb', name: 'Down one', type: 'tcp', enabled: true, latencyMs: null, target: {}, intervalMs: 60000 },
    { id: 'mon-cccccc', name: 'New one', type: 'http', enabled: true, latencyMs: null, target: {}, intervalMs: 60000 },
  ];
  const history = new Map([
    ['mon-aaaaaa', { samples: [sample(at - MIN)], hours: [hour(at - HOUR)] }],
    ['mon-bbbbbb', { samples: [sample(at - MIN, 'fail')], hours: [hour(at - HOUR, { ok: 0, fail: 60, msSum: 0, msCount: 0 })] }],
  ]);
  const status = { 'mon-aaaaaa': 'up', 'mon-bbbbbb': 'down', 'mon-cccccc': 'pending' };
  const incidents = [
    { id: 'i1', monitorId: 'mon-bbbbbb', startedAt: at - 30 * MIN, status: 'open', recoveredAt: null },
    { id: 'i2', monitorId: 'mon-aaaaaa', startedAt: at - 40 * HOUR, status: 'resolved', recoveredAt: at - 39 * HOUR },
  ];
  const doc = buildRibbons({ monitors, history, incidents }, {
    range: '24h', at, slowMs: 1000,
    publicMonitor: (m) => ({ status: status[m.id] }),
    publicIncident: (i) => ({ id: i.id, monitorId: i.monitorId, startedAt: i.startedAt, recoveredAt: i.recoveredAt, open: i.status !== 'resolved' }),
  });
  assert.deepEqual(doc.monitors.map((m) => m.status), ['up', 'down', 'pending']);
  assert.equal(doc.monitors[2].segments.length, 0, 'a monitor with no history has no segments');
  assert.equal(doc.monitors[2].coverageFrom, null);
  assert.equal(doc.summary.monitors, 3);
  assert.deepEqual([doc.summary.up, doc.summary.slow, doc.summary.down], [1, 0, 1]);
  assert.equal(doc.incidents.length, 1, 'an incident that ended before the window is not listed');
  assert.equal(doc.summary.downtimeMs, 30 * MIN, 'downtime is the ongoing incident up to now');
  assert.equal(doc.summary.uptimePct, 50, '61 ok of 122 judged checks across the two monitors');
});

// ---- through the real gates ------------------------------------------------------------------
const OLD_ENV = { ...process.env };
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-ribbons-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-ribbons-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;
let ENGINE; let handleApi; let engine; let COOKIE;

async function call(method, pathname, body, cookie = COOKIE) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, headers: { host: 'opushub.test', origin: 'http://opushub.test', ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
  const out = { status: 200, body: '' };
  await handleApi(req, { setHeader() {}, writeHead: (s) => { out.status = s; }, end: (b) => { out.body = String(b ?? ''); } }, new URL(pathname, 'http://opushub.test'));
  return { status: out.status, json: JSON.parse(out.body || 'null') };
}

test.describe('the route', () => {
  test.before(async () => {
    ENGINE = await startMockEngine();
    process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
    delete process.env.DOCKER_HOST;
    ({ handleApi } = await import('./api.js'));
    engine = await import('./monitoring/engine.js');
    COOKIE = await (await import('../test/auth-helper.js')).seedSession();
    await engine._wipeMonitoring();
    await engine.start({ autoStart: false });
  });
  test.after(async () => {
    await engine?.stop(); await ENGINE?.stop(); process.env = OLD_ENV;
    fs.rmSync(CONFIG_DIR, { recursive: true, force: true }); fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  test('it needs a session, and it is a plain read of recorded data', async () => {
    assert.equal((await call('GET', '/api/monitoring/ribbons', undefined, null)).status, 401);
    const empty = await call('GET', '/api/monitoring/ribbons');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.monitors, []);
    assert.equal(empty.json.summary.uptimePct, null, 'no monitors, no uptime figure');
    assert.equal(empty.json.range, '24h');
    assert.equal((await call('GET', '/api/monitoring/ribbons?range=nonsense')).json.range, '24h', 'an unknown range falls back to 24 h');
  });

  test('it reads what the engine recorded for both ranges, with the slow threshold from settings', async () => {
    const created = await call('POST', '/api/monitoring/monitors', { name: 'Fixture', type: 'http', target: { url: 'http://10.0.0.9:8096/' }, intervalMs: 30_000, timeoutMs: 2000 });
    const id = created.json.monitor.id;
    const now = Date.now();
    const s = engine._internals.state;
    s.history.set(id, { samples: [{ t: now - 60_000, k: 'ok', ms: 2500, code: 200 }, { t: now - 30_000, k: 'ok', ms: 2600, code: 200 }], hours: [{ h: Math.floor(now / HOUR) * HOUR, ok: 2, degraded: 0, fail: 0, unknown: 0, msSum: 5100, msCount: 2, msMin: 2500, msMax: 2600 }] });
    const r24 = (await call('GET', '/api/monitoring/ribbons?range=24h')).json;
    assert.equal(r24.slowMs, 1000);
    assert.equal(r24.monitors.length, 1);
    assert.equal(r24.monitors[0].segments.length, 1);
    assert.equal(r24.monitors[0].segments[0].slow, true, '2.5 s is over the 1 s threshold');
    const r7 = (await call('GET', '/api/monitoring/ribbons?range=7d')).json;
    assert.equal(r7.stepMs, HOUR);
    assert.equal(r7.monitors[0].segments[0].ms, 2550);
    await call('PUT', '/api/settings', { monitoring: { slowMs: 5000 } });
    assert.equal((await call('GET', '/api/monitoring/ribbons?range=24h')).json.monitors[0].segments[0].slow, false, 'raising the threshold clears slow');
    assert.equal((await call('PUT', '/api/settings', { monitoring: { slowMs: 5 } })).json.monitoring.slowMs, 100, 'the threshold is bounded');
  });
});
