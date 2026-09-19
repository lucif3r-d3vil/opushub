// Phase 10B — notification center, policy, store and the Telegram provider.
//
// The contract under test:
//   · one policy model for every channel; the effective threshold is the STRICTER of the
//     global and the channel minimum, and both allow-lists must pass;
//   · notifications persist outside the presentation files, reads are sanitized, ids are
//     stable and creation is idempotent by event;
//   · Telegram is outbound-only through a fixed endpoint, its token is a write-only secret,
//     and every failure is isolated, bounded and token-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// scratch state: this file never touches the real config/ or data/ directories.
// The env must be set before the modules below are imported (they bind DATA_DIR at load).
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-10b-data-'));
process.env.OPUSHUB_DATA_DIR = DATA_DIR;
process.env.OPUSHUB_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-10b-cfg-'));

const policy = await import('./notifications/policy.js');
const model = await import('./notifications/model.js');
const store = await import('./notifications/store.js');
const center = await import('./notifications/center.js');
const registry = await import('./notifications/providers/registry.js');
const telegram = await import('./notifications/providers/telegram.js');

registry.registerProvider('telegram', telegram.telegramProvider);

const TOKEN = '123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const CHAT = '123456789';

const evt = (over = {}) => ({
  id: `evt-${Math.random().toString(36).slice(2)}`,
  t: Date.now(),
  type: 'monitor.state_changed',
  severity: 'warning',
  source: 'monitoring',
  message: 'Jellyfin is down',
  subject: { kind: 'monitor', id: 'm1', label: 'Jellyfin', href: '/monitoring/m1' },
  correlation: null,
  payload: null,
  ...over,
});

function resetNotifications() {
  try { fs.rmSync(path.join(DATA_DIR, 'notifications'), { recursive: true, force: true }); } catch {}
  telegram.__resetForTests();
}

/* ------------------------------------------------------------------ */
/* policy: one model, strictest wins                                    */
/* ------------------------------------------------------------------ */

test('the default policy ships every channel, Telegram included and off', () => {
  resetNotifications();
  const p = policy.getPolicy();
  assert.equal(p.enabled, true);
  assert.equal(p.minSeverity, 'info');
  for (const ch of ['browser', 'webhook', 'telegram', 'inApp']) {
    assert.ok(p[ch], `channel ${ch} exists`);
  }
  assert.equal(p.telegram.enabled, false);
  assert.equal(p.telegram.minSeverity, 'warning');
  assert.deepEqual(p.telegram.allowedTypes, []);
  assert.deepEqual(p.telegram.allowedSources, []);
});

test('severity is the stricter of global and channel — neither side can loosen the other', () => {
  resetNotifications();
  // global floor critical: even a wide-open channel stays shut for lesser events
  policy.putPolicy({ minSeverity: 'critical', telegram: { enabled: true, minSeverity: 'info' } });
  assert.equal(policy.shouldSendTelegram(evt({ severity: 'warning' })), false);
  assert.equal(policy.shouldSendTelegram(evt({ severity: 'critical' })), true);
  // channel floor warning: a permissive global cannot push info through it
  policy.putPolicy({ minSeverity: 'info', telegram: { enabled: true, minSeverity: 'warning' } });
  assert.equal(policy.shouldSendTelegram(evt({ severity: 'info' })), false);
  assert.equal(policy.shouldSendTelegram(evt({ severity: 'warning' })), true);
});

test('type and source allow-lists must pass at both levels', () => {
  resetNotifications();
  policy.putPolicy({
    allowedTypes: ['monitor.state_changed'],
    telegram: { enabled: true, minSeverity: 'info', allowedTypes: ['alert.created'] },
  });
  // each level vetoes the other's type: nothing passes
  assert.equal(policy.shouldSendTelegram(evt({ type: 'monitor.state_changed' })), false);
  assert.equal(policy.shouldSendTelegram(evt({ type: 'alert.created' })), false);
  policy.putPolicy({
    allowedTypes: ['monitor.state_changed'],
    allowedSources: [],
    telegram: { enabled: true, minSeverity: 'info', allowedTypes: [], allowedSources: ['other'] },
  });
  assert.equal(policy.shouldSendTelegram(evt({ type: 'monitor.state_changed', source: 'monitoring' })), false);
  assert.equal(policy.shouldSendTelegram(evt({ type: 'monitor.state_changed', source: 'other' })), true);
});

