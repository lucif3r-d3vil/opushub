// Interaction checks — the things a screenshot cannot prove: that `/` and ⌘K open search, that
// arrows and Enter move through it, that Escape closes it, that a widget menu writes the layout it
// claims to write, and that keyboard reordering commits the order the user asked for.
//
// Run with: npm run test:web   (jsdom; see test/web-run.mjs)
import { act, useCallback, useEffect, useState, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LayoutProvider, SettingsProvider, useLayout } from '../../src/lib/theme';
import { AuthProvider } from '../../src/lib/auth';
import { useHubData } from '../../src/lib/hubData';
import { HubSurface } from '../../src/components/hub/HubSurface';
import { SearchOverlay, useGlobalSearchHotkey } from '../../src/components/SearchOverlay';
import Hub from '../../src/pages/Hub';
import Settings from '../../src/pages/Settings';
import IconsPage from '../../src/pages/Icons';
import ServiceDetail from '../../src/pages/ServiceDetail';
import StackDetail from '../../src/pages/StackDetail';
import type { LayoutDoc, WidgetInstance } from '../../src/lib/types';
import type { HubData } from '../../src/lib/hubData';
import App from '../../src/App';
import { GroupNameField } from '../../src/components/GroupNameField';
import { MenuButton } from '../../src/components/ui';
import { AreaChart } from '../../src/components/Charts';
import { createHarness, click, key, q, qa, text, type, type Harness } from './harness';
import {
  activityDoc, bookmarksDoc, catalogue, layoutWith, marketDoc, newsDoc, servicesDoc, stacksDoc,
  systemSnapshot, weatherDoc,
} from '../../src/ssr-fixtures';

export interface WebResult { passed: number; failed: number; failures: string[] }

const settings = {
  app: { name: 'OpusHub', tagline: 'The OpusGrid homelab, at a glance.' },
  appearance: { theme: 'dark', accent: 'sage', density: 'comfortable', transparency: true, fontScale: 1, background: { mode: 'quiet', photo: null, blur: 24, scrim: 62 } },
  hub: { greetingName: 'Nora', clock24h: true, showSeconds: false },
  integrations: { news: { feeds: [] }, weather: { location: null, latitude: null, longitude: null, place: null, units: 'c' }, markets: { symbols: [] } },
  behavior: { logLaunches: true, refresh: { system: 5, services: 30 } },
  advanced: { customCss: false, customJs: false },
};

const layout: LayoutDoc = layoutWith([
  { id: 'services', type: 'services', zone: 'main', size: 'lg', visible: true, config: {} },
  { id: 'system', type: 'system', zone: 'main', size: 'md', visible: true, config: {} },
  { id: 'activity', type: 'activity', zone: 'rail', size: 'md', visible: true, config: {} },
  { id: 'clock', type: 'clock', zone: 'rail', size: 'sm', visible: false, config: {} },
]);

const widgetDoc = { catalogue, widgets: layout.hub.widgets, spacing: layout.hub.spacing };

/** The detail endpoints, built from the same fixtures the launcher uses. */
const serviceDetail = {
  service: servicesDoc.services[0],
  stack: stacksDoc.stacks[0],
  container: null,
  containerStats: null,
  dockerAvailable: false,
  url: servicesDoc.services[0].url,
  urlSource: servicesDoc.services[0].urlSource,
  urlNote: null,
};
const stackDetail = { ...stacksDoc.stacks[0], live: true, statusReason: null };
const noWebService = servicesDoc.services.find((s) => s.url == null)!;
const noWebDetail = { ...serviceDetail, service: noWebService, url: null, urlSource: 'none', container: null };

const searchResults = (query: string) => ({
  results: query.includes('nav')
    ? [{ title: 'Navidrome', subtitle: 'Music · running', kind: 'service', href: '/services/Music/navidrome', icon: null, status: 'up' }]
    : [{ title: 'Widgets', subtitle: 'Hub Layout', kind: 'setting', href: '/settings/widgets' }],
});

/* Phase 3 fixtures: on-demand readings for the detail page. */
const waveContainer = {
  name: 'wave', id: 'fixturewave', image: 'ghcr.io/example/wave:1.0', imageId: 'sha256:ab12cd34',
  created: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  state: {
    status: 'running', health: 'healthy' as const, healthcheck: { status: 'healthy', failingStreak: 0 },
    startedAt: new Date(Date.now() - 86_400_000).toISOString(), finishedAt: null,
    restartCount: 2, exitCode: null, oomKilled: false,
  },
  restartPolicy: 'unless-stopped', networkMode: 'bridge', logDriver: 'json-file',
  command: '/usr/bin/wave --config /data/config.yaml',
  labels: { project: 'media', service: 'wave' },
  ports: [{ ip: '0.0.0.0', private: 8096, public: 8096, type: 'tcp' }],
  exposedPorts: [{ private: 8096, type: 'tcp' }],
  networks: [{ name: 'media_default', ip: '172.20.0.4', gateway: '172.20.0.1' }],
  mounts: [{ type: 'bind', source: '/srv/wave/data', destination: '/data', mode: 'rw', size: null }],
};
const statsSamples = {
  service: 'wave',
  watchingSince: Date.now() - 12 * 60_000,
  capped: false,
  samples: [
    { t: Date.now() - 25_000, cpu: 12.5, mem: 220_000_000, memLimit: 4_000_000_000, netRx: 10_000, netTx: 2_000, pids: 8, blockIo: null },
    { t: Date.now() - 20_000, cpu: 14.1, mem: 224_000_000, memLimit: 4_000_000_000, netRx: 30_000, netTx: 4_000, pids: 8, blockIo: null },
    { t: Date.now() - 15_000, cpu: 11.9, mem: 221_000_000, memLimit: 4_000_000_000, netRx: 52_000, netTx: 7_000, pids: 9, blockIo: null },
    { t: Date.now() - 10_000, cpu: 18.2, mem: 228_000_000, memLimit: 4_000_000_000, netRx: 76_000, netTx: 9_000, pids: 9, blockIo: null },
    { t: Date.now() - 5_000, cpu: 16.0, mem: 226_000_000, memLimit: 4_000_000_000, netRx: 99_000, netTx: 12_000, pids: 9, blockIo: null },
  ],
};
const liveStats = { status: 'ok', at: Date.now(), stats: { cpu: 16.0, memory: { used: 226_000_000, limit: 4_000_000_000 }, net: { rx: 99_000, tx: 12_000 }, pids: 9, blockIo: null } };
const serviceHistoryDoc = {
  service: 'wave',
  watchingSince: Date.now() - 3_600_000,
  logStarted: Date.now() - 3_600_000,
  events: [
    { id: 'h2', t: Date.now() - 300_000, iso: new Date().toISOString(), source: 'docker', type: 'container.health', subject: 'wave', message: 'health now healthy' },
    { id: 'h1', t: Date.now() - 3_500_000, iso: new Date().toISOString(), source: 'docker', type: 'container.started', subject: 'wave', message: 'running' },
  ],
};
const logLines = [
  'Starting server on port 8096',
  'WARN cache miss for /library',
  'ERROR database connection refused',
  'Reconnected to database',
  'Playback session opened',
];
const logsRoute = (_body: unknown, path: string) => ({
  status: 'ok',
  lines: path.includes('timestamps=1')
    ? logLines.map((l, i) => `2026-09-14T09:0${i}:00Z ${l}`)
    : logLines,
});
const providersFixture = {
  at: Date.now(),
  providers: [
    { name: 'docker', state: 'available' as const, lastOk: Date.now() - 2000, lastTry: Date.now() - 2000, staleMs: 2000, reason: null },
    { name: 'system', state: 'available' as const, lastOk: Date.now() - 2000, lastTry: Date.now() - 2000, staleMs: 2000, reason: null },
    { name: 'news', state: 'unavailable' as const, lastOk: null, lastTry: Date.now() - 2000, staleMs: null, reason: 'feeds unreachable' },
    { name: 'weather', state: 'idle' as const, lastOk: null, lastTry: null, staleMs: null, reason: null },
    { name: 'markets', state: 'idle' as const, lastOk: null, lastTry: null, staleMs: null, reason: null },
  ],
};

