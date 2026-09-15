// Theme + settings: the single place where appearance lives. Edits apply instantly (live
// preview) and persist to config/settings.yaml via a debounced PUT.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LayoutDoc, SettingsDoc } from './types';
import { api, post, put } from './api';

interface SettingsCtx {
  settings: SettingsDoc | null;
  resolvedTheme: 'dark' | 'light';
  update: (patch: DeepPartial<SettingsDoc>, immediate?: boolean) => void;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  reload: () => void;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const Ctx = createContext<SettingsCtx>(null as unknown as SettingsCtx);
export const useSettings = () => useContext(Ctx);

function deepMerge<T>(base: T, patch: unknown): T {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries((patch || {}) as Record<string, unknown>)) {
    const key = k as keyof T;
    if (v && typeof v === 'object' && !Array.isArray(v) && out[key] && typeof out[key] === 'object') {
      out[key] = deepMerge(out[key] as object, v) as T[keyof T];
    } else {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

export function applyTheme(s: SettingsDoc | null, media: MediaQueryList | null) {
  if (typeof document === 'undefined') return (s?.appearance?.theme === 'light' ? 'light' : 'dark');
  const el = document.documentElement;
  const want = s?.appearance?.theme ?? 'system';
  const resolved = want === 'system' ? (media?.matches ? 'light' : 'dark') : want;
  el.setAttribute('data-theme', resolved);
  el.setAttribute('data-accent', s?.appearance?.accent ?? 'sage');
  el.setAttribute('data-density', s?.appearance?.density ?? 'comfortable');
  el.setAttribute('data-transparency', s?.appearance?.transparency ? 'on' : 'off');
  el.setAttribute('data-bg', s?.appearance?.background?.mode ?? 'quiet');
  el.style.setProperty('--font-scale', String(s?.appearance?.fontScale ?? 1));
  el.style.setProperty('--page-bg', 'transparent');
  // The configured name is what the tab says — one place, every page, so a rename is visible
  // everywhere at once instead of only on the Hub.
  const appName = String(s?.app?.name || '').trim() || 'OpusHub';
  if (typeof document !== 'undefined' && document.title !== appName) document.title = appName;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  themeMeta?.setAttribute('content', resolved === 'dark' ? '#0b0c0e' : '#f7f7f5');
  try { localStorage.setItem('opushub.theme', want === 'system' ? '' : resolved); } catch { /* private mode */ }
  return resolved as 'dark' | 'light';
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SettingsDoc | null>(null);
  const [saveState, setSaveState] = useState<SettingsCtx['saveState']>('idle');
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>('dark');
  const media = useMemo(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null), []);
  const debounce = useRef<number | null>(null);
  const pending = useRef<DeepPartial<SettingsDoc> | null>(null);

  const reload = useCallback(() => {
    api<SettingsDoc>('/api/settings').then((s) => {
      setSettings(s);
      setResolvedTheme(applyTheme(s, media));
    }).catch(() => setSettings(structuredClone(FALLBACK)));
  }, [media]);

  useEffect(() => {
    reload();
    const onChange = () => { if (settings == null || settings.appearance.theme === 'system') setResolvedTheme(applyTheme(settings, media)); };
    media?.addEventListener('change', onChange);
    return () => media?.removeEventListener('change', onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  const flush = useCallback(async () => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setSaveState('saving');
    try {
      // Send only the touched keys so concurrent UI changes can't clobber unrelated sections.
      const next = await put<SettingsDoc>('/api/settings', p as Record<string, unknown>);
      setSettings(next);
      setResolvedTheme(applyTheme(next, media));
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 1600);
    } catch {
      setSaveState('error');
      window.setTimeout(() => setSaveState('idle'), 2500);
    }
  }, [media]);

  const update = useCallback((patch: DeepPartial<SettingsDoc>, immediate = false) => {
    setSettings((cur) => {
      if (!cur) return cur;
      const next = deepMerge(cur, patch);
      pending.current = deepMerge(pending.current || {} as SettingsDoc, patch) as DeepPartial<SettingsDoc>;
      setResolvedTheme(applyTheme(next, media));
      if (immediate && pending.current) {
        const p = pending.current;
        pending.current = null;
        void put<SettingsDoc>('/api/settings', { ...structuredClone(p) });
        setSaveState('saving');
        window.setTimeout(() => setSaveState('saved'), 400);
        window.setTimeout(() => setSaveState('idle'), 2200);
      } else if (pending.current) {
        if (debounce.current) window.clearTimeout(debounce.current);
        setSaveState('saving');
        debounce.current = window.setTimeout(() => void flush(), 700);
      }
      return next;
    });
  }, [flush, media]);

  return (
    <Ctx.Provider value={{ settings, resolvedTheme, update, saveState, reload }}>{children}</Ctx.Provider>
  );
}

const FALLBACK: SettingsDoc = {
  app: { name: 'OpusHub', tagline: 'The OpusGrid homelab, at a glance.' },
  appearance: { theme: 'system', accent: 'sage', density: 'comfortable', transparency: true, fontScale: 1, background: { mode: 'quiet', photo: null, blur: 24, scrim: 62, position: 'center', fit: 'cover' } },
  hub: { greetingName: null, clock24h: false, showSeconds: false },
  integrations: { news: { feeds: [] }, weather: { location: null, latitude: null, longitude: null, place: null, units: 'c' }, markets: { symbols: [] } },
  behavior: { logLaunches: true, refresh: { system: 5, services: 30 } },
  infrastructure: { hostAddress: null, entrypointPorts: {} },
  advanced: { customCss: false, customJs: false },
};

// ---------- layout (widgets, zones, ordering, visibility) ----------
//
// Optimistic: a drag or a size change paints immediately and persists 350 ms later, so the Hub and
// its live preview never wait on the network to reflect what the user just did.
interface LayoutCtx {
  layout: LayoutDoc | null;
  setLayout: (patch: DeepPartial<LayoutDoc>) => void;
  /** re-read layout.json (after applying a template, or resetting) */
  reload: () => Promise<void>;
  /** back to the factory composition — never touches services, overlays or appearance */
  resetLayout: () => Promise<void>;
}
const LCtx = createContext<LayoutCtx>(null as unknown as LayoutCtx);
export const useLayout = () => useContext(LCtx);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [layout, setL] = useState<LayoutDoc | null>(null);
  const pending = useRef<DeepPartial<LayoutDoc> | null>(null);
  const timer = useRef<number | null>(null);

  const reload = useCallback(async () => {
    try { setL(await api<LayoutDoc>('/api/layout')); } catch { /* keep the current shape */ }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const setLayout = useCallback((patch: DeepPartial<LayoutDoc>) => {
    setL((cur) => (cur ? deepMerge(cur, patch) : cur));
    pending.current = deepMerge(pending.current || {}, patch) as DeepPartial<LayoutDoc>;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const p = pending.current;
      pending.current = null;
      if (p) { try { const next = await put<LayoutDoc>('/api/layout', p); setL(next); } catch { /* keep local */ } }
    }, 350);
  }, []);

  const resetLayout = useCallback(async () => {
    const next = await post<LayoutDoc>('/api/layout/reset');
    setL(next);
  }, []);

  return <LCtx.Provider value={{ layout, setLayout, reload, resetLayout }}>{children}</LCtx.Provider>;
}

export { FALLBACK as FALLBACK_SETTINGS };
