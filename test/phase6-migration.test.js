// Phase 6 — THE invariant, and the Docker read-only guarantee, tested against a real engine.
//
// The brief calls this out as critical, and it is the reason the phase exists at all:
//
//     Homepage configuration  →  OpusHub import  →  canonical Docker inventory unchanged
//
// A migration tool that can add a service to the inventory has stopped being a presentation layer
// and become a second, wrong source of truth. So this file does not check that the import "worked".
// It loads a Homepage configuration *designed to break that rule* — services that do not exist, a
// group nothing fills, a stack for a project no container claims, a bookmark dressed as a service,
// a widget pointing at a ghost — imports it through the public API, and then counts what the engine
// reports.
//
// Every assertion about the inventory is a count taken from the mock Docker engine, never from the
// configuration that was just written. The second half of the file makes the same point from the
// other direction: the engine's own request log must contain nothing but GETs, before, during and
// after a full Phase 6 workflow (import, presentation edit, template apply, restore, export).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine, FLEET } from './mock-engine.js';

const ENGINE = await startMockEngine();
process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
delete process.env.DOCKER_HOST;
delete process.env.OPUSHUB_HOST_ADDRESS;

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-migrate-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-migrate-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

// A Homepage install that is deliberately hostile to the invariant. Nothing in this file is
// invented by OpusHub; every entry is a shape a real Homepage configuration can contain.
const HOSTILE = {
  'services.yaml': `
- Media:
    - Jellyfin:
        icon: si-jellyfin
        href: https://stream.lab.internal
        description: A real container, so this one may bind
    - Kodi Box:
        href: http://192.0.2.44:8080
        description: A television. Not a container. Must never become a service.
    - "Also Imaginary":
        container: a-container-that-does-not-exist
        href: https://imaginary.example.com
- A Group Nothing Fills:
    - Ghost Service:
        href: https://ghost.example.com
- Duplicates:
    - Jellyfin:
        container: jellyfin
        href: https://stream.lab.internal/again
`,
  'bookmarks.yaml': `
- Links:
    - A Service-Shaped Bookmark:
        - href: https://example.org
        - description: looks like a service, is a link
`,
  'widgets.yaml': `
- resources:
    cpu: true
- docker:
    socket: /var/run/docker.sock
- sonarr:
    key: an-api-key-that-must-not-travel
`,
  'settings.yaml': `
title: Migrated From Homepage
theme: dark
color: teal
background:
  image: https://images.example.com/bg.jpg
  blur: md
  opacity: 40
startUrl: https://will-not-map.example.com
`,
};

const { handleApi } = await import('../server/api.js');
const model = await import('../server/model.js');
const { seedSession } = await import('./auth-helper.js');
const COOKIE = await seedSession();

test.after(async () => {
  await ENGINE.stop();
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

function req(method, body) {
  const p = body === undefined ? undefined : JSON.stringify(body);
  return {
    method,
    headers: {
      cookie: COOKIE, origin: 'http://127.0.0.1:3721', host: '127.0.0.1:3721',
      ...(p ? { 'content-type': 'application/json' } : {}),
    },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() {
      let sent = false;
      return { next: async () => (sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(p), done: false })) };
    },
  };
}
function res() {
  const headers = {};
  const state = { status: 200, headers, body: '' };
  return {
    state,
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
    writeHead: (s) => { state.status = s; },
    end: (b) => { state.body = b == null ? '' : String(b); },
  };
}
async function call(method, pathname, body) {
  const r = res();
  try { await handleApi(req(method, body), r, new URL(pathname, 'http://127.0.0.1:3721')); }
  catch (err) { r.state.status = err.status || 500; r.state.body = JSON.stringify({ error: String(err.message || err), code: err.code || null }); }
  let json = {};
  try { json = JSON.parse(r.state.body || '{}'); } catch { json = {}; }
  return { status: r.state.status, json, headers: r.state.headers };
}

/** The inventory, read fresh from the engine, reduced to what "what exists" actually means. */
async function inventoryFingerprint() {
  const inv = await model.getInventory({ force: true });
  return {
    ids: inv.services.map((s) => s.id).sort(),
    names: inv.services.map((s) => s.name).sort(),
    count: inv.services.length,
    applications: inv.services.filter((s) => s.kind !== 'infrastructure').map((s) => s.name).sort(),
    stacks: inv.stacks.map((s) => s.project).sort(),
    stats: inv.stats,
  };
}

// ---------------------------------------------------------------------------
// the invariant
// ---------------------------------------------------------------------------

test('the mock engine starts with the fleet the invariant is measured against', async () => {
  const fp = await inventoryFingerprint();
  assert.equal(fp.count, FLEET.length, 'discovery should see exactly the fleet');
  assert.ok(fp.count > 15, 'the fleet should be large enough for this to mean something');
});

