// OPNsenseProvider — optional, read-only, and entirely absent until an operator configures it.
//
// OPNsense is the planned upstream firewall/router for OpusGrid, so OpusHub prepares for it
// without requiring it: with nothing configured the provider answers `not-configured` and every
// surface that would show its data says so. Startup never depends on it, and no other provider
// changes behaviour because it is missing.
//
// The security rules this file exists to hold (all tested in server/phase9-opnsense.test.js):
//
//   1. ENDPOINTS ARE FROZEN      the four paths below are the whole surface. No request carries a
//                                path, an endpoint name, a URL or a method — the route exposes
//                                `GET /api/infrastructure/opnsense` and nothing else, so the
//                                browser cannot choose what OpusHub asks the firewall.
//   2. CREDENTIALS NEVER TRAVEL  the API key and secret are read from the environment, used to
//                                build one Authorization header, and never appear in a response,
//                                a log line, an activity event, an export or a search index.
//                                The browser is told only that they are present.
//   3. NO GENERIC PROXY          there is no `request(path)` helper. The fetch below takes a key
//                                of ENDPOINTS and rejects anything that is not one.
//   4. NO RAW ECHO               responses are projected through explicit field pickers: unknown
//                                keys are dropped rather than forwarded, so a future OPNsense
//                                version that starts returning something sensitive cannot leak it
//                                through this provider by accident.
//   5. BOUNDED AND CACHED        one request per capability, 5s timeout, redirects refused,
//                                response body capped, and the registry's TTL decides how often.
//
// Capabilities that are planned but not implemented are *declared* (see PLANNED) so the UI can
// write "planned" instead of leaving a silent hole.
import { TIMEOUT_MS } from './opnsenseConfig.js';

/**
 * The endpoint table. Frozen. Exhaustive. Adding one is a reviewable edit to this file, and it
 * still cannot be selected by a client — there is no field that carries a key.
 */
export const ENDPOINTS = Object.freeze({
  system: Object.freeze({ path: '/api/core/system/status', label: 'System status', capability: 'system' }),
  interfaces: Object.freeze({ path: '/api/interfaces/overview/interfaces', label: 'Interfaces', capability: 'interfaces' }),
  gateways: Object.freeze({ path: '/api/routes/gateway/status', label: 'Gateways', capability: 'gateways' }),
  dns: Object.freeze({ path: '/api/unbound/settings/get', label: 'DNS resolver', capability: 'dns' }),
});

/** Recognised but not implemented in Phase 9 — declared, so the UI can say so in words. */
export const PLANNED = Object.freeze(['dhcp', 'firewall']);

/** Order the UI lists them in. */
export const CAPABILITY_ORDER = Object.freeze(['system', 'interfaces', 'gateways', 'dns', ...PLANNED]);

const MAX_BODY = 128 * 1024;
const MAX_ROWS = 24;

const NETWORK_ERRORS = new Set(['timeout', 'unreachable', 'tls', 'dns', 'refused', 'reset']);

/* ------------------------------------------------------------------ */
/* projecting responses                                                */
/* ------------------------------------------------------------------ */

/** Only scalars survive a projection. Objects and arrays are dropped, not stringified. */
function scalar(value, max = 200) {
  if (typeof value === 'string') return value.slice(0, max);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return null;
}

/** First non-null scalar among candidate paths. Unknown shapes simply produce nulls. */
function pickFirst(source, keys) {
  for (const key of keys) {
    const value = scalar(source?.[key]);
    if (value != null) return value;
  }
  return null;
}

function rows(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.rows) ? value.rows : null;
  return Array.isArray(list) ? list.slice(0, MAX_ROWS) : null;
}

function projectSystem(json) {
  if (!json || typeof json !== 'object') return null;
  return {
    hostname: pickFirst(json, ['hostname', 'system_hostname']),
    version: pickFirst(json, ['product_version', 'version', 'firmware_version']),
    product: pickFirst(json, ['product_name', 'product']),
    platform: pickFirst(json, ['platform', 'product_arch']),
    uptime: pickFirst(json, ['uptime']),
    load: Array.isArray(json.load) ? json.load.slice(0, 3).map((x) => scalar(x)) : null,
    // Anything else the endpoint returns is intentionally not forwarded.
  };
}

function projectInterfaces(json) {
  const list = rows(json);
  if (!list) return null;
  return list.map((r) => ({
    name: pickFirst(r, ['description', 'descr', 'device', 'if', 'name']),
    device: pickFirst(r, ['device', 'if', 'interface', 'name']),
    status: pickFirst(r, ['status', 'state']),
    enabled: r?.enabled == null ? null : !!r.enabled,
    address: pickFirst(r, ['ipaddr', 'address', 'ip']),
  })).filter((r) => r.name || r.device);
}

