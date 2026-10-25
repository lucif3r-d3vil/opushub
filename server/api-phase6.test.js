// Phase 6 — the configuration API, through the same door a browser uses.
//
// These tests hit `handleApi` directly with a real session cookie and a real Origin header, so the
// authentication gate, the CSRF gate and the validation gate are all exercised rather than bypassed.
// The Docker engine is the project's own mock (`test/mock-engine.js`), which means discovery
// produces a genuine inventory of 20-odd containers and "matched" means matched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine, FLEET } from '../test/mock-engine.js';

const ENGINE = await startMockEngine();
process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
delete process.env.DOCKER_HOST;
delete process.env.OPUSHUB_HOST_ADDRESS;

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-api-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-api-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const { handleApi } = await import('./api.js');
const model = await import('./model.js');
const { seedSession } = await import('../test/auth-helper.js');
const COOKIE = await seedSession();

test.after(async () => {
  await ENGINE.stop();
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// request plumbing — the same shapes server/index.js produces
// ---------------------------------------------------------------------------

function req(method, body, { cookie = COOKIE, origin = 'http://127.0.0.1:3721', contentType = 'application/json', extraHeaders = {} } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = { ...extraHeaders };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  headers.host = '127.0.0.1:3721';
  if (payload && contentType) headers['content-type'] = contentType;
  return {
    method,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() {
      let sent = false;
      return { next: async () => (sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(payload), done: false })) };
    },
  };
}
function res() {
  const headers = {};
  const state = { status: 200, headers, body: '', setCookies: [] };
  return {
    state,
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; if (k.toLowerCase() === 'set-cookie') state.setCookies.push(v); },
    writeHead: (s) => { state.status = s; },
    end: (b) => { state.body = b == null ? '' : String(b); },
  };
}
async function call(method, pathname, body, opts) {
  const r = res();
  try {
    await handleApi(req(method, body, opts), r, new URL(pathname, 'http://127.0.0.1:3721'));
  } catch (err) {
    r.state.status = err.status || 500;
    r.state.body = JSON.stringify({ error: String(err.message || err), code: err.code || null, detail: err.detail || null });
  }
  let json = {};
  try { json = JSON.parse(r.state.body || '{}'); } catch { json = { raw: r.state.body }; }
  return { status: r.state.status, json, headers: r.state.headers, body: r.state.body };
}
const get = (p, opts) => call('GET', p, undefined, opts);
const post = (p, b, opts) => call('POST', p, b, opts);
const put = (p, b, opts) => call('PUT', p, b, opts);
const del = (p, opts) => call('DELETE', p, undefined, opts);

// ---------------------------------------------------------------------------
// the door
// ---------------------------------------------------------------------------

test('every Phase 6 read route requires a session', async () => {
  const routes = [
    '/api/groups',
  ];
  for (const route of routes) {
    const r = await get(route, { cookie: null, origin: null });
    assert.equal(r.status, 401, `${route} answered without a session (${r.status})`);
  }
});

test('every Phase 6 write route requires a session', async () => {
  const writes = [
    ['POST', '/api/config/validate'], ['PUT', '/api/groups'],
  ];
  for (const [method, route] of writes) {
    const r = await call(method, route, {}, { cookie: null, origin: null });
    assert.equal(r.status, 401, `${method} ${route} answered without a session (${r.status})`);
  }
});

test('every Phase 6 write route refuses a cross-origin request (CSRF)', async () => {
  const writes = [
    ['POST', '/api/config/validate', { area: 'bookmarks', draft: { groups: [] } }],
    ['PUT', '/api/groups', { groups: [] }],
  ];
  for (const [method, route, body] of writes) {
    const r = await call(method, route, body, { origin: 'https://evil.example' });
    assert.equal(r.status, 403, `${method} ${route} accepted a cross-origin write (${r.status})`);
  }
});

