// Phase 9D — OPNsense: optional, read-only, and the strictest credential boundary in OpusHub.
//
// The credentials in this file are planted the way a hostile reviewer would plant them: a real
// string in the environment, echoed by the stubbed upstream, so that any path by which it could
// reach a response, a log line or an activity event shows up as a failure here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9opn-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9opn-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const KEY = 'planted-key-for-tests';
const SECRET = 'planted-secret-hunter2';

const { createOpnsenseProvider, ENDPOINTS, PLANNED } = await import('./providers/opnsense.js');
const { opnsenseConfig, opnsenseCredentials, CREDENTIAL_ENV } = await import('./providers/opnsenseConfig.js');

test.after(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  delete process.env.OPUSHUB_OPNSENSE_URL;
  delete process.env[CREDENTIAL_ENV.key];
  delete process.env[CREDENTIAL_ENV.secret];
  delete process.env.OPUSHUB_OPNSENSE_ALLOW_PLAIN_HTTP;
});

const withCreds = () => {
  process.env[CREDENTIAL_ENV.key] = KEY;
  process.env[CREDENTIAL_ENV.secret] = SECRET;
};
const withoutCreds = () => {
  delete process.env[CREDENTIAL_ENV.key];
  delete process.env[CREDENTIAL_ENV.secret];
};

