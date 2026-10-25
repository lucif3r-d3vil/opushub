import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { LayoutProvider, SettingsProvider, useSettings } from './lib/theme';
import { AuthProvider, useAuth } from './lib/auth';
import { SearchOverlay, useGlobalSearchHotkey } from './components/SearchOverlay';
import { OperationsHost } from './components/Operations';
import { ContainerEditorHost } from './components/ContainerEditor';
import { Freshness } from './components/ui';
import { LogoMark } from './components/Logo';
import { TopBar } from './components/shell/TopBar';
import { BackgroundLayer } from './components/shell/BackgroundLayer';
import { useLiveEvents } from './lib/sse';

const Hub = lazy(() => import('./pages/Hub'));
const Services = lazy(() => import('./pages/Services'));
const ServiceDetail = lazy(() => import('./pages/ServiceDetail'));
const Monitoring = lazy(() => import('./pages/Monitoring'));
const MonitorDetail = lazy(() => import('./pages/MonitorDetail'));
const Stacks = lazy(() => import('./pages/Stacks'));
const StackDetail = lazy(() => import('./pages/StackDetail'));
const ManagedStack = lazy(() => import('./pages/ManagedStack'));
const Host = lazy(() => import('./pages/Host'));
const SystemPage = lazy(() => import('./pages/System'));
const Activity = lazy(() => import('./pages/Activity'));
const Settings = lazy(() => import('./pages/Settings'));
const NotFound = lazy(() => import('./pages/NotFound'));
const Setup = lazy(() => import('./pages/Setup'));
const Login = lazy(() => import('./pages/Login'));

function SaveIndicator() {
  const { saveState } = useSettings();
  if (saveState === 'idle') return null;
  const text = saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Save failed';
  return <div className="preview-note" role="status"><Freshness at={null} />{text}</div>;
}

function Shell() {
  const [searchOpen, setSearchOpen] = useState(false);
  useGlobalSearchHotkey(() => setSearchOpen(true));
  useEffect(() => {
    const open = () => setSearchOpen(true);
    window.addEventListener('opushub:open-search', open);
    return () => window.removeEventListener('opushub:open-search', open);
  }, []);

  // Phase 10B — the shell's one SSE connection: it keeps the bell and its unread count live.
  useLiveEvents({ enabled: true });
  const location = useLocation();
  return (
    <>
      <BackgroundLayer />
      <div className="app-shell">
        <TopBar onSearch={() => setSearchOpen(true)} />
        <div className="main-wrap">
          <div className="page">
            <div className="page-anim" key={location.pathname}>
              <Suspense fallback={<div aria-busy="true" style={{ padding: 'var(--sp-16) 0', color: 'var(--ink-3)' }} className="stale-note">Loading…</div>}>
                <Outlet />
              </Suspense>
            </div>
          </div>
        </div>
      </div>

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
      {/* operations: one confirmation flow, mounted once, opened from anywhere */}
      <OperationsHost />
      <ContainerEditorHost />
      <SaveIndicator />
    </>
  );
}

/**
 * The gate. Nothing that talks to the infrastructure renders before we know who is asking:
 *
 *   loading → a quiet mark (never a flash of the wrong screen)
 *   setup   → the first-run wizard owns every route, because there is no account yet
 *   login   → the login screen, whatever URL was typed
 *   ready   → the application, exactly as before
 */
function Gate() {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <div className="auth-boot" role="status" aria-live="polite">
        <LogoMark size={34} />
        <span className="stale-note">Starting OpusHub…</span>
      </div>
    );
  }
  if (status === 'setup') return <Suspense fallback={<div className="auth-boot" />}><Setup /></Suspense>;
  if (status === 'login') return <Suspense fallback={<div className="auth-boot" />}><Login /></Suspense>;
  // Only an authenticated session mounts the settings/layout providers — pre-auth there is
  // nothing to fetch, and no request should be made that is going to be refused anyway.
  return (
    <SettingsProvider>
      <LayoutProvider>
        <ShellWithRoutes />
      </LayoutProvider>
    </SettingsProvider>
  );
}

/** Old address → its canonical home, keeping the query string (tabs, pool/dataset picks, service deep links). */
function LegacyRedirect({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={{ pathname: to, search: location.search, hash: location.hash }} replace />;
}

function ShellWithRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
            <Route index element={<Hub />} />
            <Route path="services" element={<Services />} />
            <Route path="services/:group/:name" element={<ServiceDetail />} />
            <Route path="monitoring" element={<Monitoring />} />
            <Route path="monitoring/incidents" element={<Monitoring />} />
            <Route path="monitoring/:id" element={<MonitorDetail />} />
            <Route path="stacks" element={<Stacks />} />
            <Route path="stacks/new" element={<ManagedStack />} />
            <Route path="stacks/:id/edit" element={<ManagedStack />} />
            <Route path="stacks/:name" element={<StackDetail />} />
            {/* System is the parent for the machine: live vitals and the host itself. */}
            <Route path="system" element={<SystemPage />} />
            <Route path="system/host" element={<Host />} />
            {/* Legacy mounts redirect, never 404: stored notifications, alert links and
                bookmarks still carry these paths, and they keep arriving where they meant to. */}
            <Route path="host" element={<LegacyRedirect to="/system/host" />} />
            <Route path="infrastructure" element={<LegacyRedirect to="/system" />} />
            <Route path="system/infrastructure" element={<LegacyRedirect to="/system" />} />
            <Route path="activity" element={<Activity />} />
            <Route path="settings" element={<Settings />} />
            <Route path="settings/:tab" element={<Settings />} />
            <Route path="settings/:tab/:item" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
