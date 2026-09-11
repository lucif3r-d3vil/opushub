// Shared: docker availability banner used wherever container info is expected.
import { usePolled } from '../lib/api';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface DockerStatus { ok: boolean; reason?: string; version?: string }

export function useDockerStatus(refreshMs = 60_000) {
  return usePolled<DockerStatus>('/api/docker/status', refreshMs);
}

export function DockerOffNote({ reason, extra }: { reason?: string | null; extra?: ReactNode }) {
  return (
    <div className="unavailable" role="status">
      <span className="why">Docker is not connected — container-level detail is unavailable.</span>
      {reason && <span style={{ opacity: 0.9 }}>{reason}</span>}
      <span style={{ opacity: 0.85 }}>
        Set <code>OPUSHUB_DOCKER_SOCKET</code> or <code>DOCKER_HOST</code> in the server environment.
      </span>
      {extra}
    </div>
  );
}

export function LogsDrawer({ container, onClose }: { container: string; onClose: () => void }) {
  const { data, loading } = usePolled<{ status: string; lines?: string[]; reason?: string }>(`/api/docker/containers/${encodeURIComponent(container)}/logs?tail=200`, 30_000);
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-label={`Logs for ${container}`}>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <b style={{ fontSize: 15 }}>{container}</b>
            <span className="stale-note" style={{ marginLeft: 10 }}>last 200 lines · updates every 30s</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg></button>
        </div>
        <div className="drawer-body">
          {loading && !data && <div style={{ padding: 'var(--sp-6)' }} className="stale-note">Loading logs…</div>}
          {data && data.status !== 'ok' && <div style={{ padding: 'var(--sp-6)' }} className="stale-note">{data.reason || 'Logs unavailable.'}</div>}
          {data?.status === 'ok' && (
            <pre className="logbox" style={{ maxHeight: '60dvh', margin: 0 }}>{data.lines?.join('\n') || '(no output)'}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
