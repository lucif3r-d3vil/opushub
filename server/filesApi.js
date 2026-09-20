// /api/files — the read-only file manager surface (Phase 11A).
//
// Every route here is a GET except one: `POST /api/files/privilege/request`, which asks the broker
// whether a location OpusHub cannot read may be read. There is no route that accepts an operation
// and a path in a body, no route that runs anything, and no route that writes anything. A mutation
// is not "refused by a check" here — there is no code path to refuse, which is a stronger property
// and the one server/phase11a-files.test.js proves mechanically.
//
// What a request may supply:
//   root   a root *id* (a slug for a path the server already validated — never a path itself)
//   path   a path relative to that root
//   plus fixed, bounded query knobs: sort, dir, limit, offset, depth, tail, q, refresh, token
//
// What it may never supply: an absolute path, a host path, a canonical path, a command, arguments,
// a shell, a provider name, or an operation outside the broker's frozen vocabulary. Resolution is
// the server's job (files/policy.js: realpath + containment + classification) and it happens before
// a single byte is read.
//
// Downloads never accept a path directly: `GET /api/files/download-token` mints a short-lived,
// session-bound, path-bound token and `GET /api/files/download?token=…` streams against it. A
// browser-supplied `?path=` on the download route is not a thing that exists.
//
// Authentication and CSRF are handled by api.js, which calls this behind the same gate as every
// other route; authorization is the files.* permission set in operations/permissions.js.
import { LIMITS, publicLimits } from './files/limits.js';
import { filesystem, INLINE_MIME } from './files/provider.js';
import * as broker from './files/broker.js';
import * as tokens from './files/tokens.js';
import { storageContext } from './files/context.js';
import { detect, inlineMode } from './files/preview.js';
import { isRootId } from './files/roots.js';
import { STATUS_BY_CODE } from './files/policy.js';
import { can, PERMISSIONS } from './operations/permissions.js';
import { logEvent } from './activity.js';

/** The mutations this phase does not have. Named so the UI and the tests can say it out loud. */
export const NOT_SUPPORTED = Object.freeze([
  'delete', 'rename', 'move', 'copy', 'upload', 'mkdir', 'chmod', 'chown', 'write', 'truncate',
  'execute', 'shell', 'terminal',
]);

/**
 * Every path this handler owns. api.js rewrites the listed `/api/v1/files/*` paths before calling,
 * but an *unlisted* one arrives with its v1 prefix intact — and this handler still owns it, because
 * the alternative is a generic "no route" from the fallthrough. Both prefixes are normalized to the
 * unversioned form below, so the route table is written once.
 */
export function isFilesRoute(p) {
  return p === '/api/files' || p.startsWith('/api/files/') || p === '/api/v1/files' || p.startsWith('/api/v1/files/');
}

/** `/api/v1/files/x` → `/api/files/x`; anything else is returned unchanged. */
export function filesRouteOf(p) {
  return typeof p === 'string' && p.startsWith('/api/v1/files') ? p.replace('/api/v1/files', '/api/files') : p;
}

const GET_ROUTES = Object.freeze([
  '/api/files', '/api/files/roots', '/api/files/list', '/api/files/tree', '/api/files/stat',
  '/api/files/context', '/api/files/preview', '/api/files/search', '/api/files/permission-status',
  '/api/files/download-token', '/api/files/download', '/api/files/raw',
]);
const POST_ROUTES = Object.freeze(['/api/files/privilege/request']);

export const ROUTES = Object.freeze({ get: GET_ROUTES, post: POST_ROUTES });

/* ------------------------------------------------------------------ */
/* small request-side helpers                                          */
/* ------------------------------------------------------------------ */

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const bool = (v) => v === '1' || v === 'true' || v === 'yes' || v === 'on';
const int = (v, fallback, min, max) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

const permissionsFor = (actor) => ({
  read: can(actor, PERMISSIONS.FILES_READ),
  search: can(actor, PERMISSIONS.FILES_SEARCH),
  download: can(actor, PERMISSIONS.FILES_DOWNLOAD),
  readSensitive: can(actor, PERMISSIONS.FILES_READ_SENSITIVE),
});

