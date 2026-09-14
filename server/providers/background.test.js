// Background URL tests — the whole validation contract of the Background field:
// direct images pass, pages are refused, http is refused, internal addresses are refused,
// Unsplash photo pages resolve to direct images, and nothing about a failure is a hang.
// The upstream (both the image probe and Unsplash's napi) is mocked at the fetch boundary,
// and DNS through an injectable lookup — the provider itself never sees a live network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPUSHUB_BACKGROUND_PROBE_MS = '400';
// scratch config dir — the /user/backgrounds/ file checks must never touch a real config
process.env.OPUSHUB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-bg-cfg-'));
fs.mkdirSync(path.join(process.env.OPUSHUB_CONFIG_DIR, 'backgrounds'), { recursive: true });

const originalFetch = globalThis.fetch;

/** A fake DNS: hostname → [ips] (or throw). */
const dnsTable = new Map();
const fakeLookup = (host) => {
  const ips = dnsTable.get(String(host).toLowerCase());
  if (!ips) { const e = new Error(`getaddrinfo ENOTFOUND ${host}`); e.code = 'ENOTFOUND'; throw e; }
  return Promise.resolve(ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
};

/** Response lookalike for the image probe. */
function httpResponse({ status = 200, contentType = 'image/jpeg', bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), finalUrl } = {}) {
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
  dnsTable.set('double.host.example', ['93.184.216.34', '127.0.0.1']); // one answer internal
  dnsTable.set('bad.host.example', ['10.0.0.5']);
  dnsTable.set('metadata.example', ['169.254.169.254']);
  mod = await import('./background.js');
  mod.__resetBackgroundChecks();
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('background: a direct https image URL is accepted', async () => {
  globalThis.fetch = async (url) => { void url; return httpResponse({ contentType: 'image/jpeg' }); };
  const r = await check('https://public-cdn.example/photo.jpg');
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://public-cdn.example/photo.jpg');
  assert.equal(r.kind, 'direct');
});

test('background: content-type alone is trusted; sniffed bytes are the fallback', async () => {
  globalThis.fetch = async (url) => { void url; return httpResponse({ contentType: 'application/octet-stream' }); };
  const sniffed = await check('https://public-cdn.example/blob.bin');
  assert.equal(sniffed.ok, true, 'PNG magic bytes are accepted when the content-type is absent');
  // and the same endpoint serving HTML is refused
  globalThis.fetch = async (url) => { void url; return httpResponse({ contentType: 'text/html', bytes: new TextEncoder().encode('<html><body>not an image</body></html>') }); };
  const page = await check('https://public-cdn.example/whatever');
  assert.equal(page.ok, false);
  assert.match(page.error, /web page, not an image/);
});

test('background: a web page URL is refused with a usable explanation', async () => {
  globalThis.fetch = async (url) => { void url; return httpResponse({ contentType: 'text/html', bytes: new TextEncoder().encode('<html></html>') }); };
  const r = await check('https://public-cdn.example/some-page');
  assert.equal(r.ok, false);
  assert.match(r.error, /web page, not an image/);
  assert.match(r.error, /Unsplash photo page/);
});

test('background: http:// is refused without any network call', async () => {
  let called = 0;
  globalThis.fetch = async (url) => { called++; void url; return httpResponse(); };
  const r = await check('http://public-cdn.example/photo.jpg');
  assert.equal(r.ok, false);
  assert.match(r.error, /https/);
  assert.equal(called, 0);
});

test('background: other schemes (javascript:, data:, ftp:) are refused', async () => {
  for (const v of ['javascript:alert(1)', 'data:image/png;base64,AAA', 'ftp://public-cdn.example/x.png', 'not a url at all']) {
    const r = await check(v);
    assert.equal(r.ok, false, v);
  }
});

test('background: empty / null clears the background (ok, no url)', async () => {
  assert.deepEqual(await check(''), { ok: true, url: null });
  assert.deepEqual(await check(null), { ok: true, url: null });
  assert.deepEqual(await check('   '), { ok: true, url: null });
});

test('background: private, loopback and link-local addresses are refused before any fetch', async () => {
  let called = 0;
  globalThis.fetch = async (url) => { called++; void url; return httpResponse(); };
  const cases = [
    'https://127.0.0.1/admin',
    'https://10.0.0.5/photo.jpg',
    'https://192.168.1.2/photo.jpg',
    'https://172.16.0.1/photo.jpg',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/photo.jpg',
    'https://[fe80::1]/photo.jpg',
    'https://[fc00::1]/photo.jpg',
    'https://[::ffff:10.0.0.1]/photo.jpg', // v4-mapped private
    'https://0.0.0.0/photo.jpg',
    'https://100.64.0.1/photo.jpg', // CGNAT
    'https://metadata.example/x',   // DNS → link-local
    'https://bad.host.example/x',   // DNS → RFC1918
    'https://double.host.example/x', // DNS → one public, one loopback
  ];
  for (const v of cases) {
    const r = await check(v);
    assert.equal(r.ok, false, v);
    assert.match(r.error, /network address|must not fetch|could not resolve|https/i, `${v} → ${r.error}`);
  }
  assert.equal(called, 0, 'no fetch may happen for a refused address');
});

test('background: a redirect to an internal host is refused too', async () => {
  globalThis.fetch = async (url) => { void url; return httpResponse({ finalUrl: 'http://127.0.0.1/secret' }); };
  const r = await check('https://public-cdn.example/redirect');
  assert.equal(r.ok, false);
  assert.match(r.error, /non-https/);
});

test('background: a slow host times out with a clean error, it does not hang', async () => {
  globalThis.fetch = (async (url, init) => {
    void url;
    return new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      void resolve;
    });
  });
  const started = Date.now();
  const r = await check('https://public-cdn.example/slow.jpg');
  assert.ok(Date.now() - started < 3000);
  assert.equal(r.ok, false);
  assert.match(r.error, /did not answer in time/);
});