function stubRoutes(): Record<string, unknown | ((body: unknown, path: string) => unknown)> {
  return {
    '/api/settings': settings,
    '/api/layout': layout,
    '/api/widgets': widgetDoc,
    '/api/services': servicesDoc,
    '/api/stacks': stacksDoc,
    '/api/system': systemSnapshot,
    '/api/activity': activityDoc,
    '/api/bookmarks': bookmarksDoc,
    '/api/weather': weatherDoc,
    '/api/news': newsDoc,
    '/api/market': marketDoc,
    '/api/search': (_body, path) => searchResults(decodeURIComponent(path.split('q=')[1] || '')),
    // the same shape GET /api/templates returns (templates are composition only)
    '/api/templates': {
      templates: [
        {
          id: 'minimal', name: 'Minimal', tagline: 'Time, services, and nothing else',
          description: 'A quiet home screen.', spacing: 'airy', unmatchedGroups: [], groupPriority: ['Media', 'Music'],
          widgets: [
            { id: 'clock', type: 'clock', zone: 'main', size: 'sm', title: 'Clock' },
            { id: 'services', type: 'services', zone: 'main', size: 'lg', title: 'Services' },
          ],
          preview: layoutWith([
            { id: 'clock', type: 'clock', zone: 'main', size: 'sm', visible: true, config: {} },
            { id: 'services', type: 'services', zone: 'main', size: 'lg', visible: true, config: {} },
          ]),
        },
        {
          id: 'balanced', name: 'Balanced', tagline: 'The shipped arrangement', description: 'Everything, once.',
          spacing: 'comfortable', unmatchedGroups: ['Other'], groupPriority: ['Media'], widgets: [], preview: layout,
        },
      ],
      layout, spacing: layout.hub.spacing, groupNames: ['Media'],
    },
    '/api/services/Music/wave': { ...serviceDetail, dockerAvailable: true, container: waveContainer, containerStats: liveStats.stats },
    '/api/services/Music/wave/stats': liveStats,
    '/api/services/Music/wave/stats/history': statsSamples,
    '/api/services/Music/wave/history': serviceHistoryDoc,
    '/api/docker/containers/wave/logs': logsRoute,
    '/api/providers': providersFixture,
    '/api/services/Media/photos': noWebDetail,
    '/api/services/Music/navidrome': {
      ...serviceDetail,
      service: { ...servicesDoc.services[0], name: 'navidrome', displayName: 'Navidrome', description: 'Music streaming', group: 'Music' },
    },
    '/api/stacks/media': stackDetail,
  };
}

/** The Hub, inside the providers it actually runs with, plus routes to observe navigation. */
function TestApp({ children, entry = '/' }: { children: ReactNode; entry?: string }) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <SettingsProvider>
        <LayoutProvider>
          <Routes>
            <Route path="/" element={children} />
            <Route path="/settings/:tab" element={<Settings />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/icons" element={<IconsPage />} />
            <Route path="/activity" element={<div data-test="activity">activity</div>} />
            <Route path="/stacks/:name" element={<StackDetail />} />
            <Route path="/services/:group/:name" element={<ServiceDetail />} />
          </Routes>
        </LayoutProvider>
      </SettingsProvider>
    </MemoryRouter>
  );
}

/** A second consumer of the Hub's data — the role Settings → Hub Layout's preview plays. */
function SecondConsumer() {
  const { layout: l } = useLayout();
  useHubData({ types: new Set(['services', 'system']) });
  void l;
  return null;
}

/** Mirrors the real Shell wiring: hotkey + the custom event the Hub header dispatches. */
function SearchHost() {
  const [open, setOpen] = useState(false);
  useGlobalSearchHotkey(useCallback(() => setOpen(true), []));
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('opushub:open-search', onOpen);
    return () => window.removeEventListener('opushub:open-search', onOpen);
  }, []);
  return <SearchOverlay open={open} onClose={() => setOpen(false)} />;
}

const dialog = () => q('[role="dialog"]');
const searchInput = () => q<HTMLInputElement>('.cmdk-input-row input');

