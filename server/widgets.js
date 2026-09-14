// The widget catalogue — the single internal model for every Hub block.
//
// An *instance* stored in layout.json is { id, type, title?, zone, size, visible, config }.
// An instance says WHERE a block sits and HOW BIG it is; `type` says what it is, and the client
// renders one component per type. This catalogue is the validator for everything the browser and
// layout.json can ask for, so a hand-edited file can never produce an unrenderable Hub.
//
// Adding a widget type means: one entry here + one renderer in src/components/hub/widgets.tsx.
// Nothing in this file knows about specific applications, hosts or containers — the data a widget
// shows is always discovered at runtime (see docs/04-discovery.md).

export const WIDGET_ZONES = ['main', 'rail'];
export const WIDGET_SIZES = ['sm', 'md', 'lg'];
export const HUB_SPACING = ['cozy', 'comfortable', 'airy'];

/**
 * Categories are how the picker is organised — they say where a widget's information comes from:
 * this machine, the grid you run on it, the world outside, or you. They are not a second data
 * model: nothing else in the layout depends on them.
 */
export const WIDGET_CATEGORIES = [
  { id: 'system', label: 'System', description: 'This machine, as it is right now' },
  { id: 'grid', label: 'OpusGrid', description: 'What the grid is running' },
  { id: 'information', label: 'Information', description: 'The world outside, when a provider is configured' },
  { id: 'personal', label: 'Personal', description: 'Time, links and what actually happened' },
];

/**
 * Catalogue. `config` is a tiny typed schema — the only keys accepted from the client, so widget
 * configuration stays predictable instead of becoming an unvalidated blob.
 */
export const WIDGET_TYPES = {
  services: {
    category: 'grid',
    title: 'Services',
    description: 'The launcher — every discovered application, grouped',
    zone: 'main',
    size: 'lg',
    sizes: ['sm', 'md', 'lg'],
    config: {
      groups: { label: 'Groups to include', type: 'group-list', hint: 'empty = every group the engine discovered' },
      infrastructure: { label: 'Include rails (databases, proxies)', type: 'boolean' },
    },
  },
  system: {
    category: 'system',
    title: 'System',
    description: 'CPU, memory, storage, network, uptime — a summary, not a dashboard',
    zone: 'main',
    size: 'md',
    sizes: ['sm', 'md', 'lg'],
    config: {},
  },
  stacks: {
    category: 'grid',
    title: 'Stacks',
    description: 'Compose projects and their state',
    zone: 'main',
    size: 'md',
    sizes: ['sm', 'md'],
    config: {},
  },
  attention: {
    category: 'system',
    title: 'Needs attention',
    description: 'Only the containers that are not running — silent when everything is well',
    zone: 'main',
    size: 'sm',
    sizes: ['sm', 'md'],
    config: {},
  },
  clock: {
    category: 'personal',
    title: 'Clock',
    description: 'Time and date, mostly typography',
    zone: 'rail',
    size: 'sm',
    sizes: ['sm', 'md'],
    config: {},
  },
  weather: {
    category: 'information',
    title: 'Weather',
    description: 'Current conditions from the configured location',
    zone: 'rail',
    size: 'md',
    sizes: ['sm', 'md'],
    config: {},
  },
  news: {
    category: 'information',
    title: 'News',
    description: 'Headlines from your feeds',
    zone: 'rail',
    size: 'md',
    sizes: ['sm', 'md', 'lg'],
    config: {},
  },
  markets: {
    category: 'information',
    title: 'Markets',
    description: 'Your watchlist, as a compact table',
    zone: 'rail',
    size: 'md',
    sizes: ['sm', 'md', 'lg'],
    config: {},
  },
  bookmarks: {
    category: 'personal',
    title: 'Bookmarks',
    description: 'Links you keep, by group',
    zone: 'rail',
    size: 'sm',
    sizes: ['sm', 'md', 'lg'],
    config: {
      group: { label: 'Only this bookmark group', type: 'text', hint: 'empty = all of them' },
    },
  },
  activity: {
    category: 'personal',
    title: 'Activity',
    description: 'What actually happened — discoveries, state changes, config writes',
    zone: 'rail',
    size: 'md',
    sizes: ['sm', 'md', 'lg'],
    config: {
      sources: { label: 'Sources', type: 'list', options: ['docker', 'config', 'user', 'system'] },
    },
  },
};

