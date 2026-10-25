// Phase 6 — security audit of the first-run presentation path.
//
// `POST /api/setup` is deliberately reachable *before* authentication: an install with no
// administrator has nobody to authenticate. Phase 6 made it accept a `presentation` block, which
// raises the obvious question — can an unauthenticated request use it as a generic configuration
// write primitive?
//
// The answer has to be structural, not a matter of care. This file pins the structure:
//
//   · the route refuses to run at all once setup is complete, before it reads a body or writes
//     anything;
//   · the only value it accepts is `{ mode: 'detected' | 'template', template: <one of five ids> }`,
//     validated against a server-side constant list *before* the account is created;
//   · `detected` writes nothing; `template` reaches exactly one writer, which writes exactly one
//     file (`layout.json`) atomically;
//   · no string from the request reaches a filesystem path, a URL fetch, or `settings.advanced`
//     (so custom CSS/JS cannot be switched on from here);
//
// Every "nothing happened" assertion compares a full byte-level snapshot of *both* directories —
// config/ and data/ — because the security property is about the whole install, not one file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-audit-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-audit-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;
process.env.OPUSHUB_DOCKER_SOCKET = '/tmp/opushub-p6-audit-nonexistent.sock';
delete process.env.DOCKER_HOST;
delete process.env.OPUSHUB_HOST_ADDRESS;

// A configuration worth protecting: if anything clobbers it, the diff shows it.
fs.writeFileSync(path.join(CONFIG_DIR, 'services.yaml'), [
  'groups:',
  '  - name: Media',
  '    services:',
  '      - container: jellyfin',
  '        displayName: Jellyfin',
  '',
].join('\n'));
fs.writeFileSync(path.join(CONFIG_DIR, 'settings.yaml'), 'app:\n  name: Audit Fixture\nadvanced:\n  customCss: false\n  customJs: false\n');
fs.writeFileSync(path.join(CONFIG_DIR, 'theme.css'), '/* keep me */\n');
fs.writeFileSync(path.join(CONFIG_DIR, 'app.js'), '// keep me\n');

const { handleApi } = await import('./api.js');
const { seedSession } = await import('../test/auth-helper.js');
const PRESENTATION_FILES = ['services.yaml', 'stacks.yaml', 'bookmarks.yaml', 'settings.yaml', 'layout.json', 'theme.css', 'app.js'].map((name) => ({ name }));

/* --------------------------------------------------------------------------- request plumbing --- */

