// Container runners — how each non-lifecycle container action is executed, one function each.
//
// The engine calls exactly one of these from its static dispatch, after the policy has produced
// the plan and the confirmation has been spent. Each runner:
//   - performs only the enumerated adapter calls its action needs (nothing is derived from input),
//   - verifies the result against the engine afterwards (a 2xx is not proof),
//   - reports `{ ok, code, reason, detail, result }` — never throws for an engine failure.
//
// Transactions (recreate / edit / change image) go through containers/recreate.js, the same
// ladder Update Now uses, so rollback behaviour has one implementation.
import * as adapter from '../updates/recreateAdapter.js';
import * as docker from '../providers/docker.js';
import { specFromInspect, applyPatch, normalizeSpec, createBodyFromSpec, updateBodyFromSpec } from './spec.js';
import { diffSpecs } from './diff.js';
import { recreateContainer } from './recreate.js';
import * as registries from '../registries/auth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (code, reason, detail = null) => ({ ok: false, code, reason, detail });
const fromAdapter = (res, reason) => fail(res.code || 'engine_error', reason, res.detail || res.reason || (res.status ? `docker HTTP ${res.status}` : null));

/** Re-read until `pred(inspect)` holds or the window closes. Returns the last inspect. */
async function waitFor(containerId, pred, windowMs) {
  const deadline = Date.now() + windowMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await adapter.inspectContainer(containerId);
    last = r.ok ? r.data : null;
    if (last && pred(last)) return { ok: true, inspect: last };
    await sleep(500);
  }
  return { ok: false, inspect: last };
}

/* ---------------- control (single enumerated call + verification) ---------------- */

