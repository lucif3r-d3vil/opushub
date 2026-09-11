// Local fuzzy matching for the command overlay — small, deterministic, no library.
export interface SearchEntry {
  title: string;
  subtitle?: string | null;
  hint?: string | null;
  href?: string | null;
  kind: string;
  icon?: string | null;
  keywords?: string[];
  action?: () => void;
  external?: boolean;
}

export function fuzzyScore(needle: string, ...fields: (string | null | undefined)[]): number {
  const q = needle.toLowerCase().trim();
  if (!q) return 10;
  let best = 0;
  for (const raw of fields) {
    if (!raw) continue;
    const hay = raw.toLowerCase();
    const idx = hay.indexOf(q);
    if (idx === 0) { best = Math.max(best, 100); continue; }
    if (idx > 0) { best = Math.max(best, 72 - Math.min(40, idx * 1.5)); continue; }
    const words = hay.split(/[ ·\-/]+/);
    if (words.some((w) => w.startsWith(q))) { best = Math.max(best, 64); continue; }
    // subsequence, only counts when tight
    let i = 0; let gap = 0; let last = -2;
    for (let c = 0; c < hay.length && i < q.length; c++) {
      if (hay[c] === q[i]) { if (i > 0) gap += c - last - 1; last = c; i++; }
    }
    if (i === q.length && gap <= q.length * 3) best = Math.max(best, 30 - Math.min(24, gap));
  }
  return best;
}

export function rankEntries(needle: string, entries: SearchEntry[], limit = 24): SearchEntry[] {
  if (!needle.trim()) return entries.slice(0, limit);
  return entries
    .map((e) => ({ e, s: fuzzyScore(needle, e.title, e.subtitle, e.hint, ...(e.keywords || [])) }))
    .filter((x) => x.s > 6)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e);
}

export function groupBy<T>(items: T[], key: (x: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(it);
  }
  return [...map.entries()];
}
