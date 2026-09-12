// DockerProvider tests — the real provider code against a mock Engine API speaking the
// genuine Docker HTTP-over-socket protocol. Fixtures are test-only (see test/mock-engine.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockEngine, FIXTURES } from '../../test/mock-engine.js';
import * as docker from './docker.js';

const OLD_ENV = { ...process.env };
let ENGINE = null;

function restoreSocket() {
  if (ENGINE) process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
}

test.before(async () => {
  ENGINE = await startMockEngine();
  process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
  delete process.env.DOCKER_HOST;
});

test.after(async () => {
  await ENGINE?.stop();
  process.env = OLD_ENV;
});

// --- endpoint resolution -----------------------------------------------------

test('resolveEndpoint: explicit socket env wins', () => {
  process.env.OPUSHUB_DOCKER_SOCKET = '/tmp/x.sock';
  process.env.DOCKER_HOST = 'unix:///tmp/y.sock';
  assert.equal(docker.resolveEndpoint().socket, '/tmp/x.sock');
  restoreSocket();
});

test('resolveEndpoint: DOCKER_HOST unix:// and tcp://', () => {
  delete process.env.OPUSHUB_DOCKER_SOCKET;
  process.env.DOCKER_HOST = 'unix:///run/user/1000/docker.sock';
  assert.equal(docker.resolveEndpoint().socket, '/run/user/1000/docker.sock');
  process.env.DOCKER_HOST = 'tcp://10.0.0.2:2375';
  assert.deepEqual(docker.resolveEndpoint(), { host: '10.0.0.2', port: 2375 });
  process.env.DOCKER_HOST = 'nonsense://x';
  assert.ok(docker.resolveEndpoint().invalid);
  delete process.env.DOCKER_HOST;
  restoreSocket();
});

// --- availability: public reasons never name paths ----------------------------

