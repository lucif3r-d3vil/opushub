// The Uptime page's view over the monitoring history (outside server/monitoring/: it is a reader, not part of the engine): one ribbon of state-and-latency segments per
// monitor. Pure functions over what the engine already records (raw checks and hourly buckets);
// nothing here writes, schedules or measures anything.
//
// Rules, from docs/design/DESIGN.md §6:
//   · a segment is real: it exists only where checks were recorded. Where there is no history the
//     ribbon has a gap, and a stretch where checks ran but gave no verdict is `unknown`;
//   · 24 h uses 5-minute segments from the raw checks and falls back to the hourly buckets for the
//     part of the day that is older than the raw ring (so a short ring still draws a whole day);
//     7 d uses the hourly buckets;
//   · a segment's state is its checks' state: down when most judged checks failed, unhealthy when
//     some failed or were degraded, slow when everything answered but the average was over the slow
//     threshold, up otherwise. A segment with no judged check is `unknown`;
//   · uptime counts only `ok` over judged checks, exactly like the engine's own figure.
export const RANGES = Object.freeze({
  '24h': { ms: 24 * 3_600_000, stepMs: 5 * 60_000 },
  '7d': { ms: 7 * 24 * 3_600_000, stepMs: 3_600_000 },
});

const HOUR = 3_600_000;

/** @returns {'ok'|'degraded'|'fail'|'unknown'} from the counts of one segment. */
export function segmentState({ ok, degraded, fail }) {
  const judged = ok + degraded + fail;
  if (!judged) return 'unknown';
  if (fail / judged >= 0.5) return 'fail';
  if (fail > 0 || degraded > 0) return 'degraded';
  return 'ok';
}

function finish(seg, slowMs) {
  const k = segmentState(seg);
  const ms = seg.msCount ? Math.round(seg.msSum / seg.msCount) : null;
  return {
    a: seg.a, b: seg.b, k,
    // everything answered, but not quickly: presented as amber, and labelled slow rather than unhealthy
    slow: k === 'ok' && slowMs != null && ms != null && ms > slowMs,
    ms, n: seg.ok + seg.degraded + seg.fail + seg.unknown,
    ok: seg.ok, degraded: seg.degraded, fail: seg.fail, unknown: seg.unknown,
  };
}

const blank = (a, b) => ({ a, b, ok: 0, degraded: 0, fail: 0, unknown: 0, msSum: 0, msCount: 0 });

/** Segments for one monitor over [from, to]. */
export function segmentsFor(entry, { from, to, stepMs, slowMs = null }) {
  const ring = entry?.samples || [];
  const ringStart = ring.length ? ring[0].t : null;
  const hourSeg = (h) => finish({ a: h.h, b: h.h + HOUR, ok: h.ok, degraded: h.degraded, fail: h.fail, unknown: h.unknown, msSum: h.msSum || 0, msCount: h.msCount || 0 }, slowMs);
  const hours = (entry?.hours || []).filter((h) => h.h + HOUR > from && h.h < to);

  // a coarse range is the hourly buckets and nothing else
  if (stepMs >= HOUR) return hours.map(hourSeg);

  // a fine range is the raw checks, plus the hourly buckets for whatever part of the window is older than the ring
  const out = hours.filter((h) => ringStart == null || h.h + HOUR <= ringStart).map(hourSeg);
  // the hour that contains the first raw check is drawn up to that check so the ribbon has no hole there;
  // it is marked `edge` because its counts overlap the raw checks, and the summaries skip it
  const edge = ringStart == null ? null : hours.find((h) => h.h < ringStart && h.h + HOUR > ringStart);
  if (edge) out.push({ ...hourSeg(edge), b: ringStart, edge: true });
  const buckets = new Map();
  for (const sm of ring) {
    if (sm.t < from || sm.t > to) continue;
    const a = Math.floor(sm.t / stepMs) * stepMs;
    let b = buckets.get(a);
    if (!b) { b = blank(a, a + stepMs); buckets.set(a, b); }
    if (sm.k === 'ok') b.ok += 1; else if (sm.k === 'degraded') b.degraded += 1; else if (sm.k === 'fail') b.fail += 1; else b.unknown += 1;
    if (Number.isFinite(sm.ms)) { b.msSum += sm.ms; b.msCount += 1; }
  }
  for (const a of [...buckets.keys()].sort((x, y) => x - y)) out.push(finish(buckets.get(a), slowMs));
  return out.sort((x, y) => x.a - y.a);
}

function p95(samples) {
  const ms = samples.map((s) => s.ms).filter(Number.isFinite).sort((a, b) => a - b);
  return ms.length >= 20 ? ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)] : null;
}

/** Uptime and latency over a set of segments, counted the way the engine counts them. */
export function summarise(segments) {
  let ok = 0; let judged = 0; let msSum = 0; let msCount = 0; let checks = 0;
  for (const s of segments) {
    if (s.edge) continue;
    ok += s.ok; judged += s.ok + s.degraded + s.fail; checks += s.n;
    if (s.ms != null) { msSum += s.ms * (s.ok + s.degraded + s.fail || 1); msCount += s.ok + s.degraded + s.fail || 1; }
  }
  return { checks, judged, uptimePct: judged ? Math.round((ok / judged) * 10_000) / 100 : null, avgMs: msCount ? Math.round(msSum / msCount) : null };
}

/**
 * The whole document for GET /api/monitoring/ribbons.
 * @param {{ monitors: object[], history: Map, incidents: object[] }} input engine data, read-only
 */
export function buildRibbons({ monitors, history, incidents }, { range = '24h', at = Date.now(), slowMs = null, publicMonitor, publicIncident } = {}) {
  const R = RANGES[range] || RANGES['24h'];
  const from = at - R.ms;
  const rows = monitors.map((m) => {
    const entry = history.get(m.id) || { samples: [], hours: [] };
    const segments = segmentsFor(entry, { from, to: at, stepMs: R.stepMs, slowMs });
    const rawIn = (entry.samples || []).filter((s) => s.t >= from);
    const pm = publicMonitor(m, { now: at });
    return {
      id: m.id, name: m.name, type: m.type, status: pm.status, enabled: m.enabled, latencyMs: m.latencyMs ?? null,
      service: m.target?.service ? { group: m.target.service.group ?? null, name: m.target.service.name } : null,
      intervalMs: m.intervalMs,
      ...summarise(segments), p95Ms: p95(rawIn),
      coverageFrom: segments.length ? segments[0].a : null,
      segments,
    };
  });
  const inRange = incidents
    .filter((i) => i.startedAt <= at && (i.status !== 'resolved' || (i.recoveredAt ?? i.startedAt) >= from))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((i) => publicIncident(i, { now: at }));

  const all = rows.flatMap((r) => r.segments);
  const total = summarise(all);
  const active = rows.filter((r) => r.enabled);
  return {
    at, range, from, to: at, stepMs: R.stepMs, slowMs,
    summary: {
      uptimePct: total.uptimePct, avgMs: total.avgMs,
      monitors: active.length,
      up: active.filter((r) => r.status === 'up').length,
      slow: active.filter((r) => r.status === 'degraded' || r.status === 'recovering').length,
      down: active.filter((r) => r.status === 'down').length,
      incidents: inRange.length,
      downtimeMs: inRange.reduce((a, i) => a + Math.max(0, Math.min(at, i.recoveredAt ?? at) - Math.max(from, i.startedAt)), 0),
    },
    monitors: rows,
    incidents: inRange,
  };
}
