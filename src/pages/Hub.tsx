import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, usePolled } from '../lib/api';
import { bytes, num, pct, relTime, uptime } from '../lib/format';
import { useLayout, useSettings } from '../lib/theme';
import type { ActivityEvent, LayoutDoc, NewsDoc, ServicesDoc, SystemSnapshot, WeatherDoc } from '../lib/types';
import { Icon } from '../components/Icon';
import SetupBanner from '../components/SetupBanner';
import { MeterBar, Sparkline } from '../components/Charts';
import { Menu, type MenuItem, ProviderNote, StatusDot, Freshness } from '../components/ui';
import { Sortable, type SortableCtx } from '../components/Sortable';
import { humanEvent } from '../lib/events';

/* ---------------- greeting + clock ---------------- */
function greeting(name: string | null) {
  const h = new Date().getHours();
  const part = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

function Clock() {
  const { settings } = useSettings();
  const [now, setNow] = useState(() => new Date());
  const secs = !!settings?.hub.showSeconds;
  // nudge to the next second boundary so the first tick isn't visibly late
  useEffect(() => {
    if (secs) return;
    const d = new Date();
    const wait = 1000 - d.getMilliseconds();
    const id = window.setTimeout(() => setNow(new Date()), wait);
    return () => window.clearTimeout(id);
  }, [secs]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), secs ? 1000 : 20000);
    return () => clearInterval(t);
  }, [secs]);
  return (
    <div className="clockbox">
      <div className="clock-big">
        {now.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', second: secs ? '2-digit' : undefined, hour12: !(settings?.hub.clock24h ?? false) })}
      </div>
      <div className="clock-date">{now.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
    </div>
  );
}

/* ---------------- system overview strip ---------------- */
function OverviewStrip({ sys }: { sys: SystemSnapshot | null }) {
  const cpu = sys?.cpu?.usage ?? null;
  const mem = sys?.memory ?? null;
  const disks = sys?.disks ?? [];
  const diskUsed = disks.reduce((a, d) => a + d.used, 0);
  const diskTotal = disks.reduce((a, d) => a + d.total, 0);
  const rx = sys?.network.reduce((a, n) => a + (n.rxPerSec ?? 0), 0) ?? null;
  const tx = sys?.network.reduce((a, n) => a + (n.txPerSec ?? 0), 0) ?? null;
  const topDisk = [...disks].sort((a, b) => b.used / b.total - a.used / a.total)[0];
  const memPct = mem ? 100 * (1 - mem.available / mem.total) : null;
  return (
    <div className="stat-strip" role="group" aria-label="Host overview">
      <div className="stat">
        <div className="stat-k">CPU</div>
        <div className="stat-v">{cpu == null ? <span title="First sample pending">—</span> : <>{pct(cpu)} <small>{sys?.cpu.cores} cores</small></>}</div>
        <div style={{ marginTop: 8 }}><MeterBar value={cpu} /></div>
        <div className="stat-sub">{sys?.cpu.load1 != null ? `load ${num(sys.cpu.load1, 2)}` : 'load sampling…'}</div>
      </div>
      <div className="stat">
        <div className="stat-k">Memory</div>
        <div className="stat-v">{mem ? <>{pct(memPct!)} <small>{bytes(mem.total - mem.available)}</small></> : '—'}</div>
        <div style={{ marginTop: 8 }}><MeterBar value={memPct} /></div>
        <div className="stat-sub">{mem ? `${bytes(mem.available)} available` : 'Unavailable'}</div>
      </div>
      <div className="stat">
        <div className="stat-k">Storage</div>
        <div className="stat-v">{diskTotal ? <>{pct(100 * (diskUsed / diskTotal))} <small>{disks.length} vol{disks.length === 1 ? '' : 's'}</small></> : '—'}</div>
        <div style={{ marginTop: 8 }}><MeterBar value={topDisk ? 100 * (topDisk.used / topDisk.total) : null} /></div>
        <div className="stat-sub">{topDisk ? `busiest ${topDisk.mount} · ${pct(100 * topDisk.used / topDisk.total)}` : 'No volumes'}</div>
      </div>
      <div className="stat">
        <div className="stat-k">Network</div>
        <div className="stat-v">{rx != null ? <>{bytes(rx, true)} <small>↓</small></> : '—'}</div>
        <div style={{ marginTop: 8 }} className="mono-meta">{tx != null ? `${bytes(tx, true)} ↑` : '—'}</div>
        <div className="stat-sub">{sys?.network.map((n) => n.name).join(' · ') || 'no interfaces'}</div>
      </div>
      <div className="stat">
        <div className="stat-k">Uptime</div>
        <div className="stat-v" style={{ fontSize: 20 }}>{sys ? uptime(sys.host.uptimeSec) : '—'}</div>
        <div style={{ height: 8 }} />
        <div className="stat-sub">{sys ? `${sys.host.hostname} · ${sys.host.os}` : ''}</div>
      </div>
    </div>
  );
}

/* ---------------- service tile ---------------- */
function ServiceTile({ svc, groupName, handle }: { svc: ServicesDoc['groups'][number]['services'][number]; groupName: string; handle?: ReactNode }) {
  const { settings } = useSettings();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const launch = useCallback(() => {
    if (!svc.href) return;
    if (settings?.behavior?.logLaunches) {
      void api(`/api/services/${encodeURIComponent(groupName)}/${encodeURIComponent(svc.name)}`, { method: 'POST' }).catch(() => undefined);
    }
    window.open(svc.href, '_blank', 'noreferrer');
  }, [svc.href, svc.name, groupName, settings?.behavior?.logLaunches]);
  const items: MenuItem[] = [
    ...(svc.href ? [{ label: 'Open in new tab', action: launch } as MenuItem] : []),
    { label: 'Service details', href: `/services/${encodeURIComponent(groupName)}/${encodeURIComponent(svc.name)}` },
    ...(svc.href ? [{ label: 'Copy URL', action: () => void navigator.clipboard?.writeText(svc.href || '').catch(() => undefined) } as MenuItem] : []),
  ];
  return (
    <article className="svc-tile" onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
      <div className="tile-top">
        <Icon ref={svc.icon} name={svc.name} size={30} />
        <span className="tile-top-right">
          <StatusDot state={svc.status || 'unavailable'} title={svc.statusReason || undefined} />
          {handle}
        </span>
      </div>
      <div style={{ marginTop: 'auto' }}>
        <Link to={`/services/${encodeURIComponent(groupName)}/${encodeURIComponent(svc.name)}`} className="tile-name" style={{ display: 'block' }}>{svc.name}</Link>
        {(svc.app || svc.description) && (
          <div className="tile-app" title={svc.description || undefined}>{svc.app}{svc.app && svc.description ? ' — ' : ''}{svc.description}</div>
        )}
      </div>
      <div className="tile-actions">
        {svc.href && (
          <button className="icon-btn accent-on-hover" title="Open in new tab" aria-label={`Open ${svc.name}`} onClick={launch}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        )}
      </div>
      {menu && <Menu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </article>
  );
}

/* ---------------- services launcher (draggable groups + tiles) ---------------- */
function HubGroup({ g, handle }: { g: ServicesDoc['groups'][number]; handle: ReactNode }) {
  const { layout, setLayout } = useLayout();
  const saved = layout?.services?.order?.[g.name];
  const ids = useMemo(() => {
    const names = g.services.map((s) => s.name);
    if (!saved) return names;
    const ordered = saved.filter((n) => names.includes(n));
    return [...ordered, ...names.filter((n) => !ordered.includes(n))];
  }, [g.services, saved]);
  const byName = useMemo(() => new Map(g.services.map((s) => [s.name, s])), [g.services]);
  if (!g.services.length) return null;
  return (
    <section className="svc-group">
      <div className="svc-group-head">
        {handle}
        <h2 className="svc-group-name">{g.name}</h2>
        {g.description && <span className="svc-group-desc">{g.description}</span>}
        <Link className="section-link" to="/services">All {g.services.length} →</Link>
      </div>
      <Sortable
        ids={ids}
        onReorder={(next) => setLayout({ services: { order: { [g.name]: next } } })}
        className="tile-grid"
        renderItem={(id, ctx) => <ServiceTile svc={byName.get(id)!} groupName={g.name} handle={ctx.handle} />}
      />
    </section>
  );
}

function HubServices({ data }: { data: ServicesDoc | null }) {
  const { layout, setLayout } = useLayout();
  const groups = data?.groups ?? [];
  const ids = useMemo(() => {
    const names = groups.map((g) => g.name);
    const saved = (layout?.services?.groupOrder || []).filter((n) => names.includes(n));
    return [...saved, ...names.filter((n) => !saved.includes(n))];
  }, [groups, layout?.services?.groupOrder]);
  const byName = useMemo(() => new Map(groups.map((g) => [g.name, g])), [groups]);
  if (!groups.length) {
    return <ProviderNote status="unconfigured" reason="No services configured yet." fixHref="/settings/services" fixLabel="Add services →" />;
  }
  return (
    <Sortable
      ids={ids}
      onReorder={(next) => setLayout({ services: { groupOrder: next } })}
      className="hub-groups"
      renderItem={(id, ctx) => <HubGroup g={byName.get(id)!} handle={ctx.handle} />}
    />
  );
}

/* ---------------- widget shell for the rail ---------------- */
function Widget({ id, title, right, handle, children }: { id: string; title: string; right?: ReactNode; handle?: ReactNode; children: ReactNode }) {
  const { layout, setLayout } = useLayout();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const size = (layout?.hub?.sizes?.[id] ?? 'md') as LayoutDoc['hub']['sizes'][string];
  return (
    <section className="widget" aria-label={title}>
      <div className="widget-head">
        <span className="widget-title">
          {handle}
          {title}
        </span>
        <span style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          {right}
          <button
            className="icon-btn"
            aria-label={`${title} options`}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: Math.min(r.right - 180, window.innerWidth - 196), y: r.bottom + 6 }); }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
          </button>
        </span>
      </div>
      {children}
      {menu && (
        <Menu
          x={menu.x} y={menu.y} onClose={() => setMenu(null)}
          items={[
            { label: `Size: ${size.toUpperCase()} (click to cycle)`, action: () => setLayout({ hub: { sizes: { [id]: ({ sm: 'md', md: 'lg', lg: 'sm' } as const)[size] } } }) },
            { label: 'Hide from Hub', action: () => setLayout({ hub: { hidden: [...(layout?.hub?.hidden || []), id] } }) },
          ]}
        />
      )}
    </section>
  );
}

