// ZFSProvider — read-only ZFS intelligence behind a *fixed command table*.
//
// ZFS state is only available through the `zpool` and `zfs` commands. That is exactly the kind of
// thing that turns a control plane into a shell, so the boundary here is deliberately narrow:
//
//   • there is NO exec(command). There is no function that takes a command string, and no call
//     site that builds one. Three commands exist, each a frozen { bin, args } pair below, and the
//     only thing a caller may add is a pool or dataset NAME taken from our own discovery output.
//   • no shell: execFile is called with an argv array, never with `shell: true`, never through
//     /bin/sh, so metacharacters in any argument are data, never syntax.
//   • names are validated twice: against a strict character/format rule, AND against the set of
//     names this provider itself discovered. A name that is not in our own output is refused
//     before a process is spawned — the same rule that keeps Docker targets inventory-only.
//   • bounded: one command per call, hard timeout, capped output, no retries, no polling loop of
//     its own (the registry's TTL cache decides how often this runs).
//
// If the binaries are not reachable — the normal case for OpusHub in a container — the provider
// answers `unavailable` with a plain reason. It never borrows filesystem numbers and calls them
// ZFS numbers, and it never guesses a pool name.
//
// Parsing is defensive on purpose: `zpool`/`zfs` output is text, and a half-parsed line is worse
// than an honest "Not available". Anything unexpected drops the field to null (or, for topology,
// reports the topology as unavailable) rather than inventing a vdev layout.
import fs from 'node:fs';
import { execFile } from 'node:child_process';

/* ------------------------------------------------------------------ */
/* the command table                                                   */
/* ------------------------------------------------------------------ */

/**
 * The complete set of commands this provider can run. Frozen. Exhaustive.
 *
 * `-H` (no headers, tab-separated) and `-p` (exact byte counts) make the output a stable,
 * machine-readable shape; every column named here is one we parse, and nothing else is read.
 */
const COMMANDS = Object.freeze({
  poolList: Object.freeze({ bin: 'zpool', args: Object.freeze(['list', '-Hp', '-o', 'name,size,alloc,free,frag,cap,health']) }),
  /** `-v` adds the vdev rows; that is the only source of topology, and it is optional. */
  poolTopology: Object.freeze({ bin: 'zpool', args: Object.freeze(['list', '-Hpv', '-o', 'name,size,alloc,free,frag,cap,health']) }),
  datasetList: Object.freeze({
    bin: 'zfs',
    args: Object.freeze(['list', '-Hp', '-t', 'filesystem,volume', '-o', 'name,used,avail,refer,mountpoint,compression,recordsize,quota']),
  }),
});

/**
 * Where the binaries may live. Not configurable from a request, not configurable at all: the
 * first candidate that exists wins, and the bare name falls through to PATH.
 */
const BIN_DIRS = Object.freeze(['/usr/sbin', '/sbin', '/usr/local/sbin', '/usr/bin', '/usr/local/bin']);

export const ZFS_BINARIES = Object.freeze(['zpool', 'zfs']);

/* ------------------------------------------------------------------ */
/* names                                                               */
/* ------------------------------------------------------------------ */

/** Pool names: letters, digits and the four characters ZFS itself allows. No slashes, no leading -. */
const POOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
/** Dataset names add `/` for the hierarchy. Still no spaces, no `..`, no leading `-`, no `@`. */
const DATASET_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,255}$/;

/**
 * Reject anything that could be read as an option, an escape, or a second word. Both rules are
 * belt-and-braces on top of "the name came from our own output" — argv is an array, so none of
 * these characters would be syntax anyway, but a provider that accepts them is one refactor away
 * from one that does.
 */
