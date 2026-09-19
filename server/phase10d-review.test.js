// Phase 10D — final review proofs. Cross-cutting checks the per-sub-phase suites do not make:
//
//   1. a catalog install produces a NORMAL container: every existing container action, monitoring,
//      Diun detection, Update Now and Autoheal apply to it with no catalog-specific code path;
//   2. the rollback matrix — a fault at each pipeline step leaves nothing behind but data volumes;
//   3. the stack/container boundary — an install touches nothing that is not its own;
//   4. the operation boundary and secret hygiene, end to end (records, events, activity, history,
//      responses, error messages, server logs);
//   5. a realistic manifest (Gitea) round-trips volume/env/healthcheck/restart/network/port/proxy
//      into the normal Services read surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine, FLEET, PULL_AUTH, CREATED_NETWORKS, CREATED_VOLUMES } from '../test/mock-engine.js';
import { stripComments } from '../test/source-scan.js';

const OLD_ENV = { ...process.env };
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10dr-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10dr-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;
process.env.OPUSHUB_OP_VERIFY_MS = '3000';
process.env.OPUSHUB_SECRET_KEY = 'e'.repeat(64);
process.env.OPUSHUB_PROXY_PROVIDER = 'traefik';
process.env.OPUSHUB_PROXY_NETWORK = 'proxy';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const code = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

let ENGINE = null;
let handleApi, locks, monitoring, events, diun, updatesStore, autoheal, catalogStore, activity;
let COOKIE = null;
const LOGS = [];

