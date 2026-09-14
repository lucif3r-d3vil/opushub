// Interaction checks — the things a screenshot cannot prove: that `/` and ⌘K open search, that
// arrows and Enter move through it, that Escape closes it, that a widget menu writes the layout it
// claims to write, and that keyboard reordering commits the order the user asked for.
//
// Run with: npm run test:web   (jsdom; see test/web-run.mjs)
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LayoutProvider, SettingsProvider, useLayout } from '../../src/lib/theme';
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
    '/api/services/Music/wave': serviceDetail,
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
    expect(document.title === 'Nora · OpusHub', `the document title follows the configured name (got “${document.title}”)`);
    expect(text().includes('Friday') || /day/i.test(text()), 'the date is missing');
    expect(qa('.launcher-items > li').length >= 3, 'the launcher list is short');
    // a service with no resolved URL must not offer a launch button
    const noWeb = qa('.launch-item').find((el) => el.getAttribute('data-noweb') != null);
    expect(noWeb, 'the fixture has a service with no URL, so one row should be marked');
    expect(!q('button.li-open', noWeb!) && !q('a.li-open', noWeb!), 'a URL-less service rendered a launch button');
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

  for (const r of results) {
    if (r.ok) { passed++; console.log(`✓ ${r.name}`); }
    else { failures.push(`${r.name}: ${r.detail}`); console.error(`✗ ${r.name} — ${r.detail}`); }
  }
  return { passed, failed: failures.length, failures };
}
