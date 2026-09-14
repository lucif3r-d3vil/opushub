// API authentication tests — the door, end to end, over real HTTP.
//
// A real server process is started against a scratch config/data directory and the mock Docker
// engine, exactly the way `npm run verify` starts one. Nothing here reaches the network beyond
// 127.0.0.1, and the account it creates lives in a temp directory that is removed afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockEngine } from '../test/mock-engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3741;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'api-auth-fixture-password';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-api-auth-'));
const CONFIG_DIR = path.join(scratch, 'config');
const DATA_DIR = path.join(scratch, 'data');

let engine = null;
let child = null;
let log = '';
let cookie = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 160; i++) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}): ${log.slice(-800)}`);
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await sleep(250);
  }
  throw new Error(`server never answered on ${BASE}: ${log.slice(-800)}`);
}

async function call(method, p, { body, headers = {}, auth = true, origin } = {}) {
  const h = { ...headers };
  if (auth && cookie) h.cookie = cookie;
  if (origin) h.origin = origin;
  if (body !== undefined) h['content-type'] = h['content-type'] ?? 'application/json';
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: r.status, json, text, headers: r.headers, setCookie: r.headers.getSetCookie?.() ?? [] };
}

const get = (p, opts) => call('GET', p, opts);
const send = (method) => (p, body, opts = {}) => call(method, p, { ...opts, body });

test.before(async () => {
  engine = await startMockEngine();
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPUSHUB_CONFIG_DIR: CONFIG_DIR,
      OPUSHUB_DATA_DIR: DATA_DIR,
      OPUSHUB_PORT: String(PORT),
      OPUSHUB_HOST: '127.0.0.1',
      OPUSHUB_DOCKER_SOCKET: engine.socketPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  await waitForServer();
});

test.after(async () => {
  child?.kill('SIGTERM');
  await new Promise((r) => child?.once('exit', r) ?? r());
  await engine?.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
});

// ── closed by default ────────────────────────────────────────────────────────

test('every application endpoint refuses an anonymous caller', async () => {
  const routes = [
    ['GET', '/api/services'], ['GET', '/api/stacks'], ['GET', '/api/system'], ['GET', '/api/activity'],
    ['GET', '/api/docker/status'], ['GET', '/api/logs'], ['GET', '/api/settings'], ['GET', '/api/layout'],
    ['GET', '/api/bookmarks'], ['GET', '/api/assets'], ['GET', '/api/icons'], ['GET', '/api/discovery'],
    ['GET', '/api/providers'], ['GET', '/api/inventory'], ['GET', '/api/urls'],
    ['PUT', '/api/settings'], ['PUT', '/api/layout'], ['PUT', '/api/overlays'], ['POST', '/api/icons/search'],
  ];
  for (const [method, p] of routes) {
    const r = await call(method, p, { auth: false, body: method === 'GET' ? undefined : {} });
    assert.equal(r.status, 401, `${method} ${p} → ${r.status}`);
    assert.match(r.json?.error || '', /authentication required/i);
    assert.ok(!r.text.includes('fixture'), 'a refused response must not carry data');
  }
});

test('an unknown API path is refused too — no route enumeration without a session', async () => {
  const r = await get('/api/definitely-not-a-route', { auth: false });
  assert.equal(r.status, 401);
  // An unknown *non-API* path is served as the SPA shell (there is no server-side route to
  // leak). On a fresh checkout the shell is not built yet and the server answers 404; either
  // way an unauthenticated response must never carry account, session or fixture data.
  const page = await get('/', { auth: false });
  assert.ok(page.status === 200 || page.status === 404, `unexpected unauthenticated / status: ${page.status}`);
  if (page.status === 200) assert.match(page.text, /<div id="root">|<title>/);
  assert.ok(!page.text.includes('fixture'), 'an unauthenticated response must not leak account data');
});

test('only health, setup status, me and the auth endpoints are public', async () => {
  const health = await get('/api/health', { auth: false });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.ok(!health.json.providers, 'health says nothing about the host before login');
  const status = await get('/api/setup/status', { auth: false });
  assert.equal(status.status, 200);
  assert.equal(status.json.required, true);
  assert.equal(status.json.complete, false);
  const me = await get('/api/auth/me', { auth: false });
  assert.equal(me.status, 200);
  assert.equal(me.json.authenticated, false);
  assert.equal(me.json.user, null);
  assert.equal(me.json.setupComplete, false);
  const logout = await send('POST')('/api/auth/logout', undefined, { auth: false });
  assert.equal(logout.status, 200, 'logging out while logged out is not an error');
});

test('user assets are not served to an anonymous caller', async () => {
  // a file that really exists in the config directory, so a 401 cannot be a 404 in disguise
  fs.mkdirSync(path.join(CONFIG_DIR, 'backgrounds'), { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, 'backgrounds', 'probe.png'), 'not-a-real-png');
  const anon = await get('/user/backgrounds/probe.png', { auth: false });
  assert.equal(anon.status, 401);
  assert.ok(!anon.text.includes('not-a-real-png'));
  const themeAnon = await get('/user/theme.css', { auth: false });
  assert.equal(themeAnon.status, 401);
});

// ── setup ────────────────────────────────────────────────────────────────────

test('setup refuses malformed input and non-JSON bodies', async () => {
  const wrongType = await call('POST', '/api/setup', { auth: false, body: 'username=admin', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(wrongType.status, 415, 'form posts and text/plain are not accepted');
  const empty = await send('POST')('/api/setup', {}, { auth: false });
  assert.equal(empty.status, 400);
  const weak = await send('POST')('/api/setup', { username: 'admin', password: 'short' }, { auth: false });
  assert.equal(weak.status, 400);
  assert.match(weak.json.error, /at least 8 characters/);
  const textPlain = await call('POST', '/api/setup', { auth: false, body: '{"username":"admin"}', headers: { 'content-type': 'text/plain' } });
  assert.equal(textPlain.status, 415, 'a text/plain body is never parsed as a command');
  const badName = await send('POST')('/api/setup', { username: 'no spaces allowed', password: PASSWORD }, { auth: false });
  assert.equal(badName.status, 400);
});

test('setup creates the administrator, signs them in and never leaks the hash', async () => {
  const created = await send('POST')('/api/setup', { username: 'admin', password: PASSWORD }, { auth: false });
  assert.equal(created.status, 201);
  assert.equal(created.json.user.username, 'admin');
  assert.ok(!('passwordHash' in created.json.user));
  assert.ok(!created.text.includes('scrypt$'), 'no hash anywhere in the response');
  const setCookie = created.setCookie.join('; ');
  assert.match(setCookie, /opushub_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.ok(!/;\s*Secure/.test(setCookie), 'plain HTTP on a LAN must still work');
  cookie = setCookie.split(';')[0];
});

test('the same endpoints are open now, and the hash is not', async () => {
  const services = await get('/api/services');
  assert.equal(services.status, 200);
  assert.ok(Array.isArray(services.json.services));
  assert.ok(!services.text.includes('scrypt$') && !services.text.includes('passwordHash'), 'no credential material in a data response');
  const status = await get('/api/setup/status');
  assert.equal(status.json.complete, true);
  assert.equal(status.json.required, false);
  const me = await get('/api/auth/me');
  assert.equal(me.json.authenticated, true);
  assert.equal(me.json.setupComplete, true);
  assert.equal(me.json.user.username, 'admin');
  assert.ok(!('passwordHash' in me.json.user));
  const asset = await get('/user/backgrounds/probe.png');
  assert.equal(asset.status, 200, 'the session also unlocks user assets');
});

test('setup can never be run twice', async () => {
  const again = await send('POST')('/api/setup', { username: 'intruder', password: PASSWORD }, { auth: false });
  assert.equal(again.status, 409);
  const fresh = await send('POST')('/api/setup', { username: 'intruder', password: PASSWORD });
  assert.equal(fresh.status, 409, 'an authenticated repeat is refused too');
  const me = await get('/api/auth/me');
  assert.equal(me.json.user.username, 'admin', 'the account is untouched');
});

// ── login / logout ───────────────────────────────────────────────────────────

test('login answers identically for a bad password and an unknown user', async () => {
  const wrong = await send('POST')('/api/auth/login', { username: 'admin', password: 'not-the-password' }, { auth: false });
  const ghost = await send('POST')('/api/auth/login', { username: 'nobody-here', password: 'not-the-password' }, { auth: false });
  assert.equal(wrong.status, 401);
  assert.equal(ghost.status, 401);
  assert.equal(wrong.json.error, ghost.json.error, 'no user enumeration');
  assert.match(wrong.json.error, /incorrect username or password/i);
  assert.ok(!wrong.text.includes('nobody-here'), 'the response never echoes which account exists');
});

test('signing in rotates the session id and retires the one presented', async () => {
  const old = cookie;
  const r = await call('POST', '/api/auth/login', { body: { username: 'admin', password: PASSWORD } });
  assert.equal(r.status, 200);
  const next = r.setCookie.join('; ').split(';')[0];
  assert.notEqual(next, old, 'a fresh session id on every sign-in (no session fixation)');
  assert.equal((await fetch(`${BASE}/api/services`, { headers: { cookie: old } })).status, 401,
    'the id the browser presented is dead — a token leaked before sign-in cannot be replayed');
  cookie = next;
  assert.equal((await get('/api/services')).status, 200);
});

test('signing in elsewhere does not sign this device out', async () => {
  const mine = cookie;
  const other = await send('POST')('/api/auth/login', { username: 'admin', password: PASSWORD }, { auth: false });
  assert.equal(other.status, 200);
  assert.equal((await fetch(`${BASE}/api/services`, { headers: { cookie: cookie } })).status, 200,
    'another device signing in leaves this session alone');
  cookie = mine;
});

test('a cross-origin write is refused even with a valid session cookie', async () => {
  const cross = await call('PUT', '/api/settings', { body: { theme: 'dark' }, origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  assert.match(cross.json.error, /does not match/i, `unexpected refusal: ${cross.json.error}`);
  const sameOrigin = await call('PUT', '/api/settings', { body: { theme: 'dark' }, origin: `http://127.0.0.1:${PORT}` });
  assert.equal(sameOrigin.status, 200, 'the Hub itself can still write');
  const spoofed = await call('PUT', '/api/settings', {
    body: { theme: 'dark' },
    headers: { origin: 'http://127.0.0.1:3000', host: 'evil.example' },
  });
  assert.equal(spoofed.status, 403, 'a mismatched Origin/Host pair is refused');
});

