// /api — the only door between the browser and the infrastructure. Read-mostly by design;
// mutations write config files (atomically, validated). No shell, no Docker writes, no secrets.
//
// Authentication is enforced here, once, in front of every route: the door is closed unless the
// request either names one of the small set of bootstrap endpoints (setup status / create the
// administrator / login / logout / who-am-I / the container liveness probe) or carries a valid
// session cookie. State-changing requests additionally have to be same-origin (see auth.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, APP_ROOT, readConfigText, writeText } from './configStore.js';
import * as auth from './auth.js';
import * as model from './model.js';
import { collect as collectSystem, History } from './providers/system.js';
import * as docker from './providers/docker.js';
import { getNews } from './providers/news.js';
import { getWeather, cToF } from './providers/weather.js';
import { getMarket } from './providers/market.js';
import { checkBackgroundUrl } from './providers/background.js';
import { iconSvg, search as iconSearch, listLocalFiles } from './providers/icons.js';
import { logEvent, readEvents, firstEventAt } from './activity.js';
import { searchAll } from './search.js';
import { loadEnv } from './env.js';
import { DATA_DIR } from './configStore.js';
import { statsWithHistory, statsHistory } from './statsHistory.js';
import { providerHealthDoc, reportProvider } from './providers/health.js';

/** Best-effort image facts, cached — the detail page asks once per view, never per poll. */
const imageInfoCache = new Map();
async function cachedImageInfo(imageRef) {
  if (!imageRef) return null;
  const hit = imageInfoCache.get(imageRef);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const value = await docker.imageInfo(imageRef).catch(() => null);
  if (imageInfoCache.size > 64) imageInfoCache.delete(imageInfoCache.keys().next().value);
  imageInfoCache.set(imageRef, { at: Date.now(), value });
  return value;
}

/** A container reference must be one of ours: a discovered service's container name or id.
 *  The server builds every Docker request itself — the browser never supplies a Docker path. */
function resolveServiceContainer(inv, group, name) {
  const service = model.findService(inv, group, name);
  if (!service) return null;
  const ref = service.id || service.container?.name || service.name;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,127}$/.test(ref)) return null;
  return { service, ref };
}

export const history = new History({ intervalMs: 5000, samples: 720, file: path.join(DATA_DIR, 'metrics.json') });

let lastNews = { status: 'idle', items: [] };
let bootAt = Date.now();

/**
 * The complete list of endpoints that answer without a session. Everything else — inventory,
 * stacks, system, logs, activity, settings, layout, bookmarks, icons, discovery, providers,
 * custom code — requires one. Adding a route here is a security decision; keep the list short.
 */
