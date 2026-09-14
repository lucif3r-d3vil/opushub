// Discovery tests (§24): what exists comes from Docker, what it looks like can come from config,
// and the two never trade places. Synthetic containers keep these precise; the mock-engine
// integration pass lives in model.test.js.
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { discover, imageSlugs, deriveDisplayName, baseName } from './discovery.js';
import { suggestRef } from './providers/icons.js';

/** A container exactly as /containers/json reports it (labels included — that is what discovery reads). */
const raw = (name, opts = {}) => ({
  id: opts.id || createHash('sha1').update(name).digest('hex').slice(0, 12),
  name,
  image: opts.image || `library/${name}:latest`,
  state: opts.state === undefined ? 'running' : opts.state,
  status: opts.status === undefined ? (opts.state ? `${opts.state} fixture` : null) : opts.status,
  health: opts.health ?? null,
  created: 1789000000,
  ports: opts.ports || [],
  networks: opts.networks || [],
  rawLabels: {
    ...(opts.project ? {
      'com.docker.compose.project': opts.project,
      'com.docker.compose.service': opts.service || name,
      'com.docker.compose.container-number': opts.replica ? String(opts.replica) : '1',
      'com.docker.compose.project.working_dir': `/opt/stacks/${opts.project}`,
    } : {}),
    ...(opts.proxy ? {
      'traefik.enable': 'true',
      [`traefik.http.routers.${opts.router || name}.rule`]: opts.proxy,
      ...(opts.tls ? { [`traefik.http.routers.${opts.router || name}.tls`]: 'true' } : {}),
      ...(opts.entry ? { [`traefik.http.routers.${opts.router || name}.entrypoints`]: opts.entry } : {}),
    } : {}),
    ...(opts.labels || {}),
  },
});

const overlay = (o) => ({
  name: o.container || o.name, container: null, displayName: null, app: null, description: null,
  url: null, icon: null, group: null, order: null, hidden: false, showOnHub: true, keywords: [], meta: [], ...o,
});

// same icon derivation the live inventory uses (model.js), so these assertions cover the real path
const run = (containers, opts = {}) => discover(containers, {
  live: true,
  hostAddress: '10.0.0.5',
  suggestIcon: (rec) => suggestRef([...(rec.imageSlugs || []), ...(rec.composeService ? [rec.composeService] : []), rec.containerName]),
  ...opts,
});

// ── existence is Docker's call ────────────────────────────────────────────────

test('a configured service with no container is absent — and reported, not swallowed', () => {
  const inv = run([], { serviceOverlays: [overlay({ container: 'seerr', displayName: 'Seerr', group: 'Media' })] });
  assert.equal(inv.services.length, 0, 'no container → no service, whatever services.yaml says');
  assert.equal(inv.groups.length, 0);
  assert.equal(inv.unmatched.length, 1);
  assert.match(inv.unmatched[0].reason, /no container named “seerr”/);
});

test('a container with no configuration is discovered, with derived presentation', () => {
  const inv = run([raw('navidrome', { project: 'music' })]);
  const svc = inv.services[0];
  assert.equal(svc.name, 'navidrome');
  assert.equal(svc.displayName, 'Navidrome');
  assert.equal(svc.configured, false);
  assert.equal(svc.discovered, true);
  assert.equal(svc.overlaid, null);
  // Phase 4: the compose project IS the group — no configuration, no services.yaml entry, and
  // still organised the way the operator's runtime is organised. A container with no stack at all
  // falls back to one shared group instead of inventing a category (see the group suite).
  assert.equal(svc.group, 'Music');
  assert.equal(svc.groupSource, 'compose project');
  assert.equal(inv.groups[0].services.length, 1);
  assert.equal(inv.groups[0].name, 'Music');
});

test('container + overlay is ONE enriched object, never two', () => {
  const inv = run(
    [raw('seerr', { project: 'opustream', proxy: 'Host(`seerr.example.internal`)' })],
    { serviceOverlays: [overlay({ container: 'seerr', displayName: 'Seerr Requests', group: 'Media', icon: 'mdi:movie-search-outline', description: 'Requests', meta: [{ label: 'Approvals', value: 'household' }] })] },
  );
  assert.equal(inv.services.length, 1, 'exactly one canonical object per container');
  assert.equal(inv.groups.flatMap((g) => g.services).length, 1, 'and it is not duplicated across groups');
  const svc = inv.services[0];
  assert.equal(svc.displayName, 'Seerr Requests');
  assert.equal(svc.group, 'Media');
  assert.equal(svc.icon, 'mdi:movie-search-outline');
  assert.equal(svc.iconSource, 'config');
  assert.equal(svc.description, 'Requests');
  assert.deepEqual(svc.meta, [{ label: 'Approvals', value: 'household' }]);
  assert.equal(svc.configured, true);
  assert.equal(svc.url, 'http://seerr.example.internal');
  assert.equal(svc.urlSource, 'traefik', 'config renames it; it does not move it');
});

