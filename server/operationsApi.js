// Operations API — the only HTTP surface the Operations Engine has.
//
// Everything security-relevant is decided before this module runs, in api.js: the session gate
// (every route here is non-public), the CSRF check (every route here that changes state is a
// POST), and the JSON-only body rule. This module therefore contains no authentication logic of
// its own — and that is deliberate. There is exactly one door, and it is already guarded.
//
// What the client may send:
//   { action: 'container.restart', target: { type: 'service', id: 'jellyfin', group: 'Media' } }
//
// What the client can never send, because nothing here reads it:
//   a Docker URL, an HTTP method, a Docker API path, a container id used as an endpoint,
//   a shell command, an exec request, a compose command, or a "yes I'm allowed" flag.
import { dryRunReport } from './operations/policy.js';
import * as engine from './operations/engine.js';
import { parseTargetRef } from './operations/targets.js';
import { operationError } from './operations/model.js';

const MAX_BODY_FIELDS = 8;

/**
 * A request body for an operation: an action id and a target reference. Anything else in the
 * object is ignored on purpose rather than rejected with a lecture — but it is ignored, never
 * interpreted, and never forwarded.
 */
function readOperationBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: operationError('bad_request', 'Expected a JSON object.') };
  }
  // The action is NOT checked against the registry here. Refusals belong to the engine, which
  // audits them: "someone asked for an operation that does not exist" is exactly the kind of
  // thing the operations trail should be able to answer. Anything that is not a string simply
  // cannot name an action, and is recorded as such.
  const action = typeof body.action === 'string' ? body.action.trim().slice(0, 64) : null;
  const parsed = parseTargetRef(body.target);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  // guard against a body padded with junk — an operation request is three small fields
  if (Object.keys(body).length > MAX_BODY_FIELDS) {
    return { ok: false, error: operationError('bad_request', 'The operation request has too many fields.') };
  }
  // Phase 10D — `params`: an object the engine validates against the action's declared schema
  // (operations/params.js). It is passed through opaque here; nothing in this layer reads it.
  const params = body.params === undefined ? undefined : body.params;
  return { ok: true, action, targetRef: parsed.ref, params, operationId: typeof body.operationId === 'string' ? body.operationId.trim().slice(0, 64) : null, confirmationToken: typeof body.confirmationToken === 'string' ? body.confirmationToken.trim().slice(0, 256) : null };
}

/**
 * Handle the operations routes.
 *
 * @returns {Promise<boolean>} true when the route was one of ours (and answered), false so the
 * rest of the API dispatch can carry on.
 */
export async function handleOperations({ p, method, send, jsonBody, actor, sessionId, query = null }) {
  const base = p === '/api/operations' || p === '/api/v1/operations';
  const m = p.match(/^\/api\/(?:v1\/)?operations\/([^/]+)$/);
  const sub = p.match(/^\/api\/(?:v1\/)?operations\/([^/]+)\/(trail|cancel)$/);

  // ---- capabilities + recent operations ----
  if (method === 'GET' && base) {
    const doc = await engine.operationsOverview({ actor, limit: 40 });
    // ?service=<container or service name> narrows it to one service's history — used by the
    // "Recent operations" list on Service Detail. Filtering happens here, not in the browser.
    const service = query?.get('service');
    send(200, service ? { ...doc, operations: engine.operationsForTarget(String(service).slice(0, 128), { limit: 8 }) } : doc);
    return true;
  }

  // ---- one operation ----
  if (method === 'GET' && m) {
    const id = decodeURIComponent(m[1]);
    const op = engine.getOperation(id);
    if (!op) { send(404, { error: 'No operation with that id.', code: 'unknown_operation' }); return true; }
    send(200, { operation: op });
    return true;
  }

  // ---- the audit trail of one operation ----
  if (method === 'GET' && sub && sub[2] === 'trail') {
    const id = decodeURIComponent(sub[1]);
    const doc = engine.operationTrail(id);
    if (!doc) { send(404, { error: 'No operation with that id.', code: 'unknown_operation' }); return true; }
    send(200, doc);
    return true;
  }

  // ---- cancel an operation that is waiting for confirmation ----
  if (method === 'POST' && sub && sub[2] === 'cancel') {
    const id = decodeURIComponent(sub[1]);
    const r = engine.cancelOperation({ operationId: id, actor, sessionId });
    send(r.status, r.ok ? { operation: r.operation } : { error: r.error.reason, code: r.error.code });
    return true;
  }

  // ---- dry-run: evaluate, do not execute ----
  if (method === 'POST' && p === '/api/operations/dry-run') {
    const body = await readBody(jsonBody);
    if (!body.ok) { send(400, { error: body.error.reason, code: body.error.code }); return true; }
    const r = await engine.requestOperation({
      actionId: body.action, targetRef: body.targetRef, params: body.params, actor, sessionId,
    });
    if (r.status !== 200) {
      send(r.status, { operation: r.operation, evaluation: r.evaluation, error: r.operation?.error?.reason || null, code: r.operation?.error?.code || null });
      return true;
    }
    send(200, {
      operation: r.operation,
      // the panel the dialog renders — the same checks execution will repeat
      dryRun: dryRunReport({ evaluation: r.evaluation, confirmationRequired: true, mode: r.confirmation.mode }),
      confirmation: {
        required: true,
        mode: r.confirmation.mode,
        token: r.confirmation.token,
        expiresAt: r.confirmation.expiresAt,
        ttlMs: r.confirmation.ttlMs,
        prompt: r.confirmation.prompt,
      },
    });
    return true;
  }

  // ---- execute a confirmed operation ----
  if (method === 'POST' && base) {
    const body = await readBody(jsonBody);
    if (!body.ok) { send(400, { error: body.error.reason, code: body.error.code }); return true; }
    const r = await engine.executeOperation({
      operationId: body.operationId,
      actionId: body.action,
      targetRef: body.targetRef,
      params: body.params,
      confirmationToken: body.confirmationToken,
      actor,
      sessionId,
    });
    send(r.status, { operation: r.operation, error: r.operation?.error?.reason || null, code: r.operation?.error?.code || null });
    return true;
  }

  return false;
}

async function readBody(jsonBody) {
  try {
    const body = await jsonBody();
    return readOperationBody(body);
  } catch (err) {
    return { ok: false, error: operationError('bad_request', String(err?.message || err).slice(0, 200)) };
  }
}
