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
import SystemPage from '../../src/pages/System';
import ActivityPage from '../../src/pages/Activity';
import InfrastructurePage from '../../src/pages/Infrastructure';
import MonitoringPage from '../../src/pages/Monitoring';
import MonitorDetailPage from '../../src/pages/MonitorDetail';
import { Loading } from '../../src/components/ui';
import { GREETINGS, greetingFor } from '../../src/components/hub/HubHeader';
import type { LayoutDoc, Monitor, UptimeWindow, WidgetInstance } from '../../src/lib/types';
import type { HubData } from '../../src/lib/hubData';
import App from '../../src/App';
import { GroupNameField } from '../../src/components/GroupNameField';
import { MenuButton } from '../../src/components/ui';
import { AreaChart } from '../../src/components/Charts';
import { createHarness, click, key, q, qa, text, type, type Harness } from './harness';
import { OperationsHost } from '../../src/components/Operations';
import { NotificationBell } from '../../src/components/Notifications';
import { safeHref } from '../../src/lib/notifications';
import { __emitLiveEventForTests, __setLiveStatusForTests } from '../../src/lib/sse';
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
const stackDetail = {
  ...stacksDoc.stacks[0], live: true, statusReason: null,
  rollup: {
    containers: 3, running: 3, stopped: 0, unhealthy: 1, reporting: 2,
    cpu: 21.4, memory: 512_000_000, memoryLimit: 2_000_000_000,
    netRx: 4_500_000, netTx: 900_000, upSince: Date.now() - 6 * 3600_000,
  },
};
const stackHistory = {
  stack: 'media', containers: 2, reporting: 2, watchingSince: Date.now() - 8 * 60_000, bucketMs: 2000,
  samples: [
    { t: Date.now() - 15_000, cpu: 18.0, mem: 500_000_000, memLimit: 2_000_000_000, netRx: 4_000_000, netTx: 800_000, count: 2 },
    { t: Date.now() - 10_000, cpu: 20.2, mem: 505_000_000, memLimit: 2_000_000_000, netRx: 4_200_000, netTx: 850_000, count: 2 },
    { t: Date.now() - 5_000, cpu: 21.4, mem: 512_000_000, memLimit: 2_000_000_000, netRx: 4_500_000, netTx: 900_000, count: 2 },
  ],
};
const noWebService = servicesDoc.services.find((s) => s.url == null)!;
const noWebDetail = { ...serviceDetail, service: noWebService, url: null, urlSource: 'none', container: null };