test('the duplicate the old merge produced (config “Seerr” + discovered opustream/seerr) collapses', () => {
  const inv = run(
    [raw('seerr', { project: 'opustream', service: 'Seerr', proxy: 'Host(`seerr.example.internal`)' })],
    { serviceOverlays: [overlay({ name: 'Seerr', container: 'seerr', group: 'Media' })] },
  );
  const list = inv.groups.flatMap((g) => g.services);
  assert.equal(list.length, 1);
  assert.equal(inv.stacks.length, 1);
  assert.equal(inv.stacks[0].members.length, 1);
});

test('two overlays fighting for one container resolve to one object plus a conflict note', () => {
  const inv = run([raw('immich', { project: 'photos' })], {
    serviceOverlays: [overlay({ container: 'immich', displayName: 'Lens' }), overlay({ name: 'immich', displayName: 'Photos App' })],
  });
  assert.equal(inv.services.length, 1);
  assert.equal(inv.services[0].displayName, 'Lens', 'first entry wins deterministically');
  assert.equal(inv.unmatched.length, 1);
  assert.match(inv.unmatched[0].reason, /already overlaid by “Lens”/);
});

test('a stopped container is still an inventory object; a removed one is gone', () => {
  const fleet = [raw('paperless', { project: 'cloud', state: 'exited', status: 'Exited (0) 11 hours ago' }), raw('gitea', { project: 'code' })];
  const before = run(fleet);
  assert.equal(before.services.length, 2);
  const paper = before.services.find((s) => s.name === 'paperless');
  assert.equal(paper.status, 'down');
  assert.equal(paper.url, null);
  assert.equal(paper.urlSource, 'none');
  assert.equal(paper.discovered, true, 'stopped ≠ not installed');

  const after = run([fleet[0]]); // gitea removed from the engine
  assert.equal(after.services.length, 1);
  assert.equal(after.services.some((s) => s.name === 'gitea'), false);
  assert.equal(after.stacks.find((s) => s.project === 'code'), undefined, 'its stack disappears with it');
});

test('health reported in the status string is surfaced, not invented', () => {
  const inv = run([raw('navidrome', { health: 'unhealthy' }), raw('radarr', { health: 'healthy' })]);
  assert.equal(inv.services.find((s) => s.name === 'navidrome').status, 'unhealthy');
  assert.equal(inv.services.find((s) => s.name === 'radarr').status, 'up');
  assert.equal(inv.services.find((s) => s.name === 'radarr').container.health, 'healthy', 'health in the status string is real Docker data');
  assert.equal(inv.services.find((s) => s.name === 'navidrome').container.health, 'unhealthy');
  assert.equal(run([raw('nocheck')]).services[0].container.health, null, 'no HEALTHCHECK → null, never a guess');
});

// ── identity ─────────────────────────────────────────────────────────────────

test('display names come from Docker metadata, not from an application table', () => {
  assert.equal(deriveDisplayName({ composeService: 'jellyfin', containerName: 'jellyfin' }), 'Jellyfin');
  assert.equal(deriveDisplayName({ composeService: 'home-assistant', containerName: 'home-assistant' }), 'Home Assistant');
  assert.equal(deriveDisplayName({ composeService: null, composeProject: 'opustream', containerName: 'opustream-seerr-2' }), 'Seerr', 'compose default names are unwrapped');
  assert.equal(deriveDisplayName({ composeService: null, composeProject: 'stack', containerName: 'stack_paperless-ngx_1' }), 'Paperless Ngx');
});

test('replicas of one service are two objects (two containers) with distinct ids', () => {
  const inv = run([
    raw('traefik-app-1', { project: 'app', service: 'app', replica: 1 }),
    raw('traefik-app-2', { project: 'app', service: 'app', replica: 2 }),
  ]);
  assert.equal(inv.services.length, 2);
  assert.notEqual(inv.services[0].id, inv.services[1].id);
  assert.equal(inv.services.length, new Set(inv.services.map((s) => s.id)).size, 'one object per container id');
  assert.equal(inv.stacks[0].containerCount, 2);
});