const PUBLIC_ROUTES = new Set([
  'GET /api/health',
  'GET /api/setup/status',
  'POST /api/setup',
  'GET /api/auth/me',
  'POST /api/auth/login',
  'POST /api/auth/logout',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function send(res, status, obj, { etagBody } = {}) {
  const body = etagBody ?? JSON.stringify(obj);
  const etag = '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"';
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('etag', etag);
  res.writeHead(status, { 'x-content-type-options': 'nosniff' });
  res.end(body);
}

export async function handleApi(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;
  const route = `${method} ${p}`;
  // Every mutating endpoint speaks JSON and only JSON. A form-encoded or text/plain body is
  // refused outright: it can never be a legitimate Hub request, and it keeps simple cross-site
  // form posts from ever being interpreted as an update.
  const jsonBody = async () => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type && type !== 'application/json') {
      throw Object.assign(new Error('body must be application/json'), { status: 415 });
    }
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 2_000_000) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(c);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
  };
  const notFound = () => { throw Object.assign(new Error(`no route: ${route}`), { status: 404 }); };

  // ---------- identity: one gate in front of every route ----------
  // Resolved fresh per request (a session can be revoked between two polls) and shared with the
  // routes below, so nothing has to re-read the cookie or trust a query parameter.
  const session = auth.authenticate(req);
  // The cookie token currently in play, so signing in can retire it (see the login routes).
  const activeToken = session?.session?.id ?? null;
  const isPublic = PUBLIC_ROUTES.has(route);
  if (!isPublic && !session) {
    res.setHeader('www-authenticate', 'Cookie');
    return send(res, 401, { error: 'Authentication required.', code: 'auth_required' });
  }
  if (!SAFE_METHODS.has(method)) {
    const csrf = auth.csrfCheck(req);
    if (!csrf.ok) {
      logEvent({ source: 'system', type: 'auth.csrf_blocked', subject: route, message: csrf.reason });
      return send(res, 403, { error: `Refused: ${csrf.reason}`, code: 'csrf' });
    }
  }
  const secure = auth.isSecureRequest(req);

  // ---------- setup (bootstrap; refuses to run twice) ----------
  if (route === 'GET /api/setup/status') {
    const state = auth.getSetupState();
    const body = {
      required: state.required,
      complete: state.complete,
      hasAccount: state.hasAccount,
      version: '0.1.0',
    };
    // Before an account exists the wizard needs to show what the engine looks like. That is a
    // count-only summary — no container names, no images, no URLs leave the server pre-auth.
    if (state.required) body.discovery = await setupSummary();
    return send(res, 200, body);
  }
  if (route === 'POST /api/setup') {
    if (auth.getSetupState().complete) {
      return send(res, 409, { error: 'OpusHub is already set up. Sign in instead.', code: 'already_setup' });
    }
    const body = await jsonBody();
    const user = await auth.createAdmin({ username: body?.username, password: body?.password });
    // Infrastructure knobs the wizard may set (host address for published-port URLs, entrypoint
    // port mapping). Whitelisted: setup can never write anything else into settings.yaml.
    const infra = body?.infrastructure && typeof body.infrastructure === 'object' ? body.infrastructure : null;
    if (infra) {
      const patch = {};
      if (typeof infra.hostAddress === 'string' && infra.hostAddress.trim()) patch.hostAddress = infra.hostAddress.trim();
      if (infra.entrypointPorts && typeof infra.entrypointPorts === 'object') patch.entrypointPorts = infra.entrypointPorts;
      if (Object.keys(patch).length) {
        model.putSettings({ infrastructure: patch });
        model.invalidateDiscovery();
      }
    }
    const minted = await auth.login({ username: user.username, password: body?.password, ip: clientIp(req) });
    if (minted.ok) {
      if (activeToken && activeToken !== minted.token) auth.destroySession(activeToken);
      res.setHeader('set-cookie', auth.sessionCookie(minted.token, { maxAgeMs: minted.expiresAt - Date.now(), secure }));
    }
    logEvent({ source: 'system', type: 'setup.completed', subject: user.username, message: 'administrator account created' });
    return send(res, 201, { ok: true, user, authenticated: true });
  }

  // ---------- authentication ----------
  if (route === 'GET /api/auth/me') {
    return send(res, 200, {
      authenticated: !!session,
      user: session ? auth.getUser() : null,
      setupComplete: auth.getSetupState().complete,
    });
  }
  if (route === 'POST /api/auth/login') {
    const body = await jsonBody();
    const ip = clientIp(req);
    const result = await auth.login({ username: body?.username, password: body?.password, ip });
    if (!result.ok) {
      if (result.retryAfterMs) res.setHeader('retry-after', String(Math.ceil(result.retryAfterMs / 1000)));
      logEvent({ source: 'system', type: 'auth.login_failed', subject: String(body?.username || '(none)').slice(0, 40), message: result.status === 429 ? 'throttled' : 'incorrect credentials' });
      return send(res, result.status, { error: result.error, retryAfterMs: result.retryAfterMs });
    }
    // Signing in always mints a brand new session id (no fixation) and retires the id the client
    // presented, so a token that leaked before sign-in cannot be reused afterwards.
    if (activeToken && activeToken !== result.token) auth.destroySession(activeToken);
    res.setHeader('set-cookie', auth.sessionCookie(result.token, { maxAgeMs: result.expiresAt - Date.now(), secure }));
    logEvent({ source: 'system', type: 'auth.login', subject: result.user.username, message: `signed in${ip ? ` from ${ip}` : ''}` });
    return send(res, 200, { ok: true, user: result.user, authenticated: true });
  }
  if (route === 'POST /api/auth/logout') {
    const token = auth.tokenFrom(req);
    if (token) auth.destroySession(token);
    if (session) logEvent({ source: 'system', type: 'auth.logout', subject: session.username, message: 'signed out' });
    res.setHeader('set-cookie', auth.clearedCookie());
    return send(res, 200, { ok: true, authenticated: false });
  }

  // ---------- health & meta ----------
  // Public on purpose: this is what the container healthcheck calls, and what a load balancer
  // needs. Unauthenticated callers get liveness only — no paths, no provider internals.
  if (route === 'GET /api/health') {
    if (!session) {
      const setupState = auth.getSetupState();
      return send(res, 200, {
        name: 'OpusHub', version: '0.1.0', ok: true,
        setup: { required: setupState.required, complete: setupState.complete },
        authenticated: false,
        note: 'Sign in for provider detail.',
      });
    }
    const env = loadEnv(CONFIG_DIR);
    const dockerProv = await dockerAvailabilityCached();
    return send(res, 200, {
      name: 'OpusHub',
      version: '0.1.0',
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      bootedAt: bootAt,
      configDir: CONFIG_DIR,
      dataDir: DATA_DIR,
      env: {
        // FOUND files only (names + key names, never values); the full tried-order is logged
        // on the server at boot. Absence of an entry here = NOT FOUND for that candidate.
        files: env.loaded.map((f) => ({ file: f.file, keys: f.keys, error: f.error || null })),
        note: 'values never leave the server',
      },
      providers: {
        docker: dockerProv,
        system: { ok: true, note: 'reading /proc on this host' },
      },
    });
  }

  // ---------- settings ----------
  if (route === 'GET /api/settings') {
    const s = model.getSettings();
    const raw = readConfigText('settings.yaml');
    return send(res, 200, { ...s, _text: raw || '' });
  }
  if (route === 'PUT /api/settings') {
    let patch = await jsonBody();
    // The background photo is verified server-side before it is written, so a URL that is not
    // an image can never reach the Hub as a broken <background-image>: the browser would only
    // find out on every single load. A failed check is a 400 with the reason, not a silent
    // fallback that looks like "the setting just doesn't work".
    if (patch?.appearance?.background && Object.hasOwn(patch.appearance.background, 'photo')) {
      const r = await checkBackgroundUrl(patch.appearance.background.photo);
      if (!r.ok) return send(res, 400, { error: r.error, code: 'background_url' });
      // a photo page that resolved to a direct image is stored as the direct image — the
      // setting file keeps what the browser will actually render
      if (r.url != null && r.url !== patch.appearance.background.photo) {
        patch = { ...patch, appearance: { ...patch.appearance, background: { ...patch.appearance.background, photo: r.url } } };
      }
    }
    const next = model.putSettings(patch);
    model.invalidateDiscovery(); // infrastructure.* changes how URLs are resolved
    logEvent({ source: 'config', type: 'settings.updated', subject: 'settings.yaml', message: summarizeSettingsPatch(patch) });
    return send(res, 200, next);
  }
  if (route === 'GET /api/settings/raw') {
    return send(res, 200, { file: 'settings.yaml', text: readConfigText('settings.yaml') || '' });
  }

  // ---------- layout (composition of the Hub: widgets, ordering, visibility) ----------
  if (route === 'GET /api/layout') return send(res, 200, model.getLayout());
  if (route === 'PUT /api/layout') {
    const patch = await jsonBody();
    const next = model.putLayout(patch);
    logEvent({ source: 'config', type: 'layout.updated', subject: 'layout.json', message: model.describeLayoutPatch(patch) });
    return send(res, 200, next);
  }
  if (route === 'GET /api/widgets') return send(res, 200, model.getWidgetDoc());
  if (route === 'POST /api/layout/reset') {
    const next = model.resetLayout();
    logEvent({ source: 'config', type: 'layout.updated', subject: 'layout.json', message: 'hub composition reset to defaults' });
    return send(res, 200, next);
  }

  // ---------- configuration templates (layout presets — never infrastructure) ----------
  if (route === 'GET /api/templates') return send(res, 200, await model.getTemplates());
  if (route === 'POST /api/layout/template') {
    const body = await jsonBody();
    const id = String(body?.id || '').trim();
    const next = await model.applyLayoutTemplate(id);
    logEvent({ source: 'config', type: 'layout.updated', subject: 'layout.json', message: `template applied: ${id}` });
    return send(res, 200, next);
  }

  // ---------- services & stacks (both read the one canonical inventory) ----------
  if (route === 'GET /api/services') return send(res, 200, await model.getServicesView());
  if (route === 'PUT /api/services') {
    const patch = await jsonBody();
    const next = model.writeServices(patch);
    const n = next.groups.reduce((a, g) => a + g.services.length, 0);
    model.invalidateDiscovery();
    logEvent({ source: 'config', type: 'services.updated', subject: 'services.yaml', message: `updated ${next.groups.length} group(s), ${n} overlay entr${n === 1 ? 'y' : 'ies'}` });
    return send(res, 200, await model.getServicesView());
  }
  const svcMatch = p.match(/^\/api\/services\/([^/]+)\/([^/]+)$/);
  if (method === 'GET' && svcMatch) {
    const group = decodeURIComponent(svcMatch[1]);
    const name = decodeURIComponent(svcMatch[2]);
    const inv = await model.getInventory();
    const found = resolveServiceContainer(inv, group, name);
    if (!found) return send(res, 404, { error: `no live container for: ${group}/${name}` });
    const { service, ref } = found;
    // full stack projection (same shape as GET /api/stacks) so the UI gets members + status
    const stacksDoc = await model.getStacksDoc();
    const stack = stacksDoc.stacks.find((s) => s.id === service.stack)
      || stacksDoc.stacks.find((s) => s.members.some((m) => m.containerName === service.name)) || null;
    let container = null, containerStats = null;
    if (docker.availability().ok) {
      try {
        container = await docker.inspectContainer(ref);
        // stats flow through the shared sampler: one Docker call per interval no matter how
        // many UI elements are showing this service, and every fetch grows its sparkline history
        containerStats = await statsWithHistory(ref);
      } catch { /* keep partial */ }
    }
    // inspect is the only place health and restartCount exist — surface them on the record
    const enriched = container ? {
      ...service,
      status: container.state.status === 'running'
        ? (container.state.health === 'unhealthy' ? 'unhealthy' : 'up')
        : container.state.status === 'exited' ? 'down' : (container.state.status || service.status),
      container: {
        ...service.container,
        health: container.state.health ?? service.container.health,
        restartCount: container.state.restartCount ?? service.container.restartCount,
      },
    } : service;
    return send(res, 200, {
      service: enriched, stack, container, containerStats,
      image: container ? await cachedImageInfo(container.image || service.container.image) : null,
      dockerAvailable: docker.availability().ok,
      url: service.url, urlSource: service.urlSource, urlNote: service.urlNote ?? null,
    });
  }

  // ---------- per-service read-only detail: stats, history, logs ----------
  // Generic routes keyed by the same stable service id as the page (`:group/:name`); there is
  // deliberately no /api/jellyfin — every application is addressed through the one model.
  const svcSub = p.match(/^\/api\/services\/([^/]+)\/([^/]+)\/(stats|stats\/history|logs|history)$/);
  if (method === 'GET' && svcSub) {
    const group = decodeURIComponent(svcSub[1]);
    const name = decodeURIComponent(svcSub[2]);
    const what = svcSub[3];
    const inv = await model.getInventory();
    const found = resolveServiceContainer(inv, group, name);
    if (!found) return send(res, 404, { error: `no live container for: ${group}/${name}` });
    const { service, ref } = found;

    if (what === 'stats') {
      if (!docker.availability().ok) return send(res, 200, { status: 'unavailable', stats: null });
      const stats = await statsWithHistory(ref);
      return send(res, 200, { status: stats ? 'ok' : 'unavailable', stats, at: Date.now() });
    }

    if (what === 'stats/history') {
      const win = Math.min(30 * 60_000, Math.max(60_000, Number(url.searchParams.get('window')) || 30 * 60_000));
      return send(res, 200, { service: service.name, ...statsHistory(ref, { windowMs: win }) });
    }

    if (what === 'logs') {
      const a = docker.availability();
      if (!a.ok) return send(res, 200, { status: 'unavailable', reason: a.public, lines: [] });
      const tail = Math.min(500, Math.max(1, Number(url.searchParams.get('tail')) || 150));
      const timestamps = url.searchParams.get('timestamps') === '1' || url.searchParams.get('timestamps') === 'true';
      try {
        return send(res, 200, { status: 'ok', lines: await docker.logs(ref, { tail, timestamps }) });
      } catch (err) {
        if (process.env.OPUSHUB_DEBUG) console.warn(`[docker] logs failed: ${err.message}`);
        const missing = /404|no such container/i.test(String(err.message));
        return send(res, 200, { status: 'error', reason: missing ? 'No such container (it may have been removed).' : 'Could not read container logs.', lines: [] });
      }
    }

    if (what === 'history') {
      // Real events OpusHub witnessed for this container. The log starts when OpusHub boots —
      // the UI distinguishes “no historical data yet” from “nothing happened”.
      const all = readEvents({ limit: 500 });
      const subjects = new Set([service.name, ref, service.displayName]);
      const events = all.items.filter((e) => e.source === 'docker' && e.subject && subjects.has(e.subject)).slice(0, 30);
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 12));
      return send(res, 200, {
        service: service.name,
        events: events.slice(0, limit),
        watchingSince: firstEventAt(), // null → the log is empty: no history EXISTS yet
        logStarted: firstEventAt(),
      });
    }
  }
  if (method === 'POST' && svcMatch) {
    // user launched a service externally — a real event worth logging
    const group = decodeURIComponent(svcMatch[1]);
    const name = decodeURIComponent(svcMatch[2]);
    const s = model.getSettings();
    if (s.behavior?.logLaunches) {
      logEvent({ source: 'user', type: 'service.launch', subject: name, message: `opened from ${group}` });
    }
    return send(res, 200, { logged: !!s.behavior?.logLaunches });
  }

  if (route === 'GET /api/stacks') {
    return send(res, 200, await model.getStacksDoc());
  }
  const stMatch = p.match(/^\/api\/stacks\/([^/]+)$/);
  if (method === 'GET' && stMatch) {
    const name = decodeURIComponent(stMatch[1]);
    const data = await model.getStacksDoc();
    const key = name.toLowerCase();
    const stack = data.stacks.find((s) => String(s.id).toLowerCase() === key || s.name.toLowerCase() === key || String(s.project || '').toLowerCase() === key);
    if (!stack) return send(res, 404, { error: `stack not found: ${name}` });
    const members = await model.enrichStackMembers(stack);
    return send(res, 200, { ...stack, members, live: data.live, statusReason: data.statusReason });
  }
  if (route === 'PUT /api/stacks') {
    const patch = await jsonBody();
    const next = model.writeStacks(patch);
    model.invalidateDiscovery();
    logEvent({ source: 'config', type: 'stacks.updated', subject: 'stacks.yaml', message: `updated ${next.stacks.length} stack overlay(s)` });
    return send(res, 200, next);
  }

  // ---------- bookmarks ----------
  if (route === 'GET /api/bookmarks') return send(res, 200, model.readBookmarks());
  if (route === 'PUT /api/bookmarks') {
    const next = model.writeBookmarks(await jsonBody());
    logEvent({ source: 'config', type: 'bookmarks.updated', subject: 'bookmarks.yaml', message: 'bookmarks updated' });
    return send(res, 200, next);
  }

  // ---------- system ----------
  if (route === 'GET /api/system') {
    const s = await collectSystem();
    reportProvider('system', 'available', { silent: true });
    return send(res, 200, s);
  }
  if (route === 'GET /api/system/history') {
    const ms = Math.min(24 * 3600_000, Math.max(60_000, Number(url.searchParams.get('window')) || 3600_000));
    const points = history.window(ms);
    const body = JSON.stringify({ window: ms, points });
    if (req.headers['if-none-match'] && req.headers['if-none-match'].includes(hashOf(body))) {
      res.writeHead(304); res.end(); return;
    }
    return send(res, 200, null, { etagBody: body });
  }
  // ---------- discovery diagnostics ----------
  if (route === 'GET /api/discovery') return send(res, 200, await model.getDiscoveryStatus());
  if (route === 'POST /api/discovery/refresh') {
    model.invalidateDiscovery();
    const inv = await model.getInventory();
    logEvent({ source: 'docker', type: 'discovery.refreshed', subject: 'docker', message: `${inv.stats.containers} container(s), ${inv.stats.withUrl} with a web URL` });
    return send(res, 200, await model.getDiscoveryStatus({ refreshMs: 0 }));
  }

  // ---------- docker passthrough (read-only projections) ----------
  if (route === 'GET /api/docker/status') return send(res, 200, await dockerAvailabilityCached(true));
  if (route === 'GET /api/docker/containers') {
    const a = docker.availability();
    if (!a.ok) return send(res, 200, { status: 'unavailable', reason: a.public, containers: [] });
    try { return send(res, 200, { status: 'ok', containers: await docker.listContainers({ all: true }) }); }
    catch (err) {
      if (process.env.OPUSHUB_DEBUG) console.warn(`[docker] list failed: ${err.message}`);
      return send(res, 200, { status: 'error', reason: 'Docker engine answered with an error.', containers: [] });
    }
  }
  const logsMatch = p.match(/^\/api\/docker\/containers\/([^/]+)\/logs$/);
  if (method === 'GET' && logsMatch) {
    const a = docker.availability();
    if (!a.ok) return send(res, 200, { status: 'unavailable', reason: a.public, lines: [] });
    const tail = Math.min(500, Math.max(1, Number(url.searchParams.get('tail')) || 150));
    const timestamps = url.searchParams.get('timestamps') === '1' || url.searchParams.get('timestamps') === 'true';
    const ref = decodeURIComponent(logsMatch[1]);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,127}$/.test(ref)) {
      return send(res, 200, { status: 'error', reason: 'invalid container reference', lines: [] });
    }
    // The reference must be one of OURS: a container discovery actually saw. Without this check
    // the route would read logs for any container on the host by name — including ones OpusHub
    // has no business pointing at. Same rule as every other container-scoped route.
    const inv = await model.getInventory();
    const known = inv.services.some((s) => s.name === ref || s.id === ref || s.container?.name === ref);
    if (!known) {
      return send(res, 200, { status: 'error', reason: 'Unknown container — logs are only served for containers OpusHub discovered.', lines: [] });
    }
    try { return send(res, 200, { status: 'ok', lines: await docker.logs(ref, { tail, timestamps }) }); }
    catch (err) {
      if (process.env.OPUSHUB_DEBUG) console.warn(`[docker] logs failed: ${err.message}`);
      const missing = /404|no such container/i.test(String(err.message));
      return send(res, 200, { status: 'error', reason: missing ? 'No such container (it may have been removed).' : 'Could not read container logs.', lines: [] });
    }
  }

  // ---------- integrations ----------
  if (route === 'GET /api/news') {
    const s = model.getSettings();
    const r = await getNews(s.integrations?.news?.feeds || [], { limit: Number(url.searchParams.get('limit')) || 40 });
    lastNews = r;
    reportProvider('news', r.status === 'ok' ? 'available' : r.status === 'partial' ? 'degraded' : 'unavailable', {
      reason: r.status === 'unconfigured' ? 'No news feeds configured.' : r.reason || null, silent: r.status === 'unconfigured',
    });
    return send(res, 200, r);
  }
  if (route === 'GET /api/weather') {
    const s = model.getSettings();
    const r = await getWeather(s.integrations?.weather || {});
    if (r.status === 'ok' && s.integrations?.weather?.units === 'f') {
      r.current.feelsC = cToF(r.current.feelsC);
      r.current.tempC = cToF(r.current.tempC);
      r.today.highC = cToF(r.today.highC); r.today.lowC = cToF(r.today.lowC);
      for (const f of r.forecast) { f.highC = cToF(f.highC); f.lowC = cToF(f.lowC); }
      r.units = 'f';
    }
    reportProvider('weather', r.status === 'ok' ? 'available' : 'unavailable', {
      reason: r.status === 'unconfigured' ? 'No weather location configured.' : r.reason || null, silent: r.status === 'unconfigured',
    });
    return send(res, 200, r);
  }
  if (route === 'GET /api/market') {
    const s = model.getSettings();
    const r = await getMarket(s.integrations?.markets?.symbols || []);
    reportProvider('markets', r.status === 'ok' ? 'available' : 'unavailable', {
      reason: r.status === 'unconfigured' ? 'No market symbols configured.' : r.reason || null, silent: r.status === 'unconfigured',
    });
    return send(res, 200, r);
  }

  // ---------- activity ----------
  if (route === 'GET /api/activity') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const source = url.searchParams.get('source') || null;
    const before = Number(url.searchParams.get('before')) || null;
    const grouped = url.searchParams.get('grouped') === '1' || url.searchParams.get('grouped') === 'true';
    return send(res, 200, { ...readEvents({ limit, source, before, grouped }), watchingSince: firstEventAt() });
  }

  // ---------- provider health ----------
  if (route === 'GET /api/providers') {
    return send(res, 200, providerHealthDoc());
  }

  // ---------- search ----------
  if (route === 'GET /api/search') {
    const q = url.searchParams.get('q') || '';
    return send(res, 200, { query: q, results: await searchAll(q, { newsItems: lastNews.items || [] }) });
  }

  // ---------- icons ----------
  if (route === 'GET /api/icons/search') {
    const q = url.searchParams.get('q') || '';
    if (!q) return send(res, 200, { results: listLocalFiles().slice(0, 60), remote: { status: 'idle' } });
    return send(res, 200, await iconSearch(q, Number(url.searchParams.get('limit')) || 60));
  }
  if (route === 'GET /api/icons/local') return send(res, 200, { files: listLocalFiles() });
  if (route === 'GET /api/icon') {
    const ref = url.searchParams.get('ref');
    if (!ref) return send(res, 400, { error: 'ref required' });
    const size = Math.min(128, Math.max(12, Number(url.searchParams.get('size')) || 64));
    const r = await iconSvg(ref, size);
    if (!r) return send(res, 404, { error: `cannot resolve icon: ${ref}` });
    res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=86400');
    res.writeHead(200);
    return res.end(r.svg);
  }

  // ---------- custom css/js ----------
  if (route === 'GET /api/custom') {
    const s = model.getSettings();
    return send(res, 200, {
      cssEnabled: !!s.advanced?.customCss,
      jsEnabled: !!s.advanced?.customJs,
      css: s.advanced?.customCss ? readConfigText('theme.css') : null,
      jsPresent: fs.existsSync(path.join(CONFIG_DIR, 'app.js')),
    });
  }
  if (route === 'PUT /api/custom') {
    const b = await jsonBody();
    if (typeof b.css === 'string') writeText('theme.css', b.css);
    if (typeof b.js === 'string') writeText('app.js', b.js);
    logEvent({ source: 'config', type: 'custom.updated', subject: 'theme.css / app.js', message: 'custom code updated' });
    return send(res, 200, { ok: true });
  }

  // ---------- background images ----------
  // Verify a background URL the same way it will be stored: the response is a verdict only
  // ({ ok, url | error }) — the image bytes never cross the API.
  if (route === 'GET /api/background/check') {
    const input = url.searchParams.get('url') ?? '';
    return send(res, 200, await checkBackgroundUrl(input));
  }
  if (route === 'GET /api/backgrounds') {
    const dir = path.join(CONFIG_DIR, 'backgrounds');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.(svg|png|jpe?g|webp|avif)$/i.test(f)); } catch { /* ok */ }
    return send(res, 200, { files: files.map((f) => ({ name: f, url: `/user/backgrounds/${encodeURIComponent(f)}` })) });
  }

  notFound();
}