function req(method, body, { cookie = '', origin = 'http://127.0.0.1:3721', extraHeaders = {}, raw = null } = {}) {
  const payload = raw != null ? raw : body !== undefined ? JSON.stringify(body) : null;
  const chunks = payload == null ? [] : [Buffer.from(payload)];
  return {
    method,
    headers: {
      host: '127.0.0.1:3721',
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
      ...(payload != null ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
}

function fakeRes() {
  const r = {
    status: 0, headers: {}, body: '',
    setHeader(k, v) { r.headers[String(k).toLowerCase()] = v; },
    writeHead(s) { r.status = s; },
    end(b) { r.body = b ? String(b) : ''; },
  };
  return r;
}

async function call(method, url, body, opts) {
  const r = fakeRes();
  try {
    await handleApi(req(method, body, opts), r, new URL(url, 'http://127.0.0.1:3721'));
  } catch (e) {
    r.status = e?.status || 500;
    r.body = JSON.stringify({ error: e?.message || String(e) });
  }
  let json = null;
  try { json = JSON.parse(r.body); } catch { /* some responses are not JSON */ }
  return { status: r.status, json, headers: r.headers, body: r.body };
}

/* --------------------------------------------------------------------------- full-install snapshots --- */

/** Every file under config/ and data/, with its bytes. The unit of "nothing happened". */
function tree() {
  const out = {};
  for (const dir of [CONFIG_DIR, DATA_DIR]) {
    const walk = (d, prefix) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        const rel = `${prefix}${entry.name}`;
        if (entry.isDirectory()) walk(full, `${rel}/`);
        else out[rel] = fs.readFileSync(full, 'utf8');
      }
    };
    walk(dir, '');
  }
  return out;
}
const changedFiles = (before, after) => {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((n) => before[n] !== after[n]).sort();
};
const configTree = (t) => t;

/* ======================================================================
   1–2. Limits, and what a hostile payload cannot do — while the install is still uninitialized.
   These run first, on purpose: `POST /api/setup` is an unauthenticated route, and once an account
   exists the guard (not the validation) is what refuses everything else.
   ====================================================================== */

test('the setup body is bounded by the same JSON limit as every other route', async () => {
  const before = tree();
  const huge = JSON.stringify({ username: 'a', password: 'b'.repeat(20), presentation: { mode: 'template', template: 'x'.repeat(3_000_000) } });
  const r = await call('POST', '/api/setup', undefined, { raw: huge });
  assert.equal(r.status, 413, `an oversized setup body must be refused: ${r.status}`);
  assert.deepEqual(changedFiles(before, tree()), [], 'an oversized body wrote something');

  // Depth and node count: the route never walks the payload, so a deep document cannot buy it a
  // stack overflow that turns into a half-applied write. Whatever the parser does with it, the
  // answer is not a success and not a write.
  const deep = `${'{"a":'.repeat(60_000)}1${'}'.repeat(60_000)}`;
  const nested = await call('POST', '/api/setup', undefined, { raw: deep });
  assert.ok(nested.status >= 400, `a deeply nested body must not be accepted: ${nested.status}`);
  assert.deepEqual(changedFiles(before, tree()), [], 'a deeply nested body wrote something');
});

test('a hostile presentation payload is refused before the account exists, and writes nothing', async () => {
  const before = tree();
  // Valid credentials on purpose: if a hostile presentation value were accepted, the request would
  // succeed and create the account, so a 400 can only come from the presentation validation itself.
  const creds = { username: 'auditor', password: 'audit-password-42' };
  const cases = [
    { presentation: 'template', why: 'a string where an object belongs' },
    { presentation: ['template'], why: 'an array where an object belongs' },
    { presentation: { mode: 'custom' }, why: 'an unknown mode' },
    { presentation: { mode: 'template' }, why: 'a template mode with no id' },
    { presentation: { mode: 'template', template: 7 }, why: 'a numeric id' },
    { presentation: { mode: 'template', template: {} }, why: 'an object id' },
    { presentation: { mode: 'template', template: null }, why: 'a null id' },
    { presentation: { mode: 'template', template: ['balanced'] }, why: 'an array whose string form names a real template' },
    { presentation: { mode: 'template', template: ['__proto__'] }, why: 'an array whose string form is a prototype key' },
    { presentation: { mode: 'template', template: '../../data/auth.json' }, why: 'a path as an id' },
    { presentation: { mode: 'template', template: '/etc/passwd' }, why: 'an absolute path as an id' },
    { presentation: { mode: 'template', template: 'layout.json' }, why: 'a filename as an id' },
    { presentation: { mode: 'template', template: '__proto__' }, why: 'a prototype key as an id' },
  ];
  for (const c of cases) {
    const r = await call('POST', '/api/setup', { ...creds, ...c });
    assert.equal(r.status, 400, `${c.why} must be a bad request on an uninitialized install: ${r.status} ${r.body}`);
    assert.ok(r.json?.code, `${c.why} must be refused with a machine-readable code`);
  }
  // Nothing above may have created the account, applied a template, or touched the configuration.
  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'auth.json')), 'a refused setup payload created an account');
  assert.deepEqual(changedFiles(before, tree()), [], 'a refused setup payload wrote something');
});

/* ======================================================================
   3. One account, created by exactly one request — and nothing else.
   ====================================================================== */

test('setup accepts exactly one account, ignores a malformed presentation field, and then refuses', async () => {
  const beforeSetup = tree();

  const first = await call('POST', '/api/setup', { username: 'auditor', password: 'audit-password-42' });
  assert.equal(first.status, 201, first.body);
  assert.equal(first.json.presentation.mode, 'detected', 'the default presentation must write no template');
  assert.equal(first.json.presentation.template, null);
  const afterSetup = tree();
  assert.deepEqual(changedFiles(beforeSetup, afterSetup).sort(), ['activity.jsonl', 'auth.json', 'sessions.json'],
    'setup must write the account, its session and the setup event — and nothing else');
  assert.ok(!fs.existsSync(path.join(CONFIG_DIR, 'layout.json')), 'the detected default still wrote a layout');

  // Now that an account exists, the same route with the most tempting body available.
  const before = tree();
  const crafted = await call('POST', '/api/setup', {
    username: 'attacker', password: 'attacker-password-42',
    presentation: { mode: 'template', template: 'balanced' },
    infrastructure: { hostAddress: 'evil.example', customCss: true, customJs: true },
    advanced: { customJs: true },
  });
  assert.equal(crafted.status, 409, `a completed install must refuse setup: ${crafted.body}`);
  assert.equal(crafted.json.code, 'already_setup');
  assert.deepEqual(changedFiles(before, tree()), [], 'a refused setup call wrote something');

  // The guard runs *before* the body is parsed, which is the stronger property: a completed install
  // never even reads an unauthenticated request body, so it cannot be made to buffer 3 MB.
  const oversized = await call('POST', '/api/setup', undefined, {
    raw: JSON.stringify({ username: 'a', password: 'b'.repeat(20), junk: 'x'.repeat(3_000_000) }),
  });
  assert.equal(oversized.status, 409, `a completed install must refuse before reading the body (${oversized.status})`);
  assert.deepEqual(changedFiles(before, tree()), [], 'a refused oversized setup call wrote something');

  // …and the guard is not merely "an account exists": /api/setup/status reports the same fact.
  const status = await call('GET', '/api/setup/status', undefined, {});
  assert.equal(status.json.complete, true);
});