/** The catalogue as the client consumes it (ordered, serialisable, no functions). */
export function widgetCatalogue() {
  return Object.entries(WIDGET_TYPES).map(([type, def]) => ({
    type,
    category: def.category,
    title: def.title,
    description: def.description,
    zone: def.zone,
    size: def.size,
    sizes: def.sizes,
    config: Object.entries(def.config || {}).map(([key, spec]) => ({ key, ...spec })),
  }));
}

/** One instance with catalogue defaults applied. */
export function makeWidget(type, overrides = {}) {
  const def = WIDGET_TYPES[type];
  if (!def) return null;
  return {
    id: overrides.id || type,
    type,
    zone: WIDGET_ZONES.includes(overrides.zone) ? overrides.zone : def.zone,
    size: def.sizes.includes(overrides.size) ? overrides.size : def.size,
    visible: overrides.visible !== false,
    config: normConfig(def.config, overrides.config),
    ...(typeof overrides.title === 'string' && overrides.title.trim() ? { title: overrides.title.trim().slice(0, 40) } : {}),
  };
}

/** Only the keys the catalogue declares, only the values the schema allows. */
export function normConfig(schema, raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, spec] of Object.entries(schema || {})) {
    const v = raw[key];
    if (v == null) continue;
    if (spec.type === 'boolean') {
      if (typeof v === 'boolean') out[key] = v;
      else if (/^(true|yes|1)$/i.test(String(v))) out[key] = true;
      else if (/^(false|no|0)$/i.test(String(v))) out[key] = false;
    } else if (spec.type === 'text') {
      const s = String(v).trim().slice(0, 80);
      if (s) out[key] = s;
    } else if (spec.type === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[key] = Math.max(spec.min ?? 0, Math.min(spec.max ?? 100, Math.round(n)));
    } else if (spec.type === 'list') {
      const allowed = spec.options || null;
      const list = (Array.isArray(v) ? v : [v])
        .map((x) => String(x).trim().toLowerCase())
        .filter(Boolean)
        .filter((x) => !allowed || allowed.includes(x))
        .slice(0, 12);
      if (list.length) out[key] = [...new Set(list)];
    } else if (spec.type === 'group-list') {
      const list = (Array.isArray(v) ? v : [v])
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 24);
      if (list.length) out[key] = [...new Set(list)];
    }
  }
  return out;
}

/**
 * Validate one instance coming from layout.json or the browser. Returns null for a type this
 * build does not have (dropped quietly — a newer layout opened by an older build must not crash).
 * `seen` dedupes ids so React keys stay stable and unique.
 */
export function normWidget(raw, seen = new Set()) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '');
  const def = WIDGET_TYPES[type];
  if (!def) return null;
  let id = String(raw.id || type).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) id = type;
  const base = id;
  let n = 2;
  while (seen.has(id)) id = `${base.slice(0, 36)}-${n++}`;
  seen.add(id);
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 40) : null;
  return {
    id,
    type,
    ...(title ? { title } : {}),
    zone: WIDGET_ZONES.includes(raw.zone) ? raw.zone : def.zone,
    size: def.sizes.includes(raw.size) ? raw.size : def.size,
    visible: raw.visible !== false,
    config: normConfig(def.config, raw.config),
  };
}

/** Widget list defaults — the Balanced composition, and the answer to "reset to defaults". */
export function defaultWidgets() {
  return [
    makeWidget('system', { size: 'md' }),
    makeWidget('services', { size: 'lg' }),
    makeWidget('weather', { size: 'md' }),
    makeWidget('news', { size: 'md' }),
    makeWidget('markets', { size: 'md' }),
    makeWidget('bookmarks', { size: 'sm' }),
    makeWidget('activity', { size: 'md' }),
  ].filter(Boolean);
}
