// Phase 10B — events singleton wiring
// Provides publishEvent that writes to store and bus, and bridges to activity log for meaningful transitions.

import { bus, publishEvent as busPublish } from './bus.js';
import * as store from './store.js';
import { toPublicEvent } from './model.js';

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

// Canonical publish: creates event via bus (which validates) and writes to the store.
//
// There is deliberately NO bridge into the activity log here. Every producer records its own
// timeline rows directly at the moment of the transition (alerts log alert.fired/resolved,
// the monitoring engine logs monitor.down/recovered/…, operations log their outcomes, updates
// and autoheal log theirs) with human vocabulary, stable subjects and dedupe signatures.
// A second copy written by the bus — different type names, different signatures — is how the
// same fact used to land in the Activity page twice. The bus carries canonical events to SSE
// and the notification center; the activity log carries the user-facing timeline. Two pipes,
// two vocabularies, each written once, by the module that owns the transition.
export function publishEvent(descriptor) {
  initEvents();
  const evt = busPublish(descriptor);
  if (!evt) return null;
  try {
    store.writeEvent(evt);
  } catch {}
  return evt;
}

export function subscribeEvents(filter, handler) {
  initEvents();
  return bus.subscribe(filter, handler);
}

/**
 * Best-effort publish for producers that must never be broken by the event pipeline:
 * the event is published (and stored, and bridged to the activity log) when everything
 * works, and silently dropped when it does not. Six producers used to carry their own
 * lazy-import copy of this wrapper; the canonical one lives here next to publishEvent.
 */
export function publishEventSafe(descriptor) {
  try {
    publishEvent(descriptor);
  } catch { /* event publication never breaks its producer */ }
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
