#!/usr/bin/env node
// Contrast check for the built-in backgrounds (docs/design/DESIGN.md §4).
//
// For every background it rasterises the CSS recipe in src/styles/shell.css (radial and linear
// gradients, then the scrim), puts a translucent tile on top, and measures the WORST contrast of the
// text colours against any pixel (no blur is assumed, so the brightest glow counts in full). It
// also checks text that sits directly on the background under its local plate. A `photo` can be any
// image, so it is checked against the worst possible one: pure white under the photo scrim.
//
// Exits 1 when anything falls below its floor, so `npm run check` fails the build. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// `--css <file>` and `--tokens <file>` point the check at other copies (the tests use them to prove it can fail)
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const shell = fs.readFileSync(arg('--css', path.join(root, 'src/styles/shell.css')), 'utf8');
const tokens = fs.readFileSync(arg('--tokens', path.join(root, 'src/styles/tokens.css')), 'utf8');

const FLOOR = { ink: 7, 'ink-2': 4.5, 'ink-3': 4.5 };   // WCAG AA for body text; primary text held higher
const GRID = [192, 108];                                // sample points across the viewport

// ---- colour helpers -------------------------------------------------------------------
const hex = (h) => { const m = h.replace('#', ''); const n = m.length === 3 ? [...m].map((c) => c + c) : m.match(/../g); return n.map((x) => parseInt(x, 16)); };
const rgba = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); const p = m[1].split(',').map((x) => parseFloat(x)); return [p[0], p[1], p[2], p[3] ?? 1]; };
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const over = (top, a, bottom) => top.map((c, i) => c * a + bottom[i] * (1 - a));
const colour = (s) => (s.trim().startsWith('#') ? [...hex(s.trim()), 1] : rgba(s));

