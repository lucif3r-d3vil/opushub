// Phase 6 — versioned configuration history, semantic diff, and restore.
//
// Every successful configuration write can leave a version behind:
//
//     data/config-history/
//       2026-09-15T12-00-00-000Z.json
//       2026-09-15T12-30-00-000Z.json
//       …
//
// A version is a snapshot of the seven *presentation* files (see server/configScope.js) plus a
// description of what caused it. It is deliberately not a backup of the installation: auth,
// sessions, activity and metrics are outside the boundary, by construction, because "restore my
// dashboard layout" must never mean "sign everyone out" or "delete the event log".
//
// Retention is bounded twice over — a version count AND a total byte budget — because a history
// that grows without limit is a slow-motion outage, and a homelab is not watched every day.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { DATA_DIR, readConfigText, writePresentationText } from './configStore.js';
import { LIMITS } from './configSchema.js';
import { PRESENTATION_FILES, presentationFileNames, assertPresentationFile } from './configScope.js';

const HISTORY_DIR = path.join(DATA_DIR, 'config-history');
const VERSION_FORMAT = 1;

/** Filesystem-safe ISO timestamp: `2026-09-15T12-00-00-000Z`. Sortable as a plain string. */
export function stampOf(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** `2026-09-15T12-00-00-000Z` → `2026-09-15T12:00:00.000Z` (and null if it is not one). */
export function dateOf(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(String(stamp || ''));
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

const versionPath = (id) => path.join(HISTORY_DIR, `${id}.json`);
const ensureDir = () => fs.mkdirSync(HISTORY_DIR, { recursive: true });

/** Every version on disk, newest first. Never throws — a corrupt entry is skipped, not fatal. */
export function listVersions() {
  let names = [];
  try { names = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const file of names.sort().reverse()) {
    const id = file.replace(/\.json$/, '');
    try {
      const stat = fs.statSync(path.join(HISTORY_DIR, file));
      const raw = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8'));
      out.push({
        id,
        at: raw.at || dateOf(id)?.toISOString() || null,
        reason: raw.reason || 'configuration write',
        subject: raw.subject || null,
        label: raw.label || null,
        actor: raw.actor || null,
        bytes: stat.size,
        // What the version actually holds — the honest answer to "what would restoring this do?"
        files: Object.keys(raw.files || {}).sort(),
        changed: Array.isArray(raw.changed) ? raw.changed : [],
      });
    } catch { /* a version we cannot read is reported by its absence, not by crashing the list */ }
  }
  return out;
}

/** One version, body included. */
export function readVersion(id) {
  const clean = String(id || '').replace(/[^0-9A-Za-z-]/g, '');
  if (!clean) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(versionPath(clean), 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.files || typeof raw.files !== 'object') return null;
    return { id: clean, ...raw };
  } catch { return null; }
}

/** Current contents of the seven presentation files, as text. Missing files are simply absent. */
export function snapshotFiles() {
  const files = {};
  for (const name of presentationFileNames()) {
    const text = readConfigText(name);
    if (text != null) files[name] = text;
  }
  return files;
}

const checksumOf = (files) => crypto
  .createHash('sha1')
  .update(JSON.stringify(Object.keys(files).sort().map((k) => [k, files[k]])))
  .digest('hex')
  .slice(0, 16);

/** Which files differ between two snapshots, cheapest useful description of "what changed". */
function changedBetween(prevFiles, nextFiles) {
  const names = new Set([...Object.keys(prevFiles || {}), ...Object.keys(nextFiles || {})]);
  const changed = [];
  for (const name of [...names].sort()) {
    const a = prevFiles?.[name];
    const b = nextFiles?.[name];
    if (a === b) continue;
    changed.push({ file: name, from: a == null ? 'absent' : 'present', to: b == null ? 'absent' : 'present' });
  }
  return changed;
}

/**
 * Write a version. Called after a successful configuration write, never before — a snapshot of
 * the state a failed write would have produced is worse than no snapshot at all.
 *
 * Returns the version record, or null when there is nothing to record (an identical snapshot is
 * not a version; duplicating it would push real history out of the retention window).
 */
export function snapshot({ reason = 'configuration write', subject = null, label = null, actor = null, force = false } = {}) {
  try {
    const files = snapshotFiles();
    const checksum = checksumOf(files);
    if (!Object.keys(files).length) return null;

    const versions = listVersions();
    const latest = versions[0] ? readVersion(versions[0].id) : null;
    if (!force && latest?.checksum === checksum) return null;

    ensureDir();
    const at = new Date();
    const id = stampOf(at);
    const doc = {
      format: VERSION_FORMAT,
      at: at.toISOString(),
      reason,
      subject,
      label: label || subject || reason,
      actor: actor ? String(actor).slice(0, 80) : null,
      checksum,
      files,
      changed: changedBetween(latest?.files, files),
    };
    const body = JSON.stringify(doc, null, 2);
    if (Buffer.byteLength(body, 'utf8') > LIMITS.historySnapshotBytes) {
      // A snapshot larger than the cap means something is wrong with the configuration itself;
      // recording a truncated version would be worse than recording none.
      return null;
    }
    fs.writeFileSync(versionPath(id), body, 'utf8');
    prune();
    return { id, ...doc, bytes: Buffer.byteLength(body, 'utf8') };
  } catch {
    // History bookkeeping must never fail a user's write. The write already succeeded.
    return null;
  }
}

/**
 * Bounded retention. Two independent limits, whichever bites first:
 *   · at most LIMITS.historyVersions versions;
 *   · at most LIMITS.historyTotalBytes on disk.
 * Oldest first, so the window always contains the most recent history.
 */
export function prune() {
  try {
    const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.json')).sort();
    const stat = (f) => { try { return fs.statSync(path.join(HISTORY_DIR, f)).size; } catch { return 0; } };
    let doomed = files.slice(0, Math.max(0, files.length - LIMITS.historyVersions));
    let total = files.reduce((a, f) => a + stat(f), 0);
    const survivors = files.filter((f) => !doomed.includes(f));
    for (const f of survivors) {
      if (total <= LIMITS.historyTotalBytes) break;
      total -= stat(f);
      doomed.push(f);
    }
    for (const f of doomed) {
      try { fs.unlinkSync(path.join(HISTORY_DIR, f)); } catch { /* already gone */ }
    }
    return doomed.length;
  } catch { return 0; }
}

/** How much history exists — shown in Settings → Configuration so retention is visible, not implied. */
export function historyStats() {
  const versions = listVersions();
  return {
    count: versions.length,
    retention: { versions: LIMITS.historyVersions, bytes: LIMITS.historyTotalBytes },
    totalBytes: versions.reduce((a, v) => a + v.bytes, 0),
    oldest: versions.length ? versions[versions.length - 1].at : null,
    newest: versions.length ? versions[0].at : null,
  };
}

// ---------------------------------------------------------------------------
// semantic diff
// ---------------------------------------------------------------------------

const parseMaybeYaml = (text) => {
  if (text == null) return undefined;
  try { return YAML.parse(text); } catch { return undefined; }
};

const parseMaybeJson = (text) => {
  if (text == null) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
};

/** Deep structural diff → flat list of `{ path, from, to, kind }`. */
function structuralDiff(a, b, prefix = '') {
  const out = [];
  const isObj = (v) => v != null && typeof v === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: prefix, from: a, to: b, kind: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed' });
    return out;
  }
  if (Array.isArray(a)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) out.push(...structuralDiff(a[i], b[i], `${prefix}[${i}]`));
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of [...keys].sort()) out.push(...structuralDiff(a[key], b[key], prefix ? `${prefix}.${key}` : key));
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The human-readable diff Settings → Configuration → History shows.
 *
 * "Semantic where practical" is taken literally: a change to a service's icon is reported as
 * `Stream · icon: jellyfin → custom-icon`, not as `groups[2].services[0].icon @@ -1 +1 @@`. The
 * renderer understands the four YAML/JSON documents OpusHub actually stores, and falls back to a
 * structural walk for anything else (including hand-edited files it does not recognise).
 */
