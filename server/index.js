// OpusHub server — plain Node HTTP: /api plus the built SPA. Single process, LAN tool.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { APP_ROOT, loadEnv, resolveConfigDir } from './env.js';
import { handleApi, markBoot, history } from './api.js';
import { logEvent } from './activity.js';
import * as docker from './providers/docker.js';
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
history.start(async () => (await import('./providers/system.js')).collect());

let lastDockerSnapshot = null;
let lastDockerErr = null;
async function dockerWatcher() {
  const a = docker.availability();
  if (!a.ok) return;
  try {
    const containers = await docker.listContainers({ all: true });
    const snap = new Map(containers.map((c) => [c.id, `${c.state}:${c.status}`]));
    if (lastDockerSnapshot) {
      for (const [id, st] of snap) {
        const prev = lastDockerSnapshot.get(id);
        const c = containers.find((x) => x.id === id);
        if (prev && prev !== st) logEvent({ source: 'docker', type: c.state === 'running' ? 'container.started' : c.state === 'exited' ? 'container.exited' : 'container.state', subject: c.name, message: `${c.state} · ${c.status}` });
        if (!prev) logEvent({ source: 'docker', type: 'container.discovered', subject: c.name, message: c.status });
      }
      for (const [id] of lastDockerSnapshot) {
        if (!snap.has(id)) logEvent({ source: 'docker', type: 'container.removed', subject: id, message: 'no longer listed' });
      }
    }
    lastDockerSnapshot = snap;
  } catch (err) {
    const msg = String(err.message || err);
    if (msg !== lastDockerErr) {
      lastDockerErr = msg;
      logEvent({ source: 'system', type: 'docker.error', subject: 'docker', message: msg });
    }
  }
}
setInterval(dockerWatcher, 30_000).unref();

const providerWatcher = setInterval(async () => {
  const a = docker.availability();
  const now = a.ok ? 'ok' : 'unavailable';
  if (providerWatcher.last !== now) {
    const prev = providerWatcher.last;
    providerWatcher.last = now;
    if (prev !== undefined) logEvent({ source: 'system', type: `docker.${now}`, subject: 'docker', message: a.ok ? 'Docker engine reachable' : a.reason });
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
