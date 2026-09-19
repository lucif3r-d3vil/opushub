// Phase 10B — events singleton wiring
// Provides publishEvent that writes to store and bus, and bridges to activity log for meaningful transitions.

import { bus, publishEvent as busPublish } from './bus.js';
import * as store from './store.js';
import { toPublicEvent } from './model.js';
import { logEvent as activityLog } from '../activity.js';

let initialized = false;

export function initEvents() {
  if (initialized) return { bus, store };
  initialized = true;
  // store is file-backed, no async init needed
  // Optionally preload ring from store for Last-Event-ID replay
  try {
    const recent = store.readEvents({ limit: 200 });
    for (const evt of recent) {
      bus._pushRing(evt);
    }
  } catch {}
  return { bus, store };
}

// Canonical publish: creates event via bus (which validates), writes to store, logs to activity if meaningful
export function publishEvent(descriptor) {
  initEvents();
  const evt = busPublish(descriptor);
  if (!evt) return null;
  try {
    store.writeEvent(evt);
  } catch {}
  // Bridge to activity for meaningful types: only those that are user-visible timeline entries
  try {
    if (shouldLogToActivity(evt)) {
      activityLog({
        source: evt.source,
        type: evt.type,
        subject: evt.subject?.label || evt.subject?.id || 'system',
        message: evt.message,
        meta: {
          eventId: evt.id,
          severity: evt.severity,
          ...(evt.correlation || {}),
          ...(evt.payload || {}),
        },
        severity: evt.severity,
        category: categoryForType(evt.type),
        signature: `event:${evt.type}:${evt.correlation?.monitorId || evt.correlation?.incidentId || evt.id}`,
      });
    }
  } catch {}
  return evt;
}

function shouldLogToActivity(evt) {
  // Only log meaningful transitions, not every check
  const meaningful = new Set([
    'monitor.state_changed',
    'monitor.incident.opened',
    'monitor.incident.recovered',
    'alert.created',
    'alert.resolved',
    'operation.completed',
    'operation.failed',
    'operation.timed_out',
    'infrastructure.health_changed',
    'service.down',
    'service.up',
    'service.unhealthy',
    'service.healthy',
  ]);
  return meaningful.has(evt.type);
}

function categoryForType(type) {
  if (type.startsWith('monitor.') || type.startsWith('incident')) return 'monitor';
  if (type.startsWith('alert.')) return 'alert';
  if (type.startsWith('operation.')) return 'operation';
  if (type.startsWith('infrastructure.')) return 'infrastructure';
  if (type.startsWith('service.')) return 'service';
  return 'system';
}

export function subscribeEvents(filter, handler) {
  initEvents();
  return bus.subscribe(filter, handler);
}

export function getRecentEvents(opts) {
  initEvents();
  return store.readEvents(opts);
}

export function getEventById(id) {
  initEvents();
  return store.getEventById(id);
}

export function getPublicRecentEvents(opts) {
  const items = getRecentEvents(opts);
  return items.map(toPublicEvent).filter(Boolean);
}

export { bus, store, toPublicEvent };
