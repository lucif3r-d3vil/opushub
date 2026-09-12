// URL resolution tests (§24). Every case is expressed as the label/port data a real Engine
// reports — the resolver must answer from that alone. Note what is NOT here: no domain, TLD,
// hostname or application name is expected anywhere, because the resolver must not care.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUrl, normalizeHostUrl, normalizePorts, pickPublishedPort, pickRouter, urlFromRouter, pickHostAddress, addressFromBindings } from './urlResolver.js';
import { parseTraefik } from './providers/dockerLabels.js';

/** labels → the parsed proxy view discovery would hand the resolver */
const tf = (labels) => parseTraefik(labels);

const P = (ip, priv, pub, type = 'tcp') => ({ ip, private: priv, public: pub, type });
const HOST = '10.0.0.5';
const ctx = { hostAddress: HOST };

// --- tier 1: manual override ---------------------------------------------------

test('manual override wins over Traefik and over a published port', () => {
  const c = {
    name: 'app',
    ports: [P('0.0.0.0', 8080, 8080)],
    traefik: tf({ 'traefik.http.routers.app.rule': 'Host(`auto.example.internal`)' }),
    manualUrl: 'https://chosen.example.org:9443/base',
    overlay: { url: 'https://chosen.example.org:9443/base', urlSource: 'services.yaml' },
  };
  const r = resolveUrl(c, ctx);
  assert.equal(r.url, 'https://chosen.example.org:9443/base');
  assert.equal(r.urlSource, 'manual');
  assert.match(r.urlNote, /services\.yaml/);
});

test('manual override accepts a bare host and normalizes it', () => {
  assert.equal(resolveUrl({ name: 'a', ports: [], traefik: tf({}), manualUrl: '10.0.0.9:3000/' }, ctx).url, 'http://10.0.0.9:3000');
  assert.equal(normalizeHostUrl('https://x.example/path/'), 'https://x.example/path');
  assert.equal(normalizeHostUrl('javascript:alert(1)'), null, 'unsafe schemes are refused');
  assert.equal(normalizeHostUrl(''), null);
});

test('manual override is labelled with where it came from', () => {
  const r = resolveUrl({ name: 'a', ports: [], traefik: tf({}), manualUrl: 'http://l.example', overlay: { url: 'http://l.example', urlSource: 'label:opushub.url' } }, ctx);
  assert.equal(r.urlSource, 'manual');
  assert.match(r.urlNote, /label:opushub\.url/);
});

// --- tier 2: Traefik ----------------------------------------------------------

test('traefik HTTP rule → http://host, source traefik', () => {
  const t = tf({
    'traefik.http.routers.app.rule': 'Host(`app.example.internal`)',
    'traefik.http.routers.app.entrypoints': 'web',
  });
  const r = resolveUrl({ name: 'app', ports: [P('0.0.0.0', 8080, 8080)], traefik: t }, ctx);
  assert.deepEqual({ url: r.url, urlSource: r.urlSource }, { url: 'http://app.example.internal', urlSource: 'traefik' });
  assert.match(r.urlNote, /router “app”/);
});

test('traefik TLS router → https://host', () => {
  const t = tf({
    'traefik.http.routers.app.rule': 'Host(`secure.example.internal`)',
    'traefik.http.routers.app.entrypoints': 'websecure',
    'traefik.http.routers.app.tls': 'true',
    'traefik.http.routers.app.tls.certresolver': 'letsencrypt',
  });
  const r = resolveUrl({ name: 'app', ports: [], traefik: t }, ctx);
  assert.equal(r.url, 'https://secure.example.internal');
});

test('traefik beats a published port, and the container port is never mistaken for a host port', () => {
  const t = tf({
    'traefik.http.routers.x.rule': 'Host(`x.example.internal`)',
    'traefik.http.services.x.loadbalancer.server.port': '5055',
  });
  const r = resolveUrl({ name: 'x', ports: [P('0.0.0.0', 5055, 31337)], traefik: t }, ctx);
  assert.equal(r.url, 'http://x.example.internal', 'no :5055, no :31337 — the proxy owns the port');
});

test('multiple Host()s on one rule: first is canonical, the rest are counted', () => {
  const t = tf({ 'traefik.http.routers.x.rule': 'Host(`x.example.internal`, `x-alt.example.internal`, `x3.example.internal`)' });
  const r = resolveUrl({ name: 'x', ports: [], traefik: t }, ctx);
  assert.equal(r.url, 'http://x.example.internal');
  assert.match(r.urlNote, /2 alternate hosts/);
});

test('Host rules joined with || : each alternative is parsed, the first wins', () => {
  const t = tf({ 'traefik.http.routers.x.rule': 'Host(`a.example.com`) || Host(`b.example.com`)' });
  assert.deepEqual(t.routers[0].hosts, ['a.example.com', 'b.example.com']);
  assert.equal(resolveUrl({ name: 'x', ports: [], traefik: t }, ctx).url, 'http://a.example.com');
});