/* ---------------- individual widgets ---------------- */
function WeatherWidget({ handle }: { handle?: ReactNode }) {
  const { data, error } = usePolled<WeatherDoc>('/api/weather', 15 * 60_000);
  if (!data || data.status !== 'ok') {
    return (
      <Widget id="weather" title="Weather" handle={handle}>
        <ProviderNote compact status={data?.status || (error ? 'error' : 'idle')} reason={data?.reason || error} fixHref="/settings/integrations" fixLabel="Set location →" />
      </Widget>
    );
  }
  const c = data.current!;
  return (
    <Widget id="weather" title={data.place || 'Weather'} handle={handle}>
      <div className="wx-now">
        <div>
          <div className="wx-temp">{Math.round(c.tempC)}<sup>°{data.units === 'f' ? 'F' : 'C'}</sup></div>
          <div className="wx-cond">{c.label} · feels {Math.round(c.feelsC)}° · {c.windKph} km/h{data.today?.highC != null ? ` · H ${Math.round(data.today.highC)}° L ${Math.round(data.today.lowC!)}°` : ''}</div>
        </div>
        <span className="wx-hero-ico"><Icon ref={`lucide:${weatherIcon(c.code, c.isDay)}`} name={c.label} size={44} plain /></span>
      </div>
      {data.forecast && data.forecast.length > 1 && (
        <div className="wx-forecast">
          {data.forecast.slice(1, 5).map((f) => (
            <div className="wx-day" key={f.date}>
              <div className="d">{f.label}</div>
              <Icon ref={`lucide:${weatherIcon(f.code ?? 3, true)}`} name={String(f.code)} size={17} plain />
              <div className="hi">{f.highC != null ? Math.round(f.highC) + '°' : '—'}</div>
              <div className="lo">{f.lowC != null ? Math.round(f.lowC) + '°' : ''}</div>
            </div>
          ))}
        </div>
      )}
    </Widget>
  );
}
// icon names verified against the bundled lucide collection (offline-safe)
const weatherIcon = (code: number | null, isDay: boolean) =>
  code == null ? 'cloud'
    : code === 0 ? (isDay ? 'sun' : 'moon')
      : code === 1 ? (isDay ? 'sun-dim' : 'moon')
        : code === 2 ? 'cloud-sun'
          : code === 3 ? 'cloud'
            : code < 50 ? 'cloud-fog'
              : code < 58 ? 'cloud-drizzle'
                : code < 66 ? 'cloud-rain'
                  : code < 68 ? 'cloud-hail'
                    : code < 78 ? 'cloud-snow'
                      : code < 83 ? 'cloud-rain'
                        : code < 87 ? 'snowflake'
                          : 'cloud-lightning';

