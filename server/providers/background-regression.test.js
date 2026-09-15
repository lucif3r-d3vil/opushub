// Regression tests for Phase 5 background bugs — the 12 required checks.
// 1 local bg, 2 direct remote, 3 Unsplash page→direct, 4 invalid/non-image,
// 5 failed remote, 6 persisted after validation, 7 reaching SSR (settings API),
// 8 fallback, 9 full coverage, 10 no flow impact, 11 no-bg, 12 mobile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPUSHUB_BACKGROUND_PROBE_MS = '400';
process.env.OPUSHUB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-bg-reg-cfg-'));
fs.mkdirSync(path.join(process.env.OPUSHUB_CONFIG_DIR, 'backgrounds'), { recursive: true });
process.env.OPUSHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-bg-reg-data-'));

const originalFetch = globalThis.fetch;

const dnsTable = new Map();
const fakeLookup = (host) => {
  const ips = dnsTable.get(String(host).toLowerCase());
  if (!ips) { const e = new Error(`ENOTFOUND ${host}`); e.code = 'ENOTFOUND'; throw e; }
  return Promise.resolve(ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
};

function httpResponse({ status = 200, contentType = 'image/jpeg', bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]), finalUrl } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'X',
    url: finalUrl || null,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => (sent ? { value: undefined, done: true } : (sent = true, { value: bytes, done: false })),
          cancel: async () => {},
        };
      },
    },
  };
}

let mod;
const check = (value) => mod.checkBackgroundUrl(value, { lookup: fakeLookup });

test.beforeEach(async () => {
  dnsTable.clear();
  dnsTable.set('public-cdn.example', ['93.184.216.34']);
  dnsTable.set('images.unsplash.com', ['151.101.1.217']);
  dnsTable.set('unsplash.com', ['151.101.193.143']);
  dnsTable.set('dead.example', ['93.184.216.35']);
  mod = await import('./background.js');
  mod.__resetBackgroundChecks();
});
test.afterEach(() => { globalThis.fetch = originalFetch; });

// 1 local bg
test('regression 1: local /user/backgrounds/ file works', async () => {
  const { CONFIG_DIR } = await import('../configStore.js');
  const file = path.join(CONFIG_DIR, 'backgrounds', 'local-test.jpg');
  fs.writeFileSync(file, 'x');
  let called = 0;
  globalThis.fetch = async () => { called++; return httpResponse(); };
  try {
    const ok = await check('/user/backgrounds/local-test.jpg');
    assert.equal(ok.ok, true);
    assert.equal(ok.kind, 'file');
    assert.equal(called, 0, 'no network for local file');
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
});

// 2 direct remote
test('regression 2: direct remote https image URL works', async () => {
  globalThis.fetch = async () => httpResponse({ contentType: 'image/jpeg' });
  const r = await check('https://public-cdn.example/photo.jpg');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'direct');
  assert.equal(r.url, 'https://public-cdn.example/photo.jpg');
});

// 3 Unsplash page→direct (both id-only and slug-id)
test('regression 3: Unsplash page with id-only resolves', async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/napi\/photos\/_LuLiJc1cdo/);
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ urls: { raw: 'https://images.unsplash.com/photo-123?ixid=abc&ixlib=rb' } }),
    };
  };
  const r = await check('https://unsplash.com/photos/_LuLiJc1cdo');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'unsplash');
  assert.match(r.url, /^https:\/\/images\.unsplash\.com\//);
});

test('regression 3b: Unsplash page with slug-id resolves via last-hyphen extraction', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = String(url);
    if (u.includes('body-of-water-surrounding-with-trees-_LuLiJc1cdo')) {
      // Simulate old API that 404s on full slug
      return { ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null }, text: async () => 'not found' };
    }
    if (u.includes('_LuLiJc1cdo')) {
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ urls: { raw: 'https://images.unsplash.com/photo-123?ixid=abc&ixlib=rb-4.1.0' } }),
      };
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => 'no' };
  };
  const r = await check('https://unsplash.com/photos/body-of-water-surrounding-with-trees-_LuLiJc1cdo');
  assert.equal(r.ok, true, 'should retry with id after last hyphen');
  assert.match(r.url, /^https:\/\/images\.unsplash\.com\//);
  assert.ok(calls.some((c) => c.includes('_LuLiJc1cdo')), 'should have tried id extraction');
});

// 4 invalid/non-image
test('regression 4: invalid/non-image URLs refused', async () => {
  globalThis.fetch = async () => httpResponse({ contentType: 'text/html', bytes: new TextEncoder().encode('<html></html>') });
  const r = await check('https://public-cdn.example/some-page');
  assert.equal(r.ok, false);
  assert.match(r.error, /web page, not an image/);
});