test('a PathPrefix constraint is part of the URL…', () => {
  const t = tf({ 'traefik.http.routers.nc.rule': 'Host(`nc.example.com`) && PathPrefix(`/nextcloud`)' });
  assert.equal(resolveUrl({ name: 'nc', ports: [], traefik: t }, ctx).url, 'http://nc.example.com/nextcloud');
});

test('…unless a stripPrefix middleware removes it', () => {
  const t = tf({
    'traefik.http.routers.nc.rule': 'Host(`nc.example.com`) && PathPrefix(`/nextcloud`)',
    'traefik.http.routers.nc.middlewares': 'nc-stripprefix@docker',
  });
  assert.equal(resolveUrl({ name: 'nc', ports: [], traefik: t }, ctx).url, 'http://nc.example.com');
});

test('Host with an explicit port keeps it', () => {
  const t = tf({ 'traefik.http.routers.x.rule': 'Host(`x.example.com:8443`)', 'traefik.http.routers.x.tls': 'true' });
  assert.equal(resolveUrl({ name: 'x', ports: [], traefik: t }, ctx).url, 'https://x.example.com:8443');
});

test('a TLS router wins over its plain redirect twin (and internal entrypoints lose)', () => {
  const t = tf({
    'traefik.http.routers.x-web.rule': 'Host(`x.example.com`)',
    'traefik.http.routers.x-web.entrypoints': 'web',
    'traefik.http.routers.x-web.middlewares': 'https-redirect@docker',
    'traefik.http.routers.x-web.service': 'x',
    'traefik.http.routers.x-secure.rule': 'Host(`x.example.com`)',
    'traefik.http.routers.x-secure.entrypoints': 'websecure',
    'traefik.http.routers.x-secure.tls': 'true',
    'traefik.http.routers.x-secure.service': 'x',
    'traefik.http.routers.x-internal.rule': 'Host(`x.internal-only.example.com`)',
    'traefik.http.routers.x-internal.entrypoints': 'internal',
  });
  assert.equal(pickRouter(t, ['x']).name, 'x-secure');
  assert.equal(resolveUrl({ name: 'x', ports: [], traefik: t }, ctx).url, 'https://x.example.com');
});

test('HostRegexp and HostSNI wildcards never become URLs', () => {
  const t = tf({ 'traefik.http.routers.m.rule': 'HostRegexp(`{any:[a-z-]+}.example.com`)' });
  const r = resolveUrl({ name: 'm', ports: [], traefik: t }, ctx);
  assert.equal(r.url, null);
  assert.equal(r.urlSource, 'none');
  const wild = tf({ 'traefik.tcp.routers.t.rule': 'HostSNI(`*`)' });
  assert.equal(pickRouter(wild, []), null, 'a catch-all SNI is not an address either');
});

test('traefik.enable=false disables labels entirely', () => {
  const t = tf({
    'traefik.enable': 'false',
    'traefik.http.routers.q.rule': 'Host(`q.example.com`)',
  });
  assert.equal(pickRouter(t, ['q']), null);
  const r = resolveUrl({ name: 'q', ports: [P('0.0.0.0', 8080, 8080)], traefik: t }, ctx);
  assert.equal(r.url, `http://${HOST}:8080`, 'falls through to the published port');
  assert.equal(r.urlSource, 'published-port');
});

test('entrypointPorts is the operator escape hatch when the proxy is not on 80/443', () => {
  const t = tf({ 'traefik.http.routers.x.rule': 'Host(`x.example.com`)', 'traefik.http.routers.x.entrypoints': 'web' });
  assert.equal(resolveUrl({ name: 'x', ports: [], traefik: t }, { ...ctx, entrypointPorts: { web: '8080' } }).url, 'http://x.example.com:8080');
  assert.equal(resolveUrl({ name: 'x', ports: [], traefik: t }, { ...ctx, entrypointPorts: { web: '192.0.2.7:8080' } }).url, 'http://192.0.2.7:8080');
  // 80 is the http default, so mapping it changes nothing visible
  assert.equal(resolveUrl({ name: 'x', ports: [], traefik: t }, { ...ctx, entrypointPorts: { web: '80' } }).url, 'http://x.example.com');
});

// --- tier 3: published ports ---------------------------------------------------

test('published port → http://<host address>:<port>', () => {
  const r = resolveUrl({ name: 'app', ports: [P('0.0.0.0', 9000, 9000)], traefik: tf({}) }, ctx);
  assert.deepEqual({ url: r.url, urlSource: r.urlSource }, { url: `http://${HOST}:9000`, urlSource: 'published-port' });
  assert.match(r.urlNote, /all interfaces:9000 → 9000/);
});

test('default ports are not spelled out', () => {
  assert.equal(resolveUrl({ name: 'a', ports: [P('0.0.0.0', 80, 80)], traefik: tf({}) }, ctx).url, `http://${HOST}`);
  assert.equal(resolveUrl({ name: 'a', ports: [P('0.0.0.0', 443, 443)], traefik: tf({}) }, ctx).url, `https://${HOST}`);
});

