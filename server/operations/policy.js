// The operations policy — one evaluation, used by both the dry-run and the execution path.
//
// The same function answers "would this be allowed?" and "is this allowed?". That is the whole
// point: a dry-run cannot be more permissive than the real thing, and the real thing cannot skip
// a check the dry-run reported, because there is only one list of checks.
//
// The evaluation is a list of named checks with a verdict each. The UI renders it as the
// confirmation dialog's "Ready to execute" panel, so what the server checked and what the user
// agreed to are the same list — not a summary someone wrote by hand.
//
// Phase 10D extends the list, in order:
//   action → permission → parameters → target → docker → eligibility → backoff → lock (container
//   AND stack) → plan (a diff and a configuration-policy verdict for the actions that change
//   configuration; BLOCKED refuses, DANGEROUS forces a strong confirmation)
import * as docker from '../providers/docker.js';
import * as ops from '../providers/dockerOperations.js';
import { getAction, isKnownAction } from './registry.js';
import { permissionsFor, can } from './permissions.js';
import { resolveTarget } from './targets.js';
import { backoffState, holder } from './locks.js';
import { operationError } from './model.js';
import { parseParams } from './params.js';
import { evaluateEligibility } from '../updates/eligibility.js';
import { planContainerOperation } from '../containers/planner.js';
import { resolveStackTarget, planStackOperation, stackLockKey } from '../stacks/targets.js';
import { planInstall, resolveCatalogTarget } from '../catalog/planner.js';
import { isValidImageRef } from '../updates/recreateAdapter.js';

/** Reasons a Docker lifecycle call can fail, said in the operator's language. */
const ENGINE_REASONS = {
  container_missing: 'The container no longer exists on this engine.',
  not_found: 'The container, network or image no longer exists on this engine.',
  conflict: 'Docker refused the operation because the container is in a conflicting state.',
  permission_denied: 'Docker refused the operation: OpusHub is not permitted to control containers.',
  engine_busy: 'The Docker engine is busy. Try again in a moment.',
  engine_error: 'The Docker engine returned an error.',
  bad_request: 'The Docker engine rejected the request.',
  timeout: 'The Docker engine did not answer in time.',
  socket_missing: 'The Docker operations socket is configured but not present on the server.',
  docker_unavailable: 'Docker is not connected.',
  pull_failed: 'The image could not be pulled from its registry.',
};

export function engineReason(code) {
  return ENGINE_REASONS[code] || 'The Docker engine returned an error.';
}

const check = (key, label, ok, detail = null, error = null) => ({ key, label, ok, detail, error });

/**
 * Evaluate one requested operation.
 *
 * Never throws for a policy reason: everything that can be refused comes back as a check with
 * `ok: false` and a structured error, so the caller can record, report and move on.
 *
 * @returns {Promise<{allowed:boolean, action:object|null, target:object|null, params:object|null,
 *                    plan:object|null, checks:object[], error:object|null, docker:object, actor:object,
 *                    lockKeys:string[], mode:'normal'|'strong'}>}
 */
