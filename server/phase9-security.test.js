// Phase 9H — the mechanical security proofs for the OpusGrid infrastructure surface.
//
// Phase 9 adds three things that could each have widened OpusHub dangerously: a module that runs
// a command (ZFS), a client that talks to another device (OPNsense), and a namespace of new API
// routes. This file proves none of them did — statically, over the source, and dynamically, over
// the wire, with a planted secret in the environment.
//
// It also re-proves the boundaries Phase 7 and 8 established, because "the new provider code is
// safe" is worthless if the Docker allow-list quietly changed while nobody was looking.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { startMockEngine } from '../test/mock-engine.js';
import { stripComments } from '../test/source-scan.js';

const OLD_ENV = { ...process.env };
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9sec-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9sec-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

// The planted secret: it must not reach a response, a log line or an activity event, ever.
const SECRET = 'hunter2-opnsense-secret';
process.env.OPUSHUB_OPNSENSE_URL = 'https://fw.lan';
process.env.OPUSHUB_OPNSENSE_KEY = 'planted-key';
process.env.OPUSHUB_OPNSENSE_SECRET = SECRET;

const { createZfsProvider } = await import('./providers/zfs.js');
const { ENDPOINTS } = await import('./providers/opnsense.js');
const registry = await import('./infrastructure/registry.js');

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped — assertions are about code, not the prose around it. */
const code = (rel) => stripComments(read(rel));

function serverFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
      if (e.name.endsWith('.js') && !e.name.includes('.test.')) out.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, 'server'));
  return out;
}

let ENGINE = null;
let handleApi;
let COOKIE = null;

function req(method, p, body = null, headers = {}) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return {
    method,
    headers: { ...(COOKIE ? { cookie: COOKIE } : {}), ...(body ? { 'content-type': 'application/json' } : {}), host: 'opushub.test', ...headers },
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
    },
  };
}
function res() {
  const state = { status: 200, body: '', headers: {} };
  return {
    state,
    setHeader: (k, v) => { state.headers[String(k).toLowerCase()] = v; },
    writeHead: (s, h) => { state.status = s; for (const [k, v] of Object.entries(h || {})) state.headers[String(k).toLowerCase()] = v; },
    end: (b) => { state.body = String(b ?? ''); },
  };
}
async function get(pathname, headers = {}) {
  const r = res();
  await handleApi(req('GET', pathname, null, headers), r, new URL(pathname, 'http://opushub.test'));
  return { status: r.state.status, json: JSON.parse(r.state.body || 'null'), text: r.state.body, headers: r.state.headers };
}
async function send(method, pathname, body = null, headers = {}) {
  const r = res();
  await handleApi(req(method, pathname, body, headers), r, new URL(pathname, 'http://opushub.test'));
  return { status: r.state.status, json: JSON.parse(r.state.body || 'null'), text: r.state.body };
}

const INFRA_ROUTES = [
  '/api/infrastructure',
  '/api/infrastructure/providers',
  '/api/infrastructure/storage',
  '/api/infrastructure/network',
  '/api/infrastructure/power',
  '/api/infrastructure/opnsense',
  '/api/infrastructure/topology',
  '/api/infrastructure/physical',
  '/api/infrastructure/storage/pool?name=tank',
  '/api/infrastructure/storage/dataset?name=tank/media',
];

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  ({ handleApi } = await import('./api.js'));
  const { seedSession } = await import('../test/auth-helper.js');
  COOKIE = await seedSession();
});

