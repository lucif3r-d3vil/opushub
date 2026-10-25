// The Uptime page's model: the ribbons document, and the geometry and wording derived from it.
// Pure functions, so every "never draw what was not recorded" rule can be tested without a browser.
import type { Monitor } from './types';

export type SegKind = 'ok' | 'degraded' | 'fail' | 'unknown';
export interface Segment {
  a: number; b: number; k: SegKind; slow: boolean; ms: number | null; n: number;
  ok: number; degraded: number; fail: number; unknown: number;
  /** an hourly bucket cut off where the raw checks begin: drawn, but not counted in summaries */
  edge?: boolean;
}
export interface RibbonMonitor {
  id: string; name: string; type: string; status: Monitor['status'] | string; enabled: boolean; latencyMs: number | null;
  service: { group: string | null; name: string } | null; intervalMs: number;
  checks: number; judged: number; uptimePct: number | null; avgMs: number | null; p95Ms: number | null;
  coverageFrom: number | null; segments: Segment[];
}
export interface RibbonIncident {
  id: string; monitorId: string; monitorName: string; startedAt: number; recoveredAt: number | null;
  durationMs: number; open: boolean; reason: string | null; failureCount?: number;
}
export interface RibbonsDoc {
  at: number; range: '24h' | '7d'; from: number; to: number; stepMs: number; slowMs: number | null;
  summary: { uptimePct: number | null; avgMs: number | null; monitors: number; up: number; slow: number; down: number; incidents: number; downtimeMs: number };
  monitors: RibbonMonitor[];
  incidents: RibbonIncident[];
}

/** What a ribbon shows for a segment: up, slow (answered, but over the threshold), unhealthy, down, or no verdict. */
export type Look = 'ok' | 'slow' | 'unhealthy' | 'down' | 'unknown';
export const lookOf = (s: Pick<Segment, 'k' | 'slow'>): Look => (s.k === 'fail' ? 'down' : s.k === 'degraded' ? 'unhealthy' : s.k === 'unknown' ? 'unknown' : s.slow ? 'slow' : 'ok');
export const LOOK_WORD: Record<Look, string> = { ok: 'Up', slow: 'Slow', unhealthy: 'Unhealthy', down: 'Down', unknown: 'No verdict' };
export const LOOK_COLOR: Record<Look, string> = { ok: 'var(--ok)', slow: 'var(--warn)', unhealthy: 'var(--warn)', down: 'var(--fail)', unknown: 'var(--ink-3)' };

const RANK: Record<string, number> = { down: 0, degraded: 1, recovering: 1, up: 2 };
/** Down first, then slow or unhealthy, then up, then monitors with no verdict yet; each group by name. */
export function sortRows(rows: RibbonMonitor[]): RibbonMonitor[] {
  return [...rows].sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3) || a.name.localeCompare(b.name));
}

/** The ribbon's own idea of "normal": the median answer time of its segments, or null with fewer than three. */
export function baseline(segments: Segment[]): number | null {
  const ms = segments.filter((s) => s.k === 'ok' && s.ms != null).map((s) => s.ms as number).sort((a, b) => a - b);
  if (ms.length < 3) return null;
  return Math.max(1, ms[Math.floor(ms.length / 2)]);
}

/** 0.1 (a hairline) at the baseline, growing to 1 (the full row) at five times it. */
export function thickness(ms: number | null, base: number | null): number {
  if (ms == null || base == null) return 0.16;
  return Math.min(1, Math.max(0.1, 0.1 + 0.9 * ((ms / base) - 1) / 4));
}

export interface Run { x0: number; x1: number; top: number[]; bot: number[]; xs: number[]; stops: { at: number; look: Look }[] }

/**
 * Turn segments into drawable runs. A run is a stretch of consecutive segments; a gap (no segment, or a
 * hole bigger than one and a half steps) ends it, and nothing is drawn across it. Segments with no
 * verdict are left out of the run and drawn separately as a faint dotted line.
 */
