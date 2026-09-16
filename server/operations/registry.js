// The Operations action registry — the single, exhaustive list of things OpusHub is allowed to
// DO to the infrastructure (as opposed to the many things it is allowed to say about it).
//
// Everything here is metadata. No registry field is ever used to build a Docker path, choose an
// HTTP method or call a function by name: the adapter call is a static `switch` in engine.js, so
// a registry entry cannot smuggle a new capability in, and a new capability cannot appear without
// a new case in that switch.
//
// Adding an action is therefore a four-part, reviewable change:
//   1. an entry here (metadata + risk + confirmation + timeouts)
//   2. an explicit adapter method in server/providers/dockerOperations.js
//   3. a case in the engine's static dispatch switch
//   4. tests — including the mechanical proof that the endpoint set is unchanged
//
// What is deliberately NOT here: remove, kill, pause, unpause, exec, attach, logs-follow,
// image pull/remove, volume remove, network remove, compose up/down/restart, prune, rename,
// update, copy, arbitrary shell. See docs/10-phase-8.md §"What is deliberately not supported".

/**
 * A timeout the operator may tune, clamped so it can only ever be a timeout: never zero
 * (an unbounded operation), never absurd (a request that outlives the browser's patience).
 */
function envMs(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.max(500, Math.min(120_000, v)) : fallback;
}

/** Risk levels, used only for confirmation strength and UI emphasis — never for authorization. */
export const RISKS = ['low', 'medium', 'high'];

/** Confirmation strength. `none` is not used by any shipped action. */
export const CONFIRMATIONS = ['none', 'normal', 'strong'];

/**
 * The registry. Frozen: no runtime mutation, and no way to reach a Docker operation that is
 * not one of these three ids.
 */
export const ACTIONS = Object.freeze({
  'container.start': Object.freeze({
    id: 'container.start',
    targetType: 'container',
    permission: 'operations.container.start',
    confirmation: 'normal',
    risk: 'low',
    // words, so the UI never has to assemble sentences from a verb and a guess
    verb: 'start',
    progressive: 'Starting',
    past: 'started',
    imperative: 'Start',
    consequence: null,
    // bounded: the Docker call itself, and how long we will wait for the state to be reached
    timeoutMs: envMs('OPUSHUB_OP_START_TIMEOUT_MS', 10_000),
    verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 15_000),
    // what "it worked" means — checked against a fresh inspect, not against the 204
    expect: 'running',
    auditCategory: 'service',
    // which adapter method this maps to — read by the engine's static switch only
    adapter: 'start',
    // Container states in which offering this action makes sense. This is *presentation*: it
    // decides what the UI offers, never what it may do — the engine re-checks the state itself.
    offerWhen: Object.freeze(['exited', 'created', 'dead']),
    summary: 'Start a stopped container.',
  }),
  'container.restart': Object.freeze({
    id: 'container.restart',
    targetType: 'container',
    permission: 'operations.container.restart',
    confirmation: 'normal',
    risk: 'medium',
    verb: 'restart',
    progressive: 'Restarting',
    past: 'restarted',
    imperative: 'Restart',
    consequence: 'The service will be unavailable for a moment while the container restarts.',
    timeoutMs: envMs('OPUSHUB_OP_RESTART_TIMEOUT_MS', 25_000),
    verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 20_000),
    expect: 'running',
    auditCategory: 'service',
    adapter: 'restart',
    offerWhen: Object.freeze(['running']),
    summary: 'Restart a running container.',
  }),
  'container.stop': Object.freeze({
    id: 'container.stop',
    targetType: 'container',
    permission: 'operations.container.stop',
    confirmation: 'strong',
    risk: 'high',
    verb: 'stop',
    progressive: 'Stopping',
    past: 'stopped',
    imperative: 'Stop',
    consequence: 'The service will be unavailable until it is started again.',
    timeoutMs: envMs('OPUSHUB_OP_STOP_TIMEOUT_MS', 15_000),
    verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 15_000),
    expect: 'exited',
    auditCategory: 'service',
    adapter: 'stop',
    offerWhen: Object.freeze(['running']),
    summary: 'Stop a running container. It stays stopped until you start it again.',
  }),
});

/** The action ids, in the order the UI should offer them. */
export const ACTION_IDS = Object.freeze(['container.start', 'container.restart', 'container.stop']);

/** Every permission the operations engine knows about. */
export const OPERATION_PERMISSIONS = Object.freeze(Object.values(ACTIONS).map((a) => a.permission));

/** True when the id is one of the registered actions — the only gate the API applies to input. */
export function isKnownAction(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ACTIONS, id);
}

/**
 * Look an action up. Unknown ids return null instead of throwing so the caller can answer with
 * a structured rejection (and an audit record) rather than a stack trace.
 */
export function getAction(id) {
  return isKnownAction(id) ? ACTIONS[id] : null;
}

/**
 * The registry as the Settings → Operations pane describes it. Informational: this is what the
 * engine can do, and there is no switch here that turns any of it off or on.
 */
export function registrySummary() {
  return ACTION_IDS.map((id) => {
    const a = ACTIONS[id];
    return {
      id: a.id,
      label: `${a.imperative} container`,
      permission: a.permission,
      risk: a.risk,
      confirmation: a.confirmation,
      summary: a.summary,
      timeoutMs: a.timeoutMs,
      verifyMs: a.verifyMs,
      enabled: true,
    };
  });
}

/** Test/ops helper. */
export function _internals() {
  return { ACTIONS, ACTION_IDS };
}
