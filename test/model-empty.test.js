// §25: first-run behaviour. Two empty overlay files (and, in the last case, none at all) must
// still produce a useful, live Services/Stacks experience — because existence is Docker’s job.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine } from './mock-engine.js';

const ENGINE = await startMockEngine();
process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
delete process.env.DOCKER_HOST;
// a known host address, so published-port resolution is exercised as well as proxy resolution
process.env.OPUSHUB_HOST_ADDRESS = '198.51.100.20';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-empty-'));
fs.writeFileSync(path.join(CONFIG_DIR, 'services.yaml'), 'groups: []\n', 'utf8');
fs.writeFileSync(path.join(CONFIG_DIR, 'stacks.yaml'), 'stacks: []\n', 'utf8');
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;

const m = await import('../server/model.js');

const flat = (doc) => [...doc.groups.flatMap((g) => g.services), ...doc.infrastructure];

test.after(async () => {
  await ENGINE.stop();
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
});

test('no overlay data at all: every container is still listed, named and reachable', async () => {
  const doc = await m.getServicesView();
  assert.equal(doc.live, true);
  assert.equal(doc.stats.configured, 0);
  assert.equal(doc.stats.discovered, 25, 'one row per container, nothing invented');
  assert.equal(doc.groups.length > 0, true);
  assert.deepEqual(doc.unmatched, []);

  const byName = (n) => flat(doc).find((s) => s.name === n);
  for (const app of ['jellyfin', 'seerr', 'nextcloud', 'vaultwarden', 'radarr', 'sonarr', 'navidrome', 'immich', 'observability-grafana-1']) {
    const svc = byName(app);
    assert.ok(svc, `${app} is discovered with no config`);
    assert.equal(svc.configured, false);
    assert.ok(svc.displayName && svc.displayName.length > 0, `${app} has a display name: ${svc.displayName}`);
  }
  // URLs from real metadata, with the source recorded
  assert.equal(byName('seerr').urlSource, 'traefik');
  assert.equal(byName('seerr').url, 'https://seerr.lab.internal');
  assert.equal(byName('nextcloud').url, 'http://drive.lab.internal/nextcloud', 'multi-host + path prefix');
  assert.equal(byName('qbittorrent').urlSource, 'published-port');
  assert.equal(byName('qbittorrent').url, 'http://198.51.100.20:8080', '…because the host address is known');
  // and the containers a proxy refuses to route
  assert.equal(byName('sonarr').url, null);
  assert.equal(byName('sonarr').urlSource, 'none');
  // icons: derived by probing the bundled sets against the image name — no app→icon table
  assert.equal(byName('jellyfin').icon, 'si:jellyfin');
  assert.equal(byName('jellyfin').iconSource, 'derived:image');
  assert.equal(byName('immich-machine-learning').icon, null, 'nothing matches → the client draws a monogram');
  // containers without a web endpoint are not dropped
  assert.ok(byName('paperless'), 'stopped, no port, still listed');
  assert.equal(byName('paperless').status, 'down');
});

test('a container label is a complete presentation overlay', async () => {
  const doc = await m.getServicesView();
  const wave = flat(doc).find((s) => s.name === 'navidrome');
  assert.equal(wave.displayName, 'Wave');
  assert.equal(wave.group, 'Music');
  assert.equal(wave.icon, 'lucide:waves');
  assert.equal(wave.overlaid, 'container label');
  assert.equal(wave.configured, false);
  assert.deepEqual(wave.meta, [{ label: 'Library', value: '312 GB FLAC' }]);
  assert.ok(doc.groups.some((g) => g.name === 'Music'), 'the label created the group heading');
  assert.equal(doc.groups.find((g) => g.name === 'Music').configured, false, '…and marks it as discovered');
});

test('stacks come from compose projects with no stacks.yaml, and nothing more', async () => {
  const doc = await m.getStacksDoc();
  assert.deepEqual(doc.unmatched, []);
  const projects = doc.stacks.map((s) => s.project).sort();
  assert.deepEqual(projects, ['cloud', 'home', 'observability', 'opustream', 'photos', 'secure', 'update']);
  assert.equal(doc.stacks.every((s) => s.source === 'discovered'), true);
  assert.equal(doc.stacks.every((s) => s.displayName && s.description === null), true, 'a name, and no invented prose');
  assert.equal(doc.stacks.find((s) => s.project === 'opustream').name, 'Opustream', 'project name ≠ directory name, humanized for display');
  const photos = doc.stacks.find((s) => s.project === 'photos');
  assert.equal(photos.containerCount, 3);
  assert.equal(photos.runningCount, 2);
  assert.equal(photos.status, 'degraded');
  assert.deepEqual(doc.standalone.map((c) => c.name).sort(), ['nightly-backup-runner-with-a-remarkably-long-name', 'opushub', 'restart-loop', 'traefik']);
});

test('infrastructure rails are inventoried, labelled with why, and excluded from the app grid', async () => {
  const doc = await m.getServicesView();
  const infra = doc.infrastructure;
  for (const name of ['postgres', 'redis', 'photos-db', 'mariadb', 'observability-loki-1', 'watchtower', 'immich-machine-learning']) {
    assert.ok(infra.some((s) => s.name === name), `${name} is a rail, listed as such`);
  }
  assert.ok(infra.every((s) => s.kind === 'infrastructure' && s.kindSource));
  assert.ok(infra.some((s) => s.name === 'traefik' || s.name === 'observability-prometheus-1'), '…and a rail with a port still gets one');
  const apps = doc.groups.flatMap((g) => g.services.map((s) => s.name));
  assert.equal(apps.includes('redis'), false);
  assert.equal(apps.includes('redis'), false, 'a bare cache is not an app');
  assert.ok(apps.includes('observability-grafana-1'), 'grafana is deliberately routed, so it reads as an app');
  assert.equal(doc.stats.applications + doc.stats.infrastructure, 25);
});

test('a missing config file is not an error — the overlay is simply empty', async () => {
  fs.rmSync(path.join(CONFIG_DIR, 'services.yaml'));
  fs.rmSync(path.join(CONFIG_DIR, 'stacks.yaml'));
  await m.invalidateDiscovery();
  const doc = await m.getServicesView();
  assert.equal(doc.live, true);
  assert.equal(doc.stats.containers, 25, 'the inventory is Docker’s, files or not');
  assert.deepEqual(doc.skipped, []);
  const stacks = await m.getStacksDoc();
  assert.equal(stacks.stacks.length, 7);
});
