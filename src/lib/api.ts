// Tiny fetch client + polling hooks. Stale-while-revalidate, pauses when the tab is hidden,
// honors ETag 304 on capable endpoints, and — importantly for the Hub — shares one poller per
// path across every component that asks for it (the Hub and its live preview are two consumers of
// the same data; they must not become two requests).
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  status: number;
  /** The parsed response body when there was one — operations answer a refusal with the
   *  operation record, and the UI needs it to say *why* rather than just *no*. */
  body: unknown;
  constructor(message: string, status: number, body: unknown = null) { super(message); this.status = status; this.body = body; }
}

const etags = new Map<string, string>();

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.method == null || init.method === 'GET') {
    const et = etags.get(path);
    if (et) headers['if-none-match'] = et;
  }
  if (init?.body != null) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...init, headers });
  if (res.status === 304) return null as T; // caller keeps previous data
  const text = await res.text();
  let json: unknown = null;
  if (text) { try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 200) }; } }
  if (!res.ok) {
    const msg = (json && typeof json === 'object' && 'error' in json) ? String((json as { error: string }).error) : `${res.status} ${res.statusText}`;
    // One place announces an expired or revoked session, so every page drops to the login screen
    // instead of rendering a half-empty shell of unavailable panels.
    if (res.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('opushub:unauthorized'));
    throw new ApiError(msg, res.status, json);
  }
  const et = res.headers.get('etag');
  if (et) etags.set(path, et);
  return json as T;
}

export const put = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body == null ? undefined : JSON.stringify(body) });

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  fetchedAt: number | null;
  refresh: () => void;
}

/* ------------------------------------------------------------------ */
/* shared query cache                                                  */
/* ------------------------------------------------------------------ */

interface Entry {
  data: unknown;
  error: string | null;
  fetchedAt: number | null;
  loading: boolean;
  inflight: boolean;
  subs: Map<number, number>;   // subscriber id → requested interval
  timer: number | null;
  listeners: Set<() => void>;
}

const MAX_IDLE_ENTRIES = 32;
const store = new Map<string, Entry>();
let subId = 0;

function entryFor(path: string): Entry {
  let e = store.get(path);
  if (!e) {
    e = { data: null, error: null, fetchedAt: null, loading: false, inflight: false, subs: new Map(), timer: null, listeners: new Set() };
    store.set(path, e);
  }
  return e;
}

function emit(e: Entry) { for (const l of e.listeners) l(); }

async function load(path: string, e: Entry, { silent = false } = {}) {
  if (e.inflight) return;
  e.inflight = true;
  if (!silent && e.data == null) { e.loading = true; emit(e); }
  try {
    const json = await api<unknown>(path);
    if (json != null) { e.data = json; e.fetchedAt = Date.now(); }
    e.error = null;
  } catch (err) {
    e.error = err instanceof Error ? err.message : String(err);
  } finally {
    e.inflight = false;
    e.loading = false;
    emit(e);
  }
}

/** Pollers stop when nobody is listening, but the data stays — coming back to a page is instant. */
function schedule(path: string, e: Entry) {
  if (e.timer) { window.clearInterval(e.timer); e.timer = null; }
  if (!e.subs.size) return;
  const interval = Math.max(2000, Math.min(...e.subs.values()));
  const tick = () => { if (document.visibilityState === 'visible') void load(path, e, { silent: true }); };
  e.timer = window.setInterval(tick, interval);
}

function onVisible() {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  for (const [path, e] of store) if (e.subs.size) void load(path, e, { silent: true });
}

let visibilityHooked = false;
function ensureVisibilityHook() {
  if (visibilityHooked || typeof document === 'undefined') return;
  visibilityHooked = true;
  document.addEventListener('visibilitychange', onVisible);
}

function prune() {
  if (store.size <= MAX_IDLE_ENTRIES) return;
  const idle = [...store.entries()].filter(([, e]) => e.subs.size === 0)
    .sort((a, b) => (a[1].fetchedAt || 0) - (b[1].fetchedAt || 0));
  for (const [path] of idle) {
    if (store.size <= MAX_IDLE_ENTRIES) break;
    store.delete(path);
  }
}

/**
 * Drop cached responses. Called after a write so every page (and the live preview) sees the new
 * truth immediately instead of waiting for the next poll.
 */
export function invalidateShared(prefix?: string) {
  for (const [path, e] of store) {
    if (prefix && !path.startsWith(prefix)) continue;
    e.fetchedAt = null;
    etags.delete(path);
    if (e.subs.size) void load(path, e, { silent: true });
  }
}

/**
 * Drop every cached response, data included. The Hub and its preview are the same cache, so tests
 * (and anything that imports a fresh configuration) need a way to start from nothing.
 */
export function resetSharedCache() {
  for (const e of store.values()) if (e.timer) window.clearInterval(e.timer);
  store.clear();
  etags.clear();
}

/**
 * One poller per path, shared by every caller. `intervalMs = 0` means "fetch once, never poll".
 * The smallest interval any consumer asks for wins.
 */
export function useSharedQuery<T>(path: string | null, intervalMs = 30_000): QueryState<T> {
  const [, force] = useState(0);
  const [id] = useState(() => ++subId);
  const ref = useRef<{ path: string | null }>({ path: null });

  useEffect(() => {
    if (!path) { ref.current.path = null; return; }
    ensureVisibilityHook();
    const e = entryFor(path);
    e.subs.set(id, intervalMs > 0 ? Math.max(2000, intervalMs) : 2 ** 30);
    const listener = () => force((n) => n + 1);
    e.listeners.add(listener);
    ref.current.path = path;
    if (e.data == null && !e.inflight) void load(path, e);
    schedule(path, e);
    prune();
    return () => {
      const cur = store.get(path);
      if (cur) {
        cur.subs.delete(id);
        cur.listeners.delete(listener);
        schedule(path, cur);
      }
    };
  }, [path, intervalMs, id]);

  const refresh = useCallback(() => {
    const target = ref.current.path;
    if (target) {
      const e = store.get(target);
      if (e) { etags.delete(target); void load(target, e, { silent: true }); }
    }
  }, []);

  const e = path ? store.get(path) : undefined;
  return {
    data: (e?.data as T) ?? null,
    error: e?.error ?? null,
    loading: e ? e.loading && e.data == null : !!path,
    fetchedAt: e?.fetchedAt ?? null,
    refresh,
  };
}

/** Back-compat alias: every existing page keeps the same call shape. */
export const usePolled = useSharedQuery;

/** One-shot mutation helper with local busy state. */
export function useSave() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okAt, setOkAt] = useState<number | null>(null);
  const save = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true); setErr(null);
    try { const r = await fn(); setOkAt(Date.now()); return r; }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); return null; }
    finally { setBusy(false); }
  }, []);
  return { busy, err, okAt, save, reset: () => { setErr(null); setOkAt(null); } };
}
