// Phase 6 — security audit of the first-run presentation path, and of the configuration read /
// history endpoints it sits beside.
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
//   · the only value it accepts is `{ mode: 'detected' | 'template', template: <one of six ids> }`,
//     validated against a server-side constant list *before* the account is created;
//   · `detected` writes nothing; `template` reaches exactly one writer, which writes exactly one
//     file (`layout.json`) atomically;
//   · no string from the request reaches a filesystem path, a URL fetch, or `settings.advanced`
//     (so custom CSS/JS cannot be switched on from here);
//   · the history snapshot the template path records is the presentation scope, and a version file
//     that names anything else is refused file-by-file at restore time;
//   · the four configuration read/delete/restore endpoints have the auth + CSRF boundaries they
//     claim.
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
const { PRESENTATION_FILES, PROTECTED_STATE } = await import('./configScope.js');

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
const configTree = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith('config-history/')));

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
  assert.equal(ids.length, 6, 'the template list should be the six built-ins');
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

test('custom CSS/JS cannot be switched on, or written, through setup', async () => {
  const session = await seedSession();
  const auth = { cookie: session };

  const settings = await call('GET', '/api/settings', undefined, auth);
  assert.equal(settings.status, 200, settings.body);
  assert.equal(settings.json.advanced.customCss, false, 'custom CSS must start off');
  assert.equal(settings.json.advanced.customJs, false, 'custom JS must start off');

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
   9–10. History holds presentation state, and a hostile version cannot escape it.
   ====================================================================== */

test('setup history snapshots hold presentation files only, and a hostile version is refused per file', async () => {
  const session = await seedSession();
  const auth = { cookie: session };
  // A real configuration write, through the authenticated route, so the history list holds a
  // version this audit did not plant.
  const wrote = await call('PUT', '/api/settings', { app: { name: 'Audit Fixture Two' } }, auth);
  assert.equal(wrote.status, 200, wrote.body);
  const hist = await call('GET', '/api/config/history', undefined, auth);
  assert.equal(hist.status, 200, hist.body);
  const allowed = new Set(PRESENTATION_FILES.map((f) => f.name));
  assert.ok(hist.json.versions.length >= 1, 'an authenticated settings write should have recorded a version');
  for (const v of hist.json.versions) {
    for (const name of v.files) {
      assert.ok(allowed.has(name), `a version claims to hold ${name}, which is outside the presentation scope`);
    }
  }

  // A version file planted by hand, naming authentication state: restore must refuse that file and
  // still restore the legitimate ones. This is the guard that makes an old or edited snapshot
  // incapable of escaping the boundary.
  const historyDir = path.join(DATA_DIR, 'config-history');
  fs.mkdirSync(historyDir, { recursive: true });
  const hostileId = '2020-01-01T00-00-00-000Z';
  fs.writeFileSync(path.join(historyDir, `${hostileId}.json`), JSON.stringify({
    format: 1, at: '2020-01-01T00:00:00.000Z', reason: 'planted', subject: 'audit', label: 'hostile version',
    actor: 'audit', checksum: 'x',
    files: {
      'services.yaml': 'groups: []\n',
      '../../data/auth.json': JSON.stringify({ users: [{ username: 'attacker', hash: 'x' }] }),
      'data/sessions.json': '[]',
      '../.env': 'SECRET=1\n',
      '/etc/passwd': 'root:x:0:0\n',
    },
    changed: [],
  }), 'utf8');

  const outsideBefore = Object.fromEntries([path.join(CONFIG_DIR, '..', '.env'), '/etc/passwd']
    .map((t) => [t, fs.existsSync(t) ? fs.readFileSync(t, 'utf8') : null]));
  const authBefore = fs.readFileSync(path.join(DATA_DIR, 'auth.json'), 'utf8');
  const sessionsBefore = fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8');
  const restore = await call('POST', `/api/config/history/${hostileId}/restore`, {}, auth);
  assert.equal(restore.status, 200, restore.body);
  assert.deepEqual(restore.json.files, ['services.yaml'], `only services.yaml may be restored (got ${JSON.stringify(restore.json.files)})`);
  assert.equal(restore.json.skipped.length, 4, 'every out-of-scope file must be reported as skipped');
  for (const entry of restore.json.skipped) {
    assert.ok(entry.file && entry.reason, 'a skipped file must say which file, and why');
  }
  assert.equal(fs.readFileSync(path.join(DATA_DIR, 'auth.json'), 'utf8'), authBefore, 'authentication state was overwritten by a restore');
  assert.equal(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'), sessionsBefore, 'sessions were overwritten by a restore');
  // A path that exists on every machine would make an existence check meaningless, so the probe is
  // "did these bytes change", for both destinations the planted version aimed at.
  const outside = [path.join(CONFIG_DIR, '..', '.env'), '/etc/passwd'];
  for (const target of outside) {
    assert.equal(fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null, outsideBefore[target] ?? null,
      `a restore wrote outside the configuration scope: ${target}`);
  }

  // A traversal id is not a version at all — for restore or for delete.
  for (const id of ['../../data/auth', '..%2F..%2Fdata%2Fauth', 'auth.json']) {
    const r = await call('POST', `/api/config/history/${encodeURIComponent(id)}/restore`, {}, auth);
    assert.equal(r.status, 404, `restoring ${id} must 404: ${r.status} ${r.body}`);
    const d = await call('DELETE', `/api/config/history/${encodeURIComponent(id)}`, undefined, auth);
    assert.equal(d.status, 404, `deleting ${id} must 404: ${d.status} ${d.body}`);
  }
});

/* ======================================================================
   11–13. The configuration read, download and history endpoints carry the boundaries they claim.
   ====================================================================== */

test('the configuration read and history endpoints require a session, and CSRF for writes', async () => {
  const session = await seedSession();
  const auth = { cookie: session };

  // ---- GET /api/config/export : authenticated, read-only ----
  const anonExport = await call('GET', '/api/config/export', undefined, {});
  assert.equal(anonExport.status, 401, 'the export must require a session');
  assert.ok(!anonExport.body.includes('groups'), 'an unauthenticated export leaked configuration');
  const exportOk = await call('GET', '/api/config/export', undefined, auth);
  assert.equal(exportOk.status, 200, exportOk.body);
  assert.ok(exportOk.json.files['services.yaml'], 'the export should carry the overlay');
  for (const forbidden of ['auth.json', 'sessions.json', 'metrics.json', 'activity.jsonl', '.env']) {
    assert.ok(!JSON.stringify(exportOk.json).includes(forbidden), `an export must not mention ${forbidden}`);
  }

  // ---- GET /api/config/export/download : authenticated; same scope, as a file ----
  const anonDownload = await call('GET', '/api/config/export/download', undefined, {});
  assert.equal(anonDownload.status, 401, 'the download must require a session');
  const downloadOk = await call('GET', '/api/config/export/download', undefined, auth);
  assert.equal(downloadOk.status, 200, downloadOk.body);
  assert.match(String(downloadOk.headers['content-disposition'] || ''), /attachment; filename="opushub-native-\d{4}-\d{2}-\d{2}\.json"/);
  // A `?file=` name is looked up in the *built* bundle, never joined to a path.
  for (const wanted of ['../../data/auth.json', 'auth.json', '/etc/passwd', '..%2F.env', 'settings.json']) {
    const r = await call('GET', `/api/config/export/download?file=${encodeURIComponent(wanted)}`, undefined, auth);
    assert.equal(r.status, 404, `${wanted} must not be readable through the export: ${r.status}`);
  }

  // ---- DELETE /api/config/history/:id : unsafe method, so session + CSRF ----
  const hist = await call('GET', '/api/config/history', undefined, auth);
  const victim = hist.json.versions[0]?.id;
  assert.ok(victim, 'the fixture should have at least one version');
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'config-history', `${victim}.json`)), 'the version to delete should exist');

  const anonDelete = await call('DELETE', `/api/config/history/${victim}`, undefined, {});
  assert.equal(anonDelete.status, 401, 'deleting history must require a session');
  const crossSiteDelete = await call('DELETE', `/api/config/history/${victim}`, undefined,
    { cookie: session, origin: 'https://evil.example', extraHeaders: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSiteDelete.status, 403, 'a cross-site delete must fail CSRF');
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'config-history', `${victim}.json`)), 'a refused delete removed the version');

  // ---- POST /api/config/history/:id/restore : same, and it cannot name a non-version ----
  const anonRestore = await call('POST', `/api/config/history/${victim}/restore`, {}, {});
  assert.equal(anonRestore.status, 401, 'restore must require a session');
  const crossSiteRestore = await call('POST', `/api/config/history/${victim}/restore`, {},
    { cookie: session, origin: 'https://evil.example', extraHeaders: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSiteRestore.status, 403, 'a cross-site restore must fail CSRF');

  for (const bad of ['not-a-version', '../../../etc/passwd', '..', '']) {
    const r2 = await call('POST', `/api/config/history/${encodeURIComponent(bad)}/restore`, {}, auth);
    assert.equal(r2.status, 404, `restoring ${bad} must 404: ${r2.status}`);
  }

  // and a legitimate delete works, with the session and a same-origin request
  const ok = await call('DELETE', `/api/config/history/${victim}`, undefined, auth);
  assert.equal(ok.status, 200, ok.body);
  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'config-history', `${victim}.json`)), 'the delete did not remove the version');
});

