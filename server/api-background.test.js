// API tests for the background pipeline — the door the browser uses:
//   · GET /api/background/check is session-gated and answers a verdict (never the image)
//   · PUT /api/settings refuses a background photo the server cannot verify
//   · a valid photo (direct image, or Unsplash page → resolved URL) is stored
// The upstream is mocked at the fetch boundary, exactly like the provider tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPUSHUB_DOCKER_SOCKET = '/tmp/opushub-bg-probe.sock';
delete process.env.DOCKER_HOST;
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-bg-api-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-bg-api-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;
process.env.OPUSHUB_BACKGROUND_PROBE_MS = '400';
fs.mkdirSync(path.join(CONFIG_DIR, 'backgrounds'), { recursive: true });

const originalFetch = globalThis.fetch;

const dnsTable = new Map([
  ['public-cdn.example', ['93.184.216.34']],
  ['images.unsplash.com', ['151.101.1.217']],
  ['unsplash.com', ['151.101.193.143']],
]);
const fakeLookup = (host) => {
  const ips = dnsTable.get(String(host).toLowerCase());
  if (!ips) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
  return Promise.resolve(ips.map((address) => ({ address, family: 4 })));
};

const imageResponse = () => ({
  ok: true, status: 200, statusText: 'OK', url: null,
  headers: { get: () => 'image/jpeg' },
  body: { getReader: () => ({ read: async () => ({ value: new Uint8Array(8), done: false }), cancel: async () => {} }) },
});
const htmlResponse = () => ({
  ok: true, status: 200, statusText: 'OK', url: null,
  headers: { get: () => 'text/html' },
  body: { getReader: () => ({ read: async () => ({ value: new TextEncoder().encode('<html></html>'), done: false }), cancel: async () => {} }) },
});
const napiResponse = (doc) => ({
  ok: true, status: 200, statusText: 'OK',
  headers: { get: () => 'application/json' },
  text: async () => JSON.stringify(doc),
});

const { handleApi } = await import('./api.js');
const { __setBackgroundLookup } = await import('./providers/background.js');
__setBackgroundLookup(fakeLookup);
const { seedSession } = await import('../test/auth-helper.js');
const COOKIE = await seedSession();

function req(method, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return {
    method,
    headers: { cookie: COOKIE, ...(payload ? { 'content-type': 'application/json' } : {}) },
    [Symbol.asyncIterator]() {
      let sent = false;
      return { next: async () => (sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(payload), done: false })) };
    },
  };
}
function res() {
  const headers = {};
  const state = { status: 200, headers, body: '' };
  return {
    state,
    setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
    writeHead: (s) => { state.status = s; },
    end: (b) => { state.body = b == null ? '' : String(b); },
  };
}
async function call(method, pathname, body) {
  const r = res();
  try {
    await handleApi(req(method, body), r, new URL(pathname, 'http://127.0.0.1'));
  } catch (err) {
    // exactly what server/index.js does around handleApi: a thrown {status, message} becomes a
    // JSON error response — the test goes through the same door a browser does
    r.state.status = err.status || 500;
    r.state.body = JSON.stringify({ error: String(err.message || err) });
  }
  return { status: r.state.status, json: JSON.parse(r.state.body || '{}') };
}
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('GET /api/background/check requires a session', async () => {
  const r = res();
  await handleApi({ method: 'GET', headers: {}, [Symbol.asyncIterator]() { return { next: async () => ({ value: undefined, done: true }) }; } }, r, new URL('/api/background/check?url=https://x', 'http://127.0.0.1'));
  assert.equal(r.state.status, 401);
});

test('GET /api/background/check: a valid direct image URL is ok, and nothing leaks', async () => {
  globalThis.fetch = (async (url, init) => {
    void init;
    if (String(url).startsWith('https://unsplash.com/napi/')) return napiResponse({ urls: { raw: 'https://images.unsplash.com/photo-1?ixlib=rb' } });
    return imageResponse();
  })
  const { status, json } = await call('GET', '/api/background/check?url=' + encodeURIComponent('https://public-cdn.example/photo.jpg'));
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.url, 'https://public-cdn.example/photo.jpg');
  assert.ok(!JSON.stringify(json).includes('<html'), 'no body content in the verdict');
});

