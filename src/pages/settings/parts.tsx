// The row/block primitives every settings pane is built from.
//
// These were local to Settings.tsx until Phase 6 added four more panes in a second file. Two copies
// of a `Row` is how a settings screen starts looking like two settings screens, so they live here
// and both files import them.
import type { ReactNode } from 'react';
import { Loading } from '../../components/ui';

export function Row({ label, desc, children, tight }: { label: ReactNode; desc?: ReactNode; children: ReactNode; tight?: boolean }) {
  return (
    <div className="form-row" style={tight ? { padding: '10px 0' } : undefined}>
      <div>
        <div className="fr-label">{label}</div>
        {desc && <div className="fr-desc">{desc}</div>}
      </div>
      <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>{children}</div>
    </div>
  );
}

export function Block({ title, children, aside }: { title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section style={{ marginBottom: 'var(--section-gap)' }}>
      <div className="section-head" style={{ marginBottom: 2 }}>
        <h2 className="section-title">{title}</h2>
        <span className="section-aside">{aside}</span>
      </div>
      {children}
    </section>
  );
}

export { Loading };

/** A quiet status line for an in-progress or completed operation. */
export function Busy({ state, error, done }: { state: boolean; error: string | null; done?: string | null }) {
  if (state) return <span className="stale-note" role="status">Working…</span>;
  if (error) return <span className="stale-note bg-url-state bg-url-state--err" role="alert">{error}</span>;
  if (done) return <span className="stale-note bg-url-state bg-url-state--ok" role="status">{done}</span>;
  return null;
}

/** `2026-09-15T12:00:00.000Z` → something a person reads. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Bytes, said the way a person says them. */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
