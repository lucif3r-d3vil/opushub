// The pieces every monitoring surface is built from.
//
// Three rules show up in this file and hold everywhere above it:
//   1. a monitor's state is *the recorded verdict*, never a colour invented from "enabled";
//   2. a number the engine did not record is not rendered as a number (`—`, with a reason);
//   3. the target is described exactly as it is stored — a service reference, an endpoint, or one
//      host and port — and whether it is an internal address is stated rather than implied.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, post, put, usePolled } from '../../lib/api';
import { host as hostOf, num, pct, relTime, timeOfDay } from '../../lib/format';
import type {
  Monitor, MonitorIncident, MonitorState, MonitoringSeriesPoint, MonitorType, Service, ServicesDoc, UptimeWindow,
} from '../../lib/types';
import { Sparkline } from '../Charts';
import { Modal, ProviderNote, SectionHead, Segmented } from '../ui';

/* ------------------------------------------------------------------ */
/* words                                                               */
/* ------------------------------------------------------------------ */

/** Monitoring has its own vocabulary: `pending` is not `up`, and `paused` is not `down`. */
export const STATE_WORDS: Record<MonitorState, string> = {
  pending: 'Not checked yet',
  up: 'Up',
  degraded: 'Degraded',
  down: 'Down',
  recovering: 'Recovering',
  paused: 'Paused',
  unknown: 'No verdict',
};

export const STATE_TONES: Record<MonitorState, string> = {
  pending: 'idle', up: 'ok', degraded: 'warn', down: 'bad', recovering: 'warn', paused: 'quiet', unknown: 'idle',
};

const TYPE_WORDS: Record<MonitorType, string> = { http: 'HTTP', tcp: 'TCP', docker: 'Docker' };

/** The one-line explanation of what a state means, used in tooltips and empty states. */
const STATE_HINT: Record<MonitorState, string> = {
  pending: 'The engine has not run a check for this monitor yet.',
  up: 'The last checks got the answer this monitor expects.',
  degraded: 'The service answered, but not the way this monitor expects.',
  down: 'Enough consecutive checks failed to call it down.',
  recovering: 'It is answering again, but not for long enough to call it up.',
  paused: 'You paused this monitor. It is not down — it is not being checked.',
  unknown: 'The last check produced no verdict (a refused address, an unreachable inventory, a timeout at the source).',
};

/* ------------------------------------------------------------------ */
/* state                                                                */
/* ------------------------------------------------------------------ */

export function StateBadge({ state, stale, title }: { state: MonitorState; stale?: boolean; title?: string }) {
  const word = STATE_WORDS[state] ?? state;
  return (
    <span className={`mon-state mon-${STATE_TONES[state] ?? 'idle'}`} title={title || STATE_HINT[state] || word}>
      <span className="mon-dot" aria-hidden="true" />
      {word}
      {stale && <span className="mon-state-note" title="No check in the last few intervals — this is the last recorded verdict, not current">stale</span>}
    </span>
  );
}

/** Where the check actually reached. Recorded by the engine; `null` means "not measured yet". */
export function ScopeBadge({ monitor }: { monitor: Monitor }) {
  const scope = monitor.target?.scope ?? null;
  if (scope === 'internal') {
    return <span className="chip mon-scope" title={`Every address this monitor resolved to is on your own network (recorded ${monitor.target.scopeAt ? relTime(monitor.target.scopeAt) : 'at the last check'}).`}>internal endpoint</span>;
  }
  if (scope === 'mixed') {
    return <span className="chip mon-scope" title="This target resolves to both internal and public addresses; the monitor connects to the one it validates first.">internal + public</span>;
  }
  if (scope === 'public') return <span className="chip mon-scope" title="Every address this monitor resolved to is public.">public endpoint</span>;
  return <span className="chip mon-scope mon-scope--none" title="No address has been resolved yet — the scope is recorded when the monitor runs.">scope not measured</span>;
}

