// Phase 10D-C — registries. Credentials never leave the server; every remote call is a fixed
// shape against a validated endpoint. The network is a fake transport injected into the client.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-10dc-'));
process.env.OPUSHUB_DATA_DIR = dataDir;
process.env.OPUSHUB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-10dc-cfg-'));
process.env.OPUSHUB_SECRET_KEY = 'b'.repeat(64);
process.env.OPUSHUB_DISABLE_MONITORING = '1';

const crypto = await import('./registries/crypto.js');
const endpoint = await import('./registries/endpoint.js');
const store = await import('./registries/store.js');
const client = await import('./registries/client.js');
const auth = await import('./registries/auth.js');
const net = await import('./monitoring/net.js');
const { handleRegistriesRoutes } = await import('./registriesApi.js');
const { seedSession, TEST_USER } = await import('../test/auth-helper.js');
await seedSession();

// Deterministic DNS: names ending in .internal → 10.0.0.x, public names → 93.184.216.34.
net.__setLookup(async (host) => {
  if (host === 'meta.evil') return [{ address: '169.254.169.254', family: 4 }];
  if (host === 'loop.evil') return [{ address: '127.0.0.1', family: 4 }];
  if (host.endsWith('.internal')) return [{ address: '10.0.0.5', family: 4 }];
  return [{ address: '93.184.216.34', family: 4 }];
});

const REQUESTS = [];
let route = null;
client.__setTransport(async (req) => {
  REQUESTS.push({ url: req.url, headers: { ...req.headers }, pinned: req.pinned });
  const r = await route(req);
  return { ok: true, status: 200, headers: {}, body: '{}', truncated: false, ...r };
});
const json = (status, obj, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj) });

const admin = { username: TEST_USER.username };
const viewer = { username: 'eve' };
async function api(actor, method, p, body, q = '') {
  let out;
  const handled = await handleRegistriesRoutes({
    p, method, actor: actor.username,
    send: (status, obj) => { out = { status, obj }; },
    jsonBody: async () => body,
    query: new URLSearchParams(q),
  });
  return { handled, ...out };
}

beforeEach(() => { REQUESTS.length = 0; route = () => json(200, {}); store._resetRegistriesStore(); });
after(() => { net.__setLookup(null); client.__setTransport(null); fs.rmSync(dataDir, { recursive: true, force: true }); });