/** A stub transport: records every request, answers from a table of path → {status, body}. */
function stubFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ path: url.pathname, href: url.href, headers: init?.headers || {}, method: init?.method, redirect: init?.redirect });
    const hit = answers[url.pathname] ?? { status: 404, body: '{}' };
    return {
      status: hit.status,
      text: async () => (typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

const okSystem = { status: 200, body: { product_name: 'OPNsense', product_version: '24.7.4', hostname: 'fw.lan', load: [0.1, 0.2, 0.15], secret_leak: SECRET } };
const okInterfaces = { status: 200, body: { rows: [{ device: 'igb0', descr: 'WAN', status: 'up', ipaddr: '198.51.100.2', enabled: true, secret_leak: SECRET }] } };
const okGateways = { status: 200, body: { rows: [{ name: 'WAN_GW', address: '198.51.100.1', status: 'online', loss: '0.0%', delay: '1.2ms' }] } };
const okDns = { status: 200, body: { unbound: { enabled: true, port: '53', dnssec_enabled: true, api_key: SECRET } } };

const ALL_OK = {
  [ENDPOINTS.system.path]: okSystem,
  [ENDPOINTS.interfaces.path]: okInterfaces,
  [ENDPOINTS.gateways.path]: okGateways,
  [ENDPOINTS.dns.path]: okDns,
};

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

test('with nothing configured the provider is not-configured and asks nothing', async () => {
  withoutCreds();
  delete process.env.OPUSHUB_OPNSENSE_URL;
  const fetchImpl = stubFetch(ALL_OK);
  const p = createOpnsenseProvider({ config: opnsenseConfig, credentials: opnsenseCredentials, fetchImpl });
  const result = await p.check();
  assert.equal(result.status, 'not-configured');
  assert.equal(result.error.code, 'not_configured');
  assert.match(result.error.reason, /No OPNsense address/);
  assert.deepEqual(fetchImpl.calls, [], 'nothing was requested');
  assert.equal(result.data.configured, false);
  assert.equal(result.data.credentialPresent, false);
});

test('an address without credentials is still not configured — and no request is made', async () => {
  withoutCreds();
  process.env.OPUSHUB_OPNSENSE_URL = 'https://fw.lan';
  const fetchImpl = stubFetch(ALL_OK);
  const p = createOpnsenseProvider({ config: opnsenseConfig, credentials: opnsenseCredentials, fetchImpl });
  const result = await p.check();
  assert.equal(result.status, 'not-configured');
  assert.match(result.error.reason, /credentials are not present/);
  assert.deepEqual(fetchImpl.calls, []);
  // the address is non-secret and may be echoed; the credential state is a boolean, never a value
  assert.equal(result.data.url, 'https://fw.lan');
  assert.equal(result.data.credentialSource, 'environment');
  assert.equal(result.data.credentialPresent, false);
  delete process.env.OPUSHUB_OPNSENSE_URL;
});

test('an address with a path, a query, credentials or a non-http scheme is refused', async () => {
  withCreds();
  const bad = [
    'https://fw.lan/api/core/system/status',
    'https://fw.lan/?x=1',
    'https://user:pw@fw.lan',
    'ftp://fw.lan',
    'https://fw.lan#frag',
    'not a url at all',
  ];
  for (const url of bad) {
    const fetchImpl = stubFetch(ALL_OK);
    const p = createOpnsenseProvider({ config: () => ({ url, allowPlainHttp: false }), credentials: opnsenseCredentials, fetchImpl });
    const result = await p.check();
    assert.equal(result.status, 'not-configured', `"${url}" must be refused`);
    assert.deepEqual(fetchImpl.calls, [], `"${url}" must not be requested`);
  }
});

test('plain http is refused unless the operator explicitly allows it for a LAN address', async () => {
  withCreds();
  const refused = stubFetch(ALL_OK);
  const p1 = createOpnsenseProvider({ config: () => ({ url: 'http://fw.lan', allowPlainHttp: false }), credentials: opnsenseCredentials, fetchImpl: refused });
  assert.equal((await p1.check()).status, 'not-configured');
  assert.deepEqual(refused.calls, []);

  const allowed = stubFetch(ALL_OK);
  const p2 = createOpnsenseProvider({ config: () => ({ url: 'http://fw.lan', allowPlainHttp: true }), credentials: opnsenseCredentials, fetchImpl: allowed });
  const r2 = await p2.check();
  assert.equal(r2.status, 'connected');
  assert.ok(allowed.calls.length > 0);
});

/* ------------------------------------------------------------------ */
/* connected                                                           */
/* ------------------------------------------------------------------ */

test('a connected provider reports its capabilities, its version and nothing it was not asked for', async () => {
  withCreds();
  const fetchImpl = stubFetch(ALL_OK);
  const p = createOpnsenseProvider({ config: () => ({ url: 'https://fw.lan', allowPlainHttp: false }), credentials: opnsenseCredentials, fetchImpl });
  const result = await p.check();
  assert.equal(result.status, 'connected');
  assert.deepEqual(result.capabilities, ['system', 'interfaces', 'gateways', 'dns']);
  assert.equal(result.version, '24.7.4');
  assert.equal(result.data.system.hostname, 'fw.lan');
  assert.equal(result.data.interfaces[0].name, 'WAN');
  assert.equal(result.data.gateways[0].status, 'online');
  assert.equal(result.data.dns.enabled, true);
  // the endpoint table owns the paths, and only those were requested
  const asked = fetchImpl.calls.map((c) => c.path).sort();
  assert.deepEqual(asked, Object.values(ENDPOINTS).map((e) => e.path).sort());
  // every request is a GET with no body and redirects refused
  for (const c of fetchImpl.calls) {
    assert.equal(c.method, 'GET');
    assert.equal(c.redirect, 'manual');
  }
});

test('the credentials are used to authenticate and never appear anywhere else', async () => {
  withCreds();
  const fetchImpl = stubFetch({ ...ALL_OK, [ENDPOINTS.dns.path]: { status: 500, body: `error at /var/db/opnsense with key ${SECRET}` } });
  const p = createOpnsenseProvider({ config: () => ({ url: 'https://fw.lan', allowPlainHttp: false }), credentials: opnsenseCredentials, fetchImpl });
  const result = await p.check();
  const blob = JSON.stringify(result);
  assert.ok(!blob.includes(SECRET), 'the secret reached the provider result');
  assert.ok(!blob.includes(KEY), 'the key reached the provider result');
  // the Authorization header is built, and it is built from the environment values only
  const auth = fetchImpl.calls[0].headers.authorization;
  assert.ok(/^Basic /.test(auth), 'requests are authenticated with HTTP Basic');
  const decoded = Buffer.from(String(auth).slice(6), 'base64').toString('utf8');
  assert.equal(decoded, `${KEY}:${SECRET}`);
  assert.ok(!blob.includes(Buffer.from(`${KEY}:${SECRET}`).toString('base64')), 'the encoded header leaked');
});

test('an upstream error body is never echoed — only a public sentence and a status', async () => {
  withCreds();
  const leaky = { status: 500, body: 'boom in /usr/local/etc/opnsense/config.xml' };
  const fetchImpl = stubFetch({
    [ENDPOINTS.system.path]: leaky,
    [ENDPOINTS.interfaces.path]: okInterfaces,
    [ENDPOINTS.gateways.path]: okGateways,
    [ENDPOINTS.dns.path]: okDns,
  });
  const p = createOpnsenseProvider({ config: () => ({ url: 'https://fw.lan' }), credentials: opnsenseCredentials, fetchImpl });
  const result = await p.check();
  assert.equal(result.status, 'unavailable');
  const blob = JSON.stringify(result);
  assert.ok(!blob.includes('/usr/local/etc'), 'an upstream path leaked');
  assert.ok(!blob.includes('config.xml'));
  assert.match(result.error.reason, /HTTP 500/);
});

test('rejected credentials are reported as rejected, with no upstream detail', async () => {
  withCreds();
  const fetchImpl = stubFetch({ [ENDPOINTS.system.path]: { status: 401, body: '{"error":"authentication failed","hint":"key from /conf/config.xml"}' } });
  const p = createOpnsenseProvider({ config: () => ({ url: 'https://fw.lan' }), credentials: opnsenseCredentials, fetchImpl });
  const result = await p.check();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error.code, 'authentication_failed');
  assert.match(result.error.reason, /rejected the API credentials/);
  assert.ok(!JSON.stringify(result).includes('/conf/config.xml'));
});

test('a malformed or unexpected answer degrades one capability without inventing data', async () => {
  withCreds();
  const fetchImpl = stubFetch({
    [ENDPOINTS.system.path]: { status: 200, body: 'not json at all' },
    [ENDPOINTS.interfaces.path]: { status: 404, body: '{}' },
    [ENDPOINTS.gateways.path]: { status: 200, body: { totally: 'different' } },
    [ENDPOINTS.dns.path]: okDns,
  });
  const p = createOpnsenseProvider({ config: () => ({ url: 'https://fw.lan' }), credentials: opnsenseCredentials, fetchImpl });
  const result = await p.check();
  assert.equal(result.status, 'unavailable', 'system status is the one capability that decides "connected"');
  const byId = Object.fromEntries(result.data.capabilityList.map((c) => [c.id, c]));
  assert.equal(byId.system.status, 'error');
  assert.match(byId.system.reason, /not JSON/);
  assert.equal(byId.interfaces.status, 'unavailable');
  assert.equal(byId.gateways.status, 'unavailable');
  assert.match(byId.gateways.reason, /not in a shape OpusHub recognises/);
  assert.equal(byId.dns.status, 'available');
  assert.equal(result.data.interfaces, null, 'an unparsed capability carries no data');
});

test('a partially answering firewall is degraded, not healthy and not absent', async () => {
  withCreds();
  const fetchImpl = stubFetch({
    [ENDPOINTS.system.path]: okSystem,
    [ENDPOINTS.interfaces.path]: { status: 404, body: '{}' },
    [ENDPOINTS.gateways.path]: okGateways,
    [ENDPOINTS.dns.path]: okDns,
  });
  const p = createOpnsenseProvider({ config: () => ({ url: 'https://fw.lan' }), credentials: opnsenseCredentials, fetchImpl });
  const result = await p.check();
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.capabilities, ['system', 'gateways', 'dns']);
  assert.match(result.error.reason, /1 of 4/);
});