/** What the monitor watches, said in its own terms. */
export function TargetLine({ monitor, link = false }: { monitor: Monitor; link?: boolean }) {
  const t = monitor.target;
  if (t.kind === 'tcp') return <span className="mon-target mono">{t.host}:{t.port}</span>;
  if (t.kind === 'docker') {
    const ref = t.service;
    const label = `${ref?.group ? `${ref.group} / ` : ''}${ref?.name ?? 'unknown service'}`;
    return link && ref
      ? <Link className="mon-target" to={`/services/${encodeURIComponent(ref.group || 'Other')}/${encodeURIComponent(ref.name)}`}>{label}</Link>
      : <span className="mon-target">{label}</span>;
  }
  if (t.service) {
    const ref = t.service;
    const label = `${ref.group ? `${ref.group} / ` : ''}${ref.name}`;
    return (
      <span className="mon-target">
        {t.url && <span className="mono">{hostOf(t.url)}{new URL(t.url).pathname !== '/' ? new URL(t.url).pathname : ''}</span>}
        {' '}
        {link
          ? <Link to={`/services/${encodeURIComponent(ref.group || 'Other')}/${encodeURIComponent(ref.name)}`}>via {label}</Link>
          : <span className="stale-note">via {label}</span>}
      </span>
    );
  }
  return <span className="mon-target mono">{t.url ? `${hostOf(t.url)}${new URL(t.url).pathname}` : '—'}</span>;
}

export function TypeChip({ monitor }: { monitor: Monitor }) {
  return <span className="chip mono mon-type" title={`Checked every ${Math.round(monitor.intervalMs / 1000)}s, giving up after ${Math.round(monitor.timeoutMs / 1000)}s`}>{TYPE_WORDS[monitor.type] ?? monitor.type}</span>;
}

/* ------------------------------------------------------------------ */
/* numbers                                                             */
/* ------------------------------------------------------------------ */

/** Uptime, or the honest absence of it. Never 100% because there is nothing to divide. */
export function UptimeValue({ window: w, label }: { window: UptimeWindow | null | undefined; label?: string }) {
  if (!w) return <span className="mon-figure mono">—</span>;
  if (w.paused) return <span className="mon-figure mono" title="A paused monitor has no uptime to report — it is not being checked.">paused</span>;
  if (w.noData) return <span className="mon-figure mono" title="No checks were recorded in this window. Missing data is never counted as success.">no data</span>;
  if (w.uptimePct == null) {
    return <span className="mon-figure mono" title={`${w.checks} check${w.checks === 1 ? '' : 's'} produced no verdict, so there is no uptime to compute.`}>no verdict</span>;
  }
  const cls = w.uptimePct >= 99 ? 'ok' : w.uptimePct >= 95 ? 'warn' : 'bad';
  return (
    <span className={`mon-figure mono mon-fig-${cls}`} title={`${w.ok} up · ${w.degraded} degraded · ${w.fail} failed · ${w.unknown} no verdict${label ? ` · ${label}` : ''}`}>
      {pct(w.uptimePct, w.uptimePct >= 99.95 ? 2 : 1)}
    </span>
  );
}

export function LatencyValue({ ms, at }: { ms: number | null; at?: number | null }) {
  if (ms == null) return <span className="mon-figure mono">—</span>;
  return <span className="mon-figure mono" title={at ? `Measured ${relTime(at)}` : undefined}>{num(ms, 0)} ms</span>;
}

