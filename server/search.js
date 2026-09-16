// Unified search: pages · services · stacks · infrastructure · alerts · bookmarks · settings · recent news.
// Services and stacks come from the SAME canonical inventory the Hub, Services and Stacks pages
// render — one model, so search can never offer something that isn't a container, or hide
// something that is. (Bookmarks and pages are OpusHub's own surfaces, not infrastructure.)
// A lightweight scoring pass — the client adds its own instant fuzzy layer on top.
import { readBookmarks, readServices, getInventory, getLayout, getInfra } from './model.js';
import { readEvents } from './activity.js';
import { getActiveAlerts } from './alerts.js';
import { ACTIONS, ACTION_IDS } from './operations/registry.js';
import { describeActor } from './operations/permissions.js';
import * as dockerOps from './providers/dockerOperations.js';

const PAGES = [
  { title: 'Hub', href: '/', hint: 'Your digital home', kind: 'page', keywords: ['home', 'start', 'dashboard'] },
  { title: 'Services', href: '/services', hint: 'Everything you run', kind: 'page', keywords: ['apps', 'containers'] },
  { title: 'Stacks', href: '/stacks', hint: 'Groups of containers', kind: 'page', keywords: ['compose', 'projects'] },
  { title: 'Infrastructure', href: '/infrastructure', hint: 'Engine, networks, volumes, images, topology', kind: 'page', keywords: ['docker', 'network', 'volume', 'image', 'topology', 'host', 'engine'] },
  { title: 'System', href: '/system', hint: 'Host vitals', kind: 'page', keywords: ['cpu', 'memory', 'disk', 'network', 'uptime'] },
  { title: 'Activity', href: '/activity', hint: 'What happened, when', kind: 'page', keywords: ['events', 'history', 'log'] },
  { title: 'Icon browser', href: '/icons', hint: 'Find an icon and apply it', kind: 'page', keywords: ['logo', 'glyph', 'symbol'] },
  { title: 'Settings', href: '/settings/appearance', hint: 'Everything you can change', kind: 'page', keywords: ['config', 'preferences'] },
];

