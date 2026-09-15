// Phase 6 — export, and what an export must never contain.
//
// An export is the one artifact a user is invited to take off the machine and email to themselves.
// That makes it the highest-consequence read path in the product, and the tests that matter are the
// negative ones: no auth, no sessions, no runtime state, and no credentials that happen to be
// hiding inside a URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';

const { exportNative, exportHomepage, redactUrl, toHomepageIcon } = await import('./configExport.js');

const SERVICES = {
  groups: [
    {
      name: 'Media',
      description: 'Streams and requests',
      icon: 'lucide:clapperboard',
      services: [
        { container: 'jellyfin', name: 'jellyfin', displayName: 'Stream', app: 'Jellyfin', description: 'Movies and TV', icon: 'si:jellyfin', group: 'Media', url: 'https://stream.example.com', keywords: ['movies'] },
        { container: 'sonarr', name: 'sonarr', displayName: 'Wave', icon: 'mdi:waveform', group: 'Media', hidden: true, url: 'https://user:secret@sonarr.example.com' },
      ],
    },
  ],
};
const BOOKMARKS = { groups: [{ name: 'Reading', items: [{ name: 'Hacker News', href: 'https://news.ycombinator.com', description: 'The front page' }] }] };
const SETTINGS = {
  app: { name: 'My Hub', tagline: 'The homelab' },
  appearance: { theme: 'dark', accent: 'teal', background: { mode: 'photo', photo: 'https://images.example.com/bg.jpg', blur: 16, scrim: 60 } },
  integrations: { news: { feeds: [{ name: 'Private feed', url: 'https://feeds.example.com/rss?token=PLANTED-TOKEN' }] }, markets: { symbols: ['AAPL'] } },
  infrastructure: { hostAddress: '192.0.2.10', entrypointPorts: { web: '8080' } },
  advanced: { customCss: true, customJs: true },
};
const LAYOUT = { version: 2, hub: { widgets: [{ id: 'w1', type: 'system', zone: 'main', size: 'md', visible: true, config: {} }, { id: 'w2', type: 'news', zone: 'rail', size: 'md', visible: true, config: {} }], spacing: 'comfortable', setupDismissed: false }, services: { groupOrder: ['Media'], order: {}, hiddenGroups: [] } };
const CUSTOM = { css: '.a { color: red; }', js: '/* custom */' };

const nativeInput = { services: SERVICES, stacks: { stacks: [{ project: 'opustream', displayName: 'Media', services: ['jellyfin'] }] }, bookmarks: BOOKMARKS, settings: SETTINGS, layout: LAYOUT, custom: CUSTOM };

// ---------------------------------------------------------------------------
// native
// ---------------------------------------------------------------------------

test('a native export carries every promised presentation area', () => {
  const out = exportNative(nativeInput);
  assert.deepEqual(
    Object.keys(out.files).sort(),
    ['app.js', 'bookmarks.yaml', 'layout.json', 'services.yaml', 'settings.yaml', 'stacks.yaml', 'theme.css'],
  );
  const services = YAML.parse(out.files['services.yaml']);
  assert.equal(services.groups[0].name, 'Media');
  assert.equal(services.groups[0].services[0].displayName, 'Stream');
  assert.equal(services.groups[0].services[0].icon, 'si:jellyfin');
  assert.equal(services.groups[0].services[0].url, 'https://stream.example.com');
  assert.equal(services.groups[0].services[1].hidden, true);
  assert.equal(YAML.parse(out.files['settings.yaml']).app.name, 'My Hub');
  assert.equal(JSON.parse(out.files['layout.json']).hub.spacing, 'comfortable');
  assert.equal(out.files['theme.css'], '.a { color: red; }');
  assert.equal(out.files['app.js'], '/* custom */');
});

