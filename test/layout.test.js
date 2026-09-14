// Hub composition: the widget model, the v1→v2 migration, and configuration templates.
// These tests are the contract for "the Hub is presentation, not inventory": nothing here can
// create a service, and an unknown template reference is ignored rather than invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout, normalizeLayout, describeLayoutPatch, LAYOUT_VERSION } from '../server/layout.js';
import { WIDGET_CATEGORIES, WIDGET_TYPES, widgetCatalogue, makeWidget, normWidget, normConfig } from '../server/widgets.js';
import { TEMPLATES, applyTemplate, templateList, hasTemplate } from '../server/templates.js';

/* ---------------- widget model ---------------- */

test('widget instances carry id, type, zone, size, visibility and config', () => {
  const w = makeWidget('news', { size: 'lg' });
  assert.deepEqual(Object.keys(w).sort(), ['config', 'id', 'size', 'type', 'visible', 'zone']);
  assert.equal(w.type, 'news');
  assert.equal(w.size, 'lg');
  assert.equal(w.zone, 'rail');
  assert.equal(w.visible, true);
});

test('unknown widget types are dropped, not rendered as blanks', () => {
  assert.equal(normWidget({ type: 'holodeck' }), null);
  assert.equal(makeWidget('holodeck'), null);
});

test('sizes outside a type\'s ladder fall back to its default; ids are deduped', () => {
  const seen = new Set();
  const a = normWidget({ id: 'news', type: 'news', size: 'colossal' }, seen);
  const b = normWidget({ id: 'news', type: 'news' }, seen);
  assert.equal(a.size, WIDGET_TYPES.news.size);
  assert.equal(b.id, 'news-2');
});

test('widget config is whitelisted per type — unknown keys never survive', () => {
  assert.deepEqual(normConfig(WIDGET_TYPES.services.config, { groups: ['Media', 'Media'], nonsense: 1 }), { groups: ['Media'] });
  assert.deepEqual(normConfig(WIDGET_TYPES.activity.config, { sources: ['docker', 'lol'] }), { sources: ['docker'] });
  assert.deepEqual(normConfig(WIDGET_TYPES.system.config, { evil: 'x' }), {});
});

test('the catalogue is serialisable and knows its own defaults', () => {
  const cat = widgetCatalogue();
  assert.ok(cat.length >= 8);
  for (const entry of cat) {
    assert.ok(entry.type && entry.title && entry.description);
    assert.ok(entry.sizes.includes(entry.size));
    assert.ok(['main', 'rail'].includes(entry.zone));
  }
});

/* ---------------- layout document ---------------- */

test('the default layout is balanced: system + services, then the rail', () => {
  const l = defaultLayout();
  assert.equal(l.version, LAYOUT_VERSION);
  assert.deepEqual(l.hub.widgets.filter((w) => w.zone === 'main').map((w) => w.type), ['system', 'services']);
  assert.deepEqual(l.hub.widgets.filter((w) => w.zone === 'rail').map((w) => w.type), ['weather', 'news', 'markets', 'bookmarks', 'activity']);
});

test('garbage input never throws and always yields a usable layout', () => {
  for (const input of [null, 42, 'nope', [], { hub: 'x' }, { hub: { widgets: 'x' } }]) {
    const l = normalizeLayout(input);
    assert.ok(Array.isArray(l.hub.widgets));
    assert.ok(l.hub.widgets.length > 0);
    assert.deepEqual(l.services.order, {});
  }
});

test('a v1 layout.json migrates: order, zone, size and hidden flags survive', () => {
  const v1 = {
    hub: {
      main: ['overview', 'services'],
      rail: ['weather', 'markets', 'news', 'bookmarks', 'activity'],
      hidden: ['news'],
      sizes: { overview: 'md', services: 'lg', news: 'sm' },
      setupDismissed: true,
    },
    services: { groupOrder: ['Media'], order: { Media: ['jellyfin'] } },
  };
  const l = normalizeLayout(v1);
  assert.equal(l.hub.setupDismissed, true);
  assert.deepEqual(l.hub.widgets.filter((w) => w.zone === 'main').map((w) => w.type), ['system', 'services']);
  assert.equal(l.hub.widgets.find((w) => w.type === 'services').size, 'lg');
  assert.equal(l.hub.widgets.find((w) => w.type === 'news').visible, false);
  assert.deepEqual(l.services.groupOrder, ['Media']);
  assert.deepEqual(l.services.order.Media, ['jellyfin']);
});