function projectGateways(json) {
  const list = rows(json);
  if (!list) return null;
  return list.map((r) => ({
    name: pickFirst(r, ['name', 'gateway', 'descr']),
    address: pickFirst(r, ['address', 'gateway', 'monitor']),
    // OPNsense reports gateway status as a word ("online"/"offline") in newer versions and as a
    // boolean in older ones; both are reported as what they are, and neither is invented.
    status: typeof r?.status === 'boolean' ? (r.status ? 'online' : 'offline') : pickFirst(r, ['status', 'state']),
    loss: pickFirst(r, ['loss']),
    delay: pickFirst(r, ['delay', 'stddev']),
  })).filter((r) => r.name || r.address);
}

function projectDns(json) {
  if (!json || typeof json !== 'object') return null;
  const inner = json.unbound && typeof json.unbound === 'object' ? json.unbound : json;
  return {
    enabled: inner?.enabled == null ? null : !!inner.enabled,
    port: pickFirst(inner, ['port']),
    dnssecEnabled: inner?.dnssec_enabled == null ? (inner?.dnssec == null ? null : !!inner.dnssec) : !!inner.dnssec_enabled,
  };
}

const PROJECTORS = Object.freeze({
  system: projectSystem,
  interfaces: projectInterfaces,
  gateways: projectGateways,
  dns: projectDns,
});

/* ------------------------------------------------------------------ */
/* transport                                                           */
/* ------------------------------------------------------------------ */

function classifyError(err) {
  const msg = String(err?.message || err);
  const code = String(err?.cause?.code || err?.code || '');
  if (/timeout|abort/i.test(msg)) return { code: 'timeout', reason: 'OPNsense did not answer in time.' };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code: 'unreachable', reason: 'The OPNsense host name could not be resolved.' };
  if (code === 'ECONNREFUSED') return { code: 'unreachable', reason: 'Nothing is listening on the OPNsense address.' };
  if (code === 'ECONNRESET' || code === 'EPIPE') return { code: 'unreachable', reason: 'The connection to OPNsense was closed.' };
  if (/certificate|tls|ssl|CERT_/i.test(msg) || code.startsWith('CERT_')) return { code: 'tls', reason: 'The OPNsense certificate could not be verified.' };
  return { code: 'unreachable', reason: 'OPNsense could not be reached.' };
}

/**
 * One request against one frozen endpoint. Credentials are used *here only* and never returned:
 * even the error objects carry a public sentence, never the upstream body.
 */
