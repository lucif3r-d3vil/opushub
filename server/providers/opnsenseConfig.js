// OPNsense configuration — the NON-SECRET half only.
//
// The address may be configured (Settings → Connections, or the environment). The API key and
// secret may not: they are read from the environment and nowhere else, so there is no code path
// that can write a credential into a YAML file, a configuration snapshot, an export, a history
// version or an activity event — and therefore no code path that can leak one.
//
// That is a deliberate choice, not a limitation: the configuration architecture OpusHub already
// has (Phase 6) is built for presentation files that are exported and restored. Secrets do not
// belong in it, so this provider does not put them there.
import { getSettings } from '../model.js';

/** Hard bound on one OPNsense request. */
export const TIMEOUT_MS = 5000;

/** Environment names, exported so the Settings pane can name them without printing values. */
export const CREDENTIAL_ENV = Object.freeze({ key: 'OPUSHUB_OPNSENSE_KEY', secret: 'OPUSHUB_OPNSENSE_SECRET' });
export const URL_ENV = 'OPUSHUB_OPNSENSE_URL';
export const PLAIN_HTTP_ENV = 'OPUSHUB_OPNSENSE_ALLOW_PLAIN_HTTP';

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

/** The configured address. Settings win over the environment; either may be absent. */
export function opnsenseConfig() {
  let url = null;
  try {
    const configured = getSettings()?.infrastructure?.opnsense?.url;
    if (typeof configured === 'string' && configured.trim()) url = configured.trim();
  } catch { /* configuration is optional — an unreadable settings file must not break a provider */ }
  if (!url) {
    const fromEnv = (process.env[URL_ENV] || '').trim();
    if (fromEnv) url = fromEnv;
  }
  return {
    url,
    // Plain http is refused unless the operator explicitly allows it for a LAN-only address.
    allowPlainHttp: truthy(process.env[PLAIN_HTTP_ENV]),
  };
}

/**
 * The API credentials, straight from the environment. Returns null when either half is missing —
 * never a partial pair, and never the values through any other function in this codebase.
 */
export function opnsenseCredentials() {
  const key = (process.env[CREDENTIAL_ENV.key] || '').trim();
  const secret = (process.env[CREDENTIAL_ENV.secret] || '').trim();
  return key && secret ? { key, secret } : null;
}
