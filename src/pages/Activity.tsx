import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post, usePolled } from '../lib/api';
import { dayLabel, relTime, timeOfDay } from '../lib/format';
import type { ActivityEvent, ActivityGroup, AlertItem, AlertsDoc, EventCategory, EventSeverity } from '../lib/types';
import { PageHero, ProviderNote } from '../components/ui';
import { humanEvent, humanGroup } from '../lib/events';

const SOURCES = ['all', 'system', 'config', 'user', 'docker'] as const;
type Source = (typeof SOURCES)[number];

/** The log records a fixed, small vocabulary of types — offer the ones that exist, not a free-for-all. */
const TYPES = [
  { value: '', label: 'Any event' },
  { value: 'container', label: 'Containers' },
  { value: 'provider', label: 'Providers' },
  { value: 'stack', label: 'Stacks' },
  { value: 'service', label: 'Services' },
  { value: 'auth', label: 'Authentication' },
  { value: 'settings', label: 'Settings' },
  { value: 'layout', label: 'Layout' },
  // Phase 8 — operations are the first thing OpusHub can *do*, so they are worth filtering for
  { value: 'operation', label: 'Operations' },
];

const CATEGORIES: { value: '' | EventCategory; label: string }[] = [
  { value: '', label: 'All areas' },
  { value: 'service', label: 'Services' },
  { value: 'stack', label: 'Stacks' },
  { value: 'docker', label: 'Docker' },
  { value: 'system', label: 'System' },
  { value: 'security', label: 'Security' },
  { value: 'config', label: 'Configuration' },
  { value: 'storage', label: 'Storage' },
  { value: 'network', label: 'Network' },
  { value: 'power', label: 'Power' },
  { value: 'provider', label: 'Providers' },
];

const SEVERITIES: { value: '' | EventSeverity; label: string }[] = [
  { value: '', label: 'Any severity' },
  { value: 'notice', label: 'Notice and above' },
  { value: 'warning', label: 'Warnings' },
  { value: 'critical', label: 'Critical only' },
];

const SEV_DOT: Record<string, string> = { notice: 'sev-notice', warning: 'sev-warning', critical: 'sev-critical' };

const WINDOWS = [
  { label: 'Any time', ms: 0 },
  { label: 'Last hour', ms: 3600_000 },
  { label: 'Last 24h', ms: 24 * 3600_000 },
  { label: 'Last 7 days', ms: 7 * 24 * 3600_000 },
];
type Row = ActivityEvent | ActivityGroup;

const SOURCE_ICON: Record<string, string> = {
  'app.boot': 'M12 2v4M12 18v4M2 12h4M18 12h4',
  'settings.updated': 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  'layout.updated': 'M4 5h16M4 12h10M4 19h7',
  'services.updated': 'M4.5 4.5h6v6h-6zM13.5 13.5h6v6h-6z',
  'stacks.updated': 'm12 3 8.5 4.7L12 12.4 3.5 7.7zM3.5 12.5 12 17.2l8.5-4.7',
  'service.launch': 'M7 17 17 7M9 7h8v8',
  'bookmarks.updated': 'M7 4h10v16l-5-4-5 4z',
  'custom.updated': 'M8 6 3 12l5 6M16 6l5 6-5 6',
  'container.started': 'M5 3 19 12 5 21z',
  'container.exited': 'M6 6h12v12H6z',
  'container.health': 'M12 8v5M12 16.5v.01M12 3a9 9 0 1 0 9 9',
  'provider.unavailable': 'M12 8v5M12 16.5v.01M12 3a9 9 0 1 0 9 9',
  'provider.recovered': 'm5 13 4 4L19 7',
};

const isGroup = (r: Row): r is ActivityGroup => 'grouped' in r && (r as ActivityGroup).grouped === true;

interface ActivityDoc {
  items: Row[];
  total: number;
  matched?: number;
  watchingSince: number | null;
}

