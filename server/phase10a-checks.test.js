// Phase 10A — the three checks, against real sockets and a fake inventory.
//
// The servers here are real TCP servers on loopback: what is tested is the check's behaviour
// (what it sends, what it reads, when it gives up, how it classifies the outcome), with the
// address policy injected where the test needs to reach 127.0.0.1 — which the shipped policy
// deliberately refuses, and which is asserted separately below.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

const { checkHttp } = await import('./monitoring/checks/http.js');
const { checkTcp } = await import('./monitoring/checks/tcp.js');
const { checkDocker } = await import('./monitoring/checks/docker.js');
const { __setLookup, addressRefusal, resolveHost, scopeOf } = await import('./monitoring/net.js');

const LOCAL = { address: '127.0.0.1', family: 4, klass: 'loopback' };
const localResolver = async (host) => ({ ok: true, host, addresses: [LOCAL], pinned: LOCAL.address });
const loopback = (port) => `http://127.0.0.1:${port}`;

/** A real HTTP server whose behaviour each test chooses. */
async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    url: (path = '/') => loopback(server.address().port) + path,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** A real TCP server: it accepts and closes, and counts the connections it saw. */
async function accept() {
  const seen = { connections: 0 };
  const server = net.createServer((socket) => { seen.connections += 1; socket.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

test('the HTTP check records the status, the latency and the timestamp — and never the body', async (t) => {
  const big = await serve((req, res) => {
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/html' });
      // far more than any monitor should ever pull: it writes until the socket dies, and stops the
      // moment it does (a server that ignores that would keep the test process busy forever)
      let alive = true;
      res.on('close', () => { alive = false; });
      const chunk = Buffer.alloc(64 * 1024, 'x');
      const pump = () => { if (alive && !res.writableEnded) res.write(chunk) ? setImmediate(pump) : null; };
      pump();
      return;
    }
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello'); return; }
    if (req.url === '/created') { res.writeHead(201); res.end(); return; }
    if (req.url === '/boom') { res.writeHead(500); res.end('nope'); return; }
    res.writeHead(404); res.end();
  });
  const at = Date.now();
  const ok = await checkHttp({ url: big.url('/ok') }, { resolveHost: localResolver, now: at, timeoutMs: 2000 });
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.at, at);
  assert.ok(ok.latencyMs >= 0 && ok.latencyMs < 2000);
  assert.equal(ok.reason, 'HTTP 200');
  assert.equal(ok.evidence.addressClass, 'loopback');

  // an expected status is a status or a range, and a 500 is a failure of the *service*, not of the
  // engine: it is `degraded` (it answered, wrongly), with the code and the expectation in the reason
  const wrong = await checkHttp({ url: big.url('/boom') }, { resolveHost: localResolver, timeoutMs: 2000 });
  assert.equal(wrong.kind, 'degraded');
  assert.equal(wrong.statusCode, 500);
  assert.equal(wrong.code, 'unexpected_status');
  assert.match(wrong.reason, /HTTP 500 \(expected HTTP 200–399\)/);

  const wanted = await checkHttp({ url: big.url('/created') }, { resolveHost: localResolver, timeoutMs: 2000, expected: { status: 201, min: null, max: null } });
  assert.equal(wanted.kind, 'ok', 'an explicitly expected status is honoured');
  const notWanted = await checkHttp({ url: big.url('/ok') }, { resolveHost: localResolver, timeoutMs: 2000, expected: { status: 201, min: null, max: null } });
  assert.equal(notWanted.kind, 'degraded');
  const range = await checkHttp({ url: big.url('/created') }, { resolveHost: localResolver, timeoutMs: 2000, expected: { status: null, min: 200, max: 299 } });
  assert.equal(range.kind, 'ok');

  // the body is never read: a response that would stream forever still costs one round trip
  const started = Date.now();
  const huge = await checkHttp({ url: big.url('/big') }, { resolveHost: localResolver, timeoutMs: 2000 });
  const elapsed = Date.now() - started;
  assert.equal(huge.kind, 'ok');
  assert.equal(huge.statusCode, 200);
  assert.ok(elapsed < 1500, `the check took ${elapsed}ms, which means it was waiting for the body`);
  const noBodies = JSON.stringify(huge);
  assert.equal(noBodies.includes('xxxx'), false, 'no part of the body reached the result');

  t.after(() => big.close());
});

test('a socket that never answers times out, and the timeout is the monitor’s own', async (t) => {
  const silent = await serve(() => { /* never responds */ });
  t.after(() => silent.close());
  const started = Date.now();
  const slow = await checkHttp({ url: silent.url('/hang') }, { resolveHost: localResolver, timeoutMs: 700 });
  const elapsed = Date.now() - started;
  assert.equal(slow.kind, 'fail');
  assert.equal(slow.errorType, 'timeout');
  assert.match(slow.reason, /No response \(timeout\)/);
  assert.equal(slow.latencyMs, null);
  assert.ok(elapsed >= 600 && elapsed < 2500, `timeout took ${elapsed}ms`);

  // a refused connection is a failure too — the service is not answering
  const closed = await serve(() => {});
  const port = closed.port;
  await closed.close();
  const refused = await checkHttp({ url: loopback(port) }, { resolveHost: localResolver, timeoutMs: 1000 });
  assert.equal(refused.kind, 'fail');
  assert.equal(refused.errorType, 'refused');
});

test('redirects are followed, revalidated, bounded, and the hop count is recorded', async (t) => {
  const server = await serve((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
    if (req.url === '/ok') { res.writeHead(200); res.end('fine'); return; }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
    // a redirect to another *host*: the test's resolver points every name at the loopback server,
    // and the port is carried so the hop lands somewhere real
    if (req.url === '/away') { res.writeHead(302, { location: `http://elsewhere.lab.internal:${server.port}/ok` }); res.end(); return; }
    if (req.url === '/blocked') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    res.writeHead(404); res.end();
  });
  const followed = await checkHttp({ url: server.url('/start') }, { resolveHost: localResolver, timeoutMs: 2000 });
  assert.equal(followed.kind, 'ok');
  assert.equal(followed.statusCode, 200);
  assert.equal(followed.hops, 1);
  assert.equal(followed.evidence.hops, 1);

  const loop = await checkHttp({ url: server.url('/loop') }, { resolveHost: localResolver, timeoutMs: 2000 });
  assert.equal(loop.kind, 'degraded');
  assert.equal(loop.code, 'redirect_limit');
  assert.equal(loop.hops, 3, 'at most three hops, then it stops');

  // a redirect whose target is in a refused address class is refused *by the policy*, re-checked on
  // the hop, and never contacted: the answer is `degraded` with the reason, and no incident story
  const blocked = await checkHttp({ url: server.url('/blocked') }, { resolveHost: async (host) => (host === '127.0.0.1' ? { ok: true, host, addresses: [LOCAL], pinned: LOCAL.address } : resolveHost(host)), timeoutMs: 2000 });
  assert.equal(blocked.kind, 'degraded');
  assert.equal(blocked.code, 'redirect_blocked_address');
  assert.match(blocked.reason, /link-local/);

  // and an off-host redirect is re-resolved: the test's resolver sends it to the same loopback
  // server, which is the point — the hop went through the policy again
  const away = await checkHttp({ url: server.url('/away') }, { resolveHost: localResolver, timeoutMs: 2000 });
  assert.equal(away.kind, 'ok');
  assert.equal(away.evidence.addressClass, 'loopback', 'the hop went through the address policy again');
  assert.equal(away.hops, 1);
  t.after(() => server.close());
});

test('the HTTP check refuses what the address policy refuses, and says why', async () => {
  for (const [url, klass] of [
    ['http://127.0.0.1:8080/', 'loopback'],
    ['http://[::1]:8080/', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'link-local'],
    ['http://[fe80::1]/', 'link-local'],
    ['http://239.1.1.1/', 'multicast'],
    ['http://0.0.0.0/', 'unspecified'],
  ]) {
    const out = await checkHttp({ url }, { timeoutMs: 500 });
    assert.equal(out.kind, 'unknown', `${url} must not be called "down"`);
    assert.equal(out.code, 'blocked_address', url);
    assert.equal(out.errorType, 'blocked_address');
    assert.match(out.reason, new RegExp(klass), url);
  }
  // a bad URL is a configuration problem, never an outage
  const bad = await checkHttp({ url: 'not a url' }, { timeoutMs: 500 });
  assert.equal(bad.kind, 'unknown');
  assert.ok(bad.code);
  // and a refused hostname resolution is a *failure to reach*, not an outage of the service itself
  const dns = await checkHttp({ url: 'http://nothing.lab.internal/' }, {
    timeoutMs: 500,
    resolveHost: async () => ({ ok: false, code: 'dns', reason: 'the name did not resolve' }),
  });
  assert.equal(dns.kind, 'fail');
  assert.equal(dns.errorType, 'dns');
});

test('the request a monitor makes is a plain GET and carries nothing but a user agent', async (t) => {
  let seen = null;
  const server = await serve((req, res) => { seen = { method: req.method, headers: req.headers, url: req.url }; res.writeHead(200); res.end(); });
  t.after(() => server.close());
  await checkHttp({ url: server.url('/status?full=1') }, { resolveHost: localResolver, timeoutMs: 2000 });
  assert.equal(seen.method, 'GET');
  assert.equal(seen.url, '/status?full=1');
  assert.match(seen.headers['user-agent'], /^OpusHub\//);
  assert.equal(seen.headers.cookie, undefined, 'a monitor sends no credentials');
  assert.equal(seen.headers.authorization, undefined);
});

test('the TCP check connects to exactly one endpoint and closes immediately', async (t) => {
  const listener = await accept();
  t.after(() => listener.close());
  const out = await checkTcp({ host: '127.0.0.1', port: listener.port }, { resolveHost: localResolver, timeoutMs: 1000 });
  assert.equal(out.kind, 'ok');
  assert.match(out.reason, new RegExp(`127\\.0\\.0\\.1:${listener.port}`));
  assert.ok(out.latencyMs >= 0);
  assert.equal(listener.seen.connections, 1, 'one connection, not a sweep');

  // a closed port is a failure, not an unknown
  const dead = await accept();
  const deadPort = dead.port;
  await dead.close();
  const refused = await checkTcp({ host: '127.0.0.1', port: deadPort }, { resolveHost: localResolver, timeoutMs: 1000 });
  assert.equal(refused.kind, 'fail');
  assert.equal(refused.errorType, 'refused');
  assert.equal(refused.latencyMs, null);
});

test('the TCP check never connects to a refused address, a range, a list or a bad port', async () => {
  let attempted = 0;
  const spy = async () => { attempted += 1; return { latencyMs: 1 }; };
  const configs = [
    [{ host: '169.254.169.254', port: 80 }, /link-local/],
    [{ host: '127.0.0.1', port: 80 }, /loopback/],
    [{ host: '10.0.0.0/24', port: 80 }, /host/i],
    [{ host: '10.0.0.1-10.0.0.50', port: 80 }, /host/i],
    [{ host: '10.0.0.1,10.0.0.2', port: 80 }, /host/i],
    [{ host: '10.0.0.9', port: '22-80' }, /port/i],
    [{ host: '10.0.0.9', port: '22,80' }, /port/i],
    [{ host: '10.0.0.9', port: 0 }, /port/i],
  ];
  for (const [target, pattern] of configs) {
    const out = await checkTcp(target, { resolveHost, connect: spy, timeoutMs: 200 });
    assert.equal(out.kind, 'unknown', `${JSON.stringify(target)} should have no verdict`);
    assert.match(out.reason, pattern);
    assert.equal(attempted, 0, `${JSON.stringify(target)} must not open a socket`);
  }
  // with an injected resolver that allows loopback, exactly one connect happens
  const one = await checkTcp({ host: '10.0.0.9', port: 8080 }, { resolveHost: localResolver, connect: spy, timeoutMs: 200 });
  assert.equal(one.kind, 'ok');
  assert.equal(attempted, 1);
});

test('the Docker check reads the canonical inventory and maps every container state honestly', async () => {
  const inventory = (...services) => ({ live: true, groups: [{ name: 'Media', services: services.map((s) => ({ group: 'Media', kind: 'application', ...s })) }], services: [] });
  const running = (health) => inventory({ name: 'jellyfin', displayName: 'Jellyfin', id: 'abcdef123456', container: { name: 'media-jellyfin-1', state: 'running', health } });
  const target = { service: { group: 'Media', name: 'jellyfin' } };
  const healthy = { state: { status: 'running', health: 'healthy' }, name: 'media-jellyfin-1' };

  const up = await checkDocker(target, { inventory: running(null), inspect: async () => healthy });
  assert.equal(up.kind, 'ok');
  assert.equal(up.evidence.health, 'healthy');
  assert.equal(up.evidence.application, 'proven by healthcheck');
  assert.equal(up.evidence.containerId, 'abcdef123456');

  const noCheck = await checkDocker(target, { inventory: running(null), inspect: async () => ({ state: { status: 'running', health: null }, name: 'media-jellyfin-1' }) });
  assert.equal(noCheck.kind, 'ok');
  assert.equal(noCheck.evidence.application, 'unproven — no healthcheck', 'running is not a claim that the application answers');
  assert.match(noCheck.reason, /container state only/);

  const unhealthy = await checkDocker(target, { inventory: running(null), inspect: async () => ({ state: { status: 'running', health: 'unhealthy' } }) });
  assert.equal(unhealthy.kind, 'degraded');
  assert.equal(unhealthy.evidence.application, 'healthcheck failing');

  const starting = await checkDocker(target, { inventory: running(null), inspect: async () => ({ state: { status: 'running', health: 'starting' } }) });
  assert.equal(starting.kind, 'unknown', 'a healthcheck that has not finished is not a verdict');

  const restarting = await checkDocker(target, { inventory: inventory({ name: 'jellyfin', container: { name: 'jellyfin', state: 'restarting', health: null } }) });
  assert.equal(restarting.kind, 'unknown');
  const exited = await checkDocker(target, { inventory: inventory({ name: 'jellyfin', container: { name: 'jellyfin', state: 'exited', health: null } }) });
  assert.equal(exited.kind, 'fail');
  const dead = await checkDocker(target, { inventory: inventory({ name: 'jellyfin', container: { name: 'jellyfin', state: 'dead', health: null } }) });
  assert.equal(dead.kind, 'fail');

  // a target that no longer resolves is stale, never "down" and never invented
  const stale = await checkDocker(target, { inventory: inventory({ name: 'other', displayName: 'Other', container: { name: 'other', state: 'running', health: null } }) });
  assert.equal(stale.kind, 'unknown');
  assert.equal(stale.code, 'stale_target');
  assert.equal(stale.stale, true);

  // and an engine that is not reachable yields no verdict at all
  const offline = await checkDocker(target, { inventory: { live: false, groups: [], services: [] } });
  assert.equal(offline.kind, 'unknown');
  assert.equal(offline.code, 'docker_unavailable');
  const noService = await checkDocker({}, {});
  assert.equal(noService.kind, 'unknown');
  assert.equal(noService.code, 'invalid_target');
});

test('the Docker check inspects at most once, and only a running container', async () => {
  const calls = [];
  const inventory = { live: true, groups: [{ name: 'G', services: [{ group: 'G', name: 's', id: 'abc123456789', container: { name: 's-1', state: 'running', health: null } }] }], services: [] };
  await checkDocker({ service: { group: 'G', name: 's' } }, { inventory, inspect: async (ref) => { calls.push(ref); return { state: { status: 'running', health: 'healthy' } }; } });
  assert.deepEqual(calls, ['abc123456789'], 'exactly one read, by the canonical id');

  const stopped = { live: true, groups: [{ name: 'G', services: [{ group: 'G', name: 's', id: 'abc123456789', container: { name: 's-1', state: 'exited', health: null } }] }], services: [] };
  await checkDocker({ service: { group: 'G', name: 's' } }, { inventory: stopped, inspect: async () => { throw new Error('must not be called'); } });
});

/** The refusal code for one literal, or null when it is allowed. */
const resolveRefusal = (ip, opts) => addressRefusal(ip, opts)?.code ?? null;

test('a check records the scope it actually reached, and internal targets can be switched off', async (t) => {
  const server = await serve((req, res) => { res.writeHead(200); res.end('ok'); });
  t.after(() => server.close());
  const lan = async (host) => ({ ok: true, host, addresses: [{ address: '10.0.0.9', family: 4, klass: 'private' }], pinned: '10.0.0.9' });
  const mixed = async (host) => ({
    ok: true, host,
    addresses: [{ address: '10.0.0.9', family: 4, klass: 'private' }, { address: '203.0.113.9', family: 4, klass: 'public' }],
    pinned: '10.0.0.9',
  });

  const lanResult = await checkHttp({ url: server.url('/ok') }, { resolveHost: lan, timeoutMs: 2000 });
  assert.equal(lanResult.kind, 'ok');
  assert.equal(lanResult.evidence.addressClass, 'private');
  assert.deepEqual(lanResult.evidence.addressClasses, ['private'], 'every validated address is recorded');
  assert.equal(scopeOf(lanResult.evidence.addressClasses), 'internal');
  assert.equal(scopeOf((await checkHttp({ url: server.url('/ok') }, { resolveHost: mixed, timeoutMs: 2000 })).evidence.addressClasses), 'mixed');

  // the same target, with internal monitoring switched off, through the *shipped* resolver: the
  // literal is refused before anything is dialled, and a policy refusal is not an outage
  let connected = 0;
  const refused = await checkHttp({ url: 'http://10.0.0.9:8096/ok' }, {
    timeoutMs: 2000,
    requestOne: async () => { connected += 1; throw new Error('must not connect'); },
    allowInternal: false,
  });
  assert.equal(connected, 0, 'a refused internal target never opens a socket');
  assert.equal(refused.kind, 'unknown', 'a policy refusal is not an outage');
  assert.equal(refused.code, 'internal_blocked');
  // and with the policy off, the same literal is monitored normally (no connection is possible
  // here, so the check reports a failure — what matters is that it was allowed to try)
  const allowed = await checkHttp({ url: 'http://10.0.0.9:8096/ok' }, {
    timeoutMs: 250,
    requestOne: async () => { connected += 1; const err = new Error('connect ECONNREFUSED'); err.code = 'ECONNREFUSED'; throw err; },
  });
  assert.equal(connected, 1, 'an internal endpoint is a normal monitor target by default');
  assert.equal(allowed.kind, 'fail');
  assert.equal(allowed.code, null);

  // and the always-blocked classes stay blocked either way, through the shipped resolver
  const loop = await checkHttp({ url: server.url('/ok') }, { timeoutMs: 2000, allowInternal: false });
  assert.equal(loop.code, 'blocked_address', 'loopback is refused before anything is dialled');
  assert.equal(loop.kind, 'unknown');
  assert.equal(resolveRefusal('127.0.0.1', { allowInternal: false }), 'blocked_address', 'loopback is never reachable');
  assert.equal(resolveRefusal('169.254.169.254'), 'blocked_address', 'metadata is never reachable');
  assert.equal(resolveRefusal('10.0.0.9'), null, 'a LAN address is reachable by default');
  assert.equal(resolveRefusal('10.0.0.9', { allowInternal: false }), 'internal_blocked');

  const tcpLan = await checkTcp({ host: '10.0.0.9', port: 8096 }, { resolveHost: lan, connect: async () => ({ latencyMs: 3 }) });
  assert.deepEqual(tcpLan.evidence.addressClasses, ['private']);
});

test('__setLookup is the only seam: the shipped resolver is the system one', async () => {
  __setLookup(async (host) => [{ address: '10.1.2.3', family: 4 }]);
  const injected = await resolveHost('pinned.lab.internal');
  assert.equal(injected.pinned, '10.1.2.3');
  __setLookup(null);
  const real = await resolveHost('localhost');
  assert.equal(real.ok, false, 'the shipped policy refuses a loopback answer for a name too');
  assert.equal(real.code, 'blocked_address');
});
