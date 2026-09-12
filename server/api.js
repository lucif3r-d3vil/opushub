// /api — the only door between the browser and the infrastructure. Read-mostly by design;
// mutations write config files (atomically, validated). No shell, no Docker writes, no secrets.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, APP_ROOT, readConfigText, writeText } from './configStore.js';
import * as model from './model.js';
import { collect as collectSystem, History } from './providers/system.js';
import * as docker from './providers/docker.js';
import { getNews } from './providers/news.js';
import { getWeather, cToF } from './providers/weather.js';
import { getMarket } from './providers/market.js';
import { iconSvg, search as iconSearch, listLocalFiles } from './providers/icons.js';
import { logEvent, readEvents } from './activity.js';
import { searchAll } from './search.js';
import { loadEnv } from './env.js';
import { DATA_DIR } from './configStore.js';

export const history = new History({ intervalMs: 5000, samples: 720, file: path.join(DATA_DIR, 'metrics.json') });

let lastNews = { status: 'idle', items: [] };
let bootAt = Date.now();

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
  const jsonBody = async () => {
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

  // ---------- health & meta ----------
  if (route === 'GET /api/health') {
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
      env: { files: env.loaded.map((f) => ({ file: f.file, keys: f.keys, error: f.error || null })), note: 'values never leave the server' },
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
    const patch = await jsonBody();
    const next = model.putSettings(patch);
    logEvent({ source: 'config', type: 'settings.updated', subject: 'settings.yaml', message: summarizeSettingsPatch(patch) });
    return send(res, 200, next);
  }
  if (route === 'GET /api/settings/raw') {
    return send(res, 200, { file: 'settings.yaml', text: readConfigText('settings.yaml') || '' });
  }

  // ---------- layout ----------
  if (route === 'GET /api/layout') return send(res, 200, model.getLayout());
  if (route === 'PUT /api/layout') {
    const patch = await jsonBody();
    const next = model.putLayout(patch);
    logEvent({ source: 'config', type: 'layout.updated', subject: 'layout.json', message: layoutSummary(patch) });
    return send(res, 200, next);
  }

  // ---------- services & stacks ----------
  if (route === 'GET /api/services') return send(res, 200, await model.getServicesWithStatus());
  if (route === 'PUT /api/services') {
    const patch = await jsonBody();
    const next = model.writeServices(patch);
    const n = next.groups.reduce((a, g) => a + g.services.length, 0);
    logEvent({ source: 'config', type: 'services.updated', subject: 'services.yaml', message: `updated ${next.groups.length} group(s), ${n} service(s)` });
    return send(res, 200, await model.getServicesWithStatus());
  }
  const svcMatch = p.match(/^\/api\/services\/([^/]+)\/([^/]+)$/);
  if (method === 'GET' && svcMatch) {
    const group = decodeURIComponent(svcMatch[1]);
    const name = decodeURIComponent(svcMatch[2]);
    const data = await model.getServicesWithStatus();
    const service = model.findService(data, group, name);
    if (!service) return send(res, 404, { error: `service not found: ${group}/${name}` });
    // full stack projection (same shape as GET /api/stacks) so the UI gets members + status
    const stacksDoc = await handleStacksList();
    const stack = stacksDoc.stacks.find((s) =>
      (service.stack && s.name.toLowerCase() === service.stack.toLowerCase()) ||
      s.services.some((n) => n.toLowerCase() === service.name.toLowerCase())
    ) || null;
    let container = null, containerStats = null;
    const { containers } = await model.dockerContainers();
    const ref = service.container || containers?.find((c) => c.name === service.name || c.name.toLowerCase() === service.name.toLowerCase())?.name;
    if (ref && docker.availability().ok) {
      try {
        container = await docker.inspectContainer(ref);
        containerStats = await docker.containerStats(ref).catch(() => null);
      } catch { /* keep partial */ }
    }
    return send(res, 200, { service, stack, container, containerStats, dockerAvailable: docker.availability().ok });
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
    const { stacks } = model.readStacks();
    const { groups } = model.readServices();
    const { containers, reason } = await model.dockerContainers();
    const all = groups.flatMap((g) => g.services.map((s) => ({ ...s, group: g.name })));
    const out = stacks.map((st) => {
      const members = st.services.map((name) => all.find((s) => s.name === name)).filter(Boolean);
      const links = members.map((m) => {
        const linked = containers?.find((c) => (m.container && (c.name === m.container || c.id === m.container)) || c.name === m.name || c.name.toLowerCase() === m.name.toLowerCase() || c.labels?.service?.toLowerCase() === m.name.toLowerCase());
        return linked ? { container: linked, service: m.name } : { container: null, service: m.name };
      });
      const states = links.map((l) => l.container?.state || null);
      const hasUnknown = states.some((s) => s == null);
      const status = !containers ? 'unavailable'
        : states.length && states.every((s) => s === 'running') ? (hasUnknown ? 'degraded' : 'operational')
        : states.some((s) => s === 'running') ? 'degraded' : states.every((s) => s == null) ? 'unlinked' : 'attention';
      return {
        ...st,
        members: links.map((l, i) => ({
          service: members[i]?.name ?? l.service,
          icon: members[i]?.icon ?? null,
          group: members[i]?.group ?? null,
          href: members[i]?.href ?? null,
          container: l.container ? { name: l.container.name, id: l.container.id, state: l.container.state, status: l.container.status, health: l.container.health, image: l.container.image } : null,
        })),
        status,
        statusReason: !containers ? reason : null,
        containerCount: links.filter((l) => l.container).length,
      };
    });
    return send(res, 200, { stacks: out, live: !!containers, statusReason: reason });
  }
  const stMatch = p.match(/^\/api\/stacks\/([^/]+)$/);
  if (method === 'GET' && stMatch) {
    const name = decodeURIComponent(stMatch[1]);
    const data = await handleStacksList();
    const stack = data.stacks.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!stack) return send(res, 404, { error: `stack not found: ${name}` });
    // aggregate per-member container detail
    const members = await Promise.all(stack.members.map(async (m) => {
      if (!m.container || !docker.availability().ok) return { ...m, stats: null, ports: [], networks: [], mounts: [] };
      try {
        const [insp, stats] = [await docker.inspectContainer(m.container.name), await docker.containerStats(m.container.name).catch(() => null)];
        return { ...m, stats, ports: insp.ports, networks: insp.networks, mounts: insp.mounts, startedAt: insp.state.startedAt, restartCount: insp.restartCount, restartPolicy: insp.restartPolicy, entrypoint: insp.entrypoint, command: insp.command, created: insp.created, health: insp.state.health };
      } catch { return { ...m, stats: null, error: true }; }
    }));
    return send(res, 200, { ...stack, members, live: data.live, statusReason: data.statusReason });
  }
  if (route === 'PUT /api/stacks') {
    const patch = await jsonBody();
    const next = model.writeStacks(patch);
    logEvent({ source: 'config', type: 'stacks.updated', subject: 'stacks.yaml', message: `updated ${next.stacks.length} stack(s)` });
    return send(res, 200, next);
  }
  async function handleStacksList() {
    // internal reuse of the list handler logic
    const { stacks } = model.readStacks();
    const { groups } = model.readServices();
    const { containers, reason } = await model.dockerContainers();
    const all = groups.flatMap((g) => g.services.map((s) => ({ ...s, group: g.name })));
    const out = stacks.map((st) => {
      const members = st.services.map((n) => all.find((s) => s.name === n)).filter(Boolean);
      const links = members.map((m) => {
        const linked = containers?.find((c) => (m.container && (c.name === m.container || c.id === m.container)) || c.name === m.name || c.name.toLowerCase() === m.name.toLowerCase() || c.labels?.service?.toLowerCase() === m.name.toLowerCase());
        return { container: linked ? { name: linked.name, id: linked.id, state: linked.state, status: linked.status, health: linked.health, image: linked.image } : null, service: m.name, icon: m.icon ?? null, group: m.group ?? null, href: m.href ?? null };
      });
      const states = links.map((l) => l.container?.state ?? null);
      const status = !containers ? 'unavailable'
        : states.length && states.every((s) => s === 'running') ? 'operational'
        : states.some((s) => s === 'running') ? 'degraded' : states.every((s) => s == null) ? 'unlinked' : 'attention';
      return { ...st, members: links, status, statusReason: reason, containerCount: links.filter((l) => l.container).length };
    });
    return { stacks: out, live: !!containers, statusReason: reason };
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
  // ---------- docker passthrough (read-only projections) ----------
  if (route === 'GET /api/docker/status') return send(res, 200, await dockerAvailabilityCached(true));
  if (route === 'GET /api/docker/containers') {
    const a = docker.availability();
    if (!a.ok) return send(res, 200, { status: 'unavailable', reason: a.reason, containers: [] });
    try { return send(res, 200, { status: 'ok', containers: await docker.listContainers({ all: true }) }); }
    catch (err) { return send(res, 200, { status: 'error', reason: String(err.message), containers: [] }); }
  }
  const logsMatch = p.match(/^\/api\/docker\/containers\/([^/]+)\/logs$/);
  if (method === 'GET' && logsMatch) {
    const a = docker.availability();
    if (!a.ok) return send(res, 200, { status: 'unavailable', reason: a.reason, lines: [] });
    const tail = Math.min(500, Math.max(1, Number(url.searchParams.get('tail')) || 150));
    try { return send(res, 200, { status: 'ok', lines: await docker.logs(decodeURIComponent(logsMatch[1]), { tail }) }); }
    catch (err) { return send(res, 200, { status: 'error', reason: String(err.message), lines: [] }); }
  }

  // ---------- integrations ----------
  if (route === 'GET /api/news') {
    const s = model.getSettings();
    const r = await getNews(s.integrations?.news?.feeds || [], { limit: Number(url.searchParams.get('limit')) || 40 });
    lastNews = r;
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
    return send(res, 200, r);
  }
  if (route === 'GET /api/market') {
    const s = model.getSettings();
    return send(res, 200, await getMarket(s.integrations?.markets?.symbols || []));
  }

  // ---------- activity ----------
  if (route === 'GET /api/activity') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const source = url.searchParams.get('source') || null;
    const before = Number(url.searchParams.get('before')) || null;
    return send(res, 200, readEvents({ limit, source, before }));
  }

  // ---------- search ----------
  if (route === 'GET /api/search') {
    const q = url.searchParams.get('q') || '';
    return send(res, 200, { query: q, results: searchAll(q, { newsItems: lastNews.items || [] }) });
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

  // ---------- background images inventory ----------
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

let dockerAvailCache = { at: 0, value: null };
async function dockerAvailabilityCached(force = false) {
  if (!force && Date.now() - dockerAvailCache.at < 30_000 && dockerAvailCache.value) return dockerAvailCache.value;
  const a = docker.availability();
  let value;
  if (!a.ok) value = { ok: false, reason: a.reason };
  else {
    const p = await docker.probe();
    value = p.ok ? { ok: true, version: p.version, api: p.apiVersion } : { ok: false, reason: p.reason };
  }
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

function layoutSummary(patch) {
  const what = [];
  if (patch?.hub?.main || patch?.hub?.rail) what.push('hub order');
  if (patch?.hub?.hidden) what.push('visibility');
  if (patch?.hub?.sizes) what.push('sizes');
  if (patch?.services?.order || patch?.services?.groupOrder) what.push('service order');
  return `layout updated: ${what.join(', ') || 'fine-tuned'}`;
}

export function markBoot(t) { bootAt = t; }
