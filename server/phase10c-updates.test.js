// Phase 10C — Container recovery & update management test suite
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine } from '../test/mock-engine.js';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-10c-data-'));
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-10c-cfg-'));
process.env.OPUSHUB_DATA_DIR = DATA_DIR;
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;

let ENGINE = null;
const OLD_SOCKET = process.env.OPUSHUB_DOCKER_SOCKET;

ENGINE = await startMockEngine();
process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
delete process.env.DOCKER_HOST;

const updatesStore = await import('./updates/store.js');
const updatesModel = await import('./updates/model.js');
const updatesEligibility = await import('./updates/eligibility.js');
const updatesDiun = await import('./updates/diun.js');
const updatesEngine = await import('./updates/engine.js');
const autohealObserver = await import('./autoheal/observer.js');
const eventsBus = await import('./events/bus.js');
const eventsStore = await import('./events/store.js');
const notificationsPolicy = await import('./notifications/policy.js');
const notificationsStore = await import('./notifications/store.js');
const { handleApi } = await import('./api.js');
const auth = await import('./auth.js');
const locks = await import('./operations/locks.js');
const confirmation = await import('./operations/confirmation.js');

let COOKIE = null;
let VIEWER_COOKIE = null;

test.before(async () => {
  const { seedSession } = await import('../test/auth-helper.js');
  COOKIE = await seedSession();
  const viewer = auth.createSession({ username: 'a-visitor', ip: '127.0.0.1' });
  VIEWER_COOKIE = `${auth.SESSION_COOKIE}=${viewer.id}`;
});

test.beforeEach(() => {
  locks._resetLimits();
  updatesStore.clearUpdates();
});

test.after(async () => {
  await ENGINE?.stop();
  if (OLD_SOCKET) process.env.OPUSHUB_DOCKER_SOCKET = OLD_SOCKET;
  else delete process.env.OPUSHUB_DOCKER_SOCKET;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
});

function makeReq(method, pathname, body = null, headers = {}) {
  const h = { ...headers };
  if (COOKIE && !('cookie' in h)) h.cookie = COOKIE;
  h['content-type'] = 'application/json';
  h.host = 'opushub.test';
  return {
    method,
    headers: h,
    [Symbol.asyncIterator]() {
      const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
      let i = 0;
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
    },
  };
}

async function call(method, pathname, body = null, headers = null) {
  const state = { status: 200, body: '', headers: {} };
  const res = {
    setHeader: (k, v) => { state.headers[String(k).toLowerCase()] = v; },
    writeHead: (s, h) => { state.status = s; for (const [k, v] of Object.entries(h || {})) state.headers[String(k).toLowerCase()] = v; },
    end: (b) => { state.body = String(b ?? ''); },
  };
  await handleApi(makeReq(method, pathname, body, headers || {}), res, new URL(pathname, 'http://opushub.test'));
  let json = null;
  try { json = JSON.parse(state.body || 'null'); } catch {}
  return { status: state.status, json, text: state.body };
}

/* ==================================================================== */
/* Part 1: Update State Model & Persistence                             */
/* ==================================================================== */

