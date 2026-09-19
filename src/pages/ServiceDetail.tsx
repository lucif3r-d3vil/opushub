// Service Detail — the complete view of one service.
//
// What it answers: what is this, is it running, for how long, is it healthy, where does it come
// from, how is it reached, what is it using, what relates to it, what changed recently.
// What it can DO: start, restart or stop this one container — through the Operations Engine,
// after a server-side dry-run and a confirmation, with the result verified and recorded.
// What it never does: exec, create, delete, update, deploy, or anything else Docker can do.
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, usePolled } from '../lib/api';
import { bytes, pct, relTime, uptime } from '../lib/format';
import { useSettings } from '../lib/theme';
import type { ActivityEvent, ContainerStats, ImageInfo, MonitoringOverview, Service, ServiceHealthDoc, ServiceHistoryDoc, Stack, StatsSample, SystemSnapshot } from '../lib/types';
import { Icon } from '../components/Icon';
import { AreaChart, MeterBar, Sparkline } from '../components/Charts';
import { Freshness, Loading, OpenLink, ProviderNote, SectionHead, StatusLine } from '../components/ui';
import { StateBadge, TargetLine, TypeChip, UptimeValue } from '../components/monitoring/parts';
import { DockerOffNote, LogsDrawer } from '../lib/dockerStatus';
import { humanEvent } from '../lib/events';
import { ServiceActions, RecentOperations } from '../components/ServiceActions';
import { useOperationsCapabilities } from '../lib/operations';
import { UpdateItemRow } from '../components/Updates';
import type { ContainerUpdateRecord } from '../lib/types';

interface InspectedContainer {
  id: string; name: string; image: string | null; imageId?: string | null;
  state: {
    status: string; running: boolean; startedAt: string | null; finishedAt: string | null;
    health: string | null;
    healthcheck: { status: string | null; failingStreak: number | null } | null;
    exitCode: number | null; restartCount?: number | null; oomKilled?: boolean;
  };
  restartPolicy: string | null; logDriver?: string | null;
  labels: { project: string | null; service: string | null };
  ports: { private: string; host: string; hostPort: string }[];
  exposedPorts: { private: number; type: string }[];
  mounts: { type: string; source: string; target: string; rw: boolean }[];
  networks: { name: string; ip: string; gateway: string; aliases: string[] }[];
  command: string | null; created: string | null;
}

interface Detail {
  service: Service;
  stack: Stack | null;
  container: InspectedContainer | null;
  containerStats: ContainerStats | null;
  image: ImageInfo | null;
  dockerAvailable: boolean;
  url: string | null;
  urlSource: string;
  urlNote?: string | null;
}

const URL_SOURCE_WORDS: Record<string, string> = {
  manual: 'manual override',
  traefik: 'Traefik metadata',
  'published-port': 'published Docker port',
  none: 'nothing to reach',
};

/** The one place state + health become words. "No healthcheck" is never "unhealthy". */
function runtimeWords(c: InspectedContainer | null, fallback: string): { stateWord: string; healthWord: string | null; tone: string } {
  if (!c) return { stateWord: 'Unavailable', healthWord: null, tone: 'unavailable' };
  const st = c.state.status;
  if (st === 'running') {
    if (c.state.health === 'unhealthy') return { stateWord: 'Unhealthy', healthWord: `failing${c.state.healthcheck?.failingStreak ? ` ×${c.state.healthcheck.failingStreak}` : ''}`, tone: 'unhealthy' };
    if (c.state.health === 'healthy') return { stateWord: 'Running', healthWord: 'healthy', tone: 'up' };
    if (c.state.health === 'starting') return { stateWord: 'Running', healthWord: 'healthcheck starting', tone: 'up' };
    return { stateWord: 'Running', healthWord: 'no healthcheck', tone: 'up' };
  }
  if (st === 'exited') return { stateWord: 'Stopped', healthWord: null, tone: 'down' };
  if (st === 'paused') return { stateWord: 'Paused', healthWord: null, tone: 'paused' };
  if (st === 'restarting') return { stateWord: 'Restarting', healthWord: null, tone: 'restarting' };
  if (st === 'created') return { stateWord: 'Created — never started', healthWord: null, tone: 'unmanaged' };
  return { stateWord: fallback || st || 'Unknown', healthWord: null, tone: 'unmanaged' };
}

