// The first-run presentation step (Phase 6 § First-run).
//
// The wizard may ask one question it cannot answer from Docker — "how should this look on the way
// in?" — and it must be able to ask it *before an account exists*. That makes two properties
// load-bearing:
//
//   · the answer is bounded. `detected` writes nothing; `template` applies one of six built-in
//     templates, whose ids are a server-side constant. There is no way to hand the wizard a
//     document, a path or a URL, and importing is deliberately *not* offered here: it is an
//     authenticated configuration write and this screen has no session.
//   · the preview cannot leak. Whatever the wizard renders comes from constants (template widget
//     arrangements, the default composition) plus the counts the setup summary already published —
//     never a container name, image, hostname or URL from this host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockEngine, FLEET } from '../test/mock-engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = await startMockEngine();

// One in-process install, because a module graph reads its directories once: `CONFIG_DIR` is a
// constant, so "a second fresh install" has to be a second process (see the child below).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-setup-'));
const CONFIG = path.join(TMP, 'config');
const DATA = path.join(TMP, 'data');
process.env.OPUSHUB_CONFIG_DIR = CONFIG;
process.env.OPUSHUB_DATA_DIR = DATA;
process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
delete process.env.DOCKER_HOST;
fs.mkdirSync(CONFIG, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

function res() {
  const state = { status: 0, headers: {}, body: '' };
  return {
    state,
    setHeader: (k, v) => { state.headers[String(k).toLowerCase()] = v; },
    writeHead: (s) => { state.status = s; },
    end: (b) => { state.body = b == null ? '' : String(b); },
    on: () => {}, once: () => {}, emit: () => {},
  };
}

function req(method, body, headers = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return {
    method,
    headers: { host: '127.0.0.1:3721', origin: 'http://127.0.0.1:3721', ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() {
      let done = false;
      return { next: async () => (done ? { done: true } : (done = true, { value: Buffer.from(payload), done: false })) };
    },
  };
}

const { handleApi } = await import('../server/api.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, body, headers) {
  const r = res();
  try {
    await handleApi(req(method, body, headers), r, new URL(p, 'http://127.0.0.1:3721'));
  } catch (err) {
    r.state.status = err?.status || 500;
    r.state.body = JSON.stringify({ error: err?.message || String(err), code: err?.code });
  }
  let json = null;
  try { json = JSON.parse(r.state.body); } catch { /* not json */ }
  return { status: r.state.status, json, body: r.state.body };
}

test.after(async () => {
  await ENGINE.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const readLayout = () => JSON.parse(fs.readFileSync(path.join(CONFIG, 'layout.json'), 'utf8'));

test('the wizard can see the presentation choice before an account exists', async () => {
  const status = await call('GET', '/api/setup/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.required, true);

  const p = status.json.discovery.presentation;
  assert.ok(p, 'the presentation block is part of the pre-auth summary');
  assert.deepEqual(p.templates.map((t) => t.id), ['minimal', 'balanced', 'media', 'information', 'classic', 'operations']);
  for (const t of p.templates) {
    assert.ok(t.name && t.tagline, `${t.id} is described`);
    assert.ok(t.widgets.length > 0, `${t.id} arranges something`);
    for (const w of t.widgets) {
      assert.ok(w.type && w.zone && w.size && w.title, `${t.id}: every block is renderable`);
      assert.equal(Object.keys(w).sort().join(','), 'size,title,type,zone', 'and carries nothing else');
    }
  }
  // The default composition is the constant a fresh install starts with.
  assert.equal(p.widgets.length, 7);
  assert.deepEqual(p.widgets.map((w) => w.type), ['system', 'services', 'weather', 'news', 'markets', 'bookmarks', 'activity']);
  // Counts, not names.
  assert.equal(typeof p.detected.groups, 'number');
  assert.equal(typeof p.detected.services, 'number');
  assert.equal(typeof p.detected.stacks, 'number');
});

test('nothing a host knows crosses the wire pre-auth — including through the new block', async () => {
  const status = await call('GET', '/api/setup/status');
  assert.equal(status.status, 200);
  const body = status.body;

  const presentationBody = JSON.stringify(status.json.discovery.presentation);
  const names = FLEET.map((f) => String(f.Names[0]).replace(/^\//, ''));
  for (const name of names) assert.ok(!presentationBody.includes(name), `the presentation block leaks the container name ${name}`);
  for (const f of FLEET) {
    const image = String(f.Image || '');
    if (image) assert.ok(!body.includes(image), `the summary leaks the image ${image}`);
  }
  for (const needle of ['com.docker.compose.project', '/var/run/docker.sock', 'http://', 'https://', '.lan', '.internal']) {
    assert.ok(!body.includes(needle), `the summary leaks ${needle}`);
  }
  // The template constants are allowed through, and only they: the preview is built from a fixed
  // vocabulary plus counts, so a template that has never been applied tells this host nothing.
  assert.ok(!/"preview"|groupOrder|groupPriority/.test(body), 'the real merged preview stays behind the auth gate');
});

test('an unknown or malformed presentation choice is refused before the account exists', async () => {
  // This install has no account yet — this test runs before the one that creates it below.
  const unknown = await call('POST', '/api/setup', { username: 'admin', password: 'setup-fixture-password', presentation: { mode: 'template', template: '../../etc/passwd' } });
  assert.equal(unknown.status, 400, unknown.body);
  assert.equal(unknown.json.code, 'unknown_template');

  const weird = await call('POST', '/api/setup', { username: 'admin', password: 'setup-fixture-password', presentation: { mode: 'import', files: { 'services.yaml': '- x: 1' } } });
  assert.equal(weird.status, 400, weird.body);
  assert.equal(weird.json.code, 'bad_presentation');

  // Neither attempt created an account: the validation runs before `createAdmin`, so a refused
  // choice cannot leave a half-finished install behind.
  const status = await call('GET', '/api/setup/status');
  assert.equal(status.json.required, true, 'the install is still un-initialised');
  assert.equal(status.json.hasAccount, false);
  assert.ok(!fs.existsSync(path.join(CONFIG, 'layout.json')), 'and nothing was applied');
});
test('choosing a template applies exactly that template', async () => {
  const created = await call('POST', '/api/setup', { username: 'admin', password: 'setup-fixture-password', presentation: { mode: 'template', template: 'media' } });
  assert.equal(created.status, 201, created.body);
  assert.deepEqual(created.json.presentation, { mode: 'template', template: 'media' }, 'the wizard is told what was applied');

  const layout = readLayout();
  assert.equal(layout.hub.spacing, 'comfortable');
  assert.equal(layout.hub.widgets.length, 5, 'the media arrangement, not the default one');
  // A version was recorded, so the choice is undoable like every other configuration write.
  const versions = fs.readdirSync(path.join(DATA, 'config-history'));
  assert.ok(versions.length >= 1, 'applying a template at setup records a configuration version');
});

test('the default choice arranges nothing, and setup still completes', async () => {
  // A second install, over real HTTP this time: the wizard's own request path (`server/index.js`),
  // a bare engine, and no presentation decision at all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-setup-detected-'));
  const port = 3753;
  const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPUSHUB_CONFIG_DIR: path.join(dir, 'config'),
      OPUSHUB_DATA_DIR: path.join(dir, 'data'),
      OPUSHUB_PORT: String(port),
      OPUSHUB_HOST: '127.0.0.1',
      OPUSHUB_DOCKER_SOCKET: ENGINE.socketPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  try {
    let up = false;
    for (let i = 0; i < 160 && !up; i++) {
      if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}): ${log.slice(-400)}`);
      try { up = (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) })).ok; }
      catch { await sleep(250); }
    }
    assert.ok(up, 'the second server started');
    const before = await (await fetch(`http://127.0.0.1:${port}/api/setup/status`)).json();
    assert.equal(before.required, true);
    assert.ok(before.discovery.presentation.templates.length, 'and it offers the same choice');

    const created = await fetch(`http://127.0.0.1:${port}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'setup-fixture-password' }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual((await created.json()).presentation, { mode: 'detected', template: null });
    assert.ok(!fs.existsSync(path.join(dir, 'config', 'layout.json')), 'nothing is arranged for you');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

