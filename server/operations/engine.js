// The operations engine — the lifecycle every operation goes through, in one place.
//
//   requested → authorization → target validation → policy → confirmation
//             → execution → verification → activity → final result
//
// Two entry points, one policy:
//
//   requestOperation()  validates, records, and (when confirmation is required) issues a
//                       short-lived, server-bound confirmation token. Touches Docker only to
//                       READ the inventory. This is the dry-run.
//   executeOperation()  repeats exactly the same evaluation, spends the confirmation token, and
//                       only then writes to Docker.
//
// Execution is bounded and non-blocking: the HTTP route returns as soon as the operation has been
// accepted and started, and the client follows it with `GET /api/v1/operations/:id`. Nothing waits
// indefinitely, and nothing is queued to run later — if Docker is unavailable the operation is
// rejected now, not stored for a future attempt.
import * as docker from '../providers/docker.js';
import * as dockerOps from '../providers/dockerOperations.js';
import { logEvent } from '../activity.js';
import { evaluateServiceHealth } from '../healthModel.js';
import * as model from '../model.js';

// Phase 10B — best-effort publish onto the canonical event bus (the failure-isolated
// wrapper lives with the bus; every producer used to carry an identical local copy).
import { publishEventSafe } from '../events/index.js';
import { getAction, isKnownAction, registrySummary } from './registry.js';
import { describeActor, can } from './permissions.js';
import { parseTargetRef, revalidateTarget } from './targets.js';
import { issue as issueConfirmation, verify as spendConfirmation, cancel as cancelConfirmation, cancelByOperation } from './confirmation.js';
import { acquire, release, touch, checkRate, recordFailure, clearFailures } from './locks.js';
import { engineReason, evaluate, publicPlan } from './policy.js';
import { confirmationKey } from './params.js';
import * as runners from '../containers/runners.js';
import * as stackRunners from '../stacks/runners.js';
import * as catalogRunners from '../catalog/runners.js';
import { eventSummary } from '../containers/diff.js';
import { operationTrail as readTrail } from './audit.js';
import { createOperation, publicOperation, operationError, isWellFormedOperationId } from './model.js';
import * as store from './store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VERIFY_POLL_MS = 700;
const HEALTH_TIMEOUT_MS = 8_000;

/* ------------------------------------------------------------------ */
/* request (dry-run)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Validate a requested operation and, when it passes, hand back a confirmation token.
 *
 * Docker is read (the inventory has to be resolved) but never written to. The caller gets
 * everything needed to render an honest confirmation dialog: which checks ran, whether the
 * operation is ready, and what confirming it would do.
 *
 * @returns {Promise<{operation:object, evaluation:object, confirmation:object, status:number}>}
 */
