// Phase 11A — THE canonical filesystem path policy.
//
// Every read the File Manager performs (list, stat, preview, download, search, storage context,
// permission status, and every privileged broker request) resolves through this module and through
// nothing else. There is no second place in the server where a browser-supplied string becomes a
// host path.
//
// The rules, in the order they are applied:
//
//   1. SHAPE        a path is root-relative, bounded, and free of null bytes, control characters,
//                   percent-escapes that survived URL decoding, alternate separators and `..`
//                   segments. An absolute path is refused, not "helpfully" re-rooted.
//   2. CONTAINMENT  the joined path is normalized and must still be inside the root.
//   3. CLASS        every prefix of the path is classified: allowed · sensitive · protected.
//                   Protected means refused — the server enforces it, the UI never has to.
//   4. REALPATH     the resolved target's realpath must still be inside the root's realpath, so a
//                   symlink cannot leave: `/tank/media/link → /etc` makes `link/passwd` resolve to
//                   `/etc/passwd`, which is outside, and is refused as `symlink_escape`.
//   5. CLASS AGAIN  a symlink may point at a protected path *inside* the root (`.env`, a key);
//                   the canonical path is classified too.
//   6. MOUNTS       realpath cannot see a bind mount. `/proc/self/mountinfo` is read (cached) and a
//                   mount inside the root whose type is a kernel/pseudo filesystem, or whose source
//                   root is under a protected prefix, is refused as `mount_escape`.
//
// Denials are structured (`{ ok:false, code, reason, rule }`) so the API can answer with a stable
// code and an honest sentence, and never with a raw errno or a host path.
//
// This module names protected host paths in order to REFUSE them. It contains no transport: no
// socket, no HTTP client, no process, no write of any kind (see server/phase11a-files.test.js).
import fs from 'node:fs';
import nodePath from 'node:path';
import { BLOCKED_HOST_PATHS, SENSITIVE_HOST_PATHS } from '../containers/policy.js';
import { LIMITS } from './limits.js';

/** The three classifications a path can have. `allowed` is the only one that is served. */
export const CLASS = Object.freeze({ ALLOWED: 'allowed', SENSITIVE: 'sensitive', PROTECTED: 'protected' });

/** Why a path is protected. These names are safe to show; the paths themselves are not needed. */
export const PROTECTED_CLASSES = Object.freeze([
  'root_filesystem',      // "/" and anything that resolves to it
  'kernel_interface',     // /proc, /sys, /dev, /run and friends
  'system_directory',     // /etc, /usr, /bin, /sbin, /lib, /boot, /snap, /nix, /root
  'container_runtime',    // the Docker/containerd socket and state directories
  'opushub_secrets',      // OpusHub's own config and data directories (account, sessions, keys)
  'environment_file',     // .env and its variants — the classic place a token is left
  'credential_store',     // cloud/registry/database credential files
  'ssh_material',         // .ssh, .gnupg, agent sockets, key material
  'private_key',          // private keys, keystores, keytabs
  'password_database',    // shadow, sudoers, htpasswd, .pgpass
  'session_material',     // session/token files, cookie jars
  'protected_mount',      // a bind/pseudo mount that would open one of the above
]);

/**
 * Absolute prefixes that are never exposed, whatever the operator configured. `BLOCKED_HOST_PATHS`
 * (containers/policy.js) is imported rather than restated: one vocabulary for "paths that hand over
 * the host", two consumers — the container-spec classifier and this one.
 */
export const PROTECTED_PREFIXES = Object.freeze([...new Set([
  '/',
  ...BLOCKED_HOST_PATHS,
  // kernel interfaces and the runtime directories that hold sockets and pid files
  '/proc', '/sys', '/dev', '/run', '/var/run', '/var/lock', '/run/lock',
  // the system itself: binaries, libraries, boot, package manager state
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32', '/boot', '/snap', '/nix',
  // root's home (its .ssh is the prize) and the container runtimes' state
  '/root', '/var/lib/docker', '/var/lib/containerd', '/var/lib/containers', '/var/lib/lxc',
  '/lost+found',
].map((p) => p.replace(/\/+$/, '') || '/'))]);

