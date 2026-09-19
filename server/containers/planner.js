// The container plan — what an operation will change, before anything changes.
//
// Runs inside the policy evaluation (so the dry-run and the execution see the same plan) and
// answers three questions for every configuration-changing container action:
//
//   1. what does the container look like NOW (its canonical spec, read from a fresh inspect)
//   2. what will it look like AFTER (the spec with the operator's patch applied)
//   3. is AFTER allowed (containers/policy.js) and does getting there need a recreate
//
// It never writes. The runner (containers/runners.js) receives the plan and executes exactly it.
import * as adapter from '../updates/recreateAdapter.js';
import { specFromInspect, applyPatch, normalizeSpec, IN_PLACE_FIELDS } from './spec.js';
import { diffSpecs } from './diff.js';
import { classifySpec } from './policy.js';
import { operationError } from '../operations/model.js';

const fail = (code, reason, detail = null) => ({ ok: false, plan: null, policy: null, error: operationError(code, reason, detail) });

/**
 * @param {object} action   registry entry
 * @param {object} target   resolved container target ({ containerId, containerName, ... }) or a `new` target
 * @param {object} params   parsed params
 * @returns {Promise<{ok:boolean, plan:object|null, policy:object|null, error:object|null}>}
 */
export async function planContainerOperation(action, target, params) {
  // a brand-new container: nothing to read, just classify the requested spec
  if (action.adapter === 'create') {
    const spec = params.spec;
    const policy = classifySpec(spec);
    return {
      ok: true, policy,
      plan: {
        kind: 'create', policy,
        current: null, next: publicOf(spec),
        diff: diffSpecs(null, spec),
        steps: ['pull image if missing', 'create container', ...(spec.networks?.length > 1 ? ['connect additional networks'] : []), 'start', 'verify running', 'refresh inventory'],
        summary: [`create ${spec.name || 'container'} from ${spec.image}`],
        notes: [],
      },
    };
  }

  // everything else reads the live container first
  const insp = await adapter.inspectContainer(target.containerId);
  if (!insp.ok || !insp.data) return fail('inspect_failed', 'The container could not be inspected, so no plan can be made.');
  const current = specFromInspect(insp.data);
  target.inspect = insp.data;   // eligibility uses the raw document (host pid/ipc, labels)
  target.image = current.image;
  const currentPolicy = classifySpec(current);

  switch (action.adapter) {
    case 'rename': {
      if (params.name === current.name) return fail('no_change', 'The container already has that name.');
      return simple('rename', { policy: currentPolicy, summary: [`rename ${current.name} → ${params.name}`], steps: ['rename', 'verify name', 'refresh inventory'], current, next: { ...current, name: params.name }, diffFields: ['name'] });
    }
    case 'remove': {
      const running = insp.data.State?.Running === true || insp.data.State?.Paused === true;
      if (running && !params.force) return fail('container_running', 'The container is running. Stop it first, or remove it with force.');
      return simple('remove', { policy: currentPolicy, summary: [`remove ${current.name}${running ? ' (force: it will be killed first)' : ''}`, 'named volumes are kept'], steps: [...(running ? ['kill'] : []), 'remove container (volumes kept)', 'verify gone', 'refresh inventory'], current, next: null, notes: volumeNotes(current) });
    }
    case 'pull': {
      return simple('pull', { policy: currentPolicy, summary: [`pull ${current.image}`, 'the running container is not changed'], steps: ['pull image', 'compare digests'], current, next: current });
    }
    case 'network_attach': {
      if ((current.networks || []).some((n) => n.name === params.network)) return fail('no_change', `The container is already connected to ${params.network}.`);
      if (current.networkMode && !['bridge', 'default'].includes(current.networkMode) && !/^[a-zA-Z0-9]/.test(current.networkMode)) return fail('not_applicable', `A container in ${current.networkMode} network mode cannot be attached to other networks.`);
      if (current.networkMode === 'host' || current.networkMode === 'none' || /^container:/.test(current.networkMode || '')) return fail('not_applicable', `A container in ${current.networkMode} network mode cannot be attached to other networks.`);
      const next = { ...current, networks: [...(current.networks || []), { name: params.network, aliases: params.aliases, ipv4: null }] };
      return simple('network_attach', { policy: classifySpec(next, { current }), summary: [`connect to ${params.network}`], steps: ['connect network', 'verify endpoint present', 'refresh inventory'], current, next, diffFields: ['networks'] });
    }
    case 'network_detach': {
      if (!(current.networks || []).some((n) => n.name === params.network)) return fail('no_change', `The container is not connected to ${params.network}.`);
      if ((current.networks || []).length <= 1) return fail('not_applicable', 'The container would be left with no network. Attach another network first.');
      const next = { ...current, networks: current.networks.filter((n) => n.name !== params.network) };
      return simple('network_detach', { policy: classifySpec(next, { current }), summary: [`disconnect from ${params.network}`], steps: ['disconnect network', 'verify endpoint gone', 'refresh inventory'], current, next, diffFields: ['networks'] });
    }
    case 'update': {
      const fields = Object.keys(params.spec);
      const notInPlace = fields.filter((f) => !IN_PLACE_FIELDS.includes(f));
      if (notInPlace.length) return fail('needs_recreate', `${notInPlace.join(', ')} cannot be changed in place. Use Edit, which recreates the container.`);
      const next = applyPatch(current, params.spec);
      const diff = diffSpecs(current, next);
      if (!diff.changed.length) return fail('no_change', 'The requested values match the current configuration.');
      const policy = classifySpec(next, { current });
      return { ok: true, policy, plan: { kind: 'update', policy, current: publicOf(current), next: publicOf(next), diff, steps: ['update in place', 'verify applied', 'refresh inventory'], summary: diff.summary, notes: [] } };
    }
    case 'recreate': {
      const spec = normalizeSpec(editable(current));
      if (!spec.ok) return fail('not_reproducible', `The container's configuration cannot be reproduced by OpusHub: ${spec.errors[0]}`);
      const policy = classifySpec(current, { current });
      return { ok: true, policy, plan: { kind: 'recreate', policy, current: publicOf(current), next: publicOf(current), diff: diffSpecs(current, current), steps: recreateSteps(), summary: [`recreate ${current.name} on ${current.image} (same configuration)`], notes: [...unsupportedNotes(current), ...volumeNotes(current)] } };
    }
    case 'edit': {
      const next = applyPatch(editable(current), params.spec);
      const norm = normalizeSpec(next);
      if (!norm.ok) return fail('bad_params', norm.errors[0], norm.errors.slice(1).join('; ') || null);
      const diff = diffSpecs(current, norm.spec);
      if (!diff.changed.length) return fail('no_change', 'Nothing would change.');
      const policy = classifySpec(norm.spec, { current });
      const nameChanged = diff.changed.includes('name');
      return { ok: true, policy, plan: { kind: diff.inPlace ? 'update' : 'edit', policy, current: publicOf(current), next: publicOf(norm.spec), diff, steps: diff.inPlace ? ['update in place', 'verify applied', 'refresh inventory'] : [...(diff.changed.includes('image') ? ['pull image'] : []), ...recreateSteps(nameChanged ? norm.spec.name : null)], summary: diff.summary, notes: [...unsupportedNotes(current), ...(diff.recreate ? volumeNotes(current) : [])] } };
    }
    case 'change_image': {
      if (params.image === current.image) return fail('no_change', 'The container already runs that image.');
      const next = { ...editable(current), image: params.image };
      const norm = normalizeSpec(next);
      if (!norm.ok) return fail('not_reproducible', `The container's configuration cannot be reproduced by OpusHub: ${norm.errors[0]}`);
      const diff = diffSpecs(current, norm.spec);
      const policy = classifySpec(norm.spec, { current });
      return { ok: true, policy, plan: { kind: 'change_image', policy, current: publicOf(current), next: publicOf(norm.spec), diff, steps: ['pull image', ...recreateSteps()], summary: [`${current.image} → ${params.image}`], notes: [...unsupportedNotes(current), ...volumeNotes(current)] } };
    }
    case 'duplicate': {
      // a copy: same spec, new name; host ports and named volumes are dropped unless the operator
      // provided their own, because two containers cannot share either
      const base = { ...editable(current), name: params.name };
      if (!params.spec.ports) base.ports = (current.ports || []).map((p) => ({ ...p, host: null, hostIp: null }));
      if (!params.spec.volumes) base.volumes = (current.volumes || []).filter((v) => v.type !== 'volume');
      const next = applyPatch(base, params.spec);
      const norm = normalizeSpec(next);
      if (!norm.ok) return fail('bad_params', norm.errors[0], norm.errors.slice(1).join('; ') || null);
      if (norm.spec.name === current.name) return fail('bad_params', 'The copy needs a different name.');
      const diff = diffSpecs(current, norm.spec);
      const policy = classifySpec(norm.spec, { current });
      const notes = [];
      if (!params.spec.ports && (current.ports || []).some((p) => p.host)) notes.push('Published host ports were not copied (the original still uses them).');
      if (!params.spec.volumes && (current.volumes || []).some((v) => v.type === 'volume')) notes.push('Named volumes were not copied (they belong to the original).');
      return { ok: true, policy, plan: { kind: 'duplicate', policy, current: publicOf(current), next: publicOf(norm.spec), diff, steps: ['pull image if missing', `create ${norm.spec.name}`, 'start', 'verify running', 'refresh inventory'], summary: [`create ${norm.spec.name} from ${current.name}`], notes } };
    }
    default:
      return null;
  }
}