test('background: a network failure is a clean error, not a crash', async () => {
  globalThis.fetch = async (url) => { void url; throw new TypeError('fetch failed'); };
  const r = await check('https://public-cdn.example/photo.jpg');
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not reach the image host/);
});

test('background: a 404 image is reported as gone', async () => {
  globalThis.fetch = async (url) => { void url; return httpResponse({ status: 404, contentType: 'text/html', bytes: new TextEncoder().encode('nope') }); };
  const r = await check('https://public-cdn.example/old.jpg');
  assert.equal(r.ok, false);
  assert.match(r.error, /404/);
});

test('background: an Unsplash photo page resolves to its direct image (JSON only, pinned hosts)', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({
        id: '_LuLiJc1cdo',
        urls: { raw: 'https://images.unsplash.com/photo-1465189684280-6a8fa9b19a7a?ixid=M3wxMjA3fDB8&ixlib=rb-4.1.0' },
      }),
    };
  };
  const r = await check('https://unsplash.com/photos/body-of-water-surrounding-with-trees-_LuLiJc1cdo');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'unsplash');
  assert.match(r.url, /^https:\/\/images\.unsplash\.com\/photo-1465189684280/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://unsplash.com/napi/photos/body-of-water-surrounding-with-trees-_LuLiJc1cdo', 'only the pinned napi endpoint is called');
});

test('background: Unsplash resolution is refused when the CDN host is not the pinned one', async () => {
  globalThis.fetch = async (url) => { void url; return {
    ok: true, status: 200, statusText: 'OK',
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ urls: { raw: 'https://evil.example/stolen.jpg' } }),
  }; };
  const r = await check('https://unsplash.com/photos/_LuLiJc1cdo');
  assert.equal(r.ok, false);
});

test('background: Unsplash photo that no longer exists → clean refusal', async () => {
  globalThis.fetch = async (url) => { void url; return { ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null }, text: async () => 'nope' }; };
  const r = await check('https://unsplash.com/photos/removed-photo-abc123');
  assert.equal(r.ok, false);
  assert.match(r.error, /could not find that photo/);
});

test('background: only /photos/<id> pages are resolved — no arbitrary HTML resolution', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return httpResponse({ contentType: 'text/html', bytes: new TextEncoder().encode('<html></html>') });
  };
  // a page that is not a /photos/<id> URL is probed as a direct URL (and refused as a page) —
  // it is NEVER handed to the resolution path
  const r = await check('https://unsplash.com/photos/not%20a%20valid%20id%2Fextra');
  assert.equal(r.ok, false);
  assert.ok(!calls.some((c) => c.includes('/napi/')), 'no napi resolution for a malformed photo page');
  // and a collection page (a different shape entirely) is probed as-is
  const r2 = await check('https://unsplash.com/collections/123');
  assert.equal(r2.ok, false);
  assert.ok(!calls.some((c) => c.includes('/napi/')));
});

test('background: same-origin /user/backgrounds/ files validate without any network', async () => {
  const { CONFIG_DIR } = await import('../configStore.js');
  const file = path.join(CONFIG_DIR, 'backgrounds', 'test-bg.jpg');
  fs.writeFileSync(file, 'x');
  let called = 0;
  globalThis.fetch = async (url) => { called++; void url; return httpResponse(); };
  try {
    const ok = await check('/user/backgrounds/test-bg.jpg');
    assert.equal(ok.ok, true);
    assert.equal(ok.kind, 'file');
    const missing = await check('/user/backgrounds/nope.jpg');
    assert.equal(missing.ok, false);
    const traversal = await check('/user/backgrounds/../settings.yaml');
    assert.equal(traversal.ok, false, 'path traversal is refused');
    assert.equal(called, 0, 'no network for local files');
  } finally {
    try { fs.unlinkSync(file); } catch { /* ok */ }
  }
});

test('background: relative paths outside /user/backgrounds/ are refused', async () => {
  for (const v of ['/user/icons/x.png', '/assets/app.js', '/etc/passwd']) {
    const r = await check(v);
    assert.equal(r.ok, false, v);
  }
});

test('background: verdicts are cached (repeat checks do not re-fetch)', async () => {
  let n = 0;
  globalThis.fetch = async (url) => { n++; void url; return httpResponse(); };
  await check('https://public-cdn.example/photo.jpg');
  await check('https://public-cdn.example/photo.jpg');
  assert.equal(n, 1);
});