function safeName(name, re) {
  if (typeof name !== 'string' || !name) return false;
  if (!re.test(name)) return false;
  if (name.includes('..')) return false;
  if (name.startsWith('-')) return false;
  if (/[\s'"$`;&|<>()\\]/.test(name)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

/** `-` is ZFS's "not applicable here". It is not zero, and it is never rendered as zero. */
function num(field) {
  const s = String(field ?? '').trim();
  if (!s || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function text(field) {
  const s = String(field ?? '').trim();
  return (!s || s === '-') ? null : s.slice(0, 200);
}

const HEALTH_WORDS = new Set(['ONLINE', 'DEGRADED', 'FAULTED', 'OFFLINE', 'REMOVED', 'UNAVAIL', 'SUSPENDED']);

/** Health is one word from a known vocabulary; anything else is unknown, not assumed well. */
function health(field) {
  const s = String(field ?? '').trim().toUpperCase();
  return HEALTH_WORDS.has(s) ? s : null;
}

/**
 * A dataset's mountpoint is information about the operator's own storage, so it is shown — but
 * `legacy`/`none` are ZFS's way of saying "not mounted here", and that is null, not a path.
 */
function mountpoint(field) {
  const s = text(field);
  if (!s || s === 'legacy' || s === 'none') return null;
  return s;
}

export function parsePoolList(stdout) {
  const pools = [];
  let malformed = 0;
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 7) { malformed += 1; continue; }
    const name = f[0].trim();
    if (!safeName(name, POOL_NAME)) { malformed += 1; continue; }
    const size = num(f[1]);
    const alloc = num(f[2]);
    const free = num(f[3]);
    pools.push({
      name,
      size,
      allocated: alloc,
      free,
      fragmentationPct: num(f[4]),
      capacityPct: num(f[5]),
      health: health(f[6]),
      // derived, and only when both halves were actually reported
      usedPct: size && alloc != null ? Math.round((100 * alloc) / size) : null,
    });
  }
  return { pools, malformed };
}

/**
 * Parse `zpool list -v` output into a two-level vdev summary.
 *
 * Rows with no leading whitespace are pools; an indented row belongs to the nearest row above it
 * that is less indented. ZFS does not publish vdev *types* through this command, so none are
 * claimed — a row with children is reported as a group, a row without is a leaf, and nothing is
 * called "mirror" or "raidz" unless the name itself says so (ZFS names those vdevs `mirror-N`
 * and `raidz-N`, which is the device's own word, not ours).
 *
 * Device paths are never published: a name containing `/` is reduced to its last segment.
 */
export function parsePoolTopology(stdout, poolName) {
  const rows = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 7) return { available: false, reason: 'ZFS returned a vdev row OpusHub could not read.', vdevs: [] };
    const raw = f[0];
    const name = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (!name) return { available: false, reason: 'ZFS returned a vdev row without a name.', vdevs: [] };
    rows.push({
      name: name.includes('/') ? name.split('/').pop() : name,
      pathHidden: name.includes('/'),
      depth: Math.min(3, Math.floor(indent / 2)),
      size: num(f[1]),
      allocated: num(f[2]),
      free: num(f[3]),
      fragmentationPct: num(f[4]),
      capacityPct: num(f[5]),
      health: health(f[6]),
    });
  }
  if (!rows.length) return { available: false, reason: 'ZFS reported no topology rows for this pool.', vdevs: [] };

  // The first row is the pool itself. Anything indented under it is its topology.
  const head = rows[0];
  if (head.name !== poolName) {
    return { available: false, reason: 'ZFS returned a different pool than the one asked for.', vdevs: [] };
  }
  const children = rows.slice(1);
  if (!children.length) {
    return { available: false, reason: 'ZFS did not report vdev details for this pool.', vdevs: [] };
  }
  // Build parent/child from indentation, defensively: an orphan row is attached to the pool
  // rather than dropped, and a row that would nest deeper than we track is clamped to the last
  // level we understand instead of being invented as a new one.
  const out = [];
  const stack = [];
  for (const row of children) {
    const depth = Math.max(1, row.depth);
    const node = { ...row, depth, children: [] };
    stack.length = Math.min(stack.length, depth - 1);
    if (depth <= 1) out.push(node);
    else if (!stack.length) out.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
    while (stack.length > depth) stack.pop();
  }
  return { available: true, reason: null, vdevs: out };
}

export function parseDatasetList(stdout) {
  const datasets = [];
  let malformed = 0;
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 8) { malformed += 1; continue; }
    const name = f[0].trim();
    if (!safeName(name, DATASET_NAME)) { malformed += 1; continue; }
    const quota = num(f[7]);
    const used = num(f[1]);
    datasets.push({
      name,
      pool: name.includes('/') ? name.split('/')[0] : name,
      used,
      available: num(f[2]),
      referenced: num(f[3]),
      mountpoint: mountpoint(f[4]),
      compression: text(f[5]),
      recordsize: num(f[6]),
      quota: quota === 0 ? null : quota, // 0 means "no quota" in ZFS's parseable output
      quotaUsedPct: quota && quota > 0 && used != null ? Math.round((100 * used) / quota) : null,
    });
  }
  return { datasets, malformed };
}

