// Phase 6 — configuration export.
//
// Two formats, one rule: what leaves the server must be safe to move between installations.
//
//   native      OpusHub's own presentation model, so a configuration can be carried to a new box
//               and re-imported through the same review screen the Homepage importer uses.
//   homepage    a best-effort translation back into Homepage's shape, so leaving is as supported
//               as arriving.
//
// "Safe to move" is the operative phrase, and it is enforced rather than asserted. The exporter
// never reads `data/` at all — not the auth file, not the session store, not the activity log, not
// the metric history — and it iterates `PRESENTATION_FILES` from server/configScope.js rather than
// a directory, so those files cannot appear in a bundle even by accident.
//
// Beyond that, two classes of value get special handling because "configuration" and "secret" are
// not disjoint in practice:
//
//   · **URL-embedded credentials.** A private RSS feed is `https://example.com/feed?key=abc123`.
//     That `key` is a live secret. It is redacted by default and *reported*, so the user knows
//     exactly which feeds to re-authenticate rather than discovering it later.
//   · **Host-specific facts.** `infrastructure.hostAddress` names the old machine. Carrying it to
//     a new one produces URLs pointing at the wrong host — a subtle, confusing failure — so it is
//     left out and the omission is stated.
import YAML from 'yaml';
import { LIMITS } from './configSchema.js';
import { PRESENTATION_FILES } from './configScope.js';
import { HOMEPAGE_WIDGET_MAP } from './homepageImport.js';

const SECRET_QUERY_PARAM = /^(key|api[-_]?key|token|access[-_]?token|apikey|auth|password|passwd|secret|sig|signature|session|code|bearer)$/i;

/**
 * Strip credentials out of a URL, reporting what was removed.
 *  · `https://user:pass@host/…`   → the userinfo is always removed
 *  · `https://host/feed?key=abc`  → the credential-looking parameter is removed by default
 */
export function redactUrl(raw, { redactQuery = true } = {}) {
  const s = String(raw ?? '');
  if (!s) return { url: s, redactions: [] };
  const redactions = [];
  let out = s;
  let kinds = [];
  try {
    const u = new URL(s);
    if (u.username || u.password) {
      kinds.push('userinfo');
      u.username = '';
      u.password = '';
    }
    let removedParams = [];
    if (redactQuery) {
      for (const key of [...u.searchParams.keys()]) {
        if (SECRET_QUERY_PARAM.test(key)) { removedParams.push(key); u.searchParams.delete(key); }
      }
      if (removedParams.length) kinds.push('query');
    }
    // Only touch a URL that actually needed touching. `new URL(...).toString()` normalises
    // `https://host` to `https://host/`, and an export that silently rewrites every URL it carries
    // is indistinguishable from one that altered them — the user would have to diff two exports to
    // find out it did nothing.
    if (!kinds.length) return { url: s, redactions };
    out = u.toString();
    // The report names *where* and *what kind* — never the value. Recording the original URL here
    // would put the credential straight back into the payload that removed it, which is how a
    // "redaction" ends up being the leak.
    if (kinds.includes('userinfo')) {
      redactions.push({ kind: 'userinfo', url: out, note: 'an embedded username/password was removed' });
    }
    if (kinds.includes('query')) {
      redactions.push({ kind: 'query', url: out, note: `credential-shaped parameter(s) removed: ${removedParams.join(', ')}` });
    }
  } catch {
    // not an absolute URL (a same-origin path, say) — nothing to strip
    return { url: s, redactions };
  }
  return { url: out, redactions };
}

/** Strip credentials from every URL we can find in a settings document. */
function redactSettings(settings, redactions) {
  const out = structuredClone(settings ?? {});
  // Host-specific infrastructure is not presentation: a new machine has its own address.
  if (out.infrastructure) {
    if (out.infrastructure.hostAddress != null) {
      redactions.push({ kind: 'machine', url: String(out.infrastructure.hostAddress), note: 'infrastructure.hostAddress is per-host and was not exported — the new installation detects its own' });
    }
    if (out.infrastructure.entrypointPorts && Object.keys(out.infrastructure.entrypointPorts).length) {
      redactions.push({ kind: 'machine', url: '', note: 'infrastructure.entrypointPorts describes this Traefik deployment and was not exported' });
    }
    delete out.infrastructure;
  }
  const feeds = out?.integrations?.news?.feeds;
  if (Array.isArray(feeds)) {
    out.integrations.news.feeds = feeds
      .map((f) => {
        const r = redactUrl(f?.url);
        redactions.push(...r.redactions.map((x) => ({ ...x, where: `news feed “${f?.name || r.url}”` })));
        return { ...f, url: r.url };
      })
      .filter((f) => f?.url);
  }
  delete out._raw;
  delete out._rejected;
  return out;
}

