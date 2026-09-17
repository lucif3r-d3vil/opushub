// The OpusGrid provider registry — one place that knows which infrastructure providers exist,
// what each one can do, and how it is doing right now.
//
// Phase 9 turns OpusHub from "a Docker dashboard" into "a control plane that understands an
// entire host". That only works if every new data source obeys the same contract, so the contract
// is this file.
//
//   Provider          { id, type, name, domain, optional, capabilities, ttlMs, check() }
//     id              stable snake/kebab id: docker, filesystem, zfs, network, opnsense, ups, pdu
//     type            compute | storage | network | firewall | power | host
//     domain          which branch of the OpusGrid model it feeds (see model.js)
//     optional        true → being unconfigured is NORMAL and never makes OpusGrid unhealthy
//     capabilities    what it can answer when it is working (declared, frozen)
//     ttlMs           how long one answer may be reused — expensive providers answer less often
//     check()         does the work; returns a RESULT (below). Never throws: it reports.
//
// A RESULT is the single thing a provider may answer with:
//
//   { status, capabilities, version, error, data, at }
//     status          connected | available | degraded | unavailable | not-configured | unknown
//     capabilities    the subset of the declared capabilities that actually answered this time
//     version         the remote/command version if the provider has one (never a credential)
//     error           { code, reason } — public-safe, never a raw errno, path or upstream body
//     data            the domain payload, or null. Never leaves the server as part of the status
//                     document; assemblers read it through data()
//
// Guarantees provided here (all of them load-bearing, all of them tested):
//
//   1. INDEPENDENCE    one provider failing can never change another provider's answer, and can
//                      never throw out of describeProviders()
//   2. BOUNDED WORK    one in-flight check per provider (single-flight) and a TTL cache, so a page
//                      with five widgets asking for storage at once runs zpool exactly once
//   3. HONEST STATUS   an unconfigured optional provider is `not-configured`, never `unhealthy`,
//                      and never `available` (see docs/11-phase-9.md §health)
//   4. NO SECRETS      the public document carries status, capabilities, version and a safe error
//                      sentence. Credentials, paths and upstream bodies are not fields here.
import { logEvent } from '../activity.js';

/** The whole status vocabulary. `not-configured` is a first-class answer, not a failure. */
export const PROVIDER_STATUS = Object.freeze([
  'connected', 'available', 'degraded', 'unavailable', 'not-configured', 'unknown',
]);

export const PROVIDER_TYPES = Object.freeze(['compute', 'storage', 'network', 'firewall', 'power', 'host']);

/** How each status reads in the UI. One place, so nothing improvises a synonym. */
export const STATUS_LABELS = Object.freeze({
  connected: 'Connected',
  available: 'Available',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  'not-configured': 'Not configured',
  unknown: 'Unknown',
});

/**
 * Error codes a provider may report. Reasons are public sentences, so this list is also a
 * contract with the UI: it never has to parse a provider's own words.
 */
export const ERROR_CODES = Object.freeze([
  'not_configured', 'not_supported', 'command_missing', 'command_failed', 'parse_error',
  'unreachable', 'timeout', 'authentication_failed', 'permission_denied', 'provider_error',
]);

/**
 * A provider that did not answer at all. The registry substitutes this when a provider throws,
 * so a broken provider is reported rather than propagated.
 */
const BROKEN = Object.freeze({
  status: 'unavailable',
  capabilities: [],
  version: null,
  error: Object.freeze({ code: 'provider_error', reason: 'The provider did not answer.' }),
  data: null,
});

/** Unknown: a provider that exists but has not been asked yet. */
const UNCHECKED = Object.freeze({
  status: 'unknown',
  capabilities: [],
  version: null,
  error: null,
  data: null,
});

const registry = new Map();
const cache = new Map();      // id → { at, value }
const inflight = new Map();   // id → Promise (single-flight)

/** Test helper — every provider is re-registered by the modules that own it. */
export function _resetProviders() {
  registry.clear();
  cache.clear();
  inflight.clear();
}