interface MarketRow { symbol: string; status: string; price?: number; change?: number | null; changePct?: number | null; spark?: number[] | null }
function MarketsWidget({ handle }: { handle?: ReactNode }) {
  const { layout } = useLayout();
  const { data, error } = usePolled<{ status: string; reason?: string; items: MarketRow[]; fetchedAt?: number }>('/api/market', 5 * 60_000);
  const size = layout?.hub?.sizes?.markets ?? 'md';
  const cap = size === 'sm' ? 3 : size === 'lg' ? 12 : 6;
  if (!data || data.status === 'unconfigured') {
    return (
      <Widget id="markets" title="Markets" handle={handle}>
        <ProviderNote compact status={data?.status || 'idle'} reason={data?.reason || 'Add tickers to build a watchlist.'} fixHref="/settings/integrations" fixLabel="Add symbols →" />
      </Widget>
    );
  }
  if (data.status === 'unavailable' || data.status === 'error') {
    return <Widget id="markets" title="Markets" handle={handle}><ProviderNote compact status={data.status} reason={data.reason || error} /></Widget>;
  }
  return (
    <Widget id="markets" title="Markets" handle={handle} right={<Freshness at={data.fetchedAt ?? null} />}>
      {data.items.slice(0, cap).map((m) => {
        const chg = m.changePct;
        const cls = chg == null ? 'flat' : chg > 0.05 ? 'up' : chg < -0.05 ? 'down' : 'flat';
        return (
          <div className="mkt-row" key={m.symbol}>
            <span className="mkt-sym">{m.symbol}</span>
            <span className="mkt-px">
              {m.status === 'ok' ? m.price?.toLocaleString('en', { maximumFractionDigits: 2 }) ?? '—' : <span className="stale-note">Unavailable</span>}
              {chg != null && <span className={`mkt-chg ${cls}`}>{chg > 0 ? '+' : ''}{chg.toFixed(2)}%</span>}
            </span>
            <span className="mkt-spark">
              {m.spark ? <Sparkline values={m.spark} color={cls === 'down' ? 'var(--fail)' : cls === 'up' ? 'var(--ok)' : 'var(--accent)'} /> : <span className="stale-note">—</span>}
            </span>
          </div>
        );
      })}
      {!data.items.length && <div className="stale-note">No symbols resolved.</div>}
    </Widget>
  );
}

