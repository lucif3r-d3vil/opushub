// Phase 11A — the privilege broker: what happens when a read hits EACCES.
//
// The rule this module exists to enforce: **a browser may ask for a read, never for a command.**
// A request carries exactly three things — a root id, a root-relative path, and one operation from
// the frozen vocabulary below. There is no field for an executable, arguments, a shell, an
// environment, a user, or a "run as root" flag, and `registerPrivilegedProvider()` *refuses* a
// provider spec that even names one of those fields. The broker then re-resolves the path through
// files/policy.js itself, so a grant can never be wider than the policy, and it only ever hands the
// provider a canonical path plus the operation it was asked for.
//
// Phase 11A registers **no** privileged provider. That is the honest state of a container install
// (and of a host where nobody has written one): asking produces `no_privileged_provider`, the
// request is recorded in the Activity log, and the UI says so in plain language. Nothing here fakes
// elevation, and nothing here runs `sudo`. If a real privileged provider is registered later — by
// server-side code, at boot — this module is the only door it is reached through.
//
// Grants are in-memory, session-bound, path-bound, operation-bound and short-lived
// (LIMITS.grantTtlMs at most). A restart, a logout or `retireSession()` ends them. They are not
// tokens: `execute()` requires the live session *and* a matching grant, so a grant id alone is
// worth nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { LIMITS } from './limits.js';
import { CLASS, resolve as resolvePath, STATUS_BY_CODE } from './policy.js';
import { getRoot, opushubDirs } from './roots.js';

/** The whole vocabulary. A privileged read is one of these three and nothing else. */
export const OPERATIONS = Object.freeze(['list', 'stat', 'read']);

export const OPERATION_LABELS = Object.freeze({
  list: 'list this directory',
  stat: 'read this file’s properties',
  read: 'read this file',
});

/**
 * Words a provider spec must never carry, as whole words. Registration refuses them outright, so
 * the shape of the broker cannot drift into "run this for me" by accident.
 *
 * Matching is per word (`rootId`, `sudoPassword`, `executeCommand` are all caught; `execute` and
 * `canGrant` — the two functions a spec legitimately has — are not), because a substring rule would
 * refuse the provider's own API.
 */
const FORBIDDEN_SPEC_WORDS = Object.freeze([
  'command', 'cmd', 'argv', 'args', 'shell', 'exec', 'executable', 'spawn', 'fork', 'sudo', 'su',
  'elevate', 'escalate', 'privilege', 'env', 'environment', 'user', 'uid', 'gid', 'root',
  'script', 'stdin', 'chmod', 'chown', 'write', 'delete', 'remove', 'mount',
]);

const wordsOf = (key) => String(key)
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[^A-Za-z0-9]+/g, ' ')
  .toLowerCase()
  .split(' ')
  .filter(Boolean);

const MAX_GRANTS_PER_SESSION = 8;
const MAX_GRANTS = 256;
const MAX_REASON_CHARS = 240;

const refuse = (code, reason, extra = {}) => ({
  ok: false, code, reason, status: STATUS_BY_CODE[code] ?? 400, ...extra,
});

/* ------------------------------------------------------------------ */
/* the privileged provider slot (server-side only)                     */
/* ------------------------------------------------------------------ */

let privileged = null;
let registeredAt = null;
const counters = { requested: 0, granted: 0, denied: 0, unavailable: 0, executed: 0, refusedSpecs: 0 };
const grants = new Map();   // grantId -> grant
let grantSeq = 0;

/** Every key in a spec, as whole words — functions are not traversed, only plain data. */
function specWords(obj, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return [];
  seen.add(obj);
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    out.push(...wordsOf(k));
    if (v && typeof v === 'object') out.push(...specWords(v, seen));
  }
  return out;
}

/**
 * Register (or, with `null`, remove) the privileged provider. **Server-side code only** — no API
 * route calls this, and the phase test asserts that no request handler can reach it.
 *
 * A spec is `{ id, label, operations?, async execute(req), async canGrant?(req) }`.
 */
