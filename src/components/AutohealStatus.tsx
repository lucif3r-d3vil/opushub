// Phase 10C — Autoheal Status UI Component
import { usePolled } from '../lib/api';
import type { AutohealStatusDoc } from '../lib/types';
import { StatusDot } from './ui';
import { relTime } from '../lib/format';

export function AutohealStatusArea() {
  const { data } = usePolled<AutohealStatusDoc>('/api/autoheal/status', 30_000);

  if (!data || !data.available) {
    return (
      <div className="detail-block">
        <h3 style={{ marginBottom: 'var(--sp-2)' }}>Container Auto-Recovery (Autoheal)</h3>
        <p className="stale-note">
          Docker Autoheal is not currently detected running on this host.
        </p>
      </div>
    );
  }

  return (
    <div className="detail-block">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusDot state={data.running ? 'up' : 'down'} />
          <h3 style={{ margin: 0 }}>Docker Autoheal</h3>
        </div>
        <span className="mono-meta stale-note">
          {data.running ? 'Running' : 'Stopped'}{data.version ? ` · v${data.version}` : ''}
        </span>
      </div>

      <dl className="kv">
        <dt>Monitored containers</dt>
        <dd>{data.monitoredCount} opted-in (autoheal=true)</dd>
        <dt>Unhealthy containers</dt>
        <dd>{data.unhealthyCount > 0 ? `${data.unhealthyCount} unhealthy` : 'None'}</dd>
        <dt>Last recovery</dt>
        <dd>
          {data.lastRecovery ? (
            <span>
              {data.lastRecovery.message} ({relTime(data.lastRecovery.t)})
            </span>
          ) : (
            <span className="stale-note">No recent recoveries recorded</span>
          )}
        </dd>
      </dl>

      {data.recentRecoveries && data.recentRecoveries.length > 0 && (
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <div className="stale-note" style={{ fontSize: '0.85em', marginBottom: 4 }}>Recent recovery activity:</div>
          <ul style={{ margin: 0, paddingLeft: 'var(--sp-4)', fontSize: '0.9em' }}>
            {data.recentRecoveries.slice(0, 5).map((r) => (
              <li key={r.id}>
                <span style={{ color: r.success ? 'var(--green, #10b981)' : 'var(--red, #ef4444)' }}>
                  {r.success ? '✓' : '✗'}
                </span>{' '}
                {r.message} <span className="stale-note">({relTime(r.t)})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
