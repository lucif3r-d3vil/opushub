// The config model: reads + validates + normalizes services/stacks/bookmarks/settings, and
// joins live container state when (and only when) the Docker provider answers.
import { readYaml, readJson, writeYaml, writeJson } from './configStore.js';
import * as docker from './providers/docker.js';

export const DEFAULT_SETTINGS = {
  app: { name: 'OpusHub', tagline: 'The OpusGrid homelab, at a glance.' },
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
  advanced: { customCss: false, customJs: false },
};

export const DEFAULT_LAYOUT = {
  hub: {
    // two draggable zones: the main column and the side rail
    main: ['overview', 'services'],
    rail: ['weather', 'markets', 'news', 'bookmarks', 'activity'],
    hidden: [],
    sizes: { overview: 'md', services: 'md', weather: 'md', markets: 'md', news: 'md', activity: 'md' },
  },
  services: { groupOrder: null, order: {} },
};

const str = (v, max = 240) => (typeof v === 'string' ? v.trim().slice(0, max) : null);
const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
};

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

function normService(raw, strict = false) {
  if (!raw || typeof raw !== 'object') throw Object.assign(new Error('service entry must be a map'), { status: 400 });
  const name = str(raw.name, 80);
  if (!name) throw Object.assign(new Error('service requires a name'), { status: 400 });
  const bail = (msg) => { if (strict) throw Object.assign(new Error(msg), { status: 400 }); };
  const meta = Array.isArray(raw.meta)
    ? raw.meta.map((m) => ({ label: str(m?.label, 40), value: str(m?.value, 120) })).filter((m) => m.label && m.value)
    : [];
  return {
    name,
    app: str(raw.app, 80),
    description: str(raw.description, 300),
    href: (() => { try { return safeHref(raw.href); } catch (e) { bail(`"${name}": ${e.message}`); return null; } })(),
    icon: (() => { try { return safeIcon(raw.icon); } catch (e) { bail(`"${name}": ${e.message}`); return null; } })(),
    container: str(raw.container, 120),
    stack: str(raw.stack, 80),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map((k) => str(k, 40)).filter(Boolean) : [],
    meta,
  };
}

export function readServices() {
  const doc = readYaml('services.yaml');
  const groups = [];
  const skipped = [];
  for (const g of doc?.groups || []) {
    const name = str(g?.name, 80) || 'Ungrouped';
    const services = [];
    for (const s of g?.services || g?.items || []) {
      try { services.push(normService(s)); }
      catch (e) { skipped.push({ group: name, name: str(s?.name, 80) || '(unnamed)', reason: e.message }); }
    }
    groups.push({ name, description: str(g?.description, 200), services });
  }
  // A hand-edit typo must never blank the whole UI: keep going, surface what was skipped.
  return { groups, skipped };
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
    groups.push({ name, ...(g.description ? { description: g.description } : {}), services });
  }
  writeYaml('services.yaml', { groups });
  return { groups };
}

export function readStacks() {
  const doc = readYaml('stacks.yaml');
  return {
    stacks: (doc?.stacks || []).map((s) => ({
      name: str(s?.name, 80) || 'Unnamed',
      description: str(s?.description, 300),
      icon: (() => { try { return safeIcon(s?.icon); } catch { return null; } })(),
      services: Array.isArray(s?.services) ? s.services.map((x) => str(x, 80)).filter(Boolean) : [],
      compose: str(s?.compose, 300),
      notes: str(s?.notes, 1000),
    })),
  };
}

export function writeStacks(doc) {
  const stacks = [];
  for (const s of doc?.stacks || []) {
    const name = str(s?.name, 80);
    if (!name) throw Object.assign(new Error('stack requires a name'), { status: 400 });
    stacks.push({
      name,
      description: str(s?.description, 300) || null,
      icon: safeIcon(s?.icon),
      services: Array.isArray(s?.services) ? s.services.map((x) => str(x, 80)).filter(Boolean) : [],
      compose: str(s?.compose, 300),
      notes: str(s?.notes, 1000),
    });
  }
  writeYaml('stacks.yaml', { stacks });
  return { stacks };
}

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
  out._rejected = rejected;
  const sym = out?.integrations?.markets?.symbols;
  if (Array.isArray(sym)) out.integrations.markets.symbols = sym.map((x) => str(x, 30)).filter(Boolean).slice(0, 24);
  return out;
}