export function registerPrivilegedProvider(spec) {
  if (spec == null) {
    privileged = null;
    registeredAt = null;
    grants.clear();
    return { ok: true, registered: null };
  }
  if (typeof spec !== 'object' || typeof spec.execute !== 'function' || typeof spec.id !== 'string' || !spec.id) {
    counters.refusedSpecs += 1;
    return { ok: false, code: 'bad_provider', reason: 'A privileged provider must be an object with an id and an execute() function.' };
  }
  // The mechanical guard: a spec that carries anything resembling a command is refused, so the
  // shape of the broker cannot drift into "run this for me" by accident.
  const bad = [...new Set(specWords(spec).filter((w) => FORBIDDEN_SPEC_WORDS.includes(w)))];
  if (bad.length) {
    counters.refusedSpecs += 1;
    return { ok: false, code: 'bad_provider', reason: `A privileged provider may not carry “${bad.slice(0, 4).join('”, “')}” — it accepts a path and a fixed operation, not a command.` };
  }
  const ops = (spec.operations || OPERATIONS).filter((o) => OPERATIONS.includes(o));
  if (!ops.length) {
    counters.refusedSpecs += 1;
    return { ok: false, code: 'bad_provider', reason: 'A privileged provider must support at least one of: list, stat, read.' };
  }
  privileged = Object.freeze({ id: spec.id, label: spec.label || spec.id, operations: Object.freeze(ops), execute: spec.execute, canGrant: typeof spec.canGrant === 'function' ? spec.canGrant : null });
  registeredAt = Date.now();
  return { ok: true, registered: { id: privileged.id, label: privileged.label, operations: [...privileged.operations] } };
}

/** The honest status of the privileged side. Rendered verbatim by the UI. */
export function privilegedStatus() {
  if (!privileged) {
    return {
      available: false,
      provider: null,
      operations: [...OPERATIONS],
      reason: 'OpusHub has no privileged filesystem provider on this host, so it cannot read a location its own user cannot. Nothing was elevated, and nothing will be: this is the honest answer.',
      registeredAt: null,
      grants: 0,
    };
  }
  return {
    available: true,
    provider: { id: privileged.id, label: privileged.label, operations: [...privileged.operations] },
    operations: [...privileged.operations],
    reason: null,
    registeredAt,
    grants: grants.size,
  };
}

export function hasPrivilegedProvider() { return privileged != null; }

/* ------------------------------------------------------------------ */
/* grants                                                              */
/* ------------------------------------------------------------------ */

const sweep = (now = Date.now()) => {
  for (const [id, g] of grants) if (g.expiresAt <= now) grants.delete(id);
};

function findGrant({ sessionId, rootId, path, operation, now = Date.now() }) {
  sweep(now);
  for (const g of grants.values()) {
    if (g.sessionId !== sessionId) continue;
    if (g.rootId !== rootId) continue;
    if (g.path !== path) continue;
    if (g.operation !== operation) continue;
    if (g.expiresAt <= now) continue;
    return g;
  }
  return null;
}

