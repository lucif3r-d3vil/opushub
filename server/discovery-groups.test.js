// Phase 4 — automatic organisation from Docker metadata.
//
// The contract these tests defend: **configuration never creates an infrastructure object, and
// Docker always does**. A compose project becomes a group because the engine said so; a service is
// named from its compose service / container name; an icon appears only when one really resolves;
// removing a container removes it from the inventory with nothing to clean up in config.
//
// Everything here is synthetic and clearly fake: no real stack, domain or domain name appears.
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { discover, deriveGroup, iconCandidates, stackIconCandidates, deriveDisplayName } from './discovery.js';
import { suggestRef } from './providers/icons.js';
import { humanize } from './providers/dockerLabels.js';

const raw = (name, opts = {}) => ({
  id: opts.id || createHash('sha1').update(name).digest('hex').slice(0, 12),
  name,
  image: opts.image || `library/${name}:latest`,
  state: opts.state ?? 'running',
  status: opts.status ?? 'Up 2 days',
  health: opts.health ?? null,
  created: 1789000000,
  ports: opts.ports || [],
  networks: opts.networks || [],
  rawLabels: {
    ...(opts.project ? {
      'com.docker.compose.project': opts.project,
      'com.docker.compose.service': opts.service || name,
      'com.docker.compose.container-number': '1',
      'com.docker.compose.project.working_dir': `/opt/stacks/${opts.project}`,
    } : {}),
    ...(opts.labels || {}),
  },
});

const overlay = (o) => ({
  name: o.container || o.name, container: null, displayName: null, app: null, description: null,
  url: null, icon: null, group: null, order: null, hidden: false, showOnHub: true, keywords: [], meta: [], ...o,
});

// the production probe: icon resolution is *existence* in a bundled collection, never a mapping
const run = (containers, opts = {}) => discover(containers, { live: true, suggestRef, ...opts });

// ── stack → group ─────────────────────────────────────────────────────────────

test('a compose project becomes a group, with no configuration anywhere', () => {
  const inv = run([
    raw('opustream-jellyfin-1', { project: 'opustream', service: 'jellyfin', image: 'jellyfin/jellyfin:10.9' }),
    raw('opustream-seerr-1', { project: 'opustream', service: 'seerr', image: 'ghcr.io/sct/overseerr:1.33' }),
  ]);
  assert.equal(inv.groups.length, 1, 'one project → one group');
  assert.equal(inv.groups[0].name, 'Opustream');
  assert.deepEqual(inv.groups[0].services.map((s) => s.displayName), ['Jellyfin', 'Seerr']);
  assert.ok(inv.groups[0].services.every((s) => s.groupSource === 'compose project'));
  assert.ok(inv.groups[0].services.every((s) => s.configured === false), 'nothing here came from config');
});

test('grouping is generic: arbitrary project and service names work the same way', () => {
  const inv = run([
    raw('my-thing-1', { project: 'some_odd_project', service: 'weird-service-name' }),
    raw('other-1', { project: 'another.stack', service: 'MixEdCase' }),
  ]);
  const names = inv.groups.map((g) => g.name).sort();
  assert.deepEqual(names, ['Another Stack', 'Some Odd Project']);
  const odd = inv.groups.find((g) => g.name === 'Some Odd Project');
  assert.equal(odd.services[0].displayName, 'Weird Service Name');
});

test('three containers make three entries; twenty make twenty — no per-stack assumption', () => {
  const three = run([1, 2, 3].map((i) => raw(`tiny-${i}-1`, { project: 'tiny', service: `svc-${i}` })));
  assert.equal(three.groups[0].services.length, 3);
  const twenty = run(Array.from({ length: 20 }, (_, i) => raw(`big-${i}-1`, { project: 'big', service: `svc-${i}` })));
  assert.equal(twenty.groups.length, 1);
  assert.equal(twenty.groups[0].services.length, 20);
  assert.equal(twenty.stats.stacks, 1);
});

test('a project that appears tomorrow appears by itself; one that disappears is gone', () => {
  const before = run([raw('a-1', { project: 'alpha', service: 'a' })]);
  assert.deepEqual(before.groups.map((g) => g.name), ['Alpha']);
  const after = run([
    raw('a-1', { project: 'alpha', service: 'a' }),
    raw('b-1', { project: 'beta', service: 'b' }),   // started after the fact
  ]);
  assert.deepEqual(after.groups.map((g) => g.name), ['Alpha', 'Beta']);
  const removed = run([raw('b-1', { project: 'beta', service: 'b' })]); // alpha's container is gone
  assert.deepEqual(removed.groups.map((g) => g.name), ['Beta'], 'a removed container takes its group with it');
  assert.equal(removed.services.length, 1);
});

