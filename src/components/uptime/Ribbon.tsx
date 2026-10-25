// A pulse ribbon: one continuous shape for a monitor across a time window.
//   colour     = state (green up, amber slow or unhealthy, red down), with hard edges where it changes
//   thickness  = response time, against this monitor's own normal
//   gaps       = nothing recorded: nothing is drawn, and a stretch with checks but no verdict is a faint dotted line
// It only draws what the segments say; it never fills a hole.
import { useId, useMemo } from 'react';
import { buildRuns, LOOK_COLOR, type RibbonIncident, type Segment } from '../../lib/uptimeModel';

const W = 1000;

export function RibbonShape({ segments, from, to, stepMs, height, glow = false }: {
  segments: Segment[]; from: number; to: number; stepMs: number; height: number; glow?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const { runs, unknown } = useMemo(() => buildRuns(segments, { from, to, width: W, height, stepMs }), [segments, from, to, height, stepMs]);
  return (
    <svg className={glow ? 'ur-rib ur-glow' : 'ur-rib ur-main'} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        {runs.map((r, i) => (
          <linearGradient key={i} id={`${id}g${i}`} x1="0" x2="1" y1="0" y2="0">
            {r.stops.flatMap((s, k) => {
              const next = r.stops[k + 1]?.at ?? 1;
              return [<stop key={`${k}a`} offset={s.at} stopColor={LOOK_COLOR[s.look]} />, <stop key={`${k}b`} offset={next} stopColor={LOOK_COLOR[s.look]} />];
            })}
          </linearGradient>
        ))}
      </defs>
      {unknown.map((u, i) => <line key={`u${i}`} x1={u.x0} x2={u.x1} y1={height / 2} y2={height / 2} stroke="var(--ink-3)" strokeWidth="1.5" strokeDasharray="2 5" vectorEffect="non-scaling-stroke" opacity="0.7" />)}
      {runs.map((r, i) => {
        const pts = [...r.xs.map((x, k) => [x, r.top[k]]), ...r.xs.map((x, k) => [x, r.bot[k]]).reverse()];
        return <polygon key={i} points={pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(2)}`).join(' ')} fill={`url(#${id}g${i})`} />;
      })}
    </svg>
  );
}

/** Incident notches above a ribbon: small triangles, focusable, pulsing while the incident is open. */
export function Notches({ incidents, from, to, label }: {
  incidents: RibbonIncident[]; from: number; to: number; label: (i: RibbonIncident) => string;
}) {
  return (
    <>
      {incidents.map((i) => {
        const f = (i.startedAt - from) / (to - from);
        if (f < 0 || f > 1) return null;
        return <button key={i.id} type="button" className={`ur-notch${i.open ? ' on' : ''}`} style={{ left: `${(f * 100).toFixed(2)}%` }} aria-label={label(i)} title={label(i)} data-incident={i.id} />;
      })}
    </>
  );
}

/** The small ribbon used on Home: no notches, no glow, no scrub. */
export function MiniRibbon({ segments, from, to, stepMs, label }: { segments: Segment[]; from: number; to: number; stepMs: number; label: string }) {
  return (
    <div className="ur-mini" role="img" aria-label={label}>
      <RibbonShape segments={segments} from={from} to={to} stepMs={stepMs} height={22} />
    </div>
  );
}
