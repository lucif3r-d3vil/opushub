// Phase 10D-B — managed stacks (Compose as data).
//
//   GET    /api/v1/stacks/managed                the managed stacks (env values masked)
//   POST   /api/v1/stacks/managed                create  { name, compose, env? }   → validated, stored, NOT deployed
//   GET    /api/v1/stacks/managed/:id            one managed stack + live members + last deploy
//   PATCH  /api/v1/stacks/managed/:id            update  { compose?, env? }         → new revision, NOT deployed
//   DELETE /api/v1/stacks/managed/:id            forget the definition (containers untouched; refuse if deployed)
//   POST   /api/v1/stacks/managed/:id/validate   parse + policy for the stored (or a submitted) document; no writes
//   POST   /api/v1/stacks/managed/:id/plan       the deployment plan against the live engine; no writes
//   GET    /api/v1/stacks/managed/:id/history    deployment history
//   POST   /api/v1/stacks/managed/:id/rollback   re-store the last successful document (a new revision; deploy separately)
//   POST   /api/v1/stacks/:id/{deploy,start,stop,remove}
//          thin wrappers: they call the operations engine with `stack.<verb>` and return the same
//          dry-run + confirmation shape as POST /api/v1/operations/dry-run. Execution is the
//          ordinary confirmed POST /api/v1/operations — one confirmation flow, no second door.
//
// `/api/stacks` (unversioned, GET/PUT) remains the discovery projection + stacks.yaml overlays.
// The managed store never feeds inventory: members always come from Docker.
import * as store from './stacks/store.js';
import { parseCompose } from './stacks/compose.js';
import { classifyStack } from './stacks/policy.js';
import { resolveStackTarget, planDeploy } from './stacks/targets.js';
import { parseParams } from './operations/params.js';
import { can, PERMISSIONS } from './operations/permissions.js';
import { operationError } from './operations/model.js';
import { dryRunReport, publicPlan } from './operations/policy.js';
import * as engine from './operations/engine.js';
import { maskEnvValue } from './containers/diff.js';
import { logEvent } from './activity.js';
import { publishEventSafe } from './events/index.js';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERBS = Object.freeze({ deploy: 'stack.deploy', start: 'stack.start', stop: 'stack.stop', remove: 'stack.remove' });

const maskEnv = (env) => Object.fromEntries(Object.entries(env || {}).map(([k, v]) => [k, maskEnvValue(k, v)]));

function publicStack(s, extra = {}) {
  return {
    id: s.id, name: s.name, revision: s.revision, compose: s.compose, env: maskEnv(s.env),
    envKeys: Object.keys(s.env || {}), createdAt: s.createdAt, createdBy: s.createdBy, updatedAt: s.updatedAt, updatedBy: s.updatedBy,
    lastDeploy: s.lastDeploy, ...extra,
  };
}

/** Env submitted by the browser: a masked value for an existing key means "keep the stored value". */
function mergeEnv(stored, incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming || {})) out[k] = stored && k in stored && v === maskEnvValue(k, stored[k]) ? stored[k] : v;
  return out;
}