async function fetchEndpoint(fetchImpl, { baseUrl, endpoint, key, secret }) {
  const spec = Object.prototype.hasOwnProperty.call(ENDPOINTS, endpoint) ? ENDPOINTS[endpoint] : null;
  if (!spec) return { status: 'error', error: { code: 'not_supported', reason: 'That capability does not exist.' }, data: null };
  let target;
  try {
    target = new URL(spec.path, baseUrl);
  } catch {
    return { status: 'error', error: { code: 'not_supported', reason: 'The configured OPNsense address is not usable.' }, data: null };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS);
  try {
    const res = await fetchImpl(target, {
      method: 'GET',
      redirect: 'manual', // a firewall that redirects us somewhere else is not answering this call
      signal: ctrl.signal,
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${key}:${secret}`, 'utf8').toString('base64')}`,
      },
    });
    if (res.status >= 300 && res.status < 400) {
      return { status: 'error', error: { code: 'unreachable', reason: 'OPNsense answered with a redirect, which OpusHub does not follow.' }, data: null };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 'error', error: { code: 'authentication_failed', reason: 'OPNsense rejected the API credentials.' }, data: null };
    }
    if (res.status === 404) {
      return { status: 'unavailable', error: { code: 'not_supported', reason: 'This OPNsense version does not offer that endpoint.' }, data: null };
    }
    if (res.status < 200 || res.status >= 300) {
      // The upstream body may contain paths and configuration: the status is fine, the text is not.
      return { status: 'error', error: { code: 'unreachable', reason: `OPNsense answered with HTTP ${res.status}.` }, data: null };
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(String(text).slice(0, MAX_BODY)); }
    catch { return { status: 'error', error: { code: 'parse_error', reason: 'OPNsense answered with something that is not JSON.' }, data: null }; }
    const data = PROJECTORS[endpoint] ? PROJECTORS[endpoint](json) : null;
    if (data == null) {
      return { status: 'unavailable', error: { code: 'parse_error', reason: 'OPNsense answered, but not in a shape OpusHub recognises.' }, data: null };
    }
    return { status: 'available', error: null, data };
  } catch (err) {
    if (process.env.OPUSHUB_DEBUG) console.warn(`[opnsense] ${endpoint} failed: ${String(err?.message).slice(0, 120)}`);
    const { code, reason } = classifyError(err);
    return { status: 'error', error: { code, reason }, data: null };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* the provider                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build the provider.
 *
 * @param config        () => ({ url, allowPlainHttp })   non-secret configuration (settings/env)
 * @param credentials   () => ({ key, secret }) | null    secrets, from the environment only
 * @param fetchImpl     injectable fetch (tests use a stub; production uses global fetch)
 */
export function createOpnsenseProvider({ config, credentials, fetchImpl = null } = {}) {
  const doFetch = fetchImpl || ((url, init) => fetch(url, init));

  async function resolve() {
    const cfg = (await config?.()) || {};
    const creds = (await credentials?.()) || null;
    const rawUrl = typeof cfg.url === 'string' ? cfg.url.trim() : '';
    if (!rawUrl) {
      return { configured: false, reason: 'No OPNsense address is configured.', url: null, creds: null, baseUrl: null };
    }
    let parsed;
    try { parsed = new URL(rawUrl); }
    catch { return { configured: false, reason: 'The configured OPNsense address is not a valid URL.', url: null, creds: null, baseUrl: null }; }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && cfg.allowPlainHttp)) {
      return { configured: false, reason: 'The OPNsense address must use https.', url: null, creds: null, baseUrl: null };
    }
    // The endpoint table owns the path, so a configured URL may not carry one of its own.
    if (parsed.pathname && parsed.pathname !== '/') {
      return { configured: false, reason: 'The OPNsense address must not include a path.', url: null, creds: null, baseUrl: null };
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return { configured: false, reason: 'The OPNsense address must not include credentials or a query string.', url: null, creds: null, baseUrl: null };
    }
    if (!creds?.key || !creds?.secret) {
      return {
        configured: false,
        reason: 'The OPNsense API credentials are not present in the environment.',
        url: parsed.origin, creds: null, baseUrl: null,
      };
    }
    return { configured: true, reason: null, url: parsed.origin, creds, baseUrl: parsed.origin };
  }

  async function check() {
    const resolved = await resolve();
    const publicBase = {
      configured: resolved.configured,
      url: resolved.url,                                    // origin only: no path, no credentials
      credentialSource: 'environment',
      credentialPresent: !!resolved.creds,
      capabilities: {},
    };
    if (!resolved.configured) {
      return {
        status: 'not-configured',
        capabilities: [],
        version: null,
        error: { code: 'not_configured', reason: resolved.reason },
        data: {
          ...publicBase,
          planned: [...PLANNED],
          capabilityList: CAPABILITY_ORDER.map((id) => ({
            id, label: ENDPOINTS[id]?.label || id, status: PLANNED.includes(id) ? 'planned' : 'unavailable',
            reason: null,
          })),
          at: Date.now(),
        },
      };
    }

    const keys = Object.keys(ENDPOINTS);
    const results = await Promise.all(keys.map(async (k) => [k, await fetchEndpoint(doFetch, {
      baseUrl: resolved.baseUrl, endpoint: k, key: resolved.creds.key, secret: resolved.creds.secret,
    })]));
    const byKey = Object.fromEntries(results);
    const capabilities = [];
    const capabilityList = [];
    for (const id of CAPABILITY_ORDER) {
      if (PLANNED.includes(id)) {
        capabilityList.push({ id, label: id === 'dhcp' ? 'DHCP leases' : 'Firewall state', status: 'planned', reason: 'Planned for a later phase.' });
        continue;
      }
      const r = byKey[id];
      if (!r) continue;
      if (r.status === 'available') capabilities.push(id);
      capabilityList.push({
        id,
        label: ENDPOINTS[id]?.label || id,
        status: r.status,
        reason: r.error?.reason || null,
      });
    }

    const system = byKey.system?.status === 'available';
    const status = system
      ? (capabilities.length < keys.length ? 'degraded' : 'connected')
      : 'unavailable';
    const version = system ? (byKey.system.data?.version || null) : null;

    return {
      status,
      capabilities,
      version,
      error: system
        ? (capabilities.length < keys.length
          ? { code: 'parse_error', reason: `${keys.length - capabilities.length} of ${keys.length} OPNsense capabilities did not answer.` }
          : null)
        : (byKey.system?.error || { code: 'unreachable', reason: 'OPNsense did not answer.' }),
      data: {
        ...publicBase,
        planned: [...PLANNED],
        capabilityList,
        system: byKey.system?.data || null,
        interfaces: byKey.interfaces?.data || null,
        gateways: byKey.gateways?.data || null,
        dns: byKey.dns?.data || null,
        at: Date.now(),
      },
    };
  }

  return { id: 'opnsense', check, methods: { resolve }, _internals: { ENDPOINTS, PLANNED, projectSystem, projectInterfaces, projectGateways, projectDns } };
}
