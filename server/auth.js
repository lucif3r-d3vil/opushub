// Authentication — small, local, and boring on purpose.
//
// OpusHub exposes a complete view of a Docker host (inventory, logs, host vitals) and writes its
// own presentation config, so it needs a door. What it does NOT need is an identity provider: one
// administrator account, one session cookie, no database, no native dependency.
//
//   data/auth.json       the account (scrypt hash + salts) and the setup state
//   data/sessions.json   live sessions, so a container restart does not sign the admin out
//
// Where this lives matters: it is the *data* volume, not config/. The account is runtime state,
// not presentation config, and nothing here is ever read from or written to services.yaml.
//
// Security properties this file is responsible for (see docs/06-auth.md):
//   · passwords: scrypt (N=2^15, r=8, p=1, 64-byte key) with a per-account 16-byte salt, stored as
//     `scrypt$N$r$p$salt$hash` so the parameters can be raised later without invalidating accounts
//   · verification is timing-safe (crypto.timingSafeEqual) and runs the same cost whether or not
//     the username exists, so a wrong username cannot be told from a wrong password
//   · sessions: 32 random bytes (256 bits) from crypto.randomBytes, server-side records, HttpOnly
//     cookie, SameSite=Lax, Secure whenever the request arrived over TLS, absolute + idle expiry
//   · a fresh session id is always minted at login — a fixed id cannot be planted (no fixation)
//   · state-changing requests must be same-origin (Sec-Fetch-Site / Origin / Referer), which works
//     together with the SameSite cookie and JSON-only bodies as the CSRF defence
//   · login failures back off with an exponential *delay* that expires on its own; a correct
//     password always goes through, so an admin can never lock themselves out permanently
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './configStore.js';

export const SESSION_COOKIE = 'opushub_session';

const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');

// Absolute and idle lifetimes. Long enough that a homelab admin is not retyping a password daily,
// bounded so a forgotten browser does not stay logged in forever.
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const SESSION_IDLE_MS = 7 * 24 * 3600_000;
const MAX_SESSIONS = 50;

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const MAX_PASSWORD = 200;
const MIN_PASSWORD = 8;
const MIN_USER = 3;
const MAX_USER = 32;

const now = () => Date.now();