test('a v2 layout is taken at face value — removed widgets stay removed', () => {
  const l = normalizeLayout({ hub: { widgets: [{ id: 'services', type: 'services', zone: 'main', size: 'sm' }], spacing: 'airy' } });
  assert.deepEqual(l.hub.widgets.map((w) => w.type), ['services']);
  assert.equal(l.hub.spacing, 'airy');
});

test('hidden groups and group order are validated string lists', () => {
  const l = normalizeLayout({ services: { hiddenGroups: ['Media', '', 7, null], groupOrder: [] } });
  assert.deepEqual(l.services.hiddenGroups, ['Media', '7']);
  assert.equal(l.services.groupOrder, null);
});

test('layout change summaries describe what actually changed', () => {
  assert.match(describeLayoutPatch({ hub: { widgets: [] } }), /widgets/);
  assert.match(describeLayoutPatch({ services: { hiddenGroups: [] } }), /group visibility/);
  assert.equal(describeLayoutPatch({}), 'layout updated');
});

/* ---------------- templates ---------------- */

test('every widget type belongs to exactly one category the client can label', () => {
  const ids = WIDGET_CATEGORIES.map((c) => c.id);
  assert.deepEqual(ids, ['system', 'grid', 'information', 'personal'], 'the four categories, in order');
  for (const c of WIDGET_CATEGORIES) {
    assert.ok(c.label && c.description, `${c.id} is labelled`);
  }
  for (const entry of widgetCatalogue()) {
    assert.ok(ids.includes(entry.category), `${entry.type} → ${entry.category}`);
  }
  // the picker groups by category: every category with a type must be reachable
  const used = new Set(widgetCatalogue().map((e) => e.category));
  assert.equal(used.size, 4, 'no category is left empty');
});

test('every template is presentational: widget ids reference the catalogue only', () => {
  for (const t of TEMPLATES) {
    assert.ok(t.id && t.name && t.tagline && t.description, `${t.id} is described`);
    assert.ok(t.widgets.length > 0, `${t.id} has widgets`);
    for (const w of t.widgets) assert.ok(WIDGET_TYPES[w.type], `${t.id}/${w.type} exists in the catalogue`);
  }
});

test('applying a template rearranges layout and preserves the user\'s fine-tuning', () => {
  const current = normalizeLayout({
    hub: { widgets: [{ id: 'services', type: 'services', zone: 'main', size: 'lg' }], setupDismissed: true },
    services: { order: { Media: ['jellyfin', 'seerr'] }, hiddenGroups: ['Rails'] },
  });
  const next = applyTemplate('minimal', current, { groupNames: ['Media'] });
  assert.deepEqual(next.hub.widgets.map((w) => w.type), ['clock', 'services', 'system', 'activity']);
  assert.equal(next.hub.setupDismissed, true, 'first-run dismissal survives a template');
  assert.deepEqual(next.services.order.Media, ['jellyfin', 'seerr'], 'service order survives');
  assert.deepEqual(next.services.hiddenGroups, ['Rails'], 'hidden groups survive');
});

test('a template group preference only touches groups that exist — nothing is invented', () => {
  const current = normalizeLayout(null);
  const withMedia = applyTemplate('media', current, { groupNames: ['Media', 'Rails', 'Other'] });
  assert.deepEqual(withMedia.services.groupOrder, ['Media', 'Rails', 'Other']);

  const noMedia = applyTemplate('media', current, { groupNames: ['Rails', 'Other'] });
  assert.equal(noMedia.services.groupOrder, null, 'unmatched preferences are ignored, not faked');
  assert.ok(noMedia.hub.widgets.some((w) => w.type === 'services'), 'the launcher is still there');
});

test('applying an unknown template changes nothing', () => {
  assert.equal(applyTemplate('nope', defaultLayout()), null);
  assert.equal(hasTemplate('nope'), false);
});

test('template previews are the real merged layouts the client renders', () => {
  const layout = normalizeLayout({ hub: { widgets: [{ id: 'services', type: 'services', zone: 'main', size: 'lg' }] } });
  const list = templateList({ layout, groupNames: ['Media'] });
  assert.equal(list.length, TEMPLATES.length);
  for (const t of list) {
    assert.ok(Array.isArray(t.preview.hub.widgets) && t.preview.hub.widgets.length, `${t.id} has a preview`);
    assert.ok(t.widgets.every((w) => w.title), 'widgets are labelled for the UI');
  }
  const media = list.find((t) => t.id === 'media');
  assert.deepEqual(media.unmatchedGroups.filter((g) => g !== 'Media'), ['Music', 'Streaming', 'Downloads', 'Requests', 'Photos']);
});