export async function runWebTests(): Promise<WebResult> {
  let passed = 0;
  const failures: string[] = [];
  const results: { name: string; ok: boolean; detail?: string }[] = [];

  const test = async (name: string, fn: (h: Harness) => Promise<void>) => {
    const h = await createHarness({ routes: stubRoutes() });
    try {
      await fn(h);
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, detail: (err as Error).message });
    } finally {
      await h.unmount();
    }
  };

  const expect = (cond: unknown, message: string) => {
    if (!cond) throw new Error(message);
  };

  /* 1 — the Hub renders the discovered inventory, not a placeholder */
  await test('hub renders the discovered inventory and the greeting', async (h) => {
    await h.mount(<TestApp><Hub /></TestApp>);
    await h.flush(50);
    await h.waitFor(() => text().includes('Wave'), 'the launcher to fill from the API');
    expect(text().includes('Wave') && text().includes('Photos'), 'a discovered service is missing from the launcher');
    expect(/good (morning|afternoon|evening)/i.test(text()), 'the greeting is missing');
    expect(text().includes('3 services'), 'the header does not report the discovered count');
    // the tab is the install's own name (settings.yaml → app.name), set once for every page
    expect(document.title === 'OpusHub', `the document title should be the configured name (got “${document.title}”)`);
    expect(text().includes('Friday') || /day/i.test(text()), 'the date is missing');
    expect(qa('.launcher-items > li').length >= 3, 'the launcher list is short');
    // a service with no resolved URL must not offer a launch button
    const noWeb = qa('.launch-item').find((el) => el.getAttribute('data-noweb') != null);
    expect(noWeb, 'the fixture has a service with no URL, so one row should be marked');
    expect(!q('button.li-open', noWeb!) && !q('a.li-open', noWeb!), 'a URL-less service rendered a launch button');
  });

  /* 1b — a renamed install renames the tab, on any page that has settings loaded */
  await test('settings: app.name drives the document title', async (h) => {
    const named = JSON.parse(JSON.stringify(settings));
    named.app.name = 'Grid Control';
    h.setRoutes({ ...stubRoutes(), '/api/settings': named });
    await h.mount(<TestApp><Hub /></TestApp>);
    await h.flush(50);
    await h.waitFor(() => document.title === 'Grid Control', 'the configured name to reach the tab');
  });

  /* 2 — the search surface opens from every documented trigger */
  await test('search opens from / , ⌘K and the Hub search button', async (h) => {
    await h.mount(<TestApp><Hub /><SearchHost /></TestApp>);
    await h.waitFor(() => !!q('.hub-search'), 'the Hub search field');
    expect(!dialog(), 'the overlay should start closed');
    click(q('.hub-search')!);
    await h.flush(40);
    expect(dialog(), 'the Hub search field did not open the overlay');
    key(window, 'Escape');
    await h.flush(40);
    expect(!dialog(), 'Escape did not close the overlay');
    key(window, '/');
    await h.flush(40);
    expect(dialog(), '“/” did not open search');
    expect(document.activeElement === searchInput(), 'the search field did not take focus');
    key(window, 'Escape');
    await h.flush(40);
    expect(!dialog(), 'Escape did not close search');
    key(window, 'k', { metaKey: true });
    await h.flush(40);
    expect(dialog(), '⌘K did not open search');
    key(window, 'Escape');
    await h.flush(40);
    window.dispatchEvent(new window.CustomEvent('opushub:open-search'));
    await h.flush(40);
    expect(dialog(), 'the event the Hub header dispatches did not open search');
    key(window, 'Escape');
    await h.flush(40);
  });

  /* 3 — arrows move, Enter opens, and the overlay is keyboard-native */
  await test('search: typing, arrow navigation and Enter open the result', async (h) => {
    await h.mount(<TestApp><SearchHost /></TestApp>);
    key(window, '/');
    await h.flush(40);
    await type(searchInput()!, 'nav');
    await h.waitFor(() => text().includes('Navidrome'), 'server results for “nav”');
    await h.flush(250);
    key(window, 'ArrowDown');
    await h.flush(5);
    const active = q('[data-active="true"]');
    expect(active, 'no result is marked active after ArrowDown');
    expect(text(active!).includes('Navidrome'), `the active result is “${text(active!)}”, expected Navidrome`);
    key(window, 'Enter');
    await h.flush(60);
    expect(!dialog(), 'Enter did not close the overlay');
    expect(qa('h1.detail-title').some((el) => text(el).includes('Navidrome')), 'Enter did not open the service page');
  });

  /* 4 — Escape closes from the input, and focus comes back to the page */
  await test('search: Escape closes and returns focus to the trigger', async (h) => {
    await h.mount(<TestApp><SearchHost /></TestApp>);
    const trigger = document.createElement('button');
    trigger.textContent = 'open';
    document.body.appendChild(trigger);
    trigger.focus();
    key(window, '/');
    await h.flush(40);
    expect(document.activeElement === searchInput(), 'the field should hold focus while open');
    key(window, 'Escape');
    await h.flush(20);
    expect(!dialog(), 'Escape did not close the overlay');
    expect(document.activeElement === trigger || document.activeElement === document.body,
      'focus was left somewhere unexpected after closing');
    trigger.remove();
  });

  /* 5 — the widget menu performs the change it advertises */
  await test('widget menu: Hide from Hub writes the layout', async (h) => {
    await h.mount(<TestApp><Hub /></TestApp>);
    await h.waitFor(() => !!q('.widget-tools .icon-btn'), 'the widget tools to render');
    click(q('.widget-tools .icon-btn')!);
    await h.flush(40);
    const item = qa('button, a').find((el) => text(el).trim() === 'Hide from Hub');
    expect(item, `no “Hide from Hub” item in the menu (${qa('.menu button, .menu a').map((e) => text(e)).join(' | ')})`);
    click(item!);
    await h.waitFor(() => !!h.lastCall('PUT', '/api/layout'), 'the layout PUT');
    const body = h.lastCall('PUT', '/api/layout')!.body as { hub?: { widgets?: WidgetInstance[] } };
    const services = body.hub?.widgets?.find((w) => w.id === 'services');
    expect(services?.visible === false, `expected the services widget to be hidden, got ${JSON.stringify(services)}`);
  });

  /* 6 — resizing and moving a widget are real layout writes too */
  await test('widget menu: size and zone changes persist', async (h) => {
    await h.mount(<TestApp><Hub /></TestApp>);
    await h.waitFor(() => !!q('.widget-tools .icon-btn'), 'the widget tools to render');
    click(q('.widget-tools .icon-btn')!);
    await h.flush(40);
    const size = qa('button, a').find((el) => /^Size — Small$/.test(text(el).trim()));
    expect(size, `no size item in the menu (${qa('button, a').map((e) => text(e)).join(' | ')})`);
    click(size!);
    await h.waitFor(() => !!h.lastCall('PUT', '/api/layout'), 'the size write');
    const sized = h.lastCall('PUT', '/api/layout')!.body as { hub: { widgets: WidgetInstance[] } };
    expect(sized.hub.widgets.find((w) => w.id === 'services')?.size === 'sm', 'the size change was not written');

    await h.flush(20);
    click(q('.widget-tools .icon-btn')!);
    await h.flush(40);
    const move = qa('button, a').find((el) => /^Move to/.test(text(el).trim()));
    expect(move, 'no move item in the menu');
    click(move!);
    await h.waitFor(() => h.writes('PUT', '/api/layout').length > 1, 'the zone write');
    const moved = h.lastCall('PUT', '/api/layout')!.body as { hub: { widgets: WidgetInstance[] } };
    expect(moved.hub.widgets.find((w) => w.id === 'services')?.zone === 'rail', 'the widget did not move zone');
  });

  /* 7 — keyboard reordering: Space picks up, arrows move, Escape lets go */
  await test('keyboard reorder commits the order the user asked for', async (h) => {
    await h.mount(<TestApp><Hub /></TestApp>);
    await h.waitFor(() => !!q('.launcher-items .drag-handle'), 'the launcher handles');
    const handle = q('.launcher-items .drag-handle') as HTMLElement;
    const li = handle.closest('[data-sortable-id]')!;
    const id = li.getAttribute('data-sortable-id')!;
    handle.focus();
    key(handle, ' ');
    await h.flush(40);
    expect(li.className.includes('sortable-grabbed') || li.className.includes('grabbed'), `Space did not pick the item up (${li.className})`);
    expect(h.writes('PUT', '/api/layout').length === 0, 'picking up should not write anything yet');
    key(window, 'ArrowDown');
    await h.waitFor(() => h.writes('PUT', '/api/layout').length === 1, 'the reorder write');
    const body = h.lastCall('PUT', '/api/layout')!.body as { services?: { order?: Record<string, string[]> } };
    const order = body.services?.order || {};
    const groupKey = Object.keys(order)[0];
    expect(groupKey, 'the reorder did not name a group');
    expect(order[groupKey][1] === id, `expected ${id} second, got ${JSON.stringify(order[groupKey])}`);
    key(window, 'Escape');
    await h.flush(40);
    expect(!li.className.includes('grabbed'), 'Escape did not release the item');
  });

  /* 8 — the preview surface is the same Hub, with nothing to press */
  await test('preview surface renders the Hub without controls', async (h) => {
    const data = {
      system: { data: systemSnapshot, error: null, loading: false, fetchedAt: Date.now(), refresh: () => undefined },
      services: { data: servicesDoc, error: null, loading: false, fetchedAt: Date.now(), refresh: () => undefined },
      stacks: { data: stacksDoc, error: null, loading: false, fetchedAt: Date.now(), refresh: () => undefined },
      activity: { data: activityDoc, error: null, loading: false, fetchedAt: Date.now(), refresh: () => undefined },
      bookmarks: { data: bookmarksDoc, error: null, loading: false, fetchedAt: Date.now(), refresh: () => undefined },
      weather: { data: weatherDoc, error: null, loading: false, fetchedAt: Date.now(), refresh: () => undefined },
      news: { data: newsDoc, error: null, loading: false, fetchedAt: Date.now(), refresh: () => undefined },
      markets: { data: marketDoc, error: null, loading: false, fetchedAt: Date.now(), refresh: () => undefined },
      widgets: { data: widgetDoc, error: null, loading: false, fetchedAt: Date.now(), refresh: () => undefined },
    } as HubData;
    await h.mount(
      <TestApp>
        <HubSurface data={data} layout={layout} interactive={false} preview frozenNow={new Date('2026-09-12T09:30:00')} />
      </TestApp>,
    );
    await h.flush(20);
    expect(text().includes('Wave'), 'the preview did not render the real launcher');
    expect(!q('.drag-handle'), 'the preview rendered drag handles');
    expect(!q('.widget-tools .icon-btn'), 'the preview rendered widget menus');
    expect(q('.hub--preview'), 'the preview is not marked as such');
  });

  /* 9 — accessibility surface: labels, roles, states */
  await test('a11y: widget landmarks, labelled controls and live status', async (h) => {
    await h.mount(<TestApp><Hub /></TestApp>);
    await h.waitFor(() => !!q('.widget'), 'widgets to render');
    const widgets = qa('.widget');
    expect(widgets.length >= 2, 'expected at least two widgets');
    expect(widgets.every((w) => (w.getAttribute('aria-label') || '').length > 0), 'a widget has no accessible name');
    const handles = qa('.drag-handle');
    expect(handles.length > 0, 'no drag handles found');
    expect(handles.every((el) => (el.getAttribute('aria-label') || '').length > 0), 'a drag handle has no accessible name');
    expect(qa('[role="status"]').length > 0 || qa('[role="img"]').length > 0, 'no status announcements on the page');
    const dots = qa('.status-dot');
    expect(dots.every((d) => d.getAttribute('title') || d.getAttribute('aria-label')), 'a status dot carries no text');
    expect(q('.widget-tools .icon-btn')?.getAttribute('aria-haspopup') === 'menu', 'the widget menu is not announced as a menu');
  });

  /* 10 — two consumers, one set of requests (the preview must not re-poll) */
  await test('shared data: the preview reuses the Hub\'s requests', async (h) => {
    await h.mount(<TestApp><Hub /><SecondConsumer /></TestApp>);
    await h.waitFor(() => !!q('.launcher-items'), 'the launcher');
    await h.flush(120);
    const services = h.calls.filter((c) => c.path === '/api/services').length;
    const system = h.calls.filter((c) => c.path === '/api/system').length;
    expect(services === 1, `/api/services was requested ${services} times for two consumers`);
    expect(system === 1, `/api/system was requested ${system} times for two consumers`);
  });

  /* 11 — a hidden widget costs nothing: its provider is never called */
  await test('hidden widgets are not polled', async (h) => {
    const routes = stubRoutes();
    routes['/api/layout'] = {
      ...layout,
      hub: {
        ...layout.hub,
        widgets: [
          ...layout.hub.widgets.filter((w) => w.type !== 'activity'),
          { id: 'weather', type: 'weather', zone: 'rail', size: 'md', visible: false, config: {} },
          { id: 'news', type: 'news', zone: 'rail', size: 'md', visible: false, config: {} },
        ],
      },
    };
    const h2 = await createHarness({ routes });
    try {
      await h2.mount(<TestApp><Hub /></TestApp>);
      await h2.waitFor(() => !!q('.launcher-items'), 'the launcher');
      await h2.flush(120);
      expect(!h2.calls.some((c) => c.path.startsWith('/api/weather')), 'a hidden weather widget was still polled');
      expect(!h2.calls.some((c) => c.path.startsWith('/api/news')), 'a hidden news widget was still polled');
      expect(!text().includes('Partly cloudy'), 'hidden widget content leaked into the page');
    } finally {
      await h2.unmount();
    }
  });

  /* 12 — the rewrite of Settings: each Hub tab renders from real data */
  await test('settings: the Hub tabs render their editors', async (h) => {
    for (const [tab, expected] of [
      ['widgets', 'Reset layout'], ['templates', 'Minimal'], ['services', 'config/services.yaml'],
      ['groups', 'group'], ['advanced', 'Custom CSS & JS'], ['hub', 'Spacing'],
    ] as const) {
      h.root.unmount;
      const hh = await createHarness({ routes: stubRoutes(), fallback: () => ({}) });
      try {
        await hh.mount(<TestApp entry={`/settings/${tab}`}><Hub /></TestApp>);
        await hh.flush(150);
        expect(text().includes(expected), `settings/${tab} did not render (expected “${expected}”): ${text().slice(0, 200)}`);
      } finally {
        await hh.unmount();
      }
    }
    void h;
  });

  /* 13 — the icon browser can apply an icon to a real target */
  await test('icon browser lists discovered targets and searches the icon sets', async (h) => {
    const routes = { ...stubRoutes(), '/api/icons/search': { results: [{ ref: 'mdi:movie-open', collection: 'mdi' }], local: [] }, '/api/icons/local': { files: [] } };
    delete (routes as Record<string, unknown>)['/api/services/Music/wave'];
    const h2 = await createHarness({ routes, fallback: () => ({}) });
    try {
      await h2.mount(<TestApp entry="/icons"><Hub /></TestApp>);
      await h2.waitFor(() => h2.calls.some((c) => c.path.startsWith('/api/icons/search')), 'the icon collections to be searched');
      expect(/icon/i.test(text()), 'the icon browser did not render');
      expect(text().includes('Wave'), 'the discovered service is not offered as a target');
      expect(text().includes('Media'), 'the discovered stack is not offered as a target');
      expect(h2.calls.some((c) => c.path.startsWith('/api/icons/search')), 'the icon browser never searched the collections');
    } finally {
      await h2.unmount();
    }
  });

  /* 14 — the detail pages still render the canonical record */
  await test('service detail renders the record, and invents no link without a URL', async (h) => {
    await h.mount(<TestApp entry="/services/Music/wave"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('Wave'), 'the service page');
    expect(qa('h1.detail-title').some((el) => text(el).includes('Wave')), 'the service title is missing');
    expect(text().includes('http://fixture.local/wave') || qa('a[href="http://fixture.local/wave"]').length > 0,
      'the resolved URL is not offered on the service page');

    await h.unmount();
    const h2 = await createHarness({ routes: stubRoutes() });
    try {
      await h2.mount(<TestApp entry="/services/Media/photos"><Hub /></TestApp>);
      await h2.waitFor(() => text().includes('Photos'), 'the URL-less service page');
      expect(text().includes('No web endpoint detected'), 'a URL-less service did not say so on its page');
      expect(!qa('a[href^="http://fixture.local/photos"]').length, 'a URL-less service rendered an invented link');
    } finally {
      await h2.unmount();
    }
  });

  /* 13 — a stack page still lists its real members */
  await test('stack detail renders the members of the project', async (h) => {
    await h.mount(<TestApp entry="/stacks/media"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('Media'), 'the stack page');
    expect(text().includes('Wave') || text().includes('wave'), 'the stack members are missing');
    expect(!/Docker isn.t connected/.test(text()) || stackDetail.live === false, 'a live stack reported as disconnected');
  });

  /* 15 — Phase 3: resources arrive on demand, as sparklines, with real sample counts */
  await test('service resources: a measured session chart, only while the page is being looked at', async (h) => {
    await h.mount(<TestApp entry="/services/Music/wave"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('Wave'), 'the service page');
    await h.waitFor(() => text().includes('samples'), 'the resource history');
    // one measured chart (fixed box, so it can never paint under the text below it), plus the
    // network sparkline that lives in the stat strip
    const chart = q('.res-history .chart');
    expect(!!chart, 'the session history chart did not render');
    expect(!!chart!.querySelector('svg'), 'the chart has no drawing');
    expect(!!chart!.getAttribute('style')?.includes('height'), 'the chart box was not sized');
    expect(qa('.res-history .spark').length >= 1 || qa('.stat .spark').length >= 1, 'no sparkline at all');
    expect(text().includes('5 samples'), 'the sample count is not the real one');
    expect(text().includes('only while a page is watching'), 'the chart does not say what it actually covers');
    // polling stops when the page is left: count requests, unmount, count again
    const before = h.calls.filter((c) => c.path.startsWith('/api/services/Music/wave/stats/history')).length;
    await h.unmount();
    await h.flush(80);
    const after = h.calls.filter((c) => c.path.startsWith('/api/services/Music/wave/stats/history')).length;
    expect(after === before, `resource history kept polling after unmount (${before} → ${after})`);

    // labels: the allow-listed families are shown, the raw map is not
    const h3 = await createHarness({ routes: stubRoutes(), fallback: () => ({}) });
    try {
      await h3.mount(<TestApp entry="/services/Music/wave"><Hub /></TestApp>);
      await h3.waitFor(() => text().includes('Labels'), 'the labels block');
      expect(text().includes('allow-listed'), 'the labels block did not say what it contains');
      expect(!text().includes('SECRET_TOKEN'), 'a raw label was shipped to the page');
    } finally {
      await h3.unmount();
    }

    // no readings → an honest note, never zeros-as-data
    const routes = {
      ...stubRoutes(),
      '/api/services/Music/wave': { ...serviceDetail, dockerAvailable: true, container: waveContainer, containerStats: null },
      '/api/services/Music/wave/stats/history': { status: 'unavailable', reason: 'stats unavailable: container is stopped', samples: [] },
    };
    const h2 = await createHarness({ routes, fallback: () => ({}) });
    try {
      await h2.mount(<TestApp entry="/services/Music/wave"><Hub /></TestApp>);
      await h2.waitFor(() => text().includes('Wave'), 'the service page');
      await h2.waitFor(() => text().includes('no stats for this container'), 'the unavailable note');
    } finally {
      await h2.unmount();
    }
  });

  /* 16 — Phase 3: the log drawer filters locally, honors timestamps, invents nothing */
  await test('logs drawer: search and level filtering happen in the browser', async (h) => {
    await h.mount(<TestApp entry="/services/Music/wave"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('Wave'), 'the service page');
    const logsBtn = qa('button').find((b) => text(b).trim() === 'Logs');
    expect(logsBtn, 'no Logs button on the service page');
    click(logsBtn!);
    await h.waitFor(() => !!q('.drawer'), 'the logs drawer');
    await h.waitFor(() => text().includes('Starting server on port 8096'), 'the log lines');
    expect(qa('.logline').length === 5, `expected 5 log lines, saw ${qa('.logline').length}`);
    expect(text().includes('read-only'), 'the drawer does not say it is read-only');

    // search narrows locally — no extra request goes out
    const callsBefore = h.calls.length;
    type(q<HTMLInputElement>('input.logbar-search')!, 'database');
    await h.flush(30);
    expect(qa('.logline').length === 2, 'search should keep only matching lines');
    expect(h.calls.length === callsBefore, 'filtering must not fetch from the server');

    // errors only — one matching line, the warning stays out
    type(q<HTMLInputElement>('input.logbar-search')!, '');
    const errorsBtn = qa('.seg button').find((b) => text(b).startsWith('Errors'));
    expect(errorsBtn, 'the level filter buttons are missing');
    click(errorsBtn!);
    await h.flush(30);
    expect(qa('.logline').length === 1 && text().includes('ERROR database connection refused'), 'errors-only should show exactly the error');

    // timestamps: a real refetch (new tail parameter), and the prefix is lifted into its own cell
    const tsChk = qa('.logbar-chk input')[0];
    expect(tsChk, 'the timestamps toggle is missing');
    click(tsChk!);
    await h.waitFor(() => !!q('.log-ts'), 'timestamp cells');
    expect(text().includes('2026-09-14T09:0'), 'timestamp prefixes did not render');

    // copy/refresh/clear live in the header; only the two legitimate fetches happened
    expect(qa('.drawer-head button').length >= 3, 'refresh/copy/clear controls missing');
    const logFetches = h.calls.filter((c) => c.path.startsWith('/api/docker/containers/wave/logs')).length;
    expect(logFetches === 2, `logs were fetched ${logFetches} times (open + timestamps toggle), expected 2`);
  });

  /* 17 — Phase 3: settings report provider health for all five providers */
  await test('settings: the System tab shows honest provider health', async (h) => {
    await h.mount(<TestApp entry="/settings/system"><Settings /></TestApp>);
    await h.waitFor(() => text().includes('Providers'), 'the providers block');
    expect(text().includes('Docker') && text().includes('News'), 'provider rows are missing');
    expect(text().includes('Unavailable'), 'the failed provider is not marked unavailable');
    expect(text().includes('feeds unreachable'), 'the failure reason is hidden');
    expect(h.calls.some((c) => c.path.startsWith('/api/providers')), 'the settings page never asked for provider health');
  });

  /* 18 — Phase 4: an uninitialized install gets the wizard, and no application data is fetched */
  await test('auth gate: setup required shows the wizard and never loads the app', async (h) => {
    h.setRoutes({
      '/api/setup/status': {
        required: true, complete: false, hasAccount: false, version: '0.1.0',
        discovery: { docker: { ok: true, version: '26.1.0-mock', state: 'connected' }, stacks: 3, containers: 7, running: 6, services: 5, urls: { detected: 3, manual: 1, none: 1 }, infrastructure: 2, applications: 3, traefik: { routes: 3, tlsRoutes: 2 } },
      },
      '/api/auth/me': { authenticated: false, user: null, setupComplete: false },
    });
    await h.mount(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    await h.waitFor(() => text().includes('Welcome'), 'the setup wizard');
    expect(!q('.rail'), 'the application shell rendered before setup was complete');
    expect(text().includes('Administrator') && text().includes('Discovery'), 'the wizard steps are missing');
    expect(!h.calls.some((c) => c.path === '/api/services' || c.path === '/api/settings'), 'pre-auth requests were made for application data');
    expect(!q('#setup-user'), 'the account fields appear before the welcome step');
    click(qa('button').find((b) => text(b).trim() === 'Begin')!);
    await h.flush(30);
    expect(q('#setup-user'), 'the wizard did not advance to the account step');
    expect(!!q('#setup-pass2'), 'the confirm field is missing on the account step');
  });

  /* 18b — Phase 5: the wizard walks all six steps, explains URLs, and does not enter the app by itself */
  await test('setup wizard: six steps, URL reasons explained, and a Finish screen before the Hub', async (h) => {
    const discovery = {
      docker: { ok: true, state: 'connected', version: '26.1.0-mock', apiVersion: '1.43', operatingSystem: 'linux' },
      containers: 25, running: 18, stopped: 7, stacks: 7, services: 19, infrastructure: 6, standalone: 4,
      urls: {
        detected: 15, missing: 10,
        sources: { traefik: 13, 'published-port': 2 },
        reasons: [
          { code: 'traefik', count: 13, explain: 'built from the container’s own Traefik labels', resolved: true },
          { code: 'published-port', count: 2, explain: 'built from a published port and this host’s address', resolved: true },
          { code: 'no-route', count: 7, explain: 'no proxy route and no published port', resolved: false },
          { code: 'loopback-only', count: 2, explain: 'published only on loopback — unreachable from another machine', resolved: false },
          { code: 'override-invalid', count: 1, explain: 'the configured override is not a usable http(s) URL', resolved: false },
        ],
      },
      traefik: { routes: 14, tlsRoutes: 12, routedContainers: 13, entrypoints: ['web', 'websecure'], entrypointPorts: {} },
      hostAddress: '198.51.100.7', hostAddressSource: 'outbound-interface',
    };
    let created: { username?: string; password?: string; infrastructure?: { hostAddress?: string } } | null = null;
    h.setRoutes({
      // the fixture flips to "initialized" the moment the account exists, exactly like the server
      '/api/setup/status': () => (created
        ? { required: false, complete: true, hasAccount: true, version: '0.1.0' }
        : { required: true, complete: false, hasAccount: false, version: '0.1.0', discovery }),
      '/api/auth/me': () => (created
        ? { authenticated: true, user: { username: 'admin' }, setupComplete: true }
        : { authenticated: false, user: null, setupComplete: false }),
      '/api/setup': (body) => { created = body as typeof created; return { ok: true, user: { username: 'admin' }, authenticated: true }; },
      ...stubRoutes(),
      '/api/bookmarks': { groups: [] },
    });
    await h.mount(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    await h.waitFor(() => text().includes('Welcome'), 'the wizard');
    const advance = async (label: string) => {
      const b = qa('button').find((x) => text(x).trim() === label);
      expect(!!b, `the “${label}” button is missing`);
      click(b!);
      await h.flush(30);
    };

    await advance('Begin');
    expect(!!q('#setup-user'), 'no account step');
    type(q<HTMLInputElement>('#setup-user')!, 'admin');
    type(q<HTMLInputElement>('#setup-pass')!, 'wizard-fixture-password');
    type(q<HTMLInputElement>('#setup-pass2')!, 'wizard-fixture-password');

    await advance('Continue');
    // Environment: the engine, the API version it actually speaks, and the two knobs
    expect(text().includes('Environment'), 'the Environment step heading is missing');
    expect(text().includes('26.1.0-mock'), 'the engine version is not shown');
    expect(text().includes('v1.43'), 'the Docker API version is not shown');
    const host = q<HTMLInputElement>('#setup-host')!;
    expect(host.value === '198.51.100.7', `the detected host address was not prefilled (got ${host.value})`);
    expect(text().includes('websecure'), 'the detected entrypoints are not offered');

    await advance('Continue');
    // Discovery: counts plus *why* each container does or does not have a URL
    expect(text().includes('25'), 'the container count is missing');
    expect(text().includes('compose projects'), 'the stack count is not explained');
    expect(text().includes('no proxy route and no published port'), `the missing-URL reason is not explained: ${text().slice(0, 600)}`);
    expect(text().includes('published only on loopback'), 'the loopback reason is not explained');
    expect(text().includes('built from the container’s own Traefik labels'), 'the resolved reason is not explained');
    expect(!text().includes('jellyfin') && !text().includes('wave'), 'a container name leaked into the pre-auth wizard');

    await advance('Continue');
    // Review: the recap, then the one mutation
    expect(text().includes('Review'), 'no review step');
    expect(text().includes('admin'), 'the recap does not name the account being created');
    expect(!q('.rail'), 'the shell appeared before the account existed');
    await advance('Create account');
    const post = h.writes('POST', '/api/setup')[0];
    expect(!!post, 'the account was never created');
    expect((post.body as { username?: string }).username === 'admin', 'the wrong username was sent');
    expect(!!created, 'the fixture never saw the create call');

    // Finish: a real screen, still no application behind it
    expect(text().includes('Enter OpusHub'), 'the Finish screen is missing');
    expect(!q('.rail'), 'creating the account jumped straight into the Hub');

    // …and the hand-off is explicit
    await advance('Enter OpusHub');
    await h.waitFor(() => !!q('.rail'), 'the application shell after entering');
  });

  /* 19 — Phase 4: an initialized install asks for a password; a wrong one is reported, a right one enters */
  await test('auth gate: sign-in, wrong password, and no token kept in the browser', async (h) => {
    h.setRoutes({
      '/api/setup/status': { required: false, complete: true, hasAccount: true, version: '0.1.0' },
      '/api/auth/me': () => (signedIn
        ? { authenticated: true, user: { username: 'admin' }, setupComplete: true }
        : { authenticated: false, user: null, setupComplete: true }),
      '/api/auth/login': (body) => {
        const b = body as { username?: string; password?: string } | undefined;
        if (b?.password === 'correct-horse-battery') { signedIn = true; return { ok: true, user: { username: b.username }, authenticated: true }; }
        return { $status: 401, body: { error: 'Incorrect username or password.' } };
      },
      '/api/docker/status': { ok: true, state: 'connected', version: '26.1.0-mock' },
      '/api/providers': { providers: [] },
    });
    let signedIn = false;
    await h.mount(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    await h.waitFor(() => !!q('#login-pass'), 'the login screen');
    expect(!q('.rail'), 'the shell rendered before a session existed');

    type(q<HTMLInputElement>('#login-user')!, 'admin');
    type(q<HTMLInputElement>('#login-pass')!, 'wrong-password');
    click(q('button.auth-submit')!);
    await h.flush(120);
    expect(!!q('.auth-error'), 'the refusal is not shown');
    expect(text().includes('Incorrect username or password.'), 'the server reason is not shown');
    expect(q<HTMLInputElement>('#login-pass')!.value === '', 'the password field is not cleared after a failure');
    expect(!q('.rail'), 'a failed sign-in let the shell through');

    type(q<HTMLInputElement>('#login-user')!, 'admin');
    type(q<HTMLInputElement>('#login-pass')!, 'correct-horse-battery');
    click(q('button.auth-submit')!);
    await h.waitFor(() => !!q('.rail'), 'the application shell');
    expect(h.calls.some((c) => c.method === 'GET' && c.path === '/api/settings'), 'the shell did not load its data after sign-in');

    // nothing is kept in browser storage — the session is an HttpOnly cookie and nothing else
    expect(window.localStorage.length === 0 && window.sessionStorage.length === 0, 'a token was written to browser storage');
    const loginCall = h.lastCall('POST', '/api/auth/login');
    expect(!!loginCall && (loginCall.body as { password?: string }).password === 'correct-horse-battery', 'the password was not sent to the API');
  });

  /* 20 — Phase 4: the group-name contract (Enter commits, Escape reverts, invalid refused) */
  await test('group names: Enter commits, Escape reverts, blank and duplicates are refused', async (h) => {
    const committed: string[] = [];
    // a parent that stores the committed name — exactly what Settings does
    const Stored = ({ initial, existing = [], autoFocus = false }: { initial: string; existing?: string[]; autoFocus?: boolean }) => {
      const [name, setName] = useState(initial);
      return <GroupNameField name={name} existing={existing} ariaLabel="Group name" autoFocus={autoFocus} onCommit={(n) => { committed.push(n); setName(n); }} />;
    };
    await h.mount(<Stored initial="Media" />);
    const input = () => q<HTMLInputElement>('input.group-name')!;
    expect(input().value === 'Media', 'the field does not show the stored name');

    type(input(), 'Film');
    key(input(), 'Enter');
    await h.flush(10);
    expect(committed.join() === 'Film', `Enter did not commit the new name (got ${JSON.stringify(committed)})`);
    expect(input().value === 'Film', 'the field did not keep the committed name');

    type(input(), 'Music');
    key(input(), 'Escape');
    await h.flush(10);
    expect(committed.length === 1, 'Escape committed an abandoned edit');
    expect(input().value === 'Film', 'Escape did not restore the stored name');

    type(input(), '   ');
    key(input(), 'Enter');
    await h.flush(10);
    expect(committed.length === 1, 'a blank name was committed');
    expect(!!q('.name-note'), 'a refused name is shown without a reason');
    expect(input().getAttribute('aria-invalid') === 'true', 'the invalid state is not exposed to assistive tech');
    expect(input().value === '   ', 'the refused draft was thrown away instead of being left to fix');

    // leaving the field with invalid text restores the stored name rather than showing a phantom one
    await act(async () => { input().focus(); });
    await act(async () => { input().blur(); });
    await h.flush(10);
    expect(input().value === 'Film', 'blurring an invalid edit left the field out of sync with the stored name');
    expect(!q('.name-note'), 'the refusal reason stayed after the edit was abandoned');
    expect(committed.length === 1, 'abandoning an invalid edit committed something');

    await h.mount(<Stored initial="Film" existing={['Music']} />);
    await h.flush(5);
    type(input(), 'music');
    key(input(), 'Enter');
    await h.flush(10);
    expect(committed.length === 1, 'a duplicate name was committed');
    expect(text().includes('Music'), 'the duplicate refusal does not name the clash');

    await h.mount(<Stored initial="New group" autoFocus />);
    await h.flush(10);
    expect(document.activeElement === input(), 'a fresh group does not take focus');
  });

  /* 21 — Phase 4: the chart is a bounded region measured from its container */
  await test('charts: the drawing is clipped to its own box and follows the measured width', async (h) => {
    await h.mount(
      <div className="host">
        <AreaChart
          windowMs={15 * 60_000}
          series={[{ label: 'CPU', points: Array.from({ length: 20 }, (_, i) => ({ t: Date.now() - (20 - i) * 30_000, v: 20 + i })) }]}
          fmt={(v) => `${v.toFixed(0)}%`}
        />
      </div>,
    );
    await h.flush(30);
    const box = q('.chart')!;
    const svg = q('.chart svg')!;
    expect(box.style.height.endsWith('px'), `the chart box has no bounded height (${box.style.height})`);
    expect(Number(svg.getAttribute('height')) === Number(box.style.height.replace('px', '')), 'the SVG height and its box disagree, so the drawing would scale past its region');
    expect(svg.getAttribute('preserveAspectRatio') === 'none', 'the SVG is free to letterbox/scale itself');
    expect(Number(svg.getAttribute('width')) > 0, 'the SVG has no explicit width');

    // measurement: the container reports a new width, the observer fires, geometry follows
    const instances = (globalThis as { __resizeObservers?: { cb: () => void; el?: Element }[] }).__resizeObservers;
    expect(Array.isArray(instances) && instances.length > 0, 'the chart did not observe its container at all');
    const target = instances![instances!.length - 1];
    target.el!.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 880, bottom: 148, width: 880, height: 148, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(target.el!, 'clientWidth', { value: 880, configurable: true });
    await act(async () => { target.cb(); });
    await h.flush(20);
    const after = q('.chart svg')!;
    expect(after.getAttribute('viewBox') === `0 0 880 ${after.getAttribute('height')}`, `the chart did not adopt the measured width (${after.getAttribute('viewBox')})`);
  });

  /* 22 — Phase 4: renaming a group through the Settings pane persists the rename */
  await test('settings: a renamed group is written on save and survives the round trip', async (h) => {
    await h.mount(<TestApp entry="/settings/groups"><Settings /></TestApp>);
    await h.waitFor(() => !!q('.group-rows'), 'the group rows');
    const row = qa('.group-row').find((r) => q<HTMLInputElement>('input.group-name', r)?.value === 'Media');
    expect(row, 'the fixture group row is missing');
    const input = q<HTMLInputElement>('input.group-name', row!)!;
    type(input, 'Movies');
    key(input, 'Enter');
    await h.flush(20);
    expect(input.value === 'Movies', 'the renamed group did not keep its new name in the pane');
    expect(text().includes('unsaved changes'), 'the pane did not mark the rename as unsaved');

    const saveBtn = qa('button').find((b) => text(b).trim() === 'Save groups');
    expect(saveBtn && !(saveBtn as HTMLButtonElement).disabled, 'the save button is not enabled after a rename');
    click(saveBtn!);
    await h.waitFor(() => !!h.lastCall('PUT', '/api/services'), 'the save');
    const body = h.lastCall('PUT', '/api/services')!.body as { groups: { name: string; services?: { group?: string }[] }[] };
    expect(body.groups.some((g) => g.name === 'Movies'), 'the saved document does not contain the new name');
    expect(!body.groups.some((g) => g.name === 'Media'), 'the old name is still in the saved document');
    await h.waitFor(() => !text().includes('unsaved changes'), 'the dirty flag to clear');
  });

  /* 23 — Phase 4: the “…” menu is anchored to its trigger, inside the viewport, and keyboard-safe */
  await test('anchored menu: placed against the trigger, flipped, clamped, and closed by Escape', async (h) => {
    const hidden: string[] = [];
    await h.mount(
      <MenuButton
        label="Media group options"
        title="Options for Media"
        items={[
          { label: 'Hide from Hub', action: () => hidden.push('hide') },
          { label: 'Open in Directory', href: '/services' },
        ]}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2" /></svg>
      </MenuButton>,
    );
    await h.flush(20);
    const trigger = q<HTMLButtonElement>('[aria-haspopup]')!;
    expect(!!trigger, 'the trigger did not render');
    expect(trigger.getAttribute('aria-expanded') === 'false', 'the trigger does not report its closed state');
    expect(!q('[role="menu"]'), 'the menu should start closed');

    const rect = (r: Partial<DOMRect>) => () => ({
      x: r.left ?? 0, y: r.top ?? 0, left: r.left ?? 0, top: r.top ?? 0,
      right: (r.left ?? 0) + (r.width ?? 0), bottom: (r.top ?? 0) + (r.height ?? 0),
      width: r.width ?? 0, height: r.height ?? 0, toJSON: () => ({}),
    }) as DOMRect;

    click(trigger);
    await h.flush(20);
    const menu = q('[role="menu"]')!;
    expect(!!menu, 'clicking the trigger did not open the menu');
    expect(trigger.getAttribute('aria-expanded') === 'true', 'the trigger does not report its open state');
    // portaled to the body: a fixed-position menu inside a transformed/filtered ancestor would be
    // positioned against that ancestor — the original clipping bug
    expect(menu.parentElement === document.body, 'the menu is not portaled to the document body');
    expect(!h.container.contains(menu), 'the menu was rendered inside the widget, where it can be clipped');
    expect(menu.getAttribute('data-anchored') === 'true', 'the menu does not know it is anchored');
    expect(document.activeElement?.getAttribute('role') === 'menuitem', 'opening the menu did not focus its first item');

    // the trigger sits in the lower-middle of a 1024×768 viewport, the menu is 200×120
    trigger.getBoundingClientRect = rect({ left: 900, top: 400, width: 60, height: 30 });
    menu.getBoundingClientRect = rect({ width: 200, height: 120 });
    await act(async () => { window.dispatchEvent(new window.Event('resize')); });
    await h.flush(20);
    const style = menu.getAttribute('style') || '';
    const left = Number(/left:\s*([-\d.]+)px/.exec(style)?.[1]);
    const top = Number(/top:\s*([-\d.]+)px/.exec(style)?.[1]);
    expect(left === 760, `the menu is not right-aligned to its trigger (left ${left})`);
    expect(top === 436, `the menu is not placed under its trigger (top ${top})`);

    // near the bottom edge: flip above the trigger rather than overflow the viewport
    trigger.getBoundingClientRect = rect({ left: 900, top: 700, width: 60, height: 30 });
    await act(async () => { window.dispatchEvent(new window.Event('resize')); });
    await h.flush(20);
    const top2 = Number(/top:\s*([-\d.]+)px/.exec(menu.getAttribute('style') || '')?.[1]);
    expect(top2 === 574, `the menu did not flip above the trigger (top ${top2})`);

    // hard against the left edge: clamped inside the window, never negative
    trigger.getBoundingClientRect = rect({ left: 10, top: 300, width: 50, height: 30 });
    await act(async () => { window.dispatchEvent(new window.Event('resize')); });
    await h.flush(20);
    const style3 = menu.getAttribute('style') || '';
    const left3 = Number(/left:\s*([-\d.]+)px/.exec(style3)?.[1]);
    const top3 = Number(/top:\s*([-\d.]+)px/.exec(style3)?.[1]);
    expect(left3 === 8, `the menu is not clamped to the viewport gutter (left ${left3})`);
    expect(top3 === 336, `the menu lost its vertical anchor (top ${top3})`);

    // keyboard: Escape closes and returns focus to the trigger that owns the menu
    key(window, 'Escape');
    await h.flush(20);
    expect(!q('[role="menu"]'), 'Escape did not close the menu');
    expect(document.activeElement === trigger, 'focus was not restored to the trigger');
    expect(trigger.getAttribute('aria-expanded') === 'false', 'the trigger still reports itself as open');

    // clicking elsewhere closes it too, and an item click runs its action
    click(trigger);
    await h.flush(20);
    expect(!!q('[role="menu"]'), 'the menu did not reopen');
    await act(async () => { document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); });
    await h.flush(20);
    expect(!q('[role="menu"]'), 'a click outside did not close the menu');
    click(trigger);
    await h.flush(20);
    const hideItem = qa('[role="menuitem"]').find((el) => text(el).includes('Hide from Hub'))!;
    click(hideItem);
    await h.flush(20);
    expect(hidden.join() === 'hide', 'the menu item did not run its action');
    expect(!q('[role="menu"]'), 'choosing an item left the menu open');
  });

  /* 24 — Phase 4: bookmark groups get the same naming contract, and the save guard speaks inline */
  await test('bookmark groups: renamed in place, added with a unique name, refusal shown inline', async (h) => {
    await h.mount(<TestApp entry="/settings/bookmarks"><Settings /></TestApp>);
    await h.waitFor(() => !!q('.input.group-name-heading'), 'the bookmark group heading');
    const headings = () => qa<HTMLInputElement>('input.group-name-heading');
    const saveBtn = () => qa('button').find((b) => text(b).startsWith('Save bookmarks')) as HTMLButtonElement;
    expect(headings()[0].value === 'Reading', 'the fixture bookmark group is missing');

    type(headings()[0], 'Later');
    key(headings()[0], 'Enter');
    await h.flush(20);
    expect(headings()[0].value === 'Later', 'Enter did not commit the bookmark group name');
    expect(!saveBtn().disabled, 'the rename did not mark the pane as having unsaved changes');

    // a new group gets a name nobody else has, and takes focus so it can be named immediately
    click(qa('button').find((b) => text(b).trim() === '+ New group')!);
    await h.flush(20);
    expect(headings().length === 2, `expected 2 bookmark groups, saw ${headings().length}`);
    expect(headings()[1].value === 'New group', `the new group was named ${headings()[1].value}`);
    expect(document.activeElement === headings()[1], 'the new group did not take focus, so it cannot be named');

    // a duplicate is refused by name, and nothing is written
    type(headings()[1], 'later');
    key(headings()[1], 'Enter');
    await h.flush(20);
    expect(text().includes('already uses that name'), 'a duplicate bookmark group name was accepted');
    expect(headings()[1].value === 'later', 'the refused draft was thrown away instead of being left to fix');
    key(headings()[1], 'Escape');
    await h.flush(20);
    expect(headings()[1].value === 'New group', 'Escape did not restore the stored group name');

    // renaming it properly and saving writes the document
    type(headings()[1], 'Watch list');
    key(headings()[1], 'Enter');
    await h.flush(20);
    click(saveBtn());
    await h.waitFor(() => !!h.lastCall('PUT', '/api/bookmarks'), 'the bookmark save');
    const body = h.lastCall('PUT', '/api/bookmarks')!.body as { groups: { name: string }[] };
    expect(body.groups.map((g) => g.name).join() === 'Later,Watch list', `saved groups: ${JSON.stringify(body.groups.map((g) => g.name))}`);
    await h.waitFor(() => saveBtn().disabled, 'the pane to leave its dirty state');
  });

  /* 25 — Phase 4: a document that already contains duplicate names cannot be saved silently */
  await test('bookmark groups: a document with duplicate names is refused inline, without a browser alert', async (h) => {
    h.setRoutes({
      ...stubRoutes(),
      '/api/bookmarks': { groups: [{ name: 'Reading', items: [] }, { name: 'reading', items: [] }] },
    });
    let alerted = false;
    const realAlert = window.alert;
    window.alert = () => { alerted = true; };
    try {
      await h.mount(<TestApp entry="/settings/bookmarks"><Settings /></TestApp>);
      await h.waitFor(() => qa('.input.group-name-heading').length === 2, 'both bookmark groups');
      // an edit has to exist before there is anything to save at all
      click(qa('button').find((b) => text(b).trim() === '+ link')!);
      await h.flush(20);
      click(qa('button').find((b) => text(b).startsWith('Save bookmarks'))!);
      await h.flush(40);
      expect(!h.lastCall('PUT', '/api/bookmarks'), 'a document with two identically named groups was saved');
      const note = q('.name-note');
      expect(!!note && note.getAttribute('role') === 'alert', 'the refusal is not shown inline');
      expect(/reading/i.test(text(note!)), `the refusal does not name the clash: ${text(note!)}`);
      expect(!alerted, 'the guard used a browser alert instead of the design system');
    } finally {
      window.alert = realAlert;
    }
  });

  /* 26 — the background URL is verified server-side before it is stored */
  await test('background: an Unsplash page resolves to a direct URL; a web page is refused in place', async (h) => {
    const photoSettings = structuredClone(settings);
    photoSettings.appearance.background = { mode: 'photo' as const, photo: null, blur: 24, scrim: 62 };
    let storedPhoto: string | null = null;
    h.setRoutes({
      ...stubRoutes(),
      '/api/settings': (body) => {
        const b = (body || {}) as { appearance?: { background?: { photo?: string | null } } };
        if (b?.appearance?.background && 'photo' in b.appearance.background) storedPhoto = b.appearance.background.photo ?? null;
        const cur = structuredClone(photoSettings);
        cur.appearance.background.photo = storedPhoto;
        return cur;
      },
      '/api/backgrounds': { files: [] },
      '/api/background/check': (_b, p) => {
        const url = decodeURIComponent(String(p).split('url=')[1] || '');
        if (url.startsWith('https://unsplash.com/photos/')) {
          return { ok: true, url: 'https://images.unsplash.com/photo-1465189684280-6a8fa9b19a7a?ixlib=rb-4.1.0', kind: 'unsplash' };
        }
        if (/\.(jpe?g|png|webp|avif|svg)$/i.test(url)) return { ok: true, url, kind: 'direct' };
        return { ok: false, error: 'That URL serves a web page, not an image. Paste a direct link to an image file, or an Unsplash photo page.' };
      },
    });
    await h.mount(<TestApp entry="/settings/background"><Settings /></TestApp>);
    await h.waitFor(() => !!q('#bgurl'), 'the background URL field');

    // the pasted Unsplash page → the check runs first, then the RESOLVED direct URL is what saves
    let input = q<HTMLInputElement>('#bgurl')!;
    type(input, 'https://unsplash.com/photos/body-of-water-surrounding-with-trees-_LuLiJc1cdo');
    key(input, 'Enter');
    await h.flush(40);
    const checkCall = h.calls.find((c) => c.method === 'GET' && c.path.startsWith('/api/background/check'));
    expect(!!checkCall, 'the URL was not verified before saving');
    expect(checkCall!.path.includes('body-of-water-surrounding-with-trees-_LuLiJc1cdo'), 'the pasted URL was not sent to the checker');
    await h.waitFor(() => storedPhoto !== null, 'the settings write with the resolved URL');
    expect(storedPhoto === 'https://images.unsplash.com/photo-1465189684280-6a8fa9b19a7a?ixlib=rb-4.1.0',
      `the stored value is not the resolved direct image (got ${storedPhoto})`);
    expect(text().includes('Resolved to a direct image'), 'the resolution outcome is not shown');
    expect(q('.bg-tile--url'), 'the pasted URL has no visible preview tile');
    // the field now shows the canonical value the server stored
    input = q<HTMLInputElement>('#bgurl')!;
    expect(input.value.startsWith('https://images.unsplash.com/'), `the field shows ${input.value}, expected the resolved URL`);

    // a web-page URL → refused in place with the reason, and nothing is written
    const putsBefore = h.writes('PUT', '/api/settings').length;
    type(input, 'https://public-cdn.example/some-page');
    key(input, 'Enter');
    await h.waitFor(() => !!q('.bg-url-state--err'), 'the refusal beside the field');
    expect(text().includes('web page, not an image'), 'the refusal does not explain why');
    expect(h.writes('PUT', '/api/settings').length === putsBefore, 'a refused URL was saved anyway');
    expect(input.value === 'https://public-cdn.example/some-page', 'the refused draft was thrown away instead of left to fix');

    // “None” resets to no background
    const noneTile = qa('.bg-tile button, button.bg-tile').find((t) => text(t).trim() === 'None');
    expect(!!noneTile, 'the None tile is missing');
    click(noneTile!);
    await h.waitFor(() => storedPhoto === null, 'the reset to no background');
  });

  /* 27 — the background layer itself degrades: a dead image drops out, the Hub keeps rendering */
  await test('background: a broken remote image falls back to the base background', async (h) => {
    const { BackgroundImage } = await import('../../src/components/BackgroundImage');
    await h.mount(<div className="bg-layer bg-photo" style={{ position: 'relative' }}><BackgroundImage url="https://dead.example/photo.jpg" /></div>);
    await h.flush(20);
    expect(!!q('.bg-img'), 'the background layer did not render');
    const img = q('.bg-img img')!;
    expect(!!img, 'no hidden probe image — the failure could never be detected');
    await act(async () => { img.dispatchEvent(new window.Event('error')); });
    await h.flush(20);
    expect(!q('.bg-img'), 'a dead image left the layer in place instead of falling back');
  });

  /* 28 — market symbols: provider syntax stays in the provider, not the user */
  await test('markets: a non-symbol is refused in the field, valid entries are normalized and saved', async (h) => {
    await h.mount(<TestApp entry="/settings/integrations"><Settings /></TestApp>);
    await h.waitFor(() => !!q('[aria-label="Add symbol"]'), 'the symbol field');
    const input = () => q<HTMLInputElement>('[aria-label="Add symbol"]')!;
    const symbolWrites = () => h.writes('PUT', '/api/settings').filter((c) => (c.body as { integrations?: { markets?: { symbols?: string[] } } })?.integrations?.markets?.symbols);

    // a URL is not a symbol: refused inline, and nothing is saved
    type(input(), 'https://evil.example/aapl');
    key(input(), 'Enter');
    await h.flush(40);
    expect(text().includes('✗'), 'the refusal is not shown');
    expect(/letters\/digits with \. \^ - = only/i.test(text()), `the refusal does not state the rule: ${text().slice(0, 300)}`);
    expect(symbolWrites().length === 0, 'an invalid symbol was saved');
    expect(input().value === 'https://evil.example/aapl', 'the refused draft was thrown away instead of left to fix');

    // valid mixed entries are normalized (case, .US migration) and de-duplicated
    type(input(), 'aapl, btc-usd, MSFT.us');
    key(input(), 'Enter');
    await h.waitFor(() => symbolWrites().length > 0, 'the symbol write');
    const put = symbolWrites()[symbolWrites().length - 1];
    expect((put.body as { integrations: { markets: { symbols: string[] } } }).integrations.markets.symbols.join() === 'AAPL,BTC-USD,MSFT',
      `symbols were not normalized (got ${JSON.stringify((put.body as { integrations: { markets: { symbols: string[] } } }).integrations.markets.symbols)})`);
    expect(input().value === '', 'the field was not cleared after a successful add');
  });

  /* 30 — Phase 5: the Authentication pane changes the password and audits sessions */
  await test('settings: Authentication lists sessions, changes the password, and shows no credential', async (h) => {
    const sessionsDoc = {
      count: 2,
      limits: { absoluteMs: 30 * 24 * 3600_000, idleMs: 7 * 24 * 3600_000, max: 50 },
      current: { id: 'aaaabbbbccccdddd', createdAt: Date.now() - 60_000, lastSeenAt: Date.now() - 1000, expiresAt: Date.now() + 1000, idleExpiresAt: Date.now() + 2000, ip: '192.0.2.5', current: true },
      sessions: [
        { id: 'aaaabbbbccccdddd', createdAt: Date.now() - 60_000, lastSeenAt: Date.now() - 1000, expiresAt: Date.now() + 86_400_000, idleExpiresAt: Date.now() + 86_400_000, ip: '192.0.2.5', current: true },
        { id: 'eeeeffff00001111', createdAt: Date.now() - 900_000, lastSeenAt: Date.now() - 500_000, expiresAt: Date.now() + 86_400_000, idleExpiresAt: Date.now() + 86_400_000, ip: '198.51.100.9', current: false },
      ],
    };
    h.setRoutes({
      '/api/setup/status': { required: false, complete: true, hasAccount: true, version: '0.1.0' },
      '/api/auth/me': { authenticated: true, user: { username: 'admin' }, setupComplete: true },
      '/api/auth/sessions': sessionsDoc,
      '/api/auth/password': { $status: 401, body: { error: 'The current password is incorrect.', code: 'invalid_password' } },
      '/api/settings': settings,
      '/api/layout': layout,
    });
    await h.mount(
      <MemoryRouter initialEntries={['/settings/authentication']}>
        <AuthProvider>
          <SettingsProvider>
            <LayoutProvider>
              <Routes><Route path="/settings/:tab" element={<Settings />} /></Routes>
            </LayoutProvider>
          </SettingsProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    await h.waitFor(() => text().includes('Signed-in sessions'), 'the sessions block');
    expect(h.calls.some((c) => c.path === '/api/auth/sessions'), 'the pane never asked for the session list');
    expect(text().includes('This browser') && text().includes('Another browser'), 'the two sessions are not distinguished');
    expect(text().includes('handle aaaabbbbccccdddd'), 'the derived handle is not shown');
    expect(!text().includes('scrypt$') && !text().includes('passwordHash'), 'credential material reached the page');

    // a wrong current password is reported inline, in the server's own words, without wiping the form
    type(q<HTMLInputElement>('#pw-current')!, 'definitely-wrong');
    type(q<HTMLInputElement>('#pw-new')!, 'a-much-longer-new-one');
    type(q<HTMLInputElement>('#pw-confirm')!, 'a-much-longer-new-one');
    click(qa('button').find((b) => text(b).includes('Change password'))!);
    await h.waitFor(() => /current password is incorrect/i.test(text()), 'the refusal message');
    const attempt = h.writes('POST', '/api/auth/password')[0];
    expect(!!attempt, 'no password request was sent');
    expect(attempt.body && (attempt.body as { newPassword?: string }).newPassword === 'a-much-longer-new-one', 'the request body is wrong');
    expect(q<HTMLInputElement>('#pw-new')!.value === 'a-much-longer-new-one', 'a failed attempt cleared the fields');

    // local validation runs before the network: mismatched confirmation never reaches the server
    const before = h.writes('POST', '/api/auth/password').length;
    type(q<HTMLInputElement>('#pw-confirm')!, 'something-else-entirely');
    click(qa('button').find((b) => text(b).includes('Change password'))!);
    await h.flush(30);
    expect(h.writes('POST', '/api/auth/password').length === before, 'a mismatched confirmation was still sent');
    expect(/do not match/i.test(text()), 'the mismatch is not explained');
  });

  /* 31 — Phase 5: General is where the install names itself, and the name is actually written */
  await test('settings: General writes the install name to settings.yaml', async (h) => {
    h.setRoutes({ ...stubRoutes() });
    await h.mount(<TestApp entry="/settings/general"><Settings /></TestApp>);
    await h.waitFor(() => !!q('[aria-label="App name"]'), 'the name field');
    const field = q<HTMLInputElement>('[aria-label="App name"]')!;
    expect(field.value === 'OpusHub', `the saved name is not shown (got ${field.value})`);
    act(() => { field.focus(); });
    type(field, 'Grid Control');
    act(() => { field.blur(); });
    await h.waitFor(() => h.writes('PUT', '/api/settings').length > 0, 'the settings write');
    const put = h.writes('PUT', '/api/settings').pop()!;
    expect((put.body as { app?: { name?: string } }).app?.name === 'Grid Control', `the name was not written (${JSON.stringify(put.body)})`);
  });

  for (const r of results) {
    if (r.ok) { passed++; console.log(`✓ ${r.name}`); }
    else { failures.push(`${r.name}: ${r.detail}`); console.error(`✗ ${r.name} — ${r.detail}`); }
  }
  return { passed, failed: failures.length, failures };
}
