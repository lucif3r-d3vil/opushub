// Phase 10B — Notification Center (creates notifications from events, manages read state)
//
// The dispatcher: one event in, one persisted in-app notification out (idempotent by
// eventId), plus fire-and-forget fan-out to each enabled outbound provider. Every
// provider send is failure-isolated — a broken webhook or Telegram configuration is
// recorded by that provider as a delivery failure and can never break event publication,
// the notification center, the other providers, monitoring or the scheduler.

import { makeNotificationFromEvent } from './model.js';
import * as store from './store.js';
import * as policy from './policy.js';
import { getProvider } from './providers/registry.js';

function fanOut(evt, saved) {
  // Webhook
  if (policy.shouldSendWebhook(evt)) {
    const webhook = getProvider('webhook');
    if (webhook && webhook.isEnabled && webhook.isEnabled()) {
      // fire and forget, but caught and recorded by the provider itself
      webhook.send(evt, saved).catch((err) => {
        console.warn(`[notifications] webhook send failed: ${String(err?.message || err).slice(0, 160)}`);
      });
    }
  }

  // Telegram (outbound only — same gates, same isolation, independent of webhook)
  if (policy.shouldSendTelegram(evt)) {
    const telegram = getProvider('telegram');
    if (telegram && telegram.isEnabled && telegram.isEnabled()) {
      telegram.send(evt, saved).catch((err) => {
        // The provider guarantees token-free reasons; slice defensively anyway.
        console.warn(`[notifications] telegram send failed: ${String(err?.message || err).slice(0, 160)}`);
      });
    }
  }

  // Browser notifications are handled client-side via SSE + Notification API.
  // Server only decides if event qualifies (policy.shouldSendBrowser), and includes a flag
  // in the SSE payload? Actually we let client decide based on its own policy fetch, but we
  // can include a hint in notification record. For now, nothing server-side to push for browser
  // beyond the event itself (SSE).
}

export function createFromEvent(evt) {
  if (!evt) return null;
  if (!policy.shouldCreateInApp(evt)) return null;
  const notif = makeNotificationFromEvent(evt);
  if (!notif) return null;
  const saved = store.addNotification(notif);

  // Fan-out to providers asynchronously, bounded, failure-isolated.
  try {
    fanOut(evt, saved);
  } catch (err) {
    // The dispatcher must never throw into the event bus, even if a provider's
    // isEnabled check misbehaves.
    console.warn(`[notifications] fan-out failed: ${String(err?.message || err).slice(0, 160)}`);
  }

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