export async function evaluate({ actionId, targetRef, params: rawParams = undefined, actor = null, sessionId = null, at = Date.now() }) {
  const checks = [];
  let action = null;
  let target = null;
  let params = null;
  let plan = null;
  const ctx = () => ({ action, target, params, plan, actor, docker: {}, lockKeys: [] });

  // 1 — the action must be one of the registered ones. Nothing else can be asked for, because
  //     there is no way to name anything else that reaches Docker.
  if (!isKnownAction(actionId)) {
    checks.push(check('action', 'Action', false, String(actionId ?? 'none').slice(0, 60),
      operationError('unknown_action', 'OpusHub does not have an operation with that name.')));
    return finish(checks, ctx());
  }
  action = getAction(actionId);
  checks.push(check('action', 'Action', true, `${action.imperative} ${action.targetType === 'container' ? 'container' : action.targetType} · ${action.summary}`));

  // 2 — authorization. Server-side, from the session's username. A request cannot declare it.
  const allowed = can(actor, action.permission);
  checks.push(check('permission', 'Permission', allowed,
    allowed ? `Allowed — ${actor || 'unknown user'} holds ${action.permission}` : `Not granted: ${action.permission}`,
    allowed ? null : operationError('not_permitted', 'Your account is not allowed to run that operation.')));
  if (!allowed) return finish(checks, ctx());

  // 3 — parameters: exactly the schema the action declares, nothing else.
  const parsed = parseParams(action.params, rawParams);
  checks.push(check('params', 'Parameters', parsed.ok,
    parsed.ok ? (action.params === 'none' ? 'None required' : describeParams(action.params, parsed.params)) : parsed.error.reason,
    parsed.ok ? null : parsed.error));
  if (!parsed.ok) return finish(checks, ctx());
  params = parsed.params;

  // 4 — the target must resolve to exactly one real thing of the kind the action operates on.
  const kind = targetRef?.type === 'service' ? 'container' : targetRef?.type;
  if (kind !== action.targetType) {
    checks.push(check('target', 'Target', false, describeRef(targetRef),
      operationError('bad_target', `${action.imperative} operates on a ${action.targetType === 'new' ? 'new container' : action.targetType}, not on a ${kind || 'missing target'}.`)));
    return finish(checks, ctx());
  }
  const resolved = await resolveByType(action.targetType, targetRef, params);
  if (!resolved.ok) {
    checks.push(check('target', 'Target', false, describeRef(targetRef), resolved.error));
    return finish(checks, ctx());
  }
  target = resolved.target;
  checks.push(check('target', 'Target', true, describeTarget(target)));

  // 5 — the engine has to be reachable for both reading and writing.
  const readOk = docker.availability().ok;
  const opsAvail = ops.operationsAvailability();
  checks.push(check('docker', 'Docker', readOk && opsAvail.ok,
    readOk && opsAvail.ok
      ? `Available · operations channel ${opsAvail.dedicated ? 'dedicated socket' : 'same socket as discovery'}`
      : (opsAvail.public || 'Docker is not available.'),
    readOk && opsAvail.ok ? null : operationError('docker_unavailable', opsAvail.public || 'Docker is not connected, so the operation cannot run.')));
  if (!(readOk && opsAvail.ok)) return finish(checks, { ...ctx(), docker: { read: readOk, operations: opsAvail.ok } });

  // 6 — eligibility: the container OpusHub runs in, recovery infrastructure, opted-out
  //     containers and host-namespace containers are not recreated, removed or reconfigured.
  if (action.targetType === 'container' && ['transaction', 'control'].includes(action.executor) && action.adapter !== 'pull') {
    const elig = containerEligibility(target, action);
    checks.push(check('eligibility', 'Eligible', elig.ok, elig.ok ? 'Clear' : elig.reason,
      elig.ok ? null : operationError('ineligible', elig.reason)));
    if (!elig.ok) return finish(checks, { ...ctx(), docker: { read: true, operations: true } });
  }
  if (action.targetType === 'container' && action.executor === 'lifecycle' && target.self && action.adapter === 'kill') {
    checks.push(check('eligibility', 'Eligible', false, 'OpusHub will not kill its own container.', operationError('ineligible', 'OpusHub will not kill its own container.')));
    return finish(checks, { ...ctx(), docker: { read: true, operations: true } });
  }

  // 7 — a target that keeps failing gets a short cool-off rather than an endless retry loop.
  const lockKeys = lockKeysFor(target);
  const bo = backoffState(lockKeys[0], { at });
  checks.push(check('backoff', 'Retry window', bo.ok,
    bo.ok ? 'Clear' : `Waiting ${Math.ceil(bo.retryAfterMs / 1000)}s after repeated failures`,
    bo.ok ? null : operationError('backoff', 'This target failed its last operations. Wait a moment and try again.',
      `${bo.fails} consecutive failures`)));
  if (!bo.ok) return finish(checks, { ...ctx(), docker: { read: true, operations: true }, lockKeys });

  // 8 — one operation per container at a time, and none while its stack is being deployed.
  //     A stack operation in turn needs every member container free (update + deploy, autoheal
  //     + manual recreate and friends are excluded here, not by luck).
  const held = lockKeys.map((k) => ({ key: k, holder: holder(k) })).find((h) => h.holder);
  const free = !held || (held.holder.opId && sessionId && held.holder.opId === sessionId);
  checks.push(check('lock', 'No operation in progress', !!free,
    free ? 'Clear' : `Another ${held.holder.action || 'operation'} is already running on ${held.key.startsWith('stack:') ? 'this stack' : 'this container'}`,
    free ? null : operationError('already_running',
      `${held.holder.action ? capitalize(held.holder.action.replace(/^(container|stack)\./, '')) : 'An operation'} is already in progress for ${target.label}.`,
      held.holder.opId ? `operation ${held.holder.opId}` : null)));
  if (!free) return finish(checks, { ...ctx(), docker: { read: true, operations: true }, lockKeys });

  // 9 — the plan: what will change, and whether the configuration policy allows it.
  const planned = await planByType(action, target, params);
  if (planned) {
    plan = planned.plan;
    const verdict = planned.policy?.level || 'SAFE';
    const okPlan = planned.ok && verdict !== 'BLOCKED';
    checks.push(check('plan', 'Plan', okPlan,
      !planned.ok ? planned.error.reason
        : verdict === 'BLOCKED' ? `Refused: ${planned.policy.findings.filter((f) => f.level === 'BLOCKED').map((f) => f.message).join(' ')}`
          : `${plan?.summary?.length ? plan.summary.slice(0, 4).join(' · ') : 'Ready'}${verdict === 'DANGEROUS' ? ' · dangerous configuration — strong confirmation required' : verdict === 'WARNING' ? ' · with warnings' : ''}`,
      okPlan ? null : (planned.ok ? operationError('policy_blocked', 'The configuration is not allowed by policy.', planned.policy.findings.filter((f) => f.level === 'BLOCKED').map((f) => f.code).join(', ')) : planned.error)));
    if (!okPlan) return finish(checks, { ...ctx(), plan, docker: { read: true, operations: true }, lockKeys });
  }

  return finish(checks, { ...ctx(), plan, docker: { read: true, operations: true }, lockKeys });
}

