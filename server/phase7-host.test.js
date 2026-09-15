// Phase 7A — host model, versioning, storage providers, Docker inventory projections.
// The mock engine speaks the genuine Docker HTTP-over-socket protocol (see test/mock-engine.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockEngine } from '../test/mock-engine.js';
import * as docker from './providers/docker.js';
import { describeStorage, LinuxFilesystemProvider, ZFSProvider } from './providers/storage.js';
import { versionInfo, _resetVersion } from './version.js';

const OLD_ENV = { ...process.env };
let ENGINE = null;

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
});

test.after(async () => {
  await ENGINE?.stop();
  process.env = OLD_ENV;
});

// --- version ----------------------------------------------------------------

test('versionInfo answers honestly: a version always, SHAs only when known', () => {
  _resetVersion();
  const v = versionInfo();
  assert.equal(v.name, 'OpusHub');
  assert.ok(typeof v.version === 'string' && v.version.length);
  assert.ok(['docker', 'source'].includes(v.installationMode));
  assert.ok(v.gitSha === null || /^[0-9a-f]{7,40}$/i.test(v.gitSha));
  assert.ok(v.buildTime === null || typeof v.buildTime === 'string');
  assert.ok(v.imageTag === null || typeof v.imageTag === 'string');
});

// --- storage providers -------------------------------------------------------

test('filesystem provider reports real mounts with totals', async () => {
  const p = new LinuxFilesystemProvider();
  const doc = await p.describe();
  assert.equal(doc.id, 'filesystem');
  assert.equal(doc.available, true);
  assert.ok(Array.isArray(doc.mounts) && doc.mounts.length);
  for (const m of doc.mounts.slice(0, 5)) {
    assert.ok(m.mount && m.total > 0 && m.usedPct != null);
  }
  assert.ok(doc.totals && doc.totals.total >= doc.totals.used);
});

test('zfs provider reports not-implemented rather than borrowing numbers', async () => {
  const p = new ZFSProvider();
  const doc = await p.describe();
  assert.equal(doc.available, 'not-implemented');
  assert.deepEqual(doc.pools, []);
  assert.match(doc.reason, /not implemented/i);
});

test('describeStorage aggregates every provider without throwing', async () => {
  const doc = await describeStorage();
  assert.equal(doc.providers.length, 2);
  assert.deepEqual(doc.providers.map((p) => p.id), ['filesystem', 'zfs']);
});

// --- docker inventory projections --------------------------------------------

test('listNetworks projects safe topology: names and membership, no addressing', async () => {
  const nets = await docker.listNetworks();
  assert.ok(nets.length >= 3);
  const names = nets.map((n) => n.name);
  assert.ok(names.includes('proxy'));
  const proxy = nets.find((n) => n.name === 'proxy');
  assert.equal(proxy.driver, 'bridge');
  assert.equal(proxy.attachable, true);
  assert.ok(proxy.containerCount >= 2);
  assert.ok(proxy.containers.every((c) => typeof c.name === 'string'));
  const blob = JSON.stringify(nets);
  assert.doesNotMatch(blob, /IPv4Address/);
  assert.doesNotMatch(blob, /MacAddress/);
  assert.doesNotMatch(blob, /172\.(28|29)\./);
});

test('listVolumes projects names and usage, never host mountpoints', async () => {
  const vols = await docker.listVolumes();
  assert.ok(vols.length >= 3);
  const cfg = vols.find((v) => v.name === 'jellyfin-config');
  assert.ok(cfg);
  assert.equal(cfg.driver, 'local');
  assert.equal(cfg.refCount, 1);
  assert.ok(cfg.size > 0);
  const blob = JSON.stringify(vols);
  assert.doesNotMatch(blob, /Mountpoint/);
  assert.doesNotMatch(blob, /\/var\/lib\/docker/);
});

test('listImages projects tags and sizes, never config or labels', async () => {
  const images = await docker.listImages();
  assert.ok(images.length >= 1);
  for (const i of images) {
    assert.ok(i.id === null || i.id.length === 12);
    assert.ok(Array.isArray(i.tags));
    assert.ok(!('Config' in i) && !('Labels' in i) && !('Env' in i));
  }
});

// --- canonical host document --------------------------------------------------

test('hostDocument combines system, engine, traefik and version in one shape', async () => {
  const { hostDocument, _resetHost } = await import('./host.js');
  _resetHost();
  const doc = await hostDocument();
  assert.ok(doc.at);
  assert.ok(doc.host.hostname);
  assert.ok(doc.cpu.cores > 0);
  assert.ok(doc.memory.total > 0);
  assert.equal(doc.docker.version, '26.1.0-mock');
  assert.equal(doc.docker.status, 'connected');
  assert.equal(doc.traefik.detected, true);
  assert.ok(doc.traefik.entrypoints.includes('web'));
  assert.ok(doc.traefik.entrypoints.includes('websecure'));
  assert.equal(doc.opushub.name, 'OpusHub');
  const blob = JSON.stringify(doc);
  assert.doesNotMatch(blob, /docker\.sock/);
  assert.doesNotMatch(blob, /hunter2|MOCK_FIXTURE/);
});
