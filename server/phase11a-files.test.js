// Phase 11A proof — the read-only file manager.
//
// What this file proves, in the order the requirements were written:
//
//   1  the surface is read-only: routes, methods, and the *absence* of any mutation vocabulary
//   2  roots come from configuration, are bounded, are never "/", and are reported with refusals
//   3  listing, stat, tree and search answer with real metadata and honest limits
//   4  previews are bounded, server-detected, and never render active content in our origin
//   5  downloads go through a session-bound, expiring, path-bound reference — never ?path=
//   6  traversal in every spelling we could think of is refused, including through symlinks
//   7  protected locations (sockets, keys, credentials, OpusHub's own state) are refused *and*
//      omitted from listings, and an explicit attempt at one is recorded in the Activity log
//   8  a real EACCES produces permission_required + "request access", never an elevation attempt
//   9  the privilege broker's vocabulary is fixed, its grants are session/path/operation bound,
//      and it refuses a provider spec that even names a command
//  10  roots are isolated: one root's reference cannot read another root's bytes
//  11  auth and authz: no session → 401; a viewer role → 403 with the permission named
//  12  ordinary browsing writes ZERO activity rows; only security-relevant facts are recorded
//  13  nothing in this feature spawns a process, opens a shell, invokes sudo, or writes a file —
//      asserted mechanically over the source, not by inspection
//
// Fixtures live in throwaway temp directories; the real config/ and data/ directories are never
// touched, and the Docker engine is the shared mock (so the storage-context section is exercised
// against a real container document rather than a stub).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { startMockEngine } from '../test/mock-engine.js';

const OLD_ENV = { ...process.env };

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-11a-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-11a-data-'));
const ROOT_A = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-11a-a-'));
const ROOT_B = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-11a-b-'));

/** Runs as root? Then mode 000 is not a barrier, and the EACCES tests are skipped (honestly). */
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

let ENGINE = null;
let handleApi = null;
let rewriteV1 = null;
let COOKIE = null;          // administrator
let VISITOR_COOKIE = null;  // a username that is not the administrator → viewer role
let SESSION_HANDLE = null;
let seedSession = null;
let auth = null;

/**
 * Sign in again as the administrator. One test deliberately signs out (to prove a reference does
 * not outlive its session), and the tests after it need a live session of their own.
 */
async function reseed() {
  COOKIE = await seedSession();
  SESSION_HANDLE = auth.sessionHandle(COOKIE.split('=').slice(1).join('='));
  return COOKIE;
}
let LIMITS = null;
let A = null;               // root id of ROOT_A
let B = null;               // root id of ROOT_B

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const write = (rel, content, root = ROOT_A) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};

function buildFixtures() {
  // --- a stack directory, the ordinary case ---
  write('stacks/pihole/docker-compose.yml', 'services:\n  pihole:\n    image: pihole/pihole:latest\n');
  write('stacks/pihole/README.md', '# Pi-hole\n\nSome **markdown** notes.\n');
  write('stacks/pihole/.env', 'PIHOLE_PASSWORD=hunter2-secret-value\n');
  write('stacks/notes.log', 'one\ntwo\nthree\nfour\nfive\n');
  write('stacks/data.json', '{"service":"pihole","port":80}\n');
  // a .txt holding JSON: detection must follow the content, not the extension
  write('stacks/mislabeled.txt', '{"actually":"json"}\n');
  write('stacks/page.html', '<!doctype html><html><body><script>alert(1)</script></body></html>');
  write('stacks/markup.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  write('stacks/pixel.png', Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'));
  write('stacks/report.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20), Buffer.from('\n%%EOF\n')]));
  // ~360 KB of numbered lines: previews must truncate rather than buffer the file, and a head and
  // a tail of the same file have to be visibly different slices
  write('stacks/chunky.txt', Array.from({ length: 30_000 }, (_, i) => `line ${i} ${'x'.repeat(4)}`).join('\n'));
  // a sparse 40 MB file: too large to preview, cheap to create
  const big = write('stacks/big.bin', '');
  fs.truncateSync(big, 40 * 1024 * 1024);

  // --- symlinks: inside the root (fine) and out of it (never) ---
  fs.symlinkSync('pihole', path.join(ROOT_A, 'stacks', 'inner-link'));
  fs.symlinkSync('pihole/docker-compose.yml', path.join(ROOT_A, 'stacks', 'alias.yml'));
  fs.symlinkSync('/etc', path.join(ROOT_A, 'escape-etc'));
  fs.symlinkSync('/', path.join(ROOT_A, 'escape-root'));
  fs.symlinkSync(ROOT_B, path.join(ROOT_A, 'escape-other-root'));
  // a loop: `lstat` succeeds on it, `realpath` cannot — the refusal has to say which happened
  fs.symlinkSync('loop-b', path.join(ROOT_A, 'stacks', 'loop-a'));
  fs.symlinkSync('loop-a', path.join(ROOT_A, 'stacks', 'loop-b'));

  // --- protected and sensitive material ---
  write('secrets/.ssh/id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\nhunter2-secret-value\n');
  write('secrets/.ssh/authorized_keys', 'ssh-ed25519 AAAA\n');
  write('secrets/dump.sql', 'CREATE TABLE tokens (id serial);\n');
  // a second key, in a directory no other test asks about: the activity log dedupes repeated
  // attempts at one path, so the "recorded once" test needs a path of its own
  write('secrets/keys/id_ed25519', 'hunter2-secret-value\n');
  write('secrets/backup.pem', '-----BEGIN CERTIFICATE-----\nhunter2-secret-value\n');
  write('.env', 'OPUSHUB_SECRET=hunter2-secret-value\n');
  write('docker.sock', 'not really a socket, but named like one');

  // --- entry limits: more entries than one listing may return ---
  for (let i = 0; i < 2003; i += 1) write(`many/f${String(i).padStart(4, '0')}.txt`, `${i}\n`);

  // --- search limits: more matches than one search may return, and depth to stop at ---
  for (let d = 0; d < 30; d += 1) {
    for (let n = 0; n < 20; n += 1) write(`deep/d${d}/needle-${d}-${n}.txt`, 'haystack\n');
  }
  write('deep/d0/deep-deep/deeper/deepest/buried-needle.txt', 'found me\n');

  // --- a real EACCES (skipped as root: root ignores mode bits) ---
  fs.mkdirSync(path.join(ROOT_A, 'locked'), { recursive: true });
  fs.writeFileSync(path.join(ROOT_A, 'locked', 'hidden.txt'), 'nobody reads this\n');
  fs.chmodSync(path.join(ROOT_A, 'locked'), 0o000);

  write('only-in-a.txt', 'a\n');

  // --- the second root: isolation has to mean something ---
  write('only-in-b.txt', 'b\n', ROOT_B);
  write('b-dir/inner.txt', 'b inner\n', ROOT_B);
}

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

function mkReq(method, p, { body = null, cookie = COOKIE, headers = {} } = {}) {
  const chunks = body ? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))] : [];
  return {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    once() { return this; },
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
    },
  };
}

