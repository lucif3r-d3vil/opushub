// Phase 10B — Telegram notification provider (OUTBOUND ONLY).
//
// This provider sends OpusHub notifications to a configured Telegram chat via the official
// Telegram Bot API. It is strictly one-directional:
//
//   notification policy → notification dispatcher → Telegram provider → Telegram Bot API → chat
//
// It is NOT a bot that receives commands. There is no webhook receiver, no polling for
// updates, no message handling, and no code path by which a Telegram user could trigger an
// OpusHub operation. The provider implements the generic NotificationProvider abstraction
// (server/notifications/providers/registry.js) and shares the policy model in
// server/notifications/policy.js — it has no private filtering system.
//
// Security posture, stated where it is enforced:
//   · fixed endpoint only: https://api.telegram.org/bot<token>/sendMessage. There is no
//     configurable URL field anywhere, so this module cannot become a generic HTTP proxy.
//   · the only Bot API method ever called is sendMessage (see ALLOWED_METHODS).
//   · the bot token is a secret: it lives in DATA_DIR (never in the seven presentation
//     files, never in exports/history), the file is written with 0600 permissions, GET APIs
//     return a masked form only, and the token is redacted from every error, log and
//     delivery record before it is stored.
//   · HTTPS only, bounded timeout, bounded response, bounded message, no redirects followed,
//     rate-limited sends, plain-text messages (no parse_mode, so no formatting injection).
//   · every failure is recorded in the bounded delivery log and reported via getStatus();
//     send() never throws, so a broken Telegram configuration cannot break the event bus,
//     the notification center, other providers, monitoring or the scheduler.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../configStore.js';

const DIR = path.join(DATA_DIR, 'notifications');
const FILE = path.join(DIR, 'telegram.json');

// The fixed official endpoint. The token travels in the path (Telegram's own design);
// nothing user-controlled may alter the host, scheme or method list.
export const TELEGRAM_API_HOST = 'api.telegram.org';
export const TELEGRAM_API_BASE = `https://${TELEGRAM_API_HOST}`;
const ALLOWED_METHODS = new Set(['sendMessage']);

// Bounds — every one of them is a promise to the rest of the system.
export const TIMEOUT_MS = 8000;
export const MAX_MESSAGE = 4000; // Telegram caps text at 4096; we stay underneath.
export const MAX_RESPONSE = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20; // sends per window, per bot
const MAX_LOG = 50;

// Bot tokens look like 123456:ABC-DEF... (digits, a colon, then the secret part).
// The grammar is deliberately a little wider than observed tokens so a future token
// rotation cannot brick a saved configuration, but it is still unmistakably a token.
const TOKEN_RE = /^[0-9]{5,20}:[A-Za-z0-9_-]{20,100}$/;
const CHAT_ID_RE = /^-?[0-9]{1,20}$/;
const CHAT_USERNAME_RE = /^@[A-Za-z0-9_]{5,32}$/;

let fetchImpl = null;
/** Tests inject a fetch; production uses the global one. */
export function __setFetch(fn) { fetchImpl = fn || null; }
function doFetch(url, init) {
  const f = fetchImpl || globalThis.fetch;
  return f(url, init);
}

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
}

function readRaw() {
  try {
    if (!fs.existsSync(FILE)) return { botToken: null, chatId: null, enabled: false };
    const text = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(text);
    return {
      botToken: typeof obj.botToken === 'string' && obj.botToken ? obj.botToken : null,
      chatId: typeof obj.chatId === 'string' && obj.chatId ? obj.chatId : null,
      enabled: !!obj.enabled,
    };
  } catch {
    return { botToken: null, chatId: null, enabled: false };
  }
}

function atomicWrite(obj) {
  ensureDir();
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, FILE);
  // The rename carries the temp file's mode on POSIX; enforce it anyway (best effort,
  // and a no-op where modes do not apply) because this file holds a secret.
  try { fs.chmodSync(FILE, 0o600); } catch {}
}

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

