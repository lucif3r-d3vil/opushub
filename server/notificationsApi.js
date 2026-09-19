// Phase 10B — /api/notifications routes
//
// All routes sit behind the session + CSRF gate in server/api.js: reads require a session,
// writes additionally require a same-origin request. Secrets (webhook secret, Telegram bot
// token) are write-only — GET responses carry masked forms and booleans, never the value.

import { listNotifications, unreadCount, markRead, markAllRead, getNotification, stats as notifStats } from './notifications/store.js';
import { getPolicy, putPolicy } from './notifications/policy.js';
import { getWebhookConfig, putWebhookConfig, sendWebhook, validateWebhookUrl, webhookProvider } from './notifications/providers/webhook.js';
import { getTelegramConfig, putTelegramConfig, sendTestMessage, telegramProvider } from './notifications/providers/telegram.js';
import { listProviders, registerProvider } from './notifications/providers/registry.js';

// Ensure providers are registered (init.js also registers; registration is idempotent)
try {
  registerProvider('webhook', webhookProvider);
} catch {}
try {
  registerProvider('telegram', telegramProvider);
} catch {}

export async function handleNotifications({ p, method, send, jsonBody, query }) {
  // GET /api/notifications — list
  if (p === '/api/notifications' && method === 'GET') {
    const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 50));
    const unreadOnly = query.get('unread') === '1' || query.get('unread') === 'true';
    const severity = query.get('severity') || null;
    const source = query.get('source') || null;
    const before = query.get('before') ? Number(query.get('before')) : null;

    const items = listNotifications({ limit, unreadOnly, severity, source, before });
    return send(200, {
      notifications: items,
      count: items.length,
      unread: unreadCount(),
      total: notifStats().count,
    });
  }

  // GET /api/notifications/unread-count
  if (p === '/api/notifications/unread-count' && method === 'GET') {
    return send(200, { unread: unreadCount(), total: notifStats().count });
  }

  // GET /api/notifications/stats
  if (p === '/api/notifications/stats' && method === 'GET') {
    return send(200, {
      store: notifStats(),
      providers: listProviders(),
      policy: getPolicy(),
    });
  }

  // POST /api/notifications/:id/read
  const readMatch = p.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (readMatch && method === 'POST') {
    const id = decodeURIComponent(readMatch[1]);
    const updated = markRead(id);
    if (!updated) return send(404, { error: 'no such notification', code: 'not_found' });
    return send(200, { ok: true, notification: updated });
  }

  // POST /api/notifications/read-all
  if (p === '/api/notifications/read-all' && method === 'POST') {
    const result = markAllRead();
    return send(200, { ok: true, ...result });
  }

  // GET /api/notifications/policy
  if (p === '/api/notifications/policy' && method === 'GET') {
    return send(200, { policy: getPolicy() });
  }

  // PUT /api/notifications/policy
  if (p === '/api/notifications/policy' && method === 'PUT') {
    const body = await jsonBody();
    const next = putPolicy(body);
    return send(200, { ok: true, policy: next });
  }

  // GET /api/notifications/providers
  if (p === '/api/notifications/providers' && method === 'GET') {
    return send(200, { providers: listProviders() });
  }

  // GET /api/notifications/webhook — config (masked)
  if (p === '/api/notifications/webhook' && method === 'GET') {
    return send(200, { webhook: getWebhookConfig() });
  }

  // PUT /api/notifications/webhook
  if (p === '/api/notifications/webhook' && method === 'PUT') {
    const body = await jsonBody();
    try {
      const next = putWebhookConfig({
        url: body?.url,
        secret: body?.secret,
        enabled: body?.enabled,
        allowInternal: body?.allowInternal,
        allowInsecure: body?.allowInsecure,
      });
      return send(200, { ok: true, webhook: next });
    } catch (err) {
      return send(err.status || 400, { error: err.message, code: err.code || 'invalid_webhook' });
    }
  }

  // POST /api/notifications/webhook/test — send test event
  if (p === '/api/notifications/webhook/test' && method === 'POST') {
    const body = await jsonBody();
    // Validate URL if provided in body, else use stored
    let urlToTest = body?.url;
    if (!urlToTest) {
      const testEvent = {
        id: `evt-test-${Date.now()}`,
        t: Date.now(),
        type: 'system.boot',
        severity: 'info',
        source: 'system',
        message: 'Test notification from OpusHub',
        subject: { kind: 'test', id: 'test', label: 'Test event', href: '/' },
        correlation: null,
        payload: { test: true },
      };
      const result = await sendWebhook(testEvent, null);
      return send(result.ok ? 200 : 400, { ok: result.ok, result });
    } else {
      // Validate provided URL without saving
      const validation = validateWebhookUrl(urlToTest, { allowInternal: !!body?.allowInternal, allowInsecure: !!body?.allowInsecure });
      if (!validation.ok) return send(400, { error: validation.reason, code: 'invalid_url' });
      return send(200, { ok: true, message: 'URL appears valid', url: validation.url });
    }
  }

  // GET /api/notifications/telegram — config (token masked, never returned)
  if (p === '/api/notifications/telegram' && method === 'GET') {
    return send(200, { telegram: getTelegramConfig() });
  }

  // PUT /api/notifications/telegram — save config; an omitted/empty token preserves the saved secret
  if (p === '/api/notifications/telegram' && method === 'PUT') {
    const body = await jsonBody();
    try {
      const next = putTelegramConfig({
        botToken: body?.botToken,
        chatId: body?.chatId,
        enabled: body?.enabled,
      });
      return send(200, { ok: true, telegram: next });
    } catch (err) {
      return send(err.status || 400, { error: err.message, code: err.code || 'invalid_telegram' });
    }
  }

  // POST /api/notifications/telegram/test — uses the SAVED config, sends a fixed test
  // message. Creates no incident and no persistent notification.
  if (p === '/api/notifications/telegram/test' && method === 'POST') {
    const result = await sendTestMessage();
    // The result reason is provider-sanitized (fixed words + codes, never the token,
    // never Telegram's verbatim description) and safe to return.
    return send(result.ok ? 200 : 400, { ok: result.ok, result });
  }

  // GET /api/notifications/:id
  const idMatch = p.match(/^\/api\/notifications\/([^/]+)$/);
  if (idMatch && method === 'GET') {
    const id = decodeURIComponent(idMatch[1]);
    const n = getNotification(id);
    if (!n) return send(404, { error: 'no such notification', code: 'not_found' });
    return send(200, { notification: n });
  }

  return null;
}