test('a native export contains no authentication, session or runtime state, on any key', () => {
  const out = exportNative(nativeInput);
  // The exported *configuration* must not mention any of these. (The `notes`/`redactions` metadata
  // is allowed to use the word "password" — it is describing what was taken out, not carrying it.)
  const files = JSON.stringify(out.files);
  for (const forbidden of ['scrypt', 'password', 'passwordHash', 'session', 'auth.json', 'metrics', 'activity.jsonl', 'BEGIN PRIVATE KEY']) {
    assert.ok(!files.toLowerCase().includes(forbidden.toLowerCase()), `an exported file leaked "${forbidden}"`);
  }
  // Actual secret *values* must appear nowhere in the payload at all, metadata included.
  const whole = JSON.stringify(out);
  for (const value of ['secret@', 'PLANTED-TOKEN', 'PLANTED-HASH', 'PLANTED-SECRET']) {
    assert.ok(!whole.includes(value), `an export leaked the value "${value}"`);
  }
  // and it says so, in the payload, rather than leaving the user to take our word for it
  assert.ok(out.notes.some((n) => /Authentication, sessions, activity history/i.test(n)));
  assert.deepEqual(out.scope, ['services.yaml', 'stacks.yaml', 'bookmarks.yaml', 'settings.yaml', 'layout.json', 'theme.css', 'app.js']);
});

test('credentials embedded in URLs are stripped and reported', () => {
  const out = exportNative(nativeInput);
  const whole = JSON.stringify(out.files);
  assert.ok(!whole.includes('secret@'), 'an embedded password survived the export');
  assert.ok(!whole.includes('PLANTED-TOKEN'), 'a credential-shaped query parameter survived the export');
  assert.ok(out.redactions.some((r) => r.kind === 'userinfo'), 'the userinfo removal is reported');
  const query = out.redactions.find((r) => r.kind === 'query');
  assert.ok(query, 'the query-parameter removal is reported');
  assert.match(query.where, /Private feed/);
});

test('host-specific infrastructure is left out and the omission is stated', () => {
  const out = exportNative(nativeInput);
  const settings = YAML.parse(out.files['settings.yaml']);
  assert.equal(settings.infrastructure, undefined, 'a per-host address was exported');
  assert.ok(out.machineSpecific.some((n) => /hostAddress/.test(n)));
  assert.ok(out.redactions.some((r) => r.kind === 'machine'));
});

test('a partial export honours the include list', () => {
  const out = exportNative({ ...nativeInput, include: ['services.yaml', 'bookmarks.yaml'] });
  assert.deepEqual(Object.keys(out.files).sort(), ['bookmarks.yaml', 'services.yaml']);
});

test('an empty installation exports an empty but valid bundle', () => {
  const out = exportNative({ services: { groups: [] }, bookmarks: { groups: [] }, settings: { app: {} } });
  assert.ok(out.format === 'opushub');
  assert.ok('services.yaml' in out.files);
  assert.doesNotThrow(() => YAML.parse(out.files['services.yaml']));
});

// ---------------------------------------------------------------------------
// redactUrl / toHomepageIcon
// ---------------------------------------------------------------------------

test('redactUrl removes userinfo always and credential-shaped parameters by default', () => {
  assert.equal(redactUrl('https://u:p@host/x').url, 'https://host/x');
  assert.equal(redactUrl('https://host/x?key=abc').url, 'https://host/x');
  assert.equal(redactUrl('https://host/x?token=abc&sig=def').url, 'https://host/x');
  assert.equal(redactUrl('https://host/x?page=2&sort=asc').url, 'https://host/x?page=2&sort=asc');
  // an ordinary parameter is not a credential and is left alone
  assert.deepEqual(redactUrl('https://host/x?q=hello').redactions, []);
  // a same-origin path has nothing to strip
  assert.equal(redactUrl('/user/icons/a.png').url, '/user/icons/a.png');
});

