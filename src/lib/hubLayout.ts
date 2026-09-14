// Hub composition helpers — the client side of the widget model (server/widgets.js is the
// validator; this is what the UI manipulates). Pure functions only, so the Hub, the Settings →
// Widgets editor and the live preview all move widgets the same way.
import type { HubSpacing, LayoutDoc, WidgetCatalogueEntry, WidgetInstance, WidgetSize, WidgetZone } from './types';

export const ZONES: WidgetZone[] = ['main', 'rail'];
export const ZONE_LABEL: Record<WidgetZone, string> = { main: 'Main column', rail: 'Sidebar' };
export const SIZE_ORDER: WidgetSize[] = ['sm', 'md', 'lg'];
export const SIZE_LABEL: Record<WidgetSize, string> = { sm: 'Small', md: 'Medium', lg: 'Large' };
export const SPACING_LABEL: Record<HubSpacing, string> = { cozy: 'Cozy', comfortable: 'Comfortable', airy: 'Airy' };

/** The widgets a zone renders, in order. Hidden ones are kept (so nothing is lost) but not shown. */
export function visibleInZone(layout: LayoutDoc | null, zone: WidgetZone): WidgetInstance[] {
  return (layout?.hub.widgets || []).filter((w) => w.zone === zone && w.visible !== false);
}

export function hiddenWidgets(layout: LayoutDoc | null): WidgetInstance[] {
  return (layout?.hub.widgets || []).filter((w) => w.visible === false);
}

export function widgetsOfType(layout: LayoutDoc | null, ...types: string[]): WidgetInstance[] {
  return (layout?.hub.widgets || []).filter((w) => types.includes(w.type));
}

/** The widget types present and visible — what the Hub needs data for (and nothing more). */
export function neededData(layout: LayoutDoc | null): Set<string> {
  return new Set((layout?.hub.widgets || []).filter((w) => w.visible !== false).map((w) => w.type));
}

export const findWidget = (layout: LayoutDoc | null, id: string) => (layout?.hub.widgets || []).find((w) => w.id === id) || null;

const clone = (layout: LayoutDoc): LayoutDoc => structuredClone(layout);

function replaceWidgets(layout: LayoutDoc, widgets: WidgetInstance[]): LayoutDoc {
  const next = clone(layout);
  next.hub.widgets = widgets;
  return next;
}

/** Reorder the visible widgets of one zone. Hidden widgets stay in their slots, as before. */
export function reorderZone(layout: LayoutDoc, zone: WidgetZone, orderedVisibleIds: string[]): LayoutDoc {
  const widgets = layout.hub.widgets;
  const queue = [...orderedVisibleIds];
  const out: WidgetInstance[] = [];
  for (const w of widgets) {
    if (w.zone !== zone || w.visible === false) { out.push(w); continue; }
    const next = queue.shift();
    out.push(next ? (widgets.find((x) => x.id === next) || w) : w);
  }
  // any ids that did not fit (state changed mid-drag) are appended at the end of their zone
  for (const id of queue) {
    const w = widgets.find((x) => x.id === id);
    if (w) out.push(w);
  }
  return replaceWidgets(layout, out);
}

export function setWidget(layout: LayoutDoc, id: string, patch: Partial<WidgetInstance>): LayoutDoc {
  return replaceWidgets(layout, layout.hub.widgets.map((w) => (w.id === id ? { ...w, ...patch, id: w.id, type: w.type } : w)));
}

/** Move a widget to another zone, keeping its relative position inside that zone. */
export function moveWidget(layout: LayoutDoc, id: string, zone: WidgetZone): LayoutDoc {
  const w = findWidget(layout, id);
  if (!w || w.zone === zone) return layout;
  const others = layout.hub.widgets.filter((x) => x.id !== id);
  const lastOfZone = [...others].reverse().find((x) => x.zone === zone);
  const moved: WidgetInstance = { ...w, zone };
  if (!lastOfZone) return replaceWidgets(layout, [...others, moved]);
  const at = others.indexOf(lastOfZone) + 1;
  const next = [...others.slice(0, at), moved, ...others.slice(at)];
  return replaceWidgets(layout, next);
}

export function removeWidget(layout: LayoutDoc, id: string): LayoutDoc {
  return replaceWidgets(layout, layout.hub.widgets.filter((w) => w.id !== id));
}

export function addWidget(layout: LayoutDoc, entry: WidgetCatalogueEntry, zone?: WidgetZone): LayoutDoc {
  const used = new Set(layout.hub.widgets.map((w) => w.id));
  let id = entry.type;
  let n = 2;
  while (used.has(id)) id = `${entry.type}-${n++}`;
  const instance: WidgetInstance = {
    id,
    type: entry.type,
    zone: zone || entry.zone,
    size: entry.size,
    visible: true,
    config: {},
  };
  const cloneLayout = clone(layout);
  cloneLayout.hub.widgets = [...cloneLayout.hub.widgets, instance];
  return cloneLayout;
}

export function setSpacing(layout: LayoutDoc, spacing: HubSpacing): LayoutDoc {
  const next = clone(layout);
  next.hub.spacing = spacing;
  return next;
}

/** A one-line description of a widget instance, for lists and menus — never a badge. */
export function widgetLabel(w: WidgetInstance, catalogue: WidgetCatalogueEntry[]): string {
  const entry = catalogue.find((c) => c.type === w.type);
  return w.title || entry?.title || w.type;
}

export function widgetDescription(w: WidgetInstance, catalogue: WidgetCatalogueEntry[]): string {
  return catalogue.find((c) => c.type === w.type)?.description || '';
}

/** Config keys that have a value — used to say "configured" without inventing a status pill. */
export function configSummary(w: WidgetInstance): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(w.config || {})) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    parts.push(`${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
  }
  return parts.join(' · ');
}
