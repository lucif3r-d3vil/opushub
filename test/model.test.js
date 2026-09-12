// Config-overlay integration tests (§2/§3/§6/§7/§22): the live inventory from the mock engine,
// enriched by the YAML files in test/fixtures/overlay-config. One config dir for the whole file —
// configStore resolves its path at import — with per-test rewrites followed by invalidateDiscovery().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine } from './mock-engine.js';

const ENGINE = await startMockEngine();
process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
delete process.env.DOCKER_HOST;
delete process.env.OPUSHUB_HOST_ADDRESS;

// A throwaway config dir so the repo's own (deliberately empty) overlay files are never touched.
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-overlay-'));
for (const f of ['services.yaml', 'stacks.yaml']) {
  fs.copyFileSync(new URL(`./fixtures/overlay-config/${f}`, import.meta.url), path.join(CONFIG_DIR, f));
}
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;

const m = await import('../server/model.js');

const ALL = (doc) => [...doc.groups.flatMap((g) => g.services), ...doc.infrastructure];
const byName = (doc, name) => ALL(doc).find((s) => s.name === name);

test.after(async () => {
  await ENGINE.stop();
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
});

async function view() {
  await m.invalidateDiscovery();
  return m.getServicesView();
}

// ── the join: one canonical object per container ──────────────────────────────

test('an overlay enriches its container in place — one object, never a second row', async () => {
  const doc = await view();
  assert.equal(doc.live, true);
  assert.equal(doc.stats.configured, 5, 'five of six entries bind to a real container');

  const media = doc.groups.find((g) => g.name === 'Media');
  assert.equal(media.configured, true);
  assert.equal(media.description, 'Streams, requests, the fun bits', 'group metadata comes from config');
  // no `order:` keys → alphabetical by display name inside the group; both exist, nothing invented
  assert.deepEqual(media.services.map((s) => s.name), ['seerr', 'jellyfin']);

  const jf = byName(doc, 'jellyfin');
  assert.equal(jf.displayName, 'Stream', 'config renames it');
  assert.equal(jf.icon, 'si:jellyfin');
  assert.equal(jf.configured, true);
  assert.equal(jf.overlaid, 'services.yaml');
  assert.equal(jf.container.composeProject, 'opustream', 'identity is still Docker’s');
  assert.equal(jf.container.state, 'running');
  assert.equal(jf.url, 'http://stream.lab.internal', 'URL from the container’s own Traefik labels');
  assert.equal(jf.urlSource, 'traefik', 'config said nothing about the URL');
  assert.deepEqual(jf.meta, [{ label: 'Library', value: '1.2 TB on disk' }]);
  assert.deepEqual(jf.keywords, ['movies', 'tv']);

  // the historical duplicate: configured “Requests” + discovered opustream/seerr → one object
  assert.equal(ALL(doc).filter((s) => s.container?.name === 'seerr').length, 1);
  const seerr = byName(doc, 'seerr');
  assert.equal(seerr.displayName, 'Requests');
  assert.equal(seerr.url, 'https://requests.example.org', 'a manual override is the top of the list');
  assert.equal(seerr.urlSource, 'manual');
  assert.match(seerr.urlNote, /services\.yaml/);
});

test('a configured service whose container is gone is reported, never displayed', async () => {
  const doc = await view();
  assert.equal(byName(doc, 'ghost-app'), undefined);
  assert.equal(ALL(doc).some((s) => s.displayName === 'Ghost'), false);
  assert.equal(doc.unmatched.length, 1);
  assert.equal(doc.unmatched[0].kind, 'service');
  assert.equal(doc.unmatched[0].container, 'ghost-app');
  assert.match(doc.unmatched[0].reason, /no container named “ghost-app”/);
});

test('two overlays competing for one container still produce one object, plus an explanation', async () => {
  const file = path.join(CONFIG_DIR, 'services.yaml');
  const original = fs.readFileSync(file, 'utf8');
  // insert a duplicate binding for `jellyfin` ahead of the existing one, inside the Media group
  const dupe = '      - name: Second Look\n        container: jellyfin\n        displayName: Also Jellyfin\n';
  assert.ok(original.includes('      - container: jellyfin'), 'fixture shape');
  fs.writeFileSync(file, original.replace('      - container: jellyfin', `${dupe}      - container: jellyfin`), 'utf8');
  try {
    const doc = await view();
    const jfs = ALL(doc).filter((s) => s.container?.name === 'jellyfin');
    assert.equal(jfs.length, 1, 'still exactly one object for that container');
    assert.equal(jfs[0].displayName, 'Also Jellyfin', 'the first entry wins, deterministically');
    const lost = doc.unmatched.find((u) => u.name === 'jellyfin');
    assert.ok(lost, 'the loser is surfaced instead of silently dropped');
    assert.match(lost.reason, /already overlaid by “Also Jellyfin”/);
  } finally {
    fs.writeFileSync(file, original, 'utf8');
    await view();
  }
});