/** Returns true when the route was handled. */
export async function handleStacksRoutes({ p, method, send, jsonBody, actor, sessionId }) {
  const m = p.match(/^\/api\/(?:v1\/)?stacks\/(?:managed(?:\/([^/]+))?(?:\/(validate|plan|history|rollback))?|([^/]+)\/(deploy|start|stop|remove))$/);
  if (!m) return false;
  const [, managedId, sub, verbId, verb] = m;
  const bad = (status, code, error, extra = {}) => { send(status, { error, code, ...extra }); return true; };
  const manage = can(actor, PERMISSIONS.STACK_MANAGE);

  // ---- the operation wrappers ----
  if (verb) {
    if (method !== 'POST') return bad(405, 'method_not_allowed', 'Method not allowed');
    const id = decodeURIComponent(verbId).toLowerCase();
    if (!ID_RE.test(id)) return bad(400, 'bad_target', 'That is not a stack id.');
    const r = await engine.requestOperation({ actionId: VERBS[verb], targetRef: { type: 'stack', id }, actor, sessionId });
    if (r.status !== 200) return bad(r.status, r.operation?.error?.code || null, r.operation?.error?.reason || null, { operation: r.operation, evaluation: r.evaluation });
    send(200, {
      operation: r.operation,
      dryRun: dryRunReport({ evaluation: r.evaluation, confirmationRequired: true, mode: r.confirmation.mode }),
      confirmation: { required: true, mode: r.confirmation.mode, token: r.confirmation.token, expiresAt: r.confirmation.expiresAt, ttlMs: r.confirmation.ttlMs, prompt: r.confirmation.prompt },
      execute: { path: '/api/v1/operations', body: { action: VERBS[verb], target: { type: 'stack', id }, operationId: r.operation.id, confirmationToken: '<token>' } },
    });
    return true;
  }

  // ---- collection ----
  if (managedId === undefined) {
    if (method === 'GET') {
      send(200, { stacks: store.listStacks().map((s) => publicStack(s)), permissions: { manage, deploy: can(actor, PERMISSIONS.STACK_DEPLOY), remove: can(actor, PERMISSIONS.STACK_REMOVE) } });
      return true;
    }
    if (method === 'POST') {
      if (!manage) return bad(403, 'not_permitted', 'Your account is not allowed to manage stacks.');
      let body;
      try { body = await jsonBody(); } catch (err) { return bad(err?.status || 400, 'bad_request', String(err?.message || err)); }
      const parsed = parseParams('stack_source', body);
      if (!parsed.ok) return bad(400, parsed.error.code, parsed.error.reason);
      if (!parsed.params.name) return bad(400, 'bad_params', 'A stack name is required.');
      const v = parseCompose(parsed.params.compose, { project: parsed.params.name, env: parsed.params.env });
      const policy = v.model ? classifyStack(v.model) : null;
      if (!v.ok) return bad(422, 'invalid_compose', v.errors[0], { errors: v.errors, warnings: v.warnings });
      if (policy.blocked) return bad(422, 'policy_blocked', 'The Compose document is not allowed by policy.', { errors: policy.findings.filter((f) => f.level === 'BLOCKED').map((f) => f.message), warnings: v.warnings, policy });
      const live = await resolveStackTarget({ type: 'stack', id: parsed.params.name }).catch(() => ({ ok: false }));
      const r = store.createStack({ name: parsed.params.name, compose: parsed.params.compose, env: parsed.params.env, actor });
      if (!r.ok) return bad(409, r.code, r.reason);
      logEvent({ source: 'config', type: 'stack.created', subject: r.stack.id, message: `managed stack ${r.stack.id} created by ${actor || 'unknown'}`, meta: { services: v.model.services.length } });
      publishEventSafe({ type: 'config.updated', severity: 'info', source: 'config', subject: { kind: 'stack', id: r.stack.id, label: r.stack.id, href: '/stacks' }, message: `Managed stack ${r.stack.id} created`, payload: { stack: r.stack.id, revision: 1 } });
      send(201, { stack: publicStack(r.stack, { adopted: !!live.ok && live.target.memberIds.length > 0, members: live.ok ? live.target.members.length : 0 }), validation: { ok: true, warnings: v.warnings, policy, services: v.model.services.map((s) => ({ key: s.key, container: s.containerName, image: s.spec.image })) } });
      return true;
    }
    return bad(405, 'method_not_allowed', 'Method not allowed');
  }

  // ---- one managed stack ----
  const id = decodeURIComponent(managedId).toLowerCase();
  if (!ID_RE.test(id)) return bad(400, 'bad_target', 'That is not a stack id.');
  const stack = store.getStack(id);

  if (!sub) {
    if (method === 'GET') {
      if (!stack) return bad(404, 'not_found', 'No managed stack with that id.');
      const live = await resolveStackTarget({ type: 'stack', id }).catch(() => ({ ok: false }));
      const v = parseCompose(stack.compose, { project: id, env: stack.env });
      send(200, {
        stack: publicStack(stack, {
          members: live.ok ? live.target.members.map((x) => ({ containerName: x.containerName, service: x.service, state: x.state, health: x.health, image: x.image, id: x.containerId.slice(0, 12) })) : [],
          state: live.ok ? live.target.state : 'unknown',
          validation: { ok: v.ok, errors: v.errors, warnings: v.warnings, policy: v.model ? classifyStack(v.model) : null, services: v.model ? v.model.services.map((s) => ({ key: s.key, container: s.containerName, image: s.spec.image })) : [] },
        }),
        history: store.historyFor(id, { limit: 10 }).map(publicHistory),
        permissions: { manage, deploy: can(actor, PERMISSIONS.STACK_DEPLOY), remove: can(actor, PERMISSIONS.STACK_REMOVE) },
      });
      return true;
    }
    if (method === 'PATCH') {
      if (!manage) return bad(403, 'not_permitted', 'Your account is not allowed to manage stacks.');
      if (!stack) return bad(404, 'not_found', 'No managed stack with that id.');
      let body;
      try { body = await jsonBody(); } catch (err) { return bad(err?.status || 400, 'bad_request', String(err?.message || err)); }
      const parsed = parseParams('stack_source', { name: id, compose: body?.compose ?? stack.compose, env: body?.env ?? maskEnv(stack.env) });
      if (!parsed.ok) return bad(400, parsed.error.code, parsed.error.reason);
      const env = mergeEnv(stack.env, parsed.params.env);
      const v = parseCompose(parsed.params.compose, { project: id, env });
      if (!v.ok) return bad(422, 'invalid_compose', v.errors[0], { errors: v.errors, warnings: v.warnings });
      const policy = classifyStack(v.model);
      if (policy.blocked) return bad(422, 'policy_blocked', 'The Compose document is not allowed by policy.', { errors: policy.findings.filter((f) => f.level === 'BLOCKED').map((f) => f.message), warnings: v.warnings, policy });
      const r = store.updateStack(id, { compose: parsed.params.compose, env, actor });
      logEvent({ source: 'config', type: 'stack.updated', subject: id, message: `managed stack ${id} updated to revision ${r.stack.revision} by ${actor || 'unknown'}` });
      publishEventSafe({ type: 'config.updated', severity: 'info', source: 'config', subject: { kind: 'stack', id, label: id, href: '/stacks' }, message: `Managed stack ${id} updated (revision ${r.stack.revision})`, payload: { stack: id, revision: r.stack.revision } });
      send(200, { stack: publicStack(r.stack), validation: { ok: true, warnings: v.warnings, policy } });
      return true;
    }
    if (method === 'DELETE') {
      if (!manage) return bad(403, 'not_permitted', 'Your account is not allowed to manage stacks.');
      if (!stack) return bad(404, 'not_found', 'No managed stack with that id.');
      const live = await resolveStackTarget({ type: 'stack', id }).catch(() => ({ ok: false }));
      if (live.ok && live.target.memberIds.length) return bad(409, 'deployed', 'The stack still has containers on the engine. Remove the stack first, or keep the definition.');
      store.deleteStack(id);
      logEvent({ source: 'config', type: 'stack.deleted', subject: id, message: `managed stack definition ${id} removed by ${actor || 'unknown'}` });
      send(200, { ok: true });
      return true;
    }
    return bad(405, 'method_not_allowed', 'Method not allowed');
  }

  if (sub === 'history') {
    if (method !== 'GET') return bad(405, 'method_not_allowed', 'Method not allowed');
    if (!stack) return bad(404, 'not_found', 'No managed stack with that id.');
    send(200, { history: store.historyFor(id, { limit: 30 }).map(publicHistory) });
    return true;
  }

  if (method !== 'POST') return bad(405, 'method_not_allowed', 'Method not allowed');

  if (sub === 'validate') {
    // validate the stored document, or a submitted one (the editor's "Validate" button) — no writes
    let body = {};
    try { body = (await jsonBody()) || {}; } catch (err) { return bad(err?.status || 400, 'bad_request', String(err?.message || err)); }
    const compose = typeof body.compose === 'string' ? body.compose : stack?.compose;
    if (typeof compose !== 'string') return bad(404, 'not_found', 'No managed stack with that id and no document submitted.');
    const parsed = parseParams('stack_source', { name: id, compose, env: body.env ?? (stack ? maskEnv(stack.env) : {}) });
    if (!parsed.ok) return bad(400, parsed.error.code, parsed.error.reason);
    const env = mergeEnv(stack?.env, parsed.params.env);
    const v = parseCompose(compose, { project: id, env });
    const policy = v.model ? classifyStack(v.model) : null;
    send(200, {
      ok: v.ok && !policy?.blocked, errors: v.errors, warnings: v.warnings, policy,
      services: v.model ? v.model.services.map((s) => ({ key: s.key, container: s.containerName, image: s.spec.image, dependsOn: s.dependsOn, policy: policy.perService[s.key] })) : [],
      networks: v.model ? v.model.networks.map((n) => ({ key: n.key, name: n.name, external: n.external })) : [],
      volumes: v.model ? v.model.volumes.map((x) => ({ key: x.key, name: x.name, external: x.external })) : [],
      unsupported: v.model?.unsupported || [],
    });
    return true;
  }

  if (sub === 'plan') {
    if (!stack) return bad(404, 'not_found', 'No managed stack with that id.');
    let body = {};
    try { body = (await jsonBody()) || {}; } catch (err) { return bad(err?.status || 400, 'bad_request', String(err?.message || err)); }
    const live = await resolveStackTarget({ type: 'stack', id });
    if (!live.ok) return bad(live.error.code === 'docker_unavailable' ? 503 : 404, live.error.code, live.error.reason);
    let compose = null;
    let env = null;
    if (typeof body.compose === 'string') {
      const parsed = parseParams('stack_source', { name: id, compose: body.compose, env: body.env ?? maskEnv(stack.env) });
      if (!parsed.ok) return bad(400, parsed.error.code, parsed.error.reason);
      compose = parsed.params.compose;
      env = mergeEnv(stack.env, parsed.params.env);
    }
    const planned = await planDeploy(live.target, null, { compose, env });
    if (!planned.ok) return bad(422, planned.error.code, planned.error.reason, { detail: planned.error.detail || null });
    send(200, { plan: publicPlan(planned.plan), policy: planned.policy, target: { id, state: live.target.state, members: live.target.members.length, managed: true } });
    return true;
  }

  if (sub === 'rollback') {
    if (!manage) return bad(403, 'not_permitted', 'Your account is not allowed to manage stacks.');
    if (!stack) return bad(404, 'not_found', 'No managed stack with that id.');
    const last = store.lastGoodDeploy(id);
    if (!last) return bad(404, 'no_rollback_point', 'There is no successful deployment to roll back to.');
    if (last.compose === stack.compose && JSON.stringify(last.env || {}) === JSON.stringify(stack.env || {})) return bad(409, 'no_change', 'The stored document already matches the last successful deployment.');
    const r = store.updateStack(id, { compose: last.compose, env: last.env || {}, actor });
    logEvent({ source: 'config', type: 'stack.rolled_back', subject: id, message: `managed stack ${id} document rolled back to deployment ${last.id} (revision ${r.stack.revision})` });
    send(200, { stack: publicStack(r.stack), from: publicHistory(last), next: 'Deploy the stack to apply the restored document.' });
    return true;
  }

  return bad(404, 'not_found', 'Not found');
}

function publicHistory(h) {
  const { compose: _c, env: _e, ...rest } = h;
  return { ...rest, hasDocument: typeof h.compose === 'string' };
}

export const _internals = Object.freeze({ VERBS, ID_RE, mergeEnv, operationError });