/** Overlay entries reduced to presentation, with URLs scrubbed. */
function redactOverlay(services, redactions) {
  const groups = [];
  for (const g of services?.groups || []) {
    const out = { name: g.name };
    if (g.description) out.description = g.description;
    if (g.icon) out.icon = g.icon;
    const items = [];
    for (const s of g.services || []) {
      const entry = {};
      for (const field of ['container', 'name', 'displayName', 'app', 'description', 'icon', 'group', 'order']) {
        if (s[field] != null) entry[field] = s[field];
      }
      if (s.hidden === true) entry.hidden = true;
      if (s.showOnHub === false) entry.showOnHub = false;
      if (Array.isArray(s.keywords) && s.keywords.length) entry.keywords = s.keywords;
      if (s.url) {
        const r = redactUrl(s.url);
        redactions.push(...r.redactions.map((x) => ({ ...x, where: `service “${s.displayName || s.name}”` })));
        entry.url = r.url;
      }
      items.push(entry);
    }
    if (items.length) out.services = items;
    groups.push(out);
  }
  return { groups };
}

function redactBookmarks(bookmarks, redactions) {
  return {
    groups: (bookmarks?.groups || []).map((g) => ({
      name: g.name,
      items: (g.items || []).map((i) => {
        const r = redactUrl(i.href);
        redactions.push(...r.redactions.map((x) => ({ ...x, where: `bookmark “${i.name}”` })));
        return { name: i.name, href: r.url, ...(i.description ? { description: i.description } : {}) };
      }),
    })).filter((g) => g.items.length),
  };
}

/** Homepage's widget slug for an OpusHub widget type (the reverse of HOMEPAGE_WIDGET_MAP). */
function homepageWidgetSlug(type) {
  const entries = Object.entries(HOMEPAGE_WIDGET_MAP).filter(([, t]) => t === type);
  return entries.length ? entries[0][0] : null;
}

// ---------------------------------------------------------------------------
// native
// ---------------------------------------------------------------------------

/**
 * The full OpusHub presentation bundle, as a set of *files* — the same filenames the installer
 * reads, so an export can be dropped back into `config/` on another machine and reviewed before
 * it is applied.
 *
 * `include` lets a caller take a subset (Settings → Export offers per-area checkboxes); the default
 * is everything on the scope allowlist.
 */
export function exportNative({
  services = { groups: [] },
  stacks = { stacks: [] },
  bookmarks = { groups: [] },
  settings = {},
  layout = null,
  custom = {},
  include = null,
} = {}) {
  const redactions = [];
  const files = {};
  const want = (name) => !include || include.includes(name);

  if (want('services.yaml')) files['services.yaml'] = toYaml(redactOverlay(services, redactions));
  if (want('stacks.yaml')) files['stacks.yaml'] = toYaml({ stacks: (stacks.stacks || []).map(stripStack) });
  if (want('bookmarks.yaml')) files['bookmarks.yaml'] = toYaml(redactBookmarks(bookmarks, redactions));
  if (want('settings.yaml')) files['settings.yaml'] = toYaml(redactSettings(settings, redactions));
  if (want('layout.json') && layout) files['layout.json'] = `${JSON.stringify(layout, null, 2)}\n`;
  if (want('theme.css') && typeof custom.css === 'string' && custom.css.trim()) files['theme.css'] = custom.css;
  if (want('app.js') && typeof custom.js === 'string' && custom.js.trim()) files['app.js'] = custom.js;

  return {
    format: 'opushub',
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    kind: 'native',
    files,
    notes: [
      'Presentation configuration only. Authentication, sessions, activity history, metric history and environment secrets are not part of an OpusHub export.',
      'Service entries bind to containers by name. On a machine running different containers they are reported as unmatched rather than rendered.',
    ],
    redactions,
    machineSpecific: redactions.filter((r) => r.kind === 'machine').map((r) => r.note),
    scope: PRESENTATION_FILES.map((f) => f.name),
  };
}

function stripStack(s) {
  const out = {};
  for (const field of ['project', 'name', 'displayName', 'description', 'icon', 'notes']) {
    if (s[field] != null) out[field] = s[field];
  }
  // `services` is a legacy membership hint; membership is Docker's answer and is not exported.
  return out;
}

// ---------------------------------------------------------------------------
// Homepage-compatible
// ---------------------------------------------------------------------------

/**
 * A Homepage-shaped bundle, for leaving.
 *
 * What cannot be translated is reported rather than approximated:
 *   · an overlay entry grouping containers the Homepage file has no group for,
 *   · a `/user/icons/…` icon (Homepage would need the file copied alongside),
 *   · a widget with no Homepage sibling.
 *
 * This is deliberately lossy in one direction and honest about it. A Homepage export that silently
 * dropped half a configuration would be worse than one that says which half it dropped.
 */
