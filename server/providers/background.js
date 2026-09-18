// Background image URLs — server-side validation and resolution.
//
// Settings → Background accepts three kinds of value, and this module is the single place
// that decides what a value may be before it is stored or rendered:
//
//   · a direct image URL  (https://…)        — verified against the real host before it is
//                                              accepted: it must answer 200 with image bytes
//   · an Unsplash photo page  (https://unsplash.com/photos/<id>)
//                                              — resolved to the photo's direct image URL via
//                                              Unsplash's public JSON endpoint (napi). This is a
//                                              scoped, JSON-only call to one pinned host — no
//                                              HTML is fetched or parsed.
//   · a same-origin file  (/user/backgrounds/<file>)
//                                              — validated against config/backgrounds on disk.
//
// Security boundary (this module must never become a fetch oracle into the local network):
//   · remote URLs must be https: — http:// is refused outright
//   · the hostname is resolved and every address it yields must be a globally routable IP:
//     loopback, link-local (incl. the 169.254.169.254 cloud-metadata range), RFC1918,
//     CGNAT, multicast, documentation and the IPv6 equivalents are all refused
//   · after following redirects the FINAL url is checked with the same rules (a 302 to an
//     internal host is still a 302 to an internal host)
//   · the probe reads at most 64 KB and never returns the body to the client — the API
//     answers { ok, url | error } and nothing else
//   · the only host resolved on the user's behalf for anything other than a probe is
//     unsplash.com, with a path segment restricted to [A-Za-z0-9_-]

import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../configStore.js';
import { TimedCache } from '../lib/cache.js';
import { remoteFetchBlocked } from '../lib/ipPolicy.js';
import { fetchJson } from '../lib/net.js';

const PROBE_TIMEOUT_MS = Number(process.env.OPUSHUB_BACKGROUND_PROBE_MS || 9000);
const UNSPLASH_TIMEOUT_MS = 9000;
const PROBE_MAX_BYTES = 64 * 1024;
const UA = 'OpusHub/0.1 (homelab control center)';

// photo ids look like _LuLiJc1cdo (they may START with an underscore); slugs extend that
const UNSPLASH_PAGE_RE = /^https:\/\/unsplash\.com\/photos\/([A-Za-z0-9_-][A-Za-z0-9_-]{0,79})\/?$/;
const UNSPLASH_CDN_HOST = 'images.unsplash.com';
const BG_FILE_RE = /^\/user\/backgrounds\/[A-Za-z0-9][A-Za-z0-9._ -]{0,180}\.(svg|png|jpe?g|webp|avif|gif|bmp|tif?f)$/i;

const checkCache = new TimedCache({ max: 64 });
const CHECK_TTL = 10 * 60 * 1000;

// the DNS lookup used for the host check — injectable so API-level tests run without a network
let lookupFn = dns.lookup;
export function __setBackgroundLookup(fn) { lookupFn = fn || dns.lookup; }

// a light per-minute meter so a misbehaving client cannot use the endpoint as a fetch proxy
let probeMinute = 0;
let probeCount = 0;
const PROBES_PER_MINUTE = 20;
function meterProbe() {
  const now = Math.floor(Date.now() / 60_000);
  if (now !== probeMinute) { probeMinute = now; probeCount = 0; }
  if (++probeCount > PROBES_PER_MINUTE) return false;
  return true;
}

/**
 * Is this address one the server must not fetch?
 *
 * The classification lives in `server/lib/ipPolicy.js` — one implementation of "loopback,
 * link-local (cloud metadata lives here), private, CGNAT, multicast, documentation, and the IPv6
 * twins of all of it", shared with the Phase 10A monitoring engine (which needs the same
 * classification with a different block list, because LAN services are legitimate monitor
 * targets). `remoteFetchBlocked` is the *shipped* policy of this module, kept verbatim.
 */
const isBlockedIp = (ip) => remoteFetchBlocked(ip);

/**
 * Refuse a hostname whose resolution reaches anywhere the server must not fetch.
 * `lookup` is injectable for tests.
 */
export async function assertPublicHost(hostname, lookup = lookupFn) {
  const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    let result;
    try {
      result = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new Error(`could not resolve the host for this URL`);
    }
    if (!Array.isArray(result) || !result.length) throw new Error(`could not resolve the host for this URL`);
    addresses = result.map((r) => r.address);
  }
  for (const ip of addresses) {
    if (isBlockedIp(ip)) throw new Error('this URL points at a network address OpusHub must not fetch (private, loopback or link-local)');
  }
  return addresses;
}