/** A response stub that can also be the target of `stream.pipe()` (the two byte routes). */
function mkRes() {
  const chunks = [];
  const headers = {};
  const r = new Writable({ write(c, enc, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.state = { status: 200, headers };
  r.setHeader = (k, v) => { headers[String(k).toLowerCase()] = v; };
  r.writeHead = (status, h) => {
    r.state.status = status;
    for (const [k, v] of Object.entries(h || {})) headers[String(k).toLowerCase()] = v;
    return r;
  };
  r.json = () => {
    const text = Buffer.concat(chunks).toString('utf8');
    try { return JSON.parse(text || '{}'); } catch { return { _raw: text.slice(0, 400) }; }
  };
  r.bytes = () => Buffer.concat(chunks);
  r.text = () => Buffer.concat(chunks).toString('utf8');
  return r;
}

/** Call the real router. Waits for a streamed body to finish before reading it. */
async function call(method, p, opts = {}) {
  const r = mkRes();
  const finished = new Promise((done) => r.on('finish', done));
  await handleApi(mkReq(method, p, opts), r, new URL(p, 'http://opushub.test'));
  await Promise.race([finished, new Promise((done) => setTimeout(done, 1500))]);
  return { status: r.state.status, headers: r.state.headers, json: r.json(), bytes: r.bytes(), text: r.text() };
}

const get = (p, opts) => call('GET', p, opts);
const post = (p, body, opts) => call('POST', p, { ...opts, body });

/** The activity log's files rows, newest first. */
async function filesEvents() {
  const r = await get('/api/activity?category=files&limit=200');
  assert.equal(r.status, 200);
  return r.json.items || [];
}

/* ------------------------------------------------------------------ */

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
  process.env.OPUSHUB_DATA_DIR = DATA_DIR;
  // Two roots, configured the way an operator configures them: a colon-separated list of host
  // paths. Nothing here is a browser setting, and nothing here is "/".
  process.env.OPUSHUB_FILES_ROOTS = `${ROOT_A}:${ROOT_B}`;
  buildFixtures();

  ({ handleApi, rewriteV1 } = await import('./api.js'));
  ({ LIMITS } = await import('./files/limits.js'));
  ({ seedSession } = await import('../test/auth-helper.js'));
  auth = await import('./auth.js');
  COOKIE = await seedSession();
  SESSION_HANDLE = auth.sessionHandle(COOKIE.split('=').slice(1).join('='));
  VISITOR_COOKIE = await seedSession({ username: 'a-visitor', password: 'visitor-password-42' });

  const surface = await get('/api/files');
  const ids = Object.fromEntries((surface.json.roots || []).map((r) => [r.path, r.id]));
  A = ids[ROOT_A];
  B = ids[ROOT_B];
});

test.after(async () => {
  await ENGINE?.stop();
  try { fs.chmodSync(path.join(ROOT_A, 'locked'), 0o755); } catch { /* already gone */ }
  process.env = OLD_ENV;
  for (const d of [CONFIG_DIR, DATA_DIR, ROOT_A, ROOT_B]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/* ==================================================================== */
/* 1. the surface is read-only                                          */
/* ==================================================================== */

test('the surface document says what it is: read-only, bounded, and without a privileged provider', async () => {
  const r = await get('/api/files');
  assert.equal(r.status, 200);
  const j = r.json;
  assert.equal(j.ok, true);
  assert.equal(j.readOnly, true, 'the surface declares itself read-only');
  assert.equal(j.provider.id, 'local');
  // the mutation vocabulary is named so the UI can say "not in this phase" instead of hiding it
  for (const m of ['delete', 'rename', 'move', 'copy', 'upload', 'mkdir', 'chmod', 'chown', 'execute', 'shell', 'terminal']) {
    assert.ok(j.notSupported.includes(m), `${m} is declared unsupported`);
  }
  assert.deepEqual(j.permissions, { read: true, search: true, download: true, readSensitive: true });
  assert.equal(j.privileged.available, false, 'no privileged provider is registered in Phase 11A');
  assert.match(j.privileged.reason, /no privileged filesystem provider/i, 'and it says so plainly');
  assert.ok(j.limits.maxDirectoryEntries > 0 && j.limits.maxPreviewBytes > 0, 'the bounds are published');
  assert.equal(j.limits.downloads, 'streamed', 'downloads are streamed, never buffered');
  assert.equal(j.routes.post.length, 1, 'exactly one POST exists');
  assert.deepEqual(j.routes.post, ['/api/files/privilege/request']);
  assert.equal(j.routes.get.length, 12);
  // no route in the vocabulary sounds like "do this to that"
  for (const route of [...j.routes.get, ...j.routes.post]) {
    assert.ok(!/exec|shell|command|run|sudo|write|delete|rename|move|copy|upload|mkdir|chmod|chown/i.test(route), `route ${route} is not an action endpoint`);
  }
});

test('every route is GET-only except the one privilege request, and refuses the rest with 405', async () => {
  const { ROUTES } = await import('./filesApi.js');
  for (const p of ROUTES.get) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await call(method, `${p}?root=${A}&path=stacks`, { body: {} });
      assert.equal(r.status, 405, `${method} ${p} → ${r.status}`);
      assert.equal(r.json.code, 'method_not_allowed');
      assert.ok(r.json.notSupported.includes('delete'), 'the refusal names what this surface does not do');
    }
  }
  const asGet = await get('/api/files/privilege/request');
  assert.equal(asGet.status, 405, 'the one POST refuses GET');
  assert.equal(asGet.json.code, 'method_not_allowed');
});

test('an unknown files endpoint is a 404 inside the surface, not a fallthrough', async () => {
  for (const p of ['/api/files/exec', '/api/files/shell', '/api/files/delete', '/api/files/nope']) {
    const r = await get(p);
    assert.equal(r.status, 404, `${p} → ${r.status}`);
    assert.equal(r.json.code, 'not_found');
    assert.ok(Array.isArray(r.json.routes), 'and the 404 lists what does exist');
  }
  // a URL-normalized path lands on a real route, which then refuses for its own reason
  const normalized = await get('/api/files/list/../stat');
  assert.equal(normalized.status, 404);
  assert.equal(normalized.json.code, 'unknown_root', 'it reached /api/files/stat, which needs a root');
  // and there is no generic "operation" endpoint that takes a verb from the body
  const r = await post('/api/files', { operation: 'delete', root: A, path: 'stacks/notes.log' });
  assert.equal(r.status, 405);
});

test('the v1 namespace aliases every files route, and only the listed ones', async () => {
  for (const rest of ['/files', '/files/roots', `/files/list?root=${A}&path=stacks`, `/files/stat?root=${A}&path=stacks/notes.log`]) {
    assert.equal(rewriteV1(`/api/v1${rest.split('?')[0]}`), `/api${rest.split('?')[0]}`, `${rest} is versioned`);
    const r = await get(`/api/v1${rest}`);
    assert.equal(r.status, 200, `GET /api/v1${rest} → ${r.status}`);
  }
  assert.equal(rewriteV1('/api/v1/files/not-a-route'), '/api/v1/files/not-a-route', 'an unlisted path is not rewritten into existence');
  const unlisted = await get('/api/v1/files/not-a-route');
  assert.equal(unlisted.status, 404, 'and it is still refused inside the files surface');
  assert.equal(unlisted.json.code, 'not_found');
  const unlistedPost = await post('/api/v1/files/privilege/execute', { root: A, path: 'locked', operation: 'list' });
  assert.equal(unlistedPost.status, 404, 'there is no v1 execute route either');
});

/* ==================================================================== */
/* 2. roots                                                             */
/* ==================================================================== */

test('roots come from configuration, are slugs, and are never the host root', async () => {
  const r = await get('/api/files/roots');
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'configured');
  assert.equal(r.json.configuredVia, 'OPUSHUB_FILES_ROOTS');
  assert.equal(r.json.roots.length, 2);
  for (const root of r.json.roots) {
    assert.match(root.id, /^[a-z0-9][a-z0-9-]{0,63}$/, `id ${root.id} is a slug`);
    assert.notEqual(root.path, '/', 'the host root is never a filesystem root');
    assert.equal(typeof root.readable, 'boolean');
    assert.equal(root.source, 'configured');
  }
  assert.deepEqual(r.json.roots.map((x) => x.path).sort(), [ROOT_A, ROOT_B].sort());
  // the root document carries no socket path and no OpusHub state directory
  const blob = JSON.stringify(r.json);
  assert.ok(!blob.includes('.sock'), 'no socket path is published');
  assert.ok(!blob.includes(CONFIG_DIR) && !blob.includes(DATA_DIR), 'no OpusHub state directory is published');
});

test('a root candidate that is the host root, missing, protected, or OpusHub’s own state is refused with a reason', async () => {
  const { rootTable } = await import('./files/roots.js');
  const missing = path.join(os.tmpdir(), 'opushub-11a-does-not-exist');
  let t = null;
  try {
    t = await rootTable({
      refresh: true,
      env: { OPUSHUB_FILES_ROOTS: ['/', '/etc', missing, CONFIG_DIR, ROOT_A, ROOT_A].join(':') },
    });
  } finally {
    await rootTable({ refresh: true, env: process.env });
  }
  const refusedByPath = Object.fromEntries((t.refused || []).map((x) => [x.path, x.code]));
  assert.equal(refusedByPath['/'], 'host_root', 'the host root is refused as such');
  assert.equal(refusedByPath['/etc'], 'protected_path', '/etc is refused as protected');
  assert.equal(refusedByPath[missing], 'missing', 'a path that is not there is refused as missing');
  assert.equal(refusedByPath[CONFIG_DIR], 'protected_path', 'OpusHub’s own state directory is refused');
  for (const r of t.refused) assert.ok(r.reason, 'every refusal carries a public-safe reason');
  // the one legitimate candidate survives, and duplicates do not create a second root
  assert.equal(t.roots.length, 1);
  assert.equal(t.roots[0].path, ROOT_A);
});

test('a root id that is not a slug is refused before anything is resolved', async () => {
  for (const bad of ['/', '..', '../..', 'a/b', 'A', '-x', '', 'nope', 'x'.repeat(80), '%2e%2e']) {
    const r = await get(`/api/files/list?root=${encodeURIComponent(bad)}&path=`);
    assert.equal(r.status, 404, `root=${bad} → ${r.status}`);
    assert.equal(r.json.code, 'unknown_root');
  }
  const noRoot = await get('/api/files/list?path=stacks');
  assert.equal(noRoot.status, 404);
  assert.equal(noRoot.json.code, 'unknown_root', 'a missing root parameter is not treated as "the host"');
});

/* ==================================================================== */
/* 3. listing, stat, tree, search                                       */
/* ==================================================================== */

test('a directory listing carries real metadata, folders first, and omits protected entries', async () => {
  const r = await get(`/api/files/list?root=${A}&path=stacks`);
  assert.equal(r.status, 200);
  const j = r.json;
  assert.equal(j.ok, true);
  assert.equal(j.kind, 'dir');
  assert.equal(j.path, 'stacks');
  const names = j.entries.map((e) => e.name);
  assert.ok(names.includes('pihole') && names.includes('notes.log'), 'both a folder and a file are listed');
  assert.equal(j.entries[0].kind, 'dir', 'folders come first, like an explorer');
  assert.equal(j.hidden, 0, 'nothing in this directory is withheld…');
  const pihole = await get(`/api/files/list?root=${A}&path=stacks/pihole`);
  assert.ok(!pihole.json.entries.some((e) => e.name === '.env'), '…but a protected entry is not listed at all');
  assert.equal(pihole.json.hidden, 1, 'and that listing says how many entries were withheld');
  const file = j.entries.find((e) => e.name === 'notes.log');
  assert.equal(file.kind, 'file');
  assert.equal(file.size, fs.statSync(path.join(ROOT_A, 'stacks/notes.log')).size, 'the size is the file’s real size');
  assert.equal(file.typeLabel, 'Log file');
  assert.match(file.modeText, /^[-dl]([r-][w-][x-]){3}$/, 'symbolic mode, ten characters');
  assert.match(file.octal, /^0[0-7]{3}$/, 'and the same bits in octal');
  assert.equal(typeof file.mtimeMs, 'number');
  assert.ok('owner' in file && 'group' in file, 'ownership is part of a listing');
  assert.equal(file.writable, undefined, 'a listing entry has no write field');
  assert.equal(j.truncated, false);
  assert.equal(j.sortScope, 'all');
  assert.deepEqual(j.limits, { maxDirectoryEntries: LIMITS.maxDirectoryEntries, maxDirectoryScan: LIMITS.maxDirectoryScan });
});

test('a listing is bounded: more entries than the cap is a truncated page, not a bigger answer', async () => {
  const r = await get(`/api/files/list?root=${A}&path=many`);
  assert.equal(r.status, 200);
  assert.equal(r.json.count, LIMITS.maxDirectoryEntries);
  assert.equal(r.json.total, 2003);
  assert.equal(r.json.truncated, true, 'and it says so');
  assert.equal(r.json.entries.length, LIMITS.maxDirectoryEntries);
  const paged = await get(`/api/files/list?root=${A}&path=many&limit=5&offset=2`);
  assert.equal(paged.json.count, 5);
  assert.equal(paged.json.offset, 2);
  assert.equal(paged.json.entries[0].name, 'f0002.txt');
  // an absurd limit is clamped, not honoured
  const huge = await get(`/api/files/list?root=${A}&path=many&limit=999999`);
  assert.ok(huge.json.count <= LIMITS.maxDirectoryEntries, 'the cap is the cap');
});

test('sorting is a fixed vocabulary and never re-orders folders below files', async () => {
  const bySize = await get(`/api/files/list?root=${A}&path=stacks&sort=size&dir=desc`);
  assert.equal(bySize.status, 200);
  assert.equal(bySize.json.sort, 'size');
  assert.equal(bySize.json.dir, 'desc');
  assert.equal(bySize.json.entries[0].kind, 'dir', 'a folder still comes first');
  const sizes = bySize.json.entries.filter((e) => e.kind === 'file').map((e) => e.size);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a), 'files are in descending size order');
  for (const sort of ['modified', 'type', 'permissions', 'owner']) {
    const r = await get(`/api/files/list?root=${A}&path=stacks&sort=${sort}`);
    assert.equal(r.json.sort, sort, `${sort} is accepted`);
  }
  const bogus = await get(`/api/files/list?root=${A}&path=stacks&sort=;rm%20-rf%20/`);
  assert.equal(bogus.json.sort, 'name', 'an unknown sort key falls back to name');
  assert.equal(bogus.status, 200);
});

