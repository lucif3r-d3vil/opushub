// FIXTURE DATA — for the render harness (src/ssr-hub.tsx) only.
//
// These objects mirror the shape of the real API responses exactly (same field names as
// src/lib/types.ts) so the Hub is exercised against realistic payloads without an engine to talk
// to. They are never imported by the application, never served, and contain no measurement
// presented as real: every value is obviously a fixture.
import type {
  ActivityEvent, LayoutDoc, NewsDoc, ProvidersDoc, ServicesDoc, StacksDoc, SystemSnapshot, WeatherDoc, WidgetCatalogueEntry, WidgetInstance,
} from './lib/types';
import type { BookmarkDoc, HubData } from './lib/hubData';

export type { BookmarkDoc, HubData };

const container = (name: string, extra: Partial<ServicesDoc['services'] extends (infer S)[] | undefined ? S : never> = {}) => ({
  name,
  id: `fixture${name.slice(0, 5)}`,
  image: `ghcr.io/example/${name}:1.0`,
  state: 'running',
  status: 'Up 3 days',
  health: null,
  created: 1_700_000_000,
  restartCount: 0,
  composeProject: 'media',
  composeService: name,
  networks: [{ name: 'media_default', ip: '172.20.0.4' }],
  ports: [{ ip: '0.0.0.0', private: 8096, public: 8096, type: 'tcp' }],
  labels: { compose: { project: 'media', service: name, version: null }, proxy: null, overlay: null },
  ...extra,
});

const service = (name: string, display: string, extra: Record<string, unknown> = {}): ServicesDoc['services'] extends (infer S)[] | undefined ? S : never => ({
  name,
  displayName: display,
  slug: name,
  id: `fixture${name.slice(0, 5)}`,
  app: null,
  description: 'Fixture description',
  url: `http://fixture.local/${name}`,
  urlSource: 'traefik',
  urlNote: 'fixture router',
  icon: null,
  iconSource: 'none',
  group: 'Media',
  groupSource: 'compose project',
  keywords: [],
  meta: [],
  hidden: false,
  showOnHub: true,
  order: null,
  configured: false,
  discovered: true,
  overlaid: null,
  kind: 'application',
  kindSource: 'no infrastructure signal',
  status: 'up',
  statusReason: null,
  stack: 'media',
  stackDisplayName: 'Media',
  container: container(name),
  ...extra,
} as never);

const wave = service('wave', 'Wave');
const photos = service('photos', 'Photos', { url: null, urlSource: 'none', urlNote: 'no published port, no router rule', description: null });
const sync = service('sync', 'Sync', { url: null, urlSource: 'none', urlNote: 'no published port' });
const db = service('db', 'Database', { kind: 'infrastructure', kindSource: 'name/service signal', group: 'Rails' });

export const servicesDoc: ServicesDoc = {
  // The real API puts the same objects in `services` and in `groups[].services`.
  groups: [{ name: 'Media', description: 'Streams and requests', services: [wave, photos, sync] }],
  services: [wave, photos, sync, db],
  infrastructure: [db],
  skipped: [],
  unmatched: [],
  live: true,
  statusSource: 'docker',
  statusReason: null,
  discoveredAt: Date.now(),
  stats: {
    containers: 4, running: 4, stopped: 0, applications: 3, infrastructure: 1,
    urlSources: { traefik: 1, none: 2 }, withUrl: 1, configured: 0, discovered: 4, stacks: 1, standalone: 0,
  },
};

export const stacksDoc: StacksDoc = {
  stacks: [{
    id: 'media', project: 'media', name: 'Media', displayName: 'Media', description: 'Fixture stack',
    icon: null, notes: null, compose: null, source: 'discovered', configured: false, status: 'operational',
    statusReason: null, containerCount: 1, runningCount: 1, services: ['media'],
    members: [{
      service: 'media', name: 'Media', containerName: 'wave', group: 'Media', icon: null,
      url: 'http://fixture.local/wave', urlSource: 'traefik', kind: 'application', configured: false,
      route: null, container: { name: 'wave', id: 'fixturewave', state: 'running', status: 'Up 3 days', health: null, image: 'ghcr.io/example/wave:1.0' },
    }],
  }],
  live: true,
  statusReason: null,
  standalone: [],
  unmatched: [],
};

export const systemSnapshot: SystemSnapshot = {
  at: Date.now(),
  host: { hostname: 'fixture-host', os: 'Fixture Linux', kernel: '6.1.0', arch: 'x64', node: 'v22', uptimeSec: 6 * 86400 + 3600, bootAt: null, model: null },
  cpu: { usage: 12.4, perCore: [{ id: 0, usage: 12.4 }], cores: 2, model: 'Fixture CPU', mhz: 2600, load1: 0.42, load5: 0.5, load15: 0.6, temperature: [{ zone: 'acpitz', label: 'board', celsius: 41 }] },
  memory: { total: 4_000_000_000, available: 2_400_000_000, free: 1_000_000_000, buffers: 100, cached: 500, swapTotal: 0, swapFree: 0 },
  disks: [{ mount: '/', device: '/dev/sda1', fs: 'ext4', total: 21_000_000_000, used: 4_000_000_000, free: 17_000_000_000 }],
  network: [{ name: 'eth0', rxBytes: 1, txBytes: 2, rxPerSec: 12_000, txPerSec: 4_000, mbps: null, ips: ['192.0.2.10'], rxErrors: 0, txErrors: 0 }],
  processes: 128,
  gpu: { present: false },
};

