// ActivityLog — append-only JSONL of things that genuinely happened while OpusHub watched:
// config writes made through the app, app lifecycle, provider availability transitions, Docker
// container state changes (when the engine is reachable), and user launches. No synthetic events.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './configStore.js';

const FILE = path.join(DATA_DIR, 'activity.jsonl');
const MAX_LINES = 5000;
const KEEP = 4000;
let seq = 0;
const listeners = new Set();

export function logEvent({ source, type, subject = null, message = null, meta = null }) {
  const ev = { id: `${Date.now().toString(36)}-${(seq++).toString(36)}`, t: Date.now(), iso: new Date().toISOString(), source, type, subject, message, meta };
  try {
    fs.appendFileSync(FILE, JSON.stringify(ev) + '\n');
    const size = fs.statSync(FILE).size;
    if (size > 2 * 1024 * 1024) {
      const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').slice(-KEEP);
      fs.writeFileSync(FILE + '.tmp', lines.join('\n') + '\n');
      fs.renameSync(FILE + '.tmp', FILE);
    }
  } catch { /* activity log must never break a request */ }
  for (const l of listeners) { try { l(ev); } catch { /* */ } }
  return ev;
}

export function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function readEvents({ limit = 100, source = null, before = null } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(FILE, 'utf8').trim().split('\n'); } catch { return { items: [], total: 0 }; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < Math.min(500, limit); i--) {
    let ev;
    try { ev = JSON.parse(lines[i]); } catch { continue; }
    if (source && source !== 'all' && ev.source !== source) continue;
    if (before && ev.t >= before) continue;
    out.push(ev);
  }
  return { items: out, total: lines.length };
}
