// DockerProvider — READ-ONLY Docker Engine access, server-side only. The socket is never
// exposed to the browser; every response is projected through a safe shape (env vars, host
// config secrets are stripped, host paths minimized). If no socket exists, everything
// reports `unavailable` with a public-safe reason — statuses and stats stay "Unavailable"
// in the UI. Never faked.
//
// Endpoint resolution (first hit wins):
//   1. OPUSHUB_DOCKER_SOCKET=/path/to/docker.sock   (explicit socket path)
//   2. DOCKER_HOST=unix:///path                     (unix socket)
//   3. DOCKER_HOST=tcp://host:port                  (plain TCP; LAN/VPN only, no TLS in V1)
//   4. /var/run/docker.sock, then /run/docker.sock  (well-known defaults, if present)
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

const MAX_API_VERSION = '1.43';   // what this client was written against
const MIN_API_VERSION = '1.24';   // every endpoint OpusHub uses exists since 1.24
let apiVersion = MAX_API_VERSION; // negotiated down on older daemons, never up
let negotiating = null;

/** Compare dotted version strings numerically. */
function vcmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Ask the daemon (versionless /version — accepted by every engine) which API it speaks, and
 *  clamp ours into [MIN, MAX]. Older daemons (Docker < 24) reject a too-new version prefix on
 *  EVERY request, so without this step OpusHub would read nothing on them at all.
 *  Returns { contacted, api } — `contacted: false` means the engine did not answer at all,
 *  which callers can treat as proof of unreachability without a second request. */
async function negotiateVersion(ep) {
  if (negotiating) return negotiating;
  negotiating = (async () => {
    try {
      const { body } = await rawRequest(ep, '/version', 2000);
      const v = JSON.parse(body.toString('utf8'));
      const daemon = String(v.ApiVersion || '');
      if (/^\d+\.\d+$/.test(daemon)) {
        apiVersion = vcmp(daemon, MAX_API_VERSION) < 0
          ? (vcmp(daemon, MIN_API_VERSION) >= 0 ? daemon : MIN_API_VERSION)
          : MAX_API_VERSION;
      }
      return { contacted: true, api: apiVersion };
    } catch {
      return { contacted: false, api: apiVersion }; // keep the current version
    } finally { negotiating = null; }
  })();
  return negotiating;
}

/** One request WITHOUT a version prefix (daemon default API) — used for negotiation only. */
function rawRequest(ep, pathname, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const opts = ep.socket ? { socketPath: ep.socket } : { host: ep.host, port: ep.port };
    const req = http.get({ ...opts, path: pathname, headers: { host: 'docker' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 400) return reject(new Error(`docker API ${res.statusCode}: ${body.toString('utf8').slice(0, 200)}`));
        resolve({ body, contentType: res.headers['content-type'] || '' });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('docker request timed out')));
    req.on('error', reject);
  });
}

function request(pathname, { timeoutMs = 6000, retried = false } = {}) {
  return new Promise((resolve, reject) => {
    const { ok, ep, reason } = availability();
    if (!ok) return reject(Object.assign(new Error(reason), { unavailable: true }));
    const opts = ep.socket ? { socketPath: ep.socket } : { host: ep.host, port: ep.port };
    const req = http.get({ ...opts, path: `/v${apiVersion}${pathname}`, headers: { host: 'docker' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          const text = body.toString('utf8').slice(0, 200);
          // an engine older than our pinned version refuses EVERY versioned path with a 400 —
          // negotiate down once and retry, instead of declaring the engine broken
          if (!retried && res.statusCode === 400 && /client version .* too new/i.test(text)) {
            return negotiateVersion(ep)
              .then(() => request(pathname, { timeoutMs, retried: true }))
              .then(resolve, reject);
          }
          return reject(new Error(`docker API ${res.statusCode}: ${text}`));
        }
        resolve({ body, contentType: res.headers['content-type'] || '' });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('docker request timed out')));
    req.on('error', reject);
  });
}

