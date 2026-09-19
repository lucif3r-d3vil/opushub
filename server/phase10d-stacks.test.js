// Phase 10D-B — stacks: Compose as data, deployed natively through the engine API.
//
// Parser (no execution, explicit subset), policy (SAFE/WARNING/DANGEROUS/BLOCKED), the managed
// store, and the deployment pipeline end to end against the mock engine: create → deploy →
// change → redeploy (recreate only what changed) → partial failure with rollback → stop/start →
// remove (volumes kept). Also proves the routes are inside the session gate and that a stack
// operation locks every member.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine, FLEET, CREATED_NETWORKS, CREATED_VOLUMES } from '../test/mock-engine.js';
import { stripComments } from '../test/source-scan.js';

const OLD_ENV = { ...process.env };
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10ds-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10ds-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;
process.env.OPUSHUB_OP_VERIFY_MS = '2500';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const code = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

let ENGINE = null;
let handleApi;
let COOKIE = null;
let VIEWER_COOKIE = null;
let locks = null;
let compose = null;
let stackPolicy = null;
let store = null;

function makeReq(method, body, extraHeaders = {}) {
  const headers = { ...extraHeaders, 'content-type': 'application/json', host: 'opushub.test' };
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
  return {
    state,
    setHeader: (k, v) => { state.headers[String(k).toLowerCase()] = v; },
    writeHead: (s, h) => { state.status = s; for (const [k, v] of Object.entries(h || {})) state.headers[String(k).toLowerCase()] = v; },
    end: (b) => { state.body = String(b ?? ''); },
  };
}
async function call(method, pathname, body = null, cookie = COOKIE) {
  const saved = COOKIE;
  COOKIE = cookie;
  const r = makeRes();
  await handleApi(makeReq(method, body), r, new URL(pathname, 'http://opushub.test'));
  COOKIE = saved;
  let json = null;
  try { json = JSON.parse(r.state.body || 'null'); } catch {}
  return { status: r.state.status, json, text: r.state.body };
}
const get = (p, cookie) => call('GET', p, null, cookie);
const post = (p, body, cookie) => call('POST', p, body, cookie);
const patch = (p, body, cookie) => call('PATCH', p, body, cookie);
const del = (p, cookie) => call('DELETE', p, null, cookie);
async function settle(id, timeoutMs = 30_000) {
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
/** The stack verb wrappers return a dry-run + token; execution is the ordinary operations POST. */
async function runStack(verb, id) {
  locks._resetLimits();
  const d = await post(`/api/v1/stacks/${id}/${verb}`);
  if (d.status !== 200) return { dryRun: d, operation: d.json?.operation ?? null };
  const e = await post('/api/v1/operations', { action: `stack.${verb}`, target: { type: 'stack', id }, confirmationToken: d.json.confirmation.token, operationId: d.json.operation.id });
  const operation = e.status === 202 ? await settle(e.json.operation.id) : e.json.operation;
  return { dryRun: d, execute: e, operation };
}
const posts = () => ENGINE.log.filter((l) => !l.startsWith('GET '));
const fx = (name) => FLEET.find((f) => f.Names[0] === `/${name}`);

const DOC = `
services:
  web:
    image: ghcr.io/example/web:1.0
    ports: ["8088:80"]
    environment:
      GREETING: hello
      API_TOKEN: \${API_TOKEN}
    depends_on: [db]
    volumes:
      - data:/var/lib/web
  db:
    image: docker.io/library/postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: \${DB_PASSWORD:-changeme}
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  data: {}
  dbdata: {}
`;

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  ({ handleApi } = await import('./api.js'));
  locks = await import('./operations/locks.js');
  compose = await import('./stacks/compose.js');
  stackPolicy = await import('./stacks/policy.js');
  store = await import('./stacks/store.js');
  const { seedSession } = await import('../test/auth-helper.js');
  COOKIE = await seedSession();
  const auth = await import('./auth.js');
  const viewerSession = auth.createSession({ username: 'a-visitor', ip: '127.0.0.1' });
  VIEWER_COOKIE = `${auth.SESSION_COOKIE}=${viewerSession.id}`;
});
test.after(async () => {
  await ENGINE?.stop();
  process.env = OLD_ENV;
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
test.beforeEach(() => { locks._resetLimits(); ENGINE.reset(); });

/* ------------------------------ 1. the parser ------------------------------ */

test('the parser produces canonical specs, resolves variables from the stack env only, and orders by depends_on', () => {
  process.env.API_TOKEN = 'from-process-env-must-not-leak';
  const r = compose.parseCompose(DOC, { project: 'shop', env: { API_TOKEN: 'abc' } });
  delete process.env.API_TOKEN;
  assert.ok(r.ok, r.errors.join('; '));
  assert.deepEqual(r.model.services.map((s) => s.key), ['db', 'web'], 'dependency order');
  const web = r.model.services.find((s) => s.key === 'web');
  assert.equal(web.containerName, 'shop-web-1');
  assert.equal(web.spec.env.API_TOKEN, 'abc');
  assert.equal(r.model.services.find((s) => s.key === 'db').spec.env.POSTGRES_PASSWORD, 'changeme', '${VAR:-default}');
  assert.deepEqual(web.spec.ports, [{ hostIp: null, host: 8088, container: 80, protocol: 'tcp' }]);
  assert.deepEqual(web.spec.volumes, [{ type: 'volume', source: 'shop_data', target: '/var/lib/web', readOnly: false }], 'named volumes get the project prefix');
  assert.deepEqual(web.spec.networks.map((n) => n.name), ['shop_default']);
  assert.equal(web.spec.labels['com.docker.compose.project'], 'shop');
  assert.equal(web.spec.labels['com.docker.compose.service'], 'web');
  assert.deepEqual(r.model.volumes.map((v) => v.name), ['shop_data', 'shop_dbdata']);
  assert.deepEqual(r.model.networks.map((n) => n.name), ['shop_default']);
  assert.ok(r.model.hash && r.model.hash.length === 32);
  // ${VAR:?} is an error; a missing plain ${VAR} is a warning
  const req = compose.parseCompose('services:\n  a:\n    image: x:1\n    environment:\n      A: ${MISSING:?needed}\n', { project: 'p' });
  assert.equal(req.ok, false);
  assert.match(req.errors[0], /MISSING is required/);
  const warn = compose.parseCompose('services:\n  a:\n    image: x:1\n    environment:\n      A: ${MISSING}\n', { project: 'p' });
  assert.ok(warn.ok);
  assert.match(warn.warnings[0], /MISSING is not set/);
  // a cycle is refused
  const cyc = compose.parseCompose('services:\n  a:\n    image: x:1\n    depends_on: [b]\n  b:\n    image: y:1\n    depends_on: [a]\n', { project: 'p' });
  assert.ok(cyc.errors.some((e) => /cycle/.test(e)));
});

test('the parser refuses what it cannot deploy honestly: build, env_file, relative binds, extends, host namespaces', () => {
  const doc = `
services:
  a:
    image: x:1
    build: .
    env_file: .env
    pid: host
    volumes:
      - ./config:/config
      - /etc/app:/etc/app:ro
`;
  const r = compose.parseCompose(doc, { project: 'p' });
  assert.ok(r.ok, 'unsupported keys are reported, not parse errors');
  const where = r.model.unsupported.map((u) => u.where);
  assert.ok(where.includes('services.a.build'));
  assert.ok(where.includes('services.a.env_file'));
  assert.ok(where.includes('services.a.pid'));
  assert.ok(r.model.unsupported.some((u) => u.where === 'services.a.volumes' && /relative bind/.test(u.reason)));
  const pol = stackPolicy.classifyStack(r.model);
  assert.equal(pol.level, 'BLOCKED');
  assert.ok(pol.findings.filter((f) => f.code === 'unsupported').length >= 4);
  // and the parser never touches the filesystem or a process
  const src = code('server/stacks/compose.js');
  for (const banned of ['child_process', 'readFileSync', 'readFile(', 'process.env', 'execSync', 'spawn', 'eval(', 'new Function']) assert.ok(!src.includes(banned), `compose.js contains ${banned}`);
  // YAML custom tags cannot smuggle anything in
  const tagged = compose.parseCompose('services:\n  a:\n    image: !!js/function "function(){}"\n', { project: 'p' });
  assert.equal(tagged.ok, false);
});

test('the policy classifies a stack: SAFE, WARNING, DANGEROUS, BLOCKED — and catches host-port clashes', () => {
  const classify = (doc) => stackPolicy.classifyStack(compose.parseCompose(doc, { project: 'p' }).model);
  assert.equal(classify('services:\n  a:\n    image: x:1\n').level, 'SAFE');
  assert.equal(classify('services:\n  a:\n    image: x:1\n    ports: ["80:80"]\n').level, 'WARNING');
  assert.equal(classify('services:\n  a:\n    image: x:1\n    network_mode: host\n').level, 'DANGEROUS');
  assert.equal(classify('services:\n  a:\n    image: x:1\n    cap_add: [NET_ADMIN]\n').level, 'DANGEROUS');
  assert.equal(classify('services:\n  a:\n    image: x:1\n    privileged: true\n').level, 'BLOCKED');
  assert.equal(classify('services:\n  a:\n    image: x:1\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n').level, 'BLOCKED');
  assert.equal(classify('services:\n  a:\n    image: x:1\n    cap_add: [SYS_ADMIN]\n').level, 'BLOCKED');
  assert.equal(classify('services:\n  a:\n    image: x:1\n    security_opt: ["seccomp=unconfined"]\n').level, 'DANGEROUS');
  assert.equal(classify('services:\n  a:\n    image: x:1\n    devices: ["/dev/sda:/dev/sda"]\n').level, 'BLOCKED');
  const clash = classify('services:\n  a:\n    image: x:1\n    ports: ["9000:80"]\n  b:\n    image: y:1\n    ports: ["9000:80"]\n');
  assert.equal(clash.level, 'BLOCKED');
  assert.ok(clash.findings.some((f) => f.code === 'port_conflict'));
});

/* ------------------------------ 2. the managed store + routes ------------------------------ */

test('creating a managed stack validates, stores, masks secrets, and deploys nothing', async () => {
  const r = await post('/api/v1/stacks/managed', { name: 'shop', compose: DOC, env: { API_TOKEN: 'supersecret-token' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.stack.revision, 1);
  assert.notEqual(r.json.stack.env.API_TOKEN, 'supersecret-token', 'secret env is masked in the response');
  assert.match(r.json.stack.env.API_TOKEN, /^••••/);
  assert.deepEqual(posts(), [], 'creating the definition touches nothing on the engine');
  const list = await get('/api/v1/stacks/managed');
  assert.equal(list.json.stacks.length, 1);
  assert.ok(!JSON.stringify(list.json).includes('supersecret-token'));
  // blocked documents are refused at the door
  const blocked = await post('/api/v1/stacks/managed', { name: 'evil', compose: 'services:\n  a:\n    image: x:1\n    privileged: true\n' });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.json.code, 'policy_blocked');
  // so are broken ones, unknown fields, and duplicate names
  assert.equal((await post('/api/v1/stacks/managed', { name: 'bad', compose: 'services: [' })).status, 422);
  assert.equal((await post('/api/v1/stacks/managed', { name: 'bad', compose: DOC, command: 'rm -rf /' })).status, 400);
  assert.equal((await post('/api/v1/stacks/managed', { name: 'shop', compose: DOC })).status, 409);
  // the routes sit inside the session gate and the permission model
  assert.equal((await get('/api/v1/stacks/managed', null)).status, 401);
  assert.equal((await post('/api/v1/stacks/managed', { name: 'x', compose: DOC }, VIEWER_COOKIE)).status, 403);
  // the discovery projection does not list a stack that has no containers
  const disc = await get('/api/stacks');
  assert.ok(!disc.json.stacks.some((s) => s.id === 'shop'), 'the store never fabricates inventory');
});

test('validate and plan are side-effect free and describe exactly what a deploy would do', async () => {
  const v = await post('/api/v1/stacks/managed/shop/validate');
  assert.equal(v.status, 200);
  assert.ok(v.json.ok);
  assert.deepEqual(v.json.services.map((s) => s.key), ['db', 'web']);
  const plan = await post('/api/v1/stacks/managed/shop/plan');
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.deepEqual(plan.json.plan.services.map((s) => [s.key, s.action]), [['db', 'create'], ['web', 'create']]);
  assert.ok(plan.json.plan.services.every((s) => !('desired' in s) && !('_model' in plan.json.plan)), 'the runner input is not exposed');
  assert.deepEqual(posts(), [], 'planning writes nothing');
  assert.ok(!JSON.stringify(plan.json).includes('supersecret-token'));
});

/* ------------------------------ 3. deployment ------------------------------ */

test('deploy creates networks, volumes and containers in dependency order, verifies, and records history', async () => {
  const { dryRun, operation } = await runStack('deploy', 'shop');
  assert.equal(dryRun.status, 200, JSON.stringify(dryRun.json));
  assert.equal(dryRun.json.confirmation.mode, 'strong');
  assert.equal(operation.status, 'succeeded', JSON.stringify(operation.error));
  assert.ok(fx('shop-db-1') && fx('shop-web-1'));
  assert.ok(CREATED_NETWORKS.has('shop_default'));
  assert.ok(CREATED_VOLUMES.has('shop_data') && CREATED_VOLUMES.has('shop_dbdata'));
  const seq = posts().map((l) => l.replace(/\?.*$/, '').replace(/\/containers\/[^/]+\/(start)/, '/containers/<id>/$1'));
  const dbCreate = seq.indexOf('POST /containers/create');
  assert.ok(dbCreate > seq.indexOf('POST /networks/create'), 'networks before containers');
  assert.equal(seq.filter((l) => l === 'POST /containers/create').length, 2);
  assert.ok(seq.every((l) => !/\/exec|\/prune|v=1/.test(l)));
  // the labels compose writes are present, so discovery groups the new containers as a stack
  assert.equal(fx('shop-web-1').Labels['com.docker.compose.project'], 'shop');
  assert.ok(fx('shop-web-1').Labels['io.opushub.config-hash']);
  const disc = await get('/api/stacks');
  const shop = disc.json.stacks.find((s) => s.id === 'shop');
  assert.ok(shop, 'the deployed stack is now discovered from Docker');
  assert.equal(shop.containerCount, 2);
  const detail = await get('/api/v1/stacks/managed/shop');
  assert.equal(detail.json.stack.state, 'running');
  assert.equal(detail.json.stack.lastDeploy.status, 'succeeded');
  assert.equal(detail.json.history[0].status, 'succeeded');
  assert.ok(!('compose' in detail.json.history[0]), 'history rows carry no document');
});

test('a second deploy of the same document changes nothing; a changed service is recreated alone', async () => {
  const same = await runStack('deploy', 'shop');
  assert.equal(same.operation.status, 'succeeded', JSON.stringify(same.operation.error));
  assert.deepEqual(posts().filter((l) => /containers\/create|\/rename|networks\/create|volumes\/create/.test(l)), [], 'nothing recreated');
  assert.deepEqual(same.dryRun.json.dryRun.plan.services.map((s) => s.action), ['unchanged', 'unchanged']);

  const changed = DOC.replace('GREETING: hello', 'GREETING: bonjour');
  const upd = await patch('/api/v1/stacks/managed/shop', { compose: changed });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));
  assert.equal(upd.json.stack.revision, 2);
  const stored = store.getStack('shop');
  assert.equal(stored.env.API_TOKEN, 'supersecret-token', 'a masked env sent back keeps the stored secret');

  const webId = fx('shop-web-1').Id;
  const { dryRun, operation } = await runStack('deploy', 'shop');
  assert.deepEqual(dryRun.json.dryRun.plan.services.map((s) => [s.key, s.action]), [['db', 'unchanged'], ['web', 'recreate']]);
  assert.deepEqual(dryRun.json.dryRun.plan.services[1].diff.changed, ['env']);
  assert.equal(operation.status, 'succeeded', JSON.stringify(operation.error));
  assert.notEqual(fx('shop-web-1').Id, webId, 'web was replaced');
  assert.ok(!FLEET.some((f) => f.Id === webId), 'the old web container is gone');
  assert.equal(posts().filter((l) => l.startsWith('POST /containers/create')).length, 1, 'only web was created');
  assert.ok(!posts().some((l) => /v=1/.test(l)));
});

test('editing the document invalidates a deploy confirmation issued for the previous revision', async () => {
  const d = await post('/api/v1/stacks/shop/deploy');
  assert.equal(d.status, 200);
  await patch('/api/v1/stacks/managed/shop', { compose: DOC.replace('GREETING: hello', 'GREETING: hola') });
  const e = await post('/api/v1/operations', { action: 'stack.deploy', target: { type: 'stack', id: 'shop' }, confirmationToken: d.json.confirmation.token });
  assert.equal(e.json.operation.error.code, 'confirmation_mismatch');
  assert.deepEqual(posts(), []);
  await patch('/api/v1/stacks/managed/shop', { compose: DOC.replace('GREETING: hello', 'GREETING: bonjour') });
});

test('a partial failure stops the pipeline, rolls back what this run created, and reports honestly', async () => {
  const doc = `
services:
  ok:
    image: alpine:3.20
  broken:
    image: alpine:3.20
    container_name: exit-immediately-broken
    depends_on: [ok]
`;
  assert.equal((await post('/api/v1/stacks/managed', { name: 'fragile', compose: doc })).status, 201);
  const { operation } = await runStack('deploy', 'fragile');
  assert.equal(operation.status, 'failed');
  assert.match(operation.error.reason, /broken.*exited immediately/);
  assert.ok(!fx('fragile-ok-1'), 'the service created earlier in this run was rolled back');
  assert.ok(!fx('exit-immediately-broken'));
  assert.ok(!CREATED_NETWORKS.has('fragile_default'), 'the network created in this run was removed');
  const detail = await get('/api/v1/stacks/managed/fragile');
  assert.equal(detail.json.stack.lastDeploy.status, 'failed');
  const h = detail.json.history[0];
  assert.equal(h.status, 'failed');
  assert.deepEqual(h.services.map((s) => [s.key, s.result]), [['ok', 'rolled_back'], ['broken', 'failed']]);
  assert.equal(detail.json.stack.state, 'not_deployed');
  // no rollback point exists (nothing ever succeeded)
  assert.equal((await post('/api/v1/stacks/managed/fragile/rollback')).status, 404);
});

test('a deploy that changes a running service and fails verification leaves the previous container running', async () => {
  // change web's image to one that exits at once: the recreate ladder must restore the old web
  const doc = DOC.replace('GREETING: hello', 'GREETING: bonjour').replace('ghcr.io/example/web:1.0', 'ghcr.io/example/web:2.0').replace('image: ghcr.io/example/web:2.0', 'image: ghcr.io/example/web:2.0\n    container_name: shop-web-exit-immediately');
  // (container_name changes → the plan sees "web" by service label, recreates under the new name)
  const before = fx('shop-web-1');
  const upd = await patch('/api/v1/stacks/managed/shop', { compose: doc });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));
  const { operation } = await runStack('deploy', 'shop');
  assert.equal(operation.status, 'failed', JSON.stringify(operation));
  assert.ok(fx('shop-web-1'), 'the previous web container is back under its name');
  assert.equal(fx('shop-web-1').State, 'running');
  assert.equal(fx('shop-web-1').Id, before.Id);
  assert.ok(!fx('shop-web-exit-immediately'));
  // rollback restores the last good document as a new revision (deploy is a separate, confirmed step)
  ENGINE.reset();
  const rb = await post('/api/v1/stacks/managed/shop/rollback');
  assert.equal(rb.status, 200, JSON.stringify(rb.json));
  assert.equal(store.getStack('shop').compose, DOC.replace('GREETING: hello', 'GREETING: bonjour'));
  assert.deepEqual(posts(), [], 'rolling back the document deploys nothing by itself');
});

