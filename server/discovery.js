// Discovery — the single canonical inventory.
//
//   Docker Engine ─▶ normalize() ─▶ resolveUrl() ─▶ presentation overlay ─▶ services · stacks
//
// Docker decides what EXISTS (one object per container id, always). Traefik/published ports
// decide how to REACH it. OpusHub config only decides how it LOOKS: an overlay entry that
// matches a container enriches it; an overlay entry that matches nothing is reported as an
// unmatched overlay and creates no service, no stack, no URL. Nothing here knows any
// application by name, any domain, or any port convention beyond a short "is this web-ish"
// ranking list in urlResolver.
import { parseCompose, parseTraefik, parseOverlayLabels, curatedLabels, humanize, slugify, projectFromPaths, str } from './providers/dockerLabels.js';
import { resolveUrl, normalizePorts } from './urlResolver.js';

const HEALTH_IN_STATUS = /\((healthy|unhealthy|starting)\)\s*$/i;

// Compact infrastructure *shape* signals. Not an application blacklist: these only matter for
// containers with no web endpoint, and an explicit config overlay always overrides them.
const INFRA_NAME = /(^|[\s._/-])(db|database|postgres|postgresql|mysql|mariadb|mongo|redis|valkey|memcache|memcached|cache|queue|rabbitmq|nats|mqtt|broker|bus|etcd|consul|zookeeper|vault|proxy|traefik|nginx|caddy|envoy|haproxy|gateway|socket|agent|sidecar|init|seed|migrate|migration|scheduler|worker|watchtower|updater|exporter|metrics|promtail|loki|collector|daemon|internal|machine-learning|ml|inference|backup|restic|cron)([\s._/-]|$)/i;
const INFRA_IMAGE = /(^|[/.-])(postgres|postgresql|mysql|mariadb|mongo|mongo-db|redis|valkey|memcached|rabbitmq|nats|etcd|consul|traefik|nginx|caddy|envoy|haproxy|prometheus|node-exporter|cadvisor|metrics|exporter|busybox|alpine|sidecar)([-:.:/]|$)/i;

// ---------------------------------------------------------------------------
// 1. normalize: raw engine list item → canonical record
// ---------------------------------------------------------------------------

