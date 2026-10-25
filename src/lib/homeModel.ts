// What the Home page shows, derived from data OpusHub already has: the discovered inventory, the
// container-update notices it received, the auto-heal recoveries it observed, and the monitors.
// Pure functions only, so the "show only what exists" rules can be tested without a browser.
import type { AutohealStatusDoc, ContainerUpdateRecord, Service, ServicesDoc, SystemSnapshot } from './types';
import { sortRows, type RibbonMonitor, type RibbonsDoc } from './uptimeModel';

/** A stable hue (0–359) from a name: stacks keep their colour from one visit to the next. */
export function stackHue(name: string): number {
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return (h * 47) % 360;
}

export function greetingLead(now: Date): string {
  const h = now.getHours();
  return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export type TileState = 'ok' | 'warn' | 'fail' | 'off';
export interface StateView { state: TileState; word: string }

/** Docker's status becomes a dot colour and, for anything not healthy, a word. Unhealthy is amber, never red. */
export function stateOf(svc: Pick<Service, 'status'>): StateView {
  switch (svc.status) {
    case 'up': return { state: 'ok', word: '' };
    case 'unhealthy': return { state: 'warn', word: 'Unhealthy' };
    case 'restarting': return { state: 'warn', word: 'Restarting' };
    case 'paused': return { state: 'warn', word: 'Paused' };
    case 'down': case 'stopped': return { state: 'fail', word: 'Down' };
    default: return { state: 'off', word: '' };
  }
}

export interface UpdateInfo { record: ContainerUpdateRecord; from: string | null; to: string | null }

const available = (r: ContainerUpdateRecord) => r.status === 'update_available' || r.status === 'updating';

/** Match an update notice to a discovered container (ids may be short or long). */
function matches(r: ContainerUpdateRecord, svc: Service): boolean {
  const ids = [svc.container?.id, svc.id].filter(Boolean) as string[];
  const rid = r.containerId || '';
  return ids.some((id) => id && rid && (rid.startsWith(id) || id.startsWith(rid))) || (!!r.serviceId && (r.serviceId === svc.name || r.serviceId === svc.id));
}

export function updateFor(svc: Service, records: ContainerUpdateRecord[]): UpdateInfo | null {
  const r = records.find((x) => available(x) && matches(x, svc));
  if (!r) return null;
  // Diun reports the tag of the image it watched, so "from → to" is only shown when the two differ
  const differs = r.currentTag && r.availableTag && r.currentTag !== r.availableTag;
  return { record: r, from: differs ? r.currentTag! : null, to: differs ? r.availableTag! : null };
}

export interface Tile { svc: Service; hue: number; view: StateView; update: UpdateInfo | null }
export interface StackSection { name: string; hue: number; tiles: Tile[]; attention: number }

/** The services shown on Home, grouped by Compose stack (alphabetical, "Other" last). */
export function buildStacks(doc: ServicesDoc | null, updates: ContainerUpdateRecord[]): StackSection[] {
  if (!doc) return [];
  const apps = doc.groups.flatMap((g) => g.services).filter((s) => s.kind !== 'infrastructure' && s.showOnHub !== false && !s.hidden);
  const by = new Map<string, Tile[]>();
  for (const svc of apps) {
    const name = svc.stackDisplayName || svc.stack || 'Other';
    const hue = stackHue(name);
    const list = by.get(name) ?? [];
    list.push({ svc, hue, view: stateOf(svc), update: updateFor(svc, updates) });
    by.set(name, list);
  }
  return [...by.entries()]
    .map(([name, tiles]) => ({
      name, hue: stackHue(name),
      tiles: tiles.sort((a, b) => (a.svc.order ?? 1e9) - (b.svc.order ?? 1e9) || a.svc.displayName.localeCompare(b.svc.displayName)),
      attention: tiles.filter((t) => t.view.state === 'warn' || t.view.state === 'fail').length,
    }))
    .sort((a, b) => (a.name === 'Other' ? 1 : b.name === 'Other' ? -1 : a.name.localeCompare(b.name)));
}

export interface AttentionItem {
  key: string; name: string; state: 'warn' | 'fail';
  /** one plain sentence, built only from what Docker, auto-heal or the monitor said */
  reason: string;
  svc: Service | null;
  monitorId?: string;
}

/** Auto-heal's latest recovery for a container, when the observer has seen one. */
function recoveryFor(svc: Service, heal: AutohealStatusDoc | null) {
  return heal?.recentRecoveries?.find((r) => r.containerName === svc.name || r.service === svc.name || (!!svc.container?.id && r.containerId?.startsWith(svc.container.id))) ?? null;
}

export function buildAttention(doc: ServicesDoc | null, heal: AutohealStatusDoc | null, monitors: ReturnType<typeof downMonitors>, rel: (t: number) => string): AttentionItem[] {
  const out: AttentionItem[] = [];
  const seen = new Set<string>();
  const apps = (doc?.groups ?? []).flatMap((g) => g.services).filter((s) => s.kind !== 'infrastructure' && !s.hidden);
  for (const svc of apps) {
    const v = stateOf(svc);
    if (v.state !== 'warn' && v.state !== 'fail') continue;
    const bits: string[] = [];
    if (svc.status === 'down') bits.push(svc.container?.status || svc.statusReason || 'stopped');
    else bits.push(svc.statusReason || (svc.status === 'unhealthy' ? 'the health check is failing' : v.word.toLowerCase()));
    const rec = recoveryFor(svc, heal);
    if (rec) bits.push(`auto-heal ${rec.success ? 'restarted it' : 'could not recover it'} ${rel(rec.t)}`);
    out.push({ key: `svc:${svc.name}`, name: svc.displayName, state: v.state, reason: bits.join(' · '), svc });
    seen.add(svc.name.toLowerCase()); seen.add(svc.displayName.toLowerCase());
  }
  for (const m of monitors) {
    if (seen.has(m.name.toLowerCase())) continue;
    out.push({ key: `mon:${m.id}`, name: m.name, state: 'fail', reason: m.downSince ? `monitor down since ${rel(m.downSince)}` : 'monitor reports it down', svc: null, monitorId: m.id });
  }
  return out.sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'fail' ? -1 : 1));
}

