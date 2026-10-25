// Server-side in-memory cache with per-entry TTL and a bounded size.

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