export function normalizeContainer(raw) {
  const labels = raw.rawLabels || raw.labels?.raw || {};
  const compose = parseCompose(labels);
  const traefik = parseTraefik(labels);
  const overlay = parseOverlayLabels(labels);
  const ports = normalizePorts(raw.ports);
  const health = raw.health || (HEALTH_IN_STATUS.exec(raw.status || '') || [])[1]?.toLowerCase() || null;
  const fallbackProject = compose && !compose.project ? projectFromPaths(compose) : null;
  const project = compose?.project || null;
  const service = compose?.service || null;
  const name = String(raw.name || '').replace(/^\//, '');
  return {
    // infrastructure identity — from Docker, immutable, never config-supplied
    containerId: raw.id,
    containerName: name,
    image: raw.image || null,
    imageId: raw.imageId || null,
    state: raw.state || null,
    status: raw.status || null,
    health,
    created: raw.created ?? null,
    restartCount: raw.restartCount ?? null, // list API has none; the detail route fills it from inspect
    composeProject: project,
    composeService: service,
    composeFallbackProject: fallbackProject,
    networks: raw.networks || [],
    ports,
    labels: curatedLabels({ compose, traefik, overlay }),
    // raw label sets stay server-side only (used for URL + overlay decisions)
    _traefik: traefik,
    _compose: compose,
    _labelOverlay: overlay,
  };
}

/** `<project>[-_]service[-_]<n>` is the compose default container name (v2 uses `-`, the older
 * `docker-compose` used `_`). Recover the service part so `opustream-seerr-1` reads `Seerr`,
 * not `Opustream Seerr 1`. */
export function baseName(containerName, project) {
  let s = String(containerName || '').replace(/^\//, '');
  let sep = '-';
  if (project) {
    const lower = s.toLowerCase();
    for (const c of ['-', '_']) {
      if (lower.startsWith(`${project.toLowerCase()}${c}`)) { sep = c; s = s.slice(project.length + 1); break; }
    }
    if (s.toLowerCase() === project.toLowerCase()) s = project;
  }
  s = s.replace(new RegExp(`[${sep}_](\\d{1,2})$`), ''); // compose replica suffix
  return s || containerName;
}

/** Default presentation identity, derived from Docker metadata only. No app-name table:
 * `seerr` → `Seerr`, `home-assistant` → `Home Assistant`, `opustream-navidrome-2` → `Navidrome`. */
export function deriveDisplayName(record) {
  const raw = record.composeService || baseName(record.containerName, record.composeProject);
  return humanize(raw) || record.containerName;
}

/** `ghcr.io/immich-app/immich-server:v1.118.0` → candidate slugs, most specific first. */
export function imageSlugs(image) {
  if (!image) return [];
  let repo = String(image).trim();
  repo = repo.replace(/^[a-z0-9.-]+(:\d+)?\//i, (m) => (/localhost(:\d+)?$/i.test(m) ? '' : '')); // drop registry host
  repo = repo.split('@')[0];
  const tagless = repo.split(':')[0];
  const parts = tagless.split('/').filter(Boolean);
  const out = [];
  const push = (s) => {
    const clean = String(s || '').toLowerCase()
      .replace(/\.(git|tar)$/g, '')
      .replace(/[-_](server|alpine|debian|official|stable|edge|latest|full|web|nginx|apache|cuda|universal)$/g, '')
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/^-+|-+$/g, '');
    if (clean && clean.length > 1 && !out.includes(clean)) out.push(clean);
  };
  push(parts[parts.length - 1]);
  for (const p of parts) push(p);
  return out.slice(0, 6);
}

// ---------------------------------------------------------------------------
// 2. classification: user-facing application vs infrastructure
// ---------------------------------------------------------------------------

/**
 * Application or infrastructure? Signals, in order of how much they mean:
 *   1. an explicit overlay — the owner said "this is a service"
 *   2. a reverse-proxy route — somebody deliberately gave it a browser URL
 *   3. a name/image that reads as a rail (db, cache, proxy, worker, exporter, …)
 *   4. a published HTTP port
 *   5. otherwise: a plain container the user probably cares about (an app with no endpoint yet)
 * Step 3 outranks 4 on purpose: Prometheus on :9090 is a rail even though it has a web UI, while
 * an application that is merely stopped stays an application.
 */
export function classify(record, { traefikRouted, urlFound, configured } = {}) {
  if (configured) return { kind: 'application', kindSource: 'explicit overlay' };
  // a container may also declare its role: opushub.kind: application|infrastructure
  const declared = String(record._labelOverlay?.kind || '').trim().toLowerCase();
  if (declared === 'infrastructure' || declared === 'infra') return { kind: 'infrastructure', kindSource: 'container label' };
  if (declared === 'application' || declared === 'app') return { kind: 'application', kindSource: 'container label' };
  if (traefikRouted) return { kind: 'application', kindSource: 'proxied route' };
  const names = [record.containerName, record.composeService, record.composeProject].filter(Boolean).join(' ');
  if (INFRA_NAME.test(names)) return { kind: 'infrastructure', kindSource: 'name/service signal' };
  if (INFRA_IMAGE.test(record.image || '')) return { kind: 'infrastructure', kindSource: 'image signal' };
  if (urlFound) return { kind: 'application', kindSource: 'published port' };
  return { kind: 'application', kindSource: 'no infrastructure signal' };
}

// ---------------------------------------------------------------------------
// 3. the join: containers + overlays → one canonical object per container
// ---------------------------------------------------------------------------

/** Bind config entries to containers. One container absorbs at most one overlay (first match
 * wins, later duplicates are reported as conflicts); one overlay binds to at most one container.
 * Returns { byId, matched, unmatched } — `unmatched` never becomes a service. */
export function bindOverlays(records, overlays) {
  const byId = new Map();
  const matched = new Set();
  const unmatched = [];
  const find = (pred) => records.find((r) => !byId.has(r.containerId) && pred(r)) || null;
  for (const o of overlays || []) {
    const wanted = str(o.container, 120);
    const key = String(o.name || '').toLowerCase();
    let hit = null;
    if (wanted) {
      const w = wanted.toLowerCase();
      // an explicit `container:` reference is authoritative — exact name or id prefix
      hit = find((r) => r.containerName.toLowerCase() === w || r.containerId === w || r.containerId.startsWith(w));
    }
    if (!hit && key) {
      hit = find((r) => r.containerName.toLowerCase() === key
        || baseName(r.containerName, r.composeProject).toLowerCase() === key
        || (r.composeService || '').toLowerCase() === key);
    }
    if (!hit && key) hit = find((r) => (r.imageSlugs || []).includes(key));
    if (hit) {
      byId.set(hit.containerId, o);
      matched.add(o);
      continue;
    }
    // Would this overlay have matched a container that another entry already claimed? Saying so is
    // the difference between “check your config” and “go hunt for a typo in the inventory”.
    const taken = records.find((r) => byId.has(r.containerId) && (wanted
      ? (r.containerName.toLowerCase() === wanted.toLowerCase() || r.containerId.startsWith(wanted.toLowerCase()))
      : (r.containerName.toLowerCase() === key || baseName(r.containerName, r.composeProject).toLowerCase() === key || (r.composeService || '').toLowerCase() === key)));
    if (taken) {
      const owner = byId.get(taken.containerId);
            unmatched.push({
        ...o,
        container: taken.containerName,
        conflict: `overlaid by “${owner.displayName || owner.name}”`,
        reason: `container “${taken.containerName}” is already overlaid by “${owner.displayName || owner.name}” — keep one entry per container`,
      });
      continue;
    }
    unmatched.push({
      ...o,
      reason: wanted
        ? `no container named “${wanted}” on this Docker host — it is not displayed until it exists`
        : `no container matches “${o.name}” on this Docker host — a config entry can no longer create a service`,
    });
  }
  return { byId, matched, unmatched };
}

/** Compose a browser-safe service object from one container + its (optional) overlay. */
export function toService(record, overlay, ctx) {
  const labelOverlay = record._labelOverlay || {};
  const o = overlay || {};
  const manual = o.url || labelOverlay.url || null;
  const manualSource = o.url ? (o.urlSource || 'services.yaml') : (labelOverlay.source || 'container label');
  const url = resolveUrl(
    {
      name: record.containerName,
      composeService: record.composeService,
      composeProject: record.composeProject,
      ports: record.ports,
      traefik: record._traefik,
      manualUrl: manual,
      overlay: manual ? { url: manual, urlSource: manualSource } : null,
    },
    ctx,
  );
  const displayName = o.displayName || labelOverlay.displayName || deriveDisplayName(record);
  const kind = classify(record, {
    traefikRouted: (record._traefik?.count || 0) > 0,
    urlFound: !!url.url,
    configured: !!overlay,
  });
  const icon = o.icon || labelOverlay.icon || null;
  const iconSource = o.icon ? 'config' : labelOverlay.icon ? 'label' : null;
  const group = o.group || labelOverlay.group || null;
  const state = record.state;
  const status = state === 'running'
    ? (record.health === 'unhealthy' ? 'unhealthy' : 'up')
    : state === 'exited' ? 'down'
      : state || 'unknown';
  return {
    // canonical identity
    name: record.containerName,          // unique in Docker — the URL key for detail routes
    displayName,
    slug: slugify(record.containerName),
    id: record.containerId,
    // presentation
    app: o.app || labelOverlay.app || null,
    description: o.description || labelOverlay.description || null,
    url: url.url,
    urlSource: url.url ? url.urlSource : 'none',
    urlNote: url.urlNote || null,
    icon,
    iconSource,
    iconSuggestion: icon ? null : (ctx.suggestIcon?.(record) || null),
    group: group || ctx.defaultGroup || 'Other',
    groupSource: group ? (o.group ? 'config' : 'label') : 'default',
    keywords: o.keywords || [],
    meta: [...(labelOverlay.meta || []), ...(o.meta || [])].slice(0, 12),
    order: Number.isFinite(o.order) ? o.order : (Number.isFinite(labelOverlay.order) ? labelOverlay.order : null),
    hidden: o.hidden === true,
    showOnHub: o.showOnHub !== false,
    configured: !!overlay,
    discovered: true,
    // what enriched this container: nothing, a container label, or services.yaml
    overlaid: overlay ? 'services.yaml' : (labelOverlay.displayName || labelOverlay.icon || labelOverlay.group || labelOverlay.url || labelOverlay.description ? 'container label' : null),
    kind: kind.kind,
    kindSource: kind.kindSource,
    status,
    statusReason: null,
    stack: null,          // stack id (compose project) — filled by buildStacks
    stackDisplayName: null,
    // infrastructure
    container: {
      name: record.containerName,
      id: record.containerId,
      image: record.image,
      state: record.state,
      status: record.status,
      health: record.health,
      created: record.created,
      restartCount: record.restartCount,
      composeProject: record.composeProject,
      composeService: record.composeService,
      networks: record.networks,
      ports: record.ports,
      labels: record.labels,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. stacks: compose projects, enriched by (never created by) config
// ---------------------------------------------------------------------------

export function stackStatusOf(records) {
  if (!records.length) return 'unlinked';
  const running = records.filter((r) => r.state === 'running').length;
  const unhealthy = records.some((r) => r.state === 'running' && r.health === 'unhealthy');
  if (running === records.length) return unhealthy ? 'degraded' : 'operational';
  if (running === 0) return records.every((r) => r.state === 'created') ? 'unlinked' : 'attention';
  return 'degraded';
}

export function buildStacks(records, stacksOverlay, ctx = {}) {
  const byProject = new Map();
  const standalone = [];
  for (const r of records) {
    const project = r.composeProject || r.composeFallbackProject;
    if (!project) { standalone.push(r); continue; }
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project).push(r);
  }
  const overlays = stacksOverlay || [];
  const usedOverlay = new Set();
  const stacks = [];
  const projectStacks = [...byProject.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [project, members] of projectStacks) {
    const o = overlays.find((x) => !usedOverlay.has(x.name) && (x.project || x.name).toLowerCase() === String(project).toLowerCase());
    if (o) usedOverlay.add(o.name);
    stacks.push({
      id: project,
      project,
      name: o?.displayName || humanize(project) || project,
      displayName: o?.displayName || humanize(project) || project,
      description: o?.description || null,
      icon: o?.icon || null,
      notes: o?.notes || null,
      compose: null, // host path of the compose file: deliberately never exposed (see security notes)
      source: o ? 'configured' : 'discovered',
      configured: !!o,
      members,
    });
  }
  // A configured stack that groups real containers directly (legacy `services: [A, B]` lists,
  // or hand-run containers) becomes its own stack — from matched *containers*, never from names.
  for (const o of overlays) {
    if (usedOverlay.has(o.name)) continue;
    const memberNames = new Set((o.members || []).map((n) => String(n).toLowerCase()));
    let members = memberNames.size
      ? records.filter((r) => memberNames.has(r.containerName.toLowerCase()) || memberNames.has(baseName(r.containerName, r.composeProject).toLowerCase()) || memberNames.has((r.composeService || '').toLowerCase()))
      : [];
    if (!members.length) continue; // no container → no stack. Docker decides existence.
    // If every member already lives in exactly one project stack, that IS this stack: merge.
    const projects = new Set(members.map((m) => m.composeProject || m.composeFallbackProject).filter(Boolean));
    if (projects.size === 1) {
      const [project] = [...projects];
      const existing = stacks.find((s) => s.project === project);
      const target = existing || (() => { const s = { id: project, project, name: humanize(project) || project, displayName: humanize(project) || project, description: null, icon: null, notes: null, compose: null, source: 'configured', configured: false, members: [] }; stacks.push(s); return s; })();
      target.name = o.displayName || target.name;
      target.displayName = o.displayName || target.displayName;
      target.description = o.description || target.description;
      target.icon = o.icon || target.icon;
      target.notes = o.notes || target.notes;
      target.source = 'configured';
      target.configured = true;
      // a legacy overlay keyed only by a friendly name (`name: Media`, no `project:`) renames
      // the project its members actually live in — enrichment of real containers, not invention
      if (!o.projectExplicit && o.name && o.name !== target.project) {
        target.displayName = o.name;
        target.name = o.name;
      }
      usedOverlay.add(o.name);
      continue;
    }
    stacks.push({
      id: slugify(o.name), project: null, name: o.displayName || o.name, displayName: o.displayName || o.name,
      description: o.description || null, icon: o.icon || null, notes: o.notes || null, compose: null,
      source: 'configured', configured: true, members,
    });
  }
  const unmatchedOverlays = overlays.filter((o) => !usedOverlay.has(o.name));
  stacks.sort((a, b) => a.name.localeCompare(b.name));
  for (const s of stacks) {
    s.containerCount = s.members.length;
    s.runningCount = s.members.filter((r) => r.state === 'running').length;
    s.status = ctx.live === false ? 'unavailable' : stackStatusOf(s.members);
    s.services = s.members.map((m) => m.__service?.displayName || deriveDisplayName(m)).slice(0, 40);
    s.members = s.members.map((m) => {
      const svc = m.__service;
      if (svc) { svc.stack = s.id; svc.stackDisplayName = s.name; } // presentation tag only — membership is Docker's answer
      return {
        service: svc?.displayName || deriveDisplayName(m),
        name: svc?.displayName || deriveDisplayName(m),
        containerName: m.containerName,
        group: svc?.group || null,
        icon: svc?.icon || null,
        url: svc?.url || null,
        urlSource: svc?.urlSource || 'none',
        kind: svc?.kind || 'application',
        configured: !!svc?.configured,
        container: briefOf(m),
        route: m.composeService || baseName(m.containerName, m.composeProject),
      };
    });
  }
  return {
    stacks,
    unmatchedOverlays,
    standalone: standalone.map((r) => ({
      ...briefOf(r),
      displayName: r.__service?.displayName || deriveDisplayName(r),
      kind: r.__service?.kind || 'application',
      url: r.__service?.url || null,
      urlSource: r.__service?.urlSource || 'none',
    })),
  };
}

const briefOf = (c) => ({
  name: c.containerName, id: c.containerId, state: c.state, status: c.status, health: c.health, image: c.image,
  composeProject: c.composeProject, composeService: c.composeService,
});

// ---------------------------------------------------------------------------
// 5. the orchestrator
// ---------------------------------------------------------------------------

/**
 * @param raws     engine list items (must carry `rawLabels`)
 * @param opts     { serviceOverlays, stackOverlays, hostAddress, entrypointPorts, groupOrder, groupMeta, order, live, defaultGroup, suggestIcon }
 */
export function discover(raws, opts = {}) {
  const records = (raws || []).map((r) => {
    const rec = normalizeContainer(r);
    rec.imageSlugs = imageSlugs(rec.image);
    return rec;
  });
  const ctx = {
    hostAddress: opts.hostAddress || null,
    hostAddressSource: opts.hostAddressSource || (opts.hostAddress ? 'configured' : 'unavailable'),
    entrypointPorts: opts.entrypointPorts || null,
    defaultGroup: opts.defaultGroup || 'Other',
    suggestIcon: opts.suggestIcon,
  };
  const { byId, unmatched } = bindOverlays(records, opts.serviceOverlays || []);
  const services = [];
  for (const rec of records) {
    const svc = toService(rec, byId.get(rec.containerId), ctx);
    if (!svc.icon && svc.iconSuggestion) { svc.icon = svc.iconSuggestion; svc.iconSource = 'derived:image'; }
    rec.__service = svc;
    services.push(svc);
  }
  const stacksDoc = buildStacks(records, opts.stackOverlays || [], { live: opts.live !== false });
  const { stacks, standalone, unmatchedOverlays } = stacksDoc;

  // groups: only containers that made it into a service object can form one
  const apps = services.filter((s) => s.kind !== 'infrastructure');
  const infra = services.filter((s) => s.kind === 'infrastructure');
  const groupMeta = new Map((opts.groupMeta || []).map((g) => [String(g.name).toLowerCase(), g]));
  const byGroup = new Map();
  for (const s of apps) {
    if (!byGroup.has(s.group)) byGroup.set(s.group, []);
    byGroup.get(s.group).push(s);
  }
  const orderOf = (gname) => groupMeta.get(String(gname).toLowerCase())?.order ?? null;
  let groups = [...byGroup.entries()].map(([name, list]) => {
    const meta = groupMeta.get(name.toLowerCase());
    const layoutOrder = opts.order?.[name];
    let items = [...list];
    if (Array.isArray(layoutOrder) && layoutOrder.length) {
      const rank = new Map(layoutOrder.map((n, i) => [String(n).toLowerCase(), i]));
      items.sort((a, b) => {
        const ra = rank.get(a.name.toLowerCase()) ?? rank.get(slugify(a.name)) ?? 1e9;
        const rb = rank.get(b.name.toLowerCase()) ?? rank.get(slugify(b.name)) ?? 1e9;
        return ra - rb;
      });
    } else {
      items.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.displayName.localeCompare(b.displayName));
    }
    return {
      name,
      description: meta?.description ?? null,
      icon: meta?.icon ?? null,
      configured: !!meta,
      services: items,
    };
  });
  if (Array.isArray(opts.groupOrder) && opts.groupOrder.length) {
    const rank = new Map(opts.groupOrder.map((n, i) => [String(n).toLowerCase(), i]));
    groups.sort((a, b) => (rank.get(a.name.toLowerCase()) ?? 1e9) - (rank.get(b.name.toLowerCase()) ?? 1e9)
      || (orderOf(a.name) ?? 1e9) - (orderOf(b.name) ?? 1e9) || a.name.localeCompare(b.name));
  } else {
    groups.sort((a, b) => (orderOf(a.name) ?? 1e9) - (orderOf(b.name) ?? 1e9) || a.name.localeCompare(b.name));
  }
  // a configured group with no live services is presentation metadata only — never an empty card
  groups = groups.filter((g) => g.services.length);

  const visible = groups
    .map((g) => ({ ...g, services: g.services.filter((s) => !s.hidden) }))
    .filter((g) => g.services.length);
  const urlSources = services.reduce((a, s) => { a[s.urlSource] = (a[s.urlSource] || 0) + 1; return a; }, {});
  const running = services.filter((s) => s.container.state === 'running').length;
  return {
    groups: visible,
    groupsRaw: groups,
    infrastructure: infra.filter((s) => !s.hidden),
    services,
    stacks,
    standalone,
    unmatched,                    // service overlays that bind to no container
    unmatchedStackOverlays: unmatchedOverlays,
    stats: {
      containers: services.length,
      running,
      stopped: services.length - running,
      applications: apps.length,
      infrastructure: infra.length,
      urlSources,
      withUrl: services.filter((s) => s.url).length,
      configured: services.filter((s) => s.configured).length,
      discovered: services.length, // every service is discovered; config can only enrich
      stacks: stacks.length,
      standalone: standalone.length,
    },
  };
}