export async function requestOperation({ actionId, targetRef, params = undefined, actor = null, sessionId = null, at = Date.now() }) {
  const rate = checkRate(sessionId, { at });
  if (!rate.ok) {
    const op = settle(createOperation({ action: isKnownAction(actionId) ? actionId : String(actionId ?? 'unknown').slice(0, 40), target: null, actor, sessionId, at }), {
      status: 'rejected',
      error: operationError('rate_limited', 'Too many operations in a short time. Wait a moment and try again.'),
      at,
    });
    return { operation: publicOperation(op), evaluation: null, confirmation: null, status: 429 };
  }

  const evaluation = await evaluate({ actionId, targetRef, params, actor, sessionId, at });
  const op = createOperation({
    action: isKnownAction(actionId) ? actionId : String(actionId ?? 'unknown').slice(0, 40),
    target: evaluation.target,
    actor,
    sessionId,
    at,
  });
  store.put(op);
  store.append(op, 'params', { at, note: evaluation.checks.find((c) => c.key === 'params')?.ok ? 'accepted' : 'refused' });
  store.append(op, 'requested', { at });
  store.append(op, 'authorization', { at, note: evaluation.checks.find((c) => c.key === 'permission')?.ok ? 'approved' : 'refused' });
  store.append(op, 'target', { at, note: evaluation.target ? 'resolved' : (evaluation.error?.code || 'unresolved') });

  if (!evaluation.allowed) {
    const rejected = settle({ ...op }, { status: 'rejected', error: evaluation.error, at });
    return { operation: publicOperation(rejected), evaluation: { allowed: false, checks: evaluation.checks, error: evaluation.error }, confirmation: null, status: errorStatus(evaluation.error) };
  }

  const action = evaluation.action;
  const target = evaluation.target;
  // Stronger confirmation for a higher-risk action, for an action on the container OpusHub
  // itself (where "it worked" and "you lost the page" are the same event), and for a plan the
  // configuration policy classified as dangerous.
  const mode = evaluation.mode;
  // The token is bound to the target AND to the hash of the canonical parameters: what the
  // operator confirmed is, byte for byte, what will execute.
  const conf = issueConfirmation({
    sessionId, actor, action: action.id, targetKey: confirmationKey(target, evaluation.params), opId: op.id, mode, at,
  });
  if (evaluation.plan) store.append(op, 'plan', { at, note: (evaluation.plan.summary || []).slice(0, 3).join(' · ') || evaluation.plan.kind || 'planned' });

  const awaiting = store.update(op.id, (o) => ({
    ...o,
    status: 'awaiting_confirmation',
    confirmation: { required: true, mode, tokenIssued: true, consumedAt: null },
  }));
  store.append(awaiting, 'confirmation', { at, note: `${mode} confirmation issued` });

  publishEventSafe({
    type: 'operation.requested',
    severity: 'info',
    source: 'operation',
    subject: eventSubject(target, op),
    message: `${action.id} requested for ${target?.label || target?.containerName || 'service'}`,
    payload: { action: action.id, target: target?.containerName || target?.id || null },
    correlation: { operationId: op.id },
  });

  return {
    operation: publicOperation(awaiting),
    evaluation,
    confirmation: {
      required: true,
      mode,
      token: conf.token,
      expiresAt: conf.expiresAt,
      ttlMs: conf.ttlMs,
      prompt: confirmationPrompt({ action, target, mode, plan: evaluation.plan }),
    },
    status: 200,
  };
}

