// layout.json — the persisted composition of the Hub, and the service ordering the drag/drop
// surfaces write. One shape, validated here so nothing downstream has to be defensive:
//
//   { version, hub: { widgets: [instance], spacing, setupDismissed },
//     services: { groupOrder, order, hiddenGroups } }
//
// The previous shape (hub.main / hub.rail / hub.hidden / hub.sizes) is still *read* — it is
// migrated on first load and written back in the new shape — so an existing installation keeps its
// arrangement and nobody has to hand-edit JSON. See server/widgets.js for the widget model.
import { defaultWidgets, makeWidget, normWidget, HUB_SPACING, WIDGET_TYPES } from './widgets.js';

export const LAYOUT_VERSION = 2;

/** v1 ids → v2 widget types. `overview` was the system strip; everything else kept its name. */
const LEGACY_TYPES = { overview: 'system', services: 'services', weather: 'weather', news: 'news', markets: 'markets', bookmarks: 'bookmarks', activity: 'activity', clock: 'clock', stacks: 'stacks', attention: 'attention' };

export function defaultLayout() {
  return {
    version: LAYOUT_VERSION,
    hub: {
      widgets: defaultWidgets(),
      spacing: 'comfortable',
      setupDismissed: false,
    },
    services: { groupOrder: null, order: {}, hiddenGroups: [] },
  };
}

/** v1 stored shape → the equivalent v2 widget list, keeping zone, order and hidden widgets. */
function migrateLegacyHub(hub) {
  const hidden = Array.isArray(hub?.hidden) ? hub.hidden.map(String) : [];
  const sizes = hub?.sizes && typeof hub.sizes === 'object' ? hub.sizes : {};
  const zones = [
    ['main', Array.isArray(hub?.main) ? hub.main : []],
    ['rail', Array.isArray(hub?.rail) ? hub.rail : []],
  ];
  const out = [];
  const seen = new Set();
  for (const [zone, ids] of zones) {
    for (const legacyId of ids) {
      const type = LEGACY_TYPES[legacyId] || (WIDGET_TYPES[legacyId] ? legacyId : null);
      if (!type) continue;
      const w = makeWidget(type, { id: legacyId, zone, size: sizes[legacyId] });
      if (w) { out.push({ ...w, visible: !hidden.includes(legacyId) }); seen.add(w.id); }
    }
  }
  // widgets the old layout had never heard of were appended by the Hub; do the same once here
  for (const w of defaultWidgets()) {
    if (!seen.has(w.id) && !out.some((x) => x.type === w.type)) out.push(w);
  }
  return out;
}

const strList = (v, cap = 200) => (Array.isArray(v)
  ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x).trim()).filter(Boolean).slice(0, cap)
  : null);

/**
 * The one validator. Never throws: a corrupt or partial file yields a usable Hub.
 * `raw === null` → factory defaults.
 */
export function normalizeLayout(raw) {
  const base = defaultLayout();
  if (!raw || typeof raw !== 'object') return base;

  const hub = raw.hub && typeof raw.hub === 'object' ? raw.hub : {};
  const seen = new Set();
  let widgets;
  if (Array.isArray(hub.widgets)) {
    widgets = hub.widgets.map((w) => normWidget(w, seen)).filter(Boolean);
  } else if (hub.main || hub.rail || hub.hidden || hub.sizes) {
    widgets = migrateLegacyHub(hub).map((w) => normWidget(w, seen)).filter(Boolean);
  } else {
    widgets = base.hub.widgets.map((w) => normWidget(w, seen)).filter(Boolean);
  }

  const services = raw.services && typeof raw.services === 'object' ? raw.services : {};
  const order = {};
  if (services.order && typeof services.order === 'object') {
    for (const [group, names] of Object.entries(services.order)) {
      const list = strList(names, 500);
      if (list && list.length) order[String(group)] = list;
    }
  }
  const groupOrder = strList(services.groupOrder, 100);

  return {
    version: LAYOUT_VERSION,
    hub: {
      widgets,
      spacing: HUB_SPACING.includes(hub.spacing) ? hub.spacing : base.hub.spacing,
      setupDismissed: hub.setupDismissed === true,
    },
    services: {
      groupOrder: groupOrder && groupOrder.length ? groupOrder : null,
      order,
      hiddenGroups: strList(services.hiddenGroups, 60) || [],
    },
  };
}

/** Widget instances in render order for one zone. */
export const widgetsInZone = (layout, zone) => (layout?.hub?.widgets || []).filter((w) => w.zone === zone);

/** The settings-facing summary used by the layout change event. */
export function describeLayoutPatch(patch) {
  const what = [];
  if (patch?.hub?.widgets) what.push('widgets');
  if (patch?.hub?.spacing) what.push('spacing');
  if (patch?.hub?.setupDismissed !== undefined) what.push('first-run banner');
  if (patch?.services?.order) what.push('service order');
  if (patch?.services?.groupOrder) what.push('group order');
  if (patch?.services?.hiddenGroups) what.push('group visibility');
  return what.length ? `layout updated: ${what.join(', ')}` : 'layout updated';
}
