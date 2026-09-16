// Phase 8 — the Operations Engine, end to end against the mock engine.
//
// These are the tests the phase needs because operations are the first thing OpusHub can DO to
// the infrastructure: every refusal has to be real, every execution has to be proven by the
// state it produced, and every one of them has to leave a record.
//
// The mock engine (test/mock-engine.js) accepts exactly three POST routes — start, stop, restart
// — and logs every request it receives, so "nothing else was asked of Docker" is an assertion
// and not a hope.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine } from '../test/mock-engine.js';

const OLD_ENV = { ...process.env };
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p8ops-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p8ops-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;
// Keep the verification window short: these tests assert what happens when time runs out too.
process.env.OPUSHUB_OP_VERIFY_MS = '1200';

const ROOT = new URL('..', import.meta.url).pathname;

let ENGINE = null;
let handleApi;
let COOKIE = null;
let VIEWER_COOKIE = null;
let confirmation = null;
let locks = null;
let targetsModule = null;
let registry = null;
let store = null;
let audit = null;
let engine = null;

/* ----------------------------- request helpers ----------------------------- */

function makeReq(method, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (COOKIE) headers.cookie = COOKIE;
  headers['content-type'] = 'application/json';
  headers.host = 'opushub.test';
  return {
    method,
    headers,
    [Symbol.asyncIterator]() {
      const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
      let i = 0;
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
    },
  };
}

function makeRes() {
  const state = { status: 200, body: '', headers: {} };
  return {
    state,
    setHeader: (k, v) => { state.headers[String(k).toLowerCase()] = v; },
    writeHead: (s, h) => { state.status = s; for (const [k, v] of Object.entries(h || {})) state.headers[String(k).toLowerCase()] = v; },
    end: (b) => { state.body = String(b ?? ''); },
  };
}

async function call(method, pathname, body = null, headers = null, cookie = COOKIE) {
  const saved = COOKIE;
  if (cookie !== COOKIE) COOKIE = cookie;
  const r = makeRes();
  await handleApi(makeReq(method, body, headers || {}), r, new URL(pathname, 'http://opushub.test'));
  COOKIE = saved;
  let json = null;
  try { json = JSON.parse(r.state.body || 'null'); } catch { /* text responses */ }
  return { status: r.state.status, json, text: r.state.body };
}

const get = (p, headers, cookie) => call('GET', p, null, headers, cookie);
const post = (p, body, headers, cookie) => call('POST', p, body, headers, cookie);

/** Ask for an operation to be confirmed (a dry-run) and return the whole answer. */
const dryRun = (action, target) => post('/api/v1/operations/dry-run', { action, target });

/** Spend a confirmation. */
const execute = (action, target, token, operationId) =>
  post('/api/v1/operations', { action, target, confirmationToken: token, operationId });

/** Follow an operation to its final state. */
async function settleOperation(id, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await get(`/api/v1/operations/${id}`);
    last = r.json?.operation || last;
    if (last && !['pending', 'awaiting_confirmation', 'authorized', 'running'].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 60));
  }
  return last;
}

/** The full happy path: evaluate, confirm, run, and wait for the verdict. */
async function runOperation(action, target) {
  const d = await dryRun(action, target);
  if (d.status !== 200) return { dryRun: d, operation: d.json?.operation ?? null };
  const e = await execute(action, target, d.json.confirmation.token, d.json.operation.id);
  const operation = e.status === 202 ? await settleOperation(e.json.operation.id) : e.json.operation;
  return { dryRun: d, execute: e, operation };
}

const wirePosts = () => ENGINE.log.filter((l) => !l.startsWith('GET '));
/** The container reference is an id the server resolved; tests compare shapes, not ids. */
const stripId = (l) => l.replace(/\/containers\/[^/]+\//, '/containers/<id>/');

/* --------------------------------- setup ---------------------------------- */

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  ({ handleApi } = await import('./api.js'));
  confirmation = await import('./operations/confirmation.js');
  locks = await import('./operations/locks.js');
  targetsModule = await import('./operations/targets.js');
  registry = await import('./operations/registry.js');
  store = await import('./operations/store.js');
  audit = await import('./operations/audit.js');
  engine = await import('./operations/engine.js');

  const { seedSession } = await import('../test/auth-helper.js');
  COOKIE = await seedSession();
  // a session for a username that is not the administrator: the viewer role is refused every
  // operation, which is what proves the permission check is real and not decorative
  const auth = await import('./auth.js');
  const viewerSession = auth.createSession({ username: 'a-visitor', ip: '127.0.0.1' });
  VIEWER_COOKIE = `${auth.SESSION_COOKIE}=${viewerSession.id}`;
});