export function diffSnapshots(aFiles = {}, bFiles = {}) {
  const names = [...new Set([...Object.keys(aFiles), ...Object.keys(bFiles)])].sort();
  const sections = [];
  let totalChanges = 0;

  for (const name of names) {
    const before = aFiles[name];
    const after = bFiles[name];
    if (before === after) continue;

    if (before == null) { sections.push({ file: name, title: labelOf(name), kind: 'added', entries: [{ text: 'added', kind: 'added' }] }); totalChanges++; continue; }
    if (after == null) { sections.push({ file: name, title: labelOf(name), kind: 'removed', entries: [{ text: 'removed', kind: 'removed' }] }); totalChanges++; continue; }

    if (name === 'services.yaml') { const s = diffServices(before, after); if (s.entries.length) { sections.push(s); totalChanges += s.entries.length; } continue; }
    if (name === 'bookmarks.yaml') { const s = diffBookmarks(before, after); if (s.entries.length) { sections.push(s); totalChanges += s.entries.length; } continue; }
    if (name === 'settings.yaml') { const s = diffSettings(before, after); if (s.entries.length) { sections.push(s); totalChanges += s.entries.length; } continue; }
    if (name === 'layout.json') { const s = diffLayout(before, after); if (s.entries.length) { sections.push(s); totalChanges += s.entries.length; } continue; }
    if (name === 'stacks.yaml') { const s = diffStacks(before, after); if (s.entries.length) { sections.push(s); totalChanges += s.entries.length; } continue; }
    // custom css/js and anything unrecognised: a line-level summary, which is the honest answer
    const s = diffText(name, before, after);
    if (s.entries.length) { sections.push(s); totalChanges += s.entries.length; }
  }

  return { sections, changes: totalChanges, identical: totalChanges === 0 };
}

