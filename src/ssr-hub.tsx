// Hub render harness — renders the real Hub surface with fixture data and asserts what comes out.
//
// There is no browser in this environment, so this is how the composition is verified: the actual
// component, the actual widget renderers, fixture data only for the *shape* of API responses.
// It exists to prove the states that are easy to get wrong and impossible to eyeball:
//   · a Hub with no widgets (first run)          · Docker unavailable
//   · every provider failing                      · providers that were never configured
//   · hidden + reordered widgets and services     · a widget type this build does not know
//   · the preview surface (same component, no interaction)
//
// Run: npm run smoke:hub   (fixtures are marked FIXTURE and never touch production paths)
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { LayoutDoc, NewsDoc, ServicesDoc, WeatherDoc, WidgetInstance } from './lib/types';
import type { HubData } from './lib/hubData';
import {
  activityDoc, bookmarksDoc, catalogue, layoutWith, marketDoc, newsDoc, servicesDoc, stacksDoc,
  systemSnapshot, weatherDoc,
} from './ssr-fixtures';
import { HubSurface } from './components/hub/HubSurface';
import { SettingsProvider, LayoutProvider } from './lib/theme';

let failures = 0;
const check = (name: string, raw: string, ...needles: (string | string[])[]) => {
  const html = visibleText(raw);
  const missing = needles.flat().filter((n) => !html.includes(n));
  if (missing.length) {
    failures++;
    console.error(`✗ ${name} — missing: ${missing.map((m) => JSON.stringify(m.slice(0, 60))).join(', ')}`);
  } else {
    console.log(`✓ ${name}`);
  }
};

const query = <T,>(data: T, error: string | null = null) => ({ data, error, loading: false, fetchedAt: Date.now(), refresh: () => undefined });
const dead = <T,>(error: string) => ({ data: null as T | null, error, loading: false, fetchedAt: null, refresh: () => undefined });
const waiting = <T,>() => ({ data: null as T | null, error: null, loading: true, fetchedAt: null, refresh: () => undefined });

function hubData(overrides: Partial<HubData> = {}): HubData {
  return {
    system: query(systemSnapshot),
    services: query(servicesDoc),
    stacks: query(stacksDoc),
    activity: query(activityDoc),
    bookmarks: query(bookmarksDoc),
    weather: query(weatherDoc),
    news: query(newsDoc),
    markets: query(marketDoc),
    widgets: query({ catalogue, widgets: [], spacing: 'comfortable' }),
    ...overrides,
  } as HubData;
}

const visibleText = (html: string) => html.replace(/<!--.*?-->/g, '');