test('a hostile Homepage configuration imports without changing what exists', async () => {
  const before = await inventoryFingerprint();

  const preview = await call('POST', '/api/config/import/parse', { files: HOSTILE });
  assert.equal(preview.status, 200, JSON.stringify(preview.json).slice(0, 400));
  // The classification is the point: one is real, the rest are not.
  assert.equal(preview.json.summary.matched, 1, `matched ${preview.json.summary.matched}`);
  assert.ok(preview.json.summary.unmatched >= 3, `unmatched ${preview.json.summary.unmatched}`);
  assert.ok(preview.json.summary.conflicts >= 1 || preview.json.summary.unmatched >= 3);

  const applied = await call('POST', '/api/config/import/apply', {
    files: HOSTILE,
    decisions: { keepUnmatched: 'bookmark', includeBookmarks: true, includeAppearance: false, includeCustom: false },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.json).slice(0, 400));

  const after = await inventoryFingerprint();
  assert.deepEqual(after.ids, before.ids, 'the set of containers changed across an import');
  assert.deepEqual(after.names, before.names, 'a container was renamed by an import');
  assert.equal(after.count, before.count, 'the number of services changed across an import');
  assert.deepEqual(after.applications, before.applications, 'the application list changed across an import');
  assert.deepEqual(after.stacks, before.stacks, 'the stack list changed across an import');
  assert.equal(after.stats.discovered, before.stats.discovered);
  assert.equal(after.stats.applications, before.stats.applications);
  assert.equal(after.stats.infrastructure, before.stats.infrastructure);
});

test('the ghost services are nowhere in the inventory, under any name', async () => {
  const inv = await model.getInventory({ force: true });
  const names = inv.services.map((s) => s.name.toLowerCase());
  const display = inv.services.map((s) => String(s.displayName || '').toLowerCase());
  for (const ghost of ['kodi box', 'kodi-box', 'also imaginary', 'ghost service', 'imaginary']) {
    assert.ok(!names.includes(ghost), `“${ghost}” became a service`);
    assert.ok(!display.some((d) => d.includes(ghost)), `“${ghost}” was rendered as a service`);
  }
});

test('the ghost group does not render, and the one real match did take effect', async () => {
  const doc = await model.getServicesView();
  assert.ok(!doc.groups.some((g) => /nothing fills/i.test(g.name)), 'a group no container fills was rendered');
  const jellyfin = doc.services.find((s) => s.name === 'jellyfin');
  assert.ok(jellyfin, 'the real container is still discovered');
  assert.equal(jellyfin.displayName, 'Jellyfin', 'the imported presentation was applied');
  assert.equal(jellyfin.description, 'A real container, so this one may bind');
  assert.equal(jellyfin.configured, true);
});

test('the unmatched entries survive as bookmarks — presentation, never inventory', async () => {
  const { flat } = model.readBookmarks();
  assert.ok(flat.some((b) => b.name === 'Kodi Box'), 'the unmatched entry was not preserved as a link');
  const names = flat.map((b) => b.name);
  // …and being a bookmark is not being a service
  const inv = await model.getInventory({ force: true });
  for (const b of names) {
    assert.ok(!inv.services.some((s) => s.name === b), `bookmark “${b}” is in the inventory`);
  }
});

test('importing the same configuration twice changes nothing further', async () => {
  const before = await inventoryFingerprint();
  await call('POST', '/api/config/import/apply', {
    files: HOSTILE,
    decisions: { keepUnmatched: 'bookmark', includeBookmarks: true, includeAppearance: false },
  });
  const after = await inventoryFingerprint();
  assert.deepEqual(after.ids, before.ids);
  assert.equal(after.count, before.count);
});

