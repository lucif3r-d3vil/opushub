// Stack runners — what `stack.deploy|start|stop|remove` actually do, once the operations engine
// has authenticated, authorised, planned, confirmed and locked the stack and every member.
//
// Deploy is a pipeline over the plan, in dependency order:
//   networks → volumes → per service: pull (by policy) → create | recreate (containers/recreate.js
//   ladder, rolled back on failure) | start → verify → next service.
// A failure stops the pipeline. Services already deployed in THIS run are rolled back to what
// they were: recreated ones are restored by the ladder itself; newly created ones are removed;
// networks created in this run are removed if no other container uses them. Services that were
// not reached are left exactly as they were. The report says which is which — never "deployed"
// when part of it is not.
//
// Every engine call goes through the frozen control adapter (updates/recreateAdapter.js) or the
// lifecycle adapter (providers/dockerOperations.js). There is no compose CLI and no shell.
import * as adapter from '../updates/recreateAdapter.js';
import * as dockerOps from '../providers/dockerOperations.js';
import * as docker from '../providers/docker.js';
import { createBodyFromSpec } from '../containers/spec.js';
import { recreateContainer } from '../containers/recreate.js';
import * as registries from '../registries/auth.js';
import * as store from './store.js';
import { ownedNetworks } from './targets.js';

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

/* ------------------------------------------------------------------ */
/* deploy                                                              */
/* ------------------------------------------------------------------ */

