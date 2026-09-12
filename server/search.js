// Unified search: pages · services · stacks · bookmarks · settings · recent news.
// Services and stacks come from the SAME canonical inventory the Hub, Services and Stacks pages
// render — one model, so search can never offer something that isn't a container, or hide
// something that is. (Bookmarks and pages are OpusHub's own surfaces, not infrastructure.)
// A lightweight scoring pass — the client adds its own instant fuzzy layer on top.
import { readBookmarks, getInventory } from './model.js';

const PAGES = [
  { title: 'Hub', href: '/', hint: 'Your digital home', kind: 'page' },
  { title: 'Services', href: '/services', hint: 'Everything you run', kind: 'page' },
  { title: 'Stacks', href: '/stacks', hint: 'Groups of containers', kind: 'page' },
  { title: 'System', href: '/system', hint: 'Host vitals', kind: 'page' },
  { title: 'Activity', href: '/activity', hint: 'What happened, when', kind: 'page' },
  { title: 'Settings', href: '/settings/appearance', hint: 'Appearance, hub, services, integrations', kind: 'page' },
  { title: 'Icon browser', href: '/icons', hint: 'Find icons for your services', kind: 'page' },
];

function score(needle, ...fields) {
  if (!needle) return 20;
  let best = 0;
  for (const raw of fields) {
    if (!raw) continue;
    const hay = String(raw).toLowerCase();
    const idx = hay.indexOf(needle);
    if (idx === 0) best = Math.max(best, 100);
    else if (idx > 0) best = Math.max(best, 60 - Math.min(30, idx));
    else {
      // subsequence
      let i = 0;
      for (const ch of hay) if (ch === needle[i]) i++;
      if (i === needle.length) best = Math.max(best, 25 - Math.min(20, hay.length / 4));
    }
  }
  return best;
}

export async function searchAll(q, { newsItems = [] } = {}) {
  const needle = String(q || '').toLowerCase().trim();
  const out = [];
  const add = (item, s, weight = 1) => { if (s > 8) out.push({ ...item, _s: s * weight }); };

  for (const p of PAGES) add({ title: p.title, subtitle: p.hint, href: p.href, kind: 'page' }, score(needle, p.title, p.hint));

  // the one canonical inventory: containers, their resolved URLs, and their presentation overlay
  let inv = null;
  try { inv = await getInventory(); } catch { /* discovery failed — search still answers with pages/bookmarks */ }

  if (inv) {
    for (const s of inv.services) {
      if (s.hidden) continue;
      add({
        title: s.displayName,
        subtitle: [s.kind === 'infrastructure' ? 'infrastructure' : s.group, s.container.state === 'running' ? 'running' : s.container.state].filter(Boolean).join(' · '),
        href: `/services/${encodeURIComponent(s.group || 'Other')}/${encodeURIComponent(s.name)}`,
        kind: 'service', group: s.group, icon: s.icon, status: s.status, url: s.url,
      }, score(needle, s.displayName, s.name, s.container.composeService, s.container.image, s.description, s.app, ...(s.keywords || []), s.group));
    }
    for (const st of inv.stacks) {
      add({
        title: st.name,
        subtitle: [st.project ? `compose · ${st.project}` : 'stack', `${st.containerCount} container${st.containerCount === 1 ? '' : 's'}`].join(' · '),
        href: `/stacks/${encodeURIComponent(st.id)}`,
        kind: 'stack', icon: st.icon, status: st.status,
      }, score(needle, st.name, st.displayName, st.project, st.description, ...st.services));
    }
  }

  try {
    const { flat } = readBookmarks();
    for (const b of flat) {
      add({ title: b.name, subtitle: b.group, href: b.href, kind: 'bookmark' }, score(needle, b.name, b.description, b.group));
    }
  } catch { /* ok */ }

  for (const n of newsItems.slice(0, 120)) {
    add({ title: n.title, subtitle: `News · ${n.source || ''}`.trim(), href: n.link, kind: 'news', external: true }, score(needle, n.title, n.source), 0.8);
  }

  return out.sort((a, b) => b._s - a._s).slice(0, 24).map(({ _s, ...item }) => item);
}
