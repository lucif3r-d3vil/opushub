// Per-file write isolation: a write names its file, and only that file changes. No route writes an
// arbitrary file name, and the config store refuses anything outside its whitelist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-isolation-'));
process.env.OPUSHUB_CONFIG_DIR = path.join(TMP, 'config');
process.env.OPUSHUB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.OPUSHUB_CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.OPUSHUB_DATA_DIR, { recursive: true });

const { startMockEngine } = await import('../test/mock-engine.js');
const ENGINE = await startMockEngine();
process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
delete process.env.DOCKER_HOST;

const { handleApi } = await import('../server/api.js');
const { seedSession } = await import('../test/auth-helper.js');
const configStore = await import('../server/configStore.js');

const CONFIG = process.env.OPUSHUB_CONFIG_DIR;

const SEED = {
  'services.yaml': `# hand-written header that must survive\n\ngroups:\n  - name: Media\n    services:\n      - name: jellyfin\n        container: jellyfin\n        displayName: Jellyfin\n`,
  'bookmarks.yaml': `# bookmarks\ngroups:\n  - name: Reading\n    items:\n      - name: Hacker News\n        href: https://news.ycombinator.com\n`,
  'stacks.yaml': `stacks:\n  - id: media\n    name: The media stack\n`,
  'settings.yaml': `app:\n  name: My Hub\nappearance:\n  theme: dark\n  accent: teal\n`,
  'layout.json': JSON.stringify({ version: 2, hub: { widgets: [], spacing: 'cozy', setupDismissed: false }, services: { groupOrder: [], order: {}, hiddenGroups: [] } }, null, 2),
};

function seedConfig() {
  for (const [name, text] of Object.entries(SEED)) fs.writeFileSync(path.join(CONFIG, name), text);
}

function snapshot() {
  const out = {};
  for (const name of fs.readdirSync(CONFIG)) {
    const file = path.join(CONFIG, name);
    if (fs.statSync(file).isFile()) out[name] = fs.readFileSync(file, 'utf8');
  }
  return out;
}

const changedBetween = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((n) => a[n] !== b[n]).sort();

test.after(async () => {
  await ENGINE.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});

let cookie = null;

function call(method, p, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const headers = { host: '127.0.0.1:3721', origin: 'http://127.0.0.1:3721', cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = Object.assign((async function* () { for (const c of chunks) yield c; })(), { method, headers });
  const out = { status: 0, headers: {}, body: '', setHeader: (k, v) => { out.headers[String(k).toLowerCase()] = v; }, writeHead: (s) => { out.status = s; }, end: (b) => { out.body = b ?? ''; }, write: () => {}, on: () => {}, once: () => {}, emit: () => {} };
  return handleApi(req, out, new URL(p, 'http://127.0.0.1:3721'))
    .catch((err) => { out.status = err?.status || 500; out.body = JSON.stringify({ error: err?.message }); })
    .then(() => out);
}

test('setup', async () => {
  seedConfig();
  cookie = await seedSession();
  assert.ok(cookie);
});

test('there is no arbitrary-file-write route', async () => {
  seedConfig();
  const before = snapshot();
  const attempts = [
    ['PUT', '/api/config/files/settings.yaml', 'x'],
    ['PUT', '/api/config/file/settings.yaml', 'x'],
    ['PUT', '/api/config/settings.yaml', 'x'],
    ['POST', '/api/config/write', { name: 'settings.yaml', value: 'x' }],
    ['PUT', '/api/services/../auth.json', { groups: [] }],
  ];
  for (const [method, p, body] of attempts) {
    const r = await call(method, p, body);
    assert.ok(r.status >= 400, `${method} ${p} must not be a route (got ${r.status})`);
  }
  assert.deepEqual(changedBetween(before, snapshot()), [], 'none of those attempts may write anything');

  // The positive control: a route that writes a file writes only the file it owns.
  const put = await call('PUT', '/api/bookmarks', { groups: [{ name: 'Control', items: [{ name: 'Probe', href: 'https://control.example' }] }] });
  assert.equal(put.status, 200, put.body);
  assert.deepEqual(changedBetween(before, snapshot()), ['bookmarks.yaml']);
  assert.match(snapshot()['bookmarks.yaml'], /control\.example/);
});

test('configStore itself refuses anything outside the whitelist', () => {
  for (const name of ['auth.json', '.env', '../auth.json', 'data/auth.json', 'config-history/x.json']) {
    assert.throws(() => configStore.writeText(name, 'x'), /not editable|not a writable|unsafe|refus/i, `${name} must be refused`);
  }
});