export async function deploy({ target, action, plan, onStep, actor = null, operationId = null }) {
  const model = plan?._model;
  if (!model) return fail('no_plan', 'The deployment has no plan.');
  const step = (s) => { try { onStep?.(s); } catch {} };
  const report = { services: [], networks: [], volumes: [], warnings: [] };
  const createdNetworks = [];
  const createdContainers = [];   // { id, key } — new this run, removed on rollback
  const started = Date.now();
  const budget = () => Math.max(20_000, action.timeoutMs - (Date.now() - started) - 15_000);

  const finish = (status, error = null) => {
    const entry = {
      stack: target.id, status, operationId, actor, revision: plan.revision, configHash: plan.configHash,
      services: report.services, networks: report.networks, warnings: report.warnings, error,
      ...(status === 'succeeded' ? { compose: store.getStack(target.id)?.compose ?? null, env: store.getStack(target.id)?.env ?? null } : {}),
    };
    store.appendHistory(entry);
    store.recordDeploy(target.id, { at: Date.now(), by: actor, status, operationId, revision: plan.revision, configHash: plan.configHash });
  };

  try {
    // 1 — networks
    for (const n of plan.networks) {
      if (n.action !== 'create') { report.networks.push({ name: n.name, result: n.action }); continue; }
      step(`network ${n.name}`);
      const def = model.networks.find((x) => x.name === n.name);
      const r = await adapter.createNetwork({
        Name: n.name, Driver: 'bridge', Internal: !!def?.internal, Attachable: def?.attachable !== false, CheckDuplicate: true,
        Labels: { ...(def?.labels || {}), 'com.docker.compose.project': model.name, 'com.docker.compose.network': def?.key || n.name, 'io.opushub.managed': 'stack' },
      });
      if (!r.ok) { const e = fromAdapter(r, `Network ${n.name} could not be created.`); report.networks.push({ name: n.name, result: 'failed', error: e.reason }); await rollback(); finish('failed', e.reason); return { ...e, report, rolledBack: true }; }
      createdNetworks.push(n.name);
      report.networks.push({ name: n.name, result: 'created' });
    }
    // 2 — volumes (idempotent; never removed)
    for (const v of plan.volumes) {
      if (v.action !== 'create') { report.volumes.push({ name: v.name, result: v.action }); continue; }
      step(`volume ${v.name}`);
      const def = model.volumes.find((x) => x.name === v.name);
      const r = await adapter.createVolume({ Name: v.name, Driver: 'local', Labels: { ...(def?.labels || {}), 'com.docker.compose.project': model.name, 'com.docker.compose.volume': def?.key || v.name, 'io.opushub.managed': 'stack' } });
      if (!r.ok) { const e = fromAdapter(r, `Volume ${v.name} could not be created.`); report.volumes.push({ name: v.name, result: 'failed', error: e.reason }); await rollback(); finish('failed', e.reason); return { ...e, report, rolledBack: true }; }
      report.volumes.push({ name: v.name, result: 'created' });
    }

    // 3 — services, in dependency order (model.services is already topologically sorted)
    for (const svc of model.services) {
      const planned = plan.services.find((s) => s.key === svc.key);
      const member = target.members.find((m) => m.service === svc.key) || null;
      if (planned.action === 'unchanged') { report.services.push({ key: svc.key, container: svc.containerName, result: 'unchanged' }); continue; }

      // pull by policy
      if (svc.pullPolicy === 'always' || (svc.pullPolicy === 'missing' && !(await docker.imageInfo(svc.spec.image).catch(() => null)))) {
        if (svc.pullPolicy === 'never') { /* unreachable */ }
        step(`pull ${svc.spec.image}`);
        const auth = await registries.authHeaderFor(svc.spec.image, null).catch(() => null);
        const p = await adapter.pullImage(svc.spec.image, { timeoutMs: Math.min(budget(), 300_000), registryAuth: auth?.header || null });
        if (!p.ok) { const e = fromAdapter(p, `The image ${svc.spec.image} for ${svc.key} could not be pulled.`); report.services.push({ key: svc.key, container: svc.containerName, result: 'failed', error: e.reason }); await rollback(); finish('failed', e.reason); return { ...e, report, rolledBack: true }; }
      } else if (svc.pullPolicy === 'never' && !(await docker.imageInfo(svc.spec.image).catch(() => null))) {
        const e = fail('image_missing', `The image ${svc.spec.image} for ${svc.key} is not present and pull_policy is never.`);
        report.services.push({ key: svc.key, container: svc.containerName, result: 'failed', error: e.reason }); await rollback(); finish('failed', e.reason); return { ...e, report, rolledBack: true };
      }

      const { createBody, auxiliaryNetworks } = createBodyFromSpec(svc.spec);

      if (planned.action === 'start') {
        step(`start ${svc.key}`);
        const s = await dockerOps.startContainer(member.containerId, { timeoutMs: 30_000 });
        if (!s.ok && s.status !== 304) { const e = fail('start_failed', `${svc.key} could not be started.`); report.services.push({ key: svc.key, container: svc.containerName, result: 'failed', error: e.reason }); await rollback(); finish('failed', e.reason); return { ...e, report, rolledBack: true }; }
        const v = await waitFor(member.containerId, (i) => i.State?.Running === true, action.verifyMs);
        if (!v.ok) { const e = fail('verification_failed', `${svc.key} did not stay running.`); report.services.push({ key: svc.key, container: svc.containerName, result: 'failed', error: e.reason }); await rollback(); finish('failed', e.reason); return { ...e, report, rolledBack: true }; }
        report.services.push({ key: svc.key, container: svc.containerName, result: 'started', containerId: member.containerId.slice(0, 12) });
        continue;
      }

      if (planned.action === 'recreate') {
        step(`recreate ${svc.key}`);
        const insp = await adapter.inspectContainer(member.containerId);
        const wasRunning = insp.ok && (insp.data.State?.Running === true || insp.data.State?.Paused === true);
        const rec = await recreateContainer({
          containerId: member.containerId, containerName: member.containerName, newName: svc.containerName, createBody, auxiliaryNetworks,
          kind: 'stack', wasRunning: true, verifyMs: action.verifyMs, service: svc.key, onStep: (st) => step(`${svc.key}: ${st}`),
        });
        if (!rec.ok) {
          const e = fail(rec.code, `${svc.key}: ${rec.reason}`, rec.rolledBack ? 'rolled back' : 'not rolled back');
          report.services.push({ key: svc.key, container: svc.containerName, result: 'failed', error: e.reason, rolledBack: rec.rolledBack, transactionId: rec.tx?.id || null });
          await rollback(); finish('failed', e.reason); return { ...e, report, rolledBack: rec.rolledBack };
        }
        if (rec.warnings?.length) report.warnings.push(...rec.warnings.map((w) => `${svc.key}: ${w}`));
        report.services.push({ key: svc.key, container: svc.containerName, result: 'recreated', containerId: rec.newId.slice(0, 12), previousContainerId: member.containerId.slice(0, 12), wasRunning, transactionId: rec.tx?.id || null });
        continue;
      }

      // create
      step(`create ${svc.key}`);
      const c = await adapter.createContainer(svc.containerName, createBody, { timeoutMs: 30_000 });
      if (!c.ok || !c.id) {
        const e = fromAdapter(c, c.code === 'conflict' ? `A container named ${svc.containerName} already exists (not part of this stack).` : `${svc.key} could not be created.`);
        report.services.push({ key: svc.key, container: svc.containerName, result: 'failed', error: e.reason }); await rollback(); finish('failed', e.reason); return { ...e, report, rolledBack: true };
      }
      createdContainers.push({ id: c.id, key: svc.key });
      for (const net of auxiliaryNetworks) {
        const r = await adapter.connectNetwork(net.name, c.id, net.endpointConfig).catch(() => ({ ok: false }));
        if (!r.ok) report.warnings.push(`${svc.key}: network ${net.name} could not be attached`);
      }
      const s = await adapter.startContainer(c.id);
      if (!s.ok) { const e = fromAdapter(s, `${svc.key} was created but failed to start.`); report.services.push({ key: svc.key, container: svc.containerName, result: 'failed', error: e.reason }); await rollback(); finish('failed', e.reason); return { ...e, report, rolledBack: true }; }
      const v = await waitFor(c.id, (i) => i.State?.Running === true || i.State?.Status === 'exited' || i.State?.Status === 'dead', action.verifyMs);
      if (!v.inspect || v.inspect.State?.Running !== true) {
        const exit = v.inspect?.State?.ExitCode;
        const e = fail('verification_failed', `${svc.key} started but exited immediately${Number.isFinite(exit) ? ` (exit code ${exit})` : ''}.`);
        report.services.push({ key: svc.key, container: svc.containerName, result: 'failed', error: e.reason }); await rollback(); finish('failed', e.reason); return { ...e, report, rolledBack: true };
      }
      report.services.push({ key: svc.key, container: svc.containerName, result: 'created', containerId: c.id.slice(0, 12) });
    }

    // 4 — orphans: containers of this project whose service left the document
    for (const o of plan._orphans || []) {
      step(`remove ${o.service}`);
      await adapter.stopContainer(o.containerId, { stopTimeout: 10 }).catch(() => {});
      const d = await adapter.deleteContainer(o.containerId, { force: true });
      report.services.push({ key: o.service, container: o.containerName, result: d.ok ? 'removed' : 'failed', ...(d.ok ? {} : { error: 'could not be removed' }) });
      if (!d.ok) report.warnings.push(`${o.service}: the container is no longer in the document but could not be removed`);
    }

    finish('succeeded');
    return { ok: true, result: { state: 'deployed', services: report.services, networks: report.networks, volumes: report.volumes, warnings: report.warnings, configHash: plan.configHash } };
  } catch (err) {
    const reason = String(err?.message || err).slice(0, 200);
    await rollback();
    finish('failed', reason);
    return fail('engine_error', reason, null, { report, rolledBack: true });
  }

  /** Undo what THIS run created. Recreated services were restored by the ladder already. */
  async function rollback() {
    step('rolling back');
    for (const c of createdContainers.reverse()) {
      await adapter.stopContainer(c.id, { stopTimeout: 5 }).catch(() => {});
      await adapter.deleteContainer(c.id, { force: true }).catch(() => {});
      const r = report.services.find((s) => s.key === c.key && s.result === 'created');
      if (r) r.result = 'rolled_back';
    }
    for (const n of createdNetworks.reverse()) {
      const r = await adapter.removeNetwork(n).catch(() => ({ ok: false }));
      const rep = report.networks.find((x) => x.name === n);
      if (rep) rep.result = r.ok ? 'rolled_back' : 'created (could not be removed)';
    }
    step('rolled back');
  }
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

export async function start({ target, action, plan, onStep }) {
  const results = [];
  const failures = [];
  for (const svc of plan.services) {
    if (svc.action !== 'start') { results.push({ key: svc.key, container: svc.container, result: 'skipped' }); continue; }
    const m = target.members.find((x) => x.containerName === svc.container);
    onStep?.(`start ${svc.key}`);
    const r = await dockerOps.startContainer(m.containerId, { timeoutMs: 30_000 });
    if (!r.ok && r.status !== 304) { failures.push(svc.key); results.push({ key: svc.key, container: svc.container, result: 'failed' }); continue; }
    const v = await waitFor(m.containerId, (i) => i.State?.Running === true, action.verifyMs);
    if (!v.ok) { failures.push(svc.key); results.push({ key: svc.key, container: svc.container, result: 'not_running', state: v.inspect?.State?.Status || null }); continue; }
    results.push({ key: svc.key, container: svc.container, result: 'started' });
  }
  if (failures.length) return fail('partial', `${failures.length} of ${plan.services.length} container${plan.services.length === 1 ? '' : 's'} did not start: ${failures.join(', ')}.`, null, { services: results });
  return { ok: true, result: { state: 'running', services: results } };
}

export async function stop({ target, action, plan, onStep }) {
  const results = [];
  const failures = [];
  // reverse dependency order: dependants first
  for (const svc of [...plan.services].reverse()) {
    if (svc.action !== 'stop') { results.push({ key: svc.key, container: svc.container, result: 'skipped' }); continue; }
    const m = target.members.find((x) => x.containerName === svc.container);
    onStep?.(`stop ${svc.key}`);
    const r = await dockerOps.stopContainer(m.containerId, { timeoutMs: 45_000 });
    if (!r.ok && r.status !== 304) { failures.push(svc.key); results.push({ key: svc.key, container: svc.container, result: 'failed' }); continue; }
    const v = await waitFor(m.containerId, (i) => i.State?.Running !== true, action.verifyMs);
    if (!v.ok) { failures.push(svc.key); results.push({ key: svc.key, container: svc.container, result: 'still_running' }); continue; }
    results.push({ key: svc.key, container: svc.container, result: 'stopped' });
  }
  if (failures.length) return fail('partial', `${failures.length} container${failures.length === 1 ? '' : 's'} did not stop: ${failures.join(', ')}.`, null, { services: results });
  return { ok: true, result: { state: 'stopped', services: results } };
}

export async function remove({ target, action, plan, onStep }) {
  const results = [];
  const failures = [];
  for (const svc of [...plan.services].reverse()) {
    const m = target.members.find((x) => x.containerName === svc.container);
    if (!m) continue;
    onStep?.(`remove ${svc.key}`);
    await adapter.stopContainer(m.containerId, { stopTimeout: 15 }).catch(() => {});
    const d = await adapter.deleteContainer(m.containerId, { force: true });
    if (!d.ok) { failures.push(svc.key); results.push({ key: svc.key, container: svc.container, result: 'failed', detail: d.detail || null }); continue; }
    results.push({ key: svc.key, container: svc.container, result: 'removed' });
  }
  const networks = [];
  if (!failures.length) {
    for (const n of await ownedNetworks(target.id)) {
      onStep?.(`remove network ${n}`);
      const r = await adapter.removeNetwork(n).catch(() => ({ ok: false }));
      networks.push({ name: n, result: r.ok ? 'removed' : 'kept (in use or already gone)' });
    }
  }
  if (target.managed) store.appendHistory({ stack: target.id, status: failures.length ? 'remove_failed' : 'removed', services: results, networks });
  if (failures.length) return fail('partial', `${failures.length} container${failures.length === 1 ? '' : 's'} could not be removed: ${failures.join(', ')}. Networks were left in place.`, null, { services: results });
  return { ok: true, result: { state: 'removed', services: results, networks } };
}
