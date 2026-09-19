// Phase 10B — Webhook provider (generic, SSRF-safe, bounded)
// Reuses server/lib/ipPolicy.js for address classification, and implements DNS pinning similar to monitoring/net.js

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { DATA_DIR } from '../../configStore.js';
import { classifyIp, BLOCKED_FOR_MONITOR, INTERNAL_CLASSES, describeClass } from '../../lib/ipPolicy.js';

const DIR = path.join(DATA_DIR, 'notifications');
const FILE = path.join(DIR, 'webhook.json');

const TIMEOUT_MS = 5000;
const MAX_PAYLOAD = 64 * 1024;
const MAX_RESPONSE = 16 * 1024;
const MAX_REDIRECTS = 2;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10; // per webhook per minute

// BLOCKED_FOR_WEBHOOK = always blocked + internal by default
const BLOCKED_FOR_WEBHOOK = new Set([...BLOCKED_FOR_MONITOR, ...INTERNAL_CLASSES]);

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
}

function readRaw() {
  try {
    if (!fs.existsSync(FILE)) return { url: null, secret: null, enabled: false, allowInternal: false, allowInsecure: false };
    const text = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(text);
    return {
      url: typeof obj.url === 'string' ? obj.url : null,
      secret: typeof obj.secret === 'string' ? obj.secret : null,
      enabled: !!obj.enabled,
      allowInternal: !!obj.allowInternal,
      allowInsecure: !!obj.allowInsecure, // allow http for internal
    };
  } catch {
    return { url: null, secret: null, enabled: false, allowInternal: false, allowInsecure: false };
  }
}

function atomicWrite(obj) {
  ensureDir();
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
}

let lookupFn = dns.lookup;
export function __setLookup(fn) { lookupFn = fn || dns.lookup; }

function addressRefusal(ip, { allowInternal = false } = {}) {
  const cls = classifyIp(ip);
  if (BLOCKED_FOR_MONITOR.has(cls)) {
    return { code: 'blocked_address', klass: cls, reason: `${ip} is in ${describeClass(cls)} space, which webhooks never reach.` };
  }
  if (!allowInternal && INTERNAL_CLASSES.has(cls)) {
    return { code: 'internal_blocked', klass: cls, reason: `${ip} is on the local network, and this webhook is configured for public endpoints only.` };
  }
  return null;
}

export async function resolveWebhookHost(host, { allowInternal = false } = {}) {
  // reuse monitorResolveHost logic but with webhook blocking
  const name = String(host || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!name) return { ok: false, code: 'invalid_host', reason: 'No host to reach.' };

  // Use Node's isIP check via classify
  const cls = classifyIp(name);
  if (cls !== 'invalid') {
    const refusal = addressRefusal(name, { allowInternal });
    if (refusal) return { ok: false, ...refusal };
    return { ok: true, host: name, addresses: [{ address: name, klass: cls }], pinned: name };
  }

  let records;
  try {
    records = await lookupFn(name, { all: true, verbatim: true });
  } catch {
    return { ok: false, code: 'dns', reason: `Could not resolve ${name}.` };
  }
  const list = Array.isArray(records) ? records : (records ? [records] : []);
  if (!list.length) return { ok: false, code: 'dns', reason: `${name} resolved to no address.` };

  const addresses = [];
  for (const r of list.slice(0, 8)) {
    const address = String(r?.address || '');
    const refusal = addressRefusal(address, { allowInternal });
    if (refusal) {
      return { ok: false, code: refusal.code, reason: `${name} resolves to ${refusal.reason}` };
    }
    addresses.push({ address, family: Number(r?.family) || 4, klass: classifyIp(address) });
  }
  if (!addresses.length) return { ok: false, code: 'dns', reason: `${name} resolved to no usable address.` };
  return { ok: true, host: name, addresses, pinned: addresses[0].address };
}

async function validateRedirect(from, location, { allowInternal = false } = {}) {
  let next;
  try { next = new URL(String(location), String(from)); } catch { return { ok: false, code: 'redirect', reason: 'Redirect target is not a URL.' }; }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    return { ok: false, code: 'redirect_scheme', reason: `Redirect target uses ${next.protocol}//, which is never followed.` };
  }
  if (next.username || next.password) {
    return { ok: false, code: 'redirect_credentials', reason: 'Redirect target carries credentials.' };
  }
  if (String(from).startsWith('https:') && next.protocol === 'http:') {
    return { ok: false, code: 'redirect_downgrade', reason: 'Redirect downgrades https to http.' };
  }
  const resolved = await resolveWebhookHost(next.hostname, { allowInternal });
  if (!resolved.ok) return { ok: false, code: `redirect_${resolved.code}`, reason: `Redirect target refused: ${resolved.reason}` };
  next.hash = '';
  return { ok: true, url: next.toString(), pinned: resolved.pinned };
}

