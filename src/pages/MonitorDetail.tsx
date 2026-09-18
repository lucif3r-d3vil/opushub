// One monitor, in full.
//
// Everything on this page is a recording: the state the engine last decided, the checks it kept,
// the incidents it opened and closed, and the uptime computed from those checks. When there is no
// data the page says so — it does not draw an empty graph as if it were a flat line at zero, and it
// does not print 100% for a monitor that has never run.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { invalidateShared, usePolled } from '../lib/api';
import { num } from '../lib/format';
import type { Monitor, MonitoringDetail } from '../lib/types';
import { Freshness, PageHero, ProviderNote, SectionHead } from '../components/ui';
import {
  EngineLine, IncidentList, LatencyGraph, MaintenanceControl, MonitorActions, MonitorEdit, ScopeBadge, StateBadge,
  TargetLine, TypeChip, UptimeValue, shortDuration,
} from '../components/monitoring/parts';

export default function MonitorDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const path = `/api/monitoring/monitors/${encodeURIComponent(id)}`;
  const { data, error, loading, fetchedAt, refresh } = usePolled<MonitoringDetail>(path, 15_000);
  const [override, setOverride] = useState<Monitor | null>(null);
  const [editing, setEditing] = useState(false);

  const monitor = override && override.id === id ? override : (data?.monitor ?? null);
  const reload = () => { invalidateShared('/api/monitoring'); refresh(); };

  if (error && !data) {
    return (
      <>
        <PageHero title="Monitor" desc="A monitor that is not in the engine's records." />
        <ProviderNote status="error" reason={error} fixHref="/monitoring" fixLabel="Back to Monitoring →" />
      </>
    );
  }
  if (!data || !monitor) return <p className="stale-note" style={{ padding: 'var(--sp-12) 0' }}>Reading the monitor…</p>;

  const { uptime, series, incidents, engine } = data;
  const state = monitor.enabled ? monitor.status : 'paused';
  const checks = uptime.day.checks;
  const noVerdict = checks > 0 && uptime.day.judged === 0;

  return (
    <>
      <PageHero
        title={monitor.name}
        desc={monitor.description || describeMonitor(monitor)}
        meta={<EngineLine health={engine} at={data.at} />}
        actions={(
          <>
            <Link className="btn btn-quiet btn-sm" to="/monitoring">← All monitors</Link>
            <Freshness at={fetchedAt} />
          </>
        )}
      />

      {monitor.stale && (
        <ProviderNote
          status="unavailable"
          reason={`No check has completed in the last ${Math.round(monitor.intervalMs * 2.5 / 1000)}s. The state below is the last recorded verdict, not a current one.`}
        />
      )}

      <div className="mon-detail-head">
        <StateBadge state={state} stale={monitor.stale} />
        <TypeChip monitor={monitor} />
        <ScopeBadge monitor={monitor} />
        {monitor.provenance !== 'configured' && (
          <span className="chip" title={monitor.source?.provider ? `Discovered from ${monitor.source.provider}` : 'Discovered from the inventory'}>
            {monitor.provenance}{monitor.source?.urlSource ? ` · ${monitor.source.urlSource}` : ''}
          </span>
        )}
        {monitor.maintenance && <span className="chip active">maintenance until {new Date(monitor.maintenance.until).toLocaleTimeString()}</span>}
      </div>

      <div className="mon-facts">
        <div className="mon-fact">
          <span className="micro-label">Target</span>
          <TargetLine monitor={monitor} link />
        </div>
        <div className="mon-fact">
          <span className="micro-label">Uptime (24h / 7d / 30d)</span>
          <span className="mon-fact-values">
            <UptimeValue window={uptime.day} label="24h" />
            <UptimeValue window={uptime.week} label="7d" />
            <UptimeValue window={uptime.month} label="30d" />
          </span>
        </div>
        <div className="mon-fact">
          <span className="micro-label">Latency (avg / min / max)</span>
          <span className="mon-fact-values mono">
            {uptime.day.avgLatencyMs == null
              ? <span className="mon-figure mono">—</span>
              : <>{num(uptime.day.avgLatencyMs, 0)} / {num(uptime.day.minLatencyMs, 0)} / {num(uptime.day.maxLatencyMs, 0)} ms</>}
          </span>
        </div>
        <div className="mon-fact">
          <span className="micro-label">Last check</span>
          <span className="mon-fact-values">
            {monitor.lastCheck
              ? <>{new Date(monitor.lastCheck.at).toLocaleString()} <span className="stale-note">({monitor.lastCheck.kind}{monitor.lastCheck.statusCode ? `, HTTP ${monitor.lastCheck.statusCode}` : ''})</span></>
              : <span className="stale-note">never — this monitor has not run yet</span>}
          </span>
        </div>
        <div className="mon-fact">
          <span className="micro-label">Check count</span>
          <span className="mon-fact-values">
            {checks} recorded{checks ? ` · ${uptime.day.ok} up, ${uptime.day.degraded} degraded, ${uptime.day.fail} failed, ${uptime.day.unknown} with no verdict` : ''}
          </span>
        </div>
        <div className="mon-fact">
          <span className="micro-label">Thresholds</span>
          <span className="mon-fact-values stale-note">
            down after {monitor.consecutiveFailures}/{monitor.consecutiveSuccesses} — the engine's configured thresholds apply;
            fails in a row so far: {monitor.consecutiveFailures}, successes: {monitor.consecutiveSuccesses}
          </span>
        </div>
      </div>

      {monitor.lastCheck?.reason && (
        <p className="mon-last-reason">
          <span className="micro-label">Last answer</span>
          <span>{monitor.lastCheck.reason}</span>
        </p>
      )}

      <MonitorActions
        monitor={monitor}
        onChange={(m) => { setOverride(m); reload(); }}
        onDeleted={() => { invalidateShared('/api/monitoring'); nav('/monitoring'); }}
      />

      <SectionHead
        title="Latency"
        right={<span className="stale-note">{checks ? `${checks} check${checks === 1 ? '' : 's'} recorded in the last 24 hours` : 'nothing recorded yet'}</span>}
      />
      {noVerdict
        ? <ProviderNote compact status="unavailable" reason="Every check so far produced no verdict (a refused address, an unreachable inventory or a timeout at the source), so there is no latency to report — only the reasons above." />
        : <LatencyGraph series={series} />}

      <SectionHead
        title="Incidents"
        right={<span className="stale-note">opened after sustained failures, closed when the monitor recovers</span>}
      />
      <IncidentList incidents={incidents} />

      <SectionHead
        title="Definition"
        right={(
          <button className="btn btn-quiet btn-sm" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Close' : 'Edit'}
          </button>
        )}
      />
      {editing
        ? <MonitorEdit monitor={monitor} onSaved={(m) => { setOverride(m); setEditing(false); reload(); }} onCancel={() => setEditing(false)} />
        : (
          <div className="mon-definition">
            <span className="micro-label">Interval</span><span className="mono">{Math.round(monitor.intervalMs / 1000)}s</span>
            <span className="micro-label">Timeout</span><span className="mono">{Math.round(monitor.timeoutMs / 1000)}s</span>
            <span className="micro-label">Expected</span>
            <span className="mono">{monitor.type === 'http' ? expectedWords(monitor) : 'answers or does not answer'}</span>
            <span className="micro-label">Created</span><span>{new Date(monitor.createdAt).toLocaleString()}</span>
            <span className="micro-label">Updated</span><span>{new Date(monitor.updatedAt).toLocaleString()}</span>
            <span className="micro-label">History</span>
            <span className="stale-note">
              last {incidents.length ? `${incidents.length} incident${incidents.length === 1 ? '' : 's'}` : 'no incidents'}
              {incidents[0] && incidents[0].recoveredAt ? ` · longest ${shortDuration(Math.max(...incidents.map((i) => i.durationMs)))}` : ''}
              {' · '}the target is not editable — delete and re-add to watch something else, so recorded history is never re-pointed
            </span>
          </div>
        )}

      <SectionHead title="Maintenance" right={<span className="stale-note">bounded, explicit, and quiet — no alerts, no calendar</span>} />
      <MaintenanceControl monitor={monitor} onChange={(m) => { setOverride(m); reload(); }} />

      {incidents.some((i) => i.maintenance) && (
        <p className="stale-note">Incidents marked “maintenance” happened inside a window you opened: they are recorded, but they were not allowed to raise alerts.</p>
      )}
    </>
  );
}

function describeMonitor(monitor: Monitor): string {
  if (monitor.type === 'docker') return 'Container state, read from the canonical inventory. A running container is not by itself application availability.';
  if (monitor.type === 'tcp') return 'One host and one port, opened briefly. No protocol is spoken and nothing is sent.';
  return 'An HTTP request, with the status compared against what this monitor expects.';
}

function expectedWords(monitor: Monitor): string {
  const e = monitor.expected;
  if (e?.status != null) return `HTTP ${e.status}`;
  if (e?.min != null && e?.max != null) return `HTTP ${e.min}–${e.max}`;
  return 'HTTP 200–399';
}
