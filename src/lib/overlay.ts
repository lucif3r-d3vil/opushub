// services.yaml, edited as an *overlay*.
//
// One module owns the draft shape so Settings → Services, Settings → Groups and the Icon browser
// all write the same file the same way. Every helper here only ever decorates a container that
// discovery reports: there is no path in this file that can create a service, and entries whose
// container is gone are reported by the server as unmatched rather than rendered.
import { invalidateShared, put } from './api';
import { renameGroupAt } from './groupName';
import type { Service, ServicesDoc, StacksDoc } from './types';

export interface DraftService {
  name: string;
  container: string | null;
  displayName: string | null;
  app: string | null;
  description: string | null;
  url: string | null;
  icon: string | null;
  group: string | null;
  order: number | null;
  hidden: boolean;
  showOnHub: boolean;
  keywords: string[];
  meta: { label: string; value: string }[];
}

export interface DraftGroup {
  name: string;
  description?: string | null;
  icon?: string | null;
  order?: number | null;
  services: DraftService[];
}

const empty = (container: string): DraftService => ({
  name: container, container, displayName: null, app: null, description: null, url: null,
  icon: null, group: null, order: null, hidden: false, showOnHub: true, keywords: [], meta: [],
});

/** A discovered container → a new overlay entry that changes nothing until it is edited. */
export function draftFromService(s: Service): DraftService {
  return {
    ...empty(s.name),
    name: s.container.composeService || s.name,
    displayName: s.configured ? s.displayName : null,
    app: s.app ?? null,
    description: s.description ?? null,
    url: s.urlSource === 'manual' ? s.url : null,
    icon: s.iconSource === 'config' ? s.icon : null,
    group: s.groupSource === 'config' ? s.group : null,
    hidden: !!s.hidden,
    showOnHub: s.showOnHub !== false,
    keywords: s.keywords ?? [],
    meta: s.meta ?? [],
  };
}

/** The current services.yaml, as a draft: only entries that really exist (bound overlays). */
export function overlayFromInventory(doc: ServicesDoc | null): DraftGroup[] {
  if (!doc) return [];
  const bound = new Map((doc.services ?? []).filter((s) => s.configured).map((s) => [s.name, s]));
  return doc.groups
    .map((g) => ({
      name: g.name,
      description: g.description ?? null,
      services: g.services
        .filter((s) => bound.has(s.name))
        .map((s) => {
          const inv = bound.get(s.name)!;
          return {
            name: inv.container.composeService || inv.name,
            container: inv.name,
            displayName: inv.displayName,
            app: inv.app ?? null,
            description: inv.description ?? null,
            url: inv.urlSource === 'manual' ? inv.url : null,
            icon: inv.iconSource === 'config' ? inv.icon : null,
            group: inv.groupSource === 'config' ? inv.group : g.name,
            order: inv.order ?? null,
            hidden: !!inv.hidden,
            showOnHub: inv.showOnHub !== false,
            keywords: inv.keywords ?? [],
            meta: inv.meta ?? [],
          } as DraftService;
        }),
    }))
    // groups that only carry a description still matter (they title a group of discovered
    // containers), so they are kept; empty invented groups are kept too and simply render nowhere
    .filter((g) => g.services.length || g.description || g.name);
}

const clone = (groups: DraftGroup[]) => structuredClone(groups);

function findEntry(groups: DraftGroup[], container: string): { gi: number; si: number } | null {
  for (let gi = 0; gi < groups.length; gi++) {
    const si = groups[gi].services.findIndex((s) => s.container === container);
    if (si >= 0) return { gi, si };
  }
  return null;
}

/** Add an overlay entry for a discovered container (idempotent). */
export function ensureOverlay(groups: DraftGroup[], svc: Service, groupName?: string): DraftGroup[] {
  const next = clone(groups);
  if (findEntry(next, svc.name)) return next;
  const name = groupName || svc.group || 'Other';
  let gi = next.findIndex((g) => g.name === name);
  if (gi < 0) { next.push({ name, description: null, services: [] }); gi = next.length - 1; }
  next[gi].services.push(draftFromService(svc));
  return next;
}

/** File a discovered container under a group — the presentation-only "move". */
export function assignGroup(groups: DraftGroup[], svc: Service, groupName: string | null): DraftGroup[] {
  const next = ensureOverlay(groups, svc, groupName || undefined);
  const at = findEntry(next, svc.name);
  if (!at) return next;
  const [entry] = next[at.gi].services.splice(at.si, 1);
  const target = groupName || entry.group || 'Other';
  let gi = next.findIndex((g) => g.name === target);
  if (gi < 0) { next.push({ name: target, description: null, services: [] }); gi = next.length - 1; }
  next[gi].services.push({ ...entry, group: target });
  return next.filter((g) => g.services.length || g.description || g.name);
}

