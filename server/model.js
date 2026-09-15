// The config model + the presentation overlay.
//
// Docker decides WHAT EXISTS, Traefik/published ports decide HOW TO REACH IT, and these files
// decide HOW IT LOOKS. That ordering is the whole design: `services.yaml` and `stacks.yaml` are
// overlays that enrich discovered containers, and they can never create an infrastructure object.
// A configured entry whose container is gone is reported as an unmatched overlay (Settings →
// System, and a quiet banner on Services) instead of being rendered as if it were installed.
import { readYaml, readJson, writeYaml, writeJson } from './configStore.js';
import * as docker from './providers/docker.js';
import { statsWithHistory } from './statsHistory.js';
import { discover } from './discovery.js';
import { suggestRef, existsLocal } from './providers/icons.js';
import { hostAddress } from './lib/hostAddress.js';
import { defaultLayout, normalizeLayout, describeLayoutPatch } from './layout.js';
import { applyTemplate, hasTemplate, templateList } from './templates.js';
import { WIDGET_CATEGORIES, WIDGET_TYPES, widgetCatalogue } from './widgets.js';
import { validateSymbol as validateMarketSymbol } from './providers/market.js';

export const DEFAULT_SETTINGS = {
  app: { name: 'OpusHub', tagline: 'The homelab, at a glance.' },
  appearance: {
    theme: 'system',
    accent: 'sage',
    density: 'comfortable',
    transparency: true,
    fontScale: 1,
    background: { mode: 'quiet', photo: null, blur: 24, scrim: 62, position: 'center', fit: 'cover' },
  },
  hub: { greetingName: null, clock24h: false, showSeconds: false },
  integrations: {
    news: { feeds: [] },
    weather: { location: null, latitude: null, longitude: null, place: null, units: 'c' },
    markets: { symbols: [] },
  },
  behavior: { logLaunches: true, refresh: { system: 5, services: 30 } },
  // Infrastructure access + the two optional knobs the URL resolver can't read off Docker itself.
  // hostAddress: the name/port a browser should use for published ports (else auto-detected).
  // entrypointPorts: only needed when Traefik's entrypoint is not on 80/443, e.g. { web: '8080' }.
  infrastructure: { hostAddress: null, entrypointPorts: {} },
  advanced: { customCss: false, customJs: false },
};

export const DEFAULT_LAYOUT = defaultLayout();

const str = (v, max = 240) => (typeof v === 'string' ? v.trim().slice(0, max) : null);
const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
};
const bool = (v) => (typeof v === 'boolean' ? v : /^(true|yes|1)$/i.test(String(v ?? '')) ? true : /^(false|no|0)$/i.test(String(v ?? '')) ? false : null);

export function safeHref(href) {
  const s = str(href, 2000);
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^mailto:/i.test(s) || s.startsWith('/')) return s;
  throw Object.assign(new Error(`unsafe href: ${s.slice(0, 40)}`), { status: 400 });
}

export function safeIcon(ref) {
  const s = str(ref, 400);
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || s.startsWith('/user/') || /^[a-z][a-z0-9-]*:[a-z0-9+._-]+$/i.test(s) || s.length <= 8) return s;
  throw Object.assign(new Error(`unsafe icon ref: ${s.slice(0, 40)}`), { status: 400 });
}

// ---------------------------------------------------------------------------
// services.yaml — a presentation overlay, never a service definition
// ---------------------------------------------------------------------------

/**
 * One overlay entry. It must name a real container to have any effect: either explicitly via
 * `container:` (a docker container name or id prefix — authoritative), or implicitly by its
 * `name` matching a container name / compose service. `href` is accepted as a legacy alias of
 * `url`; both are *manual URL overrides* (urlSource: "manual").
 */
function normService(raw, strict = false) {
  if (!raw || typeof raw !== 'object') throw Object.assign(new Error('service entry must be a map'), { status: 400 });
  const name = str(raw.name, 80);
  const container = str(raw.container, 120);
  if (!name && !container) throw Object.assign(new Error('service overlay needs `container` (or a name matching a container)'), { status: 400 });
  const bail = (msg) => { if (strict) throw Object.assign(new Error(msg), { status: 400 }); };
  const meta = Array.isArray(raw.meta)
    ? raw.meta.map((m) => ({ label: str(m?.label, 40), value: str(m?.value, 120) })).filter((m) => m.label && m.value)
    : [];
  const url = str(raw.url ?? raw.href, 2000);
  return {
    name: name || container,
    container,
    displayName: str(raw.displayName ?? raw.displayNameOverride ?? raw.title, 80),
    app: str(raw.app, 80),
    description: str(raw.description, 300),
    url: (() => { try { return safeHref(url); } catch (e) { bail(`"${name || container}": ${e.message}`); return null; } })(),
    urlSource: url ? (raw.url ? 'services.yaml' : 'services.yaml (legacy href)') : null,
    icon: (() => { try { return safeIcon(raw.icon); } catch (e) { bail(`"${name || container}": ${e.message}`); return null; } })(),
    group: str(raw.group, 80),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : null,
    hidden: bool(raw.hidden ?? (raw.visible === false ? true : null)) === true,
    showOnHub: bool(raw.showOnHub) === null ? true : bool(raw.showOnHub),
    stack: str(raw.stack, 80),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map((k) => str(k, 40)).filter(Boolean) : [],
    meta,
  };
}

/** Groups carry their own presentation metadata; a group with no live services renders nowhere. */
export function readServices() {
  const doc = readYaml('services.yaml');
  const groups = [];
  const skipped = [];
  const overlays = [];
  for (const g of doc?.groups || []) {
    const name = str(g?.name, 80) || 'Ungrouped';
    const services = [];
    for (const s of g?.services || g?.items || []) {
      try {
        const entry = normService(s);
        entry.group = entry.group || name;
        entry.groupSource = 'services.yaml';
        services.push(entry);
        overlays.push(entry);
      } catch (e) {
        skipped.push({ group: name, name: str(s?.name, 80) || str(s?.container, 80) || '(unnamed)', reason: e.message });
      }
    }
    groups.push({
      name,
      description: str(g?.description, 200),
      icon: (() => { try { return g?.icon ? safeIcon(g.icon) : null; } catch { return null; } })(),
      order: Number.isFinite(Number(g?.order)) ? Number(g.order) : null,
      services,
    });
  }
  // A hand-edit typo must never blank the whole UI: keep going, surface what was skipped.
  return { groups, skipped, overlays };
}

