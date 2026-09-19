// Phase 10D-A — controlled container management.
//
// Every new action goes through the same pipeline as Phase 8's three: request → authz → params →
// target → policy → plan → confirmation (bound to the plan) → allow-listed call → verification →
// events → activity. These tests run that pipeline end to end against the mock engine and check
// the wire log, the rollback behaviour and the read surface behind the Edit Container UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine, FLEET, PULLED, PULL_AUTH } from '../test/mock-engine.js';
import { stripComments } from '../test/source-scan.js';

const OLD_ENV = { ...process.env };
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10d-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p10d-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;
process.env.OPUSHUB_OP_VERIFY_MS = '3000';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const code = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

let ENGINE = null;
let handleApi;
let COOKIE = null;
let VIEWER_COOKIE = null;
let locks = null;
let registry = null;
let params = null;
let spec = null;
let policy = null;
let diff = null;

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
const dryRun = (action, target, params) => post('/api/v1/operations/dry-run', { action, target, ...(params !== undefined ? { params } : {}) });
const execute = (action, target, params, token, operationId) => post('/api/v1/operations', { action, target, ...(params !== undefined ? { params } : {}), confirmationToken: token, operationId });
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
async function run(action, target, params) {
  locks._resetLimits();
  const d = await dryRun(action, target, params);
  if (d.status !== 200) return { dryRun: d, operation: d.json?.operation ?? null };
  const e = await execute(action, target, params, d.json.confirmation.token, d.json.operation.id);
  const operation = e.status === 202 ? await settle(e.json.operation.id) : e.json.operation;
  return { dryRun: d, execute: e, operation };
}
const posts = () => ENGINE.log.filter((l) => !l.startsWith('GET '));
const fx = (name) => FLEET.find((f) => f.Names[0] === `/${name}`);

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  ({ handleApi } = await import('./api.js'));
  locks = await import('./operations/locks.js');
  registry = await import('./operations/registry.js');
  params = await import('./operations/params.js');
  spec = await import('./containers/spec.js');
  policy = await import('./containers/policy.js');
  diff = await import('./containers/diff.js');
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

/* ------------------------------ 1. parameters ------------------------------ */

test('every action declares a parameter schema, and unknown parameter keys are refused', () => {
  for (const id of registry.ACTION_IDS) assert.ok(params.PARAM_KINDS.includes(registry.getAction(id).params), id);
  assert.equal(params.parseParams('none', {}).ok, true);
  assert.equal(params.parseParams('none', { force: true }).ok, false, 'a no-parameter action refuses parameters');
  assert.equal(params.parseParams('rename', { name: 'ok-name', extra: 1 }).ok, false);
  assert.equal(params.parseParams('rename', { name: '../etc' }).ok, false);
  assert.equal(params.parseParams('rename', { name: '/leading-slash' }).params.name, 'leading-slash');
  assert.equal(params.parseParams('network', { network: 'proxy', aliases: ['a b'] }).ok, false);
  assert.equal(params.parseParams('image', { image: 'nginx:latest; rm -rf /' }).ok, false);
  assert.equal(params.parseParams('spec_patch', { spec: { privileged: true, exec: ['sh'] } }).ok, false, 'unknown spec fields are refused, not ignored');
  assert.equal(params.parseParams('spec_patch', { spec: {} }).ok, false, 'an empty edit is not an edit');
  assert.equal(params.parseParams('spec', { spec: { name: 'x' } }).ok, false, 'a create needs an image');
  // canonical hashing: key order does not matter, values do
  assert.equal(params.paramsHash({ a: 1, b: { c: [1, 2] } }), params.paramsHash({ b: { c: [1, 2] }, a: 1 }));
  assert.notEqual(params.paramsHash({ name: 'a' }), params.paramsHash({ name: 'b' }));
});

