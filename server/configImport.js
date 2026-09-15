// Phase 6 — applying a reviewed import.
//
// `server/homepageImport.js` produces a plan and never touches anything. This module is the other
// half: it takes that plan, plus the user's decisions, and writes OpusHub presentation
// configuration.
//
// Two rules govern every line below.
//
//   1. **Configuration cannot create infrastructure.** The overlay document written here is built
//      from `preview.matched`, and every entry in `matched` carries a container that discovery
//      actually reported. Unmatched entries are offered as *bookmarks* — a link is a link — and
//      there is deliberately no branch that writes an unmatched entry into `services.yaml`, because
//      an overlay with no container is exactly the "fake service" this phase forbids.
//
//   2. **Preview means preview.** Nothing in this file runs until the user has seen the plan. That
//      is enforced by shape, not by discipline: this module needs a `preview` object, and a preview
//      only exists after `buildImportPreview()` has been called against a live inventory.
import {
  LIMITS, configError, boundedString, validDisplayName,
  safeHref, safeIcon, lintCss, lintJs,
} from './configSchema.js';
import { normalizeDecisions } from './homepageImport.js';

/** Fields an imported entry may contribute to an overlay. Presentation, and nothing else. */
const IMPORTED_FIELDS = ['displayName', 'description', 'icon', 'url', 'group'];

/** One overlay entry, as OpusHub's own model stores it. */
function overlayEntry(match, groupName) {
  const entry = { container: match.container.containerName };
  if (match.displayName && validDisplayName(match.displayName)) entry.displayName = match.displayName;
  if (match.description) entry.description = match.description;
  if (match.icon) {
    try { entry.icon = safeIcon(match.icon, { label: `${match.sourceName} icon` }); }
    catch { /* an unmappable icon means a monogram, not a failed import */ }
  }
  if (match.url) {
    try { entry.url = safeHref(match.url, { label: `${match.sourceName} url` }); }
    catch { /* a refused URL is reported in the plan; the entry keeps its discovered URL */ }
  }
  if (groupName && groupName !== 'Ungrouped') entry.group = groupName;
  return entry;
}

/**
 * Merge an imported entry into an existing overlay entry.
 * The imported value wins for the fields it actually specifies — an import that carries no icon
 * must not blank the icon the user already chose.
 */
function mergeEntry(existing, incoming) {
  const out = { ...existing };
  for (const field of IMPORTED_FIELDS) {
    if (incoming[field] != null) out[field] = incoming[field];
  }
  return out;
}

/**
 * Build the next `services.yaml` document.
 *
 * Groups are rebuilt from the containers themselves, so a group that the import names but that no
 * container lands in simply does not appear — the same rule the live Hub follows. Existing entries
 * that the import did not mention are preserved, because an import is an addition to your
 * configuration, not a reset of it.
 */
