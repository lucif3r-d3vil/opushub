// OpusHub — configuration & environment discovery.
// Fixes the historical ".env was provided but never found" failure mode by searching an
// explicit, logged order instead of assuming one hard-coded path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Resolve the YAML config directory. First existing candidate wins; last resort: create app-root/config. */
export function resolveConfigDir() {
  const candidates = [];
  if (process.env.OPUSHUB_CONFIG_DIR) candidates.push(process.env.OPUSHUB_CONFIG_DIR);
  candidates.push(path.join(APP_ROOT, 'config'));
  if (process.env.HOMEPAGE_DIR) candidates.push(process.env.HOMEPAGE_DIR);
  candidates.push('/app/config');
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return { dir: c, created: false };
    } catch { /* next */ }
  }
  const dir = path.join(APP_ROOT, 'config');
  fs.mkdirSync(dir, { recursive: true });
  return { dir, created: true };
}

/** Parse .env text: KEY=VALUE, quotes, `export` prefix, comments. */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      const q = value[0];
      value = value.slice(1, -1);
      if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Discover and load .env files. Order (first existing file wins per key):
 *   1. $OPUSHUB_ENV_FILE            explicit override
 *   2. <configDir>/.env             next to the YAML config (recommended)
 *   3. <appRoot>/config/.env
 *   4. <appRoot>/.env
 *   5. $HOMEPAGE_DIR/.env           migration from a Homepage install
 *   6. /app/config/.env             container convention
 * Real process.env always beats file values.
 */
export function loadEnv(configDir) {
  const candidates0 = [];
  if (process.env.OPUSHUB_ENV_FILE) candidates0.push(process.env.OPUSHUB_ENV_FILE);
  candidates0.push(path.join(configDir, '.env'));
  candidates0.push(path.join(APP_ROOT, 'config', '.env'));
  candidates0.push(path.join(APP_ROOT, '.env'));
  if (process.env.HOMEPAGE_DIR) candidates0.push(path.join(process.env.HOMEPAGE_DIR, '.env'));
  candidates0.push('/app/config/.env');

  const seen = new Set();
  const candidates = candidates0.filter((c) => { const k = path.resolve(c); if (seen.has(k)) return false; seen.add(k); return true; });
  const tried = [];
  const loaded = []; // { file, keys: [...] } — names only, values never recorded
  for (const file of candidates) {
    tried.push(file);
    try {
      const text = fs.readFileSync(file, 'utf8');
      const vars = parseEnv(text);
      let applied = 0;
      for (const [key, value] of Object.entries(vars)) {
        if (process.env[key] === undefined) {
          process.env[key] = value;
          applied++;
        }
      }
      loaded.push({ file, keys: Object.keys(vars), applied });
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EISDIR' && err.code !== 'ENOTDIR') {
        loaded.push({ file, error: String(err.message || err), keys: [], applied: 0 });
      }
    }
  }
  return { tried, loaded };
}

export function resolveDataDir() {
  const dir = process.env.OPUSHUB_DATA_DIR || path.join(APP_ROOT, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
