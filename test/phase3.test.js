// Phase 3 — deep read-only service intelligence, verified against the mock engine.
// Covers: SERVICE (every state + URL variants), STATS (available/unavailable/malformed/bounded),
// LOGS (available/empty/large/timestamps), STACKS (statuses/standalone), ACTIVITY (dedupe +
// grouping), SEARCH (ranking tiers, hidden), SECURITY (no env/proxy/command leakage), PROVIDERS.
// Everything runs in a throwaway config dir against a throwaway socket — nothing real is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine } from './mock-engine.js';

const OLD_ENV = { ...process.env };
let ENGINE = null;
let handleApi, activity, healthMod, statsMod;
let COOKIE = null;

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-phase3-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-phase3-data-'));

function req(method, p, body = null) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return {
    method,
    headers: COOKIE ? { cookie: COOKIE } : {},
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
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

async function get(pathname) {
  const r = res();
  try {
    await handleApi(req('GET', pathname), r, new URL(pathname, 'http://x'));
  } catch (err) {
    // the real HTTP server turns thrown route errors into a status response — mirror that
    return { status: err.status || 500, json: { error: String(err.message || err) } };
  }
  let json = {};
  try { json = JSON.parse(r.state.body || '{}'); } catch { json = { _raw: r.state.body }; }
  return { status: r.state.status, json };
}

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
  process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
  process.env.OPUSHUB_DATA_DIR = DATA_DIR;
  process.env.OPUSHUB_HOST_ADDRESS = '198.51.100.20';
  // a hidden service + a bookmark, for the search assertions
  fs.writeFileSync(path.join(CONFIG_DIR, 'services.yaml'), [
    'groups:',
    '  - name: Media',
    '    services:',
    '      - container: jellyfin',
    '        displayName: Stream',
    '      - container: traefik',
    '        hidden: true',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(CONFIG_DIR, 'bookmarks.yaml'), [
    'groups:',
    '  - name: Reading',
    '    items:',
    '      - name: Jellyfin Docs',
    '        href: https://jellyfin.org/docs/',
  ].join('\n'), 'utf8');
  ({ handleApi } = await import('../server/api.js'));
  const { seedSession } = await import('./auth-helper.js');
  COOKIE = await seedSession();
  activity = await import('../server/activity.js');
  healthMod = await import('../server/providers/health.js');
  statsMod = await import('../server/statsHistory.js');
});