/* ------------------------------------------------------------------ */
/* the runner                                                          */
/* ------------------------------------------------------------------ */

const RUN_TIMEOUT_MS = 4000;
const MAX_OUTPUT = 256 * 1024;

const resolvedBins = new Map();

/** Which absolute path `zpool`/`zfs` lives at, or null when neither is reachable. */
export function resolveBinary(name) {
  if (!ZFS_BINARIES.includes(name)) return null;
  if (resolvedBins.has(name)) return resolvedBins.get(name);
  let found = null;
  for (const dir of BIN_DIRS) {
    const candidate = `${dir}/${name}`;
    try {
      if (fs.statSync(candidate).isFile()) { found = candidate; break; }
    } catch { /* next candidate */ }
  }
  // The bare name lets execFile search PATH — which is how a source checkout on a ZFS host works.
  const value = found || name;
  resolvedBins.set(name, value);
  return value;
}

/** Test helper — binary resolution is cached per process. */
export function _resetBinaryCache() { resolvedBins.clear(); }

/**
 * The one process call in this file. No shell, no environment inheritance beyond PATH, bounded
 * output and a hard timeout.
 */
function defaultRunner(bin, args) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const child = execFile(bin, args, {
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      encoding: 'utf8',
      env: { PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      if (error) {
        // The command's own text is for the server log only — it can name paths and devices.
        if (process.env.OPUSHUB_DEBUG) {
          console.warn(`[zfs] ${bin} ${args.join(' ')} failed: ${String(error.message).slice(0, 200)}`);
        }
        // exit code 1 from `zfs list` with no rows is "nothing to list", not a failure; callers
        // distinguish the two by what came back on stdout.
        return done({ ok: false, code: error.code === 'ENOENT' ? 'ENOENT' : 'FAILED', stdout: String(stdout || ''), stderr: '' });
      }
      done({ ok: true, code: 0, stdout: String(stdout || ''), stderr: '' });
    });
    child.on('error', (err) => done({ ok: false, code: err?.code || 'FAILED', stdout: '', stderr: '' }));
  });
}

/* ------------------------------------------------------------------ */
/* the provider                                                        */
/* ------------------------------------------------------------------ */

export function zfsUnavailable(code, reason) {
  return { status: 'unavailable', capabilities: [], version: null, error: { code, reason }, data: null };
}

/**
 * Build a ZFS provider.
 *
 * @param runner   injectable command runner (tests inject fixtures; nothing else ever needs to)
 */