/** Which lock keys an operation on this target must hold. */
export function lockKeysFor(target) {
  if (!target) return ['none'];
  if (target.type === 'stack') return [stackLockKey(target.id), ...(target.memberIds || [])];
  if (target.type === 'container') return [target.containerId, ...(target.stack ? [stackLockKey(target.stack)] : [])];
  if (target.type === 'image') return [`image:${target.id}`];
  if (target.type === 'catalog') return [`catalog:${target.id}:${target.name || ''}`, ...(target.name ? [`name:${target.name}`] : [])];
  if (target.type === 'new') return [`name:${target.name || 'new'}`];
  return [String(target.id || 'none')];
}

async function resolveByType(type, ref, params) {
  switch (type) {
    case 'container': return resolveTarget(ref);
    case 'stack': return resolveStackTarget(ref);
    case 'image': {
      const id = String(ref.id || '').trim();
      if (!isValidImageRef(id)) return { ok: false, error: operationError('bad_target', 'That is not a valid image reference (repository[:tag][@digest]).') };
      return { ok: true, target: { type: 'image', id, label: id, self: false } };
    }
    case 'new': {
      const name = params?.spec?.name || null;
      return { ok: true, target: { type: 'new', id: name || 'new-container', name, label: name || 'a new container', self: false } };
    }
    case 'catalog': return resolveCatalogTarget(ref, params);
    default: return { ok: false, error: operationError('bad_target', 'Unknown target type.') };
  }
}

async function planByType(action, target, params) {
  switch (action.targetType) {
    case 'container': return ['transaction', 'control'].includes(action.executor) ? planContainerOperation(action, target, params) : null;
    case 'new': return planContainerOperation(action, target, params);
    case 'stack': return planStackOperation(action, target, params);
    case 'catalog': return planInstall(action, target, params);
    default: return null;
  }
}

function containerEligibility(target, action) {
  // Update Now's refusals (self, autoheal, opt-out labels, host namespaces) apply to every
  // operation that removes, recreates or reconfigures a container.
  if (target.self && action.adapter !== 'rename' && action.adapter !== 'network_attach' && action.adapter !== 'update') {
    return { ok: false, reason: `OpusHub will not ${action.verb} its own container.` };
  }
  if (['remove', 'recreate', 'edit', 'change_image'].includes(action.adapter)) {
    const e = evaluateEligibility({ container: { id: target.containerId, name: target.containerName, image: target.image || 'unknown' }, inspect: target.inspect || null, imageRef: target.image || null });
    if (!e.eligible && !/no associated image|Container not found/i.test(e.reason)) return { ok: false, reason: e.reason };
  }
  return { ok: true };
}

function describeParams(kind, params) {
  switch (kind) {
    case 'rename': return `New name: ${params.name}`;
    case 'remove': return params.force ? 'Force: a running container will be killed first' : 'Only a stopped container is removed';
    case 'network': return `Network ${params.network}${params.aliases?.length ? ` · aliases ${params.aliases.join(', ')}` : ''}`;
    case 'image': return `Image ${params.image}`;
    case 'pull': return params.image ? `Image ${params.image}${params.registryId ? ` via registry ${params.registryId}` : ''}` : 'The target image';
    case 'spec': return `Container spec for ${params.spec?.name || 'a new container'} (${params.spec?.image})`;
    case 'spec_patch': return `Fields: ${Object.keys(params.spec).join(', ')}`;
    case 'duplicate': return `Copy named ${params.name}${Object.keys(params.spec || {}).length ? ` · overrides: ${Object.keys(params.spec).join(', ')}` : ''}`;
    case 'stack_source': return `${params.name ? `${params.name} · ` : ''}${params.compose.length} bytes of Compose${Object.keys(params.env).length ? ` · ${Object.keys(params.env).length} env` : ''}`;
    case 'install': return `${Object.keys(params.config).length} configuration value${Object.keys(params.config).length === 1 ? '' : 's'}`;
    default: return 'Accepted';
  }
}

