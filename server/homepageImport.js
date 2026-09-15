// Phase 6 — the Homepage migration engine.
//
//     Homepage configuration
//             ↓  parse      (this file)
//             ↓  validate   (server/configSchema.js)
//             ↓  classify   (matched / unmatched / presentation-only / invalid)
//             ↓  preview    ← the user inspects here; nothing has been written
//             ↓  apply      (server/configImport.js)
//
// Why a dedicated engine instead of "read the YAML and write the YAML":
//
// Homepage's configuration model is NOT OpusHub's, and copying it wholesale would break the one
// invariant this project is built on. Homepage's `services.yaml` is a *list of services*, which
// means a service can exist in Homepage and nowhere else. OpusHub's overlay is a *presentation
// layer over Docker*: a `services.yaml` entry with no container is reported as unmatched and is
// never rendered as infrastructure. Translating between the two is therefore a classification
// problem before it is a mapping problem, and that is exactly what this module does.
//
// Nothing here talks to Docker, reads a socket, or performs I/O. It takes text in and returns a
// plan. `classify` takes an inventory snapshot that the caller has already obtained through the
// normal read-only discovery path.
import YAML from 'yaml';
import {
  LIMITS, ConfigError, configError,
  boundedString, clipped, validDisplayName, writableGroupName,
  safeHref, safeIcon, assertWithinLimits, scrubSecrets,
  isSecretKey, isInfrastructureKey,
} from './configSchema.js';
import { baseName, imageSlugs } from './discovery.js';

/**
 * The files a Homepage install is made of, and what OpusHub does with each.
 *
 * `refuse` entries are not an oversight — they are the security boundary. `docker.yaml` names
 * Docker endpoints and frequently carries registry/daemon credentials; `.env` is Homepage's secret
 * store; `kubernetes.yaml` and `proxmox.yaml` describe infrastructure OpusHub has no business
 * reading. Importing any of them would turn "migrate my dashboard" into "exfiltrate my host's
 * credentials", so they are rejected by name before a single byte is parsed.
 */
export const HOMEPAGE_FILES = {
  'services.yaml': { kind: 'services', label: 'Services' },
  'bookmarks.yaml': { kind: 'bookmarks', label: 'Bookmarks' },
  'widgets.yaml': { kind: 'widgets', label: 'Widgets' },
  'settings.yaml': { kind: 'settings', label: 'Settings' },
  'custom.css': { kind: 'css', label: 'Custom CSS' },
  'custom.js': { kind: 'js', label: 'Custom JS' },
  // accepted aliases
  'theme.css': { kind: 'css', label: 'Custom CSS (theme.css alias)' },
  'app.js': { kind: 'js', label: 'Custom JS (app.js alias)' },
  // OpusHub's own export, offered back. Recognised by shape, not by filename alone.
  'layout.json': { kind: 'layout', label: 'Hub composition (OpusHub native)' },
};

export const REFUSED_FILES = {
  'docker.yaml': 'names Docker endpoints and often carries registry credentials',
  'kubernetes.yaml': 'describes cluster credentials and context OpusHub never reads',
  'proxmox.yaml': 'describes infrastructure credentials OpusHub never reads',
  'lxc.yaml': 'describes infrastructure credentials OpusHub never reads',
  'tailscale.yaml': 'describes network credentials OpusHub never reads',
  '.env': 'is Homepage\'s secret store — secrets are never imported',
  '.env.example': 'is a secret template — secrets are never imported',
  'docker-compose.yml': 'describes containers — Docker decides what exists, not configuration',
  'docker-compose.yaml': 'describes containers — Docker decides what exists, not configuration',
  'compose.yaml': 'describes containers — Docker decides what exists, not configuration',
};

// ---------------------------------------------------------------------------
// small readers that tolerate every shape Homepage has shipped
// ---------------------------------------------------------------------------

/** Coerce to an array: Homepage writes either a sequence or a single map in several places. */
const asList = (value) => {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Flatten one of Homepage's "list of single-key maps" nodes into `[{ key, value }]`.
 * Accepts both forms, because both are in the wild:
 *   [ { Jellyfin: { href: … } }, { Sonarr: { … } } ]      ← the canonical form
 *   { Jellyfin: { href: … }, Sonarr: { … } }              ← the map form
 * Keys are coerced to strings and blanks are dropped, never invented.
 */
function entriesOf(node) {
  const out = [];
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) continue;
      for (const [key, value] of Object.entries(item)) {
        if (typeof key === 'string' && key.trim()) out.push({ key: key.trim(), value });
      }
    }
    return out;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (typeof key === 'string' && key.trim()) out.push({ key: key.trim(), value });
    }
  }
  return out;
}

/**
 * A service's value in canonical Homepage is a *sequence of single-key maps* — one per field:
 *
 *     - Jellyfin:
 *         - icon: jellyfin.png
 *         - href: http://jellyfin:8096
 *
 * Older files use a bare map, and the oldest use a bare string list where the first string is the
 * icon and the second the URL. All three normalise to one map here, exactly as the bookmark reader
 * does for the same reason: treating the canonical form as a plain object silently discards every
 * field it carries, which for a migration tool means importing a dashboard of blank entries.
 */
function serviceBodyOf(value) {
  if (typeof value === 'string') return { href: value };
  if (Array.isArray(value)) {
    const out = {};
    for (const item of value) {
      if (typeof item === 'string') {
        const text = item.trim();
        if (!text) continue;
        // a bare string is a URL if it looks like one, otherwise it is the icon
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith('/')) { if (!out.href) out.href = text; }
        else if (!out.icon) out.icon = text;
        continue;
      }
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        for (const [k, v] of Object.entries(item)) if (out[k] === undefined) out[k] = v;
      }
    }
    return out;
  }
  return value && typeof value === 'object' ? value : {};
}

