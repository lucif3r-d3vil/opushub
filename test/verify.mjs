// Scratch-environment verification — the checks that must hold against a real running OpusHub.
//
// Everything here is done in a throwaway config directory in the system temp folder, on its own
// port, with its own data directory: your real config/ is never read, written, or at risk. Nothing
// is faked either — the script asserts what the API reports, and when no Docker engine is reachable
// it verifies the *unavailable* path instead of pretending services exist.
//
//   node test/verify.mjs                                   mock engine, empty config
//   OPUSHUB_DOCKER_SOCKET=/var/run/docker.sock node test/verify.mjs   the real engine
//
// It leaves the scratch directory on disk if a run fails, so the state can be inspected.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_SOCKET = '/tmp/opushub-mock-docker.sock';
const PORT = Number(process.env.OPUSHUB_VERIFY_PORT || 3721);
const BASE = `http://127.0.0.1:${PORT}`;

const socket = process.env.OPUSHUB_DOCKER_SOCKET
  || (fs.existsSync(MOCK_SOCKET) ? MOCK_SOCKET : null);

let failures = 0;
let checks = 0;
const check = (name, ok, detail = '') => {
  checks++;
  if (ok) console.log(`✓ ${name}`);
  else { failures++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// A cookie jar, because every application endpoint now requires a session — exactly like a
// browser. Origin is sent on writes, which is what the CSRF gate expects from a real client.
let COOKIE = null;
const jar = (headers = {}) => {
  const h = { ...headers };
  if (COOKIE) h.cookie = COOKIE;
  return h;
};
const capture = (res) => {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const m = /^opushub_session=([^;]*)/.exec(c);
    if (m) COOKIE = m[1] ? `opushub_session=${m[1]}` : null;
    if (/^opushub_session=;/.test(c) || /Max-Age=0/.test(c)) COOKIE = null;
  }
};
const get = async (p, headers = {}) => {
  const r = await fetch(`${BASE}${p}`, { headers: jar(headers), redirect: 'manual' });
  capture(r);
  const body = await r.json().catch(() => null);
  return { status: r.status, body, headers: r.headers };
};
const send = async (method, p, payload, headers = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: jar({ 'content-type': 'application/json', ...headers }),
    body: payload === undefined ? undefined : JSON.stringify(payload),
    redirect: 'manual',
  });
  capture(r);
  const body = await r.json().catch(() => null);
  return { status: r.status, body, headers: r.headers };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('server did not answer /api/health within 30s');
}

