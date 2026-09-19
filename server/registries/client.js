// A minimal OCI Distribution client — five fixed request shapes, nothing else.
//
//   ping          GET /v2/
//   catalog       GET /v2/_catalog?n=<N>                       (private registries; Hub/GHCR have none)
//   tags          GET /v2/<repository>/tags/list?n=<N>
//   manifest      GET /v2/<repository>/manifests/<reference>   (HEAD-like: digest + media type + size)
//   token         GET <realm>?service=&scope=                  (Bearer challenge from the registry)
//
// Every path is composed HERE from components that already passed the grammar in endpoint.js;
// no caller supplies a path, a method, or a header. The connection is pinned to the address the
// endpoint was validated at. Redirects are followed at most twice and only after revalidation
// through monitoring/net.js (https only, no credential-bearing Location, no refused classes).
// The Bearer realm is validated the same way and must be https. Credentials are sent to exactly
// two places: the registry origin (Basic) and the realm the registry itself named (Basic).
//
// Response bodies are bounded (256 KB) and parsed as JSON; a manifest body is never stored.
import http from 'node:http';
import https from 'node:https';
import { validateEndpoint, REPOSITORY_RE, TAG_RE, DIGEST_RE } from './endpoint.js';
import { pinnedLookup, validateRedirect, resolveHost } from '../monitoring/net.js';
import * as store from './store.js';

const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 12_000;
const UA = 'OpusHub/10D (+registry-client)';
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

let requestImpl = rawRequest;
/** Tests inject a transport; production uses node http(s) pinned to the validated address. */
export function __setTransport(fn) { requestImpl = fn || rawRequest; }

function rawRequest({ url, pinned, family, headers, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: `${u.pathname}${u.search}`, method: 'GET',
      headers: { 'user-agent': UA, accept: 'application/json', ...headers },
      lookup: pinnedLookup(pinned, family), servername: u.hostname, timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); else res.destroy(); });
      res.on('end', () => resolve({ ok: true, status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), truncated: size > MAX_BODY }));
      res.on('error', (err) => resolve({ ok: false, code: 'network', reason: String(err?.message || err).slice(0, 120) }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => resolve({ ok: false, code: /timeout/.test(String(err?.message)) ? 'timeout' : 'network', reason: String(err?.message || err).slice(0, 120) }));
    req.end();
  });
}

