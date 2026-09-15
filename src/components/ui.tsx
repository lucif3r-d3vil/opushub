// Small shared UI primitives: status, empty states, section heads, buttons, modals.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { ProviderStatus } from '../lib/types';
import { relTime } from '../lib/format';

export const STATUS_WORDS: Record<string, string> = {
  up: 'Online', down: 'Offline', unhealthy: 'Unhealthy', unmanaged: 'Not linked',
  unavailable: 'Unavailable', restarting: 'Restarting', paused: 'Paused', created: 'Created',
  operational: 'Operational', degraded: 'Degraded', attention: 'Needs attention', unlinked: 'Unlinked',
  stopped: 'Stopped', unknown: 'Unknown',
  ok: 'Available', error: 'Error', partial: 'Partial', unconfigured: 'Not configured', idle: 'Idle',
  available: 'Available', healthy: 'Healthy', unreachable: 'Unreachable', starting: 'Starting',
};

export function StatusDot({ state, title }: { state: string; title?: string }) {
  // note: `absent` (not `unavailable`) — the bare class name would collide with the
  // `.unavailable` provider-note box and the dot would inherit its padding/border.
  const cls = ['up', 'operational'].includes(state) ? 'up'
    : ['down', 'error', 'attention', 'fail'].includes(state) ? 'down'
      : ['unhealthy', 'degraded', 'restarting', 'partial'].includes(state) ? 'unhealthy'
        : state === 'unavailable' || state === 'unknown' ? 'absent'
          : state === 'stopped' ? 'stopped' : 'unmanaged';
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

/**
 * A page-level loading state.
 *
 * Announced (`role="status"`), single-line, and it names *what* is loading — a control plane that
 * shows a bare "Loading…" while it waits for the Docker daemon is telling the operator nothing.
 * It never renders alongside data: callers use it only when there is nothing else to show.
 */
export function Loading({ what = 'data', note }: { what?: string; note?: string }) {
  return (
    <p className="stale-note loading-note" role="status" aria-live="polite">
      Reading {what}…
      {note && <span className="loading-note-sub"> {note}</span>}
    </p>
  );
}

/**
 * Degraded-mode banner: Docker is gone, but something was seen before it left. Counts are
 * labelled as last-known with their timestamp — never presented as live — plus a way back.
 */
export function LastKnownNote({ at, lines, onRetry }: { at: number | null; lines: string[]; onRetry: () => void }) {
  return (
    <div className="unavailable" role="status" style={{ marginBottom: 'var(--sp-6)' }}>
      <span className="why">Last known state{at ? ` — ${relTime(at)}` : ''}.</span>
      {lines.map((l, i) => <span key={i} className="reason">{l}</span>)}
      <button className="btn btn-sm" onClick={onRetry} style={{ alignSelf: 'flex-start' }}>Retry</button>
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

export interface MenuItem { label?: string; icon?: ReactNode; action?: () => void; href?: string; danger?: boolean; sep?: boolean; active?: boolean }

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface MenuProps {
  items: MenuItem[];
  onClose: () => void;
  /** the control the menu belongs to — positioning is derived from its real box */
  anchor?: HTMLElement | null;
  /** fallback anchor point, for context menus opened at the pointer */
  x?: number;
  y?: number;
  align?: 'start' | 'end';
  /** accessible name of the popup itself (the trigger carries its own) */
  label?: string;
  /** focus the first item on open (default) — set false when the caller manages focus */
  autoFocus?: boolean;
}

/**
 * A menu that is *placed relative to its trigger*, measured after mount.
 *
 * Two details matter, and both were the reason a popup could land in the wrong place:
 *
 *  1. it renders through a portal on document.body. `position: fixed` inside a transformed or
 *     filtered ancestor (the page transition, a blurred surface) is positioned against that
 *     ancestor, not the viewport — so a menu could sit hundreds of pixels away from its button.
 *  2. the position comes from measuring the menu itself and the anchor's real rect: it opens
 *     below the trigger, flips above when there is no room, and is clamped into the viewport
 *     with an 8px gutter. It re-measures on resize and on any scroll.
 */
export function Menu({ items, onClose, anchor = null, x, y, align = 'end', label, autoFocus = true }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useIsoLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 6;
      const gutter = 8;
      let left: number;
      let top: number;
      const a = anchor?.getBoundingClientRect();
      if (a && (a.width || a.height)) {
        left = align === 'end' ? a.right - rect.width : a.left;
        top = a.bottom + gap;
        const above = a.top - gap - rect.height;
        if (top + rect.height > vh - gutter && above > gutter) top = above;
      } else {
        left = (x ?? 0) + 2;
        top = (y ?? 0) + 2;
        if (left + rect.width > vw - gutter) left = left - rect.width;      // context menu flips left
        if (top + rect.height > vh - gutter) top = Math.max(gutter, vh - gutter - rect.height);
      }
      left = Math.max(gutter, Math.min(left, vw - rect.width - gutter));
      top = Math.max(gutter, Math.min(top, vh - rect.height - gutter));
      setPos((cur) => (cur && Math.abs(cur.left - left) < 0.5 && Math.abs(cur.top - top) < 0.5 ? cur : { left, top }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor, align, x, y, items.length]);

  // keyboard: the menu behaves like a real menu, and closing restores focus to its trigger
  useEffect(() => {
    const el = ref.current;
    const focusables = () => [...(el?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [])];
    const restore = () => { if (typeof anchor?.focus === 'function') anchor.focus(); };
    if (autoFocus) focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); restore(); return; }
      if (e.key === 'Tab') { onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      const list = focusables();
      if (!list.length) return;
      e.preventDefault();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'Home' ? 0
        : e.key === 'End' ? list.length - 1
          : e.key === 'ArrowDown' ? (at + 1) % list.length
            : (at - 1 + list.length) % list.length;
      list[next]?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, anchor, autoFocus]);

  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      // a click on the trigger is the trigger's business — it toggles (and closing here would
      // make the toggle a no-op, leaving the menu apparently stuck open)
      if (anchor && (anchor === target || anchor.contains(target))) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('touchstart', onDown);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('touchstart', onDown); };
  }, [onClose, anchor]);

  const menu = (
    <div
      className="menu" ref={ref} role="menu" aria-label={label}
      data-anchored={anchor ? 'true' : undefined}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {items.map((it, i) =>
        it.sep ? <div className="sep" key={i} /> :
          it.label === undefined ? null :
            it.href ? (
              <a className="menu-item" key={i} href={it.href} role="menuitem" onClick={onClose}>{it.icon}{it.label}</a>
            ) : (
              <button key={i} role="menuitem" data-hl={it.active || undefined} aria-checked={it.active} className={it.danger ? 'danger' : ''} onClick={() => { it.action?.(); onClose(); }}>{it.icon}{it.label}</button>
            ))}
    </div>
  );
  // No portal when there is no DOM (server render) — the menu only ever opens on interaction.
  return typeof document === 'undefined' ? menu : createPortal(menu, document.body);
}

/**
 * A trigger + its menu, as one component. The button owns `aria-haspopup`/`aria-expanded`, opens
 * on click or ArrowDown, and the menu is always positioned against this exact element.
 */
export function MenuButton({
  items, label, className = 'icon-btn', align = 'end', menuAlign, title, children, disabled = false,
}: {
  items: MenuItem[];
  label: string;
  className?: string;
  align?: 'start' | 'end';
  /** alias kept for readability at call sites that think in terms of the popup */
  menuAlign?: 'start' | 'end';
  title?: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}
      >
        {children}
      </button>
      {open && (
        <Menu
          anchor={trigger.current}
          align={menuAlign || align}
          items={items}
          label={label}
          onClose={() => { setOpen(false); trigger.current?.focus(); }}
        />
      )}
    </>
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
