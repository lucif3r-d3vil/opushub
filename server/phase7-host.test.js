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

// Phase 9 implements ZFS (see server/providers/zfs.js). The provider no longer answers
// 'not-implemented': it either read pools and datasets from `zpool`/`zfs`, or it says plainly
// that it could not. What must never change is the second half of the old guarantee — a ZFS
// document is only ever built from ZFS's own output, never from filesystem statistics.
test('zfs provider answers from ZFS or says it could not, and never borrows filesystem numbers', async () => {
  const p = new ZFSProvider();
  const doc = await p.describe();
  assert.ok(['boolean'].includes(typeof doc.available), 'available is a boolean, never a guess');
  assert.ok(Array.isArray(doc.pools) && Array.isArray(doc.datasets));
  if (doc.available) {
    // real ZFS output: every pool has a name, and every dataset belongs to a pool it reported
    assert.ok(doc.pools.every((x) => typeof x.name === 'string' && x.name));
    for (const d of doc.datasets) assert.ok(doc.pools.some((x) => x.name === d.pool));
  } else {
    // unavailable: a reason in words, and no numbers pretending to be ZFS measurements
    assert.match(doc.reason || '', /\S/);
    assert.deepEqual(doc.pools, []);
    assert.deepEqual(doc.datasets, []);
  }
  // the filesystem provider's mounts are never presented as ZFS datasets
  const fs = await new LinuxFilesystemProvider().describe();
  const fsMounts = new Set((fs.mounts || []).map((m) => m.mount));
  for (const d of doc.datasets) assert.ok(!fsMounts.has(d.name), `${d.name} came from /proc/mounts`);
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
