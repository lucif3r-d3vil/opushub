// Monitoring — the first-class page for what OpusHub watches.
//
// The page answers, in this order: is monitoring working (engine), how much of it is well (counts),
// and which monitors are not (the list, grouped the way services are grouped). It is a list of
// things being watched, not a wall of cards: the counts are a strip, the monitors are rows, and a
// row opens the monitor.
//
// Deliberately absent: any way to watch something that is not a stored monitor. There is no URL
// box on this page, no "check this for me", and no polling of targets from the browser — every
// check happens on the server, on the schedule the monitor owns.
import { useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { invalidateShared, usePolled } from '../lib/api';
import { relTime } from '../lib/format';
import type { Monitor, MonitorIncident, MonitoringIncidentsDoc, MonitoringOverview, MonitorState } from '../lib/types';
import { Freshness, PageHero, ProviderNote } from '../components/ui';
import {
  AddMonitorDialog, EngineLine, IncidentList, LatencyValue, StateBadge, SuggestionsPanel, TargetLine, TypeChip, UptimeValue, useServices,
} from '../components/monitoring/parts';

const COUNT_ORDER = ['total', 'up', 'degraded', 'down', 'paused'] as const;
const COUNT_WORDS: Record<string, string> = { total: 'Total', up: 'Up', degraded: 'Degraded', down: 'Down', paused: 'Paused' };
const COUNT_TONES: Record<string, string> = { total: 'idle', up: 'ok', degraded: 'warn', down: 'bad', paused: 'quiet' };

const FILTERS: { value: 'all' | MonitorState; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'up', label: 'Up' },
  { value: 'degraded', label: 'Degraded' },
  { value: 'down', label: 'Down' },
  { value: 'recovering', label: 'Recovering' },
  { value: 'pending', label: 'Not checked yet' },
  { value: 'paused', label: 'Paused' },
];

export default function MonitoringPage() {
  const location = useLocation();
  const view = location.pathname.endsWith('/incidents') ? 'incidents' : 'monitors';
  const { data, error, loading, fetchedAt, refresh } = usePolled<MonitoringOverview>('/api/monitoring', 15_000);
  const [filter, setFilter] = useState<'all' | MonitorState>('all');
  // Deep link from a service page: /monitoring?service=Media/jellyfin&add=1 opens the Add dialog
  // with that service already chosen — which is the whole point of preferring a canonical endpoint
  // over a typed URL.
  const [params] = useSearchParams();
  const preselected = params.get('service');
  const [adding, setAdding] = useState(() => params.get('add') === '1');
  const { services, dockerAvailable } = useServices();

  const monitors = data?.monitors ?? [];
  const counts = data?.counts;
  const health = data?.engine ?? null;
  const engineDown = !!health && (health.state === 'stopped' || health.state === 'unavailable');

  const shown = useMemo(
    () => (filter === 'all' ? monitors : monitors.filter((m) => (m.enabled ? m.status : 'paused') === filter)),
    [monitors, filter],
  );

  /** Grouped the way services are grouped, because the monitor's service is the group's member. */
  const groups = useMemo(() => {
    const map = new Map<string, Monitor[]>();
    for (const m of shown) {
      const group = m.target?.service?.group || (m.type === 'docker' ? 'Containers' : 'Endpoints');
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(m);
    }
    return [...map.entries()].sort((a, b) => (a[0] === 'Endpoints' ? 1 : b[0] === 'Endpoints' ? -1 : a[0].localeCompare(b[0])));
  }, [shown]);

  const reload = () => { invalidateShared('/api/monitoring'); refresh(); };

  return (
    <>
      <PageHero
        title="Monitoring"
        desc="What OpusHub watches, what it found, and when. Checks run on the server on each monitor's own interval; this page only ever reads what was recorded."
        meta={data ? <EngineLine health={health} at={data.at} /> : undefined}
        actions={(
          <>
            <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)} disabled={!dockerAvailable}>Add monitor</button>
            <Freshness at={fetchedAt} />
          </>
        )}
      />

      {engineDown && (
        <ProviderNote
          status="unavailable"
          reason={`Monitoring is not running right now (${health?.reason || health?.state}). Everything below is the last recorded state — history stays readable, and nothing here is presented as current.`}
        />
      )}
      {error && !data && <ProviderNote status="error" reason={error} fixHref="/settings/monitoring" fixLabel="Monitoring settings →" />}
      {loading && !data && <p className="stale-note">Reading the monitors…</p>}

      {data && (
        <>
          <div className="mon-counts" role="list" aria-label="Monitor totals">
            {COUNT_ORDER.map((key) => (
              <button
                key={key}
                role="listitem"
                className={`mon-count mon-${COUNT_TONES[key]}${(key === 'total' && filter === 'all') || filter === key ? ' active' : ''}`}
                onClick={() => setFilter(key === 'total' ? 'all' : (key as MonitorState))}
                title={key === 'total' ? 'Every configured monitor' : `Show only monitors that are ${COUNT_WORDS[key].toLowerCase()}`}
              >
                <span className="mon-count-value mono">{counts?.[key] ?? 0}</span>
                <span className="mon-count-label">{COUNT_WORDS[key]}</span>
              </button>
            ))}
            <span className="mon-count-extra stale-note">
              {counts?.maintenance ? `${counts.maintenance} in maintenance · ` : ''}
              {counts?.stale ? `${counts.stale} stale · ` : ''}
              {counts?.pending ? `${counts.pending} never checked` : ''}
            </span>
          </div>

          <nav className="mon-views" aria-label="Monitoring views">
            <Link className={view === 'monitors' ? 'chip active' : 'chip'} to="/monitoring">Monitors</Link>
            <Link className={view === 'incidents' ? 'chip active' : 'chip'} to="/monitoring/incidents">Incidents</Link>
            <Link className="chip" to="/settings/monitoring">Defaults &amp; bounds</Link>
          </nav>

          {view === 'incidents' ? <IncidentsView /> : (
            <>
              <SuggestionsPanel onCreated={reload} />
              {!monitors.length && (
                <div className="unavailable" style={{ padding: 'var(--sp-12)' }}>
                  <span className="why" style={{ fontSize: 14 }}>
                    Nothing is being watched yet. Add a monitor above, or accept one of the suggestions —
                    OpusHub only ever checks things it has been told about.
                  </span>
                </div>
              )}
              {monitors.length > 0 && (
                <div className="mon-filters" role="tablist" aria-label="Filter monitors">
                  {FILTERS.map((f) => (
                    <button key={f.value} role="tab" aria-selected={filter === f.value} className={filter === f.value ? 'chip active' : 'chip'} onClick={() => setFilter(f.value)}>
                      {f.label}
                    </button>
                  ))}
                  <span className="stale-note">{shown.length} of {monitors.length}</span>
                </div>
              )}
              {groups.map(([group, list]) => (
                <section className="mon-group" key={group} aria-label={`${group} monitors`}>
                  <div className="section-head">
                    <h2 className="section-title">{group}</h2>
                    <span className="section-aside stale-note">{list.length} monitor{list.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="mon-list">
                    {list.map((m) => <MonitorRow key={m.id} monitor={m} />)}
                  </div>
                </section>
              ))}
              {monitors.length > 0 && !shown.length && (
                <p className="stale-note">No monitor is {filter === 'pending' ? 'unchecked' : filter}. The filter only narrows the list — nothing was hidden from the engine.</p>
              )}
            </>
          )}
        </>
      )}

      <AddMonitorDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={() => reload()}
        services={services}
        allowInternal
        preselect={preselected}
      />
    </>
  );
}

