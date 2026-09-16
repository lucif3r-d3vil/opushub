// Confirmation — the "yes, I meant it" step, bound to the server's own state rather than to a
// boolean the browser sent.
//
// `confirmed: true` in a request body means nothing: a compromised page, a replayed request or a
// stale tab can all send it. A usable confirmation therefore has to be:
//
//   • minted server-side, only after the action and target have been authorized and validated
//   • bound to the session that asked for it (a token from another session is refused)
//   • bound to the exact action (a restart token cannot start or stop)
//   • bound to the exact target (a token for Jellyfin cannot be spent on Radarr)
//   • short-lived (two minutes; the window in which a human reads a dialog and clicks)
//   • single-use (spending it retires it, so a replay finds nothing)
//
// The token itself is an opaque random string; only its hash is kept, so nothing in memory can
// be replayed from a dump. Tokens live in memory only — a restart invalidates every outstanding
// confirmation, which is the right answer for a decision made by a person at a screen.
import crypto from 'node:crypto';
import { operationError } from './model.js';

const TTL_MS = 120_000;
const MAX_PENDING = 200;

/** token hash → record */
const pending = new Map();

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');

function sweep(at = Date.now()) {
  // A spent confirmation is kept until it expires, on purpose: knowing that a token was already
  // used is what turns a replay into "already used" instead of merely "not valid". Only expired
  // records are dropped; the cap is a backstop so a flood cannot grow the map without limit.
  for (const [k, rec] of pending) if (rec.expiresAt <= at) pending.delete(k);
  while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
}

/**
 * Issue a confirmation token for one (session, action, target) triple.
 *
 * Called only from the dry-run/request path — that is, only after the action is known, the actor
 * is authorized and the target has resolved to a real container.
 */
export function issue({ sessionId = null, actor = null, action = null, targetKey = null, opId = null, mode = 'normal', ttlMs = TTL_MS, at = Date.now() } = {}) {
  sweep(at);
  const token = crypto.randomBytes(32).toString('base64url');
  pending.set(hashToken(token), {
    sessionId: sessionId ? String(sessionId) : null,
    actor: actor ? String(actor) : null,
    action: action ? String(action) : null,
    targetKey: targetKey ? String(targetKey) : null,
    opId: opId ? String(opId) : null,
    mode,
    issuedAt: at,
    expiresAt: at + ttlMs,
    consumedAt: null,
  });
  return { token, expiresAt: at + ttlMs, ttlMs, mode };
}

/**
 * Spend a confirmation token.
 *
 * @returns {{ok:true, mode:string} | {ok:false, error:object}}
 */
export function verify({ token = null, sessionId = null, actor = null, action = null, targetKey = null, at = Date.now() } = {}) {
  if (typeof token !== 'string' || !token) {
    return { ok: false, error: operationError('confirmation_required', 'This operation has to be confirmed before it runs.') };
  }
  const rec = pending.get(hashToken(token));
  if (!rec) {
    return { ok: false, error: operationError('confirmation_invalid', 'That confirmation is not valid — open the operation again to confirm it.') };
  }
  if (rec.consumedAt) {
    return { ok: false, error: operationError('confirmation_used', 'That confirmation was already used. Confirm the operation again to repeat it.') };
  }
  if (rec.expiresAt <= at) {
    pending.delete(hashToken(token));
    return { ok: false, error: operationError('confirmation_expired', 'That confirmation expired. Confirm the operation again to continue.') };
  }
  if (rec.sessionId && String(sessionId) !== rec.sessionId) {
    return { ok: false, error: operationError('confirmation_session', 'That confirmation belongs to a different session.') };
  }
  if (rec.actor && String(actor) !== rec.actor) {
    return { ok: false, error: operationError('confirmation_session', 'That confirmation belongs to a different user.') };
  }
  if (rec.action !== String(action)) {
    return { ok: false, error: operationError('confirmation_mismatch', 'That confirmation was for a different action.') };
  }
  if (rec.targetKey !== String(targetKey)) {
    return { ok: false, error: operationError('confirmation_mismatch', 'That confirmation was for a different service.') };
  }
  // single use: spending it here is what makes a replay impossible
  rec.consumedAt = at;
  sweep(at);
  return { ok: true, mode: rec.mode || 'normal', issuedAt: rec.issuedAt };
}

/** Withdraw a confirmation without spending it (the user cancelled). */
export function cancel(token) {
  if (typeof token === 'string' && token) pending.delete(hashToken(token));
}

/**
 * Withdraw every confirmation issued for one operation.
 *
 * Cancelling an operation must also retire its token: a confirmation that outlives the operation
 * it was minted for is a credential looking for something to spend itself on.
 */
export function cancelByOperation(opId) {
  if (!opId) return 0;
  let n = 0;
  for (const [k, rec] of pending) {
    if (rec.opId === String(opId)) { pending.delete(k); n++; }
  }
  return n;
}

/** How many confirmations are outstanding — tests and diagnostics only, never a credential. */
export const pendingCount = () => pending.size;

/** Test helper. */
export function _resetConfirmations() { pending.clear(); }
export const _internals = { TTL_MS, MAX_PENDING };
