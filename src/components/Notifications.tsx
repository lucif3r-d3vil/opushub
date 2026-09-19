// Phase 10B — Notification Center UI (bell, panel, page)
//
// The bell lives in the shell (rail on desktop, bottom bar on mobile) so it is present on
// every page. The panel is portalled to document.body and positioned against the bell with
// the same measure/flip/clamp discipline as Menu — the first version was absolutely
// positioned inside the 56px rail item, which pushed it off-viewport to the left.
//
// Data: useNotifications() polls quietly AND refreshes on every live SSE event, silently —
// the server stays the source of truth, so live inserts can neither duplicate a row nor
// resurrect one already marked read.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { safeHref, useLiveStatus, useNotifications, useUnreadCount, type Notification } from '../lib/notifications';
import { relTime } from '../lib/format';
import { StatusDot } from './ui';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function severityDot(s: string) {
  if (s === 'critical') return 'down';
  if (s === 'warning') return 'unhealthy';
  if (s === 'notice') return 'up';
  return 'unmanaged';
}

export function NotificationBell() {
  const { unread } = useUnreadCount();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    // focus returns to the trigger, like Menu
    btnRef.current?.focus();
  };

  return (
    <>
      <button
        ref={btnRef}
        className="icon-btn notif-bell"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Notifications"
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => { if (!open && e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}
        style={{ position: 'relative' }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width={20} height={20}>
          <path d="M6 9a6 6 0 0 1 12 0c0 7 6 5 6 10H0s6-3 6-10" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 21a3 3 0 0 0 6 0" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {/* live from persisted server state; hidden at 0; tabular numerals + min-width so
            9→10→99+ never jitters the layout */}
        {unread > 0 && (
          <span className="notif-badge" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && <NotificationPanel anchor={btnRef.current} onClose={close} />}
    </>
  );
}

function LiveChip() {
  const { status } = useLiveStatus();
  if (status === 'live') {
    return <span className="notif-live" data-state="live" title="Live updates connected"><span className="dot" />Live</span>;
  }
  if (status === 'connecting') {
    return <span className="notif-live" data-state="connecting" title="Connection lost — retrying"><span className="dot" />Reconnecting…</span>;
  }
  return <span className="notif-live" data-state="polling" title="Polling for updates"><span className="dot" />Polling</span>;
}

function NotificationRow({ n, busy, onRead, onNavigate }: {
  n: Notification;
  busy: boolean;
  onRead: (id: string) => void;
  onNavigate: () => void;
}) {
  const href = safeHref(n.href);
  return (
    <div className="notif-row" data-read={n.read ? 'true' : 'false'} data-severity={n.severity}>
      <StatusDot state={severityDot(n.severity)} title={n.severity} />
      <div className="notif-row-body">
        <div className="notif-row-title">{n.title}</div>
        {n.message && n.message !== n.title && <div className="notif-row-msg">{n.message}</div>}
        <div className="notif-row-meta">
          <span title={new Date(n.t).toLocaleString()}>{relTime(n.t)}</span>
          <span aria-label={`severity ${n.severity}`}>{n.severity}</span>
          <span>{n.type}</span>
          {n.source && <span>{n.source}</span>}
        </div>
      </div>
      <div className="notif-row-actions">
        {!n.read && (
          <button className="btn btn-sm" disabled={busy} onClick={() => onRead(n.id)}>
            {busy ? '…' : 'Read'}
          </button>
        )}
        {href && (
          <Link to={href} className="btn btn-sm" onClick={onNavigate}>Open</Link>
        )}
      </div>
    </div>
  );
}

export function NotificationPanel({ anchor, onClose }: { anchor?: HTMLElement | null; onClose: () => void }) {
  const { notifications, unread, loading, error, markRead, markAllRead, refresh } = useNotifications(50);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAll, setBusyAll] = useState(false);

  // placement: below the bell, left-aligned with it (the rail sits at the viewport's left
  // edge, so end-alignment would clamp over the rail); flips above when there is no room
  // below (the mobile bar), and clamps into the viewport on every resize/scroll
  useIsoLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 8;
      const gutter = 8;
      const a = anchor?.getBoundingClientRect();
      let left = gutter;
      let top = gap;
      if (a && (a.width || a.height)) {
        left = a.left;
        top = a.bottom + gap;
        const height = rect.height || 320;
        const above = a.top - gap - height;
        if (top + height > vh - gutter && above > gutter) top = Math.max(gutter, above);
      }
      const width = rect.width || Math.min(420, vw - gutter * 2);
      left = Math.max(gutter, Math.min(left, vw - width - gutter));
      top = Math.max(gutter, Math.min(top, vh - (rect.height || 320) - gutter));
      setPos((cur) => (cur && Math.abs(cur.left - left) < 0.5 && Math.abs(cur.top - top) < 0.5 ? cur : { left, top }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor]);

  // keyboard: Escape closes (focus was already restored by the bell's close), Tab moves on
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Tab') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // click-outside closes; a click on the bell itself is the bell's business (it toggles)
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchor && (anchor === target || anchor.contains(target))) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('touchstart', onDown);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('touchstart', onDown); };
  }, [onClose, anchor]);

  const doRead = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try { await markRead(id); } catch { /* the error banner survives below */ } finally { setBusyId(null); }
  };
  const doReadAll = async () => {
    if (busyAll) return;
    setBusyAll(true);
    try { await markAllRead(); } catch {} finally { setBusyAll(false); }
  };

  const panel = (
    <div
      ref={ref}
      className="notif-panel"
      role="dialog"
      aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ''}`}
      tabIndex={-1}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <div className="notif-head">
        <strong>Notifications {unread > 0 && <span className="notif-unread">({unread})</span>}</strong>
        <div className="notif-head-actions">
          <LiveChip />
          <button className="btn btn-sm" disabled={busyAll || unread === 0} onClick={() => void doReadAll()}>
            {busyAll ? 'Marking…' : 'Mark all read'}
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Close notifications">✕</button>
        </div>
      </div>
      <div className="notif-list">
        {loading && <p className="stale-note notif-state">Loading…</p>}
        {!loading && error && (
          <div className="notif-state">
            <p className="stale-note" style={{ color: 'var(--warn)' }}>{error}</p>
            <button className="btn btn-sm" onClick={() => refresh()}>Retry</button>
          </div>
        )}
        {!loading && !error && notifications.length === 0 && (
          <p className="stale-note notif-state">You're all caught up — new monitoring, alert, operation and infrastructure events will appear here.</p>
        )}
        {notifications.map((n) => (
          <NotificationRow key={n.id} n={n} busy={busyId === n.id} onRead={(id) => void doRead(id)} onNavigate={onClose} />
        ))}
      </div>
      <div className="notif-foot">
        <Link to="/activity" className="btn btn-sm" onClick={onClose}>View Activity</Link>
        <Link to="/settings/notifications" className="btn btn-sm" onClick={onClose}>Settings</Link>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? panel : createPortal(panel, document.body);
}

// There is deliberately no separate notifications page: the bell + this panel are the one
// notification UI (Phase 10B). The Activity page owns history, Settings owns policy, and the
// panel links to both — three surfaces, one system.