function NewsWidget({ handle }: { handle?: ReactNode }) {
  const { layout } = useLayout();
  const { data } = usePolled<NewsDoc>('/api/news', 10 * 60_000);
  const size = layout?.hub?.sizes?.news ?? 'md';
  const cap = size === 'sm' ? 3 : size === 'lg' ? 10 : 5;
  if (!data) return <Widget id="news" title="News" handle={handle}><ProviderNote compact status="idle" reason="Loading feeds…" /></Widget>;
  if (data.status === 'unconfigured') {
    return <Widget id="news" title="News" handle={handle}><ProviderNote compact status="unconfigured" fixHref="/settings/integrations" fixLabel="Add feeds →" /></Widget>;
  }
  return (
    <Widget id="news" title="News" handle={handle} right={<Freshness at={data.fetchedAt ?? null} error={data.status === 'error' ? 'unreachable' : null} />}>
      {data.status === 'error'
        ? <ProviderNote compact status="error" reason={data.reason || 'All feeds failed.'} fixHref="/settings/integrations" fixLabel="Review feeds →" />
        : (
          <div>
            {data.items.slice(0, cap).map((n, i) => {
              // the server blanks non-http(s) links; render those as plain text, never <a href="">
              const inner = (
                <>
                  <span className="n-title">{n.title}</span>
                  <span className="n-meta">
                    <span className="n-src">{n.source}</span>
                    {n.publishedAt && <span>· {relTime(new Date(n.publishedAt).getTime())}</span>}
                  </span>
                </>
              );
              return n.link ? (
                <a className="news-item" key={n.link + i} href={n.link} target="_blank" rel="noreferrer">{inner}</a>
              ) : (
                <span className="news-item" key={`nolink-${i}`}>{inner}</span>
              );
            })}
            {!data.items.length && <div className="unavailable"><span className="why">Feeds are reachable but empty right now.</span></div>}
          </div>
        )}
    </Widget>
  );
}

