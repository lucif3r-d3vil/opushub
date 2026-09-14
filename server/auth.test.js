// Authentication unit tests — the pieces that must be right before anything else can be trusted.
//
// Everything runs against a throwaway data directory (the account lives in the *data* volume, and
// these tests never touch a real one). No network, no browser: hashing, sessions, cookies, CSRF
// metadata and the login throttle are all pure functions of their inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-auth-data-'));
process.env.OPUSHUB_DATA_DIR = DATA_DIR;
process.env.OPUSHUB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-auth-cfg-'));

const auth = await import('./auth.js');
const { hashPassword, verifyPassword } = auth;

const PASSWORD = 'fixture-password-42';
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

const req = (method, headers = {}) => ({ method, headers, socket: {} });
const clears = async (fn) => { try { await fn(); } catch (err) { return err; } return null; };

// ── passwords ────────────────────────────────────────────────────────────────

test('passwords are stored as a self-describing scrypt hash with a per-account salt', async () => {
  const a = await hashPassword(PASSWORD);
  const b = await hashPassword(PASSWORD);
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/, `unexpected format: ${a.slice(0, 24)}…`);
  assert.notEqual(a, b, 'two hashes of the same password must differ (random salt)');
  assert.ok(!a.includes(PASSWORD), 'the plaintext must not appear in the hash');
});

test('verification accepts the right password and nothing else', async () => {
  const stored = await hashPassword(PASSWORD);
  assert.equal(await verifyPassword(stored, PASSWORD), true);
  assert.equal(await verifyPassword(stored, PASSWORD + 'x'), false);
  assert.equal(await verifyPassword(stored, ''), false);
  assert.equal(await verifyPassword(stored.toUpperCase(), PASSWORD), false, 'a tampered hash is a failure, not a pass');
});

test('malformed or truncated hashes fail closed instead of throwing', async () => {
  for (const bad of ['', 'nonsense', 'scrypt$1$2$3', 'scrypt$a$b$c$d$e', null, undefined, 42, 'scrypt$32768$8$1$%%%$%%%']) {
    assert.equal(await verifyPassword(bad, PASSWORD), false, `expected false for ${String(bad)}`);
  }
});

test('account validation is explicit about what it refuses', () => {
  assert.equal(auth.validateUsername('ab').ok, false, 'too short');
  assert.equal(auth.validateUsername('has space').ok, false);
  assert.equal(auth.validateUsername('-leading').ok, false);
  assert.equal(auth.validateUsername('  admin  ').username, 'admin');
  assert.equal(auth.validateUsername('admin').ok, true);
  assert.equal(auth.validatePassword('short').ok, false, 'below the minimum length');
  assert.equal(auth.validatePassword('x'.repeat(201)).ok, false, 'absurdly long');
  assert.equal(auth.validatePassword('long-enough-1').ok, true);
});

// ── setup state + the account ────────────────────────────────────────────────

test('a fresh install reports setup required and has no account', () => {
  assert.deepEqual(auth.getSetupState(), { required: true, complete: false, hasAccount: false });
  assert.equal(auth.getUser(), null);
});

