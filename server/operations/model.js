// The canonical operation record.
//
// One object per requested operation, whatever happens to it: rejected, refused confirmation,
// executed, timed out, or failed. The record is the single thing the API returns, the audit log
// appends to, and the UI renders — so a rejection and a success are described by the same shape
// and there is no path where an operation can happen without a record of it.
import crypto from 'node:crypto';

/** Every status an operation can hold. Terminal statuses never move again. */
export const STATUSES = Object.freeze([
  'pending',                 // created, not yet evaluated
  'awaiting_confirmation',   // authorized and valid, waiting for a server-bound confirmation
  'authorized',              // approved to run (recorded between confirmation and execution)
  'running',                 // the Docker call is in flight
  'succeeded',               // executed and the resulting state was verified
  'failed',                  // executed (or attempted) and did not reach the expected state
  'rejected',                // refused before execution — policy, permission, target, or limits
  'cancelled',               // the user dismissed the confirmation
  'timed_out',               // bounded time elapsed; the state was re-read and reported honestly
]);

export const TERMINAL = Object.freeze(new Set(['succeeded', 'failed', 'rejected', 'cancelled', 'timed_out']));

/** Statuses in which an operation is still doing something (used for locks and the UI). */
export const IN_FLIGHT = Object.freeze(new Set(['pending', 'authorized', 'running']));

export const isTerminal = (status) => TERMINAL.has(status);
export const isInFlight = (status) => IN_FLIGHT.has(status);

// Operation ids are shown to the operator ("Operation #op-…") and used in URLs, so they must be
// unique, unguessable enough not to be a lookup oracle, and free of anything that looks like a
// container name, a path or a secret.
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish: no i, l, o, u

/** A short, unique, display-safe operation id: `op-<day>-<7 random chars>`. */
export function newOperationId(at = Date.now()) {
  const bytes = crypto.randomBytes(7);
  let tail = '';
  for (const b of bytes) tail += ID_ALPHABET[b % ID_ALPHABET.length];
  const day = new Date(at).toISOString().slice(0, 10).replace(/-/g, '');
  return `op-${day}-${tail}`;
}

/** Guard against a caller reusing an id (it is the key of the store and the audit log). */
export function isWellFormedOperationId(id) {
  return typeof id === 'string' && /^op-\d{8}-[0-9a-hjkmnp-tv-z]{7}$/.test(id);
}

/**
 * Create an operation record. Nothing here trusts its input beyond shape checks: the caller
 * (the engine) has already resolved the action and the target.
 */
export function createOperation({ action, target, actor, sessionId, at = Date.now(), dryRun = false }) {
  return {
    id: newOperationId(at),
    action,
    target: target ? { ...target } : null,
    actor: actor ?? null,
    // the session *handle*, never the token — enough to correlate, not enough to impersonate
    sessionId: sessionId ?? null,
    requestedAt: at,
    startedAt: null,
    completedAt: null,
    status: 'pending',
    result: null,
    error: null,
    confirmation: { required: false, mode: 'none', tokenIssued: false, consumedAt: null },
    verification: null,
    dryRun: dryRun === true,
    durationMs: null,
    auditId: null,
  };
}

/**
 * A structured failure. `code` is machine-readable and stable; `reason` is what the operator
 * reads; `detail` is technical, sanitized, and only ever present when it helps.
 */
export function operationError(code, reason, detail = null) {
  const err = { code, reason };
  if (detail) err.detail = String(detail).slice(0, 300);
  return err;
}

/** The record as it crosses the API boundary — no internals, no Docker bodies, no paths. */
export function publicOperation(op) {
  if (!op) return null;
  return {
    id: op.id,
    action: op.action,
    target: op.target
      ? {
        type: op.target.type ?? null,
        id: op.target.id ?? null,
        label: op.target.label ?? null,
        group: op.target.group ?? null,
        service: op.target.service ?? null,
        stack: op.target.stack ?? null,
        containerName: op.target.containerName ?? null,
        state: op.target.state ?? null,
      }
      : null,
    actor: op.actor ?? null,
    status: op.status,
    requestedAt: op.requestedAt,
    startedAt: op.startedAt,
    completedAt: op.completedAt,
    durationMs: op.durationMs,
    result: op.result ?? null,
    error: op.error ?? null,
    verification: op.verification ?? null,
    confirmation: op.confirmation
      ? { required: !!op.confirmation.required, mode: op.confirmation.mode, consumed: !!op.confirmation.consumedAt }
      : null,
    auditId: op.auditId ?? null,
    dryRun: op.dryRun === true,
  };
}

/** A compact row for lists (Operations panel, Service Detail's recent operations). */
export function publicOperationRow(op) {
  const p = publicOperation(op);
  if (!p) return null;
  return {
    id: p.id,
    action: p.action,
    status: p.status,
    actor: p.actor,
    target: p.target,
    requestedAt: p.requestedAt,
    completedAt: p.completedAt,
    durationMs: p.durationMs,
    error: p.error,
    verification: p.verification,
  };
}
