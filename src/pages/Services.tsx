import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, usePolled } from '../lib/api';
import { relTime } from '../lib/format';
import { useLayout, useSettings } from '../lib/theme';
import type { ServicesDoc } from '../lib/types';
import { Icon } from '../components/Icon';
import { OpenLink, ProviderNote, StatusLine } from '../components/ui';
import { Sortable } from '../components/Sortable';
import { PageHero } from '../components/ui';

export default function ServicesPage() {
  const { settings } = useSettings();
  const { layout, setLayout } = useLayout();
  const nav = useNavigate();
  const { data, error, fetchedAt, refresh } = usePolled<ServicesDoc>('/api/services', (settings?.behavior?.refresh?.services ?? 30) * 1000);
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const gs = data?.groups ?? [];
    const q = filter.toLowerCase().trim();
    const filtered = q
      ? gs.map((g) => ({ ...g, services: g.services.filter((s) => (s.name + ' ' + (s.app || '') + ' ' + (s.description || '') + ' ' + s.keywords.join(' ')).toLowerCase().includes(q)) }))
        .filter((g) => g.services.length)
      : gs;
    const names = filtered.map((g) => g.name);
    const saved = (layout?.services?.groupOrder || []).filter((n) => names.includes(n));
    return { ordered: [...saved, ...names.filter((n) => !saved.includes(n))].map((n) => filtered.find((g) => g.name === n)!), filtered };
  }, [data, filter, layout?.services?.groupOrder]);

  const total = data?.groups.reduce((a, g) => a + g.services.length, 0) ?? 0;

  return (
    <>
      <PageHero
        title="Services"
        desc="Everything OpusGrid runs, in one directory. Click a service for details; the launch button opens the app itself."
        meta={
          <>
            <span>{total} services</span><span className="sep">·</span>
            <span>{groups.filtered.length} groups</span><span className="sep">·</span>
            <span>{data?.live ? 'status live' : 'status unavailable'}</span><span className="sep">·</span>
            <span>{error ? 'refresh failed' : `updated ${relTime(fetchedAt || Date.now())}`}</span>
            <button className="btn btn-quiet btn-sm" onClick={refresh}>Refresh</button>
          </>
        }
      />

      {!!data?.skipped?.length && (
        <div className="unavailable" style={{ marginBottom: 'var(--sp-6)' }} role="alert">
          <span className="why">{data.skipped.length} entr{data.skipped.length === 1 ? 'y' : 'ies'} in services.yaml could not be read:</span>
          {data.skipped.map((b, i) => <span key={i} className="mono-meta">{b.group}/{b.name} — {b.reason}</span>)}
          <Link className="act" to="/settings/services">Review configuration →</Link>
        </div>
      )}

      <div style={{ marginBottom: 'var(--sp-6)', maxWidth: 420 }}>
        <input className="input" placeholder="Filter — name, app, description, keyword…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter services" />
      </div>

      {error && !data && <ProviderNote status="error" reason={error} />}
      {!total && !error && <ProviderNote status="unconfigured" reason="No services configured." fixHref="/settings/services" fixLabel="Configure services →" />}

      <Sortable
        ids={groups.ordered.map((g) => g.name)}
        onReorder={(next) => setLayout({ services: { groupOrder: next } })}
        className="services-groups"
        renderItem={(gid, ctx) => {
          const g = groups.ordered.find((x) => x.name === gid)!;
          const saved = layout?.services?.order?.[g.name];
          const names = g.services.map((s) => s.name);
          const ids = saved ? [...saved.filter((n) => names.includes(n)), ...names.filter((n) => !saved.includes(n))] : names;
          return (
            <section className="svc-group" key={g.name}>
              <div className="svc-group-head">
                {ctx.handle}
                <h2 className="svc-group-name">{g.name}</h2>
                {g.description && <span className="svc-group-desc">{g.description}</span>}
                <span className="svc-group-count">{g.services.length}</span>
              </div>
              <Sortable
                ids={filter ? names : ids}
                onReorder={(next) => !filter && setLayout({ services: { order: { [g.name]: next } } })}
                disabled={!!filter}
                className="svc-list"
                renderItem={(id) => {
                  const s = g.services.find((x) => x.name === id)!;
                  return (
                    <div
                      className="row svc-row"
                      role="link"
                      tabIndex={0}
                      onClick={() => nav(`/services/${encodeURIComponent(g.name)}/${encodeURIComponent(s.name)}`)}
                      onKeyDown={(e) => { if (e.key === 'Enter') nav(`/services/${encodeURIComponent(g.name)}/${encodeURIComponent(s.name)}`); }}
                      style={{ cursor: 'pointer' }}
                    >
                      <Icon ref={s.icon} name={s.name} size={26} />
                      <div className="grow">
                        <span className="title">{s.name}</span>
                        {s.app && <span className="sub" style={{ marginLeft: 8, marginRight: 0 }}>{s.app}</span>}
                      </div>
                      <div className="sub desc-col" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</div>
                      {s.href && (
                        <span className="mono-meta sub desc-col" title={s.href}>
                          {s.href.startsWith('/') ? 'this server' : s.href.replace(/^https?:\/\/(?:[^@/]*@)?([^/:]+)/, '$1')}
                        </span>
                      )}
                      <StatusLine state={s.status || 'unavailable'} note={s.statusReason} />
                      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                        <OpenLink
                          href={s.href}
                          label="Open"
                          onOpen={() => {
                            if (settings?.behavior?.logLaunches) void api(`/api/services/${encodeURIComponent(g.name)}/${encodeURIComponent(s.name)}`, { method: 'POST' }).catch(() => undefined);
                          }}
                        />
                        <Link className="btn btn-sm" to={`/services/${encodeURIComponent(g.name)}/${encodeURIComponent(s.name)}`}>Details</Link>
                      </div>
                    </div>
                  );
                }}
              />
            </section>
          );
        }}
      />
    </>
  );
}
