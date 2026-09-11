// DockerProvider — READ-ONLY Docker Engine access, server-side only. The socket is never
// exposed to the browser; every response is projected through a safe shape (env vars, host
// config secrets are stripped). If no socket exists, everything reports `unavailable` with
// the actual reason — statuses and stats stay "Unavailable" in the UI. Never faked.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

function resolveEndpoint() {
  const sock = process.env.OPUSHUB_DOCKER_SOCKET;
  if (sock) return { socket: sock };
  const dh = process.env.DOCKER_HOST;
  if (dh) {
    const m = dh.match(/^unix:\/\/(.+)$/);
    if (m) return { socket: m[1] };
    const t = dh.match(/^tcp:\/\/([^:/]+):(\d+)$/);
    if (t) return { host: t[1], port: Number(t[2]) };
  }
  const defaults = ['/var/run/docker.sock', '/run/docker.sock'];
  for (const d of defaults) if (fs.existsSync(d)) return { socket: d };
  if (process.env.OSTREE_TMP || fs.existsSync('/run/host-services/docker.sock')) return { socket: '/var/run/docker.sock' };
  return { missing: '/var/run/docker.sock' };
}

export function availability() {
  const ep = resolveEndpoint();
  if (ep.socket) {
    try {
      fs.statSync(ep.socket);
      return { ok: true, ep };
    } catch {
      return { ok: false, reason: `Docker socket configured at ${ep.socket} but not present` };
    }
  }
  if (ep.host) return { ok: true, ep, tcp: true };
  return { ok: false, reason: `no Docker socket found (${ep.missing}); set OPUSHUB_DOCKER_SOCKET or DOCKER_HOST to connect` };
}

function request(pathname, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const { ok, ep, reason } = availability();
    if (!ok) return reject(Object.assign(new Error(reason), { unavailable: true }));
    const opts = ep.socket ? { socketPath: ep.socket } : { host: ep.host, port: ep.port };
    const req = http.get({ ...opts, path: `/v1.43${pathname}`, headers: { host: 'docker' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`docker API ${res.statusCode}: ${body.slice(0, 200)}`));
        resolve(body);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('docker request timed out')));
    req.on('error', reject);
  });
}

export async function probe() {
  const a = availability();
  if (!a.ok) return a;
  try {
    const ver = JSON.parse(await request('/version', { timeoutMs: 2500 }));
    return { ok: true, version: ver.Version, apiVersion: ver.ApiVersion };
  } catch (err) {
    return { ok: false, reason: `socket present but engine unreachable: ${err.message}` };
  }
}

function labelsOf(cfgLabels) {
  const l = cfgLabels || {};
  return {
    project: l['com.docker.compose.project'] || null,
    service: l['com.docker.compose.service'] || null,
    workingDir: l['com.docker.compose.project.config_files'] || null,
    managedBy: l['com.opusgrid.stack'] || l['com.docker.compose.project'] ? 'compose' : null,
  };
}