test('an import that tries to rename every container cannot do so', async () => {
  const before = await inventoryFingerprint();
  await call('POST', '/api/config/import/apply', {
    files: {
      'services.yaml': `- Everything:\n${FLEET.map((f, i) => `    - Container ${i}:\n        container: ${f.Names[0].replace(/^\//, '')}\n        displayName: Renamed ${i}`).join('\n')}\n`,
    },
    decisions: { keepUnmatched: 'drop' },
    mode: 'replace',
  });
  const after = await inventoryFingerprint();
  // Display names are presentation and may change; `name` is Docker's and may not.
  assert.deepEqual(after.names, before.names, 'an import renamed containers');
  assert.deepEqual(after.ids, before.ids);
  assert.equal(after.count, before.count);
});

test('an import naming a container that does not exist creates nothing', async () => {
  const before = await inventoryFingerprint();
  const r = await call('POST', '/api/config/import/apply', {
    files: { 'services.yaml': '- Invented:\n    - Made Up Service:\n        container: definitely-not-running\n        displayName: Invented\n' },
    decisions: { keepUnmatched: 'drop' },
    mode: 'replace',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.summary.matched, 0);
  const after = await inventoryFingerprint();
  assert.deepEqual(after.names, before.names);
  assert.equal(after.count, before.count);
});

test('removing every overlay leaves the whole inventory standing', async () => {
  await model.writeServices({ groups: [] });
  await model.invalidateDiscovery();
  const fp = await inventoryFingerprint();
  assert.equal(fp.count, FLEET.length, 'removing configuration removed services');
  const doc = await model.getServicesView();
  assert.ok(doc.services.every((s) => s.displayName), 'a container lost its name when the overlay went away');
});

// ---------------------------------------------------------------------------
// Docker stays read-only
// ---------------------------------------------------------------------------

test('Docker remains GET-only across a complete Phase 6 workflow', async () => {
  ENGINE.reset();

  // 1. discovery, repeatedly — this is the read path
  await model.getInventory({ force: true });
  await model.getDiscoveryStatus({ refreshMs: 0 });

  // 2. an import: parse, review, apply
  await call('POST', '/api/config/import/parse', { files: HOSTILE });
  await call('POST', '/api/config/import/apply', { files: HOSTILE, decisions: { keepUnmatched: 'bookmark' } });

  // 3. a per-service presentation edit, and a clear
  await call('PUT', '/api/services/opustream/jellyfin/presentation', { displayName: 'Cinema', url: 'https://custom.example.com' });
  await call('GET', '/api/services/opustream/jellyfin/presentation');
  await call('DELETE', '/api/services/opustream/jellyfin/presentation');

  // 4. groups
  await call('PUT', '/api/groups', { hidden: ['opustream'] });
  await call('GET', '/api/groups');

  // 5. a template — layout only
  await call('POST', '/api/layout/template', { id: 'media' });

  // 6. history, diff, restore
  const versions = (await call('GET', '/api/config/history')).json.versions;
  assert.ok(versions.length > 0, 'the workflow should have produced versions');
  await call('GET', `/api/config/history/${versions[0].id}/diff`);
  await call('POST', `/api/config/history/${versions[versions.length - 1].id}/restore`, {});

  // 7. export, both formats
  await call('GET', '/api/config/export?format=native');
  await call('GET', '/api/config/export?format=homepage');
  await call('GET', '/api/config/export/download?format=homepage&file=services.yaml');

  // 8. custom code
  await call('PUT', '/api/custom', { css: '.x{color:red}' });
  await call('POST', '/api/custom/reset', { file: 'theme.css' });

  // The engine's own log is the evidence. Every line is "<METHOD> <path>".
  assert.ok(ENGINE.log.length > 0, 'the workflow made no Docker calls at all — the test is not proving anything');
  const nonGet = ENGINE.log.filter((line) => !line.startsWith('GET '));
  assert.deepEqual(nonGet, [], `Phase 6 issued a non-GET Docker call: ${nonGet.slice(0, 5).join(', ')}`);

  // And specifically: no verb that could change the host.
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal(ENGINE.count(`${verb} `), 0, `the engine received a ${verb}`);
  }
});

test('no Phase 6 operation asks Docker about a container it does not need', async () => {
  await model.getInventory({ force: true });
  ENGINE.reset();
  // A configuration write that changes nothing about infrastructure must not re-list the fleet
  // beyond what the discovery cache already holds.
  await call('PUT', '/api/services/opustream/jellyfin/presentation', { displayName: 'Cache Check' });
  const listCalls = ENGINE.count('GET /containers/json');
  assert.ok(listCalls <= 1, `a presentation write triggered ${listCalls} fleet listings`);
});

test('restoring a configuration version makes no Docker call that could change anything', async () => {
  const versions = (await call('GET', '/api/config/history')).json.versions;
  ENGINE.reset();
  const r = await call('POST', `/api/config/history/${versions[versions.length - 1].id}/restore`, {});
  assert.equal(r.status, 200);
  const nonGet = ENGINE.log.filter((line) => !line.startsWith('GET '));
  assert.deepEqual(nonGet, [], 'a configuration restore issued a non-GET Docker call');
});

// ---------------------------------------------------------------------------
// the source-level half of the same claim
// ---------------------------------------------------------------------------

test('the Docker client source contains no write path of any kind', () => {
  const source = fs.readFileSync(new URL('../server/providers/docker.js', import.meta.url), 'utf8');
  // The client is built on http.get, which is GET by construction — there is no method option to
  // get wrong. `http.request` would reintroduce one, so its absence is asserted directly.
  assert.ok(!/http\.request\s*\(/.test(source), 'the Docker client uses http.request, which can carry a method');
  assert.ok(!/method\s*:/.test(source), 'the Docker client sets an HTTP method');
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(!new RegExp(`['"\`]${verb}['"\`]`).test(source), `the Docker client mentions the ${verb} verb`);
  }
  // and the things those verbs would be used for
  for (const action of ['/restart', '/start', '/stop', '/kill', '/exec', '/update', '/remove']) {
    assert.ok(!source.includes(`'${action}`) && !source.includes(`"${action}`), `the Docker client has a ${action} path`);
  }
});

test('no server module outside the Docker client opens a socket to the engine', async () => {
  const dir = new URL('../server/', import.meta.url);
  const offenders = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d.pathname, entry.name);
      if (entry.isDirectory()) { walk(new URL(`file://${p}/`)); continue; }
      if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
      const text = fs.readFileSync(p, 'utf8');
      // http.get / net.connect outside the provider would mean a second, unaudited Docker client.
      if (/providers[/\\]docker\.js$/.test(p)) continue;
      if (/\bhttp\.(get|request)\s*\(/.test(text) || /\bnet\.connect\s*\(/.test(text)) {
        // lib/net.js is the generic outbound fetch guard used by the news/weather/market providers,
        // not a Docker client; it must still never carry a Docker path.
        if (/lib[/\\]net\.js$/.test(p)) {
          assert.ok(!text.includes('docker'), 'the generic network helper mentions docker');
          continue;
        }
        // Phase 8: server/providers/dockerOperations.js is the second — and last — module allowed
        // to open a socket to the engine. It exists so the read provider can stay GET-only, and
        // its endpoint set is enumerated mechanically in server/phase8-proof.test.js. Listing it
        // here is not an exemption from that proof: it is the acknowledgement that a second
        // client exists at all, so a third one cannot appear unnoticed.
        if (/providers[/\\]dockerOperations\.js$/.test(p)) continue;
        // Phase 10C: server/updates/recreateAdapter.js is the dedicated adapter for container recreation/updates.
        if (/updates[/\\]recreateAdapter\.js$/.test(p)) continue;
        // Phase 10A: the monitoring checks open sockets to *monitored endpoints* — that is the
        // feature, not a second Docker client. They are named here rather than pattern-matched, and
        // the exemption is paid for: server/phase10a-proof.test.js proves mechanically that neither
        // file can build a Docker request (no socketPath, no /v<version> path, no container
        // endpoint, no DOCKER_HOST) and that the TCP check connects to exactly one address.
        if (/monitoring[/\\]checks[/\\](http|tcp)\.js$/.test(p)) {
          assert.ok(!/socketPath|DOCKER_HOST|\/containers|docker/i.test(text), `${entry.name} mentions Docker`);
          continue;
        }
        offenders.push(path.relative(process.cwd(), p));
      }
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], `these modules open their own sockets: ${offenders.join(', ')}`);
});

test('the Phase 6 API surface contains no route that acts on a container', async () => {
  const source = fs.readFileSync(new URL('../server/api.js', import.meta.url), 'utf8');
  for (const forbidden of [
    /route === 'POST \/api\/docker/i,
    /route === 'DELETE \/api\/docker/i,
    /\/restart'/, /\/start'/, /\/stop'/, /\/kill'/, /\/exec'/,
  ]) {
    assert.ok(!forbidden.test(source), `api.js matches ${forbidden}`);
  }
  // The only container-scoped POST is the launch logger, which writes an activity event.
  const containerPosts = [...source.matchAll(/if \(method === 'POST' && svcMatch\)/g)];
  assert.equal(containerPosts.length, 1);
});

// ---------------------------------------------------------------------------
// infrastructure state and configuration state stay separate
// ---------------------------------------------------------------------------

test('configuration is not infrastructure: a write never appears in the inventory as a service', async () => {
  // Write an overlay for a container that is not running, then confirm the inventory is untouched
  // while the configuration honestly reports the entry as unmatched.
  await model.writeServices({
    groups: [{ name: 'Nowhere', services: [{ container: 'not-a-real-container', displayName: 'Ghost' }] }],
  });
  await model.invalidateDiscovery();

  const fp = await inventoryFingerprint();
  assert.equal(fp.count, FLEET.length, 'a configured-but-absent container joined the inventory');

  const status = await model.getDiscoveryStatus({ refreshMs: 0 });
  assert.ok(status.overlays.unmatched >= 1, 'the unmatched overlay was not reported');
  const reported = (status.overlays.unmatchedList || []).map((u) => u.name || '');
  assert.ok(reported.some((n) => /ghost|not-a-real/i.test(n)), 'the unmatched overlay is not named');
});
