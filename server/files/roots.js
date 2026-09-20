// Phase 11A — the filesystem-root policy: which parts of the host the File Manager may show at all.
//
// The rule this module exists to enforce: **`/` is never a root, and nothing becomes a root by
// accident.** A root is either
//
//   configured   named by the operator in `OPUSHUB_FILES_ROOTS` (environment, not browser-editable
//                settings — a filesystem root is host access, not presentation), or
//   discovered   a real mount reported by the *existing* filesystem provider
//                (`providers/storage.js#LinuxFilesystemProvider`), which already filters pseudo
//                filesystems and system directories.
//
// and either way it has to survive the same validation: absolute, real, a directory, not `/`, not a
// protected path (the classification in files/policy.js), not OpusHub's own config or data
// directory, not a duplicate of a root already exposed, and not beyond the root cap. A root that
// fails is *reported as refused* with an honest reason — it is not silently dropped, because "my
// mount is missing from the Files page" is otherwise unanswerable.
//
// Roots are identified to the browser by a stable slug (`/tank` → `tank`). A request names the slug
// and a root-relative path; it can never name a host path, which is what makes root isolation
// structural rather than a check.
import fs from 'node:fs';
import nodePath from 'node:path';
import { CONFIG_DIR, DATA_DIR } from '../configStore.js';
// Phase 9's provider registry is where mount and dataset facts come from — TTL-cached and
// single-flight, so opening the Files page does not run `zpool`/`statfs` again on every request.
// Importing providers.js is what registers them (it is idempotent and already loaded by api.js).
import { registerInfrastructureProviders } from '../infrastructure/providers.js';
import { checkProvider } from '../infrastructure/registry.js';
import { LIMITS } from './limits.js';
import { CLASS, PROTECTED_PREFIXES, SENSITIVE_PREFIXES, classifyPath, getDeniedMounts } from './policy.js';

const under = (p, root) => p === root || p.startsWith(`${root}/`);

/** OpusHub's own directories are protected wherever the operator put them. */
export function opushubDirs() {
  const dirs = [];
  for (const d of [CONFIG_DIR, DATA_DIR]) {
    if (!d) continue;
    dirs.push(d);
    try { dirs.push(fs.realpathSync(d)); } catch { /* not there yet */ }
  }
  return [...new Set(dirs)];
}

