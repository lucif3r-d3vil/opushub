import { useNavigate } from 'react-router-dom';
import { usePolled } from '../lib/api';
import { relTime } from '../lib/format';
import type { StacksDoc } from '../lib/types';
import { Icon } from '../components/Icon';
import { PageHero, ProviderNote, StatusLine } from '../components/ui';

const STATUS_HINT: Record<string, string> = {
  operational: 'every linked container is running',
  degraded: 'some containers up, others not',
  attention: 'one or more containers are not running',
  unlinked: 'no containers found for these services',
  unavailable: 'Docker not connected — status unavailable',
};

export default function StacksPage() {
  const nav = useNavigate();
  const { data, error, fetchedAt, refresh } = usePolled<StacksDoc>('/api/stacks', 30_000);
  const stacks = data?.stacks ?? [];
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
            <span className="sep">·</span>
            <span>{data?.live ? 'live from Docker' : 'config view (Docker not connected)'}</span>
            <button className="btn btn-quiet btn-sm" onClick={refresh}>Refresh</button>
          </>
        }
      />
      {error && !data && <ProviderNote status="error" reason={error} />}
      {!stacks.length && !error && <ProviderNote status="unconfigured" reason="No stacks defined." fixHref="/settings/services" fixLabel="Define stacks in services settings →" />}

      <ul className="stack-list" style={{ listStyle: 'none' }}>
        {stacks.map((s) => (
          <li key={s.name}>
            <div className="stack-row" role="link" tabIndex={0} style={{ cursor: 'pointer' }}
              onClick={() => nav(`/stacks/${encodeURIComponent(s.name)}`)}
              onKeyDown={(e) => { if (e.key === 'Enter') nav(`/stacks/${encodeURIComponent(s.name)}`); }}>
              <Icon ref={s.icon} name={s.name} size={32} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 620, fontSize: 15 }}>{s.name}</span>
                  {s.description && <span className="stale-note" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</span>}
                </div>
              </div>
              <div className="stack-members members-col">
                {s.members.map((m) => (
                  <span key={m.service} className="chip" onClick={(e) => { e.stopPropagation(); if (m.group && m.service) nav(`/services/${encodeURIComponent(m.group)}/${encodeURIComponent(m.service)}`); }}>
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
        ))}
      </ul>
      {stacks.length > 0 && (
        <p className="stale-note" style={{ marginTop: 'var(--sp-6)' }}>
          updated {relTime(fetchedAt || Date.now())}{data?.statusReason ? ` · ${data.statusReason}` : ''}
        </p>
      )}
    </>
  );
}
