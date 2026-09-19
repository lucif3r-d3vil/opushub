// Phase 10C — Autoheal API routes with Bearer secret auth & rate limit
import { getAutohealStatus, handleAutohealWebhook } from './autoheal/observer.js';
import { verifyWebhookAuth, checkWebhookRateLimit, MAX_BODY_SIZE } from './updates/webhookAuth.js';

export async function handleAutohealRoutes({ req, p, method, send, jsonBody, clientIp }) {
  // GET /api/autoheal/status
  if (p === '/api/autoheal/status' && method === 'GET') {
    const status = await getAutohealStatus();
    send(200, status);
    return true;
  }

  // POST /api/autoheal/webhook (Autoheal recovery intake)
  if (p === '/api/autoheal/webhook' && method === 'POST') {
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
    } catch {
      // body may be plain text or JSON
    }

    const res = await handleAutohealWebhook(body);
    send(res.ok ? 200 : 400, res);
    return true;
  }

  return false;
}