function render(node: ReactNode): string {
  return renderToString(
    <MemoryRouter>
      <SettingsProvider>
        <LayoutProvider>{node}</LayoutProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

const W = (type: string, extra: Partial<WidgetInstance> = {}): WidgetInstance => ({
  id: extra.id || type, type, zone: extra.zone || (['services', 'system', 'stacks', 'attention'].includes(type) ? 'main' : 'rail'),
  size: extra.size || (type === 'services' ? 'lg' : 'md'), visible: extra.visible !== false, config: extra.config || {},
});

/* ---------------- scenarios ---------------- */

// 1. first run: nothing arranged yet
{
  const layout: LayoutDoc = layoutWith([]);
  const html = render(<HubSurface data={hubData()} layout={layout} interactive onLayoutChange={() => undefined} />);
  check('first run: a welcome, not a wall of placeholders', html, 'Your Hub is ready.', '/settings/templates', '/settings/widgets');
}

// 2. the populated Hub — services, system, and the information rail
{
  const layout: LayoutDoc = layoutWith([
    W('system', { size: 'md' }), W('services', { size: 'lg' }),
    W('weather'), W('news'), W('markets'), W('bookmarks'), W('activity'),
  ]);
  const html = render(<HubSurface data={hubData()} layout={layout} interactive onLayoutChange={() => undefined} />);
  check('populated hub: greeting, counts, launcher, rail widgets', html, [
    'Good ', // time-of-day greeting
    '3 services', 'running',
    'Wave', 'Photos',            // launcher entries, from the fixture inventory
    '18°',                       // weather, from the fixture reading
    'Something happened',        // news headline
    'AAPL',                      // market row
    'Hacker News',               // bookmark chip
    'container started',         // activity wording
    'week ',
  ]);
  check('populated hub: launcher states are dots and words, never badges', html, 'status-dot', 'title=');
  check('populated hub: a bare container without a web endpoint says so, and links nowhere', html, ['No web endpoint detected', 'li-open--none', '· no web endpoint']);
  if (html.includes('Open http://fixture.local/photos')) { failures++; console.error('✗ no launch button may be rendered for a URL-less service'); }
}

// 3. Docker unavailable — one honest sentence, no invented services
{
  const doc: ServicesDoc = { ...servicesDoc, live: false, groups: [], infrastructure: [], services: [], statusReason: 'no-socket' };
  const layout = layoutWith([W('services'), W('system'), W('stacks'), W('attention')]);
  const html = render(<HubSurface data={hubData({ services: query(doc) })} layout={layout} interactive onLayoutChange={() => undefined} />);
  check('docker unavailable: says so once, per affected widget', html, ['Docker isn', 'connected.', 'Configure Docker']);
  // (the fixture inventory is named Wave; nothing from it may survive a Docker-off render)
  if (html.includes('Wave')) { failures++; console.error('✗ docker unavailable must not render inventory'); }
  else console.log('✓ docker unavailable: nothing is invented');
}

// 4. every external provider down — each widget degrades alone
{
  const layout = layoutWith([W('services'), W('weather'), W('news'), W('markets'), W('activity'), W('system')]);
  const html = render(
    <HubSurface
      data={hubData({
        weather: dead('fetch failed'),
        news: dead('fetch failed'),
        markets: dead('fetch failed'),
        system: dead('permission denied'),
      })}
      layout={layout}
      interactive
      onLayoutChange={() => undefined}
    />,
  );
  check('providers down: each widget owns its failure', html, ['The weather service', 'News feeds', 'quote provider', 'Host metrics', 'Wave']);
}

// 5. providers never configured — quiet absence, with the way to fix it
{
  const layout = layoutWith([W('services'), W('weather'), W('news'), W('markets')]);
  const html = render(
    <HubSurface
      data={hubData({
        weather: query({ status: 'unconfigured', reason: 'no location' } as WeatherDoc),
        news: query({ status: 'unconfigured', items: [] } as NewsDoc),
        markets: query({ status: 'unconfigured', items: [] } as unknown as typeof marketDoc),
      })}
      layout={layout}
      interactive
      onLayoutChange={() => undefined}
    />,
  );
  check('unconfigured providers: Not set up yet + a link, never a fake reading', html, ['Not set up yet.', '/settings/integrations', 'Add feeds', 'Set a location']);
}

// 6. hidden + reordered: the user's arrangement is respected, hidden things stay reachable
{
  const layout: LayoutDoc = {
    version: 2,
    hub: {
      widgets: [
        W('news', { visible: false }),
        W('services', { size: 'lg' }),
        W('system', { visible: false }),
        W('markets', { zone: 'main' }),
      ],
      spacing: 'airy',
      setupDismissed: false,
    },
    services: { groupOrder: ['Rails', 'Media'], order: { Media: ['photos', 'wave'] }, hiddenGroups: [] },
  };
  const html = render(<HubSurface data={hubData()} layout={layout} interactive onLayoutChange={() => undefined} />);
  check('hidden widgets stay reachable, not lost', html, ['2 hidden widgets', '+ News', '+ System']);
  check('spacing from the layout reaches the surface', html, 'hub--airy');
  const photos = html.indexOf('Photos');
  const wave = html.indexOf('>Wave<');
  if (photos === -1 || wave === -1 || photos > wave) {
    failures++;
    console.error('✗ reordered services render in the saved order — photos should precede wave');
  } else {
    console.log('✓ reordered services render in the saved order');
  }
}

// 7. a widget type from a newer build: graceful, not a crash
{
  const layout = layoutWith([W('services'), { id: 'holodeck', type: 'holodeck', zone: 'main', size: 'md', visible: true, config: {} }]);
  const html = render(<HubSurface data={hubData()} layout={layout} interactive onLayoutChange={() => undefined} />);
  check('unknown widget type degrades quietly', html, 'Widget settings');
}

// 8. preview surface: the same component, non-interactive
{
  const layout = layoutWith([W('services'), W('system')]);
  const html = render(<HubSurface data={hubData()} layout={layout} interactive={false} preview frozenNow={new Date('2026-09-12T09:30:00')} />);
  check('preview renders the real Hub without controls', html, ['Wave', 'Good morning']);
  if (html.includes('drag-handle')) {
    failures++;
    console.error('✗ preview must not render drag handles');
  } else {
    console.log('✓ preview renders no drag handles');
  }
}

// 9. loading: the page keeps its shape while providers answer
{
  const layout = layoutWith([W('services'), W('system'), W('weather'), W('news'), W('activity')]);
  const html = render(
    <HubSurface
      data={hubData({ services: waiting(), system: waiting(), weather: waiting(), news: waiting(), activity: waiting() })}
      layout={layout}
      interactive
      onLayoutChange={() => undefined}
    />,
  );
  check('loading: quiet, layout-stable placeholders', html, ['Reading', 'Sampling']);
  if (html.includes('skeleton')) { failures++; console.error('✗ skeleton grids are not part of this design'); }
}

if (failures) {
  console.error(`\n${failures} hub render check(s) failed`);
  process.exit(1);
}
console.log('\nhub render checks passed');
