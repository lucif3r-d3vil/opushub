// Settings written by older builds keep loading, and the routes behind removed features are gone.
//
//   · the background image, custom CSS/JS, and news / weather / market sections are no longer part
//     of the settings model: a settings file that still carries them is accepted and the sections
//     are ignored, never served back and never an error;
//   · the routes that managed them answer 404.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPUSHUB_DOCKER_SOCKET = '/tmp/opushub-legacy-probe.sock';
delete process.env.DOCKER_HOST;
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-legacy-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-legacy-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const { handleApi } = await import('./api.js');
const { seedSession } = await import('../test/auth-helper.js');
const COOKIE = await seedSession();

function req(method, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return {
    method,
    headers: { cookie: COOKIE, ...(payload ? { 'content-type': 'application/json' } : {}) },
    [Symbol.asyncIterator]() {
      let sent = false;
      return { next: async () => (sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(payload ?? ''), done: false })) };
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
    // what server/index.js does around handleApi: a thrown {status, message} becomes a JSON error
    r.state.status = err.status || 500;
    r.state.body = JSON.stringify({ error: String(err.message || err) });
  }
  return { status: r.state.status, json: JSON.parse(r.state.body || '{}') };
}

test('PUT /api/settings: sections from older builds are accepted and ignored', async () => {
  const put = await call('PUT', '/api/settings', {
    appearance: { theme: 'dark', background: { mode: 'photo', photo: 'https://images.example.com/bg.jpg', blur: 12 } },
    advanced: { customCss: true, customJs: true },
    integrations: { markets: { symbols: ['aapl'] }, weather: { units: 'f' }, news: { feeds: [] } },
  });
  assert.equal(put.status, 200, 'an old settings file still saves');
  assert.equal(put.json.appearance.theme, 'dark', 'the part that still exists is kept');
  for (const gone of [put.json.appearance.background, put.json.advanced, put.json.integrations]) {
    assert.equal(gone, undefined, 'a removed section is not served back');
  }
  const read = await call('GET', '/api/settings');
  assert.equal(read.status, 200);
  assert.equal(read.json.appearance.background, undefined);
  assert.equal(read.json.advanced, undefined);
  assert.equal(read.json.integrations, undefined);
});

test('the routes behind removed features are gone', async () => {
  for (const [method, p] of [
    ['GET', '/api/background/check?url=https://images.example.com/bg.jpg'],
    ['GET', '/api/backgrounds'],
    ['GET', '/api/custom'],
    ['PUT', '/api/custom'],
    ['POST', '/api/custom/reset'],
    ['GET', '/api/news'],
    ['GET', '/api/weather'],
    ['GET', '/api/market'],
  ]) {
    const r = await call(method, p, method === 'GET' ? undefined : {});
    assert.equal(r.status, 404, `${method} ${p} should not exist (got ${r.status})`);
  }
});