test('availability: missing socket reports public-safe reason', () => {
  process.env.OPUSHUB_DOCKER_SOCKET = '/tmp/opushub-definitely-absent.sock';
  const a = docker.availability();
  assert.equal(a.ok, false);
  assert.equal(a.state, 'socket-missing');
  assert.match(a.reason, /opushub-definitely-absent/); // internal: full detail for logs
  assert.doesNotMatch(a.public, /opushub-definitely-absent/); // public: no paths
  assert.doesNotMatch(a.public, /\/tmp\//);
  const pub = docker.publicStatus(a);
  assert.equal(pub.ok, false);
  assert.doesNotMatch(JSON.stringify(pub), /opushub-definitely-absent/);
  restoreSocket();
});

// --- live provider behavior ---------------------------------------------------

test('probe reports the mock engine version', async () => {
  const p = await docker.probe();
  assert.equal(p.ok, true);
  assert.equal(p.version, '26.1.0-mock');
  assert.equal(p.apiVersion, '1.43');
});

test('listContainers projects the safe shape for every fixture', async () => {
  const list = await docker.listContainers({ all: true });
  assert.equal(list.length, FIXTURES.length);
  for (const c of list) {
    assert.equal(typeof c.id, 'string');
    assert.equal(c.id.length, 12);
    assert.ok(!('fullId' in c), 'no full id crosses the boundary');
    assert.ok(!('Env' in c), 'no env crosses the boundary');
    assert.ok(c.name && !c.name.startsWith('/'));
  }
  const byName = new Map(list.map((c) => [c.name, c]));
  assert.equal(byName.get('jellyfin').state, 'running');
  assert.equal(byName.get('jellyfin').labels.project, 'opustream');
  assert.equal(byName.get('jellyfin').labels.service, 'jellyfin');
  assert.equal(byName.get('paperless').state, 'exited');
  assert.equal(byName.get('home-assistant').state, 'paused');
  assert.equal(byName.get('traefik').labels.project, null); // standalone
  assert.equal(byName.get('traefik').ports.length, 5);
  assert.equal(byName.get('paperless').ports.length, 0);
  assert.equal(typeof byName.get('jellyfin').created, 'number');
});

test('listContainers({ all:false }) returns running only', async () => {
  const list = await docker.listContainers({ all: false });
  assert.ok(list.length > 0 && list.length < FIXTURES.length);
  assert.ok(list.every((c) => c.State === undefined)); // raw field names never leak
  assert.ok(list.every((c) => c.state === 'running'));
});

test('inspectContainer: full detail, secrets stripped, host paths minimized', async () => {
  const c = await inspectName('vaultwarden');
  assert.equal(c.name, 'vaultwarden');
  assert.equal(c.state.health, 'healthy');
  assert.ok(c.state.startedAt);
  // the fixture command carries fake credentials — none may survive
  assert.doesNotMatch(c.command, /MOCK-FIXTURE-NOT-A-REAL-SECRET/);
  assert.doesNotMatch(c.command, /MOCK-PW-NOT-REAL/);
  assert.match(c.command, /--api-key=••••/);
  assert.match(c.command, /vault:••••@/);
  assert.ok(!('entrypoint' in c));
  assert.ok(!('workingDir' in (c.labels || {})));
  for (const n of c.networks) assert.ok(!('mac' in n));
  assert.deepEqual(c.labels, { project: 'secure', service: 'vaultwarden' });
});

test('inspectContainer: stopped container shows exit, no misleading runtime', async () => {
  const c = await inspectName('paperless');
  assert.equal(c.state.status, 'exited');
  assert.equal(c.state.running, false);
  assert.equal(c.state.exitCode, 0);
  assert.ok(c.state.finishedAt);
  assert.equal(c.state.health, null);
  assert.deepEqual(c.ports, []);
});

test('inspectContainer: unknown ref rejects with the daemon error', async () => {
  await assert.rejects(() => docker.inspectContainer('nope-no-such'), /404/);
});

async function inspectName(name) {
  return docker.inspectContainer(name);
}

test('containerStats: sane cpu/mem/net for running containers', async () => {
  const s = await docker.containerStats('jellyfin');
  assert.ok(s.cpu == null || (s.cpu >= 0 && s.cpu <= 200), `cpu=${s.cpu}`);
  assert.ok(s.cpu != null && s.cpu > 0, 'fixture deltas must yield a real cpu value');
  assert.ok(s.memory.used > 0 && s.memory.limit > 0);
  assert.ok(s.net.rx > 0 && s.net.tx > 0);
  assert.ok(s.pids > 0);
  assert.ok(s.blockIo > 0);
});

test('containerStats: stopped containers yield nulls, never zeros-as-data', async () => {
  const s = await docker.containerStats('paperless');
  assert.equal(s.cpu, null);
  assert.equal(s.memory.used, null);
  assert.equal(s.pids, null);
});

test('logs: multiplexed framing is demuxed, tail honored', async () => {
  const lines = await docker.logs('jellyfin', { tail: 3 });
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => !/[\x00-\x08]/.test(l)), 'no framing bytes survive');
  assert.match(lines.join('\n'), /trailing line without newline/);
  const head = await docker.logs('jellyfin', { tail: 20 });
  assert.match(head.join('\n'), /MOCK DATA/);
  assert.ok(head.some((l) => l.includes('System.Exception')), 'multiline entries survive as lines');
  assert.ok(head.some((l) => l.length > 400), 'long lines survive intact');
});

test('logs: TTY (raw stream) containers parse identically', async () => {
  const lines = await docker.logs('traefik', { tail: 10 });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /MOCK DATA/);
});

test('logs: timestamps opt-in prefixes RFC3339 stamps', async () => {
  const lines = await docker.logs('seerr', { tail: 2, timestamps: true });
  assert.ok(lines.every((l) => /^\d{4}-\d{2}-\d{2}T/.test(l)));
});

test('logs: unknown container rejects', async () => {
  await assert.rejects(() => docker.logs('ghost', { tail: 5 }), /404/);
});