// ---------- crypto ----------
test('crypto: roundtrip, AAD binding, tamper rejection', () => {
  const ct = crypto.encrypt('hunter2', 'reg-a');
  assert.match(ct, /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.equal(crypto.decrypt(ct, 'reg-a'), 'hunter2');
  assert.throws(() => crypto.decrypt(ct, 'reg-b'), /decrypt|auth/i);
  const parts = ct.split(':'); parts[3] = parts[3].slice(0, -2) + 'AA';
  assert.throws(() => crypto.decrypt(parts.join(':'), 'reg-a'));
  assert.notEqual(crypto.encrypt('hunter2', 'reg-a'), ct, 'fresh iv each time');
});

test('crypto: falls back to a 0600 key file when no env key is set', () => {
  const saved = process.env.OPUSHUB_SECRET_KEY;
  delete process.env.OPUSHUB_SECRET_KEY;
  crypto._resetCryptoCache();
  try {
    const ct = crypto.encrypt('x', 'id');
    const keyPath = path.join(dataDir, 'registries', 'key');
    assert.ok(fs.existsSync(keyPath));
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
    assert.equal(crypto.decrypt(ct, 'id'), 'x');
  } finally { process.env.OPUSHUB_SECRET_KEY = saved; crypto._resetCryptoCache(); }
});

// ---------- endpoint / SSRF ----------
test('endpoint: origin only — path, query, credentials, http-without-insecure refused', () => {
  assert.equal(endpoint.parseEndpoint('https://ghcr.io').ok, true);
  assert.equal(endpoint.parseEndpoint('ghcr.io').origin, 'https://ghcr.io');
  for (const bad of ['https://ghcr.io/v2/', 'https://ghcr.io/?x=1', 'https://u:p@ghcr.io', 'http://reg.internal', 'ftp://x', 'https://', 'https://a b']) {
    assert.equal(endpoint.parseEndpoint(bad).ok, false, bad);
  }
  assert.equal(endpoint.parseEndpoint('http://reg.internal:5000', { insecure: true }).ok, true);
});

test('endpoint: resolves and refuses loopback, link-local/metadata; plain http only for internal scope', async () => {
  assert.equal((await endpoint.validateEndpoint('https://loop.evil')).ok, false);
  assert.equal((await endpoint.validateEndpoint('https://meta.evil')).ok, false);
  assert.equal((await endpoint.validateEndpoint('https://[::1]')).ok, false);
  assert.equal((await endpoint.validateEndpoint('http://127.0.0.1:5000', { insecure: true })).ok, false);
  assert.equal((await endpoint.validateEndpoint('http://registry.example.com', { insecure: true })).ok, false, 'insecure http to a public address');
  const ok = await endpoint.validateEndpoint('http://reg.internal:5000', { insecure: true });
  assert.equal(ok.ok, true); assert.equal(ok.pinned, '10.0.0.5');
  assert.equal((await endpoint.validateEndpoint('https://ghcr.io')).ok, true);
});

test('endpoint: image reference helpers', () => {
  assert.equal(endpoint.registryHostOf('nginx:1.25'), 'registry-1.docker.io');
  assert.equal(endpoint.repositoryOf('nginx:1.25'), 'library/nginx');
  assert.equal(endpoint.registryHostOf('ghcr.io/acme/app:1'), 'ghcr.io');
  assert.equal(endpoint.repositoryOf('reg.internal:5000/team/app@sha256:' + 'a'.repeat(64)), 'team/app');
  assert.equal(endpoint.REPOSITORY_RE.test('../etc'), false);
  assert.equal(endpoint.TAG_RE.test('v1?x=1'), false);
});

// ---------- store ----------
test('store: secret is encrypted on disk and never in any public projection', () => {
  const r = store.upsertRegistry({ id: 'ghcr', name: 'GHCR', kind: 'ghcr', endpoint: 'https://ghcr.io', host: 'ghcr.io', username: 'bob', secret: 'ghp_SECRET_TOKEN', actor: 'root' });
  assert.equal(r.ok, true);
  const raw = fs.readFileSync(path.join(dataDir, 'registries', 'registries.json'), 'utf8');
  assert.ok(!raw.includes('ghp_SECRET_TOKEN'));
  assert.equal(fs.statSync(path.join(dataDir, 'registries', 'registries.json')).mode & 0o777, 0o600);
  const pub = JSON.stringify([store.getRegistry('ghcr'), ...store.listRegistries()]);
  assert.ok(!pub.includes('SECRET_TOKEN'));
  assert.ok(!/"secret"/.test(pub));
  assert.equal(store.getRegistry('ghcr').hasSecret, true);
  assert.equal(store.credentialsFor('ghcr').credentials.secret, 'ghp_SECRET_TOKEN');
  // undefined keeps, '' clears
  store.upsertRegistry({ id: 'ghcr', name: 'GHCR2', kind: 'ghcr', endpoint: 'https://ghcr.io', host: 'ghcr.io', actor: 'root' });
  assert.equal(store.credentialsFor('ghcr').credentials.secret, 'ghp_SECRET_TOKEN');
  store.upsertRegistry({ id: 'ghcr', name: 'GHCR2', kind: 'ghcr', endpoint: 'https://ghcr.io', host: 'ghcr.io', secret: '', actor: 'root' });
  assert.equal(store.getRegistry('ghcr').hasSecret, false);
});

// ---------- client ----------
function seedPrivate() {
  store.upsertRegistry({ id: 'corp', name: 'Corp', kind: 'oci', endpoint: 'https://reg.internal', host: 'reg.internal', username: 'bob', secret: 'pw', actor: 'root' });
}

test('client: bearer challenge → https realm → token; the password goes only to the realm', async () => {
  seedPrivate();
  route = (req) => {
    if (req.url.startsWith('https://auth.example.com/token')) {
      assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('bob:pw').toString('base64'));
      return json(200, { token: 'T0K' });
    }
    if (!req.headers.authorization) return json(401, {}, { 'www-authenticate': 'Bearer realm="https://auth.example.com/token",service="reg",scope="repository:team/app:pull"' });
    assert.equal(req.headers.authorization, 'Bearer T0K');
    if (req.url.endsWith('/v2/')) return json(200, {}, { 'docker-distribution-api-version': 'registry/2.0' });
    if (req.url.includes('/tags/list')) return json(200, { name: 'team/app', tags: ['1.0', '1.1'] });
    return json(200, { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: 'sha256:' + 'c'.repeat(64) }, layers: [{ size: 10 }] }, { 'docker-content-digest': 'sha256:' + 'd'.repeat(64) });
  };
  const p = await client.ping('corp');
  assert.equal(p.ok, true); assert.equal(p.authenticated, true);
  const t = await client.tags('corp', 'team/app');
  assert.deepEqual(t.tags, ['1.0', '1.1']);
  const m = await client.manifest('corp', 'team/app', '1.1');
  assert.equal(m.ok, true); assert.equal(m.digest, 'sha256:' + 'd'.repeat(64));
  assert.ok(REQUESTS.every((r) => r.url.startsWith('https://reg.internal/v2/') || r.url.startsWith('https://auth.example.com/token')));
});