/** Resolve where the Engine lives. Never throws; callers check `.missing`. */
export function resolveEndpoint() {
  const sock = (process.env.OPUSHUB_DOCKER_SOCKET || '').trim();
  if (sock) return { socket: sock };
  const dh = (process.env.DOCKER_HOST || '').trim();
  if (dh) {
    const unix = dh.match(/^unix:\/\/(.+)$/);
    if (unix) return { socket: unix[1] };
    const tcp = dh.match(/^tcp:\/\/([^:/[\]]+|\[[^\]]+\]):(\d{1,5})$/);
    if (tcp) return { host: tcp[1].replace(/^\[|\]$/g, ''), port: Number(tcp[2]) };
    return { invalid: dh };
  }
  const defaults = ['/var/run/docker.sock', '/run/docker.sock'];
  for (const d of defaults) {
    try {
      if (fs.statSync(d).isSocket()) return { socket: d };
    } catch { /* next */ }
  }
  return { missing: true };
}

// Public-safe reasons. Internal detail (socket paths, errno text) stays in server logs;
// the browser only ever sees these generic strings plus a configuration hint.
const PUBLIC_REASONS = {
  'no-socket':
    'Docker engine not connected — no socket found. Set the socket location in the server environment to enable live status.',
  'socket-missing':
    'Docker socket is configured but not present on the server. Check the engine and the configured socket location.',
  'invalid-endpoint':
    'DOCKER_HOST is set to something OpusHub cannot use. Expected unix:///path/to/docker.sock or tcp://host:port.',
  unreachable:
    'Docker socket is present but the engine is not responding. Check that the daemon is running.',
};

export function availability() {
  const ep = resolveEndpoint();
  if (ep.socket) {
    try {
      const st = fs.statSync(ep.socket);
      if (!st.isSocket()) {
        return { ok: false, state: 'socket-missing', reason: `configured path ${ep.socket} exists but is not a socket`, public: PUBLIC_REASONS['socket-missing'] };
      }
      return { ok: true, state: 'connected', ep };
    } catch (err) {
      return { ok: false, state: 'socket-missing', reason: `Docker socket configured at ${ep.socket} but not present (${err.code || err.message})`, public: PUBLIC_REASONS['socket-missing'] };
    }
  }
  if (ep.host) return { ok: true, state: 'connected', ep, tcp: true };
  if (ep.invalid) return { ok: false, state: 'invalid-endpoint', reason: `unparseable DOCKER_HOST: ${ep.invalid}`, public: PUBLIC_REASONS['invalid-endpoint'] };
  return { ok: false, state: 'no-socket', reason: 'no Docker socket found (checked OPUSHUB_DOCKER_SOCKET, DOCKER_HOST, /var/run/docker.sock, /run/docker.sock)', public: PUBLIC_REASONS['no-socket'] };
}

/** The only docker-availability shape allowed to cross the API boundary. */
export function publicStatus(probed) {
  if (probed?.ok) return { ok: true, state: 'connected', version: probed.version, api: probed.apiVersion };
  const state = probed?.state && probed.state !== 'connected' ? probed.state : 'unreachable';
  return { ok: false, state, reason: PUBLIC_REASONS[state] || PUBLIC_REASONS.unreachable };
}

async function requestJson(pathname, opts) {
  const { body } = await request(pathname, opts);
  return JSON.parse(body.toString('utf8'));
}

export async function probe() {
  const a = availability();
  if (!a.ok) return a;
  try {
    // versionless first: this both proves the daemon answers AND negotiates the API version.
    // If it cannot even reach the engine there is nothing else to try — fail fast, honestly.
    const neg = await negotiateVersion(a.ep);
    if (!neg.contacted) {
      return { ok: false, state: 'unreachable', reason: 'socket present but engine unreachable', public: PUBLIC_REASONS.unreachable };
    }
    const ver = await requestJson('/version', { timeoutMs: 2500 });
    return { ok: true, state: 'connected', version: ver.Version, apiVersion: ver.ApiVersion };
  } catch (err) {
    return { ok: false, state: 'unreachable', reason: `socket present but engine unreachable: ${err.message}`, public: PUBLIC_REASONS.unreachable };
  }
}