/** Prefixes that are readable but need the stronger authorization (roots under them are `sensitive`). */
export const SENSITIVE_PREFIXES = Object.freeze([...SENSITIVE_HOST_PATHS]);

/**
 * Directory names that are protected themselves *and* protect everything below them. All of them
 * are dot-prefixed credential homes, so an ordinary media or stack directory can never be caught by
 * accident (`private`, `secrets`, `keys` are deliberately NOT here — they are normal directory names
 * in a homelab; the *files* inside them are classified by their own names).
 */
const PROTECTED_COMPONENTS = Object.freeze([
  '.ssh', '.gnupg', '.aws', '.kube', '.azure', '.config/gcloud', '.terraform.d', '.vault',
  '.local/share/keyrings', '.pki', '.certmonger', '.ssh-agent',
]);

/** Basenames that are protected wherever they appear inside an exposed root. */
const PROTECTED_BASENAMES = Object.freeze([
  '.env', '.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials', '.gitconfig-credentials',
  '.htpasswd', '.pgpass', '.my.cnf', '.boto', '.vault-token', '.docker-credentials',
  'shadow', 'shadow-', 'gshadow', 'gshadow-', 'sudoers', 'sudoers.tab', 'opasswd', 'master.passwd',
  'credentials', 'credentials.json', 'credentials.xml', 'credentials.db', 'service-account.json',
  'service_account.json', 'google-services-account.json', 'adc.json', 'token.json',
  'access_tokens.json', 'refresh_tokens.json', 'cookies.sqlite', 'keyring', 'keyring.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ed448', 'id_ecdsa_sk', 'id_ed25519_sk',
  '.gitlab-cli.yml', '.boto.cfg', 'rclone.conf', 'sftp-config.json', 's3cfg', '.s3cfg',
]);

/** Basename patterns (a name is protected when one of these matches the whole name). */
const PROTECTED_NAME_PATTERNS = Object.freeze([
  /^\.env\.(?!example$|sample$|template$|test$)[A-Za-z0-9._-]+$/,   // .env.production, .env.local …
  /^id_(rsa|dsa|ecdsa|ed25519|ed448)(-[A-Za-z0-9._-]+)?$/,          // private keys, not their .pub
  /\.(p12|pfx|keytab|kdbx|asc|gpg|age)$/i,                          // keystores and encrypted keys
  /\.(sock|socket)$/i,                                              // any socket: docker, containerd, …
  /^sessions?\.json$/i, /^session[-_.]?store/i, /^auth\.json$/i,     // session material
  /^(opushub|telegram|registries)[-_]?(token|secret|key)/i,          // OpusHub's own secrets by name
]);

/** Readable, but a download or a preview is recorded (one deduplicated security row). */
const SENSITIVE_BASENAMES = Object.freeze(['authorized_keys', 'known_hosts', '.bash_history', '.zsh_history', '.mysql_history', '.psql_history']);
const SENSITIVE_NAME_PATTERNS = Object.freeze([
  /\.(sql|dump|bak|backup|old|orig|save|swp|tmp)$/i,
  /\.(db|sqlite|sqlite3|mbtiles)$/i,
  /\.(pem|crt|cer|der|key|csr|ovpn|p7b)$/i,
  /^secrets?\./i, /\.secrets?\./i, /^passwords?\./i, /^tokens?\./i, /^.*\.credentials$/i,
  /^.*(passwd|pass|secret|token|apikey|api_key)[-_]?(list|store|db|file)?\.(txt|ya?ml|json|csv|env)$/i,
]);

/** Same lists as Sets: a listing classifies up to a few thousand entries, one lookup per name. */
const PROTECTED_BASENAME_SET = new Set(PROTECTED_BASENAMES);
const SENSITIVE_BASENAME_SET = new Set(SENSITIVE_BASENAMES);

const under = (p, root) => p === root || p.startsWith(`${root}/`);

/** A refusal, in the shape every caller expects. */
function refuse(code, reason, extra = {}) {
  return { ok: false, code, reason, status: extra.status ?? STATUS_BY_CODE[code] ?? 400, ...extra };
}

