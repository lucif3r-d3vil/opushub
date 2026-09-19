// Phase 10D-C — registries. Credentials live server-side only.
//
//   GET    /api/v1/registries                 the list (no secret in any form)
//   POST   /api/v1/registries                 { id, name, kind, endpoint, insecure?, username?, secret?, default? }
//   GET    /api/v1/registries/:id
//   PATCH  /api/v1/registries/:id             same fields; secret undefined = keep, '' = clear
//   DELETE /api/v1/registries/:id
//   POST   /api/v1/registries/:id/test        /v2/ ping with the stored credentials
//   GET    /api/v1/registries/:id/repositories?q=   (private registries only)
//   GET    /api/v1/registries/:id/tags?repository=
//   GET    /api/v1/registries/:id/manifest?repository=&reference=
//
// Every remote call is one of the five fixed request shapes in registries/client.js against the
// stored, validated endpoint; the browser cannot name a URL, a path, a method or a header. Pulls
// are `image.pull` operations (confirmed) — this module has no pull route.
import * as store from './registries/store.js';
import * as client from './registries/client.js';
import { parseEndpoint, validateEndpoint, KINDS, REPOSITORY_RE, TAG_RE, DIGEST_RE } from './registries/endpoint.js';
import { keyAvailable } from './registries/crypto.js';
import { can, PERMISSIONS } from './operations/permissions.js';
import { logEvent } from './activity.js';
import { publishEventSafe } from './events/index.js';

const KIND_HOSTS = Object.freeze({ dockerhub: 'registry-1.docker.io', ghcr: 'ghcr.io' });

function readBodyFields(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'Expected a JSON object.' };
  const allowed = ['id', 'name', 'kind', 'endpoint', 'insecure', 'username', 'secret', 'default'];
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) return { ok: false, reason: `Unexpected field: ${extra[0]}` };
  const out = {};
  if (body.id !== undefined) out.id = String(body.id).trim().toLowerCase();
  if (body.name !== undefined) out.name = String(body.name).trim().slice(0, 80);
  if (body.kind !== undefined) { out.kind = String(body.kind); if (!KINDS.includes(out.kind)) return { ok: false, reason: `kind must be one of ${KINDS.join(', ')}.` }; }
  if (body.endpoint !== undefined) out.endpoint = String(body.endpoint).trim();
  if (body.insecure !== undefined) out.insecure = body.insecure === true;
  if (body.username !== undefined) { if (body.username !== null && typeof body.username !== 'string') return { ok: false, reason: 'username must be a string.' }; out.username = body.username ? body.username.slice(0, 256) : null; }
  if (body.secret !== undefined) { if (body.secret !== null && typeof body.secret !== 'string') return { ok: false, reason: 'secret must be a string.' }; if (body.secret && body.secret.length > 4096) return { ok: false, reason: 'secret is too long.' }; out.secret = body.secret; }
  if (body.default !== undefined) out.default = body.default === true;
  if (!partial) {
    if (!out.id) return { ok: false, reason: 'An id is required.' };
    if (!out.kind) return { ok: false, reason: 'A kind is required.' };
  }
  return { ok: true, fields: out };
}

