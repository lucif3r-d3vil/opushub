// Phase 7G — the mechanical proofs: Docker is GET-only (statically in the client,
// dynamically on the wire for a full API sweep), secrets and socket paths never leave
// the server in the Phase-7 responses, and the API's security headers are present.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine } from '../test/mock-engine.js';

const OLD_ENV = { ...process.env };
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p7proof-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p7proof-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const ROOT = new URL('..', import.meta.url).pathname;

let ENGINE = null;
let handleApi;
let COOKIE = null;

function req(method) {
  return { method, headers: COOKIE ? { cookie: COOKIE } : {}, [Symbol.asyncIterator]() { return { next: async () => ({ value: undefined, done: true }) }; } };
}
function res() {
  const state = { status: 200, body: '', headers: {} };
  return {
    state,
    setHeader: (k, v) => { state.headers[String(k).toLowerCase()] = v; },
    writeHead: (s, h) => { state.status = s; for (const [k, v] of Object.entries(h || {})) state.headers[String(k).toLowerCase()] = v; },
    end: (b) => { state.body = String(b ?? ''); },
  };
}
async function get(pathname) {
  const r = res();
  await handleApi(req('GET'), r, new URL(pathname, 'http://x'));
  let json = null;
  try { json = JSON.parse(r.state.body || 'null'); } catch { /* some routes answer text */ }
  return { status: r.state.status, json, text: r.state.body, headers: r.state.headers };
}

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  ({ handleApi } = await import('./api.js'));
  const { seedSession } = await import('../test/auth-helper.js');
  COOKIE = await seedSession();
});

test.after(async () => {
  await ENGINE?.stop();
  process.env = OLD_ENV;
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// --- static: the Docker client cannot speak anything but GET ------------------------

test('docker client source is mechanically GET-only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/providers/docker.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.ok(code.includes('http.get'), 'the client issues requests via http.get');
  for (const banned of ['http.request(', '.post(', '.put(', '.patch(', '.delete(', '.del(', 'method:']) {
    assert.ok(!code.includes(banned), `the client must not contain ${banned}`);
  }
  // Mutating engine operations have no path here — not even as string fragments.
  for (const op of ['/start', '/stop', '/restart', '/kill', '/exec', '/prune', '/commit', '/rename', '/update', '/pause', '/unpause', '/attach', '/resize', '/copy', '/archive']) {
    assert.ok(!code.includes(`'${op}'`) && !code.includes(`"${op}"`) && !code.includes(`\`${op}`),
      `the client must not reference the ${op} operation`);
  }
});

test('no other server module talks to the engine socket', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) { if (f.name !== 'node_modules') walk(full); continue; }
      if (!f.name.endsWith('.js') || f.name.endsWith('.test.js')) continue;
      const src = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
      if (/OPUSHUB_DOCKER_SOCKET|DOCKER_HOST|docker\.sock/.test(src)
        && !full.endsWith('server/providers/docker.js') && !full.endsWith('server/env.js')) {
        // Phase 10D — the container configuration policy names the socket path in order to
        // REFUSE a container that mounts it. It is a deny-list, not a client: it must contain no
        // transport at all.
        if (full.endsWith('server/containers/policy.js')) {
          assert.ok(!/node:net|node:http|socketPath|request\(|fetch\(/.test(src), 'containers/policy.js must not contain a transport');
          continue;
        }
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  walk(path.join(ROOT, 'server'));
  assert.deepEqual(offenders, [], 'only the docker provider (and env resolution) may touch the socket');
});

// --- dynamic: the wire log of a full API sweep is GET-only ----------------------------

test('a full API sweep issues only GET requests to the engine', async () => {
  ENGINE.reset();
  const inv = await get('/api/services');
  assert.equal(inv.status, 200);
  const svc = inv.json.services.find((s) => s.container?.state === 'running') || inv.json.services[0];
  const svcPath = `/api/services/${encodeURIComponent(svc.group)}/${encodeURIComponent(svc.name)}`;

  const paths = [
    '/api/stacks', '/api/discovery', '/api/host', '/api/networks', '/api/volumes', '/api/images',
    '/api/system', '/api/resources', '/api/storage', '/api/alerts', '/api/updates', '/api/version',
    '/api/providers', '/api/activity?limit=20', '/api/search?q=wave', svcPath, `${svcPath}/health`,
    `/api/docker/containers/${encodeURIComponent(svc.name)}/logs?tail=10`,
    '/api/v1/services', '/api/v1/stacks', '/api/v1/resources',
  ];
  for (const p of paths) {
    const r = await get(p);
    assert.ok(r.status < 500, `${p} answered ${r.status}`);
  }
  assert.ok(ENGINE.log.length > 5, 'the sweep actually talked to the engine');
  for (const line of ENGINE.log) {
    assert.ok(line.startsWith('GET '), `non-GET engine call: ${line}`);
  }
  const joined = `\n${ENGINE.log.join('\n')}`;
  for (const op of ['/start', '/stop', '/restart', '/kill', '/exec', '/prune']) {
    assert.ok(!new RegExp(` ${op}(\\?|$|/)`).test(joined), `engine wire log references ${op}`);
  }
});

// --- secret-leak audit over the Phase-7 surface ------------------------------------------

test('Phase-7 responses carry no secrets, env values or socket paths', async () => {
  const inv = await get('/api/services');
  const svc = inv.json.services[0];
  const svcPath = `/api/services/${encodeURIComponent(svc.group)}/${encodeURIComponent(svc.name)}`;
  const blobs = [];
  for (const p of ['/api/services', '/api/stacks', '/api/discovery', '/api/host', '/api/networks',
    '/api/volumes', '/api/images', '/api/system', '/api/resources', '/api/storage', '/api/alerts',
    '/api/updates', svcPath, `${svcPath}/health`]) {
    blobs.push((await get(p)).text);
  }
  const whole = blobs.join('\n');
  assert.ok(!whole.includes('hunter2'), 'the mock engine planted env secret leaked');
  assert.ok(!whole.includes('SECRET_SHOULD_NEVER_LEAVE_SERVER'), 'an env key name leaked');
  assert.ok(!whole.includes('MOCK_FIXTURE=true'), 'env values leak through the projection');
  for (const sock of ['/var/run/docker.sock', '/run/docker.sock', '.sock']) {
    assert.ok(!whole.includes(sock), `a socket path leaked (${sock})`);
  }
  assert.ok(!whole.includes('/var/lib/docker'), 'a daemon data path leaked');
});

test('/api/health reports env files by count, never by value', async () => {
  const { status, json } = await get('/api/health');
  assert.equal(status, 200);
  const env = json.env || {};
  assert.ok(Array.isArray(env.files));
  for (const f of env.files) {
    assert.ok(!('values' in f) && !('vars' in f) && !('content' in f), 'an env file entry carries values');
  }
  assert.ok(!JSON.stringify(env).includes('hunter2'));
});

// --- security headers ---------------------------------------------------------------------

test('API responses carry the security headers', async () => {
  const { headers } = await get('/api/version');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.ok(String(headers['content-type'] || '').includes('application/json'));
});