test('client: an http realm or a realm on a blocked address is refused', async () => {
  seedPrivate();
  route = () => json(401, {}, { 'www-authenticate': 'Bearer realm="http://auth.example.com/token",service="reg"' });
  const r = await client.ping('corp');
  assert.equal(r.ok, false);
  assert.ok(!REQUESTS.some((q) => q.url.startsWith('http://auth')));
  route = () => json(401, {}, { 'www-authenticate': 'Bearer realm="https://meta.evil/token",service="reg"' });
  const r2 = await client.ping('corp');
  assert.equal(r2.ok, false);
  assert.ok(!REQUESTS.some((q) => q.url.includes('meta.evil')));
});

test('client: credentials are not forwarded across an origin change on redirect', async () => {
  seedPrivate();
  route = (req) => {
    if (req.url.startsWith('https://reg.internal/')) return { status: 302, headers: { location: 'https://cdn.example.com/blob' }, body: '' };
    return json(200, { schemaVersion: 2, config: { digest: 'sha256:' + 'c'.repeat(64) }, layers: [] });
  };
  await client.manifest('corp', 'team/app', 'latest');
  const cross = REQUESTS.filter((r) => r.url.startsWith('https://cdn.example.com/'));
  assert.ok(cross.length >= 1);
  assert.ok(cross.every((r) => !r.headers.authorization));
});

test('client: catalog refused for Docker Hub and GHCR; repository/tag grammar refused before any request', async () => {
  store.upsertRegistry({ id: 'hub', name: 'Hub', kind: 'dockerhub', endpoint: 'https://registry-1.docker.io', host: 'registry-1.docker.io', actor: 'root' });
  assert.equal((await client.catalog('hub')).code, 'no_catalog');
  seedPrivate();
  assert.equal((await client.tags('corp', '../../etc')).ok, false);
  assert.equal((await client.manifest('corp', 'team/app', 'latest?x=1')).ok, false);
  assert.equal(REQUESTS.length, 0);
});

test('authHeaderFor: matches by host, explicit id must match image host, anonymous otherwise', async () => {
  seedPrivate();
  const a = await auth.authHeaderFor('reg.internal/team/app:1');
  assert.equal(a.registryId, 'corp');
  const decoded = JSON.parse(Buffer.from(a.header, 'base64').toString());
  assert.equal(decoded.username, 'bob'); assert.equal(decoded.password, 'pw'); assert.equal(decoded.serveraddress, 'reg.internal');
  assert.equal(await auth.authHeaderFor('nginx:1.25'), null);
  assert.equal(await auth.authHeaderFor('nginx:1.25', 'corp'), null, 'explicit registry whose host does not match the image');
  assert.equal(await auth.authHeaderFor('reg.internal/x:1', 'nope'), null);
});