export default function ServiceDetail() {
  const { group = '', name = '' } = useParams();
  const { settings } = useSettings();
  const [showLogs, setShowLogs] = useState(false);
  const basePath = `/api/services/${encodeURIComponent(group)}/${encodeURIComponent(name)}`;
  const { data, error, loading, refresh, fetchedAt } = usePolled<Detail>(basePath, (settings?.behavior?.refresh?.system ?? 5) * 2000);
  // stats + history poll ONLY while this page is mounted — unmounting stops both (§29)
  const statsHist = usePolled<{ samples: StatsSample[]; watchingSince: number | null }>(data?.container ? `${basePath}/stats/history` : null, 5000);
  const health = usePolled<ServiceHealthDoc>(data?.service ? `${basePath}/health` : null, 60_000);
  const history = usePolled<ServiceHistoryDoc>(data?.service ? `${basePath}/history?limit=12` : null, 60_000);
  const activity = usePolled<{ items: ActivityEvent[] }>(`/api/activity?limit=40`, 60_000);
  // Phase 10A — the monitors that watch *this* service. A filtered read of the monitoring store:
  // this block never runs a check and never duplicates the engine.
  const monitors = usePolled<MonitoringOverview>(
    data?.service ? `/api/monitoring?service=${encodeURIComponent(group ? `${group}/${name}` : name)}` : null,
    30_000,
  );
  const sys = usePolled<SystemSnapshot>('/api/system', 10_000);
  // operations for THIS service, as the server recorded them (bounded, newest first)
  const ops = usePolled<{ operations: { id: string; action: string; status: string; at: number; actor: string | null }[] }>(
    `/api/v1/operations?service=${encodeURIComponent(name)}`, 0,
  );
  const opsCap = useOperationsCapabilities();
  const opsHistory = ops.data?.operations ?? [];
  const updateQuery = usePolled<{ update: ContainerUpdateRecord }>(
    data ? `/api/container-updates/${encodeURIComponent(data.service.name)}` : null, 30_000
  );
  const containerUpdate = updateQuery.data?.update;

  if (loading && !data) return <div style={{ padding: 'var(--sp-12) 0' }}><Loading what="this service" note="from the engine and the presentation overlay" /></div>;
  if (error && !data) return <ProviderNote status="error" reason={error} fixHref="/services" fixLabel="Back to Services →" />;
  if (!data) return <ProviderNote status="error" reason="Service not found." fixHref="/services" fixLabel="Back to Services →" />;

  const s = data.service;
  const c = data.container;
  const st = data.containerStats;
  const words = runtimeWords(c, s.status);
  const related = (activity.data?.items || []).filter((e) => e.subject === s.name || e.subject === c?.name || e.subject === s.displayName);
  const now = Date.now();
  const startedMs = c?.state.startedAt && !c.state.startedAt.startsWith('0001') ? new Date(c.state.startedAt).getTime() : null;
  const createdMs = c?.created ? new Date(c.created).getTime() : null;
  const running = c?.state.status === 'running';
  const restartCount = c?.state?.restartCount ?? s.container?.restartCount ?? null;
  const restartLoop = c?.state.status === 'restarting' || (running && (restartCount ?? 0) >= 5 && startedMs != null && now - startedMs < 5 * 60_000);
  const samples = statsHist.data?.samples || [];
  const logLaunch = () => { if (settings?.behavior?.logLaunches) void api(basePath, { method: 'POST' }).catch(() => undefined); };

  return (
    <>
      {/* ── header: identity first, technology second ─────────────────────── */}
      <div className="detail-hero">
        <Icon ref={s.icon} name={s.displayName} size={68} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="status-line" style={{ marginBottom: 6 }}>
            <Link to="/services" className="section-link" style={{ textTransform: 'none', letterSpacing: 0 }}>{s.group}</Link>
            <span style={{ opacity: 0.5 }}>/</span>
            {s.stack && <>
              <Link to={`/stacks/${encodeURIComponent(s.stack)}`} className="section-link" style={{ textTransform: 'none', letterSpacing: 0 }}>{s.stackDisplayName || s.stack} stack</Link>
              <span style={{ opacity: 0.5 }}>/</span>
            </>}
          </div>
          <h1 className="detail-title">{s.displayName}</h1>
          {s.description && <p className="detail-sub">{s.description}</p>}
          <div className="detail-meta">
            <StatusLine state={words.tone === 'up' ? 'up' : words.tone === 'down' ? 'down' : words.tone} note={words.stateWord} />
            <span className={`chip svc-health svc-health--${words.healthWord === 'healthy' ? 'ok' : words.stateWord === 'Unhealthy' ? 'bad' : 'quiet'}`}>
              {words.stateWord === 'Unhealthy' ? 'Unhealthy' : words.healthWord || words.stateWord}
            </span>
            {restartLoop && <span className="chip svc-health svc-health--bad" role="status">possible restart loop</span>}
            {running && startedMs != null && <span className="stale-note">up {uptime((now - startedMs) / 1000)}</span>}
            <span className="mono-meta" title="actual container name">{s.name}</span>
            <button className="btn btn-quiet btn-sm" onClick={refresh}>Refresh</button>
            {fetchedAt && <span className="stale-note">{relTime(fetchedAt)}</span>}
          </div>
        </div>
        <div className="detail-actions">
          {s.url ? (
            <OpenLink href={s.url} label={`Open ${s.displayName}`} onOpen={logLaunch} />
          ) : (
            <span className="stale-note" title={s.urlNote || undefined} style={{ alignSelf: 'center' }}>No web endpoint detected</span>
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
          {/* ── operations: the only thing on this page that changes anything ── */}
          <section className="detail-block" aria-labelledby="ops-head">
            <SectionHead
              id="ops-head"
              title="Operations"
              right={<span className="stale-note">confirmed, executed and verified server-side</span>}
            />
            {!data.dockerAvailable ? (
              <p className="stale-note">
                Docker is not connected, so no operation can run. Everything else on this page still shows the last state OpusHub saw.
              </p>
            ) : !c ? (
              <p className="stale-note">This container is no longer on the engine, so there is nothing to operate on.</p>
            ) : opsCap.overview && opsCap.permitted.size === 0 ? (
              <p className="stale-note">
                Your account ({opsCap.overview.actor.roleLabel.toLowerCase()}) is not allowed to run operations. Everything below is still yours to read.
              </p>
            ) : (
              <>
                <ServiceActions name={s.name} group={s.group} state={c.state.status} dockerAvailable={data.dockerAvailable} />
                <p className="stale-note" style={{ marginTop: 'var(--sp-3)' }}>
                  Each one asks first: OpusHub checks permission, target and Docker, shows you what it would do,
                  and only then runs. The result is verified against the engine and recorded in Activity.
                </p>
                {opsHistory.length > 0 && (
                  <div style={{ marginTop: 'var(--sp-5)' }}>
                    <span className="micro-label">Recent operations</span>
                    <RecentOperations
                      rows={opsHistory.map((r) => ({ id: r.id, action: r.action, status: r.status, at: r.at, actor: r.actor }))}
                    />
                  </div>
                )}
              </>
            )}
          </section>

          {/* ── runtime: the honest facts about right now ─────────────────── */}
          <section className="detail-block" aria-labelledby="rt-head">
            <SectionHead id="rt-head" title="Runtime" right={data.dockerAvailable ? <Freshness at={sys.fetchedAt} /> : undefined} />
            {data.dockerAvailable ? (
              c ? (
                <>
                  <div className="stat-strip" style={{ gridAutoFlow: 'row', gridAutoColumns: 'auto' }}>
                    <div className="stat">
                      <div className="stat-k">State</div>
                      <div className="stat-v" style={{ fontSize: 16 }}>{words.stateWord}</div>
                      <div className="stat-sub">{c.state.status}{c.state.oomKilled ? ' · OOM killed' : ''}</div>
                    </div>
                    <div className="stat">
                      <div className="stat-k">Uptime</div>
                      <div className="stat-v" style={{ fontSize: 16 }}>{running && startedMs ? uptime((now - startedMs) / 1000) : 'Not available'}</div>
                      <div className="stat-sub">{running && startedMs ? `since ${new Date(startedMs).toLocaleString()}` : c.state.status === 'exited' && c.state.finishedAt ? `stopped ${new Date(c.state.finishedAt).toLocaleString()}` : ''}</div>
                    </div>
                    <div className="stat">
                      <div className="stat-k">Restarts</div>
                      <div className="stat-v" style={{ fontSize: 16 }}>{restartCount != null ? restartCount : 'Not available'}</div>
                      <div className="stat-sub">{c.restartPolicy ? `${c.restartPolicy} policy` : ''}</div>
                    </div>
                    <div className="stat">
                      <div className="stat-k">Health</div>
                      <div className="stat-v" style={{ fontSize: 16 }}>
                        {c.state.health === 'healthy' ? 'Healthy' : c.state.health === 'unhealthy' ? 'Unhealthy' : c.state.health === 'starting' ? 'Starting' : c.state.status !== 'running' ? 'Not available' : 'No healthcheck'}
                      </div>
                      <div className="stat-sub">
                        {c.state.health === 'unhealthy' && c.state.healthcheck?.failingStreak ? `${c.state.healthcheck.failingStreak} failed check(s) in a row` : c.state.health ? 'declared by the container' : c.state.status === 'running' ? 'this container defines none' : ''}
                      </div>
                    </div>
                  </div>
                  {health.data && (
                    <HealthStrip
                      doc={health.data}
                      uptime={running && startedMs ? uptime((now - startedMs) / 1000) : null}
                      onRefresh={health.refresh}
                    />
                  )}
                  <dl className="kv" style={{ marginTop: 'var(--sp-4)' }}>
                    <Pair k="Started" v={startedMs ? new Date(startedMs).toLocaleString() : 'Not available'} />
                    <Pair k="Created" v={createdMs ? new Date(createdMs).toLocaleString() : 'Not available'} />
                    {c.state.status === 'exited' && <Pair k="Exit code" v={<>{c.state.exitCode ?? 'Not available'}{c.state.oomKilled ? ' · killed by out-of-memory' : ''}</>} />}
                    {c.logDriver && <Pair k="Log driver" v={<span className="mono-meta">{c.logDriver}</span>} />}
                  </dl>
                </>
              ) : (
                <ProviderNote status="unavailable" reason={`No container matches “${s.displayName}” any more — it was removed from the engine.`} />
              )
            ) : (
              <DockerOffNote reason={s.statusReason || null} />
            )}
          </section>

          {/* ── monitoring: what OpusHub watches, read from the monitoring store ── */}
          <section className="detail-block" aria-labelledby="mon-head">
            <SectionHead
              id="mon-head"
              title="Monitoring"
              right={<Link className="section-link" to="/monitoring">Open monitoring →</Link>}
            />
            <ServiceMonitors
              doc={monitors.data}
              error={monitors.error}
              group={s.group}
              name={s.name}
              displayName={s.displayName}
              hasEndpoint={!!s.url}
            />
          </section>

          {/* ── resources: live readings + compact history, on demand only ── */}
          <section className="detail-block" aria-labelledby="res-head">
            <SectionHead
              id="res-head"
              title="Resource usage"
              right={samples.length > 0 ? <span className="stale-note">{samples.length} sample{samples.length === 1 ? '' : 's'} while viewing</span> : undefined}
            />
            {!data.dockerAvailable ? (
              <DockerOffNote reason={s.statusReason || null} />
            ) : !running ? (
              <ProviderNote compact status="unavailable" reason={c ? `Stats are only reported while the container is running — this one is ${words.stateWord.toLowerCase()}.` : 'Connect Docker to see live resource use.'} />
            ) : (
              <>
                <ResourceGrid stats={st} samples={samples} />
                <SessionHistory samples={samples} watchingSince={statsHist.data?.watchingSince ?? null} />
              </>
            )}
          </section>

          {/* ── infrastructure: ports, networks, mounts (read-only) ───────── */}
          <section className="detail-block" aria-labelledby="infra-head">
            <SectionHead id="infra-head" title="Infrastructure" right={c && <span className="stale-note">from Docker inspect</span>} />
            {c ? (
              <dl className="kv">
                <Pair k="Container" v={<span className="mono-meta">{c.name} <span style={{ opacity: 0.6 }}>({c.id})</span></span>} />
                <Pair k="Image" v={<span className="mono-meta">{c.image}</span>} />
                {(c.labels?.project || c.labels?.service) && (
                  <Pair k="Compose" v={<span className="mono-meta">{[c.labels.project && `project ${c.labels.project}`, c.labels.service && `service ${c.labels.service}`].filter(Boolean).join(' · ')}</span>} />
                )}
                {c.command && <Pair k="Command" v={<span className="mono-meta">{c.command}</span>} />}
                {c.restartPolicy && <Pair k="Restart policy" v={c.restartPolicy} />}

                {(c.ports.length > 0 || c.exposedPorts.length > 0) && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <dt>Ports</dt>
                    <dd>
                      {c.ports.length > 0 && (
                        <>
                          <div className="micro-label">Published — reachable on the host</div>
                          {c.ports.map((p, i) => (
                            <div className="port-row" key={i}>
                              <span>{p.host === '0.0.0.0' ? 'all' : p.host}:{p.hostPort}</span>
                              <span className="port-arrow">→</span>
                              <span>{p.private}</span>
                            </div>
                          ))}
                        </>
                      )}
                      {c.exposedPorts.length > 0 && (
                        <>
                          <div className="micro-label" style={{ marginTop: c.ports.length ? 8 : 0 }}>Exposed — declared in the image, not reachable from outside</div>
                          {c.exposedPorts.map((p, i) => (
                            <div className="port-row" key={`e${i}`}>
                              <span className="mono-meta">{p.private}/{p.type}</span>
                              <span className="stale-note" style={{ fontSize: 11 }}>internal only</span>
                            </div>
                          ))}
                        </>
                      )}
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
                          {n.aliases?.length > 0 && <span className="stale-note" title={n.aliases.join(', ')}>aliases: {n.aliases.slice(0, 3).join(', ')}{n.aliases.length > 3 ? '…' : ''}</span>}
                        </div>
                      ))}
                    </dd>
                  </div>
                )}

                {c.mounts.length > 0 && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <dt>Volumes &amp; mounts</dt>
                    <dd>
                      {c.mounts.map((m, i) => (
                        <div className="port-row" key={i}>
                          <span className="mono-meta" style={{ wordBreak: 'break-all' }}>{m.source}</span>
                          <span className="port-arrow">→</span>
                          <span className="mono-meta">{m.target}{!m.rw ? ' (ro)' : ''}</span>
                          <span className="stale-note" style={{ fontSize: 11 }}>{m.type === 'volume' ? 'named volume' : m.type === 'bind' ? 'bind mount' : m.type}</span>
                        </div>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            ) : (
              data.dockerAvailable
                ? <ProviderNote status="unavailable" reason={`No container matches “${s.displayName}” any more — it was removed from the engine.`} />
                : <DockerOffNote reason={s.statusReason || null} />
            )}
          </section>

          {/* ── change history: real events only ───────────────────────────── */}
          <section className="detail-block" aria-labelledby="hist-head">
            <SectionHead id="hist-head" title="Change history" right={<Link className="section-link" to="/activity">All activity →</Link>} />
            <ServiceHistory doc={history.data} containerName={s.name} related={related} />
          </section>
        </div>

        <div>
          {/* ── access: where this service lives, and how we know ─────────── */}
          <section className="detail-block">
            <SectionHead title="Access" right={<span className="stale-note">{URL_SOURCE_WORDS[data.urlSource] || data.urlSource}</span>} />
            {s.url ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
                <OpenLink href={s.url} label={`Open ${s.displayName}`} onOpen={logLaunch} />
                <span className="mono-meta" style={{ wordBreak: 'break-all', opacity: 0.8 }}>{s.url}</span>
                <span className="stale-note">Source: {URL_SOURCE_WORDS[data.urlSource] || data.urlSource}</span>
              </div>
            ) : (
              <ProviderNote
                compact
                status="unconfigured"
                reason="No web endpoint detected — this container is not routed by the proxy and publishes no reachable host port."
                fixHref="/settings/services"
                fixLabel="Add a URL override →"
                details={s.urlNote || undefined}
              />
            )}
            {((s.container?.labels?.proxy?.length ?? 0) > 0 || s.urlNote) && (
              <details className="tech" style={{ marginTop: 'var(--sp-4)' }}>
                <summary>How this URL was found</summary>
                <code>
                  {[
                    `url: ${s.url || '(none)'}`,
                    `urlSource: ${s.urlSource}`,
                    s.urlNote ? `detail: ${s.urlNote}` : null,
                    ...(s.container?.labels?.proxy || []).map((r) => `traefik router ${r.router}: host(s) ${r.hosts.join(', ')} · entrypoints ${r.entrypoints.join('/') || '—'} · tls ${r.tls} · container port ${r.servicePort ?? '—'}${r.path ? ` · path ${r.path}` : ''}`),
                  ].filter(Boolean).join('\n')}
                </code>
              </details>
            )}
          </section>

          {/* ── labels: the allow-listed ones, which are the whole reason this service looks
                 like anything at all. The raw label map stays on the server — people put
                 tokens in labels, and OpusHub has no reason to ship them to a browser. ───── */}
          <section className="detail-block">
            <SectionHead title="Labels" right={<span className="stale-note">allow-listed</span>} />
            <LabelList s={s} />
            <p className="stale-note" style={{ marginTop: 'var(--sp-3)' }}>
              Only labels OpusHub understands are read: Docker Compose’s project/service labels,
              Traefik’s routing labels, and the <code>opushub.*</code> overlay. Anything else on the
              container — including values that look like credentials — is never parsed, stored or sent.
            </p>
          </section>

          {/* ── image ──────────────────────────────────────────────────────── */}
          <section className="detail-block">
            <SectionHead title="Image" />
            {data.image || c?.image ? (
              <dl className="kv">
                <Pair k="Image" v={<span className="mono-meta" style={{ wordBreak: 'break-all' }}>{data.image?.tags?.[0] || c?.image || '—'}</span>} />
                {!!data.image?.digests?.length && <Pair k="Digest" v={<span className="mono-meta" style={{ wordBreak: 'break-all' }}>{data.image.digests[0]}</span>} />}
                {data.image?.arch && <Pair k="Architecture" v={`${data.image.arch}${data.image.os ? ` · ${data.image.os}` : ''}`} />}
                <Pair k="Pulled image created" v={data.image?.created ? new Date(data.image.created).toLocaleDateString() : 'Not available'} />
                {data.image?.size != null && <Pair k="Size" v={bytes(data.image.size)} />}
                {c?.imageId && <Pair k="Image id" v={<span className="mono-meta">sha256:{c.imageId}…</span>} />}
              </dl>
            ) : (
              <div className="stale-note">Not available — the engine did not report image metadata.</div>
            )}
            {containerUpdate && (containerUpdate.status === 'update_available' || containerUpdate.status === 'updating' || containerUpdate.status === 'updated') ? (
              <div style={{ marginTop: 'var(--sp-4)' }}>
                <UpdateItemRow record={containerUpdate} onDone={() => updateQuery.refresh()} />
              </div>
            ) : (
              <p className="stale-note" style={{ marginTop: 'var(--sp-3)' }}>Up to date or no registry update detected by Diun.</p>
            )}
          </section>

          {data.stack && (
            <section className="detail-block">
              <SectionHead title="Stack" />
              <Link to={`/stacks/${encodeURIComponent(data.stack.id)}`} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Icon ref={data.stack.icon} name={data.stack.name} size={30} />
                <div>
                  <div style={{ fontWeight: 600 }}>{data.stack.name}</div>
                  <div className="stale-note">
                    {data.stack.members.length} member{data.stack.members.length === 1 ? '' : 's'}
                    {data.stack.project ? ` · compose project ${data.stack.project}` : ''}
                  </div>
                </div>
              </Link>
            </section>
          )}

          <section className="detail-block">
            <SectionHead title="Identity" />
            <dl className="kv">
              <Pair k="Group" v={<>{s.group} <span className="stale-note">· {s.groupSource === 'config' ? 'services.yaml' : s.groupSource === 'label' ? 'container label' : 'from discovery'}</span></>} />
              <Pair k="Software" v={s.app || s.container.composeService || '—'} />
              <Pair k="Listed as" v={<>{s.kind} <span className="stale-note">· {s.kindSource}</span></>} />
              {(s.keywords?.length ?? 0) > 0 && <Pair k="Keywords" v={s.keywords!.join(', ')} />}
              <Pair k="Source" v={s.configured ? 'Docker container + overlay' : 'Docker container (discovered)'} />
            </dl>
          </section>
        </div>
      </div>
      {showLogs && c && <LogsDrawer container={c.name} onClose={() => setShowLogs(false)} />}
    </>
  );
}

/* ---------------- unified health: every evidence source, one verdict ---------------- */

/**
 * The unified verdict (§4): container state + healthcheck + HTTP probe, each labelled.
 * \"Healthy\" is only ever shown with the evidence that earned it; anything less says what is
 * missing instead of rounding up.
 */
/**
 * The per-service monitoring block.
 *
 * Three honest states: monitors exist (list them, with a way to open each one), none exist (offer
 * to configure one — preferring the endpoint OpusHub already resolved for this service), or the
 * monitoring engine is not reachable (say so, and leave the rest of the page alone).
 */
function ServiceMonitors({ doc, error, group, name, displayName, hasEndpoint }: {
  doc: MonitoringOverview | null; error: string | null; group: string; name: string; displayName: string; hasEndpoint: boolean;
}) {
  const configureHref = `/monitoring?service=${encodeURIComponent(`${group || 'Other'}/${name}`)}&add=1`;
  if (error && !doc) {
    return (
      <ProviderNote
        compact
        status="unavailable"
        reason="Monitoring is unavailable right now, so what watches this service cannot be read. Service state above is unaffected."
        fixHref="/monitoring"
        fixLabel="Open monitoring →"
      />
    );
  }
  if (!doc) return <p className="stale-note">Reading monitors…</p>;
  const list = doc.monitors;
  if (!list.length) {
    return (
      <>
        <p className="stale-note" style={{ marginTop: 0 }}>
          Nothing watches {displayName} yet. A monitor checks it on its own schedule and records state,
          latency and incidents — it never changes anything.
        </p>
        <div className="mon-actions">
          <Link className="btn btn-quiet btn-sm" to={configureHref}>Configure a monitor</Link>
          <Link className="btn btn-quiet btn-sm" to="/monitoring">Open monitoring</Link>
          {!hasEndpoint && <span className="stale-note">No endpoint is known for this service, so a Docker or TCP monitor is the natural choice.</span>}
        </div>
      </>
    );
  }
  const engineDown = doc.engine.state === 'stopped' || doc.engine.state === 'unavailable';
  return (
    <>
      {engineDown && <p className="stale-note" role="status">Monitoring is {doc.engine.state} — the states below are the last recorded ones.</p>}
      <div className="mon-list">
        {list.map((m) => (
          <div className="mon-row" key={m.id}>
            <Link className="mon-row-main" to={`/monitoring/${m.id}`}>
              <span className="mon-row-name">{m.name}</span>
              <TypeChip monitor={m} />
              <TargetLine monitor={m} />
              <UptimeValue window={m.uptime ?? null} label="last 24h" />
              <StateBadge state={m.enabled ? m.status : 'paused'} stale={m.stale} />
            </Link>
          </div>
        ))}
      </div>
      <div className="mon-actions">
        <Link className="btn btn-quiet btn-sm" to={configureHref}>Add another monitor</Link>
        <Link className="btn btn-quiet btn-sm" to="/monitoring">Open monitoring</Link>
      </div>
    </>
  );
}

function HealthStrip({ doc, uptime: up, onRefresh }: { doc: ServiceHealthDoc; uptime: string | null; onRefresh: () => void }) {
  const h = doc.health;
  const p = doc.probe;
  const http = !h.url
    ? 'No URL'
    : !p.checked
      ? 'Not checked'
      : p.reachable
        ? `HTTP ${p.statusCode}${p.latencyMs != null ? ` · ${p.latencyMs} ms` : ''}`
        : `Unreachable (${p.errorType || 'no response'})`;
  return (
    <div className="health-strip" role="status" aria-label={`Service health: ${h.state}. ${h.detail}`}>
      <div className="health-head">
        <StatusLine state={h.state} />
        <span className="health-detail">{h.detail}</span>
        <button className="btn btn-quiet btn-sm" onClick={onRefresh} style={{ marginLeft: 'auto' }}>Re-check</button>
      </div>
      <dl className="kv" style={{ marginTop: 'var(--sp-3)' }}>
        <Pair k="Container" v={<span className="mono-meta">{h.evidence.container}</span>} />
        <Pair k="Health" v={h.evidence.healthcheck === 'none' ? 'No healthcheck' : h.evidence.healthcheck} />
        <Pair k="HTTP" v={http} />
        {up && <Pair k="Uptime" v={up} />}
        {h.stack && <Pair k="Stack" v={h.stack} />}
      </dl>
    </div>
  );
}

/* ---------------- labels ---------------- */

/** The three label families OpusHub actually reads, each shown with where it came from.
 *  A missing family is stated as missing — never rendered as an empty table. */
function LabelList({ s }: { s: Service }) {
  const c = s.container;
  const compose = c.labels?.compose ?? null;
  const proxy = c.labels?.proxy ?? [];
  const overlay = c.labels?.overlay ?? null;
  const meta = s.meta ?? [];
  const hasAny = !!compose || proxy.length > 0 || !!overlay || meta.length > 0;

  if (!hasAny) {
    return (
      <div className="stale-note">
        No labels OpusHub recognises on this container — its name, group and icon were derived from
        the image and the container name instead.
      </div>
    );
  }
  return (
    <dl className="kv">
      {compose && (
        <>
          <dt>Compose</dt>
          <dd className="mono-meta">
            {[
              compose.project && `project ${compose.project}`,
              compose.service && `service ${compose.service}`,
              (compose as { version?: string | null }).version && `version ${(compose as { version?: string | null }).version}`,
            ].filter(Boolean).join(' · ') || 'Compose labels present but empty'}
          </dd>
        </>
      )}
      {proxy.length > 0 && (
        <>
          <dt>Traefik</dt>
          <dd>
            {proxy.map((r) => (
              <div key={r.router} className="label-row">
                <span className="mono-meta">{r.router}</span>
                <span className="port-arrow">·</span>
                <span>{r.hosts.join(', ') || 'no host rule'}</span>
                <span className="stale-note">
                  {r.entrypoints.join('/') || 'no entrypoint'}{r.tls ? ' · tls' : ''}{r.servicePort ? ` · port ${r.servicePort}` : ''}{r.path ? ` · path ${r.path}` : ''}
                </span>
              </div>
            ))}
          </dd>
        </>
      )}
      {overlay && (
        <>
          <dt>Presentation</dt>
          <dd>
            <div className="label-row">
              {([['Display name', overlay.displayName], ['Icon', overlay.icon], ['Group', overlay.group],
                 ['URL override', overlay.url], ['Description', overlay.description]] as const)
                .filter(([, v]) => !!v)
                .map(([k, v]) => (
                  <span className="label-pair" key={k}>
                    <span className="micro-label">{k}</span>
                    <span className="mono-meta">{v}</span>
                  </span>
                ))}
            </div>
            <span className="stale-note">from <code>opushub.*</code> container labels — presentation only; the container is still whatever Docker says it is.</span>
          </dd>
        </>
      )}
      {meta.length > 0 && (
        <>
          <dt>Facts</dt>
          <dd>
            {meta.map((m) => (
              <div className="label-row" key={m.label}>
                <span className="stale-note">{m.label}</span>
                <span>{m.value}</span>
              </div>
            ))}
          </dd>
        </>
      )}
    </dl>
  );
}

/* ---------------- resources: values + compact sparklines ---------------- */

function ResourceGrid({ stats, samples }: { stats: ContainerStats | null; samples: StatsSample[] }) {
  const memUsed = stats?.memory.used ?? null;
  const memLimit = stats?.memory.limit ?? null;
  // net rx/tx are cumulative counters — rates come from consecutive real samples, never guessed
  const netRates = useMemo(() => {
    const out: { rx: number; tx: number }[] = [];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      const dt = (b.t - a.t) / 1000;
      if (dt <= 0 || a.netRx == null || b.netRx == null || a.netTx == null || b.netTx == null) continue;
      if (b.netRx < a.netRx || b.netTx < a.netTx) continue; // counter reset — skip, don't fake
      out.push({ rx: (b.netRx - a.netRx) / dt, tx: (b.netTx - a.netTx) / dt });
    }
    return out;
  }, [samples]);
  const lastRate = netRates[netRates.length - 1] || null;

  if (!stats) {
    return <ProviderNote compact status="unavailable" reason="The engine has no stats for this container right now." />;
  }
  return (
    <div className="stat-strip" style={{ gridAutoFlow: 'row', gridAutoColumns: 'auto' }}>
      <div className="stat">
        <div className="stat-k">CPU</div>
        <div className="stat-v">{stats.cpu != null ? pct(stats.cpu, 1) : 'Not available'}</div>
        <MeterBar value={stats.cpu ?? null} />
      </div>
      <div className="stat">
        <div className="stat-k">Memory</div>
        <div className="stat-v">
          {memUsed != null ? bytes(memUsed) : 'Not available'}
          {memLimit ? <small>of {bytes(memLimit)}</small> : null}
        </div>
        {memLimit && memUsed != null ? <MeterBar value={100 * (memUsed / memLimit)} /> : null}
      </div>
      <div className="stat">
        <div className="stat-k">Network</div>
        <div className="stat-v" style={{ fontSize: 15 }}>
          {lastRate ? `${bytes(lastRate.rx, true)} ↓ · ${bytes(lastRate.tx, true)} ↑` : 'Not available yet'}
        </div>
        <div className="stat-sub">lifetime {bytes(stats.net.rx)} ↓ · {bytes(stats.net.tx)} ↑</div>
        {netRates.length >= 2 && <Sparkline values={netRates.slice(-60).map((r) => r.rx)} width={120} height={22} color="var(--ok)" />}
      </div>
      <div className="stat">
        <div className="stat-k">Block I/O</div>
        <div className="stat-v" style={{ fontSize: 15 }}>{stats.blockIo != null ? bytes(stats.blockIo) : 'Not available'}</div>
        <div className="stat-sub">{stats.pids != null ? `${stats.pids} processes` : 'processes not reported'}</div>
      </div>
    </div>
  );
}

