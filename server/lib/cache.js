// Server-side cache with a disk snapshot so provider data survives restarts.
import fs from 'node:fs';
import path from 'node:path';

export class TimedCache {
  constructor({ max = 128 } = {}) {
    this.map = new Map();
    this.max = max;
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expires > 0 && Date.now() > hit.expires) { this.map.delete(key); return null; }
    return hit.value;
  }
  set(key, value, ttlMs) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: ttlMs > 0 ? Date.now() + ttlMs : 0 });
  }
}

export function persistSnapshot(file, obj) {
  try { fs.writeFileSync(file + '.tmp', JSON.stringify(obj)); fs.renameSync(file + '.tmp', file); } catch { /* best-effort */ }
}

export function readSnapshot(dir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; }
}