test('every protected state path is outside the presentation scope, by name', () => {
  const names = new Set(PRESENTATION_FILES.map((f) => f.name));
  assert.ok(PROTECTED_STATE.length >= 5, 'the protected-state list should name the state an export or restore must skip');
  for (const p of PROTECTED_STATE) {
    assert.ok(!names.has(p.path), `${p.path} must not be writable configuration`);
    assert.ok(p.why && p.why.length > 20, `${p.path} must carry a reason a reader can check`);
  }
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
  const historyMoved = moved.filter((n) => n.startsWith('config-history/'));

  // Exactly what setup is allowed to write: the account, its session, the setup event, the layout
  // it was asked to apply, and a history version of the *presentation* files.
  assert.deepEqual(moved.filter((n) => !n.startsWith('config-history/')),
    ['activity.jsonl', 'auth.json', 'layout.json', 'sessions.json'],
    `first-run setup wrote ${moved.join(', ')}`);
  assert.equal(historyMoved.length, 1, `expected exactly one history version, got ${historyMoved.join(', ')}`);

  // the history version it recorded holds presentation files only
  const version = JSON.parse(report.after[historyMoved[0]]);
  const allowedNames = PRESENTATION_FILES.map((f) => f.name);
  for (const name of Object.keys(version.files)) {
    assert.ok(allowedNames.includes(name), `a setup history version holds ${name}`);
  }
  assert.ok(!JSON.stringify(version).includes('first-run-password-42'), 'the history version captured the password');
  assert.ok(!Object.keys(version.files).some((f) => f.includes('auth') || f.includes('session')), 'the history version captured authentication state');

  // and the layout it applied is the template's, not an empty document
  const layout = JSON.parse(report.after['layout.json']);
  assert.ok(layout.hub.widgets.length >= 4, 'the template was not applied to layout.json');

  fs.rmSync(cfg, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});