export function validateBotToken(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return { ok: false, reason: 'A bot token is required.' };
  if (t.length > 140) return { ok: false, reason: 'That token is too long to be a Telegram bot token.' };
  if (/\s/.test(t)) return { ok: false, reason: 'That token contains whitespace — paste the token BotFather gave you.' };
  if (!TOKEN_RE.test(t)) {
    return { ok: false, reason: 'That does not look like a Telegram bot token (digits, a colon, then the secret part).' };
  }
  return { ok: true, token: t };
}

export function validateChatId(raw) {
  const c = String(raw ?? '').trim();
  if (!c) return { ok: false, reason: 'A chat ID is required.' };
  if (c.length > 64) return { ok: false, reason: 'That chat ID is too long.' };
  if (/\s/.test(c)) return { ok: false, reason: 'That chat ID contains whitespace.' };
  if (CHAT_ID_RE.test(c) || CHAT_USERNAME_RE.test(c)) return { ok: true, chatId: c };
  return { ok: false, reason: 'A chat ID is a number (groups are negative) or an @username.' };
}

/** The masked form shown in UIs: eight dots and the last four characters. */
export function maskToken(token) {
  if (!token) return null;
  const t = String(token);
  return `••••••••${t.slice(-4)}`;
}

/**
 * The public configuration shape. The full token is NEVER present here — callers get a
 * boolean and a masked suffix, which is enough to show "configured" without leaking the
 * secret into API responses, events, Activity, Search, logs, errors or exports.
 */
export function getTelegramConfig() {
  const cfg = readRaw();
  return {
    enabled: cfg.enabled,
    chatId: cfg.chatId,
    configured: !!(cfg.botToken && cfg.chatId),
    hasToken: !!cfg.botToken,
    tokenMasked: maskToken(cfg.botToken),
  };
}

export function putTelegramConfig({ botToken, chatId, enabled } = {}) {
  const current = readRaw();
  const next = { ...current };

  // The secret-preservation rule: an omitted or empty token means "leave the saved token
  // alone" (the settings form submits without it when the operator did not touch the
  // field). Only an explicit null clears it.
  if (botToken !== undefined) {
    if (botToken === null) {
      next.botToken = null;
    } else if (typeof botToken === 'string' && botToken.trim() === '') {
      // unchanged — keep what is stored
    } else {
      const v = validateBotToken(botToken);
      if (!v.ok) throw Object.assign(new Error(v.reason), { status: 400, code: 'invalid_bot_token' });
      next.botToken = v.token;
    }
  }
  if (chatId !== undefined) {
    if (chatId === null || (typeof chatId === 'string' && chatId.trim() === '')) {
      next.chatId = null;
    } else {
      const v = validateChatId(chatId);
      if (!v.ok) throw Object.assign(new Error(v.reason), { status: 400, code: 'invalid_chat_id' });
      next.chatId = v.chatId;
    }
  }
  if (enabled !== undefined) next.enabled = !!enabled;

  atomicWrite(next);
  return getTelegramConfig();
}

/* ------------------------------------------------------------------ */
/* rate limiting + delivery log (both bounded)                          */
/* ------------------------------------------------------------------ */

let rateBucket = { count: 0, resetAt: 0 };

function checkRateLimit() {
  const now = Date.now();
  if (now >= rateBucket.resetAt) rateBucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (rateBucket.count >= RATE_LIMIT_MAX) {
    return { ok: false, reason: `Telegram sends are rate limited (${RATE_LIMIT_MAX} per minute).` };
  }
  rateBucket.count++;
  return { ok: true };
}

const deliveryLog = [];

function logDelivery(entry) {
  deliveryLog.push({ ...entry, t: Date.now() });
  if (deliveryLog.length > MAX_LOG) deliveryLog.shift();
}

export function __resetForTests() {
  rateBucket = { count: 0, resetAt: 0 };
  deliveryLog.length = 0;
  fetchImpl = null;
}

/* ------------------------------------------------------------------ */
/* message format — compact plain text, bounded, scrubbed               */
/* ------------------------------------------------------------------ */

