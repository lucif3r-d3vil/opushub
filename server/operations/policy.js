// The operations policy — one evaluation, used by both the dry-run and the execution path.
//
// The same function answers "would this be allowed?" and "is this allowed?". That is the whole
// point: a dry-run cannot be more permissive than the real thing, and the real thing cannot skip
// a check the dry-run reported, because there is only one list of checks.
//
// The evaluation is a list of named checks with a verdict each. The UI renders it as the
// confirmation dialog's "Ready to execute" panel, so what the server checked and what the user
// agreed to are the same list — not a summary someone wrote by hand.
import * as docker from '../providers/docker.js';
import * as ops from '../providers/dockerOperations.js';
import { getAction, isKnownAction } from './registry.js';
import { permissionsFor, can } from './permissions.js';
import { resolveTarget } from './targets.js';
import { backoffState, holder } from './locks.js';
import { operationError } from './model.js';

/** Reasons a Docker lifecycle call can fail, said in the operator's language. */
const ENGINE_REASONS = {
  container_missing: 'The container no longer exists on this engine.',
  conflict: 'Docker refused the operation because the container is in a conflicting state.',
  permission_denied: 'Docker refused the operation: OpusHub is not permitted to control containers.',
  engine_busy: 'The Docker engine is busy. Try again in a moment.',
  engine_error: 'The Docker engine returned an error.',
  timeout: 'The Docker engine did not answer in time.',
  socket_missing: 'The Docker operations socket is configured but not present on the server.',
  docker_unavailable: 'Docker is not connected.',
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
 * @returns {Promise<{allowed:boolean, action:object|null, target:object|null, checks:object[],
 *                    error:object|null, docker:object, actor:object}>}
 */
export async function evaluate({ actionId, targetRef, actor = null, sessionId = null, at = Date.now() }) {
  const checks = [];
  const perms = permissionsFor(actor);
  let action = null;
  let target = null;

  // 1 — the action must be one of the registered ones. Nothing else can be asked for, because
  //     there is no way to name anything else that reaches Docker.
  if (!isKnownAction(actionId)) {
    checks.push(check('action', 'Action', false, String(actionId ?? 'none').slice(0, 60),
      operationError('unknown_action', 'OpusHub does not have an operation with that name.')));
    return finish(checks, { action: null, target: null, actor, docker: {} });
  }
  action = getAction(actionId);
  checks.push(check('action', 'Action', true, `${action.imperative} container · ${action.summary}`));

  // 2 — authorization. Server-side, from the session's username. A request cannot declare it.
  const allowed = can(actor, action.permission);
  checks.push(check('permission', 'Permission', allowed,
    allowed ? `Allowed — ${actor || 'unknown user'} holds ${action.permission}` : `Not granted: ${action.permission}`,
    allowed ? null : operationError('not_permitted', 'Your account is not allowed to run that operation.')));
  if (!allowed) return finish(checks, { action, target: null, actor, docker: {} });

  // 3 — the target must resolve to exactly one live container.
  const resolved = await resolveTarget(targetRef);
  if (!resolved.ok) {
    checks.push(check('target', 'Target', false, describeRef(targetRef), resolved.error));
    // a target that cannot be resolved says nothing about Docker's health
    return finish(checks, { action, target: null, actor, docker: {} });
  }
  target = resolved.target;
  checks.push(check('target', 'Target', true,
    `${target.label} · ${target.containerName} · ${target.state || 'unknown state'}${target.self ? ' · this is the container OpusHub runs in' : ''}`));

  // 4 — the engine has to be reachable for both reading and writing.
  const readOk = docker.availability().ok;
  const opsAvail = ops.operationsAvailability();
  checks.push(check('docker', 'Docker', readOk && opsAvail.ok,
    readOk && opsAvail.ok
      ? `Available · operations channel ${opsAvail.dedicated ? 'dedicated socket' : 'same socket as discovery'}`
      : (opsAvail.public || 'Docker is not available.'),
    readOk && opsAvail.ok ? null : operationError('docker_unavailable', opsAvail.public || 'Docker is not connected, so the operation cannot run.')));
  if (!(readOk && opsAvail.ok)) return finish(checks, { action, target, actor, docker: { read: readOk, operations: opsAvail.ok } });

  // 5 — a target that keeps failing gets a short cool-off rather than an endless retry loop.
  const bo = backoffState(target.containerId, { at });
  checks.push(check('backoff', 'Retry window', bo.ok,
    bo.ok ? 'Clear' : `Waiting ${Math.ceil(bo.retryAfterMs / 1000)}s after repeated failures`,
    bo.ok ? null : operationError('backoff', 'This service failed its last operations. Wait a moment and try again.',
      `${bo.fails} consecutive failures`)));
  if (!bo.ok) return finish(checks, { action, target, actor, docker: { read: true, operations: true } });

  // 6 — one operation per container at a time.
  const held = holder(target.containerId);
  const free = !held || (held.opId && sessionId && held.opId === sessionId);
  checks.push(check('lock', 'No operation in progress', !!free,
    free ? 'Clear' : `Another ${held.action || 'operation'} is already running on this container`,
    free ? null : operationError('already_running',
      `${held.action ? capitalize(held.action.replace('container.', '')) : 'An operation'} is already in progress for ${target.label}.`,
      held.opId ? `operation ${held.opId}` : null)));

  return finish(checks, { action, target, actor, docker: { read: true, operations: true } });
}

function finish(checks, ctx) {
  const failed = checks.find((c) => !c.ok);
  return {
    allowed: !failed,
    action: ctx.action,
    target: ctx.target,
    actor: ctx.actor,
    checks,
    error: failed?.error ?? null,
    docker: ctx.docker,
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
    action: a ? { id: a.id, label: a.imperative, risk: a.risk, verb: a.verb, timeoutMs: a.timeoutMs } : null,
    target: t
      ? { label: t.label, containerName: t.containerName, state: t.state, health: t.health, group: t.group, stack: t.stack, self: t.self }
      : null,
    permission: evaluation.checks.find((c) => c.key === 'permission')?.ok === true,
    risk: a?.risk ?? null,
    docker: evaluation.checks.find((c) => c.key === 'docker')?.ok === true,
    // what will actually be sent to the engine — shown as a lifecycle verb, never as an endpoint
    engineAction: a ? `docker ${a.verb}` : null,
    confirmation: { required: !!confirmationRequired, mode },
    checks: evaluation.checks.map((c) => ({ key: c.key, label: c.label, ok: c.ok, detail: c.detail })),
    error: evaluation.error ?? null,
  };
}

/** Test helper. */
export function _internals() {
  return { ENGINE_REASONS };
}
