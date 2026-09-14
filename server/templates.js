// Hub configuration templates — layout presets, and nothing else.
//
// A template describes an arrangement: which widgets are visible, where they sit, how big they
// are, how much air the page gets, and (optionally) which *group names* it would like to see
// first. It cannot install, create, rename or reference infrastructure: group preferences are
// matched against the groups discovery actually produced, and unmatched preferences are ignored.
// If a group named "Media" does not exist today, nothing happens; if a container appears in it
// tomorrow, the ordering already anticipates it.
import { WIDGET_TYPES, WIDGET_ZONES, HUB_SPACING, makeWidget } from './widgets.js';

/** Compact authoring helper: widget(type, size, [zone]) with catalogue defaults. */
const w = (type, size, zone) => ({ type, size, zone });

export const TEMPLATES = [
  {
    id: 'minimal',
    name: 'Minimal',
    tagline: 'Time, services, and nothing else',
    description: 'A quiet home screen: the clock, your launcher, a one-line system strip and recent activity. Everything else hides without being deleted — switch it back on in Widgets.',
    spacing: 'airy',
    widgets: [
      w('clock', 'sm', 'main'), w('services', 'lg', 'main'), w('system', 'sm', 'main'),
      w('activity', 'sm', 'rail'),
    ],
    groupPriority: [],
  },
  {
    id: 'balanced',
    name: 'Balanced',
    tagline: 'The full home, calmly arranged',
    description: 'System summary and the launcher on the left; weather, markets, news, bookmarks and activity in the rail. This is the default composition.',
    spacing: 'comfortable',
    widgets: [
      w('system', 'md', 'main'), w('services', 'lg', 'main'),
      w('weather', 'md', 'rail'), w('news', 'md', 'rail'), w('markets', 'md', 'rail'),
      w('bookmarks', 'sm', 'rail'), w('activity', 'md', 'rail'),
    ],
    groupPriority: [],
  },
  {
    id: 'media',
    name: 'Media',
    tagline: 'Streaming first',
    description: 'Puts Media, Music and download groups at the top of the launcher, with stacks and activity alongside. You need those containers for the ordering to mean anything — nothing is created for you.',
    spacing: 'comfortable',
    widgets: [
      w('services', 'lg', 'main'), w('stacks', 'md', 'main'), w('system', 'sm', 'main'),
      w('news', 'sm', 'rail'), w('activity', 'md', 'rail'),
    ],
    groupPriority: ['Media', 'Music', 'Streaming', 'Downloads', 'Requests', 'Photos'],
  },
  {
    id: 'information',
    name: 'Information',
    tagline: 'Daylight, headlines, numbers',
    description: 'Weather, news and markets become the main column; services and system drop to the rail as a reference. For the days you open OpusHub for the world, not the containers.',
    spacing: 'comfortable',
    widgets: [
      w('weather', 'md', 'main'), w('news', 'md', 'main'), w('markets', 'md', 'main'),
      w('clock', 'sm', 'main'),
      w('services', 'md', 'rail'), w('system', 'sm', 'rail'), w('activity', 'sm', 'rail'),
    ],
    groupPriority: [],
  },
  {
    id: 'classic',
    name: 'Classic homepage',
    tagline: 'Grid of everything you run, bookmarks included',
    description: 'A wide launcher with bookmarks and the system strip underneath; the rail keeps weather, markets and news. Closest to a classic self-hosted dashboard.',
    spacing: 'cozy',
    widgets: [
      w('services', 'lg', 'main'), w('bookmarks', 'md', 'main'), w('system', 'sm', 'main'),
      w('weather', 'md', 'rail'), w('markets', 'md', 'rail'), w('news', 'md', 'rail'),
    ],
    groupPriority: [],
  },
  {
    id: 'operations',
    name: 'Operations',
    tagline: 'What is down, what changed',
    description: 'Leads with the system strip, anything needing attention and the stack list; the launcher sits below. For the days you are actually maintaining the machine.',
    spacing: 'cozy',
    widgets: [
      w('system', 'md', 'main'), w('attention', 'sm', 'main'), w('stacks', 'md', 'main'),
      w('services', 'md', 'main'),
      w('activity', 'md', 'rail'), w('clock', 'sm', 'rail'),
    ],
    groupPriority: [],
  },
];

