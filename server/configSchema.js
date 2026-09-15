// Phase 6 — the shared validation vocabulary for everything that can be imported, edited,
// exported or restored.
//
// Configuration is the only thing OpusHub lets a user write, so it is also the only place a
// hostile or merely broken value can enter the system. Before Phase 6 each writer carried its own
// ad-hoc checks; this module is the one place those limits live, so the importer, the editors, the
// history/restore path and the exporter cannot drift apart and disagree about what is acceptable.
//
// The rule this file exists to serve:
//
//     Docker decides WHAT EXISTS. Configuration decides HOW IT IS PRESENTED.
//
// Nothing here can describe infrastructure. There is no helper for a container id, an image, a
// mount, a network or an environment variable, because no configuration surface may set one.
// See server/configScope.js for the file-level half of that boundary.

/**
 * Hard limits. Every one of them is enforced *before* a value is stored, and every one of them is
 * deliberately generous enough for a large homelab and small enough that a mistake is a fast,
 * legible failure rather than a hung server.
 */
export const LIMITS = {
  /** One imported file may not exceed this. Homepage configs are kilobytes; 512 KB is indulgence. */
  importFileBytes: 512 * 1024,
  /** Total across an imported bundle. */
  importBundleBytes: 2 * 1024 * 1024,
  /** How many files one import may carry. */
  importFiles: 16,
  /** Nesting depth a parsed document may reach — a deeply nested YAML is a denial-of-service. */
  yamlDepth: 12,
  /** Total nodes (maps + sequences + scalars) one parsed file may contain. */
  yamlNodes: 20_000,
  /** Alias/anchor count, which is the classic YAML expansion bomb. */
  yamlAliases: 0,
  /** Generic string ceiling. */
  stringLength: 2000,
  /** Display names, group names, stack names. */
  nameLength: 80,
  /** Descriptions and one-line notes. */
  descriptionLength: 300,
  /** Longer free text (stack notes). */
  noteLength: 1000,
  /** URLs. */
  hrefLength: 2000,
  /** Icon references. */
  iconLength: 400,
  /** Group count in one overlay document. */
  groups: 200,
  /** Service overlay entries in one document. */
  services: 2000,
  /** Bookmark entries in one document. */
  bookmarks: 2000,
  /** Bookmarks inside a single group. */
  bookmarksPerGroup: 500,
  /** Widget instances in one layout. */
  widgets: 60,
  /** Custom CSS size. */
  cssBytes: 256 * 1024,
  /** Custom JS size. */
  jsBytes: 256 * 1024,
  /** Retained configuration history versions. Bounded — history must never grow without limit. */
  historyVersions: 60,
  /** Largest single history snapshot. */
  historySnapshotBytes: 4 * 1024 * 1024,
  /** Total bytes the whole history directory may occupy before the oldest are pruned. */
  historyTotalBytes: 24 * 1024 * 1024,
};

