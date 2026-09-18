// Phase 10A — the /api/monitoring surface, through the real gates.
//
// These requests go through `handleApi`, which means the session gate, the CSRF gate and the route
// dispatch are the ones production uses. The mock Docker engine is running, so the canonical
// inventory is real: monitors can be created against discovered services, and every Docker call
// the monitoring surface makes is visible and assertable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine } from '../test/mock-engine.js';

const OLD_ENV = { ...process.env };
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10a-api-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10a-api-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

let ENGINE = null;
let handleApi = null;
let engine = null;
let COOKIE = null;
let ANON = null;

function makeReq(method, body, headers = {}) {
  const h = { ...headers };
  if (COOKIE) h.cookie = COOKIE;
  if (body !== undefined) h['content-type'] = 'application/json';
  h.host = h.host || 'opushub.test';
  return {
    method,
    headers: h,
    [Symbol.asyncIterator]() {
      const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
      let i = 0;
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
    },
  };
}

async function call(method, pathname, body = null, headers = null, cookie = COOKIE) {
  const state = { status: 200, body: '' };
  const res = {
    setHeader: () => {},
    writeHead: (s) => { state.status = s; },
    end: (b) => { state.body = String(b ?? ''); },
  };
  const saved = COOKIE;
  if (cookie !== COOKIE) COOKIE = cookie;
  try {
    await handleApi(makeReq(method, body, headers || {}), res, new URL(pathname, 'http://opushub.test'));
  } finally {
    COOKIE = saved;
  }
  let json = null;
  try { json = JSON.parse(state.body || 'null'); } catch { /* non-JSON */ }
  return { status: state.status, json, text: state.body };
}

const get = (p, headers) => call('GET', p, null, headers);
const post = (p, body, headers) => call('POST', p, body ?? {}, headers);
const put = (p, body, headers) => call('PUT', p, body ?? {}, headers);
const del = (p, headers) => call('DELETE', p, null, headers);

const httpMonitor = (over = {}) => ({
  name: 'Fixture HTTP', type: 'http', target: { url: 'http://10.0.0.9:8096/' }, intervalMs: 30_000, timeoutMs: 2000, ...over,
});

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  ({ handleApi } = await import('./api.js'));
  engine = await import('./monitoring/engine.js');
  const { seedSession } = await import('../test/auth-helper.js');
  COOKIE = await seedSession();
  await engine._wipeMonitoring();
  await engine.start({ autoStart: false });
});

