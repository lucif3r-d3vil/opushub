import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePolled } from '../lib/api';
import { bytes, num, pct, relTime, timeOfDay, uptime } from '../lib/format';
import { useSettings } from '../lib/theme';
import type { ActivityEvent } from '../lib/types';
import { Icon } from '../components/Icon';
import { AreaChart, MeterBar } from '../components/Charts';
import { PageHero, ProviderNote, SectionHead, StatusLine } from '../components/ui';
import { DockerOffNote, LogsDrawer } from '../lib/dockerStatus';
import { humanEvent } from '../lib/events';

interface StackRollup {
  containers: number; running: number; stopped: number; unhealthy: number; reporting: number;
  cpu: number | null; memory: number | null; memoryLimit: number | null;
  netRx: number | null; netTx: number | null; upSince: number | null;
}

interface StackHistoryDoc {
  stack: string; reporting: number; containers: number; watchingSince: number | null; bucketMs: number;
  samples: { t: number; cpu: number | null; mem: number | null; memLimit: number | null; netRx: number | null; netTx: number | null; count: number }[];
}

interface StackDetailDoc {
  id: string; project: string | null; name: string; displayName: string; description: string | null; icon: string | null; notes: string | null; compose: string | null;
  status: string; statusReason: string | null; live: boolean; source: 'configured' | 'discovered'; configured: boolean;
  containerCount: number; runningCount: number; rollup?: StackRollup;
  unhealthyCount?: number; stoppedCount?: number; attentionCount?: number;
  members: {
    service: string; containerName: string; icon: string | null; group: string | null; url: string | null; urlSource: string; kind: string; route: string | null; configured: boolean;
    container: { name: string; id: string; state: string; status: string; health: string | null; image: string } | null;
    stats?: { cpu: number | null; memory: { used: number | null; limit: number | null }; net: { rx: number; tx: number }; blockIo?: number | null } | null;
    ports?: { private: string; host: string; hostPort: string }[];
    networks?: { name: string; ip: string }[];
    mounts?: { type: string; source: string; target: string; rw: boolean }[];
    startedAt?: string | null; health?: string | null; restartPolicy?: string | null; restartCount?: number;
    error?: boolean;
  }[];
}

const stateWord = (m: StackDetailDoc['members'][number]) => {
  if (!m.container) return 'unlinked';
  // the list API carries no health; the detail route enriches it from inspect — prefer that
  const health = m.health ?? m.container.health;
  if (m.container.state === 'running') return health === 'unhealthy' ? 'unhealthy' : 'up';
  if (m.container.state === 'exited') return 'down';
  return m.container.state;
};

/**
 * The stack's resources over the session, measured.
 *
 * Three readings, one chart, one focal point. The series are aggregated server-side from the same
 * per-container buffers the member rows read (no extra Docker calls at all), and the note under
 * the chart says how many containers actually answered — an aggregate over 2 of 5 containers is
 * still useful, but it is never presented as the whole project.
 */
