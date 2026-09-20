// Phase 11A — the file manager's data layer.
//
// Everything the Files page knows about the filesystem comes through here, and everything here is a
// GET against `/api/files/*` with two addressing parameters:
//
//     root=<rootId>   a slug for a path the *server* validated (never a path the browser chose)
//     path=<relative> a path relative to that root
//
// There is no function in this file that can write, delete, rename, move, copy, upload, mkdir,
// chmod or chown — not because a check refuses it, but because there is nothing to call. The one
// POST is `requestAccess()`, which asks the privilege broker about *reading*.
//
// Polling is deliberately off (`intervalMs = 0`): a directory listing is fetched when the operator
// navigates to it and when they ask for a refresh. A file manager that re-read the host every few
// seconds would be a load generator, not a UI.
import { useMemo } from 'react';
import { ApiError, post, usePolled } from './api';
import type {
  FileListDoc, FilePreviewDoc, FileSearchDoc, FileStatDoc, FileTreeDoc,
  FilesRefusal, FilesRootsDoc, FilesSurface, PermissionStatusDoc, PrivilegeRequestResult,
  PrivilegedOperation,
} from './types';

/* ------------------------------------------------------------------ */
/* paths                                                               */
/* ------------------------------------------------------------------ */

/** The root-relative path of a location's parent. The parent of a top-level entry is the root. */
export function parentPath(p: string | null | undefined): string {
  const s = String(p || '').replace(/^\/+|\/+$/g, '');
  if (!s) return '';
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i);
}

/** Join two root-relative paths without ever producing a leading or doubled slash. */
export function joinPath(a: string | null | undefined, b: string | null | undefined): string {
  const left = String(a || '').replace(/^\/+|\/+$/g, '');
  const right = String(b || '').replace(/^\/+|\/+$/g, '');
  if (!left) return right;
  if (!right) return left;
  return `${left}/${right}`;
}

/** Breadcrumb segments: `a/b/c` → [{name:'a', path:'a'}, …]. The root itself is not a segment. */
export function pathSegments(p: string | null | undefined): { name: string; path: string }[] {
  const s = String(p || '').replace(/^\/+|\/+$/g, '');
  if (!s) return [];
  const parts = s.split('/');
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}

/** A path is safe to put in a URL when it has no dot segments and no leading slash. The server
 *  re-checks all of this; doing it here too means a malformed URL never leaves the browser. */
export function isSaneRelative(p: string | null | undefined): boolean {
  const s = String(p ?? '');
  if (s.length > 4096) return false;
  if (s.startsWith('/') || s.includes('\\') || s.includes('\u0000')) return false;
  return !s.split('/').some((seg) => seg === '..' || seg === '.');
}

/**
 * The short name a root is shown by.
 *
 * The server's label is the path the operator configured — the honest identifier, and the one a
 * refusal quotes — but `/tank/media` is too long for a breadcrumb. So the UI shows the last segment
 * and keeps the full path underneath it (and in a tooltip). A label that is not a path (`Media`,
 * `Backups`) is used exactly as given, and a symlinked root is labelled `configured → resolved`, of
 * which the configured side is the name.
 */
export function rootName(root: { label?: string | null; path?: string | null } | null | undefined): string {
  const label = String(root?.label || root?.path || '').trim();
  if (!label) return 'Root';
  const configured = label.split('\u2192')[0].trim();
  if (!configured.startsWith('/')) return configured;
  const base = configured.replace(/\/+$/, '').split('/').filter(Boolean).pop();
  return base || configured;
}

/* ------------------------------------------------------------------ */
/* URLs                                                                */
/* ------------------------------------------------------------------ */

type Params = Record<string, string | number | boolean | null | undefined>;

/** Build one `/api/files/*` URL. Null and undefined parameters are dropped, not sent empty. */
export function filesUrl(route: string, params: Params = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || v === false) continue;
    q.set(k, v === true ? '1' : String(v));
  }
  const s = q.toString();
  return `/api/files/${route.replace(/^\//, '')}${s ? `?${s}` : ''}`;
}

/**
 * The download link for one file. It is a plain `<a href>`: the server mints a short-lived
 * reference and redirects to it, so no token is ever held in the page's state and no host path
 * appears in a URL. Downloads are the browser's own job from there.
 */
export function downloadHref(root: string | null, path: string | null): string | null {
  if (!root || path == null || !isSaneRelative(path)) return null;
  return filesUrl('download', { root, path });
}

/* ------------------------------------------------------------------ */
/* refusals                                                            */
/* ------------------------------------------------------------------ */

/**
 * Turn a thrown ApiError into the structured refusal the API sent. The UI switches on `code`
 * (`permission_required`, `protected_path`, `too_large`, …) and renders `error` verbatim, so a
 * refusal is a sentence rather than an exception.
 */
export function asRefusal(err: unknown): FilesRefusal | null {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const body = err.body as Partial<FilesRefusal>;
    if (typeof body.code === 'string') return { error: body.error || err.message, ...body } as FilesRefusal;
  }
  return null;
}

