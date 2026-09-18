// Phase 10A — the monitor model and the address policy.
//
// Everything a monitor can be is decided here, on the server: the type, the target, the bounds,
// the provenance and the state vocabulary. These tests are the contract the API and the checks rely
// on, and several of them are the reason the brief's "no arbitrary URL fetcher / no TCP scanner /
// no arbitrary Docker endpoint" rules are properties of the code rather than of the UI.
import test from 'node:test';
import assert from 'node:assert/strict';

const model = await import('./monitoring/model.js');
const policy = await import('./lib/ipPolicy.js');
const net = await import('./monitoring/net.js');

const {
  BOUNDS, MONITOR_STATES, MONITOR_TYPES, PROVENANCE, UNSAFE_HTTP_PORTS,
  clampSetting, describeExpected, makeMonitor, maintenanceActive, newMonitorId, normalizeSettings,
  normalizeStoredMonitor, parseHost, parseHttpEndpoint, parsePort, publicMonitor, validateTarget,
} = model;

const DEFAULTS = normalizeSettings({});
const draft = (over = {}) => ({ name: 'Jellyfin', type: 'http', target: { url: 'https://stream.lab.internal' }, ...over });
const throws = (fn, pattern) => {
  try { fn(); } catch (err) { assert.ok(err instanceof model.MonitorError, 'thrown error is a MonitorError'); assert.match(err.message, pattern); return err; }
  assert.fail('expected a refusal');
};

test('the monitor type vocabulary is exactly http, tcp, docker — and nothing else', () => {
  assert.deepEqual([...MONITOR_TYPES], ['http', 'tcp', 'docker']);
  for (const future of ['dns', 'icmp', 'ping', 'filesystem', 'storage', 'reverse-proxy', 'custom', 'exec', 'shell', 'docker_api']) {
    throws(() => makeMonitor(draft({ type: future }), { defaults: DEFAULTS }), /Monitor type must be one of http, tcp, docker/);
  }
  assert.deepEqual([...MONITOR_STATES], ['pending', 'up', 'degraded', 'down', 'recovering', 'paused', 'unknown']);
  assert.deepEqual([...PROVENANCE], ['discovered', 'configured', 'imported']);
});

test('every setting is clamped into its server-side bound, whatever the caller sends', () => {
  const loose = normalizeSettings({
    intervalMs: 1, timeoutMs: 999_999, failureThreshold: 0, recoveryThreshold: 99,
    retentionSamples: 1e9, retentionHours: -5, retentionIncidents: 1e9,
    maxMonitors: 100_000, maxConcurrent: 64, jitterMs: 1e9, autoCreate: { enabled: true, max: 1e6 },
  });
  assert.equal(loose.intervalMs, BOUNDS.intervalMs.min);
  assert.equal(loose.timeoutMs, BOUNDS.timeoutMs.max);
  assert.equal(loose.failureThreshold, BOUNDS.failureThreshold.min);
  assert.equal(loose.recoveryThreshold, BOUNDS.recoveryThreshold.max);
  assert.equal(loose.retentionSamples, BOUNDS.retentionSamples.max);
  assert.equal(loose.retentionHours, BOUNDS.retentionHours.min);
  assert.equal(loose.maxMonitors, BOUNDS.maxMonitors.max);
  assert.equal(loose.maxConcurrent, BOUNDS.maxConcurrent.max);
  assert.equal(loose.jitterMs, BOUNDS.jitterMs.max);
  assert.equal(loose.autoCreate.max, BOUNDS.autoCreateMax.max);
  // and the bounds travel with the settings, so a UI cannot invent its own
  assert.equal(loose.bounds.intervalMs.min, 10_000);
  assert.throws(() => clampSetting('nonsense', 5), /unknown setting/);
  // garbage in, defaults out — never NaN, never undefined
  for (const value of [null, undefined, '', 'abc', {}, [], NaN, Infinity]) {
    assert.equal(typeof normalizeSettings({ intervalMs: value }).intervalMs, 'number');
  }
});