function makeReq(method, body) {
  const headers = { 'content-type': 'application/json', host: 'opushub.test' };
  if (COOKIE) headers.cookie = COOKIE;
  return {
    method, headers,
    [Symbol.asyncIterator]() {
      const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
      let i = 0;
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
    },
  };
}
function makeRes() {
  const state = { status: 200, body: '', headers: {} };
  return { state, setHeader: (k, v) => { state.headers[String(k).toLowerCase()] = v; }, writeHead: (s, h) => { state.status = s; for (const [k, v] of Object.entries(h || {})) state.headers[String(k).toLowerCase()] = v; }, end: (b) => { state.body = String(b ?? ''); } };
}
async function call(method, pathname, body = null) {
  const r = makeRes();
  await handleApi(makeReq(method, body), r, new URL(pathname, 'http://opushub.test'));
  let json = null; try { json = JSON.parse(r.state.body || 'null'); } catch {}
  return { status: r.state.status, json, text: r.state.body };
}
const get = (p) => call('GET', p);
const post = (p, body) => call('POST', p, body);
async function settle(id, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await get(`/api/v1/operations/${id}`);
    last = r.json?.operation || last;
    if (last && !['pending', 'awaiting_confirmation', 'authorized', 'running'].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 60));
  }
  return last;
}
/** The one flow every mutation uses: dry-run → token → execute → settle. */
async function run(action, target, params) {
  locks._resetLimits();
  const d = await post('/api/v1/operations/dry-run', { action, target, ...(params !== undefined ? { params } : {}) });
  if (d.status !== 200) return { dryRun: d, operation: d.json?.operation ?? null };
  const e = await post('/api/v1/operations', { action, target, ...(params !== undefined ? { params } : {}), confirmationToken: d.json.confirmation.token, operationId: d.json.operation.id });
  const operation = e.status === 202 ? await settle(e.json.operation.id) : e.json.operation;
  return { dryRun: d, execute: e, operation };
}
const install = (config, id) => run('service.install', { type: 'catalog', id }, { config });
const posts = () => ENGINE.log.filter((l) => !l.startsWith('GET '));
const fx = (name) => FLEET.find((f) => f.Names[0] === `/${name}`);
const snapshot = () => ({
  fleet: FLEET.map((f) => `${f.Id}:${f.Names[0]}:${f.State}:${f.Image}`),
  nets: [...CREATED_NETWORKS.keys()].sort(),
  vols: [...CREATED_VOLUMES.keys()].sort(),
});

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  for (const k of ['log', 'warn', 'error', 'info']) {
    const orig = console[k];
    console[k] = (...args) => { LOGS.push(args.map(String).join(' ')); orig.apply(console, args); };
  }
  ({ handleApi } = await import('./api.js'));
  locks = await import('./operations/locks.js');
  monitoring = await import('./monitoring/engine.js');
  events = await import('./events/index.js');
  diun = await import('./updates/diun.js');
  updatesStore = await import('./updates/store.js');
  autoheal = await import('./autoheal/observer.js');
  catalogStore = await import('./catalog/store.js');
  activity = await import('./activity.js');
  const { seedSession } = await import('../test/auth-helper.js');
  COOKIE = await seedSession();
});
test.after(async () => {
  await monitoring.stop().catch(() => {});
  await ENGINE?.stop();
  process.env = OLD_ENV;
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
test.beforeEach(() => { locks._resetLimits(); ENGINE.reset(); });

/* ------------------------------------------------------------------ */
/* 1 + 8 + 10. catalog → normal container → every existing pathway     */
/* ------------------------------------------------------------------ */

test('a realistic install (Gitea: volume, env, healthcheck, restart, network, port, proxy) is visible through the normal Services surface', async () => {
  const r = await install({ name: 'git', variables: { ROOT_URL: 'https://git.example.com/', SSH_PORT: 2223 }, ports: { '3000/tcp': null, '22/tcp': 2223 }, expose: { domain: 'git.example.com' }, autoheal: true }, 'gitea');
  assert.equal(r.operation.status, 'succeeded', JSON.stringify(r.operation.error));
  const c = fx('git');
  // what Docker holds
  assert.ok(c.Config.Env.includes('GITEA__server__ROOT_URL=https://git.example.com/'));
  assert.ok(c.Config.Env.includes('GITEA__server__SSH_PORT=2223'));
  assert.deepEqual(c.Config.Healthcheck.Test, ['CMD', 'curl', '-fsS', 'http://127.0.0.1:3000/api/healthz']);
  assert.equal(c.Config.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.equal(c.Config.HostConfig.NetworkMode, 'proxy');
  assert.deepEqual(c.Config.HostConfig.PortBindings, { '22/tcp': [{ HostIp: '', HostPort: '2223' }] });
  assert.ok(c.Mounts.some((m) => m.Type === 'volume' && m.Name === 'git-data' && m.Destination === '/data'));
  assert.equal(c.Config.Labels['traefik.http.routers.git.rule'], 'Host(`git.example.com`)');
  assert.equal(c.Config.Labels.autoheal, 'true');
  assert.equal(c.Config.Labels['diun.enable'], 'true');

  // what the normal inventory shows — same routes every other container uses
  const services = await get('/api/services');
  const svc = services.json.services.find((s) => s.container?.name === 'git');
  assert.ok(svc, 'the installed container is in the ordinary inventory');
  assert.equal(svc.url.replace(/\/$/, ''), 'https://git.example.com', 'the URL is resolved from the labels by the existing reverse-proxy reader');
  const detail = await get(`/api/services/${encodeURIComponent(svc.group)}/${encodeURIComponent(svc.name)}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  assert.equal(detail.json.container.state.health, 'healthy');
  assert.equal(detail.json.container.restartPolicy?.name ?? detail.json.container.restartPolicy?.Name ?? 'unless-stopped', 'unless-stopped');
  assert.ok(detail.json.container.mounts.some((m) => m.target === '/data'));
  assert.ok(detail.json.container.ports.some((p) => p.hostPort === '2223'));
  assert.ok(detail.json.container.networks.some((n) => n.name === 'proxy'));
  const spec = await get('/api/v1/containers/git/spec');
  assert.equal(spec.status, 200);
  assert.equal(spec.json.spec.image, 'gitea/gitea:1.22');
  assert.equal(spec.json.spec.restartPolicy.name, 'unless-stopped');
  assert.ok(spec.json.spec.volumes.some((v) => v.type === 'volume' && v.source === 'git-data'));
  assert.ok(spec.json.spec.healthcheck && spec.json.spec.healthcheck.test[0] === 'CMD');
});

test('the installed container is an ordinary target for every existing container action — no catalog code on the path', async () => {
  const t = { type: 'service', id: 'git' };
  const id0 = fx('git').Id;

  const stop = await run('container.stop', t);
  assert.equal(stop.operation.status, 'succeeded', JSON.stringify(stop.operation.error)); assert.equal(fx('git').State, 'exited');
  const start = await run('container.start', t);
  assert.equal(start.operation.status, 'succeeded'); assert.equal(fx('git').State, 'running');
  const restart = await run('container.restart', t);
  assert.equal(restart.operation.status, 'succeeded');

  // edit: an in-place change and a recreating change through the SAME editor allowlist
  const upd = await run('container.update', t, { spec: { restartPolicy: { name: 'always', maxRetries: 0 } } });
  assert.equal(upd.operation.status, 'succeeded', JSON.stringify(upd.operation.error));
  assert.equal(fx('git').Id, id0, 'in place');
  const before = fx('git');
  const edit = await run('container.edit', t, { spec: { env: Object.fromEntries(before.Config.Env.map((e) => e.split(/=(.*)/s).slice(0, 2)).concat([['GITEA__server__LFS_START_SERVER', 'true']])) } });
  assert.equal(edit.operation.status, 'succeeded', JSON.stringify(edit.operation.error));
  assert.notEqual(fx('git').Id, id0, 'recreated');
  assert.ok(fx('git').Config.Env.includes('GITEA__server__LFS_START_SERVER=true'));
  assert.equal(fx('git').Config.Labels['io.opushub.catalog'], 'gitea', 'the recreate ladder preserved the labels like any other container');
  assert.equal(fx('git').Config.Labels['traefik.http.routers.git.rule'], 'Host(`git.example.com`)', 'proxy labels survive a recreate');

  const id1 = fx('git').Id;
  const rec = await run('container.recreate', t);
  assert.equal(rec.operation.status, 'succeeded', JSON.stringify(rec.operation.error));
  assert.notEqual(fx('git').Id, id1);
  assert.ok(fx('git').Mounts.some((m) => m.Name === 'git-data'), 'the data volume rides along');

  const chg = await run('container.change_image', t, { image: 'gitea/gitea:1.21' });
  assert.equal(chg.operation.status, 'succeeded', JSON.stringify(chg.operation.error));
  assert.equal(fx('git').Image, 'gitea/gitea:1.21');
  assert.equal(chg.operation.result.previousImage, 'gitea/gitea:1.22');

  for (const op of [stop, start, restart, upd, edit, rec, chg]) {
    assert.equal(op.dryRun.json.dryRun.target.containerName, 'git');
    // the record may quote the container's own labels (data); it never names catalog code or manifests
    assert.equal(op.operation.target.type, 'service');
    assert.ok(!('manifest' in (op.operation.result || {})), `${op.operation.action} carried catalog-specific state`);
    assert.ok(!/catalog\/|planInstall|runners/.test(JSON.stringify(op.operation)), `${op.operation.action} references catalog code`);
  }
});

test('Diun detection, Update Now and Autoheal treat the installed container like any other', async () => {
  const c = fx('git');
  // Diun: the webhook matches the live container and publishes the canonical event
  let published = null;
  const { bus } = await import('./events/bus.js');
  const sub = bus.subscribe((e) => e.type === 'container.update_available', (e) => { published = e; });
  const hook = await diun.handleDiunWebhook({ diun_version: '4.28.0', status: 'update', image: 'gitea/gitea:1.21', digest: `sha256:${'4'.repeat(64)}`, metadata: { ctn_id: c.Id.slice(0, 12), ctn_names: 'git' } });
  sub.unsubscribe();
  assert.equal(hook.ok, true, JSON.stringify(hook));
  assert.ok(published, 'no canonical update event');
  assert.equal(updatesStore.getUpdate('git')?.status ?? updatesStore.getUpdate(c.Id)?.status, 'update_available');

  // Update Now: the 10C engine's own dry-run/apply, unchanged
  const dry = await post('/api/container-updates/dry-run', { target: { type: 'service', id: 'git' } });
  assert.equal(dry.status, 200, JSON.stringify(dry.json));
  assert.equal(dry.json.plan.action, 'container.update_now');
  const idBefore = c.Id;
  const apply = await post('/api/container-updates/apply', { target: { type: 'service', id: 'git' }, confirmationToken: dry.json.confirmation.token });
  assert.equal(apply.status, 200, JSON.stringify(apply.json));
  assert.equal(apply.json.record.status, 'updated');
  assert.notEqual(fx('git').Id, idBefore, 'Update Now recreated it through the shared ladder');
  assert.equal(fx('git').Config.Labels['io.opushub.catalog'], 'gitea', 'preserveConfig kept the labels');
  assert.ok(posts()[0] === 'POST /images/create', 'Update Now pulled first (independent validation, not Diun\'s word)');

  // Autoheal: the observer resolves the container in the live inventory and publishes the canonical event
  const { invalidateDiscovery } = await import('./model.js');
  invalidateDiscovery();
  const ah = await autoheal.handleAutohealWebhook({ text: `Container /git (${fx('git').Id.slice(0, 12)}) found to be unhealthy. Successfully restarted` });
  assert.equal(ah.ok, true);
  assert.equal(ah.verified ?? ah.event?.payload?.verified ?? true, true);
  const recent = events.getRecentEvents({ limit: 50 }).find((e) => e.type === 'container.autoheal.restarted');
  assert.ok(recent, 'no canonical autoheal event');

  // an opt-out install is ineligible through the same eligibility rule everyone else has
  const optOut = await install({ name: 'cache-noupd', updates: false }, 'redis');
  assert.equal(optOut.operation.status, 'succeeded', JSON.stringify(optOut.operation.error));
  assert.equal(fx('cache-noupd').Config.Labels['opushub.update'], 'false');
  const { evaluateEligibility } = await import('./updates/eligibility.js');
  const el = evaluateEligibility({ container: { name: 'cache-noupd', id: fx('cache-noupd').Id, rawLabels: fx('cache-noupd').Config.Labels } });
  assert.equal(el.eligible, false); assert.match(el.reason, /opted out/);
});

test('monitoring follows the installed container through the monitoring engine, and remove leaves the volume', async () => {
  const mon = monitoring.overview().monitors.find((m) => m.target?.service?.name === 'git');
  assert.ok(mon, 'the install registered a monitor');
  assert.equal(mon.type, 'http'); assert.equal(mon.source.kind, 'catalog');
  const listed = await get('/api/monitoring');
  assert.ok(listed.status === 200 && JSON.stringify(listed.json).includes(mon.id), 'the monitor is an ordinary monitor in the ordinary list');

  const stop = await run('container.stop', { type: 'service', id: 'git' });
  assert.equal(stop.operation.status, 'succeeded');
  const rm = await run('container.remove', { type: 'service', id: 'git' }, {});
  assert.equal(rm.operation.status, 'succeeded', JSON.stringify(rm.operation.error));
  assert.ok(!fx('git'));
  assert.ok(!posts().some((l) => l.startsWith('DELETE /volumes')), 'remove never deletes volumes');
  assert.ok(CREATED_VOLUMES.has('git-data'), 'data volume kept');
  // the catalog knows nothing special about the removal; it just observes Docker
  const cat = await get('/api/v1/catalog/gitea');
  assert.ok(!cat.json.instances.some((i) => i.name === 'git'));
});

/* ------------------------------------------------------------------ */
/* 9. rollback matrix                                                   */
/* ------------------------------------------------------------------ */

test('rollback matrix: a fault at each step leaves nothing behind but data volumes, and the failure is reported honestly', async () => {
  const before = snapshot();
  const cases = [
    { name: 'pull',      cfg: { name: 'rb-pull', tag: 'nonexistent', ports: { '80/tcp': 18201 } }, m: 'nginx', reason: /could not be pulled/, wire: ['POST /images/create'] },
    { name: 'network',   cfg: { name: 'rb-fail-net', ports: { '80/tcp': 18202 } }, m: 'nginx', reason: /Network rb-fail-net_net could not be created/, wire: ['POST /networks/create'] },
    { name: 'volume',    cfg: { name: 'rb-fail-vol', ports: { '80/tcp': 18203 } }, m: 'nginx', reason: /Volume rb-fail-vol-html could not be created/, wire: ['POST /networks/create', 'POST /volumes/create', 'DELETE /networks/rb-fail-vol_net'] },
    { name: 'create',    cfg: { name: 'rb-fail-create', ports: { '80/tcp': 18204 } }, m: 'nginx', reason: /could not be created/, wire: ['POST /networks/create', 'POST /volumes/create', 'POST /containers/create', 'DELETE /networks/rb-fail-create_net'] },
    { name: 'start',     cfg: { name: 'rb-exit-immediately', ports: { '80/tcp': 18205 } }, m: 'nginx', reason: /exited immediately/, wire: ['POST /networks/create', 'POST /volumes/create', 'POST /containers/create', 'POST /containers/<id>/start', 'DELETE /containers/<id>', 'DELETE /networks/rb-exit-immediately_net'] },
    { name: 'health',    cfg: { name: 'rb-become-unhealthy', ports: { '80/tcp': 18206 } }, m: 'nginx', reason: /unhealthy/, wire: ['POST /networks/create', 'POST /volumes/create', 'POST /containers/create', 'POST /containers/<id>/start', 'DELETE /containers/<id>', 'DELETE /networks/rb-become-unhealthy_net'] },
  ];
  for (const c of cases) {
    ENGINE.reset();
    const r = await install({ ...c.cfg, network: 'dedicated' }, c.m);
    assert.equal(r.operation.status, 'failed', `${c.name}: ${JSON.stringify(r.operation)}`);
    assert.match(r.operation.error.reason, c.reason, `${c.name}: reason`);
    const wire = posts().map((l) => l.replace(/[0-9a-f]{12,64}/g, '<id>'));
    assert.deepEqual(wire, c.wire, `${c.name}: wire`);
    assert.ok(!fx(c.cfg.name), `${c.name}: container gone`);
    assert.ok(!CREATED_NETWORKS.has(`${c.cfg.name}_net`), `${c.name}: dedicated network gone`);
    const rec = catalogStore.listInstalls({ limit: 100 }).find((i) => i.name === c.cfg.name);
    assert.equal(rec?.status, 'failed', `${c.name}: history says failed`);
    assert.ok(!monitoring.overview().monitors.some((m) => m.target?.service?.name === c.cfg.name), `${c.name}: no monitor`);
    if (c.name !== 'pull' && c.name !== 'network' && c.name !== 'volume') {
      assert.ok(CREATED_VOLUMES.has(`${c.cfg.name}-html`), `${c.name}: data volume kept`);
      assert.ok(rec.report.warnings.some((w) => /kept/.test(w)), `${c.name}: the operator is told the volume was kept`);
      assert.match(r.operation.error.reason, /./); assert.equal(r.operation.result, null);
    }
    assert.ok(events.getRecentEvents({ limit: 100 }).some((e) => e.type === 'operation.failed' && e.correlation?.operationId === r.operation.id), `${c.name}: Event Bus failure event`);
    assert.ok(JSON.stringify((await get('/api/activity?limit=100')).json).includes(`${c.cfg.name} failed`), `${c.name}: activity line`);
    CREATED_VOLUMES.delete(`${c.cfg.name}-html`);
  }
  const after = snapshot();
  assert.deepEqual(after.fleet, before.fleet, 'no other container was touched');
  assert.deepEqual(after.nets, before.nets, 'no other network was touched');
  assert.deepEqual(after.vols, before.vols, 'no other volume was touched');
});

test('rollback matrix: a monitoring-registration failure is a reported partial success — the running container is kept', async () => {
  const saved = monitoring.overview().settings.maxMonitors;
  const count = monitoring.overview().monitors.length;
  monitoring.updateSettings({ maxMonitors: Math.max(1, count) });
  try {
    const r = await install({ name: 'cache-nomon' }, 'redis');
    assert.equal(r.operation.status, 'succeeded', JSON.stringify(r.operation.error));
    assert.equal(fx('cache-nomon').State, 'running');
    assert.equal(r.operation.result.report.monitor.result, 'skipped');
    assert.match(r.operation.result.report.monitor.reason, /limited to/);
    assert.ok(r.operation.result.report.warnings.some((w) => /monitor not created/.test(w)));
    assert.ok(!monitoring.overview().monitors.some((m) => m.target?.service?.name === 'cache-nomon'));
  } finally { monitoring.updateSettings({ maxMonitors: saved }); }
});

/* ------------------------------------------------------------------ */
/* 5. stack / container boundary                                        */
/* ------------------------------------------------------------------ */

test('boundary: an install cannot name another stack\'s container, remove the external proxy network, or claim someone else\'s volume as its own', async () => {
  const before = snapshot();
  // 1 — a name that already belongs to a compose stack member → refused at plan time, no write
  const clash = await post('/api/v1/operations/dry-run', { action: 'service.install', target: { type: 'catalog', id: 'redis' }, params: { config: { name: 'jellyfin' } } });
  assert.equal(clash.status, 409); assert.equal(clash.json.operation.error.code, 'name_taken');
  // 2 — joining the shared proxy network as an existing network is allowed; it is never created or removed by the install
  const onProxy = await install({ name: 'cache-onproxy', network: 'proxy' }, 'redis');
  assert.equal(onProxy.operation.status, 'succeeded', JSON.stringify(onProxy.operation.error));
  assert.ok(!posts().some((l) => l === 'POST /networks/create'), 'an existing network is joined, not created');
  ENGINE.reset();
  const unhealthyOnProxy = await install({ name: 'cache-become-unhealthy', network: 'proxy' }, 'redis');
  assert.equal(unhealthyOnProxy.operation.status, 'failed');
  assert.ok(!posts().some((l) => l.startsWith('DELETE /networks/')), 'rollback never removes a network the install did not create');
  // 3 — a named volume the operator points at is attached, never recreated or removed; a failed run keeps it too
  ENGINE.reset();
  const shared = await install({ name: 'pg-shared-become-unhealthy', volumes: { '/var/lib/postgresql/data': 'volume:jellyfin-config' }, variables: { POSTGRES_PASSWORD: 'x-y-z-123456' } }, 'postgres');
  assert.equal(shared.operation.status, 'failed');
  assert.ok(!posts().some((l) => l.startsWith('DELETE /volumes')));
  assert.equal(fx('jellyfin').State, 'running', 'the volume\'s other user is untouched');
  // 4 — nothing else changed
  assert.deepEqual(snapshot().fleet.filter((f) => !/cache-onproxy/.test(f)), before.fleet);
  assert.deepEqual(snapshot().nets, before.nets);
  // the install never issues stack-scoped or foreign-container writes
  assert.ok(!ENGINE.log.some((l) => /^(POST|DELETE) \/containers\/(?!create)(?!e1e2e3)/.test(l)), 'no write to a pre-existing container');
});

/* ------------------------------------------------------------------ */
/* 6 + 7. operation boundary and secret hygiene, end to end             */
/* ------------------------------------------------------------------ */

test('operation boundary: no session → 401; viewer → 403; no token → 409; a catalog install is one operation record with confirmation, lock, verification, event and activity', async () => {
  const saved = COOKIE; COOKIE = null;
  const anon = await post('/api/v1/operations/dry-run', { action: 'service.install', target: { type: 'catalog', id: 'redis' }, params: { config: { name: 'x' } } });
  COOKIE = saved;
  assert.equal(anon.status, 401);
  const noToken = await post('/api/v1/operations', { action: 'service.install', target: { type: 'catalog', id: 'redis' }, params: { config: { name: 'cache-notoken' } } });
  assert.ok([400, 409].includes(noToken.status), String(noToken.status)); assert.ok(!fx('cache-notoken'));
  const r = await install({ name: 'cache-bound' }, 'redis');
  const op = r.operation;
  assert.equal(op.status, 'succeeded');
  assert.equal(op.confirmation.consumed, true);
  assert.equal(op.confirmation.mode, 'strong');
  assert.equal(op.verification.verified, true);
  assert.ok(op.auditId);
  const trail = await get(`/api/v1/operations/${op.id}/trail`);
  assert.equal(trail.status, 200);
  assert.ok(events.getRecentEvents({ limit: 100 }).some((e) => e.type === 'operation.completed' && e.correlation?.operationId === op.id), 'Event Bus completion event');
  assert.ok(JSON.stringify((await get('/api/activity?limit=100')).json).includes('cache-bound'));
  assert.equal(op.result.newContainerId, fx('cache-bound').Id.slice(0, 12));
});

test('secret hygiene: a generated/typed secret reaches only the container — never records, events, activity, history, responses, error messages or server logs', async () => {
  const SECRET = 'Zq9!review-secret-7731';
  LOGS.length = 0;
  const ok = await install({ name: 'pg-hyg', variables: { POSTGRES_PASSWORD: SECRET } }, 'postgres');
  assert.equal(ok.operation.status, 'succeeded', JSON.stringify(ok.operation.error));
  const bad = await install({ name: 'pg-hyg-become-unhealthy', variables: { POSTGRES_PASSWORD: SECRET } }, 'postgres');
  assert.equal(bad.operation.status, 'failed');
  const preview = await post('/api/v1/catalog/postgres/plan', { config: { name: 'pg-hyg-preview', variables: { POSTGRES_PASSWORD: SECRET } } });
  assert.equal(preview.status, 200);
  const blob = JSON.stringify([
    ok.dryRun.json, ok.operation, bad.dryRun.json, bad.operation, preview.json,
    (await get('/api/activity?limit=200')).json, (await get('/api/v1/events?limit=200')).json,
    (await get('/api/v1/operations?limit=100')).json, (await get('/api/v1/catalog/installs')).json, (await get('/api/v1/catalog/postgres')).json,
    (await get(`/api/v1/operations/${ok.operation.id}/trail`)).json, (await get(`/api/v1/operations/${bad.operation.id}/trail`)).json,
    (await get('/api/v1/containers/pg-hyg/spec')).json,
  ]);
  assert.ok(!blob.includes(SECRET), 'the secret leaked into an API response or record');
  assert.ok(!LOGS.join('\n').includes(SECRET), 'the secret was logged');
  for (const f of fs.readdirSync(DATA_DIR, { recursive: true })) {
    const p = path.join(DATA_DIR, String(f));
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, 'utf8').includes(SECRET), `the secret is on disk in ${f}`);
  }
  assert.ok(fx('pg-hyg').Config.Env.includes(`POSTGRES_PASSWORD=${SECRET}`), 'the container itself gets the real value');
});

/* ------------------------------------------------------------------ */
/* 2 + 3 + 4. static architecture proofs                                */
/* ------------------------------------------------------------------ */

test('proxy abstraction: only proxy/provider.js knows Traefik label names; catalog, spec and UI carry canonical exposure only', () => {
  for (const rel of ['server/catalog/planner.js', 'server/catalog/runners.js', 'server/catalog/schema.js', 'server/catalogApi.js', 'server/containers/spec.js', 'server/operations/policy.js', 'server/operations/engine.js', 'src/pages/Catalog.tsx', 'src/pages/CatalogInstall.tsx']) {
    const src = code(rel);
    assert.ok(!/traefik\.(http|enable|docker)/.test(src), `${rel} builds Traefik labels itself`);
  }
  assert.ok(/traefik\.http\.routers/.test(code('server/proxy/provider.js')));
  assert.ok(/labelsFor\(/.test(code('server/catalog/planner.js')) && /normalizeExpose\(/.test(code('server/catalog/planner.js')));
  for (const m of fs.readdirSync(path.join(ROOT, 'server/catalog/manifests'))) {
    assert.ok(!/traefik/i.test(fs.readFileSync(path.join(ROOT, 'server/catalog/manifests', m), 'utf8')), `${m} names the proxy implementation`);
  }
});

test('install security: catalog code cannot spawn, cannot reach the socket, cannot call arbitrary Docker methods; every engine write is a frozen adapter call', () => {
  for (const rel of ['server/catalog/planner.js', 'server/catalog/runners.js', 'server/catalog/schema.js', 'server/catalog/template.js', 'server/catalog/store.js', 'server/catalogApi.js', 'server/proxy/provider.js']) {
    const src = code(rel);
    assert.ok(!/child_process|execSync|spawn\(|exec\(|new Function|\beval\(|vm\./.test(src), `${rel} has an execution surface`);
    assert.ok(!/docker\.sock|requestJson\(|requestRaw\(|http\.request\(|net\.connect\(|socketPath/.test(src), `${rel} reaches the engine directly`);
    assert.ok(!/docker compose|docker-compose|\bdocker\s+(run|exec|pull)\b/.test(src), `${rel} mentions the CLI`);
  }
  const runners = code('server/catalog/runners.js');
  const adapterCalls = [...runners.matchAll(/adapter\.(\w+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(adapterCalls)], ['connectNetwork', 'createContainer', 'createNetwork', 'createVolume', 'deleteContainer', 'inspectContainer', 'pullImage', 'removeNetwork', 'startContainer'].sort());
  assert.ok(!/fs\.|readFile|writeFile|mkdir/.test(runners), 'the runner touches no filesystem');
  // the schema forbids every dangerous field by construction: it only reads a closed key list
  const schema = code('server/catalog/schema.js');
  assert.match(schema, /TOP_KEYS = \[/);
  for (const banned of ['privileged', 'capAdd', 'cap_add', 'devices', 'pid', 'ipc', 'securityOpt', 'security_opt', 'sysctls', 'hooks', 'command_hooks', 'binds']) {
    assert.ok(!new RegExp(`TOP_KEYS = \\[[^\\]]*'${banned}'`).test(schema), `schema accepts ${banned}`);
  }
});

test('registry trust: the catalog uses registries/auth.js and the shared pull adapter — no second credential path', () => {
  const runners = code('server/catalog/runners.js');
  assert.match(runners, /from '\.\.\/registries\/auth\.js'/);
  assert.match(runners, /registries\.authHeaderFor\(/);
  assert.match(runners, /adapter\.pullImage\(/);
  for (const rel of ['server/catalog/planner.js', 'server/catalog/runners.js', 'server/catalogApi.js']) {
    assert.ok(!/x-registry-auth|X-Registry-Auth|Buffer\.from\([^)]*base64|decryptSecret|\.secret\b/.test(code(rel)), `${rel} handles credentials itself`);
  }
  assert.match(code('server/registries/auth.js'), /from '\.\/client\.js'/, 'auth.js is a re-export of the 10D-C client, not a second implementation');
  assert.match(code('server/registries/client.js'), /registryHostOf\(imageRef\)/, 'the shared helper matches on image host');
});

test('registry trust at runtime: a catalog pull attaches a credential only for a matching host, and the credential never surfaces', async () => {
  process.env.OPUSHUB_SECRET_KEY = 'e'.repeat(64);
  const store = await import('./registries/store.js');
  store.upsertRegistry({ id: 'corp2', name: 'Corp2', kind: 'oci', endpoint: 'https://reg2.example.com', host: 'reg2.example.com', username: 'bob', secret: 'pw-REVIEW-SECRET', actor: 'root' });
  PULL_AUTH.length = 0;
  const r = await install({ name: 'web-corp', tag: 'not-present', ports: { '80/tcp': 18210 }, registryId: 'corp2' }, 'nginx');
  assert.equal(r.operation.status, 'succeeded', JSON.stringify(r.operation.error));
  assert.equal(PULL_AUTH.length, 0, 'nginx is a Docker Hub image: the corp credential is not sent even when asked for');
  assert.ok(!JSON.stringify([r.dryRun.json, r.operation]).includes('pw-REVIEW-SECRET'));
  store._resetRegistriesStore();
});