function clean(s, max) {
  if (s == null) return '';
  let str = String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (str.length > max) str = str.slice(0, max);
  return str;
}
// A notification message is operator-visible text, but an event message could still carry
// something sensitive (a check that echoed a URL with credentials, for example). Redact the
// obvious key=value shapes before the text leaves the building.
const SECRET_PAIR_RE = /(password|passwd|pwd|secret|token|api[_-]?key|bearer|session|cookie)([\s"'`]*[:=][\s"'`]*)\S+/gi;

export function scrubSecrets(s) {
  return String(s || '').replace(SECRET_PAIR_RE, '$1$2••••');
}

function severityWord(sev) {
  const s = String(sev || 'info').toLowerCase();
  if (s === 'critical') return 'CRITICAL';
  if (s === 'warning') return 'WARNING';
  if (s === 'notice') return 'NOTICE';
  return 'INFO';
}

const SEVERITY_GLYPH = { critical: '🔴', warning: '⚠️', notice: 'ℹ️', info: 'ℹ️' };

function formatTime(t) {
  try {
    const d = new Date(Number(t));
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch {
    return '';
  }
}

/**
 * Build the outbound text. Only the safe, display-level fields are used — never the raw
 * event payload, never environment, never credentials. Internal hrefs are included as a
 * path reference (Telegram cannot open them; they tell the operator where to look).
 */
export function buildTelegramMessage(event, notification) {
  const sev = event?.severity || notification?.severity || 'info';
  const title = clean(notification?.title || event?.message || event?.type || 'OpusHub notification', 200);
  const message = clean(notification?.message || event?.message || '', 1200);
  const source = clean(event?.source || notification?.source || '', 40);
  const type = clean(event?.type || notification?.type || '', 80);
  const href = notification?.href && typeof notification.href === 'string' && notification.href.startsWith('/') && !notification.href.startsWith('//')
    ? notification.href.slice(0, 200)
    : null;
  const when = formatTime(event?.t ?? notification?.t);

  const lines = [];
  lines.push(`${SEVERITY_GLYPH[String(sev).toLowerCase()] || 'ℹ️'} ${severityWord(sev)} — ${title || 'OpusHub notification'}`);
  if (message && message !== title) lines.push(message);
  const meta = [];
  if (source) meta.push(`source: ${source}`);
  if (type) meta.push(`type: ${type}`);
  if (meta.length) lines.push(meta.join(' · '));
  if (when) lines.push(`time: ${when}`);
  if (href) lines.push(`open: ${href}`);

  let text = scrubSecrets(lines.join('\n'));
  if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE);
  return text;
}

/* ------------------------------------------------------------------ */
/* transport — fixed host, POST only, no redirects, bounded             */
/* ------------------------------------------------------------------ */

/** Defensively redact the token from any string about to be recorded or logged. */
function redactToken(s, token) {
  const str = String(s ?? '');
  if (!token) return str;
  const t = String(token);
  if (!t || str.indexOf(t) === -1) return str;
  return str.split(t).join('••••');
}

async function readBounded(res) {
  // Prefer a streaming read with a hard cap; fall back to text() for stubbed responses.
  try {
    if (res?.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          size += value.byteLength ?? value.length ?? 0;
          if (size > MAX_RESPONSE + 1) {
            try { await reader.cancel(); } catch {}
            return { ok: false, reason: 'response too large' };
          }
          chunks.push(value);
        }
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(c)));
      return { ok: true, text: buf.toString('utf8') };
    }
  } catch {
    return { ok: false, reason: 'response unreadable' };
  }
  try {
    const text = await res.text();
    if (text.length > MAX_RESPONSE) return { ok: false, reason: 'response too large' };
    return { ok: true, text };
  } catch {
    return { ok: false, reason: 'response unreadable' };
  }
}