test('a monitor carries the whole canonical model, and the id is server-generated', () => {
  const m = makeMonitor(draft({ provenance: 'discovered', description: 'the media server' }), { defaults: DEFAULTS });
  assert.match(m.id, /^mon-[a-z0-9]{12}$/);
  assert.equal(m.name, 'Jellyfin');
  assert.equal(m.type, 'http');
  assert.equal(m.enabled, true);
  assert.equal(m.status, 'pending');
  assert.equal(m.latencyMs, null);
  assert.equal(m.lastCheck, null);
  assert.equal(m.failureCount, 0);
  assert.equal(m.successCount, 0);
  assert.equal(m.consecutiveFailures, 0);
  assert.equal(m.targetStale, false);
  assert.equal(m.provenance, 'discovered');
  assert.equal(m.description, 'the media server');
  assert.ok(Number.isFinite(m.createdAt) && Number.isFinite(m.updatedAt));
  assert.equal(m.nextCheck, null, 'the scheduler decides when the first check happens, not the model');
  assert.equal(m.maintenance, null);
  // ids never repeat, and a caller cannot choose one
  assert.notEqual(newMonitorId(), newMonitorId());
  assert.equal(makeMonitor(draft({ id: 'mon-attackercontrolled1' }), { defaults: DEFAULTS }).id.startsWith('mon-attackercontrolled'), false);
});

test('an interval may never be shorter than the minimum, and a timeout may never outlive its interval', () => {
  const fast = makeMonitor(draft({ intervalMs: 1, timeoutMs: 30_000 }), { defaults: DEFAULTS });
  assert.equal(fast.intervalMs, BOUNDS.intervalMs.min);
  assert.ok(fast.timeoutMs <= fast.intervalMs - 1000, 'a timeout that can outlive the interval would grow a backlog');
  const slow = makeMonitor(draft({ intervalMs: 3_600_000, timeoutMs: 30_000 }), { defaults: DEFAULTS });
  assert.equal(slow.timeoutMs, 30_000);
  const tiny = makeMonitor(draft({ intervalMs: BOUNDS.intervalMs.min, timeoutMs: 60_000 }), { defaults: DEFAULTS });
  assert.equal(tiny.timeoutMs, BOUNDS.intervalMs.min - 1000);
});

