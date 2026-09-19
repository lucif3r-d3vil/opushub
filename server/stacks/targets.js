// Stack targets and plans.
//
// A stack reference resolves against TWO sources, and Docker wins:
//   • the live inventory — containers carrying `com.docker.compose.project=<id>` (the members)
//   • the managed-stack store — the Compose document OpusHub deploys (if any)
//
// A stack that exists only in the store has zero members (honestly: "not deployed"). A stack
// that exists only on the engine is *discovered*: start/stop/remove act on its real containers,
// deploy is refused because there is no document to deploy from. Nothing here fabricates a
// member list from a YAML file.
import * as model from '../model.js';
import * as adapter from '../updates/recreateAdapter.js';
import * as docker from '../providers/docker.js';
import { operationError } from '../operations/model.js';
import { _selfContainerId } from '../operations/targets.js';
import { specFromInspect } from '../containers/spec.js';
import { diffSpecs } from '../containers/diff.js';
import { parseCompose, serviceHash } from './compose.js';
import { classifyStack } from './policy.js';
import * as store from './store.js';

export function stackLockKey(id) { return `stack:${String(id).toLowerCase()}`; }

const SELF_LABEL = 'io.opushub.managed';

/** @returns {{ok:true, target:object} | {ok:false, error:object}} */
export async function resolveStackTarget(ref) {
  const id = String(ref?.id || '').toLowerCase();
  const managed = store.getStack(id);
  const inv = await model.getInventory({ force: true }).catch(() => null);
  if (!inv?.live) return { ok: false, error: operationError('docker_unavailable', 'Docker is not connected, so there is no live inventory to operate on.') };
  const live = (inv.stacks || []).find((s) => String(s.project || s.id).toLowerCase() === id && s.project);
  const members = (live?.members || []).map((m) => ({
    containerId: String(m.container?.id || '').toLowerCase(),
    containerName: m.containerName || m.container?.name,
    service: m.container?.composeService || m.route || null,
    state: m.container?.state || null,
    health: m.container?.health || null,
    image: m.container?.image || null,
  })).filter((m) => m.containerId);
  if (!managed && !members.length) return { ok: false, error: operationError('unknown_target', 'No stack with that name is deployed on this engine or managed by OpusHub.', id) };

  const selfId = _selfContainerId();
  return {
    ok: true,
    target: {
      type: 'stack',
      id,
      label: live?.displayName || managed?.name || id,
      managed: !!managed,
      revision: managed?.revision || null,
      memberIds: members.map((m) => m.containerId),
      members,
      self: !!selfId && members.some((m) => m.containerId.startsWith(String(selfId).slice(0, 12))),
      state: !members.length ? 'not_deployed' : members.every((m) => m.state === 'running') ? 'running' : members.some((m) => m.state === 'running') ? 'partial' : 'stopped',
    },
  };
}

/**
 * The stack plan for a stack.* action. Deploy compares the document against what is running,
 * service by service; the lifecycle verbs list the members they touch.
 */