export default function ActivityPage() {
  // deep links from the command palette and the service/stack pages: /activity?service=wave
  const [params, setParams] = useSearchParams();
  const [source, setSource] = useState<Source>('all');
  const [service, setService] = useState(() => params.get('service') || '');
  const [stack, setStack] = useState(() => params.get('stack') || '');
  const [type, setType] = useState(() => params.get('type') || '');
  const [category, setCategory] = useState(() => params.get('category') || '');
  const [severity, setSeverity] = useState(() => params.get('severity') || '');
  const [windowMs, setWindowMs] = useState(() => Number(params.get('since')) || 0);
  const [open, setOpen] = useState<Set<string>>(new Set());

  // The window is pinned when it is chosen (not recomputed on every render) so the query path — and
  // therefore the shared cache entry — stays stable while the page is open. Picking "Last hour"
  // means the hour up to the moment you picked it; the poll keeps the rows fresh from there.
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => { setSince(windowMs ? Date.now() - windowMs : null); }, [windowMs]);
  const query = useMemo(() => {
    const q = new URLSearchParams({ limit: '150', source, grouped: '1' });
    if (service.trim()) q.set('service', service.trim());
    if (stack.trim()) q.set('stack', stack.trim());
    if (type) q.set('type', type);
    if (category) q.set('category', category);
    if (severity) q.set('severity', severity);
    if (since) q.set('since', String(since));
    return `/api/activity?${q.toString()}`;
  }, [source, service, stack, type, category, severity, since]);
  const { data, error } = usePolled<ActivityDoc>(query, 30_000);
  const items = data?.items ?? [];
  const active = [
    service.trim() && { key: 'service', label: `service: ${service.trim()}`, clear: () => setService('') },
    stack.trim() && { key: 'stack', label: `stack: ${stack.trim()}`, clear: () => setStack('') },
    type && { key: 'type', label: `type: ${TYPES.find((t) => t.value === type)?.label || type}`, clear: () => setType('') },
    category && { key: 'category', label: CATEGORIES.find((t) => t.value === category)?.label || category, clear: () => setCategory('') },
    severity && { key: 'severity', label: SEVERITIES.find((t) => t.value === severity)?.label || severity, clear: () => setSeverity('') },
    windowMs && { key: 'time', label: WINDOWS.find((w) => w.ms === windowMs)?.label || 'window', clear: () => setWindowMs(0) },
  ].filter(Boolean) as { key: string; label: string; clear: () => void }[];
  const filtered = active.length > 0 || source !== 'all';

  useEffect(() => {
    const next = new URLSearchParams();
    if (service.trim()) next.set('service', service.trim());
    if (stack.trim()) next.set('stack', stack.trim());
    if (type) next.set('type', type);
    if (category) next.set('category', category);
    if (severity) next.set('severity', severity);
    if (windowMs) next.set('since', String(windowMs));
    const current = params.toString();
    const wanted = next.toString();
    // replace, not push: filtering is not navigation, and Back should leave the page
    if (current !== wanted) setParams(next, { replace: true });
  }, [service, stack, type, category, severity, windowMs, params, setParams]);

  const days = useMemo(() => {
    const out: [string, Row[]][] = [];
    for (const e of items) {
      const label = dayLabel(e.t);
      const last = out[out.length - 1];
      if (last && last[0] === label) last[1].push(e);
      else out.push([label, [e]]);
    }
    return out;
  }, [items]);

  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <>
      <PageHero
        title="Activity"
        desc="Everything OpusHub has witnessed: configuration changes, host and engine events, launches. Real events only — bursts that happen together are grouped, and the group expands to its parts."
        meta={data ? (
          <span>
            {data.total} recorded event{data.total === 1 ? '' : 's'}
            {data.watchingSince ? ` · watching since ${new Date(data.watchingSince).toLocaleString()}` : ' · the log is empty, so nothing has been witnessed yet'}
          </span>
        ) : undefined}
      />
      <AlertsStrip />
      <div className="tl-filters" role="tablist" aria-label="Filter by source">
        {SOURCES.map((s) => (
          <button key={s} role="tab" aria-selected={source === s} className={source === s ? 'chip active' : 'chip'} onClick={() => setSource(s)}>
            {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* the finer filters: over the whole retention window, not just the rows already on screen */}
      <div className="tl-scope">
        <label className="tl-field">
          <span className="micro-label">Service</span>
          <input className="input" placeholder="container or service name" value={service} onChange={(e) => setService(e.target.value)} />
        </label>
        <label className="tl-field">
          <span className="micro-label">Stack</span>
          <input className="input" placeholder="compose project" value={stack} onChange={(e) => setStack(e.target.value)} />
        </label>
        <label className="tl-field">
          <span className="micro-label">Type</span>
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label className="tl-field">
          <span className="micro-label">Area</span>
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((t) => <option key={t.label} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label className="tl-field">
          <span className="micro-label">Severity</span>
          <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {SEVERITIES.map((t) => <option key={t.label} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label className="tl-field">
          <span className="micro-label">Time</span>
          <select className="input" value={String(windowMs)} onChange={(e) => setWindowMs(Number(e.target.value))}>
            {WINDOWS.map((w) => <option key={w.label} value={String(w.ms)}>{w.label}</option>)}
          </select>
        </label>
      </div>

      {filtered && (
        <div className="tl-active" aria-live="polite">
          <span className="stale-note">
            {data?.matched != null ? `${data.matched} matching event${data.matched === 1 ? '' : 's'} of ${data.total} recorded` : 'filtering…'}
          </span>
          {active.map((a) => (
            <button key={a.key} className="chip active" onClick={a.clear} title={`Remove filter: ${a.label}`}>
              {a.label} <span aria-hidden="true">×</span>
            </button>
          ))}
          {source !== 'all' && (
            <button className="chip active" onClick={() => setSource('all')} title="Remove filter: source">
              source: {source} <span aria-hidden="true">×</span>
            </button>
          )}
          {active.length > 0 && <button className="chip" onClick={() => { setService(''); setStack(''); setType(''); setCategory(''); setSeverity(''); setWindowMs(0); }}>Clear</button>}
        </div>
      )}

      {error && !data && <ProviderNote status="error" reason={error} />}
      {!items.length && (
        <div className="unavailable" style={{ padding: 'var(--sp-12)' }}>
          <span className="why" style={{ fontSize: 14 }}>
            {source === 'all' && active.length === 0
              ? 'No events yet. The log starts the moment OpusHub boots — try changing a setting or dragging a widget.'
              : `Nothing matches ${[...(source === 'all' ? [] : [`source ${source}`]), ...active.map((a) => a.label)].join(' · ')}. Filters only ever narrow the log — nothing was deleted.`}
          </span>
        </div>
      )}

      <div className="activity-wrap">
        <div className="timeline">
          {days.map(([day, evs]) => (
            <div key={day}>
              <div className="tl-day">{day}</div>
              {evs.map((e) => isGroup(e) ? (
                <div className="tl-item tl-group" key={e.id}>
                  <span className="tl-ico" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                      <path d={SOURCE_ICON[e.type] || 'm12 3 8.5 4.7L12 12.4 3.5 7.7zM3.5 12.5 12 17.2l8.5-4.7M3.5 17l8.5 4.7L20.5 17'} />
                    </svg>
                  </span>
                  <div className="tl-main">
                    <button className="tl-group-toggle" aria-expanded={open.has(e.id)} onClick={() => toggle(e.id)}>
                      {e.severity && e.severity !== 'info' && (
                        <span className={`sev-dot ${SEV_DOT[e.severity] || ''}`} title={`Severity: ${e.severity}`} aria-label={`Severity ${e.severity}`} />
                      )}
                      <span className="tl-type">{humanGroup(e).title}</span>
                      <span className="chip tl-src">{e.count} events</span>
                      <span className="tl-when" title={new Date(e.t).toLocaleString()}>
                        <span>{timeOfDay(e.t)}</span>
                        <span className="rel">{relTime(e.t)}</span>
                      </span>
                    </button>
                    {open.has(e.id) && (
                      <div className="tl-group-body">
                        {e.events.map((sub) => (
                          <div className="tl-sub" key={sub.id}>
                            <span className="tl-subject">{sub.subject}</span>
                            <span className="stale-note">{sub.message || humanEvent(sub)}</span>
                            <span className="stale-note">{timeOfDay(sub.t)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="tl-item" key={e.id}>
                  <span className="tl-ico" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                      <path d={SOURCE_ICON[e.type] || 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'} />
                    </svg>
                  </span>
                  <div className="tl-main">
                    {e.severity && e.severity !== 'info' && (
                      <span className={`sev-dot ${SEV_DOT[e.severity] || ''}`} title={`Severity: ${e.severity}`} aria-label={`Severity ${e.severity}`} />
                    )}
                    <span className="tl-type">{humanEvent(e)}</span>
                    {e.subject && e.source !== 'user' && <span className="tl-subject">{e.subject}</span>}
                    {e.source !== 'system' && <span className="chip tl-src">{e.source}</span>}
                    <span className="tl-when" title={new Date(e.t).toLocaleString()}>
                      <span>{timeOfDay(e.t)}</span>
                      <span className="rel">{relTime(e.t)}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** Active alerts above the log: the conditions OpusHub is sure about right now. */
function AlertsStrip() {
  const { data, refresh } = usePolled<AlertsDoc>('/api/alerts', 30_000);
  const [acking, setAcking] = useState<string | null>(null);
  if (!data || !data.alerts.length) return null;
  const ack = async (a: AlertItem) => {
    setAcking(a.id);
    try { await post('/api/alerts/ack', { id: a.id }); } catch { /* anonymous viewers cannot ack; the alert simply stays */ }
    setAcking(null);
    refresh();
  };
  return (
    <section className="alerts-strip" aria-label="Active alerts">
      {data.alerts.map((a) => (
        <div key={a.id} className={`alert-card sev-${a.severity}${a.acknowledged ? ' acked' : ''}`}>
          <span className={`sev-dot ${SEV_DOT[a.severity] || ''}`} aria-hidden="true" />
          <div className="alert-main">
            <div className="alert-title">{a.title}</div>
            <div className="alert-detail">{a.detail}</div>
            <div className="alert-meta">
              <span>firing since {new Date(a.firedAt).toLocaleString()}</span>
              {a.acknowledged && <span> · acknowledged</span>}
              {(a.links || []).map((l) => (
                <a key={l.href} className="alert-link" href={l.href}>{l.label} →</a>
              ))}
            </div>
          </div>
          {!a.acknowledged && (
            <button className="btn btn-quiet btn-sm" disabled={acking === a.id} onClick={() => ack(a)}>
              {acking === a.id ? 'Acking…' : 'Acknowledge'}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
