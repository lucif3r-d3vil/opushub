// The widget renderers.
//
// One component per catalogue type. Each one picks the *form* the information wants — a clock is
// typography, weather is atmospheric, news is a list, markets a compact table, system a status
// strip, activity a timeline — instead of the same bordered card repeated fifteen times.
//
// Two hard rules hold everywhere in this file:
//   1. no invented values — a provider that is not configured or not reachable renders its own
//      honest state, and a metric that does not exist is never shown as a number;
//   2. one failed provider only degrades its own widget.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type {
  ActivityEvent, LayoutDoc, MarketItem, NewsDoc, Service, ServicesDoc, StacksDoc, SystemSnapshot,
  WeatherDoc, WidgetCatalogueEntry, WidgetInstance,
} from '../../lib/types';
import type { DeepPartial } from '../../lib/theme';
import { bytes, num, pct, relTime, uptime } from '../../lib/format';
import { humanEvent } from '../../lib/events';
import { useSettings } from '../../lib/theme';
import { Icon } from '../Icon';
import { MeterBar, Sparkline } from '../Charts';
import { Freshness, ProviderNote, StatusDot, STATUS_WORDS } from '../ui';
import { WidgetEmpty } from './WidgetFrame';
import { ServiceLauncher } from './ServiceLauncher';
import type { HubData } from '../../lib/hubData';

export interface WidgetProps {
  widget: WidgetInstance;
  data: HubData;
  layout: LayoutDoc | null;
  interactive: boolean;
  onLayoutChange?: (patch: DeepPartial<LayoutDoc>) => void;
  /** clock only: preview surfaces tick locally instead of waiting for the page */
  now?: Date;
}

/* ---------------- system: a subtle status strip ---------------- */

function SystemStrip({ widget, data }: WidgetProps) {
  const { system } = data;
  const sys: SystemSnapshot | null = system.data;
  const size = widget.size;
  const state = system.error ? 'error' : sys ? 'ok' : 'idle';
  if (state === 'error') return <ProviderNote compact status="error" reason="Host metrics are unreadable right now." details={system.error} />;
  if (!sys) return <div className="widget-quiet" role="status">Sampling this host…</div>;
  return <SystemStripData sys={sys} size={size} at={system.fetchedAt} error={system.error} />;
}

function SystemStripData({ sys, size, at, error }: { sys: SystemSnapshot; size: string; at: number | null; error: string | null }) {
  const mem = sys.memory;
  const memPct = mem ? 100 * (1 - mem.available / mem.total) : null;
  const cpu = sys.cpu?.usage ?? null;
  if (cpu == null && !mem && !sys.disks.length) {
    return <ProviderNote compact status="unavailable" reason="This host exposes no CPU or memory counters." />;
  }
  const disks = sys.disks || [];
  const busiest = [...disks].sort((a, b) => b.used / b.total - a.used / a.total)[0];
  const rx = sys.network.reduce((a, n) => a + (n.rxPerSec ?? 0), 0) || null;
  const tx = sys.network.reduce((a, n) => a + (n.txPerSec ?? 0), 0) || null;
  const temp = sys.cpu?.temperature?.[0]?.celsius ?? null;
  const load = sys.cpu?.load1 ?? null;

  const cells: { key: string; label: string; value: ReactNode; sub?: ReactNode; meter?: number | null }[] = [
    { key: 'cpu', label: 'CPU', value: cpu == null ? '—' : pct(cpu), sub: load != null ? `load ${num(load, 2)}` : `${sys.cpu.cores} cores`, meter: cpu },
    ...(mem ? [{ key: 'mem', label: 'Memory', value: pct(memPct!), sub: `${bytes(mem.available)} free`, meter: memPct }] : []),
    ...(size !== 'sm' && busiest
      ? [{ key: 'disk', label: 'Storage', value: pct(100 * (busiest.used / busiest.total)), sub: `${busiest.mount} · ${bytes(busiest.total - busiest.used)} free`, meter: 100 * (busiest.used / busiest.total) }]
      : []),
    ...(size === 'lg' && rx != null
      ? [{ key: 'net', label: 'Network', value: bytes(rx, true), sub: `${tx != null ? bytes(tx, true) : '—'} out`, meter: null }]
      : []),
    ...(size !== 'sm' && temp != null ? [{ key: 'temp', label: 'Temp', value: `${Math.round(temp)}°`, sub: sys.cpu.temperature?.[0]?.label || 'sensor', meter: null }] : []),
    { key: 'up', label: 'Uptime', value: <span className="sys-uptime">{uptime(sys.host.uptimeSec)}</span>, sub: sys.host.hostname },
  ];

  return (
    <div className={`sys-strip${size === 'sm' ? ' sys-strip--sm' : ''}`} role="group" aria-label="Host summary">
      {cells.map((c) => (
        <div className="sys-cell" key={c.key}>
          <span className="sys-k">{c.label}</span>
          <span className="sys-v">{c.value}</span>
          {size !== 'sm' && c.meter !== undefined && c.meter !== null && <MeterBar value={c.meter} />}
          <span className="sys-sub">{c.sub}{error ? ' · stale' : ''}</span>
        </div>
      ))}
      <span className="sys-fresh"><Freshness at={at} error={error} /></span>
    </div>
  );
}