test('update state model enforces honest versions and valid digest', () => {
  const rec = updatesModel.makeUpdateRecord({
    containerId: 'c12345678901',
    serviceId: 'jellyfin',
    imageRef: 'jellyfin/jellyfin:10.9.0',
    currentDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    availableDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    currentTag: '10.9.0',
    availableTag: '10.9.1',
    status: 'update_available',
  });
  assert.equal(rec.containerId, 'c12345678901');
  assert.equal(rec.serviceId, 'jellyfin');
  assert.equal(rec.updateAvailable, true);
  assert.equal(rec.availableTag, '10.9.1');

  // Digest-only update has no fake version
  const digestOnly = updatesModel.makeUpdateRecord({
    containerId: 'c12345678902',
    imageRef: 'alpine:latest',
    availableDigest: 'sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  });
  assert.equal(digestOnly.availableTag, null);
  assert.equal(digestOnly.availableDigest?.startsWith('sha256:'), true);
});

test('update state persists outside presentation files', () => {
  updatesStore.putUpdate({
    containerId: 'c12345678901',
    serviceId: 'jellyfin',
    imageRef: 'jellyfin/jellyfin:latest',
    availableDigest: 'sha256:aaaaabbbbbcccccdddddeeeeefffff000001111122222333334444455555666667',
    status: 'update_available',
  });

  const got = updatesStore.getUpdate('c12345678901');
  assert.ok(got);
  assert.equal(got.serviceId, 'jellyfin');

  // Verify file location
  assert.ok(updatesStore.UPDATES_FILE.startsWith(DATA_DIR));
  assert.equal(updatesStore.UPDATES_FILE.includes('config'), false);
});

/* ==================================================================== */
/* Part 2: Diun Webhook Intake & Duplicate Suppression                   */
/* ==================================================================== */

test('Diun webhook detects update and publishes container.update_available', async () => {
  const payload = {
    diun_version: '4.28.0',
    hostname: 'homelab',
    status: 'update',
    image: 'docker.io/jellyfin/jellyfin:10.9.1',
    digest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    metadata: {
      ctn_id: 'c12345678901',
      ctn_names: 'jellyfin',
    },
  };

  let published = null;
  const unsub = eventsBus.bus.subscribe((e) => e.type === 'container.update_available', (e) => {
    published = e;
  });

  const res = await updatesDiun.handleDiunWebhook(payload);
  assert.equal(res.ok, true);
  assert.equal(res.duplicated, false);
  assert.ok(published);
  assert.equal(published.type, 'container.update_available');
  assert.equal(published.payload.imageRef, 'docker.io/jellyfin/jellyfin:10.9.1');

  // Duplicate suppression for the same unchanged update
  const dup = await updatesDiun.handleDiunWebhook(payload);
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicated, true);

  unsub.unsubscribe();
});

test('Digest change for same container publishes new update event', async () => {
  const payload1 = {
    status: 'update',
    image: 'jellyfin/jellyfin:latest',
    digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    metadata: { ctn_id: 'c12345678901', ctn_names: 'jellyfin' },
  };
  const payload2 = {
    status: 'update',
    image: 'jellyfin/jellyfin:latest',
    digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    metadata: { ctn_id: 'c12345678901', ctn_names: 'jellyfin' },
  };

  const r1 = await updatesDiun.handleDiunWebhook(payload1);
  assert.equal(r1.duplicated, false);

  const r2 = await updatesDiun.handleDiunWebhook(payload2);
  assert.equal(r2.duplicated, false);
  assert.equal(r2.record.availableDigest, payload2.digest);
});

/* ==================================================================== */
/* Part 3: Update Eligibility & Unsupported Targets                     */
/* ==================================================================== */

test('OpusHub self-container is ineligible for update', () => {
  const el = updatesEligibility.evaluateEligibility({
    container: { id: 'opushub12345', name: 'opushub', image: 'ghcr.io/lucif3r-d3vil/opushub:latest' },
  });
  assert.equal(el.eligible, false);
  assert.match(el.reason, /cannot recreate its own container/i);
});

test('Recovery infrastructure (autoheal) is ineligible for update', () => {
  const el = updatesEligibility.evaluateEligibility({
    container: { id: 'autoheal12345', name: 'autoheal', image: 'willfarrell/autoheal:latest' },
  });
  assert.equal(el.eligible, false);
  assert.match(el.reason, /Recovery infrastructure/i);
});

test('Container with opt-out label is ineligible for update', () => {
  const el = updatesEligibility.evaluateEligibility({
    container: { id: 'custom12345', name: 'my-app', image: 'app:v1', rawLabels: { 'opushub.update': 'false' } },
  });
  assert.equal(el.eligible, false);
  assert.match(el.reason, /opted out/i);
});

/* ==================================================================== */
/* Part 4: Autoheal Observer & Webhook Normalization                     */
/* ==================================================================== */

test('Autoheal successful restart webhook normalizes to container.autoheal.restarted', async () => {
  let eventCaptured = null;
  const unsub = eventsBus.bus.subscribe((e) => e.type === 'container.autoheal.restarted', (e) => {
    eventCaptured = e;
  });

  const payload = {
    text: 'Container jellyfin (abc123def456) found to be unhealthy. Successfully restarted the container!',
  };

  const res = await autohealObserver.handleAutohealWebhook(payload);
  assert.equal(res.ok, true);
  assert.equal(res.recovery.containerName, 'jellyfin');
  assert.equal(res.recovery.success, true);

  assert.ok(eventCaptured);
  assert.equal(eventCaptured.type, 'container.autoheal.restarted');
  assert.equal(eventCaptured.severity, 'notice');

  // Verify secret sanitization: no env or socket paths in payload
  const strPayload = JSON.stringify(eventCaptured);
  assert.equal(strPayload.includes('docker.sock'), false);
  assert.equal(strPayload.includes('hunter2'), false);

  unsub.unsubscribe();
});

test('Autoheal failed restart webhook normalizes to container.autoheal.failed', async () => {
  let eventCaptured = null;
  const unsub = eventsBus.bus.subscribe((e) => e.type === 'container.autoheal.failed', (e) => {
    eventCaptured = e;
  });

  const payload = {
    text: 'Container postgres (def456abc123) found to be unhealthy. Failed to restart the container!',
  };

  const res = await autohealObserver.handleAutohealWebhook(payload);
  assert.equal(res.ok, true);
  assert.equal(res.recovery.success, false);

  assert.ok(eventCaptured);
  assert.equal(eventCaptured.type, 'container.autoheal.failed');
  assert.equal(eventCaptured.severity, 'critical');

  unsub.unsubscribe();
});

/* ==================================================================== */
/* Part 5: Update Now API, Confirmation Token, CSRF, & Auth              */
/* ==================================================================== */

test('container-updates routes require a session', async () => {
  const routes = [
    ['GET', '/api/container-updates'],
    ['GET', '/api/container-updates/jellyfin'],
    ['POST', '/api/container-updates/dry-run'],
    ['POST', '/api/container-updates/apply'],
  ];
  for (const [m, p] of routes) {
    const res = await call(m, p, {}, { cookie: '' });
    assert.equal(res.status, 401, `${m} ${p} must require a session`);
  }
});

test('container-updates mutations require CSRF protection', async () => {
  const cross = { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' };
  const res = await call('POST', '/api/container-updates/apply', { target: { type: 'service', id: 'jellyfin' } }, cross);
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'csrf');
});

test('dry-run update preflight issues confirmation token', async () => {
  // Setup pending update on jellyfin container
  updatesStore.putUpdate({
    containerId: 'a1b2c3d4e5f6',
    serviceId: 'jellyfin',
    imageRef: 'jellyfin/jellyfin:10.9.1',
    currentDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    availableDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    status: 'update_available',
  });

  const res = await call('POST', '/api/container-updates/dry-run', {
    target: { type: 'service', id: 'jellyfin' },
  });

  assert.equal(res.status, 200);
  assert.ok(res.json.confirmation?.token);
  assert.equal(res.json.plan?.action, 'container.update_now');
});

test('execute update requires valid confirmation token and spends it', async () => {
  updatesStore.putUpdate({
    containerId: 'a1b2c3d4e5f6',
    serviceId: 'jellyfin',
    imageRef: 'jellyfin/jellyfin:10.9.1',
    currentDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    availableDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    status: 'update_available',
  });

  const dry = await call('POST', '/api/container-updates/dry-run', {
    target: { type: 'service', id: 'jellyfin' },
  });
  const token = dry.json.confirmation.token;

  // Stolen or wrong token fails
  const bad = await call('POST', '/api/container-updates/apply', {
    target: { type: 'service', id: 'jellyfin' },
    confirmationToken: 'invalid-token-12345',
  });
  assert.equal(bad.status, 409);

  // Successful update execution
  const ok = await call('POST', '/api/container-updates/apply', {
    target: { type: 'service', id: 'jellyfin' },
    confirmationToken: token,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.record.status, 'updated');

  // Replay fails (token is single-use)
  const replay = await call('POST', '/api/container-updates/apply', {
    target: { type: 'service', id: 'jellyfin' },
    confirmationToken: token,
  });
  assert.equal(replay.status, 409);
});

/* ==================================================================== */
/* Part 6: Comprehensive Security & Boundary Regression Tests           */
/* ==================================================================== */

test('webhook authentication: rejects missing or invalid Bearer secret', async () => {
  const webhookAuth = await import('./updates/webhookAuth.js');
  webhookAuth.setWebhookSecretForTest('correct-horse-battery-staple');

  // 1. Missing auth
  const res1 = await call('POST', '/api/container-updates/webhook', { image: 'jellyfin/jellyfin:10.9.1' });
  assert.equal(res1.status, 401);

  // 2. Invalid auth
  const res2 = await call('POST', '/api/container-updates/webhook', { image: 'jellyfin/jellyfin:10.9.1' }, { authorization: 'Bearer wrong-secret' });
  assert.equal(res2.status, 403);

  // 3. Valid auth
  const res3 = await call(
    'POST',
    '/api/container-updates/webhook',
    {
      status: 'update',
      image: 'jellyfin/jellyfin:10.9.1',
      digest: 'sha256:7777777777777777777777777777777777777777777777777777777777777777',
      metadata: { ctn_names: 'jellyfin' },
    },
    { authorization: 'Bearer correct-horse-battery-staple' }
  );
  assert.equal(res3.status, 200);
  assert.equal(res3.json.ok, true);
});

test('webhook target validation: rejects fake target or repo mismatch', async () => {
  const webhookAuth = await import('./updates/webhookAuth.js');
  webhookAuth.setWebhookSecretForTest('test-secret');

  // Fake non-existent target
  const fakeTargetRes = await call(
    'POST',
    '/api/container-updates/webhook',
    {
      status: 'update',
      image: 'evil/malicious:latest',
      digest: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
      metadata: { ctn_names: 'non-existent-container' },
    },
    { authorization: 'Bearer test-secret' }
  );
  assert.equal(fakeTargetRes.status, 400);
  assert.equal(fakeTargetRes.json.code, 'unmatched_target');

  // Repository mismatch (targeting jellyfin with an arbitrary alpine image)
  const repoMismatchRes = await call(
    'POST',
    '/api/container-updates/webhook',
    {
      status: 'update',
      image: 'alpine:latest',
      digest: 'sha256:8888888888888888888888888888888888888888888888888888888888888888',
      metadata: { ctn_names: 'jellyfin' },
    },
    { authorization: 'Bearer test-secret' }
  );
  assert.equal(repoMismatchRes.status, 400);
  assert.equal(repoMismatchRes.json.code, 'image_repo_mismatch');
});

test('per-target locking prevents concurrent updates on same container', async () => {
  const targets = await import('./operations/targets.js');
  const resolved = await targets.resolveTarget({ type: 'service', id: 'jellyfin' });
  const containerId = resolved.target.containerId;

  updatesStore.putUpdate({
    containerId,
    serviceId: 'jellyfin',
    imageRef: 'jellyfin/jellyfin:10.9.1',
    status: 'update_available',
  });

  // Acquire dry-run token
  const dry = await call('POST', '/api/container-updates/dry-run', { target: { type: 'service', id: 'jellyfin' } });
  const token = dry.json.confirmation.token;

  // Manually lock container as if another tab/user is updating it
  locks.acquire(containerId, { action: 'container.update_now' });

  // Update should be rejected with 409 conflict
  const res = await call('POST', '/api/container-updates/apply', {
    target: { type: 'service', id: 'jellyfin' },
    confirmationToken: token,
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'conflict');

  locks.release(containerId);
});

test('autoheal race suppression: suppresses autoheal alert during active update window', async () => {
  const txStore = await import('./updates/transaction.js');
  txStore.markContainerUpdating('jellyfin');

  const payload = {
    text: 'Container jellyfin (a1b2c3d4e5f6) found to be unhealthy. Successfully restarted the container!',
  };
  const res = await autohealObserver.handleAutohealWebhook(payload);
  assert.equal(res.ok, true);
  assert.equal(res.suppressed, true);

  txStore.unmarkContainerUpdating('jellyfin');
});

test('configuration preservation: replacement create payload keeps labels, mounts, and env', async () => {
  const preserve = await import('./updates/preserveConfig.js');
  const mockInspect = {
    Id: 'a1b2c3d4e5f6'.padEnd(64, '0'),
    Name: '/jellyfin',
    Config: {
      Image: 'jellyfin/jellyfin:10.9.1',
      Env: ['TZ=UTC', 'JELLYFIN_PublishedServerUrl=https://stream.lab.internal'],
      Labels: {
        'traefik.enable': 'true',
        'traefik.http.routers.jellyfin.rule': 'Host(`stream.lab.internal`)',
        'autoheal': 'true',
        'opushub.group': 'Media',
      },
      Healthcheck: {
        Test: ['CMD-SHELL', 'curl -f http://localhost:8096/health || exit 1'],
        Interval: 10000000000,
      },
    },
    HostConfig: {
      Binds: ['/mnt/media:/media:ro', 'jellyfin-config:/config:rw'],
      NetworkMode: 'opusgrid_net',
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: 2147483648,
    },
    NetworkSettings: {
      Networks: {
        opusgrid_net: { IPAddress: '172.28.0.5', Aliases: ['jellyfin', 'stream'] },
      },
    },
  };

  const { createBody } = preserve.buildReplacementConfig(mockInspect, 'jellyfin/jellyfin:10.9.2');

  // Verify Image updated
  assert.equal(createBody.Image, 'jellyfin/jellyfin:10.9.2');

  // Verify Traefik & Autoheal Labels preserved
  assert.equal(createBody.Labels['traefik.enable'], 'true');
  assert.equal(createBody.Labels['traefik.http.routers.jellyfin.rule'], 'Host(`stream.lab.internal`)');
  assert.equal(createBody.Labels['autoheal'], 'true');

  // Verify Volume Binds preserved (modes intact)
  assert.deepEqual(createBody.HostConfig.Binds, ['/mnt/media:/media:ro', 'jellyfin-config:/config:rw']);

  // Verify Environment preserved
  assert.ok(createBody.Env.includes('TZ=UTC'));
  assert.ok(createBody.Env.includes('JELLYFIN_PublishedServerUrl=https://stream.lab.internal'));

  // Verify Restart Policy & Healthcheck preserved
  assert.equal(createBody.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.deepEqual(createBody.Healthcheck.Test, ['CMD-SHELL', 'curl -f http://localhost:8096/health || exit 1']);

  // Verify Resource Limits preserved
  assert.equal(createBody.HostConfig.Memory, 2147483648);
});

test('forged Diun webhook with fake digest fails independently at registry pull before recreation', async () => {
  const webhookAuth = await import('./updates/webhookAuth.js');
  webhookAuth.setWebhookSecretForTest('valid-secret');

  // 1. Attacker posts a forged webhook containing a non-existent fake digest
  const forgedRes = await call(
    'POST',
    '/api/container-updates/webhook',
    {
      status: 'update',
      image: 'jellyfin/jellyfin:fake-digest-99999',
      digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      metadata: { ctn_names: 'jellyfin' },
    },
    { authorization: 'Bearer valid-secret' }
  );
  assert.equal(forgedRes.status, 200);

  // 2. Preflight dry-run plan derives image strictly from verified inventory & store record, NOT browser input
  const dry = await call('POST', '/api/container-updates/dry-run', {
    target: { type: 'service', id: 'jellyfin' },
    // Attacker tries to inject an arbitrary image in dry-run body:
    maliciousImage: 'evil-hacker/backdoor:latest',
  });
  assert.equal(dry.status, 200);
  // Verify that the server's plan references its independently resolved record, NOT the injected maliciousImage
  assert.equal(dry.json.plan.target.currentImage, 'jellyfin/jellyfin:fake-digest-99999');

  // 3. User or admin clicks Update Now
  const applyRes = await call('POST', '/api/container-updates/apply', {
    target: { type: 'service', id: 'jellyfin' },
    confirmationToken: dry.json.confirmation.token,
    // Attacker tries to pass arbitrary image to apply endpoint:
    image: 'evil-hacker/backdoor:latest',
  });

  // 4. Update Now independently validates and executes pull against registry.
  // Because the digest/image does not exist in the registry, it fails safely at the pull stage with 502,
  // and the existing container is left completely untouched (no stop, no rename, no recreation).
  assert.equal(applyRes.status, 502);
  assert.equal(applyRes.json.code, 'pull_failed');

  // Verify the original container in Docker is still running untouched
  const targets = await import('./operations/targets.js');
  const resolved = await targets.resolveTarget({ type: 'service', id: 'jellyfin' });
  const docker = await import('./providers/docker.js');
  const inspect = await docker.inspectContainer(resolved.target.containerId);
  assert.equal(inspect.state.status, 'running');
});