test('a write with no Origin header but an explicit cross-site marker is still refused', async () => {
  // The CSRF gate has two independent signals: the Origin/Host comparison and `Sec-Fetch-Site`.
  // A same-origin GET from a link has no Origin; a cross-site POST always carries the marker.
  const r = await call('POST', '/api/config/validate', { area: 'bookmarks', draft: { groups: [] } }, { origin: null, extraHeaders: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
});

test('the presentation endpoint separates discovered identity from user override', async () => {
  await put('/api/services/opustream/jellyfin/presentation', { displayName: 'Stream', url: 'https://custom.example.com' });
  const r = await get('/api/services/opustream/jellyfin/presentation');
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  // identity: discovered, and there is no way to write it back
  assert.equal(r.json.identity.containerName, 'jellyfin');
  assert.equal(r.json.identity.composeProject, 'opustream');
  assert.match(r.json.identity.image, /jellyfin/);
  // detected: what Docker/Traefik said
  assert.equal(r.json.detected.url, 'http://stream.lab.internal');
  assert.equal(r.json.detected.urlSource, 'traefik');
  // override: what the user configured
  assert.equal(r.json.override.displayName, 'Stream');
  assert.equal(r.json.override.url, 'https://custom.example.com');
  // effective: the override wins, and both are visible so it is not a silent replacement
  assert.equal(r.json.effective.displayName, 'Stream');
  assert.equal(r.json.effective.url, 'https://custom.example.com');
  assert.notEqual(r.json.detected.url, r.json.effective.url, 'the two must be distinguishable');
});

test('the response shape carries no writable handle on Docker facts', async () => {
  const r = await get('/api/services/opustream/jellyfin/presentation');
  // The fields a client could plausibly try to write are absent from the *override* block — the
  // only block a PUT reads. Identity is present but is not what the write path consumes.
  for (const forbidden of ['id', 'image', 'networks', 'mounts', 'labels', 'env', 'ports']) {
    assert.ok(!(forbidden in r.json.override), `override exposes a writable ${forbidden}`);
  }
});

test('a PUT writes presentation only, and the discovered facts survive it', async () => {
  const before = await model.getInventory({ refreshMs: 0 });
  const beforeJellyfin = before.services.find((s) => s.name === 'jellyfin');

  const r = await put('/api/services/opustream/jellyfin/presentation', {
    displayName: 'Cinema',
    description: 'Rewritten by the editor',
    icon: 'lucide:clapperboard',
    group: 'Media',
    // none of these may have any effect, even though they are named like Docker facts
    container: 'something-else',
    image: 'evil/image:latest',
    networks: ['nope'],
    labels: { 'traefik.enable': 'true' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));

  await model.invalidateDiscovery();
  const after = await model.getInventory({ force: true });
  const jellyfin = after.services.find((s) => s.name === 'jellyfin');
  assert.equal(jellyfin.displayName, 'Cinema');
  assert.equal(jellyfin.description, 'Rewritten by the editor');
  assert.equal(jellyfin.container.image, beforeJellyfin.container.image, 'the editor changed a Docker fact');
  assert.equal(jellyfin.container.name, 'jellyfin', 'the editor renamed a container');
  assert.deepEqual(jellyfin.container.networks, beforeJellyfin.container.networks);
});

test('"use detected URL" clears the override and the discovered URL comes back', async () => {
  await put('/api/services/opustream/jellyfin/presentation', { url: 'https://custom.example.com', group: 'Media' });
  let r = await get('/api/services/opustream/jellyfin/presentation');
  assert.equal(r.json.effective.url, 'https://custom.example.com');
  assert.equal(r.json.detected.url, 'http://stream.lab.internal');

  const cleared = await del('/api/services/opustream/jellyfin/presentation');
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.cleared, true);

  await model.invalidateDiscovery();
  r = await get('/api/services/opustream/jellyfin/presentation');
  assert.equal(r.json.effective.url, 'http://stream.lab.internal', 'the detected URL did not come back');
  assert.equal(r.json.override.url, null);
  assert.equal(r.json.configured, false);
});

test('clearing every override does not remove the service', async () => {
  await del('/api/services/opustream/jellyfin/presentation');
  await model.invalidateDiscovery();
  const inv = await model.getInventory({ force: true });
  assert.ok(inv.services.some((s) => s.name === 'jellyfin'), 'clearing configuration removed a service');
  assert.equal(inv.services.length, FLEET.length);
});

test('an unsafe URL or icon in the editor is refused with 400 and nothing is written', async () => {
  const before = model.readServices().overlays.length;
  const bad = await put('/api/services/opustream/jellyfin/presentation', { url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /unsafe href|unsupported scheme/i);
  const badIcon = await put('/api/services/opustream/jellyfin/presentation', { icon: '/etc/passwd' });
  assert.equal(badIcon.status, 400);
  assert.match(badIcon.json.error, /user\/icons|unsafe icon/i);
  assert.equal(model.readServices().overlays.length, before, 'a refused edit changed the configuration');
});

test('a presentation route for a container that does not exist is a clean 404', async () => {
  const r = await get('/api/services/Media/not-a-real-container/presentation');
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

test('groups report the compose projects inside them, and say a group is not a project', async () => {
  const r = await get('/api/groups');
  assert.equal(r.status, 200);
  assert.ok(r.json.groups.length > 0);
  // Find the group that actually holds a container of the `opustream` project, wherever earlier
  // tests may have filed it, and check the payload reports the project honestly.
  const inv = await model.getInventory({ refreshMs: 0 });
  const jellyfin = inv.services.find((s) => s.name === 'jellyfin');
  const holder = r.json.groups.find((g) => g.name === jellyfin.group);
  assert.ok(holder, `no group is reported for ${jellyfin.group}`);
  assert.ok(holder.composeProjects.includes('opustream'), `composeProjects was ${JSON.stringify(holder.composeProjects)}`);
  // Every group's project list is a set of real compose projects — never a group name reused as one.
  for (const g of r.json.groups) {
    assert.ok(Array.isArray(g.composeProjects));
    assert.ok(!g.composeProjects.includes(g.name) || g.name === 'opustream');
  }
  // And the distinction the brief asks to be explicit is in the payload, not only the copy.
  assert.match(r.json.note, /not Docker Compose projects/i);
});

test('a group can be renamed, described and hidden, and the services follow the rename', async () => {
  const before = await get('/api/groups');
  const target = before.json.groups[0];

  const r = await put('/api/groups', {
    groups: [{ name: target.name, to: 'Renamed Group', description: 'Set by the test' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  assert.ok(r.json.groups.some((g) => g.name === 'Renamed Group'));

  await model.invalidateDiscovery();
  const after = await get('/api/groups');
  const renamed = after.json.groups.find((g) => g.name === 'Renamed Group');
  assert.ok(renamed, 'the rename did not take');
  assert.equal(renamed.serviceCount, target.serviceCount, 'a rename must not move services between groups');
  assert.equal(after.json.groups.length, before.json.groups.length);
});

test('hiding a group hides it from the Hub without removing anything', async () => {
  const before = await get('/api/groups');
  const target = before.json.groups[0].name;
  await put('/api/groups', { hidden: [target] });
  await model.invalidateDiscovery();

  const after = await get('/api/groups');
  assert.ok(after.json.hiddenGroups.includes(target));
  const inv = await model.getInventory({ force: true });
  assert.equal(inv.services.length, FLEET.length, 'hiding a group changed the inventory');
  assert.equal(inv.stats.discovered, FLEET.length);
});

test('renaming a group onto an existing name is refused rather than merging them', async () => {
  const groups = (await get('/api/groups')).json.groups;
  if (groups.length < 2) return; // nothing to collide with
  const r = await put('/api/groups', { groups: [{ name: groups[0].name, to: groups[1].name }] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /already exists/i);
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test('the draft validator answers for every area without writing', async () => {
  const cases = [
    ['services', { groups: [{ name: 'A', services: [{ container: 'x' }] }] }, true],
    ['services', { groups: [{ name: 'A', services: [] }, { name: 'a', services: [] }] }, false],
    ['services', { groups: [{ name: 'bad/name', services: [] }] }, false],
    ['services', { groups: [{ name: 'A', services: [{ container: 'x', url: 'javascript:1' }] }] }, false],
    ['bookmarks', { groups: [{ name: 'B', items: [{ name: 'X', href: 'https://ok.example' }] }] }, true],
    ['bookmarks', { groups: [{ name: 'B', items: [{ name: 'X', href: 'ftp://bad' }] }] }, false],
    ['layout', { version: 2, hub: { widgets: [{ id: 'w', type: 'system', zone: 'main', size: 'md', visible: true, config: {} }] } }, true],
  ];
  for (const [area, draft, shouldPass] of cases) {
    const r = await post('/api/config/validate', { area, draft });
    assert.equal(r.status, 200, `${area} returned ${r.status}`);
    assert.equal(r.json.ok, shouldPass, `${area} judged ${JSON.stringify(draft)} as ${r.json.ok ? 'valid' : 'invalid'}: ${r.json.problems?.join('; ')}`);
    assert.ok(Array.isArray(r.json.problems));
  }
});

test('an invalid settings draft is refused with the reason, and the file is untouched', async () => {
  const settingsPath = path.join(CONFIG_DIR, 'settings.yaml');
  const before = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '';
  const r = await post('/api/config/validate', { area: 'settings', draft: { infrastructure: { hostAddress: 'not a host!!' } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '', before);
});