function ActivityWidget({ handle }: { handle?: ReactNode }) {
  const { layout } = useLayout();
  const { data } = usePolled<{ items: ActivityEvent[] }>('/api/activity?limit=12', 60_000);
  const size = layout?.hub?.sizes?.activity ?? 'md';
  const cap = size === 'sm' ? 3 : size === 'lg' ? 9 : 5;
  const items = (data?.items || []).slice(0, cap);
  return (
    <Widget id="activity" title="Recent activity" handle={handle} right={<Link className="section-link" to="/activity">All →</Link>}>
      {items.length ? (
        <div className="hub-act">
          {items.map((e) => (
            <div className="ha-row" key={e.id}>
              <span className="ha-t">{relTime(e.t)}</span>
              <span className="ha-msg">{e.subject && <b>{e.subject}</b>} {humanEvent(e)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="stale-note">Nothing has happened yet — OpusHub only records real events.</div>
      )}
    </Widget>
  );
}

function BookmarksWidget({ handle }: { handle?: ReactNode }) {
  const { data, error } = usePolled<{ groups: { name: string; items: { name: string; href: string; description?: string | null }[] }[] }>('/api/bookmarks', 0);
  const groups = (data?.groups || []).filter((g) => g.items.length);
  if (!groups.length) {
    return (
      <Widget id="bookmarks" title="Bookmarks" handle={handle}>
        <ProviderNote compact status={error ? 'error' : 'unconfigured'} reason={error || 'No bookmarks yet.'} fixHref="/settings/bookmarks" fixLabel="Add links →" />
      </Widget>
    );
  }
  return (
    <Widget id="bookmarks" title="Bookmarks" handle={handle} right={<Link className="section-link" to="/settings/bookmarks">Edit →</Link>}>
      {groups.map((g) => (
        <div key={g.name} style={{ marginBottom: 8 }}>
          {groups.length > 1 && <div className="micro-label" style={{ margin: '2px 0 4px' }}>{g.name}</div>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {g.items.map((b, i) => (
              <a key={i} className="chip" href={b.href} target="_blank" rel="noreferrer" title={b.description || undefined}>{b.name}</a>
            ))}
          </div>
        </div>
      ))}
    </Widget>
  );
}

/* ---------------- main-column section ---------------- */
function MainSection({ id, title, ctx, right, children }: { id: string; title: string; ctx: SortableCtx; right?: ReactNode; children: ReactNode }) {
  const { setLayout, layout } = useLayout();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <section className="hub-section" aria-label={title}>
      <div className="hub-section-head">
        {ctx.handle}
        <h2 className="section-title">{title}</h2>
        <span className="section-aside">
          {right}
          <button className="icon-btn" aria-label={`${title} options`} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 190, y: r.bottom + 6 }); }}>
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
          </button>
        </span>
      </div>
      {children}
      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { label: 'Hide from Hub', action: () => setLayout({ hub: { hidden: [...(layout?.hub?.hidden || []), id] } }) },
        ] as MenuItem[]} />
      )}
    </section>
  );
}

/* ---------------- page ---------------- */
const RAIL_WIDGETS: Record<string, (h: { handle?: ReactNode }) => ReactNode> = {
  weather: WeatherWidget,
  markets: MarketsWidget,
  news: NewsWidget,
  bookmarks: BookmarksWidget,
  activity: ActivityWidget,
};

function resolveIds(stored: string[], all: string[], hidden: string[]): string[] {
  const known = new Set(all);
  const kept = stored.filter((w) => known.has(w) && !hidden.includes(w));
  const missing = all.filter((w) => !stored.includes(w) && !hidden.includes(w));
  return [...kept, ...missing];
}