function looksLikeImageBytes(buf) {
  const b = buf;
  if (b.length < 4) return false;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;                 // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true; // GIF
  if (b[0] === 0x42 && b[1] === 0x4d) return true;                                  // BMP
  if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) return true; // TIFF
  if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) return true;
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b.length >= 12
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true; // WEBP
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {              // ISOBMFF (avif…)
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1' || brand === 'heic') return true;
  }
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return true;  // ICO
  const head = Buffer.from(b).toString('utf8', 0, Math.min(b.length, 512)).replace(/^[\uFEFF\s<]*<!\[CDATA\[/, '').trimStart();
  return head.startsWith('<svg') || head.startsWith('<?xml'); // SVG
}

async function readHead(res, cap = PROBE_MAX_BYTES) {
  const reader = res.body?.getReader?.();
  if (!reader) return new Uint8Array(0);
  const parts = [];
  let n = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
      if (n >= cap) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; if (o >= cap) break; }
  return out.subarray(0, cap);
}

/**
 * Probe one https URL and say whether it serves an image. The body is never returned —
 * only the verdict. `fetchImpl` is injectable for tests.
 */
export async function probeImageUrl(url, { fetchImpl = fetch, lookup = lookupFn } = {}) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'That is not a valid URL.' }; }
  if (u.protocol !== 'https:') {
    return { ok: false, error: u.protocol === 'http:' ? 'Use https:// for background images — plain http is not allowed.' : 'Only https:// image URLs are supported.' };
  }
  try {
    await assertPublicHost(u.hostname, lookup);
  } catch (err) {
    return { ok: false, error: String(err?.message || 'refused host') };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(u.toString(), {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5' },
    });
    // a redirect may land anywhere — the final target is held to the same rules
    const finalUrl = res.url ? new URL(res.url) : null;
    if (finalUrl) {
      if (finalUrl.protocol !== 'https:') return { ok: false, error: 'The URL redirects to a non-https target, which is not allowed.' };
      try {
        await assertPublicHost(finalUrl.hostname, lookup);
      } catch (err) {
        return { ok: false, error: `The URL redirects to ${String(err?.message || 'a refused target')}.` };
      }
    }
    if (res.status === 404 || res.status === 410) {
      return { ok: false, error: 'The image no longer exists at that address (the host answered 404).' };
    }
    if (!res.ok) {
      return { ok: false, error: `The image host refused the request (HTTP ${res.status}).` };
    }
    const ct = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const head = await readHead(res);
    const isImageType = ct.startsWith('image/');
    const ambiguous = ct === '' || ct === 'application/octet-stream' || ct === 'application/binary';
    if (isImageType) return { ok: true, url: u.toString(), contentHint: ct };
    if (ambiguous && head.length && looksLikeImageBytes(head)) return { ok: true, url: u.toString(), contentHint: 'image (sniffed)' };
    if (ct === 'text/html') {
      return { ok: false, error: 'That URL serves a web page, not an image. Paste a direct link to an image file (.jpg / .png / .webp), or an Unsplash photo page.' };
    }
    return { ok: false, error: `That URL does not serve an image (content-type: ${ct || 'unknown'}).` };
  } catch (err) {
    if (err?.name === 'AbortError' || /timeout/i.test(String(err?.message || err))) {
      return { ok: false, error: 'The image host did not answer in time.' };
    }
    return { ok: false, error: `Could not reach the image host (${String(err?.cause?.code || err?.message || 'network error')}).` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve an Unsplash photo page URL to its direct image URL, through the public napi JSON
 * endpoint. The only outbound call is to unsplash.com itself; the resolved URL must live on
 * the pinned CDN host. `fetchImpl` is injectable for tests.
 *
 * Unsplash pages come in two shapes:
 *   https://unsplash.com/photos/<id>               (just the id)
 *   https://unsplash.com/photos/<slug>-<id>         (description + id)
 * The id itself may start with underscore and may contain hyphens/underscores.
 * The napi endpoint expects just the id, not the full slug. To be robust, we try:
 *   1. the full captured segment (covers the <id>-only case and any future where the API accepts slug)
 *   2. the substring after the last hyphen (covers <slug>-<id> where id is after last hyphen)
 * If both 404, we report not found. This keeps the security boundary (still only unsplash.com,
 * still only [A-Za-z0-9_-] chars) while fixing the common case where a user pastes a page URL
 * with a descriptive slug.
 */
export async function resolveUnsplashPage(input, { fetchImpl = fetch, lookup = lookupFn } = {}) {
  const m = UNSPLASH_PAGE_RE.exec(String(input).trim());
  if (!m) return { ok: false, error: 'Only https://unsplash.com/photos/<id> photo pages are resolved.' };
  const fullSlug = m[1];

  // Build candidate id list: full slug, then id after last hyphen (if different).
  const candidates = [fullSlug];
  const lastHyphen = fullSlug.lastIndexOf('-');
  if (lastHyphen > 0 && lastHyphen < fullSlug.length - 1) {
    const after = fullSlug.slice(lastHyphen + 1);
    if (after && after !== fullSlug && /^[A-Za-z0-9_-]+$/.test(after)) candidates.push(after);
  }

  // Also validate unsplash.com itself is public (defense-in-depth, though pinned host)
  try {
    await assertPublicHost('unsplash.com', lookup);
  } catch (err) {
    return { ok: false, error: String(err?.message || 'refused host') };
  }

  let lastErr = null;
  for (const photoId of candidates) {
    try {
      // The napi endpoint is JSON-only and pinned to unsplash.com; no HTML is fetched.
      const doc = await fetchJson(`https://unsplash.com/napi/photos/${encodeURIComponent(photoId)}`, {
        timeoutMs: UNSPLASH_TIMEOUT_MS,
        headers: { 'user-agent': UA, accept: 'application/json' },
      });
      const raw = doc?.urls?.raw;
      if (typeof raw !== 'string') throw new Error('photo not found');
      const u = new URL(raw);
      if (u.protocol !== 'https:' || u.hostname !== UNSPLASH_CDN_HOST) throw new Error('unexpected image host');
      // Final CDN host must also be public
      try {
        await assertPublicHost(u.hostname, lookup);
      } catch (err) {
        return { ok: false, error: String(err?.message || 'refused host') };
      }
      return { ok: true, url: u.toString(), resolvedFrom: input };
    } catch (err) {
      lastErr = err;
      // If it's a 404, try next candidate; otherwise break to generic error
      if (!/HTTP 404|not found/i.test(String(err?.message || err))) {
        if (/timeout/i.test(String(err?.message || err))) return { ok: false, error: 'Unsplash did not answer in time — try again.' };
        // For other errors, stop retrying and report generic failure
        break;
      }
      // 404: try next candidate if any
      continue;
    }
  }

  if (lastErr && /HTTP 404|not found/i.test(String(lastErr?.message || lastErr))) {
    return { ok: false, error: 'Unsplash could not find that photo — the link may be wrong or removed.' };
  }
  if (lastErr && /timeout/i.test(String(lastErr?.message || lastErr))) {
    return { ok: false, error: 'Unsplash did not answer in time — try again.' };
  }
  return { ok: false, error: 'Unsplash could not resolve that photo page.' };
}

/**
 * The one entry point: validate a background value the way Settings stores it.
 * Returns { ok: true, url } where `url` is what should be rendered, or { ok: false, error }.
 */
export async function checkBackgroundUrl(input, opts = {}) {
  const value = input == null ? '' : String(input).trim();
  if (!value) return { ok: true, url: null }; // clearing the background is always fine

  const hit = checkCache.get(value);
  if (hit) return hit;

  let result;
  if (BG_FILE_RE.test(value)) {
    // same-origin file — no network at all
    const name = value.slice('/user/backgrounds/'.length);
    const file = path.normalize(path.join(CONFIG_DIR, 'backgrounds', name));
    const inside = file.startsWith(path.join(CONFIG_DIR, 'backgrounds') + path.sep);
    const ok = inside && fs.existsSync(file) && fs.statSync(file).isFile();
    result = ok
      ? { ok: true, url: value, kind: 'file' }
      : { ok: false, error: `No file named “${name}” in config/backgrounds/ — drop the image there, or paste a URL.` };
  } else if (value.startsWith('/')) {
    result = { ok: false, error: 'Relative paths must live under /user/backgrounds/ (config/backgrounds/ on disk).' };
  } else if (/^https:\/\//i.test(value)) {
    const trimmed = value.trim();
    if (UNSPLASH_PAGE_RE.test(trimmed)) {
      result = await resolveUnsplashPage(trimmed, opts);
      if (result.ok) result.kind = 'unsplash';
    } else {
      if (!meterProbe()) {
        result = { ok: false, error: 'Too many URL checks in a short time — wait a minute and try again.' };
      } else {
        result = await probeImageUrl(trimmed, opts);
        if (result.ok) result.kind = 'direct';
      }
    }
  } else if (/^http:\/\//i.test(value)) {
    result = { ok: false, error: 'Use https:// for background images — plain http is not allowed.' };
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    result = { ok: false, error: 'Only https:// image URLs (or /user/backgrounds/ files) are supported.' };
  } else {
    result = { ok: false, error: 'Paste a full URL — it must start with https:// or /user/backgrounds/.' };
  }

  if (result.ok && result.url) checkCache.set(value, result, CHECK_TTL);
  return result;
}

/** Test hook: reset the verdict cache between runs. */
export function __resetBackgroundChecks() {
  checkCache.map.clear();
  probeMinute = 0;
  probeCount = 0;
}
