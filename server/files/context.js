// Phase 11A — storage context for one resolved path.
//
// The Properties panel answers "what *is* this, in storage terms?" and it answers from data OpusHub
// already collects: the kernel mount table (files/policy.js parses it for the deny list anyway),
// the Phase 9 storage providers (filesystem usage + ZFS datasets, through the registry), and the
// Docker provider's own container inspection. This module never talks to a socket and never runs a
// command — it reads documents other modules already produce.
//
// Every section is independently honest about availability. A container install with no Docker
// endpoint gets `{ available: false, reason }` per section, not an empty array that would read as
// "no container uses this file".
//
// Two deliberate limits:
//   • The container bind index costs one inspect per container, so it is capped at
//     LIMITS.maxContainerInspects, cached, and reports `scanned`/`truncated` when the cap bites.
//   • Docker *volumes* are reported unavailable rather than matched: `listVolumes()` deliberately
//     does not expose host mount points, and Phase 11A does not widen an existing provider's
//     boundary to decorate a properties panel.
//
// Context is *information*, never permission: it cannot widen what the path policy allows, and it
// is only ever asked about a path the policy already resolved.
import { LIMITS } from './limits.js';
import { mountEntries } from './policy.js';
import { checkProvider } from '../infrastructure/registry.js';
import * as docker from '../providers/docker.js';

const un = (reason, extra = {}) => ({ available: false, reason, ...extra });

const VOLUME_REASON = 'OpusHub’s volume listing does not expose host mount points, so a file cannot be attributed to a Docker volume in this phase.';

/* ------------------------------------------------------------------ */
/* cached container bind index                                         */
/* ------------------------------------------------------------------ */

let containerSource = null;
let containerIndex = { at: 0, fresh: false, mounts: [], scanned: 0, truncated: false, reason: null };
const contextCache = new Map();

/** Test hook: replace the container-mount reader wholesale. */
export function __setContainerSource(fn) { containerSource = fn || null; containerIndex = { at: 0, fresh: false, mounts: [], scanned: 0, truncated: false, reason: null }; }
export function __resetStorageContext() {
  containerSource = null;
  containerIndex = { at: 0, fresh: false, mounts: [], scanned: 0, truncated: false, reason: null };
  contextCache.clear();
}

/**
 * Every bind mount Docker reports, flattened: `{ container, id, state, source, target, rw }`.
 * One list call, then at most `maxContainerInspects` inspects — bounded, cached, and honest about
 * what it did not look at.
 */
async function containerMounts(at = Date.now()) {
  if (containerIndex.fresh && at - containerIndex.at < LIMITS.containerIndexTtlMs) return containerIndex;
  const reset = (reason, extra = {}) => { containerIndex = { at, fresh: true, mounts: [], scanned: 0, truncated: false, reason, ...extra }; return containerIndex; };

  if (containerSource) {
    try {
      const list = (await containerSource()) || [];
      const mounts = [];
      for (const c of list) for (const m of c.mounts || []) {
        if (!m?.source || m.type !== 'bind') continue;
        mounts.push({ container: c.container || c.name || null, id: c.id || null, state: c.state || null, source: m.source, target: m.target || null, rw: m.rw !== false });
      }
      containerIndex = { at, fresh: true, mounts, scanned: list.length, truncated: false, reason: null };
      return containerIndex;
    } catch { return reset('Container mounts could not be read.'); }
  }

  if (!docker.availability().ok) return reset('Docker is not configured on this host.');

  let list;
  try { list = await docker.listContainers({ all: true }); }
  catch { return reset('The Docker engine did not answer.'); }
  if (!Array.isArray(list)) return reset('The Docker engine returned no container list.');

  const scanned = Math.min(list.length, LIMITS.maxContainerInspects);
  const deadline = Date.now() + LIMITS.contextTimeoutMs;
  const mounts = [];
  for (const c of list.slice(0, scanned)) {
    if (Date.now() > deadline) break;
    try {
      const detail = await docker.inspectContainer(c.id);
      for (const m of detail?.mounts || []) {
        if (!m?.source || m.type !== 'bind') continue;
        mounts.push({ container: detail.name || c.name || null, id: detail.id || c.id || null, state: detail?.state?.status || c.state || null, source: m.source, target: m.target || null, rw: m.rw !== false });
      }
    } catch { /* one unreadable container does not hide the rest */ }
  }
  containerIndex = { at, fresh: true, mounts, scanned, truncated: list.length > scanned, reason: null };
  return containerIndex;
}

/* ------------------------------------------------------------------ */
/* pure matching (exported for tests)                                  */
/* ------------------------------------------------------------------ */

