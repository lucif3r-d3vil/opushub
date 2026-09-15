import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePolled } from '../lib/api';
import { relTime } from '../lib/format';
import type { StandaloneContainer, Stack, StacksDoc } from '../lib/types';
import { Icon } from '../components/Icon';
import { LastKnownNote, OpenLink, PageHero, ProviderNote, StatusDot, StatusLine } from '../components/ui';
import { LogsDrawer } from '../lib/dockerStatus';

// The deterministic model from server/discovery.js, in user-facing words
const STATUS_HINT: Record<string, string> = {
  operational: 'every container is running, none unhealthy',
  degraded: 'at least one container running, others unhealthy or not running',
  stopped: 'every container is stopped — nothing is running',
  attention: 'nothing running and at least one container in an unusual state',
  unknown: 'the engine reports no readable state for one or more containers',
  unlinked: 'this project has no containers on the engine',
  unavailable: 'Docker not connected — status unavailable',
};

const briefState = (c: { state: string; health: string | null }): string =>
  c.state === 'running' ? (c.health === 'unhealthy' ? 'unhealthy' : 'up')
    : c.state === 'exited' ? 'down'
      : c.state;

export default function StacksPage() {
  const nav = useNavigate();
  const { data, error, fetchedAt, refresh } = usePolled<StacksDoc>('/api/stacks', 30_000);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const stacks = data?.stacks ?? [];
  const configured = stacks.filter((s) => s.source !== 'discovered');
  const discovered = stacks.filter((s) => s.source === 'discovered');
  const standalone = data?.standalone ?? [];
  const unmatched = data?.unmatched ?? [];
  const openStack = (s: Stack) => nav(`/stacks/${encodeURIComponent(s.id)}`);
  const openService = (group: string | null, container: string) => nav(`/services/${encodeURIComponent(group || 'Other')}/${encodeURIComponent(container)}`);

  return (
    <>
      <PageHero
        title="Stacks"
        desc="A stack is a compose project: the containers that deploy together and die together, read straight off the engine. Config can rename and annotate one, never create one."
        meta={
          <>
            <span>{stacks.length} stack{stacks.length === 1 ? '' : 's'}</span>
            <span className="sep">·</span>
            <span>{stacks.reduce((a, s) => a + s.containerCount, 0)} containers</span>
            {standalone.length > 0 && <><span className="sep">·</span><span>{standalone.length} standalone</span></>}
            <span className="sep">·</span>
            <span>{data?.live ? 'live from Docker' : 'docker not connected'}</span>
            <button className="btn btn-quiet btn-sm" onClick={refresh}>Refresh</button>
          </>
        }
      />
      {error && !data && <ProviderNote status="error" reason={error} />}
      {!data?.live && !error && (
        <ProviderNote
          status="unavailable"
          reason={data?.statusReason || 'Stacks come from compose labels on the Docker engine. Without a connection there is nothing to list — an entry in stacks.yaml alone does not make a stack.'}
          fixHref="/settings/environment"
          fixLabel="Check the connection →"
        />
      )}
      {!data?.live && !error && data?.lastKnown && (
        <LastKnownNote
          at={data.lastKnown.at}
          lines={[`${data.lastKnown.stacks} stacks · ${data.lastKnown.containers} containers · ${data.lastKnown.running} running`]}
          onRetry={refresh}
        />
      )}
      {!!unmatched.length && (
        <div className="unavailable" style={{ marginBottom: 'var(--sp-6)' }} role="status">
          <span className="why">{unmatched.length} stacks.yaml {unmatched.length === 1 ? 'entry describes' : 'entries describe'} no compose project on this engine, so {unmatched.length === 1 ? 'it is' : 'they are'} not shown:</span>
          {unmatched.map((u, i) => <span key={i} className="mono-meta">{u.name}{u.container ? ` → project ${u.container}` : ''} — {u.reason}</span>)}
          <a className="act" href="/settings/services">Review configuration →</a>
        </div>
      )}

      <ul className="stack-list" style={{ listStyle: 'none' }}>
        {configured.map((s) => (
          <StackRow key={s.id} stack={s} onOpen={() => openStack(s)} onService={openService} />
        ))}
      </ul>

      {discovered.length > 0 && (
        <>
          <div className="section-head" style={{ marginTop: 'var(--section-gap)' }}>
            <h2 className="section-title">Discovered</h2>
            <span className="section-aside stale-note">compose projects on the engine with no stacks.yaml overlay</span>
          </div>
          <ul className="stack-list" style={{ listStyle: 'none' }}>
            {discovered.map((s) => (
              <StackRow key={s.id} stack={s} onOpen={() => openStack(s)} onService={openService} />
            ))}
          </ul>
        </>
      )}

      {standalone.length > 0 && (
        <>
          <div className="section-head" style={{ marginTop: 'var(--section-gap)' }}>
            <h2 className="section-title">Standalone containers</h2>
            <span className="section-aside stale-note">running outside any compose project</span>
          </div>
          <ul className="stack-list" style={{ listStyle: 'none' }}>
            {standalone.map((c) => (
              <li key={c.id}>
                <StandaloneRow c={c} onLogs={() => setLogsFor(c.name)} onOpen={(g, n) => openService(g, n)} />
              </li>
            ))}
          </ul>
        </>
      )}

      {stacks.length > 0 && (
        <p className="stale-note" style={{ marginTop: 'var(--sp-6)' }}>updated {relTime(fetchedAt || Date.now())}</p>
      )}
      {logsFor && <LogsDrawer container={logsFor} onClose={() => setLogsFor(null)} />}
    </>
  );
}