export interface UpdateRow { key: string; name: string; svc: Service | null; image: string; from: string | null; to: string | null; hue: number }

export function buildUpdates(records: ContainerUpdateRecord[], doc: ServicesDoc | null): { rows: UpdateRow[]; checkedAt: number | null } {
  const all = [...(doc?.groups ?? []).flatMap((g) => g.services), ...(doc?.infrastructure ?? [])];
  const rows = records.filter(available).map((r) => {
    const svc = all.find((s) => matches(r, s)) ?? null;
    const differs = r.currentTag && r.availableTag && r.currentTag !== r.availableTag;
    return {
      key: r.containerId, name: svc?.displayName ?? r.imageRef.split('/').pop()!.split(':')[0], svc, image: r.imageRef,
      from: differs ? r.currentTag! : null, to: differs ? r.availableTag! : null,
      hue: stackHue(svc?.stackDisplayName || svc?.stack || 'Other'),
    };
  });
  const checks = records.map((r) => r.lastCheckedAt || r.detectedAt || 0).filter(Boolean);
  return { rows: rows.sort((a, b) => a.name.localeCompare(b.name)), checkedAt: checks.length ? Math.max(...checks) : null };
}

export interface UptimeSummary { pct: number | null; up: number; total: number; since: number; rows: RibbonMonitor[] }

const MINI_MS = 12 * 3_600_000;

/**
 * The Home uptime card, from the same ribbons document the Uptime page reads: the 24-hour figure across
 * enabled monitors, and up to four monitors worth a look (not up, or with an incident in the last 12 hours)
 * for the mini ribbons. Null when nothing is monitored.
 */
export function uptimeSummary(doc: RibbonsDoc | null): UptimeSummary | null {
  const ms = (doc?.monitors ?? []).filter((m) => m.enabled);
  if (!doc || !ms.length) return null;
  const since = doc.to - MINI_MS;
  const recent = (m: RibbonMonitor) => doc.incidents.some((i) => i.monitorId === m.id && (i.open || i.startedAt >= since));
  return {
    pct: doc.summary.uptimePct,
    up: ms.filter((m) => m.status === 'up').length, total: ms.length, since,
    rows: sortRows(ms.filter((m) => m.status !== 'up' || recent(m))).slice(0, 4),
  };
}

/** Monitors that are down, in the shape the attention band reads: when it went down is the open incident's start. */
export function downMonitors(doc: RibbonsDoc | null): { id: string; name: string; enabled: boolean; status: string; downSince: number | null }[] {
  return (doc?.monitors ?? []).filter((m) => m.enabled && m.status === 'down').map((m) => ({
    id: m.id, name: m.name, enabled: m.enabled, status: m.status,
    downSince: doc!.incidents.find((i) => i.monitorId === m.id && i.open)?.startedAt ?? null,
  }));
}

export type HostMetric = 'cpu' | 'memory' | 'network' | 'disk' | 'temp';

export interface HostReading { value: number | null; unit: string; detail: string | null }

/** Current figures for the host strip, straight from the system snapshot (null when unavailable). */
export function hostNow(sys: SystemSnapshot | null): Record<HostMetric, HostReading> {
  const mem = sys?.memory;
  const root = sys?.disks.find((d) => d.mount === '/') ?? sys?.disks[0] ?? null;
  const rx = sys ? sys.network.reduce((a, n) => a + (n.rxPerSec || 0), 0) : null;
  const temp = sys?.cpu.temperature?.[0]?.celsius ?? null;
  return {
    cpu: { value: sys?.cpu.usage ?? null, unit: '%', detail: sys ? `${sys.cpu.cores} threads` : null },
    memory: { value: mem ? 100 * (1 - mem.available / mem.total) : null, unit: '%', detail: mem ? `of ${(mem.total / 1024 ** 3).toFixed(0)} GB` : null },
    network: { value: rx, unit: 'B/s', detail: null },
    disk: { value: root ? 100 * (root.used / root.total) : null, unit: '%', detail: root ? `of ${(root.total / 1024 ** 4 >= 1 ? (root.total / 1024 ** 4).toFixed(1) + ' TB' : (root.total / 1024 ** 3).toFixed(0) + ' GB')}` : null },
    temp: { value: temp, unit: '°C', detail: sys?.cpu.temperature?.[0]?.label ?? null },
  };
}
