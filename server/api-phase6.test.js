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

/** A Homepage configuration with one service that exists and one that does not. */
const HOMEPAGE_FILES = {
  'services.yaml': `
- Media:
    - Jellyfin:
        icon: si-jellyfin
        href: https://stream.lab.internal
        description: Movies and TV from the import
    - Kodi Box:
        href: http://192.0.2.44:8080
        description: A television, not a container
- Music:
    - Navidrome:
        href: https://music.lab.internal
`,
  'bookmarks.yaml': `
- Reading:
    - Hacker News:
        - abbr: HN
          href: https://news.ycombinator.com
`,
  'settings.yaml': 'title: Imported Hub\ntheme: dark\ncolor: teal\n',
};

// ---------------------------------------------------------------------------
// the door
// ---------------------------------------------------------------------------

test('every Phase 6 read route requires a session', async () => {
  const routes = [
    '/api/config/scope', '/api/config/overview', '/api/config/history',
    '/api/config/import/files', '/api/config/export', '/api/groups',
  ];
  for (const route of routes) {
    const r = await get(route, { cookie: null, origin: null });
    assert.equal(r.status, 401, `${route} answered without a session (${r.status})`);
  }
});

test('every Phase 6 write route requires a session', async () => {
  const writes = [
    ['POST', '/api/config/import/parse'], ['POST', '/api/config/import/apply'],
    ['POST', '/api/config/validate'], ['PUT', '/api/groups'],
    ['POST', '/api/config/history/2026-01-01T00-00-00-000Z/restore'],
    ['POST', '/api/custom/reset'], ['GET', '/api/config/export/download'],
  ];
  for (const [method, route] of writes) {
    const r = await call(method, route, {}, { cookie: null, origin: null });
    assert.equal(r.status, 401, `${method} ${route} answered without a session (${r.status})`);
  }
});

test('every Phase 6 write route refuses a cross-origin request (CSRF)', async () => {
  const writes = [
    ['POST', '/api/config/import/parse', { files: {} }],
    ['POST', '/api/config/import/apply', { files: {} }],
    ['POST', '/api/config/validate', { area: 'custom-css', draft: '' }],
    ['PUT', '/api/groups', { groups: [] }],
    ['POST', '/api/config/history/x/restore', {}],
    ['POST', '/api/custom/reset', { file: 'theme.css' }],
  ];
  for (const [method, route, body] of writes) {
    const r = await call(method, route, body, { origin: 'https://evil.example' });
    assert.equal(r.status, 403, `${method} ${route} accepted a cross-origin write (${r.status})`);
  }
});