// Rate limiting
const rateBuckets = new Map(); // url -> { count, resetAt }

function checkRateLimit(url) {
  const now = Date.now();
  const key = url;
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    return { ok: false, reason: `rate limited: ${RATE_LIMIT_MAX} per minute` };
  }
  bucket.count++;
  return { ok: true };
}

// Delivery history (bounded, for status)
const deliveryLog = [];
const MAX_LOG = 50;

function logDelivery(entry) {
  deliveryLog.push({ ...entry, t: Date.now() });
  if (deliveryLog.length > MAX_LOG) deliveryLog.shift();
}

export function validateWebhookUrl(rawUrl, { allowInternal = false, allowInsecure = false } = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') return { ok: false, reason: 'URL required' };
  let u;
  try { u = new URL(rawUrl); } catch { return { ok: false, reason: 'Not a valid URL' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'Only http and https are allowed' };
  if (!allowInsecure && u.protocol === 'http:' && !allowInternal) {
    // require https by default for public
    return { ok: false, reason: 'HTTPS required (http only allowed for internal when explicitly enabled)' };
  }
  if (u.username || u.password) return { ok: false, reason: 'Credential-bearing URLs are not allowed' };
  if (!u.hostname) return { ok: false, reason: 'URL has no host' };
  // length bound
  if (rawUrl.length > 2048) return { ok: false, reason: 'URL too long' };
  return { ok: true, url: u.toString() };
}

export async function sendWebhook(event, notification) {
  const cfg = readRaw();
  if (!cfg.enabled || !cfg.url) return { ok: false, reason: 'webhook not configured' };

  const urlValidation = validateWebhookUrl(cfg.url, { allowInternal: cfg.allowInternal, allowInsecure: cfg.allowInsecure });
  if (!urlValidation.ok) return { ok: false, reason: urlValidation.reason };

  const rate = checkRateLimit(cfg.url);
  if (!rate.ok) {
    logDelivery({ ok: false, reason: rate.reason, url: cfg.url, eventId: event?.id });
    return { ok: false, reason: rate.reason };
  }

  // Resolve host and validate
  let currentUrl = cfg.url;
  let pinned = null;
  let redirectCount = 0;

  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt++) {
    let parsed;
    try { parsed = new URL(currentUrl); } catch { return { ok: false, reason: 'Invalid URL' }; }

    const resolved = await resolveWebhookHost(parsed.hostname, { allowInternal: cfg.allowInternal });
    if (!resolved.ok) {
      logDelivery({ ok: false, reason: resolved.reason, url: currentUrl, eventId: event?.id });
      return { ok: false, reason: resolved.reason };
    }
    pinned = resolved.pinned;

    // Build payload (sanitized, bounded)
    const payload = {
      event: {
        id: event.id,
        type: event.type,
        severity: event.severity,
        source: event.source,
        message: event.message,
        t: event.t,
        subject: event.subject,
        correlation: event.correlation,
      },
      notification: notification ? {
        id: notification.id,
        title: notification.title,
        message: notification.message,
        href: notification.href,
      } : null,
      timestamp: new Date().toISOString(),
    };
    let body;
    try {
      body = JSON.stringify(payload);
    } catch {
      return { ok: false, reason: 'Failed to serialize payload' };
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD) {
      return { ok: false, reason: 'Payload too large' };
    }

    // Send
    const result = await doRequest(currentUrl, body, pinned, cfg.secret);
    if (result.redirect) {
      const redirectValidation = await validateRedirect(currentUrl, result.redirect, { allowInternal: cfg.allowInternal });
      if (!redirectValidation.ok) {
        logDelivery({ ok: false, reason: redirectValidation.reason, url: currentUrl, eventId: event?.id });
        return { ok: false, reason: redirectValidation.reason };
      }
      currentUrl = redirectValidation.url;
      pinned = redirectValidation.pinned;
      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) {
        return { ok: false, reason: 'Too many redirects' };
      }
      continue;
    }
    logDelivery({ ok: result.ok, status: result.status, reason: result.reason, url: currentUrl, eventId: event?.id });
    return result;
  }
  return { ok: false, reason: 'Redirect loop' };
}

