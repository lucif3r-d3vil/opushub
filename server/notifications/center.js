// Phase 10B — Notification Center (creates notifications from events, manages read state)

import { makeNotificationFromEvent } from './model.js';
import * as store from './store.js';
import * as policy from './policy.js';
import { getProvider, listProviders } from './providers/registry.js';

export function createFromEvent(evt) {
  if (!evt) return null;
  if (!policy.shouldCreateInApp(evt)) return null;
  const notif = makeNotificationFromEvent(evt);
  if (!notif) return null;
  const saved = store.addNotification(notif);

  // Fan-out to providers asynchronously, bounded, failure-isolated
  // Webhook
  if (policy.shouldSendWebhook(evt)) {
    const webhook = getProvider('webhook');
    if (webhook && webhook.isEnabled && webhook.isEnabled()) {
      // fire and forget, but catch
      webhook.send(evt, saved).catch((err) => {
        console.warn(`[notifications] webhook send failed: ${err.message}`);
      });
    }
  }

  // Browser notifications are handled client-side via SSE + Notification API.
  // Server only decides if event qualifies (policy.shouldSendBrowser), and includes a flag
  // in the SSE payload? Actually we let client decide based on its own policy fetch, but we
  // can include a hint in notification record. For now, nothing server-side to push for browser
  // beyond the event itself (SSE).

  return saved;
}

export function list(opts) {
  return store.listNotifications(opts);
}

export function unreadCount() {
  return store.unreadCount();
}

export function markRead(id) {
  return store.markRead(id);
}

export function markAllRead() {
  return store.markAllRead();
}

export function get(id) {
  return store.getNotification(id);
}

export function stats() {
  return store.stats();
}