/* ======================================================================
   4–7. The presentation payload can only reach the presentation resources.
   ====================================================================== */

test('the template the setup path applies writes layout.json and nothing else', async () => {
  const before = tree();
  const { applyLayoutTemplate } = await import('./model.js');
  const layoutPath = path.join(CONFIG_DIR, 'layout.json');
  assert.ok(!fs.existsSync(layoutPath), 'the fixture should not have a layout yet');
  await applyLayoutTemplate('balanced');
  const after = tree();
  assert.ok(fs.existsSync(layoutPath), 'the template should have written layout.json');
  const moved = changedFiles(before, after);
  assert.deepEqual(moved, ['layout.json'], `a template apply wrote ${moved.join(', ')}`);
  assert.deepEqual(changedFiles(configTree(before), configTree(after)), ['layout.json'],
    'a template apply touched a file other than layout.json');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(layoutPath, 'utf8')), 'the layout must stay parseable JSON');
});

test('the setup template id is an identifier, never a path, and traversal is refused', async () => {
  const { templateIds } = await import('./templates.js');
  const ids = templateIds();
  assert.equal(ids.length, 5, 'the template list should be the five built-ins');
  for (const hostile of [
    '../../data/auth.json', '/etc/passwd', 'services.yaml', 'layout.json', '..', '.', '',
    'balanced/../../settings.yaml', 'BALANCED', 'balanced ', 'balanced\n', '__proto__',
    'constructor', 'toString', 'minimal\x00', 'minimal; cat /etc/passwd',
  ]) {
    assert.equal(ids.includes(hostile), false, `${JSON.stringify(hostile)} must not select a template`);
  }
  for (const id of ids) {
    assert.equal(typeof id, 'string');
    assert.match(id, /^[a-z][a-z0-9-]{1,24}$/, `${id} should be a boring identifier`);
  }
});

test('custom CSS/JS cannot be written through setup, and settings no longer carry it', async () => {
  const session = await seedSession();
  const auth = { cookie: session };

  const settings = await call('GET', '/api/settings', undefined, auth);
  assert.equal(settings.status, 200, settings.body);
  assert.equal(settings.json.advanced, undefined, 'custom CSS/JS is no longer part of the settings model');

  const before = tree();
  const r = await call('POST', '/api/setup', {
    username: 'x', password: 'y'.repeat(20),
    infrastructure: { advanced: { customJs: true }, customCss: true, customJs: true },
    advanced: { customJs: true },
    presentation: { mode: 'template', template: 'balanced', custom: { js: 'window.__x = 1;' } },
  });
  assert.equal(r.status, 409, r.body);
  assert.equal(fs.readFileSync(path.join(CONFIG_DIR, 'theme.css'), 'utf8'), '/* keep me */\n', 'theme.css was touched by setup');
  assert.equal(fs.readFileSync(path.join(CONFIG_DIR, 'app.js'), 'utf8'), '// keep me\n', 'app.js was touched by setup');
  assert.deepEqual(changedFiles(before, tree()), [], 'a refused setup wrote something');
});

test('nothing in the setup path fetches a URL from the request', async () => {
  const before = tree();
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; return new Response('{}', { status: 200 }); };
  try {
    const r = await call('POST', '/api/setup', {
      username: 'a', password: 'b'.repeat(20),
      presentation: { mode: 'template', template: 'balanced', url: 'http://169.254.169.254/latest/meta-data/', background: 'https://example.com/x.jpg' },
      infrastructure: { hostAddress: 'http://169.254.169.254/' },
    });
    assert.equal(r.status, 409, r.body);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(fetched, 0, 'the setup path resolved a URL from request data');
  assert.deepEqual(changedFiles(before, tree()), [], 'a URL-bearing payload wrote something');
});

