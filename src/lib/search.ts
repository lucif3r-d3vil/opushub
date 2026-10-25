// Types and helpers for the command overlay.
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

export function groupBy<T>(items: T[], key: (x: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(it);
  }
  return [...map.entries()];
}
