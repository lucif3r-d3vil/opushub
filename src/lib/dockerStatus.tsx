// Shared: docker availability banner + the read-only log viewer.
//
// The LogsDrawer is deliberately pull-only: it fetches while it is open (and when the user asks),
// never streams, never execs, never writes. Filtering, search and wrapping are client-side — the
// server is only ever asked for the last N lines of Docker's own container log.
import { useEffect, useMemo, useRef, useState } from 'react';
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
export function DockerOffNote({ reason, extra, fixHref = '/settings/environment' }: { reason?: string | null; extra?: ReactNode; fixHref?: string }) {
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

/** Docker prefixes timestamped lines with ISO-8601; lift it off so search/filter ignore it. */
const TS_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+/;
export function splitLogLine(line: string): { ts: string | null; text: string } {
  const m = TS_PREFIX.exec(line);
  return m ? { ts: m[1], text: line.slice(m[0].length) } : { ts: null, text: line };
}

const ERROR_RE = /\b(error|err|fatal|exception|fail(?:ed|ure)?|critical|panic|segfault|traceback)\b/i;
const WARN_RE = /\bwarn(?:ing)?\b|\bdeprecat(?:ed|ion)\b/i;

export type LogLevel = 'all' | 'errors' | 'warnings';
const RENDER_CAP = 500; // never hand the DOM more lines than this

export interface LogsDrawerProps {
  container: string;
  onClose: () => void;
  /** seconds between refreshes while open — never runs when closed */
  intervalMs?: number;
}

export function LogsDrawer({ container, onClose, intervalMs = 15_000 }: LogsDrawerProps) {
  const [timestamps, setTimestamps] = useState(false);
  const [tail, setTail] = useState(200);
  const [wrap, setWrap] = useState(true);
  const [level, setLevel] = useState<LogLevel>('all');
  const [query, setQuery] = useState('');
  const [cleared, setCleared] = useState(false); // “clear” is a local view state only
  const [copied, setCopied] = useState(false);
  const path = `/api/docker/containers/${encodeURIComponent(container)}/logs?tail=${tail}${timestamps ? '&timestamps=1' : ''}`;
  const { data, loading, refresh, fetchedAt } = usePolled<{ status: string; lines?: string[]; reason?: string }>(path, intervalMs);
  const bodyRef = useRef<HTMLDivElement>(null);
  const firstLoad = useRef(true);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (firstLoad.current && data?.status === 'ok' && bodyRef.current) {
      firstLoad.current = false;
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [data]);

  const lines = useMemo(() => (data?.lines || []).map(cleanLogLine), [data]);
  const filtered = useMemo(() => {
    let out = lines;
    if (level === 'errors') out = out.filter((l) => ERROR_RE.test(splitLogLine(l).text));
    if (level === 'warnings') out = out.filter((l) => WARN_RE.test(splitLogLine(l).text));
    const q = query.trim().toLowerCase();
    if (q) out = out.filter((l) => splitLogLine(l).text.toLowerCase().includes(q));
    return out;
  }, [lines, level, query]);
  const shown = filtered.slice(-RENDER_CAP);
  const clipping = filtered.length - shown.length;

  useEffect(() => {
    if (stickToBottom.current && bodyRef.current && !query) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [shown.length, query]);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(shown.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — say nothing dramatic */ }
  };

  const counts = useMemo(() => ({
    errors: lines.filter((l) => ERROR_RE.test(splitLogLine(l).text)).length,
    warnings: lines.filter((l) => WARN_RE.test(splitLogLine(l).text)).length,
  }), [lines]);

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true" aria-label={`Logs for ${container}`}>
      <div className="drawer">
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{container}</b>
            <span className="stale-note" role="status">
              {data?.status === 'ok'
                ? `${lines.length} line${lines.length === 1 ? '' : 's'} · updates every ${Math.round(intervalMs / 1000)}s while open`
                : data?.status === 'unavailable' ? 'logs unavailable' : data?.status === 'error' ? 'logs error' : 'reading…'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-quiet btn-sm" onClick={() => { setCleared(false); refresh(); }}>Refresh</button>
            <button className="btn btn-quiet btn-sm" onClick={copyAll} disabled={!shown.length}>{copied ? 'Copied' : 'Copy'}</button>
            <button className="btn btn-quiet btn-sm" onClick={() => setCleared(true)} disabled={!lines.length} title="Hide the current view until the next refresh">Clear view</button>
            <button className="icon-btn" onClick={onClose} aria-label="Close logs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg></button>
          </div>
        </div>

        <div className="logbar" role="toolbar" aria-label="Log view options">
          <input
            className="logbar-search"
            type="search"
            placeholder="Search logs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search logs"
          />
          <div className="seg" role="group" aria-label="Filter by level">
            <button aria-pressed={level === 'all'} onClick={() => setLevel('all')}>All</button>
            <button aria-pressed={level === 'errors'} onClick={() => setLevel('errors')}>Errors{counts.errors ? ` (${counts.errors})` : ''}</button>
            <button aria-pressed={level === 'warnings'} onClick={() => setLevel('warnings')}>Warnings{counts.warnings ? ` (${counts.warnings})` : ''}</button>
          </div>
          <select className="logbar-select" value={tail} onChange={(e) => setTail(Number(e.target.value))} aria-label="How much history to fetch">
            <option value={100}>last 100</option>
            <option value={200}>last 200</option>
            <option value={500}>last 500</option>
          </select>
          <label className="stale-note logbar-chk"><input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />timestamps</label>
          <label className="stale-note logbar-chk"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />wrap</label>
        </div>

        <div
          className="drawer-body"
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {loading && !data && <div style={{ padding: 'var(--sp-6)' }} className="stale-note">Loading logs…</div>}
          {data && data.status !== 'ok' && (
            <div style={{ padding: 'var(--sp-6)' }} className="stale-note" role="status">
              {data.reason || 'Logs unavailable.'}
              {data.reason && /no such container/i.test(data.reason) ? ' It may have been removed — close this drawer and refresh the page.' : ''}
            </div>
          )}
          {data?.status === 'ok' && cleared && (
            <div style={{ padding: 'var(--sp-6)' }} className="stale-note" role="status">
              View cleared locally — press Refresh to pull the latest {tail} lines again.
            </div>
          )}
          {data?.status === 'ok' && !cleared && (
            <>
              {clipping > 0 && <div className="stale-note" style={{ padding: '8px var(--sp-4) 0' }}>showing the last {shown.length} of {filtered.length} matching lines</div>}
              {shown.length === 0 && (
                <div style={{ padding: 'var(--sp-6)' }} className="stale-note" role="status">
                  {lines.length === 0
                    ? '(no output — the container has logged nothing recently)'
                    : '(nothing matches — adjust the search or level filter)'}
                </div>
              )}
              {shown.length > 0 && (
                <pre className={`logbox${wrap ? ' logbox-wrap' : ''}`} style={{ maxHeight: '60dvh', margin: 0 }}>
                  {shown.map((l, i) => {
                    const { ts, text } = splitLogLine(l);
                    const tone = ERROR_RE.test(text) ? 'log-err' : WARN_RE.test(text) ? 'log-warn' : '';
                    return (
                      <span key={i} className={`logline ${tone}`}>
                        {timestamps && ts && <span className="log-ts">{ts} </span>}
                        {text}
                        {'\n'}
                      </span>
                    );
                  })}
                </pre>
              )}
            </>
          )}
        </div>
        <div className="drawer-foot stale-note" aria-live="polite">
          {fetchedAt ? `fetched ${new Date(fetchedAt).toLocaleTimeString()}` : 'not fetched yet'} · read-only — OpusHub never sends input to containers
        </div>
      </div>
    </div>
  );
}