test('a write with no Origin header but an explicit cross-site marker is still refused', async () => {
  // The CSRF gate has two independent signals: the Origin/Host comparison and `Sec-Fetch-Site`.
  // A same-origin GET from a link has no Origin; a cross-site POST always carries the marker.
  const r = await call('POST', '/api/config/import/apply', { files: {} }, { origin: null, extraHeaders: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
});

test('the scope document states the boundary as data', async () => {
  const r = await get('/api/config/scope');
  assert.equal(r.status, 200);
  assert.equal(r.json.presentation.length, 7);
  const protectedPaths = r.json.protected.map((p) => p.path);
  for (const expected of ['data/auth.json', 'data/sessions.json', 'data/activity.jsonl', 'data/metrics.json']) {
    assert.ok(protectedPaths.includes(expected), `${expected} is not listed as protected`);
  }
  assert.match(r.json.rule, /never touches authentication/i);
});

// ---------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------

test('the import file list names what is accepted and what is refused, with reasons', async () => {
  const r = await get('/api/config/import/files');
  assert.equal(r.status, 200);
  const accepted = r.json.accepted.map((f) => f.name);
  assert.ok(accepted.includes('services.yaml'));
  assert.ok(accepted.includes('bookmarks.yaml'));
  const refused = r.json.refused.map((f) => f.name);
  assert.ok(refused.includes('docker.yaml'));
  assert.ok(refused.includes('.env'));
  assert.ok(r.json.refused.every((f) => typeof f.why === 'string' && f.why.length > 10));
});

test('POST /api/config/import/parse returns a review and writes nothing at all', async () => {
  const servicesBefore = fs.existsSync(path.join(CONFIG_DIR, 'services.yaml'))
    ? fs.readFileSync(path.join(CONFIG_DIR, 'services.yaml'), 'utf8') : null;
  const r = await post('/api/config/import/parse', { files: HOMEPAGE_FILES });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  assert.equal(r.json.summary.groups, 2);
  assert.equal(r.json.summary.services, 3);
  assert.ok(r.json.summary.dockerContainers > 10, 'the mock engine should have produced a fleet');
  assert.equal(r.json.summary.matched, 2, 'jellyfin and navidrome are running');
  assert.equal(r.json.summary.unmatched, 1, 'the Kodi Box is not');
  assert.equal(r.json.summary.bookmarks, 1);
  // nothing was written
  const servicesAfter = fs.existsSync(path.join(CONFIG_DIR, 'services.yaml'))
    ? fs.readFileSync(path.join(CONFIG_DIR, 'services.yaml'), 'utf8') : null;
  assert.equal(servicesAfter, servicesBefore, 'parsing an import modified a configuration file');
  // and the plan says which files it *would* touch
  assert.ok(Array.isArray(r.json.plan.files));
  assert.ok(r.json.plan.files.some((f) => f.name === 'services.yaml'));
});

test('docker.yaml is refused by the API with an explanation, before anything is parsed', async () => {
  const r = await post('/api/config/import/parse', {
    files: { 'docker.yaml': 'my-docker:\n  socket: /var/run/docker.sock\n  password: hunter2\n' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'import_refused_file');
  assert.match(r.json.error, /credentials/i);
  assert.ok(!JSON.stringify(r.json).includes('hunter2'), 'the refusal echoed the password back');
});

test('applying an import writes configuration, records a version, and reports what it did', async () => {
  const r = await post('/api/config/import/apply', {
    files: HOMEPAGE_FILES,
    decisions: { keepUnmatched: 'bookmark', includeBookmarks: true, includeAppearance: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 400));
  assert.ok(r.json.written.includes('services.yaml'));
  assert.ok(r.json.written.includes('bookmarks.yaml'));
  assert.ok(r.json.version, 'the import recorded a configuration version');
  assert.equal(r.json.summary.matched, 2);
  assert.equal(r.json.preservedUnmatched, 1, 'the unmatched entry was kept, as a link');

  // the overlay now exists and binds only to real containers
  const services = model.readServices();
  const overlays = services.overlays;
  assert.equal(overlays.length, 2, 'exactly the two matched services became overlays');
  const containers = overlays.map((o) => o.container).sort();
  assert.deepEqual(containers, ['jellyfin', 'navidrome']);
  assert.ok(!containers.includes('not-a-container'));

  // the imported presentation is in force
  const jellyfin = overlays.find((o) => o.container === 'jellyfin');
  assert.equal(jellyfin.displayName, 'Jellyfin');
  assert.equal(jellyfin.description, 'Movies and TV from the import');
  assert.equal(jellyfin.icon, 'si:jellyfin');

  // the unmatched entry became a bookmark, which the inventory never reads
  const bookmarks = model.readBookmarks();
  const names = bookmarks.flat.map((b) => b.name);
  assert.ok(names.includes('Kodi Box'), 'the unmatched entry was not preserved as a link');
  assert.ok(names.includes('Hacker News'));

  // and the appearance patch landed
  assert.equal(model.getSettings().app.name, 'Imported Hub');
  assert.equal(model.getSettings().appearance.theme, 'dark');
});

test('an imported service that is not running is NOT in the inventory as a service', async () => {
  await model.invalidateDiscovery();
  const doc = await model.getServicesView();
  const names = doc.services.map((s) => s.name.toLowerCase());
  assert.ok(!names.some((n) => n.includes('kodi')), 'the ghost became a service');
  assert.equal(doc.services.length, FLEET.length, 'the inventory is still exactly the fleet');
});

test('the live inventory is unchanged in count by an import — the phase\'s critical invariant', async () => {
  const before = await model.getInventory({ force: true });
  const beforeIds = before.services.map((s) => s.id).sort();

  await post('/api/config/import/apply', {
    files: {
      'services.yaml': `
- Imaginary Land:
    - Ghost One:
        href: https://ghost-one.example.com
    - Ghost Two:
        href: https://ghost-two.example.com
- Media:
    - Jellyfin:
        container: jellyfin
        displayName: Renamed By Import
`,
    },
    decisions: { keepUnmatched: 'drop' },
  });

  const after = await model.getInventory({ force: true });
  const afterIds = after.services.map((s) => s.id).sort();
  assert.deepEqual(afterIds, beforeIds, 'an import changed which containers exist');
  assert.equal(after.services.length, FLEET.length);
  // the rename did land, on a container that exists
  const jellyfin = after.services.find((s) => s.name === 'jellyfin');
  assert.equal(jellyfin.displayName, 'Renamed By Import');
});

test('the same import applied as replace drops earlier overlays', async () => {
  await post('/api/config/import/apply', {
    files: { 'services.yaml': '- Media:\n    - Jellyfin:\n        container: jellyfin\n        displayName: Only One\n' },
    decisions: { keepUnmatched: 'drop' },
    mode: 'replace',
  });
  const overlays = model.readServices().overlays;
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].displayName, 'Only One');
});

test('an oversized import through the API is a 413, not a timeout', async () => {
  const huge = `- Media:\n${'    - S:\n        href: https://example.com\n'.repeat(20_000)}`;
  const r = await post('/api/config/import/parse', { files: { 'services.yaml': huge } });
  assert.equal(r.status, 413);
});

// ---------------------------------------------------------------------------
// the service presentation editor
// ---------------------------------------------------------------------------

test('the presentation endpoint separates discovered identity from user override', async () => {
  await post('/api/config/import/apply', {
    files: { 'services.yaml': '- Media:\n    - Jellyfin:\n        container: jellyfin\n        displayName: Stream\n        url: https://custom.example.com\n' },
    decisions: { keepUnmatched: 'drop' },
  });
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
// validation, history, export
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
    ['custom-css', 'a { color: red }', true],
    ['custom-css', 'a { color: red', false],
    ['custom-js', 'const a = 1;', true],
    ['custom-js', 'function () {', false],
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
  const r = await post('/api/config/validate', { area: 'settings', draft: { integrations: { markets: { symbols: ['NOT A SYMBOL!!'] } } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '', before);
});

test('history lists versions with time, reason and size, and marks the current one', async () => {
  const r = await get('/api/config/history');
  assert.equal(r.status, 200);
  assert.ok(r.json.versions.length > 0, 'the import should have left versions');
  const v = r.json.versions[0];
  assert.ok(v.at && v.reason && v.bytes > 0);
  assert.ok(Array.isArray(v.files) && v.files.length > 0);
  assert.equal(r.json.current, v.id);
  assert.deepEqual(r.json.scope, ['services.yaml', 'stacks.yaml', 'bookmarks.yaml', 'settings.yaml', 'layout.json', 'theme.css', 'app.js']);
});

test('a version diff reads as what restoring it would change', async () => {
  const versions = (await get('/api/config/history')).json.versions;
  assert.ok(versions.length >= 1);
  const r = await get(`/api/config/history/${versions[versions.length - 1].id}/diff`);
  assert.equal(r.status, 200);
  assert.equal(r.json.against, 'current');
  assert.ok(Array.isArray(r.json.sections));
  assert.ok(typeof r.json.changes === 'number');
});

test('restoring through the API brings the configuration back and reports an undo version', async () => {
  await post('/api/config/import/apply', {
    files: { 'services.yaml': '- Media:\n    - Jellyfin:\n        container: jellyfin\n        displayName: Restore Me\n' },
    decisions: { keepUnmatched: 'drop' },
    mode: 'replace',
  });
  const snapshotVersion = (await get('/api/config/history')).json.versions[0];

  await post('/api/config/import/apply', {
    files: { 'services.yaml': '- Media:\n    - Jellyfin:\n        container: jellyfin\n        displayName: Afterwards\n' },
    decisions: { keepUnmatched: 'drop' },
    mode: 'replace',
  });
  assert.equal(model.readServices().overlays[0].displayName, 'Afterwards');

  const r = await post(`/api/config/history/${snapshotVersion.id}/restore`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  assert.ok(r.json.files.includes('services.yaml'));
  assert.ok(r.json.undoVersion, 'no undo version was offered');
  assert.equal(model.readServices().overlays[0].displayName, 'Restore Me');
});

test('restoring does not disturb the mock engine\'s containers', async () => {
  const before = await model.getInventory({ force: true });
  const versions = (await get('/api/config/history')).json.versions;
  await post(`/api/config/history/${versions[versions.length - 1].id}/restore`, {});
  const after = await model.getInventory({ force: true });
  assert.deepEqual(after.services.map((s) => s.name).sort(), before.services.map((s) => s.name).sort());
  assert.equal(after.services.length, FLEET.length);
});

test('a native export is served with a filename and contains no secrets', async () => {
  const r = await get('/api/config/export?format=native');
  assert.equal(r.status, 200);
  assert.equal(r.json.format, 'opushub');
  assert.ok(r.json.files['services.yaml']);
  const whole = JSON.stringify(r.json);
  assert.ok(!whole.includes('hunter2'), 'the mock engine\'s planted secret reached an export');
  assert.ok(!/scrypt|auth\.json/i.test(whole));
});

test('a Homepage export is offered as a set of Homepage-shaped files', async () => {
  const r = await get('/api/config/export?format=homepage');
  assert.equal(r.status, 200);
  assert.equal(r.json.format, 'homepage');
  assert.ok(r.json.files['services.yaml'].trimStart().startsWith('- '), 'Homepage services.yaml is a sequence');
});

test('a single exported file can be downloaded on its own', async () => {
  const r = await get('/api/config/export/download?format=homepage&file=services.yaml');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-disposition'] || '', /attachment/, 'a download was not offered as an attachment');
  assert.match(r.headers['content-disposition'] || '', /services\.yaml/, 'the download did not name the file');
  assert.ok(r.body.trimStart().startsWith('- '), 'the downloaded file is not Homepage-shaped');
});

test('exporting never includes the runtime state directories', async () => {
  // Plant files that must not travel, then export and scan the payload.
  fs.writeFileSync(path.join(DATA_DIR, 'auth.json'), '{"user":{"scrypt":{"hash":"PLANTED-AUTH-HASH"}}}');
  fs.writeFileSync(path.join(DATA_DIR, 'sessions.json'), '{"sessions":[{"id":"PLANTED-SESSION-ID"}]}');
  fs.writeFileSync(path.join(DATA_DIR, 'activity.jsonl'), '{"message":"PLANTED-ACTIVITY"}\n');
  const r = await get('/api/config/export');
  const whole = JSON.stringify(r.json);
  for (const secret of ['PLANTED-AUTH-HASH', 'PLANTED-SESSION-ID', 'PLANTED-ACTIVITY']) {
    assert.ok(!whole.includes(secret), `an export leaked ${secret}`);
  }
});

// ---------------------------------------------------------------------------
// custom code
// ---------------------------------------------------------------------------

test('malformed custom CSS or JS is refused with the syntax problem named', async () => {
  for (const [file, bad, good] of [
    ['theme.css', 'a { color: red', 'a { color: red; }'],
    ['app.js', 'function () {', 'function f () {}'],
  ]) {
    const key = file === 'theme.css' ? 'css' : 'js';
    const refused = await put('/api/custom', { [key]: bad });
    assert.equal(refused.status, 400, `${file} accepted malformed content`);
    assert.equal(refused.json.code, 'custom_syntax');
    assert.ok(refused.json.problems.length > 0);

    const accepted = await put('/api/custom', { [key]: good });
    assert.equal(accepted.status, 200, `${file} refused valid content: ${JSON.stringify(accepted.json)}`);
    assert.ok(accepted.json[file === 'theme.css' ? 'cssModified' : 'jsModified'], `${file} reported no mtime`);
  }
});

test('custom CSS is refused when it would load a third-party stylesheet', async () => {
  const r = await put('/api/custom', { css: '@import url("https://evil.example/x.css");' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /@import/);
});

test('custom code can be reset, and the reset is versioned', async () => {
  await put('/api/custom', { css: '.x { color: red; }' });
  const r = await post('/api/custom/reset', { file: 'theme.css' });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(CONFIG_DIR, 'theme.css'), 'utf8'), '');
  const versions = (await get('/api/config/history')).json.versions;
  assert.ok(versions.some((v) => v.reason === 'custom.reset' || v.reason === 'custom.updated'));
});

test('a reset naming an arbitrary file is refused', async () => {
  const r = await post('/api/custom/reset', { file: '../../data/auth.json' });
  assert.equal(r.status, 400);
});
