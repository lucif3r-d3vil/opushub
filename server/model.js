// The config model + the presentation overlay.
//
// Docker decides WHAT EXISTS, Traefik/published ports decide HOW TO REACH IT, and these files
// decide HOW IT LOOKS. That ordering is the whole design: `services.yaml` and `stacks.yaml` are
// overlays that enrich discovered containers, and they can never create an infrastructure object.
// A configured entry whose container is gone is reported as an unmatched overlay (Settings →
// System, and a quiet banner on Services) instead of being rendered as if it were installed.
import { readYaml, readJson, writeYaml, writeJson } from './configStore.js';
import * as docker from './providers/docker.js';
import { discover } from './discovery.js';
import { suggestRef } from './providers/icons.js';
import { hostAddress } from './lib/hostAddress.js';
import { defaultLayout, normalizeLayout, describeLayoutPatch } from './layout.js';
import { applyTemplate, hasTemplate, templateList } from './templates.js';
import { WIDGET_CATEGORIES, widgetCatalogue } from './widgets.js';
import { validateSymbol as validateMarketSymbol } from './providers/market.js';

export const DEFAULT_SETTINGS = {
  app: { name: 'OpusHub', tagline: 'The homelab, at a glance.' },
  appearance: {
    theme: 'system',
    accent: 'sage',
    density: 'comfortable',
    transparency: true,
    fontScale: 1,
    background: { mode: 'quiet', photo: null, blur: 24, scrim: 62 },
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

/** Enrich one stack's members with inspect-level detail (ports/networks/volumes/stats). */
export async function enrichStackMembers(stack) {
  if (!docker.availability().ok) {
    return stack.members.map((m) => ({ ...m, stats: null, ports: [], networks: [], mounts: [] }));
  }
  return Promise.all(stack.members.map(async (m) => {
    if (!m.container) return { ...m, stats: null, ports: [], networks: [], mounts: [] };
    try {
      const [insp, stats] = await Promise.all([
        docker.inspectContainer(m.container.id || m.container.name),
        docker.containerStats(m.container.id || m.container.name).catch(() => null),
      ]);
      return {
        ...m,
        stats, ports: insp.ports, networks: insp.networks, mounts: insp.mounts,
        startedAt: insp.state.startedAt, restartCount: insp.state.restartCount,
        restartPolicy: insp.restartPolicy, command: insp.command, created: insp.created,
        health: insp.state.health,
      };
    } catch { return { ...m, stats: null, error: true }; }
  }));
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