test('an HTTP target is an endpoint, not a string that happens to contain a colon', () => {
  assert.equal(parseHttpEndpoint('http://10.0.0.9:8096/'), 'http://10.0.0.9:8096');
  assert.equal(parseHttpEndpoint('https://stream.lab.internal/jellyfin/web/#/home'), 'https://stream.lab.internal/jellyfin/web');
  throws(() => parseHttpEndpoint('stream.lab.internal:8096'), /must be http:\/\/ or https:\/\//);
  throws(() => parseHttpEndpoint('file:///etc/passwd'), /must be http:\/\/ or https:\/\//);
  throws(() => parseHttpEndpoint('gopher://10.0.0.9/'), /must be http:\/\/ or https:\/\//);
  throws(() => parseHttpEndpoint('http://user:pw@10.0.0.9/'), /must not contain credentials/);
  throws(() => parseHttpEndpoint('http://*.lab.internal/'), /wildcard/);
  throws(() => parseHttpEndpoint(`http://10.0.0.9/${'x'.repeat(400)}`), /path longer than/);
  throws(() => parseHttpEndpoint(''), /Endpoint is required/);
  // an address in a class monitoring never reaches is refused at configuration time
  throws(() => parseHttpEndpoint('http://169.254.169.254/latest/meta-data/'), /link-local space/);
  throws(() => parseHttpEndpoint('http://[fe80::1]/'), /link-local space/);
  throws(() => parseHttpEndpoint('http://239.1.1.1/'), /multicast space/);
});

test('an HTTP monitor refuses the ports that are never an application', () => {
  for (const port of [22, 23, 25, 2375, 2376, 3306, 3389, 5432, 6379, 11211, 27017]) {
    assert.ok(UNSAFE_HTTP_PORTS.has(port), `${port} should be on the refused list`);
    throws(() => parseHttpEndpoint(`http://10.0.0.9:${port}/`), /never an HTTP application/);
  }
  // but an ordinary published port is fine, on a LAN address
  assert.equal(parseHttpEndpoint('http://10.0.0.9:8096/'), 'http://10.0.0.9:8096');
});

test('the expected status is a status or a range, and nothing else', () => {
  const withExpected = (expected) => makeMonitor(draft({ expected }), { defaults: DEFAULTS }).expected;
  const exact = withExpected({ status: 204 });
  assert.deepEqual([exact.status, exact.min, exact.max], [204, null, null]);
  const range = withExpected({ min: 200, max: 299 });
  assert.deepEqual([range.status, range.min, range.max], [null, 200, 299]);
  const dflt = withExpected({});
  assert.deepEqual([dflt.status, dflt.min, dflt.max], [null, 200, 399]);
  for (const bad of [{ status: 99 }, { status: 700 }, { status: 'ok' }, { min: 500, max: 200 }, { min: 0 }]) {
    assert.throws(() => withExpected(bad), model.MonitorError, JSON.stringify(bad));
  }
  // a TCP or Docker monitor has no status code to expect, and never pretends to
  assert.deepEqual(makeMonitor(draft({ type: 'tcp', target: { host: '10.0.0.9', port: 5432 }, expected: { status: 200 } }), { defaults: DEFAULTS }).expected, { status: null, min: null, max: null });
  assert.match(describeExpected(dflt), /200/);
  assert.match(describeExpected(exact), /204/);
});

test('a TCP target is one host and one port — a monitor, not a scanner', () => {
  assert.deepEqual(validateTarget('tcp', { host: '10.0.0.9', port: 8096 }), { kind: 'tcp', host: '10.0.0.9', port: 8096, scope: null, scopeAt: null });
  assert.deepEqual(validateTarget('tcp', { host: '[fd00::5]', port: '80' }), { kind: 'tcp', host: 'fd00::5', port: 80, scope: null, scopeAt: null });
  for (const host of ['10.0.0.0/24', '10.0.0.1-10.0.0.50', '10.0.0.1,10.0.0.2', '10.0.0.1 10.0.0.2', '*.lab.internal', 'http://10.0.0.9/', '10.0.0.9/24', '']) {
    throws(() => validateTarget('tcp', { host, port: 80 }), /Host must be a hostname or IP address|Host is required|Host is not a valid hostname|single host|wildcard/);
  }
  for (const port of ['22-80', '22,80', '22 80', 'http', '0', '65536', '-1', '80;ls', 3.5]) {
    throws(() => validateTarget('tcp', { host: '10.0.0.9', port }), /Port must be/);
  }
  assert.equal(parsePort(443), 443);
});

test('a Docker target is a canonical service reference — never a raw container id or endpoint', () => {
  assert.deepEqual(validateTarget('docker', { service: { group: 'Media', name: 'jellyfin' } }), { kind: 'docker', service: { group: 'Media', name: 'jellyfin' }, scope: null, scopeAt: null });
  // a 12-hex "name" is a container id, and a container id is not a service reference
  assert.throws(() => validateTarget('docker', { service: { group: 'Media', name: 'abcdef123456' } }), /not a container id/);
  assert.throws(() => validateTarget('docker', { service: { name: 'a'.repeat(64) } }), /not a container id/);
  assert.throws(() => validateTarget('docker', { container: 'jellyfin' }), /needs a discovered service/);
  assert.throws(() => validateTarget('docker', { service: { name: '' } }), /needs a discovered service/);
  assert.throws(() => validateTarget('docker', { service: { name: '/var/run/docker.sock' } }), /not paths or endpoints/);
  assert.throws(() => validateTarget('docker', { service: { name: 'jellyfin\\..\\jellyfin' } }), /not paths or endpoints/);
  assert.throws(() => validateTarget('docker', { service: { name: 'x', group: 'y/../z' } }), /Group names are labels/);
});

test('every monitor says where it came from, and the source is data, not a dependency', () => {
  const manual = makeMonitor(draft(), { defaults: DEFAULTS });
  assert.equal(manual.provenance, 'configured');
  assert.equal(manual.source, null);
  const discovered = makeMonitor(draft({
    provenance: 'discovered',
    source: { kind: 'reverse-proxy', provider: 'Traefik', detail: 'router jellyfin' },
  }), { defaults: DEFAULTS });
  assert.equal(discovered.provenance, 'discovered');
  assert.equal(discovered.source.provider, 'Traefik');
  // importing a monitor keeps the import as provenance; an unknown value falls back to configured
  assert.equal(makeMonitor(draft({ provenance: 'imported' }), { defaults: DEFAULTS }).provenance, 'imported');
  assert.equal(makeMonitor(draft({ provenance: 'kuma-import' }), { defaults: DEFAULTS }).provenance, 'configured');
  // the stored record is plain JSON: nothing about a provider is required for it to work
  const round = JSON.parse(JSON.stringify(discovered));
  assert.equal(normalizeStoredMonitor(round, { defaults: DEFAULTS }).type, 'http');
});

test('a maintenance window is bounded, explicit and expressed in the server clock', () => {
  const now = 1_800_000_000_000;
  const window = model.normalizeMaintenance({ until: now + 3_600_000, reason: 'disk swap' }, { now });
  assert.equal(window.until, now + 3_600_000);
  assert.equal(window.reason, 'disk swap');
  assert.equal(maintenanceActive({ maintenance: window }, now + 1), true);
  assert.equal(maintenanceActive({ maintenance: window }, now + 3_600_001), false);
  assert.equal(maintenanceActive({ maintenance: null }, now), false);
  // a window that has already ended is refused rather than stored as a no-op
  throws(() => model.normalizeMaintenance({ until: now - 1 }, { now }), /already ended/);
  // and one that never ends is clamped to the maximum, not accepted
  const forever = model.normalizeMaintenance({ until: now + 400 * 24 * 3_600_000 }, { now });
  assert.equal(forever.until, now + BOUNDS.maintenanceMaxMs.max);
  assert.equal(model.normalizeMaintenance(null, { now }), null);
  assert.equal(model.normalizeMaintenance(undefined, { now }), null);
});

test('the public projection is what the API returns — no internals, and honest about age', () => {
  const m = makeMonitor(draft(), { defaults: DEFAULTS });
  Object.assign(m, {
    status: 'down', latencyMs: 42, lastCheck: { at: 1_700_000_000_000, kind: 'fail', statusCode: null, latencyMs: null, reason: 'No response (refused).' },
    nextCheck: 1_700_000_060_000, failureCount: 7, successCount: 900, consecutiveFailures: 3, streakStartedAt: 1_699_999_000_000,
  });
  const pub = publicMonitor(m, { now: 1_700_000_100_000 });
  assert.equal(pub.id, m.id);
  assert.equal(pub.status, 'down');
  assert.equal(pub.failureCount, 7);
  assert.equal(pub.successCount, 900);
  assert.equal(pub.lastCheck.reason, 'No response (refused).');
  assert.equal(pub.storedStatus, 'down');
  assert.equal(pub.intervalMs, m.intervalMs);
  assert.equal(pub.status, 'down');
  for (const key of Object.keys(pub)) assert.notEqual(typeof pub[key], 'function', `${key} is a function`);
  assert.equal('streakStartedAt' in pub, false, 'internal bookkeeping stays internal');
  // a disabled monitor reports itself as paused, whatever the last verdict was
  assert.equal(publicMonitor({ ...m, enabled: false }, { now: 1_700_000_100_000 }).status, 'paused');
  // and an elapsed maintenance window is not reported as one
  assert.equal(publicMonitor({ ...m, maintenance: { until: 1, reason: 'x' } }, { now: 1_700_000_100_000 }).maintenance, null);
});

test('internal targets are allowed by default, recorded as such, and can be switched off', () => {
  // the setting exists, defaults to on, and is part of the effective settings document
  assert.equal(normalizeSettings({}).allowInternal, true);
  assert.equal(normalizeSettings({ allowInternal: false }).allowInternal, false);
  assert.equal(normalizeSettings({ allowInternal: 'yes' }).allowInternal, true, 'only an explicit false turns it off');
  const monitor = makeMonitor({ name: 'NAS', type: 'http', target: { url: 'http://192.168.1.20:8080/' } }, { defaults: DEFAULTS });
  assert.equal(monitor.target.scope, null, 'a fresh target has no measured scope, and null is not "public"');
  assert.equal(monitor.target.url, 'http://192.168.1.20:8080');

  // a LAN literal is a normal target by default and refused when the instance says public-only
  assert.equal(parseHttpEndpoint('http://10.0.0.9:8096/'), 'http://10.0.0.9:8096');
  throws(() => parseHttpEndpoint('http://10.0.0.9:8096/', { allowInternal: false }), /public endpoints only/);
  assert.equal(parseHost('10.0.0.9'), '10.0.0.9');
  throws(() => parseHost('10.0.0.9', { allowInternal: false }), /public endpoints only/);
  throws(() => validateTarget('http', { url: 'http://10.0.0.9/' }, { allowInternal: false }), /public endpoints only/);
  assert.equal(validateTarget('http', { url: 'https://example.lab.internal/' }).url, 'https://example.lab.internal', 'a public name is unaffected');
  throws(() => makeMonitor({ name: 'LAN', type: 'http', target: { url: 'http://10.0.0.9/' } }, { defaults: normalizeSettings({ allowInternal: false }) }), /public endpoints only/);

  // the classes that are never any monitor's business stay refused whatever the setting says
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/', 'http://224.0.0.1/', 'http://0.0.0.0/']) {
    throws(() => parseHttpEndpoint(url, { allowInternal: true }), /which monitors never reach/);
  }

  // the observed scope travels with a stored record, so "internal" survives a restart
  const stored = normalizeStoredMonitor({ ...monitor, target: { ...monitor.target, scope: 'internal', scopeAt: 1789000000000 } }, { defaults: DEFAULTS });
  assert.equal(stored.target.scope, 'internal');
  assert.equal(stored.target.scopeAt, 1789000000000);
  // and a stored internal monitor is not deleted by the public-only setting: the setting stops
  // checks, it does not silently drop what the operator configured
  assert.ok(normalizeStoredMonitor({ ...monitor, target: { ...monitor.target } }, { defaults: normalizeSettings({ allowInternal: false }) }));
});

test('the address policy is one classifier with two verdicts, and it is the shipped one', () => {
  const cases = [
    // [address, class, allowedForMonitor, allowedForRemoteFetch]
    ['10.0.0.9', 'private', true, false],
    ['192.168.1.5', 'private', true, false],
    ['172.16.0.1', 'private', true, false],
    ['100.64.0.7', 'shared', true, false],
    ['fd00::5', 'unique-local', true, false],
    ['8.8.8.8', 'public', true, true],
    ['2606:4700::1111', 'public', true, true],
    ['::ffff:8.8.8.8', 'public', true, true],
    ['::ffff:10.0.0.9', 'private', true, false],
    ['127.0.0.1', 'loopback', false, false],
    ['::1', 'loopback', false, false],
    ['169.254.169.254', 'link-local', false, false],
    ['fe80::1', 'link-local', false, false],
    ['239.1.1.1', 'multicast', false, false],
    ['ff02::1', 'multicast', false, false],
    ['0.0.0.0', 'unspecified', false, false],
    ['::', 'unspecified', false, false],
    ['198.18.0.1', 'benchmark', false, false],
    ['100::1', 'discard', false, false],
    ['not-an-ip', 'invalid', false, false],
  ];
  for (const [ip, klass, monitor, fetch] of cases) {
    assert.equal(policy.classifyIp(ip), klass, `${ip} classification`);
    assert.equal(policy.allowedForMonitor(ip), monitor, `${ip} allowedForMonitor`);
    assert.equal(policy.allowedForRemoteFetch(ip), fetch, `${ip} allowedForRemoteFetch`);
  }
  // the coarse shipped refusals are preserved: they are conservatism, not classification
  for (const ip of ['169.1.1.1', '100::9', 'ff00:1']) assert.equal(policy.allowedForRemoteFetch(ip), false, `${ip} fetch`);
  // and monitoring's refusal is the same as the model's configuration-time refusal
  for (const ip of ['127.0.0.1', '169.254.169.254', '239.1.1.1', 'fe80::1']) {
    assert.equal(net.addressRefusal(ip)?.code, 'blocked_address', ip);
  }
  assert.equal(net.addressRefusal('10.0.0.9'), null, 'a LAN address is a legitimate thing to monitor');
});

test('resolution refuses a name if any answer is in a refused class, and pins the answer it validated', async () => {
  const mixed = await net.resolveHost('rebind.lab.internal', {
    lookup: async () => [
      { address: '10.0.0.9', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ],
  });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.code, 'blocked_address');

  const fine = await net.resolveHost('stream.lab.internal', { lookup: async () => [{ address: '10.0.0.9', family: 4 }] });
  assert.equal(fine.ok, true);
  assert.equal(fine.pinned, '10.0.0.9');
  assert.equal(fine.addresses[0].klass, 'private');

  const empty = await net.resolveHost('', {});
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'invalid_host');
  const none = await net.resolveHost('nothing.lab.internal', { lookup: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); } });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'dns');
});