/* ---------------- resource history: what we actually watched ---------------- */

/**
 * The container's resource history, and nothing more.
 *
 * Two rules keep this honest and cheap:
 *  · it can only ever show the stretch during which a page was *watching* — OpusHub samples
 *    container stats on demand, so the window is the session, never a backfilled hour;
 *  · it is drawn by the measured chart component, so the graph owns a fixed box and can never
 *    paint under the labels beneath it.
 */
function SessionHistory({ samples, watchingSince }: { samples: StatsSample[]; watchingSince: number | null }) {
  const cpu = samples.filter((s) => s.cpu != null).map((s) => ({ t: s.t, v: s.cpu as number }));
  const mem = samples
    .filter((s) => s.mem != null && s.memLimit)
    .map((s) => ({ t: s.t, v: (100 * (s.mem as number)) / (s.memLimit as number) }));
  if (cpu.length < 2 && mem.length < 2) return null;

  const first = Math.min(...[...cpu, ...mem].map((p) => p.t));
  const last = Math.max(...[...cpu, ...mem].map((p) => p.t));
  // the axis spans the session we witnessed (clamped to a sane floor/ceiling), not a fixed hour
  const windowMs = Math.min(30 * 60_000, Math.max(2 * 60_000, last - first));
  const latestCpu = cpu.length ? cpu[cpu.length - 1].v : null;
  const latestMem = mem.length ? mem[mem.length - 1].v : null;
  const spanMinutes = Math.max(1, Math.round((last - first) / 60_000));

  return (
    <div className="res-history">
      <div className="res-history-head">
        <span className="micro-label">Since you opened this page</span>
        <span className="res-legend">
          <span className="res-key"><i style={{ background: 'var(--accent)' }} />CPU{latestCpu != null ? ` ${pct(latestCpu, 1)}` : ''}</span>
          <span className="res-key"><i style={{ background: 'var(--ok)' }} />Memory{latestMem != null ? ` ${latestMem.toFixed(0)}%` : ''}</span>
        </span>
      </div>
      <AreaChart
        height={118}
        windowMs={windowMs}
        maxHint={100}
        fmt={(v) => `${v.toFixed(0)}%`}
        series={[
          { points: cpu, label: 'CPU', color: 'var(--accent)', fill: false },
          { points: mem, label: 'Memory', color: 'var(--ok)', fill: false },
        ]}
      />
      <p className="stale-note">
        {samples.length} sample{samples.length === 1 ? '' : 's'} over the last {spanMinutes} min — container stats are
        collected only while a page is watching, so anything earlier was never recorded
        {watchingSince ? ` (sampling began ${relTime(watchingSince)})` : ''}.
      </p>
    </div>
  );
}