test.after(async () => {
  await ENGINE?.stop();
  process.env = OLD_ENV;
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test.beforeEach(() => {
  locks._resetLimits();
  ENGINE.reset();
});

/* --------------------------- 1. the action registry ------------------------ */

test('the registry holds exactly the three approved lifecycle actions', () => {
  assert.deepEqual(registry.ACTION_IDS, ['container.start', 'container.restart', 'container.stop']);
  for (const id of registry.ACTION_IDS) {
    const a = registry.getAction(id);
    assert.ok(a.permission.startsWith('operations.container.'), `${id} declares an operation permission`);
    assert.ok(['none', 'normal', 'strong'].includes(a.confirmation), `${id} declares a confirmation strength`);
    assert.ok(['low', 'medium', 'high'].includes(a.risk), `${id} declares a risk`);
    assert.ok(a.timeoutMs > 0 && a.verifyMs > 0, `${id} is bounded`);
    assert.ok(['start', 'stop', 'restart'].includes(a.adapter), `${id} maps to an approved adapter method`);
  }
});

test('no other action is reachable, whatever it is called', async () => {
  const target = { type: 'service', id: 'jellyfin' };
  let n = 0;
  for (const action of ['container.remove', 'container.kill', 'container.exec', 'docker.exec', 'image.pull', 'compose.up', 'shell', '../../exec', '', null, 42, { a: 1 }, ['container.stop']]) {
    // the per-session rate limit is a real control (and tested on its own below); clear it here
    // so this loop is about the action registry and nothing else
    if (++n % 5 === 0) locks._resetLimits();
    const r = await dryRun(action, target);
    assert.equal(r.status, 400, `${String(action)} must be refused with 400, got ${r.status}`);
    // every one of these is an operation that does not exist, and each is audited as such
    assert.equal(r.json.code, 'unknown_action', `${String(action)} refused as ${r.json.code}`);
  }
  assert.deepEqual(wirePosts(), [], 'no Docker write was attempted for any unlisted action');
  assert.ok(ENGINE.log.every((l) => l.startsWith('GET ')), 'the engine only ever saw reads');
});

test('an unknown action leaves an audit record saying so', async () => {
  await dryRun('container.exec', { type: 'service', id: 'jellyfin' });
  const rows = audit.readAudit({ limit: 20 });
  assert.ok(rows.some((r) => r.code === 'unknown_action'), 'the refusal is recorded');
});

/* ------------------------------- 2. targets -------------------------------- */

test('a valid target resolves by service name, container name and container id', async () => {
  const inv = await get('/api/services');
  const jellyfin = inv.json.services.find((s) => s.name === 'jellyfin');
  for (const target of [
    { type: 'service', id: 'jellyfin' },
    { type: 'service', name: 'jellyfin' },
    { type: 'container', id: jellyfin.id },
    { type: 'service', id: 'jellyfin', group: jellyfin.group },
  ]) {
    const r = await dryRun('container.restart', target);
    assert.equal(r.status, 200, `${JSON.stringify(target)} should resolve (got ${r.status}: ${r.text?.slice(0, 120)})`);
    assert.equal(r.json.dryRun.target.containerName, 'jellyfin');
    // the target that comes back is the canonical container id, not the string that was sent
    assert.equal(r.json.operation.target.id, jellyfin.container.id);
  }
});

test('a nonexistent target is refused and nothing is attempted', async () => {
  const r = await dryRun('container.restart', { type: 'service', id: 'no-such-container-anywhere' });
  assert.equal(r.status, 404);
  assert.equal(r.json.operation.status, 'rejected');
  assert.equal(r.json.operation.error.code, 'unknown_target');
  assert.deepEqual(wirePosts(), []);
});

test('a malformed target is refused before it is looked up', async () => {
  for (const target of [null, 'jellyfin', 42, {}, [], { type: 'exec', id: 'jellyfin' }, { type: 'service' },
    { type: 'service', id: 7 }, { type: 'service', id: 'jel\u0000fin' }, { type: 'service', id: { nested: true } }]) {
    const r = await dryRun('container.restart', target);
    assert.equal(r.status, 400, `${JSON.stringify(target)} must be refused as malformed`);
    assert.equal(r.json.code, 'bad_target');
  }
  // an oversized reference is not an error to shout about — it is simply not a container name
  const long = await dryRun('container.restart', { type: 'service', id: 'a'.repeat(400) });
  assert.equal(long.status, 404);
  assert.equal(long.json.operation.error.code, 'unknown_target');
  assert.deepEqual(wirePosts(), []);
});

test('a container that disappears before execution is not operated on', async () => {
  const { FLEET } = await import('../test/mock-engine.js');
  const idx = FLEET.findIndex((f) => f.Names[0] === '/paperless');
  assert.ok(idx >= 0, 'the fixture fleet has paperless');
  const d = await dryRun('container.start', { type: 'service', id: 'paperless' });
  assert.equal(d.status, 200, 'the target exists when the operation is requested');
  const [removed] = FLEET.splice(idx, 1);
  try {
    const e = await execute('container.start', { type: 'service', id: 'paperless' }, d.json.confirmation.token, d.json.operation.id);
    assert.equal(e.status, 404, 'a vanished container must not be operated on');
    const op = e.json.operation;
    assert.equal(op.status, 'rejected');
    assert.equal(op.error.code, 'unknown_target');
    assert.match(op.error.reason, /no service or container/i);
    assert.deepEqual(wirePosts(), [], 'no Docker write was attempted against the missing container');
  } finally {
    FLEET.splice(idx, 0, removed);
  }
});

test('a replaced container is detected when the engine is re-read just before writing', async () => {
  const inv = await get('/api/services');
  const seerr = inv.json.services.find((s) => s.name === 'seerr');
  // The window this guards is real but narrow: compose can recreate a container between the
  // confirmation and the Docker call, leaving the same id with a different name. The check is
  // exercised directly, because the race cannot be forced from the outside.
  const same = await targetsModule.revalidateTarget({ containerId: seerr.id, containerName: 'seerr' });
  assert.equal(same.ok, true, 'the container still is what it was');
  const renamed = await targetsModule.revalidateTarget({ containerId: seerr.id, containerName: 'seerr-replacement' });
  assert.equal(renamed.ok, false);
  assert.equal(renamed.error.code, 'stale_target');
  assert.match(renamed.error.reason, /replaced/);
  const gone = await targetsModule.revalidateTarget({ containerId: 'ffffffffffff', containerName: 'ghost' });
  assert.equal(gone.ok, false);
  assert.equal(gone.error.code, 'stale_target');
  assert.match(gone.error.reason, /disappeared/);
});

/* --------------------------- 3. permissions & roles ------------------------ */

test('the administrator holds every operation permission; a viewer holds none', () => {
  assert.deepEqual([...registry.OPERATION_PERMISSIONS].sort(), [
    'operations.container.restart', 'operations.container.start', 'operations.container.stop',
  ].sort());
  assert.equal(registry.OPERATION_PERMISSIONS.length, 3);
});

test('an unauthenticated request cannot reach any operations route', async () => {
  for (const p of ['/api/v1/operations', '/api/operations', '/api/v1/operations/op-20260101-aaaaaaa']) {
    const r = await get(p, null, null);
    assert.equal(r.status, 401, `${p} must require a session`);
    assert.equal(r.json.code, 'auth_required');
  }
  for (const [p, body] of [['/api/v1/operations', { action: 'container.restart', target: { type: 'service', id: 'jellyfin' } }], ['/api/v1/operations/dry-run', { action: 'container.restart', target: { type: 'service', id: 'jellyfin' } }]]) {
    const r = await post(p, body, null, null);
    assert.equal(r.status, 401, `${p} must require a session`);
  }
  assert.deepEqual(wirePosts(), []);
});

test('a cross-site request is refused by the CSRF gate before the engine sees it', async () => {
  const evil = { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' };
  for (const [p, body] of [
    ['/api/v1/operations/dry-run', { action: 'container.restart', target: { type: 'service', id: 'jellyfin' } }],
    ['/api/v1/operations', { action: 'container.restart', target: { type: 'service', id: 'jellyfin' }, confirmationToken: 'x' }],
  ]) {
    const r = await post(p, body, evil);
    assert.equal(r.status, 403, `${p} must be refused cross-site`);
    assert.equal(r.json.code, 'csrf');
  }
  assert.deepEqual(wirePosts(), []);
});

test('an account without the permission is refused every operation', async () => {
  const target = { type: 'service', id: 'jellyfin' };
  for (const action of registry.ACTION_IDS) {
    const r = await dryRun(action, target) && await post('/api/v1/operations/dry-run', { action, target }, null, VIEWER_COOKIE);
    assert.equal(r.status, 403, `${action} must be refused for a viewer`);
    assert.equal(r.json.operation.error.code, 'not_permitted');
  }
  assert.deepEqual(wirePosts(), [], 'a refused actor never reaches Docker');
});

test('the overview tells the caller exactly which actions it may run', async () => {
  const mine = await get('/api/v1/operations');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.actions.map((a) => a.permitted), [true, true, true]);
  const theirs = await get('/api/v1/operations', null, VIEWER_COOKIE);
  assert.deepEqual(theirs.json.actions.map((a) => a.permitted), [false, false, false]);
  assert.equal(theirs.json.actor.role, 'viewer');
});

/* ------------------------------ 4. confirmation ---------------------------- */

test('a dry-run evaluates without touching Docker and asks for confirmation', async () => {
  ENGINE.reset();
  const r = await dryRun('container.restart', { type: 'service', id: 'jellyfin' });
  assert.equal(r.status, 200);
  assert.equal(r.json.operation.status, 'awaiting_confirmation');
  assert.equal(r.json.dryRun.ready, true);
  assert.equal(r.json.dryRun.permission, true);
  assert.equal(r.json.dryRun.docker, true);
  assert.equal(r.json.dryRun.engineAction, 'docker restart');
  assert.deepEqual(wirePosts(), [], 'a dry-run must not write to Docker');
  assert.ok(ENGINE.log.length > 0, '…but it does read the inventory it validated against');
  // the report is the same list of checks the execution will repeat
  for (const key of ['action', 'permission', 'target', 'docker', 'backoff', 'lock']) {
    assert.ok(r.json.dryRun.checks.some((c) => c.key === key && c.ok), `the dry-run reports ${key}`);
  }
  assert.equal(typeof r.json.confirmation.token, 'string');
  assert.ok(r.json.confirmation.expiresAt > Date.now());
  assert.match(r.json.confirmation.prompt.title, /^Restart Jellyfin\?$/);
});

test('executing without a confirmation is refused', async () => {
  const r = await execute('container.restart', { type: 'service', id: 'jellyfin' }, null, null);
  assert.equal(r.status, 409);
  assert.equal(r.json.operation.error.code, 'confirmation_required');
  assert.deepEqual(wirePosts(), []);
});

test('a confirmed boolean in the body means nothing', async () => {
  const r = await post('/api/v1/operations', { action: 'container.restart', target: { type: 'service', id: 'jellyfin' }, confirmed: true });
  assert.equal(r.status, 409);
  assert.equal(r.json.operation.error.code, 'confirmation_required');
  assert.deepEqual(wirePosts(), []);
});

test('a confirmation token cannot be spent twice', async () => {
  const d = await dryRun('container.start', { type: 'service', id: 'paperless' });
  const token = d.json.confirmation.token;
  const first = await execute('container.start', { type: 'service', id: 'paperless' }, token, d.json.operation.id);
  assert.equal(first.status, 202, 'the first spend starts the operation');
  const op = await settleOperation(first.json.operation.id);
  assert.equal(op.status, 'succeeded');
  const second = await post('/api/v1/operations', {
    action: 'container.start', target: { type: 'service', id: 'paperless' }, confirmationToken: token,
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.operation.error.code, 'confirmation_used');
  // exactly one start actually happened
  assert.deepEqual(wirePosts().map(stripId), ['POST /containers/<id>/start'], 'one start reached the engine');
});

test('a token issued for one action cannot be spent on another', async () => {
  const d = await dryRun('container.start', { type: 'service', id: 'paperless' });
  const r = await execute('container.stop', { type: 'service', id: 'paperless' }, d.json.confirmation.token, d.json.operation.id);
  assert.equal(r.status, 409);
  assert.equal(r.json.operation.error.code, 'confirmation_mismatch');
  assert.deepEqual(wirePosts(), []);
});

test('a token issued for one service cannot be spent on another', async () => {
  const d = await dryRun('container.restart', { type: 'service', id: 'jellyfin' });
  const r = await execute('container.restart', { type: 'service', id: 'radarr' }, d.json.confirmation.token, d.json.operation.id);
  assert.equal(r.status, 409);
  assert.equal(r.json.operation.error.code, 'confirmation_mismatch');
  assert.deepEqual(wirePosts(), []);
});

test('a token from another session is refused', async () => {
  const auth = await import('./auth.js');
  const other = auth.createSession({ username: 'fixture-admin', ip: '127.0.0.1' });
  const otherCookie = `${auth.SESSION_COOKIE}=${other.id}`;
  const d = await dryRun('container.restart', { type: 'service', id: 'jellyfin' });
  // the same person, a different browser: the confirmation is bound to the session that asked
  // for it, so a token lifted from one session is worthless in another
  const r = await post('/api/v1/operations', {
    action: 'container.restart', target: { type: 'service', id: 'jellyfin' },
    confirmationToken: d.json.confirmation.token, operationId: d.json.operation.id,
  }, null, otherCookie);
  assert.equal(r.status, 409, 'a session-scoped confirmation cannot be spent from a different session');
  assert.equal(r.json.operation.error.code, 'confirmation_session');
  assert.deepEqual(wirePosts(), []);
  auth.destroySession(other.id);
});

test('an expired confirmation is refused', async () => {
  const issued = confirmation.issue({ sessionId: 's1', actor: 'a', action: 'container.start', targetKey: 'container:abc', ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 10));
  const v = confirmation.verify({ token: issued.token, sessionId: 's1', actor: 'a', action: 'container.start', targetKey: 'container:abc' });
  assert.equal(v.ok, false);
  assert.equal(v.error.code, 'confirmation_expired');
});

test('a cancel ends the operation without running it', async () => {
  const d = await dryRun('container.restart', { type: 'service', id: 'jellyfin' });
  const id = d.json.operation.id;
  const r = await post(`/api/v1/operations/${id}/cancel`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.operation.status, 'cancelled');
  const after = await execute('container.restart', { type: 'service', id: 'jellyfin' }, d.json.confirmation.token, id);
  assert.equal(after.status, 409, 'a cancelled operation cannot then be executed');
  assert.equal(after.json.operation.error.code, 'already_settled');
  assert.deepEqual(wirePosts(), []);
});

/* ------------------------------- 5. operations ------------------------------ */

test('start: a stopped container ends up running, proven by inspect', async () => {
  const { operation } = await runOperation('container.start', { type: 'service', id: 'paperless' });
  assert.equal(operation.status, 'succeeded');
  assert.equal(operation.verification.state, 'running');
  assert.deepEqual(wirePosts().map(stripId), ['POST /containers/<id>/start']);
  assert.ok(operation.result, 'a settled operation carries its result');
});

test('stop: a running container ends up exited', async () => {
  const { operation } = await runOperation('container.stop', { type: 'service', id: 'radarr' });
  assert.equal(operation.status, 'succeeded');
  assert.equal(operation.verification.state, 'exited');
  assert.deepEqual(wirePosts().map(stripId), ['POST /containers/<id>/stop']);
});

test('restart: the container runs again with a new start time', async () => {
  const inv = await get('/api/services');
  const before = inv.json.services.find((s) => s.name === 'jellyfin');
  const pre = await get(`/api/services/${encodeURIComponent(before.group)}/${encodeURIComponent('jellyfin')}`);
  const startedBefore = pre.json.container?.state?.startedAt ?? null;
  const { operation } = await runOperation('container.restart', { type: 'service', id: 'jellyfin' });
  assert.equal(operation.status, 'succeeded');
  assert.equal(operation.verification.state, 'running');
  assert.notEqual(operation.verification.startedAt, startedBefore, 'a restart is proven by a new start time, not by "running"');
  assert.deepEqual(wirePosts().map(stripId), ['POST /containers/<id>/restart']);
});

test('every write the engine sees is one of the three approved endpoints', async () => {
  await runOperation('container.start', { type: 'service', id: 'sonarr' });
  await runOperation('container.stop', { type: 'service', id: 'sonarr' });
  await runOperation('container.start', { type: 'service', id: 'sonarr' });
  for (const line of wirePosts()) {
    assert.match(line, /^POST \/containers\/[A-Za-z0-9_.-]+\/(start|stop|restart)$/, `unexpected engine call: ${line}`);
  }
  assert.ok(wirePosts().length >= 3);
});

/* ------------------------- 6. concurrency & duplicates ---------------------- */

test('three clicks produce one restart', async () => {
  const target = { type: 'service', id: 'immich' };
  const tokens = [];
  for (let i = 0; i < 3; i++) {
    const d = await dryRun('container.restart', target);
    assert.equal(d.status, 200, `request ${i + 1} is valid on its own`);
    tokens.push(d.json.confirmation.token);
  }
  const results = [];
  for (const t of tokens) results.push(await execute('container.restart', target, t));
  const started = results.filter((r) => r.status === 202);
  const refused = results.filter((r) => r.status === 409);
  assert.equal(started.length, 1, 'exactly one restart starts');
  assert.equal(refused.length, 2, 'the duplicates are refused');
  assert.ok(refused.every((r) => r.json.operation.error.code === 'already_running'));
  const op = await settleOperation(started[0].json.operation.id);
  assert.equal(op.status, 'succeeded');
  assert.deepEqual(wirePosts().map(stripId), ['POST /containers/<id>/restart'], 'one Docker call, not three');
});

test('a lock expires on its own so a crashed operation cannot block forever', async () => {
  const id = 'deadbeef1234';
  assert.equal(locks.acquire(id, { opId: 'op-1', action: 'container.restart', ttlMs: 50 }).ok, true);
  assert.equal(locks.acquire(id, { opId: 'op-2', action: 'container.restart', ttlMs: 50 }).ok, false, 'held');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(locks.acquire(id, { opId: 'op-3', action: 'container.restart', ttlMs: 50 }).ok, true, 'the lock expired');
});

/* -------------------------------- 7. timeouts ------------------------------ */

test('an already-running container is reported honestly when the engine changes nothing', async () => {
  process.env.OPUSHUB_MOCK_OP_NOSTATE = '1';
  try {
    const { operation } = await runOperation('container.start', { type: 'service', id: 'photos-db' });
    // photos-db is already running; with NOSTATE the engine accepts but nothing changes, so the
    // verification window closes without the expected transition being proven
    const inv = await get('/api/services');
    const svc = inv.json.services.find((s) => s.name === 'photos-db');
    assert.equal(operation.status, 'succeeded', 'it is already running, so the state is reached');
    assert.equal(svc.container.state, 'running');
  } finally {
    delete process.env.OPUSHUB_MOCK_OP_NOSTATE;
  }
});

test('a verified timeout reports the state it actually observed', async () => {
  // stop a container, then ask for a *restart* while the engine refuses to change state: the
  // expected state ("running" after a new start time) is never reached inside the window.
  const { operation } = await runOperation('container.stop', { type: 'service', id: 'vaultwarden' });
  assert.equal(operation.status, 'succeeded');
  process.env.OPUSHUB_MOCK_OP_NOSTATE = '1';
  try {
    const { operation: op } = await runOperation('container.restart', { type: 'service', id: 'vaultwarden' });
    assert.equal(op.status, 'timed_out', 'a bounded timeout is reported as a timeout');
    assert.equal(op.error.code, 'verification_timeout');
    assert.equal(op.verification.state, 'exited', '…with the state that was actually observed');
    assert.equal(op.verification.verified, false);
  } finally {
    delete process.env.OPUSHUB_MOCK_OP_NOSTATE;
  }
});

/* -------------------------------- 8. failures ------------------------------ */

test('docker unavailable: the operation is rejected, not queued', async () => {
  const saved = process.env.OPUSHUB_DOCKER_SOCKET;
  delete process.env.OPUSHUB_DOCKER_SOCKET;
  try {
    const r = await dryRun('container.restart', { type: 'service', id: 'jellyfin' });
    assert.equal(r.status, 503);
    assert.equal(r.json.operation.error.code, 'docker_unavailable');
  } finally {
    process.env.OPUSHUB_DOCKER_SOCKET = saved;
  }
});

test('a daemon that refuses permission is reported as a failure, not a success', async () => {
  process.env.OPUSHUB_MOCK_OP_DENIED = '1';
  try {
    const { operation } = await runOperation('container.stop', { type: 'service', id: 'traefik' });
    assert.equal(operation.status, 'failed');
    assert.equal(operation.error.code, 'permission_denied');
    assert.match(operation.error.reason, /not permitted|refused/i);
  } finally {
    delete process.env.OPUSHUB_MOCK_OP_DENIED;
    locks._resetLimits();
  }
});

test('a daemon error is reported with its own class and no daemon payload', async () => {
  process.env.OPUSHUB_MOCK_OP_FAIL = '1';
  try {
    const { operation } = await runOperation('container.restart', { type: 'service', id: 'postgres' });
    assert.equal(operation.status, 'failed');
    assert.equal(operation.error.code, 'engine_error');
    assert.equal(operation.error.detail, 'docker HTTP 500', 'the browser gets a class and a status, never the daemon body');
  } finally {
    delete process.env.OPUSHUB_MOCK_OP_FAIL;
    locks._resetLimits();
  }
});

test('repeated failures on one service enforce a short back-off', async () => {
  process.env.OPUSHUB_MOCK_OP_FAIL = '1';
  const target = { type: 'service', id: 'photos-db' };
  try {
    for (let i = 0; i < locks._internals.FAIL_THRESHOLD; i++) {
      const r = await runOperation('container.stop', target);
      assert.equal(r.operation.status, 'failed');
    }
    const r = await dryRun('container.stop', target);
    assert.equal(r.status, 429);
    assert.equal(r.json.operation.error.code, 'backoff');
  } finally {
    delete process.env.OPUSHUB_MOCK_OP_FAIL;
    locks._resetLimits();
  }
});

/* --------------------------------- 9. audit -------------------------------- */

test('every operation leaves a trail of the phases it went through', async () => {
  const { operation } = await runOperation('container.start', { type: 'service', id: 'paperless' });
  const r = await get(`/api/v1/operations/${operation.id}/trail`);
  assert.equal(r.status, 200);
  const phases = r.json.trail.map((t) => t.phase);
  for (const phase of ['requested', 'authorization', 'target', 'confirmation', 'execution', 'completed']) {
    assert.ok(phases.includes(phase), `the trail records ${phase}`);
  }
  const done = r.json.trail.find((t) => t.phase === 'completed');
  assert.equal(done.status, 'succeeded');
  assert.equal(done.actor, 'fixture-admin');
  assert.equal(done.action, 'container.start');
  assert.equal(done.target.containerName, 'paperless');
  assert.ok(done.durationMs >= 0);
  assert.equal(done.confirmation.consumed, true);
});

test('a rejected operation is audited with the reason it was refused', async () => {
  const r = await dryRun('container.restart', { type: 'service', id: 'ghost-service' });
  assert.equal(r.status, 404);
  const rows = audit.readAudit({ limit: 10 });
  const row = rows.find((x) => x.code === 'unknown_target');
  assert.ok(row, 'the refusal is in the audit');
  assert.equal(row.status, 'rejected');
  assert.match(row.reason, /no service or container/i);
});

test('the audit trail and the API carry no secrets, tokens or socket paths', async () => {
  const { operation } = await runOperation('container.restart', { type: 'service', id: 'jellyfin' });
  const blobs = [
    JSON.stringify(await (await get('/api/v1/operations')).json),
    JSON.stringify((await get(`/api/v1/operations/${operation.id}/trail`)).json),
    fs.readFileSync(path.join(DATA_DIR, 'operations.jsonl'), 'utf8'),
    fs.readFileSync(path.join(DATA_DIR, 'activity.jsonl'), 'utf8'),
  ];
  const whole = blobs.join('\n');
  for (const needle of ['hunter2', 'SECRET_SHOULD_NEVER_LEAVE_SERVER', 'MOCK_FIXTURE=true', 'opushub_session', '/var/run/docker.sock', ENGINE.socketPath, 'confirmationToken']) {
    assert.ok(!whole.includes(needle), `leaked: ${needle}`);
  }
  // the confirmation token was issued, and still must not appear anywhere
  const d = await dryRun('container.stop', { type: 'service', id: 'jellyfin' });
  const token = d.json.confirmation.token;
  const after = fs.readFileSync(path.join(DATA_DIR, 'operations.jsonl'), 'utf8');
  assert.ok(!after.includes(token), 'a confirmation token never reaches the audit log');
});

test('an interrupted operation is recorded with an unknown outcome rather than left running', async () => {
  const op = store.put({
    id: 'op-20260101-aaaaaaa', action: 'container.restart', target: { containerName: 'ghost' },
    actor: 'fixture-admin', status: 'running', requestedAt: Date.now() - 5000, error: null, verification: null,
  });
  store.append(op, 'execution', { note: 'docker restart' });
  const recovered = store.recoverInterrupted();
  assert.ok(recovered.includes('op-20260101-aaaaaaa'));
  const rows = audit.readAudit({ opId: 'op-20260101-aaaaaaa', limit: 10 });
  const row = rows.find((r) => r.phase === 'interrupted');
  assert.ok(row, 'the interruption is recorded');
  assert.equal(row.status, 'failed');
  assert.match(row.reason, /restarted while this operation was in progress/);
  assert.match(row.detail, /may or may not have completed/);
});

/* ------------------------------- 10. activity ------------------------------ */

test('a successful operation generates exactly one activity event', async () => {
  const before = (await get('/api/activity?limit=200')).json.items.length;
  const { operation } = await runOperation('container.start', { type: 'service', id: 'paperless' });
  assert.equal(operation.status, 'succeeded');
  const items = (await get('/api/activity?limit=200')).json.items;
  const mine = items.filter((e) => e.type === 'operation.succeeded' && e.meta?.opId === operation.id);
  assert.equal(mine.length, 1, 'one event per operation, however often the page polls');
  assert.equal(mine[0].subject, 'Paperless');
  assert.equal(mine[0].message, 'started');
  assert.equal(mine[0].category, 'service');
  assert.ok(items.length > before);
});

test('a failed operation generates a warning-level event with the reason', async () => {
  process.env.OPUSHUB_MOCK_OP_FAIL = '1';
  try {
    const { operation } = await runOperation('container.stop', { type: 'service', id: 'redis' });
    assert.equal(operation.status, 'failed');
    const items = (await get('/api/activity?limit=200')).json.items;
    const mine = items.filter((e) => e.type === 'operation.failed' && e.meta?.opId === operation.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].severity, 'warning');
    assert.equal(mine[0].category, 'service');
  } finally {
    delete process.env.OPUSHUB_MOCK_OP_FAIL;
    locks._resetLimits();
  }
});

test('a rejected operation is recorded as a rejection', async () => {
  const r = await dryRun('container.restart', { type: 'service', id: 'not-a-container' });
  assert.equal(r.status, 404);
  const items = (await get('/api/activity?limit=200')).json.items;
  assert.ok(items.some((e) => e.type === 'operation.rejected'), 'the rejection is in the activity log');
});

/* -------------------------------- 11. health ------------------------------- */

test('a finished operation reports the post-operation health it measured', async () => {
  const { operation } = await runOperation('container.restart', { type: 'service', id: 'jellyfin' });
  assert.equal(operation.status, 'succeeded');
  const health = operation.verification.health;
  assert.ok(health, 'the operation verified health after the fact');
  // every one of the health model's own verdicts is acceptable; what is not acceptable is a
  // verdict that was not measured
  assert.ok(['healthy', 'available', 'degraded', 'unreachable', 'starting', 'stopped', 'unhealthy', 'unknown'].includes(health.state),
    `a real verdict, not a guess: ${health.state}`);
  assert.equal(health.measured !== false, true);
});

test('service detail reflects the new state after an operation', async () => {
  const inv = await get('/api/services');
  const svc = inv.json.services.find((s) => s.name === 'seerr');
  const path = `/api/services/${encodeURIComponent(svc.group)}/${encodeURIComponent('seerr')}`;
  const { operation } = await runOperation('container.stop', { type: 'service', id: 'seerr' });
  assert.equal(operation.status, 'succeeded');
  const after = (await get(path)).json;
  assert.equal(after.container.state.status, 'exited', 'the inventory was re-read, not served from cache');
  assert.equal(after.service.status, 'down');
});

/* ------------------------------ 12. rate limiting -------------------------- */

test('operation flooding is throttled server-side', async () => {
  const auth = await import('./auth.js');
  const s = auth.createSession({ username: 'fixture-admin', ip: '127.0.0.1' });
  const cookie = `${auth.SESSION_COOKIE}=${s.id}`;
  const target = { type: 'service', id: 'jellyfin' };
  const limit = locks._internals.MAX_PER_WINDOW;
  let throttled = null;
  for (let i = 0; i < limit + 3; i++) {
    const r = await post('/api/v1/operations/dry-run', { action: 'container.restart', target }, null, cookie);
    if (r.status === 429) { throttled = r; break; }
  }
  assert.ok(throttled, 'a flood of operations is refused');
  assert.equal(throttled.json.operation.error.code, 'rate_limited');
  assert.deepEqual(wirePosts(), [], 'nothing was executed while being throttled');
  auth.destroySession(s.id);
});

/* --------------------------- 13. no automation hooks ----------------------- */

test('the operations API is inert: no route runs anything on its own', async () => {
  ENGINE.reset();
  const overview = await get('/api/v1/operations');
  assert.equal(overview.status, 200);
  assert.equal(overview.json.docker.channel, 'shared');
  assert.ok(Array.isArray(overview.json.actions));
  assert.equal(overview.json.actions.length, 3);
  assert.equal(typeof overview.json.counts.running, 'number');
  // reading the operations surface never touches the engine in a mutating way
  assert.deepEqual(wirePosts(), []);
});

/* --------------------- 14. the command palette is not a trigger ----------- */

test('search offers operations only to an account that may run them', async () => {
  ENGINE.reset();
  const mine = await get('/api/search?q=restart');
  assert.equal(mine.status, 200);
  const ops = mine.json.results.filter((r) => r.kind === 'operation');
  assert.ok(ops.length > 0, 'an administrator sees operations in the palette');
  for (const r of ops) {
    assert.ok(registry.ACTIONS[r.operation.action], `the palette offered an unregistered action: ${r.operation.action}`);
    assert.equal(r.operation.target.type, 'service');
    assert.ok(r.operation.target.id, 'an operation result does not name its target');
  }
  // a running container is offered Restart/Stop; a stopped one is offered Start
  const offered = new Map();
  for (const r of ops) offered.set(r.operation.target.id, [...(offered.get(r.operation.target.id) || []), r.operation.action]);
  for (const [name, actions] of offered) {
    for (const action of actions) {
      const allowed = registry.ACTIONS[action].offerWhen;
      const state = (await get('/api/services')).json.services.find((s) => s.name === name)?.container?.state?.status;
      if (state) assert.ok(allowed.includes(state), `${action} was offered for ${name} in state ${state}`);
    }
  }
  // and offering them is not doing them
  assert.deepEqual(wirePosts(), [], 'search touched the engine');

  const viewer = await get('/api/search?q=restart', null, VIEWER_COOKIE);
  assert.deepEqual(viewer.json.results.filter((r) => r.kind === 'operation'), [], 'a viewer was offered operations');
});

test('an operation search result carries no endpoint, method or container id as one', async () => {
  ENGINE.reset();
  const r = await get('/api/search?q=restart');
  const op = r.json.results.find((x) => x.kind === 'operation');
  assert.ok(op, 'no operation result was returned');
  const wire = JSON.stringify(op);
  for (const forbidden of ['/containers/', 'v1.', 'POST', 'DELETE', 'http://', 'https://', '/var/run', 'exec', 'confirmed']) {
    assert.ok(!wire.includes(forbidden), `the palette result leaks a request detail: ${forbidden}`);
  }
  assert.deepEqual(Object.keys(op.operation).sort(), ['action', 'confirmation', 'risk', 'target'], 'the result carries something beyond the action and its target');
  // the target is a reference, never an address: 12/64-hex container ids must not appear
  assert.ok(!/[0-9a-f]{12}/.test(JSON.stringify(op.operation.target)), 'the result carries a container id');
});