/** The latency graph for one monitor: recorded samples only, gaps where nothing was measured. */
export function LatencyGraph({ series, height = 120, windowMs = 24 * 3_600_000 }: { series: MonitoringSeriesPoint[]; height?: number; windowMs?: number }) {
  const points = useMemo(() => series.filter((p) => Number.isFinite(p.t)), [series]);
  const values = points.map((p) => (p.ms == null ? 0 : p.ms));
  const okCount = points.filter((p) => p.k === 'ok').length;
  if (!points.length) {
    return <ProviderNote compact status="unavailable" reason="No checks have been recorded yet, so there is no latency history to draw." />;
  }
  const max = Math.max(...values, 0);
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return (
    <div className="mon-graph">
      <div className="mon-graph-row" aria-hidden="true">
        <Sparkline values={values} width={280} height={40} />
      </div>
      <div className="mon-graph-meta stale-note">
        {points.length} recorded check{points.length === 1 ? '' : 's'} over {labelForWindow(windowMs)} · peak {num(max, 0)} ms
        {avg != null ? ` · mean ${num(avg, 0)} ms` : ''} · {okCount} answered as expected
      </div>
      <div className="mon-spark-list" role="list">
        {points.slice(-12).reverse().map((p) => (
          <div className="mon-spark-row" role="listitem" key={p.t}>
            <span className={`mon-spark-kind mon-${p.k === 'ok' ? 'ok' : p.k === 'fail' ? 'bad' : 'warn'}`}>{p.k}</span>
            <span className="stale-note">{timeOfDay(p.t)}</span>
            <span className="mono">{p.ms == null ? '—' : `${num(p.ms, 0)} ms`}</span>
            <span className="stale-note">{p.code == null ? '' : `HTTP ${p.code}`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function labelForWindow(ms: number): string {
  if (ms <= 25 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** A real incident duration — the recorded start and end, never a rounded guess. */
export function DurationValue({ incident }: { incident: MonitorIncident }) {
  if (incident.recoveredAt == null) {
    return <span className="mon-figure mono" title={`Still open, started ${new Date(incident.startedAt).toLocaleString()}`}>open {shortDuration(Date.now() - incident.startedAt)}</span>;
  }
  return <span className="mon-figure mono" title={`${new Date(incident.startedAt).toLocaleString()} → ${new Date(incident.recoveredAt).toLocaleString()}`}>{shortDuration(incident.durationMs)}</span>;
}

export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/* ------------------------------------------------------------------ */
/* engine health                                                       */
/* ------------------------------------------------------------------ */

/**
 * "Is monitoring working?" is a different question from "is everything up?". When the engine is
 * not running, every number below it is a *recording*, and the UI says so instead of presenting a
 * stale verdict as current.
 */
export function EngineLine({ health, at }: { health: { state: string; reason: string | null; lastTickAt: number | null; lastCheckAt: number | null; checksRunning: number; concurrency: number; active: number; paused: number; stale: boolean } | null; at?: number | null }) {
  if (!health) return <span className="stale-note">Engine status is unknown.</span>;
  const words: Record<string, string> = {
    running: 'Monitoring is running',
    idle: 'Monitoring is running, with no enabled monitors',
    stopped: 'Monitoring is stopped',
    unavailable: 'Monitoring is unavailable',
  };
  const last = health.lastCheckAt ?? health.lastTickAt;
  return (
    <span className={`mon-engine mon-engine--${health.state}`} role="status">
      <span className="mon-dot" aria-hidden="true" />
      <strong>{words[health.state] ?? health.state}</strong>
      {health.state === 'running' && (
        <span className="stale-note">
          {' '}· {health.active} active{health.paused ? `, ${health.paused} paused` : ''} · {health.checksRunning}/{health.concurrency} checks running
          {last ? ` · last check ${relTime(last, at ?? Date.now())}` : ''}
        </span>
      )}
      {health.reason && health.state !== 'running' && <span className="stale-note"> · {health.reason}</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* add / edit                                                          */
/* ------------------------------------------------------------------ */

export interface MonitorDraft {
  name: string;
  type: MonitorType;
  /** the canonical service reference, when the monitor watches a service */
  service: { group: string; name: string } | null;
  url: string;
  host: string;
  port: string;
  intervalSec: string;
  timeoutSec: string;
  expectedStatus: string;
  expectedMin: string;
  expectedMax: string;
  description: string;
}

export const emptyDraft = (over: Partial<MonitorDraft> = {}): MonitorDraft => ({
  name: '', type: 'http', service: null, url: '', host: '', port: '', intervalSec: '60', timeoutSec: '5',
  expectedStatus: '', expectedMin: '200', expectedMax: '399', description: '', ...over,
});

export function draftBody(d: MonitorDraft) {
  const target: Record<string, unknown> = {};
  if (d.type === 'docker') target.service = d.service;
  else if (d.type === 'tcp') target.host = d.host.trim(), target.port = Number(d.port);
  else {
    if (d.service) target.service = d.service;
    if (d.url.trim()) target.url = d.url.trim();
  }
  const expected = d.type !== 'http' ? undefined : d.expectedStatus.trim()
    ? { status: Number(d.expectedStatus) }
    : { min: d.expectedMin.trim() ? Number(d.expectedMin) : undefined, max: d.expectedMax.trim() ? Number(d.expectedMax) : undefined };
  return {
    name: d.name.trim(),
    type: d.type,
    target,
    intervalMs: Math.round(Number(d.intervalSec) * 1000),
    timeoutMs: Math.round(Number(d.timeoutSec) * 1000),
    description: d.description.trim() || null,
    ...(expected ? { expected } : {}),
  };
}

/** A monitor's own settings, as a small form body — shared by Add and Edit so they cannot drift. */
export function MonitorFields({ draft, set, services, allowInternal }: { draft: MonitorDraft; set: (patch: Partial<MonitorDraft>) => void; services: Service[]; allowInternal: boolean }) {
  const refKey = draft.service ? `${draft.service.group}/${draft.service.name}` : '';
  const withUrl = services.filter((s) => s.url && !s.hidden);
  const anyService = services.filter((s) => !s.hidden);
  return (
    <div className="mon-form">
      <label className="mon-field">
        <span className="micro-label">Name</span>
        <input className="input" value={draft.name} maxLength={80} placeholder="Jellyfin" onChange={(e) => set({ name: e.target.value })} />
        <span className="fr-desc">A label for the list. The service or endpoint below is what is actually checked.</span>
      </label>

      <div className="mon-field">
        <span className="micro-label">Type</span>
        <Segmented
          ariaLabel="Monitor type"
          value={draft.type}
          onChange={(v) => set({ type: v as MonitorType })}
          options={[{ value: 'http', label: 'HTTP' }, { value: 'tcp', label: 'TCP' }, { value: 'docker', label: 'Docker' }]}
        />
      </div>

      {draft.type !== 'tcp' && (
        <label className="mon-field">
          <span className="micro-label">{draft.type === 'docker' ? 'Service to watch' : 'Service (preferred)'}</span>
          <select
            className="input"
            value={refKey}
            onChange={(e) => {
              const picked = e.target.value ? anyService.find((s) => `${s.group}/${s.name}` === e.target.value) : null;
              set({ service: picked ? { group: picked.group || 'Other', name: picked.name } : null, url: picked?.url ? picked.url : draft.url });
            }}
          >
            <option value="">
              {draft.type === 'docker' ? 'Choose a discovered service…' : 'No service — use an endpoint below'}
            </option>
            {(draft.type === 'docker' ? anyService : withUrl).map((s) => (
              <option key={`${s.group}/${s.name}`} value={`${s.group}/${s.name}`}>
                {s.displayName || s.name}{s.group ? ` · ${s.group}` : ''}{s.url ? ' · endpoint known' : ''}
              </option>
            ))}
          </select>
          <span className="fr-desc">
            {draft.type === 'docker'
              ? 'The container state of a service OpusHub already discovered. OpusHub resolves the container itself — a container id is not a target.'
              : 'Watching a service means the endpoint is resolved at check time, so a provider change (a new proxy route, a published port) is picked up instead of frozen.'}
          </span>
        </label>
      )}

      {draft.type === 'http' && (
        <label className="mon-field">
          <span className="micro-label">Endpoint{draft.service ? ' (fallback when no endpoint resolves)' : ''}</span>
          <input className="input" value={draft.url} maxLength={500} placeholder="https://app.example.lab/health" onChange={(e) => set({ url: e.target.value })} />
          <span className="fr-desc">
            http:// or https:// only, no credentials, and never a port that is not an HTTP application.
            {allowInternal
              ? ' An address on your own network is allowed and is marked as internal on the monitor.'
              : ' This instance is set to public endpoints only — internal addresses are refused by the server.'}
          </span>
        </label>
      )}

      {draft.type === 'tcp' && (
        <div className="mon-field mon-field-row">
          <label className="mon-field">
            <span className="micro-label">Host</span>
            <input className="input" value={draft.host} maxLength={253} placeholder="10.0.0.9 or nas.lab" onChange={(e) => set({ host: e.target.value })} />
          </label>
          <label className="mon-field mon-field-port">
            <span className="micro-label">Port</span>
            <input className="input" value={draft.port} inputMode="numeric" placeholder="8096" onChange={(e) => set({ port: e.target.value })} />
          </label>
          <span className="fr-desc">One host and one port. Ranges, lists and CIDR blocks are refused — a monitor is not a scanner.</span>
        </div>
      )}

      <div className="mon-field mon-field-row">
        <label className="mon-field">
          <span className="micro-label">Check every</span>
          <input className="input" value={draft.intervalSec} inputMode="numeric" onChange={(e) => set({ intervalSec: e.target.value })} />
          <span className="fr-desc">seconds (10s – 24h)</span>
        </label>
        <label className="mon-field">
          <span className="micro-label">Give up after</span>
          <input className="input" value={draft.timeoutSec} inputMode="numeric" onChange={(e) => set({ timeoutSec: e.target.value })} />
          <span className="fr-desc">seconds (0.5s – 30s)</span>
        </label>
      </div>

      {draft.type === 'http' && (
        <div className="mon-field mon-field-row">
          <label className="mon-field">
            <span className="micro-label">Expected status</span>
            <input className="input" value={draft.expectedStatus} inputMode="numeric" placeholder="leave empty for a range" onChange={(e) => set({ expectedStatus: e.target.value })} />
          </label>
          <label className="mon-field">
            <span className="micro-label">Range from</span>
            <input className="input" value={draft.expectedMin} inputMode="numeric" onChange={(e) => set({ expectedMin: e.target.value })} />
          </label>
          <label className="mon-field">
            <span className="micro-label">to</span>
            <input className="input" value={draft.expectedMax} inputMode="numeric" onChange={(e) => set({ expectedMax: e.target.value })} />
          </label>
          <span className="fr-desc">A 500 is a real answer, and it is reported as degraded rather than as healthy.</span>
        </div>
      )}

      <label className="mon-field">
        <span className="micro-label">Note (optional)</span>
        <input className="input" value={draft.description} maxLength={200} placeholder="what this watches, for the next person" onChange={(e) => set({ description: e.target.value })} />
      </label>
    </div>
  );
}

/** Add a monitor. Nothing is created until the server accepts it. */
export function AddMonitorDialog({ open, onClose, onCreated, services, allowInternal, preselect = null }: {
  open: boolean; onClose: () => void; onCreated: (m: Monitor) => void; services: Service[];
  allowInternal: boolean; preselect?: string | null;
}) {
  const [draft, setDraft] = useState<MonitorDraft>(() => emptyDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<MonitorDraft>) => setDraft((d) => ({ ...d, ...patch }));

  useEffect(() => {
    if (!open) return;
    setError(null);
    // a service named in the URL wins over an empty form: the endpoint that service already has
    // is the endpoint the monitor will watch, resolved again at every check
    const wanted = preselect ? services.find((s) => `${s.group || 'Other'}/${s.name}` === preselect) : null;
    setDraft(emptyDraft(wanted ? {
      name: wanted.displayName || wanted.name,
      type: wanted.url ? 'http' : 'docker',
      service: { group: wanted.group || 'Other', name: wanted.name },
      url: wanted.url || '',
    } : {}));
  }, [open, preselect, services]);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await post<{ monitor: Monitor }>('/api/monitoring/monitors', { monitor: draftBody(draft) });
      onCreated(res.monitor);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <Modal
      title="Add a monitor"
      onClose={onClose}
      wide
      footer={(
        <>
          {error && <span className="stale-note bg-url-state bg-url-state--err" role="alert">{error}</span>}
          <button className="btn btn-quiet" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !draft.name.trim()}>
            {busy ? 'Creating…' : 'Add monitor'}
          </button>
        </>
      )}
    >
      <p className="stale-note" style={{ marginTop: 0 }}>
        A monitor watches something OpusHub can already see, or an endpoint you name. Checks are made
        from the server, on the interval below, with a bounded worker pool — the browser never polls a
        target and nothing here can change what it watches.
      </p>
      <MonitorFields draft={draft} set={set} services={services} allowInternal={allowInternal} />
    </Modal>
  );
}

/** The service list both the Add dialog and the suggestions panel need. */
export function useServices(): { services: Service[]; dockerAvailable: boolean } {
  const { data } = usePolled<ServicesDoc>('/api/services', 30_000);
  const services: Service[] = useMemo(() => (data?.services ?? []).filter((s) => !s.hidden), [data]);
  return { services, dockerAvailable: data ? data.live !== false : true };
}

/* ------------------------------------------------------------------ */
/* maintenance + actions                                               */
/* ------------------------------------------------------------------ */

const MAINTENANCE_CHOICES = [
  { label: '15 minutes', ms: 15 * 60_000 },
  { label: '1 hour', ms: 60 * 60_000 },
  { label: '4 hours', ms: 4 * 60 * 60_000 },
  { label: '1 day', ms: 24 * 60 * 60_000 },
];

/**
 * Maintenance windows: one duration, one optional reason, bounded on the server. There is no
 * calendar here and no recurrence — a window is a window.
 */
export function MaintenanceControl({ monitor, onChange }: { monitor: Monitor; onChange: (m: Monitor) => void }) {
  const [ms, setMs] = useState(MAINTENANCE_CHOICES[1].ms);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = monitor.maintenance;

  const run = async (fn: () => Promise<{ monitor: Monitor }>) => {
    setBusy(true); setError(null);
    try { onChange((await fn()).monitor); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  if (active) {
    return (
      <div className="mon-maintenance">
        <span className="chip active" title={`Until ${new Date(active.until).toLocaleString()}`}>
          maintenance until {timeOfDay(active.until)} ({relTime(active.until)} left)
        </span>
        {active.reason && <span className="stale-note">{active.reason}</span>}
        <button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => void run(() => api<{ monitor: Monitor }>(`/api/monitoring/monitors/${monitor.id}/maintenance/clear`, { method: 'DELETE' }))}>
          End maintenance
        </button>
        <span className="stale-note">Checks keep recording; alerts stay quiet and incidents are marked as maintenance.</span>
        {error && <span className="stale-note bg-url-state bg-url-state--err" role="alert">{error}</span>}
      </div>
    );
  }
  return (
    <div className="mon-maintenance">
      <label className="mon-field mon-field-inline">
        <span className="micro-label">Maintenance for</span>
        <select className="input" value={String(ms)} onChange={(e) => setMs(Number(e.target.value))}>
          {MAINTENANCE_CHOICES.map((c) => <option key={c.label} value={String(c.ms)}>{c.label}</option>)}
        </select>
      </label>
      <label className="mon-field mon-field-inline">
        <span className="micro-label">Reason</span>
        <input className="input" value={reason} maxLength={60} placeholder="optional, e.g. disk swap" onChange={(e) => setReason(e.target.value)} />
      </label>
      <button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => void run(() => post<{ monitor: Monitor }>(`/api/monitoring/monitors/${monitor.id}/maintenance`, { until: Date.now() + ms, reason: reason.trim() || null }))}>
        {busy ? 'Starting…' : 'Start maintenance'}
      </button>
      {error && <span className="stale-note bg-url-state bg-url-state--err" role="alert">{error}</span>}
    </div>
  );
}

/** Pause / resume / check now / delete — every one of them a monitor definition, nothing else. */
export function MonitorActions({ monitor, onChange, onDeleted, compact = false }: {
  monitor: Monitor; onChange: (m: Monitor) => void; onDeleted: (id: string) => void; compact?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [checked, setChecked] = useState<string | null>(null);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what); setError(null);
    try { await fn(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  return (
    <div className={`mon-actions${compact ? ' mon-actions--compact' : ''}`}>
      <button
        className="btn btn-quiet btn-sm"
        disabled={busy === 'check'}
        title="Run this monitor's stored, validated target now. Rate limited on the server."
        onClick={() => void run('check', async () => {
          const res = await post<{ monitor: Monitor; state: MonitorState; result: { reason?: string | null; kind?: string } }>(`/api/monitoring/monitors/${monitor.id}/check`);
          onChange(res.monitor);
          setChecked(`${res.state}: ${res.result?.reason || 'checked'}`);
        })}
      >
        {busy === 'check' ? 'Checking…' : 'Check now'}
      </button>
      {monitor.enabled ? (
        <button className="btn btn-quiet btn-sm" disabled={busy === 'pause'} onClick={() => void run('pause', async () => onChange((await post<{ monitor: Monitor }>(`/api/monitoring/monitors/${monitor.id}/pause`)).monitor))}>
          {busy === 'pause' ? 'Pausing…' : 'Pause'}
        </button>
      ) : (
        <button className="btn btn-quiet btn-sm" disabled={busy === 'resume'} onClick={() => void run('resume', async () => onChange((await post<{ monitor: Monitor }>(`/api/monitoring/monitors/${monitor.id}/resume`)).monitor))}>
          {busy === 'resume' ? 'Resuming…' : 'Resume'}
        </button>
      )}
      {!compact && (
        confirming ? (
          <>
            <span className="stale-note">Delete this monitor and its history?</span>
            <button className="btn btn-quiet btn-sm" onClick={() => setConfirming(false)} disabled={busy === 'delete'}>Keep it</button>
            <button
              className="btn btn-quiet btn-sm mon-danger"
              disabled={busy === 'delete'}
              onClick={() => void run('delete', async () => {
                await api(`/api/monitoring/monitors/${monitor.id}`, { method: 'DELETE' });
                onDeleted(monitor.id);
              })}
            >
              {busy === 'delete' ? 'Deleting…' : 'Delete'}
            </button>
          </>
        ) : (
          <button className="btn btn-quiet btn-sm" onClick={() => setConfirming(true)}>Delete</button>
        )
      )}
      {checked && <span className="stale-note" role="status">{checked}</span>}
      {error && <span className="stale-note bg-url-state bg-url-state--err" role="alert">{error}</span>}
    </div>
  );
}

/** Edit the definition in place. The type and target are shown but not rewritable — delete and
 *  re-add if the thing being watched changed, so history is never silently re-pointed. */
export function MonitorEdit({ monitor, onSaved, onCancel }: { monitor: Monitor; onSaved: (m: Monitor) => void; onCancel: () => void }) {
  const [name, setName] = useState(monitor.name);
  const [intervalSec, setIntervalSec] = useState(String(Math.round(monitor.intervalMs / 1000)));
  const [timeoutSec, setTimeoutSec] = useState(String(Math.round(monitor.timeoutMs / 1000)));
  const [description, setDescription] = useState(monitor.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const res = await put<{ monitor: Monitor }>(`/api/monitoring/monitors/${monitor.id}`, {
        name: name.trim(), intervalMs: Math.round(Number(intervalSec) * 1000), timeoutMs: Math.round(Number(timeoutSec) * 1000),
        description: description.trim() || null,
      });
      onSaved(res.monitor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mon-form mon-form--edit">
      <div className="mon-field-row">
        <label className="mon-field">
          <span className="micro-label">Name</span>
          <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="mon-field">
          <span className="micro-label">Check every (s)</span>
          <input className="input" value={intervalSec} inputMode="numeric" onChange={(e) => setIntervalSec(e.target.value)} />
        </label>
        <label className="mon-field">
          <span className="micro-label">Timeout (s)</span>
          <input className="input" value={timeoutSec} inputMode="numeric" onChange={(e) => setTimeoutSec(e.target.value)} />
        </label>
      </div>
      <label className="mon-field">
        <span className="micro-label">Note</span>
        <input className="input" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="mon-field-row">
        <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        <button className="btn btn-quiet btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        {error && <span className="stale-note bg-url-state bg-url-state--err" role="alert">{error}</span>}
      </div>
    </div>
  );
}

/** The incident list, used by the monitor page and the incidents view. */
export function IncidentList({ incidents, emptyNote }: { incidents: MonitorIncident[]; emptyNote?: string }) {
  if (!incidents.length) {
    return <p className="stale-note">{emptyNote || 'No incidents have been recorded for this monitor. An incident needs sustained failures, not one bad check.'}</p>;
  }
  return (
    <div className="mon-incidents">
      <div className="mon-incident mon-incident--head" aria-hidden="true">
        <span>State</span><span>Started</span><span>Duration</span><span>Why</span>
      </div>
      {incidents.map((i) => (
        <div className="mon-incident" key={i.id}>
          <span className={`mon-state mon-${i.status === 'resolved' ? 'ok' : i.status === 'recovering' ? 'warn' : 'bad'}`}>
            <span className="mon-dot" aria-hidden="true" />
            {i.status === 'resolved' ? 'recovered' : i.status}
            {i.maintenance && <span className="mon-state-note" title="This happened inside a maintenance window; alerts were suppressed.">maintenance</span>}
          </span>
          <span className="stale-note" title={new Date(i.startedAt).toLocaleString()}>
            {timeOfDay(i.startedAt)} <span className="rel">{relTime(i.startedAt)}</span>
          </span>
          <DurationValue incident={i} />
          <span className="mon-incident-reason" title={i.reason}>{i.reason}</span>
        </div>
      ))}
    </div>
  );
}

/** The suggestions panel: what the inventory offers, and the one button that creates monitors. */
export function SuggestionsPanel({ onCreated }: { onCreated: () => void }) {
  const { data, refresh } = usePolled<{ suggestions: { id: string; title: string; type: MonitorType; reason: string }[]; reason: string | null; autoCreate: { enabled: boolean; max: number } }>(
    '/api/monitoring/suggestions', 60_000,
  );
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const list = data?.suggestions ?? [];
  if (!data) return null;
  if (!list.length) {
    return (
      <SectionHead
        title="Suggestions"
        right={<span className="stale-note">{data.reason || 'Nothing new to suggest — every discovered service with an endpoint is already monitored.'}</span>}
      />
    );
  }
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <section className="mon-suggest" aria-label="Suggested monitors">
      <SectionHead
        title="Suggestions"
        right={(
          <>
            <span className="stale-note">Nothing is created until you choose. Auto-creation is {data.autoCreate.enabled ? `on (max ${data.autoCreate.max})` : 'off'}.</span>
            <button
              className="btn btn-quiet btn-sm"
              disabled={busy || !picked.length}
              onClick={() => void (async () => {
                setBusy(true); setMessage(null);
                try {
                  const res = await post<{ created: Monitor[] }>('/api/monitoring/suggestions/apply', { ids: picked });
                  setMessage(`${res.created.length} monitor${res.created.length === 1 ? '' : 's'} added.`);
                  setPicked([]);
                  refresh();
                  onCreated();
                } catch (err) {
                  setMessage(err instanceof Error ? err.message : String(err));
                } finally { setBusy(false); }
              })()}
            >
              {busy ? 'Adding…' : `Add ${picked.length || ''} selected`}
            </button>
          </>
        )}
      />
      <div className="mon-suggest-list">
        {list.slice(0, 12).map((s) => (
          <label className="mon-suggest-row" key={s.id}>
            <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} />
            <span className="chip mono">{s.type.toUpperCase()}</span>
            <span className="mon-suggest-title">{s.title}</span>
            <span className="stale-note">{s.reason}</span>
          </label>
        ))}
      </div>
      {message && <p className="stale-note" role="status">{message}</p>}
    </section>
  );
}