export async function listContainers({ all = true } = {}) {
  const body = await request(`/containers/json?all=${all ? 'true' : 'false'}`);
  return JSON.parse(body).map((c) => {
    const cfg = c.Labels || {};
    return {
      id: c.Id.slice(0, 12),
      fullId: c.Id,
      name: (c.Names?.[0] || '').replace(/^\//, ''),
      image: c.Image,
      imageId: c.ImageID?.slice(7, 19) ?? null,
      state: c.State,           // created|running|paused|restarting|removing|exited|dead
      status: c.Status,
      health: c.Health ?? null,
      restartCount: null,
      startedAt: null,
      ports: (c.Ports || []).map((p) => ({ ip: p.IP, private: p.PrivatePort, public: p.PublicPort, type: p.Type })),
      labels: { project: cfg['com.docker.compose.project'] || null, service: cfg['com.docker.compose.service'] || null },
    };
  });
}

export async function inspectContainer(ref) {
  const body = await request(`/containers/${encodeURIComponent(ref)}/json`);
  const c = JSON.parse(body);
  const labels = labelsOf(c.Config?.Labels);
  const health = c.State?.Health?.Status ?? null;
  const mounts = (c.Mounts || []).map((m) => ({ type: m.Type, source: m.Source, target: m.Destination, rw: m.RW }));
  const ports = [];
  for (const [priv, binds] of Object.entries(c.HostConfig?.PortBindings || {})) {
    for (const b of binds || []) ports.push({ private: priv, host: b.HostIp || '0.0.0.0', hostPort: b.HostPort });
  }
  const nets = Object.entries(c.NetworkSettings?.Networks || {}).map(([name, n]) => ({
    name,
    ip: n.IPAddress,
    gateway: n.Gateway,
    aliases: n.Aliases || [],
    mac: n.MacAddress?.slice(0, 8) ?? null,
  }));
  return {
    id: c.Id.slice(0, 12),
    name: (c.Name || '').replace(/^\//, ''),
    image: c.Config?.Image ?? null,
    entrypoint: c.Config?.Entrypoint?.join(' ') ?? null,
    command: Array.isArray(c.Config?.Cmd) ? c.Config.Cmd.join(' ') : (c.Config?.Cmd ?? null),
    state: {
      status: c.State?.Status, running: !!c.State?.Running, startedAt: c.State?.StartedAt || null,
      finishedAt: c.State?.FinishedAt && !c.State.FinishedAt.startsWith('0001') ? c.State.FinishedAt : null,
      exitCode: c.State?.ExitCode ?? null, health, restartCount: c.HostConfig?.RestartPolicy?.MaximumRetryCount ? c.RestartCount : 0,
      oomKilled: !!c.State?.OOMKilled,
    },
    restartPolicy: c.HostConfig?.RestartPolicy?.Name ?? null,
    labels,
    ports,
    mounts,
    networks: nets,
    created: c.Created,
  };
}

export async function containerStats(ref, { prev } = {}) {
  const body = await request(`/containers/${encodeURIComponent(ref)}/stats?stream=false`, { timeoutMs: 8000 });
  const s = JSON.parse(body);
  if (!s || s.error) throw new Error(s?.message || 'stats unavailable');
  const cpuDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
  const sysCpus = s.cpu_stats?.online_cpus || (s.cpu_stats?.cpu_usage?.percpu_usage || []).length || osLocal.cpus().length;
  let cpuPct = null;
  const usage = s.cpu_stats?.cpu_usage?.total_usage;
  const prevUsage = s.precpu_stats?.cpu_usage?.total_usage;
  if (typeof usage === 'number' && typeof prevUsage === 'number' && cpuDelta > 0) {
    cpuPct = Math.min(100 * sysCpus, Math.max(0, 100 * ((usage - prevUsage) / cpuDelta)));
  }
  const limit = s.memory_stats?.limit || null;
  const memUsed = s.memory_stats?.usage ?? s.memory_stats?.max_usage ?? null;
  const netAgg = { rx: 0, tx: 0 };
  for (const n of Object.values(s.networks || {})) { netAgg.rx += n.rx_bytes || 0; netAgg.tx += n.tx_bytes || 0; }
  return {
    cpu: cpuPct,
    memory: limit ? { used: memUsed, limit } : { used: memUsed, limit: null },
    net: netAgg,
    pids: s.pids_stats?.current ?? null,
    blockIo: s.blkio_stats?.io_service_bytes_recursive?.reduce((a, x) => a + (x.value || 0), 0) || null,
  };
}
let _cpus = null;
function os_cpus() { return _cpus ??= osLocal.cpus().length; }
void os_cpus;
import osLocal from 'node:os';

export async function logs(ref, { tail = 200 } = {}) {
  const body = await request(`/containers/${encodeURIComponent(ref)}/logs?stdout=true&stderr=true&tail=${Math.min(500, Math.max(1, tail | 0))}`);
  // Docker multiplexed-stream framing on some daemons; strip non-printable header bytes.
  return body.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').split('\n').slice(-tail);
}

export async function events({ sinceSec } = {}) {
  const q = sinceSec ? `?since=${Math.floor(sinceSec)}` : '';
  try {
    const body = await request(`/events${q}&until=${Math.floor(Date.now() / 1000)}`, { timeoutMs: 4000 });
    const lines = body.split('\n').filter(Boolean);
    return lines.slice(-100).map((l) => {
      try {
        const e = JSON.parse(l);
        return { time: e.time * 1000, action: e.Action, type: e.Type, actor: (e.Actor?.Attributes?.name) || null, status: e.Actor?.Attributes?.exitCode ?? null };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

export async function imagesSummary() {
  try {
    const body = await request('/images/json');
    return JSON.parse(body).slice(0, 400).map((i) => ({ id: i.Id.slice(7, 19), tags: i.RepoTags || [], size: i.Size }));
  } catch { return []; }
}

export async function systemDf() {
  try { return JSON.parse(await request('/system/df?type=container&type=image&type=volume')); }
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