test('containers with no stack share one honest group instead of a group each', () => {
  const inv = run([
    raw('traefik', { image: 'traefik:v3.1' }),
    raw('restart-loop'),
    raw('opushub'),
  ]);
  assert.equal(inv.groups.length, 1);
  assert.equal(inv.groups[0].name, 'Other');
  assert.ok(inv.groups[0].services.every((s) => s.groupSource === 'default'));
  assert.equal(inv.standalone.length, 3, 'and they are still listed as standalone in the stacks view');
});

test('deriveGroup: project first, one shared fallback, never a name-derived heading', () => {
  assert.deepEqual(deriveGroup({ composeProject: 'opustream', containerName: 'x' }), { group: 'Opustream', groupSource: 'compose project', project: 'opustream' });
  assert.deepEqual(deriveGroup({ composeFallbackProject: 'from_paths', containerName: 'x' }), { group: 'From Paths', groupSource: 'compose project', project: 'from_paths' });
  assert.deepEqual(deriveGroup({ containerName: 'lonely' }), { group: 'Other', groupSource: 'default', project: null });
  assert.deepEqual(deriveGroup({ containerName: 'lonely' }, 'Solo'), { group: 'Solo', groupSource: 'default', project: null });
});

// ── service identity ─────────────────────────────────────────────────────────

test('service identity comes from the compose service, the container name, then the image', () => {
  assert.equal(deriveDisplayName({ composeService: 'jellyfin', containerName: 'opustream-jellyfin-1', composeProject: 'opustream' }), 'Jellyfin');
  assert.equal(deriveDisplayName({ composeService: null, containerName: 'opustream-jellyfin-1', composeProject: 'opustream' }), 'Jellyfin');
  assert.equal(deriveDisplayName({ composeService: null, containerName: 'home-assistant' }), 'Home Assistant');
  assert.equal(deriveDisplayName({ composeService: null, containerName: 'opustream-navidrome-2', composeProject: 'opustream' }), 'Navidrome');
  // no application-name registry anywhere: this is the same humanize() the project always had
  assert.equal(humanize('jellyfin'), 'Jellyfin');
  assert.equal(humanize('flake-solver-r'), 'Flake Solver R');
});

// ── icons ────────────────────────────────────────────────────────────────────

test('icon candidates come from image, compose service and project — most specific first', () => {
  const candidates = iconCandidates({
    imageSlugs: ['jellyfin'], composeService: 'jellyfin', containerName: 'opustream-jellyfin-1', composeProject: 'opustream',
  });
  assert.deepEqual(candidates.slice(0, 2), ['jellyfin', 'opustream']);
  const stack = stackIconCandidates('opustream-media');
  assert.ok(stack.includes('opustream-media'));
  assert.ok(stack.includes('media'), 'a purpose-named stack can borrow its app mark');
});

test('an icon is resolved only when the name really exists in a bundled set', () => {
  assert.equal(suggestRef(['jellyfin']), 'si:jellyfin', 'a real brand icon resolves');
  assert.equal(suggestRef(['definitely-not-an-application-xyz']), null, 'a miss returns null');
  const unknown = run([raw('definitely-not-an-application-xyz', { project: 'nowhere', service: 'definitely-not-an-application-xyz' })]);
  const svc = unknown.services[0];
  assert.equal(svc.icon, null, 'no icon is invented');
  assert.equal(svc.iconSuggestion, null);
  assert.equal(svc.iconSource, null);
});

test('icon precedence: config > container label > derived > nothing (unknown names never fake one)', () => {
  const fleet = [
    raw('photos-app-1', { project: 'media', service: 'photos-app', labels: { 'opushub.icon': 'lucide:camera' } }),
    raw('ghcr-photos-1', { project: 'media', service: 'ghcr-photos', image: 'ghcr.io/example/photos:1' }),
    raw('nothing-1', { project: 'media', service: 'nothing-matching', image: 'example/nothing-matching:1' }),
  ];
  const inv = run(fleet, { serviceOverlays: [overlay({ container: 'photos-app-1', icon: 'mdi:image-multiple' })] });
  const byName = Object.fromEntries(inv.services.map((s) => [s.name, s]));
  assert.equal(byName['photos-app-1'].icon, 'mdi:image-multiple');
  assert.equal(byName['photos-app-1'].iconSource, 'config');
  assert.equal(byName['ghcr-photos-1'].icon, null, 'nothing named “ghcr-photos” exists to resolve');
  assert.equal(byName['nothing-1'].icon, null);
});