/**
 * One status map for every refusal the file manager can produce — policy, broker and API alike —
 * so a code means the same HTTP status everywhere and the UI can switch on `code` alone.
 */
export const STATUS_BY_CODE = Object.freeze({
  /* policy */
  bad_path: 400, bad_query: 400, bad_operation: 400, not_a_directory: 400, is_a_directory: 400,
  unknown_root: 404, not_found: 404, no_roots: 404,
  protected_path: 403, symlink_escape: 403, mount_escape: 403, root_isolation: 403,
  permission_required: 403, not_permitted: 403,
  too_large: 413, unsupported_preview: 415, entry_limit: 413,
  timeout: 504, provider_error: 500,
  /* broker */
  grant_required: 403, no_privileged_provider: 501, bad_provider: 400,
  /* API */
  auth_required: 401, method_not_allowed: 405, cancelled: 400,
  token_invalid: 403, token_expired: 403, token_session: 403, token_mismatch: 403,
});

/* ------------------------------------------------------------------ */
/* 1. shape — what a browser-supplied relative path may look like       */
/* ------------------------------------------------------------------ */

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PERCENT_ESCAPE_RE = /%[0-9a-fA-F]{2}/;

/**
 * Normalize and validate a root-relative path.
 *
 * Refuses rather than repairs: a path that needs fixing is a path whose author meant something we
 * are guessing at. The one leniency is a trailing slash, because a location bar produces them.
 *
 * @returns {{ok:true, relative:string, segments:string[]}|{ok:false, code:string, rule:string, reason:string}}
 */
export function normalizeRelative(raw) {
  if (raw == null || raw === '') return { ok: true, relative: '', segments: [] };
  if (typeof raw !== 'string') return { ok: false, code: 'bad_path', rule: 'not_a_string', reason: 'A path must be a string.' };
  let s = raw;
  if (s.length > LIMITS.maxPathLength) return { ok: false, code: 'bad_path', rule: 'too_long', reason: `That path is longer than ${LIMITS.maxPathLength} characters.` };
  if (s.includes('\u0000')) return { ok: false, code: 'bad_path', rule: 'null_byte', reason: 'A path may not contain a null byte.' };
  if (CONTROL_RE.test(s)) return { ok: false, code: 'bad_path', rule: 'control_character', reason: 'A path may not contain control characters.' };
  // URLSearchParams already decoded once; a surviving %XX means the path was encoded twice, which
  // is how `%252e%252e%252f` becomes `../` after a second decode somewhere down the line.
  if (PERCENT_ESCAPE_RE.test(s)) return { ok: false, code: 'bad_path', rule: 'encoded', reason: 'A percent-encoded path is not accepted.' };
  if (s.includes('\\')) return { ok: false, code: 'bad_path', rule: 'separator', reason: 'Backslashes are not path separators here.' };
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return { ok: false, code: 'bad_path', rule: 'absolute', reason: 'A path is relative to its root; an absolute path is not accepted.' };
  if (s.startsWith('~')) return { ok: false, code: 'bad_path', rule: 'home', reason: 'Home-relative paths are not accepted.' };

  // a trailing slash is a location-bar artifact; interior empty segments are not
  const trailing = s.endsWith('/');
  if (trailing) s = s.slice(0, -1);
  if (s === '') return { ok: true, relative: '', segments: [] };
  const parts = s.split('/');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '') return { ok: false, code: 'bad_path', rule: 'empty_segment', reason: 'A path may not contain an empty segment.' };
    if (seg === '..') return { ok: false, code: 'bad_path', rule: 'traversal', reason: 'A path may not contain a “..” segment.' };
    if (seg === '.') return { ok: false, code: 'bad_path', rule: 'dot_segment', reason: 'A path may not contain a “.” segment.' };
    if (seg.length > LIMITS.maxNameLength) return { ok: false, code: 'bad_path', rule: 'name_too_long', reason: `A name may not exceed ${LIMITS.maxNameLength} characters.` };
  }
  if (parts.length > LIMITS.maxPathDepth) return { ok: false, code: 'bad_path', rule: 'too_deep', reason: `A path may not be deeper than ${LIMITS.maxPathDepth} levels.` };
  return { ok: true, relative: parts.join('/'), segments: parts };
}