// ---------------------------------------------------------------------------
// Projections (safe shapes — env vars and secrets never leave this module)
// ---------------------------------------------------------------------------

function labelsOf(cfgLabels) {
  const l = cfgLabels || {};
  return {
    project: l['com.docker.compose.project'] || null,
    service: l['com.docker.compose.service'] || null,
  };
}

/** Mask credential-looking tokens in a container command line. Conservative by design:
// only `key=value` tokens whose key smells like a secret, `--flag=value` forms of known
// credential flags, and `user:pass@` in URLs. Everything else passes through untouched. */
export function redactCommand(cmd) {
  if (!cmd) return cmd;
  const eqFlags = /(--?(?:password|passwd|pass|token|secret|api-?key|auth-?token|client-?secret|access-?key)[\w-]*)=(\S+)/gi;
  let out = String(cmd).replace(eqFlags, '$1=••••');
  out = out.replace(/(^|\s)([A-Za-z_][A-Za-z0-9_]*(?:PASS(?:WOR?D)?|PASSWD|SECRET|TOKEN|API[_-]?KEY|CREDENTIALS?|PWD)[A-Za-z0-9_]*)=(\S+)/gi, '$1$2=••••');
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)([^/\s@]+)(@)/g, '$1••••$3');
  return out;
}

/**
 * @param withLabels include the FULL label map as `rawLabels` — for server-side discovery only
 * (Traefik/compose parsing). It must never be serialized to a response: labels are arbitrary
 * user data and people do put tokens in them. Callers that project for the browser leave this
 * off, and `discovery.js` re-projects through `curatedLabels()` before anything reaches an API.
 */
