// Phase 11A — the canonical FilesystemProvider.
//
//     FilesystemProvider
//       roots()                          the roots the policy exposes (never the host's whole tree)
//       list({rootId, path})             one directory, bounded, sorted, protected entries omitted
//       tree({rootId, path})             the sidebar's lazy levels, directories only
//       stat({rootId, path})             file properties: size, times, mode, owner, symlink, class
//       read({rootId, path}, {tail})     a *bounded* read — the bytes behind a text preview
//       preview({rootId, path})          the preview document: server-detected kind + bounded text
//       download({rootId, path}, {range})a stream factory — nothing is ever buffered whole
//       search({rootId, path, query})    a bounded filename search inside one root
//       resolveRef({rootId, path})       what the path policy made of a request
//       permissionStatus({rootId, path}) readable | permission_required | protected | …
//
// `createFilesystemProvider()` below is the one implementation. It is **read-only by construction**:
// this module contains no write, unlink, mkdir, rename, chmod or chown call, and the phase test
// proves that mechanically. It also contains no process spawn, no shell and no Docker client — a
// `permission_required` answer is the end of the road here, not a trigger for elevation (the broker
// in files/broker.js owns that question, and owns its own refusals).
//
// Every method resolves its `{rootId, path}` through files/policy.js first. There is no code path
// here that touches the filesystem with a string a browser supplied.
//
// Relationship to the *existing* filesystem provider: `providers/storage.js#LinuxFilesystemProvider`
// is a mount/usage provider (what is mounted, how full it is). It is reused — through the Phase 9
// provider registry, in files/roots.js — as the source of discovered roots and of storage context.
// What did not exist anywhere in OpusHub was enumerating a directory the operator asked about; that
// is this contract, and it is the only one.
import fs from 'node:fs';
import nodePath from 'node:path';
import { LIMITS } from './limits.js';
import { CLASS, classifyPath, deniedMountAt, getDeniedMounts, resolve as resolvePath } from './policy.js';
import { getRoot, opushubDirs, rootTable } from './roots.js';
import { namesFor } from './identity.js';
import { decodeText, detect, inlineMode, previewRefusal } from './preview.js';

/** The operations this provider answers — a fixed vocabulary, the same one the broker is limited to. */
export const OPERATIONS = Object.freeze(['list', 'tree', 'stat', 'read', 'preview', 'download', 'search', 'resolve', 'permission-status']);

/** Sort keys the listing accepts. Anything else is `name`. */
export const SORTS = Object.freeze(['name', 'size', 'type', 'modified', 'permissions', 'owner']);

const refuse = (code, reason, extra = {}) => ({ ok: false, code, reason, status: extra.status ?? 400, ...extra });

/* ------------------------------------------------------------------ */
/* small honest helpers                                                */
/* ------------------------------------------------------------------ */

const TYPE_LABELS = Object.freeze({
  dir: 'Folder', file: 'File', symlink: 'Symbolic link', other: 'Special file',
  socket: 'Socket', fifo: 'Named pipe', block: 'Block device', character: 'Character device',
});

const EXT_LABELS = Object.freeze({
  txt: 'Text document', log: 'Log file', md: 'Markdown document', markdown: 'Markdown document',
  json: 'JSON document', yaml: 'YAML document', yml: 'YAML document', xml: 'XML document',
  html: 'HTML document', htm: 'HTML document', css: 'Stylesheet', js: 'JavaScript source',
  mjs: 'JavaScript source', ts: 'TypeScript source', tsx: 'TypeScript source', sh: 'Shell script',
  bash: 'Shell script', py: 'Python source', rb: 'Ruby source', go: 'Go source', rs: 'Rust source',
  c: 'C source', h: 'C header', conf: 'Configuration file', cfg: 'Configuration file',
  ini: 'INI file', toml: 'TOML document', env: 'Environment file', sql: 'SQL file',
  csv: 'CSV document', tsv: 'TSV document', pdf: 'PDF document',
  png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', gif: 'GIF image', webp: 'WebP image',
  avif: 'AVIF image', svg: 'SVG image', ico: 'Icon', heic: 'HEIC image',
  mp3: 'MP3 audio', flac: 'FLAC audio', m4a: 'M4A audio', ogg: 'Ogg audio', opus: 'Opus audio', wav: 'WAV audio',
  mp4: 'MP4 video', mkv: 'Matroska video', webm: 'WebM video', mov: 'QuickTime video', avi: 'AVI video',
  zip: 'ZIP archive', tar: 'Tape archive', gz: 'Gzip archive', tgz: 'Gzip archive', xz: 'XZ archive',
  '7z': '7-Zip archive', rar: 'RAR archive', iso: 'Disk image', deb: 'Debian package',
  rpm: 'RPM package', apk: 'Apk package', db: 'Database file', sqlite: 'SQLite database',
  bak: 'Backup file', key: 'Key file', crt: 'Certificate', pem: 'PEM file', ovpn: 'OpenVPN profile',
});

