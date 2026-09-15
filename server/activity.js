// ActivityLog — append-only JSONL of things that genuinely happened while OpusHub watched:
// config writes made through the app, app lifecycle, provider availability transitions, Docker
// container state changes (when the engine is reachable), and user launches. No synthetic events.
//
// Phase 3 additions:
//   • duplicate suppression — a caller may attach a stable `signature` (e.g.
//     "container.exited:paperless:exited"); an identical signature within DEDUPE_WINDOW_MS of the
//     previous one is dropped, so a flapping watcher cannot fill the log with the same fact.
//   • grouping — `readEvents({ grouped: true })` folds bursts of the same docker event type
//     (≥ GROUP_MIN events within GROUP_WINDOW_MS, typically one compose deployment) into one
//     summary item that still carries its underlying events. No information is lost.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './configStore.js';

const FILE = path.join(DATA_DIR, 'activity.jsonl');
const MAX_LINES = 5000;
const KEEP = 4000;
export const DEDUPE_WINDOW_MS = 60_000;
export const GROUP_WINDOW_MS = 120_000;
export const GROUP_MIN = 3;
let seq = 0;
const listeners = new Set();
/** signature → last accepted timestamp (bounded below) */
const recentSignatures = new Map();

export function logEvent({ source, type, subject = null, message = null, meta = null, signature = null, dedupeWindowMs = DEDUPE_WINDOW_MS }) {
  if (signature) {
    const now = Date.now();
    const last = recentSignatures.get(signature);
    if (last && now - last < dedupeWindowMs) return null; // same fact, already told
    recentSignatures.set(signature, now);
    if (recentSignatures.size > 512) {
      const oldestKey = recentSignatures.keys().next().value;
      recentSignatures.delete(oldestKey);
    }
  }
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

function parseAll() {
  let lines = [];
  try { lines = fs.readFileSync(FILE, 'utf8').trim().split('\n'); } catch { return []; }
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* skip torn lines */ }
  }
  return out;
}

/** Timestamp of the earliest recorded event — the moment OpusHub started watching.
 *  null → the log is empty: there is NO history yet, which is different from "nothing happened". */
export function firstEventAt() {
  const all = parseAll();
  return all.length ? all[0].t : null;
}

/**
 * Fold bursts of identical docker events into one grouped item.
 *
 * Deterministic rule (documented, no heuristics about "importance"):
 *   a run of ≥ GROUP_MIN events, same source (`docker`), same `type`, consecutive in the
 *   chronologically-ordered input, spanning ≤ GROUP_WINDOW_MS, becomes one item:
 *   { grouped: true, id, t, source, type, count, subjects, project, events: [...] }
 *   where `t` is the first event of the burst. Everything else passes through untouched.
 * Input may be in any order; output preserves the input's ordering of group anchors.
 */
export function groupEvents(events, { windowMs = GROUP_WINDOW_MS, min = GROUP_MIN } = {}) {
  // Cluster chronologically, per type: an event joins the open cluster of its own type when it
  // lands within `windowMs` of that cluster's first event — regardless of what other event types
  // interleave (a compose deployment and a config write can share the same second). Deterministic:
  // same input, same clusters, independent of arrival order inside a timestamp.
  const chronological = [...events].sort((a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id)));
  const openByType = new Map(); // type → cluster
  const clusters = [];
  for (const e of chronological) {
    if (e.source !== 'docker' || e.grouped) continue;
    let cluster = openByType.get(e.type);
    if (!cluster || e.t - cluster.events[0].t > windowMs) {
      cluster = { type: e.type, events: [] };
      clusters.push(cluster);
      openByType.set(e.type, cluster);
    }
    cluster.events.push(e);
  }
  const qualified = new Map(); // event → group summary
  for (const g of clusters) {
    if (g.events.length < min) continue;
    const subjects = g.events.map((e) => e.subject).filter(Boolean);
    const projects = [...new Set(g.events.map((e) => e.meta?.project).filter(Boolean))];
    const summary = {
      grouped: true,
      id: `grp-${g.events[0].id}`,
      t: g.events[0].t,
      iso: g.events[0].iso,
      source: 'docker',
      type: g.type,
      subject: projects.length === 1 ? projects[0] : (subjects[0] || null),
      project: projects.length === 1 ? projects[0] : null,
      count: g.events.length,
      subjects,
      message: null,
      meta: { projects },
      events: g.events,
    };
    for (const e of g.events) qualified.set(e, summary);
  }
  // rebuild in the caller's order, each group standing in at its newest member's slot
  const out = [];
  const seen = new Set();
  for (const e of events) {
    const g = qualified.get(e);
    if (!g) { out.push(e); continue; }
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    out.push(g);
  }
  return out;
}

/**
 * Read the log, newest first, with optional filters.
 *
 * Filtering happens here (not in the browser) so that the *whole* retention window is searchable —
 * a filter that only looked at the last 150 rows would answer a narrower question than the one the
 * UI asks. The vocabulary is deliberately small and matches what the log actually records:
 *   source   system | config | user | docker
 *   type     exact or prefix: `container` matches `container.started` and `container.health`
 *   service  a container name / service name — matched against subject and the event's own meta
 *   stack    a compose project — matched against meta.project (including grouped bursts)
 *   since    epoch ms; `before` remains for “load older” paging
 *
 * `matched` is the number of events that pass the filters (before grouping), so the page can say
 * "showing 20 of 4317" without pretending the log is shorter than it is.
 */
export function readEvents({ limit = 100, source = null, before = null, grouped = false, service = null, stack = null, type = null, since = null } = {}) {
  const all = parseAll();
  const wantService = service ? String(service).toLowerCase() : null;
  const wantStack = stack ? String(stack).toLowerCase() : null;
  const wantType = type ? String(type).toLowerCase() : null;

  const matches = (ev) => {
    if (source && source !== 'all' && ev.source !== source) return false;
    if (before && ev.t >= before) return false;
    if (since && ev.t < since) return false;
    if (wantType && !String(ev.type || '').toLowerCase().startsWith(wantType)) return false;
    if (wantService) {
      const names = [ev.subject, ev.meta?.service, ev.meta?.container, ...(Array.isArray(ev.meta?.subjects) ? ev.meta.subjects : [])]
        .filter(Boolean).map((x) => String(x).toLowerCase());
      if (!names.some((n) => n === wantService || n.includes(wantService))) return false;
    }
    if (wantStack) {
      const projects = [ev.meta?.project, ev.meta?.stack, ...(Array.isArray(ev.meta?.projects) ? ev.meta.projects : [])]
        .filter(Boolean).map((x) => String(x).toLowerCase());
      if (!projects.some((p) => p === wantStack || p.includes(wantStack))) return false;
    }
    return true;
  };

  const out = [];
  let matched = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const ev = all[i];
    if (!matches(ev)) continue;
    matched += 1;
    if (out.length < Math.min(500, limit)) out.push(ev);
  }
  const items = grouped ? groupEvents(out) : out;
  return { items, total: all.length, matched };
}

/** Test helper. */
export function _resetActivity() { recentSignatures.clear(); }
