// Phase 10C — Container updates API
// Handlers for:
// - GET /api/container-updates (list of pending image updates)
// - GET /api/container-updates/:target (update detail for container/service)
// - POST /api/container-updates/webhook (Diun webhook intake with Bearer secret auth & rate limit)
// - POST /api/container-updates/dry-run (Preflight / plan)
// - POST /api/container-updates/apply (Confirmed update execution)

import * as store from './updates/store.js';
import { handleDiunWebhook } from './updates/diun.js';
import { dryRunUpdate, executeUpdate } from './updates/engine.js';
import { verifyWebhookAuth, checkWebhookRateLimit, MAX_BODY_SIZE } from './updates/webhookAuth.js';
import { operationError } from './operations/model.js';

export async function handleUpdatesRoutes({ req, p, method, send, jsonBody, actor, sessionId, query, clientIp }) {
  // GET /api/container-updates
  if (p === '/api/container-updates' && method === 'GET') {
    const status = query?.get('status') || null;
    const serviceId = query?.get('service') || null;
    const updates = store.listUpdates({ status, serviceId });
    send(200, {
      updates,
      count: updates.length,
      availableCount: updates.filter((u) => u.status === 'update_available').length,
    });
    return true;
  }

  // GET /api/container-updates/:id
  const match = p.match(/^\/api\/container-updates\/([^/]+)$/);
  if (match && method === 'GET' && p !== '/api/container-updates/webhook' && p !== '/api/container-updates/dry-run' && p !== '/api/container-updates/apply') {
    const id = decodeURIComponent(match[1]);
    const rec = store.getUpdate(id);
    if (!rec) {
      send(404, { error: 'No update record found for that container or service', code: 'not_found' });
      return true;
    }
    send(200, { update: rec });
    return true;
  }

  // POST /api/container-updates/webhook (Diun intake)
  if (p === '/api/container-updates/webhook' && method === 'POST') {
    // 1. Rate limiting
    const rate = checkWebhookRateLimit(clientIp);
    if (!rate.ok) {
      send(429, { error: 'Too many webhook requests. Please slow down.', code: 'rate_limited' });
      return true;
    }

    // 2. Secret authentication (Authorization: Bearer <secret>)
    const authCheck = verifyWebhookAuth(req);
    if (!authCheck.ok) {
      send(authCheck.status, { error: authCheck.reason, code: authCheck.code });
      return true;
    }

    // 3. Body parsing (capped size)
    let body = {};
    try {
      body = await jsonBody({ maxSize: MAX_BODY_SIZE });
    } catch (err) {
      send(400, { error: 'Invalid or oversized JSON body', code: 'bad_request' });
      return true;
    }

    const res = await handleDiunWebhook(body);
    send(res.ok ? 200 : 400, res);
    return true;
  }

  // POST /api/container-updates/dry-run
  if (p === '/api/container-updates/dry-run' && method === 'POST') {
    let body = {};
    try {
      body = await jsonBody();
    } catch {
      send(400, { error: 'Invalid JSON body', code: 'bad_request' });
      return true;
    }
    if (!body.target) {
      send(400, { error: 'Target reference is required', code: 'bad_target' });
      return true;
    }
    const res = await dryRunUpdate({
      targetRef: body.target,
      actor,
      sessionId,
    });
    send(res.status, res.ok ? res : { error: res.error?.reason || 'Dry run failed', code: res.error?.code || 'error' });
    return true;
  }

  // POST /api/container-updates/apply
  if (p === '/api/container-updates/apply' && method === 'POST') {
    let body = {};
    try {
      body = await jsonBody();
    } catch {
      send(400, { error: 'Invalid JSON body', code: 'bad_request' });
      return true;
    }
    if (!body.target || !body.confirmationToken) {
      send(400, { error: 'Target and confirmationToken are required', code: 'bad_request' });
      return true;
    }
    const res = await executeUpdate({
      targetRef: body.target,
      confirmationToken: body.confirmationToken,
      actor,
      sessionId,
    });
    send(res.status, res.ok ? res : { error: res.error?.reason || 'Update failed', code: res.error?.code || 'error' });
    return true;
  }

  return false;
}