export async function listContainers({ all = true, withLabels = false } = {}) {
  const list = await requestJson(`/containers/json?all=${all ? 'true' : 'false'}`);
  return list.map((c) => {
    const cfg = c.Labels || {};
    return {
      ...(withLabels ? { rawLabels: cfg } : {}),
      id: String(c.Id).slice(0, 12),
      name: (c.Names?.[0] || '').replace(/^\//, ''),
      image: c.Image,
      imageId: typeof c.ImageID === 'string' && c.ImageID.startsWith('sha256:') ? c.ImageID.slice(7, 19) : null,
      state: c.State,           // created|running|paused|restarting|removing|exited|dead
      status: c.Status,
      // NOTE: /containers/json carries no health (see inspect); preserved if a daemon sends it.
      health: c.Health ?? null,
      created: typeof c.Created === 'number' ? c.Created : null, // unix seconds, from the daemon
      ports: (c.Ports || []).map((p) => ({ ip: p.IP, private: p.PrivatePort, public: p.PublicPort, type: p.Type })),
      labels: { project: cfg['com.docker.compose.project'] || null, service: cfg['com.docker.compose.service'] || null },
    };
  });
}

export async function inspectContainer(ref) {
  const c = await requestJson(`/containers/${encodeURIComponent(ref)}/json`);
  const labels = labelsOf(c.Config?.Labels);
  const health = c.State?.Health?.Status ?? null;
  const mounts = (c.Mounts || []).map((m) => ({ type: m.Type, source: m.Source, target: m.Destination, rw: m.RW }));
  const ports = [];
  for (const [priv, binds] of Object.entries(c.HostConfig?.PortBindings || {})) {
    for (const b of binds || []) ports.push({ private: priv, host: b.HostIp || '0.0.0.0', hostPort: b.HostPort });
  }
  // EXPOSE (config-declared) ports are informational — NOT reachable from outside the host.
  // The UI must present them differently from published bindings; never as web endpoints.
  const exposedPorts = Object.keys(c.Config?.ExposedPorts || {}).map((k) => {
    const [port, proto = 'tcp'] = String(k).split('/');
    return { private: Number(port), type: proto };
  }).filter((p) => Number.isFinite(p.private));
  const nets = Object.entries(c.NetworkSettings?.Networks || {}).map(([name, n]) => ({
    name,
    ip: n.IPAddress,
    gateway: n.Gateway,
    aliases: (n.Aliases || []).filter((a) => typeof a === 'string'),
  }));
  const healthcheck = c.State?.Health ? {
    status: c.State.Health.Status ?? null,
    failingStreak: Number.isFinite(c.State.Health.FailingStreak) ? c.State.Health.FailingStreak : null,
    // Health.Log contents deliberately omitted: probe output is arbitrary app data.
  } : null;
  return {
    id: String(c.Id).slice(0, 12),
    name: (c.Name || '').replace(/^\//, ''),
    image: c.Config?.Image ?? null,
    imageId: typeof c.Image === 'string' && c.Image.startsWith('sha256:') ? c.Image.slice(7, 19) : null,
    // entrypoint/env deliberately omitted: env values are secrets, entrypoint is unused by the UI.
    command: redactCommand(Array.isArray(c.Config?.Cmd) ? c.Config.Cmd.join(' ') : (c.Config?.Cmd ?? null)),
    state: {
      status: c.State?.Status, running: !!c.State?.Running, startedAt: c.State?.StartedAt || null,
      finishedAt: c.State?.FinishedAt && !c.State.FinishedAt.startsWith('0001') ? c.State.FinishedAt : null,
      exitCode: c.State?.ExitCode ?? null, health,
      healthcheck,
      restartCount: c.RestartCount ?? 0,
      oomKilled: !!c.State?.OOMKilled,
    },
    restartPolicy: c.HostConfig?.RestartPolicy?.Name ?? null,
    logDriver: c.HostConfig?.LogConfig?.Type ?? null,
    labels,
    ports,
    exposedPorts,
    mounts,
    networks: nets,
    created: c.Created,
  };
}

/** Image facts, projected safe: no config env, no labels (people put tokens in both).
 *  Best-effort — callers treat null as “the engine didn’t tell us”. */
export async function imageInfo(ref) {
  try {
    const j = await requestJson(`/images/${encodeURIComponent(ref)}/json`, { timeoutMs: 5000 });
    const id = typeof j.Id === 'string' && j.Id.startsWith('sha256:') ? j.Id.slice(7, 19) : null;
    return {
      id,
      tags: Array.isArray(j.RepoTags) ? j.RepoTags.slice(0, 8) : [],
      digests: Array.isArray(j.RepoDigests) ? j.RepoDigests.slice(0, 4) : [],
      arch: j.Architecture ?? null,
      os: j.Os ?? null,
      created: j.Created ?? null,
      size: Number.isFinite(j.Size) ? j.Size : null,
    };
  } catch {
    return null;
  }
}

/**
 * Phase 10D — the processes inside a container (`GET /containers/<id>/top`). Read-only; the
 * command column is redacted with the same rule as the container command (people put tokens in
 * argv). Best-effort: null when the container is not running or the engine refuses.
 */
export async function containerTop(ref) {
  try {
    const j = await requestJson(`/containers/${encodeURIComponent(ref)}/top?ps_args=-eo%20pid,ppid,user,%25cpu,%25mem,etime,comm,args`, { timeoutMs: 5000 });
    const titles = (Array.isArray(j.Titles) ? j.Titles : []).map((t) => String(t).toLowerCase());
    const idx = (name) => titles.indexOf(name);
    const rows = (Array.isArray(j.Processes) ? j.Processes : []).slice(0, 200).map((r) => {
      const pick = (name) => (idx(name) >= 0 ? String(r[idx(name)] ?? '') : null);
      return {
        pid: pick('pid'), ppid: pick('ppid'), user: pick('user') || pick('uid'),
        cpu: pick('%cpu'), mem: pick('%mem'), elapsed: pick('etime') || pick('time'),
        command: pick('comm') || null,
        args: redactCommand(pick('args') || pick('cmd') || pick('command') || ''),
      };
    });
    return { titles, processes: rows };
  } catch {
    return null;
  }
}

export async function containerStats(ref) {
  const s = await requestJson(`/containers/${encodeURIComponent(ref)}/stats?stream=false`, { timeoutMs: 8000 });
  if (!s || s.error || !s.cpu_stats) throw new Error(s?.message || 'stats unavailable');
  const cpuDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
  const sysCpus = s.cpu_stats?.online_cpus || (s.cpu_stats?.cpu_usage?.percpu_usage || []).length || os.cpus().length;
  let cpuPct = null;
  const usage = s.cpu_stats?.cpu_usage?.total_usage;
  const prevUsage = s.precpu_stats?.cpu_usage?.total_usage;
  if (typeof usage === 'number' && typeof prevUsage === 'number' && cpuDelta > 0 && sysCpus > 0) {
    // Docker's own formula: (cpuDelta / systemDelta) * onlineCpus * 100.
    // 100% = one core fully busy; a 4-core box tops out at 400%.
    cpuPct = Math.min(100 * sysCpus, Math.max(0, (100 * sysCpus * (usage - prevUsage)) / cpuDelta));
  }
  const limit = s.memory_stats?.limit || null;
  const memUsed = s.memory_stats?.usage ?? null; // never substitute the high-watermark for current use
  const netAgg = { rx: 0, tx: 0 };
  for (const n of Object.values(s.networks || {})) { netAgg.rx += n.rx_bytes || 0; netAgg.tx += n.tx_bytes || 0; }
  const blkio = Array.isArray(s.blkio_stats?.io_service_bytes_recursive)
    ? s.blkio_stats.io_service_bytes_recursive.reduce((a, x) => a + (x.value || 0), 0)
    : null;
  // An all-null sample is not data: stopped containers answer with empty cgroup objects.
  // Report that as unavailable so the UI says so instead of rendering 0%.
  if (cpuPct == null && memUsed == null) throw new Error('stats unavailable: engine returned no readable metrics');
  return {
    cpu: cpuPct,
    memory: { used: memUsed, limit },
    net: netAgg,
    pids: s.pids_stats?.current ?? null,
    blockIo: blkio || null,
  };
}

// ---------------------------------------------------------------------------
// Logs — demultiplexed, bounded, paginated by tail
// ---------------------------------------------------------------------------

const MAX_LOG_BYTES = 256 * 1024;

/** Parse Docker's multiplexed log stream (8-byte header per frame) into text lines.
// Non-TTY containers return framed stdout/stderr; TTY containers return a raw stream.
// Detects framing by attempting a strict parse and falls back to raw text. */
export function demuxLogs(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8');
  if (!b.length) return [];
  // Strict probe: walk headers; if the structure holds for the whole buffer, it's framed.
  let framed = b.length >= 8;
  if (framed) {
    let off = 0;
    while (off + 8 <= b.length) {
      const stream = b[off];
      const zeros = b[off + 1] === 0 && b[off + 2] === 0 && b[off + 3] === 0;
      const size = b.readUInt32BE(off + 4);
      if ((stream !== 1 && stream !== 2) || !zeros || size > 16 * 1024 * 1024 || off + 8 + size > b.length) {
        // allow a truncated final frame only if at least one full frame parsed
        framed = off > 0 && off + 8 <= b.length && (stream === 1 || stream === 2) && zeros;
        break;
      }
      off += 8 + size;
      if (off === b.length) break;
    }
    if (off !== b.length && !(off > 0)) framed = false;
  }
  let text;
  if (framed) {
    const parts = [];
    let off = 0;
    while (off + 8 <= b.length) {
      const size = b.readUInt32BE(off + 4);
      const end = Math.min(b.length, off + 8 + size);
      parts.push(b.toString('utf8', off + 8, end));
      off += 8 + size;
      if (off >= b.length) break;
    }
    text = parts.join('');
  } else {
    text = b.toString('utf8');
  }
  return text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

export async function logs(ref, { tail = 200, timestamps = false } = {}) {
  const n = Math.min(500, Math.max(1, tail | 0));
  const { body } = await request(
    `/containers/${encodeURIComponent(ref)}/logs?stdout=true&stderr=true&tail=${n}${timestamps ? '&timestamps=true' : ''}`,
    { timeoutMs: 8000 },
  );
  const capped = body.length > MAX_LOG_BYTES ? body.subarray(body.length - MAX_LOG_BYTES) : body;
  const lines = demuxLogs(capped);
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing newline, not a line
  return lines.slice(-n);
}

export async function events({ sinceSec } = {}) {
  const params = new URLSearchParams();
  if (sinceSec) params.set('since', String(Math.floor(sinceSec)));
  params.set('until', String(Math.floor(Date.now() / 1000)));
  try {
    const { body } = await request(`/events?${params.toString()}`, { timeoutMs: 4000 });
    const lines = body.toString('utf8').split('\n').filter(Boolean);
    return lines.slice(-100).map((l) => {
      try {
        const e = JSON.parse(l);
        return { time: e.time * 1000, action: e.Action, type: e.Type, actor: e.Actor?.Attributes?.name || null, status: e.Actor?.Attributes?.exitCode ?? null };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** Engine facts safe enough for the browser: version + container counters. `/info` carries
// registry mirrors, daemon labels, proxy config and paths — none of it is projected. */
export async function engineInfo() {
  const out = {};
  try {
    const v = await requestJson('/version', { timeoutMs: 4000 });
    out.version = v.Version || null;
    out.apiVersion = v.ApiVersion || null;
    out.os = v.Os || null;
    out.arch = v.Arch || null;
  } catch { /* partial */ }
  try {
    const info = await requestJson('/info', { timeoutMs: 5000 });
    out.containers = Number.isFinite(info.Containers) ? info.Containers : null;
    out.running = Number.isFinite(info.ContainersRunning) ? info.ContainersRunning : null;
    out.paused = Number.isFinite(info.ContainersPaused) ? info.ContainersPaused : null;
    out.stopped = Number.isFinite(info.ContainersStopped) ? info.ContainersStopped : null;
    out.driver = info.Driver || null;
  } catch { /* older/limited daemons */ }
  if (!Object.keys(out).length) throw new Error('engine info unavailable');
  return out;
}

export async function imagesSummary() {
  try {
    const list = await requestJson('/images/json');
    return list.slice(0, 400).map((i) => ({
      id: typeof i.Id === 'string' && i.Id.startsWith('sha256:') ? i.Id.slice(7, 19) : null,
      tags: i.RepoTags || [],
      size: i.Size,
    }));
  } catch { return []; }
}

export async function systemDf() {
  try { return await requestJson('/system/df'); }
  catch { return null; }
}

export function netAvailable() {
  // TCP probe variant support (DOCKER_HOST tcp://)
  const ep = resolveEndpoint();
  return !!(ep.host) ? new Promise((res) => {
    const s = net.connect(ep.port, ep.host);
    s.setTimeout(1500);
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.on('timeout', () => { s.destroy(); res(false); });
  }) : Promise.resolve(true);
}

/** Test helper — the negotiated version is process-global state. */
export const _internals = {
  get apiVersion() { return apiVersion; },
  setApiVersion(v) { apiVersion = v; },
  MAX_API_VERSION, MIN_API_VERSION, vcmp,
};

// ---------------------------------------------------------------------------
// Infrastructure inventory — networks, volumes, images (all GET-only projections)
// ---------------------------------------------------------------------------

/**
 * Docker networks, projected safe: identity + topology signals only. No IPAM configs with
 * gateway/subnet internals beyond names — the UI needs membership, not addressing plans.
 * Container attachments come from the inspect-side `Containers` map when the daemon includes it.
 */
export async function listNetworks() {
  const list = await requestJson('/networks');
  return (Array.isArray(list) ? list : []).slice(0, 200).map((n) => {
    const attached = n.Containers && typeof n.Containers === 'object' ? Object.values(n.Containers) : [];
    return {
      id: typeof n.Id === 'string' ? n.Id.slice(0, 12) : null,
      name: n.Name ?? null,
      driver: n.Driver ?? null,
      scope: n.Scope ?? null,
      internal: n.Internal === true,
      attachable: n.Attachable === true,
      ingress: n.Ingress === true,
      created: n.Created ?? null,
      containerCount: attached.length,
      // Names only — MAC/IPv4/IPv6 address details stay server-side (topology needs membership).
      containers: attached.slice(0, 100).map((c) => ({ name: c.Name ?? null })).filter((c) => c.name),
    };
  });
}

/**
 * Networks with their labels — for ownership decisions server-side (which networks a stack
 * created, so only those may be removed). Not a browser projection: labels are not served.
 */
export async function listNetworksRaw() {
  const list = await requestJson('/networks');
  return (Array.isArray(list) ? list : []).slice(0, 500).map((n) => ({
    id: typeof n.Id === 'string' ? n.Id.slice(0, 12) : null,
    name: n.Name ?? null,
    driver: n.Driver ?? null,
    labels: n.Labels && typeof n.Labels === 'object' ? { ...n.Labels } : {},
  }));
}

/**
 * Docker volumes, projected safe: names + usage only. Mountpoints are host paths and are
 * deliberately NOT projected (see the read-only boundary: no arbitrary filesystem locations).
 */
export async function listVolumes() {
  const doc = await requestJson('/volumes');
  const vols = Array.isArray(doc?.Volumes) ? doc.Volumes : [];
  return vols.slice(0, 500).map((v) => ({
    name: v.Name ?? null,
    driver: v.Driver ?? null,
    scope: v.Scope ?? null,
    createdAt: v.CreatedAt ?? null,
    // Usage counts come from the `UsageData` the daemon reports (RefCount, Size).
    refCount: Number.isFinite(v.UsageData?.RefCount) ? v.UsageData.RefCount : null,
    size: Number.isFinite(v.UsageData?.Size) && v.UsageData.Size >= 0 ? v.UsageData.Size : null,
  }));
}

/**
 * Docker images, projected safe: tags + size + usage. Config/labels are never fetched here
 * (people put tokens in both); per-image detail stays behind `imageInfo()` which also omits them.
 */
export async function listImages() {
  const list = await requestJson('/images/json');
  return (Array.isArray(list) ? list : []).slice(0, 400).map((i) => ({
    id: typeof i.Id === 'string' && i.Id.startsWith('sha256:') ? i.Id.slice(7, 19) : null,
    tags: Array.isArray(i.RepoTags) ? i.RepoTags.filter((t) => t !== '<none>:<none>').slice(0, 8) : [],
    digests: Array.isArray(i.RepoDigests) ? i.RepoDigests.slice(0, 4) : [],
    created: Number.isFinite(i.Created) ? i.Created : null,
    size: Number.isFinite(i.Size) ? i.Size : null,
    virtualSize: Number.isFinite(i.VirtualSize) ? i.VirtualSize : null,
    containers: Number.isFinite(i.Containers) ? i.Containers : null,
  }));
}

// ---------------------------------------------------------------------------
// Stack discovery — compose projects vs standalone containers
// ---------------------------------------------------------------------------

/** Group live containers by their compose project label. Containers without a project
// label are standalone (or managed outside compose) — never force-fit into a stack. */
export function groupByProject(containers) {
  const projects = new Map(); // project name -> containers[]
  const standalone = [];
  for (const c of containers || []) {
    const project = c.labels?.project;
    if (project) {
      if (!projects.has(project)) projects.set(project, []);
      projects.get(project).push(c);
    } else {
      standalone.push(c);
    }
  }
  return { projects, standalone };
}