// ---- tokens (the dark :root set) --------------------------------------------------------
const dark = tokens.slice(tokens.indexOf(':root {'), tokens.indexOf("html[data-theme='light']"));
const tok = (name) => { const m = dark.match(new RegExp(`--${name}:\\s*([^;]+);`)); if (!m) throw new Error(`token --${name} not found`); return m[1].trim(); };
const INK = { ink: hex(tok('ink')), 'ink-2': hex(tok('ink-2')), 'ink-3': hex(tok('ink-3')) };
const TILE = rgba(tok('tile'));
const plateFor = (id) => parseFloat((shell.match(new RegExp(`html\\[data-bg='${id}'\\]\\s*\\{[^}]*--plate:\\s*([\\d.]+)`)) || shell.match(/:root\s*\{\s*--plate:\s*([\d.]+)/))[1]);
const TILE_PHOTO = rgba((shell.match(/html\[data-bg='photo'\]\s*\{[^}]*--tile:\s*([^;]+);/) || [])[1] || tok('tile'));

// ---- the recipes ---------------------------------------------------------------------------
function splitTop(s) { const out = []; let depth = 0; let cur = ''; for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }

function recipe(id) {
  const m = shell.match(new RegExp(`html\\[data-bg='${id}'\\]\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no recipe for ${id}`);
  const body = m[1];
  const get = (n) => (body.match(new RegExp(`--${n}:\\s*([^;]+?)(?:;|$)`)) || [])[1];
  const art = body.slice(body.indexOf('--bg-art:') + 9).trim().replace(/;\s*$/, '');
  return { base: hex(get('bg-base') || '#0b0c0e'), top: parseFloat(get('scrim-top') || 0), bot: parseFloat(get('scrim-bot') || 0), layers: id === 'photo' ? [] : splitTop(art).map(parseLayer) };
}

function parseLayer(s) {
  let m = s.match(/^radial-gradient\(\s*([\d.]+)%\s+([\d.]+)%\s+at\s+([-\d.]+)%\s+([-\d.]+)%\s*,\s*(rgba?\([^)]*\))\s*,\s*transparent\s+([\d.]+)%\s*\)$/);
  if (m) return { kind: 'radial', rx: +m[1] / 100, ry: +m[2] / 100, cx: +m[3] / 100, cy: +m[4] / 100, c: rgba(m[5]), stop: +m[6] / 100 };
  m = s.match(/^linear-gradient\(\s*180deg\s*,\s*(#[0-9a-f]{3,6})\s*,\s*(#[0-9a-f]{3,6})\s+([\d.]+)%\s*\)$/i);
  if (m) return { kind: 'linear', a: hex(m[1]), b: hex(m[2]), stop: +m[3] / 100 };
  throw new Error(`cannot parse gradient layer: ${s}`);
}

function pixel(r, x, y) {
  // CSS lists the top layer first, so paint from the last layer upwards over the base colour
  let c = r.base.slice();
  for (let i = r.layers.length - 1; i >= 0; i--) {
    const L = r.layers[i];
    if (L.kind === 'linear') { const t = Math.min(1, Math.max(0, y / L.stop)); c = L.a.map((v, k) => v + (L.b[k] - v) * t); }
    else {
      const d = Math.hypot((x - L.cx) / L.rx, (y - L.cy) / L.ry) / L.stop;
      if (d < 1) c = over(L.c.slice(0, 3), L.c[3] * (1 - d), c);
    }
  }
  const a = r.top + (r.bot - r.top) * y;                    // the scrim, top to bottom
  return over([8, 9, 12], a, c);
}

// ---- measuring ---------------------------------------------------------------------------------
function measure(id, sample) {
  const worst = { ink: Infinity, 'ink-2': Infinity, 'ink-3': Infinity };
  const plated = { ink: Infinity, 'ink-2': Infinity };
  const tile = id === 'photo' ? TILE_PHOTO : TILE;
  for (let j = 0; j < GRID[1]; j++) {
    for (let i = 0; i < GRID[0]; i++) {
      const bg = sample(i / (GRID[0] - 1), j / (GRID[1] - 1));
      const onTile = over(tile.slice(0, 3), tile[3], bg);
      for (const k of Object.keys(worst)) worst[k] = Math.min(worst[k], ratio(INK[k], onTile));
      const onPlate = over([8, 9, 12], plateFor(id), bg);
      for (const k of Object.keys(plated)) plated[k] = Math.min(plated[k], ratio(INK[k], onPlate));
    }
  }
  return { tile: worst, plate: plated };
}

const ids = [...shell.matchAll(/html\[data-bg='([a-z]+)'\]\s*\{\s*--bg-base/g)].map((m) => m[1]);
const rows = []; let failed = false;
for (const id of ids) {
  const r = recipe(id);
  const sample = id === 'photo'
    ? () => over([8, 9, 12], 0.5 * (r.top + r.bot), [255, 255, 255])   // worst case: a pure white photo under the average scrim
    : (x, y) => pixel(r, x, y);
  // a white photo is brightest where the scrim is thinnest, so check it at the top edge too
  const m = id === 'photo' ? measure(id, (x, y) => over([8, 9, 12], r.top + (r.bot - r.top) * y, [255, 255, 255])) : measure(id, sample);
  rows.push({ id, ...m });
  for (const k of Object.keys(FLOOR)) {
    if (m.tile[k] < FLOOR[k]) { failed = true; console.error(`FAIL  ${id}: ${k} on a tile is ${m.tile[k].toFixed(2)}:1, needs ${FLOOR[k]}:1`); }
  }
  for (const k of ['ink', 'ink-2']) {
    if (m.plate[k] < FLOOR[k]) { failed = true; console.error(`FAIL  ${id}: ${k} on the background under its plate is ${m.plate[k].toFixed(2)}:1, needs ${FLOOR[k]}:1`); }
  }
}
const f = (n) => n.toFixed(2).padStart(5);
console.log('background   ink/tile  ink-2/tile  ink-3/tile  ink/plate  ink-2/plate   (worst pixel; floors 7 / 4.5 / 4.5)');
for (const r of rows) console.log(`${r.id.padEnd(12)} ${f(r.tile.ink)}     ${f(r.tile['ink-2'])}      ${f(r.tile['ink-3'])}      ${f(r.plate.ink)}      ${f(r.plate['ink-2'])}`);
if (failed) { console.error('\ncontrast check failed'); process.exit(1); }
console.log('\ncontrast check passed');
