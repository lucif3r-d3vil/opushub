export function bytes(n: number | null | undefined, perSec = false): string {
  if (n == null || !Number.isFinite(n)) return 'Unavailable';
  const abs = Math.abs(n);
  const units = perSec ? ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'] : ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let u = 0; let v = n;
  while (Math.abs(v) >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const digits = abs >= 1024 * 1024 * 1024 ? 1 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(u === 0 ? 0 : digits)} ${units[u]}`;
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function num(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return 'Unavailable';
  return n.toLocaleString('en', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function uptime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return 'Unavailable';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function relTime(t: number | null | undefined, now = Date.now()): string {
  if (!t) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  if (m < 90) return '1 hr ago';
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 2) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  const mo = Math.round(d / 30);
  return mo < 18 ? `${mo} mo ago` : `${Math.round(mo / 12)} yr ago`;
}

export function timeOfDay(ts: number | string | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  if (ts == null) return '—';
  return new Date(ts).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', ...opts });
}

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today.getTime() - 86400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, y)) return 'Yesterday';
  return d.toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric' });
}

export function host(url: string | null): string {
  if (!url) return '';
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, '').split('/')[0]; }
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}
