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
import { CONFIG_DIR, APP_ROOT, readConfigText, writeText, writePresentationText } from './configStore.js';
import * as auth from './auth.js';
import * as model from './model.js';
import { collect as collectSystem, History } from './providers/system.js';
import * as docker from './providers/docker.js';
import { getNews } from './providers/news.js';
import { getWeather, cToF } from './providers/weather.js';
import { getMarket } from './providers/market.js';
import { checkBackgroundUrl } from './providers/background.js';
import { URL_REASONS } from './urlResolver.js';
import { iconSvg, search as iconSearch, listLocalFiles } from './providers/icons.js';
import { logEvent, readEvents, firstEventAt } from './activity.js';
import { ackAlert, countRecentAuthFailures, getActiveAlerts, refreshAlerts } from './alerts.js';
import { checkForUpdates, lastUpdateCheck, REPO_URL } from './updateCheck.js';
import { searchAll } from './search.js';
import { loadEnv } from './env.js';
import { DATA_DIR } from './configStore.js';
import { statsWithHistory, statsHistory, aggregateHistory } from './statsHistory.js';
import { providerHealthDoc, reportProvider } from './providers/health.js';
import { configScopeDoc, presentationFileNames } from './configScope.js';
import * as configHistory from './configHistory.js';
import { parseHomepageBundle, buildImportPreview, HOMEPAGE_FILES, REFUSED_FILES } from './homepageImport.js';
import { planImport, commitPlan } from './configImport.js';
import { exportNative, exportHomepage } from './configExport.js';
import { lintCss, lintJs, LIMITS } from './configSchema.js';
import { makeWidget, defaultWidgets, WIDGET_TYPES } from './widgets.js';
import { templateList, templateIds } from './templates.js';
import { hostDocument } from './host.js';
import { handleOperations } from './operationsApi.js';
import { describeStorage } from './providers/storage.js';
// Phase 9 — the OpusGrid infrastructure surface and its health aggregation
import { handleInfrastructure } from './infrastructureApi.js';
// Phase 10A — the monitoring surface (monitors, checks, incidents, engine health)
import { handleMonitoring } from './monitoringApi.js';
import { alertInputs as monitoringAlertInputs } from './monitoring/engine.js';
import { describeProviders } from './infrastructure/registry.js';
import { aggregateHealth } from './infrastructure/health.js';
import { storageDocument, networkDocument } from './infrastructure/opusgrid.js';
import { versionInfo } from './version.js';
// Phase 10B — live events & notifications
import { handleEvents, handleEventsSSE, isSSERoute } from './eventsApi.js';
import { handleNotifications } from './notificationsApi.js';
import { initEvents } from './events/index.js';
// Phase 10C — container recovery (Autoheal) & updates (Diun)
import { handleAutohealRoutes } from './autohealApi.js';
import { handleUpdatesRoutes } from './updatesApi.js';
import { handleContainersRoutes } from './containersApi.js';

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
  let p = url.pathname.replace(/\/+$/, '') || '/';
  // /api/v1/* — the canonical versioned namespace. The unversioned routes below are permanent
  // compatibility aliases with identical shapes; v1 exists so future versions can diverge.
  p = rewriteV1(p);
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
  // Inbound webhooks carry their own dedicated Bearer secret authentication and rate limiting
  const isWebhook = p === '/api/autoheal/webhook' || p === '/api/container-updates/webhook';
  const isPublic = PUBLIC_ROUTES.has(route) || isWebhook;
  if (!isPublic && !session) {
    res.setHeader('www-authenticate', 'Cookie');
    return send(res, 401, { error: 'Authentication required.', code: 'auth_required' });
  }
  if (!SAFE_METHODS.has(method) && !isWebhook) {
    const csrf = auth.csrfCheck(req);
    if (!csrf.ok) {
      logEvent({ source: 'system', type: 'auth.csrf_blocked', subject: route, message: csrf.reason });
      return send(res, 403, { error: `Refused: ${csrf.reason}`, code: 'csrf' });
    }
  }
  const secure = auth.isSecureRequest(req);

  // ---------- operations (Phase 8) ----------
  // Handled here, immediately after the session and CSRF gates and before every other route, so
  // that the answer to "is the operations surface authenticated?" is: it cannot be reached
  // unauthenticated, because it is inside the same gate as everything else. The handler is a
  // separate module — this file only decides *where* it sits in the request path.
  if (p.startsWith('/api/operations') || p.startsWith('/api/v1/operations')) {
    const handled = await handleOperations({
      p, method,
      send: (status, obj) => send(res, status, obj),
      jsonBody,
      query: url.searchParams,
      actor: session?.username ?? null,
      // the session *handle*, never the token: enough to bind a confirmation to a session,
      // useless as a credential
      sessionId: activeToken ? auth.sessionHandle(activeToken) : null,
    });
    if (handled) return;
  }

  // ---------- OpusGrid infrastructure (Phase 9) ----------
  // Sits inside the same session and CSRF gate as everything else, so the answer to "is the
  // infrastructure surface authenticated?" is the same as for the rest of the API. The handler
  // owns every /api/infrastructure/* route and exposes GETs only — see server/infrastructureApi.js.
  if (p.startsWith('/api/infrastructure')) {
    await handleInfrastructure({
      p, method,
      send: (status, obj) => send(res, status, obj),
      query: url.searchParams,
    });
    return;
  }

  // ---------- monitoring (Phase 10A) ----------
  // Same gate, same rules: the handler owns every /api/monitoring/* route. It answers GETs and a
  // small, validated set of writes that only ever touch monitor definitions.
  if (p.startsWith('/api/monitoring')) {
    await handleMonitoring({
      p, method,
      send: (status, obj) => send(res, status, obj),
      jsonBody,
      query: url.searchParams,
      actor: session?.username ?? null,
    });
    return;
  }

  // ---------- events & notifications (Phase 10B) ----------
  // SSE is a long-lived GET that hijacks the response — it must be detected before the JSON
  // helper is used, but after the auth gate (same session cookie, same CSRF rules for safe method).
  if (isSSERoute(p, method)) {
    // Ensure events subsystem is initialized
    initEvents();
    await handleEventsSSE(req, res, {
      query: url.searchParams,
      session,
      sessionHandle: activeToken ? auth.sessionHandle(activeToken) : 'anon',
    });
    return;
  }
  if (p.startsWith('/api/events')) {
    initEvents();
    const handled = await handleEvents({
      p, method,
      send: (status, obj) => send(res, status, obj),
      query: url.searchParams,
      sessionHandle: activeToken ? auth.sessionHandle(activeToken) : 'anon',
    });
    if (handled !== null) return;
  }
  if (p.startsWith('/api/notifications')) {
    initEvents();
    const handled = await handleNotifications({
      p, method,
      send: (status, obj) => send(res, status, obj),
      jsonBody,
      query: url.searchParams,
    });
    if (handled !== null) return;
  }

  // ---------- container recovery (Phase 10C Autoheal) ----------
  if (p.startsWith('/api/autoheal')) {
    const handled = await handleAutohealRoutes({
      req,
      p, method,
      send: (status, obj) => send(res, status, obj),
      jsonBody,
      clientIp: req.socket?.remoteAddress || '127.0.0.1',
    });
    if (handled) return;
  }

  // ---------- containers (Phase 10D-A) ----------
  // The read surface behind the Edit Container UI: inspect, canonical spec, processes, volumes,
  // and a side-effect-free diff preview. Every write is an operation (POST /api/v1/operations).
  if (p.startsWith('/api/containers') || p.startsWith('/api/v1/containers')) {
    const handled = await handleContainersRoutes({
      p, method,
      send: (status, obj) => send(res, status, obj),
      jsonBody,
    });
    if (handled) return;
  }

  // ---------- container updates (Phase 10C Diun / Update Now) ----------
  if (p.startsWith('/api/container-updates')) {
    const handled = await handleUpdatesRoutes({
      req,
      p, method,
      send: (status, obj) => send(res, status, obj),
      jsonBody,
      actor: session?.username ?? null,
      sessionId: activeToken ? auth.sessionHandle(activeToken) : null,
      query: url.searchParams,
      clientIp: req.socket?.remoteAddress || '127.0.0.1',
    });
    if (handled) return;
  }

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
    // First-run presentation choice. `detected` writes nothing (the default); `template` applies one
    // of the built-in templates, whose ids are a fixed server-side list. Validated *before* the
    // account is created, so a bad choice cannot leave a half-finished install behind.
    // An unauthenticated route reads this field, so its *shape* is part of the contract: an object
    // or nothing. A scalar, an array or a nested document is refused rather than coerced — the
    // coercion is what let `['balanced']` select a template, which is not a write primitive (the id
    // still has to name one of the six built-ins) but is exactly the kind of type confusion an
    // unauthenticated field should not be able to negotiate.
    const rawPres = body?.presentation;
    if (rawPres != null && (typeof rawPres !== 'object' || Array.isArray(rawPres))) {
      return send(res, 400, { error: 'presentation must be an object', code: 'bad_presentation' });
    }
    const pres = rawPres || null;
    let template = null;
    if (pres && pres.mode && pres.mode !== 'detected') {
      if (pres.mode !== 'template') return send(res, 400, { error: 'presentation.mode must be detected or template', code: 'bad_presentation' });
      if (typeof pres.template !== 'string' || !templateIds().includes(pres.template)) {
        return send(res, 400, { error: `unknown template: ${String(pres.template).slice(0, 40)}`, code: 'unknown_template' });
      }
      template = pres.template;
    }
    const user = await auth.createAdmin({ username: body?.username, password: body?.password });
    if (template) {
      // Layout-only, and it runs through the same writer an authenticated template apply uses.
      // Awaited before the version is recorded: the snapshot has to see the file the apply wrote,
      // or it records the empty state that preceded it.
      await model.applyLayoutTemplate(template);
      recordVersion({ reason: 'template.applied', subject: template, label: `${template} template applied at setup`, actor: user.username });
      logEvent({ source: 'config', type: 'template.applied', subject: template, message: 'presentation template applied during setup' });
    }
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
    return send(res, 201, { ok: true, user, authenticated: true, presentation: { mode: template ? 'template' : 'detected', template } });
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

  // ---------- account maintenance (authenticated, same-origin) ----------
  // The audit surface: what is signed in, and the one credential change there is. Both are
  // session-scoped — an admin can only ever see and revoke *their own* sessions, and the password
  // route requires the current password even though a session is already held, so a borrowed
  // browser cannot lock the owner out. Session ids here are derived handles (see auth.sessionHandle):
  // the bearer token itself is never serialized, by any route, ever.
  if (route === 'GET /api/auth/sessions') {
    const rows = auth.listSessions(activeToken);
    return send(res, 200, {
      sessions: rows,
      count: rows.length,
      current: rows.find((s) => s.current) || null,
      limits: { absoluteMs: auth.SESSION_TTL_MS, idleMs: auth.SESSION_IDLE_MS, max: 50 },
    });
  }
  if (route === 'POST /api/auth/sessions/revoke') {
    const body = await jsonBody();
    const scope = String(body?.scope || '');
    if (scope === 'others') {
      if (!session) return send(res, 401, { error: 'Authentication required.', code: 'auth_required' });
      const revoked = auth.revokeSessions({ except: activeToken });
      logEvent({ source: 'system', type: 'auth.sessions_revoked', subject: session.username, message: `revoked ${revoked} other session(s)` });
      return send(res, 200, { ok: true, revoked, signedOut: false });
    }
    if (scope === 'all') {
      const username = session?.username ?? auth.getUser()?.username ?? 'admin';
      const revoked = auth.revokeSessions();
      res.setHeader('set-cookie', auth.clearedCookie());
      logEvent({ source: 'system', type: 'auth.sessions_revoked', subject: username, message: `signed out everywhere (${revoked} session(s))` });
      return send(res, 200, { ok: true, revoked, signedOut: true });
    }
    if (scope === 'one') {
      const handle = String(body?.id || '');
      if (!handle) return send(res, 400, { error: 'A session id is required.', code: 'session_id' });
      const revoked = auth.revokeSessions({ handles: [handle] });
      // revoking your own session is a sign-out, and must clear the cookie with it
      const isCurrent = handle === auth.sessionHandle(activeToken);
      if (isCurrent) res.setHeader('set-cookie', auth.clearedCookie());
      logEvent({ source: 'system', type: 'auth.sessions_revoked', subject: session?.username ?? 'admin', message: `revoked 1 session` });
      return send(res, 200, { ok: true, revoked, signedOut: isCurrent });
    }
    return send(res, 400, { error: 'scope must be one of: others, all, one.', code: 'scope' });
  }
  if (route === 'POST /api/auth/password') {
    const body = await jsonBody();
    if (!session) return send(res, 401, { error: 'Authentication required.', code: 'auth_required' });
    const ip = clientIp(req);
    const result = await auth.changePassword({
      currentPassword: body?.currentPassword,
      newPassword: body?.newPassword,
      token: activeToken,
      ip,
    });
    if (!result.ok) {
      // Never log either password — only the fact that the attempt failed, and for whom.
      logEvent({ source: 'system', type: 'auth.password_failed', subject: session.username, message: result.status === 401 ? 'current password incorrect' : 'refused by policy' });
      return send(res, result.status, { error: result.error, code: result.status === 401 ? 'invalid_password' : 'password_policy' });
    }
    // Rotate the cookie exactly like a login: the presented id is retired by changePassword.
    res.setHeader('set-cookie', auth.sessionCookie(result.token, { maxAgeMs: result.expiresAt - Date.now(), secure }));
    logEvent({ source: 'system', type: 'auth.password_changed', subject: session.username, message: `password changed; ${result.revoked} other session(s) revoked` });
    return send(res, 200, { ok: true, user: result.user, revoked: result.revoked, authenticated: true });
  }

  // ---------- health & meta ----------
  // Public on purpose: this is what the container healthcheck calls, and what a load balancer
  // needs. Unauthenticated callers get liveness only — no paths, no provider internals.
  if (route === 'GET /api/health') {
    if (!session) {
      const setupState = auth.getSetupState();
      return send(res, 200, {
        // The configured name (settings.yaml → app.name) is presentation, not a secret: the login
        // screen and the tab title use it, and both render before a session exists.
        name: appName(), version: '0.1.0', ok: true,
        setup: { required: setupState.required, complete: setupState.complete },
        authenticated: false,
        note: 'Sign in for provider detail.',
      });
    }
    const env = loadEnv(CONFIG_DIR);
    const dockerProv = await dockerAvailabilityCached();
    const ver = versionInfo();
    return send(res, 200, {
      name: appName(),
      version: '0.1.0',
      status: 'ok', // liveness for container healthchecks; provider detail below
      build: ver,
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
      docker: { status: dockerProv.ok ? 'ok' : dockerProv.state || 'unavailable' },
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
    recordVersion({ reason: 'settings.updated', subject: 'settings.yaml', label: summarizeSettingsPatch(patch), actor: session?.username });
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
    recordVersion({ reason: 'layout.updated', subject: 'layout.json', label: model.describeLayoutPatch(patch), actor: session?.username });
    logEvent({ source: 'config', type: 'layout.updated', subject: 'layout.json', message: model.describeLayoutPatch(patch) });
    return send(res, 200, next);
  }
  if (route === 'GET /api/widgets') return send(res, 200, model.getWidgetDoc());
  if (route === 'POST /api/layout/reset') {
    const next = model.resetLayout();
    recordVersion({ reason: 'layout.reset', subject: 'layout.json', label: 'hub composition reset to defaults', actor: session?.username });
    logEvent({ source: 'config', type: 'layout.updated', subject: 'layout.json', message: 'hub composition reset to defaults' });
    return send(res, 200, next);
  }

  // ---------- configuration templates (layout presets — never infrastructure) ----------
  if (route === 'GET /api/templates') return send(res, 200, await model.getTemplates());
  if (route === 'POST /api/layout/template') {
    const body = await jsonBody();
    const id = String(body?.id || '').trim();
    // A template replaces the whole composition, so the state it is about to replace is captured
    // *before* the write as well as after — applying the wrong preset is a one-click mistake and
    // should be a one-click undo.
    const before = recordVersion({ reason: 'template', subject: 'layout.json', label: `pre-template snapshot before "${id}"`, force: true, actor: session?.username });
    const next = await model.applyLayoutTemplate(id);
    recordVersion({ reason: 'template', subject: 'layout.json', label: `template applied: ${id}`, actor: session?.username });
    logEvent({ source: 'config', type: 'layout.updated', subject: 'layout.json', message: `template applied: ${id}` });
    return send(res, 200, { ...next, undoVersion: before?.id || null });
  }

  // ---------- services & stacks (both read the one canonical inventory) ----------
  if (route === 'GET /api/services') return send(res, 200, await model.getServicesView());
  if (route === 'PUT /api/services') {
    const patch = await jsonBody();
    const next = model.writeServices(patch);
    const n = next.groups.reduce((a, g) => a + g.services.length, 0);
    model.invalidateDiscovery();
    recordVersion({ reason: 'services.updated', subject: 'services.yaml', label: `${next.groups.length} group(s), ${n} overlay entries`, actor: session?.username });
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
  const svcSub = p.match(/^\/api\/services\/([^/]+)\/([^/]+)\/(stats|stats\/history|logs|history|health)$/);
  if (method === 'GET' && svcSub) {
    const group = decodeURIComponent(svcSub[1]);
    const name = decodeURIComponent(svcSub[2]);
    const what = svcSub[3];
    const inv = await model.getInventory();
    const found = resolveServiceContainer(inv, group, name);
    if (!found) return send(res, 404, { error: `no live container for: ${group}/${name}` });
    const { service, ref } = found;

    if (what === 'stats') {
      if (!docker.availability().ok) return send(res, 200, { status: 'unavailable', code: 'docker_unavailable', stats: null });
      const stats = await statsWithHistory(ref);
      return send(res, 200, { status: stats ? 'ok' : 'unavailable', stats, at: Date.now() });
    }

    if (what === 'stats/history') {
      const win = Math.min(30 * 60_000, Math.max(60_000, Number(url.searchParams.get('window')) || 30 * 60_000));
      return send(res, 200, { service: service.name, ...statsHistory(ref, { windowMs: win }) });
    }

    if (what === 'logs') {
      const a = docker.availability();
      if (!a.ok) return send(res, 200, { status: 'unavailable', code: 'docker_unavailable', reason: a.public, lines: [] });
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

    if (what === 'health') {
      // Unified verdict: container state + healthcheck + (bounded, cached) HTTP probe of the
      // service's own discovered URL. The browser names the service; the server resolves the URL.
      const { evaluateServiceHealth } = await import('./healthModel.js');
      let container = null;
      if (docker.availability().ok) {
        try { container = await docker.inspectContainer(ref); } catch { /* list-level evidence only */ }
      }
      return send(res, 200, await evaluateServiceHealth(service, { container }));
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
    return send(res, 200, {
      ...stack,
      members,
      // counts + aggregate CPU/memory/network + uptime, all derived from the members above
      rollup: model.stackRollup(members),
      live: data.live,
      statusReason: data.statusReason,
    });
  }

  const stHistory = p.match(/^\/api\/stacks\/([^/]+)\/history$/);
  if (method === 'GET' && stHistory) {
    const name = decodeURIComponent(stHistory[1]);
    const data = await model.getStacksDoc();
    const key = name.toLowerCase();
    const stack = data.stacks.find((s) => String(s.id).toLowerCase() === key || s.name.toLowerCase() === key || String(s.project || '').toLowerCase() === key);
    if (!stack) return send(res, 404, { error: `stack not found: ${name}` });
    // No Docker calls here: this reads the shared per-container buffers, which the stack detail
    // poll keeps warm. A member nobody has looked at simply contributes nothing.
    const refs = stack.members.filter((m) => m.container?.state === 'running').map((m) => m.container.id || m.container.name);
    const win = Math.min(30 * 60_000, Math.max(60_000, Number(url.searchParams.get('window')) || 30 * 60_000));
    return send(res, 200, { stack: stack.id, ...aggregateHistory(refs, { windowMs: win }) });
  }
  if (route === 'PUT /api/stacks') {
    const patch = await jsonBody();
    const next = model.writeStacks(patch);
    model.invalidateDiscovery();
    recordVersion({ reason: 'stacks.updated', subject: 'stacks.yaml', label: `${next.stacks.length} stack overlay(s)`, actor: session?.username });
    logEvent({ source: 'config', type: 'stacks.updated', subject: 'stacks.yaml', message: `updated ${next.stacks.length} stack overlay(s)` });
    return send(res, 200, next);
  }

  // ---------- bookmarks ----------
  if (route === 'GET /api/bookmarks') return send(res, 200, model.readBookmarks());
  if (route === 'PUT /api/bookmarks') {
    const next = model.writeBookmarks(await jsonBody());
    const bmCount = next.groups.reduce((a, g) => a + g.items.length, 0);
    recordVersion({ reason: 'bookmarks.updated', subject: 'bookmarks.yaml', label: `${bmCount} bookmark(s)`, actor: session?.username });
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
    if (!a.ok) return send(res, 200, { status: 'unavailable', code: 'docker_unavailable', reason: a.public, containers: [] });
    try { return send(res, 200, { status: 'ok', containers: await docker.listContainers({ all: true }) }); }
    catch (err) {
      if (process.env.OPUSHUB_DEBUG) console.warn(`[docker] list failed: ${err.message}`);
      return send(res, 200, { status: 'error', reason: 'Docker engine answered with an error.', containers: [] });
    }
  }
  const logsMatch = p.match(/^\/api\/docker\/containers\/([^/]+)\/logs$/);
  if (method === 'GET' && logsMatch) {
    const a = docker.availability();
    if (!a.ok) return send(res, 200, { status: 'unavailable', code: 'docker_unavailable', reason: a.public, lines: [] });
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

  // ---------- host & infrastructure (Phase 7 canonical inventory) ----------
  if (route === 'GET /api/host') {
    const inv = await model.getInventory();
    // Phase 9: the host is the parent context for infrastructure, so the host document carries
    // the provider picture alongside it. The host facts themselves are unchanged.
    const [doc, providers] = await Promise.all([
      hostDocument({ inventory: inv }),
      describeProviders(),
    ]);
    return send(res, 200, { ...doc, providers, health: aggregateHealth({ providers, alerts: getActiveAlerts() }) });
  }
  if (route === 'GET /api/docker') {
    const [inv, infra, dockerProv] = await Promise.all([
      model.getInventory(),
      model.getInfra(),
      dockerAvailabilityCached(),
    ]);
    return send(res, 200, {
      at: Date.now(),
      status: dockerProv,
      engine: inv.engine || null,
      counts: {
        containers: inv.live ? inv.stats.containers : null,
        running: inv.live ? inv.stats.running : null,
        stopped: inv.live ? inv.stats.stopped : null,
        images: infra.live ? infra.counts.images : null,
        volumes: infra.live ? infra.counts.volumes : null,
        networks: infra.live ? infra.counts.networks : null,
      },
      live: inv.live && infra.live,
      statusReason: inv.live ? (infra.live ? null : infra.statusReason) : inv.statusReason,
      code: (inv.live && infra.live) ? null : 'docker_unavailable',
      lastKnown: inv.live ? null : inv.lastKnown,
    });
  }
  if (route === 'GET /api/networks') {
    const infra = await model.getInfra();
    return send(res, 200, {
      at: infra.at, live: infra.live, statusReason: infra.statusReason,
      code: infra.live ? null : 'docker_unavailable',
      networks: infra.networks, count: infra.counts.networks, stale: infra.stale,
    });
  }
  if (route === 'GET /api/volumes') {
    const infra = await model.getInfra();
    return send(res, 200, {
      at: infra.at, live: infra.live, statusReason: infra.statusReason,
      code: infra.live ? null : 'docker_unavailable',
      volumes: infra.volumes, count: infra.counts.volumes, stale: infra.stale,
    });
  }
  if (route === 'GET /api/images') {
    const infra = await model.getInfra();
    return send(res, 200, {
      at: infra.at, live: infra.live, statusReason: infra.statusReason,
      code: infra.live ? null : 'docker_unavailable',
      images: infra.images, count: infra.counts.images, stale: infra.stale,
    });
  }
  if (route === 'GET /api/storage') {
    return send(res, 200, await describeStorage());
  }
  if (route === 'GET /api/version') {
    return send(res, 200, versionInfo());
  }
  // Update awareness: the cached answer only — this route never touches the network.
  // A check happens solely through POST /api/updates/check (the "Check for updates" button).
  if (route === 'GET /api/updates') {
    return send(res, 200, { check: lastUpdateCheck(), repo: REPO_URL, install: versionInfo() });
  }
  if (route === 'POST /api/updates/check') {
    const check = await checkForUpdates({ force: true });
    logEvent({
      source: 'system', type: 'update.checked', subject: check.latest || 'unknown',
      message: check.reason, meta: { state: check.state, current: check.current, latest: check.latest },
      severity: 'info', category: 'system',
    });
    return send(res, 200, { check, repo: REPO_URL });
  }
  if (route === 'GET /api/resources') {
    const { resourcesDocument } = await import('./resources.js');
    const [system, storage] = await Promise.all([
      collectSystem().catch(() => null),
      describeStorage().catch(() => null),
    ]);
    return send(res, 200, resourcesDocument({ system, points: history.window(3600_000), storage }));
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
    // filters (service / stack / type / since) are applied server-side over the whole log
    const service = url.searchParams.get('service');
    const stack = url.searchParams.get('stack');
    const type = url.searchParams.get('type');
    const sinceRaw = Number(url.searchParams.get('since'));
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : null;
    const category = url.searchParams.get('category');
    const minSeverity = url.searchParams.get('severity');
    return send(res, 200, {
      ...readEvents({ limit, source, before, grouped, service, stack, type, since, category, minSeverity }),
      watchingSince: firstEventAt(),
      filters: { source: source || 'all', service: service || null, stack: stack || null, type: type || null, since, category: category || 'all', severity: minSeverity || null },
    });
  }

  // ---------- alerts ----------
  // Evaluated on demand over snapshots the server already holds (cached discovery, one
  // bounded system sample, the auth-failure count). Transitions log to activity inside
  // refreshAlerts, so GET here can append exactly two kinds of honest events.
  if (route === 'GET /api/alerts') {
    const [servicesView, stacksDoc, system, storage, network, providers] = await Promise.all([
      model.getServicesView().catch(() => null),
      model.getStacksDoc().catch(() => null),
      collectSystem().catch(() => null),
      // Phase 9: infrastructure evidence. Provider answers are cached and single-flighted by the
      // registry, so this adds no polling — a provider is asked at most once per its TTL.
      storageDocument({ detail: true }).catch(() => null),
      networkDocument().catch(() => null),
      describeProviders().catch(() => []),
    ]);
    const services = servicesView?.services || [];
    const stacks = (stacksDoc?.stacks || []).map((st) => ({
      project: st.project, services: st.services || st.members || [],
      running: st.runningCount ?? st.running ?? 0,
    }));
    const alerts = refreshAlerts({
      dockerAvailable: servicesView ? servicesView.live !== false : true,
      services, stacks, system,
      authFailures: countRecentAuthFailures(),
      storage, network, providers,
      // Phase 10A: what the monitoring engine *reports* — never what it decides. A monitor that is
      // paused or inside a maintenance window is not offered here, so this is the whole mechanism
      // behind "maintenance is quiet".
      ...monitoringAlertInputs(),
    });
    return send(res, 200, {
      at: new Date().toISOString(), alerts,
      counts: {
        critical: alerts.filter((x) => x.severity === 'critical').length,
        warning: alerts.filter((x) => x.severity === 'warning').length,
      },
      // Delivery status lives with the canonical providers now
      // (GET /api/notifications/providers) — /api/alerts carries the alerts.
    });
  }
  if (route === 'POST /api/alerts/ack') {
    const body = await jsonBody();
    const found = ackAlert(body?.id);
    if (!found) return send(res, 404, { error: 'no such active alert' });
    return send(res, 200, { ok: true, alert: found });
  }

  // ---------- provider health ----------
  if (route === 'GET /api/providers') {
    return send(res, 200, providerHealthDoc());
  }

  // ---------- search ----------
  if (route === 'GET /api/search') {
    // the actor shapes which operations are offered at all — a viewer's palette is quieter
    const q = (url.searchParams.get('q') || '').slice(0, 80);
    return send(res, 200, {
      query: q,
      results: await searchAll(q, { newsItems: lastNews.items || [], actor: session?.username ?? null }),
    });
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
    // The text is returned whether or not it is enabled: this is the editor's read, and an editor
    // that cannot show a file it is asked to edit is not an editor. Nothing here is a secret —
    // theme.css and app.js are files the operator writes by hand.
    return send(res, 200, {
      cssEnabled: !!s.advanced?.customCss,
      jsEnabled: !!s.advanced?.customJs,
      css: readConfigText('theme.css') ?? '',
      js: readConfigText('app.js') ?? '',
      cssModified: fileMtime('theme.css'),
      jsModified: fileMtime('app.js'),
      jsPresent: fs.existsSync(path.join(CONFIG_DIR, 'app.js')),
    });
  }
  if (route === 'PUT /api/custom') {
    const b = await jsonBody();
    // Custom code is the one configuration area where a syntax error is *visible* and a bad save
    // is *invisible until reload* — so it is linted here, and a refusal writes nothing at all.
    const problems = [];
    if (typeof b.css === 'string') {
      if (Buffer.byteLength(b.css, 'utf8') > LIMITS.cssBytes) problems.push(`theme.css exceeds the ${Math.round(LIMITS.cssBytes / 1024)} KB cap`);
      else { const lint = lintCss(b.css); if (!lint.ok) problems.push(`theme.css: ${lint.problems[0]}`); }
    }
    if (typeof b.js === 'string') {
      if (Buffer.byteLength(b.js, 'utf8') > LIMITS.jsBytes) problems.push(`app.js exceeds the ${Math.round(LIMITS.jsBytes / 1024)} KB cap`);
      else { const lint = lintJs(b.js); if (!lint.ok) problems.push(`app.js: ${lint.problems[0]}`); }
    }
    if (problems.length) return send(res, 400, { error: problems.join('; '), code: 'custom_syntax', problems });
    if (typeof b.css === 'string') writeText('theme.css', b.css);
    if (typeof b.js === 'string') writeText('app.js', b.js);
    recordVersion({ reason: 'custom.updated', subject: 'theme.css / app.js', label: 'custom code updated', actor: session?.username });
    logEvent({ source: 'config', type: 'custom.updated', subject: 'theme.css / app.js', message: 'custom code updated' });
    return send(res, 200, { ok: true, cssModified: fileMtime('theme.css'), jsModified: fileMtime('app.js') });
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

  // =========================================================================
  // Phase 6 — configuration: scope, drafts, history, migration, export
  // =========================================================================
  //
  // Everything below writes *presentation* configuration only. There is no route here that can
  // reach the Docker socket, run a command, or touch authentication/runtime state — see
  // server/configScope.js for the boundary, which is a list rather than a convention.

  // ---------- the boundary, stated ----------
  if (route === 'GET /api/config/scope') return send(res, 200, configScopeDoc());

  /** What Settings → Configuration shows at the top: what can change, and what the last change was. */
  if (route === 'GET /api/config/overview') {
    const s = model.getSettings();
    const services = model.readServices();
    const bookmarks = model.readBookmarks();
    const layout = model.getLayout();
    const inv = await model.getInventory();
    const stats = configHistory.historyStats();
    return send(res, 200, {
      scope: configScopeDoc(),
      counts: {
        groups: (inv.groupsRaw || []).length,
        services: inv.services.length,
        configured: inv.services.filter((x) => x.configured).length,
        bookmarks: bookmarks.flat.length,
        widgets: (layout.hub.widgets || []).length,
        unmatched: inv.unmatched.length,
      },
      custom: {
        cssEnabled: !!s.advanced?.customCss,
        jsEnabled: !!s.advanced?.customJs,
        cssBytes: Buffer.byteLength(readConfigText('theme.css') || '', 'utf8'),
        jsBytes: Buffer.byteLength(readConfigText('app.js') || '', 'utf8'),
        cssModified: fileMtime('theme.css'),
        jsModified: fileMtime('app.js'),
      },
      history: stats,
      limits: LIMITS,
    });
  }

  /**
   * Draft validation. Every editor posts here before it saves, so "will this be accepted?" has one
   * answer rather than one per screen. Nothing is written: a rejection returns the reason and the
   * caller keeps the draft.
   */
  if (route === 'POST /api/config/validate') {
    const body = await jsonBody();
    const area = String(body?.area || '');
    if (area === 'custom-css') {
      const lint = lintCss(body?.draft ?? '');
      return send(res, 200, { ok: lint.ok, area, problems: lint.problems });
    }
    if (area === 'custom-js') {
      const lint = lintJs(body?.draft ?? '');
      return send(res, 200, { ok: lint.ok, area, problems: lint.problems });
    }
    // The YAML/JSON editors validate by *trying the write against a copy of the model*. The model
    // functions are pure up to their final write, so the honest way to know whether a document is
    // acceptable is to run the same normalisation the write would, and discard the result.
    try {
      if (area === 'services') { model.validateServicesDraft(body?.draft); return send(res, 200, { ok: true, area, problems: [] }); }
      if (area === 'stacks') { model.validateStacksDraft(body?.draft); return send(res, 200, { ok: true, area, problems: [] }); }
      if (area === 'bookmarks') { model.validateBookmarksDraft(body?.draft); return send(res, 200, { ok: true, area, problems: [] }); }
      if (area === 'layout') { model.normalizeLayoutDraft(body?.draft); return send(res, 200, { ok: true, area, problems: [] }); }
      if (area === 'settings') { model.validateSettingsDraft(body?.draft); return send(res, 200, { ok: true, area, problems: [] }); }
    } catch (err) {
      return send(res, 200, { ok: false, area, problems: [err.message], code: err.code || 'invalid_config' });
    }
    return send(res, 400, { error: `unknown validation area: ${area || '(none)'}`, code: 'unknown_area' });
  }

  // ---------- history: list, read, diff, restore ----------
  if (route === 'GET /api/config/history') {
    const versions = configHistory.listVersions();
    return send(res, 200, {
      versions,
      stats: configHistory.historyStats(),
      current: versions[0]?.id ?? null,
      scope: presentationFileNames(),
    });
  }
  const histVersion = p.match(/^\/api\/config\/history\/([^/]+)$/);
  if (method === 'GET' && histVersion) {
    const v = configHistory.readVersion(decodeURIComponent(histVersion[1]));
    if (!v) return send(res, 404, { error: 'no such configuration version', code: 'version_not_found' });
    return send(res, 200, {
      id: v.id, at: v.at, reason: v.reason, subject: v.subject, label: v.label, actor: v.actor,
      checksum: v.checksum, changed: v.changed || [],
      files: Object.entries(v.files || {}).map(([name, text]) => ({ name, bytes: Buffer.byteLength(text, 'utf8') })),
    });
  }
  const histDiff = p.match(/^\/api\/config\/history\/([^/]+)\/diff$/);
  if (method === 'GET' && histDiff) {
    const id = decodeURIComponent(histDiff[1]);
    const version = configHistory.readVersion(id);
    if (!version) return send(res, 404, { error: 'no such configuration version', code: 'version_not_found' });
    // "against" defaults to *now*: the common question is "what would restoring this change?".
    const against = url.searchParams.get('against');
    const other = against && against !== 'current' ? configHistory.readVersion(against) : null;
    const otherFiles = other ? other.files : configHistory.snapshotFiles();
    // diff(from = other, to = version) reads as "restoring this would…"
    const diff = configHistory.diffSnapshots(otherFiles || {}, version.files || {});
    return send(res, 200, {
      version: id,
      against: other ? other.id : 'current',
      ...diff,
    });
  }
  const histRestore = p.match(/^\/api\/config\/history\/([^/]+)\/restore$/);
  if (method === 'POST' && histRestore) {
    const id = decodeURIComponent(histRestore[1]);
    const result = configHistory.restoreVersion(id, { actor: session?.username || null });
    model.invalidateDiscovery();
    logEvent({ source: 'config', type: 'config.restored', subject: id, message: `configuration restored from ${result.restoredFrom} (${result.files.length} file(s))` });
    return send(res, 200, { ...result, overview: await model.getDiscoveryStatus({ refreshMs: 0 }) });
  }
  const histDelete = p.match(/^\/api\/config\/history\/([^/]+)$/);
  if (method === 'DELETE' && histDelete) {
    const id = decodeURIComponent(histDelete[1]);
    const pathToDelete = path.join(configHistory.historyDir(), `${id.replace(/[^0-9A-Za-z-]/g, '')}.json`);
    if (!fs.existsSync(pathToDelete)) return send(res, 404, { error: 'no such configuration version', code: 'version_not_found' });
    fs.unlinkSync(pathToDelete);
    logEvent({ source: 'config', type: 'config.history_pruned', subject: id, message: 'configuration version removed' });
    return send(res, 200, { ok: true, removed: id, stats: configHistory.historyStats() });
  }

  // ---------- migration: what can be imported ----------
  if (route === 'GET /api/config/import/files') {
    return send(res, 200, {
      accepted: Object.entries(HOMEPAGE_FILES).map(([name, spec]) => ({ name, kind: spec.kind, label: spec.label })),
      refused: Object.entries(REFUSED_FILES).map(([name, why]) => ({ name, why })),
      note: 'Imported files are parsed, validated and shown for review. Nothing is written until you apply.',
      limits: {
        fileBytes: LIMITS.importFileBytes,
        bundleBytes: LIMITS.importBundleBytes,
        files: LIMITS.importFiles,
        depth: LIMITS.yamlDepth,
        nodes: LIMITS.yamlNodes,
      },
    });
  }

  /**
   * Parse + classify → the review screen. Deliberately writes nothing: calling it is free, and
   * the user can paste a config, look at what it would do, and close the page.
   */
  if (route === 'POST /api/config/import/parse') {
    const body = await jsonBody();
    const files = body?.files && typeof body.files === 'object' ? body.files : null;
    if (!files) return send(res, 400, { error: 'files must be an object of { filename: text }', code: 'files_required' });
    const inv = await model.getInventory();
    const { bundle, report } = parseHomepageBundle(files, {
      widgetTypes: Object.keys(model.widgetTypes()),
      suggestIcon: model.suggestIconProbe,
    });
    const preview = buildImportPreview({ bundle, report, inventory: publicInventoryForImport(inv), existingOverlays: existingOverlayIndex() });
    // The write plan is included so the screen can show *exactly* which files would change.
    const plan = planImport({ preview, rawDecisions: body?.decisions, current: currentConfiguration(), makeWidget });
    return send(res, 200, {
      ...preview,
      plan: {
        files: plannedFiles(plan),
        services: plannedServiceEntries(plan),
        bookmarks: plannedBookmarkEntries(plan),
        preservedUnmatched: plan.bookmarks?.preserved || 0,
        settings: plan.settings ? Object.keys(plan.settings) : [],
        widgets: plan.layout?.hub?.widgets?.length || 0,
        custom: plan.custom.problems,
      },
    });
  }

  /**
   * Apply. The files are re-sent and re-parsed rather than looked up in a server-side preview
   * cache, so what is applied is what was reviewed *in this request* — there is no window in which
   * a stale preview could be applied to a configuration that has since changed underneath it.
   */
  if (route === 'POST /api/config/import/apply') {
    const body = await jsonBody();
    const files = body?.files && typeof body.files === 'object' ? body.files : null;
    if (!files) return send(res, 400, { error: 'files must be an object of { filename: text }', code: 'files_required' });
    const mode = body?.mode === 'replace' ? 'replace' : 'merge';
    const inv = await model.getInventory();
    const { bundle, report } = parseHomepageBundle(files, {
      widgetTypes: Object.keys(model.widgetTypes()),
      suggestIcon: model.suggestIconProbe,
    });
    const preview = buildImportPreview({ bundle, report, inventory: publicInventoryForImport(inv), existingOverlays: existingOverlayIndex() });
    const plan = planImport({ preview, rawDecisions: body?.decisions, current: currentConfiguration(), makeWidget, mode });

    const commit = commitPlan({
      plan,
      read: (name) => readConfigText(name),
      write: writeConfigTarget,
      snapshot: configHistory.snapshot,
      actor: session?.username || null,
      reason: 'import',
    });

    model.invalidateDiscovery();
    logEvent({
      source: 'config',
      type: 'config.imported',
      subject: 'homepage',
      message: `${commit.written.length} file(s) from ${bundle.source} import: ${preview.summary.matched} matched, ${preview.summary.unmatched} unmatched, ${plan.bookmarks?.preserved || 0} kept as links`,
    });
    return send(res, 200, {
      ok: true,
      mode,
      written: commit.written,
      version: commit.version,
      summary: preview.summary,
      preservedUnmatched: plan.bookmarks?.preserved || 0,
      skipped: preview.summary.invalid,
      warnings: [...preview.warnings, ...plan.custom.problems],
      secretsDropped: preview.secretsDropped.length,
    });
  }

  // ---------- export ----------
  if (route === 'GET /api/config/export') {
    const format = (url.searchParams.get('format') || 'native').toLowerCase();
    const includeParam = url.searchParams.get('include');
    const include = includeParam ? includeParam.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const bundle = await configExportInputs({ include });
    const result = format === 'homepage' ? exportHomepage(bundle) : exportNative(bundle);
    logEvent({ source: 'config', type: 'config.exported', subject: result.kind, message: `${Object.keys(result.files).length} file(s) exported as ${result.kind}` });
    return send(res, 200, result);
  }
  if (route === 'GET /api/config/export/download') {
    const format = (url.searchParams.get('format') || 'native').toLowerCase();
    const bundle = await configExportInputs({});
    const result = format === 'homepage' ? exportHomepage(bundle) : exportNative(bundle);
    // An export is a set of files; served as one JSON document so a browser download is a single
    // artifact. `?file=` picks one out for copy-paste into a real config/ directory.
    const wanted = url.searchParams.get('file');
    if (wanted) {
      const text = result.files[wanted];
      if (text == null) return send(res, 404, { error: `that export has no file named ${wanted}` });
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${wanted.replace(/[^A-Za-z0-9._-]/g, '')}"`);
      res.writeHead(200);
      return res.end(text);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="opushub-${result.kind}-${stamp}.json"`);
    res.writeHead(200);
    return res.end(JSON.stringify(result, null, 2));
  }

  // ---------- one service's presentation: detected vs override ----------
  //
  // The editor's whole job is to keep those two apart, so the API keeps them apart too rather than
  // handing the client one merged blob and trusting the UI to remember which half was which.
  const presMatch = p.match(/^\/api\/services\/([^/]+)\/([^/]+)\/presentation$/);
  if (presMatch) {
    const group = decodeURIComponent(presMatch[1]);
    const name = decodeURIComponent(presMatch[2]);
    const inv = await model.getInventory();
    const found = resolveServiceContainer(inv, group, name);
    if (!found) return send(res, 404, { error: `no live container for: ${group}/${name}` });
    const { service, ref } = found;

    if (method === 'GET') {
      const overlay = model.readServices().overlays.find((o) =>
        (o.container && (o.container.toLowerCase() === service.name.toLowerCase() || ref.startsWith(o.container)))
        || (!o.container && o.name.toLowerCase() === service.name.toLowerCase()));
      return send(res, 200, {
        id: service.id,
        identity: {
          /* discovered facts — read-only, and the UI must render them as such */
          containerName: service.container?.name || service.name,
          composeProject: service.container?.composeProject || null,
          composeService: service.container?.composeService || null,
          image: service.container?.image || null,
          state: service.container?.state || null,
          labels: service.container?.labels || null,
        },
        detected: {
          displayName: service.baseDisplayName || service.name,
          group: service.baseGroup || 'Other',
          url: service.detectedUrl ?? null,
          urlSource: service.detectedUrlSource ?? null,
          icon: service.iconSuggestion || null,
        },
        override: {
          displayName: overlay?.displayName ?? null,
          description: overlay?.description ?? null,
          icon: overlay?.icon ?? null,
          group: overlay?.group ?? null,
          url: overlay?.url ?? null,
          hidden: overlay?.hidden === true,
          showOnHub: overlay?.showOnHub !== false,
          order: overlay?.order ?? null,
          app: overlay?.app ?? null,
          keywords: overlay?.keywords || [],
        },
        effective: {
          displayName: service.displayName,
          group: service.group,
          url: service.url,
          urlSource: service.urlSource,
          icon: service.icon,
          status: service.status,
        },
        configured: !!service.configured,
      });
    }

    if (method === 'PUT') {
      const draft = await jsonBody();
      const next = model.putServicePresentation({
        group, name, ref, service, draft, actor: session?.username || null,
      });
      model.invalidateDiscovery();
      recordVersion({ reason: 'service.presentation', subject: service.name, label: `presentation for "${service.displayName}"`, actor: session?.username });
      logEvent({ source: 'config', type: 'services.updated', subject: service.name, message: `presentation for “${service.displayName}” updated` });
      return send(res, 200, next);
    }
    if (method === 'DELETE') {
      const next = model.clearServicePresentation({ service, ref, actor: session?.username || null });
      model.invalidateDiscovery();
      recordVersion({ reason: 'service.presentation_cleared', subject: service.name, label: `overrides cleared for "${service.displayName}"`, actor: session?.username });
      logEvent({ source: 'config', type: 'services.updated', subject: service.name, message: `presentation overrides for “${service.displayName}” cleared — detected values are back in force` });
      return send(res, 200, next);
    }
  }

  // ---------- groups: first-class, and explicitly not compose projects ----------
  if (route === 'GET /api/groups') {
    const inv = await model.getInventory();
    const layout = model.getLayout();
    const servicesDoc = model.readServices();
    const meta = new Map(servicesDoc.groups.map((g) => [String(g.name).toLowerCase(), g]));
    const hidden = new Set((layout.services?.hiddenGroups || []).map((g) => String(g).toLowerCase()));
    return send(res, 200, {
      groups: (inv.groupsRaw || []).map((g) => ({
        name: g.name,
        description: meta.get(g.name.toLowerCase())?.description ?? null,
        icon: meta.get(g.name.toLowerCase())?.icon ?? null,
        configured: !!meta.has(g.name.toLowerCase()),
        hidden: hidden.has(g.name.toLowerCase()),
        serviceCount: g.services.length,
        running: g.services.filter((s) => s.container?.state === 'running').length,
        // Said in the payload, not only in the copy: a group is a label, not a compose project.
        composeProjects: [...new Set(g.services.map((s) => s.container?.composeProject).filter(Boolean))],
      })),
      order: layout.services?.groupOrder || null,
      hiddenGroups: layout.services?.hiddenGroups || [],
      // Groups the overlays name but no container fills — reported, never rendered as empty cards.
      empty: servicesDoc.groups.filter((g) => !g.services.length).map((g) => g.name),
      note: 'OpusHub groups are a presentation label you choose. They are not Docker Compose projects — a group may contain services from several projects, and a project may span several groups.',
    });
  }
  if (route === 'PUT /api/groups') {
    const body = await jsonBody();
    // A group that exists only because Docker reported a compose project has no entry in
    // `services.yaml`, so "rename it" has to become per-service `group:` overrides — which is
    // exactly the right statement of the rule: configuration decides presentation, and it decides
    // it *about containers*, not about a project.
    const inv = await model.getInventory();
    const membership = new Map((inv.groupsRaw || []).map((g) => [g.name, g.services.map((x) => x.name)]));
    const next = model.writeGroups(body, { membership });
    model.invalidateDiscovery();
    recordVersion({ reason: 'groups.updated', subject: 'services.yaml + layout.json', label: `${next.groups.length} group(s)`, actor: session?.username });
    logEvent({ source: 'config', type: 'services.updated', subject: 'services.yaml', message: `groups updated: ${next.groups.length} group(s)` });
    return send(res, 200, next);
  }

  // ---------- custom CSS / JS: enable, disable, reset ----------
  if (route === 'POST /api/custom/reset') {
    const body = await jsonBody();
    const which = String(body?.file || '');
    if (which === 'theme.css') { writeText('theme.css', ''); recordVersion({ reason: 'custom.reset', subject: 'theme.css', label: 'custom CSS reset', actor: session?.username }); logEvent({ source: 'config', type: 'custom.updated', subject: 'theme.css', message: 'custom CSS reset' }); return send(res, 200, { ok: true, file: 'theme.css', bytes: 0 }); }
    if (which === 'app.js') { writeText('app.js', ''); recordVersion({ reason: 'custom.reset', subject: 'app.js', label: 'custom JS reset', actor: session?.username }); logEvent({ source: 'config', type: 'custom.updated', subject: 'app.js', message: 'custom JS reset' }); return send(res, 200, { ok: true, file: 'app.js', bytes: 0 }); }
    return send(res, 400, { error: 'file must be theme.css or app.js', code: 'bad_file' });
  }

  // ---------- export helpers ----------

  notFound();
}

/**
 * The plan's documents are nullable, and null means "this file is not part of the change" rather
 * than "an empty document". Every counter that reads the plan goes through these two, so a file the
 * import does not touch is never reported as a write of zero entries.
 */
function plannedServiceEntries(plan) {
  return (plan?.services?.groups || []).reduce((a, g) => a + (g.services || []).length, 0);
}
function plannedBookmarkEntries(plan) {
  return (plan?.bookmarks?.groups || []).reduce((a, g) => a + (g.items || []).length, 0);
}

/** `configExportInputs` gathers every presentation document in the shape the exporters expect. */
async function configExportInputs({ include = null } = {}) {
  const services = model.readServices();
  const stacks = model.readStacks();
  const bookmarks = model.readBookmarks();
  return {
    services: {
      groups: services.groups.map((g) => ({
        name: g.name,
        description: g.description,
        icon: g.icon,
        services: g.services.map((s) => ({
          container: s.container || null,
          name: s.name,
          displayName: s.displayName,
          app: s.app,
          description: s.description,
          icon: s.icon,
          group: s.group,
          order: s.order,
          hidden: s.hidden,
          showOnHub: s.showOnHub,
          keywords: s.keywords,
          url: s.url,
        })),
      })),
    },
    stacks: { stacks: stacks.stacks },
    bookmarks,
    settings: model.getSettings(),
    layout: model.getLayout(),
    custom: { css: readConfigText('theme.css'), js: readConfigText('app.js') },
    include,
  };
}

/** Which files a plan would touch — used by the review screen's "this will change" list. */
function plannedFiles(plan) {
  const files = [];
  if (plan.services) files.push({ name: 'services.yaml', entries: plannedServiceEntries(plan) });
  if (plan.bookmarks) files.push({ name: 'bookmarks.yaml', entries: plannedBookmarkEntries(plan) });
  if (plan.settings) files.push({ name: 'settings.yaml', entries: Object.keys(plan.settings).length });
  if (plan.layout) files.push({ name: 'layout.json', entries: plan.layout.hub?.widgets?.length || 0 });
  if (plan.custom?.css != null) files.push({ name: 'theme.css', entries: 1 });
  if (plan.custom?.js != null) files.push({ name: 'app.js', entries: 1 });
  return files;
}

/** The slice of the inventory the importer is allowed to see — identity, never raw labels. */
function publicInventoryForImport(inv) {
  return {
    live: inv.live,
    services: inv.services.map((s) => ({
      id: s.id,
      name: s.name,
      displayName: s.displayName,
      group: s.group,
      url: s.url,
      urlSource: s.urlSource,
      kind: s.kind,
      container: s.container ? {
        id: s.container.id, name: s.container.name,
        composeService: s.container.composeService, project: s.container.project,
        image: s.container.image, state: s.container.state,
      } : null,
    })),
  };
}

/** Existing presentation overlays, indexed the two ways an imported entry can bind to one. */
function existingOverlayIndex() {
  const map = new Map();
  for (const o of model.readServices().overlays) {
    if (o.container) map.set(String(o.container).toLowerCase(), o);
    if (o.name) map.set(String(o.name).toLowerCase(), o);
  }
  return map;
}

/** Everything an import can read and rewrite, in the shape the planner expects. */
function currentConfiguration() {
  const services = model.readServices();
  return {
    services: {
      groups: services.groups.map((g) => ({
        name: g.name,
        ...(g.description ? { description: g.description } : {}),
        ...(g.icon ? { icon: g.icon } : {}),
        services: g.services.map((s) => ({
          container: s.container || undefined,
          name: s.name,
          ...(s.displayName ? { displayName: s.displayName } : {}),
          ...(s.description ? { description: s.description } : {}),
          ...(s.icon ? { icon: s.icon } : {}),
          ...(s.group ? { group: s.group } : {}),
          ...(s.url ? { url: s.url } : {}),
          ...(s.hidden ? { hidden: true } : {}),
          ...(s.showOnHub === false ? { showOnHub: false } : {}),
          ...(s.order != null ? { order: s.order } : {}),
        })),
      })),
    },
    bookmarks: { groups: model.readBookmarks().groups },
    layout: model.getLayout(),
  };
}

/**
 * The single write function the commit path uses.
 *
 * Dispatched on the **filename**, never on an abstract content kind. That distinction is load
 * bearing: `services.yaml` and `bookmarks.yaml` are both "yaml" and both carry a `groups:` key,
 * but they are written by different normalisers, and routing one through the other's writer
 * produces a perfectly valid document containing none of the data. Naming the file leaves no room
 * for that class of mistake.
 */
const TARGET_WRITERS = {
  'services.yaml': (value) => model.writeServices(value),
  'bookmarks.yaml': (value) => model.writeBookmarks(value),
  'stacks.yaml': (value) => model.writeStacks(value),
  // settings and layout arrive from the planner as *patches*, so they merge into what is there
  // rather than replacing it — an import carries the settings it understood, not a whole document.
  'settings.yaml': (value) => model.putSettings(value),
  'layout.json': (value) => model.putLayout(value),
  'theme.css': (value) => writeText('theme.css', String(value ?? '')),
  'app.js': (value) => writeText('app.js', String(value ?? '')),
};

function writeConfigTarget(name, value, _kind, opts = {}) {
  if (opts.raw) {
    // rollback path: put the exact previous bytes back, whatever the file is
    if (value == null) return { file: name };
    return writePresentationText(name, value);
  }
  const writer = TARGET_WRITERS[name];
  if (!writer) throw Object.assign(new Error(`${name} is not a writable configuration file`), { status: 400, code: 'scope_violation' });
  return writer(value);
}

/**
 * Record a configuration version after a successful write.
 *
 * Called *after* the write, never before, and never allowed to fail it: a user's settings save must
 * not break because history bookkeeping could not get a file descriptor. Returns the version
 * record (or null when the snapshot was a duplicate), so routes that offer an undo can name it.
 */
function recordVersion({ reason, subject, label, actor = null, force = false }) {
  return configHistory.snapshot({ reason, subject, label, actor, force });
}

/** Last-modified time of a config file, for the custom-code panel. */
function fileMtime(name) {
  try {
    const file = path.join(CONFIG_DIR, name);
    return fs.statSync(file).mtime.toISOString();
  } catch { return null; }
}

/** What this install calls itself. Falls back to the product name if settings.yaml has no app.name
 *  (or cannot be read) — never an empty string in a response. */
function appName() {
  try {
    const v = model.getSettings()?.app?.name;
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : 'OpusHub';
  } catch { return 'OpusHub'; }
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
  const inv = await model.getInventory();
  // Why each container has, or has not, a browser URL — aggregated by the resolver's own reason
  // codes (`urlResolver.URL_REASONS`). Counts only: the wizard can explain the shape of this host
  // before an account exists without naming a single container, image or URL.
  const byReason = new Map();
  for (const svc of inv.services) {
    const code = svc.urlReason || (svc.url ? svc.urlSource : 'no-route');
    const row = byReason.get(code) || { code, count: 0, explain: URL_REASONS[code] || null, resolved: false };
    row.count += 1;
    row.resolved = row.resolved || !!svc.url;
    byReason.set(code, row);
  }
  const reasons = [...byReason.values()].sort((a, b) => Number(b.resolved) - Number(a.resolved) || b.count - a.count);
  return {
    docker: {
      ok: s.engine.ok,
      state: s.engine.state,
      version: s.engine.version,
      // the API version OpusHub actually speaks to the daemon (min(daemon, 1.43)) — not the product version
      apiVersion: s.engine.api,
      operatingSystem: s.engine.operatingSystem,
    },
    stacks: s.inventory.stacks,
    containers: s.engine.containers,
    running: s.engine.running,
    stopped: s.engine.stopped,
    services: s.inventory.applications,
    infrastructure: s.inventory.infrastructure,
    standalone: s.inventory.standalone,
    urls: {
      detected: s.urlDiscovery.withUrl,
      missing: s.urlDiscovery.withoutUrl,
      // every resolver tier that answered, so the wizard can show *how* URLs were found
      sources: s.urlDiscovery.sources,
      // and every reason a container has none, in categories (destination, count, explanation)
      reasons,
    },
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
    // The presentation step of the wizard, before an account exists.
    presentation: {
      detected: {
        // counts, not names: how many groups discovery would produce on its own
        groups: new Set(inv.services.map((x) => x.group).filter(Boolean)).size,
        services: inv.services.length,
        stacks: s.inventory.stacks,
      },
      // The composition a fresh install starts with — a constant, not this installation's layout
      // (which stays behind the auth gate).
      widgets: defaultWidgetCatalogue(),
      templates: templateCatalogue(),
    },
  };
}

/** `defaultWidgets()` as the same constant shape the template catalogue uses. */
function defaultWidgetCatalogue() {
  return defaultWidgets().map((w) => ({
    type: w.type, zone: w.zone, size: w.size, title: WIDGET_TYPES[w.type]?.title || w.type,
  }));
}

/**
 * The constant part of each template: what it arranges, never how it resolved here.
 * `model.getTemplates()` returns a real preview — computed against the live layout, so it carries
 * this install's group order — and that must stay behind the auth gate. These fields are template
 * literals and cannot vary with the installation, so they are safe to offer the wizard.
 */
function templateCatalogue() {
  // `groupNames: []` is the point: with no groups to resolve against, the preview cannot carry this
  // installation's group order, and only the template's own constants come back.
  return templateList({ groupNames: [] }).map((t) => ({
    id: t.id, name: t.name, tagline: t.tagline, description: t.description, spacing: t.spacing,
    widgets: t.widgets.map((x) => ({ type: x.type, zone: x.zone, size: x.size, title: x.title })),
  }));
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

/**
 * /api/v1/* → /api/* rewrite for the allowlisted canonical routes. Anything not listed passes
 * through untouched (and 404s as `no route`), so v1 can never accidentally expose a route that
 * was not deliberately versioned.
 */
const V1_ROUTES = new Set([
  '/host', '/docker', '/networks', '/volumes', '/images', '/storage', '/version', '/resources',
  '/services', '/stacks', '/system', '/discovery', '/providers',
  // Phase 9 — the OpusGrid infrastructure namespace (unversioned aliases work as before)
  '/infrastructure', '/infrastructure/providers', '/infrastructure/storage',
  '/infrastructure/storage/pool', '/infrastructure/storage/dataset', '/infrastructure/network',
  '/infrastructure/power', '/infrastructure/opnsense', '/infrastructure/topology',
  '/infrastructure/physical', '/infrastructure/provider',
  // Phase 8 — the canonical operations routes; the /:id and /:id/trail forms keep their v1
  // prefix because they are patterns, not fixed paths, and are matched by the handler itself.
  '/operations', '/operations/dry-run',
  // Phase 10B — events & notifications
  '/events', '/events/stream', '/events/stats',
  '/notifications', '/notifications/unread-count', '/notifications/stats',
  '/notifications/policy', '/notifications/providers', '/notifications/webhook',
  '/notifications/telegram',
  // Phase 10D — containers (the /:ref forms are patterns, matched by the handler itself)
  '/containers/spec-fields',
]);

export function rewriteV1(pathname) {
  if (!pathname.startsWith('/api/v1/')) return pathname;
  const rest = pathname.slice('/api/v1'.length);
  if (V1_ROUTES.has(rest)) return '/api' + rest;
  return pathname;
}