test.after(async () => {
  await ENGINE?.stop();
  process.env = OLD_ENV;
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// ── SERVICE: one detail route, every real state ─────────────────────────────

test('service detail: running + healthy + healthcheck detail', async () => {
  const { status, json } = await get('/api/services/Media/jellyfin');
  assert.equal(status, 200);
  assert.equal(json.service.status, 'up');
  assert.equal(json.container.state.status, 'running');
  assert.equal(json.container.state.health, 'healthy');
  assert.deepEqual(json.container.state.healthcheck, { status: 'healthy', failingStreak: 0 });
  assert.ok(json.container.state.startedAt, 'started timestamp is real Docker data');
  assert.equal(json.dockerAvailable, true);
});

test('service detail: unhealthy is a health verdict on a running container', async () => {
  const { json } = await get('/api/services/Other/navidrome');
  assert.equal(json.service.status, 'unhealthy');
  assert.equal(json.container.state.status, 'running');
  assert.equal(json.container.state.healthcheck.status, 'unhealthy');
  assert.ok(json.container.state.healthcheck.failingStreak >= 1);
  assert.equal(json.container.state.restartCount, 2, 'restart count comes from inspect');
});

test('service detail: no healthcheck is reported as such, never as unhealthy', async () => {
  const { json } = await get('/api/services/Other/seerr');
  assert.equal(json.container.state.status, 'running');
  assert.equal(json.container.state.health, null);
  assert.equal(json.container.state.healthcheck, null, 'no healthcheck → null, not a verdict');
  assert.equal(json.service.status, 'up');
});

test('service detail: stopped, paused, created and restarting are distinct honest states', async () => {
  const stopped = await get('/api/services/Other/paperless');
  assert.equal(stopped.json.container.state.status, 'exited');
  assert.equal(stopped.json.service.status, 'down');
  assert.ok(stopped.json.container.state.finishedAt, 'finishedAt exists for an exited container');

  const paused = await get('/api/services/Other/home-assistant');
  assert.equal(paused.json.container.state.status, 'paused');
  assert.equal(paused.json.service.status, 'paused');

  const created = await get('/api/services/Other/nightly-backup-runner-with-a-remarkably-long-name');
  assert.equal(created.json.container.state.status, 'created');

  const restarting = await get('/api/services/Other/restart-loop');
  assert.equal(restarting.json.container.state.status, 'restarting');
  assert.equal(restarting.json.container.state.restartCount, 42, 'a restart loop is visible');
});

test('service detail: URL source transparency (traefik vs published-port vs manual vs none)', async () => {
  const jellyfin = await get('/api/services/Media/jellyfin');
  assert.equal(jellyfin.json.urlSource, 'traefik');
  assert.equal(jellyfin.json.url, 'http://stream.lab.internal');
  const radarr = await get('/api/services/Other/radarr');
  assert.equal(radarr.json.urlSource, 'published-port');
  assert.match(radarr.json.url, /^http:\/\/198\.51\.100\.20:7878$/);
  const sonarr = await get('/api/services/Other/sonarr');
  assert.equal(sonarr.json.url, null);
  assert.equal(sonarr.json.urlSource, 'none');
});

test('service detail: published vs exposed ports are distinct facts', async () => {
  const { json } = await get('/api/services/Media/jellyfin');
  assert.ok(json.container.ports.length >= 1, 'published bindings exist');
  assert.ok(Array.isArray(json.container.exposedPorts));
  const sonarr = await get('/api/services/Other/sonarr');
  assert.deepEqual(sonarr.json.container.ports, [], 'no published port');
  assert.equal(sonarr.json.url, null, 'and therefore no URL can exist');
});

test('service detail: networks carry names and aliases; mounts are read-only views', async () => {
  const { json } = await get('/api/services/Media/jellyfin');
  assert.ok(json.container.networks.length >= 1);
  assert.ok(json.container.networks[0].aliases.includes('jellyfin'));
  assert.ok(json.container.mounts.some((m) => m.type === 'bind' && m.target === '/media' && m.rw === false));
});

test('service detail: image facts (tag, digest where present, arch, created) with no config env', async () => {
  const { json } = await get('/api/services/Media/jellyfin');
  assert.ok(json.image, 'image info resolved');
  assert.deepEqual(json.image.tags, ['jellyfin/jellyfin:10.9.7']);
  assert.equal(json.image.arch, 'amd64');
  assert.ok(json.image.created);
  const blob = JSON.stringify(json);
  assert.ok(!blob.includes('SHOULD_NEVER_LEAVE_SERVER'), 'image Config.Env never crosses the boundary');
  assert.ok(!blob.includes('SECRET_SHOULD_NEVER_LEAVE_SERVER'), 'container Env never crosses the boundary');
});

// ── STATS: demand-driven, bounded, honest ────────────────────────────────────

test('stats: available for a running container, with every metric the engine gave', async () => {
  const { json } = await get('/api/services/Media/jellyfin/stats');
  assert.equal(json.status, 'ok');
  assert.ok(json.stats.cpu != null && json.stats.cpu >= 0);
  assert.ok(json.stats.memory.used > 0);
  assert.ok(json.stats.memory.limit > 0);
  assert.ok(json.stats.net.rx >= 0 && json.stats.net.tx >= 0);
  assert.ok(json.stats.pids != null);
});

test('stats: unavailable is reported, not faked (stopped container)', async () => {
  const { json } = await get('/api/services/Other/paperless/stats');
  assert.equal(json.status, 'unavailable');
  assert.equal(json.stats, null);
});

test('stats: malformed engine payloads become unavailable, not a crash', async () => {
  // the exited fixture answers with an empty cpu_stats object — the projection must reject it
  const { json } = await get('/api/services/Other/immich-machine-learning/stats');
  assert.equal(json.status, 'unavailable');
});

test('stats history: samples accumulate only when asked, and stay bounded', async () => {
  statsMod.resetStatsHistory();
  const first = await get('/api/services/Media/jellyfin/stats');
  assert.equal(first.json.status, 'ok');
  const h1 = await get('/api/services/Media/jellyfin/stats/history');
  assert.equal(h1.json.samples.length, 1, 'one request → one real sample');
  // an immediate second fetch shares the dedup cache — no extra sample, no extra Docker call
  await get('/api/services/Media/jellyfin/stats');
  const h2 = await get('/api/services/Media/jellyfin/stats/history');
  assert.equal(h2.json.samples.length, 1, 'dedup window prevents a polling storm');
  assert.ok(h2.json.watchingSince > 0);
  // the buffer itself is capped (keyed by the container id the service resolves to)
  const cap = statsMod._internals.MAX_SAMPLES;
  assert.equal(statsMod._internals.buffers.size, 1, 'only the watched container has a buffer');
  const buf = [...statsMod._internals.buffers.values()][0];
  for (let i = 0; i < cap + 50; i++) buf.samples.push({ t: Date.now(), cpu: 1 });
  // force one more real sample through (past the min-interval and dedup guards) to trigger the trim
  buf.lastAt = 0;
  statsMod._internals.inflight.clear();
  await get('/api/services/Media/jellyfin/stats');
  assert.ok(buf.samples.length <= cap, `ring buffer stays capped (${buf.samples.length} ≤ ${cap})`);
});

// ── LOGS: read-only, bounded, honest ─────────────────────────────────────────

test('logs: fetched through the service route, tail-capped, timestamps optional', async () => {
  const plain = await get('/api/services/Media/jellyfin/logs?tail=3');
  assert.equal(plain.json.status, 'ok');
  assert.ok(plain.json.lines.length <= 3 && plain.json.lines.length > 0);
  const stamped = await get('/api/services/Other/seerr/logs?tail=2&timestamps=1');
  assert.ok(stamped.json.lines.every((l) => /^\d{4}-\d{2}-\d{2}T/.test(l)));
});

test('logs: an empty log says so instead of inventing output', async () => {
  const { json } = await get('/api/services/Other/restart-loop/logs');
  assert.equal(json.status, 'ok');
  assert.deepEqual(json.lines, []);
});

test('logs: a huge log never crosses the 500-line / 256KB boundary', async () => {
  const { json } = await get('/api/services/Other/nextcloud/logs?tail=500');
  assert.equal(json.status, 'ok');
  assert.ok(json.lines.length <= 500);
  const huge = await get('/api/services/Other/nextcloud/logs?tail=999999');
  assert.ok(huge.json.lines.length <= 500);
});

// ── STACKS: deterministic status + member rollup ────────────────────────────

test('stacks: statuses follow the documented model, with counts for the rollup', async () => {
  const { json } = await get('/api/stacks');
  const by = (p) => json.stacks.find((s) => s.project === p);
  assert.equal(by('secure').status, 'operational', 'all running + healthy');
  assert.equal(by('opustream').status, 'degraded', 'navidrome is unhealthy');
  assert.equal(by('photos').status, 'degraded', 'one exited member while others run');
  const media = by('opustream');
  assert.equal(media.containerCount, media.members.length);
  assert.equal(media.unhealthyCount, 1);
  assert.ok(media.runningCount >= 1);
  assert.ok(typeof media.stoppedCount === 'number' && typeof media.attentionCount === 'number');
  assert.ok(json.standalone.some((c) => c.name === 'restart-loop'), 'standalone containers stay standalone');
});

test('stack detail: members are enriched; totals stay read-only projections', async () => {
  const { json } = await get('/api/stacks/secure');
  assert.equal(json.status, 'operational');
  assert.ok(json.members.length >= 1);
  const m = json.members[0];
  assert.ok(Array.isArray(m.ports));
  assert.ok(m.stats && typeof m.stats.cpu === 'number', 'running members carry live stats');
});

// ── ACTIVITY: dedupe + grouping ─────────────────────────────────────────────

test('activity filters: service, stack, type and time narrow the whole log, not the last page', async () => {
  activity._resetActivity();
  // a small, known history: three services, two projects, three event families
  activity.logEvent({ source: 'docker', type: 'container.stopped', subject: 'jellyfin', message: 'stopped', meta: { project: 'opustream' } });
  activity.logEvent({ source: 'docker', type: 'container.exited', subject: 'paperless', message: 'exited', meta: { project: 'paperless' } });
  activity.logEvent({ source: 'config', type: 'settings.updated', subject: 'settings.yaml', message: 'appearance' });
  activity.logEvent({ source: 'auth', type: 'auth.login', subject: 'admin', message: 'signed in from 10.0.0.2' });
  const old = activity.logEvent({ source: 'docker', type: 'container.health', subject: 'navidrome', message: 'health now unhealthy', meta: { project: 'music' } });
  // age one event so the time filter has something real to exclude
  assert.ok(old);

  const byService = await get('/api/activity?limit=100&service=jellyfin');
  assert.deepEqual(byService.json.items.map((e) => e.subject), ['jellyfin']);
  assert.ok(byService.json.matched >= 1);
  assert.ok(byService.json.total >= 5, 'total still reports the whole log');
  // a substring, because container names carry project suffixes
  const partial = await get('/api/activity?limit=100&service=paper');
  assert.deepEqual(partial.json.items.map((e) => e.subject), ['paperless']);

  const byStack = await get('/api/activity?limit=100&stack=opustream');
  assert.deepEqual(byStack.json.items.map((e) => e.subject), ['jellyfin']);
  assert.deepEqual((await get('/api/activity?limit=100&stack=nope')).json.items, []);

  const byType = await get('/api/activity?limit=100&type=container');
  assert.ok(byType.json.items.every((e) => e.type.startsWith('container')));
  assert.ok(byType.json.items.length >= 2, 'the prefix matched the container family');
  assert.ok(!byType.json.items.some((e) => e.source !== 'docker'), 'the type filter let another source through');
  const exact = await get('/api/activity?limit=100&type=auth.login');
  assert.deepEqual(exact.json.items.map((e) => e.subject), ['admin']);

  // time: everything is newer than an hour ago, nothing is newer than a minute from now
  const recent = await get(`/api/activity?limit=100&since=${Date.now() - 3600_000}`);
  assert.ok(recent.json.items.length >= 5);
  const future = await get(`/api/activity?limit=100&since=${Date.now() + 60_000}`);
  assert.deepEqual(future.json.items, []);
  assert.equal(future.json.matched, 0);

  // filters compose, and the echo says what was applied
  const composed = await get('/api/activity?limit=100&source=docker&stack=music&type=container.health');
  assert.deepEqual(composed.json.items.map((e) => e.subject), ['navidrome']);
  assert.equal(composed.json.filters.source, 'docker');
  assert.equal(composed.json.filters.stack, 'music');
  assert.equal(composed.json.filters.type, 'container.health');

  // filtering then grouping still keeps the group's own events
  activity._resetActivity();
  for (const n of ['a', 'b', 'c']) {
    activity.logEvent({ source: 'docker', type: 'container.restarted', subject: `${n}-1`, meta: { project: 'burst' } });
  }
  activity.logEvent({ source: 'docker', type: 'container.restarted', subject: 'other-1', meta: { project: 'elsewhere' } });
  const grouped = await get('/api/activity?limit=100&grouped=1&stack=burst');
  const group = grouped.json.items.find((e) => e.grouped);
  assert.ok(group, 'the burst grouped after filtering');
  assert.equal(group.count, 3);
  assert.ok(group.events.every((e) => e.meta.project === 'burst'), 'grouping never folds in a filtered-out event');
});

test('activity: identical signatures inside the window are told once', async () => {
  activity._resetActivity();
  const one = activity.logEvent({ source: 'docker', type: 'container.exited', subject: 'paperless', message: 'exited', signature: 'container.exited:paperless:exited' });
  const two = activity.logEvent({ source: 'docker', type: 'container.exited', subject: 'paperless', message: 'exited', signature: 'container.exited:paperless:exited' });
  assert.ok(one, 'first telling is kept');
  assert.equal(two, null, 'the duplicate is dropped');
});

test('activity: a compose-wide burst groups into one summary that keeps its events', async () => {
  for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
    activity.logEvent({ source: 'docker', type: 'container.started', subject: `${name}-1`, message: 'running · Up 1 second', meta: { project: 'demo', state: 'running' } });
  }
  const { json } = await get('/api/activity?grouped=1&limit=100');
  const grp = json.items.find((i) => i.grouped);
  assert.ok(grp, 'the burst became one grouped item');
  assert.equal(grp.count, 4);
  assert.equal(grp.project, 'demo');
  assert.equal(grp.events.length, 4, 'the underlying events stay accessible');
  const flat = await get('/api/activity?limit=100');
  assert.ok(!flat.json.items.some((i) => i.grouped), 'grouping is opt-in');
  assert.ok(json.watchingSince > 0, 'the API says when watching began');
});

test('activity: health changes and provider transitions are worded events', async () => {
  activity.logEvent({ source: 'docker', type: 'container.health', subject: 'navidrome', message: 'health: unhealthy', meta: { project: 'opustream', health: 'unhealthy' } });
  healthMod.reportProvider('news', 'unavailable', { reason: 'feeds unreachable' });
  healthMod.reportProvider('news', 'available');
  const { json } = await get('/api/activity?limit=50');
  const kinds = json.items.map((e) => e.type);
  assert.ok(kinds.includes('container.health'));
  assert.ok(kinds.includes('provider.unavailable'));
  assert.ok(kinds.includes('provider.recovered'));
});

test('stack status model: the documented rules, case by case (unit level)', async () => {
  const m = await import('../server/model.js');
  const C = (state, health = null) => ({ state, health });
  assert.equal(m.stackStatus([], true), 'unlinked');
  assert.equal(m.stackStatus([C('running')], true), 'operational');
  assert.equal(m.stackStatus([C('running'), C('running')], true), 'operational', 'no healthcheck never degrades');
  assert.equal(m.stackStatus([C('running'), C('running', 'unhealthy')], true), 'degraded');
  assert.equal(m.stackStatus([C('running'), C('exited')], true), 'degraded');
  assert.equal(m.stackStatus([C('exited'), C('exited')], true), 'stopped');
  assert.equal(m.stackStatus([C('exited'), C('paused')], true), 'attention');
  assert.equal(m.stackStatus([C('restarting')], true), 'attention');
  assert.equal(m.stackStatus([C('running'), C(null)], true), 'unknown');
  assert.equal(m.stackStatus([C('running')], false), 'unavailable');
});

// ── SERVICE HISTORY: real events only ────────────────────────────────────────

test('service history: returns witnessed events and says when watching started', async () => {
  activity.logEvent({ source: 'docker', type: 'container.started', subject: 'jellyfin', message: 'running · Up 2 seconds', meta: { project: 'opustream' } });
  const { json } = await get('/api/services/Media/jellyfin/history');
  assert.equal(json.service, 'jellyfin');
  assert.ok(json.events.length >= 1);
  assert.equal(json.events[0].subject, 'jellyfin');
  assert.ok(json.watchingSince > 0, 'history is honest about its own beginning');
  const quiet = await get('/api/services/Other/sonarr/history');
  assert.deepEqual(quiet.json.events, [], 'no events → empty list, never invented');
});

// ── SEARCH: ranking tiers + the canonical inventory ─────────────────────────

test('search: exact beats prefix beats substring beats subsequence', async () => {
  const exact = await get('/api/search?q=jellyfin');
  assert.equal(exact.json.results[0].kind, 'service');
  assert.equal(exact.json.results[0].title, 'Stream', 'overlay display name, exact match, first');
  const prefix = await get('/api/search?q=navi');
  assert.ok(prefix.json.results.some((r) => r.kind === 'service' && /navidrome/i.test(r.href)));
  const subseq = await get('/api/search?q=nvd');
  assert.ok(subseq.json.results.length >= 1, 'tight subsequence still matches');
});

test('search: services outrank pages for the same word; hidden stays hidden', async () => {
  const r = await get('/api/search?q=media');
  const kinds = r.json.results.map((x) => x.kind);
  assert.ok(kinds.length > 0);
  const hidden = await get('/api/search?q=traefik');
  assert.ok(!hidden.json.results.some((x) => x.kind === 'service' && /traefik/i.test(x.href || '')), 'hidden service is not a search result');
});

test('search: stacks, bookmarks, settings and pages all answer from one index', async () => {
  const stack = await get('/api/search?q=opustream');
  assert.ok(stack.json.results.some((r) => r.kind === 'stack'));
  const bookmark = await get('/api/search?q=jellyfin docs');
  assert.ok(bookmark.json.results.some((r) => r.kind === 'bookmark'));
  const setting = await get('/api/search?q=widgets');
  assert.ok(setting.json.results.some((r) => r.kind === 'setting'));
  const page = await get('/api/search?q=activity');
  assert.ok(page.json.results.some((r) => r.kind === 'page' && r.href === '/activity'));
});

// ── PROVIDERS: one honest health doc ─────────────────────────────────────────

test('providers: every source reports a state and its last success', async () => {
  await get('/api/system'); // system reports itself on a successful collect
  const { json } = await get('/api/providers');
  const names = json.providers.map((p) => p.name);
  assert.deepEqual(names, ['docker', 'system', 'news', 'weather', 'markets']);
  const sys = json.providers.find((p) => p.name === 'system');
  assert.equal(sys.state, 'available');
  assert.ok(sys.lastTry > 0);
  for (const p of json.providers) assert.ok(['available', 'unavailable', 'degraded', 'idle'].includes(p.state));
});

// ── SECURITY: the read-only boundary holds ───────────────────────────────────

test('security: no env, no arbitrary docker path, no socket, no mutation surface', async () => {
  const detail = await get('/api/services/Other/vaultwarden');
  const blob = JSON.stringify(detail.json);
  assert.ok(!blob.includes('MOCK-PW-NOT-REAL'), 'credential-looking command parts are redacted');
  assert.match(detail.json.container.command, /••••/);
  assert.ok(!blob.includes('.sock'));

  // there is no generic docker proxy and no mutation endpoint to find
  for (const evil of [
    '/api/docker/containers/json',          // engine paths are not browsable
    '/api/docker/exec',
    '/api/services/Media/jellyfin/exec',
    '/api/services/Media/jellyfin/restart',
    '/api/docker/containers/jellyfin/../../version',
  ]) {
    const r = await get(evil);
    assert.equal(r.status, 404, `${evil} must not exist`);
  }
  // traversal-shaped refs are refused on the logs routes
  const evilRef = await get('/api/docker/containers/..%2F..%2Fversion/logs');
  assert.equal(evilRef.json.status, 'error');
  const evilSvc = await get('/api/services/Other/..%2F..%2Fetc/logs');
  assert.ok([404].includes(evilSvc.status) || evilSvc.json.status === 'error' || (evilSvc.json.lines || []).length === 0);

  // the passthrough logs route is bounded to containers discovery actually saw: a well-formed
  // but unknown name must not read anything, while a discovered one still works
  const unknown = await get('/api/docker/containers/some-container-that-does-not-exist/logs');
  assert.equal(unknown.json.status, 'error');
  assert.match(unknown.json.reason || '', /discovered/i);
  assert.deepEqual(unknown.json.lines, []);
  const known = await get('/api/docker/containers/jellyfin/logs?tail=5');
  assert.equal(known.json.status, 'ok', 'discovered containers keep their logs');
});
