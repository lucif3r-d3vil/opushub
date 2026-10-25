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
import { CONFIG_DIR, APP_ROOT, readConfigText } from './configStore.js';
import * as auth from './auth.js';
import * as model from './model.js';
import { collect as collectSystem, History } from './providers/system.js';
import * as docker from './providers/docker.js';
import { URL_REASONS } from './urlResolver.js';
import { iconSvg, search as iconSearch, listLocalFiles } from './providers/icons.js';
import { logEvent, readEvents, firstEventAt } from './activity.js';
import { ackAlert, countRecentAuthFailures, refreshAlerts } from './alerts.js';
import { checkForUpdates, lastUpdateCheck, REPO_URL } from './updateCheck.js';
import { searchAll } from './search.js';
import { loadEnv } from './env.js';
import { DATA_DIR } from './configStore.js';
import { containerStatsShared } from './containerStats.js';
import { providerHealthDoc, reportProvider } from './providers/health.js';
import { defaultWidgets, WIDGET_TYPES } from './widgets.js';
import { templateList, templateIds } from './templates.js';
import { hostDocument } from './host.js';
import { handleOperations } from './operationsApi.js';
// Phase 10A — the monitoring surface (monitors, checks, incidents, engine health)
import { handleMonitoring } from './monitoringApi.js';
import { alertInputs as monitoringAlertInputs } from './monitoring/engine.js';
import { versionInfo } from './version.js';
// Phase 10B — live events & notifications
import { handleEvents, handleEventsSSE, isSSERoute } from './eventsApi.js';
import { handleNotifications } from './notificationsApi.js';
import { initEvents } from './events/index.js';
// Phase 10C — container recovery (Autoheal) & updates (Diun)
import { handleAutohealRoutes } from './autohealApi.js';
import { handleUpdatesRoutes } from './updatesApi.js';
import { handleContainersRoutes } from './containersApi.js';
import { handleStacksRoutes } from './stacksApi.js';
import { handleRegistriesRoutes } from './registriesApi.js';

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

export const history = new History({ intervalMs: 5000, file: path.join(DATA_DIR, 'metrics.json') });

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
  if (p.startsWith('/api/operations')) {
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
  // and a side-effect-free diff preview. Every write is an operation (POST /api/operations).
  if (p.startsWith('/api/containers')) {
    const handled = await handleContainersRoutes({
      p, method,
      send: (status, obj) => send(res, status, obj),
      jsonBody,
    });
    if (handled) return;
  }

  // ---------- managed stacks (Phase 10D-B) ----------
  // Compose documents as data: stored, validated, planned; deployed only through the operations
  // engine. Sits before the unversioned /api/stacks discovery routes so `/api/stacks/managed` and
  // the `/api/stacks/:id/<verb>` wrappers never fall through to the projection routes.
  if (p.startsWith('/api/stacks/')) {
    const handled = await handleStacksRoutes({
      p, method,
      send: (status, obj) => send(res, status, obj),
      jsonBody,
      actor: session?.username ?? null,
      sessionId: activeToken ? auth.sessionHandle(activeToken) : null,
    });
    if (handled) return;
  }

  // ---------- registries (Phase 10D-C) ----------
  // Credentials are stored encrypted and never returned; remote calls are the five fixed shapes
  // of registries/client.js against a validated endpoint. Pulls are operations, not routes here.
  if (p.startsWith('/api/registries')) {
    const handled = await handleRegistriesRoutes({
      p, method,
      send: (status, obj) => send(res, status, obj),
      jsonBody,
      actor: session?.username ?? null,
      query: url.searchParams,
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
      await model.applyLayoutTemplate(template);
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
    const patch = await jsonBody();
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
        // stats are shared: one Docker call per interval no matter how many UI elements ask
        containerStats = await containerStatsShared(ref);
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
  const svcSub = p.match(/^\/api\/services\/([^/]+)\/([^/]+)\/(stats|logs|history|health)$/);
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
      const stats = await containerStatsShared(ref);
      return send(res, 200, { status: stats ? 'ok' : 'unavailable', stats, at: Date.now() });
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
    const bmCount = next.groups.reduce((a, g) => a + g.items.length, 0);
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
    const ms = Math.min(7 * 24 * 3600_000, Math.max(60_000, Number(url.searchParams.get('window')) || 3600_000));
    const points = history.window(ms);
    const body = JSON.stringify({ window: ms, stepMs: history.stepMs(ms), points });
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
    return send(res, 200, await hostDocument({ inventory: inv }));
  }
  if (route === 'GET /api/networks') {
    const infra = await model.getInfra();
    return send(res, 200, {
      at: infra.at, live: infra.live, statusReason: infra.statusReason,
      code: infra.live ? null : 'docker_unavailable',
      networks: infra.networks, count: infra.counts.networks, stale: infra.stale,
    });
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
    const [servicesView, stacksDoc, system] = await Promise.all([
      model.getServicesView().catch(() => null),
      model.getStacksDoc().catch(() => null),
      collectSystem().catch(() => null),
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
      results: await searchAll(q, { actor: session?.username ?? null }),
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

  // =========================================================================
  // Configuration drafts
  // =========================================================================
  //
  // Everything below writes *presentation* configuration only. There is no route here that can
  // reach the Docker socket, run a command, or touch authentication/runtime state.

  /**
   * Draft validation. Every editor posts here before it saves, so "will this be accepted?" has one
   * answer rather than one per screen. Nothing is written: a rejection returns the reason and the
   * caller keeps the draft.
   */
  if (route === 'POST /api/config/validate') {
    const body = await jsonBody();
    const area = String(body?.area || '');
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
        logEvent({ source: 'config', type: 'services.updated', subject: service.name, message: `presentation for “${service.displayName}” updated` });
      return send(res, 200, next);
    }
    if (method === 'DELETE') {
      const next = model.clearServicePresentation({ service, ref, actor: session?.username || null });
      model.invalidateDiscovery();
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
    logEvent({ source: 'config', type: 'services.updated', subject: 'services.yaml', message: `groups updated: ${next.groups.length} group(s)` });
    return send(res, 200, next);
  }

  notFound();
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
  else value = docker.publicStatus(await docker.probeUsable());
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
