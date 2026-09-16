import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, usePolled } from '../lib/api';
import { relTime } from '../lib/format';
import { useLayout, useSettings } from '../lib/theme';
import type { Service, ServicesDoc } from '../lib/types';
import { Icon } from '../components/Icon';
import { LastKnownNote, OpenLink, ProviderNote, StatusLine } from '../components/ui';
import { Sortable } from '../components/Sortable';
import { PageHero } from '../components/ui';
import { LogsDrawer } from '../lib/dockerStatus';
import { ServiceActionMenu } from '../components/ServiceActions';

const hostOf = (url: string) => url.replace(/^https?:\/\/(?:[^@/]*@)?([^/:]+)/, '$1');

export default function ServicesPage() {
  const { settings } = useSettings();
  const { layout, setLayout } = useLayout();
  const nav = useNavigate();
  const { data, error, fetchedAt, refresh } = usePolled<ServicesDoc>('/api/services', (settings?.behavior?.refresh?.services ?? 30) * 1000);
  const [filter, setFilter] = useState('');
  const [showInfra, setShowInfra] = useState(false);
  const [logsFor, setLogsFor] = useState<string | null>(null);

  const groups = useMemo(() => {
    const gs = data?.groups ?? [];
    const q = filter.toLowerCase().trim();
    const filtered = q
      ? gs
        .map((g) => ({ ...g, services: g.services.filter((s) => (`${s.displayName} ${s.name} ${s.app || ''} ${s.description || ''} ${(s.keywords || []).join(' ')} ${s.container.composeProject || ''}`).toLowerCase().includes(q)) }))
        .filter((g) => g.services.length)
      : gs;
    const names = filtered.map((g) => g.name);
    const saved = (layout?.services?.groupOrder || []).filter((n) => names.includes(n));
    return { ordered: [...saved, ...names.filter((n) => !saved.includes(n))].map((n) => filtered.find((g) => g.name === n)!), filtered };
  }, [data, filter, layout?.services?.groupOrder]);

  const total = data?.groups.reduce((a, g) => a + g.services.length, 0) ?? 0;
  const infra = data?.infrastructure ?? [];
  const unmatched = (data?.unmatched ?? []).filter((u) => u.kind === 'service');

  return (
    <>
      <PageHero
        title="Services"
        desc="Everything this Docker engine is actually running, with the URLs your proxy and published ports really expose. Click a service for details; the launch button opens the app itself."
        meta={
          <>
            <span>{total} service{total === 1 ? '' : 's'}</span><span className="sep">·</span>
            <span>{groups.filtered.length} groups</span><span className="sep">·</span>
            <span>{data?.live ? `discovered from Docker${data.stats ? ` · ${data.stats.withUrl} with a web URL` : ''}` : 'docker not connected'}</span><span className="sep">·</span>
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

      {!!unmatched.length && (
        <div className="unavailable" style={{ marginBottom: 'var(--sp-6)' }} role="status">
          <span className="why">
            {unmatched.length} overlay {unmatched.length === 1 ? 'entry names' : 'entries name'} a container that isn’t on this engine — Docker decides what exists, so {unmatched.length === 1 ? 'it is' : 'they are'} not listed above.
          </span>
          {unmatched.map((b, i) => (
            <span key={i} className="mono-meta">
              {b.container ? `${b.name} → container ${b.container}` : b.name} — {b.reason}
            </span>
          ))}
          <Link className="act" to="/settings/services">Fix the overlay →</Link>
        </div>
      )}

      <div style={{ marginBottom: 'var(--sp-6)', maxWidth: 420 }}>
        <input className="input" placeholder="Filter — name, app, image, group…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter services" />
      </div>

      {error && !data && <ProviderNote status="error" reason={error} />}
      {!data?.live && !error && (
        <ProviderNote
          status="unavailable"
          reason={data?.statusReason || 'Docker is not connected, so OpusHub has no inventory to show. Services are discovered from the engine — nothing is listed from config alone.'}
          fixHref="/settings/environment"
          fixLabel="Check the connection →"
        />
      )}
      {!data?.live && !error && data?.lastKnown && (
        <LastKnownNote
          at={data.lastKnown.at}
          lines={[`${data.lastKnown.containers} services · ${data.lastKnown.running} running · ${data.lastKnown.stopped} stopped · ${data.lastKnown.stacks} stacks`]}
          onRetry={refresh}
        />
      )}
      {!!data?.live && !total && !filter && (
        <ProviderNote
          status="unconfigured"
          reason="No containers with a web endpoint on this engine yet. Discovery is live — the moment a container appears it shows up here, with no configuration needed."
          fixHref="/settings/environment"
          fixLabel="See discovery status →"
        />
      )}

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
                {g.configured === false && <span className="stale-note" style={{ whiteSpace: 'nowrap' }}>from discovery</span>}
                <span className="svc-group-count">{g.services.length}</span>
              </div>
              <Sortable
                ids={filter ? names : ids}
                onReorder={(next) => !filter && setLayout({ services: { order: { [g.name]: next } } })}
                disabled={!!filter}
                className="svc-list"
                renderItem={(id) => {
                  const s = g.services.find((x) => x.name === id)!;
                  return <ServiceRow service={s} />;
                }}
              />
            </section>
          );
        }}
      />

      {infra.length > 0 && (
        <section className="svc-group" style={{ marginTop: 'var(--section-gap)' }}>
          <div className="svc-group-head">
            <h2 className="svc-group-name">Infrastructure</h2>
            <span className="svc-group-desc">Rails that keep the apps upright — databases, caches, proxies, workers. Here so nothing is hidden from you, not filed as a service.</span>
            <span className="svc-group-count">{infra.length}</span>
            <button className="btn btn-quiet btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setShowInfra((v) => !v)} aria-expanded={showInfra}>
              {showInfra ? 'Hide' : 'Show'}
            </button>
          </div>
          {showInfra && (
            <div className="svc-list">
              {infra.map((s) => (
                <div className="row svc-row" key={s.id}>
                  <Icon ref={s.icon} name={s.displayName} size={24} />
                  <div className="grow">
                    <span className="title" style={{ fontWeight: 540 }}>{s.displayName}</span>
                    {s.container.composeProject && <span className="sub" style={{ marginLeft: 8, marginRight: 0 }}>{s.container.composeProject}</span>}
                  </div>
                  <div className="sub desc-col mono-meta" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.container.image}</div>
                  {s.url && (
                    <span className="mono-meta sub desc-col" title={`${s.url} · ${s.urlSource}`}>{hostOf(s.url)}</span>
                  )}
                  <StatusLine state={s.status} note={s.kindSource} />
                  <div className="row-actions">
                    <button className="icon-btn accent-on-hover" title={`Logs for ${s.name}`} aria-label={`Logs for ${s.name}`} onClick={() => setLogsFor(s.name)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 5h14M5 10h14M5 15h9" strokeLinecap="round" /></svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {logsFor && <LogsDrawer container={logsFor} onClose={() => setLogsFor(null)} />}
    </>
  );
}

function ServiceRow({ service: s }: { service: Service }) {
  const { settings } = useSettings();
  const nav = useNavigate();
  const href = `/services/${encodeURIComponent(s.group)}/${encodeURIComponent(s.name)}`;
  return (
    <div
      className="row svc-row"
      role="link"
      tabIndex={0}
      onClick={() => nav(href)}
      onKeyDown={(e) => { if (e.key === 'Enter') nav(href); }}
      style={{ cursor: 'pointer' }}
    >
      <Icon ref={s.icon} name={s.displayName} size={26} />
      <div className="grow">
        <span className="title">{s.displayName}</span>
        {(s.app || s.container.composeService) && (
          <span className="sub" style={{ marginLeft: 8, marginRight: 0 }}>{s.app || s.container.composeService}</span>
        )}
        {!s.configured && <span className="stale-note" style={{ marginLeft: 8 }} title="Discovered from Docker with no overlay entry">auto</span>}
      </div>
      <div className="sub desc-col" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</div>
      {s.url ? (
        <span className="mono-meta sub desc-col" title={`${s.url} · ${s.urlSource}`}>
          {s.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
        </span>
      ) : (
        <span className="stale-note sub desc-col" title={s.urlNote || 'no web endpoint on this container'}>no web endpoint</span>
      )}
      <StatusLine state={s.status} note={s.statusReason} />
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        <OpenLink
          href={s.url}
          label="Open"
          onOpen={() => {
            if (settings?.behavior?.logLaunches) void api(href, { method: 'POST' }).catch(() => undefined);
          }}
        />
        <Link className="btn btn-sm" to={href}>Details</Link>
        {/* operations stay behind a menu: this page is for finding a service, not for
            running the whole fleet from a list of buttons */}
        <ServiceActionMenu
          name={s.name}
          group={s.group}
          state={s.container.state}
          url={s.url}
          detailHref={href}
          label={`Actions for ${s.displayName}`}
        />
      </div>
    </div>
  );
}