function createGrant({ sessionId, rootId, path, operation, ttlMs, now = Date.now() }) {
  sweep(now);
  // per-session cap: retire this session's oldest grant rather than accumulate
  const mine = [...grants.values()].filter((g) => g.sessionId === sessionId).sort((a, b) => a.expiresAt - b.expiresAt);
  for (const g of mine.slice(0, Math.max(0, mine.length - (MAX_GRANTS_PER_SESSION - 1)))) grants.delete(g.id);
  if (grants.size >= MAX_GRANTS) {
    const oldest = [...grants.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
    if (oldest) grants.delete(oldest.id);
  }
  const id = crypto.randomBytes(16).toString('base64url');
  const grant = {
    id,
    seq: ++grantSeq,
    sessionId,
    rootId,
    path,
    operation,
    createdAt: now,
    expiresAt: now + Math.max(1_000, Math.min(ttlMs || LIMITS.grantTtlMs, LIMITS.grantTtlMs)),
  };
  grants.set(id, grant);
  return grant;
}

/** Grants belonging to one session, as the UI may see them (no ids, no session handles). */
export function grantsFor(sessionId) {
  sweep();
  return [...grants.values()]
    .filter((g) => g.sessionId === sessionId)
    .sort((a, b) => b.expiresAt - a.expiresAt)
    .map((g) => ({ rootId: g.rootId, path: g.path, operation: g.operation, expiresAt: g.expiresAt, ttlMs: g.expiresAt - Date.now() }));
}

/** Called on logout: a session that is gone holds no grants. */
export function retireSession(sessionId) {
  let n = 0;
  for (const [id, g] of grants) if (g.sessionId === sessionId) { grants.delete(id); n += 1; }
  return n;
}

/** Called when every session is revoked at once: no grant outlives the sessions that asked for it. */
export function retireAllSessions() { const n = grants.size; grants.clear(); return n; }

export function stats() { return { ...counters, grants: grants.size, provider: privileged?.id || null }; }

export function _resetBroker() {
  privileged = null;
  registeredAt = null;
  grants.clear();
  grantSeq = 0;
  for (const k of Object.keys(counters)) counters[k] = 0;
}

/* ------------------------------------------------------------------ */
/* independent revalidation                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolve a request the broker's own way. The API layer has already resolved it; resolving again
 * here is the point — a grant is never based on somebody else's say-so.
 */
async function revalidate({ rootId, path, operation }, { mustExist = false } = {}) {
  if (!OPERATIONS.includes(operation)) return refuse('bad_operation', `A privileged request may only ask to ${OPERATIONS.map((o) => OPERATION_LABELS[o]).join(', ')}.`, { operation: String(operation || '').slice(0, 32) });
  const root = await getRoot(rootId);
  if (!root) return refuse('unknown_root', 'That is not a filesystem root OpusHub exposes.', { operation });
  const resolved = await resolvePath({ root, path, operation, opushubDirs: opushubDirs() });
  if (!resolved.ok) return resolved;
  if (mustExist && !resolved.exists) return refuse('not_found', 'Nothing is at that path.', { status: 404, operation });
  return { ok: true, root, resolved };
}

/** Can OpusHub's own process already read this? If so, no privilege is involved at all. */
async function alreadyReadable(resolved) {
  if (!resolved.exists) return true; // nothing to read: not a privilege question
  try {
    await fs.promises.access(resolved.canonical, fs.constants.R_OK);
    // a directory also has to be *openable*: x-only dirs pass access() but cannot be listed
    if (resolved.stat?.isDirectory()) {
      const h = await fs.promises.open(resolved.canonical, 'r');
      await h.close();
    }
    return true;
  } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* the two doors                                                       */
/* ------------------------------------------------------------------ */

/**
 * Ask for access to one path + one operation. Returns a state the UI renders verbatim:
 *
 *   granted       a live grant now covers this path and operation
 *   not_needed    OpusHub can already read it — nothing was asked for
 *   denied        the policy will not grant this (a protected path is never grantable)
 *   unavailable   no privileged provider exists on this host
 *   invalid       the request itself was malformed
 *
 * `onEvent(type, payload)` is how the caller records this in the Activity log; the broker decides
 * *when* an event is warranted, the caller decides how it is written.
 */
export async function requestPrivilege({ rootId = null, path = null, operation = null, reason = null, sessionId = null, actor = null, onEvent = null } = {}) {
  const emit = (type, severity, meta) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(type, {
        severity,
        meta: {
          root: typeof rootId === 'string' ? rootId.slice(0, 64) : null,
          path: typeof path === 'string' ? path.slice(0, LIMITS.maxPathLength) : null,
          operation: OPERATIONS.includes(operation) ? operation : null,
          actor: actor?.name || actor?.id || null,
          reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, MAX_REASON_CHARS) : null,
          ...meta,
        },
      });
    } catch { /* an event must never break the request */ }
  };

  counters.requested += 1;
  const op = OPERATIONS.includes(operation) ? operation : null;
  if (!op) {
    emit('files.privilege.requested', 'notice', { state: 'invalid', code: 'bad_operation' });
    return { ...refuse('bad_operation', `A privileged request must name one operation: ${OPERATIONS.join(', ')}.`), state: 'invalid' };
  }
  if (!sessionId) {
    emit('files.privilege.requested', 'notice', { state: 'invalid', code: 'auth_required' });
    return { ...refuse('auth_required', 'Sign in to request access.'), state: 'invalid' };
  }

  const v = await revalidate({ rootId, path, operation: op });
  if (!v.ok) {
    const state = v.code === 'protected_path' || v.code === 'symlink_escape' || v.code === 'mount_escape' || v.code === 'root_isolation' ? 'denied' : 'invalid';
    emit('files.privilege.requested', 'notice', { state, code: v.code });
    if (state === 'denied') emit('files.privilege.denied', 'warning', { code: v.code });
    // `grantable: false` is the part the UI acts on: a denied path is not waiting for a provider,
    // it is out of bounds, so "Request Access" must not be offered again.
    return { ...v, state, grantable: false, requestAccess: false };
  }

  const { root, resolved } = v;
  const cls = resolved.classification;

  // A protected path is never grantable, with or without a privileged provider. This is the line
  // between "OpusHub's user lacks permission" and "OpusHub must not look here at all".
  if (cls?.level === CLASS.PROTECTED) {
    counters.denied += 1;
    emit('files.privilege.requested', 'notice', { state: 'denied', code: 'protected_path', class: cls.class || null });
    emit('files.privilege.denied', 'warning', { code: 'protected_path', class: cls.class || null });
    return refuse('protected_path', 'This location is protected by policy. Access to it cannot be requested.', {
      state: 'denied', operation: op, class: cls.class || null, grantable: false,
      root: { id: root.id, label: root.label }, path: resolved.relative,
    });
  }

  if (await alreadyReadable(resolved)) {
    emit('files.privilege.requested', 'notice', { state: 'not_needed' });
    return {
      ok: true, state: 'not_needed', operation: op,
      root: { id: root.id, label: root.label }, path: resolved.relative,
      reason: 'OpusHub can already read this location — no privilege is involved.',
    };
  }

  if (!privileged) {
    counters.unavailable += 1;
    emit('files.privilege.requested', 'notice', { state: 'unavailable', code: 'no_privileged_provider' });
    emit('files.privilege.unavailable', 'notice', { code: 'no_privileged_provider' });
    return refuse('no_privileged_provider', privilegedStatus().reason, {
      state: 'unavailable', operation: op,
      root: { id: root.id, label: root.label }, path: resolved.relative,
      requested: true,
    });
  }

  // A real privileged provider exists. Ask it whether it will cover this, then grant narrowly.
  let can = { ok: true, granted: true, ttlMs: LIMITS.grantTtlMs, reason: null };
  if (privileged.canGrant) {
    try {
      can = await privileged.canGrant({ rootId: root.id, path: resolved.relative, canonical: resolved.canonical, operation: op, sessionId, actor: actor?.name || null });
    } catch { can = { ok: false, granted: false, reason: 'The privileged provider did not answer.' }; }
  }
  if (!can?.granted) {
    counters.denied += 1;
    emit('files.privilege.requested', 'notice', { state: 'denied', code: 'grant_refused' });
    emit('files.privilege.denied', 'warning', { code: 'grant_refused', provider: privileged.id });
    return refuse('not_permitted', can?.reason || 'The privileged provider declined this request.', {
      state: 'denied', operation: op, root: { id: root.id, label: root.label }, path: resolved.relative,
    });
  }

  const grant = createGrant({ sessionId, rootId: root.id, path: resolved.relative, operation: op, ttlMs: can.ttlMs });
  counters.granted += 1;
  emit('files.privilege.requested', 'notice', { state: 'granted', provider: privileged.id });
  emit('files.privilege.granted', 'notice', { provider: privileged.id, operation: op, ttlMs: grant.expiresAt - Date.now() });
  return {
    ok: true,
    state: 'granted',
    operation: op,
    root: { id: root.id, label: root.label },
    path: resolved.relative,
    provider: { id: privileged.id, label: privileged.label },
    expiresAt: grant.expiresAt,
    ttlMs: grant.expiresAt - Date.now(),
  };
}

