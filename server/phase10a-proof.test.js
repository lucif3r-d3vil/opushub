// Phase 10A — the mechanical security proof for the Monitoring Engine.
//
// Monitoring is the first part of OpusHub that *reaches out*: it connects to the endpoints it was
// configured to watch. That is a capability with an obvious failure mode (a fetch proxy, a port
// scanner, a Docker write path), so the boundaries are asserted mechanically here — against the
// source, not against intentions — and the pieces that can be exercised cheaply are exercised.
//
// Every assertion below is one of the rules the brief names: no arbitrary URL fetcher, no
// arbitrary TCP scanner, no arbitrary Docker endpoint, no Docker write, no Phase 8 invocation, no
// shell, no arbitrary filesystem read, no notification channel, no AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from '../test/source-scan.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped: assertions are about code, never about prose. */
const code = (rel) => stripComments(read(rel));

/** Every non-test .js file under server/monitoring, relative to the repo root. */
function monitoringFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (e.name.endsWith('.js') && !e.name.includes('.test.')) out.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, 'server', 'monitoring'));
  return out.sort();
}

/** Every non-test .js file under server/, relative to the repo root. */
function serverFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (e.name.endsWith('.js') && !e.name.includes('.test.')) out.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, 'server'));
  return out.sort();
}

const offenders = (files, test_) => files.filter((rel) => {
  let m;
  const re = new RegExp(test_.source, test_.flags.includes('g') ? test_.flags : `${test_.flags}g`);
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(code(rel))) !== null) return true;
  return false;
});

test('the monitoring surface is a fixed set of files, and every one of them is scanned', () => {
  const files = monitoringFiles();
  assert.deepEqual(files, [
    'server/monitoring/checks/docker.js',
    'server/monitoring/checks/http.js',
    'server/monitoring/checks/tcp.js',
    'server/monitoring/discovery.js',
    'server/monitoring/engine.js',
    'server/monitoring/incidents.js',
    'server/monitoring/model.js',
    'server/monitoring/net.js',
    'server/monitoring/scheduler.js',
    'server/monitoring/state.js',
    'server/monitoring/store.js',
  ], 'a new file in the monitoring engine must be reviewed here before it ships');
});

/* ==================================================================== */
/* 1. no arbitrary URL fetcher                                          */
/* ==================================================================== */