test('logout clears the cookie and invalidates the session server-side', async () => {
  const r = await send('POST')('/api/auth/logout');
  assert.equal(r.status, 200);
  assert.match(r.setCookie.join('; '), /Max-Age=0/);
  assert.equal((await get('/api/services')).status, 401, 'the token is dead, not merely forgotten by the browser');
  const withDeadCookie = await fetch(`${BASE}/api/services`, { headers: { cookie: cookie } });
  assert.equal(withDeadCookie.status, 401);
  const me = await get('/api/auth/me');
  assert.equal(me.json.authenticated, false);
});

test('sessions outlive the process that created them (the data volume, not memory)', async () => {
  const login = await send('POST')('/api/auth/login', { username: 'admin', password: PASSWORD }, { auth: false });
  cookie = login.setCookie.join('; ').split(';')[0];
  assert.equal((await get('/api/services')).status, 200);
  const file = path.join(DATA_DIR, 'sessions.json');
  assert.ok(fs.existsSync(file));
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).sessions.some((s) => cookie.endsWith(s.id)), 'the session is persisted, not held in memory');
});

// ── Phase 5: account maintenance over HTTP (sessions, password, audit) ───────
//
// These run last on purpose: they revoke sessions and change the password. Every test starts by
// establishing the session it needs, so a failure here cannot cascade into an unrelated one.

