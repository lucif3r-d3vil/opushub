import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { LayoutProvider, SettingsProvider, useSettings } from './lib/theme';
import { AuthProvider, useAuth } from './lib/auth';
import { SearchOverlay, useGlobalSearchHotkey } from './components/SearchOverlay';
import { Freshness } from './components/ui';
import { LogoMark } from './components/Logo';
import { BackgroundImage } from './components/BackgroundImage';

const Hub = lazy(() => import('./pages/Hub'));
const Services = lazy(() => import('./pages/Services'));
const ServiceDetail = lazy(() => import('./pages/ServiceDetail'));
const Stacks = lazy(() => import('./pages/Stacks'));
const StackDetail = lazy(() => import('./pages/StackDetail'));
const SystemPage = lazy(() => import('./pages/System'));
const Activity = lazy(() => import('./pages/Activity'));
const Settings = lazy(() => import('./pages/Settings'));
const IconsPage = lazy(() => import('./pages/Icons'));
const NotFound = lazy(() => import('./pages/NotFound'));
const Setup = lazy(() => import('./pages/Setup'));
const Login = lazy(() => import('./pages/Login'));

const NAV = [
  { to: '/', label: 'Hub', icon: 'M4 11.5 12 5l8 6.5V20h-5.5v-4.5h-5V20H4z' },
  { to: '/services', label: 'Services', icon: 'M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z' },
  { to: '/stacks', label: 'Stacks', icon: 'm12 3 8.5 4.7L12 12.4 3.5 7.7zM3.5 12.5 12 17.2l8.5-4.7M3.5 17l8.5 4.7L20.5 17' },
  { to: '/system', label: 'System', icon: 'M4 5.5h16v11H4zM8.5 20h7M12 16.5V20' },
  { to: '/activity', label: 'Activity', icon: 'M3 12h4l2.5-6 4 12 2.5-6H21' },
  { to: '/settings/appearance', label: 'Settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.55-2-3.46-2.35.95a7.5 7.5 0 0 0-2.05-1.2L14.5 3h-5l-.4 2.54a7.5 7.5 0 0 0-2.05 1.2L4.7 5.79l-2 3.46 2 1.55a7.6 7.6 0 0 0 0 2.4l-2 1.55 2 3.46 2.35-.95a7.5 7.5 0 0 0 2.05 1.2L9.5 21h5l.4-2.54a7.5 7.5 0 0 0 2.05-1.2l2.35.95 2-3.46-2-1.55c.07-.4.1-.8.1-1.2Z' },
];

function Background() {
  const { settings } = useSettings();
  const bg = settings?.appearance.background;
  const mode = bg?.mode ?? 'quiet';
  return (
    <div
      className={`bg-layer bg-${mode}`}
      style={{ ['--bg-blur' as never]: `${bg?.blur ?? 24}`, ['--bg-scrim' as never]: `${bg?.scrim ?? 62}` }}
      aria-hidden="true"
    >
      {mode === 'photo' && bg?.photo && <BackgroundImage url={bg.photo} />}
    </div>
  );
}

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
  const location = useLocation();
  return (
    <>
      <Background />
      <div className="app-shell">
        <nav className="rail" aria-label="Primary">
          <Link to="/" className="rail-mark" aria-label="OpusHub home">
            <LogoMark />
          </Link>
          <div className="rail-nav">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => `rail-item ${isActive || (n.to !== '/' && location.pathname.startsWith(n.to)) ? 'active' : ''}`} aria-label={n.label} end={n.to === '/'}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d={n.icon} /></svg>
                <span className="tip">{n.label}</span>
              </NavLink>
            ))}
          </div>
          <div className="rail-foot">
            <button
              className="rail-item"
              aria-label="Open search"
              onClick={() => setSearchOpen(true)}
              style={{ height: 40 }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" strokeLinecap="round" /></svg>
              <span className="tip">Search · /</span>
            </button>
            <ThemeToggle />
            <SignOutButton />
          </div>
        </nav>

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

      <nav className="mobile-bar" aria-label="Primary mobile">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => `rail-item ${isActive ? 'active' : ''}`} aria-label={n.label} end={n.to === '/'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d={n.icon} /></svg>
          </NavLink>
        ))}
        <button className="rail-item mobile-cta" aria-label="Search" onClick={() => setSearchOpen(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" strokeLinecap="round" /></svg>
        </button>
      </nav>

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
      <SaveIndicator />
      <CustomAssets />
    </>
  );
}

function ThemeToggle() {
  const { settings, update } = useSettings();
  const theme = settings?.appearance.theme ?? 'system';
  const next = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';
  const label = next === 'system' ? 'Theme: auto' : next === 'dark' ? 'Theme: dark' : 'Theme: light';
  return (
    <button className="rail-item" aria-label={label} title={label} onClick={() => update({ appearance: { theme: next } })} style={{ height: 40 }}>
      {theme === 'light'
        ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19" /></svg>
        : theme === 'dark'
          ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinejoin="round"><path d="M20 13.5A8.2 8.2 0 0 1 10.5 4 8.25 8.25 0 1 0 20 13.5Z" /></svg>
          : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round"><path d="M12 3v1.8M5.6 5.6l1.3 1.3M3 12h1.8M18.4 5.6l-1.3 1.3M21 12h-1.8M12 21v-1.8M17.1 17.1l1.3 1.3M12 16.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z" /></svg>}
      <span className="tip">{label} · click to cycle</span>
    </button>
  );
}

function CustomAssets() {
  const { settings } = useSettings();
  const css = settings?.advanced?.customCss;
  const js = settings?.advanced?.customJs;
  return (
    <>
      {css && <link rel="stylesheet" href="/user/theme.css" />}
      {js && <script src="/user/app.js" defer />}
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

/** Sign out is a rail affordance: present, quiet, and never in the way. */
function SignOutButton() {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <button className="rail-item" aria-label={`Sign out ${user.username}`} title={`Signed in as ${user.username} — click to sign out`} onClick={() => void logout()} style={{ height: 40 }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 8l-4 4 4 4M6 12h9" />
      </svg>
      <span className="tip">Sign out · {user.username}</span>
    </button>
  );
}

function ShellWithRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
            <Route index element={<Hub />} />
            <Route path="services" element={<Services />} />
            <Route path="services/:group/:name" element={<ServiceDetail />} />
            <Route path="stacks" element={<Stacks />} />
            <Route path="stacks/:name" element={<StackDetail />} />
            <Route path="system" element={<SystemPage />} />
            <Route path="activity" element={<Activity />} />
            <Route path="settings" element={<Settings />} />
            <Route path="settings/:tab" element={<Settings />} />
            <Route path="settings/:tab/:item" element={<Settings />} />
            <Route path="icons" element={<IconsPage />} />
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