// ── overlays stay overlays ───────────────────────────────────────────────────

test('an overlay renames a derived group without becoming the runtime identity', () => {
  const inv = run(
    [raw('a-1', { project: 'opustream', service: 'a' })],
    { serviceOverlays: [overlay({ container: 'a-1', group: 'Media', displayName: 'My App', icon: 'mdi:movie' })] },
  );
  const svc = inv.services[0];
  assert.equal(svc.group, 'Media');
  assert.equal(svc.groupSource, 'config');
  assert.equal(svc.displayName, 'My App');
  assert.equal(svc.container.composeProject, 'opustream', 'the runtime identity is untouched');
  assert.equal(inv.stacks[0].project, 'opustream');
});

test('configuration still cannot create a service, a group or a stack', () => {
  const inv = run(
    [raw('a-1', { project: 'alpha', service: 'a' })],
    {
      serviceOverlays: [overlay({ container: 'not-installed', group: 'Invented' })],
      stackOverlays: [{ name: 'Ghost stack', project: 'ghost', members: [], displayName: 'Ghost stack' }],
    },
  );
  assert.deepEqual(inv.groups.map((g) => g.name), ['Alpha'], 'the invented group is nowhere');
  assert.deepEqual(inv.stacks.map((s) => s.project), ['alpha'], 'the invented stack is nowhere');
  assert.equal(inv.unmatched.length, 1);
  assert.equal(inv.unmatchedStackOverlays.length, 1);
});

// ── stacks + infrastructure ─────────────────────────────────────────────────

test('stack display names humanize the project and can be overridden, never invented', () => {
  const inv = run([
    raw('opuswave-1', { project: 'opuswave', service: 'navidrome' }),
    raw('opusguard-1', { project: 'opusguard', service: 'gluetun' }),
    raw('opuswork-1', { project: 'opuswork', service: 'nextcloud' }),
  ], { stackOverlays: [{ name: 'Music', project: 'opuswave', displayName: 'Music', members: [] }] });
  const byProject = Object.fromEntries(inv.stacks.map((s) => [s.project, s]));
  assert.equal(byProject.opuswave.displayName, 'Music');
  assert.equal(byProject.opusguard.displayName, 'Opusguard');
  assert.equal(byProject.opuswork.displayName, 'Opuswork');
  assert.equal(byProject.opuswork.configured, false, 'no overlay exists for it');
});

test('infrastructure containers are classified, never deleted, and keep their group', () => {
  const inv = run([
    raw('opustream-postgres-1', { project: 'opustream', service: 'postgres', image: 'postgres:16' }),
    raw('opustream-jellyfin-1', { project: 'opustream', service: 'jellyfin', image: 'jellyfin/jellyfin:10.9' }),
    raw('adguard', { image: 'adguard/adguardhome:latest' }),
  ]);
  assert.equal(inv.infrastructure.length, 1, 'the database is a rail');
  assert.equal(inv.infrastructure[0].group, 'Opustream', 'and it is still filed under its stack');
  assert.equal(inv.groups[0].name, 'Opustream');
  assert.deepEqual(inv.groups[0].services.map((s) => s.name), ['opustream-jellyfin-1'], 'rails do not clutter the application group');
  assert.equal(inv.services.length, 3, 'every container is still one inventory object');
});

test('a stopped container keeps its place in its group (existence is Docker’s answer)', () => {
  const inv = run([
    raw('opustream-a-1', { project: 'opustream', service: 'a' }),
    raw('opustream-b-1', { project: 'opustream', service: 'b', state: 'exited', status: 'Exited (0) 2 hours ago' }),
  ]);
  assert.equal(inv.groups[0].services.length, 2);
  const stopped = inv.services.find((s) => s.name === 'opustream-b-1');
  assert.equal(stopped.status, 'down');
  assert.equal(stopped.group, 'Opustream');
});
