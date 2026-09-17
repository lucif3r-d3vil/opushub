// Phase 9B — storage: filesystem discovery, ZFS pool and dataset parsing, malformed output,
// the command boundary, and the refusal of any name ZFS itself never reported.
//
// The ZFS provider is the one module in OpusHub that runs a command, so most of this file is
// about how little it can be asked to do: a fixed table, an argv array, no shell, and names that
// have to come from ZFS's own output before a process is spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9store-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9store-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const { createZfsProvider, parsePoolList, parseDatasetList, parsePoolTopology, zfsUnavailable } = await import('./providers/zfs.js');
const { LinuxFilesystemProvider, filesystemCheck, zfsCheck } = await import('./providers/storage.js');

test.after(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const POOL_LIST = [
  ['tank', '8000000000000', '3200000000000', '4800000000000', '4', '40', 'ONLINE'],
  ['backup', '2000000000000', '1900000000000', '100000000000', '12', '95', 'DEGRADED'],
].map((r) => r.join('\t')).join('\n') + '\n';

const DATASET_LIST = [
  ['tank', '3200000000000', '4800000000000', '268435456', '/tank', 'lz4', '131072', '0'],
  ['tank/media', '2000000000000', '4800000000000', '2000000000000', '/tank/media', 'lz4', '1048576', '3000000000000'],
  ['backup', '1900000000000', '100000000000', '1900000000000', 'legacy', 'off', '131072', '0'],
].map((r) => r.join('\t')).join('\n') + '\n';

const TOPOLOGY = [
  ['tank', '8000000000000', '3200000000000', '4800000000000', '4', '40', 'ONLINE'],
  ['  mirror-0', '4000000000000', '1600000000000', '2400000000000', '4', '40', 'ONLINE'],
  ['    /dev/disk/by-id/ata-SERIAL-1', '-', '-', '-', '-', '-', 'ONLINE'],
  ['    /dev/disk/by-id/ata-SERIAL-2', '-', '-', '-', '-', '-', 'ONLINE'],
].map((r) => r.join('\t')).join('\n') + '\n';

/**
 * A runner that answers from a fixture table and records everything it was asked to run.
 * The key is derived the way the command table is: which binary, and which of the three commands.
 */
function fakeRunner(table = {}) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push({ bin, args: [...args] });
    const kind = String(bin).endsWith('zfs') ? 'dataset' : (args.some((a) => /^-[A-Za-z]*v[A-Za-z]*$/.test(a)) ? 'topology' : 'pool');
    if (table.fail === kind) return { ok: false, code: 'FAILED', stdout: '' };
    return { ok: true, code: 0, stdout: table[kind] ?? '' };
  };
  run.calls = calls;
  return run;
}

const BINS = Object.freeze({ zpool: '/usr/sbin/zpool', zfs: '/usr/sbin/zfs' });

const providerWith = (table) => createZfsProvider({
  runner: fakeRunner(table),
  binaries: BINS,
});

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

test('pool parsing reads exactly what zpool printed, and nothing more', () => {
  const { pools, malformed } = parsePoolList(POOL_LIST);
  assert.equal(malformed, 0);
  assert.deepEqual(pools.map((p) => p.name), ['tank', 'backup']);
  const tank = pools[0];
  assert.equal(tank.size, 8_000_000_000_000);
  assert.equal(tank.allocated, 3_200_000_000_000);
  assert.equal(tank.free, 4_800_000_000_000);
  assert.equal(tank.fragmentationPct, 4);
  assert.equal(tank.capacityPct, 40);
  assert.equal(tank.health, 'ONLINE');
  // no pool name is assumed — two pools, two names, both from the output
  assert.equal(pools[1].health, 'DEGRADED');
});

test('malformed pool output is skipped and counted, never guessed at', () => {
  const mixed = `${POOL_LIST}garbage line without tabs\n${['tank2', '-', '-', '-', '-', '-', 'ONLINE'].join('\t')}\n`;
  const { pools, malformed } = parsePoolList(mixed);
  assert.equal(malformed, 1);
  assert.ok(pools.every((p) => p.name && typeof p.name === 'string'));
  // a pool whose size ZFS did not report is null, not zero
  const thin = pools.find((p) => p.name === 'tank2');
  assert.equal(thin.size, null);
  assert.equal(thin.usedPct, null);
});

