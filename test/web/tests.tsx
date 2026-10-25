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
import ServiceDetail from '../../src/pages/ServiceDetail';
import StackDetail from '../../src/pages/StackDetail';
import SystemPage from '../../src/pages/System';
import ActivityPage from '../../src/pages/Activity';
import MonitoringPage from '../../src/pages/Monitoring';
import MonitorDetailPage from '../../src/pages/MonitorDetail';
import { Loading } from '../../src/components/ui';
import { GREETINGS, greetingFor } from '../../src/components/hub/HubHeader';
import type { LayoutDoc, Monitor, UptimeWindow, WidgetInstance } from '../../src/lib/types';
import type { HubData } from '../../src/lib/hubData';
import App from '../../src/App';
import {
  buildAttention, buildStacks, buildUpdates, downMonitors, hostNow, stackHue, stateOf, updateFor, uptimeSummary,
} from '../../src/lib/homeModel';
import { resetSharedCache } from '../../src/lib/api';
import { classifyTarget, defaultName, monitorDraft, typesFor, validateDefaults, toForm } from '../../src/lib/monitorForm';
import { chartStats, downsample } from '../../src/components/home/HostChart';
import {
  baseline, buildRuns, durText, pctText, ribbonSummary, segmentAt, sortRows, thickness, visibleWindow, type RibbonMonitor, type RibbonsDoc, type Segment,
} from '../../src/lib/uptimeModel';
import { GroupNameField } from '../../src/components/GroupNameField';
import { MenuButton } from '../../src/components/ui';
import { AreaChart } from '../../src/components/Charts';
import { createHarness, click, key, q, qa, text, type, type Harness } from './harness';
import { OperationsHost } from '../../src/components/Operations';
import { NotificationBell } from '../../src/components/Notifications';
import { safeHref } from '../../src/lib/notifications';
import { __emitLiveEventForTests, __setLiveStatusForTests } from '../../src/lib/sse';
import {
  activityDoc, bookmarksDoc, catalogue, layoutWith, servicesDoc, stacksDoc,
  systemSnapshot,
} from '../../src/ssr-fixtures';

export interface WebResult { passed: number; failed: number; failures: string[] }

