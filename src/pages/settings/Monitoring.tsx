// Phase 10A — the Monitoring pane in Settings.
//
// Two jobs, in this order:
//   1. the defaults every new monitor inherits, with the server's bounds shown next to each value —
//      the browser is a convenience here, the server is the authority, and the numbers say so;
//   2. the monitors that exist, as a list, so this pane is a place to understand the engine rather
//      than a second place to configure services.
//
// What is deliberately not here: a switch that makes monitoring reach further. There is no
// "allow all addresses", no "unlimited concurrency", no interval floor of one second, and no way to
// turn a check into an action. The internal-target setting is a *restriction* (public endpoints
// only), and the maintenance window is bounded by the server's own maximum.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { invalidateShared, put, usePolled } from '../../lib/api';
import { relTime } from '../../lib/format';
import type { MonitoringOverview, Monitor, MonitoringSettingsDoc, MonitoringSettings } from '../../lib/types';
import { Loading, ProviderNote } from '../../components/ui';
import { Block, Row } from './parts';
import { EngineLine, StateBadge, TargetLine } from '../../components/monitoring/parts';

const BOUND_WORDS: Record<string, { label: string; unit: string }> = {
  intervalMs: { label: 'Default interval', unit: 'seconds' },
  timeoutMs: { label: 'Default timeout', unit: 'seconds' },
  failureThreshold: { label: 'Failures before down', unit: 'checks' },
  recoveryThreshold: { label: 'Successes before up', unit: 'checks' },
  retentionSamples: { label: 'Recent samples kept', unit: 'per monitor' },
  retentionHours: { label: 'Hourly buckets kept', unit: 'hours' },
  retentionIncidents: { label: 'Resolved incidents kept', unit: 'records' },
  maxMonitors: { label: 'Monitor cap', unit: 'monitors' },
  maxConcurrent: { label: 'Concurrent checks', unit: 'checks' },
  jitterMs: { label: 'Scheduler jitter', unit: 'seconds' },
};

