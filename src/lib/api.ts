// Tiny fetch client + polling hooks. Stale-while-revalidate, pauses when the tab is hidden,
// honors ETag 304 on capable endpoints. No data library needed at this scale.
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
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
    throw new ApiError(msg, res.status);
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

export function usePolled<T>(path: string | null, intervalMs = 30_000): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const alive = useRef(true);
  const inflight = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!path || inflight.current) return;
    inflight.current = true;
    if (!silent) setLoading(true);
    try {
      const json = await api<T>(path);
      if (!alive.current) return;
      if (json != null) { setData(json); setFetchedAt(Date.now()); }
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      inflight.current = false;
      if (alive.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    setData(null); setError(null); setLoading(!!path);
    if (!path) return;
    load();
    let timer: number | undefined;
    const tick = () => {
      if (document.visibilityState === 'visible') load(true);
    };
    if (intervalMs > 0) timer = window.setInterval(tick, Math.max(2000, intervalMs));
    const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') load(true); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [path, intervalMs, load]);

  const refresh = useCallback(() => { load(true); }, [load]);
  return { data, error, loading, fetchedAt, refresh };
}

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
  return { busy, err, okAt, save };
}