export function exportHomepage({
  services = { groups: [] },
  stacks = { stacks: [] },
  bookmarks = { groups: [] },
  settings = {},
  layout = null,
  custom = {},
} = {}) {
  const notes = [];
  const redactions = [];
  const files = {};

  // ---- services.yaml: [ { Group: [ { Name: { href, description, icon } } ] } ]
  const serviceList = [];
  for (const g of services.groups || []) {
    const items = [];
    for (const s of g.services || []) {
      const body = {};
      const name = s.displayName || s.name || s.container;
      if (!name) continue;
      if (s.url) {
        const r = redactUrl(s.url);
        redactions.push(...r.redactions.map((x) => ({ ...x, where: `service “${name}”` })));
        body.href = r.url;
      }
      if (s.description) body.description = s.description;
      if (s.icon) {
        const converted = toHomepageIcon(s.icon);
        if (converted) body.icon = converted;
        else notes.push(`“${name}”: the icon ${s.icon} is a local file — copy it into Homepage's \`public/icons/\` and re-add it there`);
      }
      if (s.app) body.name = s.app;
      // `container` is a Homepage binding key, so a matched overlay round-trips correctly.
      if (s.container) body.container = s.container;
      items.push({ [name]: body });
    }
    if (items.length) serviceList.push({ [g.name]: items });
  }
  files['services.yaml'] = toYaml(serviceList);

  // ---- bookmarks.yaml: [ { Group: [ { Name: [ { href, description } ] } ] } ]
  const bookmarkList = [];
  for (const g of bookmarks.groups || []) {
    const items = [];
    for (const i of g.items || []) {
      const r = redactUrl(i.href);
      redactions.push(...r.redactions.map((x) => ({ ...x, where: `bookmark “${i.name}”` })));
      const body = { href: r.url };
      if (i.description) body.description = i.description;
      items.push({ [i.name]: [body] });
    }
    if (items.length) bookmarkList.push({ [g.name]: items });
  }
  if (bookmarkList.length) files['bookmarks.yaml'] = toYaml(bookmarkList);

  // ---- widgets.yaml: [ { widget: { … } } ]
  const widgetList = [];
  for (const w of layout?.hub?.widgets || []) {
    const slug = homepageWidgetSlug(w.type);
    if (!slug) { notes.push(`the ${w.type} block has no Homepage equivalent and was not exported`); continue; }
    widgetList.push({ [slug]: { ...(w.config || {}) } });
  }
  if (widgetList.length) files['widgets.yaml'] = toYaml(widgetList);

  // ---- settings.yaml
  const homepageSettings = {};
  if (settings.app?.name) homepageSettings.title = settings.app.name;
  const theme = settings.appearance?.theme;
  if (theme === 'dark' || theme === 'light') homepageSettings.theme = theme;
  const accent = settings.appearance?.accent;
  const HOMEPAGE_COLOR = { slate: 'slate', teal: 'teal', amber: 'amber', rose: 'rose', clay: 'stone', moss: 'emerald', sage: 'green' };
  if (accent && HOMEPAGE_COLOR[accent]) homepageSettings.color = HOMEPAGE_COLOR[accent];
  const bg = settings.appearance?.background;
  if (bg && (bg.photo || bg.blur != null || bg.scrim != null)) {
    const background = {};
    if (bg.photo) {
      const r = redactUrl(bg.photo);
      redactions.push(...r.redactions.map((x) => ({ ...x, where: 'background image' })));
      background.image = r.url;
    }
    if (bg.blur != null) background.blur = bg.blur;
    if (bg.scrim != null) background.opacity = Math.max(0, Math.min(100, 100 - Number(bg.scrim)));
    homepageSettings.background = background;
  }
  if (Object.keys(homepageSettings).length) files['settings.yaml'] = toYaml(homepageSettings);

  if (typeof custom.css === 'string' && custom.css.trim()) files['custom.css'] = custom.css;
  if (typeof custom.js === 'string' && custom.js.trim()) files['custom.js'] = custom.js;

  if ((stacks.stacks || []).length) {
    notes.push(`${stacks.stacks.length} stack annotation(s) have no Homepage equivalent — Homepage derives stacks from Docker directly`);
  }

  return {
    format: 'homepage',
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    kind: 'homepage',
    files,
    notes: [
      'Homepage-compatible output. Homepage reads these files as-is; configuration it has no concept of is listed under notes rather than approximated.',
      ...notes,
    ],
    redactions,
    scope: Object.keys(files),
  };
}

/** `si:jellyfin` → `si-jellyfin`; a URL passes through; a local file does not survive. */
export function toHomepageIcon(ref) {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/user/icons/')) return null;
  const m = /^([a-z][a-z0-9-]*):(.+)$/i.exec(s);
  if (m) return `${m[1].toLowerCase() === 'lucide' ? 'lucide' : m[1].toLowerCase()}-${m[2]}`;
  if (s.length <= 8) return null; // an emoji or monogram has no Homepage spelling
  return s;
}

/**
 * YAML serialisation for export. Uses the same `yaml` dependency the rest of the server does.
 * `lineWidth: 0` disables folding, so a long description stays on one line and a Homepage config
 * re-read by a human looks like something a human could have written.
 */
function toYaml(value) {
  return YAML.stringify(value, { lineWidth: 0 });
}

export { LIMITS };