/** Content types the raw route may serve inline. Everything else is a download. */
export const INLINE_MIME = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', pdf: 'application/pdf',
});

export const extensionOf = (name) => {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  return i > 0 && i < n.length - 1 ? n.slice(i + 1).toLowerCase().slice(0, 12) : '';
};

/** `drwxr-xr-x` — the same ten characters `ls -l` shows, built from the mode bits. */
export function symbolicMode(mode, kind = 'file') {
  if (mode == null || !Number.isFinite(mode)) return null;
  const m = mode & 0o777;
  const bit = (r, w, x) => (m & r ? 'r' : '-') + (m & w ? 'w' : '-') + (m & x ? 'x' : '-');
  const prefix = kind === 'dir' ? 'd' : kind === 'symlink' ? 'l' : kind === 'socket' ? 's'
    : kind === 'fifo' ? 'p' : kind === 'block' ? 'b' : kind === 'character' ? 'c' : '-';
  return prefix + bit(0o400, 0o200, 0o100) + bit(0o40, 0o20, 0o10) + bit(0o4, 0o2, 0o1);
}

export const octalMode = (mode) => (mode == null ? null : '0' + (mode & 0o777).toString(8).padStart(3, '0'));

function kindOf(st, dirent = null) {
  if (st?.isDirectory() || dirent?.isDirectory()) return 'dir';
  if (st?.isSymbolicLink() || dirent?.isSymbolicLink()) return 'symlink';
  if (st?.isFile() || dirent?.isFile()) return 'file';
  if (st?.isSocket()) return 'socket';
  if (st?.isFIFO()) return 'fifo';
  if (st?.isBlockDevice()) return 'block';
  if (st?.isCharacterDevice()) return 'character';
  return 'other';
}

/** Run `work` under a deadline and an optional AbortSignal; both become structured refusals. */
async function bounded(work, { ms, signal = null, what = 'The filesystem' }) {
  if (signal?.aborted) return refuse('cancelled', 'That request was cancelled.', { status: 400 });
  let timer = null;
  const onAbort = () => {};
  try {
    return await new Promise((res, rej) => {
      timer = setTimeout(() => rej(Object.assign(new Error('deadline'), { code: 'timeout' })), ms);
      if (signal) signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { code: 'cancelled' })), { once: true });
      work().then(res, rej);
    });
  } catch (err) {
    if (err?.code === 'timeout') return refuse('timeout', `${what} did not answer in time.`, { status: 504 });
    if (err?.code === 'cancelled') return refuse('cancelled', 'That request was cancelled.', { status: 400 });
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    void onAbort;
  }
}

/** Map an errno to the structured answer the UI can act on. Never a raw errno in `reason`. */
export function fsRefusal(err, { operation = 'read', what = 'this location' } = {}) {
  const code = err?.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return refuse('permission_required', `OpusHub does not currently have permission to read ${what}.`, { operation, status: 403 });
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') return refuse('not_found', 'Nothing is at that path.', { operation, status: 404 });
  if (code === 'ELOOP') return refuse('symlink_escape', 'That path is a symlink loop.', { operation, status: 403 });
  if (code === 'ENAMETOOLONG') return refuse('bad_path', 'That path is too long for the filesystem.', { operation, status: 400 });
  if (code === 'EISDIR') return refuse('is_a_directory', 'That path is a directory.', { operation, status: 400 });
  if (code === 'EMFILE' || code === 'ENFILE') return refuse('provider_error', 'The host has no file descriptors left.', { operation, status: 503 });
  return refuse('provider_error', 'The filesystem did not answer.', { operation, status: 500, detail: code || null });
}

const PERMISSION_REQUIRED = (operation, path = null) => refuse(
  'permission_required',
  'OpusHub does not currently have permission to read this location.',
  { operation, status: 403, path },
);

/* ------------------------------------------------------------------ */
/* the provider                                                        */
/* ------------------------------------------------------------------ */