/** Settings destinations — real routes, so Enter lands on the pane that owns the thing searched. */
const SETTINGS = [
  { title: 'Appearance', href: '/settings/appearance', hint: 'Theme, accent, density, type scale', keywords: ['dark', 'light', 'theme', 'accent', 'colour', 'color', 'compact', 'font'] },
  { title: 'Background', href: '/settings/background', hint: 'Quiet, horizon, or your own photo', keywords: ['wallpaper', 'photo', 'blur', 'scrim', 'image'] },
  { title: 'Hub layout', href: '/settings/hub', hint: 'Sections, spacing, greeting, clock', keywords: ['home screen', 'composition', 'sections', 'greeting', 'name', 'clock', '24 hour'] },
  { title: 'Widgets', href: '/settings/widgets', hint: 'Add, hide, resize and configure Hub widgets', keywords: ['widget', 'rail', 'weather', 'news', 'markets', 'bookmarks', 'activity', 'clock', 'system'] },
  { title: 'Templates', href: '/settings/templates', hint: 'Layout presets: minimal, balanced, media…', keywords: ['preset', 'layout', 'theme pack'] },
  { title: 'Services', href: '/settings/services', hint: 'Names, icons, groups, URLs, visibility', keywords: ['overlay', 'services.yaml', 'rename', 'icon'] },
  { title: 'Groups', href: '/settings/groups', hint: 'Create, rename, reorder and hide groups', keywords: ['grouping', 'categories', 'folders'] },
  { title: 'Bookmarks', href: '/settings/bookmarks', hint: 'Flat links, no status', keywords: ['links', 'shortcuts'] },
  { title: 'Integrations', href: '/settings/integrations', hint: 'News feeds, weather location, watchlist', keywords: ['rss', 'feed', 'weather', 'stocks', 'markets', 'symbols'] },
  { title: 'Notifications', href: '/settings/notifications', hint: 'Alert channels: webhook, email, Telegram, Slack', keywords: ['alerts', 'notify', 'webhook', 'email', 'telegram', 'slack', 'channels'] },
  { title: 'General', href: '/settings/general', hint: 'Name, greeting, this install', keywords: ['identity', 'title', 'name', 'greeting', 'app', 'about'] },
  { title: 'Environment', href: '/settings/environment', hint: 'Engine status, URL sources, Homepage-compatible files', keywords: ['docker', 'engine', 'socket', 'discovery', 'unmatched', 'env', 'paths', 'homepage', 'overlay'] },
  { title: 'Account & sessions', href: '/settings/authentication', hint: 'Password, signed-in browsers, revocation', keywords: ['password', 'change password', 'sessions', 'sign out', 'security', 'login', 'revoke'] },
  { title: 'Advanced', href: '/settings/advanced', hint: 'Custom CSS & JS, refresh intervals, launch logging', keywords: ['custom css', 'custom js', 'theme.css', 'app.js', 'advanced', 'refresh', 'poll', 'launch log'] },
  // Phase 6 — the configuration surfaces themselves are destinations worth searching for.
  { title: 'Import & migration', href: '/settings/import', hint: 'Bring a Homepage configuration across, with a review before anything is written', keywords: ['homepage', 'migrate', 'import', 'services.yaml', 'bookmarks.yaml', 'widgets.yaml', 'move', 'convert', 'porter'] },
  { title: 'Configuration history', href: '/settings/history', hint: 'Every version, what changed, and restore', keywords: ['history', 'backup', 'versions', 'restore', 'undo', 'rollback', 'diff', 'snapshot', 'revert'] },
  { title: 'Export', href: '/settings/export', hint: 'Take your configuration somewhere else', keywords: ['export', 'download', 'backup', 'move', 'homepage', 'transfer', 'portable'] },
  { title: 'Configuration scope', href: '/settings/configuration', hint: 'What configuration may change, and what it never can', keywords: ['scope', 'boundary', 'secrets', 'credentials', 'auth', 'separation', 'safety', 'docker'] },
];

/**
 * Ranking tiers (documented, deterministic) — best score across all fields wins:
 *   140 exact match        the whole field IS the query ("seerr" → seerr)
 *   110 prefix match       the field starts with the query ("ser" → seerr)
 *    90 word match         a word inside the field starts with the query ("ass" → home assistant)
 *    70 substring          the query appears mid-word, penalised by position
 *    ≤30 subsequence       characters in order, heavily penalised by gaps ("wdgt" → widgets)
 * A kind weight then orders categories: services/stacks > pages > settings > bookmarks > news,
 * so infrastructure names outrank navigation for the same textual match.
 */
export function scoreMatch(needle, ...fields) {
  if (!needle) return 20;
  let best = 0;
  for (const raw of fields) {
    if (!raw) continue;
    const hay = String(raw).toLowerCase();
    if (hay === needle) { best = Math.max(best, 140); continue; }
    if (hay.startsWith(needle)) { best = Math.max(best, 110); continue; }
    const words = hay.split(/[\s·\-_/.]+/);
    if (words.some((w) => w.startsWith(needle))) { best = Math.max(best, 90); continue; }
    const idx = hay.indexOf(needle);
    if (idx > 0) { best = Math.max(best, 70 - Math.min(30, idx)); continue; }
    // subsequence, gap-penalised
    let i = 0; let gap = 0; let last = -2;
    for (let c = 0; c < hay.length && i < needle.length; c++) {
      if (hay[c] === needle[i]) { if (i > 0) gap += c - last - 1; last = c; i++; }
    }
    if (i === needle.length) best = Math.max(best, 30 - Math.min(24, gap));
  }
  return best;
}

const score = scoreMatch;

/** Category weights — services and stacks rank highest: they are the point of the index. */
const KIND_WEIGHT = { service: 1, stack: 1, alert: 0.96, page: 0.92, config: 0.9, setting: 0.88, operation: 0.86, infra: 0.86, activity: 0.8, bookmark: 0.85, news: 0.75 };

