// Phase 8G — the mechanical security proof for the Operations Engine.
//
// Phase 7 proved the read client is GET-only. Phase 8 adds the first write path, so the proof has
// to grow: it is no longer enough to show that Docker *reads* are constrained, it has to show
// that Docker *writes* are exactly three endpoints, reachable only through named actions, only
// after authorization, only with a server-bound confirmation, and never with anything the browser
// chose.
//
// Everything here is either a static scan of the source or a request against the mock engine.
// There are no assertions about intent — only about code and bytes on the wire.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine } from '../test/mock-engine.js';
import { stripComments } from '../test/source-scan.js';

const OLD_ENV = { ...process.env };
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p8proof-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p8proof-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped — assertions are about code, not about the prose around it. */
const code = (rel) => stripComments(read(rel));

/** Every non-test .js file under server/, relative to the repo root. */
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
let confirmation = null;
let handleApi;
let COOKIE = null;
let VIEWER_COOKIE = null;

function makeReq(method, body, headers = {}) {
  const h = { ...headers };
  if (COOKIE) h.cookie = COOKIE;
  h['content-type'] = 'application/json';
  h.host = 'opushub.test';
  return {
    method, headers: h,
    [Symbol.asyncIterator]() {
      const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
      let i = 0;
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
    },
  };
}

async function call(method, pathname, body = null, headers = null, cookie = COOKIE) {
  const state = { status: 200, body: '', headers: {} };
  const res = {
    setHeader: (k, v) => { state.headers[String(k).toLowerCase()] = v; },
    writeHead: (s, h) => { state.status = s; for (const [k, v] of Object.entries(h || {})) state.headers[String(k).toLowerCase()] = v; },
    end: (b) => { state.body = String(b ?? ''); },
  };
  const saved = COOKIE;
  if (cookie !== COOKIE) COOKIE = cookie;
  await handleApi(makeReq(method, body, headers || {}), res, new URL(pathname, 'http://opushub.test'));
  COOKIE = saved;
  let json = null;
  try { json = JSON.parse(state.body || 'null'); } catch { /* non-JSON */ }
  return { status: state.status, json, text: state.body };
}

let locks = null;

test.before(async () => {
  locks = await import('./operations/locks.js');
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  ({ handleApi } = await import('./api.js'));
  confirmation = await import('./operations/confirmation.js');
  const { seedSession } = await import('../test/auth-helper.js');
  COOKIE = await seedSession();
  const auth = await import('./auth.js');
  const viewer = auth.createSession({ username: 'a-visitor', ip: '127.0.0.1' });
  VIEWER_COOKIE = `${auth.SESSION_COOKIE}=${viewer.id}`;
});

test.beforeEach(() => {
  // the rate limiter is a control with its own test in phase8-operations.test.js; these checks
  // are about the authorization, CSRF and confirmation gates, which must not be shadowed by it
  locks._resetLimits();
});

