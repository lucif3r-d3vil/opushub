// Label parsing tests — the shapes a real Engine actually reports. These are the contracts the
// URL resolver depends on, so each one is written against how Traefik v2/v3 emit labels, not
// against any assumption about this or any other homelab's domains.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCompose, parseTraefik, parseOverlayLabels, curatedLabels, projectFromPaths, ruleHosts, rulePath, humanize, slugify } from './dockerLabels.js';

const COMPOSE = (p, s) => ({
  'com.docker.compose.project': p,
  'com.docker.compose.service': s,
  'com.docker.compose.container-number': '1',
  'com.docker.compose.project.config_files': `/opt/stacks/${p}/docker-compose.yaml`,
  'com.docker.compose.project.working_dir': `/opt/stacks/${p}`,
  'com.docker.compose.version': '2.29.2',
});

// --- compose identity ---------------------------------------------------------

test('parseCompose reads project/service and keeps host paths server-side', () => {
  const c = parseCompose(COMPOSE('opustream', 'seerr'));
  assert.equal(c.project, 'opustream');
  assert.equal(c.service, 'seerr');
  assert.equal(c.version, '2.29.2');
  assert.equal(c.configFile, '/opt/stacks/opustream/docker-compose.yaml');
  assert.equal(parseCompose({ 'anything.else': '1' }), null, 'no compose labels → no project, never a guess');
});

test('projectFromPaths recovers a project only when the directory says so', () => {
  assert.equal(projectFromPaths({ workingDir: '/opt/stacks/media-stack' }), 'media-stack');
  assert.equal(projectFromPaths({ configFile: '/srv/apps/finance/docker-compose.yaml' }), 'finance');
  assert.equal(projectFromPaths({ workingDir: '/opt/stacks' }), null, 'a generic parent is not a project name');
  assert.equal(projectFromPaths({}), null);
});

// --- Traefik ------------------------------------------------------------------

test('parseTraefik: v3 HTTP router with one host, entrypoint, no TLS', () => {
  const t = parseTraefik({
    'traefik.enable': 'true',
    'traefik.http.routers.seerr.rule': 'Host(`seerr.example.internal`)',
    'traefik.http.routers.seerr.entrypoints': 'web',
    'traefik.http.services.seerr.loadbalancer.server.port': '5055',
  });
  assert.equal(t.routers.length, 1);
  assert.deepEqual(t.routers[0].hosts, ['seerr.example.internal']);
  assert.equal(t.routers[0].tls, false);
  assert.equal(t.routers[0].servicePort, 5055);
  assert.equal(t.count, 1);
});

test('parseTraefik: TLS is on for `tls=true`, a bare `tls=`, or a cert resolver', () => {
  const base = { 'traefik.http.routers.v.rule': 'Host(`vault.example.internal`)' };
  assert.equal(parseTraefik({ ...base, 'traefik.http.routers.v.tls': 'true' }).routers[0].tls, true);
  assert.equal(parseTraefik({ ...base, 'traefik.http.routers.v.tls': '' }).routers[0].tls, true);
  assert.equal(parseTraefik({ ...base, 'traefik.http.routers.v.tls.certresolver': 'lef' }).routers[0].tls, true);
  assert.equal(parseTraefik({ ...base, 'traefik.http.routers.v.tls': 'false' }).routers[0].tls, false);
});

test('ruleHosts: every Host form that shows up in the wild', () => {
  assert.deepEqual(ruleHosts('Host(`a.example.com`)').hosts, ['a.example.com']);
  assert.deepEqual(ruleHosts('Host(`a.example.com`, `b.example.com`)').hosts, ['a.example.com', 'b.example.com']);
  assert.deepEqual(ruleHosts('Host(`a.example.com`) || Host(`b.example.com`)').hosts, ['a.example.com', 'b.example.com']);
  assert.deepEqual(ruleHosts('Host(`app.example.com:8080`)').hosts, ['app.example.com:8080']);
  assert.deepEqual(ruleHosts('Host("a.example.com")').hosts, ['a.example.com'], 'double quotes are legal too');
  assert.deepEqual(ruleHosts('Host(`a.example.com`) && PathPrefix(`/x`)').hosts, ['a.example.com']);
  assert.deepEqual(ruleHosts('HostAndPath(`a.example.com/nextcloud`)'), { hosts: ['a.example.com/nextcloud'.split('/')[0]], patterns: [] });
  assert.deepEqual(ruleHosts('Host(`*:80`)').hosts, [], 'a wildcard host is not an address');
});