// ---------------------------------------------------------------------------
// small fs helpers — atomic, private, never throwing on a missing file
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonPrivate(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort (e.g. a filesystem without modes) */ }
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// passwords
// ---------------------------------------------------------------------------

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$N$r$p$saltB64$hashB64` — self-describing, so parameters can be raised later. */
export async function hashPassword(password, params = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, params);
  return ['scrypt', params.N, params.r, params.p, b64(salt), b64(key)].join('$');
}

/** Timing-safe verification. A malformed or unknown hash is a failed login, not a crash. */
export async function verifyPassword(stored, password) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const params = { N: Number(n), r: Number(r), p: Number(p), keylen: 0 };
  let expected;
  let salt;
  try {
    salt = Buffer.from(saltB64, 'base64url');
    expected = Buffer.from(hashB64, 'base64url');
  } catch { return false; }
  if (!Number.isFinite(params.N) || !Number.isFinite(params.r) || !Number.isFinite(params.p)) return false;
  if (!salt.length || !expected.length) return false;
  params.keylen = expected.length;
  let actual;
  try { actual = await scrypt(password, salt, params); } catch { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A hash of a random password: verified against when the username does not exist, so the cost
 *  (and therefore the response time) of "no such user" matches "wrong password". */
let dummyHashPromise = null;
function dummyHash() {
  dummyHashPromise ||= hashPassword(crypto.randomBytes(24).toString('base64url'));
  return dummyHashPromise;
}

export function validateUsername(raw) {
  const username = typeof raw === 'string' ? raw.trim() : '';
  if (username.length < MIN_USER || username.length > MAX_USER) {
    return { ok: false, reason: `Username must be between ${MIN_USER} and ${MAX_USER} characters.` };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(username)) {
    return { ok: false, reason: 'Username may use letters, digits, dot, dash and underscore.' };
  }
  return { ok: true, username };
}

export function validatePassword(raw) {
  const password = typeof raw === 'string' ? raw : '';
  if (password.length < MIN_PASSWORD) return { ok: false, reason: `Password must be at least ${MIN_PASSWORD} characters.` };
  if (password.length > MAX_PASSWORD) return { ok: false, reason: `Password must be at most ${MAX_PASSWORD} characters.` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// the account + the setup state (data/auth.json)
// ---------------------------------------------------------------------------

function readAuth() {
  return readJson(AUTH_FILE, { version: 1, setup: { complete: false, completedAt: null }, user: null });
}

function writeAuth(doc) {
  writeJsonPrivate(AUTH_FILE, doc);
  return doc;
}

/** The public account shape. The password hash never leaves this module. */
function publicUser(user) {
  if (!user) return null;
  return { username: user.username, createdAt: user.createdAt, updatedAt: user.updatedAt };
}

export function getUser() {
  return publicUser(readAuth().user);
}

export function getSetupState() {
  const doc = readAuth();
  return {
    required: !doc.setup?.complete || !doc.user,
    complete: !!doc.setup?.complete && !!doc.user,
    hasAccount: !!doc.user,
  };
}

/**
 * Create the administrator account and mark setup complete — the one bootstrap mutation there is.
 * Refuses once an account exists, so there is no public path back to account creation.
 */
export async function createAdmin({ username, password, at = now() }) {
  const u = validateUsername(username);
  if (!u.ok) throw Object.assign(new Error(u.reason), { status: 400 });
  const p = validatePassword(password);
  if (!p.ok) throw Object.assign(new Error(p.reason), { status: 400 });
  const doc = readAuth();
  if (doc.user || doc.setup?.complete) {
    throw Object.assign(new Error('OpusHub is already set up. Sign in with the existing administrator account.'), { status: 409 });
  }
  const passwordHash = await hashPassword(password);
  const next = writeAuth({
    version: 1,
    setup: { complete: true, completedAt: new Date(at).toISOString() },
    user: { username: u.username, passwordHash, createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString() },
  });
  return publicUser(next.user);
}

// ---------------------------------------------------------------------------
// sessions (data/sessions.json)
// ---------------------------------------------------------------------------

/**
 * Live sessions, held in memory and mirrored to disk.
 *
 * Why the cache: `authenticate()` runs on *every* request — including a dashboard that polls
 * five endpoints a second apart — and re-reading + re-parsing a JSON file for each of them is
 * pure waste. The file is therefore read once per process and thereafter treated as the
 * persistence of this process's own state (OpusHub is a single process by design; sharing one
 * data directory between two instances is not supported, and the README says so).
 *
 * Structural changes (create / destroy / revoke) are written *synchronously*: the file on disk is
 * never behind on who is signed in, so a restart cannot resurrect a session an admin revoked.
 * Only the idle timestamp is debounced, because losing 60 s of it is a nuisance and not a hole.
 */
let sessionCache = null;
let flushTimer = null;

function readSessionsFromDisk() {
  const doc = readJson(SESSION_FILE, { version: 1, sessions: [] });
  return Array.isArray(doc.sessions) ? doc.sessions : [];
}

function readSessions() {
  if (sessionCache) return sessionCache;
  sessionCache = readSessionsFromDisk();
  return sessionCache;
}

/** In-memory only — the caller decides when the file is written. */
function normalize(rows) {
  return rows
    .filter((s) => s && typeof s.id === 'string' && s.expiresAt > now())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_SESSIONS);
}

/** Persist the current set. Returns the (bounded, unexpired) rows actually kept. */
function writeSessions(rows = readSessions()) {
  const live = normalize(rows);
  sessionCache = live;
  try { writeJsonPrivate(SESSION_FILE, { version: 1, sessions: live }); } catch { /* a session that
    cannot be persisted still works in memory; losing it on restart is a nuisance, not a security
    hole, and failing the login because a disk is read-only would be worse. */ }
  return live;
}

/** The idle clock is the only thing that does not need to hit the disk on every request. */
function scheduleIdleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeSessions();
  }, 60_000);
  flushTimer.unref?.();
}

/** Mint a session. A new random id every time — this is also the session-fixation defence. */
export function createSession({ username, ip = null, at = now() } = {}) {
  const session = {
    id: crypto.randomBytes(32).toString('base64url'),
    username,
    createdAt: at,
    lastSeenAt: at,
    expiresAt: at + SESSION_TTL_MS,
    ip: ip ? String(ip).slice(0, 60) : null,
  };
  writeSessions([session, ...readSessions()]);
  return session;
}

/** Look a session up, enforce both lifetimes and refresh the idle clock (flushed lazily). */
export function getSession(token, at = now()) {
  if (typeof token !== 'string' || token.length < 16) return null;
  const rows = readSessions();
  const found = rows.find((s) => s.id === token);
  if (!found) return null;
  if (found.expiresAt <= at || at - found.lastSeenAt > SESSION_IDLE_MS) {
    writeSessions(rows.filter((s) => s.id !== token));
    return null;
  }
  found.lastSeenAt = at;
  scheduleIdleFlush();
  return found;
}

export function destroySession(token) {
  const rows = readSessions();
  const next = rows.filter((s) => s.id !== token);
  writeSessions(next);
  return rows.length !== next.length;
}

export function destroyAllSessions() {
  return writeSessions([]).length;
}

export function sessionCount() {
  return readSessions().length;
}

/**
 * A stable, non-reversible handle for a session — what the UI lists and revokes by.
 *
 * The session token is a bearer credential: putting it in an API response (even to the admin who
 * owns it) would spread it into logs, screenshots and browser history. A truncated SHA-256 of the
 * token names the same session without being usable to authenticate, and it cannot be reversed.
 */
export function sessionHandle(token) {
  if (typeof token !== 'string' || !token) return null;
  return crypto.createHash('sha256').update(token).digest('base64url').slice(0, 16);
}

/** Every live session, described for display. `current` marks the one making the request. */
export function listSessions(currentToken = null) {
  const at = now();
  const rows = readSessions().filter((s) => s.expiresAt > at);
  return rows
    .map((s) => ({
      id: sessionHandle(s.id),
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      idleExpiresAt: Math.min(s.expiresAt, s.lastSeenAt + SESSION_IDLE_MS),
      ip: s.ip || null,
      current: !!currentToken && s.id === currentToken,
    }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/** Revoke by handle (never by token), or everything except one. Returns how many were removed. */
export function revokeSessions({ handles = [], except = null } = {}) {
  const wanted = new Set((handles || []).map(String));
  const rows = readSessions();
  const keep = rows.filter((s) => {
    if (except && s.id === except) return true;
    if (!wanted.size) return false;      // no handle filter = "all" (of what `except` spares)
    return !wanted.has(sessionHandle(s.id));
  });
  const removed = rows.length - keep.length;
  writeSessions(keep);
  return removed;
}

/**
 * Change the administrator's password.
 *
 * The current password is required even though the caller already holds a session: a borrowed
 * browser must not be able to lock the owner out of their own Hub. Every other session is revoked
 * (a stolen cookie does not survive a password change) and the presented session is retired so the
 * caller is re-minted — the same no-fixation rule as sign-in.
 */
export async function changePassword({ currentPassword, newPassword, token = null, ip = null, at = now() }) {
  const doc = readAuth();
  const user = doc.user;
  if (!user) throw Object.assign(new Error('No administrator account exists yet.'), { status: 409 });
  const ok = await verifyPassword(user.passwordHash, typeof currentPassword === 'string' ? currentPassword : '');
  if (!ok) {
    return { ok: false, status: 401, error: 'The current password is incorrect.' };
  }
  const p = validatePassword(newPassword);
  if (!p.ok) return { ok: false, status: 400, error: p.reason };
  if (typeof newPassword === 'string' && typeof currentPassword === 'string' && newPassword === currentPassword) {
    return { ok: false, status: 400, error: 'The new password is the same as the current one.' };
  }
  const passwordHash = await hashPassword(newPassword);
  writeAuth({
    ...doc,
    user: { ...user, passwordHash, updatedAt: new Date(at).toISOString() },
  });
  // Every session dies — the other devices immediately, and the presented id too (it is retired
  // and replaced below, exactly like sign-in: a token that existed before a credential change is
  // not carried across it). `revoked` counts what the admin would call "the other sessions".
  const revoked = readSessions().filter((s) => s.id !== token).length;
  writeSessions([]);
  const session = createSession({ username: user.username, ip, at });
  return { ok: true, user: publicUser(doc.user), token: session.id, expiresAt: session.expiresAt, revoked };
}

// ---------------------------------------------------------------------------
// cookies & requests
// ---------------------------------------------------------------------------

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    out[k] = v;
  }
  return out;
}

/** True when this request arrived over TLS (directly or through a proxy that said so). */
export function isSecureRequest(req) {
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (proto) return proto === 'https';
  return !!req?.socket?.encrypted;
}

export function sessionCookie(token, { maxAgeMs = SESSION_TTL_MS, secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** The cookie token on this request, if any. */
export function tokenFrom(req) {
  const cookies = parseCookies(req?.headers?.cookie);
  return cookies[SESSION_COOKIE] || null;
}

/** Resolve the request's session → `{ username, session }`, or null. Never throws. */
export function authenticate(req) {
  try {
    const token = tokenFrom(req);
    if (!token) return null;
    const session = getSession(token);
    if (!session) return null;
    return { username: session.username, session };
  } catch {
    return null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for state-changing requests. Three independent layers, all cheap:
 *   1. SameSite=Lax session cookie — a cross-site POST does not carry the session at all
 *   2. `Sec-Fetch-Site` (any modern browser) must be `same-origin`/`none` when present
 *   3. `Origin` (or `Referer`) must name the host this request was addressed to
 * A request that carries none of those headers is a non-browser client (curl, a script); it has
 * no ambient cookie to abuse, so it is allowed and the session check still applies.
 */
export function csrfCheck(req) {
  const method = String(req?.method || 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true };
  const site = String(req?.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') {
    return { ok: false, reason: 'cross-site request refused' };
  }
  const origin = String(req?.headers?.origin || '').trim();
  const referer = String(req?.headers?.referer || '').trim();
  const source = origin || referer;
  if (!source) return { ok: true };
  let host;
  try { host = new URL(source).host.toLowerCase(); } catch { return { ok: false, reason: 'unparseable origin' }; }
  const target = String(req?.headers?.host || '').toLowerCase();
  if (!target) return { ok: false, reason: 'missing host header' };
  if (host !== target) return { ok: false, reason: `origin ${host} does not match ${target}` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// login + throttling
// ---------------------------------------------------------------------------

// A delay-only throttle: failures grow the wait up to 30s, the window expires on its own after
// 15 minutes, and a correct password always succeeds (after the wait). There is no permanent
// lockout, because the operator of a homelab box is often the only person who can unlock it.
const FAIL_WINDOW_MS = 15 * 60_000;
const FREE_ATTEMPTS = 4;          // failures before any delay at all
const MAX_DELAY_MS = 30_000;
const attempts = new Map();       // key → { fails, at }

const throttleKey = (username, ip) => `${String(username || '').toLowerCase()}|${ip || 'unknown'}`;

export function throttleDelay(key, at = now()) {
  const row = attempts.get(key);
  if (!row) return 0;
  if (at - row.at > FAIL_WINDOW_MS) { attempts.delete(key); return 0; }
  if (row.fails <= FREE_ATTEMPTS) return 0;
  return Math.min(MAX_DELAY_MS, 500 * 2 ** (row.fails - FREE_ATTEMPTS));
}

function recordFailure(key, at = now()) {
  const row = attempts.get(key);
  if (!row || at - row.at > FAIL_WINDOW_MS) attempts.set(key, { fails: 1, at });
  else { row.fails += 1; row.at = at; }
  return attempts.get(key).fails;
}

export function clearThrottle(key) { attempts.delete(key); }
export function resetThrottles() { attempts.clear(); }

/** Test/ops visibility into the throttle state (never exposes anything secret). */
export function throttleState(username, ip) {
  const key = throttleKey(username, ip);
  return { delayMs: throttleDelay(key), until: attempts.get(key)?.at ? attempts.get(key).at + FAIL_WINDOW_MS : null };
}

/**
 * Verify credentials and mint a session.
 * @returns {{ok:true, user, token, expiresAt} | {ok:false, status:number, error:string, retryAfterMs?:number}}
 */
export async function login({ username, password, ip = null, at = now() }) {
  const key = throttleKey(username, ip);
  const delay = throttleDelay(key, at);
  if (delay > 0) {
    if (delay > 1_000) {
      return {
        ok: false, status: 429, retryAfterMs: delay,
        error: `Too many failed attempts. Try again in ${Math.ceil(delay / 1000)} second${delay > 2000 ? 's' : ''}.`,
      };
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  const doc = readAuth();
  const user = doc.user;
  const supplied = typeof username === 'string' ? username.trim() : '';
  // Always run one scrypt verification, even with no account, so timing does not answer
  // "does this username exist?" for us.
  const candidate = user && user.username.toLowerCase() === supplied.toLowerCase() ? user.passwordHash : await dummyHash();
  const ok = await verifyPassword(candidate, typeof password === 'string' ? password : '');
  if (!user || !ok || user.username.toLowerCase() !== supplied.toLowerCase()) {
    const fails = recordFailure(key, at);
    return { ok: false, status: 401, error: 'Incorrect username or password.', failures: fails };
  }
  clearThrottle(key);
  const session = createSession({ username: user.username, ip, at });
  return { ok: true, user: publicUser(user), token: session.id, expiresAt: session.expiresAt };
}

/** Used by tests and by the (deliberately absent) API surface: never exported over HTTP. */
export function _internals() {
  return { AUTH_FILE, SESSION_FILE, SCRYPT, FREE_ATTEMPTS, FAIL_WINDOW_MS };
}