function hashOf(body) {
  return '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"';
}

/** The caller's address, for session records and login throttling. Forwarded headers are only
 *  consulted because OpusHub is expected to sit behind a reverse proxy or a VPN; the value is
 *  used for display and throttling, never for authorization. */
function clientIp(req) {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  if (fwd) return fwd.slice(0, 60);
  return req?.socket?.remoteAddress || null;
}

/**
 * Count-only view of discovery, used by the first-run wizard *before* an account exists.
 * Deliberately names nothing: no container, image, URL or path crosses the boundary pre-auth.
 */
async function setupSummary() {
  const s = await model.getDiscoveryStatus({ refreshMs: 0 });
  return {
    docker: { ok: s.engine.ok, state: s.engine.state, version: s.engine.version },
    stacks: s.inventory.stacks,
    containers: s.engine.containers,
    running: s.engine.running,
    services: s.inventory.applications,
    infrastructure: s.inventory.infrastructure,
    standalone: s.inventory.standalone,
    urls: { detected: s.urlDiscovery.withUrl, missing: s.urlDiscovery.withoutUrl },
    // Entrypoint *names* ("web", "websecure") are Traefik vocabulary, not host data: the wizard
    // needs them to offer the port mapping when the entrypoint is not on 80/443.
    traefik: {
      routes: s.urlDiscovery.traefikRouters,
      tlsRoutes: s.traefik.tlsRouters,
      routedContainers: s.traefik.containers,
      entrypoints: s.traefik.entrypoints,
      entrypointPorts: s.urlDiscovery.entrypointPorts,
    },
    hostAddress: s.urlDiscovery.hostAddress,
    hostAddressSource: s.urlDiscovery.hostAddressSource,
  };
}

let dockerAvailCache = { at: 0, value: null };
async function dockerAvailabilityCached(force = false) {
  if (!force && Date.now() - dockerAvailCache.at < 30_000 && dockerAvailCache.value) return dockerAvailCache.value;
  const a = docker.availability();
  let value;
  if (!a.ok) value = docker.publicStatus(a);
  else value = docker.publicStatus(await docker.probe());
  dockerAvailCache = { at: Date.now(), value };
  return value;
}

function summarizeSettingsPatch(patch) {
  const parts = [];
  const walk = (obj, prefix = '') => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${prefix}${k}.`);
      else parts.push(`${prefix}${k}`);
    }
  };
  walk(patch);
  const s = parts.slice(0, 6).join(', ');
  return parts.length > 6 ? `${s} … (+${parts.length - 6})` : s || 'settings updated';
}

export function markBoot(t) { bootAt = t; }
