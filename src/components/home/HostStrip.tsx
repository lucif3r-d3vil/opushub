// The host strip: CPU, Memory, Network, Disk, Temperature and Uptime in one line. Every figure is
// read from the host; one that the host does not report says so instead of showing a zero.
// Each reading (except Uptime) opens a larger chart underneath: 1 hour, 24 hours or 7 days.
import { useMemo, type ReactNode } from 'react';
import { bytes, uptime } from '../../lib/format';
import { hostNow, type HostMetric } from '../../lib/homeModel';
import type { HistoryPoint, SystemSnapshot } from '../../lib/types';
import { METRICS, RANGES, HostChart, type HostRange } from './HostChart';

const KEYS: { m: HostMetric; label: string; spark?: keyof HistoryPoint }[] = [
  { m: 'cpu', label: 'CPU', spark: 'cpu' },
  { m: 'memory', label: 'Memory', spark: 'memUsedPct' },
  { m: 'network', label: 'Network', spark: 'rx' },
  { m: 'disk', label: 'Disk /', spark: 'diskUsedPct' },
  { m: 'temp', label: 'Temp' },
];

function Spark({ values }: { values: number[] }) {
  const d = useMemo(() => {
    if (values.length < 2) return null;
    const min = Math.min(...values); const max = Math.max(...values); const span = max - min || 1;
    const pts = values.map((v, i) => [(i / (values.length - 1)) * 160, 28 - 2 - ((v - min) / span) * 24]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
    return { line, area: `${line}L160 30L0 30Z` };
  }, [values]);
  if (!d) return <div className="hm-plain">Collecting…</div>;
  return (
    <svg className="hm-sp" viewBox="0 0 160 30" preserveAspectRatio="none" aria-hidden="true">
      <path d={d.area} fill="var(--accent)" opacity="0.12" />
      <path d={d.line} fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const Chev = () => <svg className="hm-cv" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;

export function HostStrip({ sys, spark, open, onToggle }: { sys: SystemSnapshot | null; spark: HistoryPoint[]; open: HostMetric | null; onToggle: (m: HostMetric) => void }) {
  const now = hostNow(sys);
  const show = (m: HostMetric): ReactNode => {
    const v = now[m].value;
    if (v == null) return <span className="hm-na">Not reported</span>;
    if (m === 'network') return <>↓ {bytes(v, true)}</>;
    if (m === 'temp') return <>{v.toFixed(0)}<small>°C</small></>;
    return <>{v.toFixed(v < 10 ? 1 : 0)}<small>%{now[m].detail ? ` ${now[m].detail}` : ''}</small></>;
  };
  return (
    <section className="hm-host glass rise" style={{ ['--i' as never]: 1 }} aria-label="Host vitals">
      {KEYS.map((k) => {
        const values = k.spark ? spark.map((p) => p[k.spark!]).filter((v): v is number => typeof v === 'number') : [];
        const inner = (
          <>
            <div className="hm-lab"><span className="micro-label">{k.label}</span>{now[k.m].value != null && <Chev />}</div>
            <div className="hm-val">{show(k.m)}</div>
            {k.spark ? <Spark values={values.slice(-60)} /> : <div className="hm-plain">{now.temp.detail ? `${now.temp.detail} · reported by the host` : 'the host reports no sensors'}</div>}
          </>
        );
        return now[k.m].value == null && k.m === 'temp'
          ? <div key={k.m} className="hm-h">{inner}</div>
          : <button key={k.m} type="button" className="hm-h hm-hb" aria-expanded={open === k.m} aria-controls="hm-hx" aria-label={`${METRICS[k.m].label}: show history`} onClick={() => onToggle(k.m)}>{inner}</button>;
      })}
      <div className="hm-h">
        <div className="hm-lab"><span className="micro-label">Uptime</span></div>
        <div className="hm-val">{sys?.host.uptimeSec != null ? uptime(sys.host.uptimeSec) : <span className="hm-na">Not reported</span>}</div>
        <div className="hm-plain">{sys?.host.hostname ?? ''}</div>
      </div>
    </section>
  );
}

export function HostExpander({ metric, range, onRange, onClose, points, stepMs, loading, error }: {
  metric: HostMetric | null; range: HostRange; onRange: (r: HostRange) => void; onClose: () => void;
  points: HistoryPoint[] | null; stepMs: number | null; loading: boolean; error: string | null;
}) {
  const def = metric ? METRICS[metric] : null;
  return (
    <div className="hm-hxw" data-open={metric ? 'true' : 'false'} id="hm-hx">
      <div className="hm-hxi">
        {metric && def && (
          <section className="hm-hx glass" aria-label={`${def.label} history`}>
            <header>
              <h2>{def.label}</h2><span className="hm-meta">{def.note}</span>
              <span className="seg-sm" role="group" aria-label="Range">
                {RANGES.map((r) => <button key={r.id} type="button" aria-pressed={range === r.id} onClick={() => onRange(r.id)}>{r.label}</button>)}
              </span>
              <button type="button" className="hm-x" onClick={onClose} aria-label="Close chart">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </header>
            <HostChart metric={metric} range={range} points={points} stepMs={stepMs} loading={loading} error={error} />
          </section>
        )}
      </div>
    </div>
  );
}
