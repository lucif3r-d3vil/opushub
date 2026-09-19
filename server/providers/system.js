// SystemProvider — real host metrics read from /proc, /sys and Node os. No estimation, no
// fabrication: anything not exposed by the kernel is reported as null and the UI says "Unavailable".
import fs from 'node:fs';
import os from 'node:os';
import { writeFileAtomic } from '../lib/atomicFile.js';

const num = (s) => (s == null || s === '' ? null : Number(s));

function readProc(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function parseProcStat(text) {
  if (!text) return null;
  const lines = text.trim().split('\n');
  const parse = (line) => line.trim().split(/\s+/).slice(1).map(Number);
  // fields: user nice system idle iowait irq softirq steal guest guest_nice
  const totals = (f) => ({
    idle: f[3] + (f[4] || 0),
    total: f.reduce((a, b) => a + b, 0) - (f[7] || 0) * 2, // guest already includes user
  });
  const agg = totals(parse(lines[0]));
  const cores = lines.slice(1).filter((l) => /^cpu\d+/.test(l)).map((l) => totals(parse(l)));
  return { agg, cores };
}

function meminfo() {
  const text = readProc('/proc/meminfo');
  if (!text) return null;
  const kvs = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+) kB/);
    if (m) kvs[m[1]] = Number(m[2]) * 1024;
  }
  if (!kvs.MemTotal) return null;
  const cached = (kvs.Cached || 0) + (kvs.SReclaimable || 0);
  return {
    total: kvs.MemTotal,
    available: kvs.MemAvailable ?? kvs.MemFree,
    free: kvs.MemFree,
    buffers: kvs.Buffers || 0,
    cached,
    swapTotal: kvs.SwapTotal || 0,
    swapFree: kvs.SwapFree || 0,
  };
}

const REAL_FS = new Set(['ext2','ext3','ext4','xfs','btrfs','zfs','f2fs','jfs','reiserfs','vfat','exfat','ntfs','ntfs3','apfs','bcachefs','nfs','nfs4','smb3','cifs','9p','fuse','fuseblk','overlay','tmpfs']);

async function disks() {
  const text = readProc('/proc/mounts');
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const line of text.split('\n')) {
    const [dev, mnt, type] = line.split(/\s+/);
    if (!dev || !mnt || !type) continue;
    if (!REAL_FS.has(type)) continue;
    if (/^\/(proc|sys|dev|run|etc|snap|usr|nix)(\/|$)/.test(mnt)) continue;
    if (type === 'tmpfs' && mnt !== '/dev/shm') continue; // container noise, not a homelab disk
    if (seen.has(mnt)) continue;
    seen.add(mnt);
    try {
      const st = await fs.promises.statfs(mnt);
      const bsize = st.bsize || 4096;
      const total = st.blocks * bsize;
      if (!total || total < 128 * 1024 * 1024) continue; // ignore tiny pseudo mounts
      const avail = st.bavail * bsize;
      out.push({ mount: mnt, device: dev, fs: type, total, used: total - avail, free: avail });
    } catch { /* unreadable mount — not our business */ }
  }
  out.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
  return out;
}

function netNow() {
  const text = readProc('/proc/net/dev');
  const out = {};
  if (!text) return out;
  for (const line of text.split('\n').slice(2)) {
    const m = line.trim().match(/^([^:]+):\s+(.*)$/);
    if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    const iface = m[1];
    if (iface === 'lo') continue;
    out[iface] = { rxBytes: f[0], rxPackets: f[1], rxErrors: f[2], txBytes: f[8], txPackets: f[9], txErrors: f[10] };
  }
  return out;
}

function temps() {
  const out = [];
  let zones = [];
  try { zones = fs.readdirSync('/sys/class/thermal'); } catch { return null; }
  for (const z of zones) {
    try {
      const temp = num(readProc(`/sys/class/thermal/${z}/temp`)?.trim());
      const type = readProc(`/sys/class/thermal/${z}/type`)?.trim();
      if (temp != null && Number.isFinite(temp)) out.push({ zone: z, label: type || z, celsius: temp / 1000 });
    } catch { /* skip */ }
  }
  return out.length ? out : null;
}

function cpuInfo() {
  const text = readProc('/proc/cpuinfo');
  const info = { model: null, cores: os.cpus().length, mhz: null, flags: [] };
  if (!text) return info;
  const m = text.match(/^model name\s*:\s*(.+)$/m);
  if (m) info.model = m[1].trim();
  const freqs = [...text.matchAll(/^cpu MHz\s*:\s*([\d.]+)$/gm)].map((x) => Number(x[1])).filter(Number.isFinite);
  if (freqs.length) info.mhz = Math.round(freqs.reduce((a, b) => a + b, 0) / freqs.length);
  const maxm = text.match(/^cpu MHz max/); void maxm;
  return info;
}

function gpuInfo() {
  const nvidia = readProc('/proc/driver/nvidia/version');
  if (nvidia) {
    const name = readProc('/proc/driver/nvidia/gpus') ? 'NVIDIA GPU' : null; void name;
    return { present: true, vendor: 'nvidia', driver: nvidia.split('\n')[0].trim() };
  }
  let cards = [];
  try { cards = fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c)); } catch { return { present: false }; }
  if (!cards.length) return { present: false };
  return { present: true, vendor: 'drm', devices: cards };
}

let prevStat = null;
let prevNet = null;
let prevNetAt = 0;