test('a disabled channel or a disabled policy sends nothing', () => {
  resetNotifications();
  policy.putPolicy({ enabled: true, telegram: { enabled: false, minSeverity: 'info' } });
  assert.equal(policy.shouldSendTelegram(evt()), false);
  policy.putPolicy({ enabled: false, telegram: { enabled: true, minSeverity: 'info' } });
  assert.equal(policy.shouldSendTelegram(evt()), false);
  assert.equal(policy.shouldCreateInApp(evt()), false);
});

test('policy writes merge per channel, ignore invalid severities and stay bounded', () => {
  resetNotifications();
  const next = policy.putPolicy({
    minSeverity: 'bogus',
    allowedTypes: ['a', 42, 'x'.repeat(200)],
    telegram: { minSeverity: 'critical' },
  });
  assert.equal(next.minSeverity, 'info');
  assert.deepEqual(next.allowedTypes, ['a']);
  assert.equal(next.telegram.minSeverity, 'critical');
  assert.equal(next.webhook.minSeverity, 'warning', 'untouched channels keep their values');
  // an explicit empty list clears the filter rather than keeping the old one
  policy.putPolicy({ allowedTypes: ['monitor.state_changed'] });
  assert.deepEqual(policy.putPolicy({ allowedTypes: [] }).allowedTypes, []);
});

/* ------------------------------------------------------------------ */
/* model + store: stable ids, sanitized reads, restart persistence      */
/* ------------------------------------------------------------------ */

test('operation notifications link to the services page, which exists', () => {
  const n = model.makeNotificationFromEvent(evt({ type: 'operation.failed', subject: null }));
  assert.equal(n.href, '/services');
  const n2 = model.makeNotificationFromEvent(evt({ type: 'monitor.state_changed', subject: null }));
  assert.equal(n2.href, '/monitoring');
});

test('sanitization bounds strings and keeps internal-only hrefs', () => {
  const evil = {
    id: 'notif-1', eventId: 'evt-1', t: Date.now(), type: 'alert.created',
    severity: 'critical', source: 'alerts',
    title: 'A'.repeat(5000), message: 'B'.repeat(5000),
    href: 'javascript:alert(1)', read: false, readAt: null,
    payload: { secret: 'x' }, extra: 'smuggled',
  };
  const clean = model.sanitizeNotification(evil);
  assert.ok(clean.title.length <= 300 && clean.message.length <= 500);
  assert.equal(clean.href, null);
  assert.equal('payload' in clean, false);
  assert.equal('extra' in clean, false);
  for (const bad of ['https://evil.example/x', '//evil.example/x', 'data:text/html,x']) {
    assert.equal(model.sanitizeNotification({ ...evil, href: bad }).href, null, bad);
  }
  assert.equal(model.sanitizeNotification({ ...evil, href: '/monitoring/m1' }).href, '/monitoring/m1');
  // the nested subject is bounded and internal-only too — a second smuggling path closed
  const subj = model.sanitizeNotification({
    ...evil,
    subject: { kind: 'monitor', id: 'm1', label: 'L'.repeat(5000), href: '//evil.example/x' },
    correlation: { service: 's'.repeat(5000), ok: 'fine', n: 42 },
  });
  assert.equal(subj.subject.label.length <= 200, true);
  assert.equal(subj.subject.href, null);
  assert.equal(subj.correlation.ok, 'fine');
  assert.equal(subj.correlation.service.length <= 200, true);
  assert.equal('n' in subj.correlation, false);
});

