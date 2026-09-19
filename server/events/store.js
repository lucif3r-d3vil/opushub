// Phase 10B — persistent event history (bounded, atomic, corruption-resistant, restart-safe)
// Stored as JSONL under DATA_DIR/events/events.jsonl, similar to activity.js but with its own retention.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../configStore.js';
import { deserializeEvent, serializeEvent } from './model.js';

const DIR = path.join(DATA_DIR, 'events');
const FILE = path.join(DIR, 'events.jsonl');

const MAX_LINES = 5000;
const KEEP_LINES = 4000;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 7 days

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
}

function atomicAppend(line) {
  ensureDir();
  try {
    fs.appendFileSync(FILE, line + '\n', 'utf8');
  } catch (err) {
    console.warn(`[events] append failed: ${err.message}`);
  }
}

function readAllRaw() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const text = fs.readFileSync(FILE, 'utf8');
    return text.split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function readAll() {
  const raw = readAllRaw();
  const out = [];
  for (const line of raw) {
    const evt = deserializeEvent(line);
    if (evt) out.push(evt);
    // else skip torn/corrupt line
  }
  return out;
}

function trimIfNeeded() {
  try {
    const raw = readAllRaw();
    if (raw.length <= MAX_LINES) {
      // also check age
      const now = Date.now();
      const filtered = raw.filter((line) => {
        const evt = deserializeEvent(line);
        if (!evt) return false; // drop corrupt on trim
        if (now - evt.t > MAX_AGE_MS) return false;
        return true;
      });
      if (filtered.length !== raw.length) {
        const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, filtered.join('\n') + (filtered.length ? '\n' : ''), 'utf8');
        fs.renameSync(tmp, FILE);
      }
      return;
    }
    // need to trim: keep last KEEP_LINES that are valid and within age
    const now = Date.now();
    const parsed = raw.map((line) => ({ line, evt: deserializeEvent(line) })).filter((x) => x.evt);
    const ageFiltered = parsed.filter((x) => now - x.evt.t <= MAX_AGE_MS);
    const keep = ageFiltered.slice(-KEEP_LINES);
    const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, keep.map((x) => x.line).join('\n') + (keep.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.warn(`[events] trim failed: ${err.message}`);
  }
}

let approxCount = null;
let writesSinceCountCheck = 0;

function getApproxCount() {
  if (approxCount != null) return approxCount;
  try {
    approxCount = readAllRaw().length;
  } catch {
    approxCount = 0;
  }
  return approxCount;
}

export function writeEvent(evt) {
  if (!evt || !evt.id) return;
  try {
    const line = serializeEvent(evt);
    atomicAppend(line);
    if (approxCount != null) approxCount++;
    else getApproxCount(); // init
    writesSinceCountCheck++;

    // Always enforce MAX_LINES deterministically: if we know we are over, trim now
    if (getApproxCount() > MAX_LINES) {
      trimIfNeeded();
      try { approxCount = readAllRaw().length; } catch { approxCount = 0; }
      writesSinceCountCheck = 0;
      return;
    }

    // Heuristic: size-based + periodic count check to enforce TTL and corrupt cleanup
    try {
      const st = fs.statSync(FILE);
      if (st.size > 2_000_000) {
        trimIfNeeded();
        try { approxCount = readAllRaw().length; } catch { approxCount = 0; }
        writesSinceCountCheck = 0;
        return;
      }
    } catch {}
    // Periodic check every 100 writes or 2% random sampling for TTL enforcement
    if (writesSinceCountCheck >= 100 || Math.random() < 0.02) {
      trimIfNeeded();
      try { approxCount = readAllRaw().length; } catch { approxCount = 0; }
      writesSinceCountCheck = 0;
    }
  } catch (err) {
    console.warn(`[events] write failed: ${err.message}`);
  }
}

export function readEvents({ limit = 100, before = null, after = null, types = null, severity = null, source = null, since = null } = {}) {
  let items = readAll();
  // sort by t ascending, but we want most recent first for API? Keep ascending then slice.
  items.sort((a, b) => a.t - b.t);
  if (types && Array.isArray(types) && types.length) {
    const set = new Set(types);
    items = items.filter((e) => set.has(e.type));
  }
  if (source) items = items.filter((e) => e.source === source);
  if (severity) {
    const order = { info: 0, notice: 1, warning: 2, critical: 3 };
    const min = order[severity] ?? 0;
    items = items.filter((e) => (order[e.severity] ?? 0) >= min);
  }
  if (since != null) items = items.filter((e) => e.t > since);
  if (after != null) items = items.filter((e) => e.t > after);
  if (before != null) items = items.filter((e) => e.t < before);
  // limit: most recent
  if (limit != null) items = items.slice(-limit);
  return items;
}

export function getEventById(id) {
  if (!id) return null;
  const all = readAll();
  return all.find((e) => e.id === id) || null;
}

export function clearAll() {
  try {
    ensureDir();
    fs.writeFileSync(FILE, '', 'utf8');
    approxCount = 0;
    writesSinceCountCheck = 0;
  } catch {}
}

export function stats() {
  try {
    if (!fs.existsSync(FILE)) return { count: 0, bytes: 0 };
    const st = fs.statSync(FILE);
    const raw = readAllRaw();
    return { count: raw.length, bytes: st.size, file: FILE };
  } catch {
    return { count: 0, bytes: 0, file: FILE };
  }
}

export const EVENTS_FILE = FILE;
export const EVENTS_DIR = DIR;
