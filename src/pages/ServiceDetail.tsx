import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, usePolled } from '../lib/api';
import { bytes, num, pct, relTime, timeOfDay, uptime } from '../lib/format';
import { useSettings } from '../lib/theme';
import type { ActivityEvent, Stack, SystemSnapshot } from '../lib/types';
import { Icon } from '../components/Icon';
import { MeterBar } from '../components/Charts';
import { OpenLink, ProviderNote, SectionHead, StatusLine } from '../components/ui';
import { DockerOffNote, LogsDrawer } from '../lib/dockerStatus';
import { humanEvent } from './Hub';

interface Detail {
  service: {
    name: string; app: string | null; description: string | null; href: string | null; icon: string | null;
    container: string | null; stack: string | null; keywords: string[]; meta: { label: string; value: string }[];
    group: string; status: string; statusReason: string | null;
    statusDetail: { name: string; image: string; status: string; health: string | null } | null;
  };
  stack: Stack | null;
  container: {
    id: string; name: string; image: string | null; state: { status: string; running: boolean; startedAt: string | null; health: string | null; exitCode: number | null };
    restartPolicy: string | null; labels: { project: string | null; service: string | null; workingDir: string | null };
    ports: { private: string; host: string; hostPort: string }[];
    mounts: { type: string; source: string; target: string; rw: boolean }[];
    networks: { name: string; ip: string; gateway: string; aliases: string[] }[];
    entrypoint: string | null; command: string | null; created: string | null;
  } | null;
  containerStats: { cpu: number | null; memory: { used: number | null; limit: number | null }; net: { rx: number; tx: number }; pids: number | null; blockIo: number | null } | null;
  dockerAvailable: boolean;
}

