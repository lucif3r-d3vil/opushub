// Update awareness — an explicit, user-triggered check against the GitHub releases API.
// Nothing here runs on a timer, at boot, or on any page load: OpusHub never phones home
// on its own. A check happens only when someone clicks "Check for updates" (POST
// /api/updates/check), fetches one small JSON document with a hard timeout, compares the
// tag against the running version, and caches the answer for six hours so repeated
// clicks don't hammer the API. Every failure mode (offline, rate-limited, unexpected
// payload, no releases yet) resolves to state 'unknown' with a human reason — never to
// a guessed version, never to silence.
import { versionInfo } from './version.js';

export const RELEASES_URL = 'https://api.github.com/repos/lucif3r-d3vil/opushub/releases/latest';
export const REPO_URL = 'https://github.com/lucif3r-d3vil/opushub';
export const CACHE_MS = 6 * 3600_000;
export const FETCH_TIMEOUT_MS = 10_000;

let cached = null; // { state, current, latest, url, checkedAt, reason }

/** Compare dotted versions. Returns 1 when a > b, -1 when a < b, 0 when equal/unknown. */
export function compareVersions(a, b) {
  if (!/\d/.test(String(a || '')) || !/\d/.test(String(b || ''))) return 0; // unknown — never order a guess
  const pa = String(a || '').replace(/^v/, '').split('.').map((x) => Number(x));
  const pb = String(b || '').replace(/^v/, '').split('.').map((x) => Number(x));
  if (pa.some((x) => !Number.isFinite(x)) || pb.some((x) => !Number.isFinite(x))) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

async function fetchLatest({ fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  // OPUSHUB_RELEASES_URL overrides the endpoint (tests, air-gapped mirrors) — the default is the
  // public releases API and nothing else is ever contacted.
  const endpoint = (process.env.OPUSHUB_RELEASES_URL || '').trim() || RELEASES_URL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      signal: ctrl.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'opushub-update-check' },
    });
    if (res.status === 404) return { tag: null, url: REPO_URL, note: 'no releases published yet' };
    if (res.status === 403 || res.status === 429) {
      return { tag: null, url: REPO_URL, note: 'GitHub rate-limited the check — try again later' };
    }
    if (!res.ok) return { tag: null, url: REPO_URL, note: `GitHub answered ${res.status}` };
    const body = await res.json().catch(() => null);
    const tag = body && typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : null;
    const url = body && typeof body.html_url === 'string' ? body.html_url : REPO_URL;
    if (!tag) return { tag: null, url, note: 'GitHub answered without a release tag' };
    return { tag, url, note: null };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return { tag: null, url: REPO_URL, note: aborted ? 'the check timed out after 10 seconds' : 'OpusHub could not reach github.com — offline?' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a check (explicit user action only). Fresh network answer unless a cached one is
 * younger than CACHE_MS and `force` is false. Always resolves — never throws.
 */
export async function checkForUpdates({ force = false, fetchImpl, timeoutMs } = {}) {
  if (!force && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached;
  const current = versionInfo().version;
  const { tag, url, note } = await fetchLatest({ fetchImpl, timeoutMs });
  let result;
  if (!tag) {
    result = { state: 'unknown', current, latest: null, url, checkedAt: Date.now(), reason: note };
  } else {
    const cmp = compareVersions(tag, current);
    result = {
      state: cmp > 0 ? 'available' : 'current',
      current, latest: tag, url, checkedAt: Date.now(),
      reason: cmp > 0 ? `${tag} is published; this install runs ${current}` : `this install runs ${current}, the newest published release`,
    };
  }
  cached = result;
  return result;
}

/** The last answer without touching the network — null until the first check. */
export function lastUpdateCheck() { return cached; }

/** Test helper. */
export function _resetUpdateCheck() { cached = null; }