function describeTarget(t) {
  if (t.type === 'stack') return `stack ${t.label} · ${t.memberIds?.length || 0} container${t.memberIds?.length === 1 ? '' : 's'}${t.managed ? ' · managed by OpusHub' : ' · discovered'}`;
  if (t.type === 'image') return `image ${t.id}`;
  if (t.type === 'new') return t.name ? `new container ${t.name}` : 'a new container';
  if (t.type === 'catalog') return `${t.label} from the catalog${t.name ? ` as ${t.name}` : ''}`;
  return `${t.label} · ${t.containerName} · ${t.state || 'unknown state'}${t.self ? ' · this is the container OpusHub runs in' : ''}`;
}

function finish(checks, ctx) {
  const failed = checks.find((c) => !c.ok);
  const dangerous = ctx.plan?.policy?.level === 'DANGEROUS';
  return {
    allowed: !failed,
    action: ctx.action,
    target: ctx.target,
    params: ctx.params,
    plan: ctx.plan,
    actor: ctx.actor,
    checks,
    error: failed?.error ?? null,
    docker: ctx.docker,
    lockKeys: ctx.lockKeys || [],
    // strong confirmation for a high-risk action, for the OpusHub container, or for a dangerous plan
    mode: ctx.action?.confirmation === 'strong' || ctx.target?.self || dangerous ? 'strong' : 'normal',
  };
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function describeRef(ref) {
  if (!ref || typeof ref !== 'object') return 'no target';
  const id = ref.id || ref.name || null;
  return `${ref.type || 'service'}${id ? ` ${id}` : ''}${ref.group ? ` in group ${ref.group}` : ''}`.slice(0, 120);
}

/**
 * The dry-run report the confirmation dialog renders.
 *
 * It is assembled from the same evaluation the execution path will repeat, so "Ready to execute"
 * means every check passed — and a failure means the same dialog that said it would work now
 * says precisely why it will not.
 */
export function dryRunReport({ evaluation, confirmationRequired = false, mode = 'none' }) {
  const a = evaluation.action;
  const t = evaluation.target;
  return {
    ready: evaluation.allowed,
    action: a ? { id: a.id, label: a.imperative, risk: a.risk, verb: a.verb, timeoutMs: a.timeoutMs, targetType: a.targetType, executor: a.executor } : null,
    target: t
      ? { type: t.type, label: t.label, containerName: t.containerName ?? null, state: t.state ?? null, health: t.health ?? null, group: t.group ?? null, stack: t.stack ?? null, self: t.self === true, id: t.type === 'container' ? null : (t.id ?? null) }
      : null,
    permission: evaluation.checks.find((c) => c.key === 'permission')?.ok === true,
    risk: a?.risk ?? null,
    docker: evaluation.checks.find((c) => c.key === 'docker')?.ok === true,
    // what will actually be sent to the engine — shown as a lifecycle verb, never as an endpoint
    engineAction: a ? (a.executor === 'lifecycle' ? `docker ${a.verb}` : a.executor === 'control' ? `controlled ${a.verb}` : `${a.verb} transaction`) : null,
    confirmation: { required: !!confirmationRequired, mode },
    checks: evaluation.checks.map((c) => ({ key: c.key, label: c.label, ok: c.ok, detail: c.detail })),
    plan: evaluation.plan ? publicPlan(evaluation.plan) : null,
    error: evaluation.error ?? null,
  };
}

/** The plan as the browser may see it: steps, diff (env values masked), policy findings. */
export function publicPlan(plan) {
  if (!plan) return null;
  return {
    kind: plan.kind || null,
    summary: plan.summary || [],
    steps: plan.steps || [],
    diff: plan.diff ? { changed: plan.diff.changed, unchanged: plan.diff.unchanged, entries: plan.diff.entries, inPlace: plan.diff.inPlace, recreate: plan.diff.recreate, summary: plan.diff.summary } : null,
    current: plan.current ?? null,
    next: plan.next ?? null,
    policy: plan.policy ? { level: plan.policy.level, findings: plan.policy.findings } : null,
    services: plan.services ?? null,
    resources: plan.resources ?? null,
    integrations: plan.integrations ?? null,
    notes: plan.notes || [],
  };
}

/** Test helper. */
export function _internals() {
  return { ENGINE_REASONS };
}