/** Sign in and make the returned cookie the caller's. */
async function loginAs(password = PASSWORD) {
  const r = await send('POST')('/api/auth/login', { username: 'admin', password }, { auth: false });
  assert.equal(r.status, 200, `login as admin failed: ${r.text.slice(0, 120)}`);
  cookie = r.setCookie.join('; ').split(';')[0];
  return cookie;
}

/** Start from a known state: exactly one session, the browser running the assertions. */
async function freshSingleSession() {
  await loginAs();
  const cleared = await send('POST')('/api/auth/sessions/revoke', { scope: 'all' });
  assert.equal(cleared.status, 200, 'a signed-in admin can revoke every session');
  return loginAs();
}

test('the session inventory is authenticated, counts correctly and never carries a token', async () => {
  const anon = await get('/api/auth/sessions', { auth: false });
  assert.equal(anon.status, 401, 'who is signed in is not public information');

  // a clean slate, then exactly one session — earlier tests in this file left several behind
  const token = (await freshSingleSession()).split('=')[1];

  const listed = await get('/api/auth/sessions');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.count, 1, 'one browser is signed in');
  assert.equal(listed.json.sessions[0].current, true);
  assert.equal(listed.json.current.id, listed.json.sessions[0].id);
  assert.match(listed.json.sessions[0].id, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(listed.json.limits.absoluteMs, 30 * 24 * 3600_000);
  assert.equal(listed.json.limits.idleMs, 7 * 24 * 3600_000);
  assert.equal(listed.json.sessions[0].ip, '127.0.0.1', 'the client address is recorded, not secret');
  // the bearer token is the one thing that must never appear here
  assert.ok(!listed.text.includes(token), 'the session token is not in the response');
  assert.ok(!listed.text.includes('scrypt$') && !listed.text.includes('passwordHash'));
});