test('demuxLogs unit: framed, raw, empty, and long lines', () => {
  const framed = Buffer.concat([
    Buffer.from([1, 0, 0, 0, 0, 0, 0, 6]), Buffer.from('hello\n', 'utf8'),
    Buffer.from([2, 0, 0, 0, 0, 0, 0, 7]), Buffer.from('oops\n\n', 'utf8'),
  ]);
  assert.deepEqual(docker.demuxLogs(framed), ['hello', 'oops', '', '']);
  assert.deepEqual(docker.demuxLogs(Buffer.from('a\nb', 'utf8')), ['a', 'b']);
  assert.deepEqual(docker.demuxLogs(Buffer.alloc(0)), []);
  const big = 'x'.repeat(20000);
  assert.equal(docker.demuxLogs(Buffer.from(big, 'utf8'))[0].length, 20000);
});

test('redactCommand unit: only credential-shaped tokens are masked', () => {
  assert.equal(docker.redactCommand('--config /data/x.yaml --port 8080'), '--config /data/x.yaml --port 8080');
  assert.equal(docker.redactCommand('--password hunter2 --port 1'), '--password hunter2 --port 1'); // space form untouched (too risky)
  assert.equal(docker.redactCommand('--token=abc --x=1'), '--token=•••• --x=1');
  assert.equal(docker.redactCommand('PGPASSWORD=secret pg_dump'), 'PGPASSWORD=•••• pg_dump');
  assert.equal(docker.redactCommand('http://u:pw@h:1/x'), 'http://u:••••@h:1/x');
  assert.equal(docker.redactCommand(null), null);
});

test('events: parses and filters by window', async () => {
  const all = await docker.events({});
  assert.equal(all.length, 3);
  assert.equal(all[0].actor, 'jellyfin');
  const narrow = await docker.events({ sinceSec: 1789200150 });
  assert.equal(narrow.length, 1);
  assert.equal(narrow[0].actor, 'navidrome');
});

test('imagesSummary and systemDf degrade gracefully', async () => {
  const imgs = await docker.imagesSummary();
  assert.ok(imgs.length > 0 && imgs[0].tags.length > 0);
  assert.ok((await docker.systemDf()) !== null);
});

test('groupByProject separates compose stacks from standalone', async () => {
  const list = await docker.listContainers({ all: true });
  const { projects, standalone } = docker.groupByProject(list);
  assert.deepEqual([...projects.keys()].sort(), ['cloud', 'home', 'observability', 'opustream', 'photos', 'secure', 'update']);
  assert.equal(projects.get('opustream').length, 8);
  assert.deepEqual(standalone.map((c) => c.name).sort(), ['nightly-backup-runner-with-a-remarkably-long-name', 'opushub', 'traefik']);
});

test('listContainers keeps raw labels server-side unless explicitly asked for them', async () => {
  const safe = await docker.listContainers({ all: true });
  assert.ok(safe.every((c) => !('rawLabels' in c)), 'the default projection must not carry the label map');
  assert.deepEqual(safe.find((c) => c.name === 'seerr').labels, { project: 'opustream', service: 'seerr' });
  const withLabels = await docker.listContainers({ all: true, withLabels: true });
  const seer = withLabels.find((c) => c.name === 'seerr');
  assert.equal(seer.rawLabels['traefik.http.routers.seerr.tls.certresolver'], 'letsencrypt');
});

test('engineInfo projects version + counters only (no /info internals)', async () => {
  const info = await docker.engineInfo();
  assert.equal(info.version, '26.1.0-mock');
  assert.equal(info.apiVersion, '1.43');
  assert.equal(info.containers, FIXTURES.length);
  assert.equal(info.running, FIXTURES.filter((f) => f.State === 'running').length);
  const blob = JSON.stringify(info);
  // what /info holds that nobody outside the server should see: host paths, registry mirrors,
  // proxies, resource totals, security options. The storage driver name is fine to show.
  assert.equal(info.driver, 'overlay2', 'the driver name is a useful, harmless diagnostic');
  for (const forbidden of ['registry-mock', 'proxy-mock', 'var/lib/docker', 'ServerVersion', 'MemTotal', 'NCPU', 'DockerRootDir', 'SecurityOptions', 'CgroupDriver', 'userns']) {
    assert.ok(!blob.includes(forbidden), `${forbidden} must not be projected`);
  }
});