export function getLayout() { return readJson('layout.json', DEFAULT_LAYOUT); }

export function putLayout(patch) {
  const current = readJson('layout.json', DEFAULT_LAYOUT);
  const next = deepMerge(current, patch);
  writeJson('layout.json', next);
  return next;
}

// ---------- live joins ----------
let dockerCache = { at: 0, containers: null, reason: null };

export async function dockerContainers({ refreshMs = 15000 } = {}) {
  if (Date.now() - dockerCache.at < refreshMs && (dockerCache.containers || dockerCache.reason)) {
    return dockerCache;
  }
  const at = Date.now();
  const avail = docker.availability();
  if (!avail.ok) { dockerCache = { at, containers: null, reason: avail.reason }; return dockerCache; }
  try {
    const containers = await docker.listContainers({ all: true });
    dockerCache = { at, containers, reason: null };
  } catch (err) {
    dockerCache = { at, containers: null, reason: `Docker engine error: ${err.message}` };
  }
  return dockerCache;
}

function matchContainer(service, containers) {
  if (!containers?.length) return null;
  if (service.container) {
    return containers.find((c) => c.name === service.container || c.id === service.container || c.name === `opusgrid-${service.container}`) || null;
  }
  const lower = service.name.toLowerCase();
  return (
    containers.find((c) => c.name.toLowerCase() === lower) ||
    containers.find((c) => c.name.toLowerCase().endsWith(`-${lower}`)) ||
    containers.find((c) => c.labels?.service?.toLowerCase() === lower) ||
    containers.find((c) => (c.image || '').toLowerCase().includes(lower)) ||
    null
  );
}

export function serviceStatus(service, containers) {
  if (!containers) return { state: 'unavailable', reason: containers === null ? 'Docker not connected' : null };
  const c = matchContainer(service, containers);
  if (!c) return { state: 'unmanaged', reason: 'no container linked' };
  const state = c.state === 'running' ? (c.health === 'unhealthy' ? 'unhealthy' : 'up') : c.state === 'exited' ? 'down' : c.state;
  return { state, container: c };
}

/** services.yaml + layout order + live status → what the UI renders */
export async function getServicesWithStatus() {
  const { groups, skipped } = readServices();
  const { containers, reason } = await dockerContainers();
  const layout = getLayout();
  const out = groups.map((g) => {
    let services = g.services.map((s) => {
      const st = serviceStatus(s, containers);
      return {
        ...s,
        group: g.name,
        status: st.state,
        statusDetail: st.container ? { name: st.container.name, image: st.container.image, status: st.container.status, health: st.container.health } : null,
        statusReason: st.state === 'unavailable' ? (reason || 'Docker not connected') : st.reason,
      };
    });
    const order = layout.services?.order?.[g.name];
    if (Array.isArray(order)) {
      const rank = new Map(order.map((n, i) => [n, i]));
      services = [...services].sort((a, b) => (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9));
    }
    return { ...g, services };
  });
  let ordered = out;
  if (Array.isArray(layout.services?.groupOrder) && layout.services.groupOrder.length) {
    const rank = new Map(layout.services.groupOrder.map((n, i) => [n, i]));
    ordered = [...out].sort((a, b) => (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9));
  }
  return {
    groups: ordered, skipped,
    live: !!containers, statusSource: containers ? 'docker' : 'unavailable', statusReason: containers ? null : reason,
  };
}

export function findService(data, group, name) {
  // case-insensitive: URLs are user-typed (and proxies normalize case), names are canonical
  const g = data.groups.find((x) => x.name.toLowerCase() === String(group || '').toLowerCase());
  const s = g?.services.find((x) => x.name.toLowerCase() === String(name || '').toLowerCase());
  return s || null;
}

export function getStacksWithStatus() {
  const { stacks } = readStacks();
  return stacks;
}