function StackHistory({ stackId, members }: { stackId: string; members: number }) {
  const [reading, setReading] = useState<'cpu' | 'memory' | 'network'>('cpu');
  const { data } = usePolled<StackHistoryDoc>(`/api/stacks/${encodeURIComponent(stackId)}/history?window=1800000`, 5000);

  const samples = (data?.samples || []).filter((s) => s.cpu != null || s.mem != null);
  // every hook runs before the first return: the chart appears and disappears as samples arrive,
  // and a conditional hook would break the component the moment it did
  const rateSeries = useMemo(() => {
    const out: { t: number; v: number | null }[] = [];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      const dt = (b.t - a.t) / 1000;
      if (dt <= 0 || a.netRx == null || b.netRx == null) { out.push({ t: b.t, v: null }); continue; }
      if (b.netRx < a.netRx) { out.push({ t: b.t, v: null }); continue; } // counter reset: skip, never guess
      out.push({ t: b.t, v: (b.netRx - a.netRx) / dt });
    }
    return out;
  }, [samples]);

  if (!data || samples.length < 2) {
    return (
      <p className="stale-note" role="status" style={{ marginBottom: 'var(--sp-5)' }}>
        {data ? 'Collecting samples — a stack chart appears once its containers have been read more than once.' : 'Reading the stack’s recent samples…'}
      </p>
    );
  }

  const cpuSeries = samples.map((s) => ({ t: s.t, v: s.cpu }));
  const memSeries = samples.map((s) => ({ t: s.t, v: s.mem }));
  const series = reading === 'cpu'
    ? [{ points: cpuSeries, label: 'CPU', color: 'var(--accent)', fill: false }]
    : reading === 'memory'
      ? [{ points: memSeries, label: 'Memory', color: 'var(--accent)', fill: false }]
      : [{ points: rateSeries, label: 'Network in', color: 'var(--ok)', fill: false }];
  const fmt = reading === 'network' ? (v: number) => `${bytes(v, true)}/s` : reading === 'memory' ? (v: number) => bytes(v) : (v: number) => `${v.toFixed(0)}%`;
  const first = samples[0].t, last = samples[samples.length - 1].t;
  const windowMs = Math.min(30 * 60_000, Math.max(2 * 60_000, last - first));
  const avgCount = Math.round(samples.reduce((a, s) => a + s.count, 0) / samples.length);

  return (
    <div className="res-history">
      <div className="res-history-head">
        <span className="micro-label">Since you opened this page</span>
        <span className="seg" role="group" aria-label="Stack reading">
          {(['cpu', 'memory', 'network'] as const).map((k) => (
            <button key={k} className="seg-btn" aria-pressed={reading === k} onClick={() => setReading(k)}>
              {k === 'cpu' ? 'CPU' : k === 'memory' ? 'Memory' : 'Network'}
            </button>
          ))}
        </span>
      </div>
      <AreaChart height={118} windowMs={windowMs} fmt={fmt} series={series} maxHint={reading === 'cpu' ? 100 : undefined} />
      <p className="stale-note">
        {samples.length} aggregated sample{samples.length === 1 ? '' : 's'} summing {avgCount} container{avgCount === 1 ? '' : 's'} per point
        {data.containers > members ? '' : ` of ${members}`} — members nobody has looked at contribute nothing, and aggregates are
        collected only while this page is open.
      </p>
    </div>
  );
}

