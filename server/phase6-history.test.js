// Phase 6 — configuration history, semantic diff, and restore.
//
// The single most important thing this file proves is a *negative*: restoring a configuration
// version does not touch authentication, sessions, the activity log, the metric history or `.env`.
//
// That is asserted by planting known bytes in every one of those files, running a restore, and
// re-reading them. A test that only checked "the configuration changed back" would pass just as
// happily against an implementation that also logged everyone out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-hist-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p6-hist-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;
process.env.OPUSHUB_DOCKER_SOCKET = '/tmp/opushub-p6-hist-nonexistent.sock';

const store = await import('./configStore.js');
const { LIMITS } = await import('./configSchema.js');
const {
  snapshot, listVersions, readVersion, restoreVersion, diffSnapshots,
  snapshotFiles, historyStats, prune, historyDir, stampOf, dateOf,
} = await import('./configHistory.js');
const { configScopeViolation, assertPresentationFile, PRESENTATION_FILES, PROTECTED_STATE } = await import('./configScope.js');

// ---------------------------------------------------------------------------
// a scratch installation with one of every kind of state
// ---------------------------------------------------------------------------

/** Files that must survive every configuration operation, byte for byte. */
const PROTECTED = {
  'data/auth.json': '{"version":1,"setup":{"complete":true},"user":{"username":"admin","scrypt":{"hash":"PLANTED-HASH"}}}',
  'data/sessions.json': '{"sessions":[{"id":"PLANTED-SESSION","username":"admin"}]}',
  'data/activity.jsonl': '{"at":1,"type":"app.boot","message":"PLANTED-EVENT"}\n',
  'data/metrics.json': '{"samples":[{"at":1,"cpu":42}]}',
  'config/.env': 'SECRET_TOKEN=PLANTED-SECRET\n',
};

function plantProtected() {
  for (const [rel, body] of Object.entries(PROTECTED)) {
    const file = path.join(rel.startsWith('data/') ? DATA_DIR : CONFIG_DIR, path.basename(rel));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  }
}
const readProtected = () => Object.fromEntries(Object.entries(PROTECTED).map(([rel]) => {
  const file = path.join(rel.startsWith('data/') ? DATA_DIR : CONFIG_DIR, path.basename(rel));
  return [rel, fs.readFileSync(file, 'utf8')];
}));

/** Write the seven presentation files as a coherent "state A". */
function writeStateA() {
  store.writeYaml('services.yaml', { groups: [{ name: 'Media', services: [{ container: 'jellyfin', displayName: 'Stream', icon: 'si:jellyfin' }] }] });
  store.writeYaml('bookmarks.yaml', { groups: [{ name: 'Reading', items: [{ name: 'Hacker News', href: 'https://news.ycombinator.com' }] }] });
  store.writeYaml('stacks.yaml', { stacks: [{ project: 'opustream', displayName: 'Media', description: 'Streaming' }] });
  store.writeYaml('settings.yaml', { app: { name: 'State A' }, appearance: { theme: 'dark', accent: 'teal' } });
  store.writeJson('layout.json', { version: 2, hub: { widgets: [{ id: 'w1', type: 'system', zone: 'main', size: 'md', visible: true, config: {} }], spacing: 'cozy', setupDismissed: false }, services: { groupOrder: null, order: {}, hiddenGroups: [] } });
  store.writeText('theme.css', '.a { color: red; }');
  store.writeText('app.js', '// state A\n');
}

/** Write a visibly different "state B". */
function writeStateB() {
  store.writeYaml('services.yaml', { groups: [{ name: 'Media', services: [{ container: 'jellyfin', displayName: 'Stream', icon: 'lucide:clapperboard', description: 'Renamed in B' }, { container: 'sonarr', displayName: 'Wave' }] }] });
  store.writeYaml('bookmarks.yaml', { groups: [{ name: 'Reading', items: [{ name: 'Hacker News', href: 'https://news.ycombinator.com' }, { name: 'Documentation', href: 'https://docs.example.com' }] }] });
  store.writeYaml('stacks.yaml', { stacks: [{ project: 'opustream', displayName: 'Media', description: 'Streaming and requests' }] });
  store.writeYaml('settings.yaml', { app: { name: 'State B' }, appearance: { theme: 'light', accent: 'rose' } });
  store.writeJson('layout.json', { version: 2, hub: { widgets: [{ id: 'w1', type: 'system', zone: 'rail', size: 'sm', visible: false, config: {} }], spacing: 'airy', setupDismissed: false }, services: { groupOrder: ['Media'], order: {}, hiddenGroups: ['Downloads'] } });
  store.writeText('theme.css', '.a { color: blue; }\n.b { color: green; }');
  store.writeText('app.js', '// state B\n');
}