/**
 * Which registered operations make sense to offer for a container in this state.
 *
 * The list comes from the registry itself — this file names no action of its own — filtered by the
 * registry's own `offerWhen`. The palette is for finding things, not for offering every button
 * everywhere: a running service offers Restart and Stop, a stopped one offers Start. Whatever is
 * offered still goes through the same confirmation, and the server re-decides if it is allowed.
 */
const operationsForState = (state) => ACTION_IDS.filter((id) => (ACTIONS[id].offerWhen || []).includes(state));

/** Docker subjects whose events are worth offering as destinations — the same names the pages use. */
const ACTIVITY_WINDOW_MS = 7 * 24 * 3600_000;

export async function searchAll(q, { newsItems = [], actor = null } = {}) {
  const needle = String(q || '').toLowerCase().trim().slice(0, 80);
  const out = [];
  const add = (item, s, weight = 1) => { if (s > 8) out.push({ ...item, _s: s * weight }); };

  for (const p of PAGES) add({ title: p.title, subtitle: p.hint, href: p.href, kind: 'page' }, score(needle, p.title, p.hint, ...(p.keywords || [])), KIND_WEIGHT.page);
  for (const st of SETTINGS) add({ title: st.title, subtitle: `Setting · ${st.hint}`, href: st.href, kind: 'setting' }, score(needle, st.title, st.hint, ...(st.keywords || [])), KIND_WEIGHT.setting);

  // the one canonical inventory: containers, their resolved URLs, and their presentation overlay
  let inv = null;
  try { inv = await getInventory(); } catch { /* discovery failed — search still answers with pages/bookmarks */ }

  if (inv) {
    for (const s of inv.services) {
      if (s.hidden) continue; // hidden stays hidden — search is not a bypass
      add({
        title: s.displayName,
        subtitle: [s.kind === 'infrastructure' ? 'infrastructure' : s.group, s.container.state === 'running' ? 'running' : s.container.state].filter(Boolean).join(' · '),
        href: `/services/${encodeURIComponent(s.group || 'Other')}/${encodeURIComponent(s.name)}`,
        kind: 'service', group: s.group, icon: s.icon, status: s.status, url: s.url,
      }, score(needle, s.displayName, s.name, s.container.composeService, s.container.image, s.description, s.app, ...(s.keywords || []), s.group), KIND_WEIGHT.service);
    }
    /**
     * Phase 8 — operations, as destinations that open a confirmation.
     *
     * These results carry an action id and a target reference and nothing else. Selecting one
     * does not run anything: the palette hands it to the confirmation flow, which asks the server
     * to evaluate it first. There is no such thing as a dynamic command here — every entry is a
     * registered action against a container the engine actually has.
     */
    const perms = new Set(describeActor(actor).permissions);
    const opsAvailable = dockerOps.operationsAvailability().ok;
    if (opsAvailable && perms.size) {
      for (const s of inv.services) {
        if (s.hidden) continue;
        for (const actionId of operationsForState(s.container?.state)) {
          const a = ACTIONS[actionId];
          if (!a || !perms.has(a.permission)) continue;
          add({
            title: `${a.imperative} ${s.displayName}`,
            subtitle: `Operation · ${a.summary}`,
            href: `/services/${encodeURIComponent(s.group || 'Other')}/${encodeURIComponent(s.name)}`,
            kind: 'operation',
            icon: s.icon,
            // the payload the confirmation flow needs — an action id and a reference, never an
            // endpoint, a method or a container id used as one
            operation: {
              action: a.id,
              target: { type: 'service', id: s.name, group: s.group || null },
              confirmation: a.confirmation,
              risk: a.risk,
            },
          }, score(needle, `${a.imperative} ${s.displayName}`, a.verb, s.displayName, s.name, 'restart start stop operation'), KIND_WEIGHT.operation);
        }
      }
    }
    for (const st of inv.stacks) {
      add({
        title: st.name,
        subtitle: [st.project ? `compose · ${st.project}` : 'stack', `${st.containerCount} container${st.containerCount === 1 ? '' : 's'}`].join(' · '),
        href: `/stacks/${encodeURIComponent(st.id)}`,
        kind: 'stack', icon: st.icon, status: st.status,
      }, score(needle, st.name, st.displayName, st.project, st.description, ...st.services), KIND_WEIGHT.stack);
    }
  }

  /**
   * Phase 6 — configuration, as destinations.
   *
   * The brief's example is the specification: searching "Stream" should find the *service*, and
   * also the *place you would go to change how Stream looks*. Those are different results with
   * different destinations — one opens the service page, the other opens its editor — so they are
   * indexed separately rather than folded into one hit that guesses which you meant.
   */
  // Phase 7F — active alerts are destinations: the alert's own link when it has one (the
  // service, the stack), the Activity page otherwise. At most MAX_ALERTS exist by construction.
  try {
    for (const al of getActiveAlerts()) {
      const href = al.links?.[0]?.href || '/activity';
      add({
        title: al.title,
        subtitle: `Alert · ${al.severity}${al.acknowledged ? ' · acknowledged' : ''} — ${al.detail}`.slice(0, 120),
        href, kind: 'alert', status: al.severity === 'critical' ? 'down' : 'degraded',
      }, score(needle, al.title, al.detail, al.signature, 'alert', al.severity), KIND_WEIGHT.alert);
    }
  } catch { /* alerting is optional — search still answers without it */ }

  // Phase 7F — infrastructure names: networks, volumes, images, straight from the cached
  // infra document (the same one the Infrastructure page renders). Each hit deep-links to
  // its tab. Cache-first with a long window — a keystroke must never trigger engine calls.
  try {
    const infra = await getInfra({ refreshMs: 300_000 });
    const doc = infra.live ? infra : (infra.stale || infra);
    for (const n of (doc.networks || []).slice(0, 40)) {
      add({
        title: n.name, subtitle: `Network · ${n.driver || 'unknown driver'} · ${n.containers ?? '?'} attached`,
        href: '/infrastructure?tab=networks', kind: 'infra',
      }, score(needle, n.name, n.driver, 'network'), KIND_WEIGHT.infra);
    }
    for (const v of (doc.volumes || []).slice(0, 40)) {
      add({
        title: v.name, subtitle: `Volume · ${v.driver || 'unknown driver'} · ${v.refCount ?? '?'} users`,
        href: '/infrastructure?tab=volumes', kind: 'infra',
      }, score(needle, v.name, v.driver, 'volume'), KIND_WEIGHT.infra);
    }
    for (const img of (doc.images || []).slice(0, 40)) {
      const tag = (img.tags || [])[0] || img.id;
      add({
        title: tag, subtitle: `Image · ${(img.usedBy || []).length} container${(img.usedBy || []).length === 1 ? '' : 's'} use it`,
        href: '/infrastructure?tab=images', kind: 'infra',
      }, score(needle, tag, ...(img.tags || []), 'image'), KIND_WEIGHT.infra);
    }
  } catch { /* infra is optional — search still answers without it */ }

  try {
    const { overlays, groups } = readServices();
    const layout = getLayout();
    const hidden = new Set((layout.services?.hiddenGroups || []).map((g) => String(g).toLowerCase()));
    for (const o of overlays) {
      const label = o.displayName || o.name || o.container;
      if (!label) continue;
      add({
        title: `${label} presentation`,
        subtitle: `Configuration · name, icon, group, URL for “${o.container || o.name}”`,
        href: `/settings/services?service=${encodeURIComponent(o.container || o.name)}`,
        kind: 'config',
        icon: o.icon || null,
      }, score(needle, label, o.name, o.container, o.description, o.app, o.group, 'presentation', 'override', 'rename icon url group'), KIND_WEIGHT.config);
    }
    for (const g of groups) {
      if (!g.name) continue;
      add({
        title: `${g.name} group`,
        subtitle: `Configuration · ${g.services.length} service${g.services.length === 1 ? '' : 's'}${hidden.has(g.name.toLowerCase()) ? ' · hidden' : ''}`,
        href: `/settings/groups?group=${encodeURIComponent(g.name)}`,
        kind: 'config',
        icon: g.icon || null,
      }, score(needle, g.name, g.description, 'group', 'reorder', 'hide', 'rename'), KIND_WEIGHT.config);
    }
  } catch { /* configuration is optional — search still answers without it */ }

  /**
   * Recent activity, as *destinations*: "wave — container started · 2h ago" opens the Activity
   * Center already filtered to that service. Only events with a subject qualify (an event without
   * one cannot be filtered to), only the last week, and each subject appears once — the palette is
   * for finding things, not for re-reading the log.
   */
  try {
    const { items } = readEvents({ limit: 200, since: Date.now() - ACTIVITY_WINDOW_MS });
    const seen = new Set();
    for (const e of items) {
      if (e.grouped) {
        for (const sub of (e.subjects || []).slice(0, 3)) {
          if (!sub || seen.has(sub)) continue;
          seen.add(sub);
          add({
            title: sub,
            subtitle: `Activity · ${e.count} events · ${describeEventType(e.type)}`,
            href: `/activity?service=${encodeURIComponent(sub)}`,
            kind: 'activity',
          }, score(needle, sub, e.type, describeEventType(e.type)), KIND_WEIGHT.activity);
        }
        continue;
      }
      const subject = e.subject;
      if (!subject || seen.has(subject)) continue;
      seen.add(subject);
      add({
        title: subject,
        subtitle: `Activity · ${describeEventType(e.type)}${e.message ? ` · ${String(e.message).slice(0, 60)}` : ''}`,
        href: `/activity?service=${encodeURIComponent(subject)}`,
        kind: 'activity',
      }, score(needle, subject, e.type, describeEventType(e.type), e.message), KIND_WEIGHT.activity);
    }
  } catch { /* the log is optional — search still answers without it */ }

  try {
    const { flat } = readBookmarks();
    for (const b of flat.slice(0, 500)) {
      add({ title: b.name, subtitle: b.group, href: b.href, kind: 'bookmark' }, score(needle, b.name, b.description, b.group), KIND_WEIGHT.bookmark);
    }
  } catch { /* ok */ }

  for (const n of newsItems.slice(0, 120)) {
    add({ title: n.title, subtitle: `News · ${n.source || ''}`.trim(), href: n.link, kind: 'news', external: true }, score(needle, n.title, n.source), KIND_WEIGHT.news);
  }

  return out.sort((a, b) => b._s - a._s).slice(0, 24).map(({ _s, ...item }) => item);
}

/** A type code said in words, for the palette's subtitle. Unknown codes pass through unchanged. */
function describeEventType(type) {
  const map = {
    'container.started': 'started',
    'container.exited': 'stopped',
    'container.health': 'health changed',
    'container.state': 'state changed',
    'stack.appeared': 'stack appeared',
    'stack.removed': 'stack removed',
    'provider.unavailable': 'provider down',
    'provider.recovered': 'provider recovered',
    'settings.updated': 'settings changed',
    'layout.updated': 'layout changed',
    'services.updated': 'services changed',
    'bookmarks.updated': 'bookmarks changed',
    'custom.updated': 'custom assets changed',
    'service.launch': 'opened',
    'app.boot': 'OpusHub started',
    'auth.login': 'signed in',
    'auth.logout': 'signed out',
    'auth.password_changed': 'password changed',
    'auth.sessions_revoked': 'sessions revoked',
    'alert.fired': 'alert fired',
    'alert.resolved': 'alert resolved',
    'update.checked': 'checked for updates',
  };
  return map[type] || String(type || 'event');
}