test('a container can declare its own role with opushub.kind', () => {
  const rail = run([raw('dashboards', { image: 'grafana/grafana:11', ports: [{ ip: '0.0.0.0', private: 3000, public: 3000, type: 'tcp' }], labels: { 'opushub.kind': 'infrastructure' } })]);
  assert.equal(rail.services[0].kind, 'infrastructure');
  assert.equal(rail.services[0].kindSource, 'container label');
  assert.equal(rail.groups.length, 0, 'filed with the rails, not in the grid');
  assert.equal(rail.infrastructure.length, 1);
  const app = run([raw('cache-box', { image: 'redis:7', labels: { 'opushub.kind': 'application' } })]);
  assert.equal(app.services[0].kind, 'application', 'and the other direction works too');
  assert.equal(app.services[0].kindSource, 'container label');
});

test('image slugs are derived for icon probing, never mapped', () => {
  assert.deepEqual(imageSlugs('ghcr.io/immich-app/immich-server:v1.118.0'), ['immich', 'immich-app']);
  assert.deepEqual(imageSlugs('docker.io/library/postgres:16-alpine'), ['postgres', 'library']);
  assert.deepEqual(imageSlugs('nextcloud:29-apache'), ['nextcloud']);
  assert.deepEqual(imageSlugs(null), []);
});

// ── the overlay, field by field ───────────────────────────────────────────────

test('icon precedence: config > container label > derived from image > none', () => {
  const svc = (labels, ovl, image = 'ghcr.io/jellyfin/jellyfin:10.9.7') => run(
    [raw('media-app', { image, labels })],
    { serviceOverlays: ovl ? [overlay({ container: 'media-app', ...ovl })] : [] },
  ).services[0];
  assert.equal(svc({ 'opushub.icon': 'mdi:filmstrip' }, { icon: 'lucide:clapperboard' }).icon, 'lucide:clapperboard');
  assert.equal(svc({ 'opushub.icon': 'mdi:filmstrip' }, null).icon, 'mdi:filmstrip');
  assert.equal(svc({ 'opushub.icon': 'mdi:filmstrip' }, null).iconSource, 'label');
  assert.equal(svc({}, null).icon, 'si:jellyfin', 'the image said so, and the bundled set confirmed it');
  assert.equal(svc({}, null).iconSource, 'derived:image');
  assert.equal(svc({}, null, 'registry.invalid/some-org/some-thing:1').icon, null, 'nothing matches → the client draws a monogram');
});

test('a container label alone can carry the whole presentation, with no config file', () => {
  const inv = run([raw('navidrome', {
    labels: {
      'opushub.displayName': 'Wave',
      'opushub.group': 'Music',
      'opushub.description': 'Lossless, everywhere',
      'opushub.meta.Library': '312 GB FLAC',
      'opushub.order': '1',
    },
  })]);
  const s = inv.services[0];
  assert.equal(s.displayName, 'Wave');
  assert.equal(s.group, 'Music');
  assert.equal(s.description, 'Lossless, everywhere');
  assert.deepEqual(s.meta, [{ label: 'Library', value: '312 GB FLAC' }]);
  assert.equal(s.overlaid, 'container label');
  assert.equal(s.configured, false, 'configured means “there is a services.yaml entry”');
});

test('a manual url override outranks proxy metadata and is labelled manual', () => {
  const c = raw('seerr', { proxy: 'Host(`seerr.example.internal`)' });
  const inv = run([c], { serviceOverlays: [overlay({ container: 'seerr', url: 'https://requests.example.org' })] });
  assert.equal(inv.services[0].url, 'https://requests.example.org');
  assert.equal(inv.services[0].urlSource, 'manual');
});

test('hidden and showOnHub are presentation-only: the container still exists in its stack', () => {
  const inv = run([raw('secret-svc', { project: 'opustream' })], {
    serviceOverlays: [overlay({ container: 'secret-svc', hidden: true })],
  });
  assert.equal(inv.groups.length, 0, 'hidden from Services and the Hub');
  assert.equal(inv.services.length, 1, 'still in the inventory');
  assert.equal(inv.stacks[0].members.length, 1, 'still in its stack');
  const shown = run([raw('quiet-svc', { project: 'opustream' })], {
    serviceOverlays: [overlay({ container: 'quiet-svc', showOnHub: false })],
  });
  assert.equal(shown.groups[0].services.length, 1, 'Services keeps it; the Hub filters on the flag');
  assert.equal(shown.services[0].showOnHub, false);
});