/**
 * Build a refusal from a query's `error` + `errorCode` pair — the shape a page actually has after a
 * fetch. The code is what a panel switches on; the message is what it prints.
 */
export function refusalOf(error: string | null, code?: string | null, body?: unknown): FilesRefusal | null {
  if (!error && !body) return null;
  const sent = body && typeof body === 'object' ? body as Partial<FilesRefusal> : {};
  return { ...sent, error: sent.error || error || 'That request did not succeed.', code: sent.code || code || 'provider_error' };
}

/** The sentence to show when a request failed for a reason the API did not structure. */
export function refusalText(r: FilesRefusal | null, fallback: string | null): string {
  return r?.error || fallback || 'That request did not succeed.';
}

/* ------------------------------------------------------------------ */
/* queries                                                             */
/* ------------------------------------------------------------------ */

export interface ListParams {
  root: string | null;
  path: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number | null;
  offset?: number | null;
}

/** One directory. `path` must be root-relative and sane; anything else fetches nothing at all. */
export function useFileList({ root, path, sort = 'name', dir = 'asc', limit, offset }: ListParams) {
  const url = useMemo(() => {
    if (!root || !isSaneRelative(path)) return null;
    return filesUrl('list', { root, path, sort, dir, limit, offset });
  }, [root, path, sort, dir, limit, offset]);
  return usePolled<FileListDoc>(url, 0);
}

/** The sidebar's folders, a bounded number of levels deep. */
export function useFileTree(root: string | null, path: string, depth = 2) {
  const url = useMemo(() => {
    if (!root || !isSaneRelative(path)) return null;
    return filesUrl('tree', { root, path, depth });
  }, [root, path, depth]);
  return usePolled<FileTreeDoc>(url, 0);
}

/** One location's properties, with storage context when asked. */
export function useFileStat(root: string | null, path: string | null, { context = false } = {}) {
  const url = useMemo(() => {
    if (!root || path == null || !isSaneRelative(path)) return null;
    return filesUrl('stat', { root, path, context: context || null });
  }, [root, path, context]);
  return usePolled<FileStatDoc>(url, 0);
}

/** The preview document. Text arrives inline; images and PDFs arrive from `bytesHref`. */
export function useFilePreview(root: string | null, path: string | null, { tail = false, enabled = true } = {}) {
  const url = useMemo(() => {
    if (!enabled || !root || !path || !isSaneRelative(path)) return null;
    return filesUrl('preview', { root, path, tail: tail || null });
  }, [enabled, root, path, tail]);
  return usePolled<FilePreviewDoc>(url, 0);
}

/** A filename search inside one root. Nothing is fetched until there is a query. */
export function useFileSearch(root: string | null, path: string, q: string, { limit, depth }: { limit?: number | null; depth?: number | null } = {}) {
  const query = q.trim();
  const url = useMemo(() => {
    if (!root || !query || !isSaneRelative(path)) return null;
    return filesUrl('search', { root, path, q: query, limit, depth });
  }, [root, path, query, limit, depth]);
  return usePolled<FileSearchDoc>(url, 0);
}

/** Can OpusHub read this location, and may it be asked to try harder? */
export function usePermissionStatus(root: string | null, path: string | null) {
  const url = useMemo(() => {
    if (!root || path == null || !isSaneRelative(path)) return null;
    return filesUrl('permission-status', { root, path });
  }, [root, path]);
  return usePolled<PermissionStatusDoc>(url, 0);
}

/** The surface document: roots, permissions, the privileged provider's honest state, the bounds. */
export function useFilesSurface({ refresh = false } = {}) {
  const url = useMemo(() => (refresh ? '/api/files?refresh=1' : '/api/files'), [refresh]);
  return usePolled<FilesSurface>(url, 0);
}

/** The root table on its own (the sidebar's root switcher re-reads it after a refresh). */
export function useFilesRoots({ refresh = false } = {}) {
  const url = useMemo(() => (refresh ? '/api/files/roots?refresh=1' : '/api/files/roots'), [refresh]);
  return usePolled<FilesRootsDoc>(url, 0);
}

/* There is deliberately no client-side `downloadToken()`. A download is `downloadHref()` — a plain
 * link the server 302-redirects to a reference it minted for this session, this path and this
 * operation — so the page never holds a token to leak into state, storage, history or a log. The
 * `/api/files/download-token` route still exists (and is tested server-side) for a caller that
 * needs the JSON document itself. */

/* ------------------------------------------------------------------ */
/* the one POST                                                        */
/* ------------------------------------------------------------------ */

/**
 * Ask the privilege broker whether a location OpusHub cannot read may be read.
 *
 * The request carries a root id, a root-relative path and one operation from the frozen vocabulary
 * — there is no field for a command, arguments, a shell or a user, and the server refuses a body
 * that pretends otherwise. The answer's `state` is what the panel renders:
 *
 *   granted       a short-lived grant now covers this path and operation
 *   not_needed    OpusHub can already read it
 *   denied        policy will not grant this (a protected location never is)
 *   unavailable   this host has no privileged provider — the honest answer, not a fake elevation
 */
