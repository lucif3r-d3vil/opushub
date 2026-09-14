// Live render check — the last thing to run before deployment.
//
// It fetches the real API of a running OpusHub (mock engine in development, the real host in
// production), renders the real Hub through the real component tree, and asserts that what the
// payload says is what the markup shows. This is the closest thing to opening the page that exists
// in an environment without a browser: discovery → model → API → React are all exercised for real.
//
//   node test/ssr-smoke.mjs live          (against http://localhost:3000)
//   OPUSHUB_URL=http://host:3000 node ... (against any other instance)
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { LayoutDoc } from './lib/types';
import type { HubData } from './lib/hubData';
import { HubSurface } from './components/hub/HubSurface';
import { SettingsProvider, LayoutProvider } from './lib/theme';

const BASE = process.env.OPUSHUB_URL || 'http://localhost:3000';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) console.log(`✓ ${name}`);
  else { failures++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const visible = (html: string) => html.replace(/<!--.*?-->/g, '');
const count = (html: string, needle: string) => html.split(needle).length - 1;

async function get<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

const q = <T,>(data: T | null, error: string | null = null) => ({ data, error, loading: false, fetchedAt: Date.now(), refresh: () => undefined });

async function main() {
  const layout = await get<LayoutDoc>('/api/layout');
  if (!layout) {
    console.error(`✗ no OpusHub answering at ${BASE} — start it first (npm start, with the mock engine for development)`);
    process.exit(1);
  }

  const [settings, system, services, stacks, activity, bookmarks, widgets, weather, news, markets] = await Promise.all([
    get<unknown>('/api/settings'),
    get<HubData['system']['data']>('/api/system'),
    get<HubData['services']['data']>('/api/services'),
    get<HubData['stacks']['data']>('/api/stacks'),
    get<{ items: unknown[] }>('/api/activity?limit=12'),
    get<HubData['bookmarks']['data']>('/api/bookmarks'),
    get<HubData['widgets']['data']>('/api/widgets'),
    get<HubData['weather']['data']>('/api/weather'),
    get<HubData['news']['data']>('/api/news'),
    get<HubData['markets']['data']>('/api/market'),
  ]);
  check('layout and settings answer', !!settings && Array.isArray(layout.hub.widgets), `${layout.hub.widgets.length} widgets`);

  const data = {
    system: q(system), services: q(services), stacks: q(stacks),
    activity: q(activity as never), bookmarks: q(bookmarks), widgets: q(widgets),
    weather: q(weather), news: q(news), markets: q(markets),
  } as HubData;

  let html = '';
  try {
    html = renderToString(
      <MemoryRouter>
        <SettingsProvider>
          <LayoutProvider>
            <HubSurface data={data} layout={layout} interactive onLayoutChange={() => undefined} />
          </LayoutProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
  } catch (e) {
    failures++;
    console.error(`✗ the Hub threw while rendering live data: ${(e as Error).message}`);
  }
  const text = visible(html);
  check('the Hub renders live data without throwing', html.length > 5000, `${html.length} bytes`);

  // 1. docker state — whatever the payload says, the page agrees
  if (services) {
    if (services.live) {
      const applications = services.stats?.applications ?? 0;
      check('docker connected: the header reports the discovered count', text.includes(`${applications} services`), `expected "${applications} services"`);
      const visibleNames = services.groups.flatMap((g) => g.services.filter((s) => s.showOnHub !== false).map((s) => s.name));
      check('every discovered service appears in the launcher', visibleNames.every((n) => text.includes(n)),
        visibleNames.filter((n) => !text.includes(n)).slice(0, 5).join(', '));
      check('no service is invented beyond the inventory', !/Fake|Placeholder|Example (app|service)/i.test(text));
    } else {
      check('docker unavailable: the page says so and shows no inventory', text.includes('Docker') && text.includes('connected'), services.statusReason || '');
    }
  } else {
    check('services payload present', false, 'no /api/services');
  }

  // 2. every widget in the saved layout draws a frame (or is deliberately hidden)
  const zones = layout.hub.widgets.filter((w) => w.visible !== false);
  const frames = count(html, 'class="widget ') + count(html, 'class="widget"');
  check('every visible widget renders a frame', frames >= zones.length, `${frames} frames for ${zones.length} widgets`);

  // 3. providers: real content, or the documented unavailable state — never invented values
  const weatherOk = weather && weather.status === 'ok';
  check('weather widget matches its provider state', weatherOk
    ? text.includes(`${Math.round((weather as { current: { tempC: number } }).current.tempC)}°`)
    : text.includes('Not set up yet.') || text.includes('weather service') || text.includes('unavailable'),
    weatherOk ? 'expected the real reading' : 'expected an unavailable state');
  const newsOk = news && news.status === 'ok' && news.items.length > 0;
  check('news widget matches its provider state', newsOk
    ? text.includes((news as { items: { title: string }[] }).items[0].title.slice(0, 24))
    : text.includes('Not set up yet.') || text.includes('feed') || text.includes('unavailable'));
  const marketsOk = markets && markets.status === 'ok' && markets.items.length > 0;
  check('markets widget matches its provider state', marketsOk
    ? text.includes((markets as { items: { symbol: string }[] }).items[0].symbol)
    : text.includes('Not set up yet.') || text.includes('provider') || text.includes('unavailable'));

  // 4. an unavailable provider must not be dressed up with numbers
  const unavailableCopy = ['Not set up yet.', 'unavailable', 'could not', 'Could not', 'not connected'];
  check('no provider is faked when it is not answering', weatherOk || newsOk || marketsOk || unavailableCopy.some((c) => text.includes(c)));

  console.log(`\n${failures ? `${failures} live check(s) failed` : 'live checks passed'} (${BASE})`);
  process.exit(failures ? 1 : 0);
}

void main();
