// The expanded host chart: one metric over 1 h, 24 h or 7 d, hand-drawn, with a hover read-out,
// an average line, the peak marked, and now / average / peak / lowest underneath. Only measured
// samples are drawn; a gap in the data is a gap in the line, never an interpolated stretch.
import { useEffect, useMemo, useRef, useState } from 'react';
import { bytes } from '../../lib/format';
import type { HostMetric } from '../../lib/homeModel';
import type { HistoryPoint } from '../../lib/types';

export type HostRange = '1h' | '24h' | '7d';
export const RANGES: { id: HostRange; label: string; ms: number; long: string }[] = [
  { id: '1h', label: '1 hour', ms: 3600_000, long: 'last hour' },
  { id: '24h', label: '24 hours', ms: 24 * 3600_000, long: 'last 24 hours' },
  { id: '7d', label: '7 days', ms: 7 * 24 * 3600_000, long: 'last 7 days' },
];

interface MetricDef { label: string; note: string; pick: (p: HistoryPoint) => number | null | undefined; fmt: (v: number) => string; max?: number }

export const METRICS: Record<HostMetric, MetricDef> = {
  cpu: { label: 'CPU', note: 'share of all cores in use', pick: (p) => p.cpu, fmt: (v) => `${v.toFixed(v < 10 ? 1 : 0)}%`, max: 100 },
  memory: { label: 'Memory', note: 'memory in use, caches excluded', pick: (p) => p.memUsedPct, fmt: (v) => `${v.toFixed(0)}%`, max: 100 },
  network: { label: 'Network', note: 'data received, all interfaces', pick: (p) => p.rx, fmt: (v) => bytes(v, true) },
  disk: { label: 'Disk /', note: 'space used on the root filesystem', pick: (p) => p.diskUsedPct, fmt: (v) => `${v.toFixed(v < 10 ? 1 : 0)}%`, max: 100 },
  temp: { label: 'Temperature', note: 'first thermal zone the host reports', pick: (p) => p.temp, fmt: (v) => `${v.toFixed(0)}°C` },
};

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => { const n = el.clientWidth || el.getBoundingClientRect().width || 0; setW((c) => (n > 0 && Math.abs(c - n) > 1 ? Math.round(n) : c)); };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  return [ref, w] as const;
}

