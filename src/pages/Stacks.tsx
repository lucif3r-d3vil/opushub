import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePolled } from '../lib/api';
import { relTime } from '../lib/format';
import type { ContainerBrief, Stack, StacksDoc } from '../lib/types';
import { Icon } from '../components/Icon';
import { PageHero, ProviderNote, StatusDot, StatusLine } from '../components/ui';
import { LogsDrawer } from '../lib/dockerStatus';

const STATUS_HINT: Record<string, string> = {
  operational: 'every linked container is running',
  degraded: 'some containers up, others not',
  attention: 'one or more containers are not running',
  unlinked: 'no containers found for these services',
  unavailable: 'Docker not connected — status unavailable',
};

const briefState = (c: ContainerBrief): string =>
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
  return (
    <>
      <PageHero
        title="Stacks"
        desc="A stack is a set of services that belong together — deployed as one compose unit, usually dying as one too."
        meta={
          <>
            <span>{stacks.length} stack{stacks.length === 1 ? '' : 's'}</span>
            <span className="sep">·</span>
            <span>{stacks.reduce((a, s) => a + s.members.length, 0)} members</span>
            {standalone.length > 0 && <><span className="sep">·</span><span>{standalone.length} standalone</span></>}
            <span className="sep">·</span>
            <span>{data?.live ? 'live from Docker' : 'config view (Docker not connected)'}</span>
            <button className="btn btn-quiet btn-sm" onClick={refresh}>Refresh</button>
          </>
        }
      />
      {error && !data && <ProviderNote status="error" reason={error} />}
      {!stacks.length && !error && <ProviderNote status="unconfigured" reason="No stacks defined." fixHref="/settings/services" fixLabel="Define stacks in services settings →" />}

      <ul className="stack-list" style={{ listStyle: 'none' }}>
        {configured.map((s) => (
          <StackRow key={s.name} stack={s} onOpen={() => nav(`/stacks/${encodeURIComponent(s.name)}`)} onService={(g, n) => nav(`/services/${encodeURIComponent(g)}/${encodeURIComponent(n)}`)} />
        ))}
      </ul>

      {discovered.length > 0 && (
        <>
          <div className="section-head" style={{ marginTop: 'var(--section-gap)' }}>
            <h2 className="section-title">Discovered</h2>
            <span className="section-aside stale-note">compose projects with no stacks.yaml entry</span>
          </div>
          <ul className="stack-list" style={{ listStyle: 'none' }}>
            {discovered.map((s) => (
              <StackRow key={s.name} stack={s} onOpen={() => nav(`/stacks/${encodeURIComponent(s.name)}`)} onService={(g, n) => nav(`/services/${encodeURIComponent(g)}/${encodeURIComponent(n)}`)} />
            ))}
          </ul>
        </>
      )}

      {standalone.length > 0 && (
        <>
          <div className="section-head" style={{ marginTop: 'var(--section-gap)' }}>
            <h2 className="section-title">Standalone containers</h2>
            <span className="section-aside stale-note">running outside any stack</span>
          </div>
          <ul className="stack-list" style={{ listStyle: 'none' }}>
            {standalone.map((c) => (
              <li key={c.id}>
                <div className="stack-row standalone-row">
                  <span className="status-dot-wrap"><StatusDot state={briefState(c)} /></span>
                  <div style={{ minWidth: 0 }}>
                    <div className="standalone-name" title={c.name}>{c.name}</div>
                    <div className="stale-note standalone-sub" title={c.status}>{c.status || c.state}</div>
                  </div>
                  <div className="stack-members members-col">
                    <span className="mono-meta standalone-sub" title={c.image}>{c.image}</span>
                  </div>
                  <div>
                    <StatusLine state={briefState(c)} note={c.status} />
                  </div>
                  <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button className="icon-btn accent-on-hover" title={`Logs for ${c.name}`} aria-label={`Logs for ${c.name}`} onClick={() => setLogsFor(c.name)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 5h14M5 10h14M5 15h9" strokeLinecap="round" /></svg>
                    </button>
                  </span>
                </div>
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

function StackRow({ stack: s, onOpen, onService }: { stack: Stack; onOpen: () => void; onService: (group: string, name: string) => void }) {
  return (
    <li>
      <div className="stack-row" role="link" tabIndex={0} style={{ cursor: 'pointer' }}
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
        <Icon ref={s.icon} name={s.name} size={32} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
            <span className="stack-name">{s.name}</span>
            {s.source === 'discovered' && <span className="stale-note" style={{ whiteSpace: 'nowrap' }}>auto</span>}
          </div>
          {s.description && <div className="stale-note stack-desc">{s.description}</div>}
        </div>
        <div className="stack-members members-col">
          {s.members.map((m) => (
            <span key={m.service} className="chip" onClick={(e) => { e.stopPropagation(); if (m.group && m.service) onService(m.group, m.service); }}>
              <Icon ref={m.icon} name={m.service} size={14} plain /> {m.service}
            </span>
          ))}
          {!s.members.length && <span className="stale-note">no services yet</span>}
        </div>
        <div title={STATUS_HINT[s.status] || ''}>
          <StatusLine state={s.status} note={s.statusReason} />
        </div>
        <span className="stale-note" style={{ whiteSpace: 'nowrap' }}>
          {s.containerCount > 0 ? `${s.containerCount} container${s.containerCount === 1 ? '' : 's'}` : `${s.members.length} member${s.members.length === 1 ? '' : 's'}`}
        </span>
      </div>
    </li>
  );
}
