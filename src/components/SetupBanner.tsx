// The single first-run surface (§17): one quiet banner instead of a Hub full of
// "Not set up yet" blocks. Dismissible; the dismissal persists in layout.json.
import { Link } from 'react-router-dom';
import { useLayout, useSettings } from '../lib/theme';
import { useDockerStatus } from '../lib/dockerStatus';
import type { ServicesDoc, SystemSnapshot } from '../lib/types';

function Tick({ on }: { on: boolean }) {
  return (
    <span className={`setup-tick ${on ? 'on' : 'off'}`} aria-hidden="true">
      {on ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="6.5" /></svg>
      )}
    </span>
  );
}

export default function SetupBanner({ sys, services }: { sys: SystemSnapshot | null; services: ServicesDoc | null }) {
  const { settings } = useSettings();
  const { layout, setLayout } = useLayout();
  const docker = useDockerStatus();

  if (!layout || !settings) return null;
  if (layout.hub.setupDismissed) return null;

  const serviceCount = services?.groups.reduce((a, g) => a + g.services.length, 0) ?? null;
  const dockerOn = !!docker.data?.ok;
  const dockerKnown = docker.data != null;
  // The banner earns its place only while something required is missing. Optional
  // integrations keep their own quiet empty states and never summon it.
  if (dockerKnown && dockerOn && serviceCount != null && serviceCount > 0) return null;

  const configured =
    (sys ? 1 : 0) + (serviceCount ? 1 : 0) + (dockerOn ? 1 : 0);
  const wx = !!(settings.integrations.weather.location || (settings.integrations.weather.latitude != null && settings.integrations.weather.longitude != null));
  const news = (settings.integrations.news.feeds || []).length > 0;
  const markets = (settings.integrations.markets.symbols || []).length > 0;
  const configureHref = !dockerKnown || !dockerOn ? '/settings/system' : serviceCount === 0 ? '/settings/services' : '/settings/integrations';

  return (
    <section className="setup-banner" aria-label="Finish setting up OpusHub">
      <div className="setup-main">
        <h2 className="setup-title">Welcome to OpusHub</h2>
        <p className="setup-sub">Your control center is ready — {configured} of 3 connected.</p>
        <div className="setup-cols">
          <div className="setup-col">
            <div className="micro-label">Connected</div>
            <ul>
              <li><Tick on={!!sys} /> System <span className="setup-hint">{sys ? sys.host.hostname : 'reading…'}</span></li>
              <li><Tick on={!!serviceCount} /> Configuration <span className="setup-hint">{serviceCount == null ? 'reading…' : serviceCount ? `${serviceCount} services` : 'no services yet'}</span></li>
              <li><Tick on={dockerOn} /> Docker <span className="setup-hint">{!dockerKnown ? 'checking…' : dockerOn ? `engine ${docker.data?.version || ''}`.trim() : 'not connected'}</span></li>
            </ul>
          </div>
          <div className="setup-col">
            <div className="micro-label">Optional</div>
            <ul>
              <li><Tick on={wx} /> Weather</li>
              <li><Tick on={news} /> News</li>
              <li><Tick on={markets} /> Markets</li>
            </ul>
          </div>
        </div>
      </div>
      <div className="setup-actions">
        <Link className="btn btn-primary btn-sm" to={configureHref}>Configure →</Link>
        <button className="btn btn-quiet btn-sm" onClick={() => setLayout({ hub: { setupDismissed: true } })}>Dismiss</button>
      </div>
    </section>
  );
}
