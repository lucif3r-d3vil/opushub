// Operation locks, duplicate suppression and rate limiting.
//
// Three separate protections, because they answer three different questions:
//
//   1. "Is something already happening to this container?"      → a per-target lock.
//      Clicking Restart three times must produce one restart. Starting and stopping the same
//      container at the same time must not be possible either, so the lock is per *container*,
//      not per action.
//   2. "Is this session asking too often?"                       → a sliding-window rate limit.
//   3. "Is this target failing over and over?"                   → a short back-off, so a
//      container that refuses to stop cannot be hammered by a retry loop.
//
// All state is in memory with a TTL. That is deliberate: if the process dies, the locks die with
// it. A lock that outlived the process would be a permanent "already in progress" with nothing
// in progress to release it, which is a worse failure than the duplicate it was guarding against.
// The operation record on disk is what survives, and `store.recoverInterrupted()` explains it.
const LOCK_TTL_MS = 120_000;      // a container lock never outlives two minutes
const WINDOW_MS = 30_000;         // rate-limit window
const MAX_PER_WINDOW = 12;        // operations per session per window (the UI allows ~1/second)
const FAIL_BACKOFF_MS = 30_000;   // after repeated failures on one target
const FAIL_THRESHOLD = 3;

/** containerId → { action, opId, at, expiresAt } */
const locks = new Map();
/** sessionId → timestamps[] */
const windows = new Map();
/** containerId → { fails, until } */
const backoff = new Map();
const MAX_TRACKED = 500;

function sweep(at = Date.now()) {
  for (const [k, l] of locks) if (l.expiresAt <= at) locks.delete(k);
  for (const [k, w] of windows) {
    const kept = w.filter((t) => at - t < WINDOW_MS);
    if (kept.length) windows.set(k, kept); else windows.delete(k);
  }
  for (const [k, b] of backoff) if (b.until && b.until <= at) backoff.delete(k);
  while (locks.size > MAX_TRACKED) locks.delete(locks.keys().next().value);
  while (windows.size > MAX_TRACKED) windows.delete(windows.keys().next().value);
  while (backoff.size > MAX_TRACKED) backoff.delete(backoff.keys().next().value);
}

const lc = (v) => String(v ?? '').toLowerCase();

/**
 * Take the lock for a container. Returns `{ ok: true }` or `{ ok: false, holder }` where the
 * holder says what is already running — the UI turns that into "Restart already in progress".
 */
export function acquire(containerId, { opId = null, action = null, at = Date.now(), ttlMs = LOCK_TTL_MS } = {}) {
  sweep(at);
  const key = lc(containerId);
  const held = locks.get(key);
  if (held && held.expiresAt > at) return { ok: false, holder: { opId: held.opId, action: held.action, since: held.at } };
  locks.set(key, { action, opId, at, expiresAt: at + ttlMs });
  return { ok: true };
}

export function release(containerId, opId = null) {
  const key = lc(containerId);
  const held = locks.get(key);
  if (!held) return false;
  if (opId && held.opId && held.opId !== opId) return false; // someone else owns it now
  locks.delete(key);
  return true;
}

/** Who holds the lock, if anybody. Used by dry-run to say "already in progress" up front. */
export function holder(containerId) {
  sweep();
  const held = locks.get(lc(containerId));
  return held ? { opId: held.opId, action: held.action, since: held.at, expiresAt: held.expiresAt } : null;
}

/** Extend a lock still doing legitimate work (a long verification). */
export function touch(containerId, { opId = null, at = Date.now(), ttlMs = LOCK_TTL_MS } = {}) {
  const key = lc(containerId);
  const held = locks.get(key);
  if (!held) return false;
  if (opId && held.opId && held.opId !== opId) return false;
  held.expiresAt = at + ttlMs;
  return true;
}

/**
 * Rate limit per session. Counts *attempts that reached the engine* — a rejected action is
 * still a request, and a flood of unknown actions should be throttled too.
 */
export function checkRate(sessionId, { at = Date.now() } = {}) {
  sweep(at);
  const key = lc(sessionId || 'anonymous');
  const hits = (windows.get(key) || []).filter((t) => at - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    const retryAfterMs = WINDOW_MS - (at - hits[0]);
    return { ok: false, retryAfterMs, count: hits.length };
  }
  hits.push(at);
  windows.set(key, hits);
  return { ok: true, count: hits.length, remaining: MAX_PER_WINDOW - hits.length };
}

/** Record a failure against a target and apply the back-off when it repeats. */
export function recordFailure(containerId, { at = Date.now() } = {}) {
  const key = lc(containerId);
  const row = backoff.get(key) || { fails: 0, until: 0 };
  row.fails += 1;
  if (row.fails >= FAIL_THRESHOLD) row.until = at + FAIL_BACKOFF_MS;
  backoff.set(key, row);
  return row;
}

/** Clear the failure counter — a success means the target is healthy again. */
export function clearFailures(containerId) {
  backoff.delete(lc(containerId));
}

/** Whether a target is inside its back-off window. */
export function backoffState(containerId, { at = Date.now() } = {}) {
  sweep(at);
  const row = backoff.get(lc(containerId));
  if (!row || !row.until || row.until <= at) return { ok: true };
  return { ok: false, retryAfterMs: row.until - at, fails: row.fails };
}

/** Test helpers. */
export function _resetLimits() { locks.clear(); windows.clear(); backoff.clear(); }
/** Test helper: forget the rate window and backoff only — held locks stay held. */
export function _resetRate() { windows.clear(); backoff.clear(); }
export const _internals = { LOCK_TTL_MS, WINDOW_MS, MAX_PER_WINDOW, FAIL_BACKOFF_MS, FAIL_THRESHOLD };
