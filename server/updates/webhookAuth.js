// Phase 10C — Webhook shared secret, rate-limiting & authentication
// Secures inbound webhooks for:
// - /api/autoheal/webhook
// - /api/container-updates/webhook
//
// Key architectural rules:
// - Never allows unauthenticated public manipulation of OpusHub state
// - Supports Authorization: Bearer <secret>
// - Uses constant-time comparison (crypto.timingSafeEqual)
// - Never leaks secrets to logs, events, SSE, or API responses
// - Sliding-window rate limit (<= 30 requests/minute/IP)
// - Rejects oversized bodies (> 64 KB)

import crypto from 'node:crypto';

const MAX_WEBHOOK_SIZE = 64 * 1024; // 64 KB
const RATE_WINDOW_MS = 60_000;      // 1 minute
const MAX_PER_WINDOW = 30;          // 30 requests / min / IP

/** ip -> timestamps[] */
const ipHits = new Map();
const MAX_TRACKED_IPS = 1000;

function sweepRate(now = Date.now()) {
  for (const [ip, tsList] of ipHits) {
    const kept = tsList.filter((t) => now - t < RATE_WINDOW_MS);
    if (kept.length) ipHits.set(ip, kept);
    else ipHits.delete(ip);
  }
  while (ipHits.size > MAX_TRACKED_IPS) {
    ipHits.delete(ipHits.keys().next().value);
  }
}

/** Check rate limit for IP */
export function checkWebhookRateLimit(clientIp, now = Date.now()) {
  sweepRate(now);
  const ip = String(clientIp || '127.0.0.1').trim().toLowerCase();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    return { ok: false, retryAfterSec: Math.ceil((RATE_WINDOW_MS - (now - hits[0])) / 1000) };
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return { ok: true };
}

export function resetWebhookRateLimits() {
  ipHits.clear();
}

/**
 * Resolve configured webhook secret.
 * Priority:
 * 1. OPUSHUB_WEBHOOK_SECRET environment variable
 * 2. Cached persistent webhook secret
 */
let cachedSecret = null;

export function getWebhookSecret() {
  const envSecret = (process.env.OPUSHUB_WEBHOOK_SECRET || '').trim();
  if (envSecret) return envSecret;
  if (cachedSecret) return cachedSecret;
  return null;
}

export function setWebhookSecretForTest(sec) {
  cachedSecret = sec;
}

/**
 * Verify webhook authorization header.
 *
 * Accepted format:
 *   Authorization: Bearer <token>
 *
 * Uses crypto.timingSafeEqual to prevent timing side-channel attacks.
 */
export function verifyWebhookAuth(req) {
  const expectedSecret = getWebhookSecret();

  // If NO secret is configured on the host, reject inbound webhooks to prevent arbitrary spoofing!
  if (!expectedSecret) {
    return {
      ok: false,
      status: 401,
      code: 'webhook_secret_not_configured',
      reason: 'OPUSHUB_WEBHOOK_SECRET is not configured on the server.',
    };
  }

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      reason: 'Authorization header must be Bearer <token>',
    };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      reason: 'Bearer token is missing',
    };
  }

  // Constant-time comparison
  const expBuf = Buffer.from(expectedSecret, 'utf8');
  const tokBuf = Buffer.from(token, 'utf8');

  if (expBuf.length !== tokBuf.length) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      reason: 'Invalid webhook authentication token',
    };
  }

  try {
    const match = crypto.timingSafeEqual(expBuf, tokBuf);
    if (!match) {
      return {
        ok: false,
        status: 403,
        code: 'forbidden',
        reason: 'Invalid webhook authentication token',
      };
    }
  } catch {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      reason: 'Invalid webhook authentication token',
    };
  }

  return { ok: true };
}

export const MAX_BODY_SIZE = MAX_WEBHOOK_SIZE;
