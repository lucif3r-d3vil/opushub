// Who is at the door.
//
// Three states, resolved once at boot from `/api/setup/status` and `/api/auth/me`:
//
//   'loading'  we do not know yet — render nothing rather than flash the wrong screen
//   'setup'    no administrator exists: the first-run wizard owns every route
//   'login'    the install is set up but this browser has no session
//   'ready'    authenticated — the Hub renders
//
// There is no token in JavaScript-accessible storage: the session lives in an HttpOnly cookie the
// browser sends automatically, and this provider only ever learns *that* it is signed in.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api, post } from './api';

export interface AuthUser { username: string; createdAt?: string; updatedAt?: string }

export interface SetupStatus {
  required: boolean;
  complete: boolean;
  hasAccount: boolean;
  version?: string;
  discovery?: SetupDiscovery;
}

/** One built-in presentation template, as the wizard may see it before an account exists.
 *  Constants only: the real merged preview would carry this installation's group order. */
export interface SetupTemplate {
  id: string; name: string; tagline: string; description: string; spacing: string;
  widgets: { type: string; zone: string; size: string; title: string }[];
}

/** Count-only discovery summary the wizard may show before an account exists. */
export interface SetupDiscovery {
  docker: { ok: boolean; state: string; version: string | null; apiVersion?: string | null; operatingSystem?: string | null };
  stacks: number;
  containers: number;
  running: number;
  stopped?: number;
  services: number;
  infrastructure: number;
  standalone: number;
  /** `reasons` is the why: one row per resolver verdict, counted — never a container name. */
  urls: {
    detected: number;
    missing: number;
    sources?: Record<string, number>;
    reasons?: { code: string; count: number; explain: string | null; resolved: boolean }[];
  };
  traefik: {
    routes: number;
    tlsRoutes: number;
    routedContainers: number;
    entrypoints: string[];
    entrypointPorts: Record<string, string>;
  };
  hostAddress: string | null;
  hostAddressSource: string | null;
  /** Phase 6 — the presentation step. Counts for "what Docker found", template constants for
   *  "start from a template". Importing is offered as the next step, not here: it is an
   *  authenticated configuration write and the wizard has no account yet. */
  presentation?: {
    detected: { groups: number; services: number; stacks: number };
    /** the built-in default composition — a constant, not this installation's layout */
    widgets: { type: string; zone: string; size: string; title: string }[];
    templates: SetupTemplate[];
  };
}

export type AuthStatus = 'loading' | 'setup' | 'login' | 'ready';

interface AuthCtx {
  status: AuthStatus;
  user: AuthUser | null;
  setup: SetupStatus | null;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  /** create the administrator account (only meaningful while `status === 'setup'`) */
  completeSetup: (body: {
    username: string; password: string; infrastructure?: Record<string, unknown>;
    presentation?: { mode: 'detected' | 'template'; template?: string };
  }) => Promise<{ presentation?: { mode: string; template: string | null } }>;
  /** leave the wizard's final screen and mount the application */
  enter: () => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);
export const useAuth = () => useContext(Ctx);

const message = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<SetupStatus>('/api/setup/status');
      setSetup(s);
      if (s.required) { setUser(null); setStatus('setup'); return; }
      const me = await api<{ authenticated: boolean; user: AuthUser | null }>('/api/auth/me');
      if (me?.authenticated && me.user) { setUser(me.user); setStatus('ready'); }
      else { setUser(null); setStatus('login'); }
    } catch (err) {
      // A backend that cannot answer is not a licence to show the Hub — say so and stay shut.
      setError(message(err, 'Could not reach OpusHub.'));
      setStatus('login');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // A session that expires (or is revoked) while the app is open must drop straight back to the
  // login screen instead of showing empty pages — api() announces every 401.
  useEffect(() => {
    const onUnauthorized = () => { setUser(null); setStatus((s) => (s === 'setup' ? s : 'login')); };
    window.addEventListener('opushub:unauthorized', onUnauthorized);
    return () => window.removeEventListener('opushub:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setError(null);
    try {
      await post<{ user: AuthUser }>('/api/auth/login', { username, password });
      setStatus('loading');
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw new Error('Incorrect username or password.');
      throw new Error(message(err, 'Could not sign in.'));
    }
  }, [refresh]);

  /**
   * Create the administrator. This deliberately does *not* refresh into the app: the wizard owns
   * one more screen (Finish) after the account exists, so the person who just set the machine up
   * is told what happened before a dashboard appears. `enter()` is the hand-off.
   *
   * A reload at that point skips the screen entirely — `/api/setup/status` says setup is complete
   * and the session cookie is already set — so nothing here is load-bearing state.
   */
  const completeSetup = useCallback<AuthCtx['completeSetup']>(async (body) => {
    setError(null);
    try {
      const r = await post<{ user: AuthUser; presentation?: { mode: string; template: string | null } }>('/api/setup', body);
      if (r?.user) setUser(r.user);
      return { presentation: r?.presentation };
    } catch (err) {
      throw new Error(message(err, 'Setup could not be completed.'));
    }
  }, []);

  const logout = useCallback(async () => {
    try { await post('/api/auth/logout'); } catch { /* the cookie is gone either way */ }
    setUser(null);
    setStatus('login');
  }, []);

  const enter = useCallback(() => {
    setStatus('loading');
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthCtx>(() => ({
    status, user, setup, error,
    login, completeSetup, enter, logout, refresh,
    clearError: () => setError(null),
  }), [status, user, setup, error, login, completeSetup, enter, logout, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