/* ---------------- history: distinguish no-data from nothing-happened ---------------- */

/** Map a witnessed event to the state it implies for the strip that follows it. */
function stateAfter(e: ActivityEvent): { word: string; cls: string } {
  if (e.type === 'container.started') return { word: 'running', cls: 'up' };
  if (e.type === 'container.exited') return { word: 'stopped', cls: 'down' };
  if (e.type === 'container.health') {
    if (/unhealthy/i.test(e.message || '')) return { word: 'unhealthy', cls: 'unhealthy' };
    if (/healthy/i.test(e.message || '')) return { word: 'running', cls: 'up' };
    return { word: 'health changed', cls: 'unmanaged' };
  }
  const m = String(e.message || '');
  if (/^restarting/i.test(m)) return { word: 'restarting', cls: 'unhealthy' };
  if (/^paused/i.test(m)) return { word: 'paused', cls: 'unmanaged' };
  if (/^running/i.test(m)) return { word: 'running', cls: 'up' };
  if (/^exited/i.test(m)) return { word: 'stopped', cls: 'down' };
  return { word: e.message || 'changed', cls: 'unmanaged' };
}

/** A compact state strip drawn ONLY from witnessed events — no invented gaps, no
 *  backfilled history. Unknown stretches say they are unknown. */