/**
 * A bookmark's value is a *sequence containing one map* in canonical Homepage, a bare map in older
 * versions, and occasionally a string URL. Normalise all three to one map.
 */
function bookmarkBodyOf(value) {
  if (typeof value === 'string') return { href: value };
  const list = asList(value);
  for (const item of list) {
    if (item && typeof item === 'object' && !Array.isArray(item)) return item;
  }
  return {};
}

// ---------------------------------------------------------------------------
// icon translation
// ---------------------------------------------------------------------------

/**
 * Homepage icon spellings → the `set:name` references OpusHub renders, most specific first.
 *
 * Homepage ships `si-<slug>`, `mdi-<slug>`, `lucide-<slug>` prefixes and bare `<slug>.png`
 * dashboard-icon names. The mapping is *offered*, never assumed: the caller probes each candidate
 * against the bundled collections and keeps the first that actually resolves. If none does, the
 * icon is left unset and the service falls back to OpusHub's monogram, which is a designed state —
 * inventing a reference to an icon that does not exist would render a broken image forever.
 */
export function iconCandidates(raw) {
  const s = boundedString(raw, LIMITS.iconLength);
  if (!s) return [];
  if (/^https?:\/\//i.test(s) || s.startsWith('/user/icons/')) return [s];
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };
  const prefixed = /^(si|mdi|lucide|simple-icons)[-_](.+)$/i.exec(s);
  if (prefixed) {
    const set = prefixed[1].toLowerCase() === 'simple-icons' ? 'si' : prefixed[1].toLowerCase();
    const slug = prefixed[2].replace(/\.(png|svg|webp|jpg)$/i, '').toLowerCase();
    push(`${set}:${slug}`);
    push(`si:${slug}`);
    push(`mdi:${slug}`);
    return out;
  }
  const slug = s.replace(/\.(png|svg|webp|jpg)$/i, '').trim().toLowerCase();
  if (!slug || slug.length > 60) return out;
  push(`si:${slug}`);
  push(`mdi:${slug}`);
  push(`lucide:${slug}`);
  return out;
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

const PARSED = (name, text) => {
  try {
    return YAML.parse(text);
  } catch (err) {
    throw configError(`${name} is not valid YAML — ${err.message.split('\n')[0]}`, { code: 'import_parse' });
  }
};

/** Read `settings.yaml` — presentation only. Unknown keys are counted, never merged blindly. */
function readSettings(doc) {
  const appearance = {};
  const app = {};
  const ignored = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { appearance, app, ignored, widgets: null };
  }
  const title = boundedString(doc.title, LIMITS.nameLength);
  if (title) app.name = title;
  const tagline = boundedString(doc.tagline ?? doc.description, LIMITS.descriptionLength);
  if (tagline) app.tagline = tagline;

  const theme = String(doc.theme ?? '').toLowerCase();
  if (theme === 'dark') appearance.theme = 'dark';
  else if (theme === 'light') appearance.theme = 'light';

  // Homepage's `color:` is a Tailwind palette name; OpusHub's accents are a fixed, curated set.
  // Map only the ones with a genuine tonal sibling, and say so when one is dropped.
  const ACCENT_MAP = {
    slate: 'slate', gray: 'slate', zinc: 'slate', neutral: 'slate', stone: 'clay',
    teal: 'teal', cyan: 'teal', sky: 'slate', blue: 'slate', indigo: 'slate',
    amber: 'amber', yellow: 'amber', orange: 'clay', red: 'rose', rose: 'rose', pink: 'rose',
    lime: 'moss', green: 'moss', emerald: 'moss', sage: 'sage',
  };
  const color = String(doc.color ?? '').toLowerCase();
  if (color) {
    if (ACCENT_MAP[color]) appearance.accent = ACCENT_MAP[color];
    else ignored.push({ key: 'color', value: color, reason: 'no matching OpusHub accent — the current accent is kept' });
  }

  // Background: Homepage keeps a URL plus numeric sliders. Only an https URL or a local file can
  // be carried over, and blur/scrim map onto OpusHub's own 0–48 / 0–100 ranges.
  const bg = doc.background;
  if (bg && typeof bg === 'object' && !Array.isArray(bg)) {
    const appearanceBg = {};
    const image = boundedString(bg.image, LIMITS.hrefLength);
    if (image) appearanceBg.photo = image;
    const clamp = (v, lo, hi) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : null;
    };
    // Homepage's blur is a Tailwind step (`sm`/`md`/`lg`) or a px value; OpusHub's is a px radius.
    const BLUR_STEPS = { sm: 8, md: 16, lg: 24, xl: 32, '2xl': 40 };
    const blurRaw = bg.blur;
    const blur = typeof blurRaw === 'string' && BLUR_STEPS[blurRaw.toLowerCase()] != null
      ? BLUR_STEPS[blurRaw.toLowerCase()]
      : clamp(blurRaw, 0, 48);
    if (blur != null) appearanceBg.blur = blur;
    const opacity = clamp(bg.opacity, 0, 100);
    // Homepage's `opacity` is how much image shows; OpusHub's `scrim` is how much scrim covers it.
    if (opacity != null) appearanceBg.scrim = 100 - opacity;
    if (appearanceBg.photo || appearanceBg.blur != null || appearanceBg.scrim != null) {
      appearance.background = appearanceBg;
    }
    for (const key of Object.keys(bg)) {
      if (!['image', 'blur', 'opacity', 'saturate', 'brightness'].includes(key)) {
        ignored.push({ key: `background.${key}`, value: String(bg[key]).slice(0, 40), reason: 'no OpusHub equivalent' });
      }
    }
  }

  // Anything left is reported rather than silently merged: an import must not pretend it carried
  // settings it dropped.
  for (const key of Object.keys(doc)) {
    if (['title', 'tagline', 'description', 'theme', 'color', 'background'].includes(key)) continue;
    ignored.push({ key, value: typeof doc[key] === 'object' ? '(structure)' : String(doc[key]).slice(0, 40), reason: 'not part of the OpusHub presentation model' });
  }
  return { appearance, app, ignored };
}