/* ------------------------------ 4. lifecycle + locks + remove ------------------------------ */

test('stack stop and start act on every member, in dependency order, and are verified', async () => {
  const stop = await runStack('stop', 'shop');
  assert.equal(stop.operation.status, 'succeeded', JSON.stringify(stop.operation.error));
  assert.equal(fx('shop-web-1').State, 'exited');
  assert.equal(fx('shop-db-1').State, 'exited');
  const nameOf = (l) => FLEET.find((f) => l.includes(f.Id.slice(0, 12)))?.Names[0] || l;
  assert.deepEqual(posts().map(nameOf), ['/shop-web-1', '/shop-db-1'], 'dependants stop first');
  ENGINE.reset();
  const start = await runStack('start', 'shop');
  assert.equal(start.operation.status, 'succeeded', JSON.stringify(start.operation.error));
  assert.equal(fx('shop-web-1').State, 'running');
  assert.deepEqual(posts().map(nameOf), ['/shop-db-1', '/shop-web-1'], 'dependencies start first');
  // discovered (non-managed) stacks get the lifecycle verbs too, but never deploy
  const d = await post('/api/v1/stacks/opustream/deploy');
  assert.equal(d.status, 409, JSON.stringify(d.json));
  assert.equal(d.json.code, 'not_managed');
  const s = await post('/api/v1/stacks/opustream/stop');
  assert.equal(s.status, 200);
  await post(`/api/v1/operations/${s.json.operation.id}/cancel`);
});

