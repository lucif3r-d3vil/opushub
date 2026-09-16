// Operation audit — one append-only record per phase of every operation.
//
// What is recorded
//   timestamp · actor · operation id · action · target · phase · status · reason · confirmation
//   · duration — and nothing else.
//
// What is never recorded (and could not be, because it is never passed in)
//   passwords, password hashes, session tokens, cookies, CSRF/confirmation tokens, environment
//   variables, Docker socket paths, request headers, request bodies, Docker response bodies.
//
// The record is built from an allow-list of fields rather than by copying whatever the operation
// happened to carry, so a new field on the operation object can never start leaking by accident.
//
// There is no delete. Retention is bounded by count and bytes, exactly like the activity log, and
// trimming drops the oldest records — never rewrites or edits them.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../configStore.js';

const FILE = path.join(DATA_DIR, 'operations.jsonl');
const MAX_LINES = 2000;
const KEEP = 1500;
const MAX_BYTES = 2 * 1024 * 1024;

/** The phases an operation passes through. One record per phase, in order. */
export const PHASES = Object.freeze([
  'requested', 'authorization', 'target', 'policy', 'confirmation',
  'execution', 'verification', 'completed',
]);

const TARGET_FIELDS = ['type', 'id', 'service', 'containerName', 'label', 'group', 'stack'];

/** Keep only known, safe fields — a whitelist, not a denylist. */
function safeTarget(target) {
  if (!target || typeof target !== 'object') return null;
  const out = {};
  for (const k of TARGET_FIELDS) {
    const v = target[k];
    if (v == null) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 160) : v;
  }
  return out;
}

function safeText(v, max = 300) {
  if (v == null) return null;
  return String(v).slice(0, max);
}

/**
 * Append one audit record.
 *
 * @param {object} op      the operation record
 * @param {string} phase   one of PHASES (or 'rejected'/'cancelled'/'interrupted')
 * @param {object} extra   optional: { at, note, code, reason, detail }
 */
export function appendAudit(op, phase, extra = {}) {
  const at = Number(extra.at) || Date.now();
  const rec = {
    id: `${op.id}:${phase}`,
    t: at,
    iso: new Date(at).toISOString(),
    opId: op.id,
    phase,
    actor: op.actor ?? null,
    action: op.action ?? null,
    target: safeTarget(op.target),
    status: op.status ?? null,
    // reason and code describe *why* — a rejection keeps its explanation, which is the point
    reason: safeText(extra.reason ?? op.error?.reason, 300),
    code: safeText(extra.code ?? op.error?.code, 80),
    detail: safeText(extra.detail ?? (op.error?.code ? op.error.detail : null), 300),
    confirmation: op.confirmation
      ? { required: !!op.confirmation.required, mode: op.confirmation.mode || 'none', consumed: !!op.confirmation.consumedAt }
      : null,
    durationMs: Number.isFinite(op.durationMs) ? op.durationMs : (op.startedAt ? at - op.startedAt : null),
    verification: op.verification
      ? {
        state: op.verification.state ?? null,
        health: op.verification.health ?? null,
        verified: op.verification.verified === true,
      }
      : null,
    note: safeText(extra.note, 300),
    dryRun: op.dryRun === true,
  };
  try {
    fs.appendFileSync(FILE, JSON.stringify(rec) + '\n');
    trim();
  } catch { /* an audit write must never break an operation */ }
  return rec;
}

function trim() {
  try {
    if (fs.statSync(FILE).size <= MAX_BYTES) {
      // count cap still applies: many small records are as unbounded as few large ones
      const text = fs.readFileSync(FILE, 'utf8');
      const count = text === '' ? 0 : text.trim().split('\n').length;
      if (count <= MAX_LINES) return;
      const lines = text.trim().split('\n').slice(-KEEP);
      fs.writeFileSync(FILE + '.tmp', lines.join('\n') + '\n');
      fs.renameSync(FILE + '.tmp', FILE);
      return;
    }
    const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').slice(-KEEP);
    fs.writeFileSync(FILE + '.tmp', lines.join('\n') + '\n');
    fs.renameSync(FILE + '.tmp', FILE);
  } catch { /* best effort */ }
}

/**
 * Read the audit trail, newest first.
 * `opId` narrows it to one operation — that is the "clicking an operation shows its result" view.
 */
export function readAudit({ limit = 100, opId = null, target = null, since = null } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
  const n = Math.min(MAX_LINES, Math.max(1, Number(limit) || 100));
  const wantTarget = target ? String(target).toLowerCase() : null;
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (opId && rec.opId !== opId) continue;
    if (since && rec.t < since) continue;
    if (wantTarget) {
      const t = rec.target || {};
      const names = [t.id, t.containerName, t.service, t.label].filter(Boolean).map((x) => String(x).toLowerCase());
      if (!names.some((x) => x === wantTarget)) continue;
    }
    out.push(rec);
  }
  return out;
}

/** The trail of one operation, oldest first — what actually happened, in order. */
export function operationTrail(opId) {
  return readAudit({ opId, limit: 200 }).reverse();
}

/** Test helper. */
export function _resetAudit() {
  try { fs.rmSync(FILE, { force: true }); } catch { /* ok */ }
}

export function _internals() {
  return { FILE, MAX_LINES, KEEP, MAX_BYTES };
}
