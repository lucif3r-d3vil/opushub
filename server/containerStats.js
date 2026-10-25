// Shared container stats — single-flight and briefly cached, nothing is stored.
//
// One Docker stats call per container per CACHE_TTL_MS, however many UI elements ask at once.
import * as docker from './providers/docker.js';

const CACHE_TTL_MS = 3000;

/** ref → { at, promise } */
const inflight = new Map();

/** Fetch (or share) one stats reading. Returns the stats object, or null. Never throws. */
export function containerStatsShared(ref) {
  const now = Date.now();
  const hit = inflight.get(ref);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = docker.containerStats(ref).catch(() => null);
  inflight.set(ref, { at: now, promise });
  setTimeout(() => { if (inflight.get(ref)?.promise === promise) inflight.delete(ref); }, CACHE_TTL_MS).unref?.();
  return promise;
}

/** Test helper. */
export function resetContainerStats() { inflight.clear(); }