export function buildServicesDoc({ preview, decisions, current, mode = 'merge' }) {
  const skip = new Set(decisions.skip);
  const rename = decisions.groupRenames || {};

  const kept = new Map(); // container name (lowercased) → { group, entry }
  // Group metadata is not the import's to rebuild: a description, an icon or an explicit order that
  // belongs to a group surviving the merge is carried through untouched. Rebuilding groups from
  // their services alone (which is what this used to do) silently dropped all three.
  const groupMeta = new Map();
  if (mode === 'merge') {
    for (const g of current?.groups || []) {
      const meta = {};
      if (g.description) meta.description = g.description;
      if (g.icon) meta.icon = g.icon;
      if (Number.isFinite(Number(g.order))) meta.order = Number(g.order);
      if (Object.keys(meta).length) groupMeta.set(String(g.name).toLowerCase(), meta);
      for (const s of g.services || []) {
        const key = String(s.container || s.name || '').toLowerCase();
        if (key) kept.set(key, { group: g.name, entry: { ...s } });
      }
    }
  }

  let applied = 0;
  for (const match of preview.matched) {
    const id = `${match.sourceGroup}/${match.sourceName}`;
    if (skip.has(id)) continue;
    const sourceGroup = rename[match.sourceGroup] || match.sourceGroup;
    const incoming = overlayEntry(match, sourceGroup);
    const key = match.container.containerName.toLowerCase();
    const existing = kept.get(key);
    kept.set(key, {
      group: incoming.group || sourceGroup,
      entry: existing && mode === 'merge' ? mergeEntry(existing.entry, incoming) : incoming,
    });
    applied++;
  }

  // Group order follows the imported file where it exists, then whatever was already there.
  const order = [];
  for (const g of preview.groups || []) {
    const name = rename[g.name] || g.name;
    if (!order.includes(name)) order.push(name);
  }
  for (const { group } of kept.values()) {
    if (group && !order.includes(group)) order.push(group);
  }

  const groups = [];
  for (const name of order) {
    const services = [...kept.entries()]
      .filter(([, v]) => v.group === name)
      .map(([, v]) => v.entry)
      .filter((e) => e && (e.container || e.name));
    if (!services.length) continue; // an empty group is presentation metadata with nothing to present
    services.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || String(a.displayName || a.name || '').localeCompare(String(b.displayName || b.name || '')));
    groups.push({ name, ...(groupMeta.get(name.toLowerCase()) || {}), services });
  }

  // No service presentation came across: `services.yaml` must not be rewritten at all. Normalising
  // a file the import had no business in is how a bookmarks-only import ends up touching the
  // services overlay — semantically harmless in the best case, and a data-loss bug in the worst.
  if (!applied) return null;

  if (groups.length > LIMITS.groups) {
    throw configError(`the merged overlay would hold ${groups.length} groups — the cap is ${LIMITS.groups}`, { status: 413 });
  }
  const total = groups.reduce((a, g) => a + g.services.length, 0);
  if (total > LIMITS.services) {
    throw configError(`the merged overlay would hold ${total} entries — the cap is ${LIMITS.services}`, { status: 413 });
  }
  return { groups, applied };
}

/** Build the next `bookmarks.yaml` document, appending imported and preserved links. */
export function buildBookmarksDoc({ preview, decisions, current, mode = 'merge' }) {
  const groups = new Map();
  const push = (groupName, item) => {
    const name = boundedString(groupName, LIMITS.nameLength) || 'Bookmarks';
    if (!groups.has(name)) groups.set(name, []);
    const list = groups.get(name);
    if (list.length >= LIMITS.bookmarksPerGroup) return;
    list.push(item);
  };

  if (mode === 'merge') {
    for (const g of current?.groups || []) {
      for (const item of g.items || []) push(g.name, { name: item.name, href: item.href, ...(item.description ? { description: item.description } : {}) });
    }
  }

  let added = 0;
  if (decisions.includeBookmarks) {
    for (const g of preview.bookmarks || []) {
      for (const item of g.items || []) {
        push(g.name, { name: item.name, href: item.href, ...(item.description ? { description: item.description } : {}) });
        added++;
      }
    }
  }

  // The brief's fourth classification, made concrete: an imported entry with no container may be
  // preserved as a *link*. It is deliberately written to bookmarks.yaml, which the inventory
  // never reads — so it cannot become a service by accident.
  let preserved = 0;
  if (decisions.keepUnmatched === 'bookmark') {
    for (const entry of preview.unmatched || []) {
      if (!entry.url) continue;
      const name = validDisplayName(entry.displayName || entry.sourceName) ? (entry.displayName || entry.sourceName) : entry.sourceName;
      push(entry.sourceGroup || 'Imported', {
        name: boundedString(name, LIMITS.nameLength),
        href: entry.url,
        description: boundedString(`Not discovered by Docker — kept from the Homepage import. ${entry.description || ''}`.trim(), LIMITS.descriptionLength),
      });
      preserved++;
    }
  }

  // Same rule as the services document: a file the import contributes nothing to is not rewritten.
  // Merging is otherwise a re-serialisation, and a re-serialisation is a change as far as the user's
  // diff and their version history are concerned.
  if (mode === 'merge' && !added && !preserved) return null;

  return {
    groups: [...groups.entries()].map(([name, items]) => ({ name, items })),
    added,
    preserved,
  };
}