const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`;

/** Parse `WWW-Authenticate: Bearer realm="…",service="…",scope="…"`. */
export function parseChallenge(header) {
  const h = String(header || '');
  const m = /^\s*(Bearer|Basic)\s*(.*)$/i.exec(h);
  if (!m) return null;
  const params = {};
  for (const p of m[2].matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) params[p[1].toLowerCase()] = p[2];
  return { scheme: m[1].toLowerCase(), ...params };
}

/**
 * One registry request with the auth dance:
 *   1. GET; 401 with Bearer challenge → fetch a token from the (validated, https) realm, retry once
 *   2. 401 with Basic challenge → retry with Basic (credentials or fail)
 * Redirects (307/308 for blobs, 301/302 on some proxies) are revalidated and followed twice.
 */
async function registryGet(reg, path, { accept = 'application/json', creds = null, scope = null } = {}) {
  const ep = await validateEndpoint(reg.endpoint, { insecure: reg.insecure });
  if (!ep.ok) return { ok: false, code: ep.code, reason: ep.reason };
  let url = `${ep.origin}${path}`;
  let pinned = ep.pinned;
  let family = ep.family;
  let authHeader = null;
  let tokenTried = false;
  for (let hop = 0; hop < 4; hop++) {
    const res = await requestImpl({ url, pinned, family, headers: { accept, ...(authHeader ? { authorization: authHeader } : {}) } });
    if (!res.ok) return { ok: false, code: res.code, reason: res.reason };
    if ([301, 302, 307, 308].includes(res.status) && res.headers.location) {
      const v = await validateRedirect(url, res.headers.location, { resolveHost });
      if (!v.ok) return { ok: false, code: v.code, reason: v.reason };
      url = v.url; pinned = v.pinned; family = v.addresses[0].family;
      // never carry the registry credential to another origin
      if (new URL(url).origin !== ep.origin) authHeader = null;
      continue;
    }
    if (res.status === 401 && !tokenTried) {
      tokenTried = true;
      const ch = parseChallenge(res.headers['www-authenticate']);
      if (!ch) return { ok: false, code: 'unauthorized', reason: 'The registry requires authentication and offered no method OpusHub supports.', status: 401 };
      if (ch.scheme === 'basic') {
        if (!creds) return { ok: false, code: 'unauthorized', reason: 'The registry requires a username and secret.', status: 401 };
        authHeader = basic(creds.username, creds.secret);
        continue;
      }
      const tok = await fetchToken(ch, { creds, scope, origin: ep.origin });
      if (!tok.ok) return tok;
      authHeader = `Bearer ${tok.token}`;
      continue;
    }
    return { ok: true, status: res.status, headers: res.headers, body: res.body, truncated: res.truncated, authenticated: !!authHeader };
  }
  return { ok: false, code: 'too_many_redirects', reason: 'The registry redirected too many times.' };
}

async function fetchToken(challenge, { creds, scope, origin }) {
  if (!challenge.realm) return { ok: false, code: 'bad_challenge', reason: 'The registry named no token realm.' };
  let realm;
  try { realm = new URL(challenge.realm); } catch { return { ok: false, code: 'bad_challenge', reason: 'The token realm is not a URL.' }; }
  if (realm.protocol !== 'https:' && !(origin.startsWith('http:') && realm.origin === origin)) return { ok: false, code: 'bad_challenge', reason: 'The token realm must be https.' };
  if (realm.username || realm.password) return { ok: false, code: 'bad_challenge', reason: 'The token realm carries credentials.' };
  const resolved = await resolveHost(realm.hostname);
  if (!resolved.ok) return { ok: false, code: resolved.code, reason: `The token realm was refused: ${resolved.reason}` };
  const q = new URLSearchParams();
  if (challenge.service) q.set('service', challenge.service);
  const sc = scope || challenge.scope;
  if (sc) q.set('scope', sc);
  realm.search = q.toString();
  realm.hash = '';
  const res = await requestImpl({ url: realm.toString(), pinned: resolved.pinned, family: resolved.addresses[0].family, headers: { accept: 'application/json', ...(creds ? { authorization: basic(creds.username, creds.secret) } : {}) } });
  if (!res.ok) return { ok: false, code: res.code, reason: `The token service did not answer: ${res.reason}` };
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'unauthorized', reason: creds ? 'The registry rejected the username or secret.' : 'The registry requires credentials for this repository.', status: res.status };
  if (res.status !== 200) return { ok: false, code: 'token_error', reason: `The token service answered ${res.status}.`, status: res.status };
  let json;
  try { json = JSON.parse(res.body); } catch { return { ok: false, code: 'token_error', reason: 'The token service answered with something that is not JSON.' }; }
  const token = json.token || json.access_token;
  if (typeof token !== 'string' || !token) return { ok: false, code: 'token_error', reason: 'The token service returned no token.' };
  return { ok: true, token };
}

function loadCreds(id) {
  const c = store.credentialsFor(id);
  if (!c.ok) return c;
  return { ok: true, registry: c.registry, creds: c.credentials && c.credentials.secret ? c.credentials : null };
}

const jsonOf = (res) => { try { return JSON.parse(res.body); } catch { return null; } };

/* ------------------------------------------------------------------ */
/* public operations                                                   */
/* ------------------------------------------------------------------ */

/** Connectivity + authentication test. Never returns headers or bodies. */
export async function ping(id) {
  const c = loadCreds(id);
  if (!c.ok) return c;
  const started = Date.now();
  const res = await registryGet(c.registry, '/v2/', { creds: c.creds });
  const ms = Date.now() - started;
  if (!res.ok) return { ok: false, code: res.code, reason: res.reason, ms };
  if (res.status === 200) return { ok: true, api: res.headers['docker-distribution-api-version'] || 'registry/2.0', authenticated: res.authenticated, ms };
  if (res.status === 401) return { ok: false, code: 'unauthorized', reason: 'The registry rejected the credentials.', ms };
  if (res.status === 404) return { ok: false, code: 'not_a_registry', reason: 'The endpoint answered, but /v2/ is not there — this is not an OCI registry.', ms };
  return { ok: false, code: 'http', reason: `The registry answered ${res.status} to /v2/.`, ms };
}

/** Repositories (private registries only). Docker Hub and GHCR expose no catalog. */
export async function catalog(id, { limit = 200, q = '' } = {}) {
  const c = loadCreds(id);
  if (!c.ok) return c;
  if (c.registry.kind === 'dockerhub' || c.registry.kind === 'ghcr') return { ok: false, code: 'no_catalog', reason: `${c.registry.kind === 'dockerhub' ? 'Docker Hub' : 'GHCR'} does not offer a repository listing; type a repository name.` };
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  const res = await registryGet(c.registry, `/v2/_catalog?n=${n}`, { creds: c.creds, scope: 'registry:catalog:*' });
  if (!res.ok) return res;
  if (res.status !== 200) return { ok: false, code: res.status === 401 || res.status === 403 ? 'unauthorized' : 'http', reason: `The registry answered ${res.status} to the catalog request.` };
  const json = jsonOf(res);
  const repos = Array.isArray(json?.repositories) ? json.repositories.filter((r) => typeof r === 'string' && REPOSITORY_RE.test(r)) : [];
  const needle = String(q || '').toLowerCase();
  return { ok: true, repositories: (needle ? repos.filter((r) => r.includes(needle)) : repos).slice(0, n), truncated: res.truncated || !!res.headers.link };
}

/** Tags of one repository. */
export async function tags(id, repository, { limit = 200 } = {}) {
  const repo = String(repository || '').toLowerCase();
  if (!REPOSITORY_RE.test(repo)) return { ok: false, code: 'bad_repository', reason: 'That is not a repository name.' };
  const c = loadCreds(id);
  if (!c.ok) return c;
  const n = Math.max(1, Math.min(1000, Number(limit) || 200));
  const res = await registryGet(c.registry, `/v2/${repo}/tags/list?n=${n}`, { creds: c.creds, scope: `repository:${repo}:pull` });
  if (!res.ok) return res;
  if (res.status === 404) return { ok: false, code: 'not_found', reason: `The repository ${repo} does not exist or is not visible with these credentials.` };
  if (res.status !== 200) return { ok: false, code: res.status === 401 || res.status === 403 ? 'unauthorized' : 'http', reason: `The registry answered ${res.status}.` };
  const json = jsonOf(res);
  const list = Array.isArray(json?.tags) ? json.tags.filter((t) => typeof t === 'string' && TAG_RE.test(t)) : [];
  return { ok: true, repository: repo, tags: list.slice(0, n), truncated: res.truncated || !!res.headers.link };
}

/** Manifest metadata: digest, media type, size, and (for an index) the platforms. Bodies are not kept. */
export async function manifest(id, repository, reference) {
  const repo = String(repository || '').toLowerCase();
  const ref = String(reference || '');
  if (!REPOSITORY_RE.test(repo)) return { ok: false, code: 'bad_repository', reason: 'That is not a repository name.' };
  if (!TAG_RE.test(ref) && !DIGEST_RE.test(ref)) return { ok: false, code: 'bad_reference', reason: 'That is not a tag or a sha256 digest.' };
  const c = loadCreds(id);
  if (!c.ok) return c;
  const res = await registryGet(c.registry, `/v2/${repo}/manifests/${ref}`, { accept: MANIFEST_ACCEPT, creds: c.creds, scope: `repository:${repo}:pull` });
  if (!res.ok) return res;
  if (res.status === 404) return { ok: false, code: 'not_found', reason: `${repo}:${ref} does not exist or is not visible with these credentials.` };
  if (res.status !== 200) return { ok: false, code: res.status === 401 || res.status === 403 ? 'unauthorized' : 'http', reason: `The registry answered ${res.status}.` };
  const json = jsonOf(res);
  const digest = String(res.headers['docker-content-digest'] || '');
  const mediaType = String(res.headers['content-type'] || json?.mediaType || '').split(';')[0];
  const isIndex = /image\.index|manifest\.list/.test(mediaType) || Array.isArray(json?.manifests);
  const platforms = isIndex ? (json.manifests || []).slice(0, 32).map((m) => ({ digest: String(m.digest || ''), os: m.platform?.os || null, architecture: m.platform?.architecture || null, variant: m.platform?.variant || null, size: Number(m.size) || null })).filter((p) => DIGEST_RE.test(p.digest)) : [];
  const layers = !isIndex && Array.isArray(json?.layers) ? json.layers : [];
  const size = layers.reduce((a, l) => a + (Number(l?.size) || 0), 0) + (Number(json?.config?.size) || 0);
  return {
    ok: true, repository: repo, reference: ref,
    digest: DIGEST_RE.test(digest) ? digest : null, mediaType: mediaType || null,
    kind: isIndex ? 'index' : 'manifest', platforms, layers: layers.length || null, size: size || null,
    created: null,
  };
}

/**
 * The X-Registry-Auth header for a pull of `imageRef`, from the stored credentials of the matching
 * registry (explicit id, else the default entry for the image's host, else the only entry for it).
 * Returns null for anonymous pulls. Never logs, never returns the secret to anything but the adapter.
 */
export async function authHeaderFor(imageRef, registryId = null) {
  const { registryHostOf } = await import('./endpoint.js');
  const host = registryHostOf(imageRef);
  let entry = null;
  if (registryId) {
    const c = store.credentialsFor(registryId);
    if (!c.ok) return null;
    if (c.registry.host !== host) return null;   // an explicit registry must match the image's host
    entry = c;
  } else {
    const candidates = store.registriesForHost(host).filter((r) => r.hasSecret);
    if (!candidates.length) return null;
    const c = store.credentialsFor(candidates[0].id);
    if (!c.ok) return null;
    entry = c;
  }
  if (!entry.credentials?.secret) return null;
  const doc = { username: entry.credentials.username, password: entry.credentials.secret, serveraddress: entry.registry.host === 'registry-1.docker.io' ? 'https://index.docker.io/v1/' : entry.registry.host };
  return { header: Buffer.from(JSON.stringify(doc), 'utf8').toString('base64url'), registryId: entry.registry.id };
}

export const _internals = Object.freeze({ MAX_BODY, TIMEOUT_MS, MANIFEST_ACCEPT, registryGet, fetchToken });