function UptimeStrip({ events, watchingSince }: { events: ActivityEvent[]; watchingSince: number | null }) {
  const ordered = [...events].sort((a, b) => a.t - b.t).slice(-24);
  if (!ordered.length) return null;
  const now = Date.now();
  const start = Math.min(watchingSince ?? ordered[0].t, ordered[0].t);
  const span = Math.max(1, now - start);
  const segs: { from: number; to: number; word: string; cls: string }[] = [];
  let cursor = start;
  let cur = { word: 'unknown — no event yet', cls: 'unknown' };
  for (const e of ordered) {
    if (e.t > cursor) segs.push({ from: cursor, to: e.t, ...cur });
    cur = stateAfter(e);
    cursor = e.t;
  }
  segs.push({ from: cursor, to: now, ...cur });
  return (
    <div className="uptime-strip" role="img" aria-label={`Uptime history: ${segs.map((s) => s.word).join(', then ')}`}>
      {segs.map((s, i) => (
        <span
          key={i}
          className={`useg useg--${s.cls}`}
          style={{ flexGrow: Math.max(0.35, (s.to - s.from) / span * 100) }}
          title={`${s.word} · ${new Date(s.from).toLocaleTimeString()} – ${new Date(s.to).toLocaleTimeString()}`}
        />
      ))}
    </div>
  );
}

