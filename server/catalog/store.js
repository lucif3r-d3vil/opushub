// Install records — DATA_DIR/catalog/installs.json. History only: Docker remains the source of
// truth for what exists. A record says what OpusHub was asked to install, with which result;
// it never carries secrets (variables are not stored, only the shape of the install).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../configStore.js';

const DIR = path.join(DATA_DIR, 'catalog');
const FILE = path.join(DIR, 'installs.json');
const MAX = 200;
let cache = null;

function load() {
  if (cache) return cache;
  try { cache = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { installs: [] }; } catch { cache = { installs: [] }; }
  if (!Array.isArray(cache.installs)) cache.installs = [];
  return cache;
}
function persist() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export function recordInstall({ manifest, name, image, version, status, error = null, operationId = null, actor = null, report = null, config = null, at = Date.now() }) {
  const db = load();
  const entry = { id: crypto.randomBytes(8).toString('hex'), at, manifest, name, image, version, status, error, operationId, actor, report, config };
  db.installs.unshift(entry);
  if (db.installs.length > MAX) db.installs.length = MAX;
  persist();
  return entry;
}

export function listInstalls({ limit = 50, manifest = null } = {}) {
  return load().installs.filter((i) => !manifest || i.manifest === manifest).slice(0, limit);
}

export function _resetCatalogStore() { cache = null; try { fs.rmSync(FILE, { force: true }); } catch {} }
