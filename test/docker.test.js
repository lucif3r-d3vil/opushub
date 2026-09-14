// Packaging contract tests — Dockerfile, .dockerignore, compose file and the publish workflow.
//
// These are *static* checks: this repository's test environment has no Docker engine, so nothing
// here claims a real image was built. What it does claim, and checks line by line, is that the
// recipe is the one described in the README: production-only dependencies, an unprivileged runtime
// user, no config/data/.env ever entering a layer, a socket mount that stays read-only, and a
// publish workflow that authenticates with GITHUB_TOKEN and nothing else.
//
// Real builds are proven by CI (.github/workflows/ghcr.yml runs `docker/build-push-action`) — the
// last test in this file pins that wiring so the two cannot drift apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const DOCKERFILE = read('Dockerfile');
const IGNORE = read('.dockerignore');
const COMPOSE_TEXT = read('docker-compose.yml');
const WORKFLOW_TEXT = read('.github/workflows/ghcr.yml');
const COMPOSE = YAML.parse(COMPOSE_TEXT);
const WORKFLOW = YAML.parse(WORKFLOW_TEXT);
const PACKAGE = JSON.parse(read('package.json'));

const stages = [...DOCKERFILE.matchAll(/^FROM\s+(\S+)\s+AS\s+(\S+)/gim)].map(([, image, name]) => ({ image, name }));
const stageBody = (name) => {
  const parts = DOCKERFILE.split(new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\s*$`, 'm'));
  return parts.length > 1 ? parts[1].split(/^FROM\s/m)[0] : '';
};
const RUNTIME = stageBody('runtime');
// comments never ship, so assertions about what a stage *does* read the directives only
const directives = (body) => body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const RUNTIME_DIRECTIVES = directives(RUNTIME);

const gitRemote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
const [, GIT_OWNER, GIT_REPO] = gitRemote.match(/github\.com[:/]([^/]+)\/([^/.]+)/) || [];

// ── Dockerfile ───────────────────────────────────────────────────────────────

test('the Dockerfile is a three-stage build with the BuildKit syntax line first', () => {
  assert.equal(DOCKERFILE.split('\n')[0], '# syntax=docker/dockerfile:1', 'the syntax directive must be line 1 to take effect');
  assert.deepEqual(stages.map((s) => s.name), ['deps', 'build', 'runtime']);
  assert.match(DOCKERFILE, /^ARG NODE_IMAGE=/m, 'the Node version lives in exactly one place');
  assert.match(DOCKERFILE, /^ARG NODE_IMAGE=node:22-alpine$/m);
  for (const s of stages) assert.equal(s.image, '${NODE_IMAGE}', 'every stage takes the same pinned base');
});

test('the runtime image carries production dependencies only', () => {
  const install = RUNTIME.match(/RUN npm ci[^\n]*/g) || [];
  assert.equal(install.length, 1, 'exactly one install in the runtime stage');
  assert.match(install[0], /--omit=dev/, `runtime install must skip dev dependencies: ${install[0]}`);
  assert.match(install[0], /npm cache clean/, 'the npm cache is not shipped');
  assert.match(RUNTIME, /^ENV .*NODE_ENV=production/m);
  assert.ok(!/\b(vite|vitest|typescript)\b/.test(RUNTIME_DIRECTIVES), 'no build tooling is referenced at runtime');
});

test('the container runs unprivileged with an explicit signal and port', () => {
  assert.match(RUNTIME, /^USER node$/m, 'the runtime user is not root');
  assert.ok(RUNTIME.indexOf('USER node') < RUNTIME.indexOf('CMD'), 'USER must be set before CMD');
  assert.match(RUNTIME, /^STOPSIGNAL SIGTERM$/m);
  assert.match(RUNTIME, /^EXPOSE 3000$/m);
  assert.match(RUNTIME, /^CMD \["node", "server\/index\.js"\]$/m, 'exec form, so Node receives SIGTERM directly');
  const chown = RUNTIME.match(/chown -R node:node[^\n]*/)?.[0] || '';
  assert.match(chown, /\/app\/config \/app\/data/, 'the mount points belong to the runtime user');
});

test('the healthcheck asks the same endpoint the app exposes, unauthenticated-safe', () => {
  const hc = RUNTIME.match(/HEALTHCHECK[^\n]*\n[^\n]*/)?.[0] || '';
  assert.ok(hc, 'no HEALTHCHECK found');
  assert.match(hc, /127\.0\.0\.1:3000\/api\/health/);
  assert.match(hc, /--interval=/, 'interval/timeout/retries are all set explicitly');
  assert.match(hc, /--timeout=/);
  assert.match(hc, /--retries=/);
});

test('no source file tree, config, data or secret can be copied into the image', () => {
  const copies = DOCKERFILE.match(/^COPY[^\n]*/gm) || [];
  assert.ok(copies.length > 0);
  const contextPaths = copies
    .flatMap((line) => line.replace(/^COPY\s+(--from=\S+\s+)?/, '').trim().split(/\s+/).slice(0, -1))
    .filter((token) => token && token !== '.');
  for (const line of copies) {
    assert.ok(!/^\s*COPY\s+\.\s/.test(line), `a wholesale context copy would drag config/.env in: ${line}`);
  }
  for (const token of contextPaths) {
    assert.ok(!/^(config|data)(\/|$)/.test(token), `COPY must not pull runtime state in: ${token}`);
    assert.ok(!/\.env/.test(token) && !/auth\.json|sessions\.json|secret/i.test(token), `COPY must not pull secrets in: ${token}`);
  }
  // the only things that make it in are the built SPA, the server, and the manifests
  assert.match(RUNTIME, /COPY --from=build \/app\/dist \.\/dist/);
  assert.match(RUNTIME, /COPY server \.\/server/);
  assert.ok(!/COPY \.\s/.test(DOCKERFILE));
  assert.ok(!/\bRUN\s+(curl|wget)\s/.test(DOCKERFILE), 'no runtime downloads: the build is offline-reproducible');
});

test('image labels point at the real repository, not a guessed one', () => {
  assert.ok(GIT_OWNER && GIT_REPO, `could not read owner/repo from ${gitRemote}`);
  assert.match(DOCKERFILE, new RegExp(`org\\.opencontainers\\.image\\.source="https://github\\.com/${GIT_OWNER}/${GIT_REPO}"`));
  assert.match(DOCKERFILE, /org\.opencontainers\.image\.version="\$\{OPUSHUB_VERSION\}"/);
  assert.match(DOCKERFILE, /org\.opencontainers\.image\.revision="\$\{OPUSHUB_REVISION\}"/);
  assert.match(DOCKERFILE, /^ARG OPUSHUB_VERSION=/m, 'a local build without the args still labels itself');
  assert.match(DOCKERFILE, /^ARG OPUSHUB_REVISION=/m);
});

test('the image is documented as LAN-only and socket-group based', () => {
  assert.match(DOCKERFILE, /:ro/, 'the docker run example mounts the socket read-only');
  assert.match(DOCKERFILE, /group-add/, 'the non-root socket access story is spelled out');
  assert.match(DOCKERFILE, /Never publish port 3000 to the Internet/i);
});

// ── .dockerignore ────────────────────────────────────────────────────────────

test('.dockerignore excludes every class of runtime state and secret', () => {
  const lines = IGNORE.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const covers = (needle) => lines.some((l) => l === needle || l === `**/${needle}` || (l.endsWith('/') && l.slice(0, -1) === needle));
  for (const entry of ['config', 'data', '.env', '.env.*', 'node_modules', 'dist', '.git', 'test', 'docs']) {
    assert.ok(covers(entry), `.dockerignore does not exclude ${entry}`);
  }
  assert.ok(covers('**/.env') || covers('.env.*'), 'nested .env files (config/.env) are excluded too');
  assert.ok(/\*\.(pem|key|crt|p12)/i.test(IGNORE), 'private keys are excluded');
  assert.ok(/^\*_rsa|id_rsa/m.test(IGNORE), 'ssh keys are excluded');
});

test('.dockerignore does not exclude anything the build actually needs', () => {
  const lines = IGNORE.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const blocks = (p) => lines.some((l) => l === p || l === `/${p}`);
  for (const needed of ['package.json', 'package-lock.json', 'src', 'server', 'vite.config.ts', 'tsconfig.json', 'index.html']) {
    assert.ok(!blocks(needed), `.dockerignore would break the build by excluding ${needed}`);
  }
});

// ── compose ──────────────────────────────────────────────────────────────────

test('the compose file is the clean install described in the README', () => {
  const svc = COMPOSE.services?.opushub;
  assert.ok(svc, 'services.opushub is missing');
  assert.equal(svc.image, `ghcr.io/${GIT_OWNER.toLowerCase()}/${GIT_REPO.toLowerCase()}:latest`, 'the canonical image from git metadata');
  assert.equal(svc.container_name, 'opushub');
  assert.equal(svc.restart, 'unless-stopped');
  assert.deepEqual(svc.ports, ['3000:3000']);
});

test('compose mounts config, data and a read-only socket', () => {
  const volumes = COMPOSE.services.opushub.volumes;
  assert.ok(volumes.includes('./config:/app/config'), 'presentation config is persisted beside the compose file');
  assert.ok(volumes.includes('./data:/app/data'), 'the account and sessions survive a container recreate');
  const socket = volumes.find((v) => v.includes('/var/run/docker.sock'));
  assert.equal(socket, '/var/run/docker.sock:/var/run/docker.sock:ro', 'the socket is read-only, always');
});

test('compose hardens the container instead of granting it privileges', () => {
  const svc = COMPOSE.services.opushub;
  assert.ok(!svc.privileged, 'never privileged');
  assert.ok(!svc.pid || svc.pid !== 'host');
  assert.ok(!svc.network_mode || svc.network_mode !== 'host');
  assert.ok(!svc.user || String(svc.user).includes('node'), 'no root override');
  assert.deepEqual(svc.security_opt, ['no-new-privileges:true']);
  assert.equal(svc.init, true);
  assert.ok(svc.healthcheck?.test, 'compose declares its own healthcheck');
  assert.match(JSON.stringify(svc.healthcheck), /api\/health/);
  assert.ok(!/password|secret|token/i.test(COMPOSE_TEXT), 'no credentials are written into the compose file');
  assert.ok(!(svc.environment || []).some?.((e) => String(e).startsWith('OPUSHUB_HOST_ADDRESS=')), 'the host address stays opt-in, commented out');
});

test('compose caps its own log growth', () => {
  const logging = COMPOSE.services.opushub.logging;
  assert.equal(logging?.driver, 'json-file');
  assert.match(logging.options['max-size'], /^\d+m$/);
  assert.ok(Number(logging.options['max-file']) >= 2);
});

// ── publish workflow ─────────────────────────────────────────────────────────

test('the publish workflow runs on main pushes, version tags and manual dispatch', () => {
  // `on` is parsed as the boolean true by YAML 1.1 — accept either key
  const on = WORKFLOW.on ?? WORKFLOW[true];
  assert.deepEqual(on.push.branches, ['main']);
  assert.deepEqual(on.push.tags, ['v*']);
  assert.ok('workflow_dispatch' in on, 'a manual run must be possible for a re-publish');
});

test('the workflow authenticates with GITHUB_TOKEN and declares minimal permissions', () => {
  const publish = WORKFLOW.jobs.publish;
  assert.equal(publish.permissions.contents, 'read');
  assert.equal(publish.permissions.packages, 'write');
  assert.equal(publish.permissions.actions, undefined, 'nothing else is granted');
  const login = publish.steps.find((s) => s.uses?.startsWith('docker/login-action'));
  assert.ok(login, 'no docker login step');
  assert.match(login.with.registry, /\$\{\{\s*env\.REGISTRY\s*\}\}/);
  assert.match(WORKFLOW_TEXT, /^\s*REGISTRY: ghcr\.io$/m);
  assert.equal(login.with.password, '${{ secrets.GITHUB_TOKEN }}');
  assert.ok(!/secrets\.(?!GITHUB_TOKEN)/.test(WORKFLOW_TEXT), 'no long-lived registry secret is referenced anywhere');
  const passwordLines = WORKFLOW_TEXT.split('\n').filter((l) => /^\s*password:/.test(l));
  assert.ok(passwordLines.length > 0, 'the login step must state its password source');
  for (const line of passwordLines) {
    assert.match(line, /secrets\.GITHUB_TOKEN/, `a password that is not the workflow token: ${line.trim()}`);
  }
  assert.match(login.with.username, /github\.(actor|repository_owner)/);
});

test('images are tagged latest + version + commit, from the repository the workflow runs in', () => {
  const publish = WORKFLOW.jobs.publish;
  const meta = publish.steps.find((s) => s.uses?.startsWith('docker/metadata-action'));
  assert.ok(meta);
  assert.equal(meta.with.images, '${{ env.REGISTRY }}/${{ env.IMAGE }}');
  assert.match(meta.with.tags, /type=raw,value=latest/);
  assert.match(meta.with.tags, /type=semver,pattern=\{\{version\}\}/);
  assert.match(meta.with.tags, /type=sha,prefix=sha-/);
  assert.match(WORKFLOW_TEXT, /IMAGE=\$\{IMAGE,,\}/, 'the owner/repository comes from git and is lowercased for GHCR');
  assert.match(WORKFLOW_TEXT, /github\.repository/, 'owner is read from the repository, never typed');
});

test('the build is amd64 first and structured for arm64 later', () => {
  const publish = WORKFLOW.jobs.publish;
  const build = publish.steps.find((s) => s.uses?.startsWith('docker/build-push-action'));
  assert.ok(build, 'no build-push step');
  assert.equal(build.with.context, '.');
  assert.equal(build.with.platforms, 'linux/amd64');
  assert.equal(build.with.push, true);
  assert.equal(build.with.tags, '${{ steps.meta.outputs.tags }}');
  assert.match(WORKFLOW_TEXT, /arm64/, 'the arm64 path is at least documented where it will be added');
  assert.match(build.with['cache-from'], /type=gha/);
  assert.match(build.with['cache-to'], /type=gha/);
  assert.match(build.with['build-args'], /OPUSHUB_REVISION=\$\{\{ github\.sha \}\}/, 'the revision label is the real commit');
});

test('the workflow verifies before it publishes, and builds exactly what the Dockerfile builds', () => {
  const { verify, publish } = WORKFLOW.jobs;
  assert.deepEqual(publish.needs, 'verify', 'a broken commit never becomes an image');
  const cmds = verify.steps.filter((s) => s.run).map((s) => s.run).join('\n');
  assert.match(cmds, /npm ci/);
  assert.match(cmds, /npm run typecheck/);
  assert.match(cmds, /npm test/);
  assert.match(cmds, /npm run build/);
  // the scripts must exist in package.json, or CI would fail on a typo
  for (const script of ['typecheck', 'test', 'build']) assert.ok(PACKAGE.scripts[script], `package.json has no ${script} script`);
  assert.equal(WORKFLOW.jobs.publish.steps.find((s) => s.uses?.startsWith('docker/build-push-action')).with.context, '.',
    'CI builds the repository root — the same context as the documented manual build');
});
