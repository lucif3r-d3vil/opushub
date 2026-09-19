// Catalog runner — what `service.install` does once the operations engine has authenticated,
// authorised, planned, confirmed and locked `catalog:<id>:<name>` and `name:<name>`.
//
// The pipeline is the plan, executed in order, with every engine call going through the frozen
// control adapter (updates/recreateAdapter.js). No compose CLI, no shell, no hooks:
//
//   pull (registry credential by host) → networks (created this run are owned) → volumes (ensure)
//   → create → connect extra networks → start → verify running [+ healthy when the manifest has
//   a healthcheck] → monitoring registration → install record → Event Bus / Activity (engine)
//
// Failure at any step rolls back what THIS run created: the container (force removed), networks
// created this run (if unused). Named volumes are never removed — data outlives a failed attempt
// and the operator is told so. The report says exactly what happened.
import * as adapter from '../updates/recreateAdapter.js';
import * as docker from '../providers/docker.js';
import { createBodyFromSpec } from '../containers/spec.js';
import * as registries from '../registries/auth.js';
import * as monitoring from '../monitoring/engine.js';
import { logEvent } from '../activity.js';
import * as store from './store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (code, reason, detail = null, extra = {}) => ({ ok: false, code, reason, detail, ...extra });
const fromAdapter = (res, reason) => fail(res.code || 'engine_error', reason, res.detail || res.reason || (res.status ? `docker HTTP ${res.status}` : null));

async function waitFor(id, predicate, ms) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(Math.min(700, Math.max(100, ms / 10)));
    const insp = await adapter.inspectContainer(id);
    if (!insp.ok) continue;
    last = insp.data;
    if (predicate(last)) return { ok: true, inspect: last };
  }
  return { ok: false, inspect: last };
}