test('a redirect is revalidated: scheme, credentials, downgrade and address class', async () => {
  const allow = async () => ({ ok: true, host: 'x', addresses: [{ address: '10.0.0.9', family: 4, klass: 'private' }], pinned: '10.0.0.9' });
  const ok = await net.validateRedirect('http://a.lab.internal/x', 'https://b.lab.internal/y', { resolveHost: allow });
  assert.equal(ok.ok, true);
  assert.equal(ok.url, 'https://b.lab.internal/y');

  const downgrade = await net.validateRedirect('https://a.lab.internal/x', 'http://b.lab.internal/y', { resolveHost: allow });
  assert.equal(downgrade.ok, false);
  assert.equal(downgrade.code, 'redirect_downgrade');

  const creds = await net.validateRedirect('https://a.lab.internal/x', 'https://u:p@b.lab.internal/y', { resolveHost: allow });
  assert.equal(creds.ok, false);
  assert.equal(creds.code, 'redirect_credentials');

  const scheme = await net.validateRedirect('https://a.lab.internal/x', 'ftp://b.lab.internal/y', { resolveHost: allow });
  assert.equal(scheme.ok, false);
  assert.equal(scheme.code, 'redirect_scheme');

  const blocked = await net.validateRedirect('https://a.lab.internal/x', 'https://rebind.lab.internal/y', {
    resolveHost: async () => ({ ok: false, code: 'blocked_address', reason: 'metadata' }),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'redirect_blocked_address');
});

test('a stored monitor that cannot be read is dropped, not half-trusted', () => {
  assert.equal(normalizeStoredMonitor(null, { defaults: DEFAULTS }), null);
  assert.equal(normalizeStoredMonitor({ type: 'icmp' }, { defaults: DEFAULTS }), null);
  assert.equal(normalizeStoredMonitor({ id: 'mon-../../etc/passwd', type: 'http' }, { defaults: DEFAULTS }), null);
  assert.equal(normalizeStoredMonitor({ id: 'mon-abcdef123456', type: 'http', target: { url: 'file:///etc/shadow' } }, { defaults: DEFAULTS }), null);
  const ok = normalizeStoredMonitor({ id: 'mon-abcdef123456', type: 'tcp', name: 'db', target: { host: '10.0.0.9', port: 5432 } }, { defaults: DEFAULTS });
  assert.equal(ok.type, 'tcp');
  assert.equal(ok.target.port, 5432);
});
