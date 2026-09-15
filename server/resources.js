// System resource model — one consistent representation for CPU, memory, network,
// storage and GPU. Every resource answers the same questions:
//
//   current        the latest measured value (or null when not currently readable)
//   average        mean over the sampled window (history-backed, null without samples)
//   peak           max over the sampled window (null without samples)
//   availability   'available' | 'unavailable' | 'not-implemented'
//   source         which provider measured it
//   timestamp      when `current` was measured
//
// Nothing is estimated: GPU on a box without one is `unavailable` with the reason
// \"Not available\", not zeros.
function summarize(points, pick) {
  const vals = (points || []).map(pick).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!vals.length) return { average: null, peak: null, samples: 0 };
  return {
    average: vals.reduce((a, b) => a + b, 0) / vals.length,
    peak: Math.max(...vals),
    samples: vals.length,
  };
}

/**
 * Build the resource document. Pure: callers supply the system sample, the sampled history
 * window, and the storage description — this module judges shapes, never fetches.
 */
export function resourcesDocument({ system = null, points = [], storage = null, at = Date.now() } = {}) {
  const cpuStats = summarize(points, (p) => p.cpu);
  const memStats = summarize(points, (p) => p.memUsedPct);
  const rxStats = summarize(points, (p) => p.rx);
  const txStats = summarize(points, (p) => p.tx);

  const mem = system?.memory || null;
  const memUsed = mem && mem.total && mem.available != null ? mem.total - mem.available : null;
  const memPct = mem && mem.total ? (100 * (mem.total - (mem.available ?? mem.free ?? 0))) / mem.total : null;

  const ifaces = Array.isArray(system?.network) ? system.network : [];
  const rxPerSec = ifaces.reduce((a, n) => a + (n.rxPerSec || 0), 0);
  const txPerSec = ifaces.reduce((a, n) => a + (n.txPerSec || 0), 0);
  const hasRates = ifaces.some((n) => n.rxPerSec != null || n.txPerSec != null);

  const fs = storage?.providers?.find((p) => p.id === 'filesystem') || null;
  const zfs = storage?.providers?.find((p) => p.id === 'zfs') || null;

  const gpu = system?.gpu || null;

  return {
    at,
    cpu: {
      current: system?.cpu?.usage ?? null,
      unit: 'percent',
      ...cpuStats,
      cores: system?.cpu?.cores ?? null,
      load: [system?.cpu?.load1 ?? null, system?.cpu?.load5 ?? null, system?.cpu?.load15 ?? null],
      availability: system ? 'available' : 'unavailable',
      source: 'system-provider',
      timestamp: system?.at ?? null,
    },
    memory: {
      current: memUsed,
      total: mem?.total ?? null,
      available: mem?.available ?? null,
      cached: mem?.cached ?? null,
      usedPct: memPct,
      unit: 'bytes',
      averagePct: memStats.average,
      peakPct: memStats.peak,
      samples: memStats.samples,
      availability: mem ? 'available' : 'unavailable',
      source: 'system-provider',
      timestamp: system?.at ?? null,
    },
    network: {
      current: hasRates ? { rxPerSec, txPerSec } : null,
      unit: 'bytes-per-second',
      averageRx: rxStats.average,
      peakRx: rxStats.peak,
      averageTx: txStats.average,
      peakTx: txStats.peak,
      samples: Math.max(rxStats.samples, txStats.samples),
      interfaces: ifaces.map((n) => n.name),
      availability: system ? 'available' : 'unavailable',
      source: 'system-provider',
      timestamp: system?.at ?? null,
    },
    storage: {
      current: fs?.totals || null,
      mounts: fs?.mounts?.length ?? null,
      zfs: zfs?.available === true ? { pools: zfs.pools?.length ?? 0 } : null,
      unit: 'bytes',
      availability: fs?.available === true ? 'available' : fs?.available === 'not-implemented' ? 'not-implemented' : 'unavailable',
      source: 'storage-provider',
      timestamp: fs?.at ?? storage?.at ?? null,
    },
    gpu: gpu?.present
      ? {
          current: { vendor: gpu.vendor || 'unknown', devices: gpu.devices || null, driver: gpu.driver || null },
          availability: 'available', source: 'system-provider', timestamp: system?.at ?? null,
        }
      : { current: null, availability: 'unavailable', reason: 'Not available', source: 'system-provider', timestamp: system?.at ?? null },
  };
}