test('ruleHosts: patterns are reported, never turned into a hostname', () => {
  const r = ruleHosts('HostRegexp(`{any:[a-z]+}.example.com`)');
  assert.deepEqual(r.hosts, []);
  assert.equal(r.patterns.length, 1);
});

test('rulePath: only unambiguous AND-ed paths, and never when a stripPrefix middleware runs', () => {
  assert.equal(rulePath('Host(`a.example.com`) && PathPrefix(`/nextcloud`)'), '/nextcloud');
  assert.equal(rulePath('Host(`a.example.com`) && Path(`/api`)'), '/api');
  assert.equal(rulePath('Host(`a.example.com`)'), null);
  assert.equal(rulePath('Host(`a.example.com`) || (Host(`b.example.com`) && Path(`/x`))'), null, 'alternation has no single path');
  assert.equal(rulePath('Host(`a.example.com`) && PathPrefix(`/x`) && PathPrefix(`/y`)'), null, 'two paths is not one answer');
});

test('parseTraefik: multiple routers, tcp routers counted separately, services joined by name', () => {
  const t = parseTraefik({
    'traefik.http.routers.web.rule': 'Host(`app.example.com`)',
    'traefik.http.routers.web.entrypoints': 'web',
    'traefik.http.routers.web.middlewares': 'https-redirect@docker',
    'traefik.http.routers.secure.rule': 'Host(`app.example.com`)',
    'traefik.http.routers.secure.entrypoints': 'websecure',
    'traefik.http.routers.secure.tls': 'true',
    'traefik.http.routers.secure.service': 'app-svc',
    'traefik.http.services.app-svc.loadbalancer.server.port': '8080',
    'traefik.tcp.routers.db.rule': 'HostSNI(`db.example.com`)',
    'traefik.tcp.routers.db.entrypoints': 'db',
  });
  assert.equal(t.routers.length, 3);
  assert.equal(t.count, 2, 'only http routers with hosts count as web entry points');
  const secure = t.routers.find((r) => r.name === 'secure');
  assert.equal(secure.servicePort, 8080, 'a router resolves its backend port through .service');
  assert.equal(t.routers.find((r) => r.name === 'web').servicePort, null);
  assert.equal(t.routers.find((r) => r.name === 'db').protocol, 'tcp');
});

test('parseTraefik: traefik.enable=false means no routes, whatever else is labelled', () => {
  const t = parseTraefik({
    'traefik.enable': 'false',
    'traefik.http.routers.qbit.rule': 'Host(`torrents.example.com`)',
  });
  assert.equal(t.enabled, false);
  assert.equal(t.count, 0);
});

test('parseTraefik: no labels at all is a normal answer, not an error', () => {
  const t = parseTraefik({ 'com.docker.compose.project': 'x' });
  assert.deepEqual(t.routers, []);
  assert.equal(t.count, 0);
  assert.equal(t.enabled, null, 'no enable label ≠ disabled');
});

// --- presentation labels ------------------------------------------------------

test('parseOverlayLabels reads opushub.* and meta.* pairs', () => {
  const o = parseOverlayLabels({
    'opushub.displayName': 'Wave',
    'opushub.group': 'Music',
    'opushub.icon': 'lucide:waves',
    'opushub.url': 'http://10.0.0.5:4533',
    'opushub.hidden': 'true',
    'opushub.order': '3',
    'opushub.keywords': 'music, flac',
    'opushub.meta.Library': '312 GB FLAC',
  });
  assert.equal(o.displayName, 'Wave');
  assert.equal(o.group, 'Music');
  assert.equal(o.hidden, true);
  assert.equal(o.order, 3);
  assert.deepEqual(o.keywords, ['music', 'flac']);
  assert.deepEqual(o.meta, [{ label: 'Library', value: '312 GB FLAC' }]);
  assert.match(o.source, /^label:/);
});

test('parseOverlayLabels: homepage-style labels are picked up for migration', () => {
  const o = parseOverlayLabels({ 'homepage.name': 'Photos', 'homepage.icon': 'si:immich' });
  assert.equal(o.displayName, 'Photos');
  assert.equal(o.icon, 'si:immich');
});

test('parseOverlayLabels: nothing labelled is nothing overlaid', () => {
  const o = parseOverlayLabels({ 'com.docker.compose.project': 'x' });
  assert.equal(o.displayName, undefined);
  assert.deepEqual(o.meta, []);
});

// --- the public projection ----------------------------------------------------

test('curatedLabels never forwards unknown labels — only what discovery derived', () => {
  const raw = {
    ...COMPOSE('opustream', 'seerr'),
    'traefik.http.routers.seerr.rule': 'Host(`seerr.example.com`)',
    'traefik.http.routers.seerr.entrypoints': 'websecure',
    'traefik.http.routers.seerr.tls': 'true',
    'my.secret.token': 'hunter2',
    'opushub.group': 'Media',
    'homepage.env.LICENSE_KEY': 'nope',
  };
  const out = curatedLabels({ compose: parseCompose(raw), traefik: parseTraefik(raw), overlay: parseOverlayLabels(raw) });
  const json = JSON.stringify(out);
  assert.ok(!json.includes('hunter2'), 'a token in a label must not reach the browser');
  assert.ok(!json.includes('opt/stacks'), 'compose host paths must not reach the browser');
  assert.ok(!json.includes('config_files'), 'config file labels must not reach the browser');
  assert.deepEqual(out.compose, { project: 'opustream', service: 'seerr', version: '2.29.2' });
  assert.deepEqual(out.proxy, [{ router: 'seerr', hosts: ['seerr.example.com'], entrypoints: ['websecure'], tls: true, path: null, service: null, servicePort: null }]);
  assert.equal(out.overlay.group, 'Media');
});

// --- naming -------------------------------------------------------------------

test('humanize is algorithmic: separators and case, no application table', () => {
  assert.equal(humanize('jellyfin'), 'Jellyfin');
  assert.equal(humanize('home-assistant'), 'Home Assistant');
  assert.equal(humanize('navidrome'), 'Navidrome');
  assert.equal(humanize('opustream_paperless-ngx_1'), 'Opustream Paperless Ngx 1', 'humanize does not know about compose prefixes…');
  assert.equal(humanize('ImmichServer'), 'Immich Server');
  assert.equal(humanize('nextcloud:29-apache'), 'Nextcloud 29 Apache');
  assert.equal(humanize(''), '');
});

test('baseName strips the compose prefix and replica number before humanizing', async () => {
  const { baseName } = await import('../discovery.js');
  assert.equal(baseName('opustream-paperless-ngx-1', 'opustream'), 'paperless-ngx');
  assert.equal(humanize(baseName('opustream-paperless-ngx-1', 'opustream')), 'Paperless Ngx');
  assert.equal(baseName('opustream-seerr-2', 'opustream'), 'seerr');
  assert.equal(baseName('jellyfin', null), 'jellyfin', 'no project → the name stands');
  assert.equal(baseName('media', 'media'), 'media', 'a container named after its project keeps its name');
});

test('slugify keeps names URL-safe', () => {
  assert.equal(slugify('Home Assistant'), 'home-assistant');
  assert.equal(slugify('  /weird/../name  '), 'weird-name');
  assert.equal(slugify('!!!'), 'x');
});
