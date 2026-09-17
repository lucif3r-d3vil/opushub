// Storage providers — one contract, honest availability per implementation.
//
//   StorageProvider   { id, label, available(), describe() }
//     LinuxFilesystemProvider   real mounts from /proc/mounts + statfs (always attempted)
//     ZFSProvider               real pools/datasets from `zpool`/`zfs` behind a frozen command
//                               table (see ./zfs.js) — unavailable when the tools are not
//                               reachable, and NEVER borrowing filesystem stats as ZFS stats
//
// The four concepts stay separate, because flattening them is what makes a storage page lie:
//
//   filesystem   a mount the kernel reports (/proc/mounts + statfs): device, fs type, size, usage
//   pool         a ZFS storage pool: size, allocated, free, fragmentation, health, topology
//   dataset      a ZFS dataset: used, available, referenced, compression, recordsize, quota
//   mount        where a dataset is mounted — reported only when ZFS reports one
//
// `describe()` returns { id, label, available, reason, pools|mounts, at } where `available` is
// true or false. Callers render `reason` verbatim; it must be public-safe (no raw errno dumps,
// no host paths, no secrets).
import fs from 'node:fs';

const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'reiserfs',
  'vfat', 'exfat', 'ntfs', 'ntfs3', 'apfs', 'bcachefs', 'nfs', 'nfs4', 'smb3', 'cifs', '9p',
  'fuse', 'fuseblk', 'overlay', 'tmpfs']);

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

export class LinuxFilesystemProvider {
  id = 'filesystem';
  label = 'Filesystems';

  async available() {
    const text = readText('/proc/mounts');
    return text ? { available: true, reason: null } : { available: false, reason: 'Mount information is not exposed on this host.' };
  }

  async describe() {
    const at = Date.now();
    const text = readText('/proc/mounts');
    if (!text) {
      return { id: this.id, label: this.label, available: false, reason: 'Mount information is not exposed on this host.', mounts: [], at };
    }
    const seen = new Set();
    const mounts = [];
    for (const line of text.split('\n')) {
      const [dev, mnt, type] = line.split(/\s+/);
      if (!dev || !mnt || !type) continue;
      if (!REAL_FS.has(type)) continue;
      if (/^\/(proc|sys|dev|run|etc|snap|usr|nix)(\/|$)/.test(mnt)) continue;
      if (type === 'tmpfs' && mnt !== '/dev/shm') continue;
      if (seen.has(mnt)) continue;
      seen.add(mnt);
      try {
        const st = await fs.promises.statfs(mnt);
        const bsize = st.bsize || 4096;
        const total = st.blocks * bsize;
        if (!total || total < 128 * 1024 * 1024) continue;
        const avail = st.bavail * bsize;
        mounts.push({
          mount: mnt, device: dev, fs: type, total,
          used: total - avail, free: avail,
          usedPct: total ? Math.round((100 * (total - avail)) / total) : null,
        });
      } catch { /* unreadable mount — not our business */ }
    }
    mounts.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
    return {
      id: this.id, label: this.label, available: true, reason: null, mounts, at,
      totals: mounts.length
        ? {
            mounts: mounts.length,
            total: mounts.reduce((a, m) => a + m.total, 0),
            used: mounts.reduce((a, m) => a + m.used, 0),
            free: mounts.reduce((a, m) => a + m.free, 0),
          }
        : null,
    };
  }
}

// ---------------------------------------------------------------------------
// ZFS — Phase 9
// ---------------------------------------------------------------------------
// The implementation lives in ./zfs.js behind a frozen command table. This class is the adapter
// that answers in the same provider-describe shape as the filesystem provider, so `/api/storage`
// (and every Phase 7 consumer) keeps its contract while the provider behind it becomes real.
//
// The one thing that has changed: `available` is now `true` or `false` — never 'not-implemented'
// — because ZFS is implemented. It is `false` with a plain reason when the tools are not
// reachable, which is the normal case for OpusHub in a container.
import { zfsProvider } from './zfs.js';

export class ZFSProvider {
  id = 'zfs';
  label = 'ZFS';

  async available() {
    const doc = await this.describe();
    return { available: doc.available, reason: doc.reason };
  }

  async describe() {
    const result = await zfsProvider.check();
    const data = result?.data || null;
    return {
      id: this.id,
      label: this.label,
      available: result?.status === 'available',
      reason: result?.error?.reason || null,
      pools: data?.pools || [],
      datasets: data?.datasets || [],
      empty: !!data?.empty,
      at: data?.at || Date.now(),
    };
  }
}

/**
 * The filesystem provider in registry shape (see server/infrastructure/registry.js).
 * Reporting is honest per provider: a provider that cannot read its source says so.
 */
export async function filesystemCheck() {
  const doc = await new LinuxFilesystemProvider().describe();
  const ok = doc.available === true;
  return {
    status: ok ? 'available' : 'unavailable',
    capabilities: ok ? ['filesystems'] : [],
    version: null,
    error: ok ? null : { code: 'not_supported', reason: doc.reason },
    data: doc,
  };
}

/** The ZFS provider in registry shape. */
export async function zfsCheck() {
  const result = await zfsProvider.check();
  return {
    status: result?.status || 'unavailable',
    capabilities: result?.capabilities || [],
    version: result?.version || null,
    error: result?.error || null,
    // the legacy describe() shape, so /api/storage and the resource model keep working
    data: {
      id: 'zfs',
      label: 'ZFS',
      available: result?.status === 'available',
      reason: result?.error?.reason || null,
      pools: result?.data?.pools || [],
      datasets: result?.data?.datasets || [],
      empty: !!result?.data?.empty,
      at: result?.data?.at || Date.now(),
    },
  };
}

const PROVIDERS = [new LinuxFilesystemProvider(), new ZFSProvider()];

/** Every storage provider's description, in registry order. Never throws. */
export async function describeStorage() {
  const out = [];
  for (const p of PROVIDERS) {
    try {
      out.push(await p.describe());
    } catch {
      out.push({ id: p.id, label: p.label, available: false, reason: 'The provider did not answer.', at: Date.now() });
    }
  }
  return { providers: out, at: Date.now() };
}