export async function rename({ target, params, action }) {
  const r = await adapter.renameContainer(target.containerId, params.name, { timeoutMs: action.timeoutMs });
  if (!r.ok) return fromAdapter(r, r.code === 'conflict' ? `A container named ${params.name} already exists.` : 'The container could not be renamed.');
  const v = await waitFor(target.containerId, (i) => String(i.Name || '').replace(/^\//, '') === params.name, action.verifyMs);
  if (!v.ok) return fail('verification_failed', 'Docker accepted the rename but the container still reports its old name.');
  return { ok: true, result: { name: params.name, previousName: target.containerName, state: v.inspect.State?.Status || null } };
}

export async function remove({ target, params, action }) {
  const r = await adapter.deleteContainer(target.containerId, { force: params.force === true, timeoutMs: action.timeoutMs });
  if (!r.ok && r.status !== 404) {
    return fromAdapter(r, r.code === 'conflict' ? 'The container is running. Stop it first, or remove it with force.' : 'The container could not be removed.');
  }
  const deadline = Date.now() + action.verifyMs;
  while (Date.now() < deadline) {
    const i = await adapter.inspectContainer(target.containerId);
    if (!i.ok && i.status === 404) return { ok: true, result: { removed: true, name: target.containerName, volumesKept: true } };
    if (!i.ok && i.code === 'not_found') return { ok: true, result: { removed: true, name: target.containerName, volumesKept: true } };
    await sleep(400);
  }
  return fail('verification_failed', 'Docker accepted the removal but the container is still present.');
}

export async function pullImage({ target, params, action, plan }) {
  const image = params?.image || plan?.current?.image || target.image;
  if (!image) return fail('bad_params', 'There is no image to pull.');
  const before = await docker.imageInfo(image).catch(() => null);
  const auth = await registries.authHeaderFor(image, params?.registryId || null).catch(() => null);
  const r = await adapter.pullImage(image, { timeoutMs: action.timeoutMs, registryAuth: auth?.header || null });
  if (!r.ok) return fromAdapter(r, `The image ${image} could not be pulled.`);
  const after = await docker.imageInfo(image).catch(() => null);
  const beforeId = before?.id || before?.Id || null;
  const afterId = after?.id || after?.Id || null;
  return { ok: true, result: { image, changed: !!(beforeId && afterId && beforeId !== afterId) || (!beforeId && !!afterId), imageId: afterId ? String(afterId).replace(/^sha256:/, '').slice(0, 12) : null, registry: auth?.registryId || null } };
}

export async function networkAttach({ target, params, action }) {
  const r = await adapter.connectNetwork(params.network, target.containerId, { Aliases: params.aliases?.length ? params.aliases : undefined }, { timeoutMs: action.timeoutMs });
  if (!r.ok) return fromAdapter(r, r.code === 'not_found' ? `There is no network named ${params.network}.` : `The container could not be connected to ${params.network}.`);
  const v = await waitFor(target.containerId, (i) => !!i.NetworkSettings?.Networks?.[params.network], action.verifyMs);
  if (!v.ok) return fail('verification_failed', 'Docker accepted the connection but the container does not report the network.');
  return { ok: true, result: { network: params.network, aliases: params.aliases || [], networks: Object.keys(v.inspect.NetworkSettings?.Networks || {}) } };
}

export async function networkDetach({ target, params, action }) {
  const r = await adapter.disconnectNetwork(params.network, target.containerId, { timeoutMs: action.timeoutMs });
  if (!r.ok) return fromAdapter(r, `The container could not be disconnected from ${params.network}.`);
  const v = await waitFor(target.containerId, (i) => !i.NetworkSettings?.Networks?.[params.network], action.verifyMs);
  if (!v.ok) return fail('verification_failed', 'Docker accepted the disconnection but the container still reports the network.');
  return { ok: true, result: { network: params.network, networks: Object.keys(v.inspect.NetworkSettings?.Networks || {}) } };
}

export async function updateInPlace({ target, params, action, plan }) {
  const insp = await adapter.inspectContainer(target.containerId);
  if (!insp.ok) return fail('inspect_failed', 'The container could not be inspected.');
  const current = specFromInspect(insp.data);
  const next = applyPatch(current, params.spec);
  const fields = Object.keys(params.spec);
  const body = updateBodyFromSpec(next, fields);
  const r = await adapter.updateContainer(target.containerId, body, { timeoutMs: action.timeoutMs });
  if (!r.ok) return fromAdapter(r, 'Docker refused the in-place update.');
  const v = await waitFor(target.containerId, (i) => {
    const s = specFromInspect(i);
    return !diffSpecs(s, next, { fields }).changed.length;
  }, action.verifyMs);
  if (!v.ok) return fail('verification_failed', 'Docker accepted the update but the container does not report the new values.');
  return { ok: true, result: { changed: fields, diff: plan?.diff ? { changed: plan.diff.changed } : null } };
}

/* ---------------- transactions (recreate ladder) ---------------- */

async function recreateWith({ target, action, nextSpec, pull, kind, onStep }) {
  if (pull) {
    const auth = await registries.authHeaderFor(nextSpec.image, null).catch(() => null);
    const p = await adapter.pullImage(nextSpec.image, { timeoutMs: Math.max(30_000, action.timeoutMs - 30_000), registryAuth: auth?.header || null });
    if (!p.ok) return fromAdapter(p, `The image ${nextSpec.image} could not be pulled, so nothing was changed.`);
  } else {
    // a recreate on the same image must not silently pull a newer one — that is what Update Now is for
    const img = await docker.imageInfo(nextSpec.image).catch(() => null);
    if (!img) {
      const auth = await registries.authHeaderFor(nextSpec.image, null).catch(() => null);
      const p = await adapter.pullImage(nextSpec.image, { timeoutMs: Math.max(30_000, action.timeoutMs - 30_000), registryAuth: auth?.header || null });
      if (!p.ok) return fromAdapter(p, `The image ${nextSpec.image} is not present and could not be pulled, so nothing was changed.`);
    }
  }
  const insp = await adapter.inspectContainer(target.containerId);
  if (!insp.ok) return fail('inspect_failed', 'The container disappeared before it could be recreated.');
  const wasRunning = insp.data.State?.Running === true || insp.data.State?.Paused === true;
  const { createBody, auxiliaryNetworks } = createBodyFromSpec(nextSpec);
  const rec = await recreateContainer({
    containerId: target.containerId, containerName: target.containerName, createBody, auxiliaryNetworks,
    kind, wasRunning, verifyMs: action.verifyMs, service: target.service, onStep,
  });
  if (!rec.ok) return { ok: false, code: rec.code, reason: rec.reason, detail: rec.rolledBack ? 'rolled back' : 'not rolled back', rolledBack: rec.rolledBack, transactionId: rec.tx?.id || null };
  return { ok: true, result: { newContainerId: rec.newId.slice(0, 12), previousContainerId: target.containerId.slice(0, 12), name: nextSpec.name, image: nextSpec.image, running: wasRunning, warnings: rec.warnings || [], transactionId: rec.tx?.id || null } };
}

function currentEditable(inspect) {
  const spec = specFromInspect(inspect);
  const out = {};
  for (const [k, v] of Object.entries(spec)) if (!k.startsWith('_')) out[k] = v;
  return { spec, editable: out };
}

export async function recreate({ target, action, onStep }) {
  const insp = await adapter.inspectContainer(target.containerId);
  if (!insp.ok) return fail('inspect_failed', 'The container could not be inspected.');
  const { editable } = currentEditable(insp.data);
  const norm = normalizeSpec(editable);
  if (!norm.ok) return fail('not_reproducible', norm.errors[0]);
  return recreateWith({ target, action, nextSpec: norm.spec, pull: false, kind: 'recreate', onStep });
}

export async function edit({ target, params, action, plan, onStep }) {
  const insp = await adapter.inspectContainer(target.containerId);
  if (!insp.ok) return fail('inspect_failed', 'The container could not be inspected.');
  const { spec: current, editable } = currentEditable(insp.data);
  const norm = normalizeSpec(applyPatch(editable, params.spec));
  if (!norm.ok) return fail('bad_params', norm.errors[0]);
  const diff = diffSpecs(current, norm.spec);
  if (!diff.changed.length) return fail('no_change', 'Nothing would change.');
  if (diff.inPlace) return updateInPlace({ target, params, action, plan });
  // a name change is a rename of the *replacement*: the ladder creates it under the new name
  const t = diff.changed.includes('name') ? { ...target } : target;
  const r = await recreateWith({ target: t, action, nextSpec: norm.spec, pull: diff.changed.includes('image'), kind: 'edit', onStep });
  if (r.ok) r.result.changed = diff.changed;
  return r;
}

export async function changeImage({ target, params, action, onStep }) {
  const insp = await adapter.inspectContainer(target.containerId);
  if (!insp.ok) return fail('inspect_failed', 'The container could not be inspected.');
  const { editable } = currentEditable(insp.data);
  const norm = normalizeSpec({ ...editable, image: params.image });
  if (!norm.ok) return fail('not_reproducible', norm.errors[0]);
  const r = await recreateWith({ target, action, nextSpec: norm.spec, pull: true, kind: 'change_image', onStep });
  if (r.ok) r.result.previousImage = editable.image;
  return r;
}

/* ---------------- create / duplicate (no old container to protect) ---------------- */

export async function createFresh({ spec, action, name = null }) {
  const containerName = name || spec.name;
  if (!containerName) return fail('bad_params', 'A name is required.');
  const img = await docker.imageInfo(spec.image).catch(() => null);
  if (!img) {
    const auth = await registries.authHeaderFor(spec.image, null).catch(() => null);
    const p = await adapter.pullImage(spec.image, { timeoutMs: Math.max(30_000, action.timeoutMs - 30_000), registryAuth: auth?.header || null });
    if (!p.ok) return fromAdapter(p, `The image ${spec.image} could not be pulled, so nothing was created.`);
  }
  const { createBody, auxiliaryNetworks } = createBodyFromSpec(spec);
  const c = await adapter.createContainer(containerName, createBody, { timeoutMs: 30_000 });
  if (!c.ok || !c.id) return fromAdapter(c, c.code === 'conflict' ? `A container named ${containerName} already exists.` : `The container could not be created${c.detail ? ` (${c.detail})` : ''}.`);
  const warnings = [];
  for (const net of auxiliaryNetworks) {
    const r = await adapter.connectNetwork(net.name, c.id, net.endpointConfig).catch(() => ({ ok: false }));
    if (!r.ok) warnings.push(`network ${net.name} could not be attached`);
  }
  const s = await adapter.startContainer(c.id);
  if (!s.ok) {
    await adapter.deleteContainer(c.id, { force: true }).catch(() => {});
    return fromAdapter(s, `The container was created but failed to start${s.detail ? ` (${s.detail})` : ''}; it was removed again.`);
  }
  const v = await waitFor(c.id, (i) => i.State?.Running === true || i.State?.Status === 'exited' || i.State?.Status === 'dead', action.verifyMs);
  const st = v.inspect?.State;
  if (!st || st.Running !== true) {
    const exit = st?.ExitCode;
    await adapter.deleteContainer(c.id, { force: true }).catch(() => {});
    return fail('verification_failed', `The container started but exited immediately${Number.isFinite(exit) ? ` (exit code ${exit})` : ''}; it was removed again.`);
  }
  return { ok: true, result: { newContainerId: c.id.slice(0, 12), name: containerName, image: spec.image, warnings } };
}

export async function create({ params, action }) {
  return createFresh({ spec: params.spec, action });
}

export async function duplicate({ target, params, action }) {
  const insp = await adapter.inspectContainer(target.containerId);
  if (!insp.ok) return fail('inspect_failed', 'The container could not be inspected.');
  const { spec: current, editable } = currentEditable(insp.data);
  const base = { ...editable, name: params.name };
  if (!params.spec.ports) base.ports = (current.ports || []).map((p) => ({ ...p, host: null, hostIp: null }));
  if (!params.spec.volumes) base.volumes = (current.volumes || []).filter((v) => v.type !== 'volume');
  const norm = normalizeSpec(applyPatch(base, params.spec));
  if (!norm.ok) return fail('bad_params', norm.errors[0]);
  const r = await createFresh({ spec: norm.spec, action });
  if (r.ok) r.result.duplicatedFrom = target.containerName;
  return r;
}