const searchResults = (query: string) => ({
  results: query.includes('nav')
    ? [{ title: 'Navidrome', subtitle: 'Music · running', kind: 'service', href: '/services/Music/navidrome', icon: null, status: 'up' }]
    : query.includes('stream')
      ? [
        { title: 'Stream', subtitle: 'Media · running', kind: 'service', href: '/services/Media/stream', icon: null, status: 'up' },
        { title: 'stream', subtitle: 'Activity · started · 2h ago', kind: 'activity', href: '/activity?service=stream' },
      ]
      : query.includes('unhealthy')
      ? [
        { title: 'Wave is unhealthy', subtitle: 'Alert · warning — Its container healthcheck is failing.', kind: 'alert', href: '/services/Music/wave', status: 'degraded' },
        { title: 'proxy', subtitle: 'Network · bridge · 2 attached', kind: 'infra', href: '/infrastructure?tab=networks' },
      ]
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

/* Phase 7 fixtures: the infrastructure inventory, in the shapes the API serves. */
const hostDoc = {
  at: Date.now(),
  host: { hostname: 'opusgrid', os: 'Debian GNU/Linux 13 (trixie)', kernel: '6.1.0-1-amd64', arch: 'x64', model: null, uptimeSec: 86400 * 4 + 43200, bootAt: null },
  cpu: { model: 'Intel N100', cores: 4, threads: 4, mhz: 1800 },
  memory: { total: 8_000_000_000 },
  docker: { status: 'connected', available: true, version: '26.1.0', apiVersion: '1.43', os: 'linux', arch: 'amd64', driver: 'overlay2', containers: 3, running: 2, stopped: 1, paused: 0 },
  address: { configured: null, detected: '198.51.100.20', effective: '198.51.100.20', source: 'outbound-interface' },
  traefik: { detected: true, source: 'container-labels', routedContainers: 2, routers: 3, tlsRouters: 1, entrypoints: ['web', 'websecure'], container: { name: 'traefik', state: 'running' } },
  opushub: { name: 'OpusHub', version: '0.1.0', gitSha: 'abc1234', buildTime: null, imageTag: null, installationMode: 'source' },
};
const dockerDoc = {
  at: Date.now(), status: { ok: true, state: 'connected', version: '26.1.0', api: '1.43' },
  engine: { version: '26.1.0', apiVersion: '1.43', os: 'linux', arch: 'amd64', driver: 'overlay2' },
  counts: { containers: 3, running: 2, stopped: 1, images: 2, volumes: 2, networks: 2 },
  live: true, statusReason: null, code: null, lastKnown: null,
};
const networksDoc = {
  at: Date.now(), live: true, statusReason: null, code: null, count: 2, stale: null,
  networks: [
    { id: 'aaaabbbbcccc', name: 'proxy', driver: 'bridge', scope: 'local', internal: false, attachable: true, created: null, containerCount: 2, containers: [{ name: 'wave' }, { name: 'stream' }] },
    { id: 'dddddeeeefff', name: 'media_default', driver: 'bridge', scope: 'local', internal: false, attachable: false, created: null, containerCount: 1, containers: [{ name: 'wave' }] },
  ],
};
const volumesDoc = {
  at: Date.now(), live: true, statusReason: null, code: null, count: 2, stale: null,
  volumes: [
    { name: 'wave-data', driver: 'local', scope: 'local', createdAt: null, refCount: 1, size: 500_000_000 },
    { name: 'orphan-volume', driver: 'local', scope: 'local', createdAt: null, refCount: 0, size: 12_000_000 },
  ],
};
const imagesDoc = {
  at: Date.now(), live: true, statusReason: null, code: null, count: 2, stale: null,
  images: [
    { id: 'abc123def456', tags: ['ghcr.io/example/wave:1.0'], digests: [], created: 1789000000, size: 268_435_456, containers: 1, usedBy: ['wave'] },
    { id: 'deadbeef0000', tags: ['alpine:3.20'], digests: [], created: 1788000000, size: 8_000_000, containers: 0, usedBy: [] },
  ],
};
const resourcesDoc = {
  at: Date.now(),
  cpu: { current: 21.4, unit: 'percent', average: 18.2, peak: 44.0, samples: 120, cores: 4, load: [1.2, 0.9, 0.5], availability: 'available', source: 'system-provider', timestamp: Date.now() },
  memory: { current: 4_000_000_000, total: 8_000_000_000, available: 4_000_000_000, cached: 1_000_000_000, usedPct: 50, unit: 'bytes', averagePct: 48, peakPct: 61, samples: 120, availability: 'available', source: 'system-provider', timestamp: Date.now() },
  network: { current: { rxPerSec: 1000, txPerSec: 500 }, unit: 'bytes-per-second', averageRx: 900, peakRx: 2000, averageTx: 400, peakTx: 900, samples: 120, interfaces: ['eth0'], availability: 'available', source: 'system-provider', timestamp: Date.now() },
  storage: { current: { mounts: 2, total: 100_000_000_000, used: 40_000_000_000, free: 60_000_000_000 }, mounts: 2, availability: 'available', source: 'storage-provider', timestamp: Date.now() },
  gpu: { current: null, availability: 'unavailable', reason: 'Not available', source: 'system-provider', timestamp: Date.now() },
};
const storageDoc = {
  at: Date.now(),
  providers: [
    { id: 'filesystem', label: 'Filesystems', available: true, reason: null, mounts: [{ mount: '/', device: '/dev/sda1', fs: 'ext4', total: 100_000_000_000, used: 40_000_000_000, free: 60_000_000_000, usedPct: 40 }], totals: { mounts: 1, total: 100_000_000_000, used: 40_000_000_000, free: 60_000_000_000 }, at: Date.now() },
    { id: 'zfs', label: 'ZFS', available: false, reason: 'The ZFS command-line tools are not available to OpusHub.', pools: [], datasets: [], empty: false, at: Date.now() },
  ],
};

/* ------------------------------------------------------------------------
   Phase 9 fixtures — the OpusGrid infrastructure surface.
   Deliberately a *mixed* install: Docker and filesystems work, ZFS works,
   the host network answers, and OPNsense / UPS / PDU are not configured.
   That is the interesting case: everything optional being absent must read
   as "not configured", never as unhealthy.
   ------------------------------------------------------------------------ */

const infraProviders = [
  { id: 'docker', type: 'compute', name: 'Docker', domain: 'compute', optional: false, description: null, status: 'connected', statusLabel: 'Connected', capabilities: ['containers', 'networks', 'volumes', 'images'], active: ['containers', 'networks', 'volumes', 'images'], planned: [], version: '26.1.0', lastChecked: Date.now(), error: null },
  { id: 'filesystem', type: 'storage', name: 'Filesystems', domain: 'storage', optional: false, description: null, status: 'available', statusLabel: 'Available', capabilities: ['filesystems'], active: ['filesystems'], planned: [], version: null, lastChecked: Date.now(), error: null },
  { id: 'zfs', type: 'storage', name: 'ZFS', domain: 'storage', optional: true, description: null, status: 'available', statusLabel: 'Available', capabilities: ['pools', 'datasets'], active: ['pools', 'datasets'], planned: [], version: null, lastChecked: Date.now(), error: null },
  { id: 'network', type: 'network', name: 'Host network', domain: 'network', optional: false, description: null, status: 'available', statusLabel: 'Available', capabilities: ['interfaces', 'routes', 'dns'], active: ['interfaces', 'routes', 'dns'], planned: [], version: null, lastChecked: Date.now(), error: null },
  { id: 'opnsense', type: 'firewall', name: 'OPNsense', domain: 'external', optional: true, description: null, status: 'not-configured', statusLabel: 'Not configured', capabilities: ['system', 'interfaces', 'gateways', 'dns'], active: [], planned: ['dhcp', 'firewall'], version: null, lastChecked: Date.now(), error: { code: 'not_configured', reason: 'No OPNsense address is configured.' } },
  { id: 'ups', type: 'power', name: 'UPS', domain: 'power', optional: true, description: null, status: 'not-configured', statusLabel: 'Not configured', capabilities: [], active: [], planned: ['status', 'batteryChargePct', 'runtimeSec'], version: null, lastChecked: Date.now(), error: { code: 'not_configured', reason: 'No UPS provider is configured.' } },
  { id: 'pdu', type: 'power', name: 'PDU', domain: 'power', optional: true, description: null, status: 'not-configured', statusLabel: 'Not configured', capabilities: [], active: [], planned: ['outletCount', 'outletStatus'], version: null, lastChecked: Date.now(), error: { code: 'not_configured', reason: 'No PDU provider is configured.' } },
];

const infraStorageDoc = {
  at: Date.now(),
  providers: ['filesystem', 'zfs'],
  filesystems: {
    status: 'available', available: true, reason: null,
    mounts: [
      { mount: '/', device: '/dev/sda1', fs: 'ext4', total: 100_000_000_000, used: 40_000_000_000, free: 60_000_000_000, usedPct: 40 },
      { mount: '/tank', device: 'tank', fs: 'zfs', total: 8_000_000_000_000, used: 3_200_000_000_000, free: 4_800_000_000_000, usedPct: 40 },
    ],
    mountCount: 2,
    totals: { mounts: 2, total: 8_100_000_000_000, used: 3_240_000_000_000, free: 4_860_000_000_000 },
    truncated: false,
  },
  zfs: {
    status: 'available', available: true, reason: null,
    pools: [
      { name: 'tank', size: 8_000_000_000_000, allocated: 3_200_000_000_000, free: 4_800_000_000_000, fragmentationPct: 4, capacityPct: 40, health: 'ONLINE', usedPct: 40 },
      { name: 'backup', size: 2_000_000_000_000, allocated: 1_900_000_000_000, free: 100_000_000_000, fragmentationPct: 12, capacityPct: 95, health: 'DEGRADED', usedPct: 95 },
    ],
    poolCount: 2,
    datasets: [
      { name: 'tank', pool: 'tank', used: 3_200_000_000_000, available: 4_800_000_000_000, referenced: 256_000_000, mountpoint: '/tank', compression: 'lz4', recordsize: 131072, quota: null, quotaUsedPct: null },
      { name: 'tank/media', pool: 'tank', used: 2_000_000_000_000, available: 4_800_000_000_000, referenced: 2_000_000_000_000, mountpoint: '/tank/media', compression: 'lz4', recordsize: 1048576, quota: 3_000_000_000_000, quotaUsedPct: 66 },
    ],
    datasetCount: 2,
    truncated: false,
    empty: false,
  },
};

const infraNetworkDoc = {
  at: Date.now(),
  providers: ['network', 'docker'],
  status: 'available', reason: null,
  interfaces: [
    { name: 'eth0', kind: 'ethernet', state: 'up', up: true, mtu: 1500, speedMbps: 1000,
      addresses: [{ address: '198.51.100.20', family: 'ipv4', scope: 'global', prefixLength: 24 }],
      rx: { bytes: 40_000_000_000, packets: 30_000_000, errors: 0, dropped: 0 },
      tx: { bytes: 12_000_000_000, packets: 9_000_000, errors: 0, dropped: 0 } },
    { name: 'docker0', kind: 'bridge', state: 'up', up: true, mtu: 1500, speedMbps: null,
      addresses: [{ address: '172.17.0.1', family: 'ipv4', scope: 'global', prefixLength: 16 }],
      rx: { bytes: 1_000_000, packets: 2_000, errors: 0, dropped: 0 },
      tx: { bytes: 2_000_000, packets: 3_000, errors: 0, dropped: 0 } },
  ],
  interfaceCount: 2,
  counts: { interfaces: 2, up: 2, withAddress: 2 },
  routes: { defaultRoute: { via: '198.51.100.1', iface: 'eth0', protocol: 'ipv4' }, defaultRoutes: [{ via: '198.51.100.1', iface: 'eth0', protocol: 'ipv4' }], routeCount: 4, routeCount6: 1, tableAvailable: false, note: 'Only the default route is shown. The full routing table is not exposed.' },
  dns: { available: true, nameservers: ['127.0.0.53'], search: ['lan'], source: 'resolv.conf', viaStubResolver: true, note: null },
  scope: 'container', scopeNote: 'OpusHub is reading the network namespace it runs in.',
  docker: { live: true, networks: [{ name: 'proxy', driver: 'bridge', scope: 'local', containerCount: 2, internal: false, attachable: true }], networkCount: 2, reason: null },
};

const infraOpnsenseDoc = {
  at: Date.now(),
  providers: ['opnsense'],
  opnsense: {
    status: 'not-configured', configured: false, url: null, credentialSource: 'environment',
    credentialPresent: false, version: null, reason: 'No OPNsense address is configured.',
    capabilities: [
      { id: 'system', label: 'System status', status: 'unavailable', reason: null },
      { id: 'interfaces', label: 'Interfaces', status: 'unavailable', reason: null },
      { id: 'gateways', label: 'Gateways', status: 'unavailable', reason: null },
      { id: 'dns', label: 'DNS resolver', status: 'unavailable', reason: null },
      { id: 'dhcp', label: 'DHCP leases', status: 'planned', reason: 'Planned for a later phase.' },
      { id: 'firewall', label: 'Firewall state', status: 'planned', reason: 'Planned for a later phase.' },
    ],
    planned: ['dhcp', 'firewall'], system: null, interfaces: null, gateways: null, dns: null,
  },
};

const infraPowerDoc = {
  at: Date.now(),
  providers: ['ups', 'pdu'],
  ups: { status: 'not-configured', reason: 'No UPS provider is configured. OpusHub does not detect power hardware on its own.', device: null, fields: { status: null, batteryChargePct: null, runtimeSec: null }, planned: ['status', 'batteryChargePct', 'runtimeSec'], refused: ['ups.shutdown', 'ups.test.battery'], note: 'Read-only when implemented.' },
  pdu: { status: 'not-configured', reason: 'No PDU provider is configured. OpusHub does not detect power hardware on its own.', device: null, fields: { outletCount: null, outletStatus: null }, planned: ['outletCount', 'outletStatus'], refused: ['pdu.outlet.on', 'pdu.outlet.off', 'pdu.outlet.cycle'], note: 'Read-only when implemented.' },
  note: 'Power devices are read-only when implemented. Outlet switching and UPS shutdown are not part of OpusHub.',
};

const infraTopologyDoc = {
  at: Date.now(),
  nodes: [
    { id: 'host', label: 'opusgrid', sub: 'host', kind: 'host', layer: 'compute', source: 'discovered', state: null, href: '/host', note: null },
    { id: 'docker', label: 'Docker', sub: 'container engine', kind: 'docker', layer: 'compute', source: 'discovered', state: null, href: null, note: null },
    { id: 'net:proxy', label: 'proxy', sub: 'bridge · 2 attached', kind: 'network', layer: 'network', source: 'discovered', state: null, href: null, note: null },
    { id: 'iface:eth0', label: 'eth0', sub: 'up · 198.51.100.20', kind: 'interface', layer: 'network', source: 'discovered', state: 'up', href: null, note: null },
    { id: 'pool:tank', label: 'tank', sub: 'ONLINE · 40% used', kind: 'pool', layer: 'storage', source: 'discovered', state: 'online', href: '/infrastructure?tab=storage&pool=tank', note: null },
    { id: 'ds:tank/media', label: 'tank/media', sub: '/tank/media', kind: 'dataset', layer: 'storage', source: 'discovered', state: null, href: '/infrastructure?tab=storage&dataset=tank/media', note: null },
    { id: 'svc:wave', label: 'Wave', sub: 'Music', kind: 'service', layer: 'services', source: 'discovered', state: 'running', href: '/services/Music/wave', note: null },
  ],
  edges: [
    { from: 'host', to: 'docker', source: 'discovered', kind: 'runs', label: null },
    { from: 'docker', to: 'net:proxy', source: 'discovered', kind: 'provides', label: null },
    { from: 'host', to: 'iface:eth0', source: 'discovered', kind: 'has', label: null },
    { from: 'host', to: 'pool:tank', source: 'discovered', kind: 'has', label: null },
    { from: 'pool:tank', to: 'ds:tank/media', source: 'discovered', kind: 'contains', label: null },
    { from: 'net:proxy', to: 'svc:wave', source: 'discovered', kind: 'attaches', label: null },
  ],
  layers: { physical: 0, network: 2, compute: 2, storage: 2, services: 1 },
  sources: { discovered: 6, configured: 0 },
  physical: { available: false, configured: false, reason: 'No physical topology is configured.', nodes: 0, links: 0 },
  rule: 'Every link is either proven by a provider or configured by you. Nothing is inferred.',
};

const gridDoc = {
  at: Date.now(),
  health: {
    status: 'degraded',
    domains: {
      compute: { domain: 'compute', label: 'Compute', status: 'healthy', reasons: [], providers: ['docker'], alerts: 0 },
      storage: { domain: 'storage', label: 'Storage', status: 'healthy', reasons: [], providers: ['filesystem', 'zfs'], alerts: 0 },
      network: { domain: 'network', label: 'Network', status: 'healthy', reasons: [], providers: ['network'], alerts: 0 },
      power: { domain: 'power', label: 'Power', status: 'not-configured', reasons: ['UPS: not configured', 'PDU: not configured'], providers: ['ups', 'pdu'], alerts: 0 },
      external: { domain: 'external', label: 'External', status: 'not-configured', reasons: ['OPNsense: No OPNsense address is configured.'], providers: ['opnsense'], alerts: 0 },
    },
    counts: { healthy: 3, degraded: 0, unavailable: 0, notConfigured: 2, unknown: 0 },
    note: 'Optional providers that are not configured are excluded from the overall verdict.',
  },
  providers: infraProviders,
  domains: {
    compute: { at: Date.now(), providers: ['docker'], docker: { status: 'connected', version: '26.1.0', reason: null, live: true, counts: { containers: 3, running: 2, stopped: 1, stacks: 1 }, lastKnown: null } },
    storage: infraStorageDoc,
    network: { ...infraNetworkDoc, interfaces: [], summaryOnly: true },
    power: { at: Date.now(), providers: ['ups', 'pdu'], ups: infraPowerDoc.ups, pdu: infraPowerDoc.pdu, summaryOnly: true },
    external: { at: Date.now(), providers: ['opnsense'], opnsense: infraOpnsenseDoc.opnsense, summaryOnly: true },
  },
};

const poolDetailDoc = {
  at: Date.now(), name: 'tank', size: 8_000_000_000_000, allocated: 3_200_000_000_000, free: 4_800_000_000_000,
  fragmentationPct: 4, capacityPct: 40, health: 'ONLINE', usedPct: 40,
  topology: {
    available: true, reason: null,
    vdevs: [
      { name: 'mirror-0', pathHidden: false, depth: 1, size: 4_000_000_000_000, allocated: 1_600_000_000_000, free: 2_400_000_000_000, fragmentationPct: 4, capacityPct: 40, health: 'ONLINE', children: [
        { name: 'sda', pathHidden: true, depth: 2, size: null, allocated: null, free: null, fragmentationPct: null, capacityPct: null, health: 'ONLINE', children: [] },
      ] },
    ],
  },
  datasets: [infraStorageDoc.zfs.datasets[1]],
};

const datasetDetailDoc = { at: Date.now(), ...infraStorageDoc.zfs.datasets[1] };

const alertsDoc = {
  at: new Date().toISOString(),
  alerts: [
    {
      id: 'service.unhealthy:Music/wave', signature: 'service.unhealthy:Music/wave', severity: 'warning',
      title: 'Wave is unhealthy', detail: 'Its container healthcheck is failing.',
      evidence: { state: 'running', health: 'unhealthy' },
      links: [{ label: 'Open the service', href: '/services/Music/wave' }],
      firedAt: Date.now() - 60_000, acknowledged: false, ackAt: null,
    },
  ],
  counts: { critical: 0, warning: 1 },
  // no channels field: delivery status lives with the canonical Phase 10B providers now
};
const updatesDoc = {
  check: { state: 'available', current: '0.1.0', latest: '0.2.0', url: 'https://github.com/lucif3r-d3vil/opushub/releases/tag/v0.2.0', checkedAt: Date.now() - 3600_000, reason: '0.2.0 is published; this install runs 0.1.0' },
  repo: 'https://github.com/lucif3r-d3vil/opushub',
  install: { name: 'OpusHub', version: '0.1.0', gitSha: 'abc123', buildTime: null, imageTag: null, installationMode: 'source' },
};
const waveHealth = {
  service: 'wave', displayName: 'Wave',
  health: { state: 'healthy', evidence: { container: 'running', healthcheck: 'healthy', http: '200' }, stack: 'Media', startedAt: new Date(Date.now() - 86_400_000).toISOString(), url: 'http://wave.lab.internal', urlSource: 'traefik', detail: 'Healthcheck passing.' },
  probe: { checked: true, reachable: true, statusCode: 200, latencyMs: 14, checkedAt: new Date().toISOString(), source: 'traefik', errorType: null },
  evaluatedAt: Date.now(),
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
    '/api/services/Media/stream': {
      ...serviceDetail,
      service: { ...servicesDoc.services[0], name: 'stream', displayName: 'Stream', group: 'Media' },
    },
    '/api/services/Media/stream/stats/history': { samples: [], watchingSince: null, capped: 360 },
    '/api/services/Media/stream/history': { service: 'stream', events: [], watchingSince: null, logStarted: null },
    '/api/services/Music/navidrome': {
      ...serviceDetail,
      service: { ...servicesDoc.services[0], name: 'navidrome', displayName: 'Navidrome', description: 'Music streaming', group: 'Music' },
    },
    '/api/stacks/media': stackDetail,
    '/api/stacks/media/history': stackHistory,
    '/api/host': hostDoc,
    '/api/docker': dockerDoc,
    '/api/networks': networksDoc,
    '/api/volumes': volumesDoc,
    '/api/images': imagesDoc,
    '/api/resources': resourcesDoc,
    '/api/storage': storageDoc,
    '/api/services/Music/wave/health': waveHealth,
    '/api/alerts': alertsDoc,
    '/api/updates': updatesDoc,
    // Phase 9 — the OpusGrid surface
    '/api/infrastructure': gridDoc,
    '/api/infrastructure/providers': { at: Date.now(), providers: infraProviders, count: infraProviders.length },
    '/api/infrastructure/storage': infraStorageDoc,
    '/api/infrastructure/network': infraNetworkDoc,
    '/api/infrastructure/opnsense': infraOpnsenseDoc,
    '/api/infrastructure/power': infraPowerDoc,
    '/api/infrastructure/topology': infraTopologyDoc,
    '/api/infrastructure/storage/pool': poolDetailDoc,
    '/api/infrastructure/storage/dataset': datasetDetailDoc,
    '/api/infrastructure/physical': { available: false, configured: false, nodes: [], links: [], reason: 'No physical topology is configured.', error: null, file: 'topology.yaml', at: Date.now() },
  };
}


/* ------------------------------------------------------------------------
   Phase 8 fixtures — an operations engine that answers the way the real one
   does: an overview of what is permitted, a dry-run that evaluates and
   returns a token, and an execution that spends it.
   ------------------------------------------------------------------------ */

const OP_ACTIONS = [
  { id: 'container.start', label: 'Start container', permission: 'operations.container.start', risk: 'low', confirmation: 'normal', summary: 'Start a stopped container.', timeoutMs: 10_000, verifyMs: 15_000, enabled: true },
  { id: 'container.restart', label: 'Restart container', permission: 'operations.container.restart', risk: 'medium', confirmation: 'normal', summary: 'Restart a running container.', timeoutMs: 25_000, verifyMs: 20_000, enabled: true },
  { id: 'container.stop', label: 'Stop container', permission: 'operations.container.stop', risk: 'high', confirmation: 'strong', summary: 'Stop a running container. It stays stopped until you start it again.', timeoutMs: 15_000, verifyMs: 15_000, enabled: true },
];

/** The overview the engine returns — `permitted` is the server's decision, not the browser's. */
function opsOverview({ permitted = OP_ACTIONS.map((a) => a.id), docker = true, role = 'admin' as string } = {}) {
  return {
    at: Date.now(),
    actor: { username: 'nora', role, roleLabel: role === 'admin' ? 'Admin' : 'Viewer', description: 'Fixture account.', permissions: permitted.map((id) => `operations.${id}`) },
    actions: OP_ACTIONS.map((a) => ({ ...a, permitted: permitted.includes(a.id) })),
    docker: { read: true, operations: docker, channel: 'shared' as const },
    counts: { running: 0, failed: 0, recent: 0 },
    running: [], failed: [], recent: [],
  };
}

/** What the server says when it evaluates an operation and executes nothing. */
function opsDryRun(action: string, { ready = true, permission = true, error = null as null | { code: string; reason: string } } = {}) {
  const meta = OP_ACTIONS.find((a) => a.id === action) || OP_ACTIONS[0];
  return {
    operation: { id: 'op-fixture', action, target: { type: 'service', id: 'wave', label: 'Wave', group: 'Music', service: 'wave', stack: 'media', containerName: 'wave', state: 'running' }, actor: 'nora', status: 'awaiting_confirmation', requestedAt: Date.now(), startedAt: null, completedAt: null, durationMs: null, result: null, error, verification: null, confirmation: { required: true, mode: meta.confirmation, consumed: false }, auditId: 'aud-1' },
    dryRun: {
      ready: ready && permission && !error,
      action: { id: meta.id, label: meta.label, risk: meta.risk, verb: meta.id.split('.')[1], timeoutMs: meta.timeoutMs },
      target: { label: 'Wave', containerName: 'wave', state: 'running', health: 'healthy', group: 'Music', stack: 'media', self: false },
      permission, risk: meta.risk, docker: true,
      engineAction: `POST /containers/<id>/${meta.id.split('.')[1]}`,
      confirmation: { required: true, mode: meta.confirmation },
      checks: [
        { key: 'action', label: 'Registered action', ok: true, detail: meta.id },
        { key: 'permission', label: `Needs ${meta.permission}`, ok: permission, detail: permission ? 'granted for this account' : 'not granted for this account' },
        { key: 'target', label: 'Target resolves to a container', ok: true, detail: 'wave' },
        { key: 'docker', label: 'Engine reachable', ok: true, detail: 'connected' },
      ],
      error,
    },
    confirmation: {
      required: true, mode: meta.confirmation, token: 'tok-fixture', expiresAt: Date.now() + 120_000, ttlMs: 120_000,
      prompt: {
        title: `${meta.label.replace(' container', '')} Wave?`,
        body: `This runs ${meta.id} against the container “wave”. Nothing else on the host is touched.`,
        acknowledge: meta.confirmation === 'strong' ? 'I understand the service will be unavailable until I start it again.' : null,
        confirmLabel: meta.label.replace(' container', ''), cancelLabel: 'Cancel', risk: meta.risk, self: false, selfNote: null,
      },
    },
  };
}

/** An operation record in a terminal state, as the engine reports it after polling. */
function opsRecord(status: string, { action = 'container.restart', state = 'running', error = null as null | { code: string; reason: string } } = {}) {
  return {
    id: 'op-fixture', action,
    target: { type: 'service', id: 'wave', label: 'Wave', group: 'Music', service: 'wave', stack: 'media', containerName: 'wave', state },
    actor: 'nora', status, requestedAt: Date.now() - 4000, startedAt: Date.now() - 3800,
    completedAt: status === 'running' ? null : Date.now() - 2000,
    durationMs: status === 'running' ? null : 1800,
    result: status === 'succeeded' ? { state, health: 'healthy' } : null,
    error,
    verification: { state, health: { state: 'healthy', detail: null, measured: true }, startedAt: new Date().toISOString(), verified: status === 'succeeded', note: null },
    confirmation: { required: true, mode: 'normal', consumed: true },
    auditId: 'aud-1',
  };
}

/** Every Phase 8 route, wired so a test can watch what the browser actually sent. */
function opsRoutes(overview = opsOverview(), { action = 'container.restart', dry = opsDryRun(action), finalStatus = 'succeeded' } = {}) {
  let polls = 0;
  return {
    '/api/v1/operations': (body: unknown) => (body ? { operation: opsRecord('running', { action }) } : overview),
    '/api/v1/operations/dry-run': () => dry,
    '/api/v1/operations/op-fixture': () => {
      // the first poll sees it running; the second sees it settled — a real engine looks like this
      polls += 1;
      return { operation: polls < 2 ? opsRecord('running', { action }) : opsRecord(finalStatus, { action }) };
    },
    '/api/v1/operations?service=wave': { ...overview, operations: [] },
  };
}

/** The confirm button in whichever dialog is open. */
const confirmButton = () => qa('.modal-foot button').find((b) => /^(Start|Restart|Stop)$/.test(text(b).trim()));

/* ------------------------------------------------------------------ */
/* Phase 10A — monitoring fixtures                                     */
/* ------------------------------------------------------------------ */

const now = Date.now();

function uptimeWindow(over: Partial<UptimeWindow> = {}): UptimeWindow {
  return {
    windowMs: 24 * 3_600_000, from: now - 86_400_000, to: now, checks: 0, ok: 0, degraded: 0, fail: 0, unknown: 0, judged: 0,
    uptimePct: null, degradedPct: null, avgLatencyMs: null, minLatencyMs: null, maxLatencyMs: null,
    noData: true, paused: false, coverageFrom: null, coverageTo: null, ...over,
  };
}

function monitorFixture(over: Partial<Monitor> = {}): Monitor {
  return {
    id: 'mon-fixture0001',
    name: 'Jellyfin',
    type: 'http',
    target: { kind: 'http', service: { group: 'Media', name: 'jellyfin' }, url: 'http://10.0.0.12:8096', scope: 'internal', scopeAt: now - 60_000 },
    intervalMs: 60_000,
    timeoutMs: 5000,
    enabled: true,
    expected: { status: null, min: 200, max: 399 },
    provenance: 'discovered',
    source: { kind: 'reverse-proxy', provider: 'Traefik', urlSource: 'traefik', note: null },
    description: null,
    status: 'up',
    storedStatus: 'up',
    latencyMs: 42,
    lastCheck: { at: now - 30_000, kind: 'ok', statusCode: 200, latencyMs: 42, reason: 'HTTP 200', code: null, errorType: null, hops: 0, evidence: null },
    nextCheck: now + 30_000,
    failureCount: 0,
    successCount: 12,
    consecutiveFailures: 0,
    consecutiveSuccesses: 12,
    targetStale: false,
    maintenance: null,
    createdAt: now - 86_400_000,
    updatedAt: now - 30_000,
    stale: false,
    uptime: uptimeWindow({ uptimePct: 99.4, checks: 140, ok: 138, fail: 2, judged: 140, noData: false, avgLatencyMs: 44, minLatencyMs: 21, maxLatencyMs: 210, coverageFrom: now - 86_400_000, coverageTo: now }),
    ...over,
  };
}

const downMonitor = monitorFixture({
  id: 'mon-fixture0002', name: 'Paperless', status: 'down', storedStatus: 'down', latencyMs: null,
  target: { kind: 'tcp', host: '10.0.0.14', port: 8000, service: null, scope: 'internal', scopeAt: now - 60_000 },
  lastCheck: { at: now - 20_000, kind: 'fail', statusCode: null, latencyMs: null, reason: 'No connection (refused).', code: null, errorType: 'refused', hops: 0, evidence: null },
  consecutiveFailures: 5, uptime: uptimeWindow({ uptimePct: 88.2, checks: 120, ok: 105, fail: 15, judged: 120, noData: false, avgLatencyMs: 61, minLatencyMs: 30, maxLatencyMs: 900, coverageFrom: now - 86_400_000, coverageTo: now }),
});

const pausedMonitor = monitorFixture({ id: 'mon-fixture0003', name: 'Restart-loop container', type: 'docker', enabled: false, status: 'paused', storedStatus: 'up', uptime: uptimeWindow({ paused: true }) });

const monitoringOverview = {
  at: now,
  engine: {
    at: now, state: 'running', reason: null, startedAt: now - 3_600_000, stoppedAt: null, lastTickAt: now - 5_000, lastCheckAt: now - 30_000,
    bootCount: 3, checksRun: 812, ticks: 240, checksRunning: 1, maxChecksRunning: 3, concurrency: 3,
    monitored: 3, active: 2, paused: 1, stale: false, openIncidents: 1,
  },
  counts: { total: 3, up: 1, degraded: 0, down: 1, recovering: 0, pending: 0, paused: 1, unknown: 0, stale: 0, maintenance: 0, suggested: 0 },
  monitors: [monitorFixture(), downMonitor, pausedMonitor],
};

const monitoringDetail = {
  at: now,
  monitor: downMonitor,
  stale: false,
  expected: 'HTTP 200–399',
  uptime: {
    day: uptimeWindow({ uptimePct: 88.2, checks: 120, ok: 105, fail: 15, judged: 120, noData: false, avgLatencyMs: 61, minLatencyMs: 30, maxLatencyMs: 900 }),
    week: uptimeWindow({ uptimePct: 97.1, checks: 900, ok: 891, fail: 9, judged: 900, noData: false }),
    month: uptimeWindow({ uptimePct: 99.0, checks: 3600, ok: 3564, fail: 36, judged: 3600, noData: false }),
  },
  series: [
    { t: now - 120_000, k: 'ok', code: 200, ms: 40 },
    { t: now - 60_000, k: 'fail', code: null, ms: null },
    { t: now - 20_000, k: 'fail', code: null, ms: null },
  ],
  buckets: [],
  incidents: [{
    id: 'inc-fixture0001', monitorId: 'mon-fixture0002', monitorName: 'Paperless', monitorType: 'tcp', type: 'tcp',
    service: null, startedAt: now - 5 * 60_000, detectedAt: now - 3 * 60_000, recoveredAt: null, durationMs: 5 * 60_000,
    open: true, status: 'open', reason: 'No connection (refused).', failureCount: 5, maintenance: false, suppressed: false, resolvedBy: null,
  }],
  engine: monitoringOverview.engine,
};

const monitoringSettingsDoc = {
  settings: {
    intervalMs: 60_000, timeoutMs: 5000, failureThreshold: 3, recoveryThreshold: 2,
    retentionSamples: 360, retentionHours: 336, retentionIncidents: 400, maxMonitors: 200, maxConcurrent: 3,
    jitterMs: 5000, allowInternal: true, autoCreate: { enabled: false, max: 10 },
  },
  bounds: {
    intervalMs: { min: 10_000, max: 86_400_000, default: 60_000 },
    timeoutMs: { min: 500, max: 30_000, default: 5000 },
    failureThreshold: { min: 1, max: 10, default: 3 },
    recoveryThreshold: { min: 1, max: 10, default: 2 },
    retentionSamples: { min: 30, max: 2000, default: 360 },
    retentionHours: { min: 24, max: 2000, default: 336 },
    retentionIncidents: { min: 20, max: 2000, default: 400 },
    maxMonitors: { min: 1, max: 500, default: 200 },
    maxConcurrent: { min: 1, max: 8, default: 3 },
    jitterMs: { min: 0, max: 60_000, default: 5000 },
    autoCreateMax: { min: 0, max: 100, default: 10 },
  },
};

/** The monitoring endpoints, with create/check replayable so a test can see exactly what was sent. */
function monitoringRoutes(over: Record<string, unknown | ((body: unknown, path: string) => unknown)> = {}) {
  return {
    // `?service=` narrows the document exactly as the server narrows it, so a service page sees
    // only the monitors that watch *it*
    '/api/monitoring': (_body: unknown, path: string) => {
      const svc = new URLSearchParams(path.split('?')[1] || '').get('service');
      if (!svc) return monitoringOverview;
      const [group, ...rest] = svc.split('/');
      const name = rest.join('/');
      const monitors = monitoringOverview.monitors.filter((m) => m.target.service
        && m.target.service.name.toLowerCase() === name.toLowerCase()
        && (!m.target.service.group || m.target.service.group.toLowerCase() === (group || '').toLowerCase()));
      return { ...monitoringOverview, monitors, counts: { ...monitoringOverview.counts, total: monitors.length } };
    },
    '/api/monitoring/settings': monitoringSettingsDoc,
    '/api/monitoring/suggestions': { at: now, suggestions: [], reason: 'Nothing new to suggest.', autoCreate: { enabled: false, max: 10 } },
    '/api/monitoring/incidents': { at: now, incidents: monitoringDetail.incidents, open: 1, total: 1 },
    '/api/monitoring/monitors/mon-fixture0002': monitoringDetail,
    '/api/monitoring/monitors': (body: unknown) => (
      body ? { monitor: monitorFixture({ id: 'mon-created0001', name: (body as { monitor: { name: string } }).monitor.name }) } : monitoringOverview
    ),
    ...over,
  };
}

/** The Hub, inside the providers it actually runs with, plus routes to observe navigation. */
function TestApp({ children, entry = '/' }: { children: ReactNode; entry?: string }) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <SettingsProvider>
        <LayoutProvider>
          {/* Phase 8 — the one confirmation flow, mounted for every tree these checks render */}
          <OperationsHost />
          <Routes>
            <Route path="/" element={children} />
            <Route path="/settings/:tab" element={<Settings />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/icons" element={<IconsPage />} />
            <Route path="/activity" element={<div data-test="activity">activity</div>} />
            <Route path="/stacks/:name" element={<StackDetail />} />
            <Route path="/system" element={<SystemPage />} />
            <Route path="/infrastructure" element={<InfrastructurePage />} />
            <Route path="/services/:group/:name" element={<ServiceDetail />} />
            <Route path="/monitoring" element={<MonitoringPage />} />
            <Route path="/monitoring/incidents" element={<MonitoringPage />} />
            <Route path="/monitoring/:id" element={<MonitorDetailPage />} />
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
    // the greeting depends on the hour the suite runs at, so accept its whole vocabulary
    expect(/still up|good (morning|afternoon|evening)/i.test(text()), `the greeting is missing: ${text().slice(0, 160)}`);
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

  /* 1c — Phase 5: the greeting's four windows, pinned so a 4am test run is not a coin flip */
  await test('greeting: every hour of the day maps to exactly one lead, name trimmed', async () => {
    const leadFor = (hour: number, name: string | null = null) => greetingFor(name, hour).lead;
    expect(leadFor(0) === 'Still up' && leadFor(4) === 'Still up', 'the small hours lost their greeting');
    expect(leadFor(5) === 'Good morning' && leadFor(11) === 'Good morning', 'the morning window is wrong');
    expect(leadFor(12) === 'Good afternoon' && leadFor(17) === 'Good afternoon', 'the afternoon window is wrong');
    expect(leadFor(18) === 'Good evening' && leadFor(23) === 'Good evening', 'the evening window is wrong');
    // every hour is covered by exactly one of the four leads — no hour renders nothing
    for (let h = 0; h < 24; h++) expect(GREETINGS.includes(leadFor(h) as typeof GREETINGS[number]), `hour ${h} has no greeting`);
    // the name is optional, trimmed, and bounded
    expect(greetingFor(null, 9).name === null && greetingFor('   ', 9).name === null, 'a blank name was rendered');
    expect(greetingFor('  Nora  ', 9).name === 'Nora', 'the name is not trimmed');
    expect((greetingFor('x'.repeat(80), 9).name || '').length <= 40, 'the name is not bounded');
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

  /* 3b — Phase 5: the palette finds a service, offers its activity, and deep-links the filter */
  await test('search: ⌘K → “stream” → the service, with its activity one row below', async (h) => {
    await h.mount(<TestApp><SearchHost /></TestApp>);
    key(window, '/');
    await h.flush(40);
    await type(searchInput()!, 'stream');
    await h.waitFor(() => text().includes('Stream'), 'results for “stream”');
    await h.flush(260);
    // the service and the activity destination are separate rows, in separate groups
    expect(text().includes('Recent activity'), 'the activity group is not shown');
    const rows = qa('.cmdk-item').map((el) => text(el));
    expect(rows.some((r) => r.includes('Stream') && r.includes('Media')), 'the service result is missing');
    expect(rows.some((r) => r.includes('started')), 'the activity result is missing');

    // choosing the service navigates to the service page
    const serviceRow = qa('.cmdk-item').find((el) => text(el).includes('Stream') && text(el).includes('Media'))!;
    click(serviceRow);
    await h.flush(80);
    expect(!dialog(), 'the overlay stayed open');
    expect(qa('h1.detail-title').some((el) => text(el).includes('Stream')), 'the service page did not open');
    expect(!h.calls.some((c) => text(JSON.stringify(c.body ?? {})).includes('restart')), 'a destructive command reached the API');
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
  await test('stack detail renders the project, its rollup, and an aggregate chart', async (h) => {
    await h.mount(<TestApp entry="/stacks/media"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('Media'), 'the stack page');
    await h.waitFor(() => text().includes('aggregated point'), 'the aggregate history');
    expect(text().includes('Wave') || text().includes('wave'), 'the stack members are missing');
    expect(!/Docker isn.t connected/.test(text()) || stackDetail.live === false, 'a live stack reported as disconnected');

    // the rollup states its own coverage instead of implying the whole project reported,
    // and it carries the unhealthy count through from the per-member health
    expect(text().includes('2/3 reporting'), 'the rollup does not say how many containers reported');
    expect(text().includes('1'), 'the unhealthy member is not counted');
    expect(text().includes('net'), 'lifetime network I/O is missing from the rollup');
    expect(/up \d+[hms]/.test(text()), 'stack uptime is missing');

    // the aggregate chart is measured (fixed box) and honest about what it covers
    const chart = q('.res-history .chart');
    expect(!!chart && !!chart.querySelector('svg'), 'the stack history chart did not render');
    expect(/each point sums \d+ of \d+ container/.test(text()), 'the aggregate chart does not say what a point covers');
    expect(text().includes('never recorded'), 'the aggregate chart does not bound its own history');

    // and the page says out loud that a compose project is not a presentation group
    expect(text().includes('Compose project is infrastructure'), 'the compose-project ≠ group note is missing');
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

  /* 15b — Phase 5: System shows the machinery behind it, and the load history it holds */
  await test('system: provider health, load history, and no invented GPU or thermal data', async (h) => {
    h.setRoutes({
      ...stubRoutes(),
      '/api/system/history': {
        points: [
          { t: Date.now() - 10_000, cpu: 12, memUsedPct: 40, load: 0.4, rx: 1000, tx: 200, temp: 41, procs: 120 },
          { t: Date.now() - 5_000, cpu: 14, memUsedPct: 41, load: 0.62, rx: 1400, tx: 260, temp: 41, procs: 121 },
        ],
      },
    });
    await h.mount(<TestApp entry="/system"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('Load average'), 'the load history chart');
    expect(qa('.sys-band--providers .prov-row').length >= 3, 'the provider band did not render');
    expect(text().includes('read 2s ago'), 'provider freshness is not shown');
    expect(text().includes('nothing on this page needs it'), 'an idle provider is not described as idle');
    expect(text().includes('feeds unreachable'), 'a failing provider hides its reason');
    expect(text().includes('no discrete GPU'), 'the GPU row invented a device');
    expect(text().includes('41°C'), 'a real thermal reading was not shown');
    // two measured charts (cpu + load), each in its own box
    expect(qa('.chart svg').length >= 2, 'the charts did not render');
    for (const c of qa('.chart')) expect(!!c.getAttribute('style')?.includes('height'), 'a chart box was not sized');
  });

  /* 15c — Phase 5: the Activity Center's filters narrow the log through the API, visibly */
  await test('activity: filters narrow the query, and active filters are removable chips', async (h) => {
    let lastQuery = '';
    h.setRoutes({
      ...stubRoutes(),
      '/api/activity': (_body, path) => {
        lastQuery = path;
        return {
          items: [
            { id: 'a1', t: Date.now() - 60_000, iso: new Date().toISOString(), source: 'docker', type: 'container.started', subject: 'wave', message: 'running' },
          ],
          total: 4100, matched: 3, watchingSince: Date.now() - 86_400_000,
        };
      },
    });
    await h.mount(<MemoryRouter initialEntries={['/activity']}><ActivityPage /></MemoryRouter>);
    await h.waitFor(() => !!q('.tl-scope'), 'the filter row');
    expect(lastQuery.includes('source=all'), `the source filter is not in the query (${lastQuery})`);

    type(q<HTMLInputElement>('.tl-field input')!, 'wave');
    await h.flush(60);
    expect(lastQuery.includes('service=wave'), `the service filter never reached the API (${lastQuery})`);

    // the active filter is visible as a chip, and removing it widens the query again
    await h.waitFor(() => text().includes('service: wave'), 'the active filter chip');
    expect(text().includes('3 matching events of 4100 recorded'), 'the scope line does not state what matched');
    const chip = qa('button.chip.active').find((b) => text(b).includes('service: wave'));
    expect(!!chip, 'the service chip is not removable');
    click(chip!);
    await h.flush(60);
    // the filter is gone from the UI, and the scope line is back to the unfiltered wording (the
    // unfiltered query is already in the shared cache, so no second request is the correct answer)
    expect(!qa('button.chip.active').some((b) => text(b).includes('service: wave')), 'removing the chip did not clear the filter');
    expect(!text().includes('3 matching events'), 'the scope line still shows the filtered count');

    // the type and time selects change the query too
    const selects = qa('.tl-field select');
    expect(selects.length === 4, `expected the type, area, severity and time selects, saw ${selects.length}`);
    const typeSelect = selects[0] as HTMLSelectElement;
    typeSelect.value = 'container';
    act(() => { typeSelect.dispatchEvent(new Event('change', { bubbles: true })); });
    await h.flush(60);
    expect(lastQuery.includes('type=container'), `the type filter never reached the API (${lastQuery})`);
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

  /* 17b — Phase 5: the settings navigation is grouped, current, and honest about loading */
  await test('settings: grouped navigation, a current section, and announced loading states', async (h) => {
    await h.mount(<TestApp entry="/settings/general"><Settings /></TestApp>);
    await h.waitFor(() => !!q('.settings-nav'), 'the settings navigation');
    const labels = qa('.settings-nav-label').map((el) => text(el));
    // Phase 6 added a sixth section: the four configuration surfaces (import, history, export,
    // scope) are their own group rather than being filed under an existing one.
    expect(labels.length === 6, `the nav is not grouped into six sections (${labels.join(' / ')})`);
    for (const section of ['Home', 'Hub', 'Content', 'Connections', 'Configuration', 'This install']) {
      expect(labels.includes(section), `the “${section}” section heading is missing (${labels.join(' / ')})`);
    }
    // every section of the IA is reachable, including the three Phase 5 panes and Phase 6's four
    const navText = text(q('.settings-nav')!);
    for (const item of ['General', 'Appearance', 'Services', 'Groups', 'Bookmarks', 'Widgets', 'Integrations', 'Import & migration', 'History', 'Export', 'Scope', 'Account & sessions', 'Environment', 'Advanced']) {
      expect(navText.includes(item), `“${item}” is missing from the settings navigation`);
    }
    // the item you are on says so — visually and to assistive tech
    const current = qa('[aria-current="page"]').map((el) => text(el));
    expect(current.some((c) => c.includes('General')), `no section is marked current (${current.join(', ')})`);

    // the old /settings/system route still lands on Environment rather than 404-ing
    const h2 = await createHarness({ routes: stubRoutes(), fallback: () => ({}) });
    try {
      await h2.mount(<TestApp entry="/settings/system"><Settings /></TestApp>);
      await h2.waitFor(() => text().includes('Homepage-compatible'), 'the Environment pane');
      expect(qa('[aria-current="page"]').some((el) => text(el).includes('Environment')), 'the alias did not select Environment');
    } finally {
      await h2.unmount();
    }

    // loading is announced, names what it waits for, and never claims data it does not have
    await h.mount(<Loading what="the engine's status" />);
    await h.flush(10);
    expect(!!q('.loading-note[role="status"]'), 'the loading line is not a status');
    expect(text().includes("Reading the engine's status"), `the loading line does not name its subject: ${text()}`);
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
  await test('setup wizard: eight steps (with the Phase 6 presentation choice), URL reasons explained, and a Finish screen before the Hub', async (h) => {
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
      // Phase 6: the presentation step is built from constants only — template arrangements and the
      // default composition — plus the counts above. No names are involved.
      presentation: {
        detected: { groups: 7, services: 19, stacks: 7 },
        widgets: [
          { type: 'system', zone: 'main', size: 'md', title: 'System' },
          { type: 'services', zone: 'main', size: 'lg', title: 'Services' },
        ],
        templates: [
          { id: 'minimal', name: 'Minimal', tagline: 'Just your services', description: '', spacing: 'airy', widgets: [{ type: 'services', zone: 'main', size: 'lg', title: 'Services' }] },
          { id: 'media', name: 'Media', tagline: 'Streaming first', description: '', spacing: 'comfortable', widgets: [{ type: 'services', zone: 'main', size: 'lg', title: 'Services' }, { type: 'system', zone: 'rail', size: 'sm', title: 'System' }] },
        ],
      },
    };
    let created: { username?: string; password?: string; infrastructure?: { hostAddress?: string }; presentation?: { mode?: string; template?: string } } | null = null;
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
    // Presentation (Phase 6): three ways in, all of them presentation-only
    expect(text().includes('Presentation'), 'the Presentation step heading is missing');
    expect(text().includes('Use what Docker found'), 'the default choice is not offered');
    expect(text().includes('Start from a template'), 'the template choice is not offered');
    expect(text().includes('Import a Homepage configuration'), 'the import choice is not offered');
    expect(text().includes('19'), 'the choice does not say how many applications are behind it');
    // the decision is a decision — nothing has been written, and the wizard says so
    expect(!h.writes('POST', '/api/setup').length, 'the wizard wrote during the presentation step');

    // the template choice selects one, and the preview shows that arrangement
    const template = qa('button').find((x) => text(x).includes('Start from a template'))!;
    click(template);
    await h.flush(20);
    expect(text().includes('Minimal') && text().includes('Media'), `the templates were not listed: ${text().slice(0, 400)}`);
    const media = qa('button').find((x) => text(x).trim().startsWith('Media'))!;
    click(media);
    await h.flush(20);
    await advance('Continue');

    // Preview: a wireframe of the arrangement, still no names, still no writes
    expect(text().includes('Preview'), 'no preview step');
    expect(!!q('.setup-preview'), 'the preview wireframe is missing');
    expect(text().includes('Services'), 'the preview does not show the blocks the template arranges');
    expect(!text().includes('jellyfin') && !text().includes('wave'), 'a container name leaked into the preview');
    expect(!h.writes('POST', '/api/setup').length, 'the preview wrote something');
    await advance('Continue');

    // Review: the recap, then the one mutation
    expect(text().includes('Review'), 'no review step');
    expect(text().includes('admin'), 'the recap does not name the account being created');
    expect(!q('.rail'), 'the shell appeared before the account existed');
    await advance('Create account');
    const post = h.writes('POST', '/api/setup')[0];
    expect(!!post, 'the account was never created');
    expect((post.body as { username?: string }).username === 'admin', 'the wrong username was sent');
    expect((post.body as { presentation?: { template?: string } }).presentation?.template === 'media', 'the chosen template was not carried by the one write');
    expect(!!created, 'the fixture never saw the create call');

    // Finish: a real screen, still no application behind it
    expect(text().includes('Enter OpusHub'), 'the Finish screen is missing');
    expect(!q('.rail'), 'creating the account jumped straight into the Hub');

    // …and the hand-off is explicit
    await advance('Enter OpusHub');
    await h.waitFor(() => !!q('.rail'), 'the application shell after entering');
  });

  /* 18c — Phase 5: a deep link into a filtered view is still behind the door */
  await test('deep links: /activity?service=… shows the sign-in screen and fetches no application data', async (h) => {
    h.setRoutes({
      '/api/setup/status': { required: false, complete: true, hasAccount: true, version: '0.1.0' },
      '/api/auth/me': { authenticated: false, user: null, setupComplete: true },
      '/api/docker/status': { ok: true, state: 'connected', version: '26.1.0-mock' },
    });
    await h.mount(<MemoryRouter initialEntries={['/activity?service=wave']}><App /></MemoryRouter>);
    await h.waitFor(() => !!q('#login-pass'), 'the sign-in screen');
    expect(!q('.rail'), 'the shell rendered behind a deep link');
    expect(!text().includes('wave'), 'the deep link leaked a service name into the sign-in screen');
    const appPaths = h.calls.filter((c) => c.path.startsWith('/api/') && !c.path.startsWith('/api/auth/') && !c.path.startsWith('/api/setup/'));
    expect(appPaths.length === 0, `an unauthenticated deep link fetched ${appPaths.map((c) => c.path).join(', ')}`);
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

  /* 32 — Phase 6: migration is a review before it is a write */
  await test('settings: import requires a review, and the review shows counts, not promises', async (h) => {
    const preview = {
      source: 'homepage',
      files: [{ name: 'services.yaml', present: true, size: 120 }],
      ignored: [], refused: [], warnings: [],
      counts: { groups: 2, services: 3, matched: 1, unmatched: 2, bookmarks: 2, widgets: 1, conflicts: 1 },
      groups: [{ name: 'Media', added: true, renamed: false, preserved: false }],
      services: [
        { key: 'jellyfin', name: 'Jellyfin', group: 'Media', matched: true, container: 'jellyfin', notes: [] },
        { key: 'ghost', name: 'Ghost', group: 'Lab', matched: false, container: null, notes: ['no matching container'] },
      ],
      bookmarks: [{ group: 'Media', name: 'Docs', url: 'https://docs.example.com', matched: false, notes: [] }],
      widgets: 1, invalid: [], unchanged: [],
    };
    h.setRoutes({
      '/api/config/import/parse': preview,
      '/api/config/import/apply': (body) => ({ ok: true, mode: (body as { mode?: string })?.mode || 'merge', written: ['services.yaml', 'bookmarks.yaml'], counts: preview.counts, version: '2026-09-15T120000Z' }),
      ...stubRoutes(),
    });
    await h.mount(<TestApp entry="/settings/import"><Settings /></TestApp>);
    await h.waitFor(() => text().includes('Review') || text().includes('review'), 'the import pane');
    // nothing is written until a plan has been reviewed
    expect(h.writes('POST', '/api/config/import/apply').length === 0, 'the pane wrote before a review existed');
    expect(/Docker/i.test(text()), 'the pane never mentions Docker — it must say what an import cannot do');
  });

  /* 33 — Phase 6: history is configuration versions, with the runtime state nowhere in sight */
  await test('settings: history lists configuration versions and never runtime state', async (h) => {
    h.setRoutes({
      '/api/config/history': {
        current: '2026-09-15T12-00-00-000Z',
        scope: ['services.yaml', 'bookmarks.yaml', 'layout.json'],
        stats: {
          count: 1, totalBytes: 1300, oldest: new Date(Date.now() - 60_000).toISOString(), newest: new Date(Date.now() - 60_000).toISOString(),
          retention: { versions: 20, bytes: 4_000_000 },
        },
        versions: [{
          id: '2026-09-15T12-00-00-000Z', at: new Date(Date.now() - 60_000).toISOString(), reason: 'import',
          subject: 'services.yaml', label: 'Imported a Homepage configuration', actor: 'admin',
          bytes: 1300, files: ['services.yaml', 'bookmarks.yaml', 'layout.json'],
          changed: [{ file: 'services.yaml', from: 'a1b2c3', to: 'd4e5f6' }],
        }],
      },
      ...stubRoutes(),
    });
    await h.mount(<TestApp entry="/settings/history"><Settings /></TestApp>);
    await h.waitFor(() => text().includes('Imported a Homepage configuration'), 'the history version label');
    expect(!!q('.cfg-versions'), 'the version list is missing');
    expect(text().includes('1 of 20'), `the retention bound is not shown: ${text().slice(-300)}`);
    expect(/1\.3 KB|1300/.test(text()), `the version size is not reported: ${text().slice(-300)}`);
    expect(!/sessions\.json|auth\.json|cookie/i.test(text()), 'history exposes runtime or authentication state');
  });

  /* 34 — Phase 6: export offers both dialects, and says what it strips */
  await test('settings: export offers both dialects and names what is excluded', async (h) => {
    h.setRoutes({
      '/api/config/export': {
        format: 'opushub', formatVersion: 1, kind: 'native', generatedAt: new Date().toISOString(),
        scope: ['services.yaml', 'bookmarks.yaml', 'layout.json'],
        files: { 'services.yaml': 'groups: []\n', 'bookmarks.yaml': 'groups: []\n' },
        notes: ['Integration API keys are not exported.'],
        redactions: [{ kind: 'query', url: 'http://lab.internal/news?apiKey=…', note: 'a credential in a URL query was stripped', where: 'services.yaml' }],
        machineSpecific: ['hostAddress'],
      },
      ...stubRoutes(),
    });
    await h.mount(<TestApp entry="/settings/export"><Settings /></TestApp>);
    await h.waitFor(() => text().includes('Homepage'), 'the export pane');
    expect(text().includes('opushub') || text().includes('OpusHub'), 'the native dialect is not named');
    expect(/credential|query|stripped/i.test(text()), `the redaction of a URL credential is not surfaced: ${text().slice(0, 400)}`);
    expect(text().includes('services.yaml'), 'the files in the export are not listed');
  });

  /* 35 — Phase 7: the infrastructure page reads engine facts, never invents them */
  await test('infrastructure renders engine facts, tabs and the volume list', async (h) => {
    await h.mount(<TestApp entry="/infrastructure"><InfrastructurePage /></TestApp>);
    await h.waitFor(() => text().includes('26.1.0'), 'the engine version');
    expect(text().includes('opusgrid'), 'the hostname is missing');
    expect(text().includes('Intel N100'), 'the CPU model is missing');
    for (const tab of ['Docker', 'Storage', 'Network', 'Power', 'Docker networks', 'Volumes', 'Images', 'Topology']) {
      expect(text().includes(tab), `the ${tab} tab is missing`);
    }
    const vols = qa('button, a').find((el) => text(el).trim() === 'Volumes');
    expect(!!vols, 'the volumes tab button is missing');
    await click(vols!);
    await h.waitFor(() => text().includes('wave-data'), 'the volume list');
    expect(text().includes('orphan-volume'), 'the second volume is missing');
    expect(!/\/var\/lib\/docker/.test(text()), 'a host mount path leaked into the volume list');
  });

  await test('infrastructure topology draws daemon-reported attachments', async (h) => {
    await h.mount(<TestApp entry="/infrastructure?tab=topology"><InfrastructurePage /></TestApp>);
    await h.waitFor(() => text().includes('proxy'), 'the topology network node');
    const svg = q('.topo-svg');
    expect(!!svg, 'the topology graph is missing');
    const labels = [...svg!.querySelectorAll('.topo-label')].map((el) => (el.textContent || '').trim());
    expect(labels.some((l) => l === 'proxy'), `the proxy network node is missing: ${labels.join(', ')}`);
    expect(labels.some((l) => /wave/i.test(l)), `the attached container node is missing: ${labels.join(', ')}`);
  });

  await test('service detail shows the unified health verdict with its evidence', async (h) => {
    await h.mount(<TestApp entry="/services/Music/wave"><ServiceDetail /></TestApp>);
    await h.waitFor(() => text().includes('Healthcheck passing'), 'the unified verdict');
    expect(text().includes('HTTP 200'), 'the HTTP evidence is missing');
    expect(!/healthy merely|assumed/i.test(text()), 'the verdict overclaims');
  });

  /* 7E — active alerts surface above the log, and the area/severity filters narrow the query */
  await test('activity shows active alerts with evidence and ack', async (h) => {
    let lastQuery = '';
    h.setRoutes({
      ...stubRoutes(),
      '/api/activity': (_body, path) => {
        lastQuery = path;
        return {
          items: [
            { id: 'a1', t: Date.now() - 60_000, iso: new Date().toISOString(), source: 'docker', type: 'container.health', subject: 'wave', message: 'health: unhealthy', severity: 'warning', category: 'docker' },
          ],
          total: 120, matched: 1, watchingSince: Date.now() - 86_400_000,
        };
      },
    });
    await h.mount(<MemoryRouter initialEntries={['/activity']}><ActivityPage /></MemoryRouter>);
    await h.waitFor(() => text().includes('Wave is unhealthy'), 'the active alert');
    expect(text().includes('healthcheck is failing'), 'the alert detail is missing');
    expect(!!q('.alerts-strip .alert-card'), 'the alert card is missing');
    expect(text().includes('Acknowledge'), 'the ack action is missing');
    expect(!!q('.sev-dot'), 'the severity dot is missing');

    // the new selects narrow the server query
    const selects = qa('.tl-scope select');
    expect(selects.length >= 4, 'area/severity selects are missing');
    const area = selects[1] as HTMLSelectElement;
    area.value = 'docker';
    area.dispatchEvent(new Event('change', { bubbles: true }));
    await h.flush(60);
    expect(lastQuery.includes('category=docker'), `the area filter never reached the API (${lastQuery})`);
    const sev = selects[2] as HTMLSelectElement;
    sev.value = 'warning';
    sev.dispatchEvent(new Event('change', { bubbles: true }));
    await h.flush(60);
    expect(lastQuery.includes('severity=warning'), `the severity filter never reached the API (${lastQuery})`);
  });

  /* 7E/10B — the notifications tab is the canonical provider UI: no legacy channel list,
     no "coming later" anywhere, and the active-alert count survives */
  await test('settings notifications shows the canonical providers and no legacy channels', async (h) => {
    await h.mount(<TestApp entry="/settings/notifications"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('Telegram provider'), 'the canonical provider blocks');
    for (const name of ['Notification Center', 'Browser notifications', 'Webhook provider', 'Telegram provider']) {
      expect(text().includes(name), `${name} block is missing`);
    }
    expect(!text().includes('Coming later'), 'a legacy "coming later" channel is still shown');
    expect(!text().includes('Alert channels'), 'the legacy alert-channels block is still shown');
    expect(text().includes('1 active alert'), 'the active-alert count is missing');
  });

  /* 7F — the palette shows alerts and infrastructure as their own groups */
  await test('search: alerts and infrastructure are grouped destinations', async (h) => {
    await h.mount(<TestApp><SearchHost /></TestApp>);
    key(window, '/');
    await h.flush(40);
    await type(searchInput()!, 'unhealthy');
    await h.waitFor(() => text().includes('Wave is unhealthy'), 'results for “unhealthy”');
    await h.flush(260);
    expect(text().includes('Alerts'), 'the alerts group is not shown');
    expect(text().includes('Infrastructure'), 'the infrastructure group is not shown');
    const rows = qa('.cmdk-item').map((el) => text(el));
    expect(rows.some((r) => r.includes('Wave is unhealthy')), 'the alert result is missing');
    expect(rows.some((r) => r.includes('proxy')), 'the infrastructure result is missing');
  });

  /* 7F — the environment tab shows the install and the newest release, honestly */
  await test('settings environment shows update awareness without auto-checking', async (h) => {
    await h.mount(<TestApp entry="/settings/environment"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('Check for updates'), 'the updates block');
    expect(text().includes('0.2.0 available'), 'the newest release is not shown');
    expect(text().includes('never checks on its own'), 'the no-phone-home promise is missing');
    expect(!h.calls.some((c) => c.path === '/api/updates/check'), 'the page checked without being asked');
  });


  /* ==================================================================
     Phase 8 — the operations flow, as a person meets it
     ================================================================== */

  await test('operations: the service page asks first, and only a confirmed operation runs', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...opsRoutes() });
    await h.mount(<TestApp entry="/services/Music/wave"><ServiceDetail /></TestApp>);
    await h.waitFor(() => text().includes('Operations'), 'the operations section');
    const restart = qa('button').find((b) => text(b).trim() === 'Restart');
    expect(!!restart, 'no Restart control was offered for a running container');
    click(restart!);
    await h.flush(60);
    // asking is a dry-run: it evaluates, and it is the only request made so far
    await h.waitFor(() => !!h.lastCall('POST', '/api/v1/operations/dry-run'), 'the dry-run request');
    expect(!h.lastCall('POST', '/api/v1/operations'), 'clicking the button executed something before confirmation');
    const asked = h.lastCall('POST', '/api/v1/operations/dry-run')!.body as { action: string; target: { id: string } };
    expect(asked.action === 'container.restart' && asked.target.id === 'wave', 'the request named the wrong action or target');
    expect(Object.keys(asked).sort().join(',') === 'action,target', `the request carried unexpected fields: ${Object.keys(asked).join(',')}`);
    // the dialog shows the server's own checks before it offers to run anything
    await h.waitFor(() => text().includes('Registered action'), 'the dry-run checks');
    expect(text().includes('Wave'), 'the dialog does not name the target');
    click(q('.modal-foot button')!);                       // Cancel
    await h.flush(20);
    expect(!h.lastCall('POST', '/api/v1/operations'), 'cancelling ran the operation anyway');
    // confirmed: the token the server issued is what gets spent, and nothing else
    click(qa('button').find((b) => text(b).trim() === 'Restart')!);
    await h.waitFor(() => !!confirmButton(), 'the confirm button');
    click(confirmButton()!);
    await h.waitFor(() => !!h.lastCall('POST', '/api/v1/operations'), 'the execute request');
    const sent = h.lastCall('POST', '/api/v1/operations')!.body as Record<string, unknown>;
    expect(sent.confirmationToken === 'tok-fixture', 'the execution did not spend the token the server issued');
    expect(!('confirmed' in sent), 'the browser sent a “confirmed” flag — the server must decide that');
    expect(Object.keys(sent).sort().join(',') === 'action,confirmationToken,operationId,target', `unexpected execute fields: ${Object.keys(sent).join(',')}`);
    // and the result is the state the engine reported back, not an assumption
    await h.waitFor(() => /verified running|Restarted/i.test(text()), 'the verified outcome');
    expect(!/unproven/i.test(text()), 'a verified operation reported an unproven outcome');
  });

  await test('operations: a refusal is shown as a refusal, and nothing is sent afterwards', async (h) => {
    const refusal = { code: 'not_permitted', reason: 'Your account is not allowed to stop containers.' };
    // the server answers a refused dry-run with a non-200 that still carries the operation record
    h.setRoutes({
      ...stubRoutes(),
      '/api/v1/operations': (body: unknown) => (body ? { operation: opsRecord('running') } : opsOverview({ permitted: ['container.start'] })),
      '/api/v1/operations/dry-run': { $status: 403, body: { operation: opsRecord('rejected', { action: 'container.stop', error: refusal }), error: refusal.reason, code: refusal.code } },
      '/api/v1/operations/op-fixture': () => ({ operation: opsRecord('rejected', { action: 'container.stop', error: refusal }) }),
    });
    await h.mount(<TestApp entry="/services/Music/wave"><ServiceDetail /></TestApp>);
    await h.waitFor(() => !!qa('button').find((b) => text(b).trim() === 'Stop'), 'a Stop control');
    click(qa('button').find((b) => text(b).trim() === 'Stop')!);
    await h.waitFor(() => /not allowed to stop/i.test(text()), 'the refusal reason');
    expect(text().includes('Nothing was changed'), 'the dialog does not say that nothing happened');
    expect(!h.lastCall('POST', '/api/v1/operations'), 'a refused operation was executed anyway');
    expect(!confirmButton(), 'a refused operation still offers a confirm button');
  });

  await test('operations: a viewer is offered no controls and is told why', async (h) => {
    h.setRoutes({ ...stubRoutes(), '/api/v1/operations': opsOverview({ permitted: [], role: 'viewer' }) });
    await h.mount(<TestApp entry="/services/Music/wave"><ServiceDetail /></TestApp>);
    await h.waitFor(() => text().includes('Operations'), 'the operations section');
    await h.flush(60);
    expect(!qa('button').some((b) => /^(Start|Restart|Stop)$/.test(text(b).trim())), 'a viewer was offered an operation control');
    expect(/not allowed to run operations/i.test(text()), 'the page does not say why there are no controls');
  });

  await test('operations: a timeout is reported as unproven, never as a success', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...opsRoutes(opsOverview(), { finalStatus: 'timed_out' }) });
    await h.mount(<TestApp entry="/services/Music/wave"><ServiceDetail /></TestApp>);
    await h.waitFor(() => !!qa('button').find((b) => text(b).trim() === 'Restart'), 'a Restart control');
    click(qa('button').find((b) => text(b).trim() === 'Restart')!);
    await h.waitFor(() => !!confirmButton(), 'the confirm button');
    click(confirmButton()!);
    await h.waitFor(() => /unproven|timed out/i.test(text()), 'the unproven outcome');
    expect(!/verified running/i.test(text()), 'a timed-out operation claimed a verified outcome');
  });

  await test('operations: the command palette opens a confirmation instead of running anything', async (h) => {
    const search = [
      { title: 'Restart Wave', subtitle: 'Operation · Restart a running container.', href: '/services/Music/wave', kind: 'operation', operation: { action: 'container.restart', target: { type: 'service', id: 'wave', group: 'Music' }, confirmation: 'normal', risk: 'medium' } },
    ];
    h.setRoutes({ ...stubRoutes(), ...opsRoutes(), '/api/search': { query: '', results: search } });
    await h.mount(<TestApp><SearchHost /></TestApp>);
    key(window, '/');
    await h.flush(40);
    await type(searchInput()!, 'restart wave');
    await h.waitFor(() => text().includes('Restart Wave'), 'the operation result');
    await h.flush(260);
    expect(text().includes('Operations'), 'operation results are not grouped under Operations');
    key(window, 'Enter');
    await h.waitFor(() => !!h.lastCall('POST', '/api/v1/operations/dry-run'), 'the dry-run request');
    expect(!h.lastCall('POST', '/api/v1/operations'), 'choosing a palette result executed the operation');
    await h.waitFor(() => text().includes('Registered action'), 'the confirmation dialog');
  });

  await test('settings: the operations pane reports the engine and offers no switch', async (h) => {
    h.setRoutes({ ...stubRoutes(), '/api/v1/operations': opsOverview() });
    await h.mount(<TestApp entry="/settings/operations"><Settings /></TestApp>);
    await h.waitFor(() => text().includes('engine reachable'), 'the engine status');
    expect(text().includes('Restart') && text().includes('Stop'), 'the pane does not list the registered actions');
    expect(/audit/i.test(text()), 'the pane never mentions the audit trail');
    expect(!qa('input[type=checkbox]').length, 'the operations pane offers a toggle — none of this is configurable');
    expect(/no shell or command execution/i.test(text()), 'the boundaries are not stated in plain words');
    expect(/no Docker API passthrough/i.test(text()), 'the passthrough boundary is not stated');
  });

  /* ---------------- Phase 10A: monitoring ---------------- */

  await test('monitoring: the page is a list with real counts, and a stale engine says so', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...monitoringRoutes() });
    await h.mount(<TestApp entry="/monitoring"><MonitoringPage /></TestApp>);
    await h.waitFor(() => text().includes('Paperless'), 'the monitor list');
    // counts come from the document, not from counting rows in the browser
    expect(/Total/.test(text()) && /Paused/.test(text()), 'the counts strip is missing');
    expect(text().includes('Down') && text().includes('Up'), 'the counts strip lost its words');
    // a monitor's own words, never a colour alone
    expect(text().includes('Down'), 'the down monitor is not labelled as down');
    expect(text().includes('Paused'), 'a paused monitor is not labelled as paused');
    expect(/never checked|checked /.test(text()), 'no row says when it was last checked');
    // the group it belongs to comes from the service reference, not from a hardcoded list
    expect(text().includes('Media') || text().includes('Endpoints'), 'monitors are not grouped');
    // the scope of what it reaches is stated, not implied: an internal target is labelled as one
    expect(/internal/.test(text()), 'the address scope is not stated anywhere');
    // and the page never runs a check by being opened
    expect(!h.writes('POST', '/api/monitoring/monitors/mon-fixture0001/check').length, 'merely opening the page ran a check');
  });

  await test('monitoring: a stopped engine marks its data as a recording, not as current', async (h) => {
    const stopped = {
      ...monitoringOverview,
      engine: { ...monitoringOverview.engine, state: 'stopped', reason: 'The engine was stopped.', stale: true },
    };
    h.setRoutes({ ...stubRoutes(), ...monitoringRoutes({ '/api/monitoring': stopped }) });
    await h.mount(<TestApp entry="/monitoring"><MonitoringPage /></TestApp>);
    await h.waitFor(() => /Monitoring is stopped/i.test(text()), 'the stopped-engine line');
    expect(/last recorded state|not presented as current|last recorded/i.test(text()), 'a stopped engine did not say its data is a recording');
  });

  await test('monitoring: adding a monitor sends a name and a service, never a container id or a raw host', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...monitoringRoutes() });
    await h.mount(<TestApp entry="/monitoring"><MonitoringPage /></TestApp>);
    await h.waitFor(() => !!qa('button').find((b) => text(b).trim() === 'Add monitor'), 'the Add control');
    click(qa('button').find((b) => text(b).trim() === 'Add monitor')!);
    await h.waitFor(() => !!dialog(), 'the add dialog');
    // choose the discovered service rather than typing a URL — the preferred path
    const nameInput = qa<HTMLInputElement>('.modal input.input')[0];
    type(nameInput, 'Jellyfin web');
    const select = q<HTMLSelectElement>('.modal select.input');
    expect(!!select, 'there is no way to pick a discovered service');
    const picked = servicesDoc.services.find((s) => s.url)!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select!, `${picked.group}/${picked.name}`);
      select!.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await h.flush(10);
    click(qa('.modal-foot button').find((b) => text(b).trim() === 'Add monitor')!);
    await h.waitFor(() => !!h.lastCall('POST', '/api/monitoring/monitors'), 'the create request');
    const sent = h.lastCall('POST', '/api/monitoring/monitors')!.body as { monitor: { name: string; type: string; target: Record<string, unknown> } };
    expect(sent.monitor.name === 'Jellyfin web', `unexpected name ${sent.monitor.name}`);
    expect(JSON.stringify(sent.monitor.target).includes('"service"'), 'the target did not carry a service reference');
    expect(!/container|id"?:"[0-9a-f]{12}/.test(JSON.stringify(sent.monitor.target)), 'the browser sent something that looks like a container id');
    expect(!/socketPath|docker/i.test(JSON.stringify(sent.monitor)), 'the browser sent a Docker detail');
  });

  await test('monitoring: a refusal from the server is shown in place, and nothing is retried', async (h) => {
    h.setRoutes({
      ...stubRoutes(),
      ...monitoringRoutes({
        '/api/monitoring/monitors': (body: unknown) => (body
          ? { $status: 400, body: { error: 'Endpoint points at link-local space, which monitors never reach.', code: 'blocked_address' } }
          : monitoringOverview),
      }),
    });
    await h.mount(<TestApp entry="/monitoring"><MonitoringPage /></TestApp>);
    await h.waitFor(() => !!qa('button').find((b) => text(b).trim() === 'Add monitor'), 'the Add control');
    click(qa('button').find((b) => text(b).trim() === 'Add monitor')!);
    await h.waitFor(() => !!dialog(), 'the add dialog');
    type(qa<HTMLInputElement>('.modal input.input')[0], 'Metadata');
    click(qa('.modal-foot button').find((b) => text(b).trim() === 'Add monitor')!);
    await h.waitFor(() => /link-local space/i.test(text()), 'the refusal reason');
    expect(h.writes('POST', '/api/monitoring/monitors').length === 1, 'the browser retried a refused create');
    expect(!!dialog(), 'the dialog closed on a refusal, losing the form');
  });

  await test('monitoring: a filter narrows the list and says so', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...monitoringRoutes() });
    await h.mount(<TestApp entry="/monitoring"><MonitoringPage /></TestApp>);
    await h.waitFor(() => text().includes('Paperless'), 'the monitor list');
    click(qa('.mon-filters button').find((b) => text(b).trim() === 'Down')!);
    await h.flush(10);
    expect(text().includes('Paperless'), 'the down monitor vanished when filtering for down');
    expect(!text().includes('Jellyfin'), 'an up monitor survived a filter for down');
    expect(/2 of 3|1 of 3/.test(text()), 'the filter does not say how much of the list it is showing');
  });

  await test('monitoring: incidents are real records with a real duration', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...monitoringRoutes() });
    await h.mount(<TestApp entry="/monitoring/incidents"><MonitoringPage /></TestApp>);
    await h.waitFor(() => text().includes('Paperless'), 'the incident list');
    expect(/open \d|recovered|\d+m \d+s/.test(text()), 'the incident has no duration');
    expect(text().includes('No connection (refused).'), 'the incident does not carry the reason it was opened');
    expect(!/100% uptime|all systems/i.test(text()), 'the incidents view invented a reassurance');
  });

  await test('monitoring: the detail page shows recorded history, and offers no fabricated numbers', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...monitoringRoutes() });
    await h.mount(<TestApp entry="/monitoring/mon-fixture0002"><MonitorDetailPage /></TestApp>);
    await h.waitFor(() => text().includes('Paperless'), 'the monitor detail');
    await h.flush(30);
    expect(/88\.2%|88\.2/.test(text()), 'the recorded uptime is not shown');
    expect(/61 \/ 30 \/ 900 ms|—/.test(text()), 'the latency figures are missing');
    expect(/recorded check/.test(text()), 'the graph does not say how many checks it drew');
    expect(/open \d/.test(text()), 'the open incident has no duration');
    // pausing is an action, and it is sent to the monitor's own endpoint
    click(qa('button').find((b) => text(b).trim() === 'Pause')!);
    await h.waitFor(() => !!h.lastCall('POST', '/api/monitoring/monitors/mon-fixture0002/pause'), 'the pause request');
    expect(!h.lastCall('POST', '/api/v1/operations'), 'monitoring reached the operations engine');
  });

  await test('monitoring: maintenance is explicit, bounded, and ends from the same place', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...monitoringRoutes() });
    await h.mount(<TestApp entry="/monitoring/mon-fixture0002"><MonitorDetailPage /></TestApp>);
    await h.waitFor(() => !!qa('button').find((b) => text(b).trim() === 'Start maintenance'), 'the maintenance control');
    // only the offered durations — there is no free-form "until" and no calendar
    const options = qa('.mon-maintenance option').map((o) => text(o).trim());
    expect(options.length >= 3 && options.every((o) => /minute|hour|day/.test(o)), `unexpected maintenance choices: ${options.join(', ')}`);
    type(qa<HTMLInputElement>('.mon-maintenance input.input')[0], 'disk swap');
    click(qa('button').find((b) => text(b).trim() === 'Start maintenance')!);
    await h.waitFor(() => !!h.lastCall('POST', '/api/monitoring/monitors/mon-fixture0002/maintenance'), 'the maintenance request');
    const sent = h.lastCall('POST', '/api/monitoring/monitors/mon-fixture0002/maintenance')!.body as { until: number; reason: string };
    expect(sent.until > Date.now(), 'the maintenance window is in the past');
    expect(sent.until - Date.now() <= 24 * 3600_000 + 5000, 'the browser asked for a window longer than a day');
    expect(sent.reason === 'disk swap', 'the reason was not sent');
  });

  await test('monitoring: settings shows the server bounds and offers no way to widen them', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...monitoringRoutes() });
    await h.mount(<TestApp entry="/settings/monitoring"><Settings /></TestApp>);
    await h.waitFor(() => text().includes('Concurrent checks'), 'the defaults pane');
    expect(/server bound 10–86400/.test(text().replace(/,/g, '')), 'the interval bounds are not shown');
    expect(/server bound 1–8/.test(text()), 'the concurrency bound is not shown');
    expect(/public endpoints only|internal targets/i.test(text()), 'the internal-target policy is not stated');
    expect(/no container is started, stopped or restarted|never/i.test(text()), 'the pane does not state what monitoring cannot do');
    // saving sends the settings object and nothing else
    click(qa('button').find((b) => text(b).trim() === 'Save defaults')!);
    await h.waitFor(() => !!h.lastCall('PUT', '/api/monitoring/settings'), 'the settings write');
    const sent = h.lastCall('PUT', '/api/monitoring/settings')!.body as { settings: Record<string, unknown> };
    expect(typeof sent.settings.intervalMs === 'number' && typeof sent.settings.allowInternal === 'boolean', 'the settings payload is incomplete');
    expect(!('bounds' in sent.settings), 'the browser sent the bounds back to the server');
  });

  await test('monitoring: a service page shows what watches it, and offers to watch it', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...monitoringRoutes() });
    await h.mount(<TestApp entry="/services/Music/wave"><ServiceDetail /></TestApp>);
    await h.waitFor(() => text().includes('Monitoring'), 'the monitoring block');
    await h.flush(40);
    expect(/Nothing watches|mon-row|monitor/i.test(text()), 'the block says nothing about monitors');
    const link = qa('a').find((a) => text(a).trim() === 'Configure a monitor');
    expect(!!link, 'there is no way to configure a monitor from the service page');
    expect(/\/monitoring\?service=/.test(link!.getAttribute('href') || ''), 'the configure link does not name the service');
    // and the service page did not become a monitoring engine
    expect(!h.writes('POST', '/api/monitoring/monitors').length, 'the service page created a monitor on its own');
  });

  await test('search: monitors and incidents are destinations, not triggers', async (h) => {
    const search = [
      { title: 'Paperless monitor', subtitle: 'tcp · down', href: '/monitoring/mon-fixture0002', kind: 'monitor', status: 'down' },
      { title: 'Paperless incident', subtitle: 'open since 14:02', href: '/monitoring/mon-fixture0002', kind: 'incident', status: 'down' },
    ];
    h.setRoutes({ ...stubRoutes(), ...monitoringRoutes(), '/api/search': { query: 'paperless', results: search } });
    await h.mount(<TestApp><SearchHost /></TestApp>);
    key(window, '/');
    await h.flush(40);
    await type(searchInput()!, 'paperless');
    await h.waitFor(() => text().includes('Paperless monitor'), 'the monitor result');
    expect(text().includes('Monitors'), 'monitor results are not grouped under Monitors');
    expect(text().includes('Incidents'), 'incident results are not grouped under Incidents');
    key(window, 'Enter');
    await h.flush(30);
    expect(!h.writes('POST', '/api/monitoring/monitors').length, 'selecting a monitor result created something');
    expect(!h.lastCall('POST', '/api/monitoring/monitors/mon-fixture0002/check'), 'selecting a monitor result ran a check');
  });

  await test('the Hub shows a monitor summary, and keeps working when monitoring is unavailable', async (h) => {
    const withMonitoring = layoutWith([
      { id: 'monitoring', type: 'monitoring', zone: 'main', size: 'md', visible: true, config: {} },
      { id: 'services', type: 'services', zone: 'main', size: 'lg', visible: true, config: {} },
    ]);
    h.setRoutes({
      ...stubRoutes(),
      ...monitoringRoutes(),
      '/api/layout': withMonitoring,
      '/api/widgets': { catalogue: [...catalogue, { type: 'monitoring', category: 'grid', title: 'Monitoring', description: 'What OpusHub watches', zone: 'main', size: 'md', sizes: ['sm', 'md'], config: [] }], widgets: withMonitoring.hub.widgets, spacing: withMonitoring.hub.spacing },
    });
    await h.mount(<TestApp><Hub /></TestApp>);
    await h.waitFor(() => text().includes('Down'), 'the monitoring widget');
    expect(text().includes('Paused'), 'the widget does not distinguish paused from down');
    expect(/Total/.test(text()), 'the widget summary has no totals');

    // and the same widget with the engine unavailable: it says so, and the rest of the Hub is intact
    const broken = await createHarness({ routes: { ...stubRoutes(), ...monitoringRoutes(), '/api/monitoring': () => { throw new Error('offline'); }, '/api/layout': withMonitoring } });
    try {
      await broken.mount(<TestApp><Hub /></TestApp>);
      await broken.waitFor(() => text().includes('Monitoring is unavailable') || /unavailable/i.test(text()), 'the unavailable state');
      expect(text().includes('Services') || qa('.hub-widget').length > 0, 'one failed widget took the Hub with it');
    } finally {
      await broken.unmount();
    }
  });

  /* ==================================================================
     Phase 10B — the notification center, as a person meets it
     ================================================================== */

  const notif = (over: Record<string, unknown> = {}) => ({
    id: 'n1', eventId: 'evt-1', t: Date.now() - 60_000, type: 'monitor.state_changed',
    severity: 'warning', source: 'monitoring', title: 'Monitor status changed: Jellyfin',
    message: 'Jellyfin is down', href: '/monitoring/m1', read: false, readAt: null, ...over,
  });

  /** A notification backend that behaves like the real one: reads reflect writes. */
  function notificationRoutes(items: ReturnType<typeof notif>[]) {
    const state = { items };
    const doc = () => ({
      notifications: state.items, count: state.items.length,
      unread: state.items.filter((n) => !n.read).length, total: state.items.length,
    });
    const routes: Record<string, unknown | ((body: unknown, path: string) => unknown)> = {
      '/api/notifications': () => doc(),
      '/api/notifications/unread-count': () => ({ unread: state.items.filter((n) => !n.read).length, total: state.items.length }),
      '/api/notifications/read-all': () => {
        for (const n of state.items) { n.read = true; n.readAt = Date.now(); }
        return { ok: true, changed: state.items.length, total: state.items.length };
      },
    };
    for (const n of state.items) {
      routes[`/api/notifications/${n.id}/read`] = () => {
        n.read = true; n.readAt = Date.now();
        return { ok: true, notification: n };
      };
    }
    return routes;
  }

  const bellButton = () => q<HTMLButtonElement>('button[aria-label^="Notifications"]');

  /* 10B-1 — the bell toggles the panel; Escape and outside-click close it; focus returns */
  await test('notifications: the bell toggles a portalled panel, Escape and outside-click close it', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...notificationRoutes([notif()]) });
    await h.mount(<MemoryRouter><NotificationBell /></MemoryRouter>);
    await h.waitFor(() => !!bellButton(), 'the bell');
    const bell = bellButton()!;
    expect(!q('.notif-panel'), 'the panel renders before it is opened');
    click(bell);
    await h.waitFor(() => !!q('.notif-panel'), 'the panel to open');
    expect(q('.notif-panel')!.parentElement === document.body, 'the panel is not portalled to the document body');
    expect(bell.getAttribute('aria-expanded') === 'true', 'aria-expanded did not follow the panel');
    expect(bell.getAttribute('aria-haspopup') === 'dialog', 'the bell does not announce its dialog');
    expect(q('.notif-panel')!.getAttribute('role') === 'dialog', 'the panel is not a dialog');
    click(bell);
    await h.flush(30);
    expect(!q('.notif-panel'), 'clicking the bell again did not close the panel');
    click(bell);
    await h.waitFor(() => !!q('.notif-panel'), 'the panel to reopen');
    key(window, 'Escape');
    await h.flush(30);
    expect(!q('.notif-panel'), 'Escape did not close the panel');
    expect(document.activeElement === bell, 'focus did not return to the bell');
    click(bell);
    await h.waitFor(() => !!q('.notif-panel'), 'the panel to reopen a second time');
    await act(async () => { document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); });
    await h.flush(30);
    expect(!q('.notif-panel'), 'a click outside did not close the panel');
  });

  /* 10B-2 — the badge is live, honest, and hidden at zero */
  await test('notifications: the badge shows the unread count and hides at zero', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...notificationRoutes([notif(), notif({ id: 'n2', eventId: 'evt-2' }), notif({ id: 'n3', eventId: 'evt-3', read: true })]) });
    await h.mount(<MemoryRouter><NotificationBell /></MemoryRouter>);
    await h.waitFor(() => !!q('.notif-badge'), 'the badge');
    expect(text(q('.notif-badge')!).trim() === '2', `the badge should read 2, got “${text(q('.notif-badge')!)}”`);
    expect(bellButton()!.getAttribute('aria-label') === 'Notifications, 2 unread', 'the accessible label does not carry the count');
  });

  await test('notifications: no badge at zero unread', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...notificationRoutes([notif({ read: true })]) });
    await h.mount(<MemoryRouter><NotificationBell /></MemoryRouter>);
    await h.waitFor(() => !!bellButton(), 'the bell');
    await h.flush(50);
    expect(!q('.notif-badge'), 'a badge renders with nothing unread');
    expect(bellButton()!.getAttribute('aria-label') === 'Notifications', 'the zero-state label is wrong');
  });

  /* 10B-3 — rows carry severity/source/type/time; mark-read commits and refreshes the badge */
  await test('notifications: rows show their provenance and marking read clears them', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...notificationRoutes([notif(), notif({ id: 'n2', eventId: 'evt-2', severity: 'critical', type: 'alert.created', source: 'alerts', title: 'Alert: disk full', href: null })]) });
    await h.mount(<MemoryRouter><NotificationBell /></MemoryRouter>);
    await h.waitFor(() => !!bellButton(), 'the bell');
    click(bellButton()!);
    await h.waitFor(() => qa('.notif-row').length === 2, 'both rows');
    expect(text().includes('Monitor status changed: Jellyfin'), 'the first title is missing');
    expect(text().includes('Alert: disk full'), 'the second title is missing');
    expect(text().includes('monitor.state_changed') && text().includes('alert.created'), 'event types are not shown');
    expect(text().includes('monitoring') && text().includes('alerts'), 'sources are not shown');
    expect(text().includes('warning') && text().includes('critical'), 'severities are not shown');
    expect(!!q('.notif-row [title]'), 'no timestamp carries the absolute time');
    // mark the first row read: the write is committed, the row goes quiet, the badge drops
    const reads = qa('.notif-row').map((row) => q('button', row)).filter(Boolean) as HTMLElement[];
    expect(reads.length === 2, 'each unread row should offer “Read”');
    click(reads[0]);
    await h.waitFor(() => (h.lastCall('POST', '/api/notifications/n1/read') ? true : false), 'the mark-read write');
    await h.waitFor(() => !q('.notif-badge') || text(q('.notif-badge')!).trim() === '1', 'the badge to drop to 1');
    const remaining = qa('.notif-row').map((row) => q('button', row)).filter(Boolean);
    expect(remaining.length === 1, 'the read row still offers “Read”');
  });

  /* 10B-4 — mark-all-read commits once and clears the badge */
  await test('notifications: mark-all-read commits once and clears the badge', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...notificationRoutes([notif(), notif({ id: 'n2', eventId: 'evt-2' })]) });
    await h.mount(<MemoryRouter><NotificationBell /></MemoryRouter>);
    await h.waitFor(() => !!q('.notif-badge'), 'the badge');
    click(bellButton()!);
    await h.waitFor(() => qa('.notif-row').length === 2, 'both rows (the action enables once loaded)');
    const all = qa('.notif-panel button').find((b) => text(b).includes('Mark all read'))!;
    expect((all as HTMLButtonElement).disabled === false, 'mark-all-read stays disabled with unread rows');
    click(all);
    await h.waitFor(() => h.writes('POST', '/api/notifications/read-all').length === 1, 'the single read-all write');
    await h.waitFor(() => !q('.notif-badge'), 'the badge to clear');
  });

  /* 10B-5 — only safe internal hrefs become links */
  await test('notifications: external hrefs never become links', async (h) => {
    h.setRoutes({
      ...stubRoutes(),
      ...notificationRoutes([
        notif({ href: '/monitoring/m1' }),
        notif({ id: 'n2', eventId: 'evt-2', href: 'https://evil.example/steal' }),
        notif({ id: 'n3', eventId: 'evt-3', href: '//evil.example/protocol-relative' }),
      ]),
    });
    await h.mount(<MemoryRouter><NotificationBell /></MemoryRouter>);
    await h.waitFor(() => !!bellButton(), 'the bell');
    click(bellButton()!);
    await h.waitFor(() => qa('.notif-row').length === 3, 'all three rows');
    const links = qa('.notif-row a');
    expect(links.length === 1, `${links.length} links rendered, expected exactly the internal one`);
    expect(links[0].getAttribute('href') === '/monitoring/m1', 'the surviving link is not the internal one');
    expect(!text().includes('evil.example'), 'an external URL leaked into the panel');
  });

  /* 10B-6 — live events refresh silently: no duplicates, no read reset, no stray refreshes */
  await test('notifications: a live event refreshes the list without duplicating or resurrecting', async (h) => {
    const items = [notif(), notif({ id: 'n2', eventId: 'evt-2', read: true })];
    h.setRoutes({ ...stubRoutes(), ...notificationRoutes(items) });
    await h.mount(<MemoryRouter><NotificationBell /></MemoryRouter>);
    await h.waitFor(() => !!bellButton(), 'the bell');
    click(bellButton()!);
    await h.waitFor(() => qa('.notif-row').length === 2, 'both rows');
    const gets = () => h.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/notifications?')).length;
    const before = gets();
    await act(async () => {
      __emitLiveEventForTests({ id: 'evt-live-10b-6', t: Date.now(), type: 'alert.created', severity: 'critical', source: 'alerts', message: 'something happened' });
    });
    await h.waitFor(() => gets() > before, 'the silent refresh after the live event');
    await h.flush(30);
    expect(qa('.notif-row').length === 2, 'the refresh duplicated rows');
    expect(qa('.notif-row').filter((row) => !q('button', row)).length === 1, 'the refresh resurrected a read row');
    // an event type the server never turns into a notification causes no refresh at all
    const steady = gets();
    await act(async () => {
      __emitLiveEventForTests({ id: 'evt-live-10b-6b', t: Date.now(), type: 'system.boot', severity: 'info', source: 'system', message: 'booted' });
    });
    await h.flush(60);
    expect(gets() === steady, 'a non-notifiable event triggered a refresh');
    // a duplicate delivery of the same event id is swallowed, not re-fetched
    await act(async () => {
      __emitLiveEventForTests({ id: 'evt-live-10b-6', t: Date.now(), type: 'alert.created', severity: 'critical', source: 'alerts', message: 'something happened' });
    });
    await h.flush(60);
    expect(gets() === steady, 'a duplicate event id triggered a second refresh');
  });

  /* 10B-7 — the panel says whether it is live, reconnecting, or polling */
  await test('notifications: the panel shows live, reconnecting, and polling states', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...notificationRoutes([notif()]) });
    await h.mount(<MemoryRouter><NotificationBell /></MemoryRouter>);
    await h.waitFor(() => !!bellButton(), 'the bell');
    click(bellButton()!);
    await h.waitFor(() => !!q('.notif-panel'), 'the panel');
    await act(async () => { __setLiveStatusForTests('live'); });
    await h.flush(20);
    expect(text(q('.notif-live')!).includes('Live'), 'the live state is not shown');
    await act(async () => { __setLiveStatusForTests('connecting', 3); });
    await h.flush(20);
    expect(text(q('.notif-live')!).includes('Reconnecting'), 'the reconnecting state is not shown');
    await act(async () => { __setLiveStatusForTests('idle'); });
    await h.flush(20);
    expect(text(q('.notif-live')!).includes('Polling'), 'the polling fallback is not shown');
  });

  /* 10B-8 — safeHref is a pure gate: internal paths pass, everything else is null */
  await test('notifications: safeHref admits only internal paths', async () => {
    expect(safeHref('/monitoring/m1') === '/monitoring/m1', 'an internal path was refused');
    expect(safeHref('/') === '/', 'the root was refused');
    for (const bad of ['https://evil.example/', '//evil.example/x', 'javascript:alert(1)', 'data:text/html,x', '', null, undefined, 42]) {
      expect(safeHref(bad as never) === null, `${JSON.stringify(bad)} was admitted`);
    }
  });

  /* 10B-9 — the Telegram pane: masked token, preserve-on-blank, fixed test message */
  await test('settings: telegram config is masked, blank preserves, test uses the saved config', async (h) => {
    let saved = { enabled: false, chatId: '123456789', configured: true, hasToken: true, tokenMasked: '••••••••Dsaw' };
    const policyDoc = {
      enabled: true, minSeverity: 'info', allowedTypes: [], allowedSources: [],
      browser: { enabled: false, minSeverity: 'warning', allowedTypes: [], allowedSources: [] },
      webhook: { enabled: false, minSeverity: 'warning', allowedTypes: [], allowedSources: [] },
      telegram: { enabled: false, minSeverity: 'warning', allowedTypes: [], allowedSources: [] },
      inApp: { enabled: true, minSeverity: 'info', allowedTypes: [], allowedSources: [] },
    };
    h.setRoutes({
      ...stubRoutes(),
      '/api/notifications/policy': (body: unknown) => {
        if (body && typeof body === 'object') Object.assign(policyDoc.telegram, (body as { telegram?: object }).telegram || {});
        return { policy: policyDoc };
      },
      '/api/notifications/webhook': { webhook: { url: null, hasSecret: false, enabled: false, allowInternal: false, allowInsecure: false } },
      '/api/notifications/telegram': (body: unknown) => {
        if (body && typeof body === 'object') {
          const b = body as { botToken?: string | null; chatId?: string | null; enabled?: boolean };
          if (b.botToken) saved = { ...saved, hasToken: true, tokenMasked: '••••••••NEW!' };
          if (b.chatId !== undefined) saved = { ...saved, chatId: b.chatId };
          if (b.enabled !== undefined) saved = { ...saved, enabled: b.enabled };
        }
        return { telegram: saved };
      },
      '/api/notifications/telegram/test': { ok: true, result: { ok: true, code: 'sent', reason: 'Test message delivered.' } },
    });
    await h.mount(<TestApp entry="/settings/notifications"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('Telegram provider'), 'the telegram block');
    const section = qa('section').find((s) => q('h2', s)?.textContent === 'Telegram provider')!;
    expect(!!section, 'the telegram section is missing');
    const tokenInput = q<HTMLInputElement>('input[aria-label="Telegram bot token"]', section)!;
    expect(tokenInput.getAttribute('type') === 'password', 'the token field is not a password input');
    expect((tokenInput.getAttribute('placeholder') || '').includes('••••••••Dsaw'), 'the masked token is not shown as the placeholder');
    expect(tokenInput.value === '', 'the token field is pre-filled (the secret must never come back down)');
    expect(text(section).includes('api.telegram.org'), 'the fixed endpoint is not disclosed');
    // saving with a blank token preserves the secret — the write carries no botToken
    const saveBtn = qa('button', section).find((b) => text(b) === 'Save Telegram')!;
    click(saveBtn);
    await h.waitFor(() => h.writes('PUT', '/api/notifications/telegram').length === 1, 'the telegram save');
    expect(!('botToken' in (h.lastCall('PUT', '/api/notifications/telegram')!.body as object)), 'a blank token field overwrote the saved secret');
    // the write is recorded when it is sent — wait for the round-trip before the next save
    await h.waitFor(() => text(section).includes('Telegram saved'), 'the first save to settle');
    // typing a token sends it exactly once, then the field clears
    type(tokenInput, '999888:AAH-new-token-value-here-abcdefgh');
    click(saveBtn);
    await h.waitFor(() => h.writes('PUT', '/api/notifications/telegram').length === 2, 'the token save');
    expect((h.lastCall('PUT', '/api/notifications/telegram')!.body as { botToken: string }).botToken === '999888:AAH-new-token-value-here-abcdefgh', 'the typed token was not sent');
    await h.waitFor(() => q<HTMLInputElement>('input[aria-label="Telegram bot token"]', section)!.value === '', 'the token field to clear after save');
    // the test button POSTs with no steerable body and reports the outcome
    const testBtn = qa('button', section).find((b) => text(b) === 'Send test')!;
    click(testBtn);
    await h.waitFor(() => h.writes('POST', '/api/notifications/telegram/test').length === 1, 'the telegram test');
    await h.waitFor(() => text(section).includes('delivered'), 'the test outcome');
    // the channel severity commits through the shared policy
    const seg = q('[aria-label="Telegram min severity"]', section)!;
    click(qa('button', seg).find((b) => text(b) === 'Critical')!);
    await h.waitFor(() => h.writes('PUT', '/api/notifications/policy').length >= 1, 'the policy write');
    expect((h.lastCall('PUT', '/api/notifications/policy')!.body as { telegram: { minSeverity: string } }).telegram.minSeverity === 'critical', 'the telegram floor did not commit');
  });

  for (const r of results) {
    if (r.ok) { passed++; console.log(`✓ ${r.name}`); }
    else { failures.push(`${r.name}: ${r.detail}`); console.error(`✗ ${r.name} — ${r.detail}`); }
  }
  return { passed, failed: failures.length, failures };
}
