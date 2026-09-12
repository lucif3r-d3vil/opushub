// Shared: docker availability banner used wherever container info is expected.
import { useEffect, useRef, useState } from 'react';
import { usePolled } from '../lib/api';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface DockerStatus {
  ok: boolean;
  state?: 'connected' | 'no-socket' | 'socket-missing' | 'invalid-endpoint' | 'unreachable';
  reason?: string;
  version?: string;
  api?: string;
}

export function useDockerStatus(refreshMs = 60_000) {
  return usePolled<DockerStatus>('/api/docker/status', refreshMs);
}

/** The honest "Docker is off" surface: a sentence, a fix, and the raw reason tucked away. */
export function DockerOffNote({ reason, extra, fixHref = '/settings/system' }: { reason?: string | null; extra?: ReactNode; fixHref?: string }) {
  return (
    <div className="unavailable" role="status">
      <span className="why">Docker isn't connected.</span>
      <span className="reason">OpusHub can't see containers, so live status, stats and logs stay off. Connect the engine and this fills in automatically.</span>
      <Link to={fixHref} className="act">Configure Docker →</Link>
      {reason && (
        <details className="tech">
          <summary>Details</summary>
          <code>{reason}</code>
        </details>
      )}
      {extra}
    </div>
  );
}

const ANSI = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
/** Container logs arrive with color codes, carriage returns and the occasional bell. */
export function cleanLogLine(line: string): string {
  return line.replace(ANSI, '').replace(/\r/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

const RENDER_CAP = 500; // never hand the DOM more lines than this

export function LogsDrawer({ container, onClose }: { container: string; onClose: () => void }) {
  const [timestamps, setTimestamps] = useState(false);
  const { data, loading } = usePolled<{ status: string; lines?: string[]; reason?: string }>(
    `/api/docker/containers/${encodeURIComponent(container)}/logs?tail=200${timestamps ? '&timestamps=1' : ''}`,
    30_000,
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const firstLoad = useRef(true);
  useEffect(() => {
    if (firstLoad.current && data?.status === 'ok' && bodyRef.current) {
      firstLoad.current = false;
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [data]);
  const lines = (data?.lines || []).map(cleanLogLine);
  const shown = lines.slice(-RENDER_CAP);
  const clipped = lines.length - shown.length;
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-label={`Logs for ${container}`}>
      <div className="drawer">
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{container}</b>
            <span className="stale-note">last 200 lines · updates every 30s</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="stale-note" style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} aria-label="Show timestamps" />
              timestamps
            </label>
            <button className="icon-btn" onClick={onClose} aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg></button>
          </div>
        </div>
        <div className="drawer-body" ref={bodyRef}>
          {loading && !data && <div style={{ padding: 'var(--sp-6)' }} className="stale-note">Loading logs…</div>}
          {data && data.status !== 'ok' && <div style={{ padding: 'var(--sp-6)' }} className="stale-note">{data.reason || 'Logs unavailable.'}</div>}
          {data?.status === 'ok' && (
            <>
              {clipped > 0 && <div className="stale-note" style={{ padding: '8px var(--sp-4) 0' }}>showing the last {shown.length} of {lines.length} lines</div>}
              <pre className="logbox" style={{ maxHeight: '60dvh', margin: 0 }}>{shown.join('\n') || '(no output — the container has logged nothing recently)'}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
