// Per-file write isolation — the regression test for one class of bug, kept as its own suite.
//
// The bug it exists to prevent: an import planned a write to `bookmarks.yaml`, the commit dispatched
// on the *kind* of data ("yaml"), and the services writer wrote an empty document over
// `services.yaml` — a file the import had no business touching. The result was a valid-looking
// configuration with none of the user's presentation in it.
//
// The rule the code now follows is that a write names its file, and only that file may change. This
// suite proves it from both ends:
//
//   · a plan carrying exactly one document changes exactly one file — byte-for-byte comparison of
//     every other file in config/, so the assertion cannot be satisfied by "nothing happened";
//   · the planner's target list is the six presentation files and nothing else, with no `kind`;
//   · a write that fails halfway is rolled back to the previous bytes of the files it had already
//     written, and the files it had not reached are untouched;
//   · a configuration resource the import may not own (auth, sessions, activity, metrics, .env)
//     cannot be named by any import, and no route writes an arbitrary file name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-dispatch-'));
process.env.OPUSHUB_CONFIG_DIR = path.join(TMP, 'config');
process.env.OPUSHUB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.OPUSHUB_CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.OPUSHUB_DATA_DIR, { recursive: true });

const { startMockEngine, FLEET } = await import('../test/mock-engine.js');
const ENGINE = await startMockEngine();
process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
delete process.env.DOCKER_HOST;

const { handleApi } = await import('../server/api.js');
const { planImport, commitPlan } = await import('../server/configImport.js');
const { seedSession } = await import('../test/auth-helper.js');
const model = await import('../server/model.js');
const configStore = await import('../server/configStore.js');

const CONFIG = process.env.OPUSHUB_CONFIG_DIR;
const DATA = process.env.OPUSHUB_DATA_DIR;

/* ---------- the seeded configuration every test compares against ---------- */

const SEED = {
  'services.yaml': `# hand-written header that must survive\n\ngroups:\n  - name: Media\n    description: The living room\n    icon: 'si:jellyfin'\n    services:\n      - name: jellyfin\n        container: jellyfin\n        displayName: Jellyfin\n        icon: 'si:jellyfin'\n        hidden: false\n        showOnHub: true\n`,
  'bookmarks.yaml': `# bookmarks\ngroups:\n  - name: Reading\n    items:\n      - name: Hacker News\n        href: https://news.ycombinator.com\n`,
  'stacks.yaml': `stacks:\n  - id: media\n    name: The media stack\n    description: Everything that streams\n`,
  'settings.yaml': `app:\n  name: My Hub\nappearance:\n  theme: dark\n  accent: teal\n  background:\n    mode: quiet\n`,
  'layout.json': JSON.stringify({ version: 2, hub: { widgets: [{ id: 'services', type: 'services', zone: 'main', size: 'lg', visible: true, config: {} }], spacing: 'cozy', setupDismissed: false }, services: { groupOrder: ['Media'], order: {}, hiddenGroups: [] } }, null, 2),
  'theme.css': `:root { --seed: original; } /* keep me */\n`,
  'app.js': `window.__seed = 'original';\n`,
};

function seedConfig() {
  for (const [name, text] of Object.entries(SEED)) fs.writeFileSync(path.join(CONFIG, name), text);
}

/** Byte snapshot of every presentation file, so "nothing else changed" is a fact and not a hope. */
function snapshot() {
  const out = {};
  for (const name of fs.readdirSync(CONFIG)) {
    const file = path.join(CONFIG, name);
    if (fs.statSync(file).isFile()) out[name] = fs.readFileSync(file, 'utf8');
  }
  return out;
}

function changedBetween(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((n) => before[n] !== after[n]).sort();
}

