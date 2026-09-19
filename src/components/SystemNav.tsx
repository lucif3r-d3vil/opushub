// System view switcher — the rail's single System entry has three views: live vitals, the host
// itself, and the infrastructure surface (engine, storage/ZFS, network, power, topology).
// Same pattern the Monitoring page uses for Monitors/Incidents: chips that are real links, so
// every view is deep-linkable and the active one is announced.
import { NavLink } from 'react-router-dom';

const VIEWS = [
  { to: '/system', label: 'Vitals', end: true, keywords: 'host vitals, resources, charts' },
  { to: '/system/host', label: 'Host', end: false, keywords: 'the machine OpusGrid runs on' },
  { to: '/system/infrastructure', label: 'Infrastructure', end: false, keywords: 'engine, storage, network, power, topology' },
] as const;

export function SystemNav() {
  return (
    <nav className="page-views" aria-label="System views">
      {VIEWS.map((v) => (
        <NavLink
          key={v.to}
          to={v.to}
          end={v.end}
          title={v.keywords}
          className={({ isActive }) => `chip${isActive ? ' active' : ''}`}
        >
          {v.label}
        </NavLink>
      ))}
    </nav>
  );
}