/**
 * Read `widgets.yaml`. Homepage widgets are mostly *information providers with credentials*
 * (a Sonarr widget carries an API key). OpusHub's widget model is a composition of built-in
 * blocks with no place to put a credential — which is the point.
 *
 * So: count them, name them, map the handful that have an honest OpusHub sibling, and drop the
 * rest with a reason. Never carry a secret across, and never invent a widget that would render
 * empty.
 */
function readWidgets(doc, { widgetTypes }) {
  const instances = [];
  const unmapped = [];
  const credentials = [];
  for (const { key, value } of entriesOf(doc)) {
    const slug = key.toLowerCase().replace(/[\s_]/g, '-');
    const body = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    for (const k of Object.keys(body)) if (isSecretKey(k)) credentials.push(`widgets.yaml → ${key}.${k}`);
    const mapped = HOMEPAGE_WIDGET_MAP[slug];
    if (mapped && widgetTypes.includes(mapped)) {
      const config = {};
      // the few non-secret knobs that survive the crossing
      if (mapped === 'weather' && typeof body.label === 'string') config.label = boundedString(body.label, 40);
      if (mapped === 'markets' && Array.isArray(body.symbols)) config.symbols = body.symbols.slice(0, 24).map((s) => boundedString(s, 24)).filter(Boolean);
      instances.push({ from: key, type: mapped, config });
    } else {
      unmapped.push({
        name: key,
        reason: UNMAPPED_WIDGET_REASONS[slug] || 'no equivalent block in the OpusHub Hub',
      });
    }
  }
  return { instances, unmapped, credentials };
}

/** Homepage widget slug → OpusHub widget type, where the meaning genuinely survives. */
export const HOMEPAGE_WIDGET_MAP = {
  resources: 'system',
  'system-resources': 'system',
  datetime: 'clock',
  clock: 'clock',
  weather: 'weather',
  markets: 'markets',
  stocks: 'markets',
  bookmarks: 'bookmarks',
};

const UNMAPPED_WIDGET_REASONS = {
  search: 'OpusHub search is the command palette (⌘K), not a widget',
  docker: 'Docker state is discovered, never configured — see Services and Stacks',
  glances: 'a credentialed integration, not a presentation block',
  openmeteo: 'folded into the Weather block, which uses the configured location',
  calendar: 'no calendar block in the OpusHub Hub yet',
  rss: 'folded into the News block, which uses the configured feeds',
  sonarr: 'a credentialed integration, not a presentation block',
  radarr: 'a credentialed integration, not a presentation block',
  jellyfin: 'a credentialed integration, not a presentation block',
  emby: 'a credentialed integration, not a presentation block',
  tautulli: 'a credentialed integration, not a presentation block',
  qbittorrent: 'a credentialed integration, not a presentation block',
  adguard: 'a credentialed integration, not a presentation block',
  pihole: 'a credentialed integration, not a presentation block',
  'home-assistant': 'a credentialed integration, not a presentation block',
  uptimekuma: 'a credentialed integration, not a presentation block',
};

