// Phase 6 — the configuration *scope* boundary.
//
// Phase 6 made OpusHub's configuration writable in bulk: an import can rewrite every presentation
// file at once, a history version can be restored over the live configuration, and an export can
// serialise the whole thing to a file a user will email to themselves.
//
// Every one of those operations is a way to accidentally write the wrong file. `data/auth.json`
// sits one directory away from `config/settings.yaml`; a restore that took `data/` along would
// log every user out and replace the administrator's password. An export that globbed too widely
// would hand out the `.env`.
//
// So the boundary is declared here, once, as data — and every bulk operation in Phase 6 iterates
// this list rather than a directory. A file that is not on it cannot be snapshotted, restored,
// exported or imported, and adding one is a deliberate edit to this file rather than a typo in a
// glob.
//
// The five kinds below are the whole taxonomy the brief asks to be kept separate.

/** Presentation configuration: what a user may write, snapshot, restore and export. */
export const PRESENTATION_FILES = [
  { name: 'services.yaml', kind: 'overlay', label: 'Service presentation', format: 'yaml' },
  { name: 'stacks.yaml', kind: 'overlay', label: 'Stack presentation', format: 'yaml' },
  { name: 'bookmarks.yaml', kind: 'overlay', label: 'Bookmarks', format: 'yaml' },
  { name: 'settings.yaml', kind: 'settings', label: 'Appearance & integrations', format: 'yaml' },
  { name: 'layout.json', kind: 'layout', label: 'Hub composition', format: 'json' },
  { name: 'theme.css', kind: 'custom', label: 'Custom CSS', format: 'text' },
  { name: 'app.js', kind: 'custom', label: 'Custom JS', format: 'text' },
];

/**
 * Everything else OpusHub keeps, named so that a mistake is impossible to make quietly.
 * These are never snapshotted, never restored, never exported — and `configScopeViolation()`
 * below is what a test can call to prove it.
 */
export const PROTECTED_STATE = [
  { path: 'data/auth.json', kind: 'authentication', why: 'the account and its scrypt hash — restoring this would replace the administrator' },
  { path: 'data/sessions.json', kind: 'authentication', why: 'live sessions — restoring this would sign users out or, worse, back in' },
  { path: 'data/activity.jsonl', kind: 'activity', why: 'the event log — it records what happened and is not a setting' },
  { path: 'data/metrics.json', kind: 'metrics', why: 'host metric history — it is a measurement, not a preference' },
  { path: 'data/events/', kind: 'events', why: 'live event history — it is a measurement, not a preference' },
  { path: 'data/notifications/', kind: 'notifications', why: 'notification history and webhook secrets — not presentation' },
  { path: 'data/monitoring/', kind: 'monitoring', why: 'monitoring state, history and incidents — not presentation' },
  { path: 'data/operations/', kind: 'operations', why: 'operation records and audit trails — not presentation' },
  { path: 'config/.env', kind: 'secrets', why: 'environment secrets — values never leave the server' },
  { path: '.env', kind: 'secrets', why: 'environment secrets — values never leave the server' },
  { path: 'data/config-history/', kind: 'history', why: 'the history store itself — restoring a version into history would recurse' },
];

const PRESENTATION_NAMES = new Set(PRESENTATION_FILES.map((f) => f.name));

/** True for the seven files Phase 6 is allowed to read and write in bulk. */
export const isPresentationFile = (name) => PRESENTATION_NAMES.has(String(name ?? ''));

/** Metadata for one presentation file, or null. */
export const presentationFile = (name) => PRESENTATION_FILES.find((f) => f.name === name) || null;

/** The seven names, in a stable order (settings first: it is the one a human looks for). */
export const presentationFileNames = () => PRESENTATION_FILES.map((f) => f.name);

/**
 * Refuse anything that is not presentation configuration, with a message that says *why* the file
 * is protected rather than a bare "no".
 */
export function assertPresentationFile(name) {
  const clean = String(name ?? '').split(/[/\\]/).pop();
  if (isPresentationFile(clean)) return clean;
  const protectedEntry = PROTECTED_STATE.find((p) => p.path === name || p.path.endsWith(`/${clean}`) || p.path === clean);
  const why = protectedEntry
    ? `${name} is ${protectedEntry.kind} state — ${protectedEntry.why}`
    : `${name} is not presentation configuration`;
  throw Object.assign(new Error(why), { status: 400, code: 'scope_violation' });
}

/**
 * The one call a test needs: given a path a bulk operation tried to touch, is it inside the
 * boundary? Returns null when it is fine, or the reason it is not.
 */
export function configScopeViolation(path) {
  const s = String(path ?? '');
  if (!s) return 'empty path';
  const base = s.split(/[/\\]/).pop();
  if (s.includes('..') || s.startsWith('/') || /^[a-z]:/i.test(s)) {
    return `${s} is an absolute or traversing path — bulk configuration operations address the seven named files only`;
  }
  if (s.includes('/') || s.includes('\\')) {
    const entry = PROTECTED_STATE.find((p) => s.includes(p.path) || p.path === s);
    return entry ? `${s} is ${entry.kind} state and must never be touched by configuration operations` : `${s} is outside the configuration directory`;
  }
  if (PRESENTATION_NAMES.has(base)) return null;
  const entry = PROTECTED_STATE.find((p) => p.path.endsWith(`/${base}`));
  if (entry) return `${base} is ${entry.kind} state — ${entry.why}`;
  return `${base} is not presentation configuration`;
}

/** What Settings → Configuration → Scope renders: the separation, stated rather than implied. */
export function configScopeDoc() {
  return {
    presentation: PRESENTATION_FILES.map((f) => ({ name: f.name, kind: f.kind, label: f.label })),
    protected: PROTECTED_STATE.map((p) => ({ path: p.path, kind: p.kind, why: p.why })),
    rule: 'Restoring or importing configuration rewrites presentation files only. It never touches authentication, sessions, activity, metrics, secrets, or Docker.',
  };
}
