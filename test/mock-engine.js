// Mock Docker Engine — a faithful-enough subset of the Engine HTTP API served over a
// unix socket, for Phase 2 validation and unit tests.
//
//   node test/mock-engine.js /tmp/opushub-mock-docker.sock   # run standalone
//   OPUSHUB_DOCKER_SOCKET=/tmp/opushub-mock-docker.sock node server/index.js
//
// Fixtures are TEST DATA ONLY (clearly fake names/values) and exist so the real provider
// code path — socket → HTTP → projection → API → UI — can be exercised where no real
// Engine is available. They never ship to production and must never be mistaken for
// discovered infrastructure.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const C = (id12, name, image, state, status, labels, ports = [], created = 1789000000) => ({
  Id: id12 + 'e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4'.slice(0, 64 - id12.length),
  Names: [`/${name}`],
  Image: image,
  ImageID: `sha256:${'9'.repeat(64)}`,
  State: state,
  Status: status,
  Labels: labels,
  Ports: ports,
  Created: created,
});

const compose = (project, service, n = 1) => ({
  'com.docker.compose.project': project,
  'com.docker.compose.service': service,
  'com.docker.compose.container-number': String(n),
  'com.docker.compose.project.config_files': `/opt/opusgrid/stacks/${project}/docker-compose.yaml`,
  'com.docker.compose.oneoff': 'False',
});

const P = (priv, pub, ip = '0.0.0.0', type = 'tcp') => ({ IP: ip, PrivatePort: priv, PublicPort: pub, Type: type });

// --- fixture fleet: every state the UI must handle honestly ------------------
export const FIXTURES = [
  C('a1b2c3d4e5f6', 'jellyfin', 'jellyfin/jellyfin:10.9.7', 'running', 'Up 6 days (healthy)',
    compose('media', 'jellyfin'), [P(8096, 8096), P(8920, 8920)]),
  C('b2c3d4e5f6a7', 'seerr', 'seerr/seerr:2.4.0', 'running', 'Up 6 days',
    compose('media', 'seerr'), [P(5055, 5055)]),
  C('c3d4e5f6a7b8', 'navidrome', 'deluan/navidrome:0.52.0', 'running', 'Up 2 hours (unhealthy)',
    compose('media', 'navidrome'), [P(4533, 4533)]),
  C('d4e5f6a7b8c9', 'immich', 'ghcr.io/immich-app/immich-server:v1.118.0', 'running', 'Up 6 days (healthy)',
    compose('photos', 'immich'), [P(2283, 2283)]),
  C('e5f6a7b8c9d0', 'nextcloud', 'nextcloud:29-apache', 'running', 'Up 3 days (healthy)',
    compose('cloud', 'nextcloud'), [P(80, 8080)]),
  C('f6a7b8c9d0e1', 'paperless', 'ghcr.io/paperless-ngx/paperless-ngx:2.8', 'exited', 'Exited (0) 11 hours ago',
    compose('cloud', 'paperless'), []),
  C('07a8b9c0d1e2', 'vaultwarden', 'vaultwarden/server:1.32.0', 'running', 'Up 14 days (healthy)',
    compose('secure', 'vaultwarden'), [P(80, 8222)]),
  C('18b9c0d1e2f3', 'home-assistant', 'ghcr.io/home-assistant/home-assistant:2026.8', 'paused', 'Up 6 days (Paused)',
    compose('home', 'home-assistant'), [P(8123, 8123)]),
  // standalone: no compose labels at all
  C('29c0d1e2f3a4', 'traefik', 'traefik:v3.1', 'running', 'Up 14 days',
    { 'com.opusgrid.managed': 'true' },
    [P(80, 80), P(443, 443), P(8080, 8080), P(5432, 5432), P(25, 25, '127.0.0.1')]),
  C('3ad1e2f3a4b5', 'nightly-backup-runner-with-a-remarkably-long-name', 'alpine:3.20', 'created', 'Created',
    {}, []),
  // a compose project with no configured stack: must surface as "discovered"
  C('4be2f3a4b5c6', 'observability-prometheus-1', 'prom/prometheus:v2.53.0', 'running', 'Up 6 days',
    compose('observability', 'prometheus'), [P(9090, 9090)]),
];