/** Read `services.yaml` into OpusHub's proposed group shape. */
function readServices(doc, { suggestIcon }) {
  const groups = [];
  const services = [];
  const invalid = [];
  const warnings = [];
  const secrets = [];

  /** Group names are written by OpusHub, so they are repaired here and the repair is reported. */
  const groupNameFor = (raw) => {
    const r = writableGroupName(raw);
    if (r.changed) {
      warnings.push(`group “${r.from}” contains characters OpusHub group names cannot hold — imported as “${r.name}”`);
    }
    return r.name;
  };

  const readOne = (groupName, serviceName, body) => {
    // Normalise the body *before* scrubbing: the canonical form is a sequence of one-key maps, and
    // a scrubber looking at that array sees indices, not the credential keys inside it.
    const { value: clean, removed } = scrubSecrets(serviceBodyOf(body));
    for (const r of removed) secrets.push(`services.yaml → ${groupName}/${serviceName}.${r.split('.').pop()}`);
    const cfg = clean && typeof clean === 'object' && !Array.isArray(clean) ? clean : {};

    const entry = {
      sourceGroup: groupName,
      sourceName: serviceName,
      displayName: null,
      description: null,
      url: null,
      urlSource: null,
      icon: null,
      iconCandidates: [],
      iconDropped: null,
      group: groupName,
    };

    // Homepage's service *key* is what the dashboard prints, so it is the display name unless the
    // entry overrides it. Carrying the key across matters: without it an import would silently
    // replace every name the user chose with whatever Docker happens to call the container.
    const explicit = clipped(cfg.name ?? cfg.displayName ?? cfg.title, LIMITS.nameLength, 'name');
    const label = explicit.value ?? serviceName;
    entry.displayName = validDisplayName(label) ? boundedString(label, LIMITS.nameLength) : null;
    if (explicit.value && !entry.displayName) {
      warnings.push(`“${serviceName}”: the Homepage name override contains characters OpusHub cannot use in a URL — the original name is kept`);
    }
    entry.displayNameExplicit = !!explicit.value;

    const desc = boundedString(cfg.description ?? cfg.subtitle, LIMITS.descriptionLength);
    entry.description = desc;

    // `href` is Homepage's URL key; `url` appears in some builds and in widget blocks.
    const rawHref = cfg.href ?? cfg.url ?? (cfg.widget && typeof cfg.widget === 'object' ? cfg.widget.url : null);
    if (rawHref != null && String(rawHref).trim()) {
      try {
        entry.url = safeHref(rawHref, { label: `${serviceName} href` });
        entry.urlSource = cfg.href != null ? 'homepage href' : 'homepage url';
      } catch (err) {
        invalid.push({ name: serviceName, group: groupName, reason: err.message, kind: 'service' });
        return null;
      }
    }

    const candidates = iconCandidates(cfg.icon);
    entry.iconCandidates = candidates;
    if (candidates.length && suggestIcon) {
      // Keep the reason a mapped icon was dropped, so the review screen can explain the monogram.
      for (const c of candidates) {
        if (suggestIcon(c)) { entry.icon = c; break; }
      }
      if (!entry.icon) entry.iconDropped = boundedString(cfg.icon, LIMITS.iconLength);
    } else if (candidates.length) {
      [entry.icon] = candidates;
    } else if (cfg.icon) {
      entry.iconDropped = boundedString(cfg.icon, LIMITS.iconLength);
    }

    // Homepage lets a service name the container it belongs to. That is a *binding hint*, not
    // configuration OpusHub stores — it only affects which container we try to match.
    entry.containerHint = boundedString(cfg.container ?? (cfg.widget && cfg.widget.container), 120);

    // Infrastructure-bearing keys are refused outright rather than dropped quietly: a config that
    // looks like it describes containers is exactly the input this importer must not accept.
    for (const k of Object.keys(cfg)) {
      if (isInfrastructureKey(k) && !['container', 'port', 'ports'].includes(k.toLowerCase())) {
        warnings.push(`“${serviceName}”: the ${k} key describes infrastructure and was not imported`);
      }
    }
    return entry;
  };

  // Canonical Homepage: a sequence of single-key group maps.
  const canonical = new Map(); // repaired group name → the bucket, so two spellings cannot split a group
  for (const { key: rawGroupName, value } of entriesOf(doc)) {
    if (!rawGroupName.trim()) continue;
    const groupName = groupNameFor(rawGroupName);
    let bucket = canonical.get(groupName);
    if (!bucket) {
      bucket = { name: groupName, description: null, icon: null, services: [] };
      canonical.set(groupName, bucket);
      groups.push(bucket);
    }
    for (const { key: serviceName, value: body } of entriesOf(value)) {
      if (!serviceName.trim()) continue;
      const entry = readOne(groupName, serviceName, body);
      if (!entry) continue;
      bucket.services.push(entry);
      services.push(entry);
    }
  }

  if (groups.length > LIMITS.groups) {
    throw configError(`services.yaml declares ${groups.length} groups — the cap is ${LIMITS.groups}`, { status: 413, code: 'import_too_many' });
  }
  if (services.length > LIMITS.services) {
    throw configError(`services.yaml declares ${services.length} services — the cap is ${LIMITS.services}`, { status: 413, code: 'import_too_many' });
  }
  return { groups, services, invalid, warnings, secrets };
}

/**
 * Read an *OpusHub* `services.yaml` (a native export, or the file on a machine being moved).
 *
 * Recognised by shape rather than by filename: a `groups:` sequence whose entries carry a
 * `services:` sequence is OpusHub's own document and cannot be a Homepage one, whose top level is
 * always a sequence of group maps.
 *
 * The round trip has to be honest about one thing: an exported overlay entry may name a container
 * that does not exist on the machine being imported *to*. That is not a defect in the export — it is
 * the same situation a Homepage import is in, and it goes through the same classifier, so an entry
 * with no container is reported as unmatched here too rather than being written back as a service.
 */
function readNativeServices(doc, { suggestIcon }) {
  const groups = [];
  const services = [];
  const invalid = [];
  const warnings = [];
  const secrets = [];
  const seen = new Map();

  for (const g of Array.isArray(doc.groups) ? doc.groups : []) {
    if (!g || typeof g !== 'object') continue;
    const { name: groupName, changed } = writableGroupName(g.name);
    if (changed) warnings.push(`group “${g.name}” contains characters OpusHub group names cannot hold — imported as “${groupName}”`);
    let bucket = seen.get(groupName);
    if (!bucket) {
      bucket = { name: groupName, description: null, icon: null, services: [] };
      seen.set(groupName, bucket);
      groups.push(bucket);
    }
    const description = boundedString(g.description, LIMITS.descriptionLength);
    if (description) bucket.description = description;
    if (g.icon) { try { bucket.icon = safeIcon(g.icon); } catch { /* monogram */ } }

    for (const s of Array.isArray(g.services) ? g.services : []) {
      if (!s || typeof s !== 'object') continue;
      const key = String(s.container || s.name || '').trim();
      if (!key) { invalid.push({ name: '(unnamed)', group: groupName, reason: 'an overlay entry must name a container', kind: 'service' }); continue; }
      const label = s.displayName ?? s.name ?? key;
      const entry = {
        sourceGroup: groupName,
        sourceName: String(s.displayName || s.name || key),
        displayName: validDisplayName(label) ? boundedString(label, LIMITS.nameLength) : null,
        displayNameExplicit: s.displayName != null,
        description: boundedString(s.description, LIMITS.descriptionLength),
        url: null,
        urlSource: null,
        icon: null,
        iconCandidates: [],
        iconDropped: null,
        group: groupName,
        containerHint: boundedString(s.container, 120),
        app: boundedString(s.app, LIMITS.nameLength),
        hidden: s.hidden === true,
        showOnHub: s.showOnHub !== false,
        order: Number.isFinite(Number(s.order)) ? Number(s.order) : null,
        keywords: Array.isArray(s.keywords) ? s.keywords.map((k) => boundedString(k, 40)).filter(Boolean).slice(0, 20) : [],
      };
      if (s.url != null && String(s.url).trim()) {
        try { entry.url = safeHref(s.url, { label: `${entry.sourceName} url` }); entry.urlSource = 'exported override'; }
        catch (err) { invalid.push({ name: entry.sourceName, group: groupName, reason: err.message, kind: 'service' }); continue; }
      }
      const cands = iconCandidates(s.icon);
      entry.iconCandidates = cands;
      if (cands.length) {
        if (suggestIcon) {
          for (const c of cands) { if (suggestIcon(c)) { entry.icon = c; break; } }
          if (!entry.icon) entry.iconDropped = boundedString(s.icon, LIMITS.iconLength);
        } else [entry.icon] = cands;
      }
      bucket.services.push(entry);
      services.push(entry);
    }
  }
  return { groups, services, invalid, warnings, secrets };
}

