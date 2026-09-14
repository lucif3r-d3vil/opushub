// OpusHub server — plain Node HTTP: /api plus the built SPA. Single process, LAN tool.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { APP_ROOT, loadEnv, resolveConfigDir } from './env.js';
import { handleApi, markBoot, history } from './api.js';
import { logEvent } from './activity.js';
import * as docker from './providers/docker.js';
import { reportProvider } from './providers/health.js';
import { DATA_DIR, CONFIG_DIR } from './configStore.js';

// ---- 1. environment & config discovery (first thing, always) ----
const { dir: configDir } = resolveConfigDir();
const envReport = loadEnv(configDir);

const PORT = Number(process.env.OPUSHUB_PORT || process.env.PORT || 3000);
const HOST = process.env.OPUSHUB_HOST || '0.0.0.0';
const DIST = path.join(APP_ROOT, 'dist');

console.log('┌──────────────────────────────────────────────────────────────');
console.log('│ OpusHub v0.1.0');
console.log(`│ config dir : ${configDir}`);
if (envReport.loaded.length) {
  for (const f of envReport.loaded) console.log(`│ env file   : ${f.file} (${f.keys.length} key${f.keys.length === 1 ? '' : 's'}${f.error ? ', ERROR: ' + f.error : ''})`);
} else {
  console.log('│ env file   : none found (tried: ' + envReport.tried.join(', ') + ')');
}
{
  // what discovery will be able to say — printed once at boot, because an empty Services page
  // with no explanation is the exact confusion this whole subsystem exists to avoid
  const ep = docker.resolveEndpoint();
  const where = ep?.socket ? `socket ${ep.socket}` : ep?.host ? `tcp ${ep.host}:${ep.port}` : 'no socket configured';
  const a = docker.availability();
  console.log(`│ discovery  : ${a.ok ? 'Docker connected' : `Docker ${a.state}`} — ${where}`);
  if (!a.ok) console.log('│              services will be listed as discovered-but-no-engine; fix in the environment or Settings → System');
}
console.log('└──────────────────────────────────────────────────────────────');

// ---- static serving ----
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

function serveFile(res, file, { immutable = false, noCache = false } = {}) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    const etag = `W/"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`;
    res.setHeader('etag', etag);
    res.setHeader('cache-control', noCache ? 'no-cache' : immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
    res.setHeader('content-type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.writeHead(200, { 'content-length': st.size });
    fs.createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function safeJoin(root, rel) {
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root + path.sep) && full !== root) return null;
  return full;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = decodeURIComponent(url.pathname);

  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', [
    "default-src 'self'",
    // 'sha256-…' is the hash of the small pre-hydration theme script in index.html —
    // if that script changes, recompute: node -e "…" (see docs/03-design-system.md)
    "script-src 'self' 'sha256-wV7KrfbxQ7GQ61LOA7WeOy66fhFZ28qCHefeeuHPRDY='",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; '));

  try {
    if (p.startsWith('/api/')) return await handleApi(req, res, url);

    // user-config static assets
    if (p.startsWith('/user/icons/')) {
      if (serveFile(res, safeJoin(path.join(CONFIG_DIR, 'icons'), p.slice('/user/icons/'.length)))) return;
    } else if (p.startsWith('/user/backgrounds/')) {
      if (serveFile(res, safeJoin(path.join(CONFIG_DIR, 'backgrounds'), p.slice('/user/backgrounds/'.length)))) return;
    } else if (p === '/user/theme.css') {
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('content-type', 'text/css; charset=utf-8');
      try { res.end(fs.readFileSync(path.join(CONFIG_DIR, 'theme.css'), 'utf8')); } catch { res.writeHead(404); res.end('/* none */'); }
      return;
    } else if (p === '/user/app.js') {
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      try { res.end(fs.readFileSync(path.join(CONFIG_DIR, 'app.js'), 'utf8')); } catch { res.writeHead(404); res.end('/* none */'); }
      return;
    }

    // SPA + assets
    if (fs.existsSync(DIST)) {
      if (p === '/' || p === '/index.html') {
        if (serveFile(res, path.join(DIST, 'index.html'), { noCache: true })) return;
      }
      const file = safeJoin(DIST, p);
      if (file && serveFile(res, file, { immutable: p.startsWith('/assets/') })) return;
      if (!p.includes('.')) { // SPA fallback
        if (serveFile(res, path.join(DIST, 'index.html'), { noCache: true })) return;
      }
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('OpusHub: not found. Did you run `npm run build`?');
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(`[api] ${req.method} ${p}:`, err);
    try {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    } catch { /* socket already gone */ }
  }
});

