// Phase 10B — internal EventBus (canonical, trusted producers only)
// Guarantees: bounded subscribers, bounded memory, failure isolation, loop protection, ordered delivery.

import { makeEvent, toPublicEvent } from './model.js';

const MAX_SUBSCRIBERS = 100;
const RING_SIZE = 200;
const MAX_DEPTH = 10;

class EventBus {
  constructor({ ringSize = RING_SIZE, maxSubscribers = MAX_SUBSCRIBERS } = {}) {
    this.ringSize = ringSize;
    this.maxSubscribers = maxSubscribers;
    this.subscribers = new Map(); // id -> { filter, handler, createdAt }
    this.ring = []; // recent events, oldest first, max ringSize
    this.depth = 0; // publish recursion depth
    this.seq = 0;
    this.nextSubId = 1;
  }

  _pushRing(evt) {
    this.ring.push(evt);
    if (this.ring.length > this.ringSize) this.ring.shift();
  }

  getRecent({ limit = 50, types = null, severity = null, source = null, since = null } = {}) {
    let items = this.ring.slice();
    if (types && Array.isArray(types) && types.length) {
      const set = new Set(types);
      items = items.filter((e) => set.has(e.type));
    }
    if (severity) {
      const order = { info: 0, notice: 1, warning: 2, critical: 3 };
      const min = order[severity] ?? 0;
      items = items.filter((e) => (order[e.severity] ?? 0) >= min);
    }
    if (source) items = items.filter((e) => e.source === source);
    if (since != null) items = items.filter((e) => e.t > since);
    if (limit != null) items = items.slice(-limit);
    return items;
  }

  publish(raw) {
    if (this.depth >= MAX_DEPTH) {
      console.warn(`[events] publish depth exceeded (${this.depth}), dropping event ${raw?.type || 'unknown'}`);
      return null;
    }
    let evt;
    try {
      // raw may already be a canonical event or a descriptor for makeEvent
      if (raw && raw.id && raw.t && raw.type && raw.severity) {
        evt = raw;
      } else {
        evt = makeEvent(raw);
      }
    } catch (err) {
      console.warn(`[events] invalid event dropped: ${err.message}`);
      return null;
    }

    this.depth++;
    try {
      this._pushRing(evt);
      // deliver to subscribers in subscription order
      for (const [id, sub] of this.subscribers) {
        try {
          if (sub.filter && typeof sub.filter === 'function') {
            if (!sub.filter(evt)) continue;
          }
          // handler may be sync or async, but we don't await to keep ordering synchronous.
          // If it returns a promise, we attach a catch to avoid unhandled rejections.
          const r = sub.handler(evt);
          if (r && typeof r.then === 'function') {
            r.catch((e) => console.warn(`[events] subscriber ${id} async error: ${e?.message || e}`));
          }
        } catch (e) {
          console.warn(`[events] subscriber ${id} threw: ${e?.message || e}`);
          // isolate failure, continue to next subscriber
        }
      }
    } finally {
      this.depth--;
    }
    this.seq++;
    return evt;
  }

  subscribe(filterOrHandler, maybeHandler) {
    if (this.subscribers.size >= this.maxSubscribers) {
      throw Object.assign(new Error(`too many subscribers (${this.maxSubscribers})`), { status: 429, code: 'too_many_subscribers' });
    }
    let filter = null;
    let handler = null;
    if (typeof filterOrHandler === 'function' && maybeHandler == null) {
      handler = filterOrHandler;
    } else if (typeof filterOrHandler === 'function' && typeof maybeHandler === 'function') {
      filter = filterOrHandler;
      handler = maybeHandler;
    } else if (filterOrHandler && typeof filterOrHandler === 'object' && typeof maybeHandler === 'function') {
      // filter as object { types, severity, source }
      const f = filterOrHandler;
      filter = (evt) => {
        if (f.types && Array.isArray(f.types) && f.types.length && !f.types.includes(evt.type)) return false;
        if (f.source && evt.source !== f.source) return false;
        if (f.severity) {
          const order = { info: 0, notice: 1, warning: 2, critical: 3 };
          if ((order[evt.severity] ?? 0) < (order[f.severity] ?? 0)) return false;
        }
        return true;
      };
      handler = maybeHandler;
    } else {
      throw Object.assign(new Error('subscribe requires a handler function'), { status: 400, code: 'invalid_subscribe' });
    }

    const id = `sub-${this.nextSubId++}-${Date.now()}`;
    this.subscribers.set(id, { filter, handler, createdAt: Date.now() });
    return {
      id,
      unsubscribe: () => this.subscribers.delete(id),
    };
  }

  unsubscribe(id) {
    return this.subscribers.delete(id);
  }

  clear() {
    this.subscribers.clear();
    this.ring = [];
    this.depth = 0;
  }

  stats() {
    return {
      subscribers: this.subscribers.size,
      ring: this.ring.length,
      seq: this.seq,
      depth: this.depth,
    };
  }
}

// Singleton instance for the process
export const bus = new EventBus();

export function publishEvent(descriptor) {
  return bus.publish(descriptor);
}

export function subscribeEvents(filter, handler) {
  // allow subscribe(handler) shorthand
  if (typeof filter === 'function' && handler == null) return bus.subscribe(filter);
  return bus.subscribe(filter, handler);
}

export { EventBus };
