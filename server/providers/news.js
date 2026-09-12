// NewsProvider — server-side RSS/Atom fetch (also avoids browser CORS). Feeds come from
// config/settings.yaml → integrations.news.feeds. Zero feeds configured is an honest empty
// state, not an error. Per-feed failures carry their real reason.
import { TimedCache } from '../lib/cache.js';
import { fetchText } from '../lib/net.js';
import { parseFeed } from '../lib/feed.js';

const cache = new TimedCache({ max: 64 });
const TTL = 10 * 60 * 1000;

export async function getNews(feeds, { limit = 40 } = {}) {
  const list = Array.isArray(feeds) ? feeds.filter((f) => f && f.url) : [];
  if (!list.length) {
    return { status: 'unconfigured', reason: 'No RSS or Atom feeds configured.', items: [], errors: [] };
  }
  const items = [];
  const errors = [];
  const results = await Promise.all(list.map(async (feed) => {
    const cached = cache.get(feed.url);
    if (cached) return { feed, ...cached };
    try {
      const xml = await fetchText(feed.url, { timeoutMs: 9000, headers: feed.headers || undefined });
      const parsed = parseFeed(xml, feed.name || null);
      const val = { ok: true, items: parsed.items, feedTitle: parsed.feedTitle };
      cache.set(feed.url, val, TTL);
      return { feed, ...val };
    } catch (err) {
      const val = { ok: false, error: String(err.message || err) };
      cache.set(feed.url, val, Math.min(TTL, 60_000)); // remember failures briefly, retry sooner
      return { feed, ...val };
    }
  }));
  let anyOk = false;
  for (const r of results) {
    if (r.ok) {
      anyOk = true;
      const hostName = (() => { try { return new URL(r.feed.url).host; } catch { return null; } })();
      // A compromised feed must not smuggle javascript:/data: URLs into the client's hrefs.
      for (const it of r.items) {
        items.push({
          ...it,
          link: /^https?:\/\//i.test(it.link || '') ? it.link : '',
          image: it.image && /^https?:\/\//i.test(it.image) ? it.image : null,
          source: it.source || r.feed.name || r.feedTitle || hostName,
        });
      }
    } else {
      errors.push({ url: r.feed.url, name: r.feed.name || null, error: r.error });
    }
  }
  items.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  const status = !anyOk ? 'error' : errors.length ? 'partial' : 'ok';
  return {
    status,
    reason: !anyOk ? `all ${list.length} feed(s) failed: ${errors[0]?.error}` : errors.length ? `${errors.length} feed(s) unreachable` : null,
    items: items.slice(0, limit),
    errors,
    fetchedAt: Date.now(),
    nextRefreshAt: Date.now() + TTL,
  };
}