test('a web port is preferred over a non-web one, UDP is ignored', () => {
  const ports = [P('0.0.0.0', 6881, 6881), P('0.0.0.0', 8080, 8080), P('0.0.0.0', 6881, 6881, 'udp')];
  assert.equal(pickPublishedPort(ports).public, 8080);
  assert.equal(resolveUrl({ name: 't', ports, traefik: tf({}) }, ctx).url, `http://${HOST}:8080`);
});

test('database ports lose to app ports but are still usable if they are all there is', () => {
  assert.equal(pickPublishedPort([P('0.0.0.0', 3306, 3306), P('0.0.0.0', 8081, 8081)]).public, 8081);
  assert.equal(resolveUrl({ name: 'db', ports: [P('0.0.0.0', 3306, 13306)], traefik: tf({}) }, ctx).url, `http://${HOST}:13306`);
});

test('expose without publish is not a URL', () => {
  const r = resolveUrl({ name: 'svc', ports: [P('0.0.0.0', 8080, null)], traefik: tf({}) }, ctx);
  assert.equal(r.url, null);
  assert.equal(r.urlSource, 'none');
});

test('loopback-only publish is reported as unreachable, not turned into a broken link', () => {
  const r = resolveUrl({ name: 'ha', ports: [P('127.0.0.1', 8123, 8123)], traefik: tf({}) }, ctx);
  assert.equal(r.url, null);
  assert.equal(r.urlSource, 'none');
  assert.match(r.urlNote, /loopback/);
});

test('no host address means no published-port URL — and says exactly what to set', () => {
  const r = resolveUrl({ name: 'app', ports: [P('0.0.0.0', 8080, 8080)], traefik: tf({}) }, { hostAddress: null });
  assert.equal(r.url, null);
  assert.equal(r.urlSource, 'none');
  assert.match(r.urlNote, /Settings → System|OPUSHUB_HOST_ADDRESS/);
});

// --- tier 4: nothing -----------------------------------------------------------

test('no labels, no ports → url null, urlSource none', () => {
  const r = resolveUrl({ name: 'worker', ports: [], traefik: tf({}) }, ctx);
  assert.deepEqual({ url: r.url, urlSource: r.urlSource }, { url: null, urlSource: 'none' });
  assert.match(r.urlNote, /no proxy route, no published port/);
});

// --- port shape normalization + host address picking ---------------------------

test('normalizePorts accepts both list and inspect shapes', () => {
  assert.deepEqual(
    normalizePorts([{ private: 80, public: 8080, ip: '0.0.0.0', type: 'tcp' }, { private: '443/tcp', host: '127.0.0.1', hostPort: '8443' }]),
    [
      { ip: '0.0.0.0', private: 80, public: 8080, type: 'tcp' },
      { ip: '127.0.0.1', private: 443, public: 8443, type: 'tcp' },
    ],
  );
  assert.deepEqual(normalizePorts([null, { private: 'nonsense' }]), []);
});

test('pickHostAddress: explicit setting, then a real bind address, then the outbound address', () => {
  assert.deepEqual(pickHostAddress({ configured: 'https://hub.example/' }), { address: 'hub.example', source: 'configured' });
  assert.deepEqual(pickHostAddress({ bindAddress: '198.51.100.4' }), { address: '198.51.100.4', source: 'published-bind' });
  assert.deepEqual(pickHostAddress({ detected: '198.51.100.9', interfaces: { eth0: [{ address: '198.51.100.9' }] } }), { address: '198.51.100.9', source: 'outbound-interface' });
  assert.deepEqual(pickHostAddress({ detected: '172.17.0.1', interfaces: { docker0: [{ address: '172.17.0.1' }] } }), { address: null, source: 'unavailable' },
    'a docker bridge address names the container network, not the host');
  assert.deepEqual(pickHostAddress({}), { address: null, source: 'unavailable' });
});

test('addressFromBindings reads the address an operator already published on', () => {
  const ports = [
    { ip: '0.0.0.0', public: 80, private: 80 },
    { ip: '198.51.100.20', public: 8080, private: 8080 },
    { ip: '198.51.100.20', public: 9000, private: 9000 },
    { ip: '127.0.0.1', public: 5000, private: 5000 },
  ];
  assert.equal(addressFromBindings(ports), '198.51.100.20');
  assert.equal(addressFromBindings([{ ip: '0.0.0.0', public: 80, private: 80 }]), null, 'wildcard binds name no host');
});

test('urlFromRouter tolerates IPv6 and rejects junk', () => {
  assert.equal(urlFromRouter({ hosts: ['[fd00::1]:8443'], tls: true, entrypoints: [] }).url, 'https://[fd00::1]:8443');
  assert.equal(urlFromRouter({ hosts: [], tls: false, entrypoints: [] }), null);
  assert.equal(urlFromRouter(null), null);
});