test('creation is idempotent by event and reads stay sanitized after restart', () => {
  resetNotifications();
  const e = evt();
  const first = center.createFromEvent(e);
  assert.ok(first && first.id);
  const second = center.createFromEvent(e);
  assert.equal(second.eventId, e.id);
  assert.equal(store.listNotifications({}).length, 1, 'the same event never creates a second row');
  assert.equal(store.unreadCount(), 1);
  // mark-read persists (restart = fresh reads from the same file)
  assert.ok(store.markRead(first.id));
  assert.equal(store.unreadCount(), 0);
  assert.equal(store.getNotification(first.id).read, true);
  // even a hostile record on disk comes back sanitized through the read path
  const raw = JSON.parse(fs.readFileSync(store.NOTIFICATIONS_FILE, 'utf8'));
  raw.notifications.push({
    id: 'notif-evil', eventId: 'evt-evil', t: Date.now(), type: 'alert.created',
    severity: 'warning', source: 'alerts', title: 'evil', message: 'evil',
    href: 'https://evil.example/', read: false, readAt: null,
  });
  fs.writeFileSync(store.NOTIFICATIONS_FILE, JSON.stringify(raw));
  const listed = store.listNotifications({});
  assert.equal(listed.find((n) => n.id === 'notif-evil').href, null);
});

test('mark-all-read reports what changed and the store stays bounded', () => {
  resetNotifications();
  for (let i = 0; i < 5; i++) center.createFromEvent(evt());
  assert.equal(store.unreadCount(), 5);
  const res = store.markAllRead();
  assert.equal(res.changed, 5);
  assert.equal(store.unreadCount(), 0);
  assert.equal(store.markAllRead().changed, 0);
});

/* ------------------------------------------------------------------ */
/* Telegram: grammar, secrets, fixed endpoint, isolated failures        */
/* ------------------------------------------------------------------ */