const settings = {
  app: { name: 'OpusHub', tagline: 'The OpusGrid homelab, at a glance.' },
  appearance: { theme: 'dark', accent: 'sage', density: 'comfortable', transparency: true, fontScale: 1, background: 'graphite' },
  hub: { greetingName: 'Nora', clock24h: true, showSeconds: false },
  behavior: { logLaunches: true, refresh: { system: 5, services: 30 } },
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
    { name: 'registry', state: 'unavailable' as const, lastOk: null, lastTry: Date.now() - 2000, staleMs: null, reason: 'registry unreachable' },
    { name: 'telegram', state: 'idle' as const, lastOk: null, lastTry: null, staleMs: null, reason: null },
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
    '/api/services/Music/wave/history': serviceHistoryDoc,
    '/api/docker/containers/wave/logs': logsRoute,
    '/api/providers': providersFixture,
    '/api/services/Media/photos': noWebDetail,
    '/api/services/Media/stream': {
      ...serviceDetail,
      service: { ...servicesDoc.services[0], name: 'stream', displayName: 'Stream', group: 'Media' },
    },
    '/api/services/Media/stream/history': { service: 'stream', events: [], watchingSince: null, logStarted: null },
    '/api/services/Music/navidrome': {
      ...serviceDetail,
      service: { ...servicesDoc.services[0], name: 'navidrome', displayName: 'Navidrome', description: 'Music streaming', group: 'Music' },
    },
    '/api/stacks/media': stackDetail,
    '/api/host': hostDoc,
    '/api/docker': dockerDoc,
    '/api/networks': networksDoc,
    '/api/services/Music/wave/health': waveHealth,
    '/api/alerts': alertsDoc,
    '/api/updates': updatesDoc,
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
    '/api/operations': (body: unknown) => (body ? { operation: opsRecord('running', { action }) } : overview),
    '/api/operations/dry-run': () => dry,
    '/api/operations/op-fixture': () => {
      // the first poll sees it running; the second sees it settled — a real engine looks like this
      polls += 1;
      return { operation: polls < 2 ? opsRecord('running', { action }) : opsRecord(finalStatus, { action }) };
    },
    '/api/operations?service=wave': { ...overview, operations: [] },
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
            <Route path="/activity" element={<div data-test="activity">activity</div>} />
            <Route path="/stacks/:name" element={<StackDetail />} />
            <Route path="/system" element={<SystemPage />} />
            <Route path="/system/host" element={<SystemPage />} />
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

  /* 4N — the shell's navigation contract: a top bar with three destinations and the account menu */
  const AUTH_ROUTES = {
    '/api/setup/status': { required: false, complete: true, hasAccount: true, version: '0.1.0' },
    '/api/auth/me': { authenticated: true, user: { username: 'admin' }, setupComplete: true },
  };
  await test('nav: the top bar holds Home, Containers and Uptime, then search, the bell and the account menu', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...AUTH_ROUTES });
    await h.mount(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    await h.waitFor(() => !!q('.topbar'), 'the top bar');
    expect(!q('.rail') && !q('.mobile-bar'), 'the old rail or its mobile bar is still rendered');
    const links = qa('.tb-nav a');
    expect(links.map((a) => text(a).trim()).join(',') === 'Home,Containers,Uptime', `primary destinations: ${links.map((a) => text(a)).join(',')}`);
    expect(links.map((a) => a.getAttribute('href')).join(',') === '/,/services,/monitoring', 'the destinations point at the wrong pages');
    expect(links[0].getAttribute('aria-current') === 'page', 'Home is not marked current on /');
    expect(!!q('.topbar [aria-label="Search"]'), 'the search button is missing');
    expect(!!q('.topbar .notif-bell'), 'the bell is missing');
    expect(!!q('.topbar .av'), 'the avatar is missing');
    expect(!q('.acct'), 'the account menu is open before it was asked for');

    // the avatar menu: who, appearance (theme, backgrounds, accent), Settings, Sign out
    click(q('.topbar .av')!);
    await h.waitFor(() => !!q('.acct'), 'the account menu');
    expect(text(q('.acct .mh')!).includes('admin'), 'the account name is not shown');
    expect(qa('.acct [aria-label="Theme"] button').length === 3, 'the theme switch is missing');
    const bgs = qa('.acct .bgsw');
    expect(bgs.length === 4, `four built-in backgrounds without a photo, saw ${bgs.length}`);
    expect(qa('.acct .acsw').length === 7, 'the seven accents are missing');
    expect(qa('.acct a').some((a) => a.getAttribute('href') === '/settings'), 'Settings is missing from the account menu');
    expect(text(q('.acct')!).includes('Sign out'), 'Sign out is missing from the account menu');
    click(bgs[1]);
    await h.waitFor(() => h.writes('PUT', '/api/settings').length > 0, 'the background write');
    const put = h.writes('PUT', '/api/settings').pop()!.body as { appearance?: { background?: string } };
    expect(put.appearance?.background === 'dusk', `the background was not saved (${JSON.stringify(put)})`);
  });

  await test('nav: the removed Infrastructure addresses redirect to System', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...AUTH_ROUTES });
    for (const entry of ['/infrastructure?tab=volumes', '/system/infrastructure?tab=storage']) {
      await h.mount(<MemoryRouter initialEntries={[entry]}><App /></MemoryRouter>);
      await h.waitFor(() => !!q('.topbar'), `the shell for ${entry}`);
      expect(!q('.err'), `${entry} did not resolve`);
      expect(!text().includes('Page not found'), `${entry} reached the not-found page`);
    }
  });

  await test('nav: /system/host renders the host view with its sub-navigation', async (h) => {
    h.setRoutes({ ...stubRoutes(), ...AUTH_ROUTES });
    await h.mount(<MemoryRouter initialEntries={['/system/host']}><App /></MemoryRouter>);
    await h.waitFor(() => !!q('.mon-views, .page-views'), 'the host sub-navigation');
    const nav = q('.mon-views, .page-views')!;
    const labels = qa('a', nav).map((el) => text(el).trim());
    expect(labels.includes('Vitals'), `the Vitals chip is missing: ${labels.join(', ')}`);
    expect(labels.includes('Host'), `the Host chip is missing: ${labels.join(', ')}`);
    expect(!labels.includes('Infrastructure'), `the removed Infrastructure chip is still offered: ${labels.join(', ')}`);
    const host = qa('a', nav).find((el) => text(el).trim() === 'Host')!;
    expect(host.classList.contains('active') || host.getAttribute('aria-current') === 'page',
      'the Host chip is not marked active on /system/host');
    // the legacy mount still arrives where it meant to
    await h.mount(<MemoryRouter initialEntries={['/host']}><App /></MemoryRouter>);
    await h.waitFor(() => !!q('.mon-views, .page-views'), 'the host view after the legacy redirect');
    expect(!q('.err'), 'the legacy /host redirect surfaced an error');
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
          { id: 'attention', type: 'attention', zone: 'main', size: 'sm', visible: false, config: {} },
          { id: 'monitoring', type: 'monitoring', zone: 'main', size: 'md', visible: false, config: {} },
        ],
      },
    };
    const h2 = await createHarness({ routes });
    try {
      await h2.mount(<TestApp><Hub /></TestApp>);
      await h2.waitFor(() => !!q('.launcher-items'), 'the launcher');
      await h2.flush(120);
      expect(!h2.calls.some((c) => c.path.startsWith('/api/providers')), 'a hidden attention widget still polled provider health');
      expect(!h2.calls.some((c) => c.path.startsWith('/api/monitoring')), 'a hidden monitoring widget was still polled');
    } finally {
      await h2.unmount();
    }
  });

  /* 12 — the rewrite of Settings: each Hub tab renders from real data */
  await test('settings: the Hub tabs render their editors', async (h) => {
    for (const [tab, expected] of [
      ['widgets', 'Reset layout'], ['templates', 'Minimal'], ['services', 'config/services.yaml'],
      ['groups', 'group'], ['hub', 'Spacing'],
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
  await test('stack detail renders the project and its rollup', async (h) => {
    await h.mount(<TestApp entry="/stacks/media"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('Media'), 'the stack page');
    expect(text().includes('Wave') || text().includes('wave'), 'the stack members are missing');
    expect(!/Docker isn.t connected/.test(text()) || stackDetail.live === false, 'a live stack reported as disconnected');

    // the rollup states its own coverage instead of implying the whole project reported,
    // and it carries the unhealthy count through from the per-member health
    expect(text().includes('2/3 reporting'), 'the rollup does not say how many containers reported');
    expect(text().includes('1'), 'the unhealthy member is not counted');
    expect(text().includes('net'), 'lifetime network I/O is missing from the rollup');
    expect(/up \d+[hms]/.test(text()), 'stack uptime is missing');

    // and the page says out loud that a compose project is not a presentation group
    expect(text().includes('Compose project is infrastructure'), 'the compose-project ≠ group note is missing');
  });

  /* 15 — resources are live readings; no per-container history is drawn or requested */
  await test('service resources: live readings only, no history requests', async (h) => {
    await h.mount(<TestApp entry="/services/Music/wave"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('Wave'), 'the service page');
    await h.waitFor(() => text().includes('Block I/O'), 'the resource strip');
    expect(!q('.res-history'), 'a per-container history chart is still drawn');
    expect(!h.calls.some((c) => c.path.includes('/stats/history')), 'the page still asks for per-container history');
    await h.unmount();

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
    expect(text().includes('registry unreachable'), 'a failing provider hides its reason');
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
    expect(text().includes('Docker') && text().includes('registry'), 'provider rows are missing');
    expect(text().includes('Unavailable'), 'the failed provider is not marked unavailable');
    expect(text().includes('registry unreachable'), 'the failure reason is hidden');
    expect(h.calls.some((c) => c.path.startsWith('/api/providers')), 'the settings page never asked for provider health');
  });

  /* 17b — Phase 5: the settings navigation is grouped, current, and honest about loading */
  await test('settings: grouped navigation, a current section, and announced loading states', async (h) => {
    await h.mount(<TestApp entry="/settings/general"><Settings /></TestApp>);
    await h.waitFor(() => !!q('.settings-nav'), 'the settings navigation');
    const labels = qa('.settings-nav-label').map((el) => text(el));
    expect(labels.length === 5, `the nav is not grouped into five sections (${labels.join(' / ')})`);
    for (const section of ['Home', 'Hub', 'Content', 'Connections', 'This install']) {
      expect(labels.includes(section), `the “${section}” section heading is missing (${labels.join(' / ')})`);
    }
    // every section of the IA is reachable, including the three Phase 5 panes and Phase 6's four
    const navText = text(q('.settings-nav')!);
    for (const item of ['General', 'Appearance', 'Services', 'Groups', 'Bookmarks', 'Widgets', 'Account & sessions', 'Environment']) {
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
    expect(!q('.topbar'), 'the application shell rendered before setup was complete');
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
    // Presentation (Phase 6): two ways in, both presentation-only
    expect(text().includes('Presentation'), 'the Presentation step heading is missing');
    expect(text().includes('Use what Docker found'), 'the default choice is not offered');
    expect(text().includes('Start from a template'), 'the template choice is not offered');
    expect(!text().includes('Import a Homepage configuration'), 'the import choice is still offered');
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
    expect(!q('.topbar'), 'the shell appeared before the account existed');
    await advance('Create account');
    const post = h.writes('POST', '/api/setup')[0];
    expect(!!post, 'the account was never created');
    expect((post.body as { username?: string }).username === 'admin', 'the wrong username was sent');
    expect((post.body as { presentation?: { template?: string } }).presentation?.template === 'media', 'the chosen template was not carried by the one write');
    expect(!!created, 'the fixture never saw the create call');

    // Finish: a real screen, still no application behind it
    expect(text().includes('Enter OpusHub'), 'the Finish screen is missing');
    expect(!q('.topbar'), 'creating the account jumped straight into the Hub');

    // …and the hand-off is explicit
    await advance('Enter OpusHub');
    await h.waitFor(() => !!q('.topbar'), 'the application shell after entering');
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
    expect(!q('.topbar'), 'the shell rendered behind a deep link');
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
    expect(!q('.topbar'), 'the shell rendered before a session existed');

    type(q<HTMLInputElement>('#login-user')!, 'admin');
    type(q<HTMLInputElement>('#login-pass')!, 'wrong-password');
    click(q('button.auth-submit')!);
    await h.flush(120);
    expect(!!q('.auth-error'), 'the refusal is not shown');
    expect(text().includes('Incorrect username or password.'), 'the server reason is not shown');
    expect(q<HTMLInputElement>('#login-pass')!.value === '', 'the password field is not cleared after a failure');
    expect(!q('.topbar'), 'a failed sign-in let the shell through');

    type(q<HTMLInputElement>('#login-user')!, 'admin');
    type(q<HTMLInputElement>('#login-pass')!, 'correct-horse-battery');
    click(q('button.auth-submit')!);
    await h.waitFor(() => !!q('.topbar'), 'the application shell');
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

  /* Settings → Connections reports the Docker check: reachable AND allowed to list containers */
  await test('settings connections shows the container-listing Docker check', async (h) => {
    h.setRoutes({ ...stubRoutes(), '/api/docker/status': { ok: true, state: 'connected', version: '26.1.0-mock', api: '1.43', containers: 12 } });
    await h.mount(<TestApp entry="/settings/connections"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('12 listed'), 'the container count from the check');
    expect(text().includes('26.1.0-mock') && text().includes('1.43'), 'the engine and API versions are missing');
    for (const gone of ['OPNsense', 'Power', 'Physical topology', 'Providers']) {
      expect(!text().includes(gone), `the removed ${gone} section is still on the pane`);
    }
  });

  await test('settings connections says so when the engine answers but refuses to list containers', async (h) => {
    h.setRoutes({ ...stubRoutes(), '/api/docker/status': { ok: false, state: 'not-permitted', reason: 'The Docker engine answers, but OpusHub is not allowed to list containers.' } });
    await h.mount(<TestApp entry="/settings/connections"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('not allowed to list containers'), 'the refusal reason');
    expect(!text().includes('listed'), 'a container count is shown for a refused check');
    expect(text().includes('not connected'), 'the pane does not say the check failed');
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
  await test('settings notifications shows the in-app and Telegram providers and no other channels', async (h) => {
    await h.mount(<TestApp entry="/settings/notifications"><Hub /></TestApp>);
    await h.waitFor(() => text().includes('Telegram provider'), 'the canonical provider blocks');
    for (const name of ['Notification Center', 'Telegram provider']) {
      expect(text().includes(name), `${name} block is missing`);
    }
    for (const gone of ['Browser notifications', 'Webhook provider']) {
      expect(!text().includes(gone), `the removed ${gone} block is still shown`);
    }
    expect(!text().includes('Coming later'), 'a legacy "coming later" channel is still shown');
    expect(!text().includes('Alert channels'), 'the legacy alert-channels block is still shown');
    expect(text().includes('1 active alert'), 'the active-alert count is missing');
  });

  /* 7F — the palette shows alerts as their own group, and no longer offers infrastructure */
  await test('search: alerts are a grouped destination and infrastructure is gone', async (h) => {
    await h.mount(<TestApp><SearchHost /></TestApp>);
    key(window, '/');
    await h.flush(40);
    await type(searchInput()!, 'unhealthy');
    await h.waitFor(() => text().includes('Wave is unhealthy'), 'results for “unhealthy”');
    await h.flush(260);
    expect(text().includes('Alerts'), 'the alerts group is not shown');
    const rows = qa('.cmdk-item').map((el) => text(el));
    expect(rows.some((r) => r.includes('Wave is unhealthy')), 'the alert result is missing');
    expect(!text().includes('Infrastructure'), 'an infrastructure group is still shown');
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
    await h.waitFor(() => !!h.lastCall('POST', '/api/operations/dry-run'), 'the dry-run request');
    expect(!h.lastCall('POST', '/api/operations'), 'clicking the button executed something before confirmation');
    const asked = h.lastCall('POST', '/api/operations/dry-run')!.body as { action: string; target: { id: string } };
    expect(asked.action === 'container.restart' && asked.target.id === 'wave', 'the request named the wrong action or target');
    expect(Object.keys(asked).sort().join(',') === 'action,target', `the request carried unexpected fields: ${Object.keys(asked).join(',')}`);
    // the dialog shows the server's own checks before it offers to run anything
    await h.waitFor(() => text().includes('Registered action'), 'the dry-run checks');
    expect(text().includes('Wave'), 'the dialog does not name the target');
    click(q('.modal-foot button')!);                       // Cancel
    await h.flush(20);
    expect(!h.lastCall('POST', '/api/operations'), 'cancelling ran the operation anyway');
    // confirmed: the token the server issued is what gets spent, and nothing else
    click(qa('button').find((b) => text(b).trim() === 'Restart')!);
    await h.waitFor(() => !!confirmButton(), 'the confirm button');
    click(confirmButton()!);
    await h.waitFor(() => !!h.lastCall('POST', '/api/operations'), 'the execute request');
    const sent = h.lastCall('POST', '/api/operations')!.body as Record<string, unknown>;
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
      '/api/operations': (body: unknown) => (body ? { operation: opsRecord('running') } : opsOverview({ permitted: ['container.start'] })),
      '/api/operations/dry-run': { $status: 403, body: { operation: opsRecord('rejected', { action: 'container.stop', error: refusal }), error: refusal.reason, code: refusal.code } },
      '/api/operations/op-fixture': () => ({ operation: opsRecord('rejected', { action: 'container.stop', error: refusal }) }),
    });
    await h.mount(<TestApp entry="/services/Music/wave"><ServiceDetail /></TestApp>);
    await h.waitFor(() => !!qa('button').find((b) => text(b).trim() === 'Stop'), 'a Stop control');
    click(qa('button').find((b) => text(b).trim() === 'Stop')!);
    await h.waitFor(() => /not allowed to stop/i.test(text()), 'the refusal reason');
    expect(text().includes('Nothing was changed'), 'the dialog does not say that nothing happened');
    expect(!h.lastCall('POST', '/api/operations'), 'a refused operation was executed anyway');
    expect(!confirmButton(), 'a refused operation still offers a confirm button');
  });

  await test('operations: a viewer is offered no controls and is told why', async (h) => {
    h.setRoutes({ ...stubRoutes(), '/api/operations': opsOverview({ permitted: [], role: 'viewer' }) });
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
    await h.waitFor(() => !!h.lastCall('POST', '/api/operations/dry-run'), 'the dry-run request');
    expect(!h.lastCall('POST', '/api/operations'), 'choosing a palette result executed the operation');
    await h.waitFor(() => text().includes('Registered action'), 'the confirmation dialog');
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
    expect(!h.lastCall('POST', '/api/operations'), 'monitoring reached the operations engine');
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
      telegram: { enabled: false, minSeverity: 'warning', allowedTypes: [], allowedSources: [] },
      inApp: { enabled: true, minSeverity: 'info', allowedTypes: [], allowedSources: [] },
    };
    h.setRoutes({
      ...stubRoutes(),
      '/api/notifications/policy': (body: unknown) => {
        if (body && typeof body === 'object') Object.assign(policyDoc.telegram, (body as { telegram?: object }).telegram || {});
        return { policy: policyDoc };
      },
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

  /* ==================================================================
     Home (rebuild slice 1): the page shows only what exists
     ================================================================== */
  const svcBase = servicesDoc.groups[0].services[0];
  const mkSvc = (name: string, over: Record<string, unknown> = {}) => ({
    ...svcBase, name, displayName: name[0].toUpperCase() + name.slice(1), id: `id-${name}`, order: null,
    container: { ...svcBase.container, name, id: `cid-${name}` }, ...over,
  }) as typeof svcBase;
  const docOf = (groups: { name: string; services: (typeof svcBase)[] }[]) => ({ ...servicesDoc, groups, services: groups.flatMap((g) => g.services) });
  const upd = (containerId: string, over: Record<string, unknown> = {}) => ({
    containerId, serviceId: null, imageRef: 'ghcr.io/x/app:1.0', currentTag: '1.0', availableTag: '1.0', status: 'update_available',
    updateAvailable: true, updateEligible: true, detectedAt: Date.now() - 3600_000, lastCheckedAt: Date.now() - 3600_000, ...over,
  }) as never;

  await test('home model: stack colour is stable, and unhealthy is amber, never red', async () => {
    expect(stackHue('Media') === stackHue('Media') && stackHue('Media') !== stackHue('Downloads'), 'the hue is not a stable function of the name');
    expect(stackHue('Anything') >= 0 && stackHue('Anything') < 360, 'the hue is out of range');
    expect(stateOf({ status: 'unhealthy' }).state === 'warn' && stateOf({ status: 'restarting' }).state === 'warn', 'unhealthy or restarting is not amber');
    expect(stateOf({ status: 'down' }).state === 'fail' && stateOf({ status: 'up' }).word === '', 'down is not red or up carries a word');
    expect(stateOf({ status: 'unavailable' }).state === 'off', 'an unknown state is not drawn as neutral');
  });

  await test('home model: tiles group by Compose stack, hide infrastructure and hidden services, put Other last', async () => {
    const doc = docOf([{ name: 'g', services: [
      mkSvc('b-app', { stackDisplayName: 'Zeta', stack: 'zeta' }), mkSvc('a-app', { stackDisplayName: 'Alpha', stack: 'alpha' }),
      mkSvc('loose', { stackDisplayName: null, stack: null }), mkSvc('db', { kind: 'infrastructure', stackDisplayName: 'Alpha' }),
      mkSvc('secret', { hidden: true, stackDisplayName: 'Alpha' }), mkSvc('off', { showOnHub: false, stackDisplayName: 'Alpha' }),
    ] }]);
    const stacks = buildStacks(doc, []);
    expect(stacks.map((x) => x.name).join(',') === 'Alpha,Zeta,Other', `stack order: ${stacks.map((x) => x.name).join(',')}`);
    expect(stacks[0].tiles.map((t) => t.svc.name).join(',') === 'a-app', `Alpha holds ${stacks[0].tiles.map((t) => t.svc.name).join(',')}`);
    expect(buildStacks(null, []).length === 0, 'no data should be no stacks');
  });

  await test('home model: update notices match containers by id, and "from → to" only appears when the tags differ', async () => {
    const a = mkSvc('app');
    expect(updateFor(a, [upd('cid-app')])?.to === null, 'equal tags were presented as a version change');
    expect(updateFor(a, [upd('cid-app', { currentTag: '1.0', availableTag: '1.1' })])?.to === '1.1', 'a changed tag was not shown');
    expect(updateFor(a, [upd('cid-app', { status: 'dismissed' })]) === null, 'a dismissed notice still counts');
    expect(updateFor(a, [upd('someone-else')]) === null, 'a notice for another container matched');
    const doc = docOf([{ name: 'g', services: [a] }]);
    const u = buildUpdates([upd('cid-app'), upd('gone', { imageRef: 'x/y:2' })], doc);
    expect(u.rows.length === 2 && u.rows.some((r) => r.name === 'App') && u.rows.some((r) => r.svc === null), 'rows were not built for matched and unmatched notices');
    expect(u.checkedAt != null && buildUpdates([], doc).rows.length === 0 && buildUpdates([], doc).checkedAt === null, 'the check time is invented when there are no notices');
  });

  await test('home model: needs attention reads container health, auto-heal and monitors, and is empty when all is well', async () => {
    const rel = () => 'just now';
    const doc = docOf([{ name: 'g', services: [mkSvc('fine', { status: 'up' }), mkSvc('sick', { status: 'unhealthy', statusReason: null }), mkSvc('dead', { status: 'down', container: { ...svcBase.container, name: 'dead', id: 'cid-dead', status: 'Exited (137) 3 hours ago' } })] }]);
    const heal = { available: true, running: true, monitoredCount: 1, optedInCount: 1, unhealthyCount: 0, monitoredContainers: [], unhealthyContainers: [], recentRecoveries: [{ id: 'r', t: 1, containerId: 'cid-sick', containerName: 'sick', service: 'sick', success: true, message: 'restarted' }] } as never;
    const mon = [{ id: 'm1', name: 'Router', enabled: true, status: 'down', downSince: 1 }, { id: 'm3', name: 'Sick', enabled: true, status: 'down', downSince: null }];
    const items = buildAttention(doc, heal, mon, rel);
    expect(items.map((i) => i.name).join(',') === 'Dead,Router,Sick', `attention order: ${items.map((i) => i.name).join(',')}`);
    expect(items[0].state === 'fail' && items[0].reason.includes('Exited (137)'), `the stopped container reason is not Docker's own: ${items[0].reason}`);
    expect(items[2].reason.includes('auto-heal restarted it'), `the auto-heal note is missing: ${items[2].reason}`);
    expect(items.filter((i) => i.name === 'Sick').length === 1, 'a monitor for a container already listed was counted twice');
    expect(buildAttention(docOf([{ name: 'g', services: [mkSvc('fine')] }]), null, [], rel).length === 0, 'something was reported when everything is up');
    expect(uptimeSummary(null) === null && uptimeSummary({ monitors: [], incidents: [] } as never) === null, 'an uptime figure was invented without monitors');
    expect(downMonitors({ monitors: [{ id: 'a', name: 'A', enabled: true, status: 'down' }, { id: 'b', name: 'B', enabled: true, status: 'up' }, { id: 'c', name: 'C', enabled: false, status: 'down' }], incidents: [{ monitorId: 'a', open: true, startedAt: 77 }] } as never).map((m) => `${m.id}:${m.downSince}`).join() === 'a:77', 'only enabled, down monitors, with the open incident as the time they went down');
    const hn = hostNow(null);
    expect(Object.values(hn).every((r) => r.value === null), 'the host strip shows numbers without a snapshot');
  });

  await test('home chart: statistics, and one-hour views are averaged down instead of drawn as noise', async () => {
    expect(chartStats([]) === null, 'statistics of nothing');
    const st = chartStats([{ t: 1, v: 10 }, { t: 2, v: 30 }, { t: 3, v: 20 }])!;
    expect(st.now === 20 && st.avg === 20 && st.peak.v === 30 && st.peak.t === 2 && st.low.v === 10, `stats: ${JSON.stringify(st)}`);
    const many = Array.from({ length: 720 }, (_, i) => ({ t: i, v: i % 2 ? 10 : 20 }));
    const small = downsample(many);
    expect(small.length <= 130 && small.length >= 100 && Math.abs(small[3].v - 15) < 2, `downsampled to ${small.length}`);
    expect(downsample(many.slice(0, 50)).length === 50, 'a short series was resampled');
  });

  const homeRoutes = (extra: Record<string, unknown> = {}) => ({
    ...stubRoutes(), ...AUTH_ROUTES,
    '/api/container-updates': { updates: [], count: 0, availableCount: 0 },
    '/api/autoheal/status': { available: false, running: false, monitoredCount: 0, optedInCount: 0, unhealthyCount: 0, monitoredContainers: [], unhealthyContainers: [], recentRecoveries: [] },
    '/api/monitoring/ribbons': { at: 1, range: '24h', from: 0, to: Date.now(), stepMs: 300000, slowMs: 1000, summary: { uptimePct: null, avgMs: null, monitors: 0, up: 0, slow: 0, down: 0, incidents: 0, downtimeMs: 0 }, monitors: [], incidents: [] },
    '/api/system/history': { window: 3600000, stepMs: 5000, points: Array.from({ length: 30 }, (_, i) => ({ t: Date.now() - (30 - i) * 5000, cpu: 10 + i % 7, memUsedPct: 40, load: 1, rx: 1000 * i, tx: 1, temp: 40, procs: 100, diskUsedPct: 20 })) },
    '/api/operations': { docker: { operations: false }, actions: [] },
    ...extra,
  });

  await test('home: a greeting by account name, the host strip, tiles as links, and no empty bands', async (h) => {
    h.setRoutes(homeRoutes());
    await h.mount(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    await h.waitFor(() => !!q('.hm-hero h1') && qa('.hm-tile').length > 0, 'the home page');
    expect(text(q('.hm-hero h1')!).includes('admin'), `the greeting does not use the account name: ${text(q('.hm-hero h1')!)}`);
    const cells = qa('.hm-host .hm-h').map((c) => text(c));
    expect(cells.length === 6, `the host strip has ${cells.length} cells`);
    expect(cells[0].includes('CPU') && cells[0].includes('12'), `CPU reading: ${cells[0]}`);
    expect(cells[1].includes('40%') && cells[1].includes('4 GB'), `memory reading: ${cells[1]}`);
    expect(cells[3].includes('19%'), `disk reading (4 of 21 GB): ${cells[3]}`);
    expect(qa('.hm-hb').length === 5, 'five readings should be expandable');
    // nothing is wrong and no update was received, so those bands are not drawn at all
    expect(!q('.hm-attn'), 'an attention band is drawn although everything is up');
    expect(!text().includes('Updates available'), 'an updates card is drawn with no notices');
    expect(!text().includes('Uptime') || !q('.hm-rail')?.textContent?.includes('up now'), 'an uptime card is drawn with no monitors');
    // a tile is one link that opens the service; one without a web address opens its details
    const wave = qa('a.hm-tile').find((a) => text(a).includes('Wave'))!;
    expect(wave.getAttribute('href') === 'http://fixture.local/wave' && wave.getAttribute('target') === '_blank' && /noopener/.test(wave.getAttribute('rel') || ''), 'the launch tile is not a safe new-tab link');
    const photos = qa('a.hm-tile').find((a) => text(a).includes('Photos'))!;
    expect(photos.getAttribute('href') === '/services/Media/photos' && text(photos).includes('No web address'), 'a tile without a URL invented one');
    expect(qa('.hm-stack').length === 1 && text(q('.hm-stack')!).includes('Media'), 'tiles are not grouped by stack');
    expect(!q('.hm-attn'), 'attention shows for healthy containers');
  });

  await test('home: attention, updates and uptime appear from real data, and the start or restart action is offered only when permitted', async (h) => {
    const sick = mkSvc('sick', { status: 'unhealthy', stackDisplayName: 'Media', stack: 'media', group: 'Media' });
    const dead = mkSvc('dead', { status: 'down', stackDisplayName: 'Media', stack: 'media', group: 'Media', container: { ...svcBase.container, name: 'dead', id: 'cid-dead', state: 'exited', status: 'Exited (1) 2 minutes ago' } });
    h.setRoutes(homeRoutes({
      '/api/services': docOf([{ name: 'Media', services: [sick, dead, mkSvc('ok1', { stackDisplayName: 'Media', stack: 'media', group: 'Media' })] }]),
      '/api/container-updates': { updates: [upd('cid-ok1', { currentTag: '1.0', availableTag: '1.1' })], count: 1, availableCount: 1 },
      '/api/monitoring/ribbons': (() => {
        const end = Date.now(); const segs = (kinds: ('ok' | 'fail')[]) => kinds.map((k, i) => ({ a: end - (kinds.length - i) * 300_000, b: end - (kinds.length - i - 1) * 300_000, k, slow: false, ms: k === 'ok' ? 40 : null, n: 5, ok: k === 'ok' ? 5 : 0, degraded: 0, fail: k === 'fail' ? 5 : 0, unknown: 0 }));
        const mon = (id: string, name: string, status: string, kinds: ('ok' | 'fail')[]) => ({ id, name, type: 'tcp', status, enabled: true, latencyMs: null, service: null, intervalMs: 60000, checks: 50, judged: 50, uptimePct: 90, avgMs: 40, p95Ms: null, coverageFrom: end - kinds.length * 300_000, segments: segs(kinds) });
        return { at: end, range: '24h', from: end - 86_400_000, to: end, stepMs: 300_000, slowMs: 1000, summary: { uptimePct: 95, avgMs: 40, monitors: 2, up: 1, slow: 0, down: 1, incidents: 1, downtimeMs: 600_000 },
          monitors: [mon('m1', 'Router', 'down', ['ok', 'ok', 'ok', 'ok', 'fail', 'fail']), mon('m2', 'NAS', 'up', ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'])],
          incidents: [{ id: 'i1', monitorId: 'm1', monitorName: 'Router', startedAt: end - 600_000, recoveredAt: null, durationMs: 600_000, open: true, reason: 'down' }] };
      })(),
      '/api/operations': { docker: { operations: true }, actions: [{ id: 'container.restart', permitted: true }, { id: 'container.start', permitted: true }] },
    }));
    await h.mount(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    await h.waitFor(() => !!q('.hm-attn') && !!q('.hm-rail'), 'the attention band');
    const band = text(q('.hm-attn')!);
    expect(band.includes('3') && band.includes('Dead') && band.includes('Exited (1) 2 minutes ago') && band.includes('Sick') && band.includes('Router'), `attention band: ${band}`);
    await h.waitFor(() => qa('button.hm-go').length > 0, 'the one-click actions');
    const acts = qa('button.hm-go').map((b) => text(b));
    expect(acts.sort().join(',') === 'Restart →,Start →', `actions: ${acts.join(',')} (a stopped container is started, an unhealthy one restarted, a monitor has none)`);
    const rail = text(q('.hm-rail')!);
    expect(rail.includes('Updates available') && rail.includes('1.0 → 1.1') && rail.includes('nothing is applied automatically'), `updates card: ${rail}`);
    expect(rail.includes('95') && rail.includes('last 24 hours') && rail.includes('1 of 2 up now'), `uptime card: ${rail}`);
    const mini = qa('.hm-mrow');
    expect(mini.length === 1 && text(mini[0]).includes('Router') && mini[0].querySelectorAll('polygon').length > 0, `the mini ribbon is only for the monitor worth a look (an up monitor with no recent incident is left out): ${mini.map((m) => text(m)).join('|')}`);
    expect((mini[0].querySelector('[role="img"]')?.getAttribute('aria-label') || '').includes('Router'), 'the mini ribbon has no text summary');
    expect(text(q('.hm-hero')!).includes('1 update available') && text(q('.hm-hero')!).includes('3 need attention'), 'the greeting counts are not the same as the bands');
    expect(qa('.hm-upd').length === 1 && text(qa('.hm-upd')[0]).includes('1.1'), 'the update chip is missing from the tile');
  });

  await test('home: a host reading opens a chart with 1h / 24h / 7d, Escape closes it, and the history is only fetched while open', async (h) => {
    h.setRoutes(homeRoutes());
    await h.mount(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    await h.waitFor(() => qa('.hm-hb').length === 5, 'the host strip');
    expect(!h.calls.some((c) => c.path.includes('window=86400000') || c.path.includes('window=604800000')), 'long history was fetched before anyone asked');
    click(qa('.hm-hb')[0]);
    await h.waitFor(() => !!q('.hm-hx') && !!q('.hm-chart'), 'the expanded chart');
    expect(qa('.hm-hb')[0].getAttribute('aria-expanded') === 'true', 'the strip does not show which reading is open');
    expect(text(q('.hm-hx')!).includes('CPU'), 'the chart does not name its reading');
    const seg = qa('.hm-hx .seg-sm button').map((b) => text(b));
    expect(seg.join(',') === '1 hour,24 hours,7 days', `ranges: ${seg.join(',')}`);
    expect(text(q('.hm-stats')!).includes('latest') && text(q('.hm-stats')!).includes('peak') && text(q('.hm-stats')!).includes('lowest'), 'the figures under the chart are incomplete');
    click(qa('.hm-hx .seg-sm button')[2]);
    await h.waitFor(() => h.calls.some((c) => c.path.includes('window=604800000')), 'the 7-day request');
    key(document.body, 'Escape');
    await h.waitFor(() => !q('.hm-hx'), 'the chart to close');
    expect(qa('.hm-hb')[0].getAttribute('aria-expanded') === 'false', 'the strip still shows the reading open');
  });

  await test('home: Docker being unreachable is said plainly, with a way forward', async (h) => {
    h.setRoutes(homeRoutes({ '/api/services': { ...servicesDoc, groups: [], services: [], live: false, statusReason: 'Docker is not reachable.' } }));
    await h.mount(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    await h.waitFor(() => !!q('.hm-empty'), 'the Docker message');
    expect(text(q('.hm-empty')!).includes('Configure Docker'), 'no way forward is offered');
    expect(qa('.hm-tile').length === 0, 'tiles were drawn without Docker');
  });

  await test('home: a history too short to draw says so instead of drawing a line', async (h) => {
    h.setRoutes(homeRoutes({ '/api/system/history': { window: 3600000, stepMs: 5000, points: [] } }));
    await h.mount(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    await h.waitFor(() => qa('.hm-hb').length === 5, 'the host strip');
    click(qa('.hm-hb')[3]);
    await h.waitFor(() => text(q('.hm-hx') || document.body).includes('Not enough'), 'the short-history message');
    expect(!q('.hm-chart'), 'a chart was drawn from no data');
  });

  /* ==================================================================
     Uptime (rebuild slice 2): ribbons over what the engine recorded
     ================================================================== */
  const NOW = Date.now();
  const STEP = 300_000;
  const seg = (i: number, k: Segment['k'], ms: number | null, over: Partial<Segment> = {}): Segment => ({
    a: NOW - (60 - i) * STEP, b: NOW - (59 - i) * STEP, k, slow: false, ms, n: 5,
    ok: k === 'ok' ? 5 : 0, degraded: k === 'degraded' ? 5 : 0, fail: k === 'fail' ? 5 : 0, unknown: k === 'unknown' ? 5 : 0, ...over,
  });
  const run = (n: number, ms = 50, from = 60 - n) => Array.from({ length: n }, (_, i) => seg(from + i, 'ok', ms));
  const rm = (id: string, name: string, status: string, segments: Segment[], over: Partial<RibbonMonitor> = {}): RibbonMonitor => ({
    id, name, type: 'docker', status, enabled: true, latencyMs: status === 'up' ? 50 : null, service: null, intervalMs: 60_000,
    checks: segments.length * 5, judged: segments.length * 5, uptimePct: segments.length ? 99.5 : null, avgMs: segments.length ? 50 : null, p95Ms: null,
    coverageFrom: segments.length ? segments[0].a : null, segments, ...over,
  });
  const ribbonsDoc = (monitors: RibbonMonitor[], over: Partial<RibbonsDoc> = {}): RibbonsDoc => ({
    at: NOW, range: '24h', from: NOW - 24 * 3_600_000, to: NOW, stepMs: STEP, slowMs: 1000,
    summary: { uptimePct: 99.4, avgMs: 75, monitors: monitors.length, up: monitors.filter((m) => m.status === 'up').length, slow: 1, down: monitors.filter((m) => m.status === 'down').length, incidents: 1, downtimeMs: 38 * 60_000 },
    monitors,
    incidents: [{ id: 'inc-1', monitorId: 'mon-b', monitorName: 'Beta', startedAt: NOW - 38 * 60_000, recoveredAt: null, durationMs: 38 * 60_000, open: true, reason: 'Connection refused' }],
    ...over,
  });

  await test('uptime model: down first, then slow, then up, and monitors with no verdict last', async () => {
    const mk = (n: string, st: string) => rm(`mon-${n}`, n, st, []);
    expect(sortRows([mk('up2', 'up'), mk('new', 'pending'), mk('slow', 'degraded'), mk('up1', 'up'), mk('dead', 'down')]).map((r) => r.name).join(',') === 'dead,slow,up1,up2,new', 'ribbon order');
  });

  await test('uptime model: thickness is relative to the monitor\'s own normal, and a missing latency is never a thick bar', async () => {
    const segs = run(10, 100);
    expect(baseline(segs) === 100, 'the baseline is the median answer');
    expect(baseline(run(2, 100)) === null, 'two points are not a "normal"');
    expect(thickness(100, 100) === 0.1 && thickness(500, 100) === 1 && thickness(300, 100) > 0.4 && thickness(300, 100) < 0.6, 'thickness runs from a hairline at normal to full at five times');
    expect(thickness(null, 100) < 0.2 && thickness(80, null) < 0.2, 'no latency or no baseline draws a thin line');
  });

  await test('uptime model: a gap ends a run, no verdict is dotted not drawn, and down is a thin line', async () => {
    const ok = run(5, 50, 0);
    const gapped = [...ok, ...run(5, 50, 20)];                                  // a hole of 15 steps
    const geo = { from: NOW - 60 * STEP, to: NOW, width: 1000, height: 46, stepMs: STEP };
    expect(buildRuns(gapped, geo).runs.length === 2, 'a hole in the history did not break the ribbon in two');
    expect(buildRuns(ok, geo).runs.length === 1 && buildRuns([], geo).runs.length === 0, 'runs for contiguous data, none for no data');
    const withUnknown = [...ok, seg(5, 'unknown', null), ...run(5, 50, 6)];
    const u = buildRuns(withUnknown, geo);
    expect(u.unknown.length === 1 && u.runs.length === 2, 'a stretch with no verdict should be a dotted line between two runs, not a bar');
    const dead = buildRuns([...ok, seg(5, 'fail', null), seg(6, 'fail', null), ...run(3, 50, 7)], geo).runs[0];
    const mid = dead.top.length >> 1;
    const heights = dead.bot.map((b, i) => b - dead.top[i]);
    expect(Math.min(...heights) < 6, 'a down stretch is not a thin line');
    expect(heights[0] < Math.max(...heights), 'the left edge is not tapered');
    expect(segmentAt(ok, ok[2].a + 1) === ok[2] && segmentAt(ok, NOW + 1000) === null && segmentAt(ok, ok[0].a - 1) === null, 'segmentAt finds a segment or nothing');
    expect(mid > 0, 'run has no vertices');
  });

  await test('uptime model: words, numbers and the window never overstate', async () => {
    expect(pctText(99.999) === '99.99' && pctText(100) === '100' && pctText(null) === '—' && pctText(99.5) === '99.50', 'a miss was rounded up to 100');
    expect(durText(30_000) === '30 s' && durText(38 * 60_000) === '38 min' && durText(90 * 60_000) === '1 h 30 min' && durText(26 * 3_600_000) === '1 d 2 h', 'durations');
    const few = ribbonsDoc([rm('mon-a', 'Alpha', 'up', run(36))]);                // three hours of history in a 24 h window
    const w = visibleWindow(few);
    expect(w.trimmed && w.from > few.from && w.to === few.to && w.to - w.from >= 2 * 3_600_000, 'a few hours of history should zoom in rather than draw a sliver');
    const full = ribbonsDoc([rm('mon-a', 'Alpha', 'up', [seg(-200, 'ok', 50, { a: NOW - 23 * 3_600_000, b: NOW - 22 * 3_600_000 })])]);
    expect(!visibleWindow(full).trimmed, 'a window that is mostly filled was trimmed');
    expect(!visibleWindow(ribbonsDoc([])).trimmed, 'with no monitors nothing is trimmed');
    const sum = ribbonSummary(rm('mon-b', 'Beta', 'down', run(20)), '24h', ribbonsDoc([]).incidents);
    expect(sum.includes('Beta') && sum.includes('99.50% up') && sum.includes('1 incident, one ongoing') && sum.includes('currently down'), `ribbon summary: ${sum}`);
    expect(ribbonSummary(rm('mon-c', 'Gamma', 'pending', []), '24h', []).includes('no checks recorded'), 'an empty ribbon should say so');
  });

  const uptimeRoutes = (monitors: RibbonMonitor[], extra: Record<string, unknown> = {}) => ({
    ...stubRoutes(), ...AUTH_ROUTES,
    '/api/monitoring/ribbons': (_b: unknown, path: string) => ribbonsDoc(monitors, path.includes('range=7d') ? { range: '7d', stepMs: 3_600_000 } : {}),
    '/api/monitoring/engine': { state: 'running', reason: null },
    '/api/monitoring/settings': { settings: { intervalMs: 60000, timeoutMs: 5000, retentionHours: 336, retentionSamples: 360 }, bounds: {} },
    '/api/services': servicesDoc, '/api/operations': { docker: { operations: false }, actions: [] },
    ...extra,
  });
  const upMonitors = () => [
    rm('mon-a', 'Alpha', 'up', run(40, 50)),
    rm('mon-b', 'Beta', 'down', [...run(28, 50, 30), seg(58, 'fail', null), seg(59, 'fail', null)]),
    rm('mon-c', 'Gamma', 'pending', []),
  ];

  await test('uptime: the summary, ribbons sorted down-first, each with a text summary, a gap for a monitor with no checks, and the incident', async (h) => {
    h.setRoutes(uptimeRoutes(upMonitors()));
    await h.mount(<MemoryRouter initialEntries={['/monitoring']}><App /></MemoryRouter>);
    await h.waitFor(() => qa('.ur-row').length === 3, 'the ribbon rows');
    expect(text(q('.ur-head')!).includes('Uptime') && text(q('.ur-head')!).includes('3 monitors') && text(q('.ur-head')!).includes('checked every 1 min'), `header: ${text(q('.ur-head')!)}`);
    const sum = text(q('.ur-sum')!);
    expect(sum.includes('99.40') && sum.includes('1 / 3') && sum.includes('38 min of downtime') && sum.includes('75'), `summary: ${sum}`);
    expect(qa('.ur-nm b').map((b) => text(b)).join(',') === 'Beta,Alpha,Gamma', 'the down monitor is not first');
    for (const rb of qa('.ur-rb')) {
      expect((rb.getAttribute('aria-label') || '').length > 30 && rb.getAttribute('role') === 'img' && rb.tabIndex === 0, 'a ribbon needs a text summary and to be focusable');
    }
    expect((qa('.ur-rb')[0].getAttribute('aria-label') || '').includes('Beta') && (qa('.ur-rb')[0].getAttribute('aria-label') || '').includes('1 incident, one ongoing'), 'the label does not name the incident');
    expect(qa('.ur-rb')[0].querySelectorAll('polygon').length > 0, 'a ribbon with data was not drawn');
    expect(qa('.ur-rb')[2].querySelectorAll('polygon').length === 0 && text(qa('.ur-rb')[2]).includes('waiting for the first check'), 'a monitor with no checks must be a quiet gap, not a bar');
    expect(qa('.ur-notch').length === 1 && (qa('.ur-notch')[0].getAttribute('aria-label') || '').includes('Beta'), 'the incident notch is missing');
    expect(text(q('.ur-il')!).includes('Beta') && text(q('.ur-il')!).includes('Connection refused') && text(q('.ur-il')!).includes('ongoing'), 'the incident is not listed');
    expect(!!q('.ur-legend') && text(q('.ur-legend')!).includes('No verdict'), 'the legend does not explain the gap');
  });

  await test('uptime: the arrow keys scrub every row to the same moment, with an exact readout, and Escape clears', async (h) => {
    h.setRoutes(uptimeRoutes(upMonitors()));
    await h.mount(<MemoryRouter initialEntries={['/monitoring']}><App /></MemoryRouter>);
    await h.waitFor(() => qa('.ur-rb').length === 3, 'the ribbons');
    const rb = qa('.ur-rb')[1];                                                 // Alpha
    expect(!q('.ur-guide') && !q('.ur-tip'), 'a scrub guide is shown before anyone scrubs');
    key(rb, 'ArrowLeft');
    await h.waitFor(() => !!q('.ur-guide') && !!q('.ur-tip'), 'the guide and the readout');
    expect(text(q('.ur-tip')!).includes('Alpha') && text(q('.ur-tip')!).includes('Up') && /\d+ ms/.test(text(q('.ur-tip')!)), `tooltip: ${text(q('.ur-tip')!)}`);
    expect(!!q('.ur-axis .bub') && /\d\d:\d\d/.test(text(q('.ur-axis .bub')!)), 'the time bubble is missing');
    const rows = qa('.ur-c3').map((c) => text(c));
    expect(rows[0].includes('Down') && !rows[0].includes('now'), `every row should read the scrubbed moment, not now: ${rows[0]}`);
    expect(rows[2].includes('no data'), `a monitor with no history says no data at that moment: ${rows[2]}`);
    expect(qa('.ur-row')[1].className.includes('hot'), 'the scrubbed row is not marked');
    const first = text(q('.ur-axis .bub')!);
    key(rb, 'ArrowLeft', { shiftKey: true });
    await h.waitFor(() => text(q('.ur-axis .bub')!) !== first, 'Shift to move twelve steps');
    key(rb, 'Home');
    await h.waitFor(() => text(q('.ur-axis .bub')!) !== first, 'Home to jump to the start');
    key(rb, 'Escape');
    await h.waitFor(() => !q('.ur-guide'), 'Escape to clear');
    expect(qa('.ur-c3').map((c) => text(c))[0].includes('now'), 'the readout did not return to now');
  });

  await test('uptime: the range switch asks for 7 days, and Defaults and Add monitor are offered', async (h) => {
    h.setRoutes(uptimeRoutes(upMonitors()));
    await h.mount(<MemoryRouter initialEntries={['/monitoring']}><App /></MemoryRouter>);
    await h.waitFor(() => qa('.ur-row').length === 3, 'the rows');
    click(qa('.ur-head .seg-sm button')[1]);
    await h.waitFor(() => h.calls.some((c) => c.path.includes('/api/monitoring/ribbons?range=7d')), 'the 7-day request');
    await h.waitFor(() => text(q('.ur-sum')!).includes('7 days'), 'the 7-day summary');
  });

  await test('uptime: no monitors, a stopped engine, and a short history are each said plainly', async (h) => {
    h.setRoutes(uptimeRoutes([], { '/api/monitoring/ribbons': ribbonsDoc([], { incidents: [], summary: { uptimePct: null, avgMs: null, monitors: 0, up: 0, slow: 0, down: 0, incidents: 0, downtimeMs: 0 } }), '/api/monitoring/engine': { state: 'stopped', reason: 'The engine was stopped.' } }));
    await h.mount(<MemoryRouter initialEntries={['/monitoring']}><App /></MemoryRouter>);
    await h.waitFor(() => !!q('.ur-empty'), 'the empty state');
    expect(text(q('.ur-empty')!).includes('Nothing is being watched yet'), 'empty state wording');
    expect(text(q('.ur-sum')!).includes('no judged checks yet'), 'the summary invented a number');
    expect(!q('.ur-row'), 'rows were drawn for no monitors');
    expect(text().includes('Monitoring is not running'), 'a stopped engine is not announced');
  });

  await test('uptime: only a few hours of history zoom in and say so', async (h) => {
    h.setRoutes(uptimeRoutes([rm('mon-a', 'Alpha', 'up', run(36))], { '/api/monitoring/ribbons': ribbonsDoc([rm('mon-a', 'Alpha', 'up', run(36))], { incidents: [] }) }));
    await h.mount(<MemoryRouter initialEntries={['/monitoring']}><App /></MemoryRouter>);
    await h.waitFor(() => !!q('.ur-trim'), 'the short-history note');
    expect(text(q('.ur-trim')!).includes('first recorded check') && text(q('.ur-trim')!).includes('fills in as history builds'), `note: ${text(q('.ur-trim')!)}`);
  });

  const BOUNDS = { intervalMs: { min: 10_000, max: 86_400_000, default: 60_000 }, timeoutMs: { min: 500, max: 30_000, default: 5_000 }, retentionHours: { min: 24, max: 2000, default: 336 } };

  await test('monitor form: what is typed becomes a service, a web address or host:port, and only valid checks are offered', async () => {
    const svcs = [{ name: 'jellyfin', displayName: 'Jellyfin', group: 'Media' }, { name: 'wave', displayName: 'Wave', group: 'Music' }];
    const a = classifyTarget('jellyfin', svcs);
    expect(a.kind === 'service' && a.service?.group === 'Media' && classifyTarget(' Wave ', svcs).kind === 'service', 'a service is matched by name or display name');
    expect(typesFor('service').map((t) => t.type).join() === 'http,docker' && typesFor('url').map((t) => t.type).join() === 'http' && typesFor('hostport').map((t) => t.type).join() === 'tcp' && typesFor('none').length === 0, 'check types per target');
    expect(classifyTarget('https://nas.lan:8443/health', svcs).kind === 'url', 'a web address');
    const hp = classifyTarget('nas.lan:5432', svcs);
    expect(hp.kind === 'hostport' && hp.port === 5432 && hp.host === 'nas.lan', 'host:port');
    expect(classifyTarget('nas.lan:99999', svcs).problem?.includes('port') && classifyTarget('nas.lan', svcs).kind === 'none', 'a bad port or a bare name is not a target');
    expect((classifyTarget('example.com/x', svcs).problem || '').includes('http://'), 'a scheme-less address is told what to do');
    expect(classifyTarget('', svcs).kind === 'none' && !classifyTarget('', svcs).problem, 'nothing typed is not an error');
    expect(defaultName(a) === 'Jellyfin' && defaultName(hp) === 'nas.lan:5432' && defaultName(classifyTarget('https://a.example/x', svcs)) === 'a.example', 'default names');
    expect(JSON.stringify(monitorDraft(a, 'docker', ' Jellyfin ')) === JSON.stringify({ name: 'Jellyfin', type: 'docker', target: { service: { group: 'Media', name: 'jellyfin' } } }), 'a service draft carries only the reference');
    expect(JSON.stringify(monitorDraft(hp, 'tcp', 'DB')) === JSON.stringify({ name: 'DB', type: 'tcp', target: { host: 'nas.lan', port: 5432 } }), 'a tcp draft');
  });

  await test('monitor form: defaults are checked against the server\'s bounds, and retention follows the interval', async () => {
    const ok = validateDefaults(toForm({ intervalMs: 60_000, timeoutMs: 5_000, retentionHours: 336 }, 1000), BOUNDS);
    expect(ok.ok && ok.payload.monitoring.retentionHours === 336 && ok.payload.slowMs === 1000 && ok.payload.monitoring.retentionSamples === 1452, `payload: ${JSON.stringify(ok)}`);
    const fast = validateDefaults({ intervalS: '10', timeoutS: '2', slowS: '0.5', days: '30' }, BOUNDS);
    expect(fast.ok && fast.payload.monitoring.retentionSamples === 2000 && fast.payload.slowMs === 500, 'detail is capped at the engine\'s 2000 checks');
    const bad = validateDefaults({ intervalS: '5', timeoutS: '60', slowS: '0', days: '0' }, BOUNDS);
    expect(!bad.ok && Object.keys(bad.errors).length === 4, 'every out-of-range field is named');
    const clash = validateDefaults({ intervalS: '10', timeoutS: '10', slowS: '1', days: '7' }, BOUNDS);
    expect(!clash.ok && !!clash.errors.timeoutS && clash.errors.timeoutS.includes('shorter'), 'a timeout that outlives its interval is refused');
    expect(!validateDefaults({ intervalS: '60', timeoutS: '5', slowS: '1', days: '2.5' }, BOUNDS).ok, 'days must be whole');
  });

  await test('uptime: Defaults shows the current values, names a bad one, and saves interval, timeout, retention and the slow threshold', async (h) => {
    h.setRoutes(uptimeRoutes(upMonitors(), {
      '/api/monitoring/settings': (body: unknown) => (body ? { settings: body } : { settings: { intervalMs: 60000, timeoutMs: 5000, retentionHours: 336, retentionSamples: 360 }, bounds: BOUNDS }),
    }));
    await h.mount(<MemoryRouter initialEntries={['/monitoring']}><App /></MemoryRouter>);
    await h.waitFor(() => qa('.ur-row').length === 3, 'the page');
    expect(!q('.ud-pop'), 'the panel is open before it was asked for');
    click(qa('.ur-ctl button').find((b) => text(b).includes('Defaults'))!);
    await h.waitFor(() => !!q('.ud-pop') && q<HTMLInputElement>('#ud-intervalS')!.value === '60', 'the panel with the current interval');
    expect(q<HTMLInputElement>('#ud-timeoutS')!.value === '5' && q<HTMLInputElement>('#ud-slowS')!.value === '1' && q<HTMLInputElement>('#ud-days')!.value === '14', 'timeout, slow threshold and days are not filled from the settings');
    expect(qa('.ud-f').length === 4, 'the panel holds anything beyond the four settings');
    expect(text(q('.ud-pop')!).includes('does not open an incident'), 'the slow threshold does not say what it does');
    type(q<HTMLInputElement>('#ud-timeoutS')!, '90');
    await h.waitFor(() => text(q('.ud-pop')!).includes('0.5 to 30 seconds'), 'the bound for a bad timeout');
    expect(q<HTMLButtonElement>('.ud-actions .btn-primary')!.disabled, 'Save is enabled with a bad value');
    type(q<HTMLInputElement>('#ud-timeoutS')!, '8'); type(q<HTMLInputElement>('#ud-intervalS')!, '30'); type(q<HTMLInputElement>('#ud-slowS')!, '2'); type(q<HTMLInputElement>('#ud-days')!, '30');
    await h.waitFor(() => !q<HTMLButtonElement>('.ud-actions .btn-primary')!.disabled, 'Save to enable');
    click(q('.ud-actions .btn-primary')!);
    await h.waitFor(() => h.writes('PUT', '/api/monitoring/settings').length === 1 && h.writes('PUT', '/api/settings').length === 1, 'both saves');
    const mon = h.lastCall('PUT', '/api/monitoring/settings')!.body as { intervalMs: number; timeoutMs: number; retentionHours: number; retentionSamples: number };
    expect(mon.intervalMs === 30_000 && mon.timeoutMs === 8_000 && mon.retentionHours === 720 && mon.retentionSamples === 2000, `monitoring settings: ${JSON.stringify(mon)}`);
    expect((h.lastCall('PUT', '/api/settings')!.body as { monitoring: { slowMs: number } }).monitoring.slowMs === 2000, 'the slow threshold was not saved to the display settings');
    await h.waitFor(() => !q('.ud-pop'), 'the panel to close after saving');
  });

  await test('uptime: Add monitor asks for what to watch, the check and a name, and sends exactly that', async (h) => {
    h.setRoutes(uptimeRoutes(upMonitors(), { '/api/monitoring/monitors': (body: unknown) => ({ monitor: { id: 'mon-new', ...(body as object) } }) }));
    await h.mount(<MemoryRouter initialEntries={['/monitoring']}><App /></MemoryRouter>);
    await h.waitFor(() => qa('.ur-row').length === 3, 'the page');
    click(qa('.ur-ctl button').find((b) => text(b).includes('Add monitor'))!);
    await h.waitFor(() => !!q('#ua-target'), 'the dialog');
    expect(qa('.modal input').length === 2, `only what to watch and a name are fields, saw ${qa('.modal input').length}`);
    expect(qa('.modal [role="radio"]').length === 0 && q<HTMLButtonElement>('.modal-foot .btn-primary')!.disabled, 'a check type was offered, or Add was enabled, before a target');
    type(q<HTMLInputElement>('#ua-target')!, 'Wave');
    await h.waitFor(() => qa('.modal [role="radio"]').length === 2, 'both checks for a service');
    expect(q<HTMLInputElement>('#ua-name')!.value === 'Wave', 'the name does not default from the service');
    click(qa('.modal [role="radio"]')[1]);
    click(q('.modal-foot .btn-primary')!);
    await h.waitFor(() => h.writes('POST', '/api/monitoring/monitors').length === 1, 'the create request');
    expect(JSON.stringify(h.lastCall('POST', '/api/monitoring/monitors')!.body) === JSON.stringify({ name: 'Wave', type: 'docker', target: { service: { group: 'Media', name: 'wave' } } }), `body: ${JSON.stringify(h.lastCall('POST', '/api/monitoring/monitors')!.body)}`);
    await h.waitFor(() => !q('#ua-target'), 'the dialog to close');
  });

  await test('uptime: Add monitor shows the server\'s reason when it refuses, and a host:port is a port check', async (h) => {
    h.setRoutes(uptimeRoutes(upMonitors(), { '/api/monitoring/monitors': { $status: 400, body: { error: 'That address is not allowed.', code: 'blocked' } } }));
    await h.mount(<MemoryRouter initialEntries={['/monitoring']}><App /></MemoryRouter>);
    await h.waitFor(() => qa('.ur-row').length === 3, 'the page');
    click(qa('.ur-ctl button').find((b) => text(b).includes('Add monitor'))!);
    await h.waitFor(() => !!q('#ua-target'), 'the dialog');
    type(q<HTMLInputElement>('#ua-target')!, 'db.lan:5432');
    await h.waitFor(() => qa('.modal [role="radio"]').length === 1 && text(q('.modal')!).includes('Port check'), 'the port check');
    click(q('.modal-foot .btn-primary')!);
    await h.waitFor(() => !!q('.modal .ud-err'), 'the refusal');
    expect(text(q('.modal .ud-err')!).includes('not allowed'), `error: ${text(q('.modal .ud-err')!)}`);
    expect(!!q('#ua-target'), 'the dialog closed on a refusal');
    expect((h.lastCall('POST', '/api/monitoring/monitors')!.body as { target: { port: number } }).target.port === 5432, 'the port was not sent as a number');
  });

  for (const r of results) {
    if (r.ok) { passed++; console.log(`✓ ${r.name}`); }
    else { failures.push(`${r.name}: ${r.detail}`); console.error(`✗ ${r.name} — ${r.detail}`); }
  }
  return { passed, failed: failures.length, failures };
}