export async function planStackOperation(action, target, params) {
  const fail = (code, reason, detail = null) => ({ ok: false, plan: null, policy: null, error: operationError(code, reason, detail) });
  switch (action.adapter) {
    case 'stack_start': {
      const todo = target.members.filter((m) => m.state !== 'running');
      if (!target.members.length) return fail('not_deployed', 'The stack has no containers on the engine. Deploy it first.');
      return simple('stack_start', target, todo, `start ${todo.length} of ${target.members.length} container${target.members.length === 1 ? '' : 's'}`, todo.length ? [] : ['every container is already running']);
    }
    case 'stack_stop': {
      const todo = target.members.filter((m) => m.state === 'running' || m.state === 'paused' || m.state === 'restarting');
      if (!target.members.length) return fail('not_deployed', 'The stack has no containers on the engine.');
      if (target.self) return fail('ineligible', 'OpusHub runs inside this stack; stopping it would stop OpusHub.');
      return simple('stack_stop', target, todo, `stop ${todo.length} container${todo.length === 1 ? '' : 's'}`, todo.length ? [] : ['every container is already stopped']);
    }
    case 'stack_remove': {
      if (!target.members.length && !target.managed) return fail('not_deployed', 'There is nothing to remove.');
      if (target.self) return fail('ineligible', 'OpusHub runs inside this stack; removing it would remove OpusHub.');
      const nets = await ownedNetworks(target.id);
      return {
        ok: true,
        policy: { level: 'SAFE', findings: [] },
        plan: {
          kind: 'stack_remove', policy: { level: 'SAFE', findings: [] },
          services: target.members.map((m) => ({ key: m.service || m.containerName, container: m.containerName, action: 'remove', state: m.state })),
          networks: nets.map((n) => ({ name: n, action: 'remove' })),
          steps: ['stop every container', 'remove every container (volumes kept)', ...(nets.length ? [`remove ${nets.length} stack network${nets.length === 1 ? '' : 's'}`] : []), ...(target.managed ? ['keep the managed definition (redeploy restores it)'] : []), 'verify gone', 'refresh inventory'],
          summary: [`remove ${target.members.length} container${target.members.length === 1 ? '' : 's'}`, ...(nets.length ? [`remove network${nets.length === 1 ? '' : 's'} ${nets.join(', ')}`] : []), 'volumes are kept'],
          notes: [],
          current: null, next: null, diff: null,
        },
      };
    }
    case 'stack_deploy': return planDeploy(target, params);
    default: return fail('unknown_action', 'No plan for that action.');
  }
}

function simple(kind, target, todo, headline, notes) {
  return {
    ok: true,
    policy: { level: 'SAFE', findings: [] },
    plan: {
      kind, policy: { level: 'SAFE', findings: [] },
      services: target.members.map((m) => ({ key: m.service || m.containerName, container: m.containerName, action: todo.includes(m) ? kind.replace('stack_', '') : 'skip', state: m.state })),
      steps: [headline, 'verify state', 'refresh inventory'],
      summary: [headline], notes, current: null, next: null, diff: null,
    },
  };
}

/** Networks the stack created (labelled with its project) — the only ones remove may delete. */
export async function ownedNetworks(project) {
  const nets = await docker.listNetworksRaw().catch(() => []);
  return nets.filter((n) => n.labels?.['com.docker.compose.project'] === project && n.labels?.[SELF_LABEL] === 'stack').map((n) => n.name);
}

/**
 * The deploy plan: parse the managed document, classify it, and compare each service's desired
 * spec with the container that carries its service label today.
 */