/** One monitor, as a row: state, what it watches, where it is, today's uptime, last check. */
function MonitorRow({ monitor }: { monitor: Monitor }) {
  const state: MonitorState = monitor.enabled ? monitor.status : 'paused';
  const uptime = monitor.uptime ?? null;
  return (
    <div className="mon-row">
      <Link className="mon-row-main" to={`/monitoring/${monitor.id}`}>
        <span className="mon-row-name">
          {monitor.name}
          {monitor.provenance === 'discovered' && <span className="chip" title="Created from a discovered service endpoint">discovered</span>}
          {(monitor.target.scope === 'internal' || monitor.target.scope === 'mixed') && (
            <span className="chip mon-scope" title="This monitor reaches an address on your own network — recorded when it last ran.">
              {monitor.target.scope === 'mixed' ? 'internal + public' : 'internal'}
            </span>
          )}
        </span>
        <TypeChip monitor={monitor} />
        <TargetLine monitor={monitor} />
        <UptimeValue window={uptime} label="last 24h" />
        <LatencyValue ms={monitor.latencyMs} at={monitor.lastCheck?.at} />
        <span className="mon-row-when stale-note" title={monitor.lastCheck ? new Date(monitor.lastCheck.at).toLocaleString() : 'never checked'}>
          {monitor.lastCheck ? `checked ${relTime(monitor.lastCheck.at)}` : 'never checked'}
        </span>
        <StateBadge state={state} stale={monitor.stale} />
      </Link>
      <span className="mon-row-stale-note stale-note">{monitor.stale ? 'stale' : ''}</span>
    </div>
  );
}

/** Every incident the engine has recorded, newest first — a read of monitor history, not a feed. */
function IncidentsView() {
  const { data, error } = usePolled<MonitoringIncidentsDoc>('/api/monitoring/incidents?limit=100', 30_000);
  const [onlyOpen, setOnlyOpen] = useState(false);
  if (error && !data) return <ProviderNote status="error" reason={error} />;
  if (!data) return <p className="stale-note">Reading incidents…</p>;
  const incidents: MonitorIncident[] = onlyOpen ? data.incidents.filter((i) => i.status !== 'resolved') : data.incidents;
  return (
    <>
      <div className="mon-filters">
        <button className={onlyOpen ? 'chip' : 'chip active'} onClick={() => setOnlyOpen(false)}>All {data.incidents.length}</button>
        <button className={onlyOpen ? 'chip active' : 'chip'} onClick={() => setOnlyOpen(true)}>Open {data.open}</button>
      </div>
      {incidents.length === 0
        ? <p className="stale-note">No incidents recorded. An incident is opened after sustained failures — a single bad check never creates one.</p>
        : (
          <div className="mon-incident-list">
            {incidents.map((i) => (
              <div className="mon-incident-card" key={i.id}>
                <div className="mon-incident-head">
                  <Link className="mon-incident-name" to={`/monitoring/${i.monitorId}`}>{i.monitorName}</Link>
                  <span className={`mon-state mon-${i.status === 'resolved' ? 'ok' : i.status === 'recovering' ? 'warn' : 'bad'}`}>
                    <span className="mon-dot" aria-hidden="true" />{i.status === 'resolved' ? 'recovered' : i.status}
                  </span>
                  <span className="stale-note">{i.type.toUpperCase()}</span>
                </div>
                <IncidentList incidents={[i]} />
              </div>
            ))}
          </div>
        )}
    </>
  );
}