plantProtected();
writeStateA();

test.after(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

test('a snapshot captures exactly the seven presentation files', () => {
  const v = snapshot({ reason: 'test', subject: 'state A', label: 'state A', force: true });
  assert.ok(v, 'a snapshot was recorded');
  assert.deepEqual(
    Object.keys(v.files).sort(),
    PRESENTATION_FILES.map((f) => f.name).sort(),
  );
  // and nothing else: the protected files are not in it
  for (const rel of Object.keys(PROTECTED)) {
    const base = path.basename(rel);
    assert.ok(!(base in v.files), `${base} leaked into a history snapshot`);
  }
});

test('a snapshot of identical content is not recorded twice', () => {
  const before = listVersions().length;
  const again = snapshot({ reason: 'test', subject: 'state A again' });
  assert.equal(again, null, 'a duplicate snapshot must be skipped, not stored');
  assert.equal(listVersions().length, before);
});

test('versions are listed newest first, with what changed and how big they are', () => {
  writeStateB();
  snapshot({ reason: 'test', subject: 'state B', force: true });
  const versions = listVersions();
  assert.ok(versions.length >= 2);
  assert.ok(versions[0].at >= versions[versions.length - 1].at);
  for (const v of versions) {
    assert.ok(v.bytes > 0);
    assert.ok(Array.isArray(v.files) && v.files.length === 7);
  }
});

test('a version records which files differed from the one before it', () => {
  const versions = listVersions();
  const latest = readVersion(versions[0].id);
  assert.ok(Array.isArray(latest.changed));
  assert.ok(latest.changed.some((c) => c.file === 'services.yaml'));
});

test('stampOf and dateOf round-trip a filesystem-safe timestamp', () => {
  const stamp = stampOf(new Date('2026-09-15T12:00:00.000Z'));
  assert.equal(stamp, '2026-09-15T12-00-00-000Z');
  assert.equal(dateOf(stamp).toISOString(), '2026-09-15T12:00:00.000Z');
  assert.equal(dateOf('not-a-stamp'), null);
});

// ---------------------------------------------------------------------------
// semantic diff
// ---------------------------------------------------------------------------

test('a service diff is semantic: names and fields, not array indices', () => {
  writeStateA();
  const a = snapshotFiles();
  writeStateB();
  const b = snapshotFiles();
  const diff = diffSnapshots(a, b);

  const services = diff.sections.find((s) => s.file === 'services.yaml');
  assert.ok(services, 'services.yaml appears in the diff');
  const texts = services.entries.map((e) => e.text).join('\n');
  assert.match(texts, /Stream · icon: si:jellyfin → lucide:clapperboard/, 'the icon change is readable');
  assert.match(texts, /\+ Wave/, 'the added service is named');
  assert.ok(!texts.includes('groups[0].services[0]'), 'the diff is not an array walk');
});

test('a bookmark diff reads as additions, and a settings diff reads as key paths', () => {
  writeStateA();
  const a = snapshotFiles();
  writeStateB();
  const b = snapshotFiles();
  const diff = diffSnapshots(a, b);

  const bookmarks = diff.sections.find((s) => s.file === 'bookmarks.yaml');
  assert.match(bookmarks.entries.map((e) => e.text).join('\n'), /\+ Documentation/);

  const settings = diff.sections.find((s) => s.file === 'settings.yaml');
  const paths = settings.entries.map((e) => e.text).join('\n');
  assert.match(paths, /app\.name: State A → State B/);
  assert.match(paths, /appearance\.theme: dark → light/);
});

test('a layout diff names widgets and visibility rather than dumping JSON', () => {
  writeStateA();
  const a = snapshotFiles();
  writeStateB();
  const b = snapshotFiles();
  const diff = diffSnapshots(a, b);
  const layout = diff.sections.find((s) => s.file === 'layout.json');
  const texts = layout.entries.map((e) => e.text).join('\n');
  assert.match(texts, /system · zone: main → rail/);
  assert.match(texts, /system · visible: on → off/);
  assert.match(texts, /spacing: cozy → airy/);
  assert.match(texts, /hidden groups/);
});

test('a text-file diff reports line counts, and an identical pair reports no change', () => {
  const diff = diffSnapshots({ 'theme.css': 'a\nb\n' }, { 'theme.css': 'a\nc\n' });
  const entries = diff.sections[0].entries.map((e) => e.text).join('; ');
  assert.match(entries, /1 line added/);
  assert.match(entries, /1 line removed/);
  assert.equal(diffSnapshots({ 'theme.css': 'same\n' }, { 'theme.css': 'same\n' }).identical, true);
});

test('an added or removed file is reported as such', () => {
  const added = diffSnapshots({}, { 'theme.css': 'x' });
  assert.equal(added.sections[0].kind, 'added');
  const removed = diffSnapshots({ 'theme.css': 'x' }, {});
  assert.equal(removed.sections[0].kind, 'removed');
});

// ---------------------------------------------------------------------------
// restore — the safety property this whole module exists for
// ---------------------------------------------------------------------------

test('restore puts a previous version back, byte for byte', () => {
  writeStateA();
  const a = snapshot({ reason: 'test', subject: 'A for restore', force: true });
  const aServices = fs.readFileSync(path.join(CONFIG_DIR, 'services.yaml'), 'utf8');

  writeStateB();
  const bServices = fs.readFileSync(path.join(CONFIG_DIR, 'services.yaml'), 'utf8');
  assert.notEqual(aServices, bServices);

  const result = restoreVersion(a.id, { actor: 'test-user' });
  assert.equal(result.restored, a.id);
  assert.ok(result.files.includes('services.yaml'));
  assert.equal(fs.readFileSync(path.join(CONFIG_DIR, 'services.yaml'), 'utf8'), aServices, 'the file came back exactly');
});

test('RESTORING CONFIGURATION DOES NOT TOUCH AUTH, SESSIONS, ACTIVITY, METRICS OR SECRETS', () => {
  // Re-plant, so this test cannot pass because an earlier one happened to leave them alone.
  plantProtected();
  const before = readProtected();

  writeStateA();
  const a = snapshot({ reason: 'test', subject: 'safety', force: true });
  writeStateB();
  snapshot({ reason: 'test', subject: 'safety B', force: true });
  restoreVersion(a.id, { actor: 'test-user' });

  const after = readProtected();
  assert.deepEqual(after, before, 'a configuration restore modified protected state');
  // and state it individually, so a failure names the file instead of printing two blobs
  for (const rel of Object.keys(PROTECTED)) {
    assert.equal(after[rel], before[rel], `${rel} was modified by a configuration restore`);
  }
});

test('restore is itself reversible: it snapshots the state it is about to replace', () => {
  writeStateA();
  const a = snapshot({ reason: 'test', subject: 'reversible A', force: true });
  writeStateB();
  const b = snapshot({ reason: 'test', subject: 'reversible B', force: true });

  const restored = restoreVersion(a.id);
  assert.ok(restored.undoVersion, 'a pre-restore snapshot was taken');

  // Immediately after restoring A, the content is A.
  let containers = store.readYaml('services.yaml').groups.flatMap((g) => g.services.map((s) => s.container));
  assert.ok(!containers.includes('sonarr'), 'the restore should have put state A back');

  // Undoing must return to what was there *before* the restore — state B — not to A again.
  const undo = restoreVersion(restored.undoVersion);
  assert.ok(undo.files.length > 0);
  containers = store.readYaml('services.yaml').groups.flatMap((g) => g.services.map((s) => s.container));
  assert.ok(containers.includes('sonarr'), 'the undo did not restore the pre-restore state');
});

test('restoring an unknown version is a clean 404, not a partial write', () => {
  assert.throws(() => restoreVersion('2020-01-01T00-00-00-000Z'), (err) => err.status === 404 && err.code === 'version_not_found');
});

test('a version containing a file outside the presentation scope is refused for that file only', () => {
  // A hand-edited or very old version could name something the boundary forbids. The guard is
  // per-file, so the legitimate files still restore.
  const id = '2026-01-01T00-00-00-000Z';
  fs.mkdirSync(historyDir(), { recursive: true });
  fs.writeFileSync(path.join(historyDir(), `${id}.json`), JSON.stringify({
    format: 1,
    at: '2026-01-01T00:00:00.000Z',
    reason: 'hand-made',
    label: 'hostile version',
    files: {
      'theme.css': '.safe { color: green; }',
      'auth.json': '{"user":{"password":"replaced"}}',
      'activity.jsonl': '',
      '../../evil.yaml': 'nope',
    },
  }));
  const before = readProtected();
  const result = restoreVersion(id);
  assert.ok(result.files.includes('theme.css'));
  assert.ok(result.skipped.some((s) => s.file === 'auth.json'), 'the out-of-scope file was refused');
  assert.ok(result.skipped.some((s) => s.file.includes('evil')), 'the traversing path was refused');
  assert.equal(fs.existsSync(path.join(CONFIG_DIR, 'evil.yaml')), false, 'a traversal wrote outside the config directory');
  assert.deepEqual(readProtected(), before, 'protected state changed while restoring a hostile version');
});

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

test('history retention is bounded by count', () => {
  const stampBase = Date.now();
  fs.mkdirSync(historyDir(), { recursive: true });
  // Write more versions than the cap, directly, then prune.
  for (let i = 0; i < LIMITS.historyVersions + 15; i++) {
    const stamp = stampOf(new Date(stampBase + i * 1000));
    fs.writeFileSync(path.join(historyDir(), `${stamp}.json`), JSON.stringify({
      format: 1, at: new Date(stampBase + i * 1000).toISOString(), reason: 'bulk',
      label: `bulk ${i}`, files: { 'theme.css': `/* ${i} */` },
    }));
  }
  const removed = prune();
  assert.ok(removed > 0, 'prune removed something');
  const versions = listVersions();
  assert.ok(versions.length <= LIMITS.historyVersions, `${versions.length} versions retained, cap is ${LIMITS.historyVersions}`);
  // the newest survived
  assert.equal(versions[0].id, stampOf(new Date(stampBase + (LIMITS.historyVersions + 14) * 1000)));
  const stats = historyStats();
  assert.equal(stats.retention.versions, LIMITS.historyVersions);
  assert.ok(stats.totalBytes <= stats.retention.bytes);
});

test('a corrupt version file is skipped by the listing rather than breaking it', () => {
  fs.writeFileSync(path.join(historyDir(), '2026-02-02T00-00-00-000Z.json'), '{ this is not json');
  const versions = listVersions();
  assert.ok(versions.length > 0);
  assert.ok(!versions.some((v) => v.id === '2026-02-02T00-00-00-000Z'));
});

// ---------------------------------------------------------------------------
// the scope boundary, as its own contract
// ---------------------------------------------------------------------------

test('every protected path is refused by configScopeViolation with a reason', () => {
  for (const entry of PROTECTED_STATE) {
    const violation = configScopeViolation(entry.path);
    assert.ok(violation, `${entry.path} was not refused`);
    assert.equal(typeof violation, 'string');
  }
  assert.ok(configScopeViolation('auth.json'), 'a bare filename is refused too');
  assert.ok(configScopeViolation('../config/services.yaml'), 'a traversing path is refused');
  assert.ok(configScopeViolation('/etc/passwd'), 'an absolute path is refused');
  assert.ok(configScopeViolation('something-else.yaml'), 'an unknown file is refused');
});

test('every presentation file passes the boundary check', () => {
  for (const f of PRESENTATION_FILES) {
    assert.equal(configScopeViolation(f.name), null, `${f.name} should be allowed`);
    assert.equal(assertPresentationFile(f.name), f.name);
  }
});

test('assertPresentationFile explains *why* a protected file is protected', () => {
  assert.throws(() => assertPresentationFile('auth.json'), (err) => err.code === 'scope_violation' && /authentication state/.test(err.message));
  assert.throws(() => assertPresentationFile('sessions.json'), (err) => /sign users out/.test(err.message));
  assert.throws(() => assertPresentationFile('.env'), (err) => /secrets/.test(err.message));
});