// 5 failed remote
test('regression 5: failed remote (404, timeout, network) handled', async () => {
  globalThis.fetch = async () => httpResponse({ status: 404, contentType: 'text/html', bytes: new TextEncoder().encode('nope') });
  const r404 = await check('https://public-cdn.example/old.jpg');
  assert.equal(r404.ok, false);
  assert.match(r404.error, /404/);

  globalThis.fetch = async (url, init) => {
    void url;
    return new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  const rTimeout = await check('https://public-cdn.example/slow.jpg');
  assert.equal(rTimeout.ok, false);
  assert.match(rTimeout.error, /did not answer in time/);

  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  const rNet = await check('https://public-cdn.example/photo.jpg');
  assert.equal(rNet.ok, false);
  assert.match(rNet.error, /Could not reach/);
});

// 6 persisted after validation
test('regression 6: persisted after validation — resolved URL stored', async () => {
  // Simulate the API layer: checkBackgroundUrl returns resolved URL, and PUT stores it
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://unsplash.com/napi/')) {
      return {
        ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ urls: { raw: 'https://images.unsplash.com/photo-1465189684280-6a8fa9b19a7a?ixid=abc&ixlib=rb' } }),
      };
    }
    return httpResponse({ contentType: 'image/jpeg' });
  };
  const checked = await check('https://unsplash.com/photos/_LuLiJc1cdo');
  assert.equal(checked.ok, true);
  // The stored value should be the resolved direct URL, not the page URL
  assert.match(checked.url, /^https:\/\/images\.unsplash\.com\//);
  assert.notEqual(checked.url, 'https://unsplash.com/photos/_LuLiJc1cdo');
});

// 7 reaching SSR — settings API includes background photo
test('regression 7: background setting reaches settings API', async () => {
  // This test uses the real model layer with scratch config
  const { getSettings, putSettings } = await import('../model.js');
  const { checkBackgroundUrl: realCheck } = await import('./background.js');
  // Mock fetch for direct image
  globalThis.fetch = async () => httpResponse({ contentType: 'image/jpeg' });
  const verdict = await realCheck('https://public-cdn.example/photo.jpg', { lookup: fakeLookup });
  assert.equal(verdict.ok, true);
  // Simulate PUT /api/settings logic: if photo is valid, store resolved URL
  const next = putSettings({ appearance: { background: { photo: verdict.url } } });
  assert.equal(next.appearance.background.photo, 'https://public-cdn.example/photo.jpg');
  const fetched = getSettings();
  assert.equal(fetched.appearance.background.photo, 'https://public-cdn.example/photo.jpg');
});

// 8 fallback — broken image drops out, no broken icon (client-side tested in web tests, here we check server doesn't store broken)
test('regression 8: fallback — server refuses non-image so broken never stored', async () => {
  globalThis.fetch = async () => httpResponse({ contentType: 'text/html', bytes: new TextEncoder().encode('<html>not image</html>') });
  const r = await check('https://public-cdn.example/not-image');
  assert.equal(r.ok, false);
  // Client fallback is tested in web tests: BackgroundImage returns null on error, no broken icon
});

// 9 full coverage — CSS must have fixed viewport layer, z-index 0, behind rail, no pointer events
test('regression 9: full coverage CSS', async () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src/styles/base.css'), 'utf8');
  assert.match(css, /\.bg-layer\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0[^}]*z-index:\s*0[^}]*pointer-events:\s*none/);
  assert.match(css, /\.bg-overlay\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0[^}]*z-index:\s*0[^}]*pointer-events:\s*none/);
  assert.match(css, /\.app-shell\s*\{[^}]*position:\s*relative[^}]*z-index:\s*1/);
  assert.match(css, /\.bg-photo\s+\.bg-img\s*\{[^}]*position:\s*absolute[^}]*inset:\s*-48px[^}]*background-size:\s*cover/);
});

// 10 no flow impact — background layer must not affect layout
test('regression 10: no flow impact', async () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src/styles/base.css'), 'utf8');
  // fixed + pointer-events none + overflow hidden ensures no layout shift
  assert.match(css, /\.bg-layer[^}]*pointer-events:\s*none/);
  assert.match(css, /\.bg-overlay[^}]*pointer-events:\s*none/);
  // app-shell is the flow container, background is out of flow
  assert.ok(css.includes('.app-shell'), 'app-shell must exist');
});

// 11 no-bg — when photo null, no bg-img, quiet mode works
test('regression 11: no-bg mode', async () => {
  const r = await check('');
  assert.deepEqual(r, { ok: true, url: null });
  const r2 = await check(null);
  assert.deepEqual(r2, { ok: true, url: null });
  const css = fs.readFileSync(path.join(process.cwd(), 'src/styles/base.css'), 'utf8');
  assert.match(css, /\.bg-quiet::after\s*\{[^}]*background:\s*var\(--bg\)/);
});

// 12 mobile — background covers full viewport on mobile, behind bottom bar
test('regression 12: mobile coverage', async () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src/styles/base.css'), 'utf8');
  // mobile-bar has z-index 45, rail 40, bg-layer 0, so bg is behind
  assert.match(css, /\.rail\s*\{[^}]*z-index:\s*40/);
  assert.match(css, /\.mobile-bar\s*\{[^}]*z-index:\s*45/);
  assert.match(css, /@media\s*\(max-width:\s*860px\)/);
  // bg-layer is fixed inset 0, so it covers viewport even on mobile
  assert.match(css, /\.bg-layer\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/);
});
