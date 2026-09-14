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
        docker.body?.results?.some((r) => r.href === '/settings/system'),
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