test.after(async () => {
  await ENGINE.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/* ---------- a minimal API harness (same shape as the other Phase 6 suites) ---------- */

let cookie = null;

function req(method, body, opts = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const headers = { host: '127.0.0.1:3721', origin: 'http://127.0.0.1:3721', ...(opts.headers || {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie !== false && cookie) headers.cookie = cookie;
  return Object.assign((async function* () { for (const c of chunks) yield c; })(), { method, headers });
}

function res() {
  const out = { status: 0, headers: {}, body: '', setHeader: (k, v) => { out.headers[String(k).toLowerCase()] = v; }, writeHead: (s) => { out.status = s; }, end: (b) => { out.body = b ?? ''; }, write: (b) => { out.body += b ?? ''; }, on: () => {}, once: () => {}, emit: () => {} };
  return out;
}

async function call(method, p, body, opts) {
  const r = res();
  try {
    await handleApi(req(method, body, opts), r, new URL(p, 'http://127.0.0.1:3721'));
  } catch (err) {
    r.status = err?.status || 500;
    r.body = JSON.stringify({ error: err?.message || String(err), code: err?.code });
  }
  let json = null;
  try { json = JSON.parse(r.body); } catch { /* non-JSON bodies are fine */ }
  return { status: r.status, json, body: r.body, headers: r.headers };
}

const post = (p, body, opts) => call('POST', p, body, opts);

test('setup', async () => {
  seedConfig();
  cookie = await seedSession();
  assert.ok(cookie, 'a session cookie is required');
});

/* ==========================================================================
   one document → one file
   ========================================================================== */

test('a bookmarks-only import writes bookmarks.yaml and nothing else', async () => {
  // This is the exact shape of the original bug: the file that was *not* meant to change was
  // services.yaml, and it was overwritten with `groups: []`.
  seedConfig();
  const before = snapshot();

  const r = await post('/api/config/import/apply', {
    files: { 'bookmarks.yaml': '- Tools:\n    - Grafana:\n        - href: https://grafana.lan\n        - description: Dashboards\n' },
    decisions: { includeBookmarks: true, includeWidgets: false, includeAppearance: false, includeCustom: false },
    mode: 'merge',
  });
  assert.equal(r.status, 200, r.body);

  const after = snapshot();
  assert.deepEqual(changedBetween(before, after), ['bookmarks.yaml'], 'only the named file may change');
  assert.equal(after['services.yaml'], before['services.yaml'], 'services.yaml must be byte-identical');
  assert.match(after['bookmarks.yaml'], /Grafana/);
  assert.match(after['services.yaml'], /The living room/, 'the user’s group description is still there');
});

test('a matched service import writes services.yaml and leaves bookmarks.yaml alone', async () => {
  seedConfig();
  const before = snapshot();
  // The container name has to be one the engine really reports, otherwise the entry is unmatched and
  // (by the review screen's default) becomes a bookmark instead of an overlay — which is correct
  // behaviour, and a different test.
  const container = String(FLEET[0].Names[0]).replace(/^\//, '');

  const r = await post('/api/config/import/apply', {
    files: { 'services.yaml': `- Media:\n    - ${container}:\n        - icon: si-jellyfin\n        - href: https://jellyfin.lan\n` },
    decisions: { includeBookmarks: false, includeWidgets: false, includeAppearance: false, includeCustom: false },
    mode: 'merge',
  });
  assert.equal(r.status, 200, r.body);

  const after = snapshot();
  assert.deepEqual(changedBetween(before, after), ['services.yaml'], `written: ${JSON.stringify(r.json.written)}`);
  assert.equal(after['bookmarks.yaml'], before['bookmarks.yaml']);
  // and the writer that ran is the services one: the entry is an overlay, not a bookmark group
  const doc = model.readServices();
  assert.ok(doc.groups.some((g) => (g.services || []).some((s) => s.name === container)), `${container} landed in services.yaml`);
  assert.ok(!model.readBookmarks().groups.some((g) => g.name === container), 'and not in bookmarks.yaml');
  // the group metadata the user already had is still there — the merge rewrote this file, so this is
  // the assertion that would have caught the group-description loss
  assert.match(after['services.yaml'], /The living room/, 'group description survived the rewrite');
  assert.match(after['services.yaml'], /si:jellyfin/, 'group icon survived the rewrite');
});

test('an unmatched service entry is kept as a bookmark and never as a service', async () => {
  seedConfig();
  const before = snapshot();
  const r = await post('/api/config/import/apply', {
    files: { 'services.yaml': '- Media:\n    - a-container-that-does-not-exist:\n        - quote: not a container\n        - href: https://ghost.lan\n' },
    decisions: { includeBookmarks: true, includeWidgets: false, includeAppearance: false, includeCustom: false },
    mode: 'merge',
  });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(changedBetween(before, snapshot()), ['bookmarks.yaml'], 'a ghost goes to bookmarks, not to services.yaml');
  assert.ok(!model.readServices().groups.some((g) => (g.services || []).some((s) => s.name === 'a-container-that-does-not-exist')));
});

test('custom code is carried only when custom code is asked for, and only into its two files', async () => {
  seedConfig();
  let before = snapshot();

  const refused = await post('/api/config/import/apply', {
    files: { 'custom.css': ':root { --from-import: 1; }\n', 'custom.js': 'window.imported = true;\n' },
    decisions: { includeBookmarks: false, includeWidgets: false, includeAppearance: false, includeCustom: false },
    mode: 'merge',
  });
  assert.equal(refused.status, 200, refused.body);
  assert.deepEqual(changedBetween(before, snapshot()), [], 'declining custom code writes nothing at all');

  before = snapshot();
  const applied = await post('/api/config/import/apply', {
    files: { 'custom.css': ':root { --from-import: 1; }\n', 'custom.js': 'window.imported = true;\n' },
    decisions: { includeBookmarks: false, includeWidgets: false, includeAppearance: false, includeCustom: true },
    mode: 'merge',
  });
  assert.equal(applied.status, 200, applied.body);
  const after = snapshot();
  assert.deepEqual(changedBetween(before, after), ['app.js', 'theme.css']);
  assert.match(after['theme.css'], /--from-import/);
  assert.match(after['app.js'], /window\.imported/);
  assert.equal(after['services.yaml'], before['services.yaml']);
});

/* ==========================================================================
   the plan names files, and only files it is allowed to name
   ========================================================================== */

test('commitPlan targets are filenames, and carry no data kind', async () => {
  const plan = {
    services: { groups: [] },
    bookmarks: { groups: [] },
    settings: { app: { name: 'X' } },
    layout: { hub: { spacing: 'cozy' } },
    custom: { css: '', js: '' },
  };
  const seen = [];
  const result = commitPlan({
    plan, read: () => null,
    write: (name) => { seen.push(name); },
  });
  assert.deepEqual(result.targets, seen);
  assert.deepEqual([...seen].sort(), ['app.js', 'bookmarks.yaml', 'layout.json', 'services.yaml', 'settings.yaml', 'theme.css']);
  for (const name of seen) {
    assert.ok(/^[A-Za-z0-9._-]+$/.test(name), `${name} looks like a filename, not a kind`);
  }
});

test('an import cannot name a file it does not own', async () => {
  seedConfig();
  fs.writeFileSync(path.join(DATA, 'auth.json'), JSON.stringify({ users: [{ username: 'keeper' }] }));
  const authBefore = fs.readFileSync(path.join(DATA, 'auth.json'), 'utf8');
  const before = snapshot();

  // Homepage's own docker.yaml and a dotenv are the two most dangerous names to accept: one points
  // at the Docker socket, the other at credentials. Both are refused by name, not by content.
  const refused = await post('/api/config/import/apply', {
    files: {
      'docker.yaml': 'my-docker:\n  socket: /var/run/docker.sock\n  password: hunter2\n',
      '.env': 'SECRET=hunter2\n',
      'auth.json': '{"users":[]}',
      'bookmarks.yaml': '- Tools:\n    - Grafana:\n        - href: https://grafana.lan\n',
    },
    decisions: { includeBookmarks: true, includeWidgets: false, includeAppearance: false, includeCustom: false },
    mode: 'merge',
  });
  // A file that names a socket or a credential stops the whole import. That is the deliberate
  // posture (`phase6-import.test.js` asserts it per file name); what matters here is that it stops
  // it *before* anything is written, including the harmless file travelling in the same bundle.
  assert.equal(refused.status, 400, refused.body);
  assert.equal(refused.json.code, 'import_refused_file');
  assert.deepEqual(changedBetween(before, snapshot()), [], 'a refused bundle writes nothing at all');
  assert.equal(fs.readFileSync(path.join(DATA, 'auth.json'), 'utf8'), authBefore, 'runtime state is untouched');
  assert.ok(!fs.existsSync(path.join(DATA, '.env')), 'no dotenv may be written');

  // Names that are simply unknown are not refused — they are ignored and reported, and still write
  // nothing. Refusing every extra file in a Homepage directory would make the tool unusable.
  const ignored = await post('/api/config/import/apply', {
    files: {
      'notes.txt': 'my passwords are in here\n',
      'kuma-monitor.yaml': 'monitors: []\n',
      'bookmarks.yaml': '- Tools:\n    - Grafana:\n        - href: https://grafana.lan\n',
    },
    decisions: { includeBookmarks: true, includeWidgets: false, includeAppearance: false, includeCustom: false },
    mode: 'merge',
  });
  assert.equal(ignored.status, 200, ignored.body);
  assert.deepEqual(changedBetween(before, snapshot()), ['bookmarks.yaml']);
  assert.deepEqual(ignored.json.written, ['bookmarks.yaml']);
});

/* ==========================================================================
   partial failure rolls back, and does not touch what it had not reached
   ========================================================================== */

test('a failure part-way through a multi-file write restores the previous bytes exactly', async () => {
  seedConfig();
  const before = snapshot();
  const files = SEED; // the writer below starts from the seeded bytes

  let writes = 0;
  const write = (name, value, _kind, opts = {}) => {
    writes += 1;
    if (writes === 2) throw Object.assign(new Error('disk said no'), { status: 507 });
    if (opts.raw) { fs.writeFileSync(path.join(CONFIG, name), String(value)); return; }
    fs.writeFileSync(path.join(CONFIG, name), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const read = (name) => files[name] ?? null;

  assert.throws(() => commitPlan({
    plan: { services: '{"groups":[]}', bookmarks: '{"groups":[]}', settings: '{"app":{}}' },
    read, write,
  }), /rolled back/);

  const after = snapshot();
  assert.deepEqual(changedBetween(before, after), [], `a rolled-back import must leave no trace (${Object.keys(after)})`);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
});

/* ==========================================================================
   the read side of the same rule: no generic file write route exists
   ========================================================================== */

test('there is no arbitrary-file-write route', async () => {
  seedConfig();
  const before = snapshot();
  const attempts = [
    ['PUT', '/api/config/files/theme.css', 'body { color: red }'],
    ['PUT', '/api/config/file/theme.css', 'body { color: red }'],
    ['PUT', '/api/config/theme.css', 'body { color: red }'],
    ['POST', '/api/config/write', { name: 'theme.css', value: 'body { color: red }' }],
    ['PUT', '/api/services/../auth.json', { groups: [] }],
  ];
  for (const [method, p, body] of attempts) {
    const r = await call(method, p, body);
    assert.ok(r.status >= 400, `${method} ${p} must not be a route (got ${r.status})`);
  }
  assert.deepEqual(changedBetween(before, snapshot()), [], 'none of those attempts may write anything');

  // A known route with an injected filename must write only the file it owns: the `file` key has no
  // meaning in a settings patch, and it must not become one.
  const injected = await call('PUT', '/api/settings', { advanced: { customJs: true }, file: 'theme.css', name: 'app.js' });
  assert.ok(injected.status === 200 || injected.status === 400, injected.body);
  const injectedChanges = changedBetween(before, snapshot());
  assert.deepEqual(injectedChanges.filter((f) => f !== 'settings.yaml'), [], `an injected filename wrote ${injectedChanges}`);
  const injectedNow = snapshot();
  assert.equal(injectedNow['theme.css'], before['theme.css'], 'theme.css is byte-identical');
  assert.equal(injectedNow['app.js'], before['app.js'], 'app.js is byte-identical');

  // The positive control: the one route that does write custom code writes only its own two files.
  const put = await call('PUT', '/api/custom', { css: ':root { --control: 1; }\n' });
  assert.equal(put.status, 200, put.body);
  const finalChanges = changedBetween(before, snapshot());
  assert.ok(finalChanges.every((f) => f === 'settings.yaml' || f === 'theme.css'), `only files that were named changed: ${finalChanges}`);
  assert.match(snapshot()['theme.css'], /--control/);
});

test('the per-file writer refuses a name outside the presentation scope', async () => {
  // The dispatch table is the only place a filename becomes a writer. Feeding it something else must
  // be a refusal, not a fallback — otherwise a future plan could reach whatever writer was nearest.
  const apiSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'server', 'api.js'), 'utf8');
  assert.match(apiSource, /scope_violation/, 'the refusal exists');
  assert.ok(
    apiSource.includes("if (!writer) throw Object.assign(new Error(`${name} is not a writable configuration file`)"),
    'and it is thrown before any writer runs',
  );
  const names = [...apiSource.matchAll(/^  '([A-Za-z0-9._-]+)': \(value\) =>/gm)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ['app.js', 'bookmarks.yaml', 'layout.json', 'services.yaml', 'settings.yaml', 'stacks.yaml', 'theme.css']);
  // and the scope document the UI renders is built from the same list
  const { presentationFileNames } = await import('../server/configScope.js');
  assert.deepEqual([...presentationFileNames()].sort(), [...names].sort());
});

test('configuration history never contains runtime state', async () => {
  seedConfig();
  // A version is a snapshot of presentation files only. If a future change added data/ to the set,
  // this is the assertion that fails.
  await post('/api/config/import/apply', {
    files: { 'services.yaml': '- Media:\n    - Jellyfin:\n        - href: https://jellyfin.lan\n' },
    decisions: { includeBookmarks: false },
    mode: 'merge',
  });
  const versions = fs.readdirSync(path.join(DATA, 'config-history'));
  assert.ok(versions.length, 'the import recorded a version');
  for (const v of versions) {
    const doc = JSON.parse(fs.readFileSync(path.join(DATA, 'config-history', v), 'utf8'));
    const files = Object.keys(doc.files || {});
    for (const f of files) {
      assert.ok(!/^(auth|sessions)\.json$/.test(f), `${f} must not be versioned`);
      assert.ok(!/^(activity\.jsonl|metrics\.json)$/.test(f), `${f} must not be versioned`);
      assert.ok(!f.startsWith('.'), 'no dotfiles');
      assert.ok(!f.includes('/'), 'no paths, only names in config/');
    }
  }
});

test('configStore itself refuses anything outside the whitelist', async () => {
  seedConfig();
  for (const name of ['auth.json', '.env', '../auth.json', 'data/auth.json', 'config-history/x.json']) {
    assert.throws(() => configStore.writePresentationText(name, 'x'), /not editable|not a writable|unsafe|refus/i, `${name} must be refused`);
  }
  assert.doesNotThrow(() => configStore.writePresentationText('theme.css', ':root{}'));
});
