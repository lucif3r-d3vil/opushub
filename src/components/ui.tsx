// Small shared UI primitives: status, empty states, section heads, buttons, modals.
import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ProviderStatus } from '../lib/types';
import { relTime } from '../lib/format';

export const STATUS_WORDS: Record<string, string> = {
  up: 'Online', down: 'Offline', unhealthy: 'Unhealthy', unmanaged: 'Not linked',
  unavailable: 'Unavailable', restarting: 'Restarting', paused: 'Paused',
  operational: 'Operational', degraded: 'Degraded', attention: 'Needs attention', unlinked: 'Unlinked',
  ok: 'Available', error: 'Error', partial: 'Partial', unconfigured: 'Not configured', idle: 'Idle',
};

export function StatusDot({ state, title }: { state: string; title?: string }) {
  // note: `absent` (not `unavailable`) — the bare class name would collide with the
  // `.unavailable` provider-note box and the dot would inherit its padding/border.
  const cls = ['up', 'operational'].includes(state) ? 'up'
    : ['down', 'error', 'attention', 'fail'].includes(state) ? 'down'
      : ['unhealthy', 'degraded', 'restarting', 'partial'].includes(state) ? 'unhealthy'
        : state === 'unavailable' ? 'absent' : 'unmanaged';
  return <span className={`status-dot ${cls}`} role="img" aria-label={title || STATUS_WORDS[state] || state} title={title} />;
}

export function StatusLine({ state, note, className = '' }: { state: string; note?: string | null; className?: string }) {
  return (
    <span className={`status-line ${className}`} title={note || undefined}>
      <StatusDot state={state} />
      <span className="word">{STATUS_WORDS[state] || state}</span>
    </span>
  );
}

/** The single honest "there is no data" surface: what's missing, why, and how to fix it.
 *  Quiet by design — absence is not an error; only real failures get the dashed alert box.
 *  Technical detail (socket paths, fetch errors) tucks under a Details disclosure. */
export function ProviderNote({
  status, reason, fixHref, fixLabel = 'Configure →', compact = false, details,
}: { status: ProviderStatus | string; reason?: string | null; fixHref?: string; fixLabel?: string; compact?: boolean; details?: string | null }) {
  const alert = status === 'error' || status === 'partial';
  return (
    <div className={`unavailable${alert ? ' alert' : ''}${compact ? ' compact' : ''}`} role={alert ? 'alert' : 'status'}>
      <span className="why">
        {status === 'unconfigured' ? 'Not set up yet.' : status === 'unavailable' ? 'Unavailable.' : status === 'partial' ? 'Partially available.' : status === 'error' ? 'Something failed.' : 'No data.'}
      </span>
      {reason && <span className="reason">{reason}</span>}
      {fixHref && <Link to={fixHref} className="act">{fixLabel}</Link>}
      {details && <details className="tech"><summary>Details</summary><code>{details}</code></details>}
    </div>
  );
}

export function Freshness({ at, error }: { at: number | null; error?: string | null }) {
  if (error) return <span className="stale-note" style={{ color: 'var(--warn)' }}>stale — retrying</span>;
  if (!at) return null;
  return <span className="stale-note" title={new Date(at).toLocaleString()}>updated {relTime(at)}</span>;
}

export function SectionHead({ title, right, id }: { title: ReactNode; right?: ReactNode; id?: string }) {
  return (
    <div className="section-head" id={id}>
      <h2 className="section-title">{title}</h2>
      {right && <div className="section-aside">{right}</div>}
    </div>
  );
}

export function OpenLink({ href, label = 'Open', onOpen }: { href: string | null; label?: string; onOpen?: () => void }) {
  if (!href) return <span className="stale-note">No URL</span>;
  const external = /^https?:\/\//i.test(href);
  const to = (e: React.MouseEvent) => {
    if (external) onOpen?.();
    else if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); window.open(href, '_self'); onOpen?.(); }
  };
  return (
    <a
      className="btn btn-sm"
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
      onClick={to}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      {label}
    </a>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>('input,textarea,select,button')?.focus(), 30);
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; clearTimeout(t); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-modal="true" ref={ref}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export interface MenuItem { label?: string; icon?: ReactNode; action?: () => void; href?: string; danger?: boolean; sep?: boolean }

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - items.length * 34 - 20);
  return (
    <div className="menu" ref={ref} style={{ left, top }} role="menu">
      {items.map((it, i) =>
        it.sep ? <div className="sep" key={i} /> :
          it.label === undefined ? null :
            it.href ? (
              <a className="menu-item" key={i} href={it.href} role="menuitem" onClick={onClose}>{it.icon}{it.label}</a>
            ) : (
              <button key={i} role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => { it.action?.(); onClose(); }}>{it.icon}{it.label}</button>
            ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />
  );
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; ariaLabel?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)} type="button">{o.label}</button>
      ))}
    </div>
  );
}

export function PageHero({ title, desc, meta, actions, children }: {
  title: ReactNode; desc?: ReactNode; meta?: ReactNode; actions?: ReactNode; children?: ReactNode;
}) {
  return (
    <header className="page-hero">
      <div style={{ display: 'flex', gap: 'var(--sp-6)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 className="page-title">{title}</h1>
          {desc && <p className="page-desc">{desc}</p>}
          {children}
        </div>
        {(actions || meta) && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 'var(--sp-3)', justifyContent: 'center', paddingTop: 4 }}>
            {actions && <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>{actions}</div>}
            {meta && <div className="page-meta" style={{ margin: 0 }}>{meta}</div>}
          </div>
        )}
      </div>
    </header>
  );
}