const HEALTHY = new Set(['jellyfin', 'immich', 'nextcloud', 'vaultwarden']);
const UNHEALTHY = new Set(['navidrome']);

function inspectPayload(fx) {
  const running = fx.State === 'running';
  const name = fx.Names[0].slice(1);
  const project = fx.Labels['com.docker.compose.project'];
  const portBindings = {};
  for (const p of fx.Ports) {
    const key = `${p.PrivatePort}/${p.Type}`;
    portBindings[key] = [{ HostIp: p.IP, HostPort: String(p.PublicPort) }];
  }
  const nets = {};
  if (project) nets[`${project}_net`] = { IPAddress: '172.28.0.5', Gateway: '172.28.0.1', Aliases: [name], MacAddress: '02:42:ac:1c:00:05' };
  if (name === 'traefik' || name === 'jellyfin') nets['proxy'] = { IPAddress: '172.29.0.7', Gateway: '172.29.0.1', Aliases: [name], MacAddress: '02:42:ac:1d:00:07' };
  if (!project && name !== 'traefik') nets['bridge'] = { IPAddress: '172.17.0.3', Gateway: '172.17.0.1', Aliases: [], MacAddress: '02:42:ac:11:00:03' };
  const mounts = [];
  if (name === 'jellyfin') {
    mounts.push(
      { Type: 'bind', Source: '/mnt/media', Destination: '/media', RW: false },
      { Type: 'volume', Source: 'jellyfin-config', Destination: '/config', RW: true },
      { Type: 'volume', Source: 'jellyfin-cache', Destination: '/cache', RW: true },
    );
  } else if (project) {
    mounts.push({ Type: 'volume', Source: `${project}-${fx.Labels['com.docker.compose.service']}-data`, Destination: '/data', RW: true });
  }
  if (fx.State === 'paused') mounts.push({ Type: 'bind', Source: '/opt/opusgrid/stacks/home/config', Destination: '/config', RW: true });
  // one deliberately credential-bearing command so redaction is verifiable end to end
  const cmd = name === 'vaultwarden'
    ? ['/vaultwarden', '--api-key=MOCK-FIXTURE-NOT-A-REAL-SECRET', '--database-url=postgres://vault:MOCK-PW-NOT-REAL@db:5432/vault']
    : [`/entrypoint.sh`, '--config', '/data/config.yaml'];
  const health = HEALTHY.has(name) ? 'healthy' : UNHEALTHY.has(name) ? 'unhealthy' : null;
  return {
    Id: fx.Id,
    Name: `/${name}`,
    Created: '2026-09-01T08:00:00.000000000Z',
    Config: { Image: fx.Image, Cmd: cmd, Entrypoint: ['/entrypoint.sh'], Env: ['MOCK_FIXTURE=true', 'SECRET_SHOULD_NEVER_LEAVE_SERVER=hunter2'], Labels: fx.Labels },
    State: {
      Status: fx.State, Running: running, Paused: fx.State === 'paused',
      StartedAt: running || fx.State === 'paused' ? '2026-09-06T08:00:00.000000000Z' : '0001-01-01T00:00:00Z',
      FinishedAt: !running && fx.State !== 'paused' && fx.State !== 'created' ? '2026-09-11T21:00:00.000000000Z' : '0001-01-01T00:00:00Z',
      ExitCode: fx.State === 'exited' ? 0 : 0,
      OOMKilled: false,
      Health: health ? { Status: health, FailingStreak: health === 'healthy' ? 0 : 3 } : undefined,
    },
    HostConfig: { PortBindings: portBindings, RestartPolicy: { Name: project ? 'unless-stopped' : 'no' } },
    RestartCount: name === 'navidrome' ? 2 : 0,
    Mounts: mounts,
    NetworkSettings: { Networks: nets },
  };
}