test('dataset parsing separates a dataset from a pool, and a quota from no quota', () => {
  const { datasets } = parseDatasetList(DATASET_LIST);
  assert.deepEqual(datasets.map((d) => d.name), ['tank', 'tank/media', 'backup']);
  const media = datasets[1];
  assert.equal(media.pool, 'tank');
  assert.equal(media.used, 2_000_000_000_000);
  assert.equal(media.referenced, 2_000_000_000_000);
  assert.equal(media.compression, 'lz4');
  assert.equal(media.recordsize, 1_048_576);
  assert.equal(media.quota, 3_000_000_000_000);
  assert.equal(media.quotaUsedPct, 67);
  // quota 0 is ZFS's "no quota", and it is reported as no quota — not as a 0-byte limit
  assert.equal(datasets[0].quota, null);
  assert.equal(datasets[0].quotaUsedPct, null);
  // `legacy` is not a mountpoint
  assert.equal(datasets[2].mountpoint, null);
});

test('vdev topology is reported when ZFS reports it, and device paths are never published', () => {
  const parsed = parsePoolTopology(TOPOLOGY, 'tank');
  assert.equal(parsed.available, true);
  assert.equal(parsed.vdevs.length, 1);
  assert.equal(parsed.vdevs[0].name, 'mirror-0');
  assert.equal(parsed.vdevs[0].children.length, 2);
  const leaf = parsed.vdevs[0].children[0];
  assert.equal(leaf.name, 'ata-SERIAL-1', 'a device path is reduced to its last segment');
  assert.equal(leaf.pathHidden, true);
  const blob = JSON.stringify(parsed);
  assert.ok(!blob.includes('/dev/disk/by-id'), 'a device path leaked into the topology');
});

test('topology is "not available" rather than invented when ZFS will not describe it', () => {
  // one row: a pool with no vdev detail — the most common case on an older build
  const only = parsePoolTopology(['tank', '-', '-', '-', '-', '-', 'ONLINE'].join('\t'), 'tank');
  assert.equal(only.available, false);
  assert.match(only.reason, /did not report vdev details/);
  // a truncated row is refused outright
  const broken = parsePoolTopology(`${['tank', '1', '2'].join('\t')}\n`, 'tank');
  assert.equal(broken.available, false);
  assert.match(broken.reason, /could not read/);
  // and a different pool than the one asked for is not accepted
  const wrong = parsePoolTopology(TOPOLOGY, 'rpool');
  assert.equal(wrong.available, false);
});

/* ------------------------------------------------------------------ */
/* the provider                                                        */
/* ------------------------------------------------------------------ */

test('the provider reports pools and datasets from two commands, and nothing else', async () => {
  const p = providerWith({ pool: POOL_LIST, dataset: DATASET_LIST, topology: TOPOLOGY });
  const runner = p.methods ? null : null; void runner;
  const result = await p.check();
  assert.equal(result.status, 'available');
  assert.deepEqual(result.capabilities, ['pools', 'datasets']);
  assert.equal(result.data.pools.length, 2);
  assert.equal(result.data.datasets.length, 3);
  assert.equal(result.data.empty, false);
});

test('the command table is the whole surface: three commands, fixed argv, no shell', () => {
  const { COMMANDS } = createZfsProvider({ runner: async () => ({ ok: true, stdout: '' }) })._internals;
  assert.deepEqual(Object.keys(COMMANDS).sort(), ['datasetList', 'poolList', 'poolTopology']);
  for (const spec of Object.values(COMMANDS)) {
    assert.ok(Object.isFrozen(spec), 'each command is frozen');
    assert.ok(Object.isFrozen(spec.args), 'the argument vector is frozen');
    assert.ok(['zpool', 'zfs'].includes(spec.bin));
    for (const arg of spec.args) {
      assert.equal(typeof arg, 'string');
      assert.ok(!/\s/.test(arg) || arg === 'name,size,alloc,free,frag,cap,health', 'no shell word in an argument');
    }
  }
});

test('no binary, no command: the provider answers unavailable instead of trying', async () => {
  let called = false;
  const p = createZfsProvider({
    binaries: Object.freeze({ zpool: null, zfs: null }),
    runner: async () => { called = true; return { ok: true, stdout: '' }; },
  });
  const result = await p.check();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error.code, 'command_missing');
  assert.match(result.error.reason, /not available/i);
  assert.equal(called, false, 'nothing was spawned');
  assert.deepEqual(await p.methods.listPools(), []);
  assert.deepEqual(await p.methods.listDatasets(), []);
});

test('a command that fails is reported as unavailable, with a public reason and no stdout echo', async () => {
  const p = providerWith({ fail: 'pool' });
  const result = await p.check();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error.code, 'command_failed');
  assert.match(result.error.reason, /did not succeed/);
  assert.ok(!JSON.stringify(result).includes('stderr'));
});

test('ZFS present with no pools imported is available and empty — not unavailable, not full', async () => {
  const p = providerWith({ pool: '', dataset: '' });
  const result = await p.check();
  assert.equal(result.status, 'available');
  assert.equal(result.data.empty, true);
  assert.deepEqual(result.data.pools, []);
  assert.deepEqual(result.data.datasets, []);
});