test('hidden and showOnHub change what is listed, not what exists', async () => {
  const doc = await view();
  assert.equal(doc.groups.some((g) => g.services.some((s) => s.name === 'paperless')), false, 'hidden from Services');
  assert.ok(doc.services.some((s) => s.name === 'paperless'), 'still in the inventory');
  const stacks = await m.getStacksDoc();
  const cloud = stacks.stacks.find((s) => s.project === 'cloud');
  assert.ok(cloud.members.some((mm) => mm.containerName === 'paperless'), 'still in its stack');
  assert.equal(byName(doc, 'watchtower').showOnHub, false, 'the Hub filters on the flag; the row stays on Services');
  assert.ok(doc.groups.flatMap((g) => g.services).some((s) => s.name === 'watchtower'));
});

test('infrastructure is a section of the same inventory, and config can promote a rail', async () => {
  const doc = await view();
  assert.ok(doc.infrastructure.some((s) => s.name === 'redis'), 'a bare redis stays a rail');
  const pg = doc.groups.flatMap((g) => g.services).find((s) => s.name === 'postgres');
  assert.ok(pg, 'postgres was promoted by an explicit overlay');
  assert.equal(pg.displayName, 'Main Database');
  assert.equal(pg.kind, 'application');
  assert.equal(pg.kindSource, 'explicit overlay');
  assert.equal(doc.stats.applications + doc.stats.infrastructure, doc.stats.containers, 'rails are a section, not an omission');
  // and a promoted rail is still reachable by its detail route
  const found = m.findService(await m.getInventory(), 'Ops', 'postgres');
  assert.equal(found.container.composeService, 'postgres');
  assert.equal(found.displayName, 'Main Database');
});

test('groups that config declares but nothing fills do not appear', async () => {
  const doc = await view();
  assert.equal(doc.groups.some((g) => g.name === 'Documents'), false, 'its only member is hidden');
  assert.ok(doc.groups.some((g) => g.name === 'Ops'), 'this one has live containers');
});

// ── stacks ────────────────────────────────────────────────────────────────────

test('stacks are compose projects; the overlay renames the project its containers live in', async () => {
  const doc = await m.getStacksDoc();
  const media = doc.stacks.find((s) => s.name === 'Media');
  assert.ok(media, 'the Media overlay bound to the project its containers actually live in');
  assert.equal(media.project, 'opustream', 'Docker stays the identity');
  assert.equal(media.source, 'configured');
  assert.ok(media.members.some((mm) => mm.containerName === 'jellyfin'));
  assert.equal(media.members.filter((mm) => mm.containerName === 'postgres').length, 1, 'membership is the project, not the config list');
  assert.match(media.notes, /iGPU/);

  const photos = doc.stacks.find((s) => s.project === 'photos');
  assert.equal(photos.displayName, 'Photos', 'the explicit `project:` key binds directly');

  assert.equal(doc.stacks.some((s) => s.project === 'finance' || s.name === 'Finance'), false, 'a stack nobody runs does not exist');
  assert.deepEqual(doc.unmatched.map((u) => u.name), ['finance']);
  assert.equal(doc.stacks.find((s) => s.project === 'opustream').status, 'degraded', 'navidrome is unhealthy, and the stack says so');
  assert.ok(doc.standalone.some((c) => c.name === 'traefik'), 'containers with no project stay standalone');
  assert.ok(!doc.standalone.some((c) => c.name === 'jellyfin'), 'a project member is never also standalone');
  assert.ok(!JSON.stringify(doc).includes('/opt/stacks'), 'compose host paths are never exposed');
});

test('every stack member carries the URL discovery resolved, so the stack page needs no config', async () => {
  const doc = await m.getStacksDoc();
  const media = doc.stacks.find((s) => s.project === 'opustream');
  const jf = media.members.find((mm) => mm.containerName === 'jellyfin');
  assert.equal(jf.urlSource, 'traefik', 'from the container’s own router rule…');
  assert.equal(jf.url, 'http://stream.lab.internal');
  const seerr = media.members.find((mm) => mm.containerName === 'seerr');
  assert.equal(seerr.urlSource, 'manual', '…unless the overlay overrode it');
  assert.equal(seerr.url, 'https://requests.example.org');
  const qb = media.members.find((mm) => mm.containerName === 'qbittorrent');
  assert.equal(qb.urlSource, 'none', 'traefik.enable=false suppresses its label URL; with no host address the port cannot resolve yet');
  const redis = media.members.find((mm) => mm.containerName === 'redis');
  assert.equal(redis.url, null);
  assert.equal(redis.kind, 'infrastructure');
});