const inside = (path, prefix) => !!prefix && (path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));

/** Which mount a canonical path sits on: the longest matching mount point wins. */
export function mountFor(canonical, mounts) {
  let best = null;
  for (const m of mounts || []) {
    if (!m.mountPoint || !inside(canonical, m.mountPoint)) continue;
    if (!best || m.mountPoint.length > best.mountPoint.length) best = m;
  }
  return best;
}

/** Which ZFS dataset a canonical path belongs to: longest matching mountpoint. */
export function datasetFor(canonical, datasets) {
  let best = null;
  for (const d of datasets || []) {
    const mp = d?.mountpoint;
    if (!mp || mp === 'none' || mp === '-' || !inside(canonical, mp)) continue;
    if (!best || mp.length > best.mountpoint.length) best = d;
  }
  return best;
}

/**
 * Which containers a path relates to.
 *   `bind`   — the path is inside a directory a container mounts (the file reaches a container)
 *   `served` — a container mounts a directory *inside* this path (this directory serves a container)
 */
export function containerMatches(canonical, mounts, cap = 20) {
  const out = [];
  for (const m of mounts || []) {
    const relation = inside(canonical, m.source) ? 'bind' : inside(m.source, canonical) ? 'served' : null;
    if (!relation) continue;
    out.push({ container: m.container, id: m.id, state: m.state, source: m.source, target: m.target, rw: m.rw, relation });
    if (out.length >= cap) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* the answer                                                          */
/* ------------------------------------------------------------------ */

/**
 * Describe one resolved path in storage terms.
 *
 * @param opts.canonical realpath'd host path (required)
 * @param opts.root      the root it resolved under; context refuses to describe anything else
 * @param opts.relative  root-relative path, echoed for the UI
 */
export async function storageContext({ canonical, root = null, relative = null } = {}) {
  const at = Date.now();
  const path = typeof canonical === 'string' ? canonical : null;
  if (!path || !path.startsWith('/') || /\0/.test(path)) return un('That is not a path OpusHub resolved.');
  if (root?.path && !inside(path, root.path)) return un('Storage context is only available inside a filesystem root.');

  const key = `${path}|${root?.id || ''}`;
  const hit = contextCache.get(key);
  if (hit && at - hit.at < LIMITS.storageContextTtlMs) return hit.doc;

  const [mounts, fsDoc, zfsDoc, cIndex] = await Promise.all([
    mountEntries(at).catch(() => []),
    checkProvider('filesystem').catch(() => null),
    checkProvider('zfs').catch(() => null),
    containerMounts(at),
  ]);

  const mount = mountFor(path, mounts);
  const usage = (fsDoc?.data?.mounts || []).find((m) => m.mount === mount?.mountPoint) || null;
  const dataset = datasetFor(path, zfsDoc?.data?.datasets || []);

  const doc = {
    ok: true,
    at,
    path: relative ?? null,
    canonical: path,
    mount: mount
      ? {
          mountPoint: mount.mountPoint,
          source: mount.source || null,
          fsType: mount.fsType || null,
          readOnly: !!mount.readOnly,
          // a bind of a subdirectory is worth naming: it is how one dataset becomes several mounts
          bind: !!mount.fsRoot && mount.fsRoot !== '/',
          fsRoot: mount.fsRoot && mount.fsRoot !== '/' ? mount.fsRoot : null,
          usage: usage ? { total: usage.total, used: usage.used, free: usage.free, usedPct: usage.usedPct, device: usage.device || null } : null,
        }
      : null,
    mountTable: mounts.length ? { available: true, reason: null, count: mounts.length } : un('The kernel mount table is not exposed to OpusHub.', { count: 0 }),
    dataset: dataset
      ? { available: true, reason: null, name: dataset.name || null, mountpoint: dataset.mountpoint || null, used: dataset.used ?? null, free: dataset.available ?? null, compression: dataset.compression || null }
      : zfsDoc?.status === 'available'
        ? { available: true, reason: null, name: null }
        : un(zfsDoc?.error?.reason || 'ZFS is not available on this host.'),
    containers: cIndex.reason
      ? un(cIndex.reason, { matches: [], scanned: 0, truncated: false })
      : { available: true, reason: null, scanned: cIndex.scanned, truncated: cIndex.truncated, matches: containerMatches(path, cIndex.mounts) },
    volume: un(VOLUME_REASON),
  };

  contextCache.set(key, { at, doc });
  if (contextCache.size > 512) {
    // bounded like every other cache here: drop the oldest half rather than grow without limit
    for (const k of [...contextCache.keys()].slice(0, 256)) contextCache.delete(k);
  }
  return doc;
}
