// Phase 11A — uid/gid → owner and group names.
//
// A file manager that shows `1000:1000` where the host says `nora:nora` is withholding information
// it can legitimately read. This module is the only place that reads the name databases, and the
// boundary is narrow on purpose:
//
//   • it reads `/etc/passwd` and `/etc/group` **itself**, as OpusHub's own process, to map ids to
//     names. Those paths are protected from the File Manager (files/policy.js): a browser can never
//     ask for them, list them, preview them or download them.
//   • only the `name:id` columns are kept. Nothing else from those files is stored, returned or
//     logged — no hashes (there are none in passwd/group, but the rule is stated where it matters),
//     no home directories, no shells, no GECOS.
//   • bounded: one read per TTL, at most 512 KB and `nameCacheEntries` records per file.
//   • best-effort: inside a container the databases only describe the container's users, so a host
//     uid usually has no name here. That is reported as `null`, never guessed.
import fs from 'node:fs';
import { LIMITS } from './limits.js';

const MAX_BYTES = 512 * 1024;

let reader = async (file) => {
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_BYTES);
      const { bytesRead } = await handle.read(buf, 0, MAX_BYTES, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  } catch { return null; }
};

/** Test hook: the name databases are host state, so tests inject their own. */
export function __setIdentityReader(fn) { reader = fn || (async () => null); cache = { at: 0, users: null, groups: null }; }
export function __resetIdentityReader() { cache = { at: 0, users: null, groups: null }; }

let cache = { at: 0, users: null, groups: null };

/** `name:x:id:gid:gecos:home:shell` → Map(id → name). Only the name and the id survive. */
function parse(text, { idField, max }) {
  const out = new Map();
  if (!text) return out;
  for (const line of text.split('\n')) {
    if (out.size >= max) break;
    if (!line || line.startsWith('#') || line.startsWith('+') || line.startsWith('-')) continue;
    const f = line.split(':');
    if (f.length <= idField) continue;
    const id = Number(f[idField]);
    const name = String(f[0] || '').slice(0, 64);
    if (!Number.isFinite(id) || !name) continue;
    if (!out.has(id)) out.set(id, name);
  }
  return out;
}

async function tables(at = Date.now()) {
  if (cache.users && cache.groups && at - cache.at < LIMITS.nameCacheTtlMs) return cache;
  const [passwd, group] = await Promise.all([reader('/etc/passwd'), reader('/etc/group')]);
  cache = {
    at,
    users: parse(passwd, { idField: 2, max: LIMITS.nameCacheEntries }),
    groups: parse(group, { idField: 2, max: LIMITS.nameCacheEntries }),
    available: { users: passwd != null, groups: group != null },
  };
  return cache;
}

/** `{ owner, group }` — names where the host resolves them, `null` where it does not. */
export async function namesFor({ uid = null, gid = null } = {}) {
  if (uid == null && gid == null) return { owner: null, group: null };
  const t = await tables();
  return {
    owner: uid == null ? null : t.users.get(Number(uid)) ?? null,
    group: gid == null ? null : t.groups.get(Number(gid)) ?? null,
  };
}

/** One name, for the cases where only one is needed. */
export async function ownerName(uid) { return (await namesFor({ uid })).owner; }
export async function groupName(gid) { return (await namesFor({ gid })).group; }

/** Whether the host exposed its name databases at all — the UI says "ids only" when it did not. */
export async function identityAvailability() {
  const t = await tables();
  return { users: t.available?.users ?? false, groups: t.available?.groups ?? false, names: (t.users?.size || 0) + (t.groups?.size || 0) };
}
