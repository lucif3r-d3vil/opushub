// Phase 10B — notification client (unread count, list, browser permission)

import { useCallback, useEffect, useState } from 'react';
import { api, invalidateShared, post, put, useSharedQuery } from './api';
import { subscribeLiveEvents, subscribeLiveStatus, type LiveConnection } from './sse';

export interface Notification {
  id: string;
  eventId: string;
  t: number;
  type: string;
  severity: 'info' | 'notice' | 'warning' | 'critical';
  source: string;
  title: string;
  message: string;
  href: string | null;
  read: boolean;
  readAt: number | null;
}

/**
 * The event types the server turns into notifications (mirrors notifiableTypes in
 * server/notifications/init.js). The client uses this only to decide which live events
 * are worth a silent re-fetch — the server remains the source of truth.
 */
export const NOTIFIABLE_TYPES = new Set([
  'monitor.state_changed',
  'monitor.incident.opened',
  'monitor.incident.recovered',
  'alert.created',
  'alert.resolved',
  'operation.completed',
  'operation.failed',
  'operation.timed_out',
  'service.down',
  'service.up',
  'service.unhealthy',
  'service.healthy',
  // Phase 10C — container image updates observed by Diun, applied updates, and autoheal
  // recoveries are notifications too (this list had drifted five types behind the server).
  'container.update_available',
  'container.updated',
  'container.update_failed',
  'container.autoheal.restarted',
  'container.autoheal.failed',
]);

/** Defense in depth: the server already sanitizes hrefs, the client never trusts one blindly. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string' || !href) return null;
  if (!href.startsWith('/') || href.startsWith('//')) return null;
  return href.slice(0, 500);
}

/**
 * Whenever any open SSE connection delivers a notifiable event, silently re-fetch every
 * notification query (list + unread badge share the '/api/notifications' prefix). Silent
 * means: no loading flash, no scroll reset, and read flags come back from the server, so a
 * live insert can neither duplicate a row nor resurrect one already marked read.
 */
function useNotificationsLive() {
  useEffect(() => subscribeLiveEvents((evt) => {
    if (evt && NOTIFIABLE_TYPES.has(evt.type)) invalidateShared('/api/notifications');
  }), []);
}

/** Aggregate SSE connection state for the panel's Live/Reconnecting indicator. */
export function useLiveStatus(): { status: LiveConnection; attempts: number } {
  const [status, setStatus] = useState<LiveConnection>('idle');
  const [attempts, setAttempts] = useState(0);
  useEffect(() => subscribeLiveStatus((s, a) => { setStatus(s); setAttempts(a); }), []);
  return { status, attempts };
}

export function useNotifications(limit = 50) {
  const q = useSharedQuery<{ notifications: Notification[]; unread: number; count: number }>(`/api/notifications?limit=${limit}`, 15000);
  useNotificationsLive();
  const markRead = useCallback(async (id: string) => {
    await post(`/api/notifications/${encodeURIComponent(id)}/read`);
    invalidateShared('/api/notifications');
  }, []);
  const markAllRead = useCallback(async () => {
    await post('/api/notifications/read-all');
    invalidateShared('/api/notifications');
  }, []);
  return {
    notifications: q.data?.notifications || [],
    unread: q.data?.unread ?? 0,
    count: q.data?.count ?? 0,
    loading: q.loading,
    error: q.error,
    refresh: q.refresh,
    markRead,
    markAllRead,
  };
}

export function useUnreadCount() {
  const q = useSharedQuery<{ unread: number; total: number }>('/api/notifications/unread-count', 10000);
  useNotificationsLive();
  return { unread: q.data?.unread ?? 0, total: q.data?.total ?? 0, loading: q.loading, refresh: q.refresh };
}

// Policy hook
export function useNotificationPolicy() {
  const q = useSharedQuery<{ policy: any }>('/api/notifications/policy', 30000);
  const save = useCallback(async (policy: any) => {
    const res = await put<{ policy: any }>('/api/notifications/policy', policy);
    // A save settles the document on screen immediately — not at the next poll tick.
    invalidateShared('/api/notifications/policy');
    return res.policy;
  }, []);
  return { policy: q.data?.policy || null, loading: q.loading, error: q.error, refresh: q.refresh, save };
}

export interface TelegramConfig {
  enabled: boolean;
  chatId: string | null;
  configured: boolean;
  hasToken: boolean;
  /** The only form the token ever takes outside the server: eight dots + last four. */
  tokenMasked: string | null;
}

export interface TelegramTestResult {
  ok: boolean;
  code?: string;
  reason?: string;
}

export function useTelegramConfig() {
  const q = useSharedQuery<{ telegram: TelegramConfig }>('/api/notifications/telegram', 30000);
  const save = useCallback(async (cfg: { botToken?: string | null; chatId?: string | null; enabled?: boolean }) => {
    const res = await put<{ telegram: TelegramConfig }>('/api/notifications/telegram', cfg);
    invalidateShared('/api/notifications/telegram');
    return res.telegram;
  }, []);
  const test = useCallback(async () => {
    // The test always uses the SAVED config and sends a fixed message — there is nothing
    // to pass, and nothing passed could steer it anywhere.
    const res = await post<{ ok: boolean; result: TelegramTestResult }>('/api/notifications/telegram/test', {});
    invalidateShared('/api/notifications/telegram');
    return res;
  }, []);
  return { telegram: q.data?.telegram || null, loading: q.loading, error: q.error, refresh: q.refresh, save, test };
}