/* ------------------------------------------------------------------ */
/* 3. classification                                                    */
/* ------------------------------------------------------------------ */

/** Classify one absolute, normalized path. Returns `{ level, class, reason }`. */
export function classifyPath(absolute, { opushubDirs = null } = {}) {
  const abs = String(absolute || '');
  if (!abs.startsWith('/')) return { level: CLASS.PROTECTED, class: 'root_filesystem', reason: 'Only absolute host paths can be classified.' };

  if (abs === '/' || abs === '') return { level: CLASS.PROTECTED, class: 'root_filesystem', reason: 'The host root filesystem is never exposed.' };

  // OpusHub's own directories first: they are the one protected class that is not a fixed host
  // path, because the operator chooses where they live.
  for (const dir of opushubDirs || []) {
    if (dir && under(abs, String(dir))) {
      return { level: CLASS.PROTECTED, class: 'opushub_secrets', reason: 'This location holds OpusHub’s own account, session and secret files.' };
    }
  }

  // fixed protected prefixes (the container-runtime list includes the Docker socket paths)
  for (const p of PROTECTED_PREFIXES) {
    if (p === '/') continue;
    if (under(abs, p)) {
      const cls = /docker|containerd/.test(p) ? 'container_runtime'
        : ['/proc', '/sys', '/dev', '/run', '/var/run', '/var/lock', '/run/lock'].includes(p) ? 'kernel_interface'
          : p === '/root' ? 'ssh_material'
            : 'system_directory';
      return { level: CLASS.PROTECTED, class: cls, reason: reasonForClass(cls) };
    }
  }

  const segments = abs.split('/').filter(Boolean);
  const base = segments[segments.length - 1] || '';

  // credential homes: the directory itself is protected, and so is everything below it
  for (let i = 0; i < segments.length; i++) {
    if (PROTECTED_COMPONENTS.includes(segments[i])) {
      const cls = segments[i] === '.ssh' || segments[i] === '.gnupg' ? 'ssh_material' : 'credential_store';
      return { level: CLASS.PROTECTED, class: cls, reason: reasonForClass(cls) };
    }
    if (i + 1 < segments.length && PROTECTED_COMPONENTS.includes(`${segments[i]}/${segments[i + 1]}`)) {
      return { level: CLASS.PROTECTED, class: 'credential_store', reason: reasonForClass('credential_store') };
    }
    // a .git directory is browsable; its credential files are not
    if (segments[i] === '.git' && i + 1 < segments.length
      && ['config', 'credentials', 'credentials.lock', 'gitdir'].includes(segments[i + 1])) {
      return { level: CLASS.PROTECTED, class: 'credential_store', reason: reasonForClass('credential_store') };
    }
  }

  if (PROTECTED_BASENAME_SET.has(base)) {
    const cls = base.startsWith('.env') ? 'environment_file'
      : ['shadow', 'shadow-', 'gshadow', 'gshadow-', 'sudoers', 'sudoers.tab', 'opasswd', 'master.passwd', '.htpasswd', '.pgpass'].includes(base) ? 'password_database'
        : /^id_/.test(base) ? 'private_key'
          : /session|token|cookie|auth\.json/i.test(base) ? 'session_material'
            : 'credential_store';
    return { level: CLASS.PROTECTED, class: cls, reason: reasonForClass(cls) };
  }
  for (const re of PROTECTED_NAME_PATTERNS) {
    if (re.test(base)) {
      const cls = /^\.env/.test(base) ? 'environment_file'
        : /\.(sock|socket)$/i.test(base) ? 'container_runtime'
          : /\.(p12|pfx|keytab|kdbx|asc|gpg|age)$/i.test(base) || /^id_/.test(base) ? 'private_key'
            : /session|token|cookie/i.test(base) ? 'session_material'
              : 'credential_store';
      return { level: CLASS.PROTECTED, class: cls, reason: reasonForClass(cls) };
    }
  }

  if (SENSITIVE_BASENAME_SET.has(base)) return { level: CLASS.SENSITIVE, class: 'sensitive_file', reason: 'This file is readable; downloads of it are recorded.' };
  for (const re of SENSITIVE_NAME_PATTERNS) {
    if (re.test(base)) return { level: CLASS.SENSITIVE, class: 'sensitive_file', reason: 'This file is readable; downloads of it are recorded.' };
  }

  // a root (or anything) under a sensitive host directory is readable, but needs the stronger
  // authorization when it is a root — see roots.js
  for (const p of SENSITIVE_PREFIXES) if (under(abs, p)) return { level: CLASS.ALLOWED, class: 'sensitive_location', reason: null };
  return { level: CLASS.ALLOWED, class: null, reason: null };
}