const byId = (id) => TEMPLATES.find((t) => t.id === id) || null;

/** Template widget list → validated instances (ids unique inside the set). */
function templateWidgets(template) {
  const seen = new Set();
  return (template.widgets || [])
    .map((entry) => makeWidget(entry.type, { zone: WIDGET_ZONES.includes(entry.zone) ? entry.zone : undefined, size: entry.size, config: entry.config }))
    .filter(Boolean)
    .map((inst) => {
      let id = inst.id; let n = 2;
      while (seen.has(id)) id = `${inst.type.slice(0, 34)}-${n++}`;
      seen.add(id);
      return { ...inst, id };
    });
}

/**
 * Groups the template would like first, resolved against groups that exist right now.
 * Case-insensitive, never invented; unmatched preferences simply disappear.
 */
function resolveGroupOrder(template, groupNames) {
  if (!template.groupPriority?.length || !groupNames?.length) return null;
  const canonical = new Map(groupNames.map((n) => [String(n).toLowerCase(), String(n)]));
  const matched = template.groupPriority.map((name) => canonical.get(String(name).toLowerCase())).filter(Boolean);
  if (!matched.length) return null;
  const rest = groupNames.filter((n) => !matched.includes(n));
  return [...matched, ...rest];
}

/**
 * Apply a template to a layout. Pure: returns a new layout.
 *  · the widget arrangement, sizes and visibility come from the template
 *  · a group preference is applied only to groups that exist; otherwise the current order stands
 *  · service order inside a group, hidden groups and the first-run dismissal are always preserved
 *    (they are the user's own fine-tuning, not the template's business)
 */
export function applyTemplate(templateOrId, current, { groupNames = [] } = {}) {
  const template = typeof templateOrId === 'string' ? byId(templateOrId) : templateOrId;
  if (!template) return null;
  const widgets = templateWidgets(template);
  if (!widgets.length) return null;
  const resolved = resolveGroupOrder(template, groupNames);
  return {
    version: 2,
    hub: {
      widgets,
      spacing: HUB_SPACING.includes(template.spacing) ? template.spacing : (current?.hub?.spacing || 'comfortable'),
      setupDismissed: current?.hub?.setupDismissed === true,
    },
    services: {
      groupOrder: resolved || (current?.services?.groupOrder ?? null),
      order: current?.services?.order || {},
      hiddenGroups: current?.services?.hiddenGroups || [],
    },
  };
}

/** What Settings → Templates lists. `preview` is the real merged result, computed server-side so
 *  the client never reimplements the merge. */
export function templateList({ layout, groupNames = [] } = {}) {
  return TEMPLATES.map((t) => {
    const preview = applyTemplate(t, layout, { groupNames });
    return {
      id: t.id,
      name: t.name,
      tagline: t.tagline,
      description: t.description,
      spacing: t.spacing,
      widgets: (preview?.hub?.widgets || []).map((x) => ({
        id: x.id, type: x.type, zone: x.zone, size: x.size,
        title: WIDGET_TYPES[x.type]?.title || x.type,
      })),
      groupPriority: t.groupPriority || [],
      /** preferences that currently match nothing — shown so the template never lies about what it did */
      unmatchedGroups: (t.groupPriority || []).filter((n) => !groupNames.some((g) => String(g).toLowerCase() === String(n).toLowerCase())),
      preview,
    };
  });
}

export const templateIds = () => TEMPLATES.map((t) => t.id);
export const hasTemplate = (id) => !!byId(id);