test('GET /api/background/check: a page URL is a clean refusal', async () => {
  globalThis.fetch = (async () => htmlResponse())
  const { json } = await call('GET', '/api/background/check?url=' + encodeURIComponent('https://public-cdn.example/some-page'));
  assert.equal(json.ok, false);
  assert.match(json.error, /web page, not an image/);
});

test('GET /api/background/check: an Unsplash photo page resolves to the direct image', async () => {
  globalThis.fetch = (async (url) => {
    if (String(url).startsWith('https://unsplash.com/napi/')) {
      return napiResponse({ urls: { raw: 'https://images.unsplash.com/photo-1465189684280-6a8fa9b19a7a?ixlib=rb-4.1.0' } });
    }
    return imageResponse();
  })
  const { json } = await call('GET', '/api/background/check?url=' + encodeURIComponent('https://unsplash.com/photos/body-of-water-surrounding-with-trees-_LuLiJc1cdo'));
  assert.equal(json.ok, true);
  assert.match(json.url, /^https:\/\/images\.unsplash\.com\//);
});

test('PUT /api/settings: an unverified photo URL is refused with 400 and nothing is written', async () => {
  globalThis.fetch = (async () => htmlResponse())
  const { status, json } = await call('PUT', '/api/settings', { appearance: { background: { photo: 'https://public-cdn.example/some-page' } } });
  assert.equal(status, 400);
  assert.equal(json.code, 'background_url');
  assert.match(json.error, /web page, not an image/);
  let text = null;
  try { text = fs.readFileSync(path.join(CONFIG_DIR, 'settings.yaml'), 'utf8'); } catch { /* no file yet — fine */ }
  assert.ok(text == null || !text.includes('some-page'), 'the rejected URL never reaches settings.yaml');
});

test('PUT /api/settings: a valid direct image URL is stored', async () => {
  globalThis.fetch = (async () => imageResponse())
  const { status, json } = await call('PUT', '/api/settings', { appearance: { background: { photo: 'https://public-cdn.example/photo.jpg' } } });
  assert.equal(status, 200);
  assert.equal(json.appearance.background.photo, 'https://public-cdn.example/photo.jpg');
});

test('PUT /api/settings: an Unsplash photo page is stored as its resolved direct image', async () => {
  globalThis.fetch = (async (url) => {
    if (String(url).startsWith('https://unsplash.com/napi/')) {
      return napiResponse({ urls: { raw: 'https://images.unsplash.com/photo-1465189684280-6a8fa9b19a7a?ixlib=rb-4.1.0' } });
    }
    return imageResponse();
  })
  const { status, json } = await call('PUT', '/api/settings', { appearance: { background: { photo: 'https://unsplash.com/photos/body-of-water-surrounding-with-trees-_LuLiJc1cdo' } } });
  assert.equal(status, 200);
  assert.match(json.appearance.background.photo, /^https:\/\/images\.unsplash\.com\//, 'the resolved URL is what gets stored');
});

test('PUT /api/settings: clearing the photo is always allowed', async () => {
  const { status, json } = await call('PUT', '/api/settings', { appearance: { background: { photo: null } } });
  assert.equal(status, 200);
  assert.equal(json.appearance.background.photo, null);
});

test('PUT /api/settings: invalid market symbols are refused, valid ones normalized', async () => {
  const { status, json } = await call('PUT', '/api/settings', { integrations: { markets: { symbols: ['AAPL', 'https://evil.example/x', 'BTC-USD', 'aapl.us', 'AAPL'] } } });
  assert.equal(status, 400, 'one bad symbol refuses the whole save, with the reason');
  assert.match(json.error, /https:\/\/evil\.example\/x/);

  const ok = await call('PUT', '/api/settings', { integrations: { markets: { symbols: ['aapl', 'BTC-USD', 'aapl.us'] } } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.integrations.markets.symbols, ['AAPL', 'BTC-USD'], 'normalized, de-duplicated, .US migrated');
});
