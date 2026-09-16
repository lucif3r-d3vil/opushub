// Operation store — the live operations plus a bounded persisted history.
//
// In memory: every operation of this process, keyed by id, capped.
// On disk:   data/operations.jsonl, append-only per phase transition, bounded by count and bytes.
//
// There is deliberately no delete: nothing in the UI can remove an operation record. Retention is
// the same idea as the activity log — keep a bounded recent window, trim the oldest, never grow
// without limit, and never silently rewrite what happened.
//
// A crash leaves the last record mid-flight; `recoverInterrupted()` runs at boot and says so
// honestly instead of leaving an operation that appears to be running forever.
import { TERMINAL, isWellFormedOperationId, publicOperationRow } from './model.js';
import { appendAudit, readAudit, _resetAudit } from './audit.js';

const MAX_LIVE = 200;        // operations held in memory for polling
const MAX_LINES = 2000;      // records kept on disk (audit.js trims to this)

/** id → operation record */
const live = new Map();
/** ids in insertion order, so trimming can drop the oldest */
const order = [];
let tail = 0; // a monotonic tiebreaker so two operations in the same millisecond stay ordered

/** Remember an operation. Returns the record unchanged. */
export function put(op) {
  if (!op || !isWellFormedOperationId(op.id)) return op;
  if (!live.has(op.id)) order.push(op.id);
  live.set(op.id, op);
  while (order.length > MAX_LIVE) live.delete(order.shift());
  return op;
}

export function get(id) {
  return (id && live.get(id)) || null;
}

/** Mutate a stored operation through a function, so transitions happen in one place. */
export function update(id, fn) {
  const op = get(id);
  if (!op) return null;
  const next = fn(op) || op;
  live.set(id, next);
  return next;
}

/**
 * Every stored operation, newest first. `limit` is clamped — the Operations panel asks for a
 * small number and the API never returns the whole unbounded set.
 */
export function list({ limit = 50, action = null, target = null, status = null } = {}) {
  const n = Math.min(MAX_LIVE, Math.max(1, Number(limit) || 50));
  const wantAction = action ? String(action) : null;
  const wantStatus = status ? String(status) : null;
  const wantTarget = target ? String(target).toLowerCase() : null;
  const rows = [];
  for (let i = order.length - 1; i >= 0 && rows.length < n; i--) {
    const op = live.get(order[i]);
    if (!op) continue;
    if (wantAction && op.action !== wantAction) continue;
    if (wantStatus && op.status !== wantStatus) continue;
    if (wantTarget) {
      const t = op.target || {};
      const names = [t.id, t.containerName, t.service, t.label].filter(Boolean).map((x) => String(x).toLowerCase());
      if (!names.some((x) => x === wantTarget)) continue;
    }
    rows.push(publicOperationRow(op));
  }
  return rows;
}

/** Operations that are still doing something — the "Running" band of the Operations panel. */
export function inFlight() {
  const out = [];
  for (const id of order) {
    const op = live.get(id);
    if (op && !TERMINAL.has(op.status)) out.push(publicOperationRow(op));
  }
  return out;
}

/** How many operations this process has seen (bounded by MAX_LIVE). */
export const size = () => order.length;

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

/**
 * Persist a phase of an operation. One line per phase transition, so an operation's history
 * survives a restart even if the process dies mid-operation.
 *
 * The write goes through the audit module, which is the only writer and the only reader of the
 * file: one bounded, append-only trail for every operation phase.
 */
export function append(op, phase = 'completed', extra = {}) {
  if (!op) return null;
  return appendAudit(op, phase, { ...extra, seq: ++tail });
}

/**
 * The persisted history, newest first.
 *
 * `target` matches the recorded target's id or container name — used by Service Detail's
 * "recent operations" list.
 */
export function history({ limit = 50, target = null, action = null } = {}) {
  return readAudit({ limit, target, action });
}

/**
 * Boot recovery.
 *
 * An operation that was in flight when the process stopped can never be completed by this
 * process, and its Docker call may or may not have reached the engine. Leaving it "running"
 * forever would be a lie; deleting it would be a lie too. So the trail gains one honest record:
 * interrupted, outcome unknown, check the container before repeating.
 *
 * This reads only the audit trail, because that is what survives a restart — the in-memory
 * operations do not.
 */
export function recoverInterrupted({ at = Date.now() } = {}) {
  const latest = new Map(); // opId → newest audit record
  for (const rec of readAudit({ limit: 2000 })) {
    if (!rec?.opId) continue;
    const cur = latest.get(rec.opId);
    if (!cur || rec.t > cur.t) latest.set(rec.opId, rec);
  }
  const recovered = [];
  for (const rec of latest.values()) {
    if (TERMINAL.has(rec.status)) continue;
    const op = {
      id: rec.opId,
      action: rec.action || null,
      target: rec.target || null,
      actor: rec.actor || null,
      status: 'failed',
      requestedAt: rec.t,
      durationMs: null,
      verification: { state: null, health: null, verified: false, note: 'unknown — the process restarted' },
      error: {
        code: 'interrupted',
        reason: 'OpusHub restarted while this operation was in progress.',
        detail: 'The Docker call may or may not have completed. Check the container\u2019s current state before repeating it.',
      },
    };
    appendAudit(op, 'interrupted', { at, note: 'operation was in flight when the process stopped' });
    // if this process happens to hold the record too, settle it as well
    if (live.has(op.id)) {
      live.set(op.id, { ...live.get(op.id), status: 'failed', completedAt: at, error: op.error, verification: op.verification });
    }
    recovered.push(op.id);
  }
  return recovered;
}

/** Test helper — the store is process-global state. */
export function _resetStore() {
  live.clear();
  order.length = 0;
  tail = 0;
  _resetAudit();
}

export function _internals() {
  return { MAX_LIVE, MAX_LINES };
}
