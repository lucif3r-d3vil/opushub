// Registry definitions — DATA_DIR/registries/registries.json (0600).
//
// A registry entry is: id, kind, endpoint, insecure flag, an optional username, and an optional
// secret (password or token) stored ENCRYPTED (registries/crypto.js, bound to the id). The public
// projection (`publicRegistry`) never carries the secret in any form — not masked, not hashed —
// only `hasSecret: true` and the last four characters of the username. There is no route that
// returns a secret and no function here that returns one to anything but the client module.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../configStore.js';
import { encrypt, decrypt } from './crypto.js';
import { KINDS } from './endpoint.js';

const DIR = path.join(DATA_DIR, 'registries');
const FILE = path.join(DIR, 'registries.json');
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX = 50;
let cache = null;

function load() {
  if (cache) return cache;
  try { cache = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { registries: {} }; } catch { cache = { registries: {} }; }
  if (!cache.registries || typeof cache.registries !== 'object') cache.registries = {};
  return cache;
}
function persist() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

/** What the browser may see. */
export function publicRegistry(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, kind: r.kind, endpoint: r.endpoint, host: r.host, insecure: !!r.insecure,
    username: r.username || null, hasSecret: !!r.secret, secretHint: r.secretHint || null,
    default: !!r.default, createdAt: r.createdAt, updatedAt: r.updatedAt, updatedBy: r.updatedBy || null,
    lastTest: r.lastTest || null,
  };
}

export function listRegistries() { return Object.values(load().registries).sort((a, b) => a.name.localeCompare(b.name)).map(publicRegistry); }
export function getRegistry(id) { return publicRegistry(load().registries[String(id || '').toLowerCase()] || null); }
export function isValidId(id) { return ID_RE.test(String(id || '')); }

/** The registry entries that claim a host (for pulls: which credentials apply to an image). */
export function registriesForHost(host) {
  const h = String(host || '').toLowerCase();
  return Object.values(load().registries).filter((r) => r.host === h).sort((a, b) => Number(!!b.default) - Number(!!a.default)).map(publicRegistry);
}

/**
 * Create or replace fields. `secret` semantics: undefined → unchanged; '' or null → cleared;
 * a string → sealed and stored. Never returns the secret.
 */
export function upsertRegistry({ id, name, kind, endpoint, host, insecure = false, username = undefined, secret = undefined, makeDefault = undefined, actor = null, at = Date.now() }) {
  const db = load();
  const key = String(id).toLowerCase();
  if (!ID_RE.test(key)) return { ok: false, code: 'bad_id', reason: 'A registry id is lowercase letters, digits and "-" (max 64).' };
  if (!KINDS.includes(kind)) return { ok: false, code: 'bad_kind', reason: `kind must be one of ${KINDS.join(', ')}.` };
  const existing = db.registries[key] || null;
  if (!existing && Object.keys(db.registries).length >= MAX) return { ok: false, code: 'limit', reason: `At most ${MAX} registries.` };
  const r = existing ? { ...existing } : { id: key, createdAt: at, secret: null, secretHint: null, username: null, default: false };
  r.name = String(name || existing?.name || key).slice(0, 80);
  r.kind = kind;
  r.endpoint = endpoint;
  r.host = host;
  r.insecure = !!insecure;
  if (username !== undefined) r.username = username ? String(username).slice(0, 256) : null;
  if (secret !== undefined) {
    if (secret === null || secret === '') { r.secret = null; r.secretHint = null; }
    else { const s = String(secret); r.secret = encrypt(s, key); r.secretHint = `${s.length} chars`; }
  }
  if (makeDefault !== undefined) {
    if (makeDefault) for (const o of Object.values(db.registries)) if (o.host === host) o.default = false;
    r.default = !!makeDefault;
  }
  r.updatedAt = at;
  r.updatedBy = actor;
  db.registries[key] = r;
  persist();
  return { ok: true, registry: publicRegistry(r) };
}

export function recordTest(id, result) {
  const db = load();
  const r = db.registries[String(id || '').toLowerCase()];
  if (!r) return;
  r.lastTest = { at: Date.now(), ok: !!result.ok, code: result.code || null, reason: result.reason || null, api: result.api || null };
  persist();
}

export function deleteRegistry(id) {
  const db = load();
  const key = String(id || '').toLowerCase();
  if (!db.registries[key]) return false;
  delete db.registries[key];
  persist();
  return true;
}

/**
 * The credentials for the client module ONLY. Returned as `{ username, secret }` or null.
 * Decryption failure (rotated key, tampered file) is reported, not swallowed into "anonymous".
 */
export function credentialsFor(id) {
  const r = load().registries[String(id || '').toLowerCase()];
  if (!r) return { ok: false, code: 'not_found', reason: 'No registry with that id.' };
  if (!r.secret) return { ok: true, registry: publicRegistry(r), credentials: r.username ? { username: r.username, secret: '' } : null };
  try { return { ok: true, registry: publicRegistry(r), credentials: { username: r.username || '', secret: decrypt(r.secret, r.id) } }; } catch { return { ok: false, code: 'unsealable', reason: 'The stored credentials cannot be decrypted (key changed?). Re-enter them.' }; }
}

export function _resetRegistriesStore() { cache = null; try { fs.rmSync(FILE, { force: true }); } catch { /* scratch only */ } }
export const _internals = Object.freeze({ FILE, DIR, ID_RE, MAX });
