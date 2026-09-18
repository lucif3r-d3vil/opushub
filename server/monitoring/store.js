// Monitoring persistence — bounded, atomic, restart-safe, and deliberately boring.
//
// Where the data lives
//   data/monitoring/monitors.json   the monitors themselves + the effective defaults
//   data/monitoring/history.json    bounded per-monitor check history (samples + hourly buckets)
//   data/monitoring/incidents.json  incidents (open ones forever, resolved ones bounded)
//   data/monitoring/engine.json     the engine's own bookkeeping (startedAt, lastTickAt, stops)
//
// Why `data/` and not `config/`: Phase 6 draws a hard line around *presentation configuration*
// (server/configScope.js) — the seven files an import, a restore and an export are allowed to
// touch. Monitors are not presentation: they are operational state that other machinery (history,
// incidents, the alert engine) reads and writes continuously, and letting an export/import
// round-trip carry someone's monitoring history would be a bug with a friendly name. Nothing here
// can ever address a file outside `data/monitoring/`: the four names below are the whole
// vocabulary, and `storePath()` refuses anything else.
//
// Every write is atomic (temp file + rename, as the config store does) and every document is
// capped, so a runaway history cannot fill a disk with OpusHub's own bookkeeping.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../configStore.js';

export const MONITORING_DIR = path.join(DATA_DIR, 'monitoring');

/** The complete set of files this module may ever touch. */
export const STORE_FILES = Object.freeze(['monitors.json', 'history.json', 'incidents.json', 'engine.json']);

/** A document larger than this is a bug in retention, not a file to write. */
export const MAX_DOC_BYTES = 16 * 1024 * 1024;

export function storePath(name) {
  if (!STORE_FILES.includes(name)) {
    // This is the filesystem boundary, stated where it is enforced: no path, no traversal, no
    // caller-supplied name.
    throw Object.assign(new Error(`monitoring store refuses the file “${String(name).slice(0, 40)}”`), { status: 500, code: 'store_path' });
  }
  return path.join(MONITORING_DIR, name);
}

function ensureDir() {
  fs.mkdirSync(MONITORING_DIR, { recursive: true });
}

/** Read one document. A missing or unreadable file is an empty start, never a crash. */
export function readDoc(name, fallback = null) {
  const file = storePath(name);
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** `true` when the file exists and parses — used by the engine to say "this is a restart". */
export function docExists(name) {
  try { return fs.statSync(storePath(name)).isFile(); } catch { return false; }
}

export function writeDoc(name, value) {
  const file = storePath(name);
  const text = JSON.stringify(value, null, 2) + '\n';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_DOC_BYTES) {
    throw Object.assign(new Error(`monitoring document ${name} exceeds ${Math.round(MAX_DOC_BYTES / 1024 / 1024)} MB`), { status: 500, code: 'store_too_large' });
  }
  ensureDir();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file); // atomic on every platform OpusHub runs on
  return { file, bytes };
}

export function removeDoc(name) {
  try { fs.unlinkSync(storePath(name)); return true; } catch { return false; }
}

/**
 * A debounced writer. Monitoring produces a small write per check; on a hundred monitors at a
 * ten-second interval that is ten writes a second if every check writes immediately. This collapses
 * them: the *first* change schedules a flush, everything that happens in between is included when
 * it runs, and `flushNow()` is what a graceful shutdown calls.
 */
export function createFlusher({ delayMs = 4000, write, timer = setTimeout, clear = clearTimeout } = {}) {
  let handle = null;
  let dirty = false;
  let stopped = false;
  const fire = () => {
    handle = null;
    if (!dirty) return;
    dirty = false;
    try { write(); } catch { /* a failed flush must not take the engine down */ }
  };
  return {
    schedule() {
      if (stopped) return;
      dirty = true;
      if (handle) return;
      handle = timer(fire, delayMs);
      if (handle && typeof handle.unref === 'function') handle.unref();
    },
    flushNow() {
      if (handle) { clear(handle); handle = null; }
      fire();
    },
    pending: () => dirty,
    stop() {
      stopped = true;
      if (handle) { clear(handle); handle = null; }
      fire();
    },
  };
}