function statsPayload(fx) {
  if (fx.State !== 'running') {
    return { cpu_stats: {}, precpu_stats: {}, memory_stats: {} }; // daemon: nothing to sample
  }
  const seed = [...fx.Id].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const cpuUse = 40_000_000_000 + (seed % 7) * 3_000_000_000;
  return {
    cpu_stats: {
      cpu_usage: { total_usage: cpuUse, percpu_usage: [cpuUse * 0.6, cpuUse * 0.4] },
      system_cpu_usage: 9_000_000_000_000, online_cpus: 2,
    },
    precpu_stats: {
      cpu_usage: { total_usage: cpuUse - 180_000_000, percpu_usage: [(cpuUse - 180_000_000) * 0.6, (cpuUse - 180_000_000) * 0.4] },
      system_cpu_usage: 9_000_000_000_000 - 2_000_000_000,
    },
    memory_stats: { usage: 380_000_000 + (seed % 5) * 90_000_000, max_usage: 900_000_000, limit: 4_131_278_848 },
    networks: { eth0: { rx_bytes: 26_915_348 + seed, tx_bytes: 505_345 + seed, rx_packets: 4455, tx_packets: 3883 } },
    pids_stats: { current: 12 + (seed % 40) },
    blkio_stats: { io_service_bytes_recursive: [{ major: 8, minor: 0, op: 'read', value: 104_857_600 }, { major: 8, minor: 0, op: 'write', value: 52_428_800 }] },
  };
}

const LONG_LINE = 'longline: ' + 'lorem-ipsum-dolor-sit-amet-'.repeat(18) + 'end';
const LOGS = {
  jellyfin: [
    '[08:00:01 INF] Fixture log line one — jellyfin started (MOCK DATA)',
    '[08:00:02 INF] ' + LONG_LINE,
    '[08:00:03 ERR] Multiline example:\nSystem.Exception: something happened (mock)\n   at Mock.Frame.One()\n   at Mock.Frame.Two()',
    '[08:00:04 INF] unicode: héllo wörld — 日本語テスト — emoji 🎬📚',
    '[08:00:05 INF] ansi colors: \u001b[32mgreen\u001b[0m and \u001b[1;31mbold red\u001b[0m (mock)',
    '[08:00:06 INF] trailing line without newline at end',
  ],
  default: [
    'fixture stdout line 1 (MOCK DATA)',
    'fixture stdout line 2 (MOCK DATA)',
  ],
};

function frameLogs(lines, timestamps) {
  // Docker multiplexed framing: 1-byte stream, 3 zero bytes, 4-byte BE length, payload.
  const parts = [];
  lines.forEach((line, i) => {
    const text = (timestamps ? `2026-09-12T08:0${i}:00.000000000Z ` : '') + line + '\n';
    const payload = Buffer.from(text, 'utf8');
    const head = Buffer.alloc(8);
    head[0] = i % 3 === 2 ? 2 : 1; // mostly stdout, some stderr
    head.writeUInt32BE(payload.length, 4);
    parts.push(head, payload);
  });
  return Buffer.concat(parts);
}

const EVENTS = [
  { time: 1789200000, Type: 'container', Action: 'start', Actor: { Attributes: { name: 'jellyfin' } } },
  { time: 1789200100, Type: 'container', Action: 'die', Actor: { Attributes: { name: 'paperless', exitCode: '0' } } },
  { time: 1789200200, Type: 'container', Action: 'health_status: unhealthy', Actor: { Attributes: { name: 'navidrome' } } },
];

function findRef(ref) {
  return FIXTURES.find((f) => f.Names[0] === `/${ref}` || f.Id === ref || f.Id.startsWith(ref));
}