test('nothing in monitoring fetches a URL that came from a request', () => {
  // The only outbound HTTP in the engine is checks/http.js, and it is reached through a monitor's
  // stored, validated target. There is no generic fetch helper, no proxy route and no URL that the
  // browser can hand over at check time.
  assert.deepEqual(offenders(monitoringFiles(), /globalThis\.fetch|\bfetch\s*\(/), [], 'monitoring calls fetch()');
  const api = code('server/monitoringApi.js');
  assert.ok(!/fetch\s*\(|http\.request\s*\(|https\.request\s*\(|net\.connect\s*\(/.test(api), 'the API surface opens its own sockets');
  // the check's request options are built from the parsed target, never from a caller-supplied
  // option bag: `path`, `hostname` and `port` come from the URL object
  const httpCheck = code('server/monitoring/checks/http.js');
  assert.ok(/hostname:\s*url\.hostname/.test(httpCheck), 'the request is built from the parsed URL');
  assert.deepEqual([...httpCheck.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]), ['GET'], 'the check only ever issues GET');
  assert.ok(!/\.write\s*\(|\.end\(\s*[A-Za-z]/.test(httpCheck), 'the check writes no request body');
  assert.ok(/res\.destroy\(\)/.test(httpCheck), 'the response body is dropped, not read');
  assert.ok(!/res\.on\(\s*'data'|for await \(.*res\)/.test(httpCheck), 'the response body is never consumed');
  assert.ok(!/maxContentLength|maxBodyLength|\.pipe\s*\(/.test(httpCheck), 'no download plumbing exists');
});

test('every redirect hop is revalidated, and the hop count is bounded', () => {
  const httpCheck = code('server/monitoring/checks/http.js');
  assert.ok(/validateRedirect\s*\(/.test(httpCheck), 'the check validates each hop');
  assert.ok(/MAX_REDIRECTS/.test(httpCheck), 'and bounds them');
  const net = code('server/monitoring/net.js');
  assert.ok(/redirect_downgrade/.test(net), 'an https → http redirect is refused');
  assert.ok(/redirect_credentials/.test(net), 'a redirect carrying credentials is refused');
  assert.ok(/redirect_scheme/.test(net), 'a redirect off http(s) is refused');
  assert.ok(/resolveHost|addressRefusal|classifyIp/.test(net), 'and the redirect target goes back through the address policy');
});

/* ==================================================================== */
/* 2. the address policy: what monitoring may never reach               */
/* ==================================================================== */

test('loopback, link-local/metadata, multicast and the rest are refused for monitoring', async () => {
  const policy = await import('./lib/ipPolicy.js');
  for (const cls of ['loopback', 'link-local', 'multicast', 'unspecified', 'reserved', 'documentation', 'benchmark', 'discard', 'invalid']) {
    assert.ok(policy.BLOCKED_FOR_MONITOR.has(cls), `${cls} must be refused`);
  }
  // while a LAN address stays a legitimate thing to monitor — the whole point of a homelab
  for (const cls of ['private', 'shared', 'unique-local', 'public']) {
    assert.equal(policy.BLOCKED_FOR_MONITOR.has(cls), false, `${cls} must be allowed`);
  }
  // one classifier, two policies: the background fetcher is stricter than monitoring
  assert.ok(policy.BLOCKED_FOR_REMOTE_FETCH.has('private'));
  assert.equal(policy.BLOCKED_FOR_MONITOR.has('private'), false);
  // and the checks refuse a literal before they ever connect
  const net = await import('./monitoring/net.js');
  for (const ip of ['127.0.0.1', '::1', '169.254.169.254', 'fe80::1', '239.1.1.1', 'ff02::1', '0.0.0.0']) {
    assert.equal(net.addressRefusal(ip)?.code, 'blocked_address', ip);
  }
});

test('a name is only reached when *every* answer is allowed, and the checked address is pinned', async () => {
  const net = await import('./monitoring/net.js');
  const mixed = await net.resolveHost('mixed.lab.internal', {
    lookup: async () => [{ address: '10.0.0.9', family: 4 }, { address: '169.254.169.254', family: 4 }],
  });
  assert.equal(mixed.ok, false, 'one bad answer refuses the whole name (DNS rebinding)');
  const fine = await net.resolveHost('ok.lab.internal', { lookup: async () => [{ address: '10.0.0.9', family: 4 }] });
  assert.equal(fine.pinned, '10.0.0.9', 'the validated address is the one that gets connected to');
  // the checks pass that pin into the socket, so a second DNS answer cannot move the connection
  const httpCheck = code('server/monitoring/checks/http.js');
  assert.ok(/pinnedLookup\(pinned\.address/.test(httpCheck), 'the HTTP check connects to the pinned address');
  const tcpCheck = code('server/monitoring/checks/tcp.js');
  assert.ok(/address:\s*resolved\.pinned/.test(tcpCheck), 'the TCP check connects to the pinned address');
});

test('there is one address classifier, and monitoring does not re-implement it', () => {
  // Two older modules mention address prefixes, and both only ever *exclude* a host from something
  // they are about to display or publish — neither decides whether a connection may be made. They
  // are listed here so that adding a third one is a visible decision rather than a passing test.
  const PRESENTATION_ONLY = ['server/lib/hostAddress.js', 'server/urlResolver.js'];
  for (const rel of PRESENTATION_ONLY) {
    const src = code(rel);
    assert.equal(/fetch\s*\(|net\.connect|createConnection|http\.request|https\.request/.test(src), false, `${rel} is on a connection path after all`);
    assert.equal(/remoteFetchBlocked|classifyIp|BLOCKED_FOR_/.test(src), false, `${rel} decides policy after all`);
  }
  // the ranges live in exactly one module: no second SSRF implementation, no hand-rolled regex
  const withRanges = serverFiles().filter((rel) => {
    const src = code(rel);
    return /192\.168|172\.16|10\.0\.0\.0\/8|169\.254/.test(src)
      && rel !== 'server/lib/ipPolicy.js' && !PRESENTATION_ONLY.includes(rel);
  });
  assert.deepEqual(withRanges, [], 'an address range is defined outside the shared classifier');
  const classifiers = serverFiles().filter((rel) => /classifyIp|remoteFetchBlocked|isInternalAddress|allowedForMonitor/.test(code(rel)));
  for (const rel of classifiers) {
    assert.equal(/from '.*lib\/ipPolicy\.js'|from '\.\.?\/.*ipPolicy\.js'/.test(code(rel)) || rel === 'server/lib/ipPolicy.js', true, `${rel} uses the policy without importing it`);
  }
  // and the monitoring surface is one of its consumers
  assert.equal(classifiers.includes('server/monitoring/net.js'), true);
  assert.equal(classifiers.includes('server/providers/background.js'), true);
});

test('internal targets are a bounded capability, not an SSRF primitive', async () => {
  const model = await import('./monitoring/model.js');
  const { scopeOf, addressRefusal } = await import('./monitoring/net.js');
  const net = code('server/monitoring/net.js');
  // 1. the always-blocked classes are refused before the policy setting is even consulted
  for (const ip of ['127.0.0.1', '::1', '169.254.169.254', 'fe80::1', '169.254.1.1']) {
    assert.equal(addressRefusal(ip, { allowInternal: true })?.code, 'blocked_address', ip);
    assert.equal(addressRefusal(ip, { allowInternal: false })?.code, 'blocked_address', ip);
  }
  // 2. internal space is a setting, off-switch included, and it refuses in the resolver (not in a
  //    second check inside each check module)
  assert.equal(model.normalizeSettings({}).allowInternal, true);
  assert.equal(model.normalizeSettings({ allowInternal: false }).allowInternal, false);
  assert.equal(addressRefusal('10.0.0.9', { allowInternal: false })?.code, 'internal_blocked');
  assert.ok(/allowInternal/.test(net), 'the resolver owns the policy');
  const engine = code('server/monitoring/engine.js');
  assert.ok(/allowInternal: settings\.allowInternal !== false/.test(engine), 'the engine is the only place the setting is read');
  // 3. what a check reached is recorded, so an internal endpoint is visible rather than implicit
  assert.deepEqual([...model.TARGET_SCOPES], ['public', 'internal', 'mixed']);
  assert.equal(scopeOf(['private']), 'internal');
  assert.equal(scopeOf(['private', 'public']), 'mixed');
  assert.equal(scopeOf(['public']), 'public');
  assert.equal(scopeOf([]), null, 'nothing measured is not "public"');
  assert.ok(/monitor\.target\.scope = scope/.test(engine), 'the observed scope is stored on the target');
  // 4. and a policy refusal is never an outage: it cannot open an incident
  const checks = ['server/monitoring/checks/http.js', 'server/monitoring/checks/tcp.js'].map(code);
  for (const src of checks) {
    assert.ok(/internal_blocked/.test(src), 'a refusal is classified as such');
    assert.ok(/refused \? UNKNOWN : FAIL/.test(src), 'and yields no verdict rather than a failure');
  }
});

/* ==================================================================== */
/* 3. TCP: one endpoint, never a scan                                   */
/* ==================================================================== */

test('the TCP check cannot express a range, a list or a sweep', async () => {
  const { parseTcpEndpoint } = await import('./monitoring/net.js');
  const { parsePort, parseHost } = await import('./monitoring/model.js');
  for (const host of ['10.0.0.0/24', '10.0.0.1-10.0.0.50', '10.0.0.1,10.0.0.2', '10.0.0.*', '10.0.0.1 10.0.0.2']) {
    assert.equal(parseTcpEndpoint(host, 80).ok, false, `${host} must not be a monitor target`);
    assert.throws(() => parseHost(host), /single host|wildcard|hostname/, `${host} must not validate as a host`);
  }
  for (const port of ['22-80', '22,80', '22 80', '0', '65536', '1-65535']) {
    assert.equal(parseTcpEndpoint('10.0.0.9', port).ok, false, `${port} must not be a monitor port`);
    assert.throws(() => parsePort(port), /Port/);
  }
  // and there is exactly one connect call in the whole module, against one address
  const tcp = code('server/monitoring/checks/tcp.js');
  assert.equal([...tcp.matchAll(/net\.connect\s*\(/g)].length, 1, 'the TCP check has exactly one connect');
  assert.ok(!/for\s*\(|while\s*\(|Promise\.all|Array\.from/.test(tcp), 'nothing in the TCP check iterates over targets');
});

/* ==================================================================== */
/* 4. Docker: read-only, and never an arbitrary endpoint                */
/* ==================================================================== */

test('monitoring can read container state and can never write it', () => {
  for (const rel of monitoringFiles()) {
    const src = code(rel);
    for (const forbidden of [/dockerOperations/, /operations\/(engine|registry|targets|locks|store|policy)\.js/, /\boperationsApi\b/]) {
      assert.equal(forbidden.test(src), false, `${rel} reaches the write path (${forbidden})`);
    }
    for (const verb of ['restart', 'start', 'stop', 'kill', 'remove', 'prune', 'update', 'create', 'exec']) {
      const pattern = new RegExp(`dockerOps\\.${verb}|${verb}Container\\s*\\(|container\\.${verb}\\s*\\(`);
      assert.equal(pattern.test(src), false, `${rel} calls ${verb}`);
    }
  }
  const dockerCheck = code('server/monitoring/checks/docker.js');
  // the check's entire vocabulary of Docker calls is the read client
  assert.ok(/import \* as docker from '\.\.\/\.\.\/providers\/docker\.js'/.test(dockerCheck), 'the Docker check imports the read client');
  assert.ok(!/POST|PUT|PATCH|DELETE/.test(dockerCheck), 'no write verb appears in the Docker check');
  assert.ok(!/socketPath|DOCKER_HOST/.test(dockerCheck), 'the check never chooses a socket');
  assert.ok(/inspectContainer/.test(dockerCheck), 'and reads through the provider API');
});

test('monitoring does not accept a container id or an arbitrary Docker endpoint as a target', async () => {
  const model = await import('./monitoring/model.js');
  assert.throws(() => model.validateTarget('docker', { service: { name: 'abcdef123456' } }), /not a container id/);
  assert.throws(() => model.validateTarget('docker', { service: { name: 'a'.repeat(64) } }), /not a container id/);
  assert.throws(() => model.validateTarget('docker', { service: { name: '/var/run/docker.sock' } }), /paths or endpoints/);
  assert.equal(model.validateTarget('docker', { service: { group: 'Media', name: 'jellyfin' } }).service.name, 'jellyfin');
  for (const rel of monitoringFiles()) {
    assert.equal(/unix:\/\/|DOCKER_HOST|socketPath/.test(code(rel)), false, `${rel} names a Docker socket`);
  }
});

/* ==================================================================== */
/* 5. no Phase 8 engine, no shell, no arbitrary filesystem              */
/* ==================================================================== */

test('monitoring never invokes the Phase 8 operations engine', () => {
  const engine = code('server/monitoring/engine.js');
  assert.equal(/operations/.test(engine), false, 'the engine names the operations module');
  for (const rel of [...monitoringFiles(), 'server/monitoringApi.js']) {
    assert.equal(/phase8|Phase 8/.test(code(rel)), false, `${rel} leans on Phase 8`);
  }
  // and nothing that monitoring does can reach a lifecycle endpoint
  for (const rel of [...monitoringFiles(), 'server/monitoringApi.js']) {
    assert.equal(/restartContainer|startContainer|stopContainer/.test(code(rel)), false, `${rel} names a lifecycle call`);
  }
});

test('monitoring runs no command and reads no file it did not write', async () => {
  for (const rel of [...monitoringFiles(), 'server/monitoringApi.js']) {
    const src = code(rel);
    assert.equal(/child_process|execSync|spawnSync|\bspawn\s*\(|\.exec\s*\(/.test(src), false, `${rel} can run a command`);
    if (rel !== 'server/monitoring/store.js') {
      assert.equal(/readFileSync|createReadStream|readdirSync|opendirSync|statSync/.test(src), false, `${rel} reads the filesystem directly`);
    }
    assert.equal(/process\.env\.OPUSHUB_[A-Z_]*(PATH|FILE|DIR)/.test(src), false, `${rel} takes a path from the environment`);
  }
  // the one module that touches disk writes and reads exactly four known documents — and does it
  // through one gated path helper, with no directory listing of any kind
  const store = code('server/monitoring/store.js');
  assert.equal(/readdir|opendir|glob|walk/.test(store), false, 'the store never enumerates a directory');
  assert.ok(/STORE_FILES/.test(store) && /storePath/.test(store), 'the store has an allow-list');
  const { storePath, STORE_FILES } = await import('./monitoring/store.js');
  assert.deepEqual([...STORE_FILES], ['monitors.json', 'history.json', 'incidents.json', 'engine.json']);
  for (const name of STORE_FILES) assert.ok(storePath(name).endsWith(name));
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'monitors.json/../../../x', '..%2f', 'secrets.json']) {
    assert.throws(() => storePath(bad), /refuses the file/, `${bad} must not resolve to a path`);
  }
  // and the data is not part of the exportable configuration (it is operational state)
  const scope = read('server/configScope.js');
  const scopeCode = stripComments(scope);
  // PRESENTATION_FILES must not contain monitoring — it is operational state, not presentation
  const presBlock = scopeCode.match(/PRESENTATION_FILES\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(presBlock, 'PRESENTATION_FILES block found');
  assert.equal(/monitoring/.test(presBlock[1]), false, 'monitoring state is not presented as configuration');
  // Phase 10B — monitoring, events, notifications are explicitly protected
  assert.ok(/PROTECTED_STATE/.test(scopeCode), 'protected state exists');
});

/* ==================================================================== */
/* 6. no notifications, no AI, and no second alert implementation       */
/* ==================================================================== */

test('monitoring has no notification channel of its own', () => {
  for (const rel of [...monitoringFiles(), 'server/monitoringApi.js']) {
    const src = code(rel);
    for (const forbidden of [/notify/i, /telegram/i, /discord/i, /slack/i, /webhook/i, /smtp/i, /sendmail/i, /nodemailer/i, /EventSource/i, /text\/event-stream/i, /new Notification|Notification\.requestPermission/]) {
      assert.equal(forbidden.test(src), false, `${rel} mentions ${forbidden}`);
    }
  }
  // and the integration with alerts is data, not a second engine: monitoring hands over a
  // snapshot and lets alerts.js decide
  const engine = code('server/monitoring/engine.js');
  assert.ok(/export function alertInputs/.test(engine), 'the engine exposes alert inputs');
  assert.equal(/evaluateAlerts|refreshAlerts/.test(engine), false, 'the engine does not evaluate alerts itself');
});

test('monitoring has no AI surface', () => {
  for (const rel of [...monitoringFiles(), 'server/monitoringApi.js']) {
    const src = code(rel);
    // `user-agent` is an HTTP header, not an AI: the patterns name the services and protocols that
    // would actually be an AI surface
    for (const forbidden of [/openai/i, /anthropic/i, /gemini/i, /ollama/i, /\bllm\b/i, /\bmcp\b/i, /gpt-/i, /claude-/i, /chat\.completions/i, /embeddings/i]) {
      assert.equal(forbidden.test(src), false, `${rel} mentions ${forbidden}`);
    }
  }
});

test('the monitoring API writes monitor definitions, and nothing else', () => {
  const api = code('server/monitoringApi.js');
  // every write route is enumerated, and none of them names a container or a lifecycle verb
  const writes = [...api.matchAll(/method === '(POST|PUT|DELETE)'/g)].map((m) => m[1]);
  assert.ok(writes.length >= 5, 'the write routes exist');
  for (const verb of ['restart', 'startContainer', 'stop', 'kill', 'exec', 'remove', 'prune']) {
    assert.equal(new RegExp(`['"\`][^'"\`]*${verb}`, 'i').test(api), false, `the API surface mentions ${verb}`);
  }
  // and it is mounted inside the same session + CSRF gate as the rest of /api
  const dispatch = read('server/api.js');
  const gate = dispatch.indexOf('auth.authenticate(req)');
  const mount = dispatch.indexOf("p.startsWith('/api/monitoring')");
  assert.ok(gate !== -1 && mount !== -1);
  assert.ok(gate < mount, 'the monitoring mount sits behind the identity gate');
});

test('the engine is started and stopped by the server, and never by a request', () => {
  const index = read('server/index.js');
  assert.ok(/monitoring\/engine\.js|startMonitoring|monitoringEngine/.test(index), 'index.js owns the engine lifecycle');
  const api = read('server/monitoringApi.js');
  assert.equal(/\.start\s*\(|\.stop\s*\(/.test(stripComments(api)), false, 'no request starts or stops the engine');
  // the only module that constructs the scheduler is the engine
  const constructors = serverFiles().filter((rel) => {
    const src = code(rel);
    return /createScheduler\s*\(/.test(src) && !/export function createScheduler/.test(src);
  });
  assert.deepEqual(constructors, ['server/monitoring/engine.js'], 'exactly one module creates a scheduler');
  // and no module outside the engine arms a timer of its own for monitoring
  for (const rel of monitoringFiles().filter((f) => f !== 'server/monitoring/engine.js')) {
    assert.equal(/setInterval/.test(code(rel)), false, `${rel} uses a per-monitor interval`);
  }
});