test('ordering: config order inside a group, layout drag order wins over it', () => {
  const fleet = [raw('b-app', {}), raw('a-app', {}), raw('c-app', {})];
  const byConfig = run(fleet, { serviceOverlays: [overlay({ container: 'c-app', order: 1 }), overlay({ container: 'b-app', order: 2 })] });
  assert.deepEqual(byConfig.groups[0].services.map((s) => s.name), ['c-app', 'b-app', 'a-app']);
  const byLayout = run(fleet, { order: { Other: ['a-app', 'c-app', 'b-app'] } });
  assert.deepEqual(byLayout.groups[0].services.map((s) => s.name), ['a-app', 'c-app', 'b-app']);
});

test('a configured group with no live services renders nothing', () => {
  const inv = run([], {
    groupMeta: [{ name: 'Media', description: 'Streams', services: [] }],
  });
  assert.equal(inv.groups.length, 0);
});

// ── stacks ───────────────────────────────────────────────────────────────────

test('stacks come from compose projects; an overlay renames, never creates', () => {
  const fleet = [raw('jellyfin', { project: 'opustream' }), raw('seerr', { project: 'opustream' }), raw('grafana', { project: 'observability' })];
  const plain = run(fleet);
  assert.deepEqual(plain.stacks.map((s) => s.id), ['observability', 'opustream']);
  assert.equal(plain.stacks[1].name, 'Opustream', 'humanized project name by default');
  assert.equal(plain.stacks[1].configured, false);

  const renamed = run(fleet, { stackOverlays: [{ name: 'Media', project: 'opustream', projectExplicit: true, displayName: 'Media', description: 'Streams and requests', icon: 'lucide:clapperboard', notes: 'iGPU transcodes', members: [] }] });
  assert.equal(renamed.stacks.length, 2, 'still one stack per project');
  const media = renamed.stacks.find((s) => s.project === 'opustream');
  assert.equal(media.name, 'Media');
  assert.equal(media.source, 'configured');
  assert.equal(media.containerCount, 2, 'membership stays Docker’s answer');
  assert.equal(media.notes, 'iGPU transcodes');

  const ghost = run(fleet, { stackOverlays: [{ name: 'Finance', project: 'finance', projectExplicit: true, displayName: null, description: null, icon: null, notes: null, members: [] }] });
  assert.equal(ghost.stacks.length, 2, 'a stack nobody runs does not appear');
  assert.deepEqual(ghost.unmatchedStackOverlays.map((s) => s.name), ['Finance']);
});

test('a legacy friendly-name stack merges into the project its containers live in', () => {
  const inv = run([raw('jellyfin', { project: 'opustream' }), raw('seerr', { project: 'opustream', service: 'Seerr' })], {
    stackOverlays: [{ name: 'Media', project: 'Media', projectExplicit: false, displayName: null, members: ['Stream', 'Seerr', 'Wave'] }],
  });
  assert.equal(inv.stacks.length, 1, 'no Media + opustream pair — one stack');
  assert.equal(inv.stacks[0].id, 'opustream');
  assert.equal(inv.stacks[0].name, 'Media', 'the friendly name from config is what you read');
  assert.equal(inv.unmatchedStackOverlays.length, 0);
});

test('status aggregates honestly across a project (documented deterministic model)', () => {
  // some running + one exited → degraded
  const mixed = run([
    raw('a', { project: 'p', state: 'running' }),
    raw('b', { project: 'p', state: 'exited', status: 'Exited (1) 2 hours ago' }),
  ]);
  assert.equal(mixed.stacks[0].status, 'degraded');
  assert.equal(mixed.stacks[0].runningCount, 1);
  // every member exited → stopped (a clean, deliberate stop — not "attention")
  assert.equal(run([raw('x', { project: 'q', state: 'exited', status: 'Exited (0) 1 hour ago' })]).stacks[0].status, 'stopped');
  // all running but one unhealthy → degraded
  assert.equal(run([raw('x', { project: 'q' }), raw('y', { project: 'q', health: 'unhealthy' })]).stacks[0].status, 'degraded');
  // all running, healthy or no-healthcheck → operational ("no healthcheck" never counts against it)
  assert.equal(run([raw('x', { project: 'q' }), raw('y', { project: 'q', health: 'healthy' })]).stacks[0].status, 'operational');
  // no engine → no verdict
  assert.equal(run([raw('x', { project: 'q' })], { live: false }).stacks[0].status, 'unavailable');
  // nothing running, one paused (transitional) → attention, not stopped
  assert.equal(run([
    raw('x', { project: 'q', state: 'exited', status: 'Exited (0) 1 hour ago' }),
    raw('y', { project: 'q', state: 'paused', status: 'Up 2 hours (Paused)' }),
  ]).stacks[0].status, 'attention');
  // a restarting member while others run is degraded, not operational
  assert.equal(run([
    raw('x', { project: 'q' }),
    raw('y', { project: 'q', state: 'restarting', status: 'Restarting (1) 2 seconds ago' }),
  ]).stacks[0].status, 'degraded');
  // a member with no readable state → unknown, never a guess
  assert.equal(run([raw('x', { project: 'q' }), raw('y', { project: 'q', state: null, status: null })]).stacks[0].status, 'unknown');
});

