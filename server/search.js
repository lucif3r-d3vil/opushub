// Unified search: pages · services · stacks · bookmarks · settings · recent news.
// Services and stacks come from the SAME canonical inventory the Hub, Services and Stacks pages
// render — one model, so search can never offer something that isn't a container, or hide
// something that is. (Bookmarks and pages are OpusHub's own surfaces, not infrastructure.)
// A lightweight scoring pass — the client adds its own instant fuzzy layer on top.
import { readBookmarks, getInventory } from './model.js';

const PAGES = [
  { title: 'Hub', href: '/', hint: 'Your digital home', kind: 'page', keywords: ['home', 'start', 'dashboard'] },
  { title: 'Services', href: '/services', hint: 'Everything you run', kind: 'page', keywords: ['apps', 'containers'] },
  { title: 'Stacks', href: '/stacks', hint: 'Groups of containers', kind: 'page', keywords: ['compose', 'projects'] },
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
  { title: 'System & discovery', href: '/settings/system', hint: 'Engine status, URL sources, unmatched overlays', keywords: ['docker', 'engine', 'socket', 'discovery', 'unmatched', 'env', 'paths'] },
  { title: 'Advanced', href: '/settings/advanced', hint: 'Custom CSS & JS, refresh intervals, launch logging', keywords: ['custom css', 'custom js', 'theme.css', 'app.js', 'advanced', 'refresh', 'poll', 'launch log'] },
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
const KIND_WEIGHT = { service: 1, stack: 1, page: 0.92, setting: 0.88, bookmark: 0.85, news: 0.75 };

export async function searchAll(q, { newsItems = [] } = {}) {
  const needle = String(q || '').toLowerCase().trim();
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
    for (const st of inv.stacks) {
      add({
        title: st.name,
        subtitle: [st.project ? `compose · ${st.project}` : 'stack', `${st.containerCount} container${st.containerCount === 1 ? '' : 's'}`].join(' · '),
        href: `/stacks/${encodeURIComponent(st.id)}`,
        kind: 'stack', icon: st.icon, status: st.status,
      }, score(needle, st.name, st.displayName, st.project, st.description, ...st.services), KIND_WEIGHT.stack);
    }
  }

  try {
    const { flat } = readBookmarks();
    for (const b of flat) {
      add({ title: b.name, subtitle: b.group, href: b.href, kind: 'bookmark' }, score(needle, b.name, b.description, b.group), KIND_WEIGHT.bookmark);
    }
  } catch { /* ok */ }

  for (const n of newsItems.slice(0, 120)) {
    add({ title: n.title, subtitle: `News · ${n.source || ''}`.trim(), href: n.link, kind: 'news', external: true }, score(needle, n.title, n.source), KIND_WEIGHT.news);
  }

  return out.sort((a, b) => b._s - a._s).slice(0, 24).map(({ _s, ...item }) => item);
}