/* ---------------- stacks: hairline rows ---------------- */

function StacksWidget({ widget, data, interactive }: WidgetProps) {
  const doc: StacksDoc | null = data.stacks.data;
  const cap = widget.size === 'sm' ? 4 : 7;
  if (!doc) return <div className="widget-quiet" role="status">Reading stacks…</div>;
  if (!doc.live) return <WidgetEmpty>Docker isn't connected, so stacks can't be read.</WidgetEmpty>;
  if (!doc.stacks.length) return <WidgetEmpty href="/stacks" linkLabel="Stack overview →">No compose projects on this engine yet.</WidgetEmpty>;
  return (
    <ul className="hub-stack-list">
      {doc.stacks.slice(0, cap).map((s) => {
        // compact real state: counts only, no invented detail; attention/unhealthy only when non-zero
        const bits = [`${s.containerCount} container${s.containerCount === 1 ? '' : 's'}`, `${s.runningCount} running`];
        if (s.unhealthyCount) bits.push(`${s.unhealthyCount} unhealthy`);
        if (s.attentionCount) bits.push(`${s.attentionCount} attention`);
        if (s.stoppedCount && !s.runningCount) bits.push(`${s.stoppedCount} stopped`);
        return (
          <li key={s.id}>
            <Link to={`/stacks/${encodeURIComponent(s.id)}`} className="hub-stack-row">
              <StatusDot state={s.status} title={s.statusReason || STATUS_WORDS[s.status] || s.status} />
              <span className="grow">
                <span className="title">{s.displayName || s.name}</span>
                <span className="sub">{bits.join(' · ')}</span>
              </span>
              <span className="hub-stack-go" aria-hidden="true">→</span>
            </Link>
          </li>
        );
      })}
      {doc.stacks.length > cap && interactive && (
        <li><Link className="section-link" to="/stacks">+{doc.stacks.length - cap} more →</Link></li>
      )}
    </ul>
  );
}

/* ---------------- attention: only what is not running ---------------- */

/** What actually needs attention — real conditions only, one row per fact:
 *  unhealthy · stopped · paused · restarting containers, plus providers that failed.
 *  Minor technicalities stay off the Hub; this answers “what needs me?” and nothing else. */
function AttentionWidget({ widget, data }: WidgetProps) {
  const doc: ServicesDoc | null = data.services.data;
  const cap = widget.size === 'sm' ? 4 : 8;
  const list = useMemo(() => {
    if (!doc) return [];
    return (doc.services ?? []).filter((s) => !s.hidden && ['down', 'unhealthy', 'attention', 'paused', 'restarting'].includes(String(s.status)));
  }, [doc]);
  const providerIssues = useMemo(() => {
    const provs = data.providers?.data?.providers || [];
    return provs.filter((p) => p.state === 'unavailable' || p.state === 'degraded');
  }, [data.providers]);
  if (!doc) return <div className="widget-quiet" role="status">Checking service state…</div>;
  if (!doc.live && !providerIssues.length) return <WidgetEmpty>Docker isn't connected — nothing to compare against.</WidgetEmpty>;
  if (!list.length && !providerIssues.length) return <WidgetEmpty>Everything discovered is running. This stays quiet until something isn't.</WidgetEmpty>;
  const total = list.length + providerIssues.length;
  return (
    <ul className="hub-attention">
      {list.slice(0, cap).map((s) => (
        <li key={s.name}>
          <Link to={`/services/${encodeURIComponent(s.group || 'Other')}/${encodeURIComponent(s.name)}`} className="hub-attention-row">
            <StatusDot state={s.status} title={STATUS_WORDS[s.status] || s.status} />
            <span className="grow">
              <span className="title">{s.displayName}</span>
              <span className="sub">{STATUS_WORDS[s.status] || s.status}{s.stack ? ` · ${s.stackDisplayName || s.stack}` : ''}</span>
            </span>
          </Link>
        </li>
      ))}
      {providerIssues.slice(0, Math.max(0, cap - list.length) || 2).map((p) => (
        <li key={`prov-${p.name}`}>
          <Link to="/settings/environment" className="hub-attention-row">
            <StatusDot state={p.state === 'degraded' ? 'degraded' : 'down'} title={p.state} />
            <span className="grow">
              <span className="title">{p.name[0].toUpperCase() + p.name.slice(1)} provider</span>
              <span className="sub">{p.state === 'degraded' ? 'degraded' : 'unavailable'}{p.reason ? ` · ${p.reason}` : ''}</span>
            </span>
          </Link>
        </li>
      ))}
      {total > cap && <li><Link className="section-link" to="/services">+{total - cap} more →</Link></li>}
    </ul>
  );
}