/** Read an OpusHub `bookmarks.yaml`. */
function readNativeBookmarks(doc) {
  const groups = [];
  const invalid = [];
  let count = 0;
  for (const g of Array.isArray(doc.groups) ? doc.groups : []) {
    if (!g || typeof g !== 'object') continue;
    const name = boundedString(g.name, LIMITS.nameLength) || 'Bookmarks';
    const items = [];
    for (const b of Array.isArray(g.items) ? g.items : []) {
      if (!b || typeof b !== 'object') continue;
      let href;
      try { href = safeHref(b.href, { label: `bookmark ${b.name || ''}` }); }
      catch (err) { invalid.push({ name: String(b.name || '(unnamed)'), group: name, reason: err.message, kind: 'bookmark' }); continue; }
      const itemName = boundedString(b.name, LIMITS.nameLength);
      if (!itemName || !href) { invalid.push({ name: itemName || '(unnamed)', group: name, reason: 'a bookmark needs a name and an href', kind: 'bookmark' }); continue; }
      items.push({ name: itemName, href, ...(b.description ? { description: boundedString(b.description, LIMITS.descriptionLength) } : {}) });
      count++;
    }
    if (items.length) groups.push({ name, items });
  }
  return { groups, invalid, count };
}

/** Read an OpusHub `settings.yaml`. Presentation keys only; integrations are carried as-is. */
function readNativeSettings(doc) {
  const appearance = {};
  const app = {};
  const ignored = [];
  if (doc?.app && typeof doc.app === 'object') {
    if (doc.app.name) app.name = boundedString(doc.app.name, LIMITS.nameLength);
    if (doc.app.tagline) app.tagline = boundedString(doc.app.tagline, LIMITS.descriptionLength);
  }
  if (doc?.appearance && typeof doc.appearance === 'object') {
    const a = doc.appearance;
    if (['dark', 'light', 'system'].includes(String(a.theme))) appearance.theme = a.theme;
    if (a.accent) appearance.accent = boundedString(a.accent, 20);
    if (a.density) appearance.density = boundedString(a.density, 20);
    if (a.background && typeof a.background === 'object') {
      const bg = {};
      if (a.background.photo) bg.photo = boundedString(a.background.photo, LIMITS.hrefLength);
      const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
      if (n(a.background.blur) !== undefined) bg.blur = n(a.background.blur);
      if (n(a.background.scrim) !== undefined) bg.scrim = n(a.background.scrim);
      if (Object.keys(bg).length) appearance.background = bg;
    }
  }
  for (const key of Object.keys(doc || {})) {
    if (['app', 'appearance'].includes(key)) continue;
    ignored.push({ key, value: typeof doc[key] === 'object' ? '(structure)' : String(doc[key]).slice(0, 40), reason: 'applied from the export as-is where OpusHub understands it' });
  }
  return { appearance, app, ignored };
}

/** Read `bookmarks.yaml` into OpusHub's bookmark shape. */
function readBookmarks(doc) {
  const groups = [];
  const invalid = [];
  let count = 0;
  for (const { key: groupName, value } of entriesOf(doc)) {
    if (!groupName.trim()) continue;
    const items = [];
    for (const { key: name, value: body } of entriesOf(value)) {
      const cfg = bookmarkBodyOf(body);
      let href = null;
      try { href = safeHref(cfg.href ?? cfg.url, { label: `bookmark ${name}` }); }
      catch (err) { invalid.push({ name, group: groupName, reason: err.message, kind: 'bookmark' }); continue; }
      if (!href) { invalid.push({ name, group: groupName, reason: 'a bookmark needs an href', kind: 'bookmark' }); continue; }
      const item = { name: boundedString(cfg.name ?? name, LIMITS.nameLength) || name, href };
      const desc = boundedString(cfg.description, LIMITS.descriptionLength);
      if (desc) item.description = desc;
      const abbr = boundedString(cfg.abbr, 8);
      if (abbr) item.abbr = abbr;
      items.push(item);
      if (++count > LIMITS.bookmarks) {
        throw configError(`bookmarks.yaml declares more than ${LIMITS.bookmarks} bookmarks`, { status: 413, code: 'import_too_many' });
      }
    }
    if (items.length) groups.push({ name: groupName, items: items.slice(0, LIMITS.bookmarksPerGroup) });
  }
  return { groups, invalid, count };
}