/** Stop overriding a container's group — it falls back to what Docker/compose says. */
export function clearGroup(groups: DraftGroup[], container: string): DraftGroup[] {
  const next = clone(groups);
  const at = findEntry(next, container);
  if (at) next[at.gi].services[at.si].group = null;
  return next;
}

/**
 * @deprecated Renaming is addressed by index now (src/lib/groupName.ts `renameGroupAt`): keying a
 * rename by the old name made clearing the field a silent no-op and could rename the wrong row when
 * two groups shared a name. Kept for any remaining caller; the Settings editors use the new one.
 */
export function renameGroup(groups: DraftGroup[], from: string, to: string): DraftGroup[] {
  const name = to.trim();
  if (!name || name === from) return groups;
  const index = groups.findIndex((g) => g.name === from);
  if (index < 0) return groups;
  return dedupeGroups(renameGroupAt(groups, index, name));
}

export function setGroupDescription(groups: DraftGroup[], name: string, description: string | null): DraftGroup[] {
  const next = clone(groups);
  const g = next.find((x) => x.name === name);
  if (g) g.description = description?.trim() || null;
  else next.push({ name, description: description?.trim() || null, services: [] });
  return next;
}

/** Remove a group: its entries are dropped, and services that named it lose the override. */
export function removeGroup(groups: DraftGroup[], name: string): DraftGroup[] {
  const next = clone(groups).filter((g) => g.name !== name);
  for (const g of next) for (const s of g.services) if (s.group === name) s.group = null;
  return next;
}

export function removeEntry(groups: DraftGroup[], container: string): DraftGroup[] {
  const next = clone(groups).map((g) => ({ ...g, services: g.services.filter((s) => s.container !== container) }));
  return next.filter((g) => g.services.length || g.description);
}

export function setIcon(groups: DraftGroup[], container: string, icon: string | null): DraftGroup[] {
  const next = clone(groups);
  const at = findEntry(next, container);
  if (at) next[at.gi].services[at.si].icon = icon;
  else {
    // no overlay yet — create the minimal one (naming the container is all it takes)
    const gi = next.findIndex((g) => g.name === 'Other');
    const entry = { ...empty(container), icon, name: container };
    if (gi < 0) next.push({ name: 'Other', description: null, services: [entry] });
    else next[gi].services.push(entry);
  }
  return next;
}

function dedupeGroups(groups: DraftGroup[]): DraftGroup[] {
  const out: DraftGroup[] = [];
  for (const g of groups) {
    const existing = out.find((x) => x.name === g.name);
    if (existing) existing.services.push(...g.services);
    else out.push(g);
  }
  return out;
}

/** groups → the payload PUT /api/services expects (no `undefined`, no null group names). */
export function overlayPayload(groups: DraftGroup[]) {
  return {
    groups: groups.map((g) => ({
      name: g.name,
      description: g.description || null,
      services: g.services.map((s) => ({
        name: s.name || s.container || '',
        container: s.container || null,
        displayName: s.displayName || null,
        app: s.app || null,
        description: s.description || null,
        url: s.url || null,
        icon: s.icon || null,
        group: s.group || g.name,
        order: s.order ?? null,
        hidden: !!s.hidden,
        showOnHub: s.showOnHub !== false,
        keywords: s.keywords || [],
        meta: s.meta || [],
      })),
    })),
  };
}

/** Set an icon on a stack overlay (stacks.yaml). Existing entries are preserved. */
export async function saveStackIcon(doc: StacksDoc, stackId: string, icon: string | null): Promise<void> {
  const target = doc.stacks.find((s) => s.id === stackId);
  if (!target) throw new Error(`stack not found: ${stackId}`);
  const entries = doc.stacks
    .filter((s) => s.configured || s.id === stackId)
    .map((s) => ({
      name: s.name,
      project: s.project || s.id,
      displayName: s.name,
      description: s.description,
      icon: s.id === stackId ? icon : s.icon,
      notes: s.notes,
    }));
  await put('/api/stacks', { stacks: entries });
  invalidateShared('/api/stacks');
  invalidateShared('/api/services');
}

/** Set an icon on a discovered service (services.yaml) in one call. */
export async function applyServiceIcon(doc: ServicesDoc, container: string, icon: string | null): Promise<void> {
  const svc = (doc.services ?? []).find((s) => s.name === container);
  if (!svc) throw new Error(`no container named ${container}`);
  const base = overlayFromInventory(doc);
  await saveOverlay(setIcon(base, container, icon));
}

/** Persist the overlay and refresh every cached view of the inventory. */
export async function saveOverlay(groups: DraftGroup[]): Promise<ServicesDoc> {
  const next = await put<ServicesDoc>('/api/services', overlayPayload(groups));
  invalidateShared('/api/services');
  invalidateShared('/api/search');
  return next;
}