function doRequest(urlStr, body, pinnedAddress, secret) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ ok: false, reason: 'Invalid URL' }); }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body, 'utf8'),
      'user-agent': 'OpusHub-Webhook/1.0',
      'accept': 'application/json, text/plain, */*',
    };
    if (secret) {
      try {
        const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
        headers['x-opushub-signature'] = `sha256=${sig}`;
      } catch {
        // fallback: no header
      }
    }

    // Pin DNS: override lookup to return validated address
    const lookup = (hostname, options, cb) => {
      const callback = typeof options === 'function' ? options : cb;
      const opts = typeof options === 'function' ? {} : (options || {});
      if (opts.all) return process.nextTick(() => callback(null, [{ address: pinnedAddress, family: 4 }]));
      return process.nextTick(() => callback(null, pinnedAddress, 4));
    };

    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      lookup,
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE) {
          req.destroy();
          return resolve({ ok: false, reason: 'Response too large', status: res.statusCode });
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const status = res.statusCode;
        if (status >= 300 && status < 400 && res.headers.location) {
          return resolve({ ok: false, redirect: res.headers.location, status });
        }
        if (status >= 200 && status < 300) {
          return resolve({ ok: true, status });
        }
        return resolve({ ok: false, reason: `HTTP ${status}`, status });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'timeout' });
    });
    req.on('error', (err) => {
      resolve({ ok: false, reason: err.message || 'request failed' });
    });

    req.write(body);
    req.end();
  });
}

// Provider interface
export const webhookProvider = {
  id: 'webhook',
  name: 'Webhook',
  capabilities: ['http', 'ssrf-protected', 'hmac'],
  enabled: false,
  isEnabled() {
    const cfg = readRaw();
    return cfg.enabled && !!cfg.url;
  },
  getStatus() {
    const cfg = readRaw();
    if (!cfg.url) return { state: 'unconfigured', configured: false };
    if (!cfg.enabled) return { state: 'disabled', configured: true, url: maskUrl(cfg.url) };
    const last = deliveryLog[deliveryLog.length - 1];
    return {
      state: last ? (last.ok ? 'healthy' : 'degraded') : 'unknown',
      configured: true,
      url: maskUrl(cfg.url),
      allowInternal: cfg.allowInternal,
      lastDelivery: last || null,
      recent: deliveryLog.slice(-10),
    };
  },
  async send(event, notification) {
    return sendWebhook(event, notification);
  },
};

function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '***';
  }
}

export function getWebhookConfig({ includeSecret = false } = {}) {
  const cfg = readRaw();
  return {
    url: cfg.url ? maskUrl(cfg.url) : null,
    rawUrl: includeSecret ? cfg.url : undefined, // only for internal use, never expose secret
    hasSecret: !!cfg.secret,
    secretMasked: cfg.secret ? '••••••••' : null,
    enabled: cfg.enabled,
    allowInternal: cfg.allowInternal,
    allowInsecure: cfg.allowInsecure,
  };
}

export function putWebhookConfig({ url, secret, enabled, allowInternal, allowInsecure } = {}) {
  const current = readRaw();
  let next = { ...current };

  if (url !== undefined) {
    if (url === null || url === '') {
      next.url = null;
    } else {
      const validation = validateWebhookUrl(url, { allowInternal: allowInternal ?? current.allowInternal, allowInsecure: allowInsecure ?? current.allowInsecure });
      if (!validation.ok) throw Object.assign(new Error(validation.reason), { status: 400, code: 'invalid_webhook_url' });
      // additional async validation (DNS) will be done on test, not here to keep sync
      next.url = validation.url;
    }
  }
  if (secret !== undefined) {
    if (secret === null || secret === '') next.secret = null;
    else {
      if (typeof secret !== 'string' || secret.length > 1024) throw Object.assign(new Error('secret too long'), { status: 400 });
      next.secret = secret;
    }
  }
  if (enabled !== undefined) next.enabled = !!enabled;
  if (allowInternal !== undefined) next.allowInternal = !!allowInternal;
  if (allowInsecure !== undefined) next.allowInsecure = !!allowInsecure;

  atomicWrite(next);
  return getWebhookConfig();
}

export function testWebhookConfig() {
  // returns config without secret, for UI
  return getWebhookConfig();
}

export const WEBHOOK_FILE = FILE;
export const WEBHOOK_DIR = DIR;