test('a stack operation holds the stack lock and every member, so a member operation is refused meanwhile', async () => {
  const d = await post('/api/v1/stacks/shop/stop');
  assert.equal(d.status, 200);
  // simulate the running stack operation holding its keys
  const keys = ['stack:shop', ...FLEET.filter((f) => f.Labels['com.docker.compose.project'] === 'shop').map((f) => f.Id.slice(0, 12))];
  for (const k of keys) locks.acquire(k, { opId: 'op-running', action: 'stack.stop' });
  const m = await post('/api/v1/operations/dry-run', { action: 'container.restart', target: { type: 'container', id: 'shop-web-1' } });
  assert.equal(m.status, 409, JSON.stringify(m.json));
  assert.equal(m.json.code, 'already_running');
  const other = await post('/api/v1/stacks/shop/deploy');
  assert.equal(other.status, 409);
  locks._resetLimits();
  await post(`/api/v1/operations/${d.json.operation.id}/cancel`);
});

test('OpusHub refuses to stop or remove the stack it runs in', async () => {
  const targets = await import('./operations/targets.js');
  const opushub = fx('opushub');
  targets._forceSelf(opushub.Id);
  try {
    // put OpusHub into a project for this test
    opushub.Labels['com.docker.compose.project'] = 'shop';
    opushub.Labels['com.docker.compose.service'] = 'opushub';
    const { invalidateDiscovery } = await import('./model.js');
    invalidateDiscovery();
    const s = await post('/api/v1/stacks/shop/stop');
    assert.notEqual(s.status, 200);
    assert.equal(s.json.code, 'ineligible');
    const r = await post('/api/v1/stacks/shop/remove');
    assert.equal(r.json.code, 'ineligible');
  } finally {
    delete opushub.Labels['com.docker.compose.project'];
    delete opushub.Labels['com.docker.compose.service'];
    targets._forceSelf(null);
    const { invalidateDiscovery } = await import('./model.js');
    invalidateDiscovery();
  }
});