export async function requestAccess({
  root, path, operation, reason = null,
}: { root: string; path: string; operation: PrivilegedOperation; reason?: string | null }): Promise<PrivilegeRequestResult> {
  return post<PrivilegeRequestResult>('/api/files/privilege/request', { root, path, operation, reason });
}

/** The operation a "Request Access" button should ask for, given what was being attempted. */
export function operationFor(kind: 'dir' | 'file' | null | undefined, action: 'list' | 'read' = 'read'): PrivilegedOperation {
  if (kind === 'dir' || action === 'list') return 'list';
  return 'read';
}

/* ------------------------------------------------------------------ */
/* presentation helpers                                                */
/* ------------------------------------------------------------------ */

/** Which glyph an entry gets. One stroke family, and a folder is never a file. */
export function kindGlyph(kind: string, ext: string | null = null): string {
  if (kind === 'dir') return 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l1.8 2.2h7A1.5 1.5 0 0 1 19 8.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z';
  if (kind === 'symlink') return 'M9.5 14.5 14 10M11 7.5l1.6-1.6a3.4 3.4 0 0 1 4.8 4.8L15.8 12M12.2 11.6 10.6 13.2a3.4 3.4 0 0 0 4.8 4.8L17 16.4';
  if (kind === 'socket' || kind === 'fifo' || kind === 'block' || kind === 'character') return 'M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM17 14v5M14.5 16.5h5';
  switch (ext) {
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'avif': case 'svg': case 'ico': case 'bmp': case 'heic':
      return 'M4.5 5.5h15v13h-15zM4.5 15l4-3.5 3 2.5 3-3 5 4.5M9 9.2a1.1 1.1 0 1 0 0 .1';
    case 'zip': case 'tar': case 'gz': case 'tgz': case 'xz': case '7z': case 'rar': case 'iso':
      return 'M6 4.5h9l3.5 3.5v11.5H6zM11 4.5v3M11 9v2M11 12.5v2';
    case 'mp3': case 'flac': case 'm4a': case 'ogg': case 'opus': case 'wav':
      return 'M9 18V6.5l9-1.5v11M9 18a2.2 2.2 0 1 1-4.4 0A2.2 2.2 0 0 1 9 18Zm9-2a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0Z';
    case 'mp4': case 'mkv': case 'webm': case 'mov': case 'avi':
      return 'M4.5 6h11v12h-11zM15.5 10l4-2.5v9l-4-2.5';
    case 'log': case 'txt': case 'md': case 'json': case 'yaml': case 'yml': case 'xml': case 'conf': case 'ini': case 'toml': case 'csv':
      return 'M6 4.5h8l4 4v11H6zM8.5 12h7M8.5 15.5h7M8.5 8.5h3';
    default:
      return 'M6 4.5h8l4 4v11H6zM14 4.5v4h4';
  }
}

/** The sentence a listing's footer earns: what was withheld, what was left out, and why. */
export function listingNote(doc: FileListDoc | null): string | null {
  if (!doc) return null;
  const parts: string[] = [];
  if (doc.truncated) {
    parts.push(doc.sortScope === 'page'
      ? `Showing ${doc.count.toLocaleString('en')} of ${doc.total.toLocaleString('en')} entries — this directory is larger than one listing, so it is paged in name order and sorted within the page.`
      : `Showing ${doc.count.toLocaleString('en')} of ${doc.total.toLocaleString('en')} entries.`);
  }
  if (doc.hidden > 0) {
    parts.push(`${doc.hidden} ${doc.hidden === 1 ? 'entry is' : 'entries are'} not shown: OpusHub protects credentials, keys and its own state wherever they live.`);
  }
  if (doc.symlink) parts.push('This location is a symbolic link; its contents are shown from where it points, inside this root.');
  return parts.length ? parts.join(' ') : null;
}

/**
 * The sentence a search result earns. It always says what the walk did *not* do, because a search
 * that quietly skips folder symlinks and protected locations would otherwise look complete.
 */
export function searchNote(doc: FileSearchDoc | null): string | null {
  if (!doc) return null;
  const walked = `Searched ${doc.visited.toLocaleString('en')} entries in ${doc.directories.toLocaleString('en')} directories, ${doc.depth} levels deep, in ${doc.elapsedMs} ms. Folder symlinks are never followed and protected locations are never matched.`;
  if (!doc.truncated) return `${doc.count.toLocaleString('en')} ${doc.count === 1 ? 'name matches' : 'names match'}. ${walked}`;
  const why = doc.stopped === 'matches' ? `the first ${doc.count.toLocaleString('en')} matches are shown`
    : doc.stopped === 'nodes' ? `the walk stopped after ${doc.visited.toLocaleString('en')} entries`
      : doc.stopped === 'timeout' ? 'the walk ran out of time'
        : 'the search was cancelled';
  return `Results are incomplete: ${why}. Narrow the folder or the query. ${walked}`;
}

/** A stable, sortable label for the sort menu. */
export const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
  { value: 'type', label: 'Type' },
  { value: 'modified', label: 'Modified' },
  { value: 'permissions', label: 'Permissions' },
  { value: 'owner', label: 'Owner' },
];
