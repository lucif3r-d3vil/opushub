// The top bar: wordmark, three destinations, search, bell, and the account menu.
// It replaces the left rail (DESIGN.md §3). Containers points at the current Services pages and
// Uptime at the current Monitoring pages until those are rebuilt in later slices.
import { Link, NavLink, useLocation } from 'react-router-dom';
import { NotificationBell } from '../Notifications';
import { AccountMenu } from './AccountMenu';

const NAV = [
  { to: '/', label: 'Home', match: (p: string) => p === '/' },
  { to: '/services', label: 'Containers', match: (p: string) => p.startsWith('/services') || p.startsWith('/stacks') },
  { to: '/monitoring', label: 'Uptime', match: (p: string) => p.startsWith('/monitoring') },
];

export function TopBar({ onSearch }: { onSearch: () => void }) {
  const { pathname } = useLocation();
  return (
    <header className="topbar">
      <div className="topbar-in">
        <Link to="/" className="brand" aria-label="OpusHub home"><i aria-hidden="true" /><span>OpusHub</span></Link>
        <nav className="tb-nav" aria-label="Primary">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} aria-current={n.match(pathname) ? 'page' : undefined}>{n.label}</NavLink>
          ))}
        </nav>
        <span className="tb-grow" />
        <button type="button" className="tb-btn tb-search" onClick={onSearch} aria-label="Search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></svg>
          <kbd>Ctrl K</kbd>
        </button>
        <span className="tb-btn tb-bell"><NotificationBell /></span>
        <AccountMenu />
      </div>
    </header>
  );
}
