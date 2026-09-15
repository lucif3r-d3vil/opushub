// The first-run contract, over real HTTP against the mock engine.
//
// What this file pins down (docs/06-auth.md § Setup lifecycle, docs/08-phase-5-plan.md § 2):
//   · a fresh install is *useful*: the wizard learns the engine, its API version, the inventory
//     counts and — in categories — why each service does or does not have a URL;
//   · it is nevertheless *closed*: no container name, image, hostname, URL or path crosses the
//     boundary before an account exists;
//   · the account is created in one request, which cannot be repeated;
//   · a URL is never required to finish, and the reasons never gate anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockEngine } from '../test/mock-engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3752;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'setup-fixture-password';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-api-setup-'));
const CONFIG_DIR = path.join(scratch, 'config');
const DATA_DIR = path.join(scratch, 'data');

let engine = null;
let child = null;
let log = '';
let cookie = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 160; i++) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}): ${log.slice(-800)}`);
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await sleep(250);
  }
  throw new Error(`server never answered on ${BASE}: ${log.slice(-800)}`);
}

async function call(method, p, { body, auth = true } = {}) {
  const h = {};
  if (auth && cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(`${BASE}${p}`, {
    method, headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  for (const c of r.headers.getSetCookie?.() ?? []) {
    const m = /^opushub_session=([^;]*)/.exec(c);
    if (m && m[1]) cookie = `opushub_session=${m[1]}`;
  }
  return { status: r.status, json, text };
}

const get = (p, opts) => call('GET', p, opts);
const post = (p, body, opts) => call('POST', p, { body, ...opts });

test.before(async () => {
  engine = await startMockEngine();
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPUSHUB_CONFIG_DIR: CONFIG_DIR,
      OPUSHUB_DATA_DIR: DATA_DIR,
      OPUSHUB_PORT: String(PORT),
      OPUSHUB_HOST: '127.0.0.1',
      OPUSHUB_DOCKER_SOCKET: engine.socketPath,
      OPUSHUB_HOST_ADDRESS: '198.51.100.44',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  await waitForServer();
});

test.after(async () => {
  child?.kill('SIGTERM');
  await new Promise((r) => child?.once('exit', r) ?? r());
  await engine?.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('a fresh install reports what the engine sees: engine, API version, counts and routes', async () => {
  const r = await get('/api/setup/status', { auth: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.required, true);
  assert.equal(r.json.complete, false);
  assert.equal(r.json.hasAccount, false);

  const d = r.json.discovery;
  assert.ok(d, 'the wizard gets a discovery summary before an account exists');
  assert.equal(d.docker.ok, true);
  assert.equal(d.docker.state, 'connected');
  assert.ok(d.docker.version, 'the engine version is reported');
  // the API version OpusHub actually speaks — min(daemon, 1.43), so the mock's 1.24 stays 1.24
  assert.ok(d.docker.apiVersion, 'the Docker API version is reported');
  assert.match(String(d.docker.apiVersion), /^\d+\.\d+$/);

  assert.equal(d.containers, 25, 'every container the mock engine serves');
  assert.equal(d.running + (d.stopped ?? 0), d.containers, 'running + stopped accounts for the fleet');
  assert.equal(d.stacks, 7, 'compose projects');
  assert.equal(d.standalone, 4);
  assert.ok(d.services > 0 && d.infrastructure > 0);
  assert.ok(d.traefik.routes > 0, 'Traefik routers are counted');
  assert.ok(Array.isArray(d.traefik.entrypoints));
});

test('URL resolution is explained by category, and no name or URL is exposed pre-auth', async () => {
  const r = await get('/api/setup/status', { auth: false });
  const d = r.json.discovery;
  const { detected, missing, reasons } = d.urls;
  assert.equal(detected + missing, d.containers, 'every container is either reachable or honestly not');

  assert.ok(Array.isArray(reasons) && reasons.length, 'the reasons are present');
  const total = reasons.reduce((a, x) => a + x.count, 0);
  assert.equal(total, d.containers, 'the reasons account for the whole fleet');
  for (const row of reasons) {
    assert.ok(typeof row.code === 'string' && row.code.length, 'each row carries a stable code');
    assert.ok(row.count > 0);
    assert.equal(typeof row.resolved, 'boolean');
    assert.ok(row.explain === null || typeof row.explain === 'string');
  }
  // the reasons a container can have no URL, all of them real verdicts from the resolver
  const codes = new Set(reasons.map((x) => x.code));
  assert.ok(codes.has('traefik'), 'proxied containers are counted as resolved by proxy metadata');
  assert.ok(codes.has('published-port'), 'published ports with a known host address resolve');
  assert.ok(codes.has('no-route'), 'a container with nothing routing to it is its own category');
  // and the categories a *refusing* resolver produces are representable too
  for (const code of ['host-address-unknown', 'loopback-only', 'override-invalid', 'proxy-disabled', 'proxy-incomplete']) {
    assert.ok(code in (await import('./urlResolver.js')).URL_REASONS, `${code} has a documented explanation`);
  }

  // The boundary: no container names, no images, no application hostnames, no URLs, no paths.
  // The one deliberate exception (unchanged from Phase 4) is this *host's own* address plus the
  // Traefik entrypoint names: the wizard must prefill the field the operator is being asked to
  // confirm, and "web/websecure" is proxy vocabulary rather than host data.
  const text = r.text;
  for (const leak of ['jellyfin', 'seerr', 'nextcloud', 'lab.internal', 'ghcr.io', 'paperless', 'immich', '/var/run']) {
    assert.ok(!text.includes(leak), `the pre-auth payload leaks “${leak}”`);
  }
  assert.equal(d.hostAddress, '198.51.100.44', 'this host’s own address is offered for confirmation');
  assert.equal(d.hostAddressSource, 'env', 'OPUSHUB_HOST_ADDRESS wins over detection');
});

test('the wizard summary disappears once an account exists', async () => {
  const created = await post('/api/setup', { username: 'admin', password: PASSWORD }, { auth: false });
  assert.equal(created.status, 201);
  assert.equal(created.json.authenticated, true);
  assert.equal(created.json.user.username, 'admin');
  assert.ok(!created.text.includes('scrypt$'));

  const after = await get('/api/setup/status', { auth: false });
  assert.equal(after.json.required, false);
  assert.equal(after.json.complete, true);
  assert.equal(after.json.discovery, undefined, 'the count-only summary is not returned after setup');
});

test('setup cannot be repeated, and the wizard cannot be reached again', async () => {
  assert.equal((await post('/api/setup', { username: 'someone', password: PASSWORD }, { auth: false })).status, 409);
  assert.equal((await post('/api/setup', { username: 'someone', password: PASSWORD })).status, 409);
  const me = await get('/api/auth/me');
  assert.equal(me.json.authenticated, true);
  assert.equal(me.json.setupComplete, true);
});

test('after setup the same facts are available, now with names — the wizard learned nothing extra', async () => {
  const services = await get('/api/services');
  assert.equal(services.status, 200);
  const all = [...services.json.services];
  assert.equal(all.length, 25, 'the authenticated view is the same fleet the wizard counted');
  const withUrl = all.filter((s) => s.url).length;
  const reasons = new Map();
  for (const s of all) reasons.set(s.urlReason, (reasons.get(s.urlReason) || 0) + 1);
  assert.equal(withUrl, all.filter((s) => !!s.url).length);
  assert.ok(all.every((s) => typeof s.urlReason === 'string' && s.urlReason), 'every service carries its reason code');
  assert.equal([...reasons.values()].reduce((a, b) => a + b, 0), all.length);

  // the reason code never contradicts the answer it explains
  for (const s of all) {
    if (s.url) assert.ok(['manual', 'traefik', 'published-port'].includes(s.urlReason), `${s.name}: ${s.urlReason} resolved a URL`);
    else assert.ok(!['manual', 'traefik', 'published-port'].includes(s.urlReason), `${s.name}: ${s.urlReason} produced no URL`);
  }
});

test('the wizard needs no URL to finish: a fleet with nothing routable still sets up', async () => {
  // A second, separate install — no engine at all this time. That is the worst case the wizard
  // must survive: nothing to resolve, nothing to list, and setup still completes.
  const scratch2 = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-api-setup-empty-'));
  const port2 = PORT + 1;
  const child2 = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPUSHUB_CONFIG_DIR: path.join(scratch2, 'config'),
      OPUSHUB_DATA_DIR: path.join(scratch2, 'data'),
      OPUSHUB_PORT: String(port2),
      OPUSHUB_HOST: '127.0.0.1',
      OPUSHUB_DOCKER_SOCKET: path.join(scratch2, 'no-such.sock'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log2 = '';
  child2.stdout.on('data', (d) => { log2 += d; });
  child2.stderr.on('data', (d) => { log2 += d; });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      if (child2.exitCode !== null) throw new Error(`second server exited: ${log2.slice(-400)}`);
      try { up = (await fetch(`http://127.0.0.1:${port2}/api/health`, { signal: AbortSignal.timeout(800) })).ok; }
      catch { await sleep(200); }
    }
    assert.ok(up, 'the second server started');
    const status = await (await fetch(`http://127.0.0.1:${port2}/api/setup/status`)).json();
    assert.equal(status.required, true);
    assert.equal(status.discovery.docker.ok, false);
    assert.equal(status.discovery.containers, 0);
    assert.equal(status.discovery.urls.detected, 0);
    assert.deepEqual(status.discovery.urls.reasons, [], 'no containers, no reasons to report — not an error');
    const created = await fetch(`http://127.0.0.1:${port2}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    });
    assert.equal(created.status, 201, 'setup completes with no Docker and no URLs at all');
  } finally {
    child2.kill('SIGTERM');
    await new Promise((r) => child2.once('exit', r));
    fs.rmSync(scratch2, { recursive: true, force: true });
  }
});