test('enrichStackMembers adds inspect detail per member', async () => {
  const doc = await m.getStacksDoc();
  const opustream = doc.stacks.find((s) => s.project === 'opustream');
  const members = await m.enrichStackMembers(opustream);
  const jf = members.find((x) => x.containerName === 'jellyfin');
  assert.ok(jf.ports.length >= 1);
  assert.ok(jf.networks.length >= 1);
  assert.ok(jf.mounts.length >= 1);
  assert.ok(jf.stats && jf.stats.cpu != null);
  assert.ok(jf.startedAt);
  assert.ok(!JSON.stringify(members).includes('Env'), 'inspect detail stops at the allow-list');
});

// ── settings and diagnostics ──────────────────────────────────────────────────

test('the host address in settings changes discovered URLs, and nothing else', async () => {
  const before = await view();
  const navidrome = byName(before, 'navidrome');
  if (before.hostAddress) {
    assert.equal(navidrome.url, `http://${before.hostAddress}:4533`, 'published-port resolves against the host we can name');
  } else {
    assert.equal(navidrome.url, null, 'no usable host address → no invented URL');
    assert.match(navidrome.urlNote, /Settings → System|OPUSHUB_HOST_ADDRESS/);
  }
  const settings = await m.putSettings({ infrastructure: { hostAddress: '198.51.100.20' } });
  assert.equal(settings.infrastructure.hostAddress, '198.51.100.20');
  const after = await view();
  assert.equal(byName(after, 'navidrome').url, 'http://198.51.100.20:4533', '…and appears the moment a real host is named');
  assert.equal(byName(after, 'jellyfin').url, 'http://stream.lab.internal', 'proxy-derived URLs never depend on the host address');
  assert.equal(byName(await view(), 'qbittorrent').url, 'http://198.51.100.20:8080', 'every published port lights up at once');
  await m.putSettings({ infrastructure: { hostAddress: null } });
});

test('getDiscoveryStatus reports engine, sources and overlays without leaking the config dir', async () => {
  const doc = await m.getDiscoveryStatus();
  assert.equal(doc.engine.ok, true);
  assert.equal(doc.engine.state, 'connected');
  assert.equal(doc.engine.containers, 24);
  assert.equal(doc.engine.running, 20);
  assert.equal(doc.engine.stopped, 4);
  assert.ok(doc.engine.version, 'the engine told us its version');
  assert.match(String(doc.engine.api), /^\d+\.\d+$/, 'API version is echoed');
  assert.equal(doc.urlDiscovery.sources.traefik > 0, true);
  assert.equal(doc.urlDiscovery.sources['published-port'] > 0, true);
  assert.equal(doc.urlDiscovery.withoutUrl > 0, true, 'containers with no web endpoint are counted, not hidden');
  assert.equal(doc.overlays.serviceOverlays, 5);
  assert.equal(doc.overlays.stackOverlays, 2);
  assert.equal(doc.overlays.unmatched, 2, 'one ghost service + one ghost stack');
  assert.equal(doc.inventory.applications + doc.inventory.infrastructure, doc.engine.containers);
  assert.ok(doc.discoveredAt > 0);
  const json = JSON.stringify(doc);
  assert.ok(!json.includes(os.tmpdir()), 'no filesystem paths in the diagnostic payload');
  assert.ok(!json.includes('rawLabels'));
});

test('a config write is visible on the next read (the Settings editor save path)', async () => {
  const written = m.writeServices({
    groups: [{
      name: 'Media',
      services: [
        { container: 'jellyfin', displayName: 'Cinema' },
        { container: 'nextcloud', displayName: 'Files', group: 'Media', url: 'https://files.example.org' },
        { container: 'no-such-thing', displayName: 'Phantom' },
      ],
    }],
  });
  assert.equal(written.groups[0].services.length, 3, 'the file keeps what it was told');
  const doc = await view();
  assert.equal(byName(doc, 'jellyfin').displayName, 'Cinema');
  assert.equal(byName(doc, 'nextcloud').url, 'https://files.example.org');
  assert.equal(doc.unmatched.length, 1, 'the phantom is reported, not rendered');
  // and the file on disk is YAML a human can keep editing
  const onDisk = fs.readFileSync(path.join(CONFIG_DIR, 'services.yaml'), 'utf8');
  assert.match(onDisk, /displayName: Cinema/);
});