test('toHomepageIcon translates the four reference shapes and refuses what has no spelling', () => {
  assert.equal(toHomepageIcon('si:jellyfin'), 'si-jellyfin');
  assert.equal(toHomepageIcon('mdi:waveform'), 'mdi-waveform');
  assert.equal(toHomepageIcon('lucide:waves'), 'lucide-waves');
  assert.equal(toHomepageIcon('https://cdn.example.com/i.svg'), 'https://cdn.example.com/i.svg');
  assert.equal(toHomepageIcon('/user/icons/mine.png'), null, 'a local file cannot travel');
  assert.equal(toHomepageIcon('🎬'), null, 'an emoji has no Homepage spelling');
});

// ---------------------------------------------------------------------------
// Homepage-compatible
// ---------------------------------------------------------------------------

test('a Homepage export produces the canonical list-of-maps shape', () => {
  const out = exportHomepage(nativeInput);
  assert.equal(out.format, 'homepage');
  const services = YAML.parse(out.files['services.yaml']);
  assert.ok(Array.isArray(services), 'Homepage services.yaml is a sequence');
  assert.ok(Array.isArray(services[0].Media), 'each entry is a single-key group map');
  const stream = services[0].Media.find((s) => 'Stream' in s);
  assert.ok(stream, 'the service is named');
  assert.equal(stream.Stream.href, 'https://stream.example.com');
  assert.equal(stream.Stream.icon, 'si-jellyfin');
  assert.equal(stream.Stream.container, 'jellyfin', 'the container binding round-trips');
});

test('a Homepage export writes bookmarks in the sequence-of-maps shape Homepage reads', () => {
  const out = exportHomepage(nativeInput);
  const bookmarks = YAML.parse(out.files['bookmarks.yaml']);
  assert.ok(Array.isArray(bookmarks));
  const item = bookmarks[0].Reading[0];
  assert.ok(Array.isArray(item['Hacker News']), 'a bookmark body is a sequence');
  assert.equal(item['Hacker News'][0].href, 'https://news.ycombinator.com');
});

test('a Homepage export strips credentials from the URLs it writes', () => {
  const out = exportHomepage(nativeInput);
  const whole = JSON.stringify(out.files);
  assert.ok(!whole.includes('secret@'));
  assert.ok(!whole.includes('PLANTED-TOKEN'));
});

test('what Homepage cannot express is reported rather than silently approximated', () => {
  const out = exportHomepage({ ...nativeInput, services: { groups: [{ name: 'Media', services: [{ container: 'jellyfin', displayName: 'Stream', icon: '/user/icons/mine.png', url: 'https://x.example.com' }] }] } });
  assert.ok(out.notes.some((n) => /local file/.test(n)), 'the un-exportable icon is named');
  assert.ok(!out.notes.some((n) => /silently/.test(n)));
});

test('stack annotations are reported as having no Homepage equivalent', () => {
  const out = exportHomepage(nativeInput);
  assert.ok(out.notes.some((n) => /stack annotation/.test(n)));
});

test('a widget with no Homepage sibling is reported and a real one is translated', () => {
  const out = exportHomepage(nativeInput);
  const widgets = YAML.parse(out.files['widgets.yaml']);
  assert.ok(widgets.some((w) => 'resources' in w), 'the system widget became `resources`');
  assert.ok(out.notes.some((n) => /news block has no Homepage equivalent/.test(n)));
});

test('an export round-trips through the importer', async () => {
  const { parseHomepageBundle, buildImportPreview } = await import('./homepageImport.js');
  const out = exportNative(nativeInput);
  // offer the exported files straight back to the importer
  const { bundle } = parseHomepageBundle({
    'services.yaml': out.files['services.yaml'],
    'bookmarks.yaml': out.files['bookmarks.yaml'],
  }, { widgetTypes: [] });
  assert.equal(bundle.source, 'opushub');
  const p = buildImportPreview({ bundle, report: { files: [], secrets: [] }, inventory: { live: true, services: [] } });
  // the containers are not running on this empty inventory, so everything is unmatched — but the
  // important part is that the *file* was understood, not re-invented
  assert.ok(p.summary.services >= 1);
});
