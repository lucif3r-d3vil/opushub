// Phase 11A — file references: the only way bytes leave the host through a URL.
//
// The failure this prevents is the obvious design, `GET /api/files/download?path=/etc/shadow`: a URL
// whose query string *is* a host path is a path-traversal endpoint with an extra step, it lands in
// browser history, proxies and logs, and it cannot be revoked. So a download (and an inline image or
// PDF preview) is served from a token that this module minted:
//
//   • minted server-side, only after the path policy resolved and classified the path
//   • opaque — 32 random bytes; only the SHA-256 of it is kept, so a memory dump cannot be replayed
//   • bound to the session handle that asked for it (another session's token is refused)
//   • bound to the root id and the canonical root-relative path (it cannot be re-pointed)
//   • bound to the operation: a `preview` token does not download, a `download` token does not preview
//   • short-lived, swept, and capped in number
//
// Tokens are *not* single-use: a browser may legitimately retry or resume a download inside the TTL,
// and a token that can only be spent once turns a flaky connection into a confusing failure. What
// makes replay useless instead is the binding above plus the expiry.
import crypto from 'node:crypto';
import { LIMITS } from './limits.js';

/** The only two things a token can authorize. */
export const TOKEN_OPERATIONS = Object.freeze(['download', 'preview']);

const TTL_BY_OPERATION = Object.freeze({
  download: LIMITS.downloadTokenTtlMs,
  preview: LIMITS.previewTokenTtlMs,
});

/** token hash → record. In memory only: a restart invalidates every outstanding reference. */
const tokens = new Map();

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');

function sweep(at = Date.now()) {
  for (const [k, rec] of tokens) if (rec.expiresAt <= at) tokens.delete(k);
  while (tokens.size > LIMITS.maxTokens) tokens.delete(tokens.keys().next().value);
}

/**
 * Mint a reference for one resolved path.
 *
 * @param record `{ sessionId, actor, rootId, path, operation, name, size, mime, disposition }`
 *                `path` is the canonical root-relative path from the policy — never an absolute one.
 */
export function issue({ sessionId = null, actor = null, rootId = null, path = null, operation = 'download', name = null, size = null, mime = null, ttlMs = null, at = Date.now() } = {}) {
  if (!TOKEN_OPERATIONS.includes(operation)) {
    return { ok: false, code: 'bad_operation', reason: 'That is not an operation a file reference can authorize.' };
  }
  if (!rootId || typeof path !== 'string') return { ok: false, code: 'bad_request', reason: 'A file reference needs a root and a path.' };
  sweep(at);
  const ttl = Number.isFinite(ttlMs) && ttlMs != null ? Math.max(0, Math.min(ttlMs, LIMITS.previewTokenTtlMs)) : TTL_BY_OPERATION[operation];
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = at + ttl;
  tokens.set(hash(token), {
    sessionId: sessionId ? String(sessionId) : null,
    actor: actor ? String(actor) : null,
    rootId: String(rootId),
    path: String(path),
    operation,
    name: name ? String(name).slice(0, 255) : null,
    size: Number.isFinite(size) ? size : null,
    mime: mime ? String(mime).slice(0, 120) : null,
    issuedAt: at,
    expiresAt,
    uses: 0,
  });
  return { ok: true, token, expiresAt, ttlMs: ttl, operation };
}

/**
 * Spend (validate) a reference.
 *
 * @returns `{ok:true, record}` or `{ok:false, code, reason, status}` — the codes are stable so the
 *          UI can say "that link expired, ask for the file again" instead of "error".
 */
export function verify({ token = null, sessionId = null, operation = null, at = Date.now() } = {}) {
  if (typeof token !== 'string' || !token || token.length > 128) {
    return { ok: false, code: 'token_invalid', reason: 'That file reference is not valid.', status: 403 };
  }
  const rec = tokens.get(hash(token));
  if (!rec) return { ok: false, code: 'token_invalid', reason: 'That file reference is not valid — ask for the file again.', status: 403 };
  if (rec.expiresAt <= at) {
    tokens.delete(hash(token));
    return { ok: false, code: 'token_expired', reason: 'That file reference expired — ask for the file again.', status: 403 };
  }
  if (rec.sessionId && String(sessionId || '') !== rec.sessionId) {
    return { ok: false, code: 'token_session', reason: 'That file reference belongs to a different session.', status: 403 };
  }
  if (operation && rec.operation !== operation) {
    return { ok: false, code: 'token_mismatch', reason: `That file reference was issued for ${rec.operation}, not ${operation}.`, status: 403 };
  }
  rec.uses += 1;
  sweep(at);
  return { ok: true, record: rec };
}

/**
 * Retire every reference. Used when sessions are revoked wholesale ("sign out everywhere"): a
 * reference is cheap to mint again, and keeping one alive past the session that asked for it is
 * not worth the ambiguity.
 */
export function revokeAll() { const n = tokens.size; tokens.clear(); return n; }

/** Retire one reference (a cancelled download). */
export function revoke(token) {
  if (typeof token === 'string' && token) tokens.delete(hash(token));
}

/** Retire every reference held by one session — called when a session is revoked or signs out. */
export function revokeBySession(sessionId) {
  if (!sessionId) return 0;
  let n = 0;
  for (const [k, rec] of tokens) if (rec.sessionId === String(sessionId)) { tokens.delete(k); n += 1; }
  return n;
}

/** How many references are outstanding. Diagnostics and tests; never a credential. */
export const pendingCount = () => tokens.size;

/** Test helper. */
export function _resetTokens() { tokens.clear(); }

export const _internals = Object.freeze({ TTL_BY_OPERATION, hash });