// ---- background loops: metric history + docker state watcher ----
// The watcher only REPORTS transitions it observes between two polls — it never writes to
// Docker. Events carry stable signatures so a flapping container produces one event per real
// transition, and compose-wide deployments group on the Activity page (see activity.js).
history.start(async () => {
  try {
    const s = await (await import('./providers/system.js')).collect();
    reportProvider('system', 'available', { silent: true });
    return s;
  } catch (err) {
    reportProvider('system', 'unavailable', { reason: 'Host metrics are unreadable right now.' });
    throw err;
  }
});
// seed the registry once at boot (silently — the first successful contact is not an event).
// A socket file that exists is NOT proof the daemon answers: when the path looks healthy we
// probe before claiming "available", so provider health can never say healthy off stale data.
{
  const a = docker.availability();
  if (!a.ok) {
    reportProvider('docker', 'unavailable', { reason: a.public, silent: true });
  } else {
    void docker.probe().then((p) => {
      reportProvider('docker', p.ok ? 'available' : 'unavailable', { reason: p.ok ? null : p.public, silent: true });
    });
  }
}

const HEALTH_IN_STATUS = /\((healthy|unhealthy|starting)\)\s*$/i;
let lastDockerSnapshot = null; // id → { state, health, project }
let lastProjects = null;       // Set<project>
let lastDockerErr = null;

async function dockerWatcher() {
  const a = docker.availability();
  if (!a.ok) return;
  try {
    const containers = await docker.listContainers({ all: true });
    const snap = new Map();
    const projects = new Set();
    for (const c of containers) {
      const health = c.health || (HEALTH_IN_STATUS.exec(c.status || '') || [])[1]?.toLowerCase() || null;
      snap.set(c.id, { state: c.state, health, project: c.labels?.project || null, name: c.name, status: c.status });
      if (c.labels?.project) projects.add(c.labels.project);
    }
    if (lastDockerSnapshot) {
      for (const [id, cur] of snap) {
        const prev = lastDockerSnapshot.get(id);
        if (!prev) {
          logEvent({ source: 'docker', type: 'container.discovered', subject: cur.name, message: cur.status, meta: { project: cur.project }, signature: `container.discovered:${id}:${cur.state}` });
          continue;
        }
        if (prev.state === cur.state && prev.health === cur.health) continue;
        const meta = { project: cur.project, state: cur.state, health: cur.health };
        if (prev.state !== cur.state) {
          const type = cur.state === 'running' ? 'container.started' : cur.state === 'exited' ? 'container.exited' : 'container.state';
          logEvent({ source: 'docker', type, subject: cur.name, message: `${cur.state} · ${cur.status}`, meta, signature: `${type}:${id}:${cur.state}` });
        }
        if (prev.state === cur.state && prev.health !== cur.health && cur.health) {
          // health moved while the state held — its own fact (became unhealthy / recovered)
          logEvent({ source: 'docker', type: 'container.health', subject: cur.name, message: `health: ${cur.health}`, meta, signature: `container.health:${id}:${cur.health}` });
        }
      }
      for (const [id, prev] of lastDockerSnapshot) {
        if (!snap.has(id)) logEvent({ source: 'docker', type: 'container.removed', subject: prev.name || id, message: 'no longer listed', meta: { project: prev.project }, signature: `container.removed:${id}` });
      }
      // whole-project changes read as stack events, not N container events
      if (lastProjects) {
        for (const p of projects) if (!lastProjects.has(p)) logEvent({ source: 'docker', type: 'stack.appeared', subject: p, message: `compose project “${p}” is now on the engine`, signature: `stack.appeared:${p}` });
        for (const p of lastProjects) if (!projects.has(p)) logEvent({ source: 'docker', type: 'stack.removed', subject: p, message: `compose project “${p}” is no longer on the engine`, signature: `stack.removed:${p}` });
      }
    }
    lastDockerSnapshot = snap;
    lastProjects = projects;
  } catch (err) {
    const msg = String(err.message || err);
    if (msg !== lastDockerErr) {
      lastDockerErr = msg;
      logEvent({ source: 'system', type: 'docker.error', subject: 'docker', message: msg });
    }
  }
}
setInterval(dockerWatcher, 30_000).unref();

// Docker reachability goes through the provider registry: one honest state, transitions logged
// exactly once, and the System pane can say when it last worked.
const providerWatcher = setInterval(async () => {
  const a = docker.availability();
  if (a.ok) {
    try { await docker.probe(); reportProvider('docker', 'available'); }
    catch { reportProvider('docker', 'unavailable', { reason: 'Docker engine is not responding.' }); }
  } else {
    reportProvider('docker', 'unavailable', { reason: a.public });
  }
}, 60_000);
providerWatcher.unref();

server.listen(PORT, HOST, () => {
  markBoot(Date.now());
  logEvent({ source: 'system', type: 'app.boot', subject: 'opushub', message: `listening on ${HOST}:${PORT}`, meta: { port: PORT, configDir: CONFIG_DIR, dataDir: DATA_DIR, envFiles: envReport.loaded.map((f) => f.file) } });
  console.log(`OpusHub → http://${HOST}:${PORT}  (config: ${configDir})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logEvent({ source: 'system', type: 'app.shutdown', subject: 'opushub', message: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