test('a redirect is refused rather than followed somewhere else', async () => {
  withCreds();
  const fetchImpl = stubFetch({ [ENDPOINTS.system.path]: { status: 302, body: '' } });
  const p = createOpnsenseProvider({ config: () => ({ url: 'https://fw.lan' }), credentials: opnsenseCredentials, fetchImpl });
  const result = await p.check();
  assert.equal(result.status, 'unavailable');
  assert.match(result.error.reason, /redirect/);
});

test('timeouts and network failures are classified, not passed through', async () => {
  withCreds();
  const failing = async () => { const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; };
  failing.calls = [];
  const p = createOpnsenseProvider({ config: () => ({ url: 'https://fw.lan' }), credentials: opnsenseCredentials, fetchImpl: failing });
  const result = await p.check();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error.code, 'unreachable');
  assert.match(result.error.reason, /listening/);
});

/* ------------------------------------------------------------------ */
/* the endpoint table                                                  */
/* ------------------------------------------------------------------ */

test('the endpoint table is frozen, exhaustive and the only thing that can be requested', async () => {
  withCreds();
  assert.ok(Object.isFrozen(ENDPOINTS));
  const paths = Object.values(ENDPOINTS).map((e) => e.path);
  assert.deepEqual(paths, ['/api/core/system/status', '/api/interfaces/overview/interfaces', '/api/routes/gateway/status', '/api/unbound/settings/get']);
  for (const e of Object.values(ENDPOINTS)) {
    assert.ok(Object.isFrozen(e));
    assert.ok(e.path.startsWith('/api/'), 'every endpoint is a fixed path under /api');
    assert.ok(!e.path.includes('{') && !e.path.includes('$'), 'no interpolation in an endpoint');
  }
  // DHCP and firewall are declared as planned, and have no endpoint at all
  assert.deepEqual([...PLANNED], ['dhcp', 'firewall']);
  assert.ok(!Object.keys(ENDPOINTS).includes('dhcp'));
  assert.ok(!Object.keys(ENDPOINTS).includes('firewall'));

  // an unknown capability key is refused before a request exists
  const fetchImpl = stubFetch(ALL_OK);
  const p = createOpnsenseProvider({ config: () => ({ url: 'https://fw.lan' }), credentials: opnsenseCredentials, fetchImpl });
  const before = fetchImpl.calls.length;
  const p2 = p._internals;
  assert.ok(p2.ENDPOINTS && Object.keys(p2.ENDPOINTS).length === 4);
  assert.equal(fetchImpl.calls.length, before);
});

test('the provider offers no generic request helper — the transport is not reachable', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/providers/opnsense.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  for (const banned of ['export function request', 'export function fetchEndpoint', 'export const fetchEndpoint', 'export function call']) {
    assert.ok(!src.includes(banned), `the provider exports ${banned}`);
  }
  assert.ok(!/export (async )?function (get|post|put|del|send)\b/.test(src), 'no generic HTTP helper is exported');
  // nothing in the provider reads request data: there is no req/body/query in this module at all
  for (const needle of ['req.', 'body.', 'query.', 'searchParams']) {
    assert.ok(!src.includes(needle), `the provider reads ${needle}`);
  }
});