test('a second device is listed, and revoking it by handle signs only it out', async () => {
  await freshSingleSession();
  const second = await send('POST')('/api/auth/login', { username: 'admin', password: PASSWORD }, { auth: false });
  const phone = second.setCookie.join('; ').split(';')[0];
  assert.notEqual(phone, cookie, 'a different browser earns a different session');

  const both = await get('/api/auth/sessions');
  assert.equal(both.json.count, 2);
  const other = both.json.sessions.find((s) => !s.current);
  assert.ok(other, 'the other session is visible');

  const revoked = await send('POST')('/api/auth/sessions/revoke', { scope: 'one', id: other.id });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.revoked, 1);
  assert.equal(revoked.json.signedOut, false, 'revoking somebody else is not a sign-out');

  const phoneCall = await fetch(`${BASE}/api/services`, { headers: { cookie: phone } });
  assert.equal(phoneCall.status, 401, 'the revoked device is signed out server-side');
  assert.equal((await get('/api/services')).status, 200, 'this browser is untouched');
  assert.equal((await get('/api/auth/sessions')).json.count, 1);

  // an unknown handle revokes nothing, and never somebody else's session by accident
  const bogus = await send('POST')('/api/auth/sessions/revoke', { scope: 'one', id: 'ZZZZZZZZZZZZZZZZ' });
  assert.equal(bogus.status, 200);
  assert.equal(bogus.json.revoked, 0);
  assert.equal((await get('/api/services')).status, 200);
  assert.equal((await send('POST')('/api/auth/sessions/revoke', { scope: 'nonsense' })).status, 400);
});

test('revoking every session clears the cookie and signs the admin out everywhere', async () => {
  await loginAs();
  const second = await send('POST')('/api/auth/login', { username: 'admin', password: PASSWORD }, { auth: false });
  const device = second.setCookie.join('; ').split(';')[0];
  const r = await send('POST')('/api/auth/sessions/revoke', { scope: 'all' });
  assert.equal(r.status, 200);
  assert.equal(r.json.signedOut, true);
  assert.match(r.setCookie.join('; '), /Max-Age=0/);
  assert.equal((await get('/api/services')).status, 401);
  const deviceCall = await fetch(`${BASE}/api/services`, { headers: { cookie: device } });
  assert.equal(deviceCall.status, 401, 'every other device is out too');
});

test('malformed, oversized and truncated session cookies are a clean 401 — never a 500', async () => {
  await loginAs();
  const bad = [
    'opushub_session=', 'opushub_session=short', 'opushub_session=' + 'x'.repeat(4000),
    'opushub_session=%E0%A4%A', 'opushub_session=' + encodeURIComponent('../../etc/passwd'),
    'garbage', 'opushub_session="quoted"', 'opushub_session=' + 'A'.repeat(64),
    'opushub_session=; other=1',
  ];
  for (const c of bad) {
    const r = await fetch(`${BASE}/api/services`, { headers: { cookie: c } });
    assert.equal(r.status, 401, `cookie ${c.slice(0, 40)} must be refused, not crash`);
    const body = await r.json();
    assert.equal(body.code, 'auth_required');
  }
  // and the server is still healthy afterwards
  assert.equal((await get('/api/services')).status, 200);
});