function normalizeResult(raw, declared) {
  const status = PROVIDER_STATUS.includes(raw?.status) ? raw.status : 'unavailable';
  const declaredCaps = Array.isArray(declared.capabilities) ? declared.capabilities : [];
  const caps = Array.isArray(raw?.capabilities)
    ? raw.capabilities.filter((c) => declaredCaps.includes(c))
    : (status === 'connected' || status === 'available' ? declaredCaps : []);
  let error = null;
  if (raw?.error && typeof raw.error === 'object') {
    const code = ERROR_CODES.includes(raw.error.code) ? raw.error.code : 'provider_error';
    // The reason is shown verbatim in the UI, so it is truncated and it is the provider's
    // own public sentence — never an exception message or an upstream response body.
    const reason = typeof raw.error.reason === 'string' ? raw.error.reason.slice(0, 300) : null;
    error = { code, reason: reason || null };
  }
  const version = typeof raw?.version === 'string' ? raw.version.slice(0, 80) : null;
  return { status, capabilities: Object.freeze([...caps]), version, error, data: raw?.data ?? null, at: Date.now() };
}

/**
 * Register a provider. Ids are unique: a second registration for the same id is a programming
 * error, not a silent override (nothing in OpusHub may swap a provider out from under a page).
 */
export function registerProvider(def) {
  if (!def || typeof def.id !== 'string' || !def.id) throw new Error('provider needs an id');
  if (registry.has(def.id)) throw new Error(`provider already registered: ${def.id}`);
  if (!PROVIDER_TYPES.includes(def.type)) throw new Error(`provider ${def.id}: unknown type ${def.type}`);
  if (typeof def.check !== 'function') throw new Error(`provider ${def.id} has no check()`);
  const entry = Object.freeze({
    id: def.id,
    type: def.type,
    name: typeof def.name === 'string' ? def.name : def.id,
    domain: typeof def.domain === 'string' ? def.domain : def.type,
    optional: def.optional !== false,
    capabilities: Object.freeze([...(Array.isArray(def.capabilities) ? def.capabilities : [])]),
    ttlMs: Number.isFinite(def.ttlMs) && def.ttlMs > 0 ? def.ttlMs : 60_000,
    check: def.check,
    // capabilities this provider recognises but does not implement yet — declared so the UI can
    // say "planned" instead of leaving a silent gap (see docs/11-phase-9.md §future)
    planned: Object.freeze([...(Array.isArray(def.planned) ? def.planned : [])]),
    description: typeof def.description === 'string' ? def.description : null,
  });
  registry.set(entry.id, entry);
  return entry;
}

export function getProvider(id) { return registry.get(id) || null; }

/** Every registered provider, in registration order. */
export function listProviders() { return [...registry.values()]; }

export function providerIds() { return [...registry.keys()]; }

/** True when the id is registered — the only gate applied to a provider id from the client. */
export function isKnownProvider(id) { return typeof id === 'string' && registry.has(id); }

/** True when the provider declared the capability AND currently reports it available. */
export function hasCapability(id, capability, result = null) {
  const p = registry.get(id);
  if (!p) return false;
  const r = result || cache.get(id)?.value || null;
  if (!r) return false;
  return r.capabilities.includes(capability);
}

/**
 * Run one provider's check, through the cache and single-flight.
 *
 * @param id      a registered provider id
 * @param force   ignore the TTL (used by the Connections pane's refresh, never by a poll loop)
 * @returns the normalized RESULT, or UNCHECKED when the id is not registered
 */