test('stack remove deletes the containers and the networks it created, keeps volumes, and the definition survives', async () => {
  const { dryRun, operation } = await runStack('remove', 'shop');
  assert.equal(dryRun.json.confirmation.mode, 'strong');
  assert.equal(operation.status, 'succeeded', JSON.stringify(operation.error));
  assert.ok(!fx('shop-web-1') && !fx('shop-db-1'));
  assert.ok(!CREATED_NETWORKS.has('shop_default'));
  assert.ok(CREATED_VOLUMES.has('shop_data'), 'volumes are never deleted');
  assert.ok(!posts().some((l) => /v=1|\/volumes\//.test(l)));
  const detail = await get('/api/v1/stacks/managed/shop');
  assert.equal(detail.status, 200, 'the definition is still there');
  assert.equal(detail.json.stack.state, 'not_deployed');
  // and can now be forgotten
  assert.equal((await del('/api/v1/stacks/managed/shop')).status, 200);
  assert.equal((await get('/api/v1/stacks/managed/shop')).status, 404);
});

/* ------------------------------ 5. static proofs ------------------------------ */

test('stack modules reach the engine only through the frozen adapters and never through a shell', () => {
  for (const rel of ['server/stacks/runners.js', 'server/stacks/targets.js', 'server/stacks/compose.js', 'server/stacks/policy.js', 'server/stacks/store.js', 'server/stacksApi.js']) {
    const src = code(rel);
    for (const banned of ['child_process', 'execSync', 'spawn(', 'docker compose', 'docker-compose', 'http.request(', 'net.connect', 'docker.sock']) {
      assert.ok(!src.includes(banned), `${rel} contains ${banned}`);
    }
  }
  // the API module has no path to a write: it only asks the engine for a dry-run
  const api = code('server/stacksApi.js');
  assert.ok(!/executeOperation|recreateAdapter|dockerOperations|stacks\/runners/.test(api));
  assert.ok(api.includes('requestOperation('), 'the verbs are thin dry-run wrappers');
  // deploy runs from the stored revision: no compose text travels in an operation
  assert.ok(!/params\.compose/.test(code('server/stacks/runners.js')));
});
