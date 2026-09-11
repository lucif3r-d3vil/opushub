// Hand-drawn SVG charts — small, dependency-free, and tuned to the design system.
import { useMemo, useRef, useState } from 'react';

export function Sparkline({
  values, width = 84, height = 26, color = 'var(--accent)', fill = true,
}: { values: number[] | null | undefined; width?: number; height?: number; color?: string; fill?: boolean }) {
  const path = useMemo(() => {
    if (!values || values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => [
      (i / (values.length - 1)) * width,
      height - 2 - ((v - min) / span) * (height - 4),
    ]);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
    return { d, area: `${d}L${width} ${height}L0 ${height}Z` };
  }, [values, width, height]);
  if (!path) return <span className="stale-note" style={{ opacity: 0.5 }}>—</span>;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {fill && <path d={path.area} fill={color} opacity={0.1} />}
      <path d={path.d} fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface AreaSeries { points: { t: number; v: number | null }[]; color?: string; label: string; fill?: boolean }

export function AreaChart({
  series, height = 132, windowMs, fmt = (v: number) => v.toFixed(0), maxHint,
}: { series: AreaSeries[]; height?: number; windowMs: number; fmt?: (v: number) => string; maxHint?: number }) {
  const W = 600, H = height, PAD_T = 10;
  const ref = useRef<SVGSVGElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const now = Date.now();
  const from = now - windowMs;

  const geom = useMemo(() => {
    const all = series.flatMap((s) => s.points.filter((p) => p.v != null));
    const minT = Math.min(...all.map((p) => p.t), from);
    const maxT = now;
    let maxV = Math.max(1, ...all.map((p) => p.v as number), maxHint ?? 0);
    let minV = Math.min(0, ...all.map((p) => p.v as number));
    if (maxHint && maxV > maxHint * 2.2) maxV = maxHint * 2.2; // keep spikes from crushing the range? clamp both ways
    const pad = (maxV - minV) * 0.08;
    maxV += pad;
    const x = (t: number) => ((t - minT) / Math.max(1, maxT - minT)) * W;
    const y = (v: number) => H - 14 - ((v - minV) / Math.max(1e-9, maxV - minV)) * (H - PAD_T - 14);
    const paths = series.map((s) => {
      const pts = s.points.map((p) => [x(p.t), p.v == null ? null : y(p.v)] as const);
      let d = ''; let started = false;
      for (const [px, py] of pts) {
        if (py == null) { started = false; continue; }
        d += `${started ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`;
        started = true;
      }
      return { d, area: d && `${d}L${x(pts[pts.length - 1]?.[0] ?? W) } ${H - 14}L${x(pts[0]?.[0] ?? from)} ${H - 14}Z` };
    });
    return { paths, minT, maxT, x, y };
  }, [series, from, now, H, maxHint]);

  const ticks = useMemo(() => {
    const n = 4;
    const out: { t: number; label: string }[] = [];
    for (let i = 0; i <= n; i++) {
      const t = geom.minT + ((geom.maxT - geom.minT) * i) / n;
      const d = new Date(t);
      out.push({
        t,
        label: d.getMinutes() === 0
          ? `${d.getHours()}h`
          : d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', hour12: false }),
      });
    }
    return out;
  }, [geom]);

  const hoverIdx = useMemo(() => {
    if (hoverX == null || !series[0]) return null;
    const pts = series[0].points;
    if (!pts.length) return null;
    const t = geom.minT + (hoverX / W) * (geom.maxT - geom.minT);
    let best = 0; let bd = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = i; } });
    return best;
  }, [hoverX, series, geom]);

  if (!series.some((s) => s.points.some((p) => p.v != null))) {
    return (
      <div className="chart" style={{ height: H, display: 'grid', placeItems: 'center', color: 'var(--ink-3)', fontSize: 'var(--fs-meta)', border: '1px dashed var(--hair)', borderRadius: 'var(--r-md)' }}>
        Collecting samples…
      </div>
    );
  }

  return (
    <div className="chart">
      <svg
        ref={ref} viewBox={`0 0 ${W} ${H + 16}`} role="img"
        aria-label={series.map((s) => s.label).join(', ')}
        onMouseMove={(e) => {
          const r = ref.current!.getBoundingClientRect();
          setHoverX(((e.clientX - r.left) / r.width) * W);
        }}
        onMouseLeave={() => setHoverX(null)}
      >
        <defs>
          {series.map((s, i) => (
            <linearGradient key={i} id={`ag${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color || 'var(--accent)'} stopOpacity={0.16} />
              <stop offset="100%" stopColor={s.color || 'var(--accent)'} stopOpacity={0.015} />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={geom.x(t.t)} x2={geom.x(t.t)} y1={PAD_T} y2={H - 14} stroke="var(--hair)" strokeWidth="1" strokeDasharray={i === 0 ? '0' : '1 4'} />
            <text x={geom.x(t.t) + 4} y={H + 8} className="chart-label">{t.label}</text>
          </g>
        ))}
        <line x1="0" x2={W} y1={H - 14} y2={H - 14} stroke="var(--hair)" />
        {series.map((s, i) => (
          <g key={i}>
            {s.fill !== false && geom.paths[i]?.area && <path d={geom.paths[i].area} fill={`url(#ag${i})`} />}
            <path d={geom.paths[i].d} fill="none" stroke={s.color || 'var(--accent)'} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
          </g>
        ))}
        {hoverIdx != null && series[0]?.points[hoverIdx] && (
          <g>
            <line className="hover-line" x1={geom.x(series[0].points[hoverIdx].t)} x2={geom.x(series[0].points[hoverIdx].t)} y1={PAD_T} y2={H - 14} />
            {series.map((s, i) => {
              const p = s.points[hoverIdx];
              if (!p || p.v == null) return null;
              return <circle key={i} cx={geom.x(p.t)} cy={geom.y(p.v)} r="3" fill={s.color || 'var(--accent)'} stroke="var(--bg)" strokeWidth="1.5" />;
            })}
          </g>
        )}
      </svg>
      {hoverIdx != null && (
        <div style={{ position: 'absolute', top: 0, right: 0, fontSize: 'var(--fs-meta)', color: 'var(--ink-2)', background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 7, padding: '3px 9px', pointerEvents: 'none' }}>
          {series[0]?.points[hoverIdx] && new Date(series[0].points[hoverIdx].t).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })}
          {series.map((s, i) => {
            const v = s.points[hoverIdx]?.v;
            return v == null ? null : (
              <span key={i} style={{ marginLeft: 10 }}><b style={{ color: s.color || 'var(--accent)', fontWeight: 600 }}>{fmt(v)}</b> {s.label.toLowerCase()}</span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function MeterBar({ value, max = 100, className = '' }: { value: number | null; max?: number; className?: string }) {
  if (value == null) return <div className={`meter muted ${className}`}><i style={{ width: '0%' }} /></div>;
  const pctv = Math.max(0, Math.min(100, (value / max) * 100));
  const state = pctv > 95 ? 'fail' : pctv > 85 ? 'warn' : '';
  return <div className={`meter ${state} ${className}`} role="progressbar" aria-valuenow={Math.round(pctv)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pctv}%` }} /></div>;
}