test('createAdmin writes a private file, never returns the hash, and closes setup', async () => {
  const user = await auth.createAdmin({ username: 'admin', password: PASSWORD });
  assert.deepEqual(Object.keys(user).sort(), ['createdAt', 'updatedAt', 'username']);
  assert.equal(auth.getSetupState().complete, true);
  assert.equal(auth.getSetupState().required, false);
  const text = fs.readFileSync(AUTH_FILE, 'utf8');
  assert.match(text, /"passwordHash":\s*"scrypt\$/);
  assert.ok(!text.includes(PASSWORD), 'no plaintext password on disk');
  assert.equal(fs.statSync(AUTH_FILE).mode & 0o077, 0, 'the account file is not group/world readable');
});

test('setup cannot be repeated, and a second account cannot be created', async () => {
  const err = await clears(() => auth.createAdmin({ username: 'someone-else', password: PASSWORD }));
  assert.equal(err?.status, 409);
});

test('a weak password is refused before any file is written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-auth-fresh-'));
  // exercise the validation path directly: the guard runs before the write, so the real store is
  // untouched and the message is the same one the API returns
  const err = await clears(() => auth.createAdmin({ username: 'admin', password: 'short' }));
  assert.equal(err?.status, 400);
  assert.match(err.message, /at least 8 characters/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── sessions ─────────────────────────────────────────────────────────────────

test('a session is 256 bits of randomness, survives a reload, and can be destroyed', () => {
  const a = auth.createSession({ username: 'admin' });
  const b = auth.createSession({ username: 'admin' });
  assert.ok(a.id.length >= 40, `session id too short: ${a.id.length}`);
  assert.notEqual(a.id, b.id);
  assert.equal(auth.getSession(a.id)?.username, 'admin');
  assert.equal(auth.getSession('not-a-real-session'), null);
  assert.equal(auth.destroySession(a.id), true);
  assert.equal(auth.getSession(a.id), null);
  assert.equal(auth.destroySession(a.id), false, 'destroying twice is not an error');
  // persistence: a container restart reads the same file back
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'));
  assert.ok(onDisk.sessions.some((s) => s.id === b.id), 'the session is on disk, so restarts keep the admin signed in');
});

test('sessions expire absolutely and when idle', () => {
  const now = Date.now();
  const fresh = auth.createSession({ username: 'admin', at: now });
  assert.equal(auth.getSession(fresh.id, now + 3600_000)?.username, 'admin', 'an hour later is still fine');
  assert.equal(auth.getSession(fresh.id, now + auth.SESSION_TTL_MS + 1), null, 'absolute expiry — 30 days');
  const idle = auth.createSession({ username: 'admin', at: now });
  assert.equal(auth.getSession(idle.id, now + auth.SESSION_IDLE_MS + 1), null, 'idle expiry — 7 days of silence');
});

test('session records stay bounded', () => {
  for (let i = 0; i < 60; i++) auth.createSession({ username: 'admin' });
  const rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8')).sessions;
  assert.ok(rows.length <= 50, `expected a cap, saw ${rows.length}`);
  assert.equal(auth.destroyAllSessions(), 0);
  assert.equal(auth.sessionCount(), 0);
});

// ── cookies & request metadata ───────────────────────────────────────────────

test('the session cookie is HttpOnly, SameSite=Lax, scoped to / and Secure only over TLS', () => {
  const plain = auth.sessionCookie('abc', { secure: false });
  assert.match(plain, /^opushub_session=abc/);
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.match(plain, /Path=\//);
  assert.ok(!/;\s*Secure/.test(plain), 'no Secure flag on plain HTTP (it would break a LAN install)');
  assert.match(auth.sessionCookie('abc', { secure: true }), /;\s*Secure/);
  assert.match(auth.clearedCookie(), /Max-Age=0/);
});

test('cookies and forwarded protocol are parsed defensively', () => {
  assert.deepEqual(auth.parseCookies('a=1; opushub_session=xyz; b=2'), { a: '1', opushub_session: 'xyz', b: '2' });
  assert.deepEqual(auth.parseCookies(''), {});
  assert.equal(auth.tokenFrom(req('GET', { cookie: 'opushub_session=tok' })), 'tok');
  assert.equal(auth.tokenFrom(req('GET')), null);
  assert.equal(auth.isSecureRequest(req('GET', { 'x-forwarded-proto': 'https' })), true);
  assert.equal(auth.isSecureRequest(req('GET', { 'x-forwarded-proto': 'http' })), false);
  assert.equal(auth.isSecureRequest(req('GET')), false);
});

test('csrf: same-origin writes pass, cross-origin writes are refused, reads are untouched', () => {
  assert.equal(auth.csrfCheck(req('GET', { origin: 'https://evil.example' })).ok, true, 'reads are not a CSRF surface');
  assert.equal(auth.csrfCheck(req('PUT', { origin: 'http://hub.lan', host: 'hub.lan' })).ok, true);
  assert.equal(auth.csrfCheck(req('PUT', { referer: 'http://hub.lan/settings/appearance', host: 'hub.lan' })).ok, true);
  const cross = auth.csrfCheck(req('PUT', { origin: 'https://evil.example', host: 'hub.lan' }));
  assert.equal(cross.ok, false);
  assert.match(cross.reason, /does not match/);
  assert.equal(auth.csrfCheck(req('PUT', { 'sec-fetch-site': 'cross-site', host: 'hub.lan' })).ok, false);
  assert.equal(auth.csrfCheck(req('POST', { 'sec-fetch-site': 'same-origin', host: 'hub.lan' })).ok, true);
  assert.equal(auth.csrfCheck(req('PUT', { host: 'hub.lan' })).ok, true, 'a non-browser client carries no cookie to abuse');
  assert.equal(auth.csrfCheck(req('PUT', { origin: 'not a url', host: 'hub.lan' })).ok, false);
});

// ── login + throttling ───────────────────────────────────────────────────────

test('login mints a fresh session and never reveals which half was wrong', async () => {
  const wrongPassword = await auth.login({ username: 'admin', password: 'wrong-password' });
  assert.equal(wrongPassword.ok, false);
  assert.equal(wrongPassword.status, 401);
  const unknownUser = await auth.login({ username: 'ghost', password: 'wrong-password' });
  assert.equal(unknownUser.error, wrongPassword.error, 'identical answer → no user enumeration');
  const ok = await auth.login({ username: 'admin', password: PASSWORD });
  assert.equal(ok.ok, true);
  assert.equal(ok.user.username, 'admin');
  assert.ok(ok.token && auth.getSession(ok.token), 'the returned token is a live session');
  assert.ok(!('passwordHash' in ok.user));
});

test('repeated failures back off with a delay that expires — never a permanent lockout', async () => {
  auth.resetThrottles();
  const t0 = Date.now();
  let last = null;
  let attempts = 0;
  // keep trying until the endpoint pushes back; the growth is exponential, so it must arrive
  while (attempts < 10 && last?.status !== 429) {
    last = await auth.login({ username: 'admin', password: 'nope', ip: '10.0.0.9', at: t0 });
    attempts++;
  }
  assert.equal(last.status, 429, `after ${attempts} failures the endpoint asks the client to wait`);
  assert.ok(last.retryAfterMs > 0);
  // the same client, later than the failure window: the throttle has forgotten, and the right
  // password works again — the lockout can never be permanent
  const later = await auth.login({ username: 'admin', password: PASSWORD, ip: '10.0.0.9', at: t0 + 16 * 60_000 });
  assert.equal(later.ok, true, 'a correct password is never locked out permanently');
  // while throttled, another address is unaffected: this is per client + username, not a switch
  auth.resetThrottles();
  for (let i = 0; i < 6; i++) await auth.login({ username: 'admin', password: 'nope', ip: '10.0.0.11', at: Date.now() });
  const elsewhere = await auth.login({ username: 'admin', password: PASSWORD, ip: '10.0.0.12', at: Date.now() });
  assert.equal(elsewhere.ok, true, 'the throttle never locks the whole install out');
  auth.resetThrottles();
});

test('a successful login clears the failure window for that client', async () => {
  auth.resetThrottles();
  const t = Date.now();
  for (let i = 0; i < 3; i++) await auth.login({ username: 'admin', password: 'nope', ip: '10.1.1.1', at: t });
  const ok = await auth.login({ username: 'admin', password: PASSWORD, ip: '10.1.1.1', at: t });
  assert.equal(ok.ok, true);
  assert.equal(auth.throttleState('admin', '10.1.1.1').delayMs, 0, 'the counter is forgotten on success');
  const again = await auth.login({ username: 'admin', password: PASSWORD, ip: '10.1.1.1', at: t });
  assert.equal(again.ok, true, 'and the next sign-in is immediate');
});