test.after(async () => {
  await ENGINE?.stop();
  process.env = OLD_ENV;
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/* ==================================================================== */
/* 1. only approved action ids exist                                     */
/* ==================================================================== */

test('the action registry is exactly three actions and nothing else', async () => {
  const registry = await import('./operations/registry.js');
  assert.deepEqual(Object.keys(registry.ACTIONS), ['container.start', 'container.restart', 'container.stop']);
  assert.deepEqual([...registry.ACTION_IDS], ['container.start', 'container.restart', 'container.stop']);
  assert.deepEqual([...registry.OPERATION_PERMISSIONS], [
    'operations.container.start', 'operations.container.restart', 'operations.container.stop',
  ]);
});

test('no other server file declares an operation action', () => {
  // A capability is a `<domain>.<verb>` pair. Event *names* (container.started, docker.unavailable)
  // are not capabilities, so only operation verbs are flagged. The registry defines the actions
  // and the engine compares against them; every other module that names one is the place a
  // capability was added without a review.
  const VERBS = new Set(['start', 'stop', 'restart', 'kill', 'remove', 'pull', 'push', 'up', 'down',
    'create', 'delete', 'prune', 'update', 'exec', 'run', 'attach', 'pause', 'unpause', 'rename',
    'commit', 'build', 'copy', 'archive', 'resize', 'deploy']);
  const DOMAINS = '(?:container|image|volume|network|compose|stack|docker|system|exec|shell)';
  const offenders = [];
  for (const rel of serverFiles()) {
    if (rel.endsWith('operations/registry.js') || rel.endsWith('operations/engine.js')) continue;
    const src = code(rel);
    for (const m of src.matchAll(new RegExp(`["'\`]${DOMAINS}\\.([a-z][a-z_-]{1,20})["'\`]`, 'g'))) {
      if (VERBS.has(m[1])) offenders.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], 'an operation is declared outside the registry');
});

/* ==================================================================== */
/* 2. only approved Docker lifecycle endpoints exist                     */
/* ==================================================================== */

test('the operations adapter reaches exactly three endpoints', () => {
  const src = code('server/providers/dockerOperations.js');
  const table = src.match(/const OP_PATHS = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(table, 'the adapter declares an endpoint table');
  const declared = [...table[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(declared.sort(), [['restart', '/restart'], ['start', '/start'], ['stop', '/stop']].sort());
  // the table is the only place a mutation endpoint is spelled
  for (const op of ['/kill', '/remove', '/prune', '/exec', '/commit', '/rename', '/update', '/pause', '/unpause', '/attach', '/resize', '/copy', '/archive', '/create']) {
    assert.ok(!src.includes(`'${op}`) && !src.includes(`"${op}`) && !src.includes('`' + op), `the adapter mentions ${op}`);
  }
  assert.ok(!/\/(images|volumes|networks|build|containers\/create)/.test(src), 'the adapter reaches beyond container lifecycle');
});

test('the operations adapter exposes no generic request helper', () => {
  const src = code('server/providers/dockerOperations.js');
  const exported = [...src.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]).sort();
  const alsoExported = [...src.matchAll(/export const (\w+)/g)].map((m) => m[1]);
  // the complete public surface of the write path: three lifecycle calls, three availability
  // helpers, and a test-only view of the endpoint table
  assert.deepEqual(exported, [
    'operationsAvailability', 'probeOperations', 'publicOperationsStatus', 'restartContainer',
    'resolveOperationsEndpoint', 'startContainer', 'stopContainer',
  ].sort());
  assert.deepEqual(alsoExported, ['_internals']);
  // the module-private transport is not reachable from outside
  assert.ok(!/export function post\b/.test(src), 'the transport must not be exported');
  assert.ok(!/export function request\b/.test(src), 'there is no generic request helper');
  assert.ok(!/export function (call|dockerCall|execute|mutate)\b/.test(src));
  // and there is exactly one HTTP method in the whole module
  const methods = [...src.matchAll(/method\s*:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(methods, ['POST'], 'only one HTTP method is ever set');
});

test('the engine dispatches through a static switch, never through input', () => {
  const src = code('server/operations/engine.js');
  const sw = src.match(/function dispatch\(action, containerId\) \{([\s\S]*?)\n\}/);
  assert.ok(sw, 'the engine has one dispatch function');
  const cases = [...sw[1].matchAll(/case '(\w+)': return dockerOps\.(\w+)\(/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(cases.sort(), [['restart', 'restartContainer'], ['start', 'startContainer'], ['stop', 'stopContainer']].sort());
  assert.ok(/default: return Promise\.resolve\(\{ ok: false, code: 'unknown_action'/.test(sw[1]), 'an unlisted adapter value is refused');
  // no dynamic dispatch anywhere in the operations path
  for (const rel of serverFiles().filter((f) => f.includes('operations'))) {
    const s = code(rel);
    assert.ok(!/dockerOps\[/.test(s), `${rel} indexes the adapter dynamically`);
    assert.ok(!/\[action(\.adapter|\.id)?\]/.test(s), `${rel} looks a method up by action`);
  }
});

/* ==================================================================== */
/* 3. no exec, no shell, no arbitrary command — anywhere                 */
/* ==================================================================== */

test('no exec endpoint, shell helper or command runner exists in the server', () => {
  const offenders = [];
  for (const rel of serverFiles()) {
    const src = code(rel);
    // `regex.exec(` is not a shell; only a process spawn or a string evaluated as code is.
    // server/version.js runs `git` once at boot to name the build. It predates Phase 8, it is
    // not reachable from a request, and it must never become one: allow-listed, and still
    // forbidden from knowing anything about Docker.
    if (/from 'node:child_process'|require\(['"]child_process/.test(src)) {
      if (rel === 'server/version.js') {
        // it detects whether OpusHub itself is containerised (/.dockerenv, cgroup) — that is a
        // read of the local filesystem, and it must never grow into a Docker client
        for (const needle of ['docker.sock', 'DOCKER_HOST', '/containers/', 'exec(', 'spawn(']) {
          assert.ok(!src.includes(needle), `version.js must not use ${needle}`);
        }
      } else if (rel === 'server/providers/zfs.js') {
        // Phase 9 — the ZFS provider is the ONE module allowed to run a command, and only the
        // frozen table inside it. These checks are stricter than the version.js exemption above,
        // and server/phase9-security.test.js adds the dynamic half: a pool or dataset name that
        // ZFS itself never reported is refused before a process is spawned.
        for (const needle of ['shell:', 'execSync', 'spawnSync', 'spawn(', 'fork(', 'exec(', '/exec', 'new Function', 'eval(']) {
          assert.ok(!src.includes(needle), `zfs.js must not use ${needle}`);
        }
        assert.ok(/execFile\(/.test(src), 'zfs.js runs commands with execFile (an argv array, never a shell)');
        assert.ok(/Object\.freeze\(/.test(src), 'the ZFS command table is frozen');
        for (const needle of ['docker.sock', 'DOCKER_HOST', '/containers/', 'req.', 'body.', 'query.']) {
          assert.ok(!src.includes(needle), `zfs.js must know nothing about ${needle}`);
        }
        continue; // the generic process-call checks below are covered by the assertions above
      } else offenders.push(`${rel}: child_process`);
    }
    if (/\b(execSync|spawnSync)\s*\(/.test(src)) offenders.push(`${rel}: synchronous process call`);
    if (/(?<![.\w])(spawn|exec|execFile|fork)\s*\(/.test(src)) offenders.push(`${rel}: process call`);
    if (/new Function\s*\(|(?<![.\w])eval\s*\(/.test(src)) offenders.push(`${rel}: code evaluation`);
    if (/\/exec/.test(src)) offenders.push(`${rel}: /exec`);
  }
  assert.deepEqual(offenders, []);
});

test('the operations modules cannot reach a shell or a filesystem write', () => {
  for (const rel of serverFiles().filter((f) => f.includes('operations') || f.includes('dockerOperations'))) {
    const src = code(rel);
    for (const banned of ['child_process', 'writeFileSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'appendFileSync']) {
      // the audit log is the one writer, and it is an append-only trail in the data directory
      if (rel.endsWith('operations/audit.js')) continue;
      assert.ok(!src.includes(banned), `${rel} must not use ${banned}`);
    }
  }
});

/* ==================================================================== */
/* 4. no arbitrary method, path or endpoint comes from the client        */
/* ==================================================================== */

test('no operation route reads an HTTP method, a Docker path or a command from the request', () => {
  const watched = ['server/operationsApi.js', 'server/api.js', 'server/operations/engine.js', 'server/operations/policy.js', 'server/operations/targets.js'];
  for (const rel of watched) {
    const src = code(rel);
    for (const field of ['body.method', 'body.path', 'body.endpoint', 'body.dockerPath', 'body.command', 'body.url', 'body.dockerUrl', 'body.socket', 'body.httpMethod', 'body.args']) {
      assert.ok(!src.includes(field), `${rel} reads ${field} from the request`);
    }
  }
});

test('the client can name an action and a target, and nothing else is interpreted', async () => {
  // a body padded with every field a generic proxy would need changes nothing about the outcome
  const r = await call('POST', '/api/v1/operations', {
    action: 'container.stop',
    target: { type: 'service', id: 'jellyfin' },
    method: 'DELETE',
    path: '/containers/jellyfin',
    endpoint: '/containers/jellyfin/exec',
    command: 'rm -rf /',
    url: 'http://evil.example/x',
    dockerPath: '/var/run/docker.sock',
    confirmed: true,
    force: true,
    permission: 'operations.container.stop',
  });
  // a body padded past what an operation request can legitimately contain is refused outright
  assert.equal(r.status, 400, 'a padded request is not negotiated with');
  assert.equal(r.json.code, 'bad_request');

  const sneaky = await call('POST', '/api/v1/operations', {
    action: 'container.stop', target: { type: 'service', id: 'jellyfin' },
    method: 'DELETE', path: '/containers/jellyfin/exec', command: 'id', confirmed: true, force: true,
  });
  assert.equal(sneaky.status, 409, 'none of the invented fields buys a confirmation');
  assert.equal(sneaky.json.operation.error.code, 'confirmation_required');
  assert.deepEqual(ENGINE.log.filter((l) => !l.startsWith('GET ')), [], 'and nothing reached the engine');
});

/** Files allowed to show the well-known socket path as operator instructions. */
const SOCKET_PATH_PROSE = new Set(['src/pages/Setup.tsx']);

test('the browser bundle contains no Docker endpoint, socket path or exec', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      // ssr-*.tsx are Node-side render harnesses for the smoke tests — they run in the server
      // process, not in a browser, so `process.env` is legitimate there
      if (/^ssr-/.test(e.name)) continue;
      if (/\.(ts|tsx)$/.test(e.name)) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.ok(files.length > 20, 'the source tree was scanned');
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // Naming an environment variable in help text is fine (Settings → Environment tells the
    // operator which one to set). Reading one, or reaching the engine, is not.
    for (const needle of ['dockerOps', 'child_process', 'node:child_process', 'OPUSHUB_OPERATIONS_SOCKET']) {
      assert.ok(!src.includes(needle), `${path.relative(ROOT, f)} mentions ${needle}`);
    }
    // The one place the well-known socket path appears in the UI is the first-run wizard telling
    // the operator what to mount. That is prose about a convention, not this host's socket —
    // and it is an allow-list of one, so a second appearance fails this check.
    if (src.includes('docker.sock')) {
      assert.ok(SOCKET_PATH_PROSE.has(path.relative(ROOT, f).split(path.sep).join('/')),
        `${path.relative(ROOT, f)} names a socket path outside the setup help text`);
    }
    // (Settings → Environment explains in prose that unset keys "fall through to process.env" —
    // that sentence is not an environment read, and `process.env.` would be.)
    assert.ok(!/process\.env\s*\./.test(src), `${path.relative(ROOT, f)} reads an environment variable`);
    // OpusHub's own /api/docker/containers/… route is fine; the engine's mutation endpoints are not
    assert.ok(!/\/containers\/[^'"\s]*\/(start|stop|restart|kill|exec|remove|prune)/.test(src),
      `${path.relative(ROOT, f)} calls a Docker mutation endpoint`);
  }
});

/* ==================================================================== */
/* 5. the read provider is still GET-only                                */
/* ==================================================================== */

test('adding a write path did not change the read client', () => {
  const src = code('server/providers/docker.js');
  assert.ok(src.includes('http.get'), 'the read client still issues http.get');
  for (const banned of ['http.request(', 'method:', '.post(', '.put(', '.patch(', '.delete(']) {
    assert.ok(!src.includes(banned), `the read client must not contain ${banned}`);
  }
  for (const op of ['/start', '/stop', '/restart', '/kill', '/exec', '/prune']) {
    assert.ok(!src.includes(`'${op}`) && !src.includes(`"${op}`) && !src.includes('`' + op), `the read client mentions ${op}`);
  }
});

test('a full read sweep plus a full operation still issues only approved engine calls', async () => {
  ENGINE.reset();
  for (const p of ['/api/services', '/api/stacks', '/api/discovery', '/api/host', '/api/networks', '/api/volumes', '/api/images', '/api/system', '/api/resources', '/api/alerts', '/api/activity?limit=10', '/api/v1/operations']) {
    const r = await call('GET', p);
    assert.ok(r.status < 500, `${p} answered ${r.status}`);
  }
  const d = await call('POST', '/api/v1/operations/dry-run', { action: 'container.start', target: { type: 'service', id: 'paperless' } });
  assert.equal(d.status, 200);
  const e = await call('POST', '/api/v1/operations', {
    action: 'container.start', target: { type: 'service', id: 'paperless' },
    confirmationToken: d.json.confirmation.token, operationId: d.json.operation.id,
  });
  assert.equal(e.status, 202);
  for (let i = 0; i < 100 && (await call('GET', `/api/v1/operations/${e.json.operation.id}`)).json.operation.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const writes = ENGINE.log.filter((l) => !l.startsWith('GET '));
  assert.deepEqual(writes.map((l) => l.replace(/\/containers\/[^/]+\//, '/containers/<id>/')), ['POST /containers/<id>/start']);
});

/* ==================================================================== */
/* 6. no browser route exposes the Docker socket                         */
/* ==================================================================== */

test('no server file that answers the browser names a socket path', () => {
  for (const rel of ['server/api.js', 'server/index.js', 'server/operationsApi.js', 'server/operations/engine.js']) {
    const src = code(rel);
    assert.ok(!/docker\.sock/.test(src), `${rel} names a socket`);
    assert.ok(!/OPUSHUB_DOCKER_SOCKET/.test(src), `${rel} resolves the socket itself`);
  }
});

test('no API response leaks a socket path, an env value or a token', async () => {
  const paths = ['/api/v1/operations', '/api/services', '/api/discovery', '/api/health'];
  const blobs = [];
  for (const p of paths) blobs.push((await call('GET', p)).text);
  const d = await call('POST', '/api/v1/operations/dry-run', { action: 'container.restart', target: { type: 'service', id: 'jellyfin' } });
  blobs.push(d.text);
  const e = await call('POST', '/api/v1/operations', {
    action: 'container.restart', target: { type: 'service', id: 'jellyfin' },
    confirmationToken: d.json.confirmation.token, operationId: d.json.operation.id,
  });
  blobs.push(e.text);
  const whole = blobs.join('\n');
  for (const needle of ['/var/run/docker.sock', ENGINE.socketPath, 'hunter2', 'SECRET_SHOULD_NEVER_LEAVE_SERVER', 'opushub_session=']) {
    assert.ok(!whole.includes(needle), `leaked: ${needle}`);
  }
  // the dry-run hands the token to the browser on purpose — that is how the dialog confirms.
  // It must not appear in any *other* response, and never on disk.
  assert.ok(!e.text.includes(d.json.confirmation.token), 'the execute response echoes the confirmation token');
  const onDisk = fs.readFileSync(path.join(DATA_DIR, 'operations.jsonl'), 'utf8');
  assert.ok(!onDisk.includes(d.json.confirmation.token), 'the confirmation token reached the audit log');
});

/* ==================================================================== */
/* 7–10. no route bypasses a gate                                        */
/* ==================================================================== */

const OPERATION_ROUTES = [
  ['GET', '/api/v1/operations'],
  ['GET', '/api/operations'],
  ['GET', '/api/v1/operations/op-20260101-aaaaaaa'],
  ['GET', '/api/v1/operations/op-20260101-aaaaaaa/trail'],
  ['POST', '/api/v1/operations/dry-run'],
  ['POST', '/api/v1/operations'],
  ['POST', '/api/v1/operations/op-20260101-aaaaaaa/cancel'],
];

const BODY = { action: 'container.restart', target: { type: 'service', id: 'jellyfin' } };

/** Wait for any background operation to finish, so an assertion is never racing one. */
async function drain() {
  for (let i = 0; i < 200; i++) {
    const doc = (await call('GET', '/api/v1/operations')).json;
    if (!doc?.counts?.running) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('every operations route requires a session', async () => {
  for (const [method, p] of OPERATION_ROUTES) {
    const r = await call(method, p, method === 'POST' ? BODY : null, null, null);
    assert.equal(r.status, 401, `${method} ${p} must require a session (got ${r.status})`);
    assert.equal(r.json.code, 'auth_required');
  }
});

test('every state-changing operations route is behind CSRF', async () => {
  const cross = { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' };
  for (const [method, p] of OPERATION_ROUTES.filter(([m]) => m === 'POST')) {
    const r = await call(method, p, BODY, cross);
    assert.equal(r.status, 403, `${method} ${p} must refuse a cross-site request (got ${r.status})`);
    assert.equal(r.json.code, 'csrf');
  }
});

test('every operations route enforces authorization', async () => {
  for (const action of ['container.start', 'container.restart', 'container.stop']) {
    const r = await call('POST', '/api/v1/operations/dry-run', { action, target: { type: 'service', id: 'jellyfin' } }, null, VIEWER_COOKIE);
    assert.equal(r.status, 403, `${action} must be refused for an account without the permission`);
    assert.equal(r.json.code, 'not_permitted');
  }
  const executed = await call('POST', '/api/v1/operations', { ...BODY, confirmationToken: 'stolen' }, null, VIEWER_COOKIE);
  assert.equal(executed.status, 403, 'execution is refused too, not just the dry-run');
});

test('no operations route executes without a server-bound confirmation', async () => {
  await drain();
  ENGINE.reset();
  const cases = [
    ['no token at all', {}],
    ['a client-asserted boolean', { confirmed: true }],
    ['a fabricated token', { confirmationToken: 'not-a-real-token' }],
    ['a token-shaped string', { confirmationToken: 'a'.repeat(43) }],
  ];
  for (const [label, extra] of cases) {
    const r = await call('POST', '/api/v1/operations', { ...BODY, ...extra });
    assert.equal(r.status, 409, `${label} must not execute`);
    assert.ok(['confirmation_required', 'confirmation_invalid'].includes(r.json.operation.error.code), label);
  }
  assert.deepEqual(ENGINE.log.filter((l) => !l.startsWith('GET ')), [], 'nothing reached the engine');
});

test('the confirmation is bound to action, target and session, and is single-use', async () => {
  await drain();
  ENGINE.reset();
  const d = await call('POST', '/api/v1/operations/dry-run', BODY);
  const token = d.json.confirmation.token;
  // Each of these spends nothing: the token does not match the action/target it was minted for,
  // so the engine refuses before the lock is even taken.
  const wrongAction = await call('POST', '/api/v1/operations', {
    action: 'container.stop', target: { type: 'service', id: 'jellyfin' }, confirmationToken: token,
  });
  assert.equal(wrongAction.json.operation.error.code, 'confirmation_mismatch', 'a restart token cannot stop');
  const wrongTarget = await call('POST', '/api/v1/operations', {
    action: 'container.restart', target: { type: 'service', id: 'radarr' }, confirmationToken: token,
  });
  assert.equal(wrongTarget.json.operation.error.code, 'confirmation_mismatch', 'a Jellyfin token cannot restart Radarr');
  assert.deepEqual(ENGINE.log.filter((l) => !l.startsWith('GET ')), [], 'nothing executed yet');
  assert.ok(confirmation.pendingCount() > 0, 'a refused attempt does not consume the confirmation');

  const first = await call('POST', '/api/v1/operations', { ...BODY, confirmationToken: token, operationId: d.json.operation.id });
  assert.equal(first.status, 202, 'the right action, target and session are accepted');
  await drain();
  // with the container free again, the only thing standing between the replay and a second
  // restart is the fact that the token was already spent
  const replay = await call('POST', '/api/v1/operations', { ...BODY, confirmationToken: token });
  assert.equal(replay.json.operation.error.code, 'confirmation_used', 'the same token cannot be spent twice');
});

test('the operations surface is inert until a person confirms something', async () => {
  await drain();
  ENGINE.reset();
  // read the whole surface, twice, including every sub-route
  for (const [method, p] of OPERATION_ROUTES.filter(([m]) => m === 'GET')) await call(method, p);
  for (const [method, p] of OPERATION_ROUTES.filter(([m]) => m === 'GET')) await call(method, p);
  await call('POST', '/api/v1/operations/dry-run', BODY);
  assert.deepEqual(ENGINE.log.filter((l) => !l.startsWith('GET ')), [],
    'reading the operations surface must never operate on anything');
});
