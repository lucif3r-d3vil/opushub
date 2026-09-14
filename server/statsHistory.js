// Per-container stats history — demand-driven, bounded, in-memory.
//
// Rules this module exists to enforce (Phase 3 §29):
//   • there is NO global per-container polling loop — samples only ever arrive because somebody
//     is looking at that exact container (Service Detail open, stack detail open, manual refresh);
//   • one container keeps at most MAX_SAMPLES samples (30 minutes at a 5s cadence);
//   • one sample per container per MIN_INTERVAL_MS, no matter how many UI elements ask —
//     concurrent requests share one in-flight Docker call (single-flight) and one cached answer;
//   • a container nobody is watching costs exactly nothing: its buffer expires and is dropped.
//
// The samples are the raw stats projection from providers/docker.js (cpu / memory / net / pids /
// blockIo). Net rx/tx are cumulative counters in Docker; the client derives rates from
// consecutive samples and never invents a rate from a single point.
import * as docker from './providers/docker.js';

const MAX_SAMPLES = 360;          // 30 min at one sample / 5s
const MIN_INTERVAL_MS = 2000;     // never sample the same container more than once per 2s
const CACHE_TTL_MS = 3000;        // share one answer across concurrent UI consumers
const IDLE_DROP_MS = 15 * 60_000; // a buffer nobody has read for 15 min disappears

/** ref → { samples: [{t, cpu, mem, memLimit, netRx, netTx, pids, blockIo}], lastAt } */
const buffers = new Map();
/** ref → { at, value, promise } — short-lived dedup cache */
const inflight = new Map();

function bufferFor(ref) {
  if (!buffers.has(ref)) buffers.set(ref, { samples: [], lastAt: 0, readAt: 0 });
  return buffers.get(ref);
}

function prune(now = Date.now()) {
  if (buffers.size <= 64) return;
  for (const [ref, b] of buffers) {
    if (now - b.readAt > IDLE_DROP_MS || (now - b.lastAt > IDLE_DROP_MS && now - (b.samples.at?.t || 0) > IDLE_DROP_MS)) {
      buffers.delete(ref);
    }
  }
}

/**
 * Fetch (or share) one stats sample for a container and append it to its history.
 * Returns the stats object, or null when the engine has nothing to say (stopped container,
 * malformed payload, cgroup limits…). Never throws.
 */
export async function statsWithHistory(ref) {
  const now = Date.now();
  const cached = inflight.get(ref);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.promise || cached.value;
  }

  const buf = bufferFor(ref);
  const tooSoon = buf.lastAt && now - buf.lastAt < MIN_INTERVAL_MS;
  if (tooSoon && cached) return cached.promise || cached.value;

  const promise = (async () => {
    try {
      const stats = await docker.containerStats(ref);
      const at = Date.now();
      buf.samples.push({
        t: at,
        cpu: stats.cpu ?? null,
        mem: stats.memory?.used ?? null,
        memLimit: stats.memory?.limit ?? null,
        netRx: stats.net?.rx ?? null,
        netTx: stats.net?.tx ?? null,
        pids: stats.pids ?? null,
        blockIo: stats.blockIo ?? null,
      });
      if (buf.samples.length > MAX_SAMPLES) buf.samples = buf.samples.slice(-MAX_SAMPLES);
      buf.lastAt = at;
      buf.readAt = at;
      prune(at);
      return stats;
    } catch {
      return null;
    } finally {
      // let the dedup entry outlive the promise briefly so concurrent callers share the value
      setTimeout(() => { if (inflight.get(ref)?.promise === promise) inflight.delete(ref); }, CACHE_TTL_MS).unref?.();
    }
  })();

  inflight.set(ref, { at: now, promise, value: null });
  const value = await promise;
  const entry = inflight.get(ref);
  if (entry && entry.promise === promise) { entry.promise = null; entry.value = value; }
  return value;
}

/** The bounded sample history for one container, newest last. Marks when watching began. */
export function statsHistory(ref, { windowMs = 30 * 60_000 } = {}) {
  const buf = buffers.get(ref);
  const now = Date.now();
  if (!buf) return { samples: [], watchingSince: null, capped: MAX_SAMPLES };
  buf.readAt = now;
  const cutoff = now - windowMs;
  const samples = buf.samples.filter((s) => s.t >= cutoff);
  return {
    samples,
    watchingSince: buf.samples[0]?.t ?? null,
    capped: MAX_SAMPLES,
  };
}

/**
 * Aggregate series across several containers — a stack's shape over the same session window.
 *
 * Members are sampled in the same request (the stack detail route looks at all of them), so their
 * timestamps cluster within a second or two. Buckets of BUCKET_MS merge those into one point per
 * cadence. Nothing is interpolated and nothing is invented: a bucket reports how many containers
 * actually answered (`count`), so a chart can say "3 of 5" instead of pretending the gap was zero.
 *
 * Only containers that already have a buffer appear — the sampler is still demand-driven, and this
 * function makes no Docker calls of its own.
 */
const BUCKET_MS = 2000;

export function aggregateHistory(refs, { windowMs = 30 * 60_000 } = {}) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const buckets = new Map();
  let watchingSince = null;
  let live = 0;

  for (const ref of refs || []) {
    const buf = buffers.get(ref);
    if (!buf || !buf.samples.length) continue;
    live += 1;
    buf.readAt = now;
    if (watchingSince == null || buf.samples[0].t < watchingSince) watchingSince = buf.samples[0].t;
    for (const sample of buf.samples) {
      if (sample.t < cutoff) continue;
      const key = Math.round(sample.t / BUCKET_MS) * BUCKET_MS;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { t: key, cpu: 0, cpuSeen: 0, mem: 0, memSeen: 0, limit: 0, limitSeen: 0, netRx: 0, netSeen: 0, netTx: 0, count: 0 };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      if (sample.cpu != null) { bucket.cpu += sample.cpu; bucket.cpuSeen += 1; }
      if (sample.mem != null) { bucket.mem += sample.mem; bucket.memSeen += 1; }
      if (sample.memLimit != null) { bucket.limit += sample.memLimit; bucket.limitSeen += 1; }
      if (sample.netRx != null && sample.netTx != null) { bucket.netRx += sample.netRx; bucket.netTx += sample.netTx; bucket.netSeen += 1; }
    }
  }

  const samples = [...buckets.values()]
    .sort((a, b) => a.t - b.t)
    .map((b) => ({
      t: b.t,
      // sums are only reported for what was actually seen; a missing member is never counted as 0
      cpu: b.cpuSeen ? b.cpu : null,
      mem: b.memSeen ? b.mem : null,
      memLimit: b.limitSeen ? b.limit : null,
      netRx: b.netSeen ? b.netRx : null,
      netTx: b.netSeen ? b.netTx : null,
      count: b.count,
    }));

  return { samples, watchingSince, containers: refs?.length ?? 0, reporting: live, capped: MAX_SAMPLES, bucketMs: BUCKET_MS };
}

/** Test helper. */
export function resetStatsHistory() {
  buffers.clear();
  inflight.clear();
}

export const _internals = { buffers, inflight, MAX_SAMPLES, MIN_INTERVAL_MS, CACHE_TTL_MS };
