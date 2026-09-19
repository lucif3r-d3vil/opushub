// Phase 10B — notification client (unread count, list, browser permission)

import { useCallback, useEffect, useState } from 'react';
import { api, post, put, useSharedQuery } from './api';

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

export function useNotifications(limit = 50) {
  const q = useSharedQuery<{ notifications: Notification[]; unread: number; count: number }>(`/api/notifications?limit=${limit}`, 15000);
  const markRead = useCallback(async (id: string) => {
    await post(`/api/notifications/${encodeURIComponent(id)}/read`);
  }, []);
  const markAllRead = useCallback(async () => {
    await post('/api/notifications/read-all');
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
  return { unread: q.data?.unread ?? 0, total: q.data?.total ?? 0, loading: q.loading, refresh: q.refresh };
}

// Browser notifications
export function canUseBrowserNotifications() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function browserPermission(): NotificationPermission | 'unsupported' {
  if (!canUseBrowserNotifications()) return 'unsupported';
  return Notification.permission;
}

export async function requestBrowserPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!canUseBrowserNotifications()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const perm = await Notification.requestPermission();
    return perm;
  } catch {
    return Notification.permission as NotificationPermission;
  }
}

export function showBrowserNotification(title: string, opts: { body?: string; tag?: string; icon?: string } = {}) {
  if (!canUseBrowserNotifications()) return null;
  if (Notification.permission !== 'granted') return null;
  try {
    const n = new Notification(title, {
      body: opts.body,
      tag: opts.tag,
      icon: opts.icon || '/favicon.svg',
    });
    // auto close after 8s
    setTimeout(() => { try { n.close(); } catch {} }, 8000);
    return n;
  } catch {
    return null;
  }
}

// Policy & webhook hooks
export function useNotificationPolicy() {
  const q = useSharedQuery<{ policy: any }>('/api/notifications/policy', 30000);
  const save = useCallback(async (policy: any) => {
    const res = await put<{ policy: any }>('/api/notifications/policy', policy);
    return res.policy;
  }, []);
  return { policy: q.data?.policy || null, loading: q.loading, error: q.error, refresh: q.refresh, save };
}

export function useWebhookConfig() {
  const q = useSharedQuery<{ webhook: any }>('/api/notifications/webhook', 30000);
  const save = useCallback(async (cfg: any) => {
    const res = await put<{ webhook: any }>('/api/notifications/webhook', cfg);
    return res.webhook;
  }, []);
  const test = useCallback(async (url?: string) => {
    const res = await post<{ ok: boolean; result: any }>('/api/notifications/webhook/test', url ? { url } : {});
    return res;
  }, []);
  return { webhook: q.data?.webhook || null, loading: q.loading, error: q.error, refresh: q.refresh, save, test };
}
