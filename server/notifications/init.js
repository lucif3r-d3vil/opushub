// Phase 10B — notifications initialization (wires event bus → notification center)

import { bus } from '../events/bus.js';
import { createFromEvent } from './center.js';
import { registerProvider } from './providers/registry.js';
import { webhookProvider } from './providers/webhook.js';

let initialized = false;
let sub = null;

export function initNotifications() {
  if (initialized) return;
  initialized = true;

  // Register built-in providers
  try { registerProvider('webhook', webhookProvider); } catch {}

  // Subscribe to all public events that should become notifications
  // We use a filter that only passes meaningful notification types
  const notifiableTypes = new Set([
    'monitor.state_changed',
    'monitor.incident.opened',
    'monitor.incident.recovered',
    'alert.created',
    'alert.resolved',
    'operation.completed',
    'operation.failed',
    'operation.timed_out',
    'infrastructure.health_changed',
    'infrastructure.storage.health_changed',
    'infrastructure.provider.state_changed',
    'service.down',
    'service.up',
    'service.unhealthy',
    'service.healthy',
  ]);

  sub = bus.subscribe((evt) => {
    if (!evt || !evt.type) return false;
    return notifiableTypes.has(evt.type);
  }, (evt) => {
    try {
      createFromEvent(evt);
    } catch (err) {
      console.warn(`[notifications] failed to create from event ${evt.id}: ${err.message}`);
    }
  });

  console.log('│ notifications: center ready — listening for events');
}

export function stopNotifications() {
  if (sub) {
    try { sub.unsubscribe(); } catch {}
    sub = null;
  }
  initialized = false;
}