function reasonForClass(cls) {
  switch (cls) {
    case 'root_filesystem': return 'The host root filesystem is never exposed.';
    case 'kernel_interface': return 'Kernel interfaces are never exposed.';
    case 'system_directory': return 'System directories are never exposed.';
    case 'container_runtime': return 'The container runtime socket and state are never exposed.';
    case 'opushub_secrets': return 'This location holds OpusHub’s own account, session and secret files.';
    case 'environment_file': return 'Environment files hold secrets and are never exposed.';
    case 'credential_store': return 'Credential stores are never exposed.';
    case 'ssh_material': return 'SSH and keyring material is never exposed.';
    case 'private_key': return 'Private keys and keystores are never exposed.';
    case 'password_database': return 'Password and sudo databases are never exposed.';
    case 'session_material': return 'Session and token files are never exposed.';
    case 'protected_mount': return 'A mount here would expose a protected location.';
    default: return 'This location is protected by policy.';
  }
}

/**
 * Classify a path *and every one of its ancestors*. A protected directory makes everything below it
 * protected, even when the leaf name looks harmless (`data/.ssh/authorized_keys`).
 */
export function classifyChain(absolute, opts = {}) {
  const abs = String(absolute || '');
  const segments = abs.split('/').filter(Boolean);
  let worst = { level: CLASS.ALLOWED, class: null, reason: null };
  for (let i = 1; i <= segments.length; i++) {
    const prefix = '/' + segments.slice(0, i).join('/');
    const c = classifyPath(prefix, opts);
    if (c.level === CLASS.PROTECTED) return c;
    if (c.level === CLASS.SENSITIVE && worst.level !== CLASS.SENSITIVE) worst = c;
  }
  return worst;
}

/* ------------------------------------------------------------------ */
/* 6. the mount table (bind/pseudo mounts realpath cannot see)          */
/* ------------------------------------------------------------------ */

/**
 * Filesystem types that are kernel interfaces or namespace plumbing. A mount of one of these inside
 * an exposed root is refused: it is how a container (or a curious operator) can put `/proc` or a
 * cgroup tree somewhere a realpath check would happily vouch for.
 *
 * Deliberately NOT here: `tmpfs`, `ramfs`, `overlay` and `squashfs`. They are ordinary storage —
 * denying them would refuse a scratch directory or a container image bind for no security gain, and
 * the dangerous ones (`/dev/shm`, `/run/…`) are already covered by their protected prefixes.
 */
const DENIED_FS_TYPES = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'cgroup', 'cgroup2', 'securityfs', 'debugfs', 'tracefs',
  'fusectl', 'mqueue', 'hugetlbfs', 'bpf', 'binfmt_misc', 'autofs', 'nsfs', 'configfs', 'pstore',
  'efivarfs', 'selinuxfs', 'rpc_pipefs', 'nfsd', 'fuse.lxcfs',
]);

/** mountinfo escapes octal in paths; only these four sequences are defined. */
function unescapeMountField(s) {
  return String(s).replace(/\\0(40|11|12|134)/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));
}

/**
 * Parse `/proc/self/mountinfo` into the four fields the policy needs.
 *
 *   mountPoint  where it appears in our namespace
 *   fsRoot      the path *inside the source filesystem* this mount exposes — `/etc` here is the
 *               signature of a bind mount of /etc
 *   fsType      the filesystem type
 *   source      the device or pseudo-source
 */