export async function checkProvider(id, { force = false } = {}) {
  const p = registry.get(id);
  if (!p) return { ...UNCHECKED, at: Date.now() };
  const hit = cache.get(id);
  if (!force && hit && Date.now() - hit.at < p.ttlMs) return hit.value;
  if (inflight.has(id)) return inflight.get(id);
  const run = (async () => {
    let value;
    try {
      const raw = await p.check();
      value = raw && typeof raw === 'object' ? normalizeResult(raw, p) : { ...BROKEN, at: Date.now() };
    } catch (err) {
      // A provider's own exception is a server detail: the UI gets a sentence, the log gets the
      // reason (behind OPUSHUB_DEBUG, so a normal install stays quiet).
      if (process.env.OPUSHUB_DEBUG) console.warn(`[providers] ${id} failed: ${err?.message}`);
      value = { ...BROKEN, at: Date.now() };
    }
    cache.set(id, { at: value.at, value });
    return value;
  })().finally(() => inflight.delete(id));
  inflight.set(id, run);
  return run;
}

/** The cached domain payload for one provider, or null. Never triggers a check. */
export function cachedData(id) {
  return cache.get(id)?.value?.data ?? null;
}

/** Force a re-check on the next read (used after a settings change). */
export function invalidateProvider(id) { cache.delete(id); }

export function invalidateAll() { cache.clear(); }

/**
 * The status document for one provider — the ONLY shape allowed across the API boundary.
 * `data` is deliberately stripped: domain payloads come from their own routes, which is also
 * what makes lazy detail fetching possible (see docs/11-phase-9.md §performance).
 */
export function providerStatusDoc(id) {
  const p = registry.get(id);
  const r = cache.get(id)?.value || null;
  if (!p) return null;
  return {
    id: p.id,
    type: p.type,
    name: p.name,
    domain: p.domain,
    optional: p.optional,
    description: p.description,
    status: r?.status ?? 'unknown',
    statusLabel: STATUS_LABELS[r?.status ?? 'unknown'],
    capabilities: p.capabilities ? [...p.capabilities] : [],
    active: r?.capabilities ? [...r.capabilities] : [],
    planned: [...p.planned],
    version: r?.version ?? null,
    lastChecked: r?.at ?? null,
    error: r?.error ?? null,
  };
}

/** Status documents for every provider (or the named ones), with per-provider isolation. */
export async function describeProviders({ ids = null, force = false } = {}) {
  const list = ids ? ids.filter((id) => registry.has(id)) : providerIds();
  const out = [];
  for (const id of list) {
    try {
      await checkProvider(id, { force });
    } catch { /* checkProvider never throws; this is belt and braces */ }
    out.push(providerStatusDoc(id));
  }
  return out;
}

/** The full provider document the API and the Connections pane render. */
export async function providersDocument({ force = false } = {}) {
  const providers = await describeProviders({ force });
  return { at: Date.now(), providers, count: providers.length };
}

/**
 * Provider state transitions are real events, so they are recorded — once per change, with the
 * same signature dedupe the rest of the activity log uses. `not-configured` is not an event:
 * an operator who has not connected OPNsense has not caused anything to happen.
 */
const lastState = new Map();

export function noteProviderStates(providers) {
  for (const p of providers) {
    if (p.status === 'unknown') continue;
    const prev = lastState.get(p.id);
    if (prev === p.status) continue;
    lastState.set(p.id, p.status);
    if (prev == null) continue;                       // first observation is not a transition
    if (p.status === 'not-configured' || prev === 'not-configured') continue;
    const up = p.status === 'connected' || p.status === 'available';
    const recovered = up || (p.status === 'degraded' && prev === 'unavailable');
    logEvent({
      source: 'system',
      type: recovered ? 'provider.connected' : 'provider.disconnected',
      subject: p.name,
      message: recovered
        ? `${p.name} is ${p.statusLabel.toLowerCase()} again`
        : `${p.name} is ${p.statusLabel.toLowerCase()}${p.error?.reason ? ` — ${p.error.reason}` : ''}`,
      meta: { provider: p.id, from: prev, to: p.status },
      severity: recovered ? 'notice' : 'warning',
      category: 'provider',
      signature: `provider.${p.id}:${prev}>${p.status}`,
      dedupeWindowMs: 5 * 60_000,
    });
  }
}
