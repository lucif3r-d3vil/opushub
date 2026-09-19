// Phase 10B — Notification Center UI (bell, list, read/unread)

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useNotifications, useUnreadCount } from '../lib/notifications';
import { relTime } from '../lib/format';
import { StatusDot } from './ui';

function severityDot(s: string) {
  if (s === 'critical') return 'down';
  if (s === 'warning') return 'unhealthy';
  if (s === 'notice') return 'up';
  return 'unmanaged';
}

export function NotificationBell() {
  const { unread } = useUnreadCount();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button
        className="icon-btn"
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
        title="Notifications"
        onClick={() => setOpen((v) => !v)}
        style={{ position: 'relative' }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width={20} height={20}>
          <path d="M6 9a6 6 0 0 1 12 0c0 7 6 5 6 10H0s6-3 6-10" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 21a3 3 0 0 0 6 0" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -2, right: -2,
            background: 'var(--danger)', color: 'white',
            borderRadius: '10px', fontSize: '10px', minWidth: '16px', height: '16px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px',
            fontWeight: 700,
          }}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && <NotificationPanel onClose={() => setOpen(false)} />}
    </div>
  );
}

export function NotificationPanel({ onClose }: { onClose?: () => void }) {
  const { notifications, unread, loading, error, markRead, markAllRead, refresh } = useNotifications(50);

  return (
    <div
      className="card"
      style={{
        position: 'absolute', right: 0, top: 'calc(100% + 8px)',
        width: 'min(420px, 90vw)', maxHeight: '70vh', overflow: 'auto',
        zIndex: 100, boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <strong>Notifications {unread > 0 && <span style={{ color: 'var(--danger)' }}>({unread})</span>}</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => { void markAllRead().then(() => refresh()); }}>Mark all read</button>
          {onClose && <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>}
        </div>
      </div>
      {loading && <p className="stale-note" style={{ padding: 16 }}>Loading…</p>}
      {error && <p className="stale-note" style={{ padding: 16, color: 'var(--warn)' }}>{error}</p>}
      {!loading && notifications.length === 0 && <p className="stale-note" style={{ padding: 16 }}>No notifications.</p>}
      <div>
        {notifications.map((n) => (
          <div
            key={n.id}
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--border)',
              background: n.read ? 'transparent' : 'var(--surface-2)',
              display: 'flex', gap: 10, alignItems: 'flex-start',
            }}
          >
            <StatusDot state={severityDot(n.severity)} title={n.severity} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: n.read ? 400 : 600, fontSize: '0.92rem', lineHeight: 1.3 }}>{n.title}</div>
              <div className="stale-note" style={{ marginTop: 2, fontSize: '0.82rem' }}>{n.message}</div>
              <div className="stale-note" style={{ marginTop: 4, fontSize: '0.75rem' }}>
                {relTime(n.t)} · {n.type} {n.source && `· ${n.source}`}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {!n.read && (
                <button className="btn btn-sm" onClick={() => { void markRead(n.id).then(() => refresh()); }}>Read</button>
              )}
              {n.href && (
                <Link to={n.href} className="btn btn-sm" onClick={() => onClose?.()}>Open</Link>
              )}
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: 12, textAlign: 'center' }}>
        <Link to="/activity" className="btn btn-sm" onClick={() => onClose?.()}>View Activity</Link>
        <Link to="/settings?tab=notifications" className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => onClose?.()}>Settings</Link>
      </div>
    </div>
  );
}

export function NotificationCenterPage() {
  const { notifications, unread, loading, error, markRead, markAllRead, refresh } = useNotifications(100);
  return (
    <div>
      <header className="page-hero">
        <h1 className="page-title">Notifications {unread > 0 && <span style={{ color: 'var(--danger)' }}>({unread} unread)</span>}</h1>
        <p className="page-desc">Live updates from monitoring, alerts, operations, and infrastructure. Mark read to clear the bell.</p>
      </header>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className="btn" onClick={() => { void markAllRead().then(() => refresh()); }}>Mark all read</button>
        <button className="btn" onClick={() => refresh()}>Refresh</button>
      </div>
      {loading && <p>Loading…</p>}
      {error && <p style={{ color: 'var(--warn)' }}>{error}</p>}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {notifications.length === 0 && !loading && <p className="stale-note" style={{ padding: 16 }}>No notifications.</p>}
        {notifications.map((n) => (
          <div key={n.id} style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 12, background: n.read ? 'transparent' : 'var(--surface-2)' }}>
            <StatusDot state={severityDot(n.severity)} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: n.read ? 400 : 600 }}>{n.title}</div>
              <div className="stale-note">{n.message}</div>
              <div className="stale-note" style={{ fontSize: '0.8rem', marginTop: 4 }}>{relTime(n.t)} · {n.type}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {!n.read && <button className="btn btn-sm" onClick={() => { void markRead(n.id).then(() => refresh()); }}>Mark read</button>}
              {n.href && <Link className="btn btn-sm" to={n.href}>Open</Link>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