test('the confirmation token is bound to the parameters: a token for one plan cannot run another', async () => {
  const target = { type: 'service', id: 'radarr' };
  const d = await dryRun('container.rename', target, { name: 'radarr-renamed' });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  // (no operationId: like Phase 8's proof, a mismatch against a named operation settles that
  // operation as rejected — here the point is the token, not the record)
  const wrong = await execute('container.rename', target, { name: 'radarr-other' }, d.json.confirmation.token);
  assert.equal(wrong.json.operation.error.code, 'confirmation_mismatch');
  assert.deepEqual(posts(), [], 'nothing reached the engine');
  // and the right parameters spend it
  const ok = await execute('container.rename', target, { name: 'radarr-renamed' }, d.json.confirmation.token, d.json.operation.id);
  assert.equal(ok.status, 202);
  const op = await settle(ok.json.operation.id);
  assert.equal(op.status, 'succeeded', JSON.stringify(op.error));
  assert.equal(fx('radarr-renamed')?.Id, 'd5e6f7a8b9c0e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4'.slice(0, 64));
  assert.deepEqual(posts().map((l) => l.replace(/\/containers\/[^/]+\//, '/containers/<id>/')), ['POST /containers/<id>/rename']);
  // put it back for the other tests
  await run('container.rename', { type: 'container', id: 'd5e6f7a8b9c0' }, { name: 'radarr' });
});

/* ------------------------------ 2. lifecycle additions ------------------------------ */

test('pause, unpause and kill are verified lifecycle operations', async () => {
  const t = { type: 'service', id: 'sonarr' };
  let r = await run('container.pause', t);
  assert.equal(r.operation.status, 'succeeded', JSON.stringify(r.operation.error));
  assert.equal(r.operation.verification.state, 'paused');
  r = await run('container.unpause', t);
  assert.equal(r.operation.status, 'succeeded');
  assert.equal(r.operation.verification.state, 'running');
  r = await run('container.kill', t);
  assert.equal(r.dryRun.json.confirmation.mode, 'strong', 'kill needs a strong confirmation');
  assert.equal(r.operation.status, 'succeeded');
  assert.equal(r.operation.verification.state, 'exited');
  assert.deepEqual(posts().map((l) => l.replace(/\/containers\/[^/]+\//, '/containers/<id>/')), ['POST /containers/<id>/pause', 'POST /containers/<id>/unpause', 'POST /containers/<id>/kill']);
  await run('container.start', t);
});

test('OpusHub will not kill, remove or recreate its own container', async () => {
  const targets = await import('./operations/targets.js');
  targets._forceSelf('911223344556');
  try {
  for (const [action, p] of [['container.kill', undefined], ['container.remove', { force: true }], ['container.recreate', undefined]]) {
    const d = await dryRun(action, { type: 'service', id: 'opushub' }, p);
    assert.equal(d.status, 422, `${action}: ${d.status} ${JSON.stringify(d.json)}`);
    assert.equal(d.json.operation.error.code, 'ineligible');
  }
  assert.deepEqual(posts(), []);
  } finally { targets._forceSelf(null); }
});

/* ------------------------------ 3. remove ------------------------------ */

test('remove refuses a running container without force, never deletes volumes, and verifies it is gone', async () => {
  const t = { type: 'service', id: 'paperless' }; // exited in the fixtures
  const running = await dryRun('container.remove', { type: 'service', id: 'qbittorrent' }, { force: false });
  assert.equal(running.status, 422);
  assert.equal(running.json.operation.error.code, 'container_running');
  const r = await run('container.remove', t, {});
  assert.equal(r.dryRun.json.dryRun.plan.kind, 'remove');
  assert.equal(r.operation.status, 'succeeded', JSON.stringify(r.operation.error));
  assert.equal(r.operation.result.volumesKept, true);
  assert.equal(fx('paperless'), undefined);
  const del = posts().find((l) => l.startsWith('DELETE'));
  assert.ok(del && !del.includes('v=1'), `volumes are never removed: ${del}`);
});

/* ------------------------------ 4. networks ------------------------------ */

test('network attach and detach are verified against the engine and refuse a missing network', async () => {
  const t = { type: 'service', id: 'seerr' };
  const missing = await run('container.network_attach', t, { network: 'no-such-network' });
  assert.equal(missing.operation.status, 'failed');
  assert.match(missing.operation.error.reason, /no network named/);
  const a = await run('container.network_attach', t, { network: 'backend', aliases: ['seerr-alt'] });
  assert.equal(a.operation.status, 'succeeded', JSON.stringify(a.operation.error));
  assert.ok(a.operation.result.networks.includes('backend'));
  const dup = await dryRun('container.network_attach', t, { network: 'backend' });
  assert.equal(dup.status, 400);
  assert.equal(dup.json.operation.error.code, 'no_change');
  const d = await run('container.network_detach', t, { network: 'backend' });
  assert.equal(d.dryRun.json.confirmation.mode, 'strong');
  assert.equal(d.operation.status, 'succeeded', JSON.stringify(d.operation.error));
  assert.ok(!d.operation.result.networks.includes('backend'));
  assert.deepEqual(posts().filter((l) => l.includes('/networks/')), ['POST /networks/no-such-network/connect', 'POST /networks/backend/connect', 'POST /networks/backend/disconnect']);
});

/* ------------------------------ 5. in-place update & edit ------------------------------ */

test('an in-place update changes only restart policy and resources, without a recreate', async () => {
  const t = { type: 'service', id: 'redis' };
  const before = fx('redis').Id;
  const r = await run('container.update', t, { spec: { restartPolicy: { name: 'always', maxRetries: 0 }, resources: { memory: 256 * 1024 * 1024 } } });
  assert.equal(r.dryRun.json.dryRun.plan.kind, 'update');
  assert.equal(r.dryRun.json.dryRun.plan.diff.inPlace, true);
  assert.equal(r.operation.status, 'succeeded', JSON.stringify(r.operation.error));
  assert.equal(fx('redis').Id, before, 'the container was not replaced');
  assert.deepEqual(posts().map((l) => l.replace(/\/containers\/[^/]+\//, '/containers/<id>/')), ['POST /containers/<id>/update']);
  const notInPlace = await dryRun('container.update', t, { spec: { env: { A: 'b' } } });
  assert.equal(notInPlace.status, 400);
  assert.equal(notInPlace.json.operation.error.code, 'needs_recreate');
});

test('an edit that needs a recreate runs the full ladder and the diff names exactly what changed', async () => {
  const t = { type: 'service', id: 'vaultwarden' };
  const oldId = fx('vaultwarden').Id;
  const preview = await post('/api/v1/containers/vaultwarden/diff', { spec: { env: { MOCK_FIXTURE: 'true', SECRET_SHOULD_NEVER_LEAVE_SERVER: 'hunter2', NEW_FLAG: '1' } } });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.deepEqual(preview.json.diff.changed, ['env']);
  assert.equal(preview.json.action, 'container.edit');
  assert.ok(!preview.text.includes('hunter2'), 'secret env values are masked in the preview');
  assert.deepEqual(preview.json.diff.entries[0].keys, { added: ['NEW_FLAG'], removed: [], changed: [] });

  const r = await run('container.edit', t, { spec: { env: { MOCK_FIXTURE: 'true', SECRET_SHOULD_NEVER_LEAVE_SERVER: 'hunter2', NEW_FLAG: '1' } } });
  assert.equal(r.dryRun.json.confirmation.mode, 'strong');
  assert.equal(r.dryRun.json.dryRun.plan.diff.recreate, true);
  assert.equal(r.operation.status, 'succeeded', JSON.stringify(r.operation.error));
  assert.notEqual(fx('vaultwarden').Id, oldId, 'the container was replaced');
  assert.equal(FLEET.some((f) => f.Id === oldId), false, 'the old container is gone');
  assert.ok(fx('vaultwarden').Config.Env.includes('NEW_FLAG=1'));
  assert.ok(!JSON.stringify(r.operation).includes('hunter2'), 'the operation record carries no secret values');
  const wire = posts().map((l) => l.replace(/\/containers\/[^/]+\//, '/containers/<id>/').replace(/\/containers\/[0-9a-f]{12,}/, '/containers/<id>'));
  assert.deepEqual(wire, ['POST /containers/<id>/stop', 'POST /containers/<id>/rename', 'POST /containers/create', 'POST /networks/proxy/connect', 'POST /containers/<id>/start', 'DELETE /containers/<id>']);
});

test('a recreate whose replacement dies rolls back to the original', async () => {
  const t = { type: 'service', id: 'qbittorrent' };
  const oldId = fx('qbittorrent').Id;
  // the mock exits a created container immediately when its name contains exit-immediately,
  // so a rename to that name followed by a recreate exercises the rollback path
  await run('container.rename', t, { name: 'qbit-exit-immediately' });
  const r = await run('container.recreate', { type: 'container', id: oldId.slice(0, 12) });
  assert.equal(r.operation.status, 'failed');
  assert.equal(r.operation.error.code, 'verification_failed');
  assert.match(r.operation.error.reason, /previous container was restored/);
  const survivor = FLEET.find((f) => f.Id === oldId);
  assert.ok(survivor, 'the original container still exists');
  assert.equal(survivor.Names[0], '/qbit-exit-immediately', 'and has its name back');
  assert.equal(survivor.State, 'running', 'and is running again');
  assert.equal(FLEET.filter((f) => f.Names[0] === '/qbit-exit-immediately').length, 1, 'no orphaned replacement');
  await run('container.rename', { type: 'container', id: oldId.slice(0, 12) }, { name: 'qbittorrent' });
});

/* ------------------------------ 6. change image / pull / duplicate / create ------------------------------ */

test('change image pulls first and recreates; a failed pull changes nothing', async () => {
  const t = { type: 'service', id: 'nextcloud' };
  const oldId = fx('nextcloud').Id;
  const bad = await run('container.change_image', t, { image: 'nextcloud:nonexistent' });
  assert.equal(bad.operation.status, 'failed');
  assert.match(bad.operation.error.reason, /nothing was changed/);
  assert.equal(fx('nextcloud').Id, oldId);
  assert.deepEqual(posts(), ['POST /images/create'], 'only the pull was attempted');
  ENGINE.reset();
  const ok = await run('container.change_image', t, { image: 'nextcloud:30-apache' });
  assert.equal(ok.operation.status, 'succeeded', JSON.stringify(ok.operation.error));
  assert.equal(fx('nextcloud').Image, 'nextcloud:30-apache');
  assert.equal(ok.operation.result.previousImage, 'nextcloud:29-apache');
  assert.equal(posts()[0], 'POST /images/create');
});

test('pull image reports whether the image changed and never touches the container', async () => {
  const t = { type: 'service', id: 'mariadb' };
  const id = fx('mariadb').Id;
  const r = await run('container.pull_image', t);
  assert.equal(r.operation.status, 'succeeded', JSON.stringify(r.operation.error));
  assert.equal(r.operation.result.image, 'mariadb:11');
  assert.equal(fx('mariadb').Id, id);
  assert.deepEqual(posts(), ['POST /images/create']);
  assert.ok(PULLED.get('mariadb:11') >= 1);
  const img = await run('image.pull', { type: 'image', id: 'docker.io/library/alpine:3.20' }, {});
  assert.equal(img.operation.status, 'succeeded', JSON.stringify(img.operation.error));
});

test('image.pull carries the stored registry credential only for a matching host, and never into events', async () => {
  process.env.OPUSHUB_SECRET_KEY = 'c'.repeat(64);
  const store = await import('./registries/store.js');
  const crypto = await import('./registries/crypto.js');
  crypto._resetCryptoCache();
  store.upsertRegistry({ id: 'corp', name: 'Corp', kind: 'oci', endpoint: 'https://reg.example.com', host: 'reg.example.com', username: 'bob', secret: 'pw-SECRET', actor: 'root' });
  PULL_AUTH.length = 0;
  const anon = await run('image.pull', { type: 'image', id: 'docker.io/library/alpine:3.20' }, {});
  assert.equal(anon.operation.status, 'succeeded');
  assert.equal(PULL_AUTH.length, 0, 'no credential for an unmatched host');
  const authed = await run('image.pull', { type: 'image', id: 'reg.example.com/team/app:1' }, { registryId: 'corp' });
  assert.equal(authed.operation.status, 'succeeded', JSON.stringify(authed.operation.error));
  assert.equal(PULL_AUTH.length, 1);
  assert.equal(JSON.parse(Buffer.from(PULL_AUTH[0].header, 'base64').toString()).password, 'pw-SECRET');
  const mismatch = await run('image.pull', { type: 'image', id: 'docker.io/library/alpine:3.20' }, { registryId: 'corp' });
  assert.equal(mismatch.operation.status, 'succeeded');
  assert.equal(PULL_AUTH.length, 1, 'an explicit registry whose host does not match the image is ignored');
  const blob = JSON.stringify([anon.operation, authed.operation, mismatch.operation, anon.dryRun.json, authed.dryRun.json]);
  assert.ok(!blob.includes('pw-SECRET') && !blob.includes(PULL_AUTH[0].header));
  const { getRecentEvents } = await import('./events/index.js');
  assert.ok(!JSON.stringify(getRecentEvents({ limit: 500 })).includes('pw-SECRET'));
  store._resetRegistriesStore();
});

test('duplicate creates a copy without host ports or named volumes; create refuses a name clash', async () => {
  const r = await run('container.duplicate', { type: 'service', id: 'jellyfin' }, { name: 'jellyfin-copy' });
  assert.equal(r.operation.status, 'succeeded', JSON.stringify(r.operation.error));
  const copy = fx('jellyfin-copy');
  assert.ok(copy);
  assert.deepEqual(Object.values(copy.Config.HostConfig.PortBindings).flat().map((b) => b.HostPort), Object.values(copy.Config.HostConfig.PortBindings).flat().map(() => ''), 'host ports were not copied');
  assert.ok(!copy.Config.HostConfig.Binds.some((b) => b.startsWith('jellyfin-config:')), 'named volumes were not copied');
  assert.ok(r.dryRun.json.dryRun.plan.notes.some((n) => /host ports were not copied/i.test(n)));
  const clash = await run('container.create', { type: 'new' }, { spec: { image: 'alpine:3.20', name: 'jellyfin-copy' } });
  assert.equal(clash.operation.status, 'failed');
  assert.match(clash.operation.error.reason, /already exists/);
  const fresh = await run('container.create', { type: 'new' }, { spec: { image: 'alpine:3.20', name: 'brand-new', ports: ['18080:80'], env: { A: '1' } } });
  assert.equal(fresh.operation.status, 'succeeded', JSON.stringify(fresh.operation.error));
  assert.equal(fx('brand-new').State, 'running');
  await run('container.remove', { type: 'container', id: 'brand-new' }, { force: true });
  await run('container.remove', { type: 'container', id: 'jellyfin-copy' }, { force: true });
});

/* ------------------------------ 7. configuration policy ------------------------------ */

test('the configuration policy blocks privileged, host namespaces, the docker socket and dangerous capabilities', () => {
  const base = { image: 'x:1', name: 'x' };
  const lvl = (patch) => policy.classifySpec(spec.normalizeSpec({ ...base, ...patch }).spec).level;
  assert.equal(lvl({}), 'SAFE');
  assert.equal(lvl({ privileged: true }), 'BLOCKED');
  assert.equal(lvl({ volumes: ['/var/run/docker.sock:/var/run/docker.sock'] }), 'BLOCKED');
  assert.equal(lvl({ volumes: ['/:/host'] }), 'BLOCKED');
  assert.equal(lvl({ volumes: ['/etc:/host-etc:ro'] }), 'DANGEROUS');
  assert.equal(lvl({ capabilities: { add: ['SYS_ADMIN'], drop: [] } }), 'BLOCKED');
  assert.equal(lvl({ capabilities: { add: ['NET_ADMIN'], drop: [] } }), 'DANGEROUS');
  assert.equal(lvl({ networkMode: 'host' }), 'DANGEROUS');
  assert.equal(lvl({ ports: ['0.0.0.0:22:22'] }), 'DANGEROUS');
  assert.equal(lvl({ ports: ['0.0.0.0:80:80'] }), 'WARNING');
  assert.equal(lvl({ devices: ['/dev/dri:/dev/dri'] }), 'WARNING');
  assert.equal(lvl({ securityOpt: ['seccomp=unconfined'] }), 'DANGEROUS');
  assert.equal(lvl({ securityOpt: ['apparmor=unconfined', 'label=disable'] }), 'DANGEROUS');
  // a pre-existing BLOCKED property is preserved (demoted to DANGEROUS), a new one is refused
  const current = spec.normalizeSpec({ ...base, privileged: true }).spec;
  assert.equal(policy.classifySpec(current, { current }).level, 'DANGEROUS');
  assert.equal(policy.classifySpec(spec.normalizeSpec({ ...base, privileged: true, volumes: ['/:/host'] }).spec, { current }).level, 'BLOCKED');
});

test('a blocked edit is refused before confirmation; a dangerous one forces a strong confirmation', async () => {
  const t = { type: 'service', id: 'redis' };
  const blocked = await dryRun('container.edit', t, { spec: { privileged: true } });
  assert.equal(blocked.status, 422, JSON.stringify(blocked.json));
  assert.equal(blocked.json.operation.error.code, 'policy_blocked');
  const sock = await dryRun('container.edit', t, { spec: { volumes: ['/var/run/docker.sock:/var/run/docker.sock'] } });
  assert.equal(sock.json.operation.error.code, 'policy_blocked');
  assert.deepEqual(posts(), []);
  const dangerous = await dryRun('container.edit', t, { spec: { capabilities: { add: ['NET_ADMIN'], drop: [] } } });
  assert.equal(dangerous.status, 200, JSON.stringify(dangerous.json));
  assert.equal(dangerous.json.confirmation.mode, 'strong');
  assert.equal(dangerous.json.dryRun.plan.policy.level, 'DANGEROUS');
  assert.match(dangerous.json.confirmation.prompt.body, /dangerous/i);
  await post(`/api/v1/operations/${dangerous.json.operation.id}/cancel`, {});
});

/* ------------------------------ 8. locks ------------------------------ */

test('a container operation holds its stack lock, so a second operation on the same stack member is refused while it runs', async () => {
  process.env.OPUSHUB_MOCK_OP_DELAY = '600';
  try {
    const t = { type: 'service', id: 'observability-grafana-1' };
    const d = await dryRun('container.restart', t);
    assert.equal(d.status, 200, JSON.stringify(d.json));
    const e = await execute('container.restart', t, undefined, d.json.confirmation.token, d.json.operation.id);
    assert.equal(e.status, 202);
    const same = await dryRun('container.restart', t);
    assert.equal(same.json.operation.error.code, 'already_running');
    const sibling = await dryRun('container.restart', { type: 'service', id: 'observability-loki-1' });
    assert.equal(sibling.status, 200, 'a sibling container may still be operated on (only the stack-wide lock is shared)');
    await post(`/api/v1/operations/${sibling.json.operation.id}/cancel`, {});
    await settle(e.json.operation.id);
  } finally {
    delete process.env.OPUSHUB_MOCK_OP_DELAY;
  }
});

/* ------------------------------ 9. read surface ------------------------------ */

test('the containers read surface returns the canonical spec with secrets masked, and requires a session', async () => {
  const anon = await get('/api/v1/containers/vaultwarden/spec', null);
  assert.equal(anon.status, 401);
  const r = await get('/api/v1/containers/vaultwarden/spec');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.spec.image, 'vaultwarden/server:1.32.0');
  assert.ok(!r.text.includes('hunter2'), 'env secrets are masked');
  assert.ok(r.json.secretKeys.includes('SECRET_SHOULD_NEVER_LEAVE_SERVER'));
  assert.deepEqual(r.json.fields.map((f) => f.field), [...spec.SPEC_FIELDS]);
  const fields = await get('/api/v1/containers/spec-fields');
  assert.deepEqual(fields.json.inPlace, ['restartPolicy', 'resources']);
  const vols = await get('/api/v1/containers/jellyfin/volumes');
  assert.equal(vols.status, 200);
  assert.ok(vols.json.volumes.some((v) => v.type === 'volume' && v.source === 'jellyfin-config'));
  assert.ok(!vols.text.includes('/var/lib/docker'), 'no mountpoints leak');
  const top = await get('/api/v1/containers/jellyfin/top');
  assert.equal(top.status, 200);
  const viewer = await get('/api/v1/containers/vaultwarden/spec', VIEWER_COOKIE);
  assert.equal(viewer.status, 200, 'reads are not permission-gated beyond the session (the UI hides what cannot be run)');
  const missing = await get('/api/v1/containers/does-not-exist/spec');
  assert.equal(missing.status, 404);
  assert.deepEqual(posts(), [], 'the read surface never writes');
});

/* ------------------------------ 10. static proofs ------------------------------ */

test('the containers read API imports no write adapter and the spec builder spreads no client object', () => {
  const api = code('server/containersApi.js');
  assert.ok(!/dockerOperations|containers\/runners|containers\/recreate|requestOperation|executeOperation/.test(api), 'containersApi.js has no write path');
  assert.ok(/inspectContainer as inspectRaw/.test(api), 'the only control-adapter import is the inspect read');
  const s = code('server/containers/spec.js');
  const builder = s.split('export function createBodyFromSpec')[1].split('export function updateBodyFromSpec')[0];
  assert.ok(!/\.\.\.(raw|input|body|patch|hostConfig|HostConfig|inspect)\b|\.\.\.spec\s*[,}]|\.\.\.spec\.(env|volumes|ports|networks|resources|healthcheck)\s*[,}]/.test(builder), 'the create body is built field by field');
  assert.ok(!/HostConfig:\s*\{\s*\.\.\./.test(builder), 'HostConfig is never a spread of an input object');
  // the diff module never renders a raw env value for a secret-looking key
  const masked = diff.publicSpec({ env: { API_TOKEN: 'abc', PASSWORD: 'p', PLAIN: 'v' } }).env;
  assert.notEqual(masked.API_TOKEN, 'abc');
  assert.notEqual(masked.PASSWORD, 'p');
  assert.equal(masked.PLAIN, 'v');
});

test('the recreate ladder is the only place the old container is removed, and it never sends v=1', () => {
  const rec = code('server/containers/recreate.js');
  assert.ok(/deleteContainer\(containerId, \{ force: true \}\)/.test(rec));
  const adapter = code('server/updates/recreateAdapter.js');
  assert.ok(/v: '0'/.test(adapter) && !/v: '1'/.test(adapter));
  // Update Now uses the same ladder (no second copy of the transaction)
  const upd = code('server/updates/engine.js');
  assert.ok(/recreateContainer\(/.test(upd), 'updates/engine.js delegates to containers/recreate.js');
  assert.ok(!/recreateAdapter\.(renameContainer|createContainer|startContainer|deleteContainer|connectNetwork)\(/.test(upd), 'updates/engine.js no longer runs its own ladder');
});