/** Group/service names are deliberately narrow: they end up in URLs and in filenames-by-hand. */
const NAME_RE = /^[A-Za-z0-9 ._'-]+$/;

export class ConfigError extends Error {
  constructor(message, { status = 400, code = 'invalid_config', detail = null } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.status = status;
    this.code = code;
    if (detail) this.detail = detail;
  }
}

export const configError = (message, opts) => new ConfigError(message, opts);

/** Trim + clamp a string, treating anything non-string as absent. */
export function boundedString(value, max = LIMITS.stringLength) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** Trim + clamp, but *report* truncation instead of silently swallowing it. */
export function clipped(value, max, label) {
  const s = boundedString(value, max + 1);
  if (s == null) return { value: null, clipped: false };
  if (s.length > max) return { value: s.slice(0, max), clipped: true, label };
  return { value: s, clipped: false };
}

export function validGroupName(name) {
  const s = boundedString(name, LIMITS.nameLength);
  return !!s && NAME_RE.test(s);
}

/**
 * A group name OpusHub is willing to *write*. This is the same charset `model.writeServices`
 * enforces, exported so the importer can check it before a write is attempted rather than after it
 * fails — a migration that dies on the twelfth group should have said so on the first screen.
 */
export function writableGroupName(name, fallback = 'Ungrouped') {
  const s = boundedString(name, LIMITS.nameLength);
  if (!s) return { name: fallback, changed: false };
  if (validGroupName(s)) return { name: s, changed: false };
  // Deterministic, lossless-where-possible repair: keep the words, drop what cannot be stored.
  const repaired = s.replace(/[^A-Za-z0-9 ._'-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.nameLength);
  return { name: repaired || fallback, changed: true, from: s };
}

/**
 * Escape hatch for values that are *displayed* but never parsed: a group called `Media 🎬` is fine,
 * a group called `../../etc` is not. Emoji and non-Latin scripts are allowed; path separators,
 * control characters and the characters that break a URL segment are not.
 */
export function validDisplayName(name) {
  const s = boundedString(name, LIMITS.nameLength);
  if (!s) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (/[/\\]/.test(s)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// URL / icon / reference safety (the same rules the editors enforce, one copy)
// ---------------------------------------------------------------------------

/**
 * A href OpusHub is willing to render. Returns the value or throws a ConfigError.
 * `relative` allows same-origin paths (`/user/...`, `/services/...`).
 */
export function safeHref(value, { label = 'href', relative = true } = {}) {
  const s = boundedString(value, LIMITS.hrefLength);
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^mailto:/i.test(s)) return s;
  if (relative && s.startsWith('/') && !s.startsWith('//')) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    throw configError(`${label} uses an unsupported scheme: ${s.slice(0, 40)}`, { code: 'unsafe_href' });
  }
  throw configError(`${label} must be an absolute URL or a same-origin path`, { code: 'unsafe_href' });
}

/**
 * An icon reference OpusHub is willing to render. Four shapes only:
 *   · `set:name` (a bundled collection, resolved offline first)
 *   · an absolute http(s) URL
 *   · `/user/icons/<file>` (the safe user-content boundary)
 *   · an emoji / short glyph
 * Anything else — notably a filesystem path — is refused.
 */
export function safeIcon(value, { label = 'icon' } = {}) {
  const s = boundedString(value, LIMITS.iconLength);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/user/icons/')) {
    // No traversal, no encoding tricks, no nested directories.
    const rest = s.slice('/user/icons/'.length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(rest) || rest.includes('..')) {
      throw configError(`${label} must name a file directly inside /user/icons/`, { code: 'unsafe_icon' });
    }
    return s;
  }
  if (s.startsWith('/')) {
    throw configError(`${label} may only point inside /user/icons/ — filesystem paths are not accepted`, { code: 'unsafe_icon' });
  }
  if (/^[a-z][a-z0-9-]*:[a-z0-9+._-]+$/i.test(s)) return s;
  if (s.length <= 8) return s; // emoji or a two-letter monogram override
  throw configError(`${label} is not a recognised icon reference: ${s.slice(0, 40)}`, { code: 'unsafe_icon' });
}

/** Path-traversal and absolute-path refusal, for anything claiming to be a user content file. */
export function safeUserAssetPath(value, { dir = 'icons' } = {}) {
  const s = boundedString(value, 200);
  if (!s) return null;
  if (s.includes('\0')) throw configError('path contains a null byte', { code: 'unsafe_path' });
  if (s.startsWith('/') || /^[a-z]:/i.test(s) || s.startsWith('\\\\')) {
    throw configError('absolute paths are not accepted', { code: 'unsafe_path' });
  }
  if (s.split(/[/\\]/).includes('..')) {
    throw configError('path traversal is not accepted', { code: 'unsafe_path' });
  }
  if (s.includes('/') || s.includes('\\')) {
    throw configError('nested paths are not accepted — only a bare filename', { code: 'unsafe_path' });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(s)) {
    throw configError(`not a valid ${dir} filename`, { code: 'unsafe_path' });
  }
  return s;
}

// ---------------------------------------------------------------------------
// Structural limits — measured on the *parsed* value, not the text
// ---------------------------------------------------------------------------

/** Depth of a parsed JSON-ish value. Scalars are depth 0. */
export function depthOf(value, cap = LIMITS.yamlDepth + 1) {
  let max = 0;
  const walk = (v, d) => {
    if (d > max) max = d;
    if (d > cap || v == null || typeof v !== 'object') return;
    for (const child of Array.isArray(v) ? v : Object.values(v)) walk(child, d + 1);
  };
  walk(value, 0);
  return max;
}

/** Count of maps + sequences + scalars. */
export function countNodes(value, cap = LIMITS.yamlNodes + 1) {
  let n = 0;
  const walk = (v) => {
    if (++n > cap) return;
    if (v == null || typeof v !== 'object') return;
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      if (n > cap) return;
      walk(child);
    }
  };
  walk(value);
  return n;
}

/**
 * The gate every imported document passes through. Refuses by measure, not by trust:
 * size first (cheapest), then depth, then node count, then aliases.
 *
 * `text` is the raw file, `parsed` the result of parsing it. Both are checked because a small
 * file can still expand into an enormous document and vice versa.
 */
export function assertWithinLimits(name, { text, parsed } = {}) {
  if (typeof text === 'string') {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > LIMITS.importFileBytes) {
      throw configError(`${name} is ${Math.round(bytes / 1024)} KB — the import cap is ${Math.round(LIMITS.importFileBytes / 1024)} KB per file`, { status: 413, code: 'import_too_large' });
    }
    // YAML anchors/aliases are the standard expansion bomb and nothing OpusHub writes uses them.
    const aliases = (text.match(/(^|[\s:[,{])[*&][A-Za-z0-9_-]+/g) || []).length;
    if (aliases > LIMITS.yamlAliases) {
      throw configError(`${name} uses YAML anchors/aliases, which are not accepted in imported configuration`, { code: 'import_aliases' });
    }
  }
  if (parsed !== undefined) {
    const depth = depthOf(parsed);
    if (depth > LIMITS.yamlDepth) {
      throw configError(`${name} nests ${depth} levels deep — the import cap is ${LIMITS.yamlDepth}`, { code: 'import_too_deep' });
    }
    const nodes = countNodes(parsed);
    if (nodes > LIMITS.yamlNodes) {
      throw configError(`${name} contains more than ${LIMITS.yamlNodes} values — that is not a dashboard configuration`, { code: 'import_too_many_nodes' });
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Custom CSS / JS — syntax sanity, never execution
// ---------------------------------------------------------------------------

/**
 * A *practical* check, not a parser. It exists so a half-finished edit is caught before it is
 * saved and the whole installation renders unstyled, which is the failure that actually happens.
 *
 * OpusHub never evaluates either of these on the server — this function only reads characters.
 */
export function lintCss(text) {
  const problems = [];
  const src = String(text ?? '');
  if (!src.trim()) return { ok: true, problems };
  let depth = 0;
  let inComment = false;
  let inString = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inComment) { if (c === '*' && next === '/') { inComment = false; i++; } continue; }
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && next === '*') { inComment = true; i++; continue; }
    if (c === '"' || c === "'") { inString = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth < 0) { problems.push('a closing brace has no opening brace'); depth = 0; } }
  }
  if (inComment) problems.push('a comment is never closed');
  if (inString) problems.push('a string is never closed');
  if (depth > 0) problems.push(`${depth} block${depth === 1 ? ' is' : 's are'} never closed`);
  // `@import` pulls a stylesheet from another origin into an authenticated page — refuse it rather
  // than let customization become a way to load third-party code into the app shell.
  if (/@import/i.test(src)) problems.push('@import is not allowed — it would load a third-party stylesheet into an authenticated page');
  if (/expression\s*\(/i.test(src)) problems.push('CSS expression() is not supported by any current browser and is not allowed');
  if (/javascript:/i.test(src)) problems.push('javascript: URLs are not allowed in custom CSS');
  return { ok: problems.length === 0, problems };
}

/**
 * Balanced-delimiter check for custom JS. Deliberately shallow: the browser is the only thing that
 * ever runs this, so a full parse here would buy nothing but a second implementation to disagree
 * with. What it does buy is catching a truncated paste before it is written.
 */
export function lintJs(text) {
  const problems = [];
  const src = String(text ?? '');
  if (!src.trim()) return { ok: true, problems };
  const stack = [];
  let i = 0;
  let line = 1;
  let inLine = false;
  let inBlock = false;
  let inString = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '\n') { line++; inLine = false; }
    if (inLine) { i++; continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } i++; continue; }
    if (inString) {
      if (c === '\\') { i += 2; continue; }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '/' && next === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inString = c; i++; continue; }
    if (c === '(' || c === '[' || c === '{') stack.push({ c, line });
    else if (c === ')' || c === ']' || c === '}') {
      const open = stack.pop();
      const want = { ')': '(', ']': '[', '}': '{' }[c];
      if (!open) { problems.push(`line ${line}: an unmatched ${c}`); break; }
      if (open.c !== want) { problems.push(`line ${line}: ${c} closes a ${open.c} opened on line ${open.line}`); break; }
    }
    i++;
  }
  if (inString) problems.push('a string is never closed');
  if (inBlock) problems.push('a block comment is never closed');
  if (stack.length) {
    const top = stack[stack.length - 1];
    problems.push(`${stack.length} unclosed delimiter${stack.length === 1 ? '' : 's'} — the last opens on line ${top.line}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The credential scrubber.
 *
 * Homepage's configuration routinely carries live secrets — widget API keys, integration
 * passwords, docker socket credentials. None of them have any meaning in OpusHub's presentation
 * model, so the importer drops them on the way in *and* the exporter drops them on the way out.
 * This is the single list both use, so they cannot disagree about what counts as a secret.
 */
export const SECRET_KEYS = new Set([
  'key', 'apikey', 'api_key', 'api-key', 'token', 'accesstoken', 'access_token',
  'password', 'passwd', 'pwd', 'secret', 'clientsecret', 'client_secret',
  'username', 'user', 'login', 'credential', 'credentials', 'auth', 'authorization',
  'privatekey', 'private_key', 'sshkey', 'ssh_key', 'passphrase', 'salt', 'hash',
  'cookie', 'sessionkey', 'session_key', 'bearer', 'signature', 'webhook', 'webhookurl',
]);

/** Keys that describe infrastructure we must never accept as configuration. */
export const INFRASTRUCTURE_KEYS = new Set([
  'socket', 'dockersocket', 'container', 'containerid', 'image', 'ports', 'port',
  'volumes', 'networks', 'labels', 'compose', 'project', 'namespace', 'cluster',
  'env', 'environment', 'command', 'entrypoint', 'privileged', 'capabilities',
]);

export const isSecretKey = (key) => SECRET_KEYS.has(String(key ?? '').toLowerCase().replace(/[\s_]/g, ''));
export const isInfrastructureKey = (key) => INFRASTRUCTURE_KEYS.has(String(key ?? '').toLowerCase().replace(/[\s_-]/g, ''));

/**
 * Walk a parsed value and remove every secret-looking key, reporting each removal.
 * Returns a new value; the input is never mutated.
 */
export function scrubSecrets(value, path = '') {
  const removed = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${p}[${i}]`));
    if (v == null || typeof v !== 'object') return v;
    const out = {};
    for (const [k, child] of Object.entries(v)) {
      const here = p ? `${p}.${k}` : k;
      if (isSecretKey(k)) { removed.push(here); continue; }
      out[k] = walk(child, here);
    }
    return out;
  };
  const scrubbed = walk(value, path);
  return { value: scrubbed, removed };
}