function pct(cur, prev) {
  if (!cur || !prev) return null;
  const dt = cur.total - prev.total;
  if (dt <= 0) return null;
  return Math.max(0, Math.min(100, 100 * (1 - (cur.idle - prev.idle) / dt)));
}

export async function collect() {
  // Shared sampler: multiple consumers (API requests, history ticks) get one consistent view;
  // the /proc deltas only advance on a real refresh. Never hammer the kernel.
  const now = Date.now();
  if (collect.last && now - collect.last.at < 1500) return collect.last;
  const data = await collectFresh();
  collect.last = data;
  return data;
}

async function collectFresh() {
  const now = Date.now();
  const stat = parseProcStat(readProc('/proc/stat'));
  const cpu = {
    usage: stat && prevStat ? pct(stat.agg, prevStat.agg) : null,
    cores: stat && prevStat ? stat.cores.map((c, i) => ({ id: i, usage: pct(c, prevStat.cores[i]) })) : [],
  };
  if (stat) prevStat = stat;

  const net = netNow();
  let rates = {};
  if (prevNet && now - prevNetAt > 400) {
    const secs = (now - prevNetAt) / 1000;
    for (const [iface, v] of Object.entries(net)) {
      const p = prevNet[iface];
      if (p && v.rxBytes >= p.rxBytes && v.txBytes >= p.txBytes) {
        rates[iface] = { rxPerSec: (v.rxBytes - p.rxBytes) / secs, txPerSec: (v.txBytes - p.txBytes) / secs };
      }
    }
  }
  prevNet = net; prevNetAt = now;

  const load = (readProc('/proc/loadavg') || '').trim().split(/\s+/).slice(0, 3).map(Number);
  const mem = meminfo();
  const cpuInfo_ = cpuInfo();
  const uptimeS = num(readProc('/proc/uptime')?.trim().split(/\s+/)[0]);
  let osPretty = null;
  try {
    const rel = readProc('/etc/os-release') || '';
    osPretty = rel.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? null;
  } catch { /* ok */ }

  const ifaces = [];
  const addrs = os.networkInterfaces();
  for (const [name, v] of Object.entries(net)) {
    let speed = null;
    try { speed = num(fs.readFileSync(`/sys/class/net/${name}/speed`, 'utf8').trim()); } catch { /* ok */ }
    ifaces.push({
      name,
      rxBytes: v.rxBytes, txBytes: v.txBytes, rxPackets: v.rxPackets, txPackets: v.txPackets,
      rxErrors: v.rxErrors, txErrors: v.txErrors,
      rxPerSec: rates[name]?.rxPerSec ?? null, txPerSec: rates[name]?.txPerSec ?? null,
      mbps: speed && speed > 0 ? speed : null,
      ips: (addrs[name] || []).filter((a) => a.family === 'IPv4').map((a) => a.address),
    });
  }

  let procCount = null;
  try { procCount = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length; } catch { /* ok */ }

  return {
    at: now,
    host: {
      hostname: os.hostname(),
      os: osPretty || `${os.type()} ${os.release()}`,
      kernel: os.release(),
      arch: os.arch(),
      node: process.version,
      uptimeSec: uptimeS,
      bootAt: uptimeS ? new Date(now - uptimeS * 1000).toISOString() : null,
      model: readProc('/sys/devices/virtual/dmi/id/product_name')?.trim() || null,
    },
    cpu: {
      usage: cpu.usage,
      perCore: cpu.cores,
      cores: cpuInfo_.cores,
      model: cpuInfo_.model,
      mhz: cpuInfo_.mhz,
      load1: load[0], load5: load[1], load15: load[2],
      temperature: temps(),
    },
    memory: mem,
    disks: await disks(),
    network: ifaces,
    processes: procCount,
    gpu: gpuInfo(),
  };
}

// ---- sampled history ring buffer (for charts; real samples only) ----
export class History {
  constructor({ intervalMs = 5000, samples = 720, file = null } = {}) {
    this.intervalMs = intervalMs; this.samples = samples; this.file = file;
    this.points = [];
    this.timer = null;
  }
  async load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const cutoff = Date.now() - 24 * 3600 * 1000;
      this.points = (Array.isArray(data) ? data : []).filter((p) => p.t > cutoff).slice(-this.samples * 4);
    } catch { /* fresh start */ }
  }
  async start(collectFn) {
    await this.load();
    const tick = async () => {
      try {
        const s = await collectFn();
        this.points.push({
          t: s.at,
          cpu: s.cpu.usage,
          memUsedPct: s.memory ? 100 * (1 - s.memory.available / s.memory.total) : null,
          load: s.cpu.load1,
          rx: s.network.reduce((a, n) => a + (n.rxPerSec || 0), 0) || null,
          tx: s.network.reduce((a, n) => a + (n.txPerSec || 0), 0) || null,
          temp: s.cpu.temperature?.[0]?.celsius ?? null,
          procs: s.processes,
        });
        if (this.points.length > this.samples * 4) this.points = this.points.slice(-this.samples * 4);
        if (this.file) {
          this.fileTick = (this.fileTick || 0) + 1;
          if (this.fileTick % 12 === 0) {
            writeFileAtomic(this.file, JSON.stringify(this.points.slice(-2880)));
          }
        }
      } catch { /* next tick */ }
    };
    await tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
  }
  window(ms) {
    const cutoff = Date.now() - ms;
    return this.points.filter((p) => p.t >= cutoff);
  }
}