const H = 230; const PAD = { l: 46, r: 14, t: 16, b: 28 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function clock(t: number, range: HostRange) {
  const d = new Date(t);
  return range === '7d' ? d.toLocaleDateString('en', { weekday: 'short', hour: 'numeric' }) : d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Average runs of raw samples down to about `target` points so a one-hour view reads as a line, not noise. */
export function downsample(pts: { t: number; v: number }[], target = 120): { t: number; v: number }[] {
  if (pts.length <= target * 1.5) return pts;
  const size = Math.ceil(pts.length / target);
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < pts.length; i += size) {
    const chunk = pts.slice(i, i + size);
    out.push({ t: chunk[Math.floor(chunk.length / 2)].t, v: chunk.reduce((a, p) => a + p.v, 0) / chunk.length });
  }
  return out;
}

export interface ChartStats { now: number; avg: number; peak: { v: number; t: number }; low: { v: number; t: number } }

export function chartStats(pts: { t: number; v: number }[]): ChartStats | null {
  if (!pts.length) return null;
  let peak = pts[0]; let low = pts[0]; let sum = 0;
  for (const p of pts) { sum += p.v; if (p.v > peak.v) peak = p; if (p.v < low.v) low = p; }
  return { now: pts[pts.length - 1].v, avg: sum / pts.length, peak: { v: peak.v, t: peak.t }, low: { v: low.v, t: low.t } };
}

export function HostChart({ metric, range, points, stepMs, loading, error }: {
  metric: HostMetric; range: HostRange; points: HistoryPoint[] | null; stepMs: number | null; loading: boolean; error: string | null;
}) {
  const def = METRICS[metric];
  const [box, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const pts = useMemo(() => downsample((points ?? []).map((p) => ({ t: p.t, v: def.pick(p) })).filter((p): p is { t: number; v: number } => typeof p.v === 'number' && Number.isFinite(p.v))), [points, def]);
  const stats = useMemo(() => chartStats(pts), [pts]);
  const r = RANGES.find((x) => x.id === range)!;

  const w = Math.max(width, 280);
  const to = pts.length ? pts[pts.length - 1].t : Date.now();
  const from = to - r.ms;
  // percentages fit their own range (capped at 100) so a quiet CPU is still readable
  const peakV = Math.max(...pts.map((p) => p.v), 1);
  const max = def.max ? Math.min(def.max, Math.max(10, niceMax(peakV * 1.25))) : niceMax(peakV * 1.1);
  const x = (t: number) => PAD.l + ((t - from) / (to - from)) * (w - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const gap = (stepMs ?? 5000) * 3.5;

  // one path per unbroken run of samples
  const runs = useMemo(() => {
    const out: { t: number; v: number }[][] = [];
    for (const p of pts) {
      const cur = out[out.length - 1];
      if (cur && p.t - cur[cur.length - 1].t <= gap) cur.push(p); else out.push([p]);
    }
    return out;
  }, [pts, gap]);
  const line = (run: { t: number; v: number }[]) => run.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
  const area = (run: { t: number; v: number }[]) => `${line(run)}L${x(run[run.length - 1].t).toFixed(1)} ${y(0)}L${x(run[0].t).toFixed(1)} ${y(0)}Z`;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const xt = [0, 0.25, 0.5, 0.75, 1].map((f) => from + f * (to - from));

  const idxAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || !pts.length) return null;
    const t = from + ((clientX - rect.left - PAD.l) / (w - PAD.l - PAD.r)) * (to - from);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - t) < Math.abs(pts[best].t - t)) best = i;
    return best;
  };
  const hp = hover != null ? pts[hover] : null;

  if (error && !pts.length) return <p className="hm-note" role="status">The history is not available right now ({error}).</p>;
  if (loading && !pts.length) return <p className="hm-note" role="status">Reading the history…</p>;
  if (pts.length < 2) {
    return (
      <p className="hm-note" role="status">
        Not enough {def.label.toLowerCase()} history for the {r.long} yet ({pts.length} sample{pts.length === 1 ? '' : 's'}). OpusHub records the
        host once every five seconds and keeps hourly averages for seven days, so a longer range fills in as time passes.
      </p>
    );
  }

  return (
    <>
      <div
        ref={box} className="hm-chart" tabIndex={0} role="img"
        aria-label={`${def.label} over the ${r.long}: now ${def.fmt(stats!.now)}, average ${def.fmt(stats!.avg)}, peak ${def.fmt(stats!.peak.v)}. Use the arrow keys to read values.`}
        onPointerMove={(e) => setHover(idxAt(e.clientX))} onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setHover((h) => Math.max(0, Math.min(pts.length - 1, (h ?? pts.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 12 : 1)))); }
          if (e.key === 'Escape') setHover(null);
        }}
        onBlur={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${w} ${H}`} width={w} height={H} aria-hidden="true">
          <defs><linearGradient id="hm-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity="0.30" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={w - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--hair)" strokeDasharray={v === 0 ? undefined : '2 5'} />
              <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end">{def.fmt(v)}</text>
            </g>
          ))}
          {xt.map((t, i) => <text key={t} x={x(t)} y={H - 8} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>{i === 4 ? 'now' : clock(t, range)}</text>)}
          {runs.map((run, i) => run.length > 1 && <path key={`a${i}`} d={area(run)} fill="url(#hm-fill)" />)}
          <line x1={PAD.l} x2={w - PAD.r} y1={y(stats!.avg)} y2={y(stats!.avg)} stroke="var(--ink-3)" strokeDasharray="5 5" />
          {runs.map((run, i) => <path key={`l${i}`} className="hm-ln" d={line(run)} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
          <circle cx={x(stats!.peak.t)} cy={y(stats!.peak.v)} r="4" fill="var(--warn)" />
          <text className="hm-pk" x={Math.min(x(stats!.peak.t), w - PAD.r - 40)} y={y(stats!.peak.v) - 10} textAnchor="middle">peak {def.fmt(stats!.peak.v)}</text>
          {hp && <><line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.t} y2={y(0)} stroke="var(--ink-2)" strokeOpacity="0.6" /><circle cx={x(hp.t)} cy={y(hp.v)} r="4.5" fill="var(--bg)" stroke="var(--accent)" strokeWidth="2" /></>}
        </svg>
        {hp && (
          <div className="hm-tip" style={{ left: Math.max(6, Math.min(x(hp.t) - 44, w - 100)), top: Math.max(0, y(hp.v) - 56) }}>
            <b>{def.fmt(hp.v)}</b><em>{clock(hp.t, range)}</em>
          </div>
        )}
      </div>
      <div className="hm-stats">
        <div><b>{def.fmt(stats!.now)}</b><small>latest</small></div>
        <div><b>{def.fmt(stats!.avg)}</b><small>average, {r.long}</small></div>
        <div><b>{def.fmt(stats!.peak.v)}</b><small>peak at {clock(stats!.peak.t, range)}</small></div>
        <div><b>{def.fmt(stats!.low.v)}</b><small>lowest at {clock(stats!.low.t, range)}</small></div>
      </div>
    </>
  );
}