export function buildRuns(segments: Segment[], { from, to, width, height, stepMs }: { from: number; to: number; width: number; height: number; stepMs: number }) {
  const base = baseline(segments);
  const x = (t: number) => ((t - from) / (to - from)) * width;
  const mid = height / 2;
  const runs: Run[] = [];
  const unknown: { x0: number; x1: number }[] = [];
  let cur: { segs: Segment[] } | null = null;
  const flush = () => { if (cur && cur.segs.length) runs.push(shape(cur.segs)); cur = null; };
  const shape = (segs: Segment[]): Run => {
    const raw = segs.map((s) => (s.k === 'fail' ? 0.07 : thickness(s.ms, base)));
    // a five-tap smoothing so a spike swells and eases instead of stepping
    const sm = raw.map((_, i) => { let sum = 0; let w = 0; for (let d = -2; d <= 2; d++) { const v = raw[i + d]; if (v != null) { const k = 3 - Math.abs(d); sum += v * k; w += k; } } return sum / w; });
    const xs = segs.map((s) => x((s.a + s.b) / 2));
    const first = x(segs[0].a); const last = x(segs[segs.length - 1].b);
    const vx = [first, ...xs, last];
    const vh = [sm[0] * 0.4, ...sm.map((h, i) => (segs[i].k === 'fail' ? 0.07 : h)), sm[sm.length - 1] * 0.4];
    return {
      x0: first, x1: last, xs: vx,
      top: vh.map((h) => mid - (h * (height - 6)) / 2),
      bot: vh.map((h) => mid + (h * (height - 6)) / 2),
      stops: segs.map((s, i) => ({ at: i === 0 ? 0 : (x(s.a) - first) / Math.max(1, last - first), look: lookOf(s) })),
    };
  };
  let prevEnd: number | null = null;
  for (const s of segments) {
    if (s.k === 'unknown') { flush(); unknown.push({ x0: x(s.a), x1: x(s.b) }); prevEnd = s.b; continue; }
    if (cur && prevEnd != null && s.a - prevEnd > stepMs * 1.5) flush();
    if (!cur) cur = { segs: [] };
    cur.segs.push(s);
    prevEnd = s.b;
  }
  flush();
  return { runs, unknown, baseline: base };
}

/** The segment covering time t, or null where nothing was recorded. */
export function segmentAt(segments: Segment[], t: number): Segment | null {
  for (const s of segments) if (t >= s.a && t < s.b) return s;
  return null;
}

/** "99.95%" without ever rounding a miss up to 100. */
export function pctText(p: number | null | undefined): string {
  if (p == null) return '—';
  if (p >= 100) return '100';
  return p >= 99.995 ? '99.99' : p.toFixed(2);
}

export function durText(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export function whenText(t: number, range: '24h' | '7d'): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  return range === '7d' || Date.now() - t > 20 * 3_600_000 ? `${d.toLocaleDateString('en', { weekday: 'short' })} ${time}` : time;
}

/** One sentence per ribbon, for screen readers and as the label of the drawing. */
export function ribbonSummary(m: RibbonMonitor, range: '24h' | '7d', incidents: RibbonIncident[]): string {
  const span = range === '24h' ? 'the last 24 hours' : 'the last 7 days';
  if (!m.segments.length) return `${m.name}: no checks recorded in ${span} yet.`;
  const own = incidents.filter((i) => i.monitorId === m.id);
  const parts = [
    `${m.name}, ${span}: ${m.uptimePct == null ? 'no judged checks' : `${pctText(m.uptimePct)}% up`}`,
    own.length ? `${own.length} incident${own.length === 1 ? '' : 's'}${own.some((i) => i.open) ? ', one ongoing' : ''}` : 'no incidents',
    m.avgMs != null ? `average ${m.avgMs} ms` : null,
    `currently ${m.status}`,
  ].filter(Boolean);
  const since = m.coverageFrom != null && m.coverageFrom > Date.now() - (range === '24h' ? 20 : 150) * 3_600_000 ? `Recording began ${durText(Date.now() - m.coverageFrom)} ago. ` : '';
  return `${since}${parts.join(', ')}.`;
}

/** Shrink the window to where history exists when most of it would be empty, so a few hours still read. */
export function visibleWindow(doc: RibbonsDoc): { from: number; to: number; trimmed: boolean; since: number | null } {
  const starts = doc.monitors.map((m) => m.coverageFrom).filter((v): v is number => v != null);
  if (!starts.length) return { from: doc.from, to: doc.to, trimmed: false, since: null };
  const first = Math.min(...starts);
  const span = doc.to - doc.from;
  if (first - doc.from < span * 0.5) return { from: doc.from, to: doc.to, trimmed: false, since: first };
  // keep a little lead-in, and never less than two hours so a first ribbon is not a sliver
  const from = Math.min(first - Math.max(10 * 60_000, (doc.to - first) * 0.04), doc.to - 2 * 3_600_000);
  return { from: Math.max(doc.from, from), to: doc.to, trimmed: true, since: first };
}