export default function StackDetailPage() {
  const { name = '' } = useParams();
  const { settings } = useSettings();
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const { data, error, loading, fetchedAt, refresh } = usePolled<StackDetailDoc>(
    `/api/stacks/${encodeURIComponent(name)}`,
    (settings?.behavior?.refresh?.services ?? 30) * 1000,
  );
  const activity = usePolled<{ items: ActivityEvent[] }>('/api/activity?limit=80', 60_000);

  if (loading && !data) return <div className="stale-note" style={{ padding: 'var(--sp-12) 0' }}>Loading stack…</div>;
  if (error && !data) return <ProviderNote status="error" reason={error} fixHref="/stacks" fixLabel="All stacks →" />;
  if (!data) return <ProviderNote status="error" reason="Stack not found." fixHref="/stacks" fixLabel="All stacks →" />;

  const memberNames = new Set([
    ...data.members.map((m) => m.service),
    ...data.members.map((m) => m.container?.name || ''),
    ...data.members.map((m) => m.containerName),
    data.project || '',
  ]);
  const related = (activity.data?.items || []).filter((e) => e.subject && memberNames.has(e.subject));
  // the server computes the rollup from the same enriched members, excluding containers that
  // answered nothing; fixtures and older payloads fall back to the same arithmetic here
  const totals = data.rollup
    ? { cpu: data.rollup.cpu ?? 0, mem: data.rollup.memory ?? 0, hasAny: data.rollup.reporting > 0 }
    : data.members.reduce(
      (a, m) => ({
        cpu: m.stats?.cpu != null ? a.cpu + m.stats.cpu : a.cpu,
        mem: m.stats?.memory.used != null ? a.mem + m.stats.memory.used : a.mem,
        hasAny: a.hasAny || !!m.stats,
      }),
      { cpu: 0, mem: 0, hasAny: false },
    );
  const roll = data.rollup ?? null;

  return (
    <>
      <div className="detail-hero">
        <Icon ref={data.icon} name={data.name} size={68} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Link to="/stacks" className="section-link" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 11, fontWeight: 650 }}>Stack</Link>
          <h1 className="detail-title">{data.name}</h1>
          {data.description && <p className="detail-sub">{data.description}</p>}
          <div className="detail-meta">
            <StatusLine state={data.status} note={data.statusReason} />
            <span className="stale-note">{data.members.length} member{data.members.length === 1 ? '' : 's'}</span>
            {totals.hasAny && <span className="mono-meta">{pct(totals.cpu, 0)} cpu · {bytes(totals.mem)} mem</span>}
            {roll?.upSince != null && <span className="stale-note">up {uptime((Date.now() - roll.upSince) / 1000)}</span>}
            <button className="btn btn-quiet btn-sm" onClick={refresh}>Refresh</button>
            {fetchedAt && <span className="stale-note">{relTime(fetchedAt)}</span>}
          </div>
          {/* compact rollup — the page stays readable; deep detail lives on the service pages */}
          <div className="stack-rollup" role="group" aria-label="Stack health summary">
            <span className="roll-cell"><b>{data.containerCount}</b> containers</span>
            <span className="roll-cell roll-run"><b>{data.runningCount}</b> running</span>
            {!!data.unhealthyCount && <span className="roll-cell roll-bad"><b>{data.unhealthyCount}</b> unhealthy</span>}
            {!!data.stoppedCount && <span className="roll-cell roll-stop"><b>{data.stoppedCount}</b> stopped</span>}
            {!!data.attentionCount && <span className="roll-cell roll-warn"><b>{data.attentionCount}</b> attention</span>}
            {totals.hasAny && <span className="roll-cell"><b>{pct(totals.cpu, 1)}</b> cpu · <b>{bytes(totals.mem)}</b> mem{roll && roll.reporting < roll.running ? <span className="stale-note"> · {roll.reporting}/{roll.running} reporting</span> : null}</span>}
            {roll?.netRx != null && <span className="roll-cell">net <b>{bytes(roll.netRx)}</b> ↓ · <b>{bytes(roll.netTx ?? 0)}</b> ↑ <span className="stale-note">lifetime</span></span>}
          </div>
        </div>
        <div className="detail-actions">
          {data.members.filter((m) => m.url).map((m) => (
            <a key={m.containerName} className="btn" href={m.url!} target="_blank" rel="noreferrer" title={`${m.url} · ${m.urlSource}`}>Open {m.service}</a>
          ))}
          {data.live && (
            <button className="btn" onClick={() => setLogsFor(data.members.find((m) => m.container)?.container?.name || '')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 5h14M5 10h14M5 15h9" strokeLinecap="round" /></svg>
              Logs
            </button>
          )}
        </div>
      </div>

      {data.notes && (
        <p style={{ maxWidth: 640, color: 'var(--ink-2)', fontStyle: 'italic', fontFamily: 'var(--font-display)', fontSize: 16, lineHeight: 1.5, margin: '0 0 var(--sp-8)' }}>
          “{data.notes}”
        </p>
      )}

      {data.source === 'discovered' && (
        <p className="stale-note" style={{ margin: '-8px 0 var(--sp-8)' }}>
          Live because the engine reports these containers — nothing here invents it. Add a
          {' '}<span className="mono-meta">project: {data.project || data.id}</span> entry to stacks.yaml to rename, describe and icon it.
        </p>
      )}

      {!data.live && (
        <div style={{ marginBottom: 'var(--section-gap)' }}>
          <DockerOffNote reason={data.statusReason} extra={<span className="stale-note">— showing the configuration view; container detail will appear once the engine is reachable.</span>} />
        </div>
      )}

      <section className="detail-block">
        <SectionHead title="Containers" right={<span className="mono-meta">{data.project ? `${data.members.length} container(s) in project ${data.project}` : 'grouped by overlay'}</span>} />
        <ul style={{ listStyle: 'none' }}>
          {data.members.map((m) => (
            <li key={m.containerName} style={{ borderTop: '1px solid var(--hair)' }}>
              <div className="member-row">
                <Icon ref={m.icon} name={m.service} size={22} plain />
                <div style={{ minWidth: 0 }}>
                  {m.group || m.containerName
                    ? <Link to={`/services/${encodeURIComponent(m.group || 'Other')}/${encodeURIComponent(m.containerName)}`} style={{ fontWeight: 590, display: 'inline-block' }}>{m.service}</Link>
                    : <div style={{ fontWeight: 590 }}>{m.service}</div>}
                  <div className="stale-note">
                    {m.container ? `${m.container.name} · ${m.container.id}` : 'no container linked'}
                    {m.kind === 'infrastructure' ? ' · infrastructure' : ''}
                  </div>
                </div>
                <div className="member-state image-col">{m.container?.image || '—'}</div>
                {m.url
                  ? <a className="mono-meta" href={m.url} target="_blank" rel="noreferrer" title={`url from ${m.urlSource}`} style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 210, whiteSpace: 'nowrap' }}>{m.url.replace(/^https?:\/\//, '')}</a>
                  : <span className="stale-note">no web endpoint</span>}
                <StatusLine state={stateWord(m)} note={m.container?.status} />
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end', minWidth: 140 }}>
                  {m.stats ? <span className="mono-meta">{pct(m.stats.cpu, 0)} cpu · {bytes(m.stats.memory.used)}</span> : <span className="stale-note" />}
                  {m.container && <button className="icon-btn accent-on-hover" title="Container logs" onClick={() => setLogsFor(m.container!.name)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 5h14M5 10h14M5 15h9" strokeLinecap="round" /></svg>
                  </button>}
                </div>
              </div>
              {!!(m.ports?.length || m.mounts?.length || m.networks?.length) && (
                <dl className="kv" style={{ padding: '2px 0 var(--sp-4) 42px', gridTemplateColumns: '110px minmax(0,1fr)' }}>
                  {!!m.ports?.length && <><dt>Ports</dt><dd>{m.ports!.map((p, i) => <div className="port-row" key={i}><span>{p.host === '0.0.0.0' ? 'all' : p.host}:{p.hostPort}</span><span className="port-arrow">→</span><span>{p.private}</span></div>)}</dd></>}
                  {!!m.networks?.length && <><dt>Networks</dt><dd>{m.networks!.map((n) => <div className="port-row" key={n.name}><span>{n.name}</span><span className="port-arrow">·</span><span className="mono-meta">{n.ip}</span></div>)}</dd></>}
                  {!!m.mounts?.length && <><dt>Volumes</dt><dd>{m.mounts!.map((vo, i) => <div className="port-row" key={i}><span className="mono-meta" style={{ wordBreak: 'break-all' }}>{vo.source}</span><span className="port-arrow">→</span><span className="mono-meta">{vo.target}{!vo.rw ? ' (ro)' : ''}</span></div>)}</dd></>}
                </dl>
              )}
            </li>
          ))}
        </ul>
      </section>

      <div className="detail-grid">
        <div>
          <section className="detail-block">
            <SectionHead title="Resources" right={data.live && totals.hasAny ? <span className="stale-note">from the engine, every {settings?.behavior?.refresh?.services ?? 30}s</span> : undefined} />
            {data.live && <StackHistory stackId={data.id} members={data.members.length} />}
            {data.members.some((m) => m.stats) ? (
              <div>
                {data.members.filter((m) => m.stats).map((m) => (
                  <div key={m.service} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr', gap: 'var(--sp-4)', alignItems: 'center', padding: '11px 0', borderTop: '1px solid var(--hair)' }}>
                    <span style={{ fontWeight: 560, fontSize: 13 }}>{m.service}</span>
                    <div>
                      <div className="stat-v" style={{ fontSize: 15, marginBottom: 5 }}>{pct(m.stats!.cpu, 1)}<small style={{ color: 'var(--ink-3)', fontWeight: 500 }}> cpu</small></div>
                      <MeterBar value={m.stats!.cpu} />
                    </div>
                    <div>
                      <div className="stat-v" style={{ fontSize: 15, marginBottom: 5 }}>
                        {m.stats!.memory.used != null ? bytes(m.stats!.memory.used) : '—'}
                        {m.stats!.memory.limit ? <small style={{ color: 'var(--ink-3)', fontWeight: 500 }}> of {bytes(m.stats!.memory.limit)}</small> : null}
                      </div>
                      <MeterBar value={m.stats!.memory.limit ? 100 * ((m.stats!.memory.used || 0) / m.stats!.memory.limit) : null} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <ProviderNote compact status={data.live ? 'unavailable' : 'unconfigured'} reason={data.live ? 'The engine here does not expose container stats.' : 'Connect Docker to see live resource use.'} fixHref={data.live ? undefined : '/settings/environment'} fixLabel="Configure Docker →" />
            )}
          </section>

          <section className="detail-block">
            <SectionHead title="Recent activity" right={<Link className="section-link" to="/activity">All →</Link>} />
            {related.length ? (
              <div className="hub-act">
                {related.slice(0, 10).map((e) => (
                  <div className="ha-row" key={e.id}>
                    <span className="ha-t">{relTime(e.t)}</span>
                    <span className="ha-msg"><b>{e.subject}</b> {humanEvent(e)}{e.message && e.type.includes('container') ? <span> · {e.message}</span> : null}</span>
                  </div>
                ))}
              </div>
            ) : <div className="stale-note">No events for this stack’s services yet.</div>}
          </section>
        </div>

        <div>
          <section className="detail-block">
            <SectionHead title="Configuration" right={<span className="stale-note">presentation</span>} />
            <dl className="kv">
              <div><dt>Existence</dt><dd className="mono-meta">Docker · {data.project ? `compose project “${data.project}”` : 'containers matched by the overlay'}</dd></div>
              <div><dt>Appearance</dt><dd className="mono-meta">{data.configured ? 'stacks.yaml overlay' : 'no overlay — defaults from discovery'}</dd></div>
              <div><dt>Members</dt><dd>{data.members.map((m) => m.service).join(', ') || '—'}</dd></div>
              <div><dt>Status source</dt><dd>{data.live ? 'Docker engine' : 'configuration only'}</dd></div>
              <div><dt>Checked</dt><dd className="mono-meta">{fetchedAt ? timeOfDay(fetchedAt) + ' · ' + num(data.members.filter((m) => m.container).length, 0) + ' linked' : '—'}</dd></div>
            </dl>
            <p className="stale-note" style={{ marginTop: 'var(--sp-3)' }}>
              A Compose project is infrastructure; a presentation group is a label. This page is the
              project the engine reports — its members are the containers that carry
              {' '}<span className="mono-meta">com.docker.compose.project={data.project || data.id}</span>.
              Renaming it in <span className="mono-meta">stacks.yaml</span> changes the heading, the
              icon and the description, never the containers or their project id. A service whose
              group was renamed in <span className="mono-meta">services.yaml</span> still belongs to
              this project.
            </p>
          </section>
        </div>
      </div>

      {logsFor && <LogsDrawer container={logsFor} onClose={() => setLogsFor(null)} />}
    </>
  );
}
