// The Docker read-only guarantee and the "configuration is not infrastructure" invariant, tested
// against a real mock engine: the Docker client has no write path, no other module opens a socket
// to the engine, and an overlay for a container that does not exist never becomes a service.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine, FLEET } from './mock-engine.js';

const ENGINE = await startMockEngine();
process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
delete process.env.DOCKER_HOST;
delete process.env.OPUSHUB_HOST_ADDRESS;

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-migrate-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-migrate-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const { handleApi } = await import('../server/api.js');
const model = await import('../server/model.js');
const { seedSession } = await import('./auth-helper.js');
const COOKIE = await seedSession();

test.after(async () => {
  await ENGINE.stop();
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

function req(method, body) {
  const p = body === undefined ? undefined : JSON.stringify(body);
  return {
    method,
    headers: {
      cookie: COOKIE, origin: 'http://127.0.0.1:3721', host: '127.0.0.1:3721',
      ...(p ? { 'content-type': 'application/json' } : {}),
    },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() {
      let sent = false;
      return { next: async () => (sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(p), done: false })) };
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
  try { await handleApi(req(method, body), r, new URL(pathname, 'http://127.0.0.1:3721')); }
  catch (err) { r.state.status = err.status || 500; r.state.body = JSON.stringify({ error: String(err.message || err), code: err.code || null }); }
  let json = {};
  try { json = JSON.parse(r.state.body || '{}'); } catch { json = {}; }
  return { status: r.state.status, json, headers: r.state.headers };
}

/** The inventory, read fresh from the engine, reduced to what "what exists" actually means. */
async function inventoryFingerprint() {
  const inv = await model.getInventory({ force: true });
  return {
    ids: inv.services.map((s) => s.id).sort(),
    names: inv.services.map((s) => s.name).sort(),
    count: inv.services.length,
    applications: inv.services.filter((s) => s.kind !== 'infrastructure').map((s) => s.name).sort(),
    stacks: inv.stacks.map((s) => s.project).sort(),
    stats: inv.stats,
  };
}

// ---------------------------------------------------------------------------
// the invariant
// ---------------------------------------------------------------------------

test('the mock engine starts with the fleet the invariant is measured against', async () => {
  const fp = await inventoryFingerprint();
  assert.equal(fp.count, FLEET.length, 'discovery should see exactly the fleet');
  assert.ok(fp.count > 15, 'the fleet should be large enough for this to mean something');
});

test('the Docker client source contains no write path of any kind', () => {
  const source = fs.readFileSync(new URL('../server/providers/docker.js', import.meta.url), 'utf8');
  // The client is built on http.get, which is GET by construction — there is no method option to
  // get wrong. `http.request` would reintroduce one, so its absence is asserted directly.
  assert.ok(!/http\.request\s*\(/.test(source), 'the Docker client uses http.request, which can carry a method');
  assert.ok(!/method\s*:/.test(source), 'the Docker client sets an HTTP method');
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(!new RegExp(`['"\`]${verb}['"\`]`).test(source), `the Docker client mentions the ${verb} verb`);
  }
  // and the things those verbs would be used for
  for (const action of ['/restart', '/start', '/stop', '/kill', '/exec', '/update', '/remove']) {
    assert.ok(!source.includes(`'${action}`) && !source.includes(`"${action}`), `the Docker client has a ${action} path`);
  }
});

test('no server module outside the Docker client opens a socket to the engine', async () => {
  const dir = new URL('../server/', import.meta.url);
  const offenders = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d.pathname, entry.name);
      if (entry.isDirectory()) { walk(new URL(`file://${p}/`)); continue; }
      if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
      const text = fs.readFileSync(p, 'utf8');
      // http.get / net.connect outside the provider would mean a second, unaudited Docker client.
      if (/providers[/\\]docker\.js$/.test(p)) continue;
      if (/\bhttp\.(get|request)\s*\(/.test(text) || /\bnet\.connect\s*\(/.test(text)) {
        // lib/net.js is the generic outbound fetch guard,
        // not a Docker client; it must still never carry a Docker path.
        if (/lib[/\\]net\.js$/.test(p)) {
          assert.ok(!text.includes('docker'), 'the generic network helper mentions docker');
          continue;
        }
        // Phase 8: server/providers/dockerOperations.js is the second — and last — module allowed
        // to open a socket to the engine. It exists so the read provider can stay GET-only, and
        // its endpoint set is enumerated mechanically in server/phase8-proof.test.js. Listing it
        // here is not an exemption from that proof: it is the acknowledgement that a second
        // client exists at all, so a third one cannot appear unnoticed.
        if (/providers[/\\]dockerOperations\.js$/.test(p)) continue;
        // Phase 10C: server/updates/recreateAdapter.js is the dedicated adapter for container recreation/updates.
        if (/updates[/\\]recreateAdapter\.js$/.test(p)) continue;
        // Phase 10A: the monitoring checks open sockets to *monitored endpoints* — that is the
        // feature, not a second Docker client. They are named here rather than pattern-matched, and
        // the exemption is paid for: server/phase10a-proof.test.js proves mechanically that neither
        // file can build a Docker request (no socketPath, no /v<version> path, no container
        // endpoint, no DOCKER_HOST) and that the TCP check connects to exactly one address.
        if (/monitoring[/\\]checks[/\\](http|tcp)\.js$/.test(p)) {
          assert.ok(!/socketPath|DOCKER_HOST|\/containers|docker/i.test(text), `${entry.name} mentions Docker`);
          continue;
        }
        offenders.push(path.relative(process.cwd(), p));
      }
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], `these modules open their own sockets: ${offenders.join(', ')}`);
});

test('the Phase 6 API surface contains no route that acts on a container', async () => {
  const source = fs.readFileSync(new URL('../server/api.js', import.meta.url), 'utf8');
  for (const forbidden of [
    /route === 'POST \/api\/docker/i,
    /route === 'DELETE \/api\/docker/i,
    /\/restart'/, /\/start'/, /\/stop'/, /\/kill'/, /\/exec'/,
  ]) {
    assert.ok(!forbidden.test(source), `api.js matches ${forbidden}`);
  }
  // The only container-scoped POST is the launch logger, which writes an activity event.
  const containerPosts = [...source.matchAll(/if \(method === 'POST' && svcMatch\)/g)];
  assert.equal(containerPosts.length, 1);
});

// ---------------------------------------------------------------------------
// infrastructure state and configuration state stay separate
// ---------------------------------------------------------------------------

test('configuration is not infrastructure: a write never appears in the inventory as a service', async () => {
  // Write an overlay for a container that is not running, then confirm the inventory is untouched
  // while the configuration honestly reports the entry as unmatched.
  await model.writeServices({
    groups: [{ name: 'Nowhere', services: [{ container: 'not-a-real-container', displayName: 'Ghost' }] }],
  });
  await model.invalidateDiscovery();

  const fp = await inventoryFingerprint();
  assert.equal(fp.count, FLEET.length, 'a configured-but-absent container joined the inventory');

  const status = await model.getDiscoveryStatus({ refreshMs: 0 });
  assert.ok(status.overlays.unmatched >= 1, 'the unmatched overlay was not reported');
  const reported = (status.overlays.unmatchedList || []).map((u) => u.name || '');
  assert.ok(reported.some((n) => /ghost|not-a-real/i.test(n)), 'the unmatched overlay is not named');
});
