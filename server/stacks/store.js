// Managed stacks and their deployment history — DATA_DIR/stacks/{stacks,history}.json.
//
// A managed stack is the operator's Compose document, its env, and what OpusHub last did with it.
// It is NOT inventory: the containers a stack has are always read from Docker (stacks/targets.js).
// If the store says "deployed" and the engine has no containers, the engine is right.
//
// Env values are stored as given — they are the operator's configuration, not credentials OpusHub
// holds for a third party (registry credentials live in registries/store.js, encrypted). They are
// masked on the way to the browser when their key looks secret (containers/diff.js rules).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../configStore.js';

const DIR = path.join(DATA_DIR, 'stacks');
const STACKS_FILE = path.join(DIR, 'stacks.json');
const HISTORY_FILE = path.join(DIR, 'history.json');
const MAX_HISTORY_PER_STACK = 30;
const MAX_HISTORY_TOTAL = 500;

let cache = null;      // { stacks: {id → stack} }
let history = null;    // [ entries ] newest last

function readJson(file, fallback) {
  try { if (!fs.existsSync(file)) return fallback; const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : fallback; } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}
function load() { if (!cache) cache = readJson(STACKS_FILE, { stacks: {} }); if (!cache.stacks) cache.stacks = {}; return cache; }
function loadHistory() { if (!history) { const h = readJson(HISTORY_FILE, { entries: [] }); history = Array.isArray(h.entries) ? h.entries : []; } return history; }

export function listStacks() { return Object.values(load().stacks).sort((a, b) => a.name.localeCompare(b.name)); }
export function getStack(id) { return load().stacks[String(id || '').toLowerCase()] || null; }

/** Create a managed stack. `name` is the compose project name and the id. */
export function createStack({ name, compose, env = {}, actor = null, at = Date.now() }) {
  const id = String(name).toLowerCase();
  const db = load();
  if (db.stacks[id]) return { ok: false, code: 'conflict', reason: `A managed stack named ${id} already exists.` };
  const stack = {
    id, name: id, compose, env: { ...env }, revision: 1,
    createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor,
    lastDeploy: null,   // { at, by, status, operationId, revision, configHash }
  };
  db.stacks[id] = stack;
  writeJson(STACKS_FILE, db);
  return { ok: true, stack };
}

/** Replace the compose/env of a managed stack (a new revision). Does not deploy. */
export function updateStack(id, { compose, env, actor = null, at = Date.now() }) {
  const db = load();
  const s = db.stacks[String(id || '').toLowerCase()];
  if (!s) return { ok: false, code: 'not_found', reason: 'No managed stack with that id.' };
  if (compose !== undefined) s.compose = compose;
  if (env !== undefined) s.env = { ...env };
  s.revision += 1;
  s.updatedAt = at;
  s.updatedBy = actor;
  writeJson(STACKS_FILE, db);
  return { ok: true, stack: s };
}

export function recordDeploy(id, info) {
  const db = load();
  const s = db.stacks[String(id || '').toLowerCase()];
  if (!s) return;
  s.lastDeploy = { ...info };
  writeJson(STACKS_FILE, db);
}

export function deleteStack(id) {
  const db = load();
  const key = String(id || '').toLowerCase();
  if (!db.stacks[key]) return false;
  delete db.stacks[key];
  writeJson(STACKS_FILE, db);
  return true;
}

/** Append a deployment record. Bounded per stack and in total. */
export function appendHistory(entry) {
  const h = loadHistory();
  const rec = { id: `dep-${crypto.randomBytes(6).toString('hex')}`, at: Date.now(), ...entry };
  h.push(rec);
  const perStack = h.filter((e) => e.stack === rec.stack);
  if (perStack.length > MAX_HISTORY_PER_STACK) {
    const drop = new Set(perStack.slice(0, perStack.length - MAX_HISTORY_PER_STACK).map((e) => e.id));
    history = h.filter((e) => !drop.has(e.id));
  }
  if (history.length > MAX_HISTORY_TOTAL) history = history.slice(history.length - MAX_HISTORY_TOTAL);
  writeJson(HISTORY_FILE, { entries: history });
  return rec;
}

export function historyFor(id, { limit = 30 } = {}) {
  const key = String(id || '').toLowerCase();
  return loadHistory().filter((e) => e.stack === key).slice(-limit).reverse();
}

/** The last successful deployment's compose/env — what a rollback redeploys. */
export function lastGoodDeploy(id) {
  const key = String(id || '').toLowerCase();
  const list = loadHistory().filter((e) => e.stack === key && e.status === 'succeeded' && typeof e.compose === 'string');
  return list.length ? list[list.length - 1] : null;
}

export function _resetStacksStore() { cache = null; history = null; }
export const _internals = Object.freeze({ DIR, STACKS_FILE, HISTORY_FILE });