function labelOf(name) {
  return PRESENTATION_FILES.find((f) => f.name === name)?.label || name;
}

const show = (v) => {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 57)}…` : v;
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(none)';
  return JSON.stringify(v).slice(0, 60);
};

/** `container → displayName`, the key a user recognises a service by. */
function serviceIndex(doc) {
  const map = new Map();
  const groups = Array.isArray(doc?.groups) ? doc.groups : [];
  for (const g of groups) {
    for (const s of Array.isArray(g?.services) ? g.services : []) {
      const key = String(s?.container || s?.name || '').trim();
      if (!key) continue;
      map.set(key.toLowerCase(), { group: g?.name || 'Ungrouped', service: s });
    }
  }
  return map;
}

function diffServices(before, after) {
  const entries = [];
  const a = serviceIndex(parseMaybeYaml(before));
  const b = serviceIndex(parseMaybeYaml(after));
  const groupsBefore = new Set((parseMaybeYaml(before)?.groups || []).map((g) => String(g?.name || '')));
  const groupsAfter = new Set((parseMaybeYaml(after)?.groups || []).map((g) => String(g?.name || '')));

  for (const name of [...groupsAfter].filter((g) => !groupsBefore.has(g)).sort()) entries.push({ text: `+ ${name}`, kind: 'added', scope: 'Groups' });
  for (const name of [...groupsBefore].filter((g) => !groupsAfter.has(g)).sort()) entries.push({ text: `− ${name}`, kind: 'removed', scope: 'Groups' });

  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const av = a.get(key)?.service;
    const bv = b.get(key)?.service;
    const label = bv?.displayName || av?.displayName || bv?.name || av?.name || key;
    if (!av) { entries.push({ text: `+ ${label}`, kind: 'added', scope: 'Services' }); continue; }
    if (!bv) { entries.push({ text: `− ${label}`, kind: 'removed', scope: 'Services' }); continue; }
    for (const field of ['displayName', 'description', 'icon', 'group', 'url', 'hidden', 'showOnHub', 'order']) {
      if (!same(av[field], bv[field])) {
        entries.push({
          text: `${label} · ${field}: ${show(av[field])} → ${show(bv[field])}`,
          kind: 'changed',
          scope: 'Services',
          service: label,
          field,
        });
      }
    }
  }
  return { file: 'services.yaml', title: 'Service presentation', entries };
}

function diffBookmarks(before, after) {
  const entries = [];
  const flat = (doc) => {
    const map = new Map();
    for (const g of doc?.groups || []) {
      for (const item of g?.items || []) map.set(`${g?.name || 'Bookmarks'}::${item?.name}`, { group: g?.name, item });
    }
    return map;
  };
  const a = flat(parseMaybeYaml(before));
  const b = flat(parseMaybeYaml(after));
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const av = a.get(key);
    const bv = b.get(key);
    if (!av) { entries.push({ text: `+ ${bv.item.name} (${bv.group})`, kind: 'added', scope: 'Bookmarks' }); continue; }
    if (!bv) { entries.push({ text: `− ${av.item.name} (${av.group})`, kind: 'removed', scope: 'Bookmarks' }); continue; }
    for (const field of ['href', 'description', 'group']) {
      const one = field === 'group' ? av.group : av.item[field];
      const two = field === 'group' ? bv.group : bv.item[field];
      if (!same(one, two)) entries.push({ text: `${bv.item.name} · ${field}: ${show(one)} → ${show(two)}`, kind: 'changed', scope: 'Bookmarks' });
    }
  }
  return { file: 'bookmarks.yaml', title: 'Bookmarks', entries };
}

function diffSettings(before, after) {
  const changes = structuralDiff(parseMaybeYaml(before), parseMaybeYaml(after));
  const entries = changes.map((c) => ({
    text: `${c.path}: ${show(c.from)} → ${show(c.to)}`,
    kind: c.kind,
    scope: 'Settings',
    path: c.path,
  }));
  return { file: 'settings.yaml', title: 'Appearance & integrations', entries };
}

function diffLayout(before, after) {
  const a = parseMaybeJson(before) || {};
  const b = parseMaybeJson(after) || {};
  const entries = [];
  const wa = new Map((a?.hub?.widgets || []).map((w) => [String(w?.id), w]));
  const wb = new Map((b?.hub?.widgets || []).map((w) => [String(w?.id), w]));
  for (const id of [...new Set([...wa.keys(), ...wb.keys()])].sort()) {
    const av = wa.get(id);
    const bv = wb.get(id);
    if (!av) { entries.push({ text: `+ ${bv.type} widget (${bv.zone})`, kind: 'added', scope: 'Hub' }); continue; }
    if (!bv) { entries.push({ text: `− ${av.type} widget (${av.zone})`, kind: 'removed', scope: 'Hub' }); continue; }
    for (const field of ['type', 'zone', 'size', 'visible']) {
      if (!same(av[field], bv[field])) entries.push({ text: `${av.type} · ${field}: ${show(av[field])} → ${show(bv[field])}`, kind: 'changed', scope: 'Hub' });
    }
    if (!same(av.config, bv.config)) entries.push({ text: `${av.type} · configuration changed`, kind: 'changed', scope: 'Hub' });
  }
  if (!same(a?.hub?.spacing, b?.hub?.spacing)) entries.push({ text: `spacing: ${show(a?.hub?.spacing)} → ${show(b?.hub?.spacing)}`, kind: 'changed', scope: 'Hub' });
  const ga = (a?.services?.groupOrder || []).join(',');
  const gb = (b?.services?.groupOrder || []).join(',');
  if (ga !== gb) entries.push({ text: `group order: ${show(a?.services?.groupOrder)} → ${show(b?.services?.groupOrder)}`, kind: 'changed', scope: 'Hub' });
  const ha = (a?.services?.hiddenGroups || []).join(',');
  const hb = (b?.services?.hiddenGroups || []).join(',');
  if (ha !== hb) entries.push({ text: `hidden groups: ${show(a?.services?.hiddenGroups)} → ${show(b?.services?.hiddenGroups)}`, kind: 'changed', scope: 'Hub' });
  return { file: 'layout.json', title: 'Hub composition', entries };
}

function diffStacks(before, after) {
  const idx = (doc) => new Map((parseMaybeYaml(doc)?.stacks || []).map((s) => [String(s?.project || s?.name), s]));
  const a = idx(before);
  const b = idx(after);
  const entries = [];
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const av = a.get(key);
    const bv = b.get(key);
    if (!av) { entries.push({ text: `+ ${key}`, kind: 'added', scope: 'Stacks' }); continue; }
    if (!bv) { entries.push({ text: `− ${key}`, kind: 'removed', scope: 'Stacks' }); continue; }
    for (const field of ['name', 'displayName', 'description', 'icon', 'notes']) {
      if (!same(av[field], bv[field])) entries.push({ text: `${key} · ${field}: ${show(av[field])} → ${show(bv[field])}`, kind: 'changed', scope: 'Stacks' });
    }
  }
  return { file: 'stacks.yaml', title: 'Stack presentation', entries };
}

/** Line-level summary for text files. Counts only — a CSS diff in prose would be noise. */
function diffText(name, before, after) {
  const la = String(before).split('\n');
  const lb = String(after).split('\n');
  const setA = new Set(la);
  const setB = new Set(lb);
  const added = lb.filter((l) => !setA.has(l)).length;
  const removed = la.filter((l) => !setB.has(l)).length;
  const entries = [];
  if (added) entries.push({ text: `${added} line${added === 1 ? '' : 's'} added`, kind: 'added', scope: 'Custom' });
  if (removed) entries.push({ text: `${removed} line${removed === 1 ? '' : 's'} removed`, kind: 'removed', scope: 'Custom' });
  if (!added && !removed && before !== after) entries.push({ text: 'content reordered', kind: 'changed', scope: 'Custom' });
  return { file: name, title: labelOf(name), entries };
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

/**
 * Put a previous version back.
 *
 * Two properties matter more than the mechanics:
 *
 *   1. **Presentation only.** The loop iterates `presentationFileNames()`, which is derived from
 *      server/configScope.js. There is no code path here that could reach `data/auth.json`,
 *      `data/sessions.json`, the activity log, the metric history or `.env` — they are not in the
 *      list, and the list is the only thing iterated.
 *
 *   2. **Reversible.** The configuration being replaced is snapshotted *first*, under reason
 *      `restore`, so restoring the wrong version is itself undoable. That snapshot is `force`d
 *      because the user asked for a restore even if the bytes happen to match nothing.
 *
 * Docker is not consulted, contacted or informed. A restore is a file write.
 */
export function restoreVersion(id, { actor = null } = {}) {
  const version = readVersion(id);
  if (!version) throw Object.assign(new Error(`no such configuration version: ${id}`), { status: 404, code: 'version_not_found' });

  const files = version.files || {};
  const names = Object.keys(files);
  if (!names.length) throw Object.assign(new Error('that version holds no configuration files'), { status: 400 });

  // Snapshot the present *before* overwriting it. This is the undo point: restoring it returns
  // the user to the state a restore replaced, which is the only thing "undo" can sensibly mean.
  const preRestore = snapshot({ reason: 'restore', subject: `before restoring ${id}`, label: 'pre-restore snapshot', actor, force: true });

  const written = [];
  const skipped = [];
  for (const name of names) {
    try {
      assertPresentationFile(name);
      // JSON and CSS/JS come back exactly as stored; YAML does too (that is the point of
      // writePresentationText) so comments and key order survive the round trip.
      writePresentationText(name, files[name]);
      written.push(name);
    } catch (err) {
      // A version containing a file that is no longer in scope is refused for that file only —
      // this is the guard that makes an old or hand-edited snapshot incapable of escaping.
      skipped.push({ file: name, reason: err.message });
    }
  }

  const after = snapshot({ reason: 'restore', subject: `restored ${id}`, label: `restored ${version.label || id}`, actor, force: true });

  return {
    ok: true,
    restored: id,
    restoredFrom: version.at,
    files: written,
    skipped,
    undoVersion: preRestore?.id || null,
    scope: presentationFileNames(),
  };
}

export const historyDir = () => HISTORY_DIR;