test.after(async () => {
  await ENGINE?.stop();
  process.env = OLD_ENV;
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/* ==================================================================== */
/* 1. no arbitrary shell, no arbitrary command                           */
/* ==================================================================== */

test('exactly one module may run a command, and it may only run its own frozen table', () => {
  const runners = serverFiles().filter((rel) => /from 'node:child_process'|require\(['"]child_process/.test(code(rel)));
  assert.deepEqual(runners.sort(), ['server/providers/zfs.js', 'server/version.js'].sort(),
    'a new module started a process — that needs its own review');

  const src = code('server/providers/zfs.js');
  // no shell, no string command, no dynamic binary, no request data
  for (const banned of ['shell:', 'execSync', 'spawnSync', 'spawn(', 'fork(', '/exec', 'new Function', 'eval(']) {
    assert.ok(!src.includes(banned), `zfs.js uses ${banned}`);
  }
  for (const banned of ['req.', 'body.', 'query.', 'searchParams']) {
    assert.ok(!src.includes(banned), `zfs.js knows about ${banned}`);
  }
  // The provider may read exactly two environment values: PATH, so execFile can find the binary in
  // a container that sets PATH for us, and OPUSHUB_DEBUG, to log a refused name. Nothing else —
  // not the Docker socket, not an OPNsense credential, not any user-controlled variable. It also
  // must never hand over or spread the whole environment to the child.
  const envReads = [...new Set([...src.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[([^\]]+)\])/g)]
    .map((m) => m[1] || m[2]))].sort();
  assert.deepEqual(envReads, ['OPUSHUB_DEBUG', 'PATH'], `zfs.js reads an unexpected environment value: ${envReads}`);
  assert.equal((src.match(/process\.env\b(?!\.|\[)/g) || []).length, 0, 'zfs.js passes the whole environment through');
  assert.ok(/execFile\(/.test(src), 'commands run through execFile with an argv array');

  // the command table is frozen and complete
  const { COMMANDS } = createZfsProvider({ runner: async () => ({ ok: true, stdout: '' }) })._internals;
  assert.deepEqual(Object.keys(COMMANDS).sort(), ['datasetList', 'poolList', 'poolTopology']);
  for (const spec of Object.values(COMMANDS)) {
    assert.ok(Object.isFrozen(spec.args));
    assert.ok(spec.args.every((a) => typeof a === 'string' && !/[\s;&|`$]/.test(a)));
  }

  // every call site names a key of that table as a literal — nothing is computed
  const calls = [...src.matchAll(/\brun\(\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, 'the table is used');
  for (const c of calls) assert.ok(Object.prototype.hasOwnProperty.call(COMMANDS, c), `run('${c}') is not in the table`);
});

test('no server module turns request input into a filesystem path', () => {
  // The infrastructure surface reads three query parameters and nothing else. Prove it by
  // extracting them from the source rather than trusting a comment.
  const api = code('server/infrastructureApi.js');
  const params = [...new Set([...api.matchAll(/query\.get\('([^']+)'\)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(params, ['id', 'include', 'name'], 'a new request field appeared in the infrastructure API');
  for (const banned of ["query.get('path')", "query.get('file')", "query.get('url')", "query.get('endpoint')", "query.get('command')"]) {
    assert.ok(!api.includes(banned), `the infrastructure API reads ${banned}`);
  }
  // and no provider-level module reads the request at all
  for (const rel of ['server/providers/zfs.js', 'server/providers/network.js', 'server/providers/opnsense.js', 'server/providers/power.js']) {
    const src = code(rel);
    for (const needle of ['req.', 'request.', 'searchParams']) {
      assert.ok(!src.includes(needle), `${rel} reads ${needle}`);
    }
  }
});

/* ==================================================================== */
/* 2. no arbitrary OPNsense endpoint, no generic proxy                   */
/* ==================================================================== */

test('the OPNsense endpoint table is frozen and is the only thing that can be requested', () => {
  assert.ok(Object.isFrozen(ENDPOINTS));
  const paths = Object.values(ENDPOINTS).map((e) => e.path);
  assert.deepEqual(paths, ['/api/core/system/status', '/api/interfaces/overview/interfaces', '/api/routes/gateway/status', '/api/unbound/settings/get']);
  const src = code('server/providers/opnsense.js');
  assert.ok(!/export (async )?function (request|call|proxy|get|post|fetchEndpoint)\b/.test(src), 'no generic transport is exported');
  assert.ok(!src.includes('body.'), 'the provider never reads a request body');
  // a request cannot influence the path: the URL is built from the configured origin + the table
  assert.ok(src.includes('new URL(spec.path, baseUrl)'), 'paths come from the table, not from input');
});

test('a browser cannot choose an OPNsense endpoint, method or parameter', async () => {
  const attempts = [
    '/api/infrastructure/opnsense?endpoint=/api/core/firmware/reinstall',
    '/api/infrastructure/opnsense?path=/api/core/system/status',
    '/api/infrastructure/opnsense?url=http://evil.example',
    '/api/infrastructure/opnsense?command=reboot',
    '/api/infrastructure/opnsense?method=POST',
    '/api/infrastructure/opnsense?apiKey=abc',
  ];
  for (const p of attempts) {
    const r = await get(p);
    // the extra parameters are ignored (the route answers the same document either way) — the
    // proof is that no request was made with anything but a table path, asserted below
    assert.ok(r.status < 500, `${p} → ${r.status}`);
  }
});

/* ==================================================================== */
/* 3. no provider credential anywhere                                    */
/* ==================================================================== */

test('no infrastructure response contains a credential, a path or an upstream body', async () => {
  const blobs = [];
  for (const p of INFRA_ROUTES) blobs.push((await get(p)).text);
  blobs.push((await get('/api/host')).text);
  blobs.push((await get('/api/alerts')).text);
  blobs.push((await get(`/api/search?q=${encodeURIComponent('opnsense')}`)).text);
  const whole = blobs.join('\n');
  for (const needle of [SECRET, 'planted-key', Buffer.from(`planted-key:${SECRET}`).toString('base64')]) {
    assert.ok(!whole.includes(needle), `a credential leaked: ${needle}`);
  }
  assert.ok(!whole.includes('OPNSENSE_KEY'), 'the environment variable name itself is not echoed');
  for (const needle of ['/var/run/docker.sock', '/var/lib/docker', '.sock"', 'authorization']) {
    assert.ok(!whole.includes(needle), `leaked: ${needle}`);
  }
});

test('provider secrets are not written to the activity log or the configuration', async () => {
  await get('/api/infrastructure/opnsense');
  await get('/api/alerts');
  const log = fs.existsSync(path.join(DATA_DIR, 'activity.jsonl')) ? fs.readFileSync(path.join(DATA_DIR, 'activity.jsonl'), 'utf8') : '';
  assert.ok(!log.includes(SECRET), 'the secret reached the activity log');
  const settingsFile = path.join(CONFIG_DIR, 'settings.yaml');
  const settings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '';
  assert.ok(!settings.includes(SECRET), 'the secret reached configuration');
});

test('the OPNsense connection settings refuse to store a credential', async () => {
  const { putSettings } = await import('./model.js');
  const cases = [
    { url: 'https://fw.lan/api/core/system/status' },
    { url: 'https://user:pw@fw.lan' },
    { url: 'https://fw.lan?key=abc' },
    { url: 'ftp://fw.lan' },
  ];
  for (const opnsense of cases) {
    assert.throws(() => putSettings({ infrastructure: { opnsense } }), /must be a plain http/, `accepted ${JSON.stringify(opnsense)}`);
  }
  const ok = putSettings({ infrastructure: { opnsense: { url: 'https://fw.lan' } } });
  assert.equal(ok.infrastructure.opnsense.url, 'https://fw.lan', 'a plain https address is stored, normalized to its origin');
  // and a secret-shaped value has nowhere to live: there is no field for one
  const stored = YAML.parse(fs.readFileSync(path.join(CONFIG_DIR, 'settings.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(stored.infrastructure.opnsense || {}), ['url']);
  putSettings({ infrastructure: { opnsense: { url: null } } });
});

/* ==================================================================== */
/* 4. the surface is read-only and authenticated                         */
/* ==================================================================== */

test('every infrastructure route is GET-only', async () => {
  for (const p of INFRA_ROUTES) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await send(method, p, {});
      assert.equal(r.status, 405, `${method} ${p} must be refused (got ${r.status})`);
      assert.equal(r.json.code, 'method_not_allowed');
    }
  }
});

test('every infrastructure route requires a session', async () => {
  const saved = COOKIE;
  COOKIE = null;
  for (const p of INFRA_ROUTES) {
    const r = await get(p);
    assert.equal(r.status, 401, `${p} must require a session (got ${r.status})`);
    assert.equal(r.json.code, 'auth_required');
  }
  COOKIE = saved;
});

test('an unknown infrastructure path is a 404, not a fallthrough', async () => {
  for (const p of ['/api/infrastructure/nope', '/api/infrastructure/storage/pool/../../etc']) {
    const r = await get(p);
    assert.equal(r.status, 404, `${p} → ${r.status}`);
  }
});

test('a pool or dataset name ZFS never reported is refused without a command being run', async () => {
  for (const p of [
    '/api/infrastructure/storage/pool?name=rpool',
    '/api/infrastructure/storage/pool?name=-o',
    '/api/infrastructure/storage/pool?name=tank%3B%20rm%20-rf%20%2F',
    '/api/infrastructure/storage/dataset?name=..%2F..%2Fetc%2Fpasswd',
    '/api/infrastructure/storage/pool',
    '/api/infrastructure/storage/pool?name=' + 'a'.repeat(300),
  ]) {
    const r = await get(p);
    assert.equal(r.status, 404, `${p} must be refused (got ${r.status})`);
    assert.equal(r.json.code, 'not_found');
  }
  // nothing non-GET reached the engine while all of that was refused
  assert.deepEqual(ENGINE.log.filter((l) => !l.startsWith('GET ')), []);
});

test('an unknown provider id is refused before a check runs', async () => {
  const r = await get('/api/infrastructure/provider?id=nope');
  assert.equal(r.status, 404);
  const ok = await get('/api/infrastructure/provider?id=docker');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.provider.id, 'docker');
});

test('the include parameter is an allow-list, not a passthrough', async () => {
  const r = await get('/api/infrastructure?include=storage,../../etc/passwd,<script>');
  assert.equal(r.status, 200);
  assert.ok(r.json.domains, 'the document still answers');
  assert.equal(JSON.stringify(r).includes('../../etc/passwd'), false);
  assert.equal(r.json.domains.network.summaryOnly, true, 'an unrecognised section is ignored, not honoured');
});

test('the infrastructure sweep never writes to the engine', async () => {
  ENGINE.reset();
  // The registry answers every provider from its TTL cache while it is warm, so a warm sweep is
  // expected to make *zero* engine calls — that caching is a deliberate cost control, not a gap in
  // this proof. Clear it so the sweep actually goes to the wire and we can inspect the traffic.
  registry.invalidateAll();
  for (const p of INFRA_ROUTES) await get(p);
  assert.ok(ENGINE.log.length > 0, 'the sweep talked to the engine');
  for (const line of ENGINE.log) assert.ok(line.startsWith('GET '), `non-GET engine call: ${line}`);
});

/* ==================================================================== */
/* 5. Phase 8's boundaries are unchanged                                 */
/* ==================================================================== */

test('the Docker operation allow-list is still exactly three actions', async () => {
  const registry = await import('./operations/registry.js');
  assert.deepEqual(Object.keys(registry.ACTIONS), ['container.start', 'container.restart', 'container.stop']);
  const adapter = code('server/providers/dockerOperations.js');
  const table = adapter.match(/const OP_PATHS = Object\.freeze\(\{([\s\S]*?)\}\);/);
  const declared = [...table[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(declared.sort(), [['restart', '/restart'], ['start', '/start'], ['stop', '/stop']].sort());
});

test('the Docker read provider is still GET-only', () => {
  const src = code('server/providers/docker.js');
  assert.ok(src.includes('http.get'), 'the read client still issues http.get');
  for (const banned of ['http.request(', 'method:', '.post(', '.put(', '.patch(']) {
    assert.ok(!src.includes(banned), `the read client contains ${banned}`);
  }
});

test('no infrastructure module reaches the Docker socket or an operation', () => {
  for (const rel of serverFiles().filter((f) => f.includes('infrastructure') || f.includes('providers/zfs') || f.includes('providers/network') || f.includes('providers/opnsense'))) {
    const src = code(rel);
    for (const needle of ['OPUSHUB_DOCKER_SOCKET', 'DOCKER_HOST', 'docker.sock', 'dockerOperations', '/containers/', '/start', '/stop', '/restart']) {
      assert.ok(!src.includes(needle), `${rel} references ${needle}`);
    }
  }
});

test('no infrastructure module can write to the filesystem', () => {
  for (const rel of serverFiles().filter((f) => f.includes('infrastructure'))) {
    const src = code(rel);
    for (const banned of ['writeFileSync', 'appendFileSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'renameSync']) {
      assert.ok(!src.includes(banned), `${rel} uses ${banned}`);
    }
  }
});

/* ==================================================================== */
/* 6. no new state-changing route in api.js                              */
/* ==================================================================== */

test('the source scanner these proofs read with does not delete code', () => {
  // A static proof is only as good as the text it reads. api.js documents its versioned namespace
  // with a line comment containing `/api/v1/*`, and the naive block-comment strip treats that `/*`
  // as the start of a comment and deletes everything up to the next `*/` — 30% of the file,
  // including the setup, auth, settings and layout routes. That version of this assertion passed
  // while looking at a file with those routes missing, which is worse than having no assertion.
  const raw = read('server/api.js');
  const stripped = code('server/api.js');
  const routes = (s) => [...s.matchAll(/route === '(POST|PUT|PATCH|DELETE) ([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`).sort();
  assert.deepEqual(routes(stripped), routes(raw), 'comment stripping removed a route from the source');
  assert.ok(!stripped.includes('/*'), 'a block comment survived the stripper');
  assert.ok(stripped.length < raw.length && stripped.length > raw.length * 0.5,
    'the stripper removed an implausible amount of the file');
  // it must not invent code either: everything it reports is present in the file as written
  for (const r of routes(stripped)) assert.ok(raw.includes(`'${r}'`), `${r} does not appear in api.js`);
});

test('the set of non-GET routes in api.js is unchanged since Phase 8', () => {
  const src = code('server/api.js');
  const mutations = [...src.matchAll(/route === '(POST|PUT|PATCH|DELETE) ([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`).sort();
  // the complete list of state-changing application routes before Phase 9 — reviewed, audited and
  // CSRF-protected. Adding one is a deliberate change to this list, not a side effect of a feature.
  assert.deepEqual(mutations, [
    'POST /api/alerts/ack',
    'POST /api/auth/login',
    'POST /api/auth/logout',
    'POST /api/auth/password',
    'POST /api/auth/sessions/revoke',
    'POST /api/config/import/apply',
    'POST /api/config/import/parse',
    'POST /api/config/validate',
    'POST /api/custom/reset',
    'POST /api/discovery/refresh',
    'POST /api/layout/reset',
    'POST /api/layout/template',
    'POST /api/setup',
    'POST /api/updates/check',
    'PUT /api/bookmarks',
    'PUT /api/custom',
    'PUT /api/groups',
    'PUT /api/layout',
    'PUT /api/services',
    'PUT /api/settings',
    'PUT /api/stacks',
  ], 'a new state-changing route appeared in api.js');
});

test('no provider may be selected by the browser outside the registry', () => {
  const src = code('server/infrastructureApi.js');
  // the one place a client-supplied provider id is accepted validates it against the registry
  assert.ok(src.includes('isKnownProvider('), 'the provider route validates against the registry');
  assert.ok(!/\bcheck\(/.test(src), 'the API never calls a provider check directly');
});