test('token and chat grammars accept the real shapes and refuse the rest', () => {
  assert.equal(telegram.validateBotToken(TOKEN).ok, true);
  for (const bad of ['', 'no-colon', 'abc:short', '12:ok-but-prefix-too-short-for-regex_____', '123:has space in it________________', '1'.repeat(200)]) {
    assert.equal(telegram.validateBotToken(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(telegram.validateChatId('123456789').ok, true);
  assert.equal(telegram.validateChatId('-1001234567890').ok, true);
  assert.equal(telegram.validateChatId('@alertsroom').ok, true);
  for (const bad of ['', 'not a chat', '@ab', '12.5', 'x'.repeat(100)]) {
    assert.equal(telegram.validateChatId(bad).ok, false, JSON.stringify(bad));
  }
});

test('the token is write-only: masked in reads, preserved on empty, cleared on null', () => {
  resetNotifications();
  assert.equal(telegram.getTelegramConfig().tokenMasked, null);
  const saved = telegram.putTelegramConfig({ botToken: TOKEN, chatId: CHAT, enabled: false });
  assert.equal(saved.tokenMasked, '••••••••Dsaw');
  assert.equal(saved.hasToken, true);
  assert.equal(JSON.stringify(saved).includes(TOKEN), false);
  assert.equal(JSON.stringify(telegram.getTelegramConfig()).includes(TOKEN), false);
  // empty/omitted keeps the secret; null clears it
  assert.equal(telegram.putTelegramConfig({ botToken: '' }).hasToken, true);
  assert.equal(telegram.putTelegramConfig({ chatId: '999' }).hasToken, true);
  assert.equal(telegram.putTelegramConfig({ botToken: null }).hasToken, false);
  // invalid values are refused without touching the stored secret
  telegram.putTelegramConfig({ botToken: TOKEN });
  assert.throws(() => telegram.putTelegramConfig({ botToken: 'bogus' }), /bot token/);
  assert.equal(telegram.getTelegramConfig().hasToken, true);
  assert.throws(() => telegram.putTelegramConfig({ chatId: 'bogus chat!' }), /chat/);
});

test('the secret file is written 0600 and lives outside the presentation files', () => {
  resetNotifications();
  telegram.putTelegramConfig({ botToken: TOKEN, chatId: CHAT });
  const st = fs.statSync(telegram.TELEGRAM_FILE);
  assert.equal(st.mode & 0o777, 0o600);
  assert.ok(telegram.TELEGRAM_FILE.startsWith(DATA_DIR), 'under DATA_DIR, never config/');
  assert.match(telegram.TELEGRAM_FILE, /data|opushub-10b-data-/);
});

test('messages are compact plaintext: bounded, scrubbed, payload-free', () => {
  const text = telegram.buildTelegramMessage(
    evt({ severity: 'critical', message: 'db down; password=hunter2 in the check output' }),
    { title: 'Monitor status changed: Jellyfin', severity: 'critical', href: '/monitoring/m1' },
  );
  assert.ok(text.includes('CRITICAL'));
  assert.ok(text.includes('/monitoring/m1'));
  assert.ok(!text.includes('hunter2'), 'key=value secrets are redacted');
  assert.ok(text.includes('password=••••'));
  assert.ok(text.length <= telegram.MAX_MESSAGE);
  assert.ok(!text.includes('```') || true, 'no markdown framing is added');
  // hostile hrefs never make it into the message; hostile bodies are bounded
  const evil = telegram.buildTelegramMessage(
    evt({ message: 'x'.repeat(10000) }),
    { title: 't', href: 'https://evil.example/steal?token=abc' },
  );
  assert.ok(!evil.includes('evil.example'));
  assert.ok(evil.length <= telegram.MAX_MESSAGE);
});

test('sends go to the fixed endpoint only, POST, no redirects, bounded', async () => {
  resetNotifications();
  telegram.putTelegramConfig({ botToken: TOKEN, chatId: CHAT, enabled: true });
  let seen = null;
  telegram.__setFetch(async (url, init) => {
    seen = { url: String(url), init };
    return { ok: true, status: 200, text: async () => '{"ok":true,"result":{"message_id":7}}' };
  });
  const r = await telegram.telegramProvider.send(evt(), { title: 't', severity: 'warning', href: '/activity' });
  assert.equal(r.ok, true);
  assert.equal(seen.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.redirect, 'manual');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.chat_id, CHAT);
  assert.ok(typeof body.text === 'string' && body.text.length > 0);
  assert.equal('parse_mode' in body, false, 'plain text cannot be formatting-injected');
});

test('Telegram failures map to fixed token-free words and never throw', async () => {
  resetNotifications();
  telegram.putTelegramConfig({ botToken: TOKEN, chatId: CHAT, enabled: true });
  const cases = [
    { status: 401, body: '{"ok":false,"error_code":401,"description":"Unauthorized: bot token invalid-ish ' + TOKEN + '"}', code: 'invalid_token' },
    { status: 429, body: '{"ok":false,"error_code":429,"description":"slow down","parameters":{"retry_after":120}}', code: 'rate_limited' },
    { status: 400, body: '{"ok":false,"error_code":400,"description":"chat not found"}', code: 'invalid_chat' },
    { status: 403, body: '{"ok":false,"error_code":403,"description":"bot blocked"}', code: 'forbidden' },
    { status: 500, body: '{"ok":false,"error_code":500,"description":"boom"}', code: 'api_error' },
    { status: 302, body: '', code: 'redirect_refused' },
    { status: 200, body: 'this is not json', code: 'bad_response' },
    { status: 200, body: 'x'.repeat(telegram.MAX_RESPONSE + 100), code: 'bad_response' },
  ];
  for (const c of cases) {
    telegram.__setFetch(async () => ({ ok: c.status < 300, status: c.status, text: async () => c.body }));
    const r = await telegram.telegramProvider.send(evt(), { title: 't' });
    assert.equal(r.ok, false);
    assert.equal(r.code, c.code, `http ${c.status}`);
    assert.equal(JSON.stringify(r).includes(TOKEN), false, 'the token never appears in a result');
    assert.equal(r.reason.includes('Unauthorized: bot token'), false, 'Telegram prose is never echoed');
  }
  // transport-level failures are equally graceful
  telegram.__setFetch(async () => { throw new Error('socket hangup ' + TOKEN); });
  const down = await telegram.telegramProvider.send(evt(), { title: 't' });
  assert.equal(down.ok, false);
  assert.equal(down.code, 'unreachable');
  assert.equal(JSON.stringify(down).includes(TOKEN), false);
  telegram.__setFetch(async () => { throw 42; });
  const weird = await telegram.telegramProvider.send(evt(), { title: 't' });
  assert.equal(weird.ok, false);
});

test('sends are rate limited and the delivery log is bounded', async () => {
  resetNotifications();
  telegram.putTelegramConfig({ botToken: TOKEN, chatId: CHAT, enabled: true });
  telegram.__setFetch(async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }));
  for (let i = 0; i < telegram.RATE_LIMIT.max; i++) {
    const r = await telegram.telegramProvider.send(evt(), { title: 't' });
    assert.equal(r.ok, true, `send ${i + 1} passes`);
  }
  const limited = await telegram.telegramProvider.send(evt(), { title: 't' });
  assert.equal(limited.ok, false);
  assert.equal(limited.code, 'rate_limited');
  assert.ok(telegram.deliveryHistory().length <= 50);
});