function StandaloneRow({ c, onLogs, onOpen }: { c: StandaloneContainer; onLogs: () => void; onOpen: (group: string | null, container: string) => void }) {
  return (
    <div className="stack-row standalone-row" onClick={() => onOpen(null, c.name)} role="link" tabIndex={0} style={{ cursor: 'pointer' }}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(null, c.name); }}>
      <span className="status-dot-wrap"><StatusDot state={briefState(c)} /></span>
      <div style={{ minWidth: 0 }}>
        <div className="standalone-name" title={c.name}>{c.displayName}</div>
        <div className="stale-note standalone-sub" title={c.status}>{c.status || c.state}</div>
      </div>
      <div className="stack-members members-col">
        <span className="mono-meta standalone-sub" title={c.image}>{c.image}</span>
        <span className="stale-note standalone-sub">{c.kind === 'infrastructure' ? 'infrastructure' : c.url ? `url from ${c.urlSource}` : 'no web endpoint'}</span>
      </div>
      <div>
        <StatusLine state={briefState(c)} note={c.status} />
      </div>
      <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }} onClick={(e) => e.stopPropagation()}>
        <OpenLink href={c.url} label="Open" />
        <button className="icon-btn accent-on-hover" title={`Logs for ${c.name}`} aria-label={`Logs for ${c.name}`} onClick={onLogs}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 5h14M5 10h14M5 15h9" strokeLinecap="round" /></svg>
        </button>
      </span>
    </div>
  );
}

function StackRow({ stack: s, onOpen, onService }: { stack: Stack; onOpen: () => void; onService: (group: string | null, container: string) => void }) {
  return (
    <li>
      <div className="stack-row" role="link" tabIndex={0} style={{ cursor: 'pointer' }}
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
        <Icon ref={s.icon} name={s.name} size={32} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
            <span className="stack-name">{s.name}</span>
            {s.project && s.project !== s.name && <span className="mono-meta" title="compose project on the engine">{s.project}</span>}
            {s.source === 'discovered' && <span className="stale-note" style={{ whiteSpace: 'nowrap' }}>auto</span>}
          </div>
          {s.description && <div className="stale-note stack-desc">{s.description}</div>}
        </div>
        <div className="stack-members members-col">
          {s.members.map((m) => (
            <span key={m.containerName} className="chip" onClick={(e) => { e.stopPropagation(); onService(m.group, m.containerName); }} title={m.container ? `${m.container.name} · ${m.container.state}` : undefined}>
              <Icon ref={m.icon} name={m.service} size={14} plain /> {m.service}
            </span>
          ))}
          {!s.members.length && <span className="stale-note">no containers</span>}
        </div>
        <div title={STATUS_HINT[s.status] || ''}>
          <StatusLine state={s.status} note={s.statusReason} />
        </div>
        <span className="stale-note" style={{ whiteSpace: 'nowrap' }}>
          {s.runningCount}/{s.containerCount} up
          {!!s.unhealthyCount && ` · ${s.unhealthyCount} unhealthy`}
          {!!s.attentionCount && ` · ${s.attentionCount} attention`}
        </span>
      </div>
    </li>
  );
}
