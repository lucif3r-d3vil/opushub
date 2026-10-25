// The built-in backgrounds: a fixed list of ids, plus config/background.jpg when that file exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPUSHUB_DOCKER_SOCKET = '/tmp/opushub-bg-probe.sock';
delete process.env.DOCKER_HOST;
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-bg-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-bg-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const { handleApi } = await import('./api.js');
const { seedSession } = await import('../test/auth-helper.js');
const COOKIE = await seedSession();

test.after(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

async function call(method, p, body, headers = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = {
    method,
    headers: { cookie: COOKIE, origin: 'http://127.0.0.1:3721', host: '127.0.0.1:3721', ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
    [Symbol.asyncIterator]() {
      let sent = false;
      return { next: async () => (sent || !payload ? { done: true, value: undefined } : (sent = true, { done: false, value: payload })) };
    },
  };
  const out = { status: 200, headers: {}, body: '' };
  const res = { setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, writeHead: (s) => { out.status = s; }, end: (b) => { out.body = b ?? ''; } };
  try { await handleApi(req, res, new URL(p, 'http://127.0.0.1:3721')); } catch (err) { out.status = err.status || 500; out.body = JSON.stringify({ error: err.message }); }
  let json = null;
  try { json = JSON.parse(Buffer.isBuffer(out.body) ? out.body.toString('utf8') : out.body); } catch { /* binary */ }
  return { ...out, json };
}

test('the default is graphite, and a photo is not offered without the file', async () => {
  const r = await call('GET', '/api/settings');
  assert.equal(r.json.appearance.background, 'graphite');
  assert.equal(r.json.appearance.photoAvailable, false);
  assert.equal((await call('GET', '/api/appearance/background')).status, 404);
});

test('a known id is kept; anything else reads as the default', async () => {
  for (const id of ['dusk', 'forest', 'ember']) {
    const r = await call('PUT', '/api/settings', { appearance: { background: id } });
    assert.equal(r.json.appearance.background, id);
  }
  const bad = await call('PUT', '/api/settings', { appearance: { background: 'neon' } });
  assert.equal(bad.json.appearance.background, 'graphite');
  const obj = await call('PUT', '/api/settings', { appearance: { background: { mode: 'photo', photo: 'https://x.example/bg.jpg' } } });
  assert.equal(obj.json.appearance.background, 'graphite');
  assert.ok(!/x\.example/.test(fs.readFileSync(path.join(CONFIG_DIR, 'settings.yaml'), 'utf8')), 'the old URL is not written back');
});

test('photo needs config/background.jpg; with it the file is served and the flag is computed, not stored', async () => {
  const noFile = await call('PUT', '/api/settings', { appearance: { background: 'photo' } });
  assert.equal(noFile.json.appearance.background, 'graphite', 'photo without a file falls back');
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  fs.writeFileSync(path.join(CONFIG_DIR, 'background.jpg'), jpg);
  const r = await call('PUT', '/api/settings', { appearance: { background: 'photo', photoAvailable: false } });
  assert.equal(r.json.appearance.background, 'photo');
  assert.equal(r.json.appearance.photoAvailable, true);
  assert.ok(!/photoAvailable/.test(fs.readFileSync(path.join(CONFIG_DIR, 'settings.yaml'), 'utf8')), 'the computed flag is never stored');
  const img = await call('GET', '/api/appearance/background');
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/jpeg');
  assert.deepEqual(Buffer.from(img.body), jpg);
  const cached = await call('GET', '/api/appearance/background', undefined, { 'if-none-match': img.headers.etag });
  assert.equal(cached.status, 304);
});

test('removing the file makes a saved "photo" read as graphite again', async () => {
  fs.rmSync(path.join(CONFIG_DIR, 'background.jpg'));
  const r = await call('GET', '/api/settings');
  assert.equal(r.json.appearance.background, 'graphite');
  assert.equal(r.json.appearance.photoAvailable, false);
});

test('an oversized file is not served', async () => {
  fs.writeFileSync(path.join(CONFIG_DIR, 'background.jpg'), Buffer.alloc(6 * 1024 * 1024 + 1));
  assert.equal((await call('GET', '/api/appearance/background')).status, 404);
  fs.rmSync(path.join(CONFIG_DIR, 'background.jpg'));
});