test('stat answers with properties, ownership and an in-root symlink target only', async () => {
  const file = await get(`/api/files/stat?root=${A}&path=stacks/pihole/docker-compose.yml`);
  assert.equal(file.status, 200);
  const j = file.json;
  assert.equal(j.name, 'docker-compose.yml');
  assert.equal(j.kind, 'file');
  assert.equal(j.typeLabel, 'YAML document');
  assert.equal(j.size, fs.statSync(path.join(ROOT_A, 'stacks/pihole/docker-compose.yml')).size);
  assert.equal(j.ext, 'yml');
  assert.equal(j.readable, true);
  assert.equal(j.writable, false, 'nothing in this phase can report a write path');
  assert.equal(j.previewable, true);
  assert.match(j.modeText, /^-[r-][w-][x-][r-][w-][x-][r-][w-][x-]$/, 'the file’s symbolic mode');
  assert.deepEqual(j.permissions, { read: true, search: true, download: true, readSensitive: true }, 'and `permissions` in a response is always the caller’s role map, never the file’s mode');
  assert.ok(j.canonical.startsWith(ROOT_A), 'the canonical path stays inside the root');

  const dir = await get(`/api/files/stat?root=${A}&path=stacks`);
  assert.equal(dir.json.kind, 'dir');
  assert.equal(dir.json.size, null, 'a directory has no size');
  assert.match(dir.json.modeText, /^d/);

  const inner = await get(`/api/files/stat?root=${A}&path=stacks/alias.yml`);
  assert.equal(inner.json.symlink, true);
  assert.equal(inner.json.link.inside, true);
  assert.equal(inner.json.link.target, path.posix.join('stacks', 'pihole', 'docker-compose.yml'));

  const outer = await get(`/api/files/stat?root=${A}&path=escape-etc`);
  assert.equal(outer.status, 403, 'a symlink out of the root is refused');
  assert.equal(outer.json.code, 'symlink_escape');

  const missing = await get(`/api/files/stat?root=${A}&path=stacks/nope.txt`);
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'not_found');
});

test('the sidebar tree returns directories only, bounded by depth', async () => {
  const r = await get(`/api/files/tree?root=${A}&path=&depth=2`);
  assert.equal(r.status, 200);
  const names = r.json.children.map((c) => c.name);
  assert.ok(names.includes('stacks') && names.includes('deep'), 'directories are listed');
  assert.ok(!names.includes('notes.log'), 'files are not part of the tree');
  assert.ok(!names.includes('.env') && !names.includes('docker.sock'), 'protected entries are not part of the tree either');
  const stacks = r.json.children.find((c) => c.name === 'stacks');
  assert.ok(stacks.children.every((c) => c.kind === 'dir'));
  assert.ok(!stacks.children.some((c) => c.name === 'escape-etc'), 'a symlink out of the root is not a tree node');
  const deepLimit = await get(`/api/files/tree?root=${A}&path=&depth=99`);
  assert.equal(deepLimit.json.depth, LIMITS.maxTreeDepth, 'a requested depth is clamped');
  const onFile = await get(`/api/files/tree?root=${A}&path=stacks/notes.log`);
  assert.equal(onFile.status, 400);
  assert.equal(onFile.json.code, 'not_a_directory');
});

test('search is bounded by matches, nodes and depth, and never follows a directory symlink', async () => {
  const r = await get(`/api/files/search?root=${A}&path=&q=needle`);
  assert.equal(r.status, 200);
  assert.equal(r.json.count, LIMITS.maxSearchMatches, 'the match cap is the cap');
  assert.equal(r.json.truncated, true);
  assert.equal(r.json.stopped, 'matches');
  assert.equal(r.json.followedSymlinks, false);
  assert.ok(r.json.matches.every((m) => m.name.includes('needle')));
  assert.ok(r.json.matches.every((m) => !m.path.startsWith('/')), 'matches are root-relative paths');

  const small = await get(`/api/files/search?root=${A}&path=&q=needle&limit=3`);
  assert.equal(small.json.count, 3, 'a requested limit is honoured');
  assert.equal(small.json.stopped, 'matches');

  const nodes = await get(`/api/files/search?root=${A}&path=&q=needle&nodes=5`);
  assert.equal(nodes.json.stopped, 'nodes', 'the node budget stops the walk');
  assert.ok(nodes.json.visited <= 5);

  const shallow = await get(`/api/files/search?root=${A}&path=deep&q=buried&depth=0`);
  assert.equal(shallow.json.count, 0, 'depth 0 does not descend');
  const deep = await get(`/api/files/search?root=${A}&path=deep&q=buried&depth=8`);
  assert.equal(deep.json.count, 1, 'and the same query at depth 8 finds it');

  // a directory symlink is the one way a bounded walk becomes unbounded: it must not be followed
  const viaLink = await get(`/api/files/search?root=${A}&path=&q=only-in-b`);
  assert.equal(viaLink.json.count, 0, 'the walk did not cross into the other root through a symlink');

  for (const [q, code] of [['', 'bad_query'], [['a'.repeat(200)], 'bad_query'], [['a%00b'], 'bad_query']]) {
    const bad = await get(`/api/files/search?root=${A}&path=&q=${q}`);
    assert.equal(bad.status, 400, `q=${JSON.stringify(q)} → ${bad.status}`);
    assert.equal(bad.json.code, code);
  }
  const onFile = await get(`/api/files/search?root=${A}&path=stacks/notes.log&q=x`);
  assert.equal(onFile.json.code, 'not_a_directory');
});

test('storage context describes the mount and the containers, and is honest when Docker is absent', async () => {
  const r = await get(`/api/files/stat?root=${A}&path=stacks/notes.log&context=1`);
  assert.equal(r.status, 200);
  const ctx = r.json.context;
  assert.ok(ctx, 'context is attached when asked for');
  assert.equal(ctx.ok, true);
  assert.ok(ctx.mount, 'the file sits on a mount');
  assert.equal(typeof ctx.mount.fsType, 'string');
  assert.equal(typeof ctx.mount.readOnly, 'boolean');
  assert.ok('containers' in ctx && 'volume' in ctx && 'dataset' in ctx, 'every section answers');
  // the mock engine has no container that mounts our temp fixture, so this is an honest empty set
  assert.ok(Array.isArray(ctx.containers.matches ?? null) || ctx.containers.available === false);
  assert.equal(ctx.volume.available, false, 'volume attribution is reported unavailable rather than guessed');
  assert.match(ctx.volume.reason, /mount points/i);

  const alone = await get(`/api/files/context?root=${A}&path=stacks`);
  assert.equal(alone.status, 200);
  assert.equal(alone.json.ok, true);
  // context is never a way to ask about a path the policy refused
  const bad = await get(`/api/files/context?root=${A}&path=../../etc`);
  assert.equal(bad.status, 400);
});

/* ==================================================================== */
/* 4. previews                                                          */
/* ==================================================================== */

test('a text preview is bounded, and the detection follows the content rather than the name', async () => {
  const yaml = await get(`/api/files/preview?root=${A}&path=stacks/pihole/docker-compose.yml`);
  assert.equal(yaml.status, 200);
  assert.equal(yaml.json.kind, 'text');
  assert.equal(yaml.json.subtype, 'yaml');
  assert.equal(yaml.json.inline, 'text');
  assert.equal(yaml.json.text, 'services:\n  pihole:\n    image: pihole/pihole:latest\n');
  assert.equal(yaml.json.truncated, false);

  const mislabeled = await get(`/api/files/preview?root=${A}&path=stacks/mislabeled.txt`);
  assert.equal(mislabeled.json.subtype, 'json', 'a .txt holding JSON is detected as JSON');
  assert.equal(mislabeled.json.detectedBy, 'content');

  const png = await get(`/api/files/preview?root=${A}&path=stacks/pixel.png`);
  assert.equal(png.json.kind, 'image', 'magic bytes beat the extension');

  const truncated = await get(`/api/files/preview?root=${A}&path=stacks/chunky.txt`);
  assert.equal(truncated.status, 200);
  assert.equal(truncated.json.truncated, true);
  assert.ok(truncated.json.bytes <= LIMITS.maxPreviewBytes, 'the preview never carries more than the cap');
  assert.ok(truncated.json.text.length <= LIMITS.maxPreviewBytes);
  assert.match(truncated.json.note, /Showing the first/, 'and it says what was left out');

  const tail = await get(`/api/files/preview?root=${A}&path=stacks/chunky.txt&tail=1`);
  assert.equal(tail.json.tail, true);
  assert.notEqual(tail.json.text, truncated.json.text, 'the tail is a different slice of the same file');
  assert.match(truncated.json.text, /^line 0 /, 'the head starts at the beginning');
  assert.match(tail.json.text, /line 29999/, 'and the tail ends at the end');
  assert.match(tail.json.note, /Showing the last/, 'the note says which end was read');

  const dir = await get(`/api/files/preview?root=${A}&path=stacks`);
  assert.equal(dir.status, 400);
  assert.equal(dir.json.code, 'is_a_directory', 'a directory is listed, not previewed');

  const empty = await get(`/api/files/preview?root=${A}&path=stacks/big.bin`);
  assert.equal(empty.status, 413, 'a 40 MB file is not previewed');
  assert.equal(empty.json.code, 'too_large');
  assert.equal(empty.json.size, 40 * 1024 * 1024);
  assert.equal(empty.json.inline, null);
  assert.match(empty.json.error, /download it instead/i, 'and the refusal points at the honest alternative');
});