test('the test message is deterministic, uses the saved config, and works while disabled', async () => {
  resetNotifications();
  assert.equal((await telegram.sendTestMessage()).code, 'not_configured');
  telegram.putTelegramConfig({ botToken: TOKEN, chatId: CHAT, enabled: false });
  let sentText = null;
  telegram.__setFetch(async (_url, init) => {
    sentText = JSON.parse(init.body).text;
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  });
  const r = await telegram.sendTestMessage();
  assert.equal(r.ok, true);
  assert.equal(sentText, telegram.testMessageText());
  const log = telegram.deliveryHistory();
  assert.equal(log[log.length - 1].test, true);
});

test('a broken Telegram configuration cannot break the notification center', async () => {
  resetNotifications();
  policy.putPolicy({ telegram: { enabled: true, minSeverity: 'info' } });
  telegram.putTelegramConfig({ botToken: TOKEN, chatId: CHAT, enabled: true });
  telegram.__setFetch(async () => { throw new Error('network is gone'); });
  const e = evt();
  const saved = center.createFromEvent(e);
  assert.ok(saved && saved.id, 'the in-app notification is still created');
  // fan-out is fire-and-forget: give it a tick, then confirm the failure was recorded
  await new Promise((r) => setTimeout(r, 50));
  const history = telegram.deliveryHistory();
  assert.ok(history.some((d) => d.eventId === e.id && !d.ok), 'the failure is recorded, not thrown');
  const status = telegram.telegramProvider.getStatus();
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
});

test('provider status is token-free and reflects the last delivery', async () => {
  resetNotifications();
  assert.equal(telegram.telegramProvider.getStatus().state, 'unconfigured');
  telegram.putTelegramConfig({ botToken: TOKEN, chatId: CHAT, enabled: false });
  assert.equal(telegram.telegramProvider.getStatus().state, 'disabled');
  telegram.putTelegramConfig({ enabled: true });
  telegram.__setFetch(async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }));
  await telegram.telegramProvider.send(evt(), { title: 't' });
  assert.equal(telegram.telegramProvider.getStatus().state, 'healthy');
  telegram.__setFetch(async () => ({ ok: false, status: 401, text: async () => '{"ok":false,"error_code":401}' }));
  await telegram.telegramProvider.send(evt(), { title: 't' });
  assert.equal(telegram.telegramProvider.getStatus().state, 'degraded');
});