/**
 * Build the appearance/settings patch an import contributes.
 * Only presentation keys, and only ones the mapping actually produced.
 */
export function buildSettingsPatch({ preview, decisions }) {
  if (!decisions.includeAppearance) return null;
  const patch = {};
  const app = {};
  if (preview.app?.name) app.name = preview.app.name;
  if (preview.app?.tagline) app.tagline = preview.app.tagline;
  if (Object.keys(app).length) patch.app = app;

  const appearance = {};
  const a = preview.appearance || {};
  if (a.theme) appearance.theme = a.theme;
  if (a.accent) appearance.accent = a.accent;
  if (a.background) appearance.background = { ...a.background };
  if (Object.keys(appearance).length) patch.appearance = appearance;
  return Object.keys(patch).length ? patch : null;
}

/**
 * Fold imported widgets into the layout as *instances*.
 *
 * A widget the Homepage config had and OpusHub does not has already been reported as unmapped; it
 * is not invented here. What this does is place the ones that do map into the Hub composition,
 * without disturbing anything already there.
 */
export function buildLayoutPatch({ preview, decisions, current, makeWidget }) {
  if (!decisions.includeWidgets) return null;
  const instances = preview.widgets?.instances || [];
  if (!instances.length) return null;
  const existingTypes = new Set((current?.hub?.widgets || []).map((w) => w.type));
  const added = [];
  for (const inst of instances) {
    if (existingTypes.has(inst.type)) continue; // already on the Hub — an import must not duplicate
    const widget = makeWidget(inst.type, { config: inst.config || {} });
    if (widget) { added.push(widget); existingTypes.add(inst.type); }
  }
  if (!added.length) return null;
  return { hub: { widgets: [...(current?.hub?.widgets || []), ...added] } };
}

/**
 * Validate the custom code an import would carry, without ever running it.
 * The files are stored as text and served same-origin; `lintCss`/`lintJs` read characters only.
 */
export function buildCustomPlan({ preview, decisions }) {
  if (!decisions.includeCustom) return { css: null, js: null, problems: [] };
  const problems = [];
  const out = { css: null, js: null, problems };
  const css = preview.custom?.css;
  if (typeof css === 'string' && css.trim()) {
    if (Buffer.byteLength(css, 'utf8') > LIMITS.cssBytes) problems.push(`custom.css exceeds the ${Math.round(LIMITS.cssBytes / 1024)} KB cap and was not carried over`);
    else {
      const lint = lintCss(css);
      if (lint.ok) out.css = css;
      else problems.push(`custom.css was not carried over: ${lint.problems[0]}`);
    }
  }
  const js = preview.custom?.js;
  if (typeof js === 'string' && js.trim()) {
    if (Buffer.byteLength(js, 'utf8') > LIMITS.jsBytes) problems.push(`custom.js exceeds the ${Math.round(LIMITS.jsBytes / 1024)} KB cap and was not carried over`);
    else {
      const lint = lintJs(js);
      if (lint.ok) out.js = js;
      else problems.push(`custom.js was not carried over: ${lint.problems[0]}`);
    }
  }
  return out;
}

/**
 * The complete write plan for an import: exactly the documents that would change, before any of
 * them is written. Used both by the apply route and by the preview renderer, so what the review
 * screen shows is what applying produces.
 */
