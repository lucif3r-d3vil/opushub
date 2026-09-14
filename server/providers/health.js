// Provider health registry — one honest answer to "which data sources are working right now?"
//
// Every provider that crosses the API boundary (docker, system, news, weather, markets) reports
// the outcome of its last attempt here. The registry keeps:
//   state      'available' | 'unavailable' | 'degraded' | 'idle' (never configured / never asked)
//   lastOk     timestamp of the most recent successful answer (null → never succeeded)
//   lastTry    timestamp of the most recent attempt
//   reason     a PUBLIC-safe explanation of the current state (never socket paths or tokens)
//
// State transitions are real events, so they are written to the activity log — "provider became
// unavailable" and "provider recovered" — with built-in duplicate suppression (a provider that
// keeps failing every poll produces ONE unavailable event, not one per poll).
import { logEvent } from '../activity.js';

const STATES = new Set(['available', 'unavailable', 'degraded', 'idle']);

/** name → { state, lastOk, lastTry, reason, initialized } */
const registry = new Map();

function entry(name) {
  if (!registry.has(name)) {
    registry.set(name, { state: 'idle', lastOk: null, lastTry: null, reason: null, initialized: false });
  }
  return registry.get(name);
}

/**
 * Report the outcome of one provider attempt.
 * @param name    'docker' | 'system' | 'news' | 'weather' | 'markets'
 * @param state   'available' | 'unavailable' | 'degraded'
 * @param opts    { reason, silent } — silent skips activity logging (used for steady-state polls)
 */
export function reportProvider(name, state, { reason = null, silent = false } = {}) {
  if (!STATES.has(state)) state = 'unavailable';
  const e = entry(name);
  const now = Date.now();
  const prev = e.state;
  const changed = !e.initialized ? state !== 'idle' : state !== prev;
  e.state = state;
  e.lastTry = now;
  if (state === 'available' || state === 'degraded') e.lastOk = now;
  if (reason != null) e.reason = reason || null;
  if (!silent && changed) {
    e.initialized = true;
    if (state === 'available' && prev === 'idle') {
      // first successful contact is not an "event" — it is just OpusHub starting up
    } else if (state === 'available') {
      logEvent({ source: 'system', type: 'provider.recovered', subject: name, message: `${name} is available again`, meta: { provider: name } });
    } else {
      logEvent({ source: 'system', type: 'provider.unavailable', subject: name, message: `${name} is ${state}${reason ? ` — ${reason}` : ''}`, meta: { provider: name, state } });
    }
  } else if (changed) {
    e.initialized = true;
  }
  return e;
}

/** A snapshot for the API: deterministic order, honest states, no internals. */
export function providerHealthDoc(now = Date.now()) {
  const names = ['docker', 'system', 'news', 'weather', 'markets'];
  return {
    at: now,
    providers: names.map((name) => {
      const e = registry.has(name) ? registry.get(name) : { state: 'idle', lastOk: null, lastTry: null, reason: null };
      return {
        name,
        state: e.state,
        lastOk: e.lastOk,
        lastTry: e.lastTry,
        // a stale success is its own kind of trouble: say how old it is, let the UI judge
        staleMs: e.lastOk ? now - e.lastOk : null,
        reason: e.state === 'available' ? null : e.reason,
      };
    }),
  };
}

/** Test helper — reset between runs. */
export function resetProviderHealth() {
  registry.clear();
}
