// Uptime: a summary, one pulse ribbon per monitor with a shared hover scrub, and the incidents.
// A new view over the monitoring engine's recorded history (GET /api/monitoring/ribbons); the
// engine and its data are untouched. Where nothing was recorded there is a gap, never a bar.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Notches, RibbonShape } from '../components/uptime/Ribbon';
import { useSharedQuery } from '../lib/api';
import { relTime } from '../lib/format';
import {
  LOOK_WORD, durText, lookOf, pctText, ribbonSummary, segmentAt, sortRows, visibleWindow, whenText,
  type RibbonIncident, type RibbonMonitor, type RibbonsDoc,
} from '../lib/uptimeModel';
import type { MonitoringEngineHealth } from '../lib/types';
import { UptimeActions } from './UptimeActions';

type Range = '24h' | '7d';

/** Axis labels on round local times, about six of them across the window. */
function axisTicks(from: number, to: number): { t: number; label: string }[] {
  const steps = [30, 60, 120, 180, 240, 360, 720, 1440].map((m) => m * 60_000);
  const step = steps.find((s) => (to - from) / s <= 7) ?? steps[steps.length - 1];
  const d = new Date(from);
  if (step >= 1440 * 60_000) d.setHours(24, 0, 0, 0);
  else { d.setMinutes(0, 0, 0); if (d.getTime() < from) d.setTime(d.getTime() + 3_600_000); }
  const out: { t: number; label: string }[] = [];
  for (let t = d.getTime(); t <= to - (to - from) * 0.05; t += step) {
    const x = new Date(t);
    if (step < 1440 * 60_000 && step >= 60 * 60_000 && (x.getHours() * 60) % (step / 60_000) !== 0) continue;
    out.push({ t, label: step >= 1440 * 60_000 ? x.toLocaleDateString('en', { weekday: 'short' }) : x.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false }) });
  }
  return out;
}

const DOT: Record<string, string> = { ok: 'ok', slow: 'warn', unhealthy: 'warn', down: 'fail', unknown: 'off' };
const STATUS_WORD: Record<string, string> = { up: 'Up', down: 'Down', degraded: 'Unhealthy', recovering: 'Recovering', paused: 'Paused', pending: 'Waiting', unknown: 'No verdict' };
const STATUS_DOT: Record<string, string> = { up: 'ok', down: 'fail', degraded: 'warn', recovering: 'warn', paused: 'off', pending: 'off', unknown: 'off' };