test('the password route refuses the wrong current password, and a cross-origin attempt', async () => {
  await loginAs();
  const cross = await call('POST', '/api/auth/password', {
    body: { currentPassword: PASSWORD, newPassword: 'hijacked-passphrase-1' },
    origin: 'https://evil.example',
  });
  assert.equal(cross.status, 403, 'a cross-site write cannot change the password');
  assert.equal((await send('POST')('/api/auth/login', { username: 'admin', password: PASSWORD }, { auth: false })).status, 200, 'the password is unchanged');

  const wrong = await send('POST')('/api/auth/password', { currentPassword: 'not-the-password', newPassword: 'brand-new-passphrase-9' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.json.error, /current password is incorrect/i);
  assert.equal((await get('/api/services')).status, 200, 'a failed change does not sign the admin out');

  const weak = await send('POST')('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'short' });
  assert.equal(weak.status, 400, 'policy is enforced on the new password');

  const anonymous = await call('POST', '/api/auth/password', { body: { currentPassword: PASSWORD, newPassword: 'without-a-session-1' }, auth: false });
  assert.equal(anonymous.status, 401, 'changing a password needs a session, not just the old password');
});

test('a successful password change rotates the cookie and signs the other devices out', async () => {
  const NEW_PASSWORD = 'phase-five-passphrase';
  await freshSingleSession();
  const phone = await send('POST')('/api/auth/login', { username: 'admin', password: PASSWORD }, { auth: false });
  const phoneCookie = phone.setCookie.join('; ').split(';')[0];

  const changed = await send('POST')('/api/auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.revoked, 1, 'the other browser is revoked');
  const rotated = changed.setCookie.join('; ').split(';')[0];
  assert.notEqual(rotated, cookie, 'the session id is rotated, not reused');
  cookie = rotated;

  assert.equal((await get('/api/services')).status, 200, 'the new cookie works');
  const phoneCall = await fetch(`${BASE}/api/services`, { headers: { cookie: phoneCookie } });
  assert.equal(phoneCall.status, 401, 'the pre-change session does not survive');
  assert.equal((await get('/api/auth/sessions')).json.count, 1);

  const oldPassword = await send('POST')('/api/auth/login', { username: 'admin', password: PASSWORD }, { auth: false });
  assert.equal(oldPassword.status, 401);
  const newPassword = await send('POST')('/api/auth/login', { username: 'admin', password: NEW_PASSWORD }, { auth: false });
  assert.equal(newPassword.status, 200, 'the new password signs in');
  cookie = newPassword.setCookie.join('; ').split(';')[0];
});

test('credentials never travel in a URL, and a query-string password is ignored', async () => {
  const inQuery = await call('POST', `/api/auth/login?username=admin&password=${encodeURIComponent('irrelevant')}`, {
    body: { username: 'admin', password: 'phase-five-passphrase' },
    auth: false,
  });
  assert.equal(inQuery.status, 200, 'the body is the only place credentials are read from');
  const bogus = await call('POST', `/api/auth/login?password=phase-five-passphrase`, { body: {}, auth: false });
  assert.equal(bogus.status, 401, 'a password in the query string authenticates nothing');
});

test('the activity log records auth events without ever recording a credential', async () => {
  await loginAs('phase-five-passphrase');
  const activity = await get('/api/activity?limit=200');
  assert.equal(activity.status, 200);
  const types = activity.json.items.map((e) => e.type);
  assert.ok(types.includes('auth.password_changed'), 'the change is a logged fact');
  assert.ok(types.includes('auth.password_failed'), 'the refusal is a logged fact');
  assert.ok(types.includes('auth.sessions_revoked'));
  const text = activity.text;
  for (const secret of ['phase-five-passphrase', PASSWORD, 'brand-new-passphrase-9', 'hijacked-passphrase-1']) {
    assert.ok(!text.includes(secret), `the activity feed must not contain "${secret}"`);
  }
  assert.ok(!text.includes('scrypt$'), 'no hash in the activity feed either');
});