test('active content is shown as escaped text and can never be served into our origin', async () => {
  for (const p of ['stacks/page.html', 'stacks/markup.svg']) {
    const r = await get(`/api/files/preview?root=${A}&path=${p}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.activeContent, true, `${p} is flagged`);
    assert.equal(r.json.inline, 'text', 'and is only ever offered as text');
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8', 'the response is JSON, not markup');
    assert.ok(r.json.text.includes('<script>'), 'the markup is present as text…');
    assert.equal(r.json.bytesHref, null, '…and no byte reference is minted for it');
    assert.match(r.json.note, /never rendered inside OpusHub/i);
  }
  // even a valid, same-session preview reference cannot make the raw route serve HTML
  const tokens = await import('./files/tokens.js');
  const issued = tokens.issue({ sessionId: SESSION_HANDLE, rootId: A, path: 'stacks/page.html', operation: 'preview', name: 'page.html', mime: 'text/html' });
  const raw = await get(`/api/files/raw?token=${encodeURIComponent(issued.token)}`);
  assert.equal(raw.status, 415, 'the raw route re-sniffs and refuses');
  assert.equal(raw.json.code, 'unsupported_preview');
  assert.equal(raw.json.activeContent, true);
  assert.equal(raw.headers['content-type'], 'application/json; charset=utf-8', 'the refusal is JSON');
  assert.ok(!raw.text.includes('<script>alert'), 'and not one byte of the markup was served as content');
});

test('an image preview is served as bytes with sandbox headers, and a PDF as one too', async () => {
  const png = await get(`/api/files/preview?root=${A}&path=stacks/pixel.png`);
  assert.equal(png.json.inline, 'image');
  assert.ok(png.json.bytesHref, 'a byte reference is minted');
  assert.match(png.json.bytesHref, /^\/api\/files\/raw\?token=/, 'and it is a relative URL on this origin');
  const raw = await get(png.json.bytesHref);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers['content-type'], 'image/png');
  assert.equal(raw.headers['x-content-type-options'], 'nosniff');
  assert.equal(raw.headers['cross-origin-resource-policy'], 'same-origin');
  assert.match(raw.headers['content-disposition'], /^inline;/);
  assert.match(raw.headers['content-security-policy'], /sandbox/, 'an inlined image is sandboxed');
  assert.equal(raw.headers['cache-control'], 'private, no-store');
  assert.equal(raw.bytes.length, 33, 'the real bytes, streamed');

  const pdf = await get(`/api/files/preview?root=${A}&path=stacks/report.pdf`);
  assert.equal(pdf.json.inline, 'pdf');
  assert.equal(pdf.json.kind, 'pdf');
  const rawPdf = await get(pdf.json.bytesHref);
  assert.equal(rawPdf.status, 200);
  assert.equal(rawPdf.headers['content-type'], 'application/pdf');
  assert.match(rawPdf.headers['content-security-policy'], /frame-ancestors 'none'/, 'a PDF may not be framed');
});

/* ==================================================================== */
/* 5. downloads go through a reference                                  */
/* ==================================================================== */

test('a download is minted, redirected, streamed — and the path never appears in a byte URL', async () => {
  const redirect = await get(`/api/files/download?root=${A}&path=stacks/notes.log`);
  assert.equal(redirect.status, 302, 'the path form mints a reference and redirects');
  const location = redirect.headers.location;
  assert.match(location, /^\/api\/files\/download\?token=[A-Za-z0-9_-]+$/);
  assert.ok(!location.includes('notes.log'), 'the location carries no path');
  assert.ok(!location.includes(ROOT_A), 'and no host path');
  assert.equal(redirect.headers['cache-control'], 'no-store');

  const streamed = await get(location);
  assert.equal(streamed.status, 200);
  assert.equal(streamed.text, 'one\ntwo\nthree\nfour\nfive\n', 'the real bytes arrive');
  assert.match(streamed.headers['content-disposition'], /^attachment; filename="notes\.log"/);
  assert.equal(streamed.headers['content-length'], String(fs.statSync(path.join(ROOT_A, 'stacks/notes.log')).size));
  assert.equal(streamed.headers['cache-control'], 'private, no-store');
  assert.equal(streamed.headers['x-content-type-options'], 'nosniff');

  const explicit = await get(`/api/files/download-token?root=${A}&path=stacks/notes.log`);
  assert.equal(explicit.status, 200);
  assert.equal(explicit.json.operation, 'download');
  assert.ok(explicit.json.token.length >= 32);
  assert.ok(explicit.json.ttlMs <= LIMITS.downloadTokenTtlMs, 'the reference is short-lived');
  assert.equal(explicit.json.file.path, 'stacks/notes.log', 'it names a root-relative path');
  // A root's *label* is the host path the operator configured, and the roots endpoint publishes it
  // on purpose. What must never carry a host path is the file reference or the URL built from it.
  assert.ok(!JSON.stringify(explicit.json.file).includes(ROOT_A), 'the file itself is named relatively');
  assert.ok(!explicit.json.href.includes(ROOT_A) && !explicit.json.href.includes('stacks'), 'and so is its URL');

  // a byte route addressed by reference ignores anything else a browser adds to the query
  for (const extra of [`&path=${encodeURIComponent('../../etc/passwd')}`, `&root=${B}`, '&path=secrets/dump.sql']) {
    const tampered = await get(`${explicit.json.href}${extra}`);
    assert.equal(tampered.status, 200, `reference + ${extra} still answers`);
    assert.equal(tampered.text, 'one\ntwo\nthree\nfour\nfive\n', 'and still serves the referenced file only');
  }
});

test('a reference is bound to its session, its operation and its lifetime', async () => {
  const tokens = await import('./files/tokens.js');
  const good = await get(`/api/files/download-token?root=${A}&path=stacks/notes.log`);
  const href = good.json.href;

  const bogus = await get('/api/files/download?token=not-a-real-token');
  assert.equal(bogus.status, 403);
  assert.equal(bogus.json.code, 'token_invalid');

  const otherSession = tokens.issue({ sessionId: 'another-session-handle', rootId: A, path: 'stacks/notes.log', operation: 'download', name: 'notes.log' });
  const stolen = await get(`/api/files/download?token=${encodeURIComponent(otherSession.token)}`);
  assert.equal(stolen.status, 403, 'a reference from another session is refused');
  assert.equal(stolen.json.code, 'token_session');

  const asPreview = await get(`/api/files/raw?token=${encodeURIComponent(good.json.token)}`);
  assert.equal(asPreview.status, 403, 'a download reference cannot be spent on the inline route');
  assert.equal(asPreview.json.code, 'token_mismatch');

  const expired = tokens.issue({ sessionId: SESSION_HANDLE, rootId: A, path: 'stacks/notes.log', operation: 'download', name: 'notes.log', ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 10));
  const late = await get(`/api/files/download?token=${encodeURIComponent(expired.token)}`);
  assert.equal(late.status, 403);
  assert.equal(late.json.code, 'token_expired');
  assert.match(late.json.error, /expired/i);
  assert.equal(late.json.retry, 'request a fresh link', 'and the UI is told what to do about it');

  // a reference cannot exist without a session: minting refuses, so "session-bound" is a property
  // of the module and not merely of the routes that call it
  const sessionless = tokens.issue({ rootId: A, path: 'stacks/notes.log', operation: 'download', name: 'notes.log' });
  assert.equal(sessionless.ok, false, 'a reference with no session is not minted');
  assert.equal(sessionless.code, 'bad_request');
  assert.equal(sessionless.token, undefined, 'and no token string comes back with the refusal');
  assert.equal(tokens.verify({ token: 'x'.repeat(43), sessionId: null, operation: 'download' }).code, 'token_invalid');

  // a reference is stored as a hash: the module never holds the string it issued
  assert.equal(tokens._internals.hash(good.json.token).length, 43, 'a base64url sha256 digest');
  assert.notEqual(tokens._internals.hash(good.json.token), good.json.token, 'the reference is not stored in the clear');
  assert.deepEqual(Object.keys(tokens._internals.TTL_BY_OPERATION).sort(), ['download', 'preview'], 'two operations can be authorized by a reference');
  assert.equal(tokens._internals.TTL_BY_OPERATION.download, LIMITS.downloadTokenTtlMs);
  assert.equal(tokens._internals.TTL_BY_OPERATION.preview, LIMITS.previewTokenTtlMs);

  // signing out retires every reference the session held
  const before = await get(href);
  assert.equal(before.status, 200);
  const out = await post('/api/auth/logout', {});
  assert.equal(out.status, 200);
  // the session gate fires before any token check, so a signed-out session gets a plain 401:
  // it cannot spend a reference, and it cannot find out whether one was ever valid
  assert.equal((await get(href)).status, 401);
  assert.equal((await get('/api/files')).status, 401, 'and the session itself is gone');

  // the reference is *retired*, not merely unreachable: a fresh session cannot spend it either
  await reseed();
  const after = await get(href);
  assert.equal(after.status, 403, 'a reference does not outlive the session that asked for it');
  assert.equal(after.json.code, 'token_invalid');
});

test('a download of a directory, a missing file or a protected file is refused', async () => {
  const dir = await get(`/api/files/download?root=${A}&path=stacks`);
  assert.equal(dir.status, 400);
  assert.equal(dir.json.code, 'is_a_directory');
  const missing = await get(`/api/files/download?root=${A}&path=stacks/nope`);
  assert.equal(missing.status, 404);
  const protectedFile = await get(`/api/files/download?root=${A}&path=secrets/.ssh/id_rsa`);
  assert.equal(protectedFile.status, 403);
  assert.equal(protectedFile.json.code, 'protected_path');
  const raw = await get('/api/files/raw');
  assert.equal(raw.status, 400, 'the inline route needs a reference');
  assert.equal(raw.json.code, 'token_invalid');
});

/* ==================================================================== */
/* 6. traversal, in every spelling                                      */
/* ==================================================================== */

test('traversal is refused: plain, encoded, doubled, backslash, null byte, absolute, dot segments', async () => {
  // The rule names are files/policy.js's own: a refusal says *which* rule caught it, so a future
  // loosening shows up here as a changed rule rather than as a quietly accepted path.
  const cases = [
    ['../../etc/passwd', 'traversal'],
    ['stacks/../../etc/passwd', 'traversal'],
    ['..%2f..%2fetc%2fpasswd', 'encoded'],
    ['%2e%2e%2f%2e%2e%2fetc', 'encoded'],
    ['%252e%252e%252fetc', 'encoded'],
    ['..\\..\\windows\\system32', 'separator'],
    ['stacks\\..\\..\\etc', 'separator'],
    ['stacks/./../etc', 'dot_segment'],   // the first offending segment names the rule
    ['stacks/../etc', 'traversal'],
    ['.', 'dot_segment'],
    ['./stacks', 'dot_segment'],
    ['stacks/.', 'dot_segment'],
    ['stacks//pihole', 'empty_segment'],
    ['/etc/passwd', 'absolute'],
    ['//etc/passwd', 'absolute'],
    ['C:\\Windows\\win.ini', 'separator'],
    ['~root/.ssh', 'home'],
    ['stacks/notes.log\u0000.png', 'null_byte'],
    ['stacks/n%00otes.log', 'encoded'],
    ['stacks\n/notes.log', 'control_character'],
    ['a/'.repeat(70) + 'x', 'too_deep'],
    ['stacks/' + 'n'.repeat(300), 'name_too_long'],
    ['stacks/' + 'x'.repeat(5000), 'too_long'],
  ];
  for (const [p, rule] of cases) {
    for (const route of ['list', 'stat', 'preview', 'search', 'download-token', 'permission-status']) {
      const url = route === 'search'
        ? `/api/files/${route}?root=${A}&path=${encodeURIComponent(p)}&q=x`
        : `/api/files/${route}?root=${A}&path=${encodeURIComponent(p)}`;
      const r = await get(url);
      assert.equal(r.status, 400, `${route} ${JSON.stringify(p)} → ${r.status} (${r.json.code})`);
      assert.equal(r.json.code, 'bad_path', `${route} ${JSON.stringify(p)} → ${r.json.code}`);
      assert.equal(r.json.rule, rule, `${route} ${JSON.stringify(p)} → rule ${r.json.rule}`);
    }
  }
});

test('a symlink that leaves the root is refused, and one that stays inside is resolved', async () => {
  for (const p of ['escape-etc', 'escape-etc/passwd', 'escape-root', 'escape-root/etc/passwd', 'escape-other-root', 'escape-other-root/only-in-b.txt']) {
    const r = await get(`/api/files/stat?root=${A}&path=${p}`);
    assert.equal(r.status, 403, `${p} → ${r.status}`);
    assert.ok(['symlink_escape', 'root_isolation'].includes(r.json.code), `${p} → ${r.json.code}`);
    const listed = await get(`/api/files/list?root=${A}&path=${p}`);
    assert.equal(listed.status, 403, `listing ${p} is refused too`);
  }
  // a link inside the root is fine, and its canonical path proves where it landed
  const inner = await get(`/api/files/list?root=${A}&path=stacks/inner-link`);
  assert.equal(inner.status, 200);
  assert.ok(inner.json.canonical.startsWith(`${ROOT_A}/`), 'the canonical path is inside the root');
  assert.equal(inner.json.symlink, true, 'and the listing admits it came through a link');
  const alias = await get(`/api/files/preview?root=${A}&path=stacks/alias.yml`);
  assert.equal(alias.status, 200);
  assert.equal(alias.json.subtype, 'yaml');

  // A loop is refused as a loop — never as "nothing is at that path", and never by following it.
  for (const p of ['stacks/loop-a', 'stacks/loop-b', 'stacks/loop-a/deeper']) {
    const r = await get(`/api/files/stat?root=${A}&path=${encodeURIComponent(p)}`);
    assert.equal(r.status, 403, `${p} → ${r.status} ${r.json.code}`);
    assert.equal(r.json.code, 'symlink_escape', `${p} → ${r.json.code}`);
    assert.match(r.json.error, /loop|outside its filesystem root/i, `${p} → ${r.json.error}`);
  }
  // a ".." through a loop is caught by the shape rule first: no ".." segment is ever normalized,
  // in-root or not, so the cheaper and stricter answer arrives before the filesystem is touched
  const dotted = await get(`/api/files/stat?root=${A}&path=${encodeURIComponent('stacks/loop-a/../notes.log')}`);
  assert.equal(dotted.status, 400);
  assert.equal(dotted.json.code, 'bad_path');
  assert.equal(dotted.json.rule, 'traversal');
  const loopList = await get(`/api/files/list?root=${A}&path=stacks/loop-a`);
  assert.equal(loopList.status, 403, 'a loop cannot be listed either');
  assert.equal(loopList.json.code, 'symlink_escape');
  // and it is still an entry in its parent's listing: a symlink is reported as the symlink it is
  const parent = await get(`/api/files/list?root=${A}&path=stacks`);
  const loopEntry = parent.json.entries.find((e) => e.name === 'loop-a');
  assert.ok(loopEntry, 'the loop is visible as an entry (it is the operator’s own broken link)');
  assert.equal(loopEntry.kind, 'symlink');
  assert.equal(loopEntry.link.inside, true, 'its target is inside the root, so it is named');
});

/* ==================================================================== */
/* 7. protected paths and secrets                                       */
/* ==================================================================== */

test('protected locations are refused on every route and omitted from every listing', async () => {
  const protectedPaths = [
    'secrets/.ssh', 'secrets/.ssh/id_rsa', 'secrets/.ssh/authorized_keys', '.env', 'docker.sock',
    'stacks/pihole/.env',
  ];
  for (const p of protectedPaths) {
    const stat = await get(`/api/files/stat?root=${A}&path=${encodeURIComponent(p)}`);
    assert.equal(stat.status, 403, `stat ${p} → ${stat.status}`);
    assert.equal(stat.json.code, 'protected_path', `stat ${p} → ${stat.json.code}`);
    assert.ok(stat.json.class, 'and it names the class of material, not the material');
    const preview = await get(`/api/files/preview?root=${A}&path=${encodeURIComponent(p)}`);
    assert.equal(preview.status, 403);
    const download = await get(`/api/files/download?root=${A}&path=${encodeURIComponent(p)}`);
    assert.equal(download.status, 403);
  }
  // listings omit them and count what they omitted
  const root = await get(`/api/files/list?root=${A}&path=`);
  const names = root.json.entries.map((e) => e.name);
  assert.ok(!names.includes('.env'), '.env is not listed');
  assert.ok(!names.includes('docker.sock'), 'a socket is not listed');
  assert.ok(root.json.hidden >= 2, `and the listing reports ${root.json.hidden} withheld entries`);
  const secrets = await get(`/api/files/list?root=${A}&path=secrets`);
  const secretNames = secrets.json.entries.map((e) => e.name);
  assert.ok(!secretNames.includes('.ssh'), 'the .ssh directory itself is not listed');
  assert.ok(secretNames.includes('dump.sql'), 'a sensitive-but-allowed file is listed');
  const sql = secrets.json.entries.find((e) => e.name === 'dump.sql');
  assert.equal(sql.sensitive, true, 'and it is marked sensitive');
  // the tree agrees with the listing
  const tree = await get(`/api/files/tree?root=${A}&path=`);
  assert.ok(!tree.json.children.some((c) => c.name === 'secrets' && c.children.some((x) => x.name === '.ssh')));
});

test('no response ever carries a secret value, a socket path or OpusHub’s own state directory', async () => {
  const urls = [
    '/api/files', '/api/files/roots',
    `/api/files/list?root=${A}&path=`, `/api/files/list?root=${A}&path=secrets`,
    `/api/files/stat?root=${A}&path=secrets/dump.sql&context=1`,
    `/api/files/preview?root=${A}&path=stacks/data.json`,
    `/api/files/tree?root=${A}&path=`, `/api/files/search?root=${A}&path=&q=sql`,
    `/api/files/permission-status?root=${A}&path=secrets/.ssh`,
    `/api/files/context?root=${A}&path=stacks`,
  ];
  for (const u of urls) {
    const r = await get(u);
    const blob = r.text;
    assert.ok(!blob.includes('hunter2-secret-value'), `${u} leaked a secret value`);
    assert.ok(!blob.includes(ENGINE.socketPath), `${u} leaked the Docker socket path`);
    assert.ok(!blob.includes('docker.sock'), `${u} named a socket`);
    assert.ok(!blob.includes(CONFIG_DIR), `${u} leaked the config directory`);
    assert.ok(!blob.includes(DATA_DIR), `${u} leaked the data directory`);
    assert.ok(!blob.includes('BEGIN OPENSSH PRIVATE KEY'), `${u} leaked key material`);
  }
});

test('the Docker socket and kernel interfaces are refused even when a root is aimed at them', async () => {
  const { rootTable } = await import('./files/roots.js');
  let t = null;
  try {
    t = await rootTable({ refresh: true, env: { OPUSHUB_FILES_ROOTS: [ENGINE.socketPath, '/proc', '/sys', '/dev', '/run', ROOT_A].join(':') } });
  } finally {
    // whatever the assertions below do, the table the rest of the file relies on is restored
    await rootTable({ refresh: true, env: process.env });
  }
  const byPath = Object.fromEntries((t.refused || []).map((x) => [x.path, x]));
  for (const p of ['/proc', '/sys', '/dev', '/run']) {
    assert.ok(byPath[p], `${p} was refused as a root`);
    assert.equal(byPath[p].code, 'protected_path', `${p} → ${byPath[p].code}`);
  }
  assert.ok(byPath[ENGINE.socketPath], 'the Docker socket itself is refused as a root');
  assert.equal(byPath[ENGINE.socketPath].code, 'protected_path');
  assert.equal(t.roots.length, 1, 'only the legitimate candidate became a root');
  assert.equal(t.roots[0].path, ROOT_A);
  // and the policy refuses a socket by name wherever it appears
  const { classifyPath, CLASS } = await import('./files/policy.js');
  const { opushubDirs } = await import('./files/roots.js');
  const dirs = opushubDirs();
  assert.ok(dirs.includes(CONFIG_DIR) && dirs.includes(DATA_DIR), 'the policy is told where OpusHub keeps its own state');
  assert.equal(classifyPath('/var/run/docker.sock').level, CLASS.PROTECTED);
  assert.equal(classifyPath('/run/containerd/containerd.sock').level, CLASS.PROTECTED);
  assert.equal(classifyPath('/proc/self/environ').level, CLASS.PROTECTED);
  assert.equal(classifyPath(`${CONFIG_DIR}/settings.yaml`, { opushubDirs: dirs }).level, CLASS.PROTECTED, 'OpusHub’s own state is protected wherever it lives');
  assert.equal(classifyPath(`${DATA_DIR}/activity.jsonl`, { opushubDirs: dirs }).level, CLASS.PROTECTED);
  assert.equal(classifyPath(`${CONFIG_DIR}/settings.yaml`).level, CLASS.ALLOWED, 'and only because the policy was told — the classification is not guesswork');
  assert.equal((await get(`/api/files/list?root=${A}&path=`)).status, 200, 'the restored table still serves the real root');
});

test('a denied mount inside a root is refused, unlisted, and never enumerated by tree or search', async () => {
  // The precondition is narrow, and operator-made: a mount the policy denies — a bind of a
  // protected tree, a pseudo filesystem, a socket — sitting *inside* an exposed root. Its
  // mountpoint looks innocent by name (`mounts/etcview`), so only the mount table says otherwise.
  // That table is host state, so this test injects one through the same seam resolve() reads.
  const { __setMountReader, __resetMountReader, getDeniedMounts } = await import('./files/policy.js');
  const { rootTable } = await import('./files/roots.js');
  const real = fs.realpathSync(ROOT_A);
  const line = (rel, fsRoot, fsType, source) =>
    `40 25 0:41 ${fsRoot} ${real}/${rel} rw,relatime shared:12 - ${fsType} ${source} rw`;

  // names chosen so the *lexical* classification allows every one of them: if these are skipped,
  // it is the mount rule doing it, not the protected-name lists
  write('mounts/etcview/motd-copy.txt', 'a bind of a protected tree, mounted where a name looks fine\n');
  write('mounts/procview/uptime-copy.txt', 'a pseudo filesystem inside an exposed volume\n');
  write('mounts/normal/ok.txt', 'an ordinary file the walk must still find\n');
  fs.writeFileSync(path.join(ROOT_A, 'mounts', 'agent.sock'), '');

  const mountinfo = [
    line('mounts/etcview', '/etc', 'ext4', '/dev/nvme0n1p2'),   // fsRoot is protected → denied
    line('mounts/procview', '/', 'proc', 'proc'),                // pseudo filesystem → denied
    line('mounts/agent.sock', '/', 'tmpfs', 'tmpfs'),            // a socket → denied
  ].join('\n');

  try {
    __setMountReader(async () => mountinfo);
    const denied = await getDeniedMounts();
    assert.equal(denied.length, 3, 'the injected table yields exactly three denied mounts');
    assert.deepEqual(denied.map((d) => d.class).sort(), ['container_runtime', 'protected_mount', 'protected_mount']);

    // naming one is refused — 403 mount_escape, never a 404 that would act as an existence oracle
    for (const rel of ['mounts/etcview', 'mounts/procview', 'mounts/etcview/motd-copy.txt']) {
      const r = await get(`/api/files/list?root=${A}&path=${encodeURIComponent(rel)}`);
      assert.equal(r.status, 403, `${rel} → ${r.status}`);
      assert.equal(r.json.code, 'mount_escape', `${rel} → ${r.json.code}`);
    }
    const preview = await get(`/api/files/preview?root=${A}&path=mounts/etcview/motd-copy.txt`);
    assert.equal(preview.status, 403);
    assert.equal(preview.json.code, 'mount_escape');
    const token = await get(`/api/files/download-token?root=${A}&path=mounts/etcview/motd-copy.txt`);
    assert.equal(token.status, 403, 'no reference is minted for a path inside a denied mount');
    assert.equal(token.json.code, 'mount_escape');

    // the parent listing hides them, and says how many it hid rather than leaving a mystery
    const parent = await get(`/api/files/list?root=${A}&path=mounts`);
    assert.equal(parent.status, 200);
    assert.deepEqual(parent.json.entries.map((e) => e.name), ['normal'], 'only the ordinary sibling is listed');
    assert.equal(parent.json.hidden, 3, 'the three denied mounts are counted as hidden');

    // the tree neither shows nor descends into them
    const tree = await get(`/api/files/tree?root=${A}&path=&depth=3`);
    assert.equal(tree.status, 200);
    const flat = JSON.stringify(tree.json);
    for (const name of ['etcview', 'procview', 'agent.sock', 'motd-copy', 'uptime-copy']) {
      assert.ok(!flat.includes(name), `the tree does not name ${name}`);
    }
    assert.ok(flat.includes('"normal"'), 'and the tree still walks the rest of the root');

    // a search never matches, names or descends into what the policy refuses to read
    const inside = await get(`/api/files/search?root=${A}&path=&q=copy`);
    assert.equal(inside.status, 200);
    assert.equal(inside.json.count, 0, 'nothing inside a denied mount is matched');
    const mountName = await get(`/api/files/search?root=${A}&path=&q=etcview`);
    assert.equal(mountName.json.count, 0, 'the mountpoint itself is not named by a search either');
    const control = await get(`/api/files/search?root=${A}&path=&q=ok.txt`);
    assert.equal(control.json.count, 1, 'the walk still searches the rest of the root');
    assert.equal(control.json.matches[0].path, 'mounts/normal/ok.txt');

    // "Request Access" is not offered for a location the policy denies outright
    const ask = await post('/api/files/privilege/request', { root: A, path: 'mounts/etcview', operation: 'list' });
    assert.equal(ask.json.state, 'denied');
    assert.equal(ask.json.grantable, false);
    assert.equal(ask.json.code, 'mount_escape');

    // nor can such a mount be exposed as a root of its own
    const t = await rootTable({ refresh: true, env: { OPUSHUB_FILES_ROOTS: `${ROOT_A}/mounts/etcview:${ROOT_A}` } });
    const byPath = Object.fromEntries((t.refused || []).map((x) => [x.path, x]));
    assert.ok(byPath[`${ROOT_A}/mounts/etcview`], 'a denied mount is refused as a root');
    assert.equal(byPath[`${ROOT_A}/mounts/etcview`].code, 'mount_escape');
    assert.equal(byPath[`${ROOT_A}/mounts/etcview`].class, 'protected_mount');
    assert.equal(t.roots.length, 1, 'the legitimate candidate is unaffected');
    assert.equal(t.roots[0].path, real);
  } finally {
    __resetMountReader();
    await rootTable({ refresh: true, env: process.env });
  }

  // with the real table back, the fixture is an ordinary directory again — the injection was the
  // only thing refusing it, which is what makes the assertions above about the mount rule
  const after = await get(`/api/files/list?root=${A}&path=mounts/etcview`);
  assert.equal(after.status, 200);
  const siblings = await get(`/api/files/list?root=${A}&path=mounts`);
  // `agent.sock` stays hidden — but now because of its *name*, which is the other rule at work
  assert.deepEqual(siblings.json.entries.map((e) => e.name).sort(), ['etcview', 'normal', 'procview']);
  assert.equal(siblings.json.hidden, 1);
});

/* ==================================================================== */
/* 8 + 9. permission_required and the privilege broker                  */
/* ==================================================================== */

test('a real EACCES becomes a structured permission_required, never an elevation attempt', { skip: IS_ROOT && 'running as root: mode 000 is not a barrier' }, async () => {
  const listed = await get(`/api/files/list?root=${A}&path=locked`);
  assert.equal(listed.status, 403);
  assert.equal(listed.json.code, 'permission_required');
  assert.equal(listed.json.operation, 'list');
  assert.equal(listed.json.requestAccess, true, 'the UI is told an access request is possible');
  assert.match(listed.json.error, /does not currently have permission/i);
  assert.ok(!/EACCES|EPERM|errno/.test(listed.json.error), 'no raw errno reaches the browser');
  assert.equal(listed.json.privileged.available, false, 'and it is told why: no privileged provider');

  const status = await get(`/api/files/permission-status?root=${A}&path=locked`);
  assert.equal(status.status, 200);
  assert.equal(status.json.state, 'permission_required');
  assert.equal(status.json.requestable, true);
  assert.equal(status.json.code, 'permission_required');

  const protectedStatus = await get(`/api/files/permission-status?root=${A}&path=secrets/.ssh`);
  assert.equal(protectedStatus.json.state, 'protected');
  assert.equal(protectedStatus.json.requestable, false, 'a protected path is never offered "Request Access"');

  // asking produces the honest 501: nothing was elevated, and the request is recorded
  const ask = await post('/api/files/privilege/request', { root: A, path: 'locked', operation: 'list', reason: 'reading logs' });
  assert.equal(ask.status, 501);
  assert.equal(ask.json.code, 'no_privileged_provider');
  assert.equal(ask.json.state, 'unavailable');
  assert.equal(ask.json.requested, true, 'the request itself was recorded');
  assert.match(ask.json.error, /no privileged filesystem provider/i);
  assert.equal(ask.json.privileged.available, false);

  const events = await filesEvents();
  const types = events.map((e) => e.type);
  assert.ok(types.includes('files.privilege.requested'), 'the request is in the Activity log');
  assert.ok(types.includes('files.privilege.unavailable'), 'and so is the fact that nothing could grant it');
  const requested = events.find((e) => e.type === 'files.privilege.requested');
  assert.equal(requested.category, 'files');
  assert.equal(requested.meta.operation, 'list');
  assert.equal(requested.meta.reason, 'reading logs');
  assert.ok(!JSON.stringify(requested).includes(SESSION_HANDLE), 'no session handle in an event');
});

test('the broker refuses a request that is not a path plus a fixed read operation', async () => {
  const bad = [
    [{ root: A, path: 'locked', operation: 'delete' }, 400, 'bad_operation'],
    [{ root: A, path: 'locked', operation: 'exec' }, 400, 'bad_operation'],
    [{ root: A, path: 'locked', operation: 'shell' }, 400, 'bad_operation'],
    [{ root: A, path: 'locked', operation: 'write' }, 400, 'bad_operation'],
    [{ root: A, path: 'locked', operation: 'download' }, 400, 'bad_operation'],
    [{ root: A, path: 'locked' }, 400, 'bad_operation'],
    [{ root: 'nope', path: 'x', operation: 'list' }, 404, 'unknown_root'],
    [{ root: A, path: '../../etc/shadow', operation: 'read' }, 400, 'bad_path'],
    [{ root: A, path: 'secrets/.ssh', operation: 'list' }, 403, 'protected_path'],
  ];
  for (const [body, status, code] of bad) {
    const r = await post('/api/files/privilege/request', body);
    assert.equal(r.status, status, `${JSON.stringify(body)} → ${r.status}`);
    assert.equal(r.json.code, code, `${JSON.stringify(body)} → ${r.json.code}`);
  }
  // a command smuggled into the body has no field to land in: it is ignored, and never echoed back
  const smuggled = await post('/api/files/privilege/request', { root: A, path: IS_ROOT ? 'stacks' : 'locked', operation: 'list', command: '/bin/sh', args: ['-c', 'id'] });
  assert.ok([200, 501].includes(smuggled.status), `the request is answered on its own terms (${smuggled.status})`);
  assert.ok(['granted', 'not_needed', 'unavailable'].includes(smuggled.json.state), `state ${smuggled.json.state}`);
  assert.ok(!smuggled.text.includes('/bin/sh'), 'and the command is not echoed');
  assert.ok(!smuggled.text.includes('args'), 'nor is there a field that could have carried arguments');

  // a protected path is never grantable, and the response says so explicitly
  const protectedAsk = await post('/api/files/privilege/request', { root: A, path: 'secrets/.ssh/id_rsa', operation: 'read' });
  assert.equal(protectedAsk.json.state, 'denied');
  assert.equal(protectedAsk.json.grantable, false, 'and the UI is told no grant could ever cover it');
  assert.equal(protectedAsk.json.requestAccess, false, 'so "Request Access" is not offered again');
  // extra fields in the body change nothing: there is nowhere to put a command
  const noisy = await post('/api/files/privilege/request', { root: A, path: 'stacks', operation: 'list', args: ['-la'], shell: true, sudo: true, user: 'root', env: { A: '1' } });
  assert.equal(noisy.status, 200, 'a readable path needs no privilege');
  assert.equal(noisy.json.state, 'not_needed');
});

test('the broker refuses to register a provider that carries a command, and grants narrowly when it does not', async () => {
  const broker = await import('./files/broker.js');
  assert.deepEqual([...broker.OPERATIONS], ['list', 'stat', 'read'], 'the vocabulary is three read operations');

  for (const spec of [
    { id: 'sh', command: '/bin/sh', execute: async () => ({ ok: true }) },
    { id: 'sh', args: ['-c', 'id'], execute: async () => ({ ok: true }) },
    { id: 'sh', shell: true, execute: async () => ({ ok: true }) },
    { id: 'sh', sudo: true, execute: async () => ({ ok: true }) },
    { id: 'sh', runAsUser: 'root', execute: async () => ({ ok: true }) },
    { id: 'sh', env: { PATH: '/' }, execute: async () => ({ ok: true }) },
    { id: 'sh', exec: async () => ({ ok: true }) },
    { id: 'sh', operations: ['delete'], execute: async () => ({ ok: true }) },
  ]) {
    const r = broker.registerPrivilegedProvider(spec);
    assert.equal(r.ok, false, `${JSON.stringify(Object.keys(spec))} must be refused`);
    assert.equal(r.code, 'bad_provider');
  }
  assert.equal(broker.privilegedStatus().available, false, 'a refused spec registers nothing');

  // a well-formed provider registers, and a grant is bound to session + path + operation
  const seen = [];
  const registered = broker.registerPrivilegedProvider({
    id: 'test-double',
    label: 'Test double',
    operations: ['list', 'stat', 'read'],
    canGrant: async () => ({ ok: true, granted: true, ttlMs: 60_000 }),
    execute: async (req) => { seen.push(req); return { ok: true, entries: ['pretend'] }; },
  });
  assert.equal(registered.ok, true);
  assert.equal(broker.privilegedStatus().available, true);

  const ask = await post('/api/files/privilege/request', { root: A, path: IS_ROOT ? 'stacks' : 'locked', operation: 'list' });
  if (IS_ROOT) {
    assert.equal(ask.json.state, 'not_needed', 'as root there is no barrier to grant');
  } else {
    assert.equal(ask.status, 200);
    assert.equal(ask.json.state, 'granted');
    assert.ok(ask.json.ttlMs <= LIMITS.grantTtlMs, 'a grant is capped at the broker’s TTL');
    assert.equal(ask.json.provider.id, 'test-double');
    // a grant is not a bearer token: nothing id-shaped is handed to the browser, only the expiry
    assert.ok(!/"grant[^"]*"\s*:\s*"[A-Za-z0-9_-]{8,}"/.test(JSON.stringify(ask.json)), 'no grant id is handed to the browser');
    assert.deepEqual(Object.keys(ask.json).sort(), ['expiresAt', 'ok', 'operation', 'path', 'privileged', 'provider', 'reason', 'root', 'state', 'ttlMs']);
    const events = await filesEvents();
    assert.ok(events.some((e) => e.type === 'files.privilege.granted'), 'a grant is recorded');
  }

  // execute() is server-side only: there is no route for it
  assert.equal((await post('/api/files/privilege/execute', { root: A, path: 'locked', operation: 'list' })).status, 404);
  assert.equal((await get('/api/files/privilege/execute')).status, 404);
  const executed = await broker.execute({ rootId: A, path: IS_ROOT ? 'stacks' : 'locked', operation: 'list', sessionId: SESSION_HANDLE });
  if (!IS_ROOT) {
    assert.equal(executed.ok, true);
    assert.equal(executed.privileged, true);
    // the provider saw a canonical path, a relative path, an operation and a session — nothing else
    assert.deepEqual(Object.keys(seen[0]).sort(), ['canonical', 'operation', 'path', 'rootId', 'sessionId', 'signal']);
    assert.ok(seen[0].canonical.startsWith(`${ROOT_A}/`));
  }
  for (const attempt of [
    { rootId: A, path: 'locked', operation: 'list', sessionId: 'someone-else' },
    { rootId: A, path: 'locked', operation: 'read', sessionId: SESSION_HANDLE },
    { rootId: A, path: 'stacks/notes.log', operation: 'list', sessionId: SESSION_HANDLE },
    { rootId: A, path: '../../etc/passwd', operation: 'read', sessionId: SESSION_HANDLE },
    { rootId: B, path: 'only-in-b.txt', operation: 'read', sessionId: SESSION_HANDLE },
    { rootId: A, path: 'locked', operation: 'delete', sessionId: SESSION_HANDLE },
  ]) {
    const r = await broker.execute(attempt);
    assert.equal(r.ok, false, `${JSON.stringify(attempt)} must be refused`);
    assert.ok(['grant_required', 'bad_path', 'bad_operation', 'permission_required', 'not_permitted'].includes(r.code), `→ ${r.code}`);
  }

  // a session that is retired holds no grants
  assert.ok(broker.retireSession(SESSION_HANDLE) >= 0);
  const afterRetire = await broker.execute({ rootId: A, path: 'locked', operation: 'list', sessionId: SESSION_HANDLE });
  if (!IS_ROOT) assert.equal(afterRetire.code, 'grant_required');
  broker.registerPrivilegedProvider(null);
  assert.equal(broker.privilegedStatus().available, false, 'unregistering leaves the honest state');
  assert.equal((await post('/api/files/privilege/request', { root: A, path: 'locked', operation: 'list' })).status, 501);
});

/* ==================================================================== */
/* 10 + 11. isolation, auth, authz                                      */
/* ==================================================================== */

test('roots are isolated: one root cannot be used to reach another’s files', async () => {
  const inB = await get(`/api/files/list?root=${B}&path=`);
  assert.equal(inB.status, 200);
  assert.ok(inB.json.entries.some((e) => e.name === 'only-in-b.txt'));

  const crossPath = await get(`/api/files/stat?root=${A}&path=only-in-b.txt`);
  assert.equal(crossPath.status, 404, 'A does not contain B’s file');
  assert.equal(crossPath.json.code, 'not_found');

  const crossWalk = await get(`/api/files/list?root=${A}&path=${encodeURIComponent(`../${path.basename(ROOT_B)}`)}`);
  assert.equal(crossWalk.status, 400, 'walking from one root to another is traversal');
  assert.equal(crossWalk.json.code, 'bad_path');

  const viaLink = await get(`/api/files/list?root=${A}&path=escape-other-root`);
  assert.equal(viaLink.status, 403, 'a symlink into another root is refused');

  // a reference minted for one root cannot be re-aimed at another by editing the query
  const tokenA = await get(`/api/files/download-token?root=${A}&path=only-in-a.txt`);
  const swapped = await get(`${tokenA.json.href}&root=${B}&path=only-in-b.txt`);
  assert.equal(swapped.status, 200);
  assert.equal(swapped.text, 'a\n', 'it still serves root A’s file — the reference is the authority');

  // and a search inside one root never reports the other’s paths
  const search = await get(`/api/files/search?root=${A}&path=&q=only-in`);
  assert.deepEqual(search.json.matches.map((m) => m.path), ['only-in-a.txt']);
});

test('every files route requires a session', async () => {
  const { ROUTES } = await import('./filesApi.js');
  for (const p of [...ROUTES.get, ...ROUTES.post]) {
    const url = p === '/api/files/privilege/request' ? p : `${p}?root=${A}&path=stacks`;
    const r = await call(p === '/api/files/privilege/request' ? 'POST' : 'GET', url, { cookie: null, body: p === '/api/files/privilege/request' ? { root: A, path: 'stacks', operation: 'list' } : null });
    assert.equal(r.status, 401, `${p} → ${r.status}`);
    assert.equal(r.json.code, 'auth_required');
  }
  // a byte route is behind the same door: a valid reference without a session is worth nothing
  const issued = await get(`/api/files/download-token?root=${A}&path=stacks/notes.log`);
  const anon = await get(issued.json.href, { cookie: null });
  assert.equal(anon.status, 401);
});

test('a role without files permissions is refused with the permission named', async () => {
  const surface = await get('/api/files', { cookie: VISITOR_COOKIE });
  assert.equal(surface.status, 403, 'a viewer role cannot use the file manager at all');
  assert.equal(surface.json.code, 'not_permitted');
  assert.equal(surface.json.permission, 'files.read');
  assert.match(surface.json.error, /role permission, not a filesystem permission/i);

  for (const p of ['roots', 'list', 'tree', 'stat', 'context', 'preview', 'permission-status', 'download-token', 'search']) {
    const r = await get(`/api/files/${p}?root=${A}&path=stacks&q=x`, { cookie: VISITOR_COOKIE });
    assert.equal(r.status, 403, `${p} → ${r.status}`);
    assert.equal(r.json.code, 'not_permitted');
  }
  const ask = await post('/api/files/privilege/request', { root: A, path: 'locked', operation: 'list' }, { cookie: VISITOR_COOKIE });
  assert.equal(ask.status, 403, 'asking for privilege is also a permission');

  // the permission vocabulary itself is explicit and read-only
  const { PERMISSIONS, permissionsForRole } = await import('./operations/permissions.js');
  assert.equal(PERMISSIONS.FILES_READ, 'files.read');
  assert.equal(PERMISSIONS.FILES_SEARCH, 'files.search');
  assert.equal(PERMISSIONS.FILES_DOWNLOAD, 'files.download');
  assert.equal(PERMISSIONS.FILES_READ_SENSITIVE, 'files.read_sensitive');
  for (const p of ['files.read', 'files.search', 'files.download', 'files.read_sensitive']) {
    assert.ok(permissionsForRole('administrator').includes(p), `the administrator holds ${p}`);
    assert.ok(!permissionsForRole('viewer').includes(p), `a viewer holds no ${p}`);
  }
  assert.ok(!Object.values(PERMISSIONS).some((p) => /write|delete|modify|execute|shell|sudo/i.test(p)), 'no permission in the vocabulary can mutate a file');
});

test('a sensitive file needs files.read_sensitive, and reading one is recorded', async () => {
  const { ROLES } = await import('./operations/permissions.js');
  // the administrator holds it, so the read succeeds — and is written to the Activity log
  const before = (await filesEvents()).filter((e) => e.type === 'files.download.sensitive').length;
  const preview = await get(`/api/files/preview?root=${A}&path=secrets/dump.sql`);
  assert.equal(preview.status, 200, 'a sensitive file is readable by a role that may read sensitive files');
  assert.equal(preview.json.sensitive, true, 'and the response says it is sensitive');
  const download = await get(`/api/files/download?root=${A}&path=secrets/dump.sql`);
  assert.equal(download.status, 302);
  const after = await filesEvents();
  assert.ok(after.filter((e) => e.type === 'files.preview.sensitive').length >= 1, 'the sensitive preview was recorded');
  assert.ok(after.filter((e) => e.type === 'files.download.sensitive').length > before, 'and so was the sensitive download');
  for (const e of after.filter((x) => String(x.type).startsWith('files.'))) {
    assert.equal(e.category, 'files');
    assert.ok(!JSON.stringify(e.meta || {}).includes('hunter2-secret-value'), 'no file content in an event');
  }
  // a role without it is refused by name (the operator role is the one that lacks it)
  assert.ok(!ROLES.operator.permissions.includes('files.read_sensitive'), 'an operator may browse but not read sensitive files');
  assert.ok(ROLES.operator.permissions.includes('files.read'), 'an operator may browse');
});

/* ==================================================================== */
/* 12. activity discipline                                              */
/* ==================================================================== */

test('ordinary browsing records nothing: a listing is not an event', async () => {
  // a fresh log, so the count is about these calls only
  const { DATA_DIR: dd } = await import('./configStore.js');
  const logFile = path.join(dd, 'activity.jsonl');
  const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('"files."') || l.includes('"category":"files"')).length : 0;

  const browsing = [
    '/api/files',
    '/api/files/roots',
    `/api/files/list?root=${A}&path=stacks`,
    `/api/files/list?root=${A}&path=stacks/pihole`,
    `/api/files/tree?root=${A}&path=`,
    `/api/files/stat?root=${A}&path=stacks/notes.log&context=1`,
    `/api/files/preview?root=${A}&path=stacks/pihole/README.md`,
    `/api/files/search?root=${A}&path=&q=compose`,
    `/api/files/permission-status?root=${A}&path=stacks`,
    `/api/files/download-token?root=${A}&path=stacks/notes.log`,
  ];
  let calls = 0;
  for (let i = 0; i < 3; i += 1) {
    for (const u of browsing) {
      const r = await get(u);
      assert.equal(r.status, 200, `${u} answered — otherwise "no events" would prove nothing`);
      calls += 1;
    }
  }
  assert.equal(calls, 30);
  const after = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('"files."') || l.includes('"category":"files"')).length : 0;
  assert.equal(after - before, 0, `${calls} read-only requests wrote zero files events`);
});

test('a protected-path attempt is recorded once, with the attempt and not the material', async () => {
  const before = (await filesEvents()).filter((e) => e.type === 'files.protected_path').length;
  // one path, four attempts — including through a different route
  for (let i = 0; i < 3; i += 1) await get(`/api/files/stat?root=${A}&path=secrets/keys/id_ed25519`);
  await get(`/api/files/list?root=${A}&path=secrets/keys`);
  const rows = (await filesEvents()).filter((e) => e.type === 'files.protected_path');
  assert.equal(rows.length, before + 1, 'the attempt was recorded exactly once — repeated attempts are deduped, not spammed');
  const row = rows.find((e) => String(e.subject || '').endsWith('secrets/keys/id_ed25519')) || rows[0];
  assert.equal(row.severity, 'warning');
  assert.equal(row.category, 'files');
  assert.equal(row.meta.class, 'private_key', 'the class of material is recorded');
  assert.ok(!JSON.stringify(row).includes('hunter2-secret-value'), 'the material itself is not');
  // the event model forbids payload *keys* like session/token/secret (a substring match on the key
  // name); a path that happens to live under a directory called "secrets" is a value, not a key
  const forbiddenKey = /password|passwd|pwd|secret|token|cookie|session|authorization|auth|credential|apikey|api_key|privatekey|env|environment|dockersocket|socketpath/i;
  for (const k of Object.keys(row.meta || {})) {
    assert.ok(!forbiddenKey.test(k), `the payload key ${JSON.stringify(k)} is not one the event model forbids`);
  }
  assert.ok(!forbiddenKey.test(row.type), 'and neither is the event type');
});

/* ==================================================================== */
/* 13. no process, no shell, no write — proved over the source           */
/* ==================================================================== */

const FILES_SOURCES = [
  'server/filesApi.js',
  'server/files/limits.js', 'server/files/policy.js', 'server/files/roots.js',
  'server/files/identity.js', 'server/files/preview.js', 'server/files/tokens.js',
  'server/files/provider.js', 'server/files/context.js', 'server/files/broker.js',
];

/**
 * Source, with comments and string literals blanked out. The scans below are about *code*: this
 * feature names `sudo`, `chmod` and `shell` in prose and in deny lists (that is what a deny list
 * is), and a scanner that could not tell the difference would either fail on the deny list or be
 * too vague to be worth running.
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const READ = (rel) => fs.readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8');

test('no file in this feature spawns a process, opens a shell, invokes sudo or evaluates code', () => {
  // Execution primitives, matched as code. The bare words "shell" and "sudo" do appear in this
  // feature — as a file-type label ("Shell script") and as entries in the broker's deny list — so
  // what is banned is the call, the interpreter path and the command string.
  const BANNED = [
    /child_process/, /\bspawn(Sync)?\s*\(/, /\bexec(File|Sync)?\s*\(/, /\bfork\s*\(/,
    /\beval\s*\(/, /new\s+Function\s*\(/, /process\.binding/, /vm\.runIn/, /node-pty/,
    /\bsudo\s*\(/, /\bsudo\b(?!['"])/, /\/bin\/(sh|bash|dash|zsh)\b/, /\bchmod\s*\(/,
    /\bchown\s*\(/, /require\s*\(/, /['"`](sh|bash|zsh|dash|cmd|powershell)['"`]/, /\s-c\s/,
  ];
  for (const rel of FILES_SOURCES) {
    const code = codeOnly(READ(rel));
    assert.ok(/export/.test(code), `${rel}: the comment/string stripper left real code to scan`);
    for (const re of BANNED) assert.ok(!re.test(code), `${rel} must not contain ${re}`);
  }
  // The words do appear — in the broker's deny list, which is the reason they can never be used.
  const broker = READ('server/files/broker.js');
  assert.match(broker, /'sudo'/, 'the broker refuses a provider spec that names sudo');
  assert.match(broker, /'shell'/, '…or a shell');
  assert.match(broker, /'command'/, '…or a command');
  assert.match(broker, /'args'/, '…or arguments');
});

test('no file in this feature can modify the filesystem', () => {
  // Call-shaped on purpose: `mkdir` and `rename` appear in this feature as *names of things it
  // does not do* (filesApi.js's NOT_SUPPORTED list). What must not exist is the call.
  const WRITES = [
    /\.writeFile\s*\(/, /\.appendFile\s*\(/, /createWriteStream\s*\(/, /\.unlink(Sync)?\s*\(/,
    /\.rm(Sync)?\s*\(/, /\.rmdir\s*\(/, /\.mkdir(Sync)?\s*\(/, /\.rename(Sync)?\s*\(/,
    /\.copyFile\s*\(/, /\.chmod(Sync)?\s*\(/, /\.chown(Sync)?\s*\(/, /\.lchown\s*\(/,
    /\.utimes(Sync)?\s*\(/, /\.truncate(Sync)?\s*\(/, /\.ftruncate\s*\(/, /\.symlink(Sync)?\s*\(/,
    /\.link(Sync)?\s*\(/, /\.mkdtemp(Sync)?\s*\(/, /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/,
  ];
  for (const rel of FILES_SOURCES) {
    const src = READ(rel);
    const code = codeOnly(src);
    for (const re of WRITES) assert.ok(!re.test(code), `${rel} must not contain ${re}`);
    // every open() in the feature is a read (checked on the real source: the flag is a literal)
    const comments = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    const opens = [...comments.matchAll(/\.open\(([^;]*?)\)/g)];
    for (const m of opens) assert.match(m[1], /'r'|"r"/, `${rel} opens a file with a non-read flag: ${m[1]}`);
    // and every createReadStream is opened read-only by definition; nothing else streams
    assert.ok(!/createWriteStream|pipeline\s*\(.*Writable/.test(code), `${rel} writes a stream`);
  }
});

test('the feature imports no Docker transport of its own and reaches the engine only through providers', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../server/files/context.js'), 'utf8');
  assert.ok(src.includes("from '../providers/docker.js'"), 'storage context uses the existing Docker provider');
  assert.ok(!/http|fetch|net\.|Socket|createConnection/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), 'and opens no socket of its own');
  const roots = fs.readFileSync(path.join(import.meta.dirname, '../server/files/roots.js'), 'utf8');
  assert.ok(roots.includes("from '../infrastructure/registry.js'"), 'root discovery goes through the Phase 9 registry');
});

test('the API surface is the frozen route list, and nothing else answers under /api/files', async () => {
  const { ROUTES } = await import('./filesApi.js');
  assert.deepEqual([...ROUTES.get].sort(), [
    '/api/files', '/api/files/context', '/api/files/download', '/api/files/download-token',
    '/api/files/list', '/api/files/permission-status', '/api/files/preview', '/api/files/raw',
    '/api/files/roots', '/api/files/search', '/api/files/stat', '/api/files/tree',
  ]);
  assert.deepEqual([...ROUTES.post], ['/api/files/privilege/request']);
  // a body on a GET is ignored, not interpreted: there is no field anywhere that could carry an
  // operation, so smuggling one into a listing request changes nothing at all
  const plain = await get(`/api/files/list?root=${A}&path=stacks`);
  const withBody = await call('GET', `/api/files/list?root=${A}&path=stacks`, { body: { operation: 'delete', path: '/etc/passwd', cmd: 'rm -rf /' } });
  assert.equal(withBody.status, 200, 'it is still the same GET');
  assert.deepEqual(withBody.json.entries.map((e) => e.name), plain.json.entries.map((e) => e.name), 'and the same listing');
  assert.ok(!withBody.text.includes('delete'), 'the smuggled operation is not echoed');
});