export function createFilesystemProvider({ dirs = null } = {}) {
  const opushub = () => dirs || opushubDirs();

  /** Resolve one `{rootId, path}` request into a policy result, or a structured refusal. */
  async function locate({ rootId, path }, operation, { mustExist = true } = {}) {
    const root = await getRoot(rootId);
    if (!root) return refuse('unknown_root', 'That is not a filesystem root OpusHub exposes.', { status: 404, operation });
    const r = await resolvePath({ root, path, operation, opushubDirs: opushub() });
    if (!r.ok) return r;
    if (mustExist && !r.exists) {
      return refuse('not_found', 'Nothing is at that path.', { status: 404, operation, root: { id: root.id, label: root.label } });
    }
    return { ok: true, root, resolved: r };
  }

  /** One directory entry. `parentAbs` has already been through the policy. */
  async function entryFor(parentAbs, parentRel, dirent, { rootPath, names = true, links = true } = {}) {
    const entryName = dirent.name;
    const abs = `${parentAbs}/${entryName}`;
    const rel = parentRel ? `${parentRel}/${entryName}` : entryName;
    const cls = classifyPath(abs, { opushubDirs: opushub() });
    let st = null;
    let statError = null;
    try { st = await fs.promises.lstat(abs); } catch (err) { statError = err?.code || 'error'; }
    const kind = kindOf(st, dirent);
    const ext = kind === 'file' || kind === 'symlink' ? extensionOf(entryName) : '';
    const who = names ? await namesFor({ uid: st?.uid ?? null, gid: st?.gid ?? null }) : { owner: null, group: null };
    let link = null;
    if (kind === 'symlink' && links) {
      try {
        const raw = await fs.promises.readlink(abs);
        const lexical = nodePath.isAbsolute(raw) ? nodePath.normalize(raw) : nodePath.normalize(nodePath.join(parentAbs, raw));
        // A listing never realpaths every link (one syscall per entry, for an answer that is
        // re-checked the moment the entry is opened), so `inside` here is lexical — and the target
        // is only named when the link stays inside the root.
        const inside = lexical.startsWith(`${rootPath}/`);
        link = { target: inside ? lexical.slice(rootPath.length + 1) : null, inside };
      } catch { link = { target: null, inside: false }; }
    }
    return {
      name: entryName,
      path: rel,
      kind,
      typeLabel: kind === 'dir' ? TYPE_LABELS.dir : kind === 'symlink' ? TYPE_LABELS.symlink
        : EXT_LABELS[ext] || (kind === 'file' ? 'File' : TYPE_LABELS[kind] || 'Special file'),
      ext: ext || null,
      size: st?.isDirectory() ? null : (st?.size ?? null),
      mtimeMs: st?.mtimeMs ?? null,
      ctimeMs: st?.ctimeMs ?? null,
      mode: st ? st.mode & 0o7777 : null,
      modeText: symbolicMode(st?.mode, kind),
      octal: octalMode(st?.mode),
      uid: st?.uid ?? null,
      gid: st?.gid ?? null,
      owner: who.owner,
      group: who.group,
      nlink: st?.nlink ?? null,
      symlink: kind === 'symlink',
      link,
      accessible: st != null,
      statError: st == null ? statError : null,
      sensitive: cls.level === CLASS.SENSITIVE,
      classification: cls.level === CLASS.ALLOWED ? null : cls.class || cls.level,
    };
  }

  function sortEntries(entries, sort, dir) {
    const key = SORTS.includes(sort) ? sort : 'name';
    const sign = dir === 'desc' ? -1 : 1;
    const value = (e) => {
      switch (key) {
        case 'size': return e.size ?? -1;
        case 'modified': return e.mtimeMs ?? -1;
        case 'type': return String(e.typeLabel || e.ext || '').toLowerCase();
        case 'permissions': return String(e.octal || '');
        case 'owner': return String(e.owner || e.uid || '').toLowerCase();
        default: return e.name.toLowerCase();
      }
    };
    return [...entries].sort((a, b) => {
      // folders first, always — that is what an explorer is
      if (a.kind === 'dir' && b.kind !== 'dir') return -1;
      if (b.kind === 'dir' && a.kind !== 'dir') return 1;
      const va = value(a); const vb = value(b);
      const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign || byName;
      return (String(va).localeCompare(String(vb)) || byName) * sign;
    });
  }

  /* ---- roots ---- */
  async function roots({ refresh = false } = {}) {
    const t = await rootTable({ refresh });
    return {
      ok: true,
      roots: t.roots,
      refused: t.refused,
      source: t.source,
      disabled: t.disabled,
      configuredVia: t.configuredVia,
      at: t.at,
    };
  }

  /* ---- list ---- */
  async function list({ rootId, path }, { sort = 'name', dir = 'asc', limit = null, offset = 0, signal = null } = {}) {
    return bounded(async () => {
      const loc = await locate({ rootId, path }, 'list');
      if (!loc.ok) return loc;
      const { root, resolved } = loc;
      if (!resolved.stat) return PERMISSION_REQUIRED('list', resolved.relative);
      if (!resolved.stat.isDirectory()) return refuse('not_a_directory', 'That path is a file, not a directory.', { status: 400, operation: 'list' });

      let dirents;
      try {
        dirents = await fs.promises.readdir(resolved.canonical, { withFileTypes: true });
      } catch (err) { return fsRefusal(err, { operation: 'list', what: 'this directory' }); }

      const scanned = dirents.length;
      const overScan = scanned > LIMITS.maxDirectoryScan;
      const pool = overScan ? dirents.slice(0, LIMITS.maxDirectoryScan) : dirents;

      // Protected entries never reach a response, and neither does an entry that *is* a denied
      // mount or sits inside one (a bind of a protected tree, a pseudo filesystem, a socket). Both
      // are counted, so a short listing is not a mystery — and the walk below cannot be used to
      // name what `resolve()` would refuse to open.
      const denied = await getDeniedMounts();
      let hidden = 0;
      const visible = [];
      for (const d of pool) {
        const abs = `${resolved.canonical}/${d.name}`;
        if (classifyPath(abs, { opushubDirs: opushub() }).level === CLASS.PROTECTED || deniedMountAt(abs, denied)) { hidden += 1; continue; }
        visible.push(d);
      }

      const cap = Math.max(1, Math.min(Number(limit) || LIMITS.maxDirectoryEntries, LIMITS.maxDirectoryEntries));
      const truncated = visible.length > cap || overScan;
      // name order is free; any other key needs the metadata, so a directory bigger than the cap is
      // paged in name order and sorted within the page — reported honestly as `sortScope: 'page'`
      const global = visible.length <= cap;
      const ordered = global ? visible : [...visible].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      const from = Math.max(0, Number(offset) || 0);
      const page = ordered.slice(from, from + cap);

      const entries = [];
      for (let i = 0; i < page.length; i += LIMITS.statConcurrency) {
        if (signal?.aborted) return refuse('cancelled', 'That request was cancelled.', { status: 400 });
        const chunk = page.slice(i, i + LIMITS.statConcurrency);
        entries.push(...await Promise.all(chunk.map((d) => entryFor(resolved.canonical, resolved.relative, d, { rootPath: root.path }))));
      }

      return {
        ok: true,
        root: { id: root.id, label: root.label, sensitive: root.sensitive },
        path: resolved.relative,
        canonical: resolved.canonical,
        kind: 'dir',
        entries: sortEntries(entries, sort, dir),
        sort: SORTS.includes(sort) ? sort : 'name',
        dir: dir === 'desc' ? 'desc' : 'asc',
        sortScope: global ? 'all' : 'page',
        count: entries.length,
        total: visible.length,
        hidden,
        scanned,
        offset: from,
        truncated,
        symlink: resolved.symlink,
        limits: { maxDirectoryEntries: LIMITS.maxDirectoryEntries, maxDirectoryScan: LIMITS.maxDirectoryScan },
        at: Date.now(),
      };
    }, { ms: LIMITS.listTimeoutMs, signal, what: 'The directory listing' });
  }

  /* ---- tree ---- */
  async function tree({ rootId, path }, { depth = 2, signal = null } = {}) {
    return bounded(async () => {
      const levels = Math.max(1, Math.min(Number(depth) || 1, LIMITS.maxTreeDepth));
      const loc = await locate({ rootId, path }, 'list');
      if (!loc.ok) return loc;
      const { root, resolved } = loc;
      if (!resolved.stat?.isDirectory()) return refuse('not_a_directory', 'That path is not a directory.', { status: 400, operation: 'list' });

      // one fetch for the whole walk: the table is cached, and a tree can visit thousands of paths
      const denied = await getDeniedMounts();

      const walk = async (abs, rel, level) => {
        if (level > levels || signal?.aborted) return [];
        let dirents;
        try { dirents = await fs.promises.readdir(abs, { withFileTypes: true }); } catch { return []; }
        const dirs = dirents
          .filter((d) => d.isDirectory())
          .filter((d) => classifyPath(`${abs}/${d.name}`, { opushubDirs: opushub() }).level !== CLASS.PROTECTED)
          // a denied mount inside the root is not a directory the tree may show, still less descend
          // into: its names would be enumerated by a walk that `resolve()` refuses to open
          .filter((d) => !deniedMountAt(`${abs}/${d.name}`, denied))
          .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
          .slice(0, LIMITS.maxTreeEntriesPerLevel);
        const out = [];
        for (const d of dirs) {
          const childRel = rel ? `${rel}/${d.name}` : d.name;
          out.push({
            name: d.name,
            path: childRel,
            kind: 'dir',
            truncated: dirents.length > LIMITS.maxTreeEntriesPerLevel,
            children: await walk(`${abs}/${d.name}`, childRel, level + 1),
          });
        }
        return out;
      };

      return { ok: true, root: { id: root.id, label: root.label }, path: resolved.relative, children: await walk(resolved.canonical, resolved.relative, 1), depth: levels, at: Date.now() };
    }, { ms: LIMITS.listTimeoutMs, signal, what: 'The directory tree' });
  }

  /* ---- stat ---- */
  async function stat({ rootId, path }, { signal = null } = {}) {
    return bounded(async () => {
      const loc = await locate({ rootId, path }, 'stat');
      if (!loc.ok) return loc;
      const { root, resolved } = loc;
      const l = resolved.lstat || resolved.requested;
      const st = resolved.stat || l;
      if (!l && !st) return PERMISSION_REQUIRED('stat', resolved.relative);
      const kind = kindOf(l || st);
      const who = await namesFor({ uid: l?.uid ?? null, gid: l?.gid ?? null });
      const ext = kind === 'file' ? extensionOf(nodePath.basename(resolved.requestedPath)) : '';
      let readable = false;
      try { await fs.promises.access(resolved.canonical, fs.constants.R_OK); readable = true; } catch { readable = false; }
      return {
        ok: true,
        root: { id: root.id, label: root.label, sensitive: root.sensitive },
        name: nodePath.basename(resolved.requestedPath) || root.label,
        path: resolved.relative,
        canonical: resolved.canonical,
        kind,
        typeLabel: kind === 'dir' ? TYPE_LABELS.dir : kind === 'symlink' ? TYPE_LABELS.symlink : EXT_LABELS[ext] || 'File',
        isDirectory: kind === 'dir',
        isFile: kind === 'file',
        symlink: resolved.symlink,
        // a link's target is named only when it stays inside the root: a symlink is not a way to
        // enumerate what OpusHub is not allowed to show
        link: resolved.symlink ? { target: resolved.symlinkTarget, inside: resolved.symlinkInside } : null,
        size: st && !st.isDirectory() ? st.size : null,
        mtimeMs: st?.mtimeMs ?? null,
        atimeMs: st?.atimeMs ?? null,
        ctimeMs: st?.ctimeMs ?? null,
        birthtimeMs: st?.birthtimeMs ?? null,
        mode: l ? l.mode & 0o7777 : null,
        modeText: symbolicMode(l?.mode, kind),
        octal: octalMode(l?.mode),
        uid: l?.uid ?? null,
        gid: l?.gid ?? null,
        owner: who.owner,
        group: who.group,
        nlink: st?.nlink ?? null,
        ext: ext || null,
        readable,
        writable: false,   // Phase 11A is read-only: nothing here can report a write path
        classification: resolved.classification?.level === CLASS.ALLOWED ? null : { level: resolved.classification?.level, class: resolved.classification?.class || null },
        sensitive: resolved.classification?.level === CLASS.SENSITIVE,
        previewable: kind === 'file' && (st?.size ?? 0) <= LIMITS.maxPreviewFileSize,
        limits: { maxPreviewBytes: LIMITS.maxPreviewBytes, maxPreviewFileSize: LIMITS.maxPreviewFileSize },
        at: Date.now(),
      };
    }, { ms: LIMITS.statTimeoutMs, signal, what: 'The file properties' });
  }

  /* ---- resolve ---- */
  async function resolveRef({ rootId, path }, { signal = null } = {}) {
    return bounded(async () => {
      const loc = await locate({ rootId, path }, 'resolve', { mustExist: false });
      if (!loc.ok) return loc;
      const { root, resolved } = loc;
      return {
        ok: true,
        root: { id: root.id, label: root.label },
        path: resolved.relative,
        canonical: resolved.canonical,
        exists: resolved.exists,
        kind: resolved.exists ? kindOf(resolved.lstat || resolved.stat) : null,
        symlink: resolved.symlink,
        insideRoot: true,
        classification: resolved.classification?.level === CLASS.ALLOWED ? null : resolved.classification,
      };
    }, { ms: LIMITS.statTimeoutMs, signal, what: 'Path resolution' });
  }

  /* ---- read (bounded) ---- */
  async function read({ rootId, path }, { maxBytes = LIMITS.maxPreviewBytes, tail = false, signal = null } = {}) {
    return bounded(async () => {
      const loc = await locate({ rootId, path }, 'read');
      if (!loc.ok) return loc;
      const { root, resolved } = loc;
      if (!resolved.stat) return PERMISSION_REQUIRED('read', resolved.relative);
      if (resolved.stat.isDirectory()) return refuse('is_a_directory', 'That path is a directory; directories are listed, not read.', { status: 400, operation: 'read' });

      const cap = Math.max(1, Math.min(Number(maxBytes) || LIMITS.maxPreviewBytes, LIMITS.maxPreviewBytes));
      const size = resolved.stat.size;
      const want = Math.min(cap, size);
      const offset = tail && size > want ? size - want : 0;
      const buf = Buffer.alloc(want);
      let bytesRead = 0;
      let handle = null;
      try {
        // 'r' only: no create, no write, no truncate. There is no flag combination in this module
        // that can modify a file. `resolved.canonical` was vouched for a moment ago by policy.js —
        // see the check-then-use note at the end of resolve() for what that does and does not mean.
        handle = await fs.promises.open(resolved.canonical, 'r');
        bytesRead = (await handle.read(buf, 0, want, offset)).bytesRead;
      } catch (err) { return fsRefusal(err, { operation: 'read', what: 'this file' }); }
      finally { try { await handle?.close(); } catch { /* nothing to do */ } }

      return {
        ok: true,
        root: { id: root.id, label: root.label },
        name: nodePath.basename(resolved.requestedPath),
        path: resolved.relative,
        canonical: resolved.canonical,
        bytes: buf.subarray(0, bytesRead),
        bytesRead,
        offset,
        size,
        truncated: size > bytesRead,
        tail: !!tail && offset > 0,
        sensitive: resolved.classification?.level === CLASS.SENSITIVE,
        classification: resolved.classification,
      };
    }, { ms: LIMITS.previewTimeoutMs, signal, what: 'The file read' });
  }

  /* ---- preview ---- */
  async function preview({ rootId, path }, { tail = false, signal = null } = {}) {
    const r = await read({ rootId, path }, { maxBytes: LIMITS.maxPreviewBytes, tail, signal });
    if (!r.ok) return r;
    const head = r.bytes.subarray(0, Math.min(r.bytes.length, LIMITS.sniffBytes));
    const detected = detect({ head, name: r.name, size: r.size });
    const base = {
      root: r.root, name: r.name, path: r.path, canonical: r.canonical,
      kind: detected.kind, subtype: detected.subtype, label: detected.label, mime: detected.mime,
      detectedBy: detected.detectedBy, activeContent: detected.activeContent,
      size: r.size, bytes: r.bytesRead, truncated: r.truncated, tail: r.tail,
      sensitive: r.sensitive,
    };
    const refused = previewRefusal(detected, { size: r.size });
    if (refused) {
      // a refusal to preview is still an honest answer *about* the file, so it carries the detection
      return { ...base, ok: false, code: refused.code, reason: refused.reason, status: refused.code === 'too_large' ? 413 : 415, inline: null, text: null };
    }
    const mode = inlineMode(detected);
    if (mode === 'text' || detected.kind === 'empty') {
      const decoded = detected.kind === 'empty' ? { text: '', encoding: 'utf-8', lossy: false } : decodeText(r.bytes);
      return {
        ...base,
        ok: true,
        inline: 'text',
        text: decoded.text,
        encoding: decoded.encoding,
        lossy: decoded.lossy,
        lines: decoded.text ? decoded.text.split('\n').length : 0,
        note: detected.activeContent
          ? 'Shown as text. Markup like this is never rendered inside OpusHub — nothing in a preview can run a script.'
          : detected.kind === 'empty' ? 'This file is empty.'
            : r.truncated ? `Showing ${tail ? 'the last' : 'the first'} ${Math.max(1, Math.round(r.bytesRead / 1024))} KB of ${Math.round(r.size / 1024)} KB.` : null,
      };
    }
    // images and PDFs are served as bytes from the token route; the API mints the reference
    return { ...base, ok: true, inline: mode, text: null, encoding: null, needsBytes: true };
  }

  /* ---- download (streamed) ---- */
  async function download({ rootId, path }, { range = null, signal = null } = {}) {
    return bounded(async () => {
      const loc = await locate({ rootId, path }, 'download');
      if (!loc.ok) return loc;
      const { root, resolved } = loc;
      if (!resolved.stat) return PERMISSION_REQUIRED('download', resolved.relative);
      if (resolved.stat.isDirectory()) return refuse('is_a_directory', 'That path is a directory; directories cannot be downloaded in this phase.', { status: 400, operation: 'download' });
      const name = nodePath.basename(resolved.requestedPath);
      // The extension decides the label; an unknown name is octet-stream, which the browser saves
      // rather than renders. The bytes are never sniffed into a type we would then serve inline.
      const mime = INLINE_MIME[extensionOf(name)] || 'application/octet-stream';
      return {
        ok: true,
        root: { id: root.id, label: root.label },
        file: {
          name,
          path: resolved.relative,
          canonical: resolved.canonical,
          size: resolved.stat.size,
          mtimeMs: resolved.stat.mtimeMs ?? null,
          mime,
          sensitive: resolved.classification?.level === CLASS.SENSITIVE,
          classification: resolved.classification?.level === CLASS.ALLOWED ? null : resolved.classification.class || resolved.classification.level,
        },
        range: range || null,
        // A factory, not an open stream: the API decides when to open it, and an unused one leaks
        // nothing. It opens the path this call resolved ('r' only); the API re-resolved it through
        // the whole policy when the reference was redeemed, which is what makes the gap between the
        // two as short as it can be without openat()/O_NOFOLLOW — see the note in policy.js#resolve.
        createStream: () => fs.createReadStream(resolved.canonical, { flags: 'r', ...(range ? { start: range.start, end: range.end } : {}) }),
      };
    }, { ms: LIMITS.statTimeoutMs, signal, what: 'The download' });
  }

  /* ---- search ---- */
  async function search({ rootId, path, query }, { limit = null, maxNodes = null, maxDepth = null, signal = null } = {}) {
    const q = typeof query === 'string' ? query.trim() : '';
    if (q.length < LIMITS.minSearchQuery) return refuse('bad_query', 'A search needs at least one character.', { status: 400, operation: 'search' });
    if (q.length > LIMITS.maxSearchQuery) return refuse('bad_query', `A search may not be longer than ${LIMITS.maxSearchQuery} characters.`, { status: 400, operation: 'search' });
    if (/[\u0000-\u001f\u007f]/.test(q)) return refuse('bad_query', 'A search may not contain control characters.', { status: 400, operation: 'search' });

    return bounded(async () => {
      const loc = await locate({ rootId, path }, 'search');
      if (!loc.ok) return loc;
      const { root, resolved } = loc;
      if (!resolved.stat?.isDirectory()) return refuse('not_a_directory', 'A search starts at a directory.', { status: 400, operation: 'search' });

      const needle = q.toLowerCase();
      const matchCap = Math.max(1, Math.min(Number(limit) || LIMITS.maxSearchMatches, LIMITS.maxSearchMatches));
      const nodeCap = Math.max(1, Math.min(Number(maxNodes) || LIMITS.maxSearchNodes, LIMITS.maxSearchNodes));
      const depthCap = Math.max(0, Math.min(maxDepth == null || !Number.isFinite(Number(maxDepth)) ? LIMITS.maxSearchDepth : Number(maxDepth), LIMITS.maxSearchDepth));
      const startedAt = Date.now();
      const deadline = startedAt + LIMITS.searchTimeoutMs;

      const matches = [];
      let visited = 0;
      let directories = 0;
      let stopped = null;
      const stack = [{ abs: resolved.canonical, rel: resolved.relative, depth: 0 }];
      const denied = await getDeniedMounts();

      while (stack.length) {
        if (signal?.aborted) { stopped = 'cancelled'; break; }
        if (Date.now() > deadline) { stopped = 'timeout'; break; }
        if (visited >= nodeCap) { stopped = 'nodes'; break; }
        if (matches.length >= matchCap) { stopped = 'matches'; break; }
        const node = stack.pop();
        if (node.depth > depthCap) continue;
        let dirents;
        try {
          dirents = await fs.promises.readdir(node.abs, { withFileTypes: true });
        } catch {
          // an unreadable branch is skipped, not treated as "no matches": the count still moves
          visited += 1;
          continue;
        }
        directories += 1;
        for (const d of dirents) {
          if (visited >= nodeCap) { stopped = 'nodes'; break; }
          visited += 1;
          const abs = `${node.abs}/${d.name}`;
          const rel = node.rel ? `${node.rel}/${d.name}` : d.name;
          const cls = classifyPath(abs, { opushubDirs: opushub() });
          if (cls.level === CLASS.PROTECTED) continue;
          // the same rule the tree walk applies: a search never names, matches or descends into a
          // mount the policy denies, however innocent its mountpoint looks by name
          if (deniedMountAt(abs, denied)) continue;
          const isDir = d.isDirectory();
          const isLink = d.isSymbolicLink();
          if (d.name.toLowerCase().includes(needle)) {
            let st = null;
            try { st = await fs.promises.lstat(abs); } catch { st = null; }
            matches.push({
              name: d.name,
              path: rel,
              depth: node.depth + 1,
              kind: isDir ? 'dir' : isLink ? 'symlink' : d.isFile() ? 'file' : 'other',
              typeLabel: isDir ? TYPE_LABELS.dir : EXT_LABELS[extensionOf(d.name)] || 'File',
              size: st && !st.isDirectory() ? st.size : null,
              mtimeMs: st?.mtimeMs ?? null,
              modeText: symbolicMode(st?.mode, isDir ? 'dir' : isLink ? 'symlink' : 'file'),
              sensitive: cls.level === CLASS.SENSITIVE,
            });
            if (matches.length >= matchCap) { stopped = 'matches'; break; }
          }
          // a directory symlink is never followed: it is the one way a bounded walk becomes
          // unbounded (and the one way it could leave the root)
          if (isDir && node.depth + 1 <= depthCap) stack.push({ abs, rel, depth: node.depth + 1 });
        }
      }

      return {
        ok: true,
        root: { id: root.id, label: root.label },
        path: resolved.relative,
        query: q,
        matches: matches.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path)),
        count: matches.length,
        visited,
        directories,
        depth: depthCap,
        stopped,
        truncated: stopped != null,
        elapsedMs: Date.now() - startedAt,
        followedSymlinks: false,
        limits: { maxSearchMatches: matchCap, maxSearchNodes: nodeCap, maxSearchDepth: depthCap, searchTimeoutMs: LIMITS.searchTimeoutMs },
        at: Date.now(),
      };
    }, { ms: LIMITS.searchTimeoutMs + 1000, signal, what: 'The search' });
  }

  /* ---- permission status ---- */
  async function permissionStatus({ rootId, path }, { signal = null } = {}) {
    return bounded(async () => {
      const loc = await locate({ rootId, path }, 'read', { mustExist: false });
      if (!loc.ok) {
        return {
          ok: true,
          state: loc.code === 'protected_path' ? 'protected'
            : loc.code === 'permission_required' ? 'permission_required'
              : loc.code === 'symlink_escape' || loc.code === 'mount_escape' ? 'blocked'
                : loc.code === 'unknown_root' ? 'unknown_root' : 'invalid',
          code: loc.code,
          reason: loc.reason,
          rule: loc.rule || null,
          class: loc.class || null,
          operation: 'read',
          path: typeof path === 'string' ? String(path).slice(0, LIMITS.maxPathLength) : null,
        };
      }
      const { root, resolved } = loc;
      if (!resolved.exists) {
        return { ok: true, state: 'not_found', code: 'not_found', reason: 'Nothing is at that path.', operation: 'read', path: resolved.relative, root: { id: root.id, label: root.label } };
      }
      let readable = false;
      try { await fs.promises.access(resolved.canonical, fs.constants.R_OK); readable = true; } catch { readable = false; }
      const operation = resolved.stat?.isDirectory() ? 'list' : 'read';
      if (!readable) {
        return {
          ok: true,
          state: 'permission_required',
          code: 'permission_required',
          reason: 'OpusHub does not currently have permission to read this location.',
          operation,
          path: resolved.relative,
          root: { id: root.id, label: root.label },
        };
      }
      const sensitive = resolved.classification?.level === CLASS.SENSITIVE;
      return {
        ok: true,
        state: sensitive ? 'sensitive' : 'readable',
        code: null,
        reason: sensitive ? 'Readable; downloads of this file are recorded.' : null,
        operation,
        path: resolved.relative,
        root: { id: root.id, label: root.label },
        kind: kindOf(resolved.lstat || resolved.stat),
        sensitive,
      };
    }, { ms: LIMITS.statTimeoutMs, signal, what: 'The permission check' });
  }

  return {
    id: 'local',
    label: 'Host filesystem (read-only)',
    operations: OPERATIONS,
    roots, list, tree, stat, read, preview, download, resolveRef, search, permissionStatus,
    _internals: Object.freeze({ locate, entryFor, sortEntries, opushub }),
  };
}

/** The one provider the API uses. */
export const filesystem = createFilesystemProvider();