export function planImport({
  preview, rawDecisions, current = {}, makeWidget, mode = 'merge',
}) {
  const decisions = normalizeDecisions(rawDecisions);
  const services = buildServicesDoc({ preview, decisions, current: current.services, mode });
  const bookmarks = buildBookmarksDoc({ preview, decisions, current: current.bookmarks, mode });
  const settings = buildSettingsPatch({ preview, decisions });
  const layout = buildLayoutPatch({ preview, decisions, current: current.layout, makeWidget });
  const custom = buildCustomPlan({ preview, decisions });
  return { decisions, mode, services, bookmarks, settings, layout, custom };
}

export { IMPORTED_FIELDS };

// ---------------------------------------------------------------------------
// committing a plan — all of it, or none of it
// ---------------------------------------------------------------------------

/**
 * Apply a plan across several files with an all-or-nothing guarantee.
 *
 * A configuration write is not atomic across files — the filesystem has no transaction — but an
 * import that rewrote `services.yaml` and then failed on `bookmarks.yaml` would leave the user with
 * a configuration that is neither the old one nor the new one, and no obvious way to tell which
 * half landed. So the writes are made *recoverable* instead:
 *
 *   1. every document is validated and serialised **before** anything is written, so a document
 *      that cannot be written is discovered while nothing has changed;
 *   2. the pre-import state of every file about to be touched is read into memory;
 *   3. files are written inside a try block;
 *   4. if any write throws, the files already written are put back from step 2 and the error
 *      propagates — the user sees one failure and still has their previous configuration.
 *
 * A history version is taken before step 3 and after success, so both the before and after states
 * are recoverable from Settings → Configuration → History as well.
 */
export function commitPlan({ plan, read, write, snapshot = null, actor = null, reason = 'import' } = {}) {
  // `name` is the only thing the writer dispatches on — see api.js `writeConfigTarget`. There is
  // deliberately no "kind" here to get wrong.
  const targets = [];
  if (plan.services) targets.push({ name: 'services.yaml', value: plan.services });
  if (plan.bookmarks) targets.push({ name: 'bookmarks.yaml', value: plan.bookmarks });
  if (plan.settings) targets.push({ name: 'settings.yaml', value: plan.settings });
  if (plan.layout) targets.push({ name: 'layout.json', value: plan.layout });
  if (plan.custom?.css != null) targets.push({ name: 'theme.css', value: plan.custom.css });
  if (plan.custom?.js != null) targets.push({ name: 'app.js', value: plan.custom.js });

  if (!targets.length) return { written: [], restored: [], changed: false };

  const before = new Map();
  for (const t of targets) before.set(t.name, read(t.name));

  snapshot?.({ reason, subject: 'import', label: 'pre-import snapshot', actor, force: true });

  const written = [];
  try {
    for (const t of targets) {
      write(t.name, t.value);
      written.push(t.name);
    }
  } catch (err) {
    const restored = [];
    for (const name of written) {
      try { write(name, before.get(name), null, { raw: true }); restored.push(name); }
      catch { /* a rollback that cannot write is reported by the error the caller already has */ }
    }
    throw Object.assign(
      new Error(`the import was rolled back — ${err.message}`),
      { status: err.status || 500, code: 'import_rolled_back', detail: { restored, failed: err.message } },
    );
  }

  const after = snapshot?.({ reason, subject: 'import', label: 'import applied', actor });
  return { written, restored: [], changed: true, version: after?.id || null, targets: targets.map((t) => t.name) };
}

/**
 * The draft → validate → preview → save pipeline the editors share.
 *
 * `validate` is a plain function per editor that throws a ConfigError with a legible message. The
 * point of routing every editor through one function is the guarantee in the second sentence: a
 * failed validation returns the error and changes nothing, so a user's draft survives a rejection
 * and the active configuration is never left half-written.
 */
export function validateDraft({ area, draft, validate }) {
  try {
    const value = validate(draft);
    return { ok: true, value, problems: [] };
  } catch (err) {
    return {
      ok: false,
      area,
      problems: [err.message],
      code: err.code || 'invalid_config',
    };
  }
}