// ---------------------------------------------------------------------------
// the bundle
// ---------------------------------------------------------------------------

/**
 * Parse a set of uploaded files into a validated Homepage bundle.
 *
 * `files` is `{ name: content }`. Unknown names are ignored with a note; refused names throw. A JS
 * file is never executed, evaluated or `require`d — it is carried as a string and linted, which is
 * the entire contract for custom code in OpusHub (it runs in the browser, same-origin, opt-in).
 */
export function parseHomepageBundle(files = {}, { widgetTypes = [], suggestIcon = null } = {}) {
  const names = Object.keys(files);
  if (names.length > LIMITS.importFiles) {
    throw configError(`an import may carry at most ${LIMITS.importFiles} files (got ${names.length})`, { status: 413, code: 'import_too_many_files' });
  }
  let totalBytes = 0;
  for (const name of names) {
    const bytes = Buffer.byteLength(String(files[name] ?? ''), 'utf8');
    totalBytes += bytes;
    if (totalBytes > LIMITS.importBundleBytes) {
      throw configError(`the import exceeds ${Math.round(LIMITS.importBundleBytes / 1024)} KB in total`, { status: 413, code: 'import_too_large' });
    }
  }

  const report = { files: [], refused: [], ignored: [], secrets: [] };
  const bundle = {
    source: 'homepage',
    groups: [], services: [], bookmarks: [], widgets: [], widgetPlan: null,
    appearance: {}, app: {}, layout: null, custom: { css: null, js: null },
    invalid: [], warnings: [], ignoredSettings: [], unmappedWidgets: [],
  };

  // Refusals first, and they are hard: this is the difference between a migration tool and a
  // credential harvester.
  for (const name of names) {
    const base = String(name).split(/[/\\]/).pop().toLowerCase();
    if (REFUSED_FILES[base]) {
      throw configError(
        `${base} is not imported — it ${REFUSED_FILES[base]}. OpusHub discovers infrastructure from Docker and never reads credentials from configuration.`,
        { code: 'import_refused_file', detail: { file: base } },
      );
    }
  }

  for (const [name, raw] of Object.entries(files)) {
    const base = String(name).split(/[/\\]/).pop().toLowerCase();
    const spec = HOMEPAGE_FILES[base];
    const text = typeof raw === 'string' ? raw : String(raw ?? '');
    if (!spec) {
      report.ignored.push({ file: base, reason: 'not part of the OpusHub migration surface' });
      continue;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (!text.trim()) {
      report.files.push({ file: base, kind: spec.kind, bytes, status: 'empty', note: 'nothing to import' });
      continue;
    }
    assertWithinLimits(base, { text });

    if (spec.kind === 'css' || spec.kind === 'js') {
      bundle.custom[spec.kind] = text;
      report.files.push({ file: base, kind: spec.kind, bytes, status: 'parsed', note: `${spec.label} carried over (still needs enabling)` });
      continue;
    }

    const parsed = PARSED(base, text);
    assertWithinLimits(base, { parsed });

    if (spec.kind === 'services') {
      // An OpusHub native export may be offered here instead of a Homepage file. Recognising it is
      // what makes "move this install to a new box" work through the same review screen — and it
      // must still go through the same classifier, because the containers it names may not exist
      // on the machine being imported to.
      const native = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Array.isArray(parsed.groups)
        && parsed.groups.every((g) => g && typeof g === 'object' && (Array.isArray(g.services) || g.services === undefined));
      if (native) {
        bundle.source = 'opushub';
        const r = readNativeServices(parsed, { suggestIcon });
        bundle.groups = r.groups;
        bundle.services = r.services;
        bundle.invalid.push(...r.invalid);
        bundle.warnings.push(...r.warnings);
        report.secrets.push(...r.secrets);
        report.files.push({
          file: base, kind: 'services', bytes, status: 'parsed',
          note: `OpusHub native export — ${r.groups.length} group(s), ${r.services.length} service(s)`,
        });
        continue;
      }
      const r = readServices(parsed, { suggestIcon });
      bundle.groups = r.groups;
      bundle.services = r.services;
      bundle.invalid.push(...r.invalid);
      bundle.warnings.push(...r.warnings);
      report.secrets.push(...r.secrets);
      report.files.push({
        file: base, kind: 'services', bytes, status: 'parsed',
        note: `${r.groups.length} group${r.groups.length === 1 ? '' : 's'}, ${r.services.length} service${r.services.length === 1 ? '' : 's'}`,
      });
      continue;
    }

    if (spec.kind === 'bookmarks') {
      const native = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Array.isArray(parsed.groups)
        && parsed.groups.every((g) => g && typeof g === 'object' && Array.isArray(g.items));
      if (native) {
        bundle.source = 'opushub';
        const r = readNativeBookmarks(parsed);
        bundle.bookmarks = r.groups;
        bundle.invalid.push(...r.invalid);
        report.files.push({ file: base, kind: 'bookmarks', bytes, status: 'parsed', note: `OpusHub native export — ${r.groups.length} group(s), ${r.count} link(s)` });
        continue;
      }
      const r = readBookmarks(parsed);
      bundle.bookmarks = r.groups;
      bundle.invalid.push(...r.invalid);
      report.files.push({
        file: base, kind: 'bookmarks', bytes, status: 'parsed',
        note: `${r.groups.length} group${r.groups.length === 1 ? '' : 's'}, ${r.count} link${r.count === 1 ? '' : 's'}`,
      });
      continue;
    }

    if (spec.kind === 'widgets') {
      const r = readWidgets(parsed, { widgetTypes });
      bundle.widgetPlan = r;
      bundle.unmappedWidgets = r.unmapped;
      report.secrets.push(...r.credentials);
      report.files.push({
        file: base, kind: 'widgets', bytes, status: 'parsed',
        note: `${r.instances.length} mapped, ${r.unmapped.length} without an OpusHub equivalent`,
      });
      continue;
    }

    if (spec.kind === 'layout') {
      // OpusHub's composition. Carried through as a patch rather than a replacement, so a template
      // or a hand-edit made since the export is not silently discarded.
      if (parsed && typeof parsed === 'object' && parsed.hub && Array.isArray(parsed.hub.widgets)) {
        bundle.layout = parsed;
        report.files.push({ file: base, kind: 'layout', bytes, status: 'parsed', note: `OpusHub composition — ${parsed.hub.widgets.length} widget(s)` });
      } else {
        report.files.push({ file: base, kind: 'layout', bytes, status: 'skipped', note: 'not an OpusHub layout document' });
      }
      continue;
    }

    if (spec.kind === 'settings') {
      const nativeSettings = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && (parsed.appearance !== undefined || parsed.app !== undefined)
        && parsed.title === undefined && parsed.theme === undefined;
      const r = nativeSettings ? readNativeSettings(parsed) : readSettings(parsed);
      if (nativeSettings) bundle.source = 'opushub';
      bundle.appearance = r.appearance;
      bundle.app = r.app;
      bundle.ignoredSettings = r.ignored;
      report.files.push({
        file: base, kind: 'settings', bytes, status: 'parsed',
        note: Object.keys(r.appearance).length || Object.keys(r.app).length
          ? `${Object.keys(r.appearance).length + Object.keys(r.app).length} presentation setting(s) mapped`
          : 'nothing in this file maps onto OpusHub presentation',
      });
      continue;
    }
  }

  return { bundle, report };
}

/**
 * Take a parsed bundle and decide what each imported service *is*.
 *
 * This is the function the whole phase exists to get right. The four outcomes are not a UI
 * convenience — they are the model:
 *
 *   matched            this imported entry describes a container that is really running here.
 *                      Its presentation (name, icon, description, group, url override) is applied.
 *   unmatched          no container matches. It may still be a useful *link*, but it is never
 *                      inventory. The user decides: keep it as a bookmark, or drop it.
 *   presentation-only  the user has already decided to keep an unmatched entry as a link.
 *   invalid            the entry could not be represented safely (bad URL, bad name) and is
 *                      reported instead of being partially applied.
 *
 * Docker is the only source of `matched`. Nothing an imported file says can create, rename or
 * remove a container, and this function has no code path that could.
 */
export function classifyBundle(bundle, inventory, { existingOverlays = new Map() } = {}) {
  const containers = (inventory?.services || []).map((s) => ({
    id: s.id,
    name: s.name,
    displayName: s.displayName,
    group: s.group,
    containerId: s.container?.id || s.id,
    containerName: s.container?.name || s.name,
    composeService: s.container?.composeService || null,
    composeProject: s.container?.project || null,
    image: s.container?.image || null,
    url: s.url || null,
    urlSource: s.urlSource || null,
    state: s.container?.state || null,
    kind: s.kind || 'application',
  }));

  const matched = [];
  const unmatched = [];
  const invalid = [...(bundle.invalid || [])];
  const conflicts = [];
  const takenContainers = new Map();

  const hostOf = (u) => {
    try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
  };

  for (const entry of bundle.services || []) {
    const candidates = [];
    const hint = entry.containerHint?.toLowerCase();
    const name = String(entry.sourceName || '').toLowerCase();
    const slug = String(entry.displayName || entry.sourceName || '').toLowerCase();
    const host = entry.url ? hostOf(entry.url) : null;

    // 1. an explicit `container:` in the Homepage entry — the strongest signal there is
    if (hint) {
      for (const c of containers) {
        if (c.containerName.toLowerCase() === hint || c.containerId === hint || String(c.containerId).startsWith(hint)) {
          candidates.push({ c, how: 'container name in the imported file', confidence: 'explicit' });
        }
      }
    }
    // 2. the service's own name against container name / compose service / derived base name
    if (!candidates.length && name) {
      for (const c of containers) {
        const cn = c.containerName.toLowerCase();
        const cs = (c.composeService || '').toLowerCase();
        const bn = baseName(c.containerName, c.composeProject).toLowerCase();
        if (cn === name || cs === name || bn === name) {
          candidates.push({ c, how: cs === name ? 'compose service name' : 'container name', confidence: 'name' });
        }
      }
    }
    // 3. the display name, for Homepage configs whose key was prettified
    if (!candidates.length && slug && slug !== name) {
      for (const c of containers) {
        const bn = baseName(c.containerName, c.composeProject).toLowerCase();
        if (bn === slug || (c.composeService || '').toLowerCase() === slug) {
          candidates.push({ c, how: 'derived from the entry name', confidence: 'name' });
        }
      }
    }
    // 4. the href host, against the URL Docker/Traefik actually resolved for a container
    if (!candidates.length && host) {
      for (const c of containers) {
        if (c.url && hostOf(c.url) === host) candidates.push({ c, how: `same host as the running service (${host})`, confidence: 'url' });
      }
    }
    // 5. the icon slug, against image slugs — weakest, and only ever a suggestion
    if (!candidates.length && entry.iconCandidates?.length) {
      const slugs = new Set(entry.iconCandidates.map((c) => c.split(':').pop()));
      for (const c of containers) {
        for (const s of imageSlugs(c.image || '')) {
          if (slugs.has(s)) candidates.push({ c, how: `image name (${c.image})`, confidence: 'icon' });
        }
      }
    }

    const free = candidates.filter(({ c }) => !takenContainers.has(c.id));
    const pick = free[0] || null;

    if (!pick) {
      const blocked = candidates.length ? candidates[0] : null;
      unmatched.push({
        ...entry,
        reason: blocked
          ? `would match “${blocked.c.containerName}”, but that container is already claimed by “${takenContainers.get(blocked.c.id)?.sourceName}”`
          : (inventory?.live === false
            ? 'Docker is not connected, so nothing could be matched — start the engine and re-run the import'
            : 'no container with this name, URL host or image is running on this Docker host'),
        suggestion: entry.url ? 'bookmark' : 'drop',
      });
      continue;
    }

    takenContainers.set(pick.c.id, entry);

    // A conflict is not "the file disagrees with itself" — it is "the file disagrees with an
    // overlay you already have". Those are the only two things that can disagree, and the user
    // is shown both sides before either is written.
    const existing = existingOverlays.get(pick.c.containerName) || existingOverlays.get(pick.c.id) || null;
    if (existing) {
      const changes = [];
      const compare = (label, from, to) => {
        if (to == null) return;
        const a = from == null ? '' : String(from);
        if (a !== String(to)) changes.push({ field: label, current: a || '(none)', imported: String(to) });
      };
      compare('Display name', existing.displayName, entry.displayName);
      compare('Description', existing.description, entry.description);
      compare('Icon', existing.icon, entry.icon);
      compare('Group', existing.group, entry.group);
      compare('URL override', existing.url, entry.url);
      if (changes.length) {
        conflicts.push({
          container: pick.c.containerName,
          service: pick.c.displayName,
          source: `${entry.sourceGroup} / ${entry.sourceName}`,
          changes,
        });
      }
    }

    matched.push({
      ...entry,
      container: pick.c,
      matchHow: pick.how,
      matchConfidence: pick.confidence,
      existing,
    });
  }

  return {
    matched,
    unmatched,
    invalid,
    conflicts,
    // The four-way classification, as counts, is what the review screen puts at the top.
    counts: {
      matched: matched.length,
      unmatched: unmatched.length,
      presentationOnly: 0,
      invalid: invalid.length,
      conflicts: conflicts.length,
    },
  };
}

/**
 * The full review payload. `files` → `bundle` → `classification` → the summary the UI renders.
 * No side effects of any kind: calling this twice with the same input yields the same plan, and
 * nothing on disk has changed.
 */
export function buildImportPreview({ bundle, report, inventory, existingOverlays = new Map() }) {
  const classification = classifyBundle(bundle, inventory, { existingOverlays });
  const groups = (bundle.groups || []).map((g) => ({
    name: g.name,
    matched: classification.matched.filter((m) => m.sourceGroup === g.name).length,
    unmatched: classification.unmatched.filter((m) => m.sourceGroup === g.name).length,
    total: g.services.length,
  }));
  return {
    source: bundle.source,
    files: report.files,
    refused: report.refused,
    ignored: report.ignored,
    secretsDropped: [...new Set([...(report.secrets || []), ...(bundle.warnings || []).filter((w) => /secret|credential/i.test(w))])],
    summary: {
      groups: (bundle.groups || []).length,
      services: (bundle.services || []).length,
      bookmarks: (bundle.bookmarks || []).reduce((a, g) => a + g.items.length, 0),
      widgets: (bundle.widgetPlan?.instances || []).length,
      widgetGroups: (bundle.widgetPlan?.unmapped || []).length,
      matched: classification.counts.matched,
      unmatched: classification.counts.unmatched,
      invalid: classification.counts.invalid,
      conflicts: classification.counts.conflicts,
      dockerConnected: inventory?.live !== false,
      dockerContainers: (inventory?.services || []).length,
    },
    groups,
    matched: classification.matched,
    unmatched: classification.unmatched,
    invalid: classification.invalid,
    conflicts: classification.conflicts,
    bookmarks: bundle.bookmarks || [],
    widgets: bundle.widgetPlan || { instances: [], unmapped: [], credentials: [] },
    unmappedWidgets: bundle.unmappedWidgets || [],
    ignoredSettings: bundle.ignoredSettings || [],
    appearance: bundle.appearance || {},
    app: bundle.app || {},
    custom: bundle.custom || { css: null, js: null },
    layout: bundle.layout || null,
    warnings: bundle.warnings || [],
  };
}

/** Shape check for the decisions the review screen sends back. */
export function normalizeDecisions(raw = {}) {
  const keep = String(raw.keepUnmatched ?? 'bookmark');
  return {
    keepUnmatched: ['bookmark', 'drop', 'overlay'].includes(keep) ? keep : 'bookmark',
    includeBookmarks: raw.includeBookmarks !== false,
    includeWidgets: raw.includeWidgets !== false,
    includeAppearance: raw.includeAppearance !== false,
    includeCustom: raw.includeCustom === true,
    // explicit per-service opt-outs, by `sourceGroup/sourceName`
    skip: Array.isArray(raw.skip) ? raw.skip.filter((x) => typeof x === 'string').slice(0, LIMITS.services) : [],
    // explicit per-group remapping
    groupRenames: raw.groupRenames && typeof raw.groupRenames === 'object' && !Array.isArray(raw.groupRenames)
      ? Object.fromEntries(Object.entries(raw.groupRenames).slice(0, LIMITS.groups).map(([k, v]) => [String(k).slice(0, LIMITS.nameLength), String(v).slice(0, LIMITS.nameLength)]))
      : {},
  };
}

export { ConfigError, scrubSecrets };