function telegramUrl(token, method) {
  // The URL is assembled from constants and the validated token only. There is no
  // user-controlled host, path, query or method — this cannot be steered elsewhere.
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

async function callApi(token, method, params, { eventId = null } = {}) {
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, code: 'unsupported_method', reason: 'Unsupported Telegram method.' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS);
  try {
    const res = await doFetch(telegramUrl(token, method), {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'accept': 'application/json',
        'user-agent': 'OpusHub/1.0 (outbound notifications)',
      },
      body: JSON.stringify(params),
      signal: ctrl.signal,
      redirect: 'manual', // never follow — a 3xx is a failure, not a new destination
    });

    if (res.status >= 300 && res.status < 400) {
      return { ok: false, code: 'redirect_refused', reason: 'Telegram answered with a redirect, which is never followed.' };
    }

    const body = await readBounded(res);
    if (!body.ok) return { ok: false, code: 'bad_response', reason: `Telegram answered with an unreadable response (${body.reason}).` };

    let json = null;
    try {
      json = JSON.parse(body.text);
    } catch {
      return { ok: false, code: 'bad_response', reason: `Telegram answered with HTTP ${res.status}, which is not JSON.` };
    }

    if (res.ok && json && json.ok === true) {
      return { ok: true, status: res.status, messageId: json?.result?.message_id ?? null };
    }

    // Map Telegram's failure to our own fixed words. Telegram's `description` may echo
    // request-adjacent detail, so it is never stored or logged verbatim — only the code.
    const code = Number(json?.error_code ?? res.status);
    if (code === 401) {
      return { ok: false, code: 'invalid_token', httpStatus: res.status, reason: 'Telegram rejected the bot token (invalid or revoked).' };
    }
    if (code === 429) {
      const retry = Number(json?.parameters?.retry_after);
      return {
        ok: false, code: 'rate_limited', httpStatus: res.status,
        reason: Number.isFinite(retry) && retry > 0
          ? `Telegram rate limited the send (retry after ${Math.min(retry, 300)}s).`
          : 'Telegram rate limited the send.',
        retryAfterSec: Number.isFinite(retry) ? Math.min(retry, 300) : null,
      };
    }
    if (code === 400) {
      return { ok: false, code: 'invalid_chat', httpStatus: res.status, reason: 'Telegram rejected the chat (unknown chat ID, or the bot is not a member).' };
    }
    if (code === 403) {
      return { ok: false, code: 'forbidden', httpStatus: res.status, reason: 'Telegram refused the send (the bot was blocked or removed from the chat).' };
    }
    return { ok: false, code: 'api_error', httpStatus: res.status, reason: `Telegram answered with an error (HTTP ${Number.isFinite(code) ? code : res.status}).` };
  } catch (err) {
    const name = err?.name || '';
    const msg = String(err?.message || err || '');
    if (name === 'AbortError' || /timeout|aborted/i.test(msg)) {
      return { ok: false, code: 'timeout', reason: `Telegram did not answer within ${Math.round(TIMEOUT_MS / 1000)}s.` };
    }
    // Network failures carry socket detail, never the token (it only appears in the URL we
    // built, and fetch errors do not echo it) — still, redact defensively at the boundary.
    return { ok: false, code: 'unreachable', reason: 'Telegram could not be reached (network or DNS failure).' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one notification. Never throws: every outcome — including programmer errors in the
 * transport — comes back as a result object and is recorded in the delivery log.
 */
export async function sendTelegram(event, notification, { text = null } = {}) {
  const cfg = readRaw();
  if (!cfg.enabled) return { ok: false, code: 'disabled', reason: 'Telegram notifications are disabled.' };
  if (!cfg.botToken || !cfg.chatId) {
    return { ok: false, code: 'not_configured', reason: 'Telegram is not configured (token and chat ID are both required).' };
  }

  const rate = checkRateLimit();
  if (!rate.ok) {
    const r = { ok: false, code: 'rate_limited', reason: rate.reason };
    logDelivery({ ok: false, code: r.code, reason: r.reason, eventId: event?.id || null });
    return r;
  }

  let message;
  try {
    message = typeof text === 'string' && text ? scrubSecrets(clean(text, MAX_MESSAGE)) : buildTelegramMessage(event, notification);
  } catch {
    return { ok: false, code: 'message_error', reason: 'The notification could not be formatted for Telegram.' };
  }
  if (!message) return { ok: false, code: 'message_error', reason: 'There is nothing to send.' };

  let result;
  try {
    result = await callApi(cfg.botToken, 'sendMessage', {
      chat_id: cfg.chatId,
      text: message,
      disable_web_page_preview: true,
      // No parse_mode: plain text cannot be formatting-injected by event content.
    }, { eventId: event?.id || null });
  } catch (err) {
    result = { ok: false, code: 'transport_error', reason: 'The Telegram send failed unexpectedly.' };
  }

  // The boundary guarantee: nothing recorded here may contain the token.
  const safeReason = redactToken(result.reason, cfg.botToken);
  const safe = { ...result, reason: safeReason };
  logDelivery({ ok: safe.ok, code: safe.code || null, reason: safeReason, eventId: event?.id || null, messageId: safe.messageId ?? null });
  return safe;
}

/** The deterministic configuration test: uses the SAVED config, sends a fixed message. */
export function testMessageText() {
  return 'OpusHub test — if you can read this, Telegram notifications are configured correctly. (No incident, no action needed.)';
}

export async function sendTestMessage() {
  const cfg = readRaw();
  if (!cfg.botToken || !cfg.chatId) {
    return { ok: false, code: 'not_configured', reason: 'Telegram is not configured (token and chat ID are both required).' };
  }
  // A test sends even when the provider is disabled: it verifies the configuration, not the switch.
  const savedEnabled = cfg.enabled;
  if (!savedEnabled) {
    // Temporarily act as enabled for this one send without persisting anything.
    const rate = checkRateLimit();
    if (!rate.ok) {
      const r = { ok: false, code: 'rate_limited', reason: rate.reason };
      logDelivery({ ok: false, code: r.code, reason: r.reason, eventId: null, test: true });
      return r;
    }
    let result;
    try {
      result = await callApi(cfg.botToken, 'sendMessage', {
        chat_id: cfg.chatId,
        text: testMessageText(),
        disable_web_page_preview: true,
      }, { eventId: null });
    } catch {
      result = { ok: false, code: 'transport_error', reason: 'The Telegram test failed unexpectedly.' };
    }
    const safe = { ...result, reason: redactToken(result.reason, cfg.botToken) };
    logDelivery({ ok: safe.ok, code: safe.code || null, reason: safe.reason, eventId: null, test: true });
    return safe;
  }
  const result = await sendTelegram(
    { id: null, severity: 'info', source: 'system', type: 'system.boot', t: Date.now(), message: testMessageText() },
    null,
    { text: testMessageText() },
  );
  const entry = deliveryLog[deliveryLog.length - 1];
  if (entry) entry.test = true;
  return result;
}

/* ------------------------------------------------------------------ */
/* provider interface (registry)                                       */
/* ------------------------------------------------------------------ */

export const telegramProvider = {
  id: 'telegram',
  name: 'Telegram',
  capabilities: ['outbound-only', 'sendMessage', 'rate-limited', 'secret-masked'],
  enabled: false,
  isEnabled() {
    const cfg = readRaw();
    return cfg.enabled && !!cfg.botToken && !!cfg.chatId;
  },
  getStatus() {
    const cfg = readRaw();
    if (!cfg.botToken || !cfg.chatId) return { state: 'unconfigured', configured: false, hasToken: !!cfg.botToken, chatId: cfg.chatId };
    if (!cfg.enabled) {
      return {
        state: 'disabled', configured: true, hasToken: true, chatId: cfg.chatId,
        tokenMasked: maskToken(cfg.botToken),
        lastDelivery: deliveryLog[deliveryLog.length - 1] || null,
      };
    }
    const last = deliveryLog[deliveryLog.length - 1];
    return {
      state: last ? (last.ok ? 'healthy' : 'degraded') : 'unknown',
      configured: true,
      hasToken: true,
      chatId: cfg.chatId,
      tokenMasked: maskToken(cfg.botToken),
      lastDelivery: last || null,
      recent: deliveryLog.slice(-10),
    };
  },
  async send(event, notification) {
    try {
      return await sendTelegram(event, notification);
    } catch (err) {
      // Absolute last resort: the provider contract is "never throws".
      const safe = { ok: false, code: 'transport_error', reason: 'The Telegram send failed unexpectedly.' };
      try { logDelivery({ ok: false, code: safe.code, reason: safe.reason, eventId: event?.id || null }); } catch {}
      return safe;
    }
  },
};

export function deliveryHistory() {
  return deliveryLog.slice();
}

export const TELEGRAM_FILE = FILE;
export const TELEGRAM_DIR = DIR;
export const RATE_LIMIT = { windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX };
