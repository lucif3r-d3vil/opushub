// Phase 6 — the Homepage migration engine, tested as a contract.
//
// The importer's job is not "read YAML". It is to take a configuration written for a different
// product — one whose model lets a service exist without a container, and whose files routinely
// carry live API keys — and decide, per entry, what it is allowed to become here.
//
// Every test below is therefore about a *classification* or a *refusal*, not about parsing:
//
//   · a service that matches a running container becomes a presentation overlay,
//   · a service that matches nothing becomes at most a link, never inventory,
//   · a file that carries credentials is refused by name,
//   · a value that cannot be stored safely is reported instead of partially applied.
//
// The engine is pure: it is given text and an inventory snapshot and returns a plan. Nothing here
// touches a filesystem, a socket or a Docker daemon, which is why the whole file runs in
// milliseconds and why it can assert on hostile input without defending a host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The engine imports discovery, which imports the URL resolver; none of them read config at import
// time, but the store does — so point it at a scratch directory before anything is loaded.
process.env.OPUSHUB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-import-cfg-'));
process.env.OPUSHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-import-data-'));
process.env.OPUSHUB_DOCKER_SOCKET = '/tmp/opushub-p6-nonexistent.sock';

const {
  parseHomepageBundle, classifyBundle, buildImportPreview, iconCandidates,
  HOMEPAGE_FILES, REFUSED_FILES,
} = await import('./homepageImport.js');

/** Widget types this build knows — the same list the API passes in. */
const WIDGET_TYPES = ['services', 'system', 'stacks', 'attention', 'clock', 'weather', 'news', 'markets', 'bookmarks', 'activity'];

/** The icon probe, stubbed: only these two names resolve in the "bundled collections". */
const suggestIcon = (ref) => (['si:jellyfin', 'si:sonarr'].includes(ref) ? ref : null);

/**
 * A fleet that mirrors what a real Homepage user would be running, in the shape discovery
 * produces. Two containers of one compose project, one standalone, one unrouted.
 */
const INVENTORY = {
  live: true,
  services: [
    {
      id: 'c0ffee000001', name: 'jellyfin', displayName: 'Jellyfin', group: 'opustream',
      url: 'https://stream.example.com', urlSource: 'traefik', kind: 'application',
      container: { id: 'c0ffee000001', name: 'jellyfin', composeService: 'jellyfin', project: 'opustream', image: 'jellyfin/jellyfin:latest', state: 'running' },
    },
    {
      id: 'c0ffee000002', name: 'sonarr', displayName: 'Sonarr', group: 'opustream',
      url: 'https://sonarr.example.com', urlSource: 'traefik', kind: 'application',
      container: { id: 'c0ffee000002', name: 'sonarr', composeService: 'sonarr', project: 'opustream', image: 'linuxserver/sonarr:latest', state: 'running' },
    },
    {
      id: 'c0ffee000003', name: 'uptime-kuma', displayName: 'Uptime Kuma', group: 'Other',
      url: 'https://status.example.com', urlSource: 'traefik', kind: 'application',
      container: { id: 'c0ffee000003', name: 'uptime-kuma', composeService: 'uptime-kuma', project: null, image: 'louislam/uptime-kuma:1', state: 'running' },
    },
  ],
};

const parse = (files, opts = {}) => parseHomepageBundle(files, { widgetTypes: WIDGET_TYPES, suggestIcon, ...opts });
const previewOf = (files, inventory = INVENTORY, opts = {}) => {
  const { bundle, report } = parse(files, opts);
  return buildImportPreview({ bundle, report, inventory });
};

// ---------------------------------------------------------------------------
// the canonical Homepage files
// ---------------------------------------------------------------------------

test('a canonical Homepage services.yaml is read as groups, and its services become overlays', () => {
  const p = previewOf({
    'services.yaml': `
- Media:
    - Jellyfin:
        icon: si-jellyfin
        href: https://stream.example.com
        description: Movies and TV, streamed anywhere in the house
    - Sonarr:
        icon: si-sonarr
        href: https://sonarr.example.com
        description: Wants your shows
- Monitoring:
    - Uptime Kuma:
        href: https://status.example.com
`,
  });
  assert.equal(p.summary.groups, 2);
  assert.equal(p.summary.services, 3);
  assert.equal(p.summary.matched, 3, 'every service in this file names a running container');
  assert.equal(p.summary.unmatched, 0);
  assert.equal(p.summary.invalid, 0);
  const jellyfin = p.matched.find((m) => m.sourceName === 'Jellyfin');
  assert.equal(jellyfin.container.containerName, 'jellyfin');
  assert.equal(jellyfin.icon, 'si:jellyfin', 'a resolvable icon reference is carried across');
  assert.equal(jellyfin.url, 'https://stream.example.com');
  assert.equal(jellyfin.description, 'Movies and TV, streamed anywhere in the house');
});

test('the map form of the same file is read identically', () => {
  const asList = previewOf({
    'services.yaml': `
- Media:
    - Jellyfin:
        href: https://stream.example.com
`,
  });
  const asMap = previewOf({
    'services.yaml': `
- Media:
    Jellyfin:
      href: https://stream.example.com
`,
  });
  assert.equal(asList.summary.matched, 1);
  assert.equal(asMap.summary.matched, 1);
  assert.equal(asList.matched[0].container.containerName, asMap.matched[0].container.containerName);
});

// ---------------------------------------------------------------------------
// THE invariant: an imported service that does not exist in Docker
// ---------------------------------------------------------------------------

test('a Homepage service with no container is classified unmatched — and is not an overlay', () => {
  const p = previewOf({
    'services.yaml': `
- Media:
    - Jellyfin:
        href: https://stream.example.com
    - Kodi Box:
        href: http://192.0.2.44:8080
        description: The TV in the front room, not a container
`,
  });
  assert.equal(p.summary.matched, 1);
  assert.equal(p.summary.unmatched, 1);
  const ghost = p.unmatched[0];
  assert.equal(ghost.sourceName, 'Kodi Box');
  assert.match(ghost.reason, /no container/i);
  // the crucial assertion: it is absent from the matched set entirely, so nothing downstream can
  // write it into services.yaml as if discovery had found it
  assert.ok(!p.matched.some((m) => m.sourceName === 'Kodi Box'));
});

test('unmatched entries are never given a container, even when they name one', () => {
  const p = previewOf({
    'services.yaml': `
- Media:
    - Imaginary:
        container: not-a-real-container
        href: https://imaginary.example.com
`,
  });
  assert.equal(p.summary.matched, 0);
  assert.equal(p.summary.unmatched, 1);
  assert.equal(p.matched.length, 0);
});

test('a match is reported with the evidence that produced it', () => {
  const p = previewOf({
    'services.yaml': `
- Media:
    - The streaming box:
        container: jellyfin
        href: https://stream.example.com
`,
  });
  assert.equal(p.summary.matched, 1);
  assert.equal(p.matched[0].matchConfidence, 'explicit');
  assert.match(p.matched[0].matchHow, /container name in the imported file/);
});

test('two imported entries cannot claim the same container — the second is reported, not silently dropped', () => {
  const p = previewOf({
    'services.yaml': `
- Media:
    - Jellyfin:
        href: https://stream.example.com
    - Jellyfin again:
        container: jellyfin
        href: https://stream.example.com/other
`,
  });
  assert.equal(p.summary.matched, 1);
  assert.equal(p.summary.unmatched, 1);
  assert.match(p.unmatched[0].reason, /already claimed/i);
});

test('a service already overlaid by the user is reported as a conflict, with both sides shown', () => {
  const { bundle, report } = parse({
    'services.yaml': `
- Media:
    - Jellyfin:
        icon: si-jellyfin
        description: Imported description
`,
  });
  const existing = new Map([['jellyfin', { container: 'jellyfin', displayName: 'Stream', description: 'My own words', icon: 'lucide:clapperboard' }]]);
  const p = buildImportPreview({ bundle, report, inventory: INVENTORY, existingOverlays: existing });
  assert.equal(p.summary.conflicts, 1);
  const conflict = p.conflicts[0];
  assert.equal(conflict.container, 'jellyfin');
  const fields = conflict.changes.map((c) => c.field);
  assert.ok(fields.includes('Description'));
  assert.ok(fields.includes('Icon'));
  const icon = conflict.changes.find((c) => c.field === 'Icon');
  assert.equal(icon.current, 'lucide:clapperboard');
  assert.equal(icon.imported, 'si:jellyfin');
});

// ---------------------------------------------------------------------------
// hostile input
// ---------------------------------------------------------------------------

test('docker.yaml is refused by name — it names sockets and credentials', () => {
  assert.throws(
    () => parse({ 'docker.yaml': 'my-docker:\n  socket: /var/run/docker.sock\n  password: hunter2\n' }),
    (err) => err.code === 'import_refused_file' && /docker\.yaml/.test(err.message),
  );
  assert.ok(REFUSED_FILES['docker.yaml'], 'the refusal list is the guard, and it is exported');
});

test('every secret-bearing file in the refusal list is refused with a reason', () => {
  for (const file of Object.keys(REFUSED_FILES)) {
    assert.throws(
      () => parse({ [file]: 'anything: at-all\n' }),
      (err) => err.code === 'import_refused_file',
      `${file} was not refused`,
    );
  }
  // and the refusal survives being smuggled in by path
  assert.throws(
    () => parse({ 'nested/../docker.yaml': 'x: 1\n' }),
    (err) => err.code === 'import_refused_file',
  );
});

test('widget API keys are dropped on the way in, and named', () => {
  const { bundle, report } = parse({
    'services.yaml': `
- Media:
    - Jellyfin:
        href: https://stream.example.com
        widget:
          type: jellyfin
          url: https://stream.example.com
          key: live-api-key-here
`,
  });
  assert.ok(report.secrets.some((s) => /key/.test(s)), 'the dropped credential is reported');
  const entry = bundle.services[0];
  // the key exists nowhere in the parsed bundle
  const flat = JSON.stringify(bundle);
  assert.ok(!flat.includes('live-api-key-here'), 'a credential survived into the parsed bundle');
  assert.equal(entry.url, 'https://stream.example.com', 'the widget URL is still usable as a hint');
});

test('malformed YAML is a reported parse error, not a crash', () => {
  assert.throws(
    () => parse({ 'services.yaml': '- Media:\n    - Jellyfin:\n   href: broken\n  bad indent\n' }),
    (err) => err.code === 'import_parse' && /not valid YAML/.test(err.message),
  );
});

test('an oversized file is refused by size, before it is parsed', () => {
  const huge = `- Media:\n${'    - Service:\n        href: https://example.com\n'.repeat(20_000)}`;
  assert.throws(
    () => parse({ 'services.yaml': huge }),
    (err) => err.status === 413 && err.code === 'import_too_large',
  );
});

test('YAML anchors and aliases are refused — the expansion bomb has no legitimate use here', () => {
  assert.throws(
    () => parse({ 'services.yaml': 'base: &b\n  href: https://example.com\n- Media:\n    - X: *b\n' }),
    (err) => err.code === 'import_aliases',
  );
});

test('a deeply nested document is refused by depth, not by stack overflow', () => {
  // Built in flow style, where nesting is unambiguous: YAML's block indentation only ever adds
  // one level per parent, so a block-style fixture cannot express the shape this guards against.
  let nested = '1';
  for (let i = 0; i < 25; i++) nested = `{ level${i}: ${nested} }`;
  const src = `- Media:\n    - Deep:\n        config: ${nested}\n`;
  assert.throws(
    () => parse({ 'services.yaml': src }),
    (err) => err.code === 'import_too_deep' && /nests .* levels deep/.test(err.message),
  );
});

test('a document with more values than the node cap is refused', () => {
  // 25k nodes in one file: under the byte cap, over the node cap — the check that byte limits miss.
  const entries = Array.from({ length: 25_000 }, (_, i) => `        - k${i}: v`).join('\n');
  assert.throws(
    () => parse({ 'services.yaml': `- Media:\n    - Big:\n${entries}\n` }),
    (err) => ['import_too_many_nodes', 'import_too_large'].includes(err.code),
  );
});

test('a javascript: URL is refused and reported as invalid, never stored', () => {
  const p = previewOf({
    'services.yaml': `
- Media:
    - Sketchy:
        href: "javascript:alert(document.cookie)"
`,
  });
  assert.equal(p.summary.invalid, 1);
  assert.match(p.invalid[0].reason, /unsupported scheme/i);
  assert.equal(p.summary.matched, 0);
});

test('a file:// href is refused — configuration cannot name the server filesystem', () => {
  const p = previewOf({ 'services.yaml': '- Media:\n    - Leak:\n        href: "file:///etc/passwd"\n' });
  assert.equal(p.summary.invalid, 1);
});

test('too many files in one import is refused up front', () => {
  const files = {};
  for (let i = 0; i < 40; i++) files[`file-${i}.yaml`] = 'a: 1\n';
  assert.throws(() => parse(files), (err) => err.status === 413 && err.code === 'import_too_many_files');
});

// ---------------------------------------------------------------------------
// the rest of the bundle
// ---------------------------------------------------------------------------

test('bookmarks are read in both Homepage shapes', () => {
  const canonical = previewOf({
    'bookmarks.yaml': `
- Reading:
    - Hacker News:
        - abbr: HN
          href: https://news.ycombinator.com
        - description: The front page
`,
  });
  const flat = previewOf({
    'bookmarks.yaml': `
- Reading:
    Hacker News:
      href: https://news.ycombinator.com
      description: The front page
`,
  });
  assert.equal(canonical.summary.bookmarks, 1);
  assert.equal(flat.summary.bookmarks, 1);
  assert.equal(canonical.bookmarks[0].items[0].href, 'https://news.ycombinator.com');
  assert.equal(flat.bookmarks[0].items[0].description, 'The front page');
});

test('a bookmark with a dangerous scheme is reported invalid rather than imported', () => {
  const p = previewOf({ 'bookmarks.yaml': '- Links:\n    - Bad:\n        - href: "javascript:void(0)"\n' });
  assert.equal(p.summary.bookmarks, 0);
  assert.equal(p.summary.invalid, 1);
});

test('settings.yaml maps what has an equivalent and reports what does not', () => {
  const p = previewOf({
    'settings.yaml': `
title: The Home Lab
theme: dark
color: teal
background:
  image: https://images.example.com/bg.jpg
  blur: md
  opacity: 40
startUrl: https://example.com
headerStyle: boxed
`,
  });
  assert.equal(p.app.name, 'The Home Lab');
  assert.equal(p.appearance.theme, 'dark');
  assert.equal(p.appearance.accent, 'teal');
  assert.equal(p.appearance.background.photo, 'https://images.example.com/bg.jpg');
  assert.equal(p.appearance.background.blur, 16, 'Homepage blur step md → 16px');
  assert.equal(p.appearance.background.scrim, 60, 'opacity 40 → scrim 60');
  const ignored = p.ignoredSettings.map((i) => i.key);
  assert.ok(ignored.includes('startUrl'));
  assert.ok(ignored.includes('headerStyle'));
});

test('an unmappable Homepage colour is reported instead of silently dropping to the default', () => {
  const p = previewOf({ 'settings.yaml': 'title: X\ncolor: chartreuse\n' });
  assert.ok(p.ignoredSettings.some((i) => i.key === 'color'));
  assert.equal(p.appearance.accent, undefined);
});

test('widgets map where an honest equivalent exists and are named where none does', () => {
  const p = previewOf({
    'widgets.yaml': `
- resources:
    cpu: true
    memory: true
- datetime:
    text_size: xl
- sonarr:
    key: secret-key
- search:
    provider: duckduckgo
`,
  });
  const types = p.widgets.instances.map((i) => i.type);
  assert.deepEqual(types, ['system', 'clock']);
  const unmapped = p.widgets.unmapped.map((u) => u.name);
  assert.ok(unmapped.includes('sonarr'));
  assert.ok(unmapped.includes('search'));
  assert.ok(p.secretsDropped.some((s) => /sonarr/.test(s)), 'the widget API key is reported as dropped');
});

test('an icon that resolves in no bundled collection is dropped, not invented', () => {
  const p = previewOf({
    'services.yaml': `
- Media:
    - Jellyfin:
        icon: some-dashboard-icon.png
        href: https://stream.example.com
`,
  });
  const entry = p.matched[0];
  assert.equal(entry.icon, null, 'an unresolvable icon must not become a reference');
  assert.equal(entry.iconDropped, 'some-dashboard-icon.png', 'and the original is preserved for the review screen');
});

test('icon candidates translate every spelling Homepage ships', () => {
  assert.deepEqual(iconCandidates('si-jellyfin').slice(0, 1), ['si:jellyfin']);
  assert.deepEqual(iconCandidates('mdi-movie-search-outline').slice(0, 1), ['mdi:movie-search-outline']);
  assert.deepEqual(iconCandidates('jellyfin.png').slice(0, 1), ['si:jellyfin']);
  assert.deepEqual(iconCandidates('lucide-waves').slice(0, 1), ['lucide:waves']);
  assert.deepEqual(iconCandidates('https://cdn.example.com/i.svg'), ['https://cdn.example.com/i.svg']);
  assert.deepEqual(iconCandidates(''), []);
});

test('a group name OpusHub cannot store is repaired deterministically and the repair is reported', () => {
  const p = previewOf({ 'services.yaml': '- "Media & Streaming":\n    - Jellyfin:\n        href: https://stream.example.com\n' });
  assert.ok(p.warnings.some((w) => /Media Streaming/.test(w)));
  assert.ok(p.groups.some((g) => g.name === 'Media Streaming'));
});

test('OpusHub\'s own export is recognised when offered to the importer', () => {
  const { bundle, report } = parse({
    'services.yaml': 'groups:\n  - name: Media\n    services:\n      - container: jellyfin\n        displayName: Stream\n',
    'bookmarks.yaml': 'groups:\n  - name: Reading\n    items:\n      - { name: HN, href: https://news.ycombinator.com }\n',
  });
  assert.equal(bundle.source, 'opushub');
  assert.ok(report.files.some((f) => /OpusHub native export/.test(f.note || '')));
});

test('a Docker-less host reports every service as unmatched with the honest reason', () => {
  const p = previewOf(
    { 'services.yaml': '- Media:\n    - Jellyfin:\n        href: https://stream.example.com\n' },
    { live: false, services: [] },
  );
  assert.equal(p.summary.matched, 0);
  assert.equal(p.summary.unmatched, 1);
  assert.match(p.unmatched[0].reason, /Docker is not connected/i);
  assert.equal(p.summary.dockerConnected, false);
});

test('the preview is a pure function — calling it twice changes nothing and yields the same plan', () => {
  const files = { 'services.yaml': '- Media:\n    - Jellyfin:\n        href: https://stream.example.com\n' };
  const a = previewOf(files);
  const b = previewOf(files);
  assert.deepEqual(a.summary, b.summary);
  assert.deepEqual(a.matched.map((m) => m.container.containerName), b.matched.map((m) => m.container.containerName));
});

test('the accepted-file list and the refusal list are both non-empty and disjoint', () => {
  const accepted = new Set(Object.keys(HOMEPAGE_FILES));
  const refused = new Set(Object.keys(REFUSED_FILES));
  assert.ok(accepted.size > 0 && refused.size > 0);
  for (const name of refused) assert.ok(!accepted.has(name), `${name} is both accepted and refused`);
});