/** `/opt/stacks` → `opt-stacks`. Stable, URL-safe, and never a host path. */
export function rootIdFor(absolute) {
  const slug = String(absolute || '')
    .replace(/^\/+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'root';
  return slug;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Is this a root id the browser may send? Shape only — membership is checked against the table. */
export function isRootId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/** The environment variable that names roots explicitly. Colon-separated absolute paths. */
export const ROOTS_ENV = 'OPUSHUB_FILES_ROOTS';
/** Set to `1`/`true` and the whole File Manager surface exposes no roots at all. */
export const DISABLED_ENV = 'OPUSHUB_FILES_DISABLED';

/** Configured roots, parsed. Never throws; an unparsable value is an empty list plus a reason. */
export function configuredRoots(env = process.env) {
  const raw = String(env?.[ROOTS_ENV] ?? '').trim();
  const disabled = /^(1|true|yes|on)$/i.test(String(env?.[DISABLED_ENV] ?? '').trim());
  if (!raw) return { paths: [], disabled, reason: null };
  const paths = [];
  for (const part of raw.split(':')) {
    const p = part.trim();
    if (p) paths.push(p);
  }
  return { paths: paths.slice(0, LIMITS.maxRoots), disabled, reason: null };
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Validate one candidate root. Returns `{ ok, root }` or `{ ok:false, path, code, reason, class }`.
 *
 * @param candidate   the path as configured or discovered
 * @param opts.source 'configured' | 'discovered'
 * @param opts.mount  the mount facts the filesystem provider reported, when there are any
 * @param opts.dataset the ZFS dataset mounted here, when there is one
 */
export async function validateRoot(candidate, { source = 'configured', mount = null, dataset = null, taken = new Set(), opushub = null } = {}) {
  const given = String(candidate || '').trim();
  if (!given) return { ok: false, path: given, code: 'empty', reason: 'No path was given.' };
  if (!given.startsWith('/')) return { ok: false, path: given, code: 'relative', reason: 'A filesystem root must be an absolute path.' };
  const normalized = nodePath.normalize(given).replace(/\/+$/, '') || '/';
  if (normalized === '/') return { ok: false, path: given, code: 'host_root', reason: 'The host root filesystem is never exposed.' };
  if (normalized.includes('\u0000')) return { ok: false, path: given, code: 'bad_path', reason: 'A filesystem root may not contain a null byte.' };

  const dirs = opushub || opushubDirs();
  const lexical = classifyPath(normalized, { opushubDirs: dirs });
  if (lexical.level === CLASS.PROTECTED) {
    return { ok: false, path: normalized, code: 'protected_path', class: lexical.class, reason: lexical.reason };
  }
  for (const p of PROTECTED_PREFIXES) {
    if (p !== '/' && under(normalized, p)) return { ok: false, path: normalized, code: 'protected_path', reason: lexical.reason || 'That location is protected by policy.' };
  }

  let real;
  let viaSymlink = false;
  try {
    const lst = await fs.promises.lstat(normalized);
    viaSymlink = lst.isSymbolicLink();
    if (!viaSymlink && !lst.isDirectory()) return { ok: false, path: normalized, code: 'not_a_directory', reason: 'A filesystem root must be a directory.' };
    real = await fs.promises.realpath(normalized);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: false, path: normalized, code: 'missing', reason: 'That directory does not exist on this host.' };
    if (err?.code === 'EACCES' || err?.code === 'EPERM') return { ok: false, path: normalized, code: 'unreadable', reason: 'OpusHub cannot read that directory.' };
    return { ok: false, path: normalized, code: 'unreadable', reason: 'That directory could not be examined.' };
  }
  if (real === '/' || real === '') return { ok: false, path: normalized, code: 'host_root', reason: 'That path resolves to the host root filesystem, which is never exposed.' };

  // the resolved location is the one that has to be allowed: a symlinked root cannot launder a
  // protected path into the table
  const resolvedClass = classifyPath(real, { opushubDirs: dirs });
  if (resolvedClass.level === CLASS.PROTECTED) {
    return { ok: false, path: normalized, code: 'protected_path', class: resolvedClass.class, reason: resolvedClass.reason };
  }
  let lst2;
  try { lst2 = await fs.promises.lstat(real); } catch { lst2 = null; }
  if (!lst2?.isDirectory()) return { ok: false, path: normalized, code: 'not_a_directory', reason: 'That path does not resolve to a directory.' };

  // A denied mount is never a root, even when its mountpoint looks innocuous by name: a bind of a
  // protected tree at `/tank/etcview`, or a pseudo filesystem mounted inside an exposed volume,
  // classifies as ALLOWED lexically while `resolve()` refuses every path under it. Refusing the
  // root keeps the table honest instead of advertising a location the policy will never serve.
  for (const m of await getDeniedMounts()) {
    if (under(real, m.mountPoint)) {
      return {
        ok: false, path: normalized, code: 'mount_escape', class: m.class || 'protected_mount',
        reason: m.reason || 'That location is a mount this policy does not expose.',
      };
    }
  }
  if (taken.has(real)) return { ok: false, path: normalized, code: 'duplicate', reason: 'That location is already exposed as another root.' };

  let usage = null;
  try {
    const st = await fs.promises.statfs(real);
    const bsize = st.bsize || 4096;
    const total = st.blocks * bsize;
    const free = st.bavail * bsize;
    usage = total > 0 ? { total, used: total - free, free, usedPct: Math.round((100 * (total - free)) / total) } : null;
  } catch { usage = null; }

  let readable = true;
  let reason = null;
  try {
    await fs.promises.readdir(real);
  } catch (err) {
    readable = false;
    reason = err?.code === 'EACCES' || err?.code === 'EPERM'
      ? 'OpusHub does not have permission to list this root.'
      : 'This root could not be listed.';
  }

  const sensitive = SENSITIVE_PREFIXES.some((p) => under(real, p)) || resolvedClass.level === CLASS.SENSITIVE;

  return {
    ok: true,
    root: {
      id: rootIdFor(real),
      label: normalized === real ? normalized : `${normalized} → ${real}`,
      path: real,
      configuredPath: normalized,
      source,
      viaSymlink,
      fs: mount?.fs ?? null,
      device: mount?.device ?? null,
      ...(usage || { total: null, used: null, free: null, usedPct: null }),
      dataset: dataset ? { name: dataset.name, pool: dataset.pool } : null,
      sensitive,
      readable,
      reason,
    },
  };
}

/* ------------------------------------------------------------------ */
/* the table                                                           */
/* ------------------------------------------------------------------ */

/**
 * Injectable sources for the discovery half of the policy. By default they read the *existing*
 * storage providers through the Phase 9 registry: `filesystem` for real mounts, `zfs` for the
 * dataset mounted at a candidate root. Neither is a second mount reader.
 */
registerInfrastructureProviders();
const defaultMountSource = async () => (await checkProvider('filesystem'))?.data?.mounts || [];
const defaultDatasetSource = async () => (await checkProvider('zfs'))?.data?.datasets || [];
let mountSource = defaultMountSource;
let datasetSource = defaultDatasetSource;

/** Test hooks: discovery is only testable if it can be given a mount table. */
export function __setMountSource(fn) { mountSource = fn || defaultMountSource; cache = null; }
export function __setDatasetSource(fn) { datasetSource = fn || defaultDatasetSource; cache = null; }
export function __resetSources() { mountSource = defaultMountSource; datasetSource = defaultDatasetSource; cache = null; }

let cache = { at: 0, doc: null };

/**
 * The exposed roots, plus the candidates that were refused and why.
 *
 * Cached briefly (a mount table changes rarely, and a page load asks several times), and never
 * cached across a `_resetRoots()` in tests.
 */
export async function rootTable({ refresh = false, env = process.env, at = Date.now() } = {}) {
  if (!refresh && cache.doc && at - cache.at < LIMITS.rootTtlMs) return cache.doc;

  const { paths: configured, disabled } = configuredRoots(env);
  const dirs = opushubDirs();
  const roots = [];
  const refused = [];
  const taken = new Set();

  let datasets = [];
  if (!disabled) { try { datasets = (await datasetSource()) || []; } catch { datasets = []; } }

  const consider = async (candidate, { source, mount }) => {
    if (disabled) return;
    if (roots.length >= LIMITS.maxRoots) {
      refused.push({ path: candidate, source, code: 'root_limit', reason: `At most ${LIMITS.maxRoots} roots are exposed.` });
      return;
    }
    const normalized = nodePath.normalize(String(candidate)).replace(/\/+$/, '') || '/';
    const dataset = datasets.find((d) => d?.mountpoint && (d.mountpoint === normalized || d.mountpoint === candidate)) || null;
    const v = await validateRoot(candidate, { source, mount, dataset, taken, opushub: dirs });
    if (!v.ok) {
      refused.push({ path: String(candidate), source, code: v.code, class: v.class || null, reason: v.reason });
      return;
    }
    if (taken.has(v.root.path)) {
      refused.push({ path: String(candidate), source, code: 'duplicate', reason: 'That location is already exposed as another root.' });
      return;
    }
    taken.add(v.root.path);
    roots.push(v.root);
  };

  if (disabled) {
    refused.push({ path: null, source: 'policy', code: 'disabled', reason: 'The File Manager is disabled on this host (OPUSHUB_FILES_DISABLED).' });
  } else if (configured.length) {
    for (const p of configured) await consider(p, { source: 'configured', mount: null });
  } else {
    // Discovery: the mounts the *existing* filesystem provider already considers real. Its own
    // filter (no /proc, /sys, /dev, /run, /etc, /usr, /snap, /nix; no small tmpfs) plus the
    // validation above is what keeps `/` and the system out of the table.
    let mounts = [];
    try { mounts = await mountSource(); } catch { mounts = []; }
    const candidates = (mounts || [])
      .map((m) => m?.mount)
      .filter((m) => typeof m === 'string' && m.startsWith('/') && m !== '/')
      .filter((m) => !PROTECTED_PREFIXES.some((p) => p !== '/' && under(m, p)))
      .filter((m) => !dirs.some((d) => under(m, d) || under(d, m)));
    for (const m of candidates) {
      const mount = (mounts || []).find((x) => x.mount === m) || null;
      await consider(m, { source: 'discovered', mount });
    }
    if (!candidates.length && !roots.length) {
      refused.push({ path: null, source: 'discovery', code: 'no_mounts', reason: 'No mount on this host is eligible to be exposed as a filesystem root.' });
    }
  }

  // unique ids: two roots whose slugs collide keep their order and gain a suffix
  const seen = new Map();
  for (const r of roots) {
    const n = (seen.get(r.id) || 0) + 1;
    seen.set(r.id, n);
    if (n > 1) r.id = `${r.id}-${n}`.slice(0, 64);
  }
  // a root nested inside another root is reported as nested, so the tree does not look duplicated
  for (const r of roots) {
    const parent = roots.find((o) => o !== r && under(r.path, o.path));
    r.nestedUnder = parent ? parent.id : null;
  }
  roots.sort((a, b) => (a.source === b.source ? a.path.localeCompare(b.path) : a.source === 'configured' ? -1 : 1));

  const doc = {
    at,
    disabled,
    source: configured.length ? 'configured' : 'discovered',
    configuredVia: configured.length ? ROOTS_ENV : null,
    roots,
    refused,
    protectedPrefixes: PROTECTED_PREFIXES.filter((p) => p !== '/'),
    opushubProtected: dirs.length > 0,
  };
  cache = { at, doc };
  return doc;
}

/** The exposed roots only — what the UI renders. */
export async function listRoots(opts) {
  const t = await rootTable(opts);
  return t.roots;
}

/**
 * One root by id. `null` when the id is not in the table — including when it *looks* like a path,
 * which is the point: there is no way to address a root by naming a directory.
 */
export async function getRoot(id, opts) {
  if (!isRootId(id)) return null;
  const roots = await listRoots(opts);
  return roots.find((r) => r.id === id) || null;
}

/** Drop the cached table (a refresh, or a test that changed the host). */
export function _resetRoots() { cache = { at: 0, doc: null }; }

export const _internals = Object.freeze({ under, ID_RE, PROTECTED_PREFIXES, defaultMountSource, defaultDatasetSource });