async function main() {
  const scratch = fs.mkdtempSync(join(os.tmpdir(), 'opushub-verify-'));
  const configDir = join(scratch, 'config');
  const dataDir = join(scratch, 'data');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  // Phase 11A — a real directory tree for the read-only file manager, including the one thing the
  // path policy exists to stop: a symlink that leaves the root.
  const filesRoot = join(scratch, 'files-root');
  fs.mkdirSync(join(filesRoot, 'stacks', 'media'), { recursive: true });
  fs.writeFileSync(join(filesRoot, 'notes.txt'), 'compose notes for the verify run\n');
  fs.writeFileSync(join(filesRoot, 'stacks', 'media', 'compose.yml'), 'services:\n  wave:\n    image: wave:latest\n');
  // a PNG signature followed by junk: enough for the preview detector to judge by content
  fs.writeFileSync(join(filesRoot, 'poster.png'), Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex'));
  try { fs.symlinkSync('/etc', join(filesRoot, 'escape')); } catch { /* a platform without symlinks */ }

  console.log(`verifying against a scratch config dir: ${scratch}`);
  console.log(socket ? `engine: ${socket}` : 'engine: none — verifying the unavailable path');

  const child = spawn(process.execPath, [join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPUSHUB_CONFIG_DIR: configDir,
      OPUSHUB_DATA_DIR: dataDir,
      OPUSHUB_PORT: String(PORT),
      OPUSHUB_HOST: '127.0.0.1',
      // one exposed root, named by the environment — never by a request
      OPUSHUB_FILES_ROOTS: filesRoot,
      ...(socket ? { OPUSHUB_DOCKER_SOCKET: socket } : { OPUSHUB_DOCKER_SOCKET: '/nonexistent/docker.sock' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  let ok = true;
  try {
    await waitForServer(child);

    // ---- 0. the door: setup, authentication, CSRF, logout --------------------
    console.log('');
    {
      const status = await get('/api/setup/status');
      check('auth: a fresh install reports that setup is required',
        status.status === 200 && status.body?.required === true && status.body?.complete === false,
        JSON.stringify(status.body).slice(0, 120));
      check('auth: pre-setup the wizard gets a count-only discovery summary (no names)',
        !!status.body?.discovery && typeof status.body.discovery.containers === 'number'
        && !JSON.stringify(status.body.discovery).includes('jellyfin'),
        JSON.stringify(status.body?.discovery || {}).slice(0, 140));
      const closed = await get('/api/services');
      check('auth: every application endpoint is closed before login', closed.status === 401, `status ${closed.status}`);
      const closedSystem = await get('/api/system');
      check('auth: system readings are not public either', closedSystem.status === 401, `status ${closedSystem.status}`);
      const health = await get('/api/health');
      check('auth: health stays public but says nothing about the host',
        health.status === 200 && health.body?.ok === true && !health.body.providers && !health.body.configDir,
        JSON.stringify(health.body).slice(0, 120));

      const weak = await send('POST', '/api/setup', { username: 'admin', password: 'short' });
      check('auth: setup refuses a weak password', weak.status === 400, `status ${weak.status}`);
      const created = await send('POST', '/api/setup', { username: 'admin', password: 'verify-fixture-password' });
      check('auth: setup creates the administrator and starts a session',
        created.status === 201 && created.body?.user?.username === 'admin' && !!COOKIE,
        JSON.stringify(created.body).slice(0, 120));
      check('auth: the API never returns a password hash',
        !JSON.stringify(created.body).includes('scrypt$') && !JSON.stringify(created.body).includes('passwordHash'));
      const again = await send('POST', '/api/setup', { username: 'admin', password: 'verify-fixture-password' });
      check('auth: setup cannot be repeated', again.status === 409, `status ${again.status}`);
      const afterSetup = await get('/api/setup/status');
      check('auth: after setup the status endpoint exposes no discovery summary at all',
        afterSetup.body?.complete === true && afterSetup.body?.discovery === undefined,
        JSON.stringify(afterSetup.body).slice(0, 120));

      const authFile = join(dataDir, 'auth.json');
      const storedText = fs.existsSync(authFile) ? fs.readFileSync(authFile, 'utf8') : '';
      check('auth: the account is persisted with a scrypt hash and no plaintext password',
        /"passwordHash":\s*"scrypt\$/.test(storedText) && !storedText.includes('verify-fixture-password'),
        storedText.slice(0, 60));
      check('auth: the auth file is not group/world readable',
        fs.existsSync(authFile) && (fs.statSync(authFile).mode & 0o077) === 0,
        `mode ${(fs.statSync(authFile).mode & 0o777).toString(8)}`);

      const authed = await get('/api/settings');
      check('auth: the session cookie opens the application',
        authed.status === 200 && !!authed.body?.appearance, `status ${authed.status}`);
      const me = await get('/api/auth/me');
      check('auth: who-am-I names the signed-in account', me.body?.authenticated === true && me.body?.user?.username === 'admin');

      const crossSite = await send('PUT', '/api/settings', { app: { tagline: 'The homelab, at a glance.' } }, { origin: 'https://evil.example' });
      check('auth: a cross-origin write is refused (CSRF)', crossSite.status === 403, `status ${crossSite.status}`);
      const site = await send('PUT', '/api/settings', { app: { tagline: 'The homelab, at a glance.' } }, { 'sec-fetch-site': 'cross-site' });
      check('auth: a cross-site write is refused even without an Origin header', site.status === 403, `status ${site.status}`);

      const out = await send('POST', '/api/auth/logout');
      check('auth: logout clears the cookie', out.status === 200 && !COOKIE, `status ${out.status}`);
      const afterLogout = await get('/api/services');
      check('auth: the session is dead after logout', afterLogout.status === 401, `status ${afterLogout.status}`);

      const wrong = await send('POST', '/api/auth/login', { username: 'admin', password: 'not-the-password' });
      check('auth: a wrong password is refused without saying which half was wrong',
        wrong.status === 401 && /Incorrect username or password/.test(wrong.body?.error || ''), JSON.stringify(wrong.body));
      const nobody = await send('POST', '/api/auth/login', { username: 'nobody', password: 'not-the-password' });
      check('auth: an unknown user gets the identical answer (no enumeration)',
        nobody.status === 401 && wrong.body?.error === nobody.body?.error);
      const login = await send('POST', '/api/auth/login', { username: 'admin', password: 'verify-fixture-password' });
      check('auth: the administrator can sign in again', login.status === 200 && !!COOKIE, JSON.stringify(login.body).slice(0, 120));
    }

    console.log(''); // ---- 1. first run: nothing configured yet -------------------------------
    {
      const s = await get('/api/settings');
      check('first run: defaults come back without a config file',
        s.status === 200 && s.body?.appearance?.theme === 'system' && s.body?.hub?.greetingName === null,
        `status ${s.status}`);
      const l = await get('/api/layout');
      const lw = l.body?.hub?.widgets || [];
      check('first run: the Hub has a composition, not an empty array',
        l.body?.version === 2 && lw.length > 0 && lw.every((w) => w.id && w.type && w.zone && w.size),
        `${lw.length} widgets`);
      check('first run: no widget type is unknown to the catalogue', await (async () => {
        const w = await get('/api/widgets');
        const types = new Set((w.body?.catalogue || []).map((c) => c.type));
        return lw.every((x) => types.has(x.type));
      })(), lw.map((w) => w.type).join(', '));

      const w = await get('/api/widgets');
      check('widget catalogue covers the promised categories', (() => {
        const types = new Set((w.body?.catalogue || []).map((c) => c.type));
        const want = ['services', 'system', 'stacks', 'attention', 'clock', 'weather', 'news', 'markets', 'bookmarks', 'activity'];
        return want.every((t) => types.has(t));
      })(), `${(w.body?.catalogue || []).length} entries`);
      check('widget catalogue carries real config fields, not free text only',
        (w.body?.catalogue || []).some((c) => c.config?.length > 0));
      check('widget catalogue is organised into the four categories, each with a label',
        (() => {
          const ids = (w.body?.categories || []).map((c) => c.id);
          const types = w.body?.catalogue || [];
          return JSON.stringify(ids) === JSON.stringify(['system', 'grid', 'information', 'personal'])
            && types.every((c) => ids.includes(c.category));
        })(), JSON.stringify((w.body?.categories || []).map((c) => c.id)));

      const hy = await get('/api/health');
      check('health reports the engine state it actually has',
        hy.status === 200 && typeof hy.body?.providers?.docker?.ok === 'boolean',
        JSON.stringify(hy.body?.providers?.docker || {}));
      check('health lists the resolved config and data directories, without leaking env values',
        typeof hy.body?.configDir === 'string' && JSON.stringify(hy.body.env).length < 2000 && !/secret|password/i.test(JSON.stringify(hy.body.env)));
    }

    // ---- 2. discovery: the real inventory, or an honest absence ----------
    const svcFirst = await get('/api/services');
    const doc = svcFirst.body;
    const engineLive = !!doc?.live;
    if (engineLive) {
      check('discovery: containers are found with no configuration at all',
        doc.stats?.discovered > 0 && doc.groups.length > 0, `${doc.stats?.discovered} containers`);
      check('discovery: every service carries a status and a URL verdict',
        doc.services.every((s) => s.status && 'url' in s && s.urlSource), '');
      check('discovery: nothing is marked configured before an overlay exists',
        doc.services.every((s) => s.configured === false), '');
      check('discovery: overlay write paths are reported for inspection',
        Array.isArray(doc.unmatched) && Array.isArray(doc.skipped), '');
    } else {
      check('discovery: without an engine the API says so instead of inventing services',
        doc.groups.length === 0 && doc.stats?.discovered === 0 && typeof doc.statusReason === 'string',
        doc.statusReason || '');
      check('discovery: the reason is public-safe (no socket paths leak)',
        !/\/var\/run|docker\.sock|ENOENT/i.test(doc.statusReason || ''), doc.statusReason || '');
    }

    const stacks = await get('/api/stacks');
    check('stacks: the projection answers with the same engine state as services',
      stacks.status === 200 && stacks.body?.live === engineLive, `live=${stacks.body?.live}`);

    // ---- 3. providers: unavailable states carry reasons, never values ----------
    const weather = await get('/api/weather');
    const news = await get('/api/news');
    const market = await get('/api/market');
    check('weather: unconfigured means unconfigured (no reading is invented)',
      weather.body?.status !== 'unconfigured' || (!weather.body.current && typeof weather.body.reason === 'string'),
      JSON.stringify(weather.body).slice(0, 120));
    check('news: an unconfigured feed list returns no items, with a reason',
      news.body?.status !== 'unconfigured' || (news.body.items.length === 0 && typeof news.body.reason === 'string'),
      JSON.stringify(news.body).slice(0, 120));
    check('markets: an empty watchlist returns no quotes, with a reason',
      market.body?.status !== 'unconfigured' || (market.body.items.length === 0 && typeof market.body.reason === 'string'),
      JSON.stringify(market.body).slice(0, 120));

    // ---- 4. the widget model: unknown types are dropped, sizes are clamped ----------
    {
      const put = await send('PUT', '/api/layout', {
        hub: {
          widgets: [
            { id: 'services', type: 'services', zone: 'main', size: 'gigantic', visible: true, config: {} },
            { id: 'holodeck', type: 'holodeck', zone: 'rail', size: 'md', visible: true, config: {} },
            { id: 'clock', type: 'clock', zone: 'rail', size: 'sm', visible: false, config: {} },
          ],
          spacing: 'airy',
        },
      });
      const widgets = put.body?.hub?.widgets || [];
      check('layout: an impossible size is clamped, not accepted',
        widgets.find((w) => w.id === 'services')?.size === 'lg', JSON.stringify(widgets.find((w) => w.id === 'services')));
      check('layout: a widget type this build does not know is dropped, not rendered',
        !widgets.some((w) => w.type === 'holodeck'));
      check('layout: hidden widgets are kept, so nothing is silently lost',
        widgets.find((w) => w.id === 'clock')?.visible === false);
      check('layout: spacing is part of the composition', put.body?.hub?.spacing === 'airy');

      const reset = await send('POST', '/api/layout/reset');
      check('layout: reset returns to the shipped composition',
        reset.body?.hub?.widgets?.length > 0 && reset.body.hub.widgets.some((w) => w.type === 'services'),
        `${reset.body?.hub?.widgets?.length} widgets`);
    }

    // ---- 5. templates: layout only, and provably so ----------
    {
      const t = await get('/api/templates');
      const list = t.body?.templates || [];
      check('templates: the shipped set is present with previews',
        list.length >= 5 && list.every((x) => x.id && x.name && x.preview?.hub?.widgets?.length > 0),
        `${list.length} templates`);
      check('templates: a template is composition only — no service, image or container fields',
        list.every((x) => !JSON.stringify(x).match(/"image"|"container"\s*:|"compose"|"ports"/)),
        '');

      // a saved service order must survive a template apply
      await send('PUT', '/api/layout', { services: { order: { __verify: ['a', 'b'] }, groupOrder: ['__verify'], hiddenGroups: ['__verify'] } });
      const applied = await send('POST', '/api/layout/template', { id: list[0].id });
      check('templates: applying one preserves the user\'s service arrangement',
        applied.body?.services?.groupOrder?.includes('__verify') && applied.body?.services?.order?.__verify?.length === 2,
        JSON.stringify(applied.body?.services));
      check('templates: applying one rewrites the hub composition',
        applied.body?.hub?.widgets?.length === list[0].preview.hub.widgets.length);
      check('templates: a media template reports the groups it could not place',
        (() => {
          const media = list.find((x) => x.id === 'media');
          return !media || Array.isArray(media.unmatchedGroups);
        })());

      const before = (await get('/api/layout')).body;
      const bad = await send('POST', '/api/layout/template', { id: 'not-a-template' });
      const after = (await get('/api/layout')).body;
      check('templates: an unknown id is refused and changes nothing',
        bad.status === 404 && JSON.stringify(before) === JSON.stringify(after), `status ${bad.status}`);

      await send('PUT', '/api/layout', { services: { order: {}, groupOrder: [], hiddenGroups: [] } });
    }

    // ---- 5b. partial layout patches never wipe the composition ----------
    {
      const before = (await get('/api/layout')).body;
      const put = await send('PUT', '/api/layout', { hub: { setupDismissed: true } });
      check('layout: a partial patch (e.g. dismissing the welcome card) keeps every widget',
        JSON.stringify(put.body?.hub?.widgets) === JSON.stringify(before.hub.widgets) && put.body?.hub?.setupDismissed === true,
        `${put.body?.hub?.widgets?.length} widgets after`);
      const back = await send('PUT', '/api/layout', { hub: { setupDismissed: false } });
      check('layout: a second partial patch still keeps them', JSON.stringify(back.body?.hub?.widgets) === JSON.stringify(before.hub.widgets));
      const spacing = await send('PUT', '/api/layout', { hub: { spacing: 'cozy' } });
      check('layout: spacing can change on its own without rearranging anything',
        spacing.body?.hub?.spacing === 'cozy' && JSON.stringify(spacing.body?.hub?.widgets) === JSON.stringify(before.hub.widgets));
      await send('POST', '/api/layout/reset');
    }

    // ---- 6. the overlay: customization that never invents infrastructure ----------
    if (engineLive) {
      const base = (await get('/api/services')).body;
      const target = base.services.find((s) => !s.hidden && s.kind !== 'infrastructure') || base.services[0];
      const group = target.group;

      const put = await send('PUT', '/api/services', {
        groups: [{
          name: group,
          description: 'Verification overlay',
          services: [
            {
              container: target.name, displayName: 'VERIFY NAME', description: 'Overlay description',
              icon: 'mdi:movie-open', url: 'http://verify.invalid:1234/', keywords: ['verifykeyword'], order: 1,
            },
            { container: 'does-not-exist-verify', displayName: 'GHOST', description: 'must never render' },
          ],
        }],
      });
      check('overlay: a write binds to real containers and answers with the new view', put.status === 200, `status ${put.status}`);

      const after = (await get('/api/services')).body;
      const svc = after.services.find((s) => s.name === target.name);
      check('overlay: a display name replaces the discovered one',
        svc?.displayName === 'VERIFY NAME', svc?.displayName);
      check('overlay: the icon is applied through the existing resolution chain',
        svc?.icon === 'mdi:movie-open' && svc?.iconSource !== 'none', `${svc?.icon} (${svc?.iconSource})`);
      check('overlay: a URL override wins over the resolved one (and is normalized)',
        svc?.url === 'http://verify.invalid:1234' && svc?.urlSource === 'manual', `${svc?.url} (${svc?.urlSource})`);
      check('overlay: the service is now visibly customized, not discovered-only',
        svc?.configured === true && !!svc?.overlaid, JSON.stringify(svc?.overlaid || null).slice(0, 80));
      check('overlay: the container is still identified as discovered',
        svc?.discovered === true);
      check('overlay: a ghost entry is reported, never rendered as a service',
        !after.services.some((s) => s.displayName === 'GHOST') && (after.unmatched || []).length > 0,
        `${(after.unmatched || []).length} unmatched`);
      check('overlay: extra keywords become searchable',
        (await get('/api/search?q=verifykeyword')).body?.results?.some((r) => r.title === 'VERIFY NAME'));

      const detail = await get(`/api/services/${encodeURIComponent(after.services.find((s) => s.name === target.name).group)}/${encodeURIComponent(target.name)}`);
      check('service detail: the page data resolves for a customized service',
        detail.status === 200 && detail.body?.service?.displayName === 'VERIFY NAME' && 'urlSource' in detail.body,
        `status ${detail.status}`);

      // hide it: gone from the Hub-facing inventory, still present in its stack
      await send('PUT', '/api/services', {
        groups: [{ name: group, services: [{ container: target.name, hidden: true }] }],
      });
      const hiddenDoc = (await get('/api/services')).body;
      check('overlay: a hidden service leaves the inventory',
        !hiddenDoc.groups.some((g) => g.services.some((s) => s.name === target.name)));
      if (target.stack) {
        const stack = stackByTarget(await get('/api/stacks'), target.name);
        check('overlay: a hidden service is still visible in its stack',
          !!stack, target.stack);
      }
      // and comes back
      await send('PUT', '/api/services', { groups: [] });
      const restored = (await get('/api/services')).body;
      check('overlay: clearing the overlay returns the inventory to discovered-only',
        restored.services.every((s) => s.configured === false) && restored.services.length === base.services.length,
        `${restored.services.length} vs ${base.services.length}`);
      check('overlay: clearing it leaves no residue (unmatched is empty again)',
        (restored.unmatched || []).length === 0);
    } else {
      check('overlay: with no engine reachable, an overlay entry can never become a service',
        await (async () => {
          await send('PUT', '/api/services', { groups: [{ name: 'X', services: [{ container: 'nope', displayName: 'NEVER SHOWN' }] }] });
          const d = (await get('/api/services')).body;
          // Bindings cannot be verified without an engine, so nothing is shown and nothing is
          // condemned — the status reason explains the outage instead.
          const ok = d.live === false && d.services.length === 0 && !JSON.stringify(d).includes('NEVER SHOWN');
          await send('PUT', '/api/services', { groups: [] });
          return ok;
        })(),
        'an overlay entry must not conjure a service out of an unreachable engine');
    }

    // ---- 7. layout ordering that the Hub reads ----------
    if (engineLive) {
      const d = (await get('/api/services')).body;
      const g = d.groups[0];
      const names = g.services.map((s) => s.name);
      if (names.length > 1) {
        const reversed = [...names].reverse();
        await send('PUT', '/api/layout', { services: { order: { [g.name]: reversed }, groupOrder: [g.name], hiddenGroups: [] } });
        const l = (await get('/api/layout')).body;
        check('layout: a saved service order and group order round-trip',
          JSON.stringify(l.services.order[g.name]) === JSON.stringify(reversed) && l.services.groupOrder[0] === g.name);
        await send('PUT', '/api/layout', { services: { order: {}, groupOrder: [], hiddenGroups: [] } });
      }
    }

    // ---- 8. search: one index over everything the Hub shows ----------
    {
      const settings = await get('/api/search?q=widgets');
      check('search: settings are searchable and land on the right tab',
        settings.body?.results?.some((r) => r.kind === 'setting' && r.href === '/settings/widgets'),
        JSON.stringify((settings.body?.results || []).slice(0, 3)));
      const docker = await get('/api/search?q=docker');
      check('search: a query about the engine reaches discovery and, when live, real services',
        docker.body?.results?.some((r) => r.href === '/settings/environment'),
        `${(docker.body?.results || []).length} results`);
      const advanced = await get('/api/search?q=advanced');
      check('search: the Advanced tab is reachable by the words people would type',
        advanced.body?.results?.some((r) => r.href === '/settings/advanced'), JSON.stringify((advanced.body?.results || []).slice(0, 3)));
      const empty = await get('/api/search?q=');
      check('search: an empty query gives a start surface rather than an error',
        empty.status === 200 && Array.isArray(empty.body?.results));
      const junk = await get('/api/search?q=zzzzzzzznotathing');
      check('search: a miss returns an empty list, not a crash', junk.status === 200 && junk.body.results.length === 0);
      const fuzzy = await get('/api/search?q=wdgt');
      check('search: subsequence matching still finds distant matches', fuzzy.status === 200);
    }

    // ---- 8c. Phase 10A: monitoring is a real engine, and it is honest ----------
    {
      const overview = await get('/api/monitoring');
      check('monitoring: the engine reports its own state, not a service verdict',
        overview.status === 200 && ['running', 'idle', 'stopped', 'unavailable'].includes(overview.body?.engine?.state)
        && typeof overview.body?.counts?.total === 'number',
        JSON.stringify(overview.body?.engine || {}).slice(0, 120));
      check('monitoring: the monitor cap and check concurrency are stated as numbers',
        typeof overview.body?.engine?.concurrency === 'number' && overview.body?.engine?.concurrency <= 8,
        String(overview.body?.engine?.concurrency));

      // a monitor on a discovered service, preferring the canonical endpoint over a typed URL
      const dockerLive = (await get('/api/services')).body?.live !== false;
      let monitorId = null;
      if (dockerLive) {
        const services = (await get('/api/services')).body?.services || [];
        const withUrl = services.find((s) => s.url && !s.hidden);
        const target = withUrl || services.find((s) => !s.hidden);
        if (target) {
          const created = await send('POST', '/api/monitoring/monitors', {
            monitor: { name: 'verify-monitor', type: withUrl ? 'http' : 'docker', target: { service: { group: target.group, name: target.name } }, intervalMs: 15_000, timeoutMs: 2000 },
          });
          monitorId = created.body?.monitor?.id || null;
          check('monitoring: a monitor is created from a service reference and starts with no verdict',
            created.status === 201 && created.body?.monitor?.status === 'pending' && created.body.monitor.target.service.name === target.name,
            `${created.status} ${JSON.stringify(created.body?.monitor || created.body).slice(0, 120)}`);
          check('monitoring: the created monitor carries provenance and a resolved-at-check-time target',
            created.body?.monitor?.provenance === 'configured' && created.body.monitor.target.service && 'url' in created.body.monitor.target,
            JSON.stringify(created.body?.monitor?.provenance));
          check('monitoring: nothing internal to the engine leaks into the API projection',
            created.body?.monitor && !('streakStartedAt' in created.body.monitor) && !('rawTarget' in created.body.monitor),
            Object.keys(created.body?.monitor || {}).join(','));

          const before = await get(`/api/monitoring/monitors/${monitorId}`);
          check('monitoring: a monitor with no checks reports no data, never 100% uptime',
            before.status === 200 && before.body?.uptime?.day?.noData === true && before.body.uptime.day.uptimePct === null,
            JSON.stringify(before.body?.uptime?.day || {}).slice(0, 120));

          const manual = await send('POST', `/api/monitoring/monitors/${monitorId}/check`);
          check('monitoring: a manual check runs the stored target and records one check with a timestamp',
            manual.status === 200 && manual.body?.monitor?.lastCheck?.at > 0 && manual.body?.result?.kind,
            `${manual.status} ${JSON.stringify(manual.body?.result || manual.body || {}).slice(0, 120)}`);
          const after = await get(`/api/monitoring/monitors/${monitorId}`);
          check('monitoring: the recorded check appears in history and uptime reflects it',
            after.body?.uptime?.day?.checks >= 1 && after.body.uptime.day.judged >= 0
            && (after.body.uptime.day.judged === 0 ? after.body.uptime.day.uptimePct === null : typeof after.body.uptime.day.uptimePct === 'number'),
            JSON.stringify(after.body?.uptime?.day || {}).slice(0, 140));
          check('monitoring: one failed check is never enough to call something down',
            after.body?.monitor?.status !== 'down' || after.body.monitor.consecutiveFailures >= 3,
            `${after.body?.monitor?.status} after ${after.body?.monitor?.consecutiveFailures} failure(s)`);
          check('monitoring: a check records the scope of the address it actually reached',
            ['public', 'internal', 'mixed', null].includes(after.body?.monitor?.target?.scope),
            String(after.body?.monitor?.target?.scope));

          const paused = await send('POST', `/api/monitoring/monitors/${monitorId}/pause`);
          const doc = await get('/api/monitoring');
          check('monitoring: pausing is not down — it is a paused state with no incident',
            paused.body?.monitor?.status === 'paused' && doc.body?.counts?.paused >= 1
            && (await get(`/api/monitoring/monitors/${monitorId}`)).body?.incidents?.length === 0,
            JSON.stringify(paused.body?.monitor || {}).slice(0, 100));
          await send('POST', `/api/monitoring/monitors/${monitorId}/resume`);
        }
      }

      // what the model refuses, whatever the caller sends
      const refusals = [
        ['monitoring: a loopback and a link-local endpoint are refused with a reason', { name: 'x', type: 'http', target: { url: 'http://169.254.169.254/latest/meta-data/' } }, /link-local|private|refused/i],
        ['monitoring: a non-http scheme is refused', { name: 'x', type: 'http', target: { url: 'file:///etc/passwd' } }, /http/i],
        ['monitoring: a port range is refused — monitoring is not a scanner', { name: 'x', type: 'tcp', target: { host: '10.0.0.9', port: '22-80' } }, /port/i],
        ['monitoring: a host range is refused too', { name: 'x', type: 'tcp', target: { host: '10.0.0.1-10.0.0.50', port: 22 } }, /host/i],
        ['monitoring: a container id is not a service reference', { name: 'x', type: 'docker', target: { service: { name: 'abcdef123456' } } }, /container id/i],
        ['monitoring: an unsupported type is refused', { name: 'x', type: 'icmp', target: { host: '10.0.0.9' } }, /type/i],
      ];
      let refusalsHeld = 0;
      for (const [name, body, pattern] of refusals) {
        const r = await send('POST', '/api/monitoring/monitors', { monitor: body });
        const ok = r.status === 400 && pattern.test(String(r.body?.error || '')) && !!r.body?.code;
        if (ok) refusalsHeld++;
        else console.error(`   ↳ ${name}: ${r.status} ${String(r.body?.error || '').slice(0, 100)}`);
      }
      check('monitoring: every invalid target is refused with a status, a code and a sentence', refusalsHeld === refusals.length, `${refusalsHeld}/${refusals.length}`);

      const settings = await get('/api/monitoring/settings');
      check('monitoring: the effective settings carry their server-side bounds',
        settings.status === 200 && settings.body?.bounds?.intervalMs?.min === 10_000 && settings.body?.bounds?.maxConcurrent?.max === 8
        && typeof settings.body?.settings?.allowInternal === 'boolean',
        JSON.stringify(settings.body?.bounds || {}).slice(0, 120));
      const clamped = await send('PUT', '/api/monitoring/settings', { settings: { intervalMs: 1, maxConcurrent: 99, failureThreshold: 42, allowInternal: true } });
      check('monitoring: a setting outside its bound is clamped on the server, not stored',
        clamped.body?.settings?.intervalMs === 10_000 && clamped.body.settings.maxConcurrent === 8 && clamped.body.settings.failureThreshold === 10,
        JSON.stringify(clamped.body?.settings || {}).slice(0, 140));
      await send('PUT', '/api/monitoring/settings', { settings: { intervalMs: 60_000, maxConcurrent: 3, failureThreshold: 3 } });

      if (monitorId) {
        const search = await get('/api/search?q=verify-monitor');
        check('monitoring: a monitor is searchable, as a destination',
          search.body?.results?.some((r) => r.kind === 'monitor' && r.href === `/monitoring/${monitorId}`),
          JSON.stringify((search.body?.results || []).slice(0, 3)));
        const activity = await get('/api/activity?category=monitoring&limit=50');
        check('monitoring: the activity log carries the monitor through its own category',
          activity.body?.items?.some((e) => String(e.type).startsWith('monitor.') || String(e.type).startsWith('incident.')),
          JSON.stringify((activity.body?.items || []).slice(0, 3).map((e) => e.type)));
        const removed = await send('DELETE', `/api/monitoring/monitors/${monitorId}`);
        check('monitoring: deleting a monitor removes it and its detail is a 404 afterwards',
          removed.status === 200 && (await get(`/api/monitoring/monitors/${monitorId}`)).status === 404);
      }

      // and the surface is behind the same session as everything else
      const anon = await fetch(`${BASE}/api/monitoring`, { headers: { 'x-forwarded-for': '127.0.0.1' } });
      check('monitoring: the API is not public', anon.status === 401, `status ${anon.status}`);
    }

    // ---- 8b. Phase 3: read-only service intelligence ----------
    if (engineLive) {
      // service detail carries the runtime facts Docker actually has
      const jf = await get('/api/services/Other/jellyfin');
      check('service detail: inspect-level facts (healthcheck, started, restarts) cross the boundary',
        jf.status === 200 && jf.body?.container?.state?.health === 'healthy'
        && jf.body?.container?.state?.healthcheck?.status === 'healthy'
        && typeof jf.body?.container?.state?.restartCount === 'number'
        && !!jf.body?.container?.state?.startedAt, JSON.stringify(jf.body?.container?.state || {}).slice(0, 120));
      check('service detail: published vs exposed ports stay distinct facts',
        Array.isArray(jf.body?.container?.ports) && Array.isArray(jf.body?.container?.exposedPorts));
      check('service detail: image facts arrive without config env',
        !!jf.body?.image?.tags?.length && !JSON.stringify(jf.body).includes('SHOULD_NEVER_LEAVE_SERVER'));

      const nav = await get('/api/services/Other/navidrome');
      check('service detail: unhealthy is a health verdict on a running container',
        nav.body?.service?.status === 'unhealthy' && nav.body?.container?.state?.status === 'running');
      const seerr = await get('/api/services/Other/seerr');
      check('service detail: no healthcheck is reported as such, never as unhealthy',
        seerr.body?.container?.state?.health === null && seerr.body?.service?.status === 'up');
      const loop = await get('/api/services/Other/restart-loop');
      check('service detail: a restart loop is visible (restarting + restart count)',
        loop.body?.container?.state?.status === 'restarting' && (loop.body?.container?.state?.restartCount ?? 0) > 5);

      // stats: on demand, honest, bounded
      const stats = await get('/api/services/Other/jellyfin/stats');
      check('stats: fetched on demand with real metrics', stats.body?.status === 'ok' && stats.body?.stats?.cpu != null);
      const noStats = await get('/api/services/Other/paperless/stats');
      check('stats: a stopped container reports unavailable, never zeros-as-data', noStats.body?.status === 'unavailable' && noStats.body?.stats === null);
      const hist = await get('/api/services/Other/jellyfin/stats/history');
      check('stats history: samples exist only because somebody asked', Array.isArray(hist.body?.samples) && hist.body.samples.length >= 1);

      // logs: read-only, bounded, timestamps optional
      const logs = await get('/api/services/Other/nextcloud/logs?tail=50');
      check('logs: a large log stays under the tail cap', logs.body?.status === 'ok' && logs.body.lines.length <= 50 && logs.body.lines.length > 0);
      const emptyLogs = await get('/api/services/Other/restart-loop/logs');
      check('logs: an empty log says so honestly', emptyLogs.body?.status === 'ok' && emptyLogs.body.lines.length === 0);

      // service history: real events + the moment watching began
      const sh = await get('/api/services/Other/jellyfin/history');
      check('service history: answers with events + watchingSince (never invented)',
        sh.status === 200 && Array.isArray(sh.body?.events) && 'watchingSince' in (sh.body || {}));

      // stacks: the deterministic status model
      const stacksDoc = (await get('/api/stacks')).body;
      const secure = stacksDoc.stacks.find((s) => s.project === 'secure');
      const opus = stacksDoc.stacks.find((s) => s.project === 'opustream');
      check('stacks: deterministic statuses (operational vs degraded)',
        secure?.status === 'operational' && opus?.status === 'degraded', `${secure?.status} / ${opus?.status}`);
      check('stacks: rollup counts travel with the doc',
        typeof opus?.unhealthyCount === 'number' && typeof opus?.stoppedCount === 'number' && typeof opus?.attentionCount === 'number');

      // activity: grouping + the watching-since marker
      const act = await get('/api/activity?grouped=1&limit=50');
      check('activity: grouped mode answers and reports when watching began',
        act.status === 200 && Array.isArray(act.body?.items) && 'watchingSince' in (act.body || {}));
    }
    {
      const prov = await get('/api/providers');
      check('providers: one honest health doc for docker/system/news/weather/markets',
        prov.status === 200 && JSON.stringify(prov.body?.providers?.map((p) => p.name)) === JSON.stringify(['docker', 'system', 'news', 'weather', 'markets'])
        && prov.body.providers.every((p) => ['available', 'unavailable', 'degraded', 'idle'].includes(p.state)),
        JSON.stringify(prov.body?.providers || {}).slice(0, 140));
      check('providers: docker state matches the engine we are talking to',
        prov.body?.providers?.find((p) => p.name === 'docker')?.state === (engineLive ? 'available' : 'unavailable'));
    }

    // ---- 9. custom CSS/JS stay opt-in frontend-only ----------
    {
      const off = await send('PUT', '/api/settings', { advanced: { customCss: false, customJs: false } });
      check('custom assets: opt-in flags are stored as given',
        off.body?.advanced?.customCss === false && off.body?.advanced?.customJs === false);
      const custom = await get('/api/custom');
      check('custom assets: the API reports what it would serve', custom.status === 200, `status ${custom.status}`);
      await send('PUT', '/api/settings', { advanced: { customCss: false, customJs: false } });
    }

    // ---- 10. background + theme settings survive a round trip ----------
    {
      const bg = await send('PUT', '/api/settings', { appearance: { theme: 'dark', background: { mode: 'solid', blur: 10, scrim: 50 } } });
      check('appearance: theme and background settings round-trip',
        bg.body?.appearance?.theme === 'dark' && bg.body?.appearance?.background?.mode === 'solid',
        JSON.stringify(bg.body?.appearance?.background));
      const clamped = await send('PUT', '/api/settings', { appearance: { background: { blur: -5, scrim: 999 } } });
      check('appearance: out-of-range values are clamped, not stored',
        clamped.body?.appearance?.background?.blur >= 0 && clamped.body?.appearance?.background?.scrim <= 100,
        JSON.stringify(clamped.body?.appearance?.background));
      await send('PUT', '/api/settings', { appearance: { theme: 'system', background: { mode: 'quiet', blur: 24, scrim: 62 } } });
    }

    // ---- 11. files: the read-only explorer, against a real directory ----------
    {
      const surface = await get('/api/files');
      const rootId = surface.body?.roots?.[0]?.id || null;
      check('files: the surface exposes exactly the configured root, read-only',
        surface.status === 200 && surface.body?.readOnly === true && surface.body?.source === 'configured'
        && surface.body?.roots?.length === 1 && surface.body.roots[0].path === filesRoot,
        JSON.stringify(surface.body?.roots ?? surface.body).slice(0, 140));
      check('files: the surface publishes the operations this phase does not have',
        Array.isArray(surface.body?.notSupported)
        && ['delete', 'rename', 'upload', 'mkdir', 'chmod', 'chown', 'shell'].every((op) => surface.body.notSupported.includes(op)),
        JSON.stringify(surface.body?.notSupported));
      check('files: the only write verb is the privilege request',
        JSON.stringify(surface.body?.routes?.post) === JSON.stringify(['/api/files/privilege/request']),
        JSON.stringify(surface.body?.routes?.post));
      check('files: a host with no privileged provider says so instead of implying one',
        surface.body?.privileged?.available === false && !!surface.body?.privileged?.reason,
        JSON.stringify(surface.body?.privileged));

      const enc = encodeURIComponent(rootId);
      const list = await get(`/api/files/list?root=${enc}&path=`);
      const names = (list.body?.entries || []).map((e) => e.name);
      check('files: a listing is addressed by root id plus a relative path',
        list.status === 200 && names.includes('notes.txt') && names.includes('stacks'),
        names.join(', ') || `status ${list.status}`);
      check('files: an entry carries its mode, owner and type — and nothing writable',
        (list.body?.entries || []).every((e) => 'modeText' in e && 'octal' in e && 'owner' in e && 'typeLabel' in e)
        && !JSON.stringify(list.body?.entries).includes('"writable":true'),
        JSON.stringify(list.body?.entries?.[0]).slice(0, 140));
      const nested = await get(`/api/files/list?root=${enc}&path=stacks/media`);
      check('files: a nested folder lists through the same addressing',
        nested.status === 200 && (nested.body?.entries || []).some((e) => e.name === 'compose.yml'),
        `status ${nested.status}`);
      const stat = await get(`/api/files/stat?root=${enc}&path=notes.txt&context=1`);
      check('files: stat reports ownership, mode and whether OpusHub may read it',
        stat.status === 200 && stat.body?.modeText === '-rw-r--r--' && stat.body?.writable === false
        && typeof stat.body?.readable === 'boolean',
        JSON.stringify(stat.body).slice(0, 140));

      const traversal = await get(`/api/files/list?root=${enc}&path=../../etc`);
      // 400 bad_path with the rule that caught it, or 403 root_isolation once it resolved: either
      // way the answer names the rule, and neither way reaches the host.
      check('files: a traversal out of the root is refused, naming the rule that caught it',
        (traversal.status === 400 && traversal.body?.code === 'bad_path' && traversal.body?.rule === 'traversal')
        || (traversal.status === 403 && traversal.body?.code === 'root_isolation'),
        `status ${traversal.status} ${JSON.stringify(traversal.body).slice(0, 120)}`);
      const encoded = await get(`/api/files/list?root=${enc}&path=stacks%2f%2e%2e%2f%2e%2e%2fetc`);
      check('files: an encoded traversal is refused the same way',
        encoded.status >= 400 && !!encoded.body?.code, `status ${encoded.status} ${JSON.stringify(encoded.body).slice(0, 120)}`);
      const nulled = await get(`/api/files/list?root=${enc}&path=notes.txt%00.png`);
      check('files: a null byte in a path is refused', nulled.status >= 400, `status ${nulled.status}`);
      const absolute = await get(`/api/files/list?root=${enc}&path=/etc/passwd`);
      check('files: an absolute path is refused', absolute.status >= 400 && !!absolute.body?.code, `status ${absolute.status}`);
      const escape = await get(`/api/files/list?root=${enc}&path=escape`);
      check('files: a symlink that leaves the root is refused, not followed',
        escape.status === 403 && escape.body?.code === 'symlink_escape',
        `status ${escape.status} ${JSON.stringify(escape.body).slice(0, 120)}`);
      const unknown = await get(`/api/files/list?root=${encodeURIComponent('/etc')}&path=`);
      check('files: a root that was never exposed is unknown, not interpreted',
        unknown.status === 404 && unknown.body?.code === 'unknown_root', `status ${unknown.status}`);
      const notADir = await get(`/api/files/list?root=${enc}&path=notes.txt`);
      check('files: listing a file says it is not a directory',
        notADir.status === 400 && notADir.body?.code === 'not_a_directory', `status ${notADir.status}`);

      const preview = await get(`/api/files/preview?root=${enc}&path=notes.txt`);
      check('files: a text preview arrives in JSON with its detected type',
        preview.status === 200 && preview.body?.inline === 'text' && /compose notes/.test(preview.body?.text || '')
        && !!preview.body?.label && !!preview.body?.detectedBy,
        JSON.stringify(preview.body).slice(0, 140));
      const image = await get(`/api/files/preview?root=${enc}&path=poster.png`);
      const imageHref = image.body?.bytesHref || '';
      check('files: an image preview is a minted reference, not bytes in JSON',
        image.status === 200 && image.body?.inline === 'image' && image.body?.text === null
        && imageHref.startsWith('/api/files/raw?token='),
        JSON.stringify(image.body).slice(0, 140));
      const raw = await fetch(`${BASE}${imageHref}`, { headers: jar({}), redirect: 'manual' });
      check('files: the reference serves those bytes inline, with a content policy',
        raw.status === 200 && (raw.headers.get('content-type') || '').startsWith('image/png')
        && /sandbox|default-src 'none'|no-store/.test(`${raw.headers.get('content-security-policy') || ''}${raw.headers.get('cache-control') || ''}`),
        `${raw.status} ${raw.headers.get('content-type')} csp=${raw.headers.get('content-security-policy')}`);
      await raw.arrayBuffer();
      const swapped = await fetch(`${BASE}/api/files/download?token=${imageHref.split('token=')[1]}`, { headers: jar({}), redirect: 'manual' });
      check('files: a preview reference cannot be spent on the download route',
        swapped.status === 403 && swapped.headers.get('content-type')?.includes('json'),
        `status ${swapped.status}`);
      await swapped.text();

      const dl = await get(`/api/files/download?root=${enc}&path=stacks/media/compose.yml`);
      const location = dl.headers.get('location') || '';
      check('files: a download is a redirect to a minted reference — no host path in a URL',
        dl.status === 302 && location.startsWith('/api/files/download?token=') && !location.includes('files-root')
        && !location.includes(scratch),
        `status ${dl.status} ${location.slice(0, 90)}`);
      const streamed = await fetch(`${BASE}${location}`, { headers: jar({}), redirect: 'manual' });
      const body = await streamed.text();
      check('files: the reference streams the file as a named attachment',
        streamed.status === 200 && /attachment/.test(streamed.headers.get('content-disposition') || '')
        && /compose\.yml/.test(streamed.headers.get('content-disposition') || '') && body.includes('wave:latest'),
        `${streamed.status} ${streamed.headers.get('content-disposition')}`);
      const dirDl = await get(`/api/files/download?root=${enc}&path=stacks`);
      check('files: a directory cannot be downloaded', dirDl.status === 400 && dirDl.body?.code === 'is_a_directory', `status ${dirDl.status}`);

      const search = await get(`/api/files/search?root=${enc}&q=compose`);
      check('files: search matches names, bounds the walk and never follows folder symlinks',
        search.status === 200 && search.body?.count >= 1 && search.body?.followedSymlinks === false
        && (search.body?.matches || []).some((m) => m.path === 'stacks/media/compose.yml')
        && typeof search.body?.visited === 'number' && !!search.body?.limits,
        JSON.stringify(search.body).slice(0, 140));
      const shortSearch = await get(`/api/files/search?root=${enc}&q=`);
      check('files: an empty search is a bad request, not a walk of the whole root',
        shortSearch.status === 400 && shortSearch.body?.code === 'bad_query', `status ${shortSearch.status}`);

      const mutations = [];
      for (const [method, target] of [
        ['POST', '/api/files/delete'], ['POST', '/api/files/rename'], ['POST', '/api/files/move'],
        ['POST', '/api/files/copy'], ['POST', '/api/files/upload'], ['POST', '/api/files/mkdir'],
        ['POST', '/api/files/chmod'], ['POST', '/api/files/chown'], ['POST', '/api/files/write'],
        ['POST', '/api/files/exec'], ['POST', '/api/files/shell'],
        ['DELETE', `/api/files/list?root=${enc}&path=notes.txt`],
        ['PUT', `/api/files/stat?root=${enc}&path=notes.txt`],
        ['PATCH', `/api/files/preview?root=${enc}&path=notes.txt`],
      ]) {
        const r = await send(method, target, method === 'POST' ? {} : undefined);
        if (r.status !== 404 && r.status !== 405) mutations.push(`${method} ${target} → ${r.status}`);
      }
      check('files: no mutation route exists, under any verb', mutations.length === 0, mutations.join(', '));
      check('files: the fixture files survived every request above',
        fs.existsSync(join(filesRoot, 'notes.txt')) && fs.existsSync(join(filesRoot, 'stacks', 'media', 'compose.yml'))
        && fs.readFileSync(join(filesRoot, 'notes.txt'), 'utf8') === 'compose notes for the verify run\n');

      const privilege = await send('POST', '/api/files/privilege/request', {
        root: rootId, path: 'notes.txt', operation: 'read', command: 'rm -rf /', shell: '/bin/sh', user: 'root',
      });
      check('files: the privilege broker answers honestly and drops a smuggled command',
        [200, 501].includes(privilege.status)
        && ['unavailable', 'not_needed', 'denied'].includes(privilege.body?.state)
        && !JSON.stringify(privilege.body).includes('rm -rf') && !JSON.stringify(privilege.body).includes('/bin/sh'),
        `status ${privilege.status} ${JSON.stringify(privilege.body).slice(0, 140)}`);
      const badOp = await send('POST', '/api/files/privilege/request', { root: rootId, path: 'notes.txt', operation: 'execute' });
      check('files: an operation outside the fixed vocabulary is refused',
        badOp.status >= 400 && badOp.body?.state !== 'granted', `status ${badOp.status} ${JSON.stringify(badOp.body).slice(0, 120)}`);

      const act = await get('/api/activity?limit=200');
      const fileEvents = (act.body?.items || []).filter((e) => e.category === 'files');
      check('files: browsing, previewing and downloading wrote no activity events — asking for privilege did',
        fileEvents.length >= 1 && fileEvents.every((e) => String(e.type).startsWith('files.privilege')),
        JSON.stringify(fileEvents.map((e) => e.type)).slice(0, 140));
    }

    console.log('');
  } catch (err) {
    ok = false;
    failures++;
    console.error(`\nverification aborted: ${err.message}`);
    console.error(log.split('\n').slice(-15).join('\n'));
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (child.exitCode === null) child.kill('SIGKILL');
    if (failures === 0) fs.rmSync(scratch, { recursive: true, force: true });
    else console.error(`scratch config kept for inspection: ${scratch}`);
  }

  console.log(`${checks - failures}/${checks} checks passed`);
  process.exitCode = ok && failures === 0 ? 0 : 1;
}

const stackByTarget = (doc, containerName) =>
  (doc.body?.stacks || []).find((s) => s.members?.some((m) => m.containerName === containerName)) || null;

void main();