export function createHandler() {
  return (req, res) => {
    const url = new URL(req.url, 'http://docker');
    const p = url.pathname.replace(/^\/v1\.\d+/, '');
    const send = (code, obj, contentType = 'application/json') => {
      const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
      res.writeHead(code, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    if (req.method === 'GET' && p === '/version') {
      return send(200, { Version: '26.1.0-mock', ApiVersion: '1.43', Os: 'linux', Arch: 'amd64' });
    }
    if (req.method === 'GET' && p === '/containers/json') {
      const all = url.searchParams.get('all') !== 'false';
      return send(200, all ? FIXTURES : FIXTURES.filter((f) => f.State === 'running'));
    }
    let m = p.match(/^\/containers\/([^/]+)\/json$/);
    if (req.method === 'GET' && m) {
      const fx = findRef(decodeURIComponent(m[1]));
      return fx ? send(200, inspectPayload(fx)) : send(404, { message: 'No such container' });
    }
    m = p.match(/^\/containers\/([^/]+)\/stats$/);
    if (req.method === 'GET' && m) {
      const fx = findRef(decodeURIComponent(m[1]));
      return fx ? send(200, statsPayload(fx)) : send(404, { message: 'No such container' });
    }
    m = p.match(/^\/containers\/([^/]+)\/logs$/);
    if (req.method === 'GET' && m) {
      const fx = findRef(decodeURIComponent(m[1]));
      if (!fx) return send(404, { message: 'No such container' });
      const name = fx.Names[0].slice(1);
      const tail = Math.min(500, Math.max(1, Number(url.searchParams.get('tail')) || 200));
      const timestamps = url.searchParams.get('timestamps') === 'true';
      const lines = (LOGS[name] || LOGS.default).slice(-tail);
      if (name === 'traefik') {
        // TTY-attached containers stream raw text, not framed
        const text = lines.map((l, i) => (timestamps ? `2026-09-12T08:0${i}:00.000000000Z ${l}` : l)).join('\n') + '\n';
        return send(200, text, 'text/plain; charset=utf-8');
      }
      return send(200, frameLogs(lines, timestamps), 'application/vnd.docker.multiplexed-stream');
    }
    if (req.method === 'GET' && p === '/events') {
      const since = Number(url.searchParams.get('since')) || 0;
      const until = Number(url.searchParams.get('until')) || Number.MAX_SAFE_INTEGER;
      const lines = EVENTS.filter((e) => e.time >= since && e.time <= until).map((e) => JSON.stringify(e));
      return send(200, lines.join('\n') + (lines.length ? '\n' : ''), 'application/json');
    }
    if (req.method === 'GET' && p === '/images/json') {
      return send(200, FIXTURES.slice(0, 6).map((f, i) => ({ Id: `sha256:${String(i).repeat(64)}`, RepoTags: [f.Image], Size: 100_000_000 + i })));
    }
    if (req.method === 'GET' && p === '/system/df') {
      return send(200, { LayersSize: 1, Images: [], Containers: [], Volumes: [] });
    }
    return send(404, { message: `mock engine: no route ${req.method} ${p}` });
  };
}

export async function startMockEngine(socketPath) {
  const sock = socketPath || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mock-docker-')), 'docker.sock');
  try { fs.unlinkSync(sock); } catch { /* fresh */ }
  const server = http.createServer(createHandler());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, resolve);
  });
  return {
    socketPath: sock,
    url: sock,
    async stop() {
      await new Promise((r) => server.close(r));
      try { fs.unlinkSync(sock); } catch { /* ok */ }
    },
  };
}

// CLI: node test/mock-engine.js [socket-path]
const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invoked) {
  const sock = process.argv[2] || '/tmp/opushub-mock-docker.sock';
  const engine = await startMockEngine(sock);
  console.log(`mock docker engine → ${engine.socketPath}`);
  console.log(`OPUSHUB_DOCKER_SOCKET=${engine.socketPath} node server/index.js`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => engine.stop().then(() => process.exit(0)));
}