// ---------- API ----------
test('api: viewer can list (masked) but cannot write or test; admin CRUD; secret never echoed', async () => {
  const create = await api(admin, 'POST', '/api/v1/registries', { id: 'corp', name: 'Corp', kind: 'oci', endpoint: 'https://reg.internal', username: 'bob', secret: 'pw' });
  assert.equal(create.status, 201, JSON.stringify(create.obj));
  assert.ok(!JSON.stringify(create.obj).includes('"pw"'));
  const list = await api(viewer, 'GET', '/api/v1/registries');
  assert.equal(list.status, 200); assert.equal(list.obj.registries.length, 1); assert.equal(list.obj.permissions.manage, false);
  assert.ok(!JSON.stringify(list.obj).includes('secret":"'));
  assert.equal((await api(viewer, 'POST', '/api/v1/registries', { id: 'x', kind: 'ghcr' })).status, 403);
  assert.equal((await api(viewer, 'PATCH', '/api/v1/registries/corp', { name: 'n' })).status, 403);
  assert.equal((await api(viewer, 'DELETE', '/api/v1/registries/corp')).status, 403);
  assert.equal((await api(viewer, 'POST', '/api/v1/registries/corp/test')).status, 403);
  const patch = await api(admin, 'PATCH', '/api/v1/registries/corp', { name: 'Corp2' });
  assert.equal(patch.status, 200); assert.equal(store.credentialsFor('corp').credentials.secret, 'pw', 'patch without secret keeps it');
  assert.equal((await api(admin, 'PATCH', '/api/v1/registries/corp', { id: 'other' })).status, 400);
  assert.equal((await api(admin, 'POST', '/api/v1/registries', { id: 'corp', kind: 'oci', endpoint: 'https://reg.internal' })).status, 409);
  assert.equal((await api(admin, 'DELETE', '/api/v1/registries/corp')).status, 200);
  assert.equal((await api(admin, 'GET', '/api/v1/registries/corp')).status, 404);
});

test('api: SSRF-shaped endpoints and unknown fields are refused at create time', async () => {
  for (const endpoint of ['https://loop.evil', 'https://meta.evil', 'https://reg.internal/v2/', 'http://reg.internal', 'https://u:p@reg.internal']) {
    const r = await api(admin, 'POST', '/api/v1/registries', { id: 'bad', name: 'x', kind: 'oci', endpoint });
    assert.equal(r.status, 400, endpoint);
  }
  assert.equal((await api(admin, 'POST', '/api/v1/registries', { id: 'bad', kind: 'oci', endpoint: 'https://reg.internal', url: 'https://x' })).status, 400);
  assert.equal((await api(admin, 'POST', '/api/v1/registries', { id: 'hub', kind: 'dockerhub', endpoint: 'https://evil.example.com' })).status, 400, 'dockerhub kind is pinned to its host');
  assert.equal((await api(admin, 'POST', '/api/v1/registries', { id: 'hub', kind: 'dockerhub' })).status, 201);
  assert.equal(REQUESTS.length, 0, 'creating a registry makes no remote request');
});

test('api: test/tags/manifest use only the fixed shapes; bad grammar rejected before any request', async () => {
  await api(admin, 'POST', '/api/v1/registries', { id: 'corp', name: 'Corp', kind: 'oci', endpoint: 'https://reg.internal', username: 'bob', secret: 'pw' });
  route = (req) => req.url.includes('/tags/list') ? json(200, { tags: ['a'] }) : json(200, {}, { 'docker-distribution-api-version': 'registry/2.0' });
  const t = await api(admin, 'POST', '/api/v1/registries/corp/test');
  assert.equal(t.obj.result.ok, true);
  assert.equal(store.getRegistry('corp').lastTest.ok, true);
  assert.equal((await api(viewer, 'GET', '/api/v1/registries/corp/tags', null, 'repository=team/app')).obj.tags[0], 'a');
  REQUESTS.length = 0;
  assert.equal((await api(viewer, 'GET', '/api/v1/registries/corp/tags', null, 'repository=../x')).status, 400);
  assert.equal((await api(viewer, 'GET', '/api/v1/registries/corp/manifest', null, 'repository=team/app&reference=bad ref')).status, 400);
  assert.equal(REQUESTS.length, 0);
  assert.ok(REQUESTS.every((r) => /^https:\/\/reg\.internal\/v2\/(?:$|team\/app\/(tags\/list|manifests\/))/.test(r.url)));
});

// ---------- source discipline ----------
test('registry modules never spawn, never touch the docker socket, never log secrets', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'registries');
  const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), path.join(dir, '..', 'registriesApi.js')];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const banned of ['child_process', 'spawn(', 'child_process.exec', 'execSync', 'docker.sock', 'console.log(']) assert.ok(!src.includes(banned), `${path.basename(f)} contains ${banned}`);
  }
});