/* ---------------- clock: mostly typography ---------------- */

function ClockWidget({ widget, now: provided }: WidgetProps) {
  const { settings } = useSettings();
  const [now, setNow] = useState(() => provided || new Date());
  const secs = !!settings?.hub.showSeconds;
  useEffect(() => {
    if (provided) { setNow(provided); return; }
    const t = window.setInterval(() => setNow(new Date()), secs ? 1000 : 15_000);
    return () => clearInterval(t);
  }, [secs, provided]);
  const hour12 = !(settings?.hub.clock24h ?? false);
  return (
    <div className={`hub-clock${widget.size === 'sm' ? ' hub-clock--sm' : ''}`}>
      <div className="hub-clock-time">
        {now.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', second: secs ? '2-digit' : undefined, hour12 })}
      </div>
      <div className="hub-clock-date">{now.toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      {widget.size !== 'sm' && <div className="hub-clock-extra">week {isoWeek(now)} · {now.getFullYear()}</div>}
    </div>
  );
}

function isoWeek(d: Date): number {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

/* ---------------- weather: a compact atmospheric element ---------------- */

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

function WeatherWidget({ widget, data }: WidgetProps) {
  const w: WeatherDoc | null = data.weather.data;
  if (!w) {
    if (data.weather.error) return <ProviderNote compact status="error" reason="The weather service didn't answer." details={data.weather.error} />;
    return <div className="widget-quiet" role="status">Looking outside…</div>;
  }
  if (w.status !== 'ok' || !w.current) {
    return (
      <ProviderNote
        compact
        status={w.status}
        reason={w.reason || (w.status === 'unconfigured' ? 'No location configured yet.' : undefined)}
        fixHref={w.status === 'unconfigured' ? '/settings/integrations' : undefined}
        fixLabel="Set a location →"
      />
    );
  }
  const c = w.current;
  const unit = w.units === 'f' ? 'F' : 'C';
  return (
    <div className={`wx${widget.size === 'sm' ? ' wx--sm' : ''}`}>
      <div className="wx-row">
        <div className="wx-temp">{Math.round(c.tempC)}<sup>°{unit}</sup></div>
        <span className="wx-hero-ico"><Icon ref={`lucide:${weatherIcon(c.code, c.isDay)}`} name={c.label} size={widget.size === 'sm' ? 34 : 44} plain /></span>
      </div>
      <div className="wx-cond">{c.label}{w.today?.highC != null ? ` · H ${Math.round(w.today.highC)}° L ${Math.round(w.today.lowC ?? w.today.highC)}°` : ''}</div>
      {widget.size !== 'sm' && (
        <div className="wx-strip">
          <span>feels {Math.round(c.feelsC)}°</span>
          <span>{c.windKph} km/h</span>
          <span>{c.humidity}% humidity</span>
          {w.today?.precipChance != null && <span>{w.today.precipChance}% rain</span>}
        </div>
      )}
      {widget.size !== 'sm' && (w.forecast?.length || 0) > 1 && (
        <div className="wx-forecast">
          {w.forecast!.slice(1, 5).map((f) => (
            <div className="wx-day" key={f.date}>
              <div className="d">{f.label}</div>
              <Icon ref={`lucide:${weatherIcon(f.code ?? 3, true)}`} name={String(f.code)} size={17} plain />
              <div className="hi">{f.highC != null ? `${Math.round(f.highC)}°` : '—'}</div>
              <div className="lo">{f.lowC != null ? Math.round(f.lowC) + '°' : ''}</div>
            </div>
          ))}
        </div>
      )}
      <div className="wx-place">{w.place || 'configured location'}</div>
    </div>
  );
}

/* ---------------- news: a list, never article cards ---------------- */

function NewsWidget({ widget, data }: WidgetProps) {
  const doc: NewsDoc | null = data.news.data;
  const cap = widget.size === 'sm' ? 4 : widget.size === 'lg' ? 10 : 6;
  if (!doc) {
    if (data.news.error) return <ProviderNote compact status="error" reason="News feeds didn't answer." details={data.news.error} />;
    return <div className="widget-quiet" role="status">Reading feeds…</div>;
  }
  if (doc.status === 'unconfigured') {
    return <ProviderNote compact status="unconfigured" reason="No feeds have been added." fixHref="/settings/integrations" fixLabel="Add feeds →" />;
  }
  if (doc.status === 'error' || (!doc.items.length && doc.errors?.length)) {
    return <ProviderNote compact status="error" reason={doc.reason || 'Every feed failed to load.'} fixHref="/settings/integrations" fixLabel="Review feeds →" details={doc.errors?.map((e) => `${e.name || e.url}: ${e.error}`).join('\n')} />;
  }
  if (!doc.items.length) return <WidgetEmpty href="/settings/integrations" linkLabel="Feeds →">Feeds are reachable but carry nothing right now.</WidgetEmpty>;
  return (
    <>
      <ul className="news-list">
        {doc.items.slice(0, cap).map((n, i) => {
          const inner = (
            <>
              <span className="n-title">{n.title}</span>
              <span className="n-meta">
                {n.source && <span className="n-src">{n.source}</span>}
                {n.publishedAt && <span>{relTime(new Date(n.publishedAt).getTime())}</span>}
              </span>
            </>
          );
          // the server blanks non-http(s) links — those render as text, never as an empty <a>
          return n.link
            ? <li key={`${n.link}-${i}`}><a className="news-item" href={n.link} target="_blank" rel="noreferrer">{inner}</a></li>
            : <li key={`nolink-${i}`}><span className="news-item">{inner}</span></li>;
        })}
      </ul>
      {(doc.status === 'partial' || doc.errors?.length) && (
        <div className="widget-quiet">{doc.errors?.length} feed{doc.errors?.length === 1 ? '' : 's'} unreachable · <Link className="section-link" to="/settings/integrations">review</Link></div>
      )}
    </>
  );
}

/* ---------------- markets: a compact table ---------------- */

function MarketsWidget({ widget, data }: WidgetProps) {
  const doc = data.markets.data;
  const cap = widget.size === 'sm' ? 4 : widget.size === 'lg' ? 12 : 7;
  if (!doc) {
    if (data.markets.error) return <ProviderNote compact status="error" reason="The quote provider didn't answer." details={data.markets.error} />;
    return <div className="widget-quiet" role="status">Reading quotes…</div>;
  }
  if (doc.status === 'unconfigured') {
    return <ProviderNote compact status="unconfigured" reason="No symbols in the watchlist yet." fixHref="/settings/integrations" fixLabel="Add symbols →" />;
  }
  if (doc.status === 'unavailable' || doc.status === 'error') {
    return <ProviderNote compact status={doc.status} reason={doc.reason || 'Quotes are unavailable right now.'} />;
  }
  if (!doc.items.length) return <ProviderNote compact status="unavailable" reason="No symbols resolved to quotes." />;
  return (
    <table className="mkt-table">
      <thead>
        <tr><th scope="col">Symbol</th><th scope="col" className="num">Last</th><th scope="col" className="num">Change</th><th scope="col" aria-label="Trend" /></tr>
      </thead>
      <tbody>
        {doc.items.slice(0, cap).map((m) => <MarketRow key={m.symbol} m={m} />)}
      </tbody>
    </table>
  );
}

function MarketRow({ m }: { m: MarketItem }) {
  const chg = m.changePct ?? null;
  const dir = chg == null ? 'flat' : chg > 0.05 ? 'up' : chg < -0.05 ? 'down' : 'flat';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·';
  const price = m.status === 'ok' && m.price != null ? m.price.toLocaleString('en', { maximumFractionDigits: 2 }) : null;
  return (
    <tr>
      <td className="mkt-sym">{m.symbol}</td>
      <td className="num">{price ?? <span className="stale-note">n/a</span>}</td>
      <td className={`num mkt-chg ${dir}`}>{chg == null ? <span className="stale-note">—</span> : `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`}</td>
      <td className="mkt-spark">
        {m.spark?.length ? <Sparkline values={m.spark} width={54} height={18} color={dir === 'down' ? 'var(--fail)' : dir === 'up' ? 'var(--ok)' : 'var(--accent)'} />
          : <span className={`mkt-arrow ${dir}`} aria-hidden="true">{arrow}</span>}
      </td>
    </tr>
  );
}

/* ---------------- bookmarks: quiet chips, grouped ---------------- */

function BookmarksWidget({ widget, data }: WidgetProps) {
  const doc = data.bookmarks.data;
  const wanted = typeof widget.config?.group === 'string' ? String(widget.config.group).toLowerCase() : null;
  const groups = (doc?.groups || [])
    .filter((g) => g.items.length)
    .filter((g) => !wanted || g.name.toLowerCase() === wanted);
  if (!doc) return <div className="widget-quiet" role="status">Reading bookmarks…</div>;
  if (!groups.length) {
    return (
      <ProviderNote
        compact
        status="unconfigured"
        reason={wanted ? `No links filed under “${widget.config.group}”.` : 'No bookmarks yet — flat links to the places you keep visiting.'}
        fixHref="/settings/bookmarks"
        fixLabel="Add links →"
      />
    );
  }
  return (
    <div className="bm">
      {groups.map((g) => (
        <div className="bm-group" key={g.name}>
          {groups.length > 1 && <div className="micro-label">{g.name}</div>}
          <div className="bm-items">
            {g.items.slice(0, widget.size === 'sm' ? 8 : 24).map((b, i) => (
              <a key={i} className="chip" href={b.href} target="_blank" rel="noreferrer" title={b.description || undefined}>{b.name}</a>
            ))}
          </div>
        </div>
      ))}
      <Link className="section-link" to="/settings/bookmarks">Edit bookmarks →</Link>
    </div>
  );
}

/* ---------------- activity: a compact timeline ---------------- */

function ActivityWidget({ widget, data, interactive }: WidgetProps) {
  const doc = data.activity.data;
  const cap = widget.size === 'sm' ? 4 : widget.size === 'lg' ? 10 : 6;
  const sources = Array.isArray(widget.config?.sources) ? (widget.config.sources as string[]) : null;
  const items: ActivityEvent[] = (doc?.items || [])
    .filter((e) => !sources?.length || sources.includes(e.source))
    .slice(0, cap);
  if (!doc) return <div className="widget-quiet" role="status">Reading activity…</div>;
  if (!items.length) {
    return <WidgetEmpty href="/activity" linkLabel="Activity log →">Nothing has happened yet — OpusHub only records real events.</WidgetEmpty>;
  }
  return (
    <>
      <ol className="hub-tl">
        {items.map((e) => (
          <li key={e.id} className="hub-tl-item">
            <span className={`hub-tl-dot hub-tl-dot--${eventTone(e)}`} aria-hidden="true" />
            <span className="hub-tl-text">
              {e.subject && <b>{e.subject}</b>} {humanEvent(e)}
            </span>
            <span className="hub-tl-when">{relTime(e.t)}</span>
          </li>
        ))}
      </ol>
      {interactive && <Link className="section-link hub-tl-more" to="/activity">Full activity →</Link>}
    </>
  );
}

function eventTone(e: ActivityEvent): string {
  if (e.source === 'docker') return e.type === 'container.exited' || e.type === 'container.removed' ? 'warn' : 'docker';
  if (e.source === 'config') return 'config';
  if (e.source === 'user') return 'user';
  return 'system';
}

/* ---------------- registry ---------------- */

export const WIDGET_RENDERERS: Record<string, (props: WidgetProps) => ReactNode> = {
  services: (p) => (
    <ServiceLauncher
      services={p.data.services.data}
      error={p.data.services.error}
      loading={p.data.services.loading}
      layout={p.layout}
      widget={p.widget}
      interactive={p.interactive}
      onLayoutChange={p.onLayoutChange}
    />
  ),
  system: SystemStrip,
  stacks: StacksWidget,
  attention: AttentionWidget,
  clock: ClockWidget,
  weather: WeatherWidget,
  news: NewsWidget,
  markets: MarketsWidget,
  bookmarks: BookmarksWidget,
  activity: ActivityWidget,
};

/** A layout.json from a newer build may name a type this bundle doesn't render. */
export function renderWidget(props: WidgetProps, catalogue: WidgetCatalogueEntry[]): ReactNode {
  const fn = WIDGET_RENDERERS[props.widget.type];
  if (fn) return fn(props);
  const known = catalogue.length === 0;
  return (
    <WidgetEmpty href="/settings/widgets" linkLabel="Widget settings →">
      {known ? 'This widget type is not available in this build.' : `“${props.widget.type}” isn't a widget this version knows.`}
    </WidgetEmpty>
  );
}

export type { Service };