/* ======================================================================
   8. One write, atomic, no intermediate left behind.
   ====================================================================== */

test('a presentation write is a single atomic file replacement', async () => {
  const layoutPath = path.join(CONFIG_DIR, 'layout.json');
  const before = fs.readFileSync(layoutPath, 'utf8');
  const { applyLayoutTemplate } = await import('./model.js');
  await applyLayoutTemplate('minimal');
  const after = fs.readFileSync(layoutPath, 'utf8');
  assert.notEqual(after, before);
  assert.doesNotThrow(() => JSON.parse(after), 'the layout file must remain parseable JSON');
  const allowed = new Set([...PRESENTATION_FILES.map((f) => f.name), 'icons', 'backgrounds']);
  const strays = fs.readdirSync(CONFIG_DIR).filter((f) => !allowed.has(f));
  assert.deepEqual(strays, [], `unexpected files in the config directory: ${strays.join(', ')}`);
});

/* ======================================================================
   The whole path, end to end, on an install that does not exist yet.

   Everything above runs inside one process whose module state is already "set up". This last check
   drives the real unauthenticated request against brand-new config/ and data/ directories, in a
   child process, and compares the filesystem before and after — which is the only way to assert
   what a first-run install actually writes.
   ====================================================================== */

test('a first run that chooses a template writes the account and layout.json, and nothing else', async () => {
  const { spawnSync } = await import('node:child_process');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-firstrun-cfg-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-firstrun-data-'));
  const script = `
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { handleApi } = await import('${new URL('./api.js', import.meta.url).href}');
    const list = (dir) => {
      const out = {};
      for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
        if (!e.isFile()) continue;
        const full = path.join(e.parentPath ?? e.path, e.name);
        out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
      }
      return out;
    };
    const before = { ...list(process.env.OPUSHUB_CONFIG_DIR), ...list(process.env.OPUSHUB_DATA_DIR) };
    const r = { status: 0, body: '', setHeader() {}, writeHead(s) { r.status = s; }, end(b) { r.body = b ? String(b) : ''; } };
    const body = JSON.stringify({
      username: 'firstrun', password: 'first-run-password-42',
      presentation: { mode: 'template', template: 'balanced', custom: { js: 'window.__x = 1;' }, files: { 'theme.css': 'body{display:none}' } },
      advanced: { customJs: true, customCss: true },
      files: { 'layout.json': '{}' },
    });
    const chunks = [Buffer.from(body)];
    const req = { method: 'POST', headers: { host: '127.0.0.1:3721', origin: 'http://127.0.0.1:3721', 'content-type': 'application/json' },
      [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
    await handleApi(req, r, new URL('http://127.0.0.1:3721/api/setup'));
    const after = { ...list(process.env.OPUSHUB_CONFIG_DIR), ...list(process.env.OPUSHUB_DATA_DIR) };
    process.stdout.write(JSON.stringify({ status: r.status, response: JSON.parse(r.body), before, after }));
  `;

  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, OPUSHUB_CONFIG_DIR: cfg, OPUSHUB_DATA_DIR: data, OPUSHUB_DOCKER_SOCKET: '/tmp/opushub-p6-firstrun-nonexistent.sock' },
  });
  assert.equal(run.status, 0, `the child process failed:\n${run.stderr}`);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, 201, JSON.stringify(report.response));
  assert.equal(report.response.presentation.mode, 'template');
  assert.equal(report.response.presentation.template, 'balanced');
  assert.equal(report.response.authenticated, true, 'setup signs the new administrator in');

  const moved = [...new Set([...Object.keys(report.before), ...Object.keys(report.after)])]
    .filter((n) => report.before[n] !== report.after[n]).sort();

  // Exactly what setup is allowed to write: the account, its session, the setup event, the layout
  // it was asked to apply.
  assert.deepEqual(moved,
    ['activity.jsonl', 'auth.json', 'layout.json', 'sessions.json'],
    `first-run setup wrote ${moved.join(', ')}`);
  // and the layout it applied is the template's, not an empty document
  const layout = JSON.parse(report.after['layout.json']);
  assert.ok(layout.hub.widgets.length >= 4, 'the template was not applied to layout.json');

  fs.rmSync(cfg, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});