export default function UptimePage() {
  const [range, setRange] = useState<Range>('24h');
  const doc = useSharedQuery<RibbonsDoc>(`/api/monitoring/ribbons?range=${range}`, 30_000);
  const engine = useSharedQuery<MonitoringEngineHealth>('/api/monitoring/engine', 30_000);
  const data = doc.data && doc.data.range === range ? doc.data : null;
  const rows = useMemo(() => sortRows(data?.monitors ?? []), [data]);
  const win = useMemo(() => (data ? visibleWindow(data) : null), [data]);

  // the scrub is one moment in time shared by every row
  const [scrub, setScrub] = useState<{ t: number; row: string; x: number; y: number } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const step = data?.stepMs ?? 300_000;

  const clear = useCallback(() => setScrub(null), []);
  const at = useCallback((e: React.PointerEvent<HTMLElement>, row: string) => {
    if (!win) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setScrub({ t: win.from + f * (win.to - win.from), row, x: e.clientX, y: r.top });
  }, [win]);
  const key = useCallback((e: React.KeyboardEvent<HTMLElement>, row: string) => {
    if (!win || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') { setScrub(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const cur = scrub?.t ?? win.to - step / 2;
    const t = e.key === 'Home' ? win.from + step / 2 : e.key === 'End' ? win.to - step / 2
      : Math.min(win.to - 1, Math.max(win.from, cur + (e.key === 'ArrowLeft' ? -1 : 1) * step * (e.shiftKey ? 12 : 1)));
    const f = (t - win.from) / (win.to - win.from);
    setScrub({ t, row, x: r.left + f * r.width, y: r.top });
  }, [win, scrub, step]);
  useEffect(() => { clear(); }, [range, clear]);

  const incidents = data?.incidents ?? [];
  const ticks = useMemo(() => (win ? axisTicks(win.from, win.to) : []), [win]);
  const intervals = [...new Set(rows.map((r) => r.intervalMs))].sort((a, b) => a - b);
  const every = !intervals.length ? '' : intervals.length === 1 ? `checked every ${durText(intervals[0])}` : `checked every ${durText(intervals[0])} to ${durText(intervals[intervals.length - 1])}`;
  const engineDown = engine.data && (engine.data.state === 'stopped' || engine.data.state === 'unavailable');
  const frac = (t: number) => (win ? ((t - win.from) / (win.to - win.from)) * 100 : 0);

  // what a row's right-hand column says: the scrubbed moment, or now
  const readout = (m: RibbonMonitor) => {
    if (scrub) {
      const s = segmentAt(m.segments, scrub.t);
      if (!s) return { dot: 'off', main: '—', sub: 'no data', at: true };
      const look = lookOf(s);
      return { dot: DOT[look], main: s.ms != null ? `${s.ms}` : '—', unit: s.ms != null ? 'ms' : '', sub: LOOK_WORD[look], at: true };
    }
    const dot = STATUS_DOT[m.status] ?? 'off';
    return { dot, main: m.latencyMs != null && m.status !== 'down' ? `${m.latencyMs}` : '—', unit: m.latencyMs != null && m.status !== 'down' ? 'ms' : '', sub: `${STATUS_WORD[m.status] ?? m.status} now`, at: false };
  };
  const tip = scrub && data ? rows.find((r) => r.id === scrub.row) : null;
  const tipSeg = tip ? segmentAt(tip.segments, scrub!.t) : null;
  const sum = data?.summary;
  const bubble = scrub && win ? { left: frac(scrub.t), text: whenText(scrub.t, range) } : null;

  return (
    <>
      <section className="ur-head rise" style={{ ['--i' as never]: 0 }}>
        <div className="plate">
          <h1 className="on-bg">Uptime</h1>
          <p className="on-bg">{rows.length ? `${rows.length} monitor${rows.length === 1 ? '' : 's'}${every ? ` · ${every}` : ''}` : 'Nothing is being watched yet'}</p>
        </div>
        <div className="ur-ctl">
          <div className="seg-sm" role="group" aria-label="Time range">
            <button type="button" aria-pressed={range === '24h'} onClick={() => setRange('24h')}>24 hours</button>
            <button type="button" aria-pressed={range === '7d'} onClick={() => setRange('7d')}>7 days</button>
          </div>
          <UptimeActions onChanged={() => { void doc.refresh(); }} />
        </div>
      </section>

      {engineDown && <p className="ur-note glass" role="status">Monitoring is not running ({engine.data!.reason || engine.data!.state}). What is shown was recorded before it stopped.</p>}
      {doc.error && !data && <p className="ur-note glass" role="alert">The uptime history could not be read ({doc.error}).</p>}

      <section className="ur-sum glass rise" style={{ ['--i' as never]: 1 }} aria-label="Summary">
        <div><span className="micro-label">Uptime · {range === '24h' ? '24 h' : '7 days'}</span><b>{sum?.uptimePct != null ? <>{pctText(sum.uptimePct)}<small>%</small></> : '—'}</b><span className="hm-meta">{sum?.uptimePct != null ? 'across all monitors' : 'no judged checks yet'}</span></div>
        <div><span className="micro-label">Up right now</span><b>{sum ? sum.up : '—'}<small> / {sum ? sum.monitors : '—'}</small></b><span className="hm-meta">{sum ? `${sum.slow} slow or unhealthy · ${sum.down} down` : ''}</span></div>
        <div><span className="micro-label">Incidents</span><b>{sum ? sum.incidents : '—'}</b><span className="hm-meta">{sum && sum.incidents ? `${durText(sum.downtimeMs)} of downtime in total` : 'none in this range'}</span></div>
        <div><span className="micro-label">Response time</span><b>{sum?.avgMs != null ? <>{sum.avgMs}<small> ms</small></> : '—'}</b><span className="hm-meta">{sum?.avgMs != null ? 'average, all monitors' : 'nothing measured yet'}</span></div>
      </section>

      <section className="ur-wrap glass rise" style={{ ['--i' as never]: 2 }} aria-label="Pulse ribbons">
        {data && !rows.length && (
          <div className="ur-empty">
            <b>Nothing is being watched yet.</b>
            <span>Add a monitor and its ribbon appears here as soon as it has been checked. OpusHub only checks what it has been told about.</span>
          </div>
        )}
        {!data && !doc.error && <div className="ur-empty"><span>Reading the history…</span></div>}
        {data && win && rows.length > 0 && (
          <div className="ur-board" ref={boardRef}>
            {rows.map((m, ri) => {
              const r = readout(m);
              const own = incidents.filter((i) => i.monitorId === m.id);
              return (
                <div key={m.id} className={`ur-row${scrub?.row === m.id ? ' hot' : ''}`}>
                  <div className="ur-c1">
                    <Link to={`/monitoring/${m.id}`} className="ur-nm"><b>{m.name}</b><small>{m.uptimePct != null ? `${pctText(m.uptimePct)}%` : 'no checks yet'}{m.p95Ms != null ? ` · p95 ${m.p95Ms} ms` : ''}</small></Link>
                  </div>
                  <div className="ur-c2">
                    <div
                      className="ur-rb" tabIndex={0} role="img" aria-label={`${ribbonSummary(m, range, incidents)} Use the left and right arrow keys to read values over time.`}
                      style={{ ['--i' as never]: ri }}
                      onPointerMove={(e) => at(e, m.id)} onPointerLeave={clear} onBlur={clear} onKeyDown={(e) => key(e, m.id)}
                    >
                      {m.segments.length === 0 && <span className="ur-none">{m.status === 'pending' ? 'waiting for the first check' : 'no checks recorded yet'}</span>}
                      {m.coverageFrom != null && frac(m.coverageFrom) > 35 && <span className="ur-none ur-since" style={{ width: `${frac(m.coverageFrom)}%` }}>recording for {durText(Date.now() - m.coverageFrom)}</span>}
                      <RibbonShape segments={m.segments} from={win.from} to={win.to} stepMs={data.stepMs} height={46} glow />
                      <RibbonShape segments={m.segments} from={win.from} to={win.to} stepMs={data.stepMs} height={46} />
                      <Notches incidents={own} from={win.from} to={win.to} label={(i: RibbonIncident) => `${m.name}: incident ${i.open ? 'ongoing, since' : 'of ' + durText(i.durationMs) + ', from'} ${whenText(i.startedAt, range)}${i.reason ? `: ${i.reason}` : ''}`} />
                    </div>
                  </div>
                  <div className="ur-c3">
                    <span className="ur-now"><i className={`hdot ${r.dot}`} />{r.main}{r.unit && <small> {r.unit}</small>}</span>
                    <span className="hm-meta">{r.sub}</span>
                  </div>
                </div>
              );
            })}
            <div className="ur-ov" aria-hidden="true">
              {ticks.map((k) => <i key={k.t} className="ur-tk" style={{ left: `${frac(k.t)}%` }} />)}
              {scrub && <i className="ur-guide on" style={{ left: `${frac(scrub.t)}%` }} />}
            </div>
            <div className="ur-axisrow" aria-hidden="true">
              <div className="ur-axis">
                {ticks.map((k) => <span key={k.t} style={{ left: `${frac(k.t)}%` }}>{k.label}</span>)}
                <span className="edge-r" style={{ left: '100%' }}>now</span>
                {bubble && <span className="bub on" style={{ left: `${bubble.left}%` }}>{bubble.text}</span>}
              </div>
            </div>
          </div>
        )}
        {data && rows.length > 0 && (
          <div className="ur-legend">
            <span className="k"><i className="sw" style={{ background: 'var(--ok)' }} />Up</span>
            <span className="k"><i className="sw" style={{ background: 'var(--warn)' }} />Slow or unhealthy</span>
            <span className="k"><i className="sw" style={{ background: 'var(--fail)' }} />Down</span>
            <span className="k"><i className="thin" /><i className="thick" />Thicker = slower answer</span>
            <span className="k"><i className="tri" />Incident began</span>
            <span className="k"><i className="gap" />No verdict</span>
            <span className="k hm-meta">Hover or use ← → to scrub</span>
          </div>
        )}
        {win?.trimmed && (
          <p className="ur-trim">Showing from the first recorded check{win.since ? ` (${durText(Date.now() - win.since)} ago)` : ''}. The {range === '24h' ? '24-hour' : '7-day'} view fills in as history builds.</p>
        )}
        <p className="sr-only" role="status" aria-live="polite">{scrub && tip ? `${tip.name}, ${whenText(scrub.t, range)}: ${tipSeg ? `${LOOK_WORD[lookOf(tipSeg)]}${tipSeg.ms != null ? `, ${tipSeg.ms} milliseconds` : ''}` : 'no data'}` : ''}</p>
      </section>

      {scrub && tip && (
        <div className="ur-tip on" style={{ left: Math.max(8, Math.min((typeof window === 'undefined' ? 1000 : window.innerWidth) - 230, scrub.x - 110)), top: Math.max(8, scrub.y - 62) }} role="presentation">
          <b>{tip.name} · {tipSeg ? LOOK_WORD[lookOf(tipSeg)] : 'No data'}</b>
          <em>{whenText(scrub.t, range)}{tipSeg ? (tipSeg.ms != null ? ` · ${tipSeg.ms} ms` : ' · no response') : ' · nothing recorded'}</em>
        </div>
      )}

      <section className="ur-inc rise" style={{ ['--i' as never]: 3 }} aria-labelledby="ur-inc-h">
        <h2 id="ur-inc-h" className="plate on-bg">Incidents</h2>
        <div className="ur-il glass">
          {incidents.slice(0, 12).map((i) => (
            <Link key={i.id} to={`/monitoring/${i.monitorId}`} className="ur-ir">
              <i className={`hdot ${i.open ? 'warn' : 'fail'}`} />
              <div><b>{i.monitorName} <span>· incident</span></b><small>{i.reason || 'no reason recorded'} · started {whenText(i.startedAt, range)}</small></div>
              <div className={`ur-len${i.open ? ' ongoing' : ''}`}>{durText(i.durationMs)}<small>{i.open ? 'ongoing' : `resolved ${i.recoveredAt ? relTime(i.recoveredAt) : ''}`}</small></div>
            </Link>
          ))}
          {data && !incidents.length && (
            <div className="ur-ir"><i className="hdot ok" /><div><b>No incidents</b><small>{rows.length ? 'Nothing went wrong in this range.' : 'Nothing is being watched yet.'}</small></div></div>
          )}
          {incidents.length > 12 && <p className="hm-meta" style={{ padding: '10px 0' }}>{incidents.length - 12} older incident{incidents.length - 12 === 1 ? '' : 's'} in this range are on each monitor's page.</p>}
        </div>
        <p className="hm-meta ur-manage"><Link to="/monitoring/manage">Manage monitors: pause, maintenance, suggestions →</Link></p>
      </section>
    </>
  );
}
