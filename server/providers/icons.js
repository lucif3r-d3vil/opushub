// IconProvider — three tiers, best available wins:
//  1. Bundled local collections (@iconify-json/lucide, mdi, simple-icons) → works fully offline.
//  2. Iconify API proxy (any set) when the network is reachable → results cached to data/.
//  3. Local files in config/icons/ (served as /user/icons/*) → handled by static routes.
// Resolution order for an `IconRef`: url → /user/ path → set:name → emoji/letter (client fallback).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TimedCache } from '../lib/cache.js';
import { fetchText } from '../lib/net.js';
import { DATA_DIR, CONFIG_DIR } from '../configStore.js';

const require = createRequire(import.meta.url);
const COLLECTIONS = {
  lucide: '@iconify-json/lucide/icons.json',
  mdi: '@iconify-json/mdi/icons.json',
  si: '@iconify-json/simple-icons/icons.json',
};
const loaded = new Map();
function collection(set) {
  if (loaded.has(set)) return loaded.get(set);
  let data = null;
  try {
    data = require(COLLECTIONS[set]);
    data._names = new Set([...Object.keys(data.icons || {}), ...Object.keys(data.aliases || {})]);
    data._labelMap = data.icons;
  } catch { /* npm dep missing — degrade */ }
  loaded.set(set, data);
  return data;
}

function iconBody(set, name) {
  const col = collection(set);
  if (!col) return null;
  let def = col.icons?.[name] ?? col.aliases?.[name];
  if (def?.parent) def = col.icons?.[def.parent];
  if (!def || def.hidden) return null;
  return { body: def.body, width: def.width ?? col.width ?? 24, height: def.height ?? col.height ?? 24, name };
}

export function resolveIcon(ref, size = 24, color = 'currentColor') {
  if (!ref || typeof ref !== 'string') return null;
  const m = ref.match(/^([a-z0-9-]+):([a-z0-9+._-]+)$/i);
  if (m && COLLECTIONS[m[1]]) {
    const d = iconBody(m[1], m[2]);
    if (d) {
      const vb = `0 0 ${d.width} ${d.height}`;
      const svg = d.body.replace(/\[iconify-color\]/g, color);
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${size}" height="${size}" fill="none" aria-hidden="true" style="color:${color === 'currentColor' ? 'inherit' : color}">${svg.includes('currentColor') ? svg : `<g fill="currentColor">${svg}</g>`}</svg>`;
    }
  }
  return null;
}

export async function resolveRemote(set, name) {
  const hit = remoteCache.get(`${set}:${name}`);
  if (hit) return hit.svg ? { ...hit, cached: true } : null;
  try {
    const xml = await fetchText(`https://api.iconify.design/${set}.svg?icon=${encodeURIComponent(name)}&height=64`, { timeoutMs: 6000 });
    if (!xml.trim().startsWith('<svg')) return null;
    const val = { svg: xml };
    remoteCache.set(`${set}:${name}`, val, 30 * 24 * 3600_000);
    try { fs.mkdirSync(REMOTE_DIR, { recursive: true }); fs.writeFileSync(path.join(REMOTE_DIR, `${set}__${name}.svg`), xml); } catch { /* ok */ }
    return val;
  } catch {
    try {
      const file = path.join(REMOTE_DIR, `${set}__${name}.svg`);
      const svg = fs.readFileSync(file, 'utf8');
      remoteCache.set(`${set}:${name}`, { svg }, 30 * 24 * 3600_000);
      return { svg, cached: true };
    } catch { return null; }
  }
}

const REMOTE_DIR = path.join(DATA_DIR, 'icons-cache');
const remoteCache = new TimedCache({ max: 512 });
// preload disk-cached svgs lazily on miss above.

const REMOTE_SETS = ['mdi', 'lucide', 'si', 'tabler', 'ph', 'solar', 'noto', 'twemoji', 'logos', 'vscode-icons', 'heroicons', 'radix-icons', 'flat-color-icons'];

export function searchLocal(q, limit = 60) {
  const needle = String(q || '').toLowerCase().trim();
  const results = [];
  for (const set of Object.keys(COLLECTIONS)) {
    const col = collection(set);
    if (!col) continue;
    const names = col._names;
    for (const name of names) {
      if (!needle || name.includes(needle) || needle.includes(name)) {
        const label = name.replace(/-/g, ' ');
        results.push({ ref: `${set}:${name}`, set, name, label, local: true });
        if (results.length >= limit) {
          return { results: rank(results, needle), remote: { status: 'not-needed' } };
        }
      }
    }
  }
  return { results: rank(results, needle), remote: { status: 'skip-local-was-enough' } };
}

function rank(results, needle) {
  return results
    .map((r) => {
      let s = 0;
      const base = r.name;
      if (base === needle) s += 100;
      if (base.startsWith(needle)) s += 40;
      if (base.split('-').some((p) => p === needle)) s += 30;
      s += base.split('-').some((p) => p.startsWith(needle)) ? 12 : 0;
      if (r.set === 'lucide') s += 4; else if (r.set === 'si') s += 3; else s += 2;
      if (base.length < 22) s += 2;
      return { ...r, _s: s };
    })
    .sort((a, b) => b._s - a._s || a.ref.localeCompare(b.ref))
    .slice(0, 100)
    .map(({ _s, ...r }) => r);
}

export async function search(q, limit = 60) {
  const local = searchLocal(q, limit);
  // Augment with remote Iconify search for other sets (and better ranking), network-permitting.
  try {
    const j = await fetchText(`https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=${Math.min(64, limit * 2)}`, { timeoutMs: 4500 });
    const data = JSON.parse(j);
    const extra = [];
    for (const [key, meta] of Object.entries(data.icons || {})) {
      if (COLLECTIONS[key.split(':')[0]]) continue; // dedupe against local sets
      if (!REMOTE_SETS.includes(key.split(':')[0])) continue;
      extra.push({ ref: key, set: key.split(':')[0], name: key.split(':')[1], label: (meta.name || key.split(':')[1]).toLowerCase(), local: false });
    }
    return {
      results: rank([...local.results, ...extra], String(q || '').toLowerCase().trim()).slice(0, limit),
      total: data.total,
      remote: { status: 'ok' },
    };
  } catch (err) {
    return { ...local, remote: { status: 'unavailable', reason: err.message } };
  }
}

export async function iconSvg(ref, size = 64) {
  const svg = resolveIcon(ref, size);
  if (svg) return { svg };
  const m = String(ref).match(/^([a-z0-9-]+):([a-z0-9+._-]+)$/i);
  if (m) {
    const remote = await resolveRemote(m[1], m[2]);
    if (remote) return { svg: remote.svg, remote: true, cached: remote.cached };
  }
  return null;
}

export function listLocalFiles() {
  const dir = path.join(CONFIG_DIR, 'icons');
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(svg|png|jpe?g|webp|gif|avif)$/i.test(f))
      .map((f) => ({ ref: `/user/icons/${encodeURIComponent(f)}`, name: f }));
  } catch { return []; }
}