/** The words the dialog shows. Built from the registry, so they cannot drift from the action. */
export function confirmationPrompt({ action, target, mode, plan = null }) {
  const name = target?.label || target?.containerName || (target?.type === 'stack' ? 'this stack' : 'this service');
  const title = `${action.imperative} ${name}?`;
  const noun = target?.type === 'stack' ? 'stack' : 'container';
  const dangerous = plan?.policy?.level === 'DANGEROUS' ? ` The configuration is classified as dangerous: ${plan.policy.findings.filter((f) => f.level === 'DANGEROUS').map((f) => f.message).join(' ')}` : '';
  const body = mode === 'strong'
    ? `${action.consequence || `This will ${action.verb} the ${name} ${noun}.`}${target?.state ? ` The container is ${target.state} right now.` : ''}${dangerous}`
    : (action.consequence || `This will ${action.verb} the ${name} ${noun}.`);
  const acknowledge = mode === 'strong'
    ? `I understand — ${name} will be ${action.verb === 'stop' ? 'unavailable until I start it again' : action.verb === 'remove' ? 'deleted' : action.past}.`
    : null;
  return {
    title,
    body,
    acknowledge,
    confirmLabel: action.imperative === 'Stop' ? `Stop ${name}` : `${action.imperative} ${name}`,
    cancelLabel: 'Cancel',
    risk: action.risk,
    self: target?.self === true,
    selfNote: target?.self === true
      ? 'This is the container OpusHub runs in. Operating on it will interrupt OpusHub itself.'
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* execute                                                             */
/* ------------------------------------------------------------------ */

/**
 * Execute a confirmed operation.
 *
 * Validates from scratch (the confirmation token is not a substitute for authorization), spends
 * the token, starts the work, and returns immediately with the operation in flight. The caller
 * polls `getOperation()`.
 */
export async function executeOperation({ operationId = null, actionId, targetRef, params = undefined, actor = null, sessionId = null, confirmationToken = null, at = Date.now() }) {
  const rate = checkRate(sessionId, { at });
  if (!rate.ok) {
    return {
      operation: publicOperation(settle(createOperation({ action: String(actionId ?? 'unknown').slice(0, 40), target: null, actor, sessionId, at }), {
        status: 'rejected', error: operationError('rate_limited', 'Too many operations in a short time. Wait a moment and try again.'), at,
      })),
      status: 429,
    };
  }

  // The whole evaluation runs again: a token proves the *confirmation*, not the permission,
  // the target, or that Docker is still there.
  const evaluation = await evaluate({ actionId, targetRef, params, actor, sessionId, at });
  const existing = operationId && isWellFormedOperationId(operationId) ? store.get(operationId) : null;
  // An operation is confirmed once and executed once. A cancelled, rejected or already-run
  // operation has no confirmation left to spend, whatever token the request carries.
  if (existing && existing.status !== 'awaiting_confirmation') {
    cancelConfirmation(confirmationToken);
    return {
      operation: publicOperation({
        ...existing,
        error: operationError('already_settled', 'That operation has already finished. Confirm it again to run a new one.'),
      }),
      status: 409,
    };
  }
  const op = existing || createOperation({
    action: isKnownAction(actionId) ? actionId : String(actionId ?? 'unknown').slice(0, 40),
    target: evaluation.target, actor, sessionId, at,
  });
  if (!existing) store.put(op);

  if (!evaluation.allowed) {
    // The prior dry-run's token dies with the refusal: a confirmation for an operation that is
    // no longer permitted must not stay spendable.
    cancelConfirmation(confirmationToken);
    return {
      operation: publicOperation(settle({ ...op }, { status: 'rejected', error: evaluation.error, at })),
      status: errorStatus(evaluation.error),
    };
  }

  const action = evaluation.action;
  const target = evaluation.target;

  // Confirmation: required, valid, and bound to this session, action and target.
  const conf = spendConfirmation({
    token: confirmationToken,
    sessionId, actor, action: action.id, targetKey: confirmationKey(target, evaluation.params), at,
  });
  if (!conf.ok) {
    return {
      operation: publicOperation(settle({ ...op }, { status: 'rejected', error: conf.error, at })),
      status: 409,
    };
  }

  // The locks are taken only now — after every check has passed — so a refused request never
  // blocks the container it was refused for. A container operation holds the container and its
  // stack; a stack operation holds the stack and every member. All or nothing.
  const lockKeys = evaluation.lockKeys.length ? evaluation.lockKeys : [target.containerId];
  const lock = acquireAll(lockKeys, { opId: op.id, action: action.id, at });
  if (!lock.ok) {
    return {
      operation: publicOperation(settle({ ...op }, {
        status: 'rejected',
        error: operationError('already_running', 'Another operation is already running for this service.'),
        at,
      })),
      status: 409,
    };
  }

  const authorized = store.update(op.id, (o) => ({
    ...o,
    status: 'authorized',
    target,
    confirmation: { required: true, mode: conf.mode || 'normal', tokenIssued: true, consumedAt: at },
  }));
  store.append(authorized, 'confirmation', { at, note: 'confirmation accepted' });

  const running = store.update(op.id, (o) => ({ ...o, status: 'running', startedAt: Date.now(), plan: evaluation.plan ? publicPlan(evaluation.plan) : null }));
  store.append(running, 'execution', { at: running.startedAt, note: action.executor === 'lifecycle' ? `docker ${action.verb}` : `${action.executor} ${action.verb}` });

  publishEventSafe({
    type: 'operation.started',
    severity: 'notice',
    source: 'operation',
    subject: eventSubject(target, op),
    message: `${action.id} started for ${target.label || target.containerName || target.id}`,
    payload: { action: action.id, target: target.containerName || target.id || null, ...(evaluation.plan?.diff ? { changes: eventSummary(evaluation.plan.diff) } : {}) },
    correlation: { operationId: op.id },
  });

  // Deliberately not awaited: the route answers now, the operation finishes on its own clock,
  // and the client follows the operation record. Bounded, never queued for later.
  if (action.executor === 'lifecycle') {
    void runOperation({ op: running, action, target, actor, sessionId, at: running.startedAt, lockKeys });
  } else {
    void runControlled({ op: running, action, target, params: evaluation.params, plan: evaluation.plan, actor, sessionId, at: running.startedAt, lockKeys });
  }

  return { operation: publicOperation(running), status: 202 };
}

/**
 * The execution itself: Docker call → bounded verification → record → activity.
 *
 * Every exit path records a terminal status. There is no path where the operation stays
 * "running" afterwards, and none where a failure is reported as a success.
 */
async function runOperation({ op, action, target, actor, sessionId, at, lockKeys = [target.containerId] }) {
  const targetKey = target.containerId;
  let before = null;
  try {
    before = await docker.inspectContainer(targetKey).catch(() => null);

    // Re-check the target immediately before writing: the container may have been replaced
    // between the confirmation and now, and the id alone is not proof it is the same container.
    const re = await revalidateTarget(target);
    if (!re.ok) return fail(op, action, target, actor, re.error, at, { phase: 'execution' });

    const res = await dispatch(action, targetKey);
    const after = Date.now();

    if (!res.ok) {
      recordFailure(targetKey, { at: after });
      const err = operationError(res.code, engineReason(res.code), res.status ? `docker HTTP ${res.status}` : null);
      // A timeout is not a verdict: the engine may well have done it. Read the state and say so.
      if (res.code === 'timeout') {
        const v = await verify(action, target, before, { windowMs: 5_000, at: after });
        return timeout(op, action, target, actor, err, v.verification, at);
      }
      return fail(op, action, target, actor, err, at, { phase: 'execution' });
    }

    touch(targetKey, { opId: op.id, at: after });
    const v = await verify(action, target, before, { windowMs: action.verifyMs, at: after });
    if (!v.ok) {
      // Bounded time elapsed without reaching the expected state: report the timeout with the
      // state we actually observed, never as a success and never as a proven failure.
      recordFailure(targetKey, { at: Date.now() });
      return timeout(op, action, target, actor,
        operationError('verification_timeout', `${capitalize(action.progressive)} took longer than expected.`),
        v.verification, at);
    }

    clearFailures(targetKey);
    return succeed(op, action, target, actor, v.verification, at, { unchanged: res.unchanged === true });
  } catch (err) {
    return fail(op, action, target, actor,
      operationError('engine_error', 'The operation could not be completed.', String(err?.message || err).slice(0, 200)), at, { phase: 'execution' });
  } finally {
    releaseAll(lockKeys, op.id);
    // The inventory this operation just changed is now stale everywhere; drop it so the next
    // read (and the UI's next poll) sees the new state instead of a cached old one.
    try { model.invalidateDiscovery(); } catch { /* never fail an operation on a cache */ }
  }
}

/**
 * Controlled (non-lifecycle) execution: a single enumerated control call, or a transaction with
 * rollback. The runner verifies its own outcome (each one knows what "done" looks like); the
 * engine adds the bounded timeout, the lock lifetime, the record and the activity.
 */
async function runControlled({ op, action, target, params, plan, actor, sessionId, at, lockKeys }) {
  const targetKey = lockKeys[0];
  const keepAlive = setInterval(() => { for (const k of lockKeys) touch(k, { opId: op.id }); }, 10_000);
  try {
    if (target.type === 'container') {
      const re = await revalidateTarget(target);
      if (!re.ok) return fail(op, action, target, actor, re.error, at, { phase: 'execution' });
    }
    const onStep = (state) => { try { store.append(op, 'transaction', { at: Date.now(), note: state }); } catch {} };
    const timeoutErr = Symbol('timeout');
    let timer = null;
    const res = await Promise.race([
      dispatchControlled(action, { target, params, plan, onStep, actor, operationId: op.id }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(timeoutErr), action.timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    if (res === timeoutErr) {
      // the runner is still going; its own rollback logic finishes on its own clock — we report
      // honestly that the outcome is not known yet, and the transaction store keeps the truth
      recordFailure(targetKey, { at: Date.now() });
      return timeout(op, action, target, actor,
        operationError('verification_timeout', `${capitalize(action.progressive)} ${target.label || target.id} took longer than expected. The transaction log holds its final state.`),
        { state: null, health: null, verified: false, note: 'still running when the operation window closed' }, at);
    }
    if (!res.ok) {
      recordFailure(targetKey, { at: Date.now() });
      return fail(op, action, target, actor, operationError(res.code || 'engine_error', res.reason || engineReason(res.code), res.detail || null), at, { phase: 'execution' });
    }
    clearFailures(targetKey);
    const verification = await verifyControlled(action, target, res.result);
    return settle(op, { status: 'succeeded', result: res.result, verification, at: Date.now() });
  } catch (err) {
    return fail(op, action, target, actor,
      operationError('engine_error', 'The operation could not be completed.', String(err?.message || err).slice(0, 200)), at, { phase: 'execution' });
  } finally {
    clearInterval(keepAlive);
    releaseAll(lockKeys, op.id);
    try { model.invalidateDiscovery(); } catch { /* never fail an operation on a cache */ }
  }
}

/**
 * The ONLY place a controlled action becomes a runner call — the same static switch discipline
 * as `dispatch`, one case per registry `adapter` value.
 */
function dispatchControlled(action, ctx) {
  switch (action.adapter) {
    case 'rename': return runners.rename({ ...ctx, action });
    case 'remove': return runners.remove({ ...ctx, action });
    case 'pull': return runners.pullImage({ ...ctx, action });
    case 'network_attach': return runners.networkAttach({ ...ctx, action });
    case 'network_detach': return runners.networkDetach({ ...ctx, action });
    case 'update': return runners.updateInPlace({ ...ctx, action });
    case 'recreate': return runners.recreate({ ...ctx, action });
    case 'edit': return runners.edit({ ...ctx, action });
    case 'change_image': return runners.changeImage({ ...ctx, action });
    case 'duplicate': return runners.duplicate({ ...ctx, action });
    case 'create': return runners.create({ ...ctx, action });
    case 'image_pull': return runners.pullImage({ ...ctx, action, params: { ...(ctx.params || {}), image: ctx.params?.image || ctx.target.id } });
    case 'stack_deploy': return stackRunners.deploy({ ...ctx, action });
    case 'stack_start': return stackRunners.start({ ...ctx, action });
    case 'stack_stop': return stackRunners.stop({ ...ctx, action });
    case 'stack_remove': return stackRunners.remove({ ...ctx, action });
    case 'install': return catalogRunners.install({ ...ctx, action });
    default: return Promise.resolve({ ok: false, code: 'unknown_action', reason: 'No runner for that action.' });
  }
}

/** After a controlled action: what does the engine say about the thing now? */
async function verifyControlled(action, target, result) {
  const base = { verified: true, verifiedAt: Date.now(), state: null, health: null };
  try {
    switch (action.expect) {
      case 'gone': return { ...base, state: 'removed' };
      case 'image': return { ...base, state: result?.changed ? 'updated' : 'unchanged' };
      case 'stack': return { ...base, state: result?.state || 'applied', services: result?.services ?? null };
      case 'replaced':
      case 'created': {
        const id = result?.newContainerId;
        if (!id) return { ...base, state: 'created' };
        const insp = await docker.inspectContainer(id).catch(() => null);
        const h = insp ? await postOperationHealth({ ...target, containerId: id, service: result?.name || target.service }, Date.now()) : null;
        return { ...base, state: insp?.state?.status || 'created', health: h || null, containerId: id };
      }
      default: {
        const insp = await docker.inspectContainer(target.containerId).catch(() => null);
        return { ...base, state: insp?.state?.status || null, health: insp?.state?.health ?? null };
      }
    }
  } catch {
    return { ...base, verified: false, note: 'post-operation state could not be read' };
  }
}

function acquireAll(keys, meta) {
  const taken = [];
  for (const k of keys) {
    const r = acquire(k, meta);
    if (!r.ok) { for (const t of taken) release(t, meta.opId); return { ok: false, key: k }; }
    taken.push(k);
  }
  return { ok: true };
}
function releaseAll(keys, opId) { for (const k of keys) release(k, opId); }

function eventSubject(target, op) {
  if (!target) return { kind: 'service', id: op.id, label: op.action, href: '/services' };
  if (target.type === 'stack') return { kind: 'stack', id: target.id, label: target.label || target.id, href: '/stacks' };
  if (target.type === 'image') return { kind: 'image', id: target.id, label: target.id, href: '/services' };
  if (target.type === 'catalog') return { kind: 'service', id: target.name || target.id, label: target.label || target.id, href: '/services' };
  return { kind: 'service', id: target.containerId || target.id || op.id, label: target.label || target.containerName || op.action, href: '/services' };
}

/**
 * The ONLY place an action becomes a Docker call.
 *
 * A static switch: there is no way for an action id, a request field or a registry value to reach
 * any other adapter method. Adding an action means adding a case here, next to the proof that
 * enumerates the endpoints it is allowed to touch.
 */
function dispatch(action, containerId) {
  switch (action.adapter) {
    case 'start': return dockerOps.startContainer(containerId, { timeoutMs: action.timeoutMs });
    case 'stop': return dockerOps.stopContainer(containerId, { timeoutMs: action.timeoutMs });
    case 'restart': return dockerOps.restartContainer(containerId, { timeoutMs: action.timeoutMs });
    case 'pause': return dockerOps.pauseContainer(containerId, { timeoutMs: action.timeoutMs });
    case 'unpause': return dockerOps.unpauseContainer(containerId, { timeoutMs: action.timeoutMs });
    case 'kill': return dockerOps.killContainer(containerId, { timeoutMs: action.timeoutMs });
    default: return Promise.resolve({ ok: false, code: 'unknown_action', status: null });
  }
}

/**
 * Bounded post-operation verification: re-read the container and confirm the expected state.
 *
 * For a restart, "running again" is not enough on its own — the container was running before.
 * A changed `startedAt` is what proves the restart actually happened.
 */
async function verify(action, target, before, { windowMs, at }) {
  const deadline = at + windowMs;
  let last = { state: null, health: null, startedAt: null, verified: false };
  while (Date.now() < deadline) {
    const insp = await docker.inspectContainer(target.containerId).catch(() => null);
    if (insp) {
      const state = insp.state?.status || null;
      const health = insp.state?.health ?? null;
      const startedAt = insp.state?.startedAt || null;
      const reached = action.expect === 'running'
        ? state === 'running'
        : action.expect === 'paused'
          ? state === 'paused'
          : (state === 'exited' || state === 'created' || state === 'dead');
      const restarted = action.adapter !== 'restart' ? true : (startedAt && before?.state?.startedAt ? startedAt !== before.state.startedAt : state === 'running');
      // An unhealthy verdict is a real outcome worth reporting, but a container whose
      // healthcheck has not finished yet is "starting", not "failed".
      const healthy = action.expect === 'running' ? health !== 'unhealthy' : true;
      last = { state, health, startedAt, verified: !!(reached && restarted && healthy) };
      if (last.verified) {
        const h = await postOperationHealth(target, at);
        return { ok: true, verification: { ...last, restartCount: insp.state?.restartCount ?? null, health: h || null, verifiedAt: Date.now() } };
      }
    }
    await sleep(VERIFY_POLL_MS);
  }
  return { ok: false, verification: { ...last, note: 'the expected state was not reached in time' } };
}

/**
 * A bounded re-read of the service's unified health after the operation.
 *
 * "Operation succeeded" and "the service is healthy" are different statements, and the second one
 * needs its own evidence. If the check cannot finish inside the window, the result says the
 * service is still starting rather than claiming health it did not measure.
 */
async function postOperationHealth(target, at) {
  try {
    const inv = await model.getInventory({ force: true });
    const svc = (inv.services || []).find((s) => s.name === target.service || String(s.id).startsWith(target.containerId));
    if (!svc) return null;
    const timeout = new Promise((r) => setTimeout(() => r(null), HEALTH_TIMEOUT_MS));
    const doc = await Promise.race([evaluateServiceHealth(svc, {}), timeout]);
    if (!doc) return { state: 'starting', detail: 'still starting', measured: false };
    // the health model answers { service, health: { state, evidence, detail }, probe }
    const h = doc.health || {};
    return { state: h.state || 'unknown', detail: h.detail || null, evidence: h.evidence || null, measured: true };
  } catch {
    return { state: 'unknown', detail: 'health could not be re-evaluated', measured: false };
  }
}

/* ------------------------------------------------------------------ */
/* outcomes                                                            */
/* ------------------------------------------------------------------ */

function settle(op, { status, error = null, result = null, verification = null, at = Date.now() }) {
  const next = {
    ...op,
    status,
    error,
    result,
    verification,
    completedAt: at,
    durationMs: op.requestedAt ? at - op.requestedAt : null,
    // every settled operation carries its own audit trail id — the record and the trail are
    // the same story, so the UI can open one from the other
    auditId: op.auditId || op.id,
  };
  store.put(next);
  store.append(next, 'completed', { at });
  logActivity(next);
  // Phase 10B — publish operation completion events
  try {
    const target = next.target || {};
    const subject = eventSubject(target, next);
    if (status === 'succeeded') {
      publishEventSafe({
        type: 'operation.completed',
        severity: 'notice',
        source: 'operation',
        subject,
        message: `${next.action} completed for ${subject.label}`,
        payload: { action: next.action, state: verification?.state || null, ...(next.plan?.diff ? { changes: { changed: next.plan.diff.changed, recreate: next.plan.diff.recreate } } : {}), ...(result?.newContainerId ? { newContainerId: result.newContainerId } : {}) },
        correlation: { operationId: next.id },
      });
    } else if (status === 'failed') {
      publishEventSafe({
        type: 'operation.failed',
        severity: 'warning',
        source: 'operation',
        subject,
        message: `${next.action} failed for ${subject.label}: ${error?.reason || 'failed'}`,
        payload: { action: next.action, code: error?.code || null },
        correlation: { operationId: next.id },
      });
    } else if (status === 'timed_out') {
      publishEventSafe({
        type: 'operation.timed_out',
        severity: 'warning',
        source: 'operation',
        subject,
        message: `${next.action} timed out for ${subject.label}`,
        payload: { action: next.action },
        correlation: { operationId: next.id },
      });
    }
  } catch {}
  return next;
}

const succeed = (op, action, target, actor, verification, at, extra = {}) => settle(op, {
  status: 'succeeded',
  result: { state: verification.state, health: verification.health ?? null, unchanged: extra.unchanged === true },
  verification,
  at: Date.now(),
});

const fail = (op, action, target, actor, error, at, extra = {}) => settle(op, {
  status: 'failed', error, verification: { state: null, health: null, verified: false }, at: Date.now(),
});

const timeout = (op, action, target, actor, error, verification, at) => settle(op, {
  status: 'timed_out', error, verification, at: Date.now(),
});

/**
 * Activity integration — one event per settled operation, and only one.
 *
 * The signature includes the operation id, so a retry, a poll or a duplicate can never turn into
 * a second event for the same operation.
 */
function logActivity(op) {
  const target = op.target || {};
  const subject = target.label || target.containerName || target.service || null;
  const meta = {
    opId: op.id,
    action: op.action,
    container: target.containerName || null,
    service: target.service || null,
    project: target.stack || null,
    group: target.group || null,
    durationMs: op.durationMs,
    state: op.verification?.state ?? null,
    health: op.verification?.health ?? null,
    code: op.error?.code ?? null,
  };
  if (op.status === 'succeeded') {
    const verb = isKnownAction(op.action) ? getAction(op.action).past : 'completed';
    logEvent({
      source: 'user', type: 'operation.succeeded', subject,
      message: verb, meta, category: 'service', severity: 'notice',
      signature: `operation.succeeded:${op.id}`,
    });
  } else if (op.status === 'failed') {
    logEvent({
      source: 'user', type: 'operation.failed', subject,
      message: op.error?.reason || 'failed', meta, category: 'service', severity: 'warning',
      signature: `operation.failed:${op.id}`,
    });
  } else if (op.status === 'timed_out') {
    logEvent({
      source: 'user', type: 'operation.timeout', subject,
      message: op.error?.reason || 'timed out', meta, category: 'service', severity: 'warning',
      signature: `operation.timeout:${op.id}`,
    });
  } else if (op.status === 'rejected') {
    logEvent({
      source: 'user', type: 'operation.rejected', subject,
      message: op.error?.reason || 'rejected', meta, category: 'service', severity: 'warning',
      signature: `operation.rejected:${op.id}`,
    });
  } else if (op.status === 'cancelled') {
    logEvent({
      source: 'user', type: 'operation.cancelled', subject,
      message: 'cancelled', meta, category: 'service',
      signature: `operation.cancelled:${op.id}`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* reads                                                               */
/* ------------------------------------------------------------------ */

export function getOperation(id) {
  const op = store.get(id);
  return op ? publicOperation(op) : null;
}

/** The trail of one operation — what happened, in order, with times. */
export function operationTrail(id) {
  const op = store.get(id);
  if (!op) return null;
  return { operation: publicOperation(op), trail: readTrail(id) };
}

/**
 * Cancel an operation that is waiting for confirmation.
 *
 * Only an `awaiting_confirmation` operation can be cancelled — one that is already running is
 * allowed to finish (there is no safe way to recall it, and pretending otherwise would be a lie).
 */
export function cancelOperation({ operationId, actor = null, sessionId = null, at = Date.now() }) {
  const op = operationId ? store.get(operationId) : null;
  if (!op) return { ok: false, status: 404, error: operationError('unknown_operation', 'No operation with that id.') };
  if (op.status !== 'awaiting_confirmation') {
    return { ok: false, status: 409, error: operationError('not_cancellable', 'That operation is no longer waiting for confirmation.') };
  }
  if (op.sessionId && sessionId && op.sessionId !== sessionId) {
    return { ok: false, status: 403, error: operationError('not_permitted', 'That operation belongs to a different session.') };
  }
  cancelByOperation(op.id);   // the token dies with the operation it was minted for
  const next = settle({ ...op }, { status: 'cancelled', at });
  return { ok: true, status: 200, operation: publicOperation(next) };
}

/**
 * The whole Operations surface in one read: what is allowed, what exists, and what happened.
 *
 * `actor` shapes the answer — a viewer sees the same capabilities list with none of them
 * permitted, because the point of the pane is to make the boundary visible.
 */
export async function operationsOverview({ actor = null, limit = 40, at = Date.now() } = {}) {
  const rows = store.list({ limit });
  const running = rows.filter((r) => r.status === 'authorized' || r.status === 'running' || r.status === 'awaiting_confirmation');
  const failed = rows.filter((r) => r.status === 'failed' || r.status === 'timed_out');
  const recent = rows.filter((r) => !running.includes(r)).slice(0, Math.min(20, limit));
  const availability = dockerOps.operationsAvailability();
  return {
    at,
    actor: describeActor(actor),
    actions: registrySummary().map((a) => ({ ...a, permitted: can(actor, a.permission) })),
    docker: {
      read: docker.availability().ok,
      operations: availability.ok,
      // "dedicated" says whether a separate operations socket is in use — never its path
      channel: availability.dedicated ? 'dedicated' : 'shared',
    },
    counts: {
      running: running.length,
      failed: failed.length,
      recent: recent.length,
    },
    running,
    failed: failed.slice(0, 10),
    recent,
  };
}

/** Recent operations for one service — the Service Detail "recent operations" list. */
export function operationsForTarget(target, { limit = 5 } = {}) {
  if (!target) return [];
  return store.history({ limit, target: String(target) }).map((r) => ({
    id: r.opId || r.id,
    action: r.action,
    status: r.status,
    actor: r.actor,
    at: r.t,
    durationMs: r.durationMs ?? null,
    reason: r.reason ?? null,
    state: r.verification?.state ?? null,
  }));
}

/** Boot recovery: say out loud that interrupted operations have an unknown outcome. */
export function recoverInterrupted({ at = Date.now() } = {}) {
  return store.recoverInterrupted({ at });
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Map a policy error code onto an HTTP status the client can act on. */
function errorStatus(error) {
  switch (error?.code) {
    case 'unknown_action':
    case 'bad_target': return 400;
    case 'unknown_target':
    case 'ambiguous_target': return 404;
    case 'stale_target': return 409;
    case 'not_permitted': return 403;
    case 'docker_unavailable': return 503;
    case 'bad_params':
    case 'no_change':
    case 'not_applicable':
    case 'needs_recreate': return 400;
    case 'policy_blocked':
    case 'ineligible':
    case 'not_reproducible':
    case 'container_running': return 422;
    case 'not_available': return 501;
    case 'already_running':
    case 'confirmation_required':
    case 'confirmation_invalid':
    case 'confirmation_expired':
    case 'confirmation_used':
    case 'confirmation_mismatch': return 409;
    case 'backoff': return 429;
    default: return 409;
  }
}

/** Test helpers. */
export function _resetEngine() {
  store._resetStore();
}
export const _internals = { VERIFY_POLL_MS, HEALTH_TIMEOUT_MS, errorStatus, dispatch, dispatchControlled, verify, parseTargetRef };