/** A filename for Content-Disposition: no control characters, no quote-breaking, RFC 5987 for the rest. */
export function dispositionFilename(name) {
  const clean = String(name || 'download').replace(/[\u0000-\u001f\u007f]/g, '').replace(/["\\/]/g, '_').slice(0, 180) || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').trim() || 'download';
  return { ascii, utf8: encodeURIComponent(clean), header: `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}` };
}

/**
 * Headers for a byte response. `inline` is only ever true for an image or a PDF that the preview
 * detector approved — see the guard in the raw route. Active content (HTML, SVG, XML) is never
 * served from this origin as anything but escaped text in a JSON preview.
 */
function byteHeaders({ mime, size, mtimeMs, inline, filename }) {
  const h = {
    'content-type': mime,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'content-disposition': inline
      ? `inline; filename="${filename.ascii}"; filename*=UTF-8''${filename.utf8}`
      : filename.header,
  };
  if (Number.isFinite(size)) h['content-length'] = String(size);
  if (mtimeMs) h['last-modified'] = new Date(mtimeMs).toUTCString();
  if (inline) {
    // An inlined image gets a sandbox: even if a file lied about what it is, the response cannot
    // script, navigate or fetch in OpusHub's origin. A PDF is opened in its own tab instead of
    // being framed, so it refuses to be framed rather than being sandboxed (which breaks viewers).
    h['content-security-policy'] = mime === 'application/pdf'
      ? "default-src 'none'; frame-ancestors 'none'"
      : "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
  }
  return h;
}

/* ------------------------------------------------------------------ */
/* the handler                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param req,res   the raw request — needed only by the two streaming routes, which cannot use
 *                  api.js's JSON `send()` helper
 * @param actor     the session's username (never a request field)
 * @param sessionId the session *handle* (not the cookie token) — what tokens and grants bind to
 * @returns true when this surface owned the path, including its own 404s
 */
export async function handleFilesRoutes({ req, res, p: requestedPath, method, send, jsonBody, query, actor, sessionId }) {
  if (!isFilesRoute(requestedPath)) return false;
  // one route table, written once: the v1 form is normalized to the unversioned one
  const p = filesRouteOf(requestedPath);

  const isPostRoute = POST_ROUTES.includes(p);
  // An unknown path is a 404 whatever the method: answering 405 would imply the endpoint exists
  // and merely dislikes the verb, which is exactly the impression a read-only surface must not give.
  if (!isPostRoute && !GET_ROUTES.includes(p)) {
    send(404, { error: 'No such files endpoint.', code: 'not_found', routes: [...GET_ROUTES, ...POST_ROUTES] });
    return true;
  }
  if (isPostRoute ? method !== 'POST' : (method !== 'GET' && method !== 'HEAD')) {
    send(405, {
      error: isPostRoute
        ? 'This endpoint accepts POST only.'
        : 'The file manager is read-only: it lists, inspects, previews, searches and downloads. It has no write, no delete, no rename and no shell.',
      code: 'method_not_allowed',
      allowed: isPostRoute ? ['POST'] : ['GET', 'HEAD'],
      notSupported: [...NOT_SUPPORTED],
    });
    return true;
  }

  const perms = permissionsFor(actor);
  const refusePermission = (permission, what) => {
    send(403, {
      error: `Your role may not ${what}. This is a role permission, not a filesystem permission — nothing was elevated and nothing can be requested for it.`,
      code: 'not_permitted',
      permission,
    });
    return true;
  };

  /**
   * Refusals from the provider/policy, in the API's voice. Also where an explicit attempt at a
   * protected path is recorded — normal browsing never reaches this branch, because protected
   * entries are omitted from listings rather than refused.
   *
   * `where` is the root/path the caller was addressing (a token route passes the reference's own,
   * re-resolved), and it is defined before every branch so no route can reach it uninitialized.
   */
  const refused = (r, operation, where = {}) => {
    const atRoot = where.rootId ?? null;
    const atPath = where.path ?? null;
    if (r.code === 'protected_path' && atRoot != null) {
      logEvent({
        source: 'files',
        type: 'files.protected_path',
        subject: `${atRoot}:${atPath || '/'}`,
        message: `${actor || 'someone'} asked for a protected location`,
        meta: { root: atRoot, path: atPath, operation, class: r.class || null, rule: r.rule || null },
        severity: 'warning',
        category: 'files',
        signature: `protected|${actor}|${atRoot}|${atPath}`,
      });
    }
    send(r.status || 400, {
      error: r.reason, code: r.code, operation: r.operation || operation, rule: r.rule || null,
      class: r.class || null, root: r.root || null, path: r.path ?? atPath,
      requestAccess: r.code === 'permission_required',
      privileged: r.code === 'permission_required' || r.code === 'no_privileged_provider' ? broker.privilegedStatus() : undefined,
    });
    return true;
  };

  // Cancellation: a browser that navigates away mid-listing should not keep the host working.
  const ac = new AbortController();
  req?.once?.('close', () => { if (!res?.writableEnded) ac.abort(); });
  const signal = ac.signal;

  /* ---- the one POST: ask the broker ---- */
  if (isPostRoute) {
    if (!perms.read) return refusePermission(PERMISSIONS.FILES_READ, 'read the filesystem');
    let body = {};
    try { body = (await jsonBody()) || {}; }
    catch (err) { send(err.status || 400, { error: err.message || 'That request body could not be read.', code: 'bad_request' }); return true; }
    const rootId = str(body.root, 64);
    const path = str(body.path, LIMITS.maxPathLength) ?? '';
    const operation = str(body.operation, 32);
    const reason = str(body.reason, 240);
    const result = await broker.requestPrivilege({
      rootId, path, operation, reason, sessionId,
      actor: { name: actor },
      // The broker decides when an event is warranted; this decides how it is written. Ordinary
      // browsing produces nothing — asking for privilege always does.
      onEvent: (type, ev) => logEvent({
        source: 'files',
        type,
        subject: rootId ? `${rootId}:${path || '/'}` : null,
        message: messageFor(type, ev.meta),
        meta: ev.meta,
        severity: ev.severity,
        category: 'files',
        signature: `${type}|${actor}|${rootId}|${path}|${operation}`,
      }),
    });
    if (!result.ok) {
      send(result.status || 400, {
        error: result.reason, code: result.code, state: result.state || null,
        operation: result.operation || null, root: result.root || null, path: result.path ?? null,
        class: result.class || null, rule: result.rule || null, grantable: result.grantable ?? null,
        // the UI's one question: should it offer "Request Access" again? Only a real permission
        // gap with a provider that could fill it says yes.
        requestAccess: result.requestAccess ?? (result.code === 'no_privileged_provider'),
        requested: result.requested ?? false,
        privileged: broker.privilegedStatus(),
      });
      return true;
    }
    send(200, {
      ok: true, state: result.state, operation: result.operation, root: result.root, path: result.path,
      reason: result.reason || null, provider: result.provider || null,
      expiresAt: result.expiresAt ?? null, ttlMs: result.ttlMs ?? null,
      privileged: broker.privilegedStatus(),
    });
    return true;
  }

  /* ---- GET /api/files: the surface document the page boots from ---- */
  if (p === '/api/files') {
    if (!perms.read) return refusePermission(PERMISSIONS.FILES_READ, 'read the filesystem');
    const t = await filesystem.roots({ refresh: bool(query.get('refresh')) });
    send(200, {
      ok: true,
      surface: 'files',
      phase: '11A',
      readOnly: true,
      notSupported: [...NOT_SUPPORTED],
      provider: { id: filesystem.id, label: filesystem.label, operations: [...filesystem.operations] },
      roots: t.roots,
      refused: t.refused,
      source: t.source,
      disabled: t.disabled,
      configuredVia: t.configuredVia,
      permissions: perms,
      privileged: broker.privilegedStatus(),
      limits: publicLimits(),
      routes: { get: [...GET_ROUTES], post: [...POST_ROUTES] },
      at: Date.now(),
    });
    return true;
  }

  /* ---- GET /api/files/roots ---- */
  if (p === '/api/files/roots') {
    if (!perms.read) return refusePermission(PERMISSIONS.FILES_READ, 'read the filesystem');
    const t = await filesystem.roots({ refresh: bool(query.get('refresh')) });
    send(200, {
      ok: true, roots: t.roots, refused: t.refused, source: t.source, disabled: t.disabled,
      configuredVia: t.configuredVia, permissions: perms, privileged: broker.privilegedStatus(), at: t.at,
    });
    return true;
  }

  /* ---- bytes, addressed by token ----
   * These two come *before* the root/path validation on purpose: a reference is a capability the
   * server issued for a path it already resolved, so the only inputs are the token and the session.
   * There is no `?path=` form of a download — a browser cannot point this route at a location it
   * was not already given a reference for. */
  if (p === '/api/files/raw') {
    const token = str(query.get('token'), 256);
    if (!token) {
      send(400, { error: 'A preview needs a reference from the preview endpoint.', code: 'token_invalid' });
      return true;
    }
    return streamBytes({ token, operation: 'preview', inline: true });
  }
  if (p === '/api/files/download' && query.get('token')) {
    return streamBytes({ token: str(query.get('token'), 256), operation: 'download', inline: false });
  }

  /* ---- the routes that address one path ---- */
  const rootId = str(query.get('root'), 64);
  const rawPath = query.get('path');
  const path = rawPath == null ? '' : str(rawPath, LIMITS.maxPathLength + 1);
  if (path != null && path.length > LIMITS.maxPathLength) {
    send(400, { error: `That path is longer than ${LIMITS.maxPathLength} characters.`, code: 'bad_path', rule: 'too_long' });
    return true;
  }
  if (!rootId || !isRootId(rootId)) {
    send(404, { error: 'That is not a filesystem root OpusHub exposes.', code: 'unknown_root', rootId: rootId ? rootId.slice(0, 64) : null });
    return true;
  }

  /** A sensitive file is readable, but only by a role that may read sensitive files — and it is recorded. */
  const sensitiveGate = (what, event) => {
    if (!perms.readSensitive) {
      send(403, {
        error: `This file is classified as sensitive. Your role may not ${what} sensitive files.`,
        code: 'not_permitted', permission: PERMISSIONS.FILES_READ_SENSITIVE, class: 'sensitive',
      });
      return false;
    }
    logEvent({
      source: 'files', type: event, subject: `${rootId}:${path}`,
      message: `${actor || 'someone'} ${what} a sensitive file`,
      meta: { root: rootId, path, operation: what === 'download' ? 'download' : 'preview' },
      severity: 'notice', category: 'files',
      signature: `${event}|${actor}|${rootId}|${path}`,
    });
    return true;
  };

  const rootSensitiveGate = async () => {
    const t = await filesystem.roots();
    const root = (t.roots || []).find((r) => r.id === rootId) || null;
    if (root?.sensitive && !perms.readSensitive) {
      send(403, {
        error: `“${root.label}” is a sensitive location. Your role may not read sensitive filesystem roots.`,
        code: 'not_permitted', permission: PERMISSIONS.FILES_READ_SENSITIVE, root: { id: root.id, label: root.label },
      });
      return false;
    }
    return true;
  };

  /* ---- streaming, shared by download and raw ---- */
  async function streamBytes({ token, operation, inline }) {
    const checked = tokens.verify({ token, sessionId, operation });
    if (!checked.ok) {
      send(checked.status || 403, {
        error: checked.reason, code: checked.code,
        // a stale token is a normal thing: the honest instruction is "ask for a new one"
        retry: checked.code === 'token_expired' ? 'request a fresh link' : null,
      });
      return true;
    }
    const record = checked.record;
    if (!perms.read && operation === 'preview') return refusePermission(PERMISSIONS.FILES_READ, 'read the filesystem');
    if (!perms.download && operation === 'download') return refusePermission(PERMISSIONS.FILES_DOWNLOAD, 'download files');

    // Re-resolve through the policy on the way to the bytes. The token proves the session asked for
    // this path recently; it does not get to skip the policy.
    const doc = await filesystem.download({ rootId: record.rootId, path: record.path }, { signal });
    if (!doc.ok) return refused(doc, operation, { rootId: record.rootId, path: record.path });

    let mime = doc.file.mime || 'application/octet-stream';
    if (inline) {
      // Defence in depth: sniff the bytes again and refuse to inline anything that is not an image
      // or a PDF. A token for a file that turned out to be HTML still cannot make OpusHub serve
      // HTML from its own origin.
      const head = await filesystem.read({ rootId: record.rootId, path: record.path }, { maxBytes: LIMITS.sniffBytes, signal });
      if (!head.ok) return refused(head, operation, { rootId: record.rootId, path: record.path });
      const detected = detect({ head: head.bytes, name: doc.file.name, size: doc.file.size });
      const mode = inlineMode(detected);
      if (mode !== 'image' && mode !== 'pdf') {
        send(415, {
          error: mode === 'text'
            ? 'That file is text; it is previewed as escaped text, never rendered inside OpusHub.'
            : 'That file cannot be shown inside OpusHub. Download it instead.',
          code: 'unsupported_preview', kind: detected.kind, subtype: detected.subtype, label: detected.label,
          activeContent: detected.activeContent, inline: null,
        });
        return true;
      }
      const cap = mode === 'image' ? LIMITS.maxInlineImageBytes : LIMITS.maxPreviewFileSize;
      if (doc.file.size > cap) {
        send(413, { error: `That ${mode} is larger than ${Math.round(cap / (1024 * 1024))} MB, so it is not shown inline. Download it instead.`, code: 'too_large', size: doc.file.size, limit: cap });
        return true;
      }
      // the sniffed type wins over the name's extension: that is the whole point of detecting
      mime = mode === 'pdf' ? 'application/pdf' : (detected.mime || INLINE_MIME[detected.subtype] || mime);
    }

    const filename = dispositionFilename(doc.file.name);
    const headers = byteHeaders({ mime, size: doc.file.size, mtimeMs: doc.file.mtimeMs, inline, filename });
    if (method === 'HEAD') { res.writeHead(200, headers); res.end(); return true; }

    const stream = doc.createStream();
    res.writeHead(200, headers);
    stream.on('error', (err) => {
      // The headers are already out; the honest thing left to do is stop, and record why.
      try { stream.destroy(); } catch { /* already gone */ }
      try { res.end(); } catch { /* already gone */ }
      logEvent({
        source: 'files', type: 'files.download.failed', subject: `${record.rootId}:${record.path}`,
        message: `a ${operation} stopped part-way`, meta: { root: record.rootId, path: record.path, operation, code: err?.code || null },
        severity: 'warning', category: 'files', signature: `failed|${actor}|${record.rootId}|${record.path}`,
      });
    });
    // A client that goes away must not leave the host reading: the stream is destroyed, not drained.
    res.on('close', () => { if (!stream.destroyed) stream.destroy(); });
    stream.pipe(res);
    return true;
  }

  /* ---- list ---- */
  if (p === '/api/files/list') {
    if (!perms.read) return refusePermission(PERMISSIONS.FILES_READ, 'read the filesystem');
    if (!(await rootSensitiveGate())) return true;
    const doc = await filesystem.list({ rootId, path }, {
      sort: str(query.get('sort'), 16) || 'name',
      dir: str(query.get('dir'), 8) || 'asc',
      limit: int(query.get('limit'), LIMITS.maxDirectoryEntries, 1, LIMITS.maxDirectoryEntries),
      offset: int(query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
      signal,
    });
    if (!doc.ok) return refused(doc, 'list', { rootId, path });
    send(200, { ...doc, permissions: perms, privileged: broker.privilegedStatus() });
    return true;
  }

  /* ---- tree (the sidebar) ---- */
  if (p === '/api/files/tree') {
    if (!perms.read) return refusePermission(PERMISSIONS.FILES_READ, 'read the filesystem');
    if (!(await rootSensitiveGate())) return true;
    const doc = await filesystem.tree({ rootId, path }, { depth: int(query.get('depth'), 2, 1, LIMITS.maxTreeDepth), signal });
    if (!doc.ok) return refused(doc, 'list', { rootId, path });
    send(200, doc);
    return true;
  }

  /* ---- stat (+ optional storage context) ---- */
  if (p === '/api/files/stat') {
    if (!perms.read) return refusePermission(PERMISSIONS.FILES_READ, 'read the filesystem');
    if (!(await rootSensitiveGate())) return true;
    const doc = await filesystem.stat({ rootId, path }, { signal });
    if (!doc.ok) return refused(doc, 'stat', { rootId, path });
    let context = null;
    if (bool(query.get('context'))) {
      const t = await filesystem.roots();
      const root = (t.roots || []).find((r) => r.id === rootId) || null;
      context = await storageContext({ canonical: doc.canonical, root, relative: doc.path }).catch(() => null);
    }
    send(200, { ...doc, context, permissions: perms, privileged: broker.privilegedStatus() });
    return true;
  }

  /* ---- storage context on its own ---- */
  if (p === '/api/files/context') {
    if (!perms.read) return refusePermission(PERMISSIONS.FILES_READ, 'read the filesystem');
    if (!(await rootSensitiveGate())) return true;
    const doc = await filesystem.resolveRef({ rootId, path }, { signal });
    if (!doc.ok) return refused(doc, 'stat', { rootId, path });
    const t = await filesystem.roots();
    const root = (t.roots || []).find((r) => r.id === rootId) || null;
    const ctx = await storageContext({ canonical: doc.canonical, root, relative: doc.path });
    send(200, { ok: true, root: doc.root, path: doc.path, kind: doc.kind, exists: doc.exists, ...ctx });
    return true;
  }

  /* ---- permission status (the Properties panel's "can OpusHub read this?") ---- */
  if (p === '/api/files/permission-status') {
    if (!perms.read) return refusePermission(PERMISSIONS.FILES_READ, 'read the filesystem');
    const doc = await filesystem.permissionStatus({ rootId, path }, { signal });
    if (!doc.ok) return refused(doc, 'read', { rootId, path });
    // A malformed path is a bad request rather than a status: the UI should not have to guess
    // whether "invalid" means "unreadable" or "you asked for nonsense".
    if (doc.state === 'invalid' && doc.code) {
      send(STATUS_BY_CODE[doc.code] || 400, {
        error: doc.reason, code: doc.code, state: doc.state, rule: doc.rule || null,
        operation: doc.operation || 'read', path: doc.path ?? path, requestAccess: false,
      });
      return true;
    }
    send(200, {
      ...doc,
      permissions: perms,
      privileged: broker.privilegedStatus(),
      // "Request Access" is offered only where a grant could conceivably help: a real EACCES on a
      // path the policy allows. A protected path is never requestable, and neither is a bad path.
      requestable: doc.state === 'permission_required',
      grants: broker.grantsFor(sessionId),
    });
    return true;
  }

  /* ---- preview ---- */
  if (p === '/api/files/preview') {
    if (!perms.read) return refusePermission(PERMISSIONS.FILES_READ, 'read the filesystem');
    if (!(await rootSensitiveGate())) return true;
    const doc = await filesystem.preview({ rootId, path }, { tail: bool(query.get('tail')), signal });
    if (!doc.ok) {
      // A preview refusal still carries the detection: "this is a 900 MB video, download it" is a
      // useful answer, and it is not an error the UI should render as a broken page.
      if (doc.code === 'too_large' || doc.code === 'unsupported_preview') {
        send(doc.status, {
          error: doc.reason, code: doc.code, root: doc.root, name: doc.name, path: doc.path,
          kind: doc.kind, subtype: doc.subtype, label: doc.label, mime: doc.mime, size: doc.size,
          detectedBy: doc.detectedBy, activeContent: doc.activeContent, inline: null, text: null,
          limits: publicLimits(),
        });
        return true;
      }
      return refused(doc, 'read', { rootId, path });
    }
    if (doc.sensitive && !sensitiveGate('preview', 'files.preview.sensitive')) return true;
    // Images and PDFs are served as bytes from the token route; text arrives escaped in this JSON.
    let bytesHref = null;
    if (doc.ok && (doc.inline === 'image' || doc.inline === 'pdf')) {
      const issued = tokens.issue({
        sessionId, actor, rootId, path: doc.path, operation: 'preview',
        name: doc.name, size: doc.size, mime: doc.mime,
      });
      if (issued.ok) bytesHref = `/api/files/raw?token=${encodeURIComponent(issued.token)}`;
    }
    send(200, { ...doc, bytesHref, tokenExpiresAt: bytesHref ? Date.now() + LIMITS.previewTokenTtlMs : null, permissions: perms });
    return true;
  }

  /* ---- search ---- */
  if (p === '/api/files/search') {
    if (!perms.search) return refusePermission(PERMISSIONS.FILES_SEARCH, 'search the filesystem');
    if (!(await rootSensitiveGate())) return true;
    const doc = await filesystem.search({
      rootId, path,
      query: str(query.get('q') ?? query.get('query'), LIMITS.maxSearchQuery + 1),
    }, {
      limit: int(query.get('limit'), LIMITS.maxSearchMatches, 1, LIMITS.maxSearchMatches),
      maxDepth: query.get('depth') == null ? null : int(query.get('depth'), LIMITS.maxSearchDepth, 0, LIMITS.maxSearchDepth),
      maxNodes: int(query.get('nodes'), LIMITS.maxSearchNodes, 1, LIMITS.maxSearchNodes),
      signal,
    });
    if (!doc.ok) return refused(doc, 'search', { rootId, path });
    send(200, { ...doc, permissions: perms });
    return true;
  }

  /* ---- download token ---- */
  if (p === '/api/files/download-token') {
    if (!perms.download) return refusePermission(PERMISSIONS.FILES_DOWNLOAD, 'download files');
    if (!(await rootSensitiveGate())) return true;
    const doc = await filesystem.download({ rootId, path }, { signal });
    if (!doc.ok) return refused(doc, 'download', { rootId, path });
    if (doc.file.sensitive && !sensitiveGate('download', 'files.download.sensitive')) return true;
    const issued = tokens.issue({
      sessionId, actor, rootId, path: doc.file.path, operation: 'download',
      name: doc.file.name, size: doc.file.size, mime: doc.file.mime,
    });
    if (!issued.ok) {
      send(503, { error: issued.reason || 'A download token could not be issued right now.', code: issued.code || 'provider_error' });
      return true;
    }
    send(200, {
      ok: true,
      // The token is a capability, not a path: it names an operation and a root-relative path the
      // server already resolved. It expires, it is bound to this session, and it is never logged.
      token: issued.token,
      expiresAt: issued.expiresAt,
      ttlMs: issued.ttlMs,
      operation: 'download',
      file: { name: doc.file.name, path: doc.file.path, size: doc.file.size, mime: doc.file.mime, mtimeMs: doc.file.mtimeMs },
      href: `/api/files/download?token=${encodeURIComponent(issued.token)}`,
      root: doc.root,
    });
    return true;
  }

  /* ---- download: mint a reference, then let the browser's own download UI take over ---- */
  if (p === '/api/files/download') {
    if (!perms.download) return refusePermission(PERMISSIONS.FILES_DOWNLOAD, 'download files');
    if (!(await rootSensitiveGate())) return true;
    const doc = await filesystem.download({ rootId, path }, { signal });
    if (!doc.ok) return refused(doc, 'download', { rootId, path });
    if (doc.file.sensitive && !sensitiveGate('download', 'files.download.sensitive')) return true;
    const issued = tokens.issue({
      sessionId, actor, rootId, path: doc.file.path, operation: 'download',
      name: doc.file.name, size: doc.file.size, mime: doc.file.mime,
    });
    if (!issued.ok) { send(503, { error: issued.reason || 'A download token could not be issued.', code: issued.code || 'provider_error' }); return true; }
    // A redirect, not a stream: the browser retries a URL, and the path never appears in a URL a
    // person can copy, edit and reuse.
    res.writeHead(302, {
      location: `/api/files/download?token=${encodeURIComponent(issued.token)}`,
      'cache-control': 'no-store',
    });
    res.end();
    return true;
  }

  return true;
}

/**
 * End every file capability one session held: its download/preview references and its privileged
 * grants. Called from the sign-out and session-revocation routes in api.js — a session that is gone
 * must not leave a live download link or a live grant behind it.
 */
export function retireFilesSession(sessionId) {
  if (!sessionId) return { tokens: 0, grants: 0 };
  return { tokens: tokens.revokeBySession(sessionId), grants: broker.retireSession(sessionId) };
}

/** The wholesale form, for "sign out everywhere". */
export function retireAllFilesSessions() {
  return { tokens: tokens.revokeAll(), grants: broker.retireAllSessions() };
}

/** Human vocabulary for the Activity rows the broker asks for. */
function messageFor(type, meta = {}) {
  const where = meta?.root ? `${meta.root}${meta.path ? `/${meta.path}` : ''}` : 'a location';
  switch (type) {
    case 'files.privilege.requested': return `asked for access to ${where}`;
    case 'files.privilege.granted': return `access to ${where} was granted (${Math.round((meta?.ttlMs || 0) / 60000)} minutes)`;
    case 'files.privilege.denied': return `access to ${where} was denied`;
    case 'files.privilege.unavailable': return `access to ${where} cannot be granted on this host`;
    default: return `a privileged read was requested for ${where}`;
  }
}