export async function planDeploy(target, params, { compose: composeOverride = null, env: envOverride = null } = {}) {
  const fail = (code, reason, detail = null) => ({ ok: false, plan: null, policy: null, error: operationError(code, reason, detail) });
  const managed = store.getStack(target.id);
  const compose = composeOverride ?? managed?.compose;
  const env = envOverride ?? managed?.env ?? {};
  if (typeof compose !== 'string') return fail('not_managed', 'This stack was deployed outside OpusHub; there is no Compose document to deploy from. Import it as a managed stack first.');
  const parsed = parseCompose(compose, { project: target.id, env });
  if (!parsed.ok) return fail('invalid_compose', `The Compose document is not valid: ${parsed.errors[0]}`, parsed.errors.slice(1, 6).join('; ') || null);
  const m = parsed.model;

  // what is running now, per service key
  const current = new Map();
  const currentHash = new Map();
  const byService = new Map(target.members.map((x) => [x.service, x]));
  for (const svc of m.services) {
    const live = byService.get(svc.key);
    if (!live) continue;
    const insp = await adapter.inspectContainer(live.containerId);
    if (!insp.ok || !insp.data) continue;
    const spec = specFromInspect(insp.data);
    current.set(svc.key, spec);
    currentHash.set(svc.key, insp.data.Config?.Labels?.['io.opushub.config-hash'] || null);
    live.running = insp.data.State?.Running === true;
  }

  const policy = classifyStack(m, { current });
  const services = [];
  for (const svc of m.services) {
    const cur = current.get(svc.key) || null;
    const desired = { ...svc.spec, labels: { ...svc.spec.labels, 'io.opushub.config-hash': serviceHash(svc.spec) } };
    let action;
    let diff = null;
    if (!cur) action = 'create';
    else {
      diff = diffSpecs(stripManaged(cur), stripManaged(svc.spec));
      action = diff.changed.length ? 'recreate' : (byService.get(svc.key)?.running === false ? 'start' : 'unchanged');
    }
    services.push({ key: svc.key, container: svc.containerName, image: svc.spec.image, action, pull: svc.pullPolicy, diff: diff ? { changed: diff.changed, entries: diff.entries, summary: diff.summary } : null, current: diff?.current || null, next: diff?.next || null, desired, dependsOn: svc.dependsOn });
  }
  // members on the engine whose service key is no longer in the document
  const orphans = target.members.filter((x) => x.service && !m.services.some((s) => s.key === x.service)).map((x) => ({ key: x.service, container: x.containerName, action: 'remove' }));
  const existingNets = new Set((await docker.listNetworksRaw().catch(() => [])).map((n) => n.name));
  const networks = m.networks.map((n) => ({ key: n.key, name: n.name, external: n.external, action: existingNets.has(n.name) ? 'exists' : n.external ? 'missing' : 'create' }));
  const missingExternal = networks.filter((n) => n.action === 'missing');
  if (missingExternal.length) return fail('missing_network', `External network ${missingExternal[0].name} does not exist on the engine.`);
  const existingVols = new Set((await docker.listVolumes().catch(() => [])).map((v) => v.name));
  const volumes = m.volumes.map((v) => ({ key: v.key, name: v.name, external: v.external, action: existingVols.has(v.name) ? 'exists' : v.external ? 'missing' : 'create' }));
  const missingVol = volumes.filter((v) => v.action === 'missing');
  if (missingVol.length) return fail('missing_volume', `External volume ${missingVol[0].name} does not exist on the engine.`);

  const counts = { create: 0, recreate: 0, start: 0, unchanged: 0, remove: orphans.length };
  for (const s of services) counts[s.action] += 1;
  const steps = [
    ...(networks.some((n) => n.action === 'create') ? [`create ${networks.filter((n) => n.action === 'create').length} network(s)`] : []),
    ...(volumes.some((v) => v.action === 'create') ? [`create ${volumes.filter((v) => v.action === 'create').length} volume(s)`] : []),
    ...(services.some((s) => s.action !== 'unchanged') ? ['pull images'] : []),
    ...services.filter((s) => s.action !== 'unchanged').map((s) => `${s.action} ${s.key}`),
    ...orphans.map((o) => `remove ${o.key} (no longer in the document)`),
    'verify every service', 'refresh inventory',
  ];
  const summary = [
    `${counts.create} create · ${counts.recreate} recreate · ${counts.start} start · ${counts.unchanged} unchanged${counts.remove ? ` · ${counts.remove} remove` : ''}`,
    ...(policy.level !== 'SAFE' ? [`policy: ${policy.level.toLowerCase()} (${policy.findings.length} finding${policy.findings.length === 1 ? '' : 's'})`] : []),
  ];
  return {
    ok: true,
    policy,
    plan: {
      kind: 'stack_deploy', policy,
      project: m.name, configHash: m.hash, revision: managed?.revision || null,
      services: services.map(({ desired: _d, ...s }) => s), orphans, networks, volumes, counts,
      steps, summary, notes: parsed.warnings, current: null, next: null, diff: null,
      // the runner's input — never sent to the browser (publicPlan strips it)
      _model: { ...m, services: m.services.map((svc) => ({ ...svc, spec: services.find((s) => s.key === svc.key).desired })) },
      _orphans: target.members.filter((x) => x.service && !m.services.some((s) => s.key === x.service)),
    },
  };
}

/** Labels OpusHub writes itself must not count as drift. */
function stripManaged(spec) {
  const labels = { ...(spec.labels || {}) };
  for (const k of Object.keys(labels)) if (k.startsWith('io.opushub.') || k.startsWith('com.docker.compose.')) delete labels[k];
  return { ...spec, labels, name: null };
}
