// Phase 10B — SSE hook (authenticated, reconnecting, duplicate-safe, Last-Event-ID)

import { useEffect, useRef, useState, useCallback } from 'react';

export interface LiveEvent {
  id: string;
  t: number;
  type: string;
  severity: 'info' | 'notice' | 'warning' | 'critical';
  source: string;
  subject?: { kind: string; id: string; label: string; href: string | null } | null;
  message: string;
  correlation?: Record<string, string> | null;
  payload?: Record<string, unknown> | null;
}

export interface SSEState {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  lastEventId: string | null;
  events: LiveEvent[];
  reconnectAttempts: number;
}

const MAX_BUFFER = 200;
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30000;

export function useLiveEvents({
  enabled = true,
  types = null as string[] | null,
  severity = null as string | null,
  source = null as string | null,
  onEvent = null as ((e: LiveEvent) => void) | null,
} = {}) {
  const [state, setState] = useState<SSEState>({
    connected: false,
    connecting: false,
    error: null,
    lastEventId: null,
    events: [],
    reconnectAttempts: 0,
  });

  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<number>(RECONNECT_MIN);
  const timeoutRef = useRef<number | null>(null);
  const lastIdRef = useRef<string | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (!enabled) return;
    if (esRef.current) {
      try { esRef.current.close(); } catch {}
      esRef.current = null;
    }

    setState((s) => ({ ...s, connecting: true, error: null }));

    const params = new URLSearchParams();
    if (types && types.length) params.set('types', types.join(','));
    if (severity) params.set('severity', severity);
    if (source) params.set('source', source);
    if (lastIdRef.current) params.set('lastEventId', lastIdRef.current);

    const url = `/api/events/stream${params.toString() ? `?${params.toString()}` : ''}`;

    // EventSource is authenticated via cookie (same-origin)
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setState((s) => ({ ...s, connected: true, connecting: false, error: null, reconnectAttempts: 0 }));
      retryRef.current = RECONNECT_MIN;
      reportLiveStatus('live', 0);
    };

    es.onerror = () => {
      setState((s) => ({ ...s, connected: false, connecting: false, error: 'connection lost', reconnectAttempts: s.reconnectAttempts + 1 }));
      reportLiveStatus('connecting', 0);
      try { es.close(); } catch {}
      esRef.current = null;
      // exponential backoff with jitter
      const delay = Math.min(RECONNECT_MAX, retryRef.current * (1 + Math.random() * 0.3));
      retryRef.current = Math.min(RECONNECT_MAX, retryRef.current * 1.8);
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => connect(), delay);
    };

    const handleMessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as LiveEvent;
        if (!data || !data.id) return;
        // duplicate prevention
        if (seenRef.current.has(data.id)) return;
        seenRef.current.add(data.id);
        if (seenRef.current.size > MAX_BUFFER * 2) {
          // prune oldest half
          const arr = [...seenRef.current];
          seenRef.current = new Set(arr.slice(-MAX_BUFFER));
        }
        lastIdRef.current = data.id;
        setState((s) => {
          const events = [data, ...s.events].slice(0, MAX_BUFFER);
          return { ...s, events, lastEventId: data.id };
        });
        if (onEventRef.current) {
          try { onEventRef.current(data); } catch {}
        }
      } catch {
        // ignore malformed
      }
    };

    // Listen for all event types (server sends event: type)
    // Also listen for generic message (fallback)
    es.onmessage = handleMessage;

    // Add listeners for known types to ensure typed events are captured
    const knownTypes = [
      'monitor.state_changed', 'monitor.incident.opened', 'monitor.incident.recovered',
      'alert.created', 'alert.resolved', 'operation.completed', 'operation.failed',
      'infrastructure.health_changed', 'service.down', 'service.up',
    ];
    for (const t of knownTypes) {
      es.addEventListener(t, handleMessage as EventListener);
    }
  }, [enabled, types, severity, source]);

  useEffect(() => {
    if (enabled) connect();
    return () => {
      if (esRef.current) {
        try { esRef.current.close(); } catch {}
        esRef.current = null;
      }
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [enabled, connect]);

  const clear = useCallback(() => {
    setState((s) => ({ ...s, events: [] }));
    seenRef.current.clear();
  }, []);

  return { ...state, clear, reconnect: connect };
}

/* ------------------------------------------------------------------ */
/* shared live-event broadcast (Phase 10B Notification Center)          */
/*                                                                     */
/* The Shell keeps one SSE connection for browser notifications and the */
/* Activity page keeps its own while open. Instead of the notification */
/* bell opening a third connection just to learn that something         */
/* happened, every useLiveEvents instance republishes the deduplicated  */
/* events it receives here. Consumers (the notification hooks) refresh  */
/* from the server on each new event id — the server stays the source   */
/* of truth, so live inserts can neither duplicate nor reset read state.*/
/* ------------------------------------------------------------------ */

type LiveListener = (e: LiveEvent) => void;

const liveListeners = new Set<LiveListener>();
const liveSeen = new Set<string>();

function broadcastLiveEvent(e: LiveEvent) {
  if (!e || !e.id || liveSeen.has(e.id)) return;
  liveSeen.add(e.id);
  // bounded: the set only guards the broadcast fan-out, not history
  if (liveSeen.size > 500) {
    const arr = [...liveSeen];
    for (const id of arr.slice(0, arr.length - 500)) liveSeen.delete(id);
  }
  for (const fn of liveListeners) {
    try { fn(e); } catch { /* one bad listener must not break the others */ }
  }
}

/** Subscribe to deduplicated live events from every open SSE connection. */
export function subscribeLiveEvents(fn: LiveListener): () => void {
  liveListeners.add(fn);
  return () => { liveListeners.delete(fn); };
}

/** Test seam: feed one event through the same dedupe + broadcast path. */
export function __emitLiveEventForTests(e: LiveEvent) {
  broadcastLiveEvent(e);
}

/* Aggregate connection status across every open instance, for the panel's
 * Live/Reconnecting indicator. Instances report; the last report wins, with
 * "connected" sticky until an instance reports otherwise. */

export type LiveConnection = 'live' | 'connecting' | 'idle';

let liveStatus: LiveConnection = 'idle';
let liveAttempts = 0;
const statusListeners = new Set<(s: LiveConnection, attempts: number) => void>();

function reportLiveStatus(s: LiveConnection, attempts: number) {
  liveStatus = s;
  liveAttempts = attempts;
  for (const fn of statusListeners) {
    try { fn(s, attempts); } catch {}
  }
}

export function subscribeLiveStatus(fn: (s: LiveConnection, attempts: number) => void): () => void {
  statusListeners.add(fn);
  // the current truth immediately, so a panel opened mid-outage shows it
  try { fn(liveStatus, liveAttempts); } catch {}
  return () => { statusListeners.delete(fn); };
}

export function __setLiveStatusForTests(s: LiveConnection, attempts = 0) {
  reportLiveStatus(s, attempts);
}