export const activityDoc: { items: ActivityEvent[] } = {
  items: [
    { id: 'fixture-1', t: Date.now() - 60_000, iso: new Date().toISOString(), source: 'docker', type: 'container.started', subject: 'wave', message: 'running' },
    { id: 'fixture-2', t: Date.now() - 600_000, iso: new Date().toISOString(), source: 'config', type: 'layout.updated', subject: 'layout.json', message: 'hub order' },
  ],
};

export const bookmarksDoc: BookmarkDoc = {
  groups: [{ name: 'Reading', items: [{ name: 'Hacker News', href: 'https://news.ycombinator.com', description: 'Front page' }] }],
};

export const weatherDoc: WeatherDoc = {
  status: 'ok',
  place: 'Fixtureville',
  units: 'c',
  current: { tempC: 18.4, feelsC: 17.2, humidity: 61, windKph: 9, precipMm: 0, code: 2, label: 'Partly cloudy', icon: 'cloud-sun', isDay: true },
  today: { highC: 21, lowC: 11, sunrise: null, sunset: null, precipChance: 10 },
  forecast: [
    { date: '2026-09-12', label: 'Sat', code: 2, highC: 21, lowC: 11, precipChance: 10 },
    { date: '2026-09-13', label: 'Sun', code: 3, highC: 19, lowC: 10, precipChance: 20 },
  ],
};

export const newsDoc: NewsDoc = {
  status: 'ok',
  items: [
    { title: 'Something happened', link: 'https://example.com/a', source: 'Fixture Wire', publishedAt: new Date(Date.now() - 3600_000).toISOString(), summary: null, image: null },
    { title: 'Then something else', link: 'https://example.com/b', source: 'Fixture Wire', publishedAt: new Date(Date.now() - 7200_000).toISOString(), summary: null, image: null },
  ],
  fetchedAt: Date.now(),
};

export const marketDoc = {
  status: 'ok' as const,
  items: [{ symbol: 'AAPL', status: 'ok', price: 231.4, change: 1.2, changePct: 0.52, spark: [1, 2, 3, 2.6, 3.4] }],
};

export const providersDoc: ProvidersDoc = {
  at: Date.now(),
  providers: [
    { name: 'docker', state: 'available' as const, lastOk: Date.now() - 5000, lastTry: Date.now() - 5000, staleMs: 5000, reason: null },
    { name: 'system', state: 'available' as const, lastOk: Date.now() - 5000, lastTry: Date.now() - 5000, staleMs: 5000, reason: null },
    { name: 'news', state: 'available' as const, lastOk: Date.now() - 60_000, lastTry: Date.now() - 60_000, staleMs: 60_000, reason: null },
    { name: 'weather', state: 'idle' as const, lastOk: null, lastTry: null, staleMs: null, reason: null },
    { name: 'markets', state: 'idle' as const, lastOk: null, lastTry: null, staleMs: null, reason: null },
  ],
};

/** Mirrors server/widgets.js for the harness (test/layout.test.js owns the real catalogue). */
export const catalogue: WidgetCatalogueEntry[] = [
  { type: 'services', title: 'Services', description: 'The launcher', zone: 'main', size: 'lg', sizes: ['sm', 'md', 'lg'], config: [{ key: 'groups', label: 'Groups', type: 'group-list' }] },
  { type: 'system', title: 'System', description: 'Host summary', zone: 'main', size: 'md', sizes: ['sm', 'md', 'lg'], config: [] },
  { type: 'stacks', title: 'Stacks', description: 'Compose projects', zone: 'main', size: 'md', sizes: ['sm', 'md'], config: [] },
  { type: 'attention', title: 'Needs attention', description: 'Not running', zone: 'main', size: 'sm', sizes: ['sm', 'md'], config: [] },
  { type: 'clock', title: 'Clock', description: 'Time and date', zone: 'rail', size: 'sm', sizes: ['sm', 'md'], config: [] },
  { type: 'weather', title: 'Weather', description: 'Current conditions', zone: 'rail', size: 'md', sizes: ['sm', 'md'], config: [] },
  { type: 'news', title: 'News', description: 'Headlines', zone: 'rail', size: 'md', sizes: ['sm', 'md', 'lg'], config: [] },
  { type: 'markets', title: 'Markets', description: 'Watchlist', zone: 'rail', size: 'md', sizes: ['sm', 'md', 'lg'], config: [] },
  { type: 'bookmarks', title: 'Bookmarks', description: 'Your links', zone: 'rail', size: 'sm', sizes: ['sm', 'md', 'lg'], config: [{ key: 'group', label: 'Only this group', type: 'text' }] },
  { type: 'activity', title: 'Activity', description: 'What happened', zone: 'rail', size: 'md', sizes: ['sm', 'md', 'lg'], config: [{ key: 'sources', label: 'Sources', type: 'list', options: ['docker', 'config', 'user', 'system'] }] },
];

export function layoutWith(widgets: WidgetInstance[]): LayoutDoc {
  return {
    version: 2,
    hub: { widgets, spacing: 'comfortable', setupDismissed: true },
    services: { groupOrder: null, order: {}, hiddenGroups: [] },
  };
}