test('containers with no compose project are standalone, not force-fit into a stack', () => {
  const inv = run([raw('adhoc-runner'), raw('app', { project: 'real' })]);
  assert.equal(inv.standalone.length, 1);
  assert.equal(inv.standalone[0].name, 'adhoc-runner');
  assert.equal(inv.standalone[0].displayName, 'Adhoc Runner');
  assert.equal(inv.standalone[0].kind, 'application');
  assert.equal(inv.standalone[0].name, 'adhoc-runner');
  assert.equal(inv.standalone[0].composeProject, null, 'and it honestly reports having no project');
  assert.equal(inv.stacks.length, 1);
});

// ── applications vs rails ────────────────────────────────────────────────────

test('rails are separated by signals, and never deleted from the inventory', () => {
  const inv = run([
    raw('postgres', { project: 'app', image: 'docker.io/library/postgres:16' }),
    raw('app-db', { project: 'app', service: 'db' }),
    raw('prometheus', { project: 'obs', image: 'prom/prometheus:v2', ports: [{ ip: '0.0.0.0', private: 9090, public: 9090, type: 'tcp' }] }),
    raw('immich-machine-learning', { project: 'photos' }),
    raw('grafana', { project: 'obs', image: 'grafana/grafana:11', ports: [{ ip: '0.0.0.0', private: 3000, public: 3000, type: 'tcp' }] }),
    raw('some-worker', { project: 'app', service: 'worker' }),
  ]);
  const apps = inv.groups.flatMap((g) => g.services).map((s) => s.name);
  const infra = inv.infrastructure.map((s) => s.name);
  assert.deepEqual(infra.sort(), ['app-db', 'immich-machine-learning', 'postgres', 'prometheus', 'some-worker'].sort());
  assert.deepEqual(apps, ['grafana'], 'the app with a real web port stays a service');
  assert.equal(inv.services.length, 6, 'nothing is dropped: rails are a section, not an omission');
  assert.equal(inv.infrastructure[0].url === undefined, false, 'rails keep their url too, for the detail view');
});

test('a proxied rail is an application again — routing it on purpose is the strongest signal', () => {
  const inv = run([raw('postgres-admin', { image: 'dpage/pgadmin4', proxy: 'Host(`pg.example.com`)' })]);
  assert.equal(inv.groups.flatMap((g) => g.services).length, 1);
  assert.equal(inv.services[0].kindSource, 'proxied route');
});

test('explicit config can promote a rail into the Services list', () => {
  const inv = run([raw('redis', { image: 'redis:7' })], { serviceOverlays: [overlay({ container: 'redis', displayName: 'Cache', group: 'Ops' })] });
  assert.equal(inv.services[0].kind, 'application');
  assert.equal(inv.services[0].kindSource, 'explicit overlay');
  assert.equal(inv.groups[0].name, 'Ops');
});

// ── the security boundary ────────────────────────────────────────────────────

test('nothing secret or raw crosses into the service object', () => {
  const inv = run([raw('app', {
    project: 'p',
    labels: {
      'opushub.group': 'G',
      'com.docker.compose.project.config_files': '/opt/stacks/p/docker-compose.yaml',
      'com.docker.compose.project.working_dir': '/opt/stacks/p',
      'homepage.env.SECRET_TOKEN': 'hunter2',
      'traefik.http.routers.app.rule': 'Host(`app.example.com`)',
    },
  })]);
  const json = JSON.stringify(inv.services[0]);
  assert.ok(!json.includes('hunter2'));
  assert.ok(!json.includes('rawLabels'));
  assert.ok(!json.includes('/opt/stacks'), 'compose host paths stay server-side');
  assert.ok(!json.includes('SECRET_TOKEN'), 'only allow-listed label keys are interpreted');
  assert.equal(inv.services[0].container.labels.compose.project, 'p');
  assert.equal(inv.services[0].container.labels.proxy[0].hosts[0], 'app.example.com');
});

test('an empty engine yields an empty, honest inventory (first run without a daemon)', () => {
  const inv = run([], { live: false });
  assert.deepEqual(inv.groups, []);
  assert.deepEqual(inv.stacks, []);
  assert.deepEqual(inv.infrastructure, []);
  assert.equal(inv.stats.containers, 0);
});
