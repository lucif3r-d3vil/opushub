// Minimal RSS 2.0 / Atom parser — enough for homelab-configured news feeds.
import { decodeEntities, stripHtml } from './net.js';

function block(src, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

function field(item, ...tags) {
  for (const tag of tags) {
    const m = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
    if (m && m[1].trim()) return decodeEntities(m[1].trim());
    const self = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?/>`, 'i'));
    if (self) return '';
  }
  return '';
}

function attr(src, tag, name) {
  const m = src.match(new RegExp(`<${tag}\\s[^>]*${name}="([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function firstImage(item, desc) {
  const media = item.match(/<media:(?:content|thumbnail)[^>]*url="([^"]+)"/i);
  if (media) return decodeEntities(media[1]);
  const img = (desc || '').match(/<img[^>]+src="([^"]+)"/i);
  if (img) return decodeEntities(img[1]);
  const enclosure = item.match(/<enclosure[^>]*type="image[^>]*url="([^"]+)"/i);
  return enclosure ? decodeEntities(enclosure[1]) : '';
}

export function parseFeed(xml, feedName = '') {
  const src = String(xml || '');
  const isAtom = /<feed[\s>]/i.test(src) && !/<rss[\s>]/i.test(src);
  const feedTitle = isAtom ? field(src, 'title') : field(src.match(/<channel[\s\S]*?<\/channel>/i)?.[0] ?? src, 'title');
  const items = isAtom ? block(src, 'entry') : block(src, 'item');
  const out = [];
  for (const item of items.slice(0, 60)) {
    const desc = field(item, 'description', 'summary', 'content:encoded', 'content');
    const link = isAtom
      ? (attr(item, 'link', 'href') || field(item, 'id'))
      : field(item, 'link');
    const date = field(item, 'pubDate', 'published', 'updated', 'dc:date') || field(item, 'date');
    const parsed = date ? new Date(date) : null;
    out.push({
      title: stripHtml(field(item, 'title')) || '(untitled)',
      link,
      source: feedName || stripHtml(feedTitle) || null,
      publishedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
      summary: stripHtml(desc).slice(0, 220) || null,
      image: firstImage(item, desc) || null,
    });
  }
  return { feedTitle: stripHtml(feedTitle) || feedName || null, items: out };
}
