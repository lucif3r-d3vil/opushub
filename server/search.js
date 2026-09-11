// Unified search: pages · services · stacks · bookmarks · settings · recent news.
// A lightweight scoring pass — the client adds its own instant fuzzy layer on top.
import { readServices, readStacks, readBookmarks } from './model.js';

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

export function searchAll(q, { newsItems = [] } = {}) {
  const needle = String(q || '').toLowerCase().trim();
  const out = [];
  const add = (group, item, s) => { if (s > 8) out.push({ ...item, _s: s }); };

  for (const p of PAGES) add('Pages', { title: p.title, subtitle: p.hint, href: p.href, kind: 'page' }, score(needle, p.title, p.hint));

  try {
    const { groups } = readServices();
    for (const g of groups) {
      for (const s of g.services) {
        add('Services', {
          title: s.name, subtitle: [s.app, g.name].filter(Boolean).join(' · '),
          href: `/services/${encodeURIComponent(g.name)}/${encodeURIComponent(s.name)}`,
          kind: 'service', group: g.name, icon: s.icon, status: s.status || null,
        }, score(needle, s.name, s.app, s.description, ...s.keywords, g.name));
      }
    }
  } catch { /* config broken — search degrades, page still loads */ }

  try {
    const { stacks } = readStacks();
    for (const st of stacks) {
      add('Stacks', {
        title: st.name, subtitle: (st.services || []).slice(0, 4).join(', ') || 'stack',
        href: `/stacks/${encodeURIComponent(st.name)}`, kind: 'stack', icon: st.icon,
      }, score(needle, st.name, st.description, ...(st.services || [])));
    }
  } catch { /* ok */ }

  try {
    const { flat } = readBookmarks();
    for (const b of flat) {
      add('Bookmarks', { title: b.name, subtitle: b.group, href: b.href, kind: 'bookmark' }, score(needle, b.name, b.description, b.group));
    }
  } catch { /* ok */ }

  for (const n of newsItems.slice(0, 120)) {
    const s = score(needle, n.title, n.source);
    if (s > 8) out.push({ title: n.title, subtitle: `News · ${n.source || ''}`.trim(), href: n.link, kind: 'news', external: true, _s: s * 0.8 });
  }

  return out.sort((a, b) => b._s - a._s).slice(0, 24).map(({ _s, ...item }) => item);
}