export function writeServices(doc) {
  const groups = [];
  for (const g of doc?.groups || []) {
    const name = str(g?.name, 80);
    if (!name) throw Object.assign(new Error('group requires a name'), { status: 400 });
    if (!/^[A-Za-z0-9 ._'-]+$/.test(name)) throw Object.assign(new Error(`group name has unsafe characters: ${name}`), { status: 400 });
    const services = (g.services || []).map((x) => normService(x, true));
    const seen = new Set();
    for (const s of services) {
      if (seen.has(s.name)) throw Object.assign(new Error(`duplicate service "${s.name}" in ${name}`), { status: 400 });
      seen.add(s.name);
    }
    const meta = {};
    if (g.description) meta.description = g.description;
    if (g.icon) meta.icon = safeIcon(g.icon);
    if (Number.isFinite(Number(g.order))) meta.order = Number(g.order);
    groups.push({ name, ...meta, services });
  }
  writeYaml('services.yaml', { groups });
  return { groups };
}

// ---------------------------------------------------------------------------
// Phase 6 — draft validation, one write per service, and group management
//
// The three concerns below share a property that matters more than any of them individually: they
// let a user change *presentation* without a route into infrastructure. Every function here writes
// `services.yaml`, `layout.json` or a settings patch, and each one validates through the very
// normaliser its write path uses — so "the draft is valid" and "the write will succeed" are the
// same statement rather than two guesses.
// ---------------------------------------------------------------------------

/**
 * Validate a draft `services.yaml` without writing it.
 * Runs the exact normaliser `writeServices` runs and throws on the exact conditions it would,
 * then discards the result. This is what makes the editor's Validate button honest.
 */
export function validateServicesDraft(doc) {
  const groups = [];
  for (const g of doc?.groups || []) {
    const name = str(g?.name, 80);
    if (!name) throw Object.assign(new Error('a group needs a name'), { status: 400, code: 'group_name' });
    if (!/^[A-Za-z0-9 ._'-]+$/.test(name)) {
      throw Object.assign(new Error(`group “${name}” has characters OpusHub group names cannot hold`), { status: 400, code: 'group_name' });
    }
    if (groups.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      throw Object.assign(new Error(`two groups are both called “${name}”`), { status: 400, code: 'duplicate_group' });
    }
    const services = (g.services || []).map((x) => normService(x, true));
    const seen = new Set();
    for (const s of services) {
      const key = String(s.container || s.name).toLowerCase();
      if (seen.has(key)) throw Object.assign(new Error(`“${s.name}” appears twice in ${name}`), { status: 400, code: 'duplicate_service' });
      seen.add(key);
    }
    groups.push({ name, services });
  }
  // Two entries binding the same container from different groups is the same error one level up.
  const byContainer = new Map();
  for (const g of groups) {
    for (const s of g.services) {
      const key = String(s.container || '').toLowerCase();
      if (!key) continue;
      if (byContainer.has(key) && byContainer.get(key) !== g.name) {
        throw Object.assign(
          new Error(`“${s.name}” and the entry in ${byContainer.get(key)} both bind container “${s.container}” — a container may be presented once`),
          { status: 400, code: 'duplicate_binding' },
        );
      }
      byContainer.set(key, g.name);
    }
  }
  if (groups.length > 200) throw Object.assign(new Error(`${groups.length} groups exceeds the 200 cap`), { status: 413 });
  return { groups };
}

export function validateStacksDraft(doc) {
  return (doc?.stacks || []).map((x) => normStack(x, true));
}

export function validateBookmarksDraft(doc) {
  const names = new Set();
  for (const g of doc?.groups || []) {
    const name = str(g?.name, 80) || 'Bookmarks';
    if (names.has(name.toLowerCase())) throw Object.assign(new Error(`two bookmark groups are both called “${name}”`), { status: 400, code: 'duplicate_group' });
    names.add(name.toLowerCase());
    const seen = new Set();
    for (const b of g?.items || []) {
      const itemName = str(b?.name, 80);
      if (!itemName) throw Object.assign(new Error(`a bookmark in ${name} has no name`), { status: 400, code: 'bookmark_name' });
      if (seen.has(itemName.toLowerCase())) throw Object.assign(new Error(`“${itemName}” appears twice in ${name}`), { status: 400, code: 'duplicate_bookmark' });
      seen.add(itemName.toLowerCase());
      try { safeHref(b?.href); }
      catch (e) { throw Object.assign(new Error(`bookmark “${itemName}”: ${e.message}`), { status: 400, code: 'unsafe_href' }); }
    }
  }
  return true;
}

/** A layout draft is valid if normalising it produces a layout — the validator never throws. */
export function normalizeLayoutDraft(doc) {
  const next = normalizeLayout(doc);
  if (!next?.hub?.widgets?.length) throw Object.assign(new Error('a layout needs at least one widget'), { status: 400, code: 'empty_layout' });
  return next;
}

export function validateSettingsDraft(patch) {
  const cleaned = sanitizeSettings(deepMerge(getSettings(), patch || {}));
  if (cleaned._rejected?.length) throw Object.assign(new Error(cleaned._rejected.join('; ')), { status: 400, code: 'invalid_settings' });
  delete cleaned._rejected;
  return cleaned;
}

/** The widget type names this build knows — the importer needs them to decide what maps. */
export function widgetTypes() {
  return WIDGET_TYPES;
}

/**
 * Icon resolution probe, exposed for the importer.
 *
 * `suggestRef` takes bare *slugs* and returns whichever of `si:`/`mdi:` resolves; `existsLocal`
 * answers for a fully-qualified `set:name` reference. The importer has both shapes — Homepage
 * writes `si-jellyfin` (a slug after translation to `si:jellyfin`) and `jellyfin.png` (a bare
 * slug) — so both are handled here, and a miss is a plain `null` rather than an invented
 * reference. That null is what makes the service fall back to a monogram instead of a broken image.
 */
export function suggestIconProbe(ref) {
  try {
    if (!ref) return null;
    const s = String(ref);
    if (/^[a-z0-9-]+:[a-z0-9+._-]+$/i.test(s)) return existsLocal(s) ? s : null;
    return suggestRef([s]);
  } catch { return null; }
}

/**
 * Write one container's presentation, merging into whatever overlay already exists.
 *
 * This is the single-service editor's write path, and its shape is the point: the caller supplies
 * presentation fields only. There is no parameter for a container id, an image, a network, a mount
 * or a label, so an editor — or a bug in one — cannot rewrite a discovered fact.
 */
export function putServicePresentation({ group, name, ref, service, draft = {}, actor = null }) {
  const containerName = service.container?.name || service.name;
  const doc = readYaml('services.yaml') || {};
  const groups = Array.isArray(doc.groups) ? structuredClone(doc.groups) : [];

  // Locate any existing entry binding this container, wherever it lives.
  const binds = (s) => {
    const c = str(s?.container, 120);
    if (c) {
      const lc = c.toLowerCase();
      return lc === containerName.toLowerCase() || String(ref).toLowerCase() === lc || String(ref).toLowerCase().startsWith(lc);
    }
    return str(s?.name, 80)?.toLowerCase() === containerName.toLowerCase()
      || str(s?.name, 80)?.toLowerCase() === String(name).toLowerCase();
  };

  let target = null;
  let targetGroup = null;
  for (const g of groups) {
    const list = Array.isArray(g.services) ? g.services : [];
    const idx = list.findIndex(binds);
    if (idx >= 0) { target = list[idx]; targetGroup = g; break; }
  }

  const allowed = {
    displayName: str(draft.displayName, 80),
    description: str(draft.description, 300),
    app: str(draft.app, 80),
    icon: (() => { try { return draft.icon ? safeIcon(draft.icon) : null; } catch (e) { throw Object.assign(new Error(e.message), { status: 400, code: 'unsafe_icon' }); } })(),
    url: (() => { try { return draft.url ? safeHref(draft.url) : null; } catch (e) { throw Object.assign(new Error(e.message), { status: 400, code: 'unsafe_href' }); } })(),
    group: str(draft.group, 80),
    order: Number.isFinite(Number(draft.order)) ? Number(draft.order) : null,
  };
  const flags = {
    hidden: draft.hidden === true,
    showOnHub: draft.showOnHub === false ? false : true,
  };

  const entry = target || { container: containerName, name: containerName };
  for (const [k, v] of Object.entries(allowed)) {
    if (v == null) delete entry[k];
    else entry[k] = v;
  }
  // Booleans are always explicit on save: "I turned this on" has to survive as a fact, not as an
  // absence that the default could later flip.
  entry.hidden = flags.hidden;
  entry.showOnHub = flags.showOnHub;

  // An entry that overrides nothing is not worth storing — and storing it would make the container
  // read as "configured" in discovery, which is a lie about where its appearance comes from.
  const overridesAnything = Object.keys(allowed).some((k) => allowed[k] != null);
  if (!overridesAnything && !flags.hidden && entry.showOnHub !== false) {
    if (target && targetGroup) {
      targetGroup.services = targetGroup.services.filter((_, i) => targetGroup.services[i] !== target);
    }
    const pruned = groups.filter((g) => (g.services || []).length);
    writeYaml('services.yaml', { groups: pruned });
    return { cleared: true, entry: null };
  }

  // A group named in the draft wins; otherwise the entry keeps the group it had, or the container's.
  const wantedGroup = allowed.group || targetGroup?.name || service.group || 'Other';
  const cleanGroup = /^[A-Za-z0-9 ._'-]+$/.test(wantedGroup) ? wantedGroup : 'Other';

  if (target) {
    if (targetGroup.name !== cleanGroup) {
      targetGroup.services = targetGroup.services.filter((x) => x !== target);
      entry.group = cleanGroup;
      let dest = groups.find((g) => g.name === cleanGroup);
      if (!dest) { dest = { name: cleanGroup, services: [] }; groups.push(dest); }
      (dest.services ||= []).push(entry);
    } else {
      Object.assign(target, entry);
    }
  } else {
    let dest = groups.find((g) => g.name === cleanGroup);
    if (!dest) { dest = { name: cleanGroup, services: [] }; groups.push(dest); }
    (dest.services ||= []).push(entry);
  }

  validateServicesDraft({ groups });
  writeYaml('services.yaml', { groups: groups.filter((g) => (g.services || []).length) });
  return { cleared: false, entry, group: cleanGroup };
}

/**
 * Remove every override for one container.
 *
 * This is how "Use detected URL" behaves, and it is the operation that proves the design: clearing
 * configuration does not remove a service — the container is still there, still discovered, and
 * simply falls back to what Docker and its proxy say.
 */
export function clearServicePresentation({ service, ref }) {
  const containerName = service.container?.name || service.name;
  const doc = readYaml('services.yaml') || {};
  const groups = Array.isArray(doc.groups) ? structuredClone(doc.groups) : [];
  const binds = (s) => {
    const c = str(s?.container, 120);
    if (c) return c.toLowerCase() === containerName.toLowerCase() || String(ref).toLowerCase().startsWith(c.toLowerCase());
    return str(s?.name, 80)?.toLowerCase() === containerName.toLowerCase();
  };
  let removed = 0;
  for (const g of groups) {
    if (!Array.isArray(g.services)) continue;
    const kept = g.services.filter((s) => !binds(s));
    removed += g.services.length - kept.length;
    g.services = kept;
  }
  writeYaml('services.yaml', { groups: groups.filter((g) => (g.services || []).length) });
  return { cleared: removed > 0, removed, container: containerName };
}

/**
 * Group management as one document write.
 *
 * Groups live in two places by design: their metadata (description, icon) in `services.yaml`, and
 * their order and visibility in `layout.json` — because order and visibility are properties of the
 * *composition*, which is what layout.json is for. This function presents both as one operation so
 * the UI can treat a group as a single first-class thing.
 */
export function writeGroups(body = {}, { membership = new Map() } = {}) {
  const services = readYaml('services.yaml') || {};
  const groups = Array.isArray(services.groups) ? structuredClone(services.groups) : [];
  const incoming = Array.isArray(body.groups) ? body.groups : [];

  const byName = new Map(groups.map((g) => [String(g.name || '').toLowerCase(), g]));

  /** Every container currently presented under a group name, configured or derived. */
  const containersIn = (groupName) => {
    const configured = groups
      .filter((g) => String(g?.name || '').toLowerCase() === String(groupName).toLowerCase())
      .flatMap((g) => (g.services || []).map((s) => str(s?.container || s?.name, 120)).filter(Boolean));
    const derived = membership instanceof Map ? (membership.get(groupName) || []) : [];
    return [...new Set([...configured, ...derived])];
  };

  /**
   * Rename by *re-filing the containers*, falling back to renaming the group entry when the group
   * has one. A group discovery derived from a compose project does not exist in `services.yaml`, so
   * there is no entry to rename — but there are containers to re-file, and re-filing them is both
   * the only thing that works and the honest description of what a rename is.
   */
  const renameGroup = (from, to) => {
    const existing = byName.get(from.toLowerCase());
    if (existing) {
      existing.name = to;
      byName.delete(from.toLowerCase());
      byName.set(to.toLowerCase(), existing);
    }
    const names = containersIn(from);
    if (!names.length) return existing ? 1 : 0;
    let dest = groups.find((g) => String(g.name || '').toLowerCase() === to.toLowerCase());
    if (!dest) { dest = { name: to, services: [] }; groups.push(dest); byName.set(to.toLowerCase(), dest); }
    dest.services ||= [];
    for (const container of names) {
      // move the existing entry if there is one, else create a minimal one that only sets `group`
      let moved = null;
      for (const g of groups) {
        if (g === dest || !Array.isArray(g.services)) continue;
        const idx = g.services.findIndex((s) => str(s?.container || s?.name, 120) === container);
        if (idx >= 0) { [moved] = g.services.splice(idx, 1); break; }
      }
      if (moved) { moved.group = to; dest.services.push(moved); }
      else if (!dest.services.some((s) => str(s?.container || s?.name, 120) === container)) {
        dest.services.push({ container, group: to });
      }
    }
    return names.length;
  };

  // Renames first, so a rename followed by an edit addresses the new name.
  for (const change of incoming) {
    if (!change) continue;
    const from = str(change.from ?? change.name, 80);
    const to = str(change.to ?? change.name, 80);
    if (!from || !to || from === to) continue;
    const existing = byName.get(from.toLowerCase());
    const willMove = containersIn(from).length;
    if (!existing && !willMove) continue;
    // The target must be free in *both* senses: no overlay entry carries the name, and no live
    // group is already presenting under it. Checking only the file would happily merge two groups
    // that discovery had kept apart — which is the opposite of what a rename means.
    const liveTarget = membership instanceof Map ? (membership.get(to) || []) : [];
    if (byName.has(to.toLowerCase()) || liveTarget.length) {
      throw Object.assign(new Error(`a group called “${to}” already exists`), { status: 400, code: 'duplicate_group' });
    }
    renameGroup(from, to);
  }

  for (const change of incoming) {
    if (!change) continue;
    const name = str(change.to ?? change.name, 80);
    if (!name) continue;
    const existing = byName.get(name.toLowerCase());
    const patch = {
      description: change.description !== undefined ? str(change.description, 200) : undefined,
      icon: change.icon !== undefined ? (() => { try { return change.icon ? safeIcon(change.icon) : null; } catch { return null; } })() : undefined,
    };
    if (existing) {
      if (patch.description !== undefined) { if (patch.description) existing.description = patch.description; else delete existing.description; }
      if (patch.icon !== undefined) { if (patch.icon) existing.icon = patch.icon; else delete existing.icon; }
      continue;
    }
    // A brand new group with no services renders nowhere until a container lands in it, which is
    // the honest behaviour — so it is still stored, and the UI says so.
    if (change.create) {
      const created = { name, services: [] };
      if (change.description) created.description = str(change.description, 200);
      if (change.icon) { try { created.icon = safeIcon(change.icon); } catch { /* monogram */ } }
      groups.push(created);
      byName.set(name.toLowerCase(), created);
    }
  }

  // Deletions: the group's metadata goes; nothing else can, because the group is a label.
  const deletions = new Set((body.delete || []).map((x) => String(x).toLowerCase()));
  const kept = groups.filter((g) => !deletions.has(String(g.name || '').toLowerCase()));
  writeYaml('services.yaml', { groups: kept });

  // Order and visibility are the composition's business.
  const layout = getLayout();
  const next = normalizeLayout({
    ...layout,
    services: {
      ...layout.services,
      groupOrder: Array.isArray(body.order) && body.order.length ? body.order.map((x) => str(x, 80)).filter(Boolean) : layout.services.groupOrder,
      hiddenGroups: Array.isArray(body.hidden) ? body.hidden.map((x) => str(x, 80)).filter(Boolean) : layout.services.hiddenGroups,
    },
  });
  writeJson('layout.json', next);

  return {
    groups: kept.map((g) => ({ name: g.name, description: g.description || null, icon: g.icon || null, serviceCount: (g.services || []).length })),
    order: next.services.groupOrder,
    hidden: next.services.hiddenGroups,
  };
}

// ---------------------------------------------------------------------------
// stacks.yaml — overlay metadata for compose projects
// ---------------------------------------------------------------------------

function normStack(raw, strict = false) {
  const name = str(raw?.name, 80) || str(raw?.project, 80);
  if (!name) throw Object.assign(new Error('stack requires a name (the compose project it describes)'), { status: 400 });
  const bail = (msg) => { if (strict) throw Object.assign(new Error(msg), { status: 400 }); };
  return {
    name,
    // The compose project this overlay describes. Defaults to `name` so a stack named after its
    // project needs no extra key; set it when the friendly name differs (project `opustream`
    // displayed as `Media`).
    project: str(raw?.project, 80) || name,
    projectExplicit: !!str(raw?.project, 80),
    displayName: str(raw?.displayName, 80) || (str(raw?.project, 80) && str(raw?.project) !== name ? name : null),
    description: str(raw?.description, 300),
    icon: (() => { try { return safeIcon(raw?.icon); } catch (e) { bail(e.message); return null; } })(),
    members: Array.isArray(raw?.services) ? raw.services.map((x) => str(x, 80)).filter(Boolean) : [],
    notes: str(raw?.notes, 1000),
    order: Number.isFinite(Number(raw?.order)) ? Number(raw.order) : null,
  };
}

export function readStacks() {
  const doc = readYaml('stacks.yaml');
  const overlays = [];
  const skipped = [];
  for (const s of doc?.stacks || []) {
    try { overlays.push(normStack(s)); }
    catch (e) { skipped.push({ name: str(s?.name, 80) || '(unnamed)', reason: e.message }); }
  }
  return { stacks: overlays, skipped };
}

export function writeStacks(doc) {
  const stacks = (doc?.stacks || []).map((x) => normStack(x, true)).map((x) => ({
    name: x.name, project: x.project, ...(x.displayName ? { displayName: x.displayName } : {}),
    ...(x.description ? { description: x.description } : {}), ...(x.icon ? { icon: x.icon } : {}),
    ...(x.members.length ? { services: x.members } : {}), ...(x.notes ? { notes: x.notes } : {}),
  }));
  writeYaml('stacks.yaml', { stacks });
  return { stacks };
}

// ---------------------------------------------------------------------------
// bookmarks / settings / layout
// ---------------------------------------------------------------------------

export function readBookmarks() {
  const doc = readYaml('bookmarks.yaml');
  const flat = [];
  const groups = (doc?.groups || []).map((g) => {
    const items = (g?.items || []).map((b) => ({
      name: str(b?.name, 80) || '',
      href: (() => { try { return safeHref(b?.href); } catch { return null; } })(),
      description: str(b?.description, 200),
    })).filter((b) => b.name && b.href);
    items.forEach((i) => flat.push({ ...i, group: str(g?.name, 80) || 'Bookmarks' }));
    return { name: str(g?.name, 80) || 'Bookmarks', items };
  });
  return { groups, flat };
}

export function writeBookmarks(doc) {
  const groups = [];
  for (const g of doc?.groups || []) {
    groups.push({
      name: str(g?.name, 80) || 'Bookmarks',
      items: (g?.items || [])
        .map((b) => {
          let href;
          try { href = safeHref(b?.href); }
          catch (e) { throw Object.assign(new Error(`bookmark ${str(b?.name, 80) || '(unnamed)'}: ${e.message}`), { status: 400 }); }
          return { name: str(b?.name, 80), href, ...(b?.description ? { description: str(b.description, 200) } : {}) };
        })
        .filter((b) => b.name && b.href),
    });
  }
  writeYaml('bookmarks.yaml', { groups });
  return { groups };
}

function deepMerge(base, patch) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v === null && Array.isArray(out[k]) ? [] : v;
    }
  }
  return out;
}

export function getSettings() {
  const raw = readYaml('settings.yaml');
  const merged = deepMerge(DEFAULT_SETTINGS, raw || {});
  // clamp
  merged.appearance.fontScale = clampInt(10 * merged.appearance.fontScale, 9, 12, 10) / 10;
  merged.appearance.background.blur = clampInt(merged.appearance.background.blur, 0, 48, 24);
  merged.appearance.background.scrim = clampInt(merged.appearance.background.scrim, 0, 100, 62);
  // Positioning is a closed vocabulary, not free CSS: a stored value can never become an
  // arbitrary declaration in the page.
  const BG_POSITION = ['center', 'top', 'bottom', 'left', 'right'];
  const BG_FIT = ['cover', 'contain'];
  merged.appearance.background.position = BG_POSITION.includes(merged.appearance.background.position) ? merged.appearance.background.position : 'center';
  merged.appearance.background.fit = BG_FIT.includes(merged.appearance.background.fit) ? merged.appearance.background.fit : 'cover';
  merged.behavior.refresh.system = clampInt(merged.behavior.refresh.system, 2, 300, 5);
  merged.behavior.refresh.services = clampInt(merged.behavior.refresh.services, 5, 600, 30);
  merged.infrastructure = merged.infrastructure || {};
  merged._raw = raw || {}; // raw file content (for the YAML view)
  return merged;
}

export function putSettings(patch) {
  const current = readYaml('settings.yaml') || {};
  const next = deepMerge(current, patch);
  const cleaned = sanitizeSettings(next);
  // A rejected key must not silently revert: report it so the UI can say so.
  if (cleaned._rejected?.length) throw Object.assign(new Error(cleaned._rejected.join('; ')), { status: 400 });
  delete cleaned._rejected;
  writeYaml('settings.yaml', cleaned);
  return getSettings();
}

function sanitizeSettings(s) {
  const out = structuredClone(s);
  const rejected = [];
  delete out._raw;
  const feeds = out?.integrations?.news?.feeds;
  if (Array.isArray(feeds)) {
    out.integrations.news.feeds = feeds
      .map((f) => {
        try { return { url: safeHref(f?.url), name: str(f?.name, 60) }; }
        catch (e) { rejected.push(`feed ${e.message}`); return null; }
      })
      .filter((f) => f?.url);
  }
  const sym = out?.integrations?.markets?.symbols;
  if (Array.isArray(sym)) {
    const clean = [];
    for (const x of sym.slice(0, 24)) {
      const v = str(x, 24);
      if (!v) continue;
      const r = validateMarketSymbol(v);
      if (!r.ok) { rejected.push(`market symbol “${v}”: ${r.reason}`); continue; }
      if (!clean.includes(r.symbol)) clean.push(r.symbol);
    }
    out.integrations.markets.symbols = clean;
  }
  // The background photo is the one setting whose value becomes a URL the browser fetches,
  // so it is clamped here too (the deep check happens on the API route): only https image
  // URLs, Unsplash photo pages, or same-origin files under /user/backgrounds/ may be stored.
  const photo = out?.appearance?.background?.photo;
  if (photo != null) {
    const s = str(photo, 2048);
    if (!s) out.appearance.background.photo = null;
    else if (!/^https:\/\//i.test(s) && !s.startsWith('/user/backgrounds/')) {
      rejected.push('appearance.background.photo must be an https:// image URL, an Unsplash photo page, or a /user/backgrounds/ file');
      out.appearance.background.photo = null;
    } else out.appearance.background.photo = s;
  }
  // infrastructure knobs are validated, never silently accepted: a typo'd host would otherwise
  // show up as wrong URLs everywhere with no clue why.
  const infra = out.infrastructure;
  if (infra && typeof infra === 'object') {
    const host = str(infra.hostAddress, 200);
    if (host && !/^[a-z0-9.\-:_[\]]+$/i.test(host.replace(/^[a-z]+:\/\//i, ''))) {
      rejected.push('infrastructure.hostAddress is not a valid host or host:port');
      infra.hostAddress = null;
    } else infra.hostAddress = host;
    const ports = infra.entrypointPorts;
    if (ports && typeof ports === 'object' && !Array.isArray(ports)) {
      const clean = {};
      for (const [k, v] of Object.entries(ports).slice(0, 16)) {
        const key = str(k, 40);
        const val = String(v ?? '').trim();
        if (!key) continue;
        if (!val) continue;
        if (!/^(\d{1,5}|[a-z0-9.\-_-]+:\d{1,5})$/i.test(val)) { rejected.push(`infrastructure.entrypointPorts.${key} must be a port or host:port`); continue; }
        clean[key] = val;
      }
      infra.entrypointPorts = clean;
    } else infra.entrypointPorts = {};
  }
  out._rejected = rejected;
  return out;
}

/** The persisted layout, always validated. A v1 file is migrated here and written back on the
 *  next change, so no one has to edit JSON by hand (see server/layout.js). */
export function getLayout() {
  return normalizeLayout(readJson('layout.json', null));
}

export function putLayout(patch) {
  const current = normalizeLayout(readJson('layout.json', null));
  const next = normalizeLayout(deepMerge(current, patch || {}));
  writeJson('layout.json', next);
  return next;
}

/** Reset the Hub composition to factory defaults. Never touches discovery or the overlay files. */
export function resetLayout() {
  const next = normalizeLayout(null);
  writeJson('layout.json', next);
  return next;
}

/** Every group the engine currently produces — what a template's preferences are matched against. */
export async function groupNames() {
  try {
    const inv = await getInventory({ refreshMs: 0 });
    const names = [
      ...inv.groups.map((g) => g.name),
      ...(inv.groupsRaw || []).map((g) => g.name),
      ...inv.services.map((s) => s.group).filter(Boolean),
    ];
    return [...new Set(names)];
  } catch { return []; }
}

/** Settings → Templates: the presets, each with the real merged layout it would produce today. */
export async function getTemplates() {
  const layout = getLayout();
  const names = await groupNames();
  return {
    templates: templateList({ layout, groupNames: names }),
    layout,
    spacing: layout.hub.spacing,
    groupNames: names,
  };
}

/** Apply a template. Layout-only: it cannot add, remove or rename a service. */
export async function applyLayoutTemplate(id) {
  if (!hasTemplate(id)) throw Object.assign(new Error(`unknown template: ${id}`), { status: 404 });
  const current = getLayout();
  const names = await groupNames();
  const next = normalizeLayout(applyTemplate(id, current, { groupNames: names }));
  writeJson('layout.json', next);
  return next;
}

/** The widget catalogue + what the current layout actually contains (Settings → Widgets). */
export function getWidgetDoc() {
  const layout = getLayout();
  return {
    catalogue: widgetCatalogue(), categories: WIDGET_CATEGORIES,
    widgets: layout.hub.widgets, spacing: layout.hub.spacing,
  };
}

export { describeLayoutPatch };

// ---------------------------------------------------------------------------
// Discovery-backed views — everything the browser sees is built here, once per cycle
// ---------------------------------------------------------------------------

let dockerCache = { at: 0, containers: null, reason: null, engine: null };
let invCache = { at: 0, value: null };
let lastDiscoveryAt = null;

/** Raw (label-bearing) container list, cached. `containers === null` means "engine not there",
 * which is different from "no containers". Only public-safe reasons ever cross the API boundary. */
export async function dockerContainers({ refreshMs = 15000, force = false } = {}) {
  if (!force && Date.now() - dockerCache.at < refreshMs && (dockerCache.containers || dockerCache.reason)) return dockerCache;
  const at = Date.now();
  const avail = docker.availability();
  // NOTE: only `public` reasons cross the API boundary — `reason` may name socket paths
  // and stays in server logs. See server/providers/docker.js.
  if (!avail.ok) {
    if (process.env.OPUSHUB_DEBUG) console.warn(`[docker] unavailable: ${avail.reason}`);
    dockerCache = { at, containers: null, reason: avail.public, engine: null };
    return dockerCache;
  }
  try {
    const [containers, engine] = await Promise.all([
      docker.listContainers({ all: true, withLabels: true }),
      docker.engineInfo().catch(() => null),
    ]);
    dockerCache = { at, containers, reason: null, engine };
  } catch (err) {
    if (process.env.OPUSHUB_DEBUG) console.warn(`[docker] engine error: ${err.message}`);
    dockerCache = { at, containers: null, reason: 'Docker engine answered with an error. Check the daemon and try again.', engine: null };
  }
  return dockerCache;
}

/**
 * The canonical inventory: one object per container, URLs resolved, overlays applied, stacks
 * grouped by compose project. Everything (Services, Hub, Stacks, search, detail pages) reads
 * this same structure, so the pages cannot disagree about what exists.
 */
export async function getInventory({ refreshMs = 15000, force = false } = {}) {
  if (!force && invCache.value && Date.now() - invCache.at < refreshMs) return invCache.value;
  const { containers, reason, engine, at } = await dockerContainers({ refreshMs, force });
  const live = !!containers;
  const settings = getSettings();
  const infra = settings.infrastructure || {};
  const layout = getLayout();
  const { skipped, overlays, groups: groupMeta } = readServices();
  const stacksDoc = readStacks();
  const host = infra.hostAddress ? { address: infra.hostAddress, source: 'configured' } : await hostAddress();
  const built = discover(containers || [], {
    live,
    serviceOverlays: overlays,
    stackOverlays: stacksDoc.stacks,
    groupMeta,
    groupOrder: Array.isArray(layout.services?.groupOrder) ? layout.services.groupOrder : null,
    order: layout.services?.order || {},
    hostAddress: host.address ? String(host.address).replace(/^https?:\/\//, '').replace(/\/+$/, '') : null,
    hostAddressSource: host.source,
    entrypointPorts: infra.entrypointPorts && Object.keys(infra.entrypointPorts).length ? infra.entrypointPorts : null,
    // the only thing the model supplies is the *probe* (does an icon with this name exist in a
    // bundled set?); discovery decides which identity signals to offer, and a miss is a monogram
    suggestRef,
  });
  lastDiscoveryAt = Date.now();
  // “unmatched” compares an overlay against discovery. With no engine there is nothing to
  // compare to, so the honest answer is the offline reason above — not “your config is wrong”.
  const unmatched = !live ? [] : [
    ...built.unmatched.map((o) => ({
      kind: 'service',
      name: o.name,
      group: o.group || null,
      container: o.container || null,
      conflict: o.conflict || null,
      reason: o.reason || (o.conflict
        ? 'two overlays bind to the same container'
        : 'no container matches this overlay — it is not shown as a live service'),
    })),
    ...(stacksDoc.skipped || []).map((x) => ({ kind: 'stack', name: x.name, reason: x.reason })),
    ...(built.unmatchedStackOverlays || [])
      .map((s) => ({ kind: 'stack', name: s.name, container: s.project || null, reason: 'no compose project or container matches this stack overlay — it is not shown as a live stack' })),
  ];
  const value = {
    ...built,
    at,
    live,
    statusReason: live ? null : reason,
    skipped,
    stackSkipped: stacksDoc.skipped || [],
    overlayServiceCount: overlays.length + skipped.length, // entries in the file, bound or not
    overlayStackCount: stacksDoc.stacks.length + (stacksDoc.skipped || []).length,
    unmatched,
    hostAddress: host.address || null,
    hostAddressSource: host.source,
    engine,
  };
  invCache = { at: Date.now(), value };
  return value;
}

/** Small projection of the last discovery pass for Settings → System (counts + URL sources only). */
export async function getDiscoveryStatus({ refreshMs = 15000 } = {}) {
  const inv = await getInventory({ refreshMs });
  const avail = docker.availability();
  // Traefik facts, read off the containers' own labels (curated projection — never raw labels).
  const routers = inv.services.flatMap((s) => s.container.labels?.proxy || []);
  const entrypoints = [...new Set(routers.flatMap((r) => r.entrypoints || []))].sort();
  const proxyNetworks = [...new Set(inv.services
    .filter((s) => (s.container.labels?.proxy || []).length)
    .flatMap((s) => s.container.networks.map((n) => n.name)))]
    .sort();
  return {
    engine: {
      ok: !!inv.live,
      state: avail.ok ? 'connected' : avail.state,
      version: inv.engine?.version || null,
      api: inv.engine?.apiVersion || null,
      containers: inv.stats.containers,
      running: inv.stats.running,
      stopped: inv.stats.stopped,
      operatingSystem: inv.engine?.os || null,
    },
    urlDiscovery: {
      sources: inv.stats.urlSources,
      withUrl: inv.stats.withUrl,
      withoutUrl: inv.stats.containers - inv.stats.withUrl,
      hostAddress: inv.hostAddress,
      hostAddressSource: inv.hostAddressSource,
      entrypointPorts: getSettings().infrastructure?.entrypointPorts || {},
      traefikRouters: inv.services.filter((s) => s.container.labels?.proxy?.length).length,
      // the services a first-run setup should mention as "attention": real containers with no
      // browser URL, each carrying the honest reason the resolver refused to invent one
      withoutUrlList: inv.services
        .filter((s) => !s.url && !s.hidden && s.kind !== 'infrastructure')
        .slice(0, 40)
        .map((s) => ({ name: s.name, displayName: s.displayName, group: s.group, reason: s.urlNote || null })),
    },
    traefik: {
      containers: inv.services.filter((s) => s.container.labels?.proxy?.length).length,
      routers: routers.length,
      tlsRouters: routers.filter((r) => r.tls).length,
      entrypoints,
      networks: proxyNetworks,
      routes: routers.slice(0, 40).map((r) => ({
        router: r.router, hosts: r.hosts, entrypoints: r.entrypoints, tls: !!r.tls, path: r.path || null,
      })),
      // routers that carry a matcher instead of a hostname — reported, never turned into a URL
      hostRegexpOnly: routers.filter((r) => !(r.hosts || []).length).length,
    },
    overlays: {
      // bound = enriching a container that exists; entries = what the files actually contain,
      // so the UI can say “5 of 6 entries bind” rather than only counting the successes
      serviceOverlays: inv.services.filter((s) => s.configured).length,
      stackOverlays: inv.stacks.filter((s) => s.configured).length,
      serviceEntries: inv.overlayServiceCount,
      stackEntries: inv.overlayStackCount,
      unmatched: inv.unmatched.length,
      unmatchedList: inv.unmatched,
      skipped: inv.skipped.length,
    },
    inventory: { applications: inv.stats.applications, infrastructure: inv.stats.infrastructure, stacks: inv.stats.stacks, standalone: inv.stats.standalone },
    discoveredAt: lastDiscoveryAt,
  };
}

/** Drop both caches — after a config write or a manual refresh, so the UI never shows a stale
 * overlay next to fresh containers. */
export function invalidateDiscovery() {
  invCache = { at: 0, value: null };
  dockerCache = { at: 0, containers: null, reason: null, engine: null };
}

export function serviceStatus(service, containers) {
  // Kept for the (rare) direct-mapping call sites and tests: a container is required — no
  // container means "not installed here", never "unmanaged but present".
  if (!containers) return { state: 'unavailable', reason: containers === null ? 'Docker not connected' : null };
  const c = containers.find((x) => (service?.container && (x.name === service.container || x.id === service.container || x.id.startsWith(service.container))))
    || containers.find((x) => x.name === service?.name || x.name.toLowerCase() === String(service?.name || '').toLowerCase())
    || containers.find((x) => x.labels?.service?.toLowerCase() === String(service?.name || '').toLowerCase());
  if (!c) return { state: 'absent', reason: 'no such container on this engine' };
  const state = c.state === 'running' ? (c.health === 'unhealthy' ? 'unhealthy' : 'up') : c.state === 'exited' ? 'down' : c.state;
  return { state, container: c };
}

/** Resolve a service by whatever the URL bar carries: container name, id, or display name.
 * Case-insensitive, group ignored when it doesn't match (old bookmarks keep working). */
export function findService(inv, group, name) {
  const all = [...(inv.groups || []).flatMap((g) => g.services), ...(inv.services || [])];
  const key = String(name || '').toLowerCase();
  const gkey = String(group || '').toLowerCase();
  const match = (s) => s.name.toLowerCase() === key || s.id === key || s.id.startsWith(key) || s.displayName?.toLowerCase() === key || s.slug === key;
  return all.find((s) => match(s) && (!gkey || s.group?.toLowerCase() === gkey))
    || all.find(match) || null;
}

/** The full Services view the UI renders. */
export async function getServicesView() {
  const inv = await getInventory();
  return {
    groups: inv.groups,
    // the full flat inventory (incl. infrastructure + hidden) so the overlay editor can bind an
    // entry to any real container, not only the ones the Services page happens to show
    services: inv.services,
    infrastructure: inv.infrastructure,
    skipped: inv.skipped,
    unmatched: inv.unmatched.filter((u) => u.kind === 'service'),
    live: inv.live,
    statusSource: inv.live ? 'docker' : 'unavailable',
    statusReason: inv.statusReason,
    discoveredAt: inv.at,
    stats: inv.stats,
  };
}

/** @deprecated use getServicesView — kept so older call sites/tests keep resolving. */
export const getServicesWithStatus = getServicesView;

/** Stacks: compose projects (Docker's answer) enriched by stacks.yaml (our answer). */
export async function getStacksDoc() {
  const inv = await getInventory();
  return {
    stacks: inv.stacks.map((s) => ({
      id: s.id, project: s.project, name: s.name, displayName: s.displayName,
      description: s.description, icon: s.icon, notes: s.notes, compose: s.compose,
      source: s.source, configured: s.configured, status: s.status, statusReason: null,
      containerCount: s.containerCount, runningCount: s.runningCount,
      unhealthyCount: s.unhealthyCount || 0, stoppedCount: s.stoppedCount || 0, attentionCount: s.attentionCount || 0,
      services: s.services, members: s.members,
    })),
    live: inv.live,
    statusReason: inv.statusReason,
    standalone: inv.standalone,
    unmatched: inv.unmatched.filter((u) => u.kind === 'stack'),
  };
}

/** How many Docker calls a stack page may have in flight at once. A 40-container project must not
 *  fire 40 simultaneous inspects at a daemon that is also serving the rest of the host. */
const STACK_ENRICH_CONCURRENCY = 4;

/**
 * Enrich one stack's members with inspect-level detail (ports/networks/volumes/health/stats).
 *
 * Bounded on purpose — this route is polled, so its cost has to be predictable:
 *   • only *running* members are inspected. A stopped container's state, image and id already come
 *     from the list projection, and asking the daemon about a container that cannot be running
 *     buys nothing;
 *   • at most STACK_ENRICH_CONCURRENCY inspects are in flight at any moment;
 *   • stats go through the shared sampler (`statsWithHistory`), so a container that the service
 *     page is also watching costs one Docker call per interval for both, and both get history.
 */
export async function enrichStackMembers(stack) {
  const blank = (m) => ({ ...m, stats: null, ports: [], networks: [], mounts: [] });
  if (!docker.availability().ok) return stack.members.map(blank);

  const out = new Array(stack.members.length);
  const work = stack.members.map((m, i) => ({ m, i }));
  let cursor = 0;

  async function run() {
    while (cursor < work.length) {
      const { m, i } = work[cursor++];
      if (!m.container) { out[i] = blank(m); continue; }
      const ref = m.container.id || m.container.name;
      const running = m.container.state === 'running';
      try {
        if (!running) {
          // a stopped container: report what the engine said, claim nothing about health or stats
          out[i] = { ...m, stats: null, ports: [], networks: [], mounts: [], health: null };
          continue;
        }
        const [insp, stats] = await Promise.all([
          docker.inspectContainer(ref),
          statsWithHistory(ref),
        ]);
        out[i] = {
          ...m,
          stats: stats || null,
          ports: insp.ports, networks: insp.networks, mounts: insp.mounts,
          startedAt: insp.state.status === 'running' ? insp.state.startedAt : null,
          restartCount: insp.state.restartCount,
          restartPolicy: insp.restartPolicy, command: insp.command, created: insp.created,
          health: insp.state.health,
        };
      } catch { out[i] = { ...m, stats: null, error: true }; }
    }
  }

  await Promise.all(Array.from({ length: Math.min(STACK_ENRICH_CONCURRENCY, work.length) }, run));
  return out;
}

/**
 * The rollup the Stack page shows above the member list: counts by state, aggregate CPU/memory,
 * lifetime network totals, and how long the stack has been up (the *oldest* running member — a
 * stack is only as "up" as its longest-surviving container).
 *
 * Everything is derived from the enriched members; members that reported nothing are excluded from
 * a total rather than counted as zero, and `reporting` says how many actually answered.
 */
export function stackRollup(members) {
  const stats = members.filter((m) => m.stats);
  const running = members.filter((m) => m.container?.state === 'running');
  const sum = (pick) => {
    let total = 0;
    let seen = 0;
    for (const m of stats) {
      const v = pick(m);
      if (v != null) { total += v; seen += 1; }
    }
    return seen ? { total, seen } : null;
  };
  const cpu = sum((m) => m.stats.cpu);
  const mem = sum((m) => m.stats.memory?.used ?? null);
  const memLimit = sum((m) => m.stats.memory?.limit ?? null);
  const netRx = sum((m) => m.stats.net?.rx ?? null);
  const netTx = sum((m) => m.stats.net?.tx ?? null);
  const starts = running
    .map((m) => m.startedAt)
    .filter((x) => typeof x === 'string' && x && !x.startsWith('0001'))
    .map((x) => Date.parse(x))
    .filter((x) => Number.isFinite(x));
  return {
    containers: members.length,
    running: running.length,
    stopped: members.filter((m) => m.container?.state === 'exited').length,
    unhealthy: members.filter((m) => (m.health ?? m.container?.health) === 'unhealthy').length,
    reporting: stats.length,
    cpu: cpu ? cpu.total : null,
    memory: mem ? mem.total : null,
    memoryLimit: memLimit && memLimit.seen === mem?.seen ? memLimit.total : null,
    netRx: netRx ? netRx.total : null,
    netTx: netTx ? netTx.total : null,
    // oldest running member: the stack cannot have been up longer than its longest-lived container
    upSince: starts.length ? Math.min(...starts) : null,
  };
}

/** Status of a stack given its member container states (helper for tests/callers).
 *  Mirrors the documented model in discovery.js `stackStatusOf` exactly:
 *  unavailable > unlinked > unknown > { operational | degraded | stopped | attention }. */
export function stackStatus(memberContainers, live) {
  if (!live) return 'unavailable';
  if (!memberContainers.length) return 'unlinked';
  const states = memberContainers.map((c) => c?.state ?? null);
  if (states.some((s) => s == null)) return 'unknown';
  const running = states.filter((s) => s === 'running');
  if (running.length === states.length) {
    const unhealthy = memberContainers.some((c) => c?.state === 'running' && c?.health === 'unhealthy');
    return unhealthy ? 'degraded' : 'operational';
  }
  if (running.length === 0) return states.every((s) => s === 'exited') ? 'stopped' : 'attention';
  return 'degraded';
}
