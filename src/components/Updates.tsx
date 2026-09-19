// Phase 10C — Container Updates & Autoheal Modal & Controls
import { useState } from 'react';
import { api, usePolled } from '../lib/api';
import type { ContainerUpdateRecord, ContainerUpdatesDoc } from '../lib/types';
import { Loading } from './ui';

export function GlobalUpdateIndicator() {
  const { data } = usePolled<ContainerUpdatesDoc>('/api/container-updates', 30_000);
  const [open, setOpen] = useState(false);
  const available = data?.availableCount ?? 0;

  if (available <= 0) return null;

  return (
    <>
      <button
        className="chip active"
        onClick={() => setOpen(true)}
        title={`${available} container update${available === 1 ? '' : 's'} available`}
        style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <span className="dot" style={{ background: 'var(--amber, #f59e0b)' }} />
        <span>Updates available: {available}</span>
      </button>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Container Image Updates</h2>
              <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </div>
            <div className="modal-body">
              <p className="stale-note" style={{ marginBottom: 'var(--sp-4)' }}>
                Image updates detected by Diun. All updates require explicit confirmation.
              </p>
              <div className="update-list" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
                {(data?.updates || [])
                  .filter((u) => u.status === 'update_available' || u.status === 'updating')
                  .map((u) => (
                    <UpdateItemRow key={u.containerId} record={u} onDone={() => setOpen(false)} />
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function UpdateItemRow({ record, onDone }: { record: ContainerUpdateRecord; onDone?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [dryRunPlan, setDryRunPlan] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(record.status);

  const startUpdateFlow = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<any>('/api/container-updates/dry-run', {
        method: 'POST',
        body: JSON.stringify({ target: { type: 'container', id: record.containerId } }),
      });
      setDryRunPlan(res);
      setConfirming(true);
    } catch (err: any) {
      setError(err?.message || 'Preflight check failed');
    } finally {
      setLoading(false);
    }
  };

  const executeUpdate = async () => {
    if (!dryRunPlan?.confirmation?.token) return;
    setLoading(true);
    setError(null);
    setStatus('updating');
    try {
      await api('/api/container-updates/apply', {
        method: 'POST',
        body: JSON.stringify({
          target: { type: 'container', id: record.containerId },
          confirmationToken: dryRunPlan.confirmation.token,
        }),
      });
      setStatus('updated');
      setConfirming(false);
      if (onDone) setTimeout(onDone, 1200);
    } catch (err: any) {
      setError(err?.message || 'Update failed');
      setStatus('failed');
    } finally {
      setLoading(false);
    }
  };

  const isUpdating = status === 'updating';
  const isUpdated = status === 'updated';

  return (
    <div className="row" style={{ padding: 'var(--sp-3)', border: '1px solid var(--border-quiet)', borderRadius: 8 }}>
      <div className="grow">
        <div style={{ fontWeight: 600 }}>{record.serviceId || record.containerId}</div>
        <div className="mono-meta stale-note" style={{ fontSize: '0.85em', wordBreak: 'break-all' }}>
          {record.imageRef}
        </div>
        <div className="stale-note" style={{ fontSize: '0.85em', marginTop: 4 }}>
          Current: {record.currentTag || record.currentDigest?.slice(0, 19) || 'unknown'} → Available:{' '}
          {record.availableTag || record.availableDigest?.slice(0, 19) || 'new digest'}
        </div>
        {!record.updateEligible && (
          <div style={{ color: 'var(--amber, #f59e0b)', fontSize: '0.85em', marginTop: 4 }}>
            Update unavailable: {record.ineligibilityReason}
          </div>
        )}
        {error && (
          <div style={{ color: 'var(--red, #ef4444)', fontSize: '0.85em', marginTop: 4 }}>
            {error}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {isUpdated ? (
          <span className="badge up">Updated</span>
        ) : isUpdating ? (
          <span className="stale-note">Updating…</span>
        ) : status === 'rolled_back' ? (
          <span className="badge warn" title="Previous version restored">Rolled back</span>
        ) : status === 'recovery_required' ? (
          <span className="badge down" title="Manual recovery required">Recovery required</span>
        ) : (
          <button
            className="btn btn-sm btn-primary"
            disabled={!record.updateEligible || loading}
            onClick={startUpdateFlow}
          >
            {loading ? 'Checking…' : 'Update now'}
          </button>
        )}
      </div>

      {confirming && dryRunPlan && (
        <div className="modal-backdrop" onClick={() => setConfirming(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{dryRunPlan.confirmation?.prompt?.title || `Update ${record.serviceId}?`}</h2>
              <button className="icon-btn" onClick={() => setConfirming(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p>{dryRunPlan.confirmation?.prompt?.body}</p>
              <dl className="kv" style={{ margin: 'var(--sp-4) 0' }}>
                <dt>Image</dt>
                <dd className="mono-meta">{record.imageRef}</dd>
                {record.currentDigest && (
                  <>
                    <dt>Current digest</dt>
                    <dd className="mono-meta">{record.currentDigest}</dd>
                  </>
                )}
                {record.availableDigest && (
                  <>
                    <dt>Available digest</dt>
                    <dd className="mono-meta">{record.availableDigest}</dd>
                  </>
                )}
              </dl>
              <div className="stale-note" style={{ marginBottom: 'var(--sp-4)' }}>
                This will pull the updated image and recreate/restart the container. Volumes and environment will be preserved.
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button className="btn btn-quiet" onClick={() => setConfirming(false)} disabled={loading}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={executeUpdate} disabled={loading}>
                  {loading ? 'Updating…' : 'Confirm & update'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