export function createZfsProvider({ runner = defaultRunner, binaries = null } = {}) {
  const bin = (name) => (binaries ? binaries[name] || null : resolveBinary(name));

  /** Run one entry from the frozen command table, optionally with one validated name appended. */
  async function run(command, name = null) {
    const spec = COMMANDS[command];
    if (!spec) return { ok: false, code: 'FAILED', stdout: '' };
    const path = bin(spec.bin);
    if (!path) return { ok: false, code: 'ENOENT', stdout: '' };
    const args = name ? [...spec.args, name] : [...spec.args];
    return runner(path, args);
  }

  async function binaryState() {
    const zpool = bin('zpool');
    const zfs = bin('zfs');
    if (!zpool || !zfs) return 'missing';
    return 'present';
  }

  /**
   * The registry check: one `zpool list` and one `zfs list`, and nothing else. Everything the
   * storage domain shows comes from these two answers, which is also why a page full of ZFS
   * panels still costs two commands per cache window.
   */
  async function check() {
    if ((await binaryState()) === 'missing') {
      return zfsUnavailable('command_missing', 'The ZFS command-line tools are not available to OpusHub.');
    }
    const poolsRun = await run('poolList');
    if (!poolsRun.ok) {
      return zfsUnavailable('command_failed', 'The zpool command did not succeed — OpusHub cannot read ZFS state, or no pools are imported.');
    }
    const { pools, malformed: poolMalformed } = parsePoolList(poolsRun.stdout);
    if (!pools.length && poolMalformed) {
      return zfsUnavailable('parse_error', 'ZFS returned pool information OpusHub could not read.');
    }
    const datasetRun = await run('datasetList');
    const parsed = datasetRun.ok
      ? parseDatasetList(datasetRun.stdout)
      : { datasets: [], malformed: 0 };
    const datasets = parsed.datasets.filter((d) => pools.some((p) => p.name === d.pool));
    const version = null; // `zpool --version` is not needed to answer anything the UI asks
    return {
      status: pools.length ? 'available' : 'available',
      capabilities: ['pools', 'datasets'],
      version,
      error: null,
      data: {
        pools,
        datasets,
        empty: pools.length === 0,
        malformed: { pools: poolMalformed, datasets: parsed.malformed },
        datasetsUnavailable: !datasetRun.ok,
        at: Date.now(),
      },
    };
  }

  /**
   * listPools() — the pools ZFS itself reported. No name is invented and none is assumed.
   */
  async function listPools() {
    const result = await checkProviderCached();
    return result?.data?.pools ?? [];
  }

  /** listDatasets() — the datasets ZFS itself reported, for pools it also reported. */
  async function listDatasets() {
    const result = await checkProviderCached();
    return result?.data?.datasets ?? [];
  }

  /**
   * getPoolStatus(name) — one pool, with its topology when ZFS will say.
   *
   * `name` MUST be one this provider discovered. An unknown name is refused here, before a
   * process is spawned, and the refusal is not an error the caller has to interpret: it returns
   * null and the route answers 404.
   */
  async function getPoolStatus(name) {
    if (!safeName(name, POOL_NAME)) return null;
    const pools = await listPools();
    const pool = pools.find((p) => p.name === name);
    if (!pool) return null;
    const topoRun = await run('poolTopology', name);
    const topology = topoRun.ok
      ? parsePoolTopology(topoRun.stdout, name)
      : { available: false, reason: 'ZFS did not report the pool layout.', vdevs: [] };
    return {
      ...pool,
      datasets: (await listDatasets()).filter((d) => d.pool === name).length,
      topology,
      at: Date.now(),
    };
  }

  /** getDataset(name) — one dataset, or null when ZFS never reported that name. */
  async function getDataset(name) {
    if (!safeName(name, DATASET_NAME)) return null;
    const datasets = await listDatasets();
    return datasets.find((d) => d.name === name) || null;
  }

  /** The provider owns its own cache so detail calls reuse the list answer. */
  let cachedAt = 0;
  let cached = null;
  let inflight = null;
  async function checkProviderCached() {
    if (cached && Date.now() - cachedAt < 30_000) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
      const value = await check();
      cached = value; cachedAt = Date.now();
      return value;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  return {
    id: 'zfs',
    methods: { listPools, getPoolStatus, listDatasets, getDataset },
    check,
    // test/ops visibility: the command table is the security boundary, so let tests read it
    _internals: { COMMANDS, POOL_NAME, DATASET_NAME, safeName, run },
  };
}

/** The provider used in production. Tests build their own with an injected runner. */
export const zfsProvider = createZfsProvider();