function ServiceHistory({ doc, containerName, related }: { doc: ServiceHistoryDoc | null; containerName: string; related: ActivityEvent[] }) {
  const events = doc?.events?.length ? doc.events : related.filter((e) => e.source === 'docker');
  if (!doc) return <div className="stale-note">Loading history…</div>;
  if (!events.length) {
    // the two honest sentences, and they mean different things
    if (!doc.watchingSince) {
      return <div className="stale-note" role="status">No historical data yet — OpusHub has recorded nothing since it started, so there is no history to show (this is not the same as “nothing happened”).</div>;
    }
    return <div className="stale-note" role="status">No events recorded for this service since OpusHub started watching ({new Date(doc.watchingSince).toLocaleString()}). Earlier changes were not observed.</div>;
  }
  return (
    <div className="hub-act">
      <UptimeStrip events={events} watchingSince={doc.watchingSince} />
      {events.slice(0, 8).map((e) => (
        <div className="ha-row" key={e.id}>
          <span className="ha-t">{relTime(e.t)}</span>
          <span className="ha-msg">
            {humanEvent(e)}
            {e.message && e.type.startsWith('container') && !e.message.startsWith('health') ? <span> · {e.message}</span> : null}
          </span>
        </div>
      ))}
      <span className="stale-note" style={{ display: 'block', marginTop: 'var(--sp-2)' }}>
        {containerName} — history begins {doc.watchingSince ? new Date(doc.watchingSince).toLocaleString() : 'when OpusHub boots'}; earlier changes are unknown, never invented.
      </span>
    </div>
  );
}

function Pair({ k, v }: { k: string; v: React.ReactNode }) {
  return (<><dt>{k}</dt><dd>{v}</dd></>);
}