test('a name ZFS never reported is refused before a process is spawned', async () => {
  const runner = fakeRunner({ pool: POOL_LIST, dataset: DATASET_LIST, topology: TOPOLOGY });
  const p = createZfsProvider({ runner, binaries: BINS });
  // discovery first: from here on, the provider's own cache is what a name is checked against
  const discovered = await p.methods.listPools();
  assert.deepEqual(discovered.map((x) => x.name), ['tank', 'backup']);
  const afterList = runner.calls.length;

  for (const name of ['rpool', 'tank/media/../../etc', '-o', 'tank; rm -rf /', 'tank $(id)', '', 'TANK']) {
    assert.equal(await p.methods.getPoolStatus(name), null, `pool "${name}" must be refused`);
    assert.equal(await p.methods.getDataset(name), null, `dataset "${name}" must be refused`);
  }
  assert.equal(runner.calls.length, afterList, 'no command was run for a name ZFS never reported');
});

test('a known name costs one command, and the list is not re-read to answer it', async () => {
  const runner = fakeRunner({ pool: POOL_LIST, dataset: DATASET_LIST, topology: TOPOLOGY });
  const p = createZfsProvider({ runner, binaries: BINS });
  await p.methods.listPools();
  const before = runner.calls.length;

  const pool = await p.methods.getPoolStatus('tank');
  assert.ok(pool, 'a pool ZFS reported is found');
  assert.equal(pool.name, 'tank');
  assert.equal(pool.health, 'ONLINE');
  assert.ok(Array.isArray(pool.topology.vdevs), 'the detail carries a topology answer');

  const dataset = await p.methods.getDataset('tank/media');
  assert.equal(dataset?.name, 'tank/media');

  const added = runner.calls.slice(before);
  assert.equal(added.length, 1, `one command for one pool detail, not a re-list: ${JSON.stringify(added)}`);
  assert.ok(added[0].args.some((a) => /^-[A-Za-z]*v/.test(a)), `and it is the topology read, nothing else: ${added[0].args.join(' ')}`);
  assert.equal(added[0].args[added[0].args.length - 1], 'tank', 'the validated name is appended last');
});

test('only names from the frozen table reach the runner, with a validated name appended last', async () => {
  const runner = fakeRunner({ pool: POOL_LIST, dataset: DATASET_LIST, topology: TOPOLOGY });
  const p = createZfsProvider({ runner, binaries: BINS });
  await p.check();
  const { run } = p._internals;
  // the table is the allow-list: anything else is refused without a process
  assert.deepEqual(await run('destroy', 'tank'), { ok: false, code: 'FAILED', stdout: '' });
  for (const call of runner.calls) {
    assert.ok(['zpool', 'zfs'].includes(call.bin.replace(/^\/usr\/sbin\//, '')));
    assert.ok(Array.isArray(call.args));
    assert.ok(call.args.every((a) => typeof a === 'string'));
    assert.ok(!call.args.some((a) => /[;&|`$]/.test(a)), `a shell metacharacter reached argv: ${call.args}`);
  }
});

test('the filesystem provider reads real mounts and reports totals', async () => {
  const doc = await new LinuxFilesystemProvider().describe();
  assert.equal(doc.id, 'filesystem');
  if (doc.available) {
    assert.ok(Array.isArray(doc.mounts));
    for (const m of doc.mounts) {
      assert.ok(m.mount && typeof m.total === 'number' && m.total > 0);
      assert.ok(m.used + m.free <= m.total + 1, 'usage never exceeds the size the kernel reported');
    }
    assert.ok(doc.totals.total >= doc.totals.used);
  } else {
    assert.match(doc.reason || '', /\S/, 'an unavailable provider still says why');
  }
});

test('both storage providers answer in registry shape, and neither borrows the other’s numbers', async () => {
  const [fs, zfs] = await Promise.all([filesystemCheck(), zfsCheck()]);
  assert.ok(['available', 'unavailable'].includes(fs.status));
  assert.ok(['available', 'unavailable'].includes(zfs.status));
  // never 'not-implemented' any more: ZFS is implemented, so it either read or it says it could not
  assert.notEqual(zfs.data.available, 'not-implemented');
  if (zfs.status === 'unavailable') {
    assert.deepEqual(zfs.data.pools, [], 'no pool numbers without ZFS');
    assert.match(zfs.data.reason || '', /\S/);
  }
  assert.equal(fs.data.id, 'filesystem');
  assert.equal(zfs.data.id, 'zfs');
});

test('an unavailable provider says so in one public sentence', () => {
  const doc = zfsUnavailable('command_missing', 'The ZFS command-line tools are not available to OpusHub.');
  assert.equal(doc.status, 'unavailable');
  assert.deepEqual(doc.capabilities, []);
  assert.equal(doc.data, null);
  assert.equal(doc.error.code, 'command_missing');
});