export default function Hub() {
  const { settings } = useSettings();
  const { layout, setLayout } = useLayout();
  const sysQ = usePolled<SystemSnapshot>('/api/system', (settings?.behavior?.refresh?.system ?? 5) * 1000);
  const svcQ = usePolled<ServicesDoc>('/api/services', (settings?.behavior?.refresh?.services ?? 30) * 1000);

  const hidden = layout?.hub?.hidden || [];
  // known widgets that the stored layout has never heard of are appended, not dropped
  const railIds = resolveIds(layout?.hub?.rail || [], Object.keys(RAIL_WIDGETS), hidden);
  const mainIds = resolveIds(layout?.hub?.main || ['overview', 'services'], ['overview', 'services'], hidden);
  const hiddenRail = Object.keys(RAIL_WIDGETS).filter((w) => hidden.includes(w));
  const hiddenMain = ['overview', 'services'].filter((w) => hidden.includes(w));

  const openSearch = () => window.dispatchEvent(new CustomEvent('opushub:open-search'));

  return (
    <>
      <div className="hub-top">
        <div>
          <h1 className="greeting">{greeting(settings?.hub?.greetingName || null)}</h1>
          <div className="greet-meta">
            <StatusDot state={svcQ.data?.live ? 'up' : 'unavailable'} title={svcQ.data?.statusReason || undefined} />
            <span>
              {svcQ.data
                ? `${svcQ.data.groups.reduce((a, g) => a + g.services.length, 0)} services · ${svcQ.data.live ? 'status live' : 'status unavailable'}`
                : sysQ.error ? 'host metrics unreachable' : 'reading host…'}
            </span>
            <span>·</span>
            <span>week {isoWeek()}</span>
          </div>
        </div>
        <Clock />
      </div>

      <SetupBanner sys={sysQ.data} services={svcQ.data} />

      <div className="hub-search">
        <button className="hub-search-trigger" onClick={openSearch} aria-label="Search OpusHub">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" strokeLinecap="round" /></svg>
          <span className="grow">Search services, stacks, pages, news…</span>
          <kbd className="kbd">/</kbd>
        </button>
      </div>

      <div className="hub-grid">
        <div className="hub-col-main">
          <Sortable
            ids={mainIds}
            onReorder={(next) => setLayout({ hub: { main: next } })}
            className="hub-main-stack"
            renderItem={(id, ctx) =>
              id === 'overview' ? (
                <MainSection id="overview" title="This machine" ctx={ctx} right={<Freshness at={sysQ.fetchedAt} error={sysQ.error} />}>
                  <OverviewStrip sys={sysQ.data} />
                </MainSection>
              ) : (
                <MainSection id="services" title="Services" ctx={ctx} right={<Link className="section-link" to="/services">Directory →</Link>}>
                  <HubServices data={svcQ.data} />
                </MainSection>
              )}
          />
          {hiddenMain.map((w) => (
            <button key={w} className="chip" style={{ marginTop: 10 }} onClick={() => setLayout({ hub: { hidden: hidden.filter((h) => h !== w) } })}>
              + show {w}
            </button>
          ))}
        </div>

        <aside className="hub-col-rail">
          <Sortable
            ids={railIds}
            onReorder={(next) => setLayout({ hub: { rail: mergeRail(next, layout) } })}
            className="hub-rail-stack"
            renderItem={(id, ctx) => {
              const W = RAIL_WIDGETS[id];
              return <W handle={ctx.handle} />;
            }}
          />
          {hiddenRail.length > 0 && (
            <div style={{ marginTop: 'var(--sp-6)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="stale-note">hidden:</span>
              {hiddenRail.map((w) => (
                <button key={w} className="chip" onClick={() => setLayout({ hub: { hidden: hidden.filter((h) => h !== w) } })}>
                  + {w}
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

/** Keep hidden widgets in their original slots when the visible ones are reordered. */
function mergeRail(dropped: string[], layout: LayoutDoc | null): string[] {
  const hidden = layout?.hub?.hidden || [];
  const rail = layout?.hub?.rail || [];
  const out: string[] = [];
  let i = 0;
  for (const w of rail) {
    if (hidden.includes(w)) out.push(w);
    else if (i < dropped.length) out.push(dropped[i++]);
  }
  while (i < dropped.length) out.push(dropped[i++]);
  return out;
}

function isoWeek(d = new Date()): number {
  // ISO 8601 week — the year of week 1's Thursday anchors the count
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}
