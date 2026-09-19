// Phase 7E — event severity/category, alert evaluation, transitions, and the feed into
// the canonical Phase 10B event bus (the old Phase 7 channel registry is gone — delivery
// is the notification center's job now).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine } from '../test/mock-engine.js';

const OLD_ENV = { ...process.env };
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p7alerts-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p7alerts-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const { classifyEvent, logEvent, readEvents, _resetActivity } = await import('./activity.js');
const { evaluateAlerts, refreshAlerts, getActiveAlerts, ackAlert, _resetAlerts, MAX_ALERTS } = await import('./alerts.js');
const { bus } = await import('./events/bus.js');

let ENGINE = null;
let handleApi;
let COOKIE = null;

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

// --- classification -----------------------------------------------------------

test('classifyEvent grades severity and category from the event type', () => {
  assert.deepEqual(classifyEvent({ source: 'docker', type: 'container.health', meta: { to: 'unhealthy' } }), { severity: 'warning', category: 'docker' });
  assert.deepEqual(classifyEvent({ source: 'docker', type: 'container.health', meta: { to: 'healthy' } }), { severity: 'info', category: 'docker' });
  assert.deepEqual(classifyEvent({ source: 'docker', type: 'container.exited', meta: { exitCode: 1 } }), { severity: 'warning', category: 'docker' });
  assert.deepEqual(classifyEvent({ source: 'system', type: 'auth.login_failed' }), { severity: 'warning', category: 'security' });
  assert.deepEqual(classifyEvent({ source: 'system', type: 'app.boot' }), { severity: 'notice', category: 'system' });
  assert.deepEqual(classifyEvent({ source: 'system', type: 'provider.unavailable' }), { severity: 'warning', category: 'docker' });
  assert.deepEqual(classifyEvent({ source: 'user', type: 'settings.updated' }), { severity: 'info', category: 'config' });
  assert.deepEqual(classifyEvent({ source: 'docker', type: 'stack.appeared' }), { severity: 'info', category: 'stack' });
  assert.deepEqual(classifyEvent({ source: 'user', type: 'service.launch' }), { severity: 'info', category: 'service' });
});

test('logEvent stamps severity/category; readEvents filters by them', () => {
  _resetActivity();
  logEvent({ source: 'docker', type: 'container.health', subject: 'db', meta: { to: 'unhealthy' } });
  logEvent({ source: 'user', type: 'settings.updated', subject: 'theme' });
  const all = readEvents({ limit: 50 });
  assert.ok(all.items.every((e) => e.severity && e.category), 'every event is classified');
  const warnings = readEvents({ limit: 50, minSeverity: 'warning' });
  assert.ok(warnings.items.length >= 1 && warnings.items.every((e) => ['warning', 'critical'].includes(e.severity)));
  assert.ok(warnings.items.some((e) => e.subject === 'db'));
  const config = readEvents({ limit: 50, category: 'config' });
  assert.ok(config.items.some((e) => e.subject === 'theme'));
  assert.ok(config.items.every((e) => e.category === 'config'));
});

// --- evaluation ---------------------------------------------------------------

test('evaluateAlerts fires the documented conditions with evidence', () => {
  const alerts = evaluateAlerts({
    dockerAvailable: false,
    services: [{ group: 'Media', name: 'wave', displayName: 'Wave', health: 'unhealthy', state: 'running' }],
    stacks: [{ project: 'media', services: [{}, {}, {}], running: 1 }],
    system: { memory: { pct: 96.2 }, disk: { pct: 91.4, mount: '/' } },
    authFailures: 7,
  });
  const sigs = alerts.map((a) => a.signature);
  assert.ok(sigs.includes('docker.unavailable'));
  assert.ok(sigs.includes('service.unhealthy:Media/wave'));
  assert.ok(sigs.includes('stack.degraded:media'));
  assert.ok(sigs.includes('host.memory.critical'));
  assert.ok(sigs.includes('host.disk.warning'));
  assert.ok(sigs.includes('auth.failures'));
  assert.ok(alerts.every((a) => a.title && a.detail && a.firedAt));
  // worst first
  const rank = { critical: 0, warning: 1 };
  const ranks = alerts.map((a) => rank[a.severity]);
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y));
});

test('evaluateAlerts stays silent on a healthy snapshot and caps the list', () => {
  const calm = evaluateAlerts({
    dockerAvailable: true, services: [], stacks: [],
    system: { memory: { pct: 40 }, disk: { pct: 30, mount: '/' } }, authFailures: 0,
  });
  assert.deepEqual(calm, []);
  const many = Array.from({ length: MAX_ALERTS + 20 }, (_, i) => ({
    group: 'g', name: `svc${i}`, displayName: `Svc ${i}`, health: 'unhealthy', state: 'running',
  }));
  const capped = evaluateAlerts({ dockerAvailable: true, services: many, stacks: [], system: null, authFailures: 0 });
  assert.ok(capped.length <= MAX_ALERTS);
  assert.ok(capped.some((a) => a.signature === 'service.unhealthy:overflow'), 'the cap is disclosed, not silent');
});

// --- transitions ----------------------------------------------------------------

test('refreshAlerts logs fired/resolved exactly once per transition', () => {
  _resetAlerts();
  _resetActivity();
  const sick = {
    dockerAvailable: true,
    services: [{ group: 'g', name: 'db', displayName: 'Db', health: 'unhealthy', state: 'running' }],
    stacks: [], system: null, authFailures: 0,
  };
  const healthy = { ...sick, services: [] };
  refreshAlerts(sick);
  refreshAlerts(sick);
  let fired = readEvents({ limit: 50, type: 'alert.fired' });
  assert.equal(fired.items.length, 1, 'one fired event for the ongoing alert');
  assert.equal(getActiveAlerts().length, 1);

  const acked = ackAlert('service.unhealthy:g/db');
  assert.equal(acked.acknowledged, true);

  refreshAlerts(healthy);
  refreshAlerts(healthy);
  const resolved = readEvents({ limit: 50, type: 'alert.resolved' });
  assert.equal(resolved.items.length, 1, 'one resolved event');
  assert.equal(getActiveAlerts().length, 0);

  // a re-fire after resolve is a new transition, and the old ack is gone with the old alert
  refreshAlerts(sick);
  fired = readEvents({ limit: 50, type: 'alert.fired' });
  assert.equal(fired.items.length, 2);
  assert.equal(getActiveAlerts()[0].acknowledged, false);
});

// --- canonical feed: alerts publish to the Phase 10B event bus ----------------------
// There is no alert-channel registry anymore. A firing alert reaches the outside world
// through exactly one path: alert.created on the bus → notification center → providers.

test('a firing alert publishes alert.created to the canonical event bus', async () => {
  _resetAlerts();
  _resetActivity();
  const seen = [];
  const sub = bus.subscribe(() => true, (evt) => { seen.push(evt); });
  try {
    // let any in-flight publish from an earlier test settle, then listen fresh
    await new Promise((r) => setTimeout(r, 100));
    seen.length = 0;
    refreshAlerts({
      dockerAvailable: true,
      services: [{ group: 'g', name: 'db', displayName: 'Db', health: 'unhealthy', state: 'running' }],
      stacks: [], system: null, authFailures: 0,
    });
    for (let i = 0; i < 200 && !seen.some((e) => e.type === 'alert.created'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const created = seen.find((e) => e.type === 'alert.created');
    assert.ok(created, 'no alert.created reached the bus');
    assert.equal(created.correlation?.alertId, 'service.unhealthy:g/db');
    assert.equal(created.source, 'alert');
    assert.ok(created.subject?.href, 'the event carries somewhere to look');
  } finally {
    sub.unsubscribe();
  }
});

// --- endpoint -------------------------------------------------------------------

test('GET /api/alerts returns active alerts and counts, and no channel registry', async () => {
  _resetAlerts();
  const { status, json } = await get('/api/alerts');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.alerts));
  assert.ok(json.counts && typeof json.counts.critical === 'number' && typeof json.counts.warning === 'number');
  assert.equal('channels' in json, false, 'the obsolete channel list is gone from the API');
  assert.ok(json.at);
});

test('GET /api/activity accepts category and severity filters', async () => {
  const { status, json } = await get('/api/activity?limit=50&category=docker&severity=warning');
  assert.equal(status, 200);
  assert.equal(json.filters.category, 'docker');
  assert.equal(json.filters.severity, 'warning');
  assert.ok(json.items.every((e) => e.category === 'docker'));
  assert.ok(json.items.every((e) => ['warning', 'critical'].includes(e.severity)));
});