export function parseMountinfo(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split(' ');
    const sep = f.indexOf('-');
    if (sep < 5 || sep + 2 >= f.length) continue;
    out.push({
      mountPoint: unescapeMountField(f[4]),
      fsRoot: unescapeMountField(f[3]),
      fsType: f[sep + 1],
      source: unescapeMountField(f[sep + 2]),
      // mountinfo fields: 5 = per-mount options, 6..sep-1 = optional fields (shared:N, tag:…),
      // then `- fstype source superoptions`. A read-only bind says so in the options or the
      // superblock options, so both are kept.
      options: f[5] || '',
      superOptions: f[sep + 3] || '',
      optional: f.slice(6, sep).join(' '),
      readOnly: /(^|,)ro(,|$)/.test(`${f[5] || ''},${f[sep + 3] || ''}`),
    });
  }
  return out;
}

/** Which of those mounts the policy denies, and why. Pure — the reader is injectable for tests. */
export function deniedMounts(entries) {
  const out = [];
  for (const m of entries || []) {
    if (!m.mountPoint || m.mountPoint === '/') continue;
    if (DENIED_FS_TYPES.has(m.fsType)) { out.push({ ...m, class: 'protected_mount', reason: `A ${m.fsType} mount is not exposed.` }); continue; }
    if (m.fsRoot && m.fsRoot !== '/') {
      const c = classifyPath(m.fsRoot);
      if (c.level === CLASS.PROTECTED) { out.push({ ...m, class: 'protected_mount', reason: 'This mount exposes a protected location.' }); continue; }
    }
    if (/\.(sock|socket)$/i.test(m.mountPoint) || /\.(sock|socket)$/i.test(m.source || '')) {
      out.push({ ...m, class: 'container_runtime', reason: reasonForClass('container_runtime') });
    }
  }
  return out;
}

let mountReader = async () => {
  try { return await fs.promises.readFile('/proc/self/mountinfo', 'utf8'); } catch { return null; }
};
let mountCache = { at: 0, fresh: false, all: [], denied: [] };

const resetMountCache = () => { mountCache = { at: 0, fresh: false, all: [], denied: [] }; };

/** Test hook: replace the mount-table reader (the real one reads `/proc/self/mountinfo`). */
export function __setMountReader(fn) { mountReader = fn || (async () => null); resetMountCache(); }
export function __resetMountReader() { mountReader = async () => { try { return await fs.promises.readFile('/proc/self/mountinfo', 'utf8'); } catch { return null; } }; resetMountCache(); }

/**
 * The parsed mount table of *our own* namespace, cached. Used for storage context (which
 * filesystem a path sits on) and to decide which mounts the policy denies.
 */
export async function mountEntries(at = Date.now()) {
  if (mountCache.fresh && at - mountCache.at < LIMITS.mountTableTtlMs) return mountCache.all;
  let all = [];
  try {
    const text = await mountReader();
    if (text) all = parseMountinfo(text);
  } catch { all = []; }
  mountCache = { at, fresh: true, all, denied: deniedMounts(all) };
  return all;
}

/** The denied mounts in our own namespace, cached. Never served to a browser. */
export async function getDeniedMounts(at = Date.now()) {
  if (!mountCache.fresh || at - mountCache.at >= LIMITS.mountTableTtlMs) await mountEntries(at);
  return mountCache.denied;
}

/**
 * Which denied mount an absolute path sits at or inside, or `null`. Pure: the caller passes the
 * table it already fetched, so a walk can ask about thousands of paths without re-reading mounts.
 *
 * `resolve()` refuses a denied mount when a browser *names* it. The directory walks (tree, search)
 * and a listing's own entry filter use this so they never enumerate what the policy refuses to
 * read: a denied mount inside an exposed root is not descended into, not matched and not named.
 */