export default function ServiceDetail() {
  const { group = '', name = '' } = useParams();
  const { settings } = useSettings();
  const [showLogs, setShowLogs] = useState(false);
  const { data, error, loading, refresh, fetchedAt } = usePolled<Detail>(
    `/api/services/${encodeURIComponent(group)}/${encodeURIComponent(name)}`,
    (settings?.behavior?.refresh?.system ?? 5) * 2000,
  );
  const activity = usePolled<{ items: ActivityEvent[] }>(`/api/activity?limit=40`, 60_000);
  const sys = usePolled<SystemSnapshot>('/api/system', 10_000);

  if (loading && !data) return <div className="stale-note" style={{ padding: 'var(--sp-12) 0' }}>Loading service…</div>;
  if (error && !data) return <ProviderNote status="error" reason={error} fixHref="/services" fixLabel="Back to Services →" />;
  if (!data) return <ProviderNote status="error" reason="Service not found." fixHref="/services" fixLabel="Back to Services →" />;

  const s = data.service;
  const c = data.container;
  const st = data.containerStats;
  const memUsed = st?.memory.used ?? null;
  const memLimit = st?.memory.limit ?? null;
  const related = (activity.data?.items || []).filter((e) => e.subject === s.name || e.subject === c?.name);
  const now = Date.now();
  const startedMs = c?.state.startedAt ? new Date(c.state.startedAt).getTime() : null;

  return (
    <>
      <div className="detail-hero">
        <Icon ref={s.icon} name={s.name} size={68} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="status-line" style={{ marginBottom: 6 }}>
            <Link to="/services" className="section-link" style={{ textTransform: 'none', letterSpacing: 0 }}>{s.group}</Link>
            <span style={{ opacity: 0.5 }}>/</span>
            {s.stack && <>
              <Link to={`/stacks/${encodeURIComponent(s.stack)}`} className="section-link" style={{ textTransform: 'none', letterSpacing: 0 }}>{s.stack} stack</Link>
              <span style={{ opacity: 0.5 }}>/</span>
            </>}
          </div>
          <h1 className="detail-title">{s.name}</h1>
          {s.description && <p className="detail-sub">{s.description}</p>}
          <div className="detail-meta">
            {s.app && <span className="chip">{s.app}</span>}
            <StatusLine state={s.status || 'unavailable'} note={s.statusReason} />
            {c && <span className="mono-meta">{c.state.status}{c.state.health ? ` · ${c.state.health}` : ''}</span>}
            <button className="btn btn-quiet btn-sm" onClick={refresh}>Refresh</button>
            {fetchedAt && <span className="stale-note">{relTime(fetchedAt)}</span>}
          </div>
        </div>
        <div className="detail-actions">
          {s.href && (
            <OpenLink
              href={s.href}
              label={`Open ${s.name}`}
              onOpen={() => { if (settings?.behavior?.logLaunches) void api(`/api/services/${encodeURIComponent(group)}/${encodeURIComponent(name)}`, { method: 'POST' }).catch(() => undefined); }}
            />
          )}
          {data.dockerAvailable && c && (
            <button className="btn" onClick={() => setShowLogs(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 5h14M5 10h14M5 15h9" strokeLinecap="round" /></svg>
              Logs
            </button>
          )}
          <Link className="btn" to="/settings/services">Configuration</Link>
        </div>
      </div>

      <div className="detail-grid">
        <div>
          {/* runtime */}
          <section className="detail-block">
            <SectionHead title="Runtime" right={data.dockerAvailable ? (sys.data ? <Fresh at={sys.fetchedAt} /> : undefined) : undefined} />
            {data.dockerAvailable ? (
              c ? (
                <div className="stat-strip" style={{ gridAutoFlow: 'row', gridAutoColumns: 'auto' }}>
                  <div className="stat">
                    <div className="stat-k">CPU</div>
                    <div className="stat-v">{st?.cpu != null ? pct(st.cpu, 1) : 'Unavailable'}</div>
                    <MeterBar value={st?.cpu ?? null} />
                  </div>
                  <div className="stat">
                    <div className="stat-k">Memory</div>
                    <div className="stat-v">
                      {memUsed != null ? bytes(memUsed) : 'Unavailable'}
                      {memLimit ? <small>of {bytes(memLimit)}</small> : null}
                    </div>
                    {memLimit ? <MeterBar value={100 * (memUsed! / memLimit)} /> : null}
                  </div>
                  <div className="stat">
                    <div className="stat-k">Network</div>
                    <div className="stat-v" style={{ fontSize: 16 }}>{st ? `${bytes(st.net.rx)} ↓ · ${bytes(st.net.tx)} ↑` : 'Unavailable'}<small>lifetime</small></div>
                  </div>
                  <div className="stat">
                    <div className="stat-k">Uptime</div>
                    <div className="stat-v" style={{ fontSize: 16 }}>{startedMs ? uptime((now - startedMs) / 1000) : 'Unavailable'}</div>
                    <div className="stat-sub">{startedMs ? `since ${new Date(startedMs).toLocaleString()}` : ''}</div>
                  </div>
                </div>
              ) : (
                <ProviderNote status="unavailable" reason={`No container linked to “${s.name}”. Link one by name in Settings → Services (container field).`} />
              )
            ) : (
              <DockerOffNote reason={s.statusReason || null} />
            )}
          </section>

          {/* config-level facts */}
          {s.meta.length > 0 && (
            <section className="detail-block">
              <SectionHead title="Notes" />
              <dl className="kv">
                {s.meta.map((m, i) => <Pair key={i} k={m.label} v={m.value} />)}
              </dl>
            </section>
          )}

          {/* infrastructure */}
          <section className="detail-block">
            <SectionHead title="Infrastructure" right={c && <span className="stale-note">from Docker inspect</span>} />
            {c ? (
              <dl className="kv">
                <Pair k="Container" v={<span className="mono-meta">{c.name} <span style={{ opacity: 0.6 }}>({c.id})</span></span>} />
                <Pair k="Image" v={<span className="mono-meta">{c.image}</span>} />
                {c.command && <Pair k="Command" v={<span className="mono-meta">{c.command}</span>} />}
                {c.restartPolicy && <Pair k="Restart policy" v={c.restartPolicy} />}
                {c.ports.length > 0 && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <dt>Ports</dt>
                    <dd>
                      {c.ports.map((p, i) => (
                        <div className="port-row" key={i}>
                          <span>{p.host === '0.0.0.0' ? 'all' : p.host}:{p.hostPort}</span>
                          <span className="port-arrow">→</span>
                          <span>{p.private}</span>
                        </div>
                      ))}
                    </dd>
                  </div>
                )}
                {c.networks.length > 0 && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <dt>Networks</dt>
                    <dd>
                      {c.networks.map((n) => (
                        <div className="port-row" key={n.name}>
                          <span>{n.name}</span>
                          <span className="port-arrow">·</span>
                          <span className="mono-meta">{n.ip}{n.gateway ? ` gw ${n.gateway}` : ''}</span>
                        </div>
                      ))}
                    </dd>
                  </div>
                )}
                {c.mounts.length > 0 && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <dt>Volumes</dt>
                    <dd>
                      {c.mounts.map((m, i) => (
                        <div className="port-row" key={i}>
                          <span className="mono-meta" style={{ wordBreak: 'break-all' }}>{m.source}</span>
                          <span className="port-arrow">→</span>
                          <span className="mono-meta">{m.target}{!m.rw ? ' (ro)' : ''}</span>
                        </div>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            ) : (
              data.dockerAvailable
                ? <ProviderNote status="unavailable" reason={`No container matches “${s.name}”.`} />
                : <DockerOffNote reason={s.statusReason || null} />
            )}
          </section>

          {/* activity */}
          <section className="detail-block">
            <SectionHead title="Recent activity" right={<Link className="section-link" to="/activity">All →</Link>} />
            {related.length ? (
              <div className="hub-act">
                {related.slice(0, 8).map((e) => (
                  <div className="ha-row" key={e.id}>
                    <span className="ha-t">{relTime(e.t)}</span>
                    <span className="ha-msg">{humanEvent(e)}{e.message && e.type.startsWith('container') ? <span> · {e.message}</span> : null}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="stale-note">No recorded events for this service yet.</div>
            )}
          </section>
        </div>

        <div>
          <section className="detail-block">
            <SectionHead title="Application" />
            {s.href ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
                <OpenLink href={s.href} label={`Open ${s.name}`} onOpen={() => { void api(`/api/services/${encodeURIComponent(group)}/${encodeURIComponent(name)}`, { method: 'POST' }).catch(() => undefined); }} />
                <span className="mono-meta" style={{ wordBreak: 'break-all', opacity: 0.8 }}>{s.href}</span>
              </div>
            ) : (
              <ProviderNote compact status="unconfigured" reason="No URL configured for this service." fixHref="/settings/services" fixLabel="Add URL →" />
            )}
          </section>

          {data.stack && (
            <section className="detail-block">
              <SectionHead title="Stack" />
              <Link to={`/stacks/${encodeURIComponent(data.stack.name)}`} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Icon ref={data.stack.icon} name={data.stack.name} size={30} />
                <div>
                  <div style={{ fontWeight: 600 }}>{data.stack.name}</div>
                  <div className="stale-note">{data.stack.members.length} members · {data.stack.status}</div>
                </div>
              </Link>
            </section>
          )}

          <section className="detail-block">
            <SectionHead title="Identity" />
            <dl className="kv">
              <Pair k="Group" v={s.group} />
              <Pair k="Software" v={s.app || '—'} />
              {s.keywords.length > 0 && <Pair k="Keywords" v={s.keywords.join(', ')} />}
              <Pair k="Status source" v={data.dockerAvailable ? 'Docker engine' : 'unavailable'} />
            </dl>
          </section>
        </div>
      </div>
      {showLogs && c && <LogsDrawer container={c.name} onClose={() => setShowLogs(false)} />}
    </>
  );
}

function Pair({ k, v }: { k: string; v: React.ReactNode }) {
  return (<><dt>{k}</dt><dd>{v}</dd></>);
}
function Fresh({ at }: { at: number | null }) {
  return at ? <span className="stale-note">polled {timeOfDay(at)} · every 10s{''}</span> : null;
}
void num;