export async function install({ target, action, plan, onStep, actor = null, operationId = null }) {
  const inst = plan?._install;
  if (!inst) return fail('no_plan', 'The installation has no plan.');
  const { spec, manifest, built, registryId } = inst;
  const step = (s) => { try { onStep?.(s); } catch {} };
  const report = { image: null, networks: [], volumes: [], container: null, monitor: null, warnings: [] };
  const createdNetworks = [];
  let containerId = null;
  const started = Date.now();
  const budget = () => Math.max(20_000, action.timeoutMs - (Date.now() - started) - 15_000);

  const rollback = async (why) => {
    step(`rolling back: ${why}`);
    if (containerId) { await adapter.deleteContainer(containerId, { force: true }).catch(() => {}); report.container = { ...(report.container || {}), result: 'removed (rollback)' }; }
    for (const n of createdNetworks) {
      const r = await adapter.removeNetwork(n).catch(() => ({ ok: false }));
      const entry = report.networks.find((x) => x.name === n);
      if (entry) entry.result = r.ok ? 'removed (rollback)' : 'left in place (could not remove)';
    }
    if (report.volumes.length) report.warnings.push(`named volume${report.volumes.length === 1 ? '' : 's'} ${report.volumes.map((v) => v.name).join(', ')} kept — data is never removed by a rollback`);
  };
  const failed = async (e) => {
    await rollback(e.reason);
    store.recordInstall({ manifest: manifest.id, name: spec.name, image: spec.image, version: built.image.version, status: 'failed', error: e.reason, operationId, actor, report });
    logEvent({ source: 'operations', type: 'service.install_failed', subject: spec.name, message: `install of ${manifest.name} as ${spec.name} failed: ${e.reason}`, severity: 'warning', category: 'service' });
    return { ...e, report, rolledBack: true };
  };

  try {
    // 1 — image
    const present = await docker.imageInfo(spec.image).catch(() => null);
    if (!present) {
      step(`pull ${spec.image}`);
      const auth = await registries.authHeaderFor(spec.image, registryId).catch(() => null);
      const p = await adapter.pullImage(spec.image, { timeoutMs: Math.min(budget(), 300_000), registryAuth: auth?.header || null });
      if (!p.ok) return failed(fromAdapter(p, `The image ${spec.image} could not be pulled, so nothing was created.`));
      report.image = { ref: spec.image, result: 'pulled', registry: auth?.registryId || null };
    } else report.image = { ref: spec.image, result: 'present' };

    // 2 — networks owned by this install
    for (const n of built.createNetworks) {
      step(`network ${n}`);
      const r = await adapter.createNetwork({ Name: n, Driver: 'bridge', Attachable: true, CheckDuplicate: true, Labels: { 'io.opushub.managed': 'catalog', 'io.opushub.catalog': manifest.id, 'io.opushub.catalog.container': spec.name } });
      if (!r.ok) { report.networks.push({ name: n, result: 'failed' }); return failed(fromAdapter(r, `Network ${n} could not be created.`)); }
      createdNetworks.push(n);
      report.networks.push({ name: n, result: 'created' });
    }
    // 3 — volumes (ensure; never removed)
    for (const v of built.namedVolumes) {
      step(`volume ${v}`);
      const r = await adapter.createVolume({ Name: v, Driver: 'local', Labels: { 'io.opushub.managed': 'catalog', 'io.opushub.catalog': manifest.id } });
      if (!r.ok) { report.volumes.push({ name: v, result: 'failed' }); return failed(fromAdapter(r, `Volume ${v} could not be created.`)); }
      report.volumes.push({ name: v, result: 'ensured' });
    }

    // 4 — create + networks + start
    step(`create ${spec.name}`);
    const { createBody, auxiliaryNetworks } = createBodyFromSpec(spec);
    const c = await adapter.createContainer(spec.name, createBody, { timeoutMs: 30_000 });
    if (!c.ok || !c.id) return failed(fromAdapter(c, c.code === 'conflict' ? `A container named ${spec.name} already exists.` : `The container could not be created${c.detail ? ` (${c.detail})` : ''}.`));
    containerId = c.id;
    report.container = { id: c.id.slice(0, 12), name: spec.name, result: 'created' };
    for (const net of auxiliaryNetworks) {
      const r = await adapter.connectNetwork(net.name, c.id, net.endpointConfig).catch(() => ({ ok: false }));
      if (!r.ok) return failed(fail('network_failed', `The container could not be connected to network ${net.name}.`));
    }
    step('start');
    const s = await adapter.startContainer(c.id);
    if (!s.ok) return failed(fromAdapter(s, `The container was created but failed to start${s.detail ? ` (${s.detail})` : ''}.`));

    // 5 — verify: running, and healthy when there is a healthcheck (bounded by the action's verify window)
    step(spec.healthcheck ? 'verify running and healthy' : 'verify running');
    const v = await waitFor(c.id, (i) => i.State?.Running === true || ['exited', 'dead'].includes(i.State?.Status), Math.min(action.verifyMs, 15_000));
    const st = v.inspect?.State;
    if (!st || st.Running !== true) return failed(fail('verification_failed', `The container started but exited immediately${Number.isFinite(st?.ExitCode) ? ` (exit code ${st.ExitCode})` : ''}.`));
    report.container.result = 'running';
    if (spec.healthcheck && spec.healthcheck.test?.[0] !== 'NONE') {
      const h = await waitFor(c.id, (i) => i.State?.Health?.Status === 'healthy' || i.State?.Health?.Status === 'unhealthy' || i.State?.Running !== true, Math.max(5_000, action.verifyMs - 15_000));
      const hs = h.inspect?.State?.Health?.Status || null;
      if (hs === 'unhealthy' || h.inspect?.State?.Running !== true) return failed(fail('verification_failed', `${spec.name} started but Docker reports it ${hs || 'not running'}.`));
      report.container.health = hs || 'starting';
      if (!hs || hs === 'starting') report.warnings.push('health was still "starting" when the verification window closed; monitoring will follow it');
    }

    // 6 — monitoring registration (a Docker or HTTP monitor through the monitoring engine's own API)
    if (built.integrations.monitoring) {
      step('register monitor');
      try {
        const m = built.integrations.monitoring;
        const url = m.type === 'http' && built.integrations.proxy?.url ? new URL(m.path, built.integrations.proxy.url).toString() : null;
        const draft = m.type === 'http' && url
          ? { type: 'http', name: `${manifest.name} (${spec.name})`, target: { service: { name: spec.name }, url }, expected: m.expectStatus ? { status: m.expectStatus } : undefined, provenance: 'configured', source: { kind: 'catalog', provider: manifest.id } }
          : { type: 'docker', name: `${manifest.name} (${spec.name})`, target: { service: { name: spec.name } }, provenance: 'configured', source: { kind: 'catalog', provider: manifest.id } };
        try { const { invalidateDiscovery } = await import('../model.js'); invalidateDiscovery(); } catch {}
        const mon = await monitoring.createMonitor(draft, { actor: actor || 'catalog' });
        report.monitor = { id: mon.id, type: mon.type, result: 'created' };
      } catch (err) {
        report.monitor = { result: 'skipped', reason: String(err?.message || err).slice(0, 160) };
        report.warnings.push(`monitor not created: ${report.monitor.reason}`);
      }
    }

    store.recordInstall({ manifest: manifest.id, name: spec.name, image: spec.image, version: built.image.version, status: 'succeeded', operationId, actor, report, config: { network: spec.networkMode, expose: built.expose?.domain || null, volumes: spec.volumes.map((x) => ({ target: x.target, type: x.type, source: x.type === 'bind' ? x.source : x.source })), monitoring: !!built.integrations.monitoring, autoheal: built.integrations.autoheal, updates: built.integrations.updates } });
    logEvent({ source: 'operations', type: 'service.installed', subject: spec.name, message: `${manifest.name} installed as ${spec.name} (${spec.image})${actor ? ` by ${actor}` : ''}`, severity: 'notice', category: 'service' });
    return {
      ok: true,
      result: {
        newContainerId: c.id.slice(0, 12), name: spec.name, image: spec.image, manifest: manifest.id, version: built.image.version,
        report, url: built.integrations.proxy?.url || null,
      },
    };
  } catch (err) {
    return failed(fail('engine_error', 'The installation could not be completed.', String(err?.message || err).slice(0, 200)));
  }
}