export function deniedMountAt(absolute, mounts = null) {
  if (typeof absolute !== 'string' || !absolute.startsWith('/')) return null;
  for (const m of mounts || []) {
    if (m && typeof m.mountPoint === 'string' && under(absolute, m.mountPoint)) return m;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 2 + 4 + 5 + 6 — resolution                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolve one browser-supplied `{ root, path }` pair into a host path that this policy vouches for.
 *
 * @param root   a root from files/roots.js: `{ id, path }` where `path` is already a realpath
 * @param path   the root-relative path from the request
 * @param opts.operation  'list' | 'stat' | 'read' | 'download' | 'search' — reported in a
 *                        permission_required refusal so the UI can say what was attempted
 * @param opts.opushubDirs OpusHub's own directories, protected wherever they live
 * @returns a result; on success `{ ok, relative, absolute, canonical, exists, lstat, stat,
 *          symlink, symlinkTarget, symlinkInside, classification }`
 */
export async function resolve({ root, path = '', operation = 'read', opushubDirs = null } = {}) {
  if (!root || typeof root !== 'object' || typeof root.path !== 'string' || !root.path.startsWith('/')) {
    return refuse('unknown_root', 'That is not a filesystem root OpusHub exposes.', { status: 404 });
  }
  const rel = normalizeRelative(path);
  if (!rel.ok) return refuse(rel.code, rel.reason, { rule: rel.rule });

  const absolute = rel.relative ? `${root.path}/${rel.relative}` : root.path;
  const normalized = nodePath.normalize(absolute);
  // containment on the normalized form: the join above cannot escape, and asserting it anyway means
  // a future refactor that builds `absolute` differently cannot silently drop the guarantee
  if (!under(normalized, root.path)) {
    return refuse('root_isolation', 'That path is outside its filesystem root.', { rule: 'containment' });
  }

  const lexical = classifyChain(normalized, { opushubDirs });
  if (lexical.level === CLASS.PROTECTED) {
    return refuse('protected_path', lexical.reason || reasonForClass(lexical.class), { class: lexical.class, operation });
  }

  // the deepest existing ancestor, so a not-yet-existing leaf still gets its parents checked
  let probe = normalized;
  let missing = null;
  for (;;) {
    try { await fs.promises.lstat(probe); break; } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
        const parent = nodePath.dirname(probe);
        if (parent === probe) return refuse('not_found', 'Nothing is at that path.', { status: 404, operation });
        missing = missing ? `${nodePath.basename(probe)}/${missing}` : nodePath.basename(probe);
        probe = parent;
        continue;
      }
      if (err?.code === 'EACCES' || err?.code === 'EPERM') {
        return refuse('permission_required', 'OpusHub does not currently have permission to read this location.', { operation, class: 'unreadable' });
      }
      if (err?.code === 'ELOOP') return refuse('symlink_escape', 'That path is a symlink loop.', { operation });
      if (err?.code === 'ENAMETOOLONG') return refuse('bad_path', 'That path is too long for the filesystem.', { rule: 'name_too_long' });
      return refuse('provider_error', 'The filesystem did not answer.', { operation, detail: err?.code || null });
    }
  }

  let canonical;
  try {
    canonical = await fs.promises.realpath(probe);
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      return refuse('permission_required', 'OpusHub does not currently have permission to read this location.', { operation });
    }
    // `lstat` above succeeds on a loop (it does not follow the final link), so the loop surfaces
    // here. Naming it honestly matters: "nothing is at that path" sends somebody hunting for a
    // deleted file, when the real answer is that this link cannot be resolved at all.
    if (err?.code === 'ELOOP') return refuse('symlink_escape', 'That path is a symlink loop.', { operation, class: 'symlink_escape' });
    if (err?.code === 'ENAMETOOLONG') return refuse('bad_path', 'That path is too long for the filesystem.', { rule: 'name_too_long' });
    return refuse('not_found', 'Nothing is at that path.', { status: 404, operation });
  }
  if (!under(canonical, root.path)) {
    // a symlink (or a chain of them) that leaves the root — the escape this whole module exists for
    return refuse('symlink_escape', 'That path resolves outside its filesystem root, so it is not served.', { operation, class: 'symlink_escape' });
  }
  const full = missing ? `${canonical}/${missing}` : canonical;

  // classify the canonical path too: a symlink inside the root may point at a protected file inside it
  if (missing == null) {
    const real = classifyChain(full, { opushubDirs });
    if (real.level === CLASS.PROTECTED) {
      return refuse('protected_path', real.reason || reasonForClass(real.class), { class: real.class, operation });
    }
  }

  // a bind or pseudo mount realpath cannot see
  for (const m of await getDeniedMounts()) {
    if (under(full, m.mountPoint)) {
      return refuse('mount_escape', m.reason || reasonForClass('protected_mount'), { operation, class: m.class });
    }
  }

  // Two sets of facts, because they answer different questions:
  //   requested  the path as the browser named it — a symlink is reported as the symlink it is
  //   lstat/stat the canonical target it resolves to — what a read would actually touch
  let requested = null;
  let lstat = null;
  let stat = null;
  if (missing == null) {
    try { requested = await fs.promises.lstat(normalized); } catch { requested = null; }
    try { lstat = await fs.promises.lstat(full); } catch { lstat = null; }
    // an unreadable target is not a missing one: the entry exists, its content is not ours to read
    try { stat = await fs.promises.stat(full); } catch { stat = null; }
  }

  const symlink = !!requested?.isSymbolicLink();
  let symlinkTarget = null;
  let symlinkInside = false;
  if (symlink) {
    try {
      const raw = await fs.promises.readlink(normalized);
      const lexical = nodePath.isAbsolute(raw) ? nodePath.normalize(raw) : nodePath.normalize(nodePath.join(nodePath.dirname(normalized), raw));
      // the target's *location* is only reported when it stays inside the root — a link must never
      // become a way to enumerate what is outside it. Outside targets are named as outside.
      let real = lexical;
      try { real = await fs.promises.realpath(lexical); } catch { real = null; }
      symlinkInside = !!real && under(real, root.path);
      symlinkTarget = symlinkInside ? (real.slice(root.path.length + 1) || '.') : null;
    } catch { symlinkTarget = null; }
  }

  // What this result is — and the one thing it is not.
  //
  // `canonical` is a path this policy vouched for *at this instant*: inside the root, not
  // protected, not a denied mount, with the facts below read from it. A caller then opens it, and
  // between the two there is a window — the classic check-then-use (TOCTOU) race: somebody who can
  // already write inside an exposed root could replace that file with a symlink in the meantime.
  // Closing it properly means resolving component by component with `openat()` + `O_NOFOLLOW` and
  // holding the descriptor, which Node's `fs` does not expose; so the window is documented here
  // rather than papered over, and nothing about the boundary is relaxed to make it smaller.
  //
  // What bounds it in practice:
  //   • the attacker needs local write access *inside a root the operator exposed* — a browser
  //     cannot create, rename or replace anything, because this whole feature is read-only;
  //   • every byte route re-resolves through this function when its reference is redeemed, so a
  //     stale answer is never reused as authority (see filesApi.js#streamBytes);
  //   • the open itself is read-only ('r'), so the worst case is reading a file that the same
  //     local user could have opened directly, without OpusHub involved at all.
  return {
    ok: true,
    root: { id: root.id, path: root.path },
    relative: rel.relative,
    segments: rel.segments,
    absolute: full,
    canonical: full,
    requestedPath: normalized,
    exists: missing == null,
    missing,
    requested,
    lstat,
    stat,
    symlink,
    symlinkTarget,
    symlinkInside,
    classification: classifyPath(full, { opushubDirs }),
    operation,
  };
}

/**
 * Is this absolute path protected? The one question the provider asks before it lists a directory
 * entry, so a protected file is never even named in a response.
 */
export function isProtected(absolute, { opushubDirs = null } = {}) {
  return classifyChain(absolute, { opushubDirs }).level === CLASS.PROTECTED;
}

export const _internals = Object.freeze({ under, PROTECTED_COMPONENTS, PROTECTED_BASENAMES, PROTECTED_BASENAME_SET, DENIED_FS_TYPES, reasonForClass });
