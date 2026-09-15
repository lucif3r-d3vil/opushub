// Notify — the delivery abstraction behind alerts. Channels register here with a stable
// id, a label, a status, and (when ready) a send() implementation. dispatch() fans a
// fired alert out to every ready channel, collects per-channel outcomes, and never
// throws: a failing channel is reported, not fatal.
//
// Today every channel is `coming-later` — the registry, the dispatch fan-out, and the
// Settings surface exist so that adding a real channel is one registerChannel() call
// plus its send() implementation. No credentials are stored anywhere yet, by design.
const channels = new Map();

export function registerChannel(id, { label, blurb = '', status = 'coming-later', send = null } = {}) {
  channels.set(String(id), { id: String(id), label, blurb, status, send: typeof send === 'function' ? send : null });
}

export function listChannels() {
  return [...channels.values()].map(({ id, label, blurb, status, send }) => ({
    id, label, blurb, status, configured: status === 'ready' && !!send,
  }));
}

/**
 * Deliver an alert to every ready channel. Returns the per-channel outcomes:
 * [{ channel, ok, detail }] — empty today, since no channel is ready yet.
 */
export function dispatch(alert) {
  const outcomes = [];
  for (const ch of channels.values()) {
    if (ch.status !== 'ready' || !ch.send) continue;
    try {
      const r = ch.send(alert);
      if (r && typeof r.then === 'function') {
        r.then(
          () => outcomes.push({ channel: ch.id, ok: true }),
          (err) => outcomes.push({ channel: ch.id, ok: false, detail: err?.message || 'delivery failed' }),
        );
      } else {
        outcomes.push({ channel: ch.id, ok: true });
      }
    } catch (err) {
      outcomes.push({ channel: ch.id, ok: false, detail: err?.message || 'delivery failed' });
    }
  }
  return outcomes;
}

// The four planned channels. Webhook is first in line; the others follow the same shape.
registerChannel('webhook', {
  label: 'Webhook',
  blurb: 'POST the alert as JSON to a URL you choose. The first channel planned.',
});
registerChannel('email', {
  label: 'Email',
  blurb: 'Send alerts through your own SMTP server.',
});
registerChannel('telegram', {
  label: 'Telegram',
  blurb: 'Message a chat via a bot token you create.',
});
registerChannel('slack', {
  label: 'Slack',
  blurb: 'Post to a channel via an incoming webhook.',
});