test.after(async () => {
  await engine?.stop();
  await ENGINE?.stop();
  process.env = OLD_ENV;
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('the whole surface is behind the session gate', async () => {
  const routes = [
    ['GET', '/api/monitoring'], ['GET', '/api/monitoring/engine'], ['GET', '/api/monitoring/settings'],
    ['GET', '/api/monitoring/incidents'], ['GET', '/api/monitoring/suggestions'], ['GET', '/api/monitoring/search'],
    ['GET', '/api/monitoring/monitors'], ['GET', '/api/monitoring/monitors/mon-abcdef123456'],
    ['POST', '/api/monitoring/monitors'], ['PUT', '/api/monitoring/settings'],
    ['POST', '/api/monitoring/monitors/mon-abcdef123456/pause'],
    ['POST', '/api/monitoring/monitors/mon-abcdef123456/check'],
    ['DELETE', '/api/monitoring/monitors/mon-abcdef123456'],
  ];
  for (const [method, p] of routes) {
    const r = await call(method, p, method === 'GET' ? null : {}, null, ANON);
    assert.equal(r.status, 401, `${method} ${p} answered ${r.status}`);
    assert.equal(r.json.code, 'auth_required');
  }
});

test('a write from another origin is refused before it reaches the handler', async () => {
  const r = await post('/api/monitoring/monitors', httpMonitor(), { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'csrf');
  assert.equal((await get('/api/monitoring')).json.counts.total, 0, 'nothing was created');
});

test('create, read, edit, pause, resume, maintain and delete — the whole lifecycle', async () => {
  const created = await post('/api/monitoring/monitors', httpMonitor());
  assert.equal(created.status, 201, created.text.slice(0, 200));
  const id = created.json.monitor.id;
  assert.match(id, /^mon-[a-z0-9]+$/);
  assert.equal(created.json.monitor.status, 'pending');
  assert.equal(created.json.monitor.provenance, 'configured');
  assert.equal('streakStartedAt' in created.json.monitor, false, 'the projection hides internals');

  const doc = (await get('/api/monitoring')).json;
  assert.equal(doc.counts.total, 1);
  assert.equal(doc.counts.pending, 1);
  assert.equal(doc.monitors[0].id, id);

  const one = await get(`/api/monitoring/monitors/${id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.monitor.name, 'Fixture HTTP');
  assert.equal(one.json.uptime.day.noData, true, 'no checks yet is "no data", never 100%');
  assert.deepEqual(one.json.series, []);
  assert.deepEqual(one.json.incidents, []);

  const edited = await put(`/api/monitoring/monitors/${id}`, { name: 'Edited', intervalMs: 120_000 });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.monitor.name, 'Edited');
  assert.equal(edited.json.monitor.intervalMs, 120_000);

  const paused = await post(`/api/monitoring/monitors/${id}/pause`);
  assert.equal(paused.json.monitor.status, 'paused');
  assert.equal(paused.json.monitor.enabled, false);
  assert.equal((await get('/api/monitoring')).json.counts.paused, 1);
  const resumed = await post(`/api/monitoring/monitors/${id}/resume`);
  assert.equal(resumed.json.monitor.enabled, true);
  assert.equal(resumed.json.monitor.status, 'unknown', 'resuming is not a health claim');

  const window = await post(`/api/monitoring/monitors/${id}/maintenance`, { until: Date.now() + 600_000, reason: 'reboot' });
  assert.equal(window.status, 200);
  assert.equal(window.json.monitor.maintenance.reason, 'reboot');
  assert.equal((await get('/api/monitoring')).json.counts.maintenance, 1);
  const cleared = await del(`/api/monitoring/monitors/${id}/maintenance/clear`);
  assert.equal(cleared.json.monitor.maintenance, null);

  const removed = await del(`/api/monitoring/monitors/${id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.json.id, id);
  assert.equal((await get(`/api/monitoring/monitors/${id}`)).status, 404);
  assert.equal((await get('/api/monitoring')).json.counts.total, 0);
});

test('what the model refuses, the API refuses — with a status, a code and a sentence', async () => {
  const cases = [
    [httpMonitor({ target: { url: 'http://127.0.0.1:8080/' } }), 400, /loopback/],
    [httpMonitor({ target: { url: 'http://169.254.169.254/latest/meta-data/' } }), 400, /link-local/],
    [httpMonitor({ target: { url: 'http://10.0.0.9:22/' } }), 400, /never an HTTP application/],
    [httpMonitor({ target: { url: 'http://user:pw@10.0.0.9/' } }), 400, /credentials/],
    [httpMonitor({ target: { url: 'file:///etc/passwd' } }), 400, /http/],
    [httpMonitor({ target: {} }), 400, /service to watch or an endpoint/],
    [httpMonitor({ type: 'icmp' }), 400, /type must be one of/],
    [httpMonitor({ name: '   ' }), 400, /Name is required/],
    [{ name: 'range', type: 'tcp', target: { host: '10.0.0.0/24', port: 80 } }, 400, /host/i],
    [{ name: 'list', type: 'tcp', target: { host: '10.0.0.1,10.0.0.2', port: 80 } }, 400, /host/i],
    [{ name: 'port range', type: 'tcp', target: { host: '10.0.0.9', port: '22-80' } }, 400, /port/i],
    [{ name: 'no port', type: 'tcp', target: { host: '10.0.0.9' } }, 400, /port/i],
    [{ name: 'id', type: 'docker', target: { service: { name: 'abcdef123456' } } }, 400, /not a container id/],
    [{ name: 'shell', type: 'tcp', target: { host: '10.0.0.9; id', port: 80 } }, 400, /host/i],
  ];
  for (const [body, status, pattern] of cases) {
    const r = await post('/api/monitoring/monitors', body);
    assert.equal(r.status, status, `${JSON.stringify(body.target)} → ${r.status} ${r.text.slice(0, 140)}`);
    assert.match(String(r.json.error), pattern, JSON.stringify(body));
    assert.ok(r.json.code, 'every refusal carries a machine-readable code');
  }
  assert.equal((await get('/api/monitoring')).json.counts.total, 0, 'nothing invalid was stored');
});

test('settings are readable with their bounds, and writable only within them', async () => {
  const before = (await get('/api/monitoring/settings')).json;
  assert.equal(before.bounds.intervalMs.min, 10_000);
  assert.equal(before.settings.autoCreate.enabled, false, 'auto-creation is off unless it is asked for');
  const changed = await put('/api/monitoring/settings', { settings: { intervalMs: 1, failureThreshold: 99, autoCreate: { enabled: true, max: 1000 } } });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.settings.intervalMs, 10_000);
  assert.equal(changed.json.settings.failureThreshold, 10);
  assert.equal(changed.json.settings.autoCreate.max, 100);
  // leave the engine as it was found: a later test must not inherit a threshold of ten
  const restored = await put('/api/monitoring/settings', { settings: { intervalMs: 60_000, timeoutMs: 5000, failureThreshold: 3, recoveryThreshold: 2, autoCreate: { enabled: false, max: 10 } } });
  assert.equal(restored.json.settings.autoCreate.enabled, false);
  assert.equal(restored.json.settings.failureThreshold, 3);
});

test('suggestions come from the canonical inventory, name a provider, and create nothing by reading them', async () => {
  const services = (await get('/api/services')).json.services.filter((s) => !s.hidden);
  assert.ok(services.length, 'the mock engine produced an inventory');
  const withUrl = services.find((s) => s.url);
  assert.ok(withUrl, 'and at least one service has a discovered endpoint');

  const before = (await get('/api/monitoring')).json.counts.total;
  const listed = await get('/api/monitoring/suggestions');
  assert.equal(listed.status, 200);
  const suggestion = listed.json.suggestions.find((s) => s.type === 'http' && s.target.service.name === withUrl.name);
  assert.ok(suggestion, 'the service is suggested');
  assert.equal(suggestion.target.url, withUrl.url);
  assert.equal(suggestion.provenance, 'discovered');
  assert.ok(suggestion.source.urlSource, 'where the endpoint came from is recorded as data');
  assert.equal((await get('/api/monitoring')).json.counts.total, before, 'reading suggestions creates nothing');

  const applied = await post('/api/monitoring/suggestions/apply', { ids: [suggestion.id] });
  assert.equal(applied.status, 201, applied.text.slice(0, 200));
  assert.equal(applied.json.created.length, 1);
  assert.equal(applied.json.created[0].provenance, 'discovered');
  assert.equal(applied.json.created[0].target.service.name, withUrl.name);
  const after = (await get('/api/monitoring')).json;
  assert.equal(after.counts.total, before + 1);
  assert.equal(after.counts.suggested >= 0, true);
  // the suggestion that was applied is gone while the monitor exists: the service is monitored, so
  // the list no longer offers it — and asking for it again is refused rather than duplicated
  const leftovers = (await get('/api/monitoring/suggestions')).json.suggestions;
  assert.equal(leftovers.some((s) => s.id === suggestion.id), false, 'an already-monitored service is not suggested again');
  const again = await post('/api/monitoring/suggestions/apply', { ids: [suggestion.id] });
  assert.equal(again.status, 404);
  assert.equal(again.json.code, 'unknown_suggestion');
  assert.equal((await get('/api/monitoring')).json.counts.total, before + 1, 'and no duplicate monitor exists');
  for (const m of applied.json.created) await del(`/api/monitoring/monitors/${m.id}`);
  assert.equal((await get('/api/monitoring')).json.counts.total, before);
});

test('a Docker monitor is created from a service reference and runs a real, read-only check', async () => {
  const services = (await get('/api/services')).json.services.filter((s) => !s.hidden);
  const target = services[0];
  const created = await post('/api/monitoring/monitors', {
    name: `${target.displayName} container`, type: 'docker', target: { service: { group: target.group, name: target.name } }, intervalMs: 30_000, timeoutMs: 5000,
  });
  assert.equal(created.status, 201, created.text.slice(0, 200));
  const id = created.json.monitor.id;

  ENGINE.reset();
  const checked = await post(`/api/monitoring/monitors/${id}/check`);
  assert.equal(checked.status, 200, checked.text.slice(0, 200));
  assert.ok(['up', 'degraded', 'down', 'unknown'].includes(checked.json.state));
  assert.equal(checked.json.result.code === 'stale_target', false, 'the service resolved against the inventory');
  assert.equal(checked.json.monitor.lastCheck.at > 0, true, 'the check is recorded with a timestamp');
  const history = (await get(`/api/monitoring/monitors/${id}`)).json;
  assert.equal(history.uptime.day.checks, 1);
  assert.equal(history.series.length, 1);

  // the only Docker traffic the monitoring surface generated was reads
  assert.ok(ENGINE.log.length > 0, 'the check talked to the engine');
  for (const line of ENGINE.log) assert.match(line, /^GET /, `monitoring issued ${line}`);

  // a service that is not in the inventory cannot be watched
  const ghost = await post('/api/monitoring/monitors', { name: 'ghost', type: 'docker', target: { service: { group: 'Nope', name: 'does-not-exist' } } });
  assert.equal(ghost.status, 400);
  assert.match(ghost.json.error, /No service named/);
  await del(`/api/monitoring/monitors/${id}`);
});

test('an HTTP monitor can be created against a service endpoint, and the endpoint is resolved at check time', async () => {
  const service = (await get('/api/services')).json.services.find((s) => s.url);
  const created = await post('/api/monitoring/monitors', httpMonitor({ name: `${service.displayName} web`, target: { service: { group: service.group, name: service.name } } }));
  assert.equal(created.status, 201, created.text.slice(0, 200));
  const id = created.json.monitor.id;
  const detail = (await get(`/api/monitoring/monitors/${id}`)).json;
  assert.equal(detail.monitor.target.service.name, service.name);
  assert.equal(detail.monitor.target.url, null, 'the endpoint is not frozen at creation — the service is watched, not a string');
  await del(`/api/monitoring/monitors/${id}`);
});

test('a monitor that is driven down reaches the alerts surface and the activity log', async () => {
  const created = await post('/api/monitoring/monitors', httpMonitor({ name: 'Down Actor' }));
  const id = created.json.monitor.id;
  const monitor = engine._internals?.state?.monitors?.get(id) ?? null;
  assert.ok(monitor, 'the engine owns the record the API just created');
  for (let i = 0; i < 3; i++) {
    await engine.runCheck(monitor, { at: Date.now() + i, deps: { checkHttp: async () => ({ kind: 'fail', at: Date.now() + i, latencyMs: null, statusCode: null, errorType: 'refused', code: null, reason: 'No response (refused).', hops: 0, evidence: null }) } });
  }
  assert.equal(monitor.status, 'down');

  const alerts = (await get('/api/alerts')).json;
  const condition = alerts.alerts.find((a) => a.signature === `monitor.down:${id}`);
  assert.ok(condition, 'the monitor condition reached the Alerts surface through the existing engine');
  assert.equal(condition.severity, 'critical');
  assert.equal(condition.area, 'monitoring');
  assert.match(condition.links[0].href, new RegExp(`^/monitoring/${id}$`));

  const incidents = (await get('/api/monitoring/incidents?open=1')).json.incidents;
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].monitorId, id);
  assert.equal(incidents[0].status, 'open');
  assert.ok(incidents[0].durationMs >= 0);

  const activity = (await get('/api/activity?category=monitoring')).json;
  const types = activity.items.map((e) => e.type);
  assert.ok(types.includes('monitor.down'), 'the down transition is in Activity');
  assert.ok(types.includes('incident.opened'));
  assert.equal(activity.items.every((e) => e.category === 'monitoring'), true);

  const search = (await get('/api/search?q=Down Actor')).json;
  assert.ok(search.results.some((r) => r.kind === 'monitor' && r.href === `/monitoring/${id}`), 'the monitor is searchable');

  await del(`/api/monitoring/monitors/${id}`);
});

test('unknown paths and unsupported methods are answered, not guessed at', async () => {
  assert.equal((await get('/api/monitoring/nope')).status, 404);
  assert.equal((await get('/api/monitoring/monitors/not-an-id')).status, 404);
  assert.equal((await get('/api/monitoring/monitors/mon-aaaaaaaaaaaa')).status, 404);
  assert.equal((await post('/api/monitoring/monitors/mon-aaaaaaaaaaaa/pause')).status, 404);
  assert.equal((await post('/api/monitoring/monitors/mon-aaaaaaaaaaaa/maintenance', { until: Date.now() - 1 })).status, 404, 'an unknown monitor is a 404 before the body is parsed');
  const patch = await call('PATCH', '/api/monitoring');
  assert.equal(patch.status, 405);
  assert.equal(patch.json.code, 'method_not_allowed');
});

test('the manual check endpoint cannot be used to check something that was not configured', async () => {
  // there is no route that accepts a URL, host or port: the only trigger names a stored monitor
  const attempts = [
    await post('/api/monitoring/check', { url: 'http://169.254.169.254/' }),
    await post('/api/monitoring/monitors', { name: 'x', type: 'http', target: { url: 'http://10.0.0.9' }, checkUrl: 'http://169.254.169.254/' }),
    await post('/api/monitoring/check-now', { host: '10.0.0.9', port: 22 }),
  ];
  assert.equal(attempts[0].status, 404);
  assert.equal(attempts[2].status, 404);
  assert.equal(attempts[1].status, 201);
  const id = attempts[1].json.monitor.id;
  assert.equal(attempts[1].json.monitor.target.url, 'http://10.0.0.9', 'the extra field was ignored, not stored');
  await del(`/api/monitoring/monitors/${id}`);
});

test('monitoring never asks Docker to do anything, at any point in its lifecycle', async () => {
  // every request in this file has already gone through the mock engine; this is the summary claim
  ENGINE.reset();
  const created = await post('/api/monitoring/monitors', httpMonitor({ name: 'Read Only' }));
  const id = created.json.monitor.id;
  await get('/api/monitoring');
  await get(`/api/monitoring/monitors/${id}`);
  await post(`/api/monitoring/monitors/${id}/pause`);
  await post(`/api/monitoring/monitors/${id}/resume`);
  await post(`/api/monitoring/monitors/${id}/check`);
  await del(`/api/monitoring/monitors/${id}`);
  for (const line of ENGINE.log) {
    assert.match(line, /^GET /, `monitoring issued ${line}`);
    assert.ok(!/\/(start|stop|restart|kill|exec|remove|update)/.test(line), `monitoring reached ${line}`);
  }
});