export async function handleRegistriesRoutes({ p, method, send, jsonBody, actor, query }) {
  const m = p.match(/^\/api\/(?:v1\/)?registries(?:\/([^/]+)(?:\/(test|repositories|tags|manifest))?)?$/);
  if (!m) return false;
  const [, rawId, sub] = m;
  const bad = (status, code, error, extra = {}) => { send(status, { error, code, ...extra }); return true; };
  const manage = can(actor, PERMISSIONS.REGISTRY_MANAGE);
  const readBody = async () => { try { return { ok: true, body: await jsonBody() }; } catch (err) { return { ok: false, status: err?.status || 400, reason: String(err?.message || err) }; } };

  if (rawId === undefined) {
    if (method === 'GET') { send(200, { registries: store.listRegistries(), kinds: KINDS, secretStorage: keyAvailable(), permissions: { manage } }); return true; }
    if (method !== 'POST') return bad(405, 'method_not_allowed', 'Method not allowed');
    if (!manage) return bad(403, 'not_permitted', 'Your account is not allowed to manage registries.');
    const b = await readBody();
    if (!b.ok) return bad(b.status, 'bad_request', b.reason);
    const f = readBodyFields(b.body);
    if (!f.ok) return bad(400, 'bad_request', f.reason);
    if (!store.isValidId(f.fields.id)) return bad(400, 'bad_id', 'A registry id is lowercase letters, digits and "-" (max 64).');
    if (store.getRegistry(f.fields.id)) return bad(409, 'conflict', 'A registry with that id already exists.');
    const ep = await resolveFields(f.fields);
    if (!ep.ok) return bad(400, ep.code, ep.reason);
    const ks = keyAvailable();
    if (f.fields.secret && !ks.ok) return bad(503, 'no_secret_key', `Secrets cannot be stored: ${ks.reason}`);
    const r = store.upsertRegistry({ ...f.fields, endpoint: ep.origin, host: ep.host, makeDefault: f.fields.default, actor });
    if (!r.ok) return bad(400, r.code, r.reason);
    logEvent({ source: 'config', type: 'registry.created', subject: r.registry.id, message: `registry ${r.registry.id} (${r.registry.kind}, ${r.registry.host}) added by ${actor || 'unknown'}` });
    publishEventSafe({ type: 'config.updated', severity: 'info', source: 'config', subject: { kind: 'registry', id: r.registry.id, label: r.registry.name, href: '/settings/registries' }, message: `Registry ${r.registry.name} added`, payload: { registry: r.registry.id, host: r.registry.host } });
    send(201, { registry: r.registry });
    return true;
  }

  const id = decodeURIComponent(rawId).toLowerCase();
  if (!store.isValidId(id)) return bad(400, 'bad_id', 'That is not a registry id.');
  const reg = store.getRegistry(id);
  if (!reg) return bad(404, 'not_found', 'No registry with that id.');

  if (!sub) {
    if (method === 'GET') { send(200, { registry: reg }); return true; }
    if (method === 'PATCH') {
      if (!manage) return bad(403, 'not_permitted', 'Your account is not allowed to manage registries.');
      const b = await readBody();
      if (!b.ok) return bad(b.status, 'bad_request', b.reason);
      const f = readBodyFields(b.body, { partial: true });
      if (!f.ok) return bad(400, 'bad_request', f.reason);
      if (f.fields.id && f.fields.id !== id) return bad(400, 'bad_request', 'The id cannot be changed.');
      const merged = { kind: f.fields.kind || reg.kind, endpoint: f.fields.endpoint || reg.endpoint, insecure: f.fields.insecure ?? reg.insecure };
      const ep = await resolveFields(merged);
      if (!ep.ok) return bad(400, ep.code, ep.reason);
      if (f.fields.secret && !keyAvailable().ok) return bad(503, 'no_secret_key', 'Secrets cannot be stored: no key.');
      const r = store.upsertRegistry({ id, name: f.fields.name ?? reg.name, kind: merged.kind, endpoint: ep.origin, host: ep.host, insecure: merged.insecure, username: f.fields.username, secret: f.fields.secret, makeDefault: f.fields.default, actor });
      if (!r.ok) return bad(400, r.code, r.reason);
      logEvent({ source: 'config', type: 'registry.updated', subject: id, message: `registry ${id} updated by ${actor || 'unknown'}${f.fields.secret !== undefined ? ' (credentials changed)' : ''}` });
      send(200, { registry: r.registry });
      return true;
    }
    if (method === 'DELETE') {
      if (!manage) return bad(403, 'not_permitted', 'Your account is not allowed to manage registries.');
      store.deleteRegistry(id);
      logEvent({ source: 'config', type: 'registry.deleted', subject: id, message: `registry ${id} removed by ${actor || 'unknown'}` });
      send(200, { ok: true });
      return true;
    }
    return bad(405, 'method_not_allowed', 'Method not allowed');
  }

  if (sub === 'test') {
    if (method !== 'POST') return bad(405, 'method_not_allowed', 'Method not allowed');
    if (!manage) return bad(403, 'not_permitted', 'Your account is not allowed to test registries.');
    const r = await client.ping(id);
    store.recordTest(id, r);
    logEvent({ source: 'config', type: r.ok ? 'registry.test_ok' : 'registry.test_failed', subject: id, message: r.ok ? `registry ${id} reachable (${r.ms} ms${r.authenticated ? ', authenticated' : ''})` : `registry ${id} test failed: ${r.reason}` });
    send(200, { result: { ok: r.ok, code: r.code || null, reason: r.reason || null, api: r.api || null, authenticated: r.authenticated || false, ms: r.ms ?? null } });
    return true;
  }
  if (method !== 'GET') return bad(405, 'method_not_allowed', 'Method not allowed');
  if (sub === 'repositories') {
    const q = String(query?.get('q') || '').toLowerCase().slice(0, 128);
    const r = await client.catalog(id, { q });
    if (!r.ok) return bad(r.code === 'no_catalog' ? 501 : r.code === 'unauthorized' ? 502 : 502, r.code, r.reason);
    send(200, { repositories: r.repositories, truncated: r.truncated });
    return true;
  }
  if (sub === 'tags') {
    const repository = String(query?.get('repository') || '').toLowerCase();
    if (!REPOSITORY_RE.test(repository)) return bad(400, 'bad_repository', 'That is not a repository name.');
    const r = await client.tags(id, repository);
    if (!r.ok) return bad(r.code === 'not_found' ? 404 : r.code === 'bad_repository' ? 400 : 502, r.code, r.reason);
    send(200, { repository: r.repository, tags: r.tags, truncated: r.truncated });
    return true;
  }
  if (sub === 'manifest') {
    const repository = String(query?.get('repository') || '').toLowerCase();
    const reference = String(query?.get('reference') || '');
    if (!REPOSITORY_RE.test(repository)) return bad(400, 'bad_repository', 'That is not a repository name.');
    if (!TAG_RE.test(reference) && !DIGEST_RE.test(reference)) return bad(400, 'bad_reference', 'That is not a tag or a sha256 digest.');
    const r = await client.manifest(id, repository, reference);
    if (!r.ok) return bad(r.code === 'not_found' ? 404 : 502, r.code, r.reason);
    send(200, { manifest: r });
    return true;
  }
  return bad(404, 'not_found', 'Not found');
}

async function resolveFields(f) {
  const endpoint = f.endpoint || KIND_HOSTS[f.kind];
  if (!endpoint) return { ok: false, code: 'bad_request', reason: 'An endpoint is required for this kind.' };
  if (KIND_HOSTS[f.kind] && f.endpoint) {
    const p = parseEndpoint(f.endpoint);
    if (!p.ok || p.host !== KIND_HOSTS[f.kind]) return { ok: false, code: 'bad_endpoint', reason: `A ${f.kind} registry always points at ${KIND_HOSTS[f.kind]}.` };
  }
  const v = await validateEndpoint(endpoint, { insecure: !!f.insecure });
  if (!v.ok) return v;
  return v;
}
