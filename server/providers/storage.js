// Storage providers — one contract, honest availability per implementation.
//
//   StorageProvider   { id, label, available(), describe() }
//     LinuxFilesystemProvider   real mounts from /proc/mounts + statfs (always attempted)
//     ZFSProvider               reports `available: not-implemented` until a safe integration
//                               exists — generic filesystem stats are NEVER presented as ZFS stats
//
// `describe()` returns { id, label, available, reason, pools|mounts, at } where `available` is
// one of: true | false (provider applicable but unreadable) | 'not-implemented'.
// Callers render `reason` verbatim; it must be public-safe (no raw errno dumps, no secrets).
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

// ZFS support is future work. The provider exists so the API shape and the UI slot are real
// today; it answers \"not implemented\" rather than borrowing another provider's numbers.
export class ZFSProvider {
  id = 'zfs';
  label = 'ZFS';

  async available() {
    return { available: 'not-implemented', reason: 'ZFS integration is not implemented yet.' };
  }

  async describe() {
    return {
      id: this.id, label: this.label,
      available: 'not-implemented',
      reason: 'ZFS integration is not implemented yet.',
      pools: [], datasets: [], at: Date.now(),
    };
  }
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