/**
 * Perform one privileged read. Requires a live session **and** a live grant for exactly this
 * root/path/operation, re-resolves the path itself, and passes the provider nothing but
 * `{ rootId, path, canonical, operation, sessionId, signal }`.
 */
export async function execute({ rootId = null, path = null, operation = null, sessionId = null, signal = null } = {}) {
  if (!privileged) return refuse('no_privileged_provider', privilegedStatus().reason, { state: 'unavailable' });
  if (!sessionId) return refuse('auth_required', 'Sign in to use a privileged read.', { status: 401 });

  const op = OPERATIONS.includes(operation) ? operation : null;
  if (!op) return refuse('bad_operation', `A privileged read must name one operation: ${OPERATIONS.join(', ')}.`);
  if (!privileged.operations.includes(op)) return refuse('not_permitted', `The privileged provider on this host does not ${OPERATION_LABELS[op]}.`);

  const v = await revalidate({ rootId, path, operation: op }, { mustExist: false });
  if (!v.ok) return v;
  const { root, resolved } = v;
  if (resolved.classification?.level === CLASS.PROTECTED) {
    return refuse('protected_path', 'This location is protected by policy.', { class: resolved.classification.class || null, operation: op });
  }

  const grant = findGrant({ sessionId, rootId: root.id, path: resolved.relative, operation: op });
  if (!grant) {
    return refuse('grant_required', 'Access to this location was not granted, or the grant has expired. Ask again.', {
      operation: op, root: { id: root.id, label: root.label }, path: resolved.relative, requestAccess: true,
    });
  }

  let result;
  try {
    result = await privileged.execute({
      rootId: root.id,
      path: resolved.relative,
      canonical: resolved.canonical,
      operation: op,
      sessionId,
      signal,
    });
  } catch (err) {
    return refuse('provider_error', 'The privileged provider did not answer.', { status: 500, detail: err?.code || null });
  }
  if (!result?.ok) {
    const code = result?.code || 'provider_error';
    return refuse(code, result?.reason || 'The privileged read did not succeed.', { status: STATUS_BY_CODE[code] ?? 500, operation: op });
  }
  counters.executed += 1;
  return {
    ok: true,
    privileged: true,
    provider: { id: privileged.id, label: privileged.label },
    operation: op,
    root: { id: root.id, label: root.label },
    path: resolved.relative,
    grantExpiresAt: grant.expiresAt,
    result,
  };
}

export const _internals = Object.freeze({ findGrant, createGrant, revalidate, alreadyReadable, specWords, wordsOf, FORBIDDEN_SPEC_WORDS, MAX_GRANTS, MAX_GRANTS_PER_SESSION });
