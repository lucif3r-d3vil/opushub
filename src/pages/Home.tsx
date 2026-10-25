// Home: a greeting, the host at a glance, what needs attention, and every service as a tile.
// Replaces the widget-composed Hub. Everything shown is read from data OpusHub already has; a
// section with nothing real to say is not drawn.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Attention, BookmarksCard, UpdatesCard, UptimeCard } from '../components/home/Sections';
import { HostExpander, HostStrip } from '../components/home/HostStrip';
import { RANGES, type HostRange } from '../components/home/HostChart';
import { Tile } from '../components/home/Tile';
import { useAuth } from '../lib/auth';
import { useSharedQuery } from '../lib/api';
import { relTime } from '../lib/format';
import {
  buildAttention, buildStacks, buildUpdates, downMonitors, greetingLead, uptimeSummary, type HostMetric,
} from '../lib/homeModel';
import type { BookmarkDoc } from '../lib/hubData';
import { useOperationsCapabilities } from '../lib/operations';
import { useSettings } from '../lib/theme';
import type {
  AutohealStatusDoc, ContainerUpdatesDoc, HistoryPoint, ServicesDoc, SystemSnapshot,
} from '../lib/types';
import type { RibbonsDoc } from '../lib/uptimeModel';

function useClock(hour12: boolean) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 15_000); return () => window.clearInterval(id); }, []);
  return {
    now,
    time: now.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12 }),
    date: now.toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long' }),
  };
}

export default function Home() {
  const { user } = useAuth();
  const { settings } = useSettings();
  const refresh = settings?.behavior?.refresh;
  const services = useSharedQuery<ServicesDoc>('/api/services', (refresh?.services ?? 30) * 1000);
  const system = useSharedQuery<SystemSnapshot>('/api/system', (refresh?.system ?? 5) * 1000);
  const spark = useSharedQuery<{ points: HistoryPoint[] }>('/api/system/history?window=3600000', 10_000);
  // the same document the Uptime page reads, so the card and the page can never disagree
  const ribbons = useSharedQuery<RibbonsDoc>('/api/monitoring/ribbons?range=24h', 30_000);
  const updates = useSharedQuery<ContainerUpdatesDoc>('/api/container-updates', 60_000);
  const heal = useSharedQuery<AutohealStatusDoc>('/api/autoheal/status', 30_000);
  const bookmarks = useSharedQuery<BookmarkDoc>('/api/bookmarks', 0);
  const caps = useOperationsCapabilities();
  const ops = useMemo(() => ({ available: caps.available, can: caps.can }), [caps.available, caps.permitted]); // eslint-disable-line react-hooks/exhaustive-deps

  // the expanded host chart: one metric, one range; the history is only fetched while it is open
  const [metric, setMetric] = useState<HostMetric | null>(null);
  const [range, setRange] = useState<HostRange>('1h');
  const rangeMs = RANGES.find((r) => r.id === range)!.ms;
  const longHistory = useSharedQuery<{ points: HistoryPoint[]; stepMs?: number }>(metric ? `/api/system/history?window=${rangeMs}` : null, range === '1h' ? 10_000 : 60_000);
  const toggle = useCallback((m: HostMetric) => setMetric((cur) => (cur === m ? null : m)), []);
  useEffect(() => {
    if (!metric) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMetric(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [metric]);

  const { now, time, date } = useClock(!settings?.hub?.clock24h);
  const name = user?.username || 'there';

  const records = updates.data?.updates ?? [];
  const stacks = useMemo(() => buildStacks(services.data, records), [services.data, records]);
  const attention = useMemo(() => buildAttention(services.data, heal.data, downMonitors(ribbons.data), (t) => relTime(t)), [services.data, heal.data, ribbons.data]);
  const upd = useMemo(() => buildUpdates(records, services.data), [records, services.data]);
  const uptime = useMemo(() => uptimeSummary(ribbons.data), [ribbons.data]);
  const all = stacks.flatMap((s) => s.tiles);
  const running = all.filter((t) => t.view.state === 'ok').length;
  const groups = bookmarks.data?.groups ?? [];

  const dockerDown = services.data != null && services.data.live === false;
  const noContainers = services.data != null && services.data.live && all.length === 0;
  let i = 3;

  return (
    <>
      <section className="hm-hero rise" style={{ ['--i' as never]: 0 }}>
        <div className="plate">
          <h1 className="on-bg">{greetingLead(now)}, <em>{name}</em>.</h1>
          <p className="hm-sub on-bg">
            {all.length > 0 && <span><i className="hdot ok" />{running} of {all.length} containers running</span>}
            {uptime && <span>{uptime.up} of {uptime.total} monitors up</span>}
            {attention.length > 0 && <span><i className="hdot warn" />{attention.length} need{attention.length === 1 ? 's' : ''} attention</span>}
            {upd.rows.length > 0 && <span className="hm-subacc">↑ {upd.rows.length} update{upd.rows.length === 1 ? '' : 's'} available</span>}
          </p>
        </div>
        <div className="hm-clock" aria-label="Local time"><b>{time}</b><span>{date}</span></div>
      </section>

      <HostStrip sys={system.data} spark={spark.data?.points ?? []} open={metric} onToggle={toggle} />
      <HostExpander
        metric={metric} range={range} onRange={setRange} onClose={() => setMetric(null)}
        points={longHistory.data?.points ?? null} stepMs={longHistory.data?.stepMs ?? null} loading={longHistory.loading} error={longHistory.error}
      />

      <Attention items={attention} healOn={heal.data?.available ? heal.data.optedInCount : null} ops={ops} />

      <div className="hm-cols">
        <div>
          {dockerDown && (
            <p className="hm-empty glass">Docker is not reachable, so there is nothing to launch yet. <Link to="/settings">Configure Docker →</Link></p>
          )}
          {noContainers && (
            <p className="hm-empty glass">Docker is connected, but no containers were found. <Link to="/stacks/new">Add a compose block →</Link></p>
          )}
          {!services.data && services.error && <p className="hm-empty glass">The services could not be read ({services.error}).</p>}
          {stacks.map((st) => (
            <section key={st.name} className="hm-stack rise" style={{ ['--i' as never]: i++, ['--h' as never]: st.hue }} aria-labelledby={`hm-st-${st.name}`}>
              <div className="hm-stack-h plate on-bg">
                <h2 id={`hm-st-${st.name}`}>{st.name}</h2>
                <span className="hm-meta">{st.tiles.length} container{st.tiles.length === 1 ? '' : 's'} · {st.attention ? `${st.attention} need${st.attention === 1 ? 's' : ''} attention` : 'all running'}</span>
                <span className="hm-line" />
              </div>
              <div className="hm-tiles">{st.tiles.map((t) => <Tile key={t.svc.name} tile={t} ops={ops} />)}</div>
            </section>
          ))}
        </div>
        <aside className="hm-rail">
          <UpdatesCard rows={upd.rows} checkedAt={upd.checkedAt} index={4} />
          <UptimeCard summary={uptime} doc={ribbons.data} index={5} />
          <BookmarksCard groups={groups} index={6} />
        </aside>
      </div>
    </>
  );
}