function simple(kind, { policy, summary, steps, current, next, diffFields = null, notes = [] }) {
  return {
    ok: true, policy,
    plan: {
      kind, policy,
      current: publicOf(current), next: publicOf(next),
      diff: next && diffFields ? diffSpecs(current, next, { fields: diffFields }) : null,
      steps, summary, notes,
    },
  };
}

function recreateSteps(newName = null) {
  return ['stop current container', 'rename current container aside', `create replacement${newName ? ` as ${newName}` : ''}`, 'connect additional networks', 'start replacement', 'verify running', 'remove previous container (volumes kept)', 'refresh inventory'];
}

function volumeNotes(spec) {
  const named = (spec.volumes || []).filter((v) => v.type === 'volume');
  const anon = (spec._anonymousVolumes || []);
  const out = [];
  if (named.length) out.push(`Named volumes kept: ${named.map((v) => v.source).join(', ')}.`);
  if (anon.length) out.push(`${anon.length} anonymous volume${anon.length === 1 ? '' : 's'} will be kept but no longer attached to a container.`);
  return out;
}

function unsupportedNotes(spec) {
  const u = spec._unsupported;
  if (!u || !Object.keys(u).length) return [];
  return [`Preserved as-is (not editable here): ${Object.keys(u).join(', ')}.`];
}

/** The spec without its read-only annotations — what normalizeSpec accepts. */
function editable(spec) {
  const out = {};
  for (const [k, v] of Object.entries(spec)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

function publicOf(spec) {
  if (!spec) return null;
  // lazy import avoided: diff.js exports publicSpec; keep the plan self-contained
  return diffSpecs(null, spec).next;
}