export function MonitoringSettingsTab() {
  const { data, error, loading, refresh } = usePolled<MonitoringSettingsDoc>('/api/monitoring/settings', 0);
  const { data: overview } = usePolled<MonitoringOverview>('/api/monitoring', 30_000);
  const [draft, setDraft] = useState<MonitoringSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => { if (data && !draft) setDraft(data.settings); }, [data, draft]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ProviderNote status="error" reason={error} />;
  if (!data || !draft) return null;
  const bounds = data.bounds;
  const monitors = overview?.monitors ?? [];

  const change = (patch: Partial<MonitoringSettings>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const changeAuto = (patch: Partial<MonitoringSettings['autoCreate']>) => setDraft((d) => (d ? { ...d, autoCreate: { ...d.autoCreate, ...patch } } : d));

  const save = async () => {
    setBusy(true); setMessage(null); setProblem(null);
    try {
      const res = await put<MonitoringSettingsDoc>('/api/monitoring/settings', { settings: draft });
      setDraft(res.settings);
      setMessage('Saved. Values outside the server’s bounds were clamped, and the result is shown here.');
      invalidateShared('/api/monitoring');
      refresh();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Block title="Monitoring" aside={overview ? <EngineLine health={overview.engine} at={overview.at} /> : undefined}>
        <p className="stale-note" style={{ marginTop: 0 }}>
          OpusHub checks the targets you configure — nothing else, and nothing on its own. Checks run on the
          server through one centralized scheduler with a bounded worker pool; detectors never act on what they
          find. Every value below has a hard bound on the server: what you type is a request, and what comes back
          is what the engine will actually do.
        </p>
      </Block>

      <Block title="Defaults" aside={<span className="stale-note">applied to new monitors, and used as the engine’s thresholds</span>}>
        <div className="form-list">
          {(['intervalMs', 'timeoutMs', 'failureThreshold', 'recoveryThreshold'] as const).map((key) => (
            <Row
              key={key}
              label={BOUND_WORDS[key].label}
              desc={`${BOUND_WORDS[key].unit} · server bound ${scaleFor(key, bounds[key]?.min)}–${scaleFor(key, bounds[key]?.max)}`}
              tight
            >
              <input
                className="input mon-setting-input"
                value={String(scaleFor(key, draft[key] as number))}
                inputMode="numeric"
                aria-label={BOUND_WORDS[key].label}
                onChange={(e) => change({ [key]: Number(e.target.value) * scaleFor(key, 1) } as Partial<MonitoringSettings>)}
              />
              <button className="btn btn-quiet btn-sm" onClick={() => change({ [key]: bounds[key]?.default } as Partial<MonitoringSettings>)}>Default</button>
            </Row>
          ))}
          <Row
            label="Internal targets"
            desc={draft.allowInternal
              ? 'A monitor may watch an address on your own network (RFC1918, CGNAT, IPv6 ULA). Loopback, link-local, metadata (169.254.169.254), multicast and reserved space are refused either way, and what a check reached is recorded on the monitor.'
              : 'Public endpoints only. A monitor that resolves to a private address produces no verdict and raises no alert; existing monitors keep their history and simply stop checking internal targets.'}
            tight
          >
            <label className="mon-switch">
              <input type="checkbox" checked={draft.allowInternal} onChange={(e) => change({ allowInternal: e.target.checked })} />
              <span>{draft.allowInternal ? 'allowed and marked internal' : 'public endpoints only'}</span>
            </label>
          </Row>
        </div>
      </Block>

      <Block title="Retention and load" aside={<span className="stale-note">bounded on purpose — a monitor is not allowed to grow without limit</span>}>
        <div className="form-list">
          {(['retentionSamples', 'retentionHours', 'retentionIncidents', 'maxMonitors', 'maxConcurrent', 'jitterMs'] as const).map((key) => (
            <Row key={key} label={BOUND_WORDS[key].label} desc={`${BOUND_WORDS[key].unit} · server bound ${scaleFor(key, bounds[key]?.min)}–${scaleFor(key, bounds[key]?.max)}`} tight>
              <input
                className="input mon-setting-input"
                value={String(scaleFor(key, draft[key] as number))}
                inputMode="numeric"
                aria-label={BOUND_WORDS[key].label}
                onChange={(e) => change({ [key]: Number(e.target.value) * scaleFor(key, 1) } as Partial<MonitoringSettings>)}
              />
              <button className="btn btn-quiet btn-sm" onClick={() => change({ [key]: bounds[key]?.default } as Partial<MonitoringSettings>)}>Default</button>
            </Row>
          ))}
        </div>
      </Block>

      <Block title="Discovery" aside={<span className="stale-note">nothing is watched just because it was found</span>}>
        <div className="form-list">
          <Row
            label="Create monitors from discovered services"
            desc="Off by default. When on, OpusHub creates monitors only for services that already expose an endpoint from a known source, never more than the cap below, and every one of them is marked as discovered in the list."
            tight
          >
            <label className="mon-switch">
              <input type="checkbox" checked={draft.autoCreate.enabled} onChange={(e) => changeAuto({ enabled: e.target.checked })} />
              <span>{draft.autoCreate.enabled ? 'on' : 'off'}</span>
            </label>
          </Row>
          <Row label="Discovery cap" desc={`monitors created from discovery at boot · server bound 0–${bounds.autoCreateMax?.max ?? 100}`} tight>
            <input className="input mon-setting-input" value={String(draft.autoCreate.max)} inputMode="numeric" aria-label="Discovery cap" onChange={(e) => changeAuto({ max: Number(e.target.value) })} />
          </Row>
        </div>
      </Block>

      <div className="mon-save">
        <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save defaults'}</button>
        {message && <span className="stale-note bg-url-state bg-url-state--ok" role="status">{message}</span>}
        {problem && <span className="stale-note bg-url-state bg-url-state--err" role="alert">{problem}</span>}
      </div>

      <Block title="Monitors" aside={<Link className="section-link" to="/monitoring">Open Monitoring →</Link>}>
        {!monitors.length
          ? <p className="stale-note">No monitors yet. They are created on the Monitoring page — from a discovered service, or by naming an endpoint yourself.</p>
          : (
            <div className="mon-list mon-list--settings">
              {monitors.slice(0, 40).map((m: Monitor) => (
                <div className="mon-row" key={m.id}>
                  <Link className="mon-row-main" to={`/monitoring/${m.id}`}>
                    <span className="mon-row-name">{m.name}</span>
                    <TargetLine monitor={m} />
                    <span className="stale-note">{m.lastCheck ? `checked ${relTime(m.lastCheck.at)}` : 'never checked'}</span>
                    <StateBadge state={m.enabled ? m.status : 'paused'} stale={m.stale} />
                  </Link>
                </div>
              ))}
            </div>
          )}
        {monitors.length > 40 && <p className="stale-note">Showing the first 40 of {monitors.length} — the full list is on the Monitoring page.</p>}
      </Block>

      <Block title="Boundaries" aside={<span className="stale-note">what monitoring is, and is not allowed to become</span>}>
        <ul className="mon-guarantees">
          {[
            'Monitors are read-only observers: no container is started, stopped or restarted, ever, and the Phase 8 operations engine is never invoked.',
            'No arbitrary URLs and no arbitrary hosts: a monitor’s target is either resolved from the canonical inventory or validated by the shared address policy — loopback, link-local/metadata, multicast and reserved space are refused outright.',
            'A TCP monitor is one host and one port. Ranges, lists and CIDR blocks are refused, so monitoring cannot be used as a scanner.',
            'Docker checks read the canonical inventory through the read-only provider client; there is no Docker API passthrough in this engine.',
            'No shell, no filesystem access, no AI, no notification channel of any kind in Phase 10A — the only outputs are recorded state, incidents, history, activity events and alert inputs.',
            'Missing data is never success: a monitor with no checks reports “no data”, and an engine that is not running marks everything below it as stale.',
            'History and incidents are persisted under the data directory, bounded by the retention values above, and survive a restart.',
          ].map((line) => <li key={line}>{line}</li>)}
        </ul>
      </Block>
    </>
  );
}

/** Milliseconds are stored, seconds are shown — except for the counts, which are counts. */
const MS_KEYS = new Set(['intervalMs', 'timeoutMs', 'jitterMs', 'maintenanceMaxMs']);
function scaleFor(key: string, value: number | undefined | null): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return MS_KEYS.has(key) ? Math.round(n / 1000) : n;
}
