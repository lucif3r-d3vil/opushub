// The Docker check — read-only, and deliberately narrow.
//
// What it does: resolves the monitor's service reference against the canonical OpusGrid inventory,
// reads the container's state (and its healthcheck status, when the engine reports one) and maps
// that to a monitoring verdict. What it does NOT do is anything at all: this module imports
// `providers/docker.js` for reads only, and never `dockerOperations.js`, never the operations
// engine, and it never calls start/stop/restart. A static proof asserts that
// (server/phase10a-proof.test.js).
//
// Container states (`running`, `exited`, `restarting`, …) are Docker's own vocabulary and are
// reported as such. The *verdict* distinguishes three different situations that a naive
// implementation collapses into one:
//
//   1. the container is running AND its healthcheck passes      → ok
//   2. the container is running with no healthcheck at all      → ok, and the evidence says
//      `application: 'unproven'` — this is a container-state monitor; it is NOT a claim that the
//      application inside answers (rule 8 of the brief, and the same rule healthModel.js follows)
//   3. the container is running and its healthcheck FAILS       → degraded (real negative evidence,
//      not a transient network event)
//
// Stopped/exited/dead is a failure; `restarting`, `created`, `removing` and `paused` are
// transitional and yield no verdict (`unknown`) rather than a false outage. A reference that no
// longer resolves to a container is `stale_target` — reported, never invented, never auto-deleted.
import * as docker from '../../providers/docker.js';

const OK = 'ok';
const DEGRADED = 'degraded';
const FAIL = 'fail';
const UNKNOWN = 'unknown';

/** Docker states with no verdict: the container is mid-transition, not down. */
const TRANSIENT = new Set(['created', 'restarting', 'removing', 'paused']);
/** Docker states that mean "it is not running". */
const STOPPED = new Set(['exited', 'dead']);

/**
 * Run one Docker check.
 *
 * @param {object} target    `{ service: { group, name } }`
 * @param {object} opts      `{ inventory, inspect, dockerAvailable, now }`
 *   `inventory` is fetched once per scheduler tick and shared by every Docker monitor in it.
 */
export async function checkDocker(target, { inventory = null, inspect = docker.inspectContainer, dockerAvailable = true, now = Date.now() } = {}) {
  const at = now;
  const ref = target?.service;
  const where = ref ? (ref.group ? `${ref.group}/${ref.name}` : ref.name) : null;
  if (!ref?.name) {
    return { kind: UNKNOWN, at, latencyMs: null, statusCode: null, errorType: 'invalid_target', code: 'invalid_target', reason: 'The monitor has no service to watch.', hops: 0, evidence: null, stale: true };
  }
  if (!dockerAvailable || inventory?.live === false) {
    return {
      kind: UNKNOWN, at, latencyMs: null, statusCode: null, errorType: 'docker_unavailable', code: 'docker_unavailable',
      reason: 'The Docker engine is not reachable, so nothing about this container can be verified.',
      hops: 0, evidence: { service: where },
    };
  }

  const all = [...(inventory?.groups || []).flatMap((g) => g.services || []), ...(inventory?.services || [])];
  const key = String(ref.name).toLowerCase();
  const gkey = ref.group ? String(ref.group).toLowerCase() : null;
  const match = (s) => s.name?.toLowerCase() === key || s.displayName?.toLowerCase() === key || s.slug === key;
  const service = all.find((s) => match(s) && (!gkey || s.group?.toLowerCase() === gkey)) || all.find(match) || null;

  if (!service) {
    // The service disappeared: a compose project was removed, an overlay no longer binds. This is
    // reported as a stale target — not as "down", and never as "up".
    return {
      kind: UNKNOWN, at, latencyMs: null, statusCode: null, errorType: 'stale_target', code: 'stale_target',
      reason: `${where || ref.name} is not in the current inventory — the container may have been removed or renamed.`,
      hops: 0, evidence: { service: where }, stale: true,
    };
  }

  const containerRef = service.id || service.container?.name || service.name;
  let state = service.container?.state || null;
  let health = service.container?.health ?? null;
  let containerName = service.container?.name || service.name;
  let checkedAt = at;

  // The list projection carries no healthcheck status, so a *running* container is inspected once
  // (a read, bounded by the same worker slot as every other check) to learn whether its
  // healthcheck is passing. If the inspect fails, the list-level facts stand and health stays
  // unknown — the verdict does not get worse because a convenience read failed.
  if (state === 'running') {
    try {
      const info = await inspect(containerRef);
      state = info?.state?.status ?? state;
      health = info?.state?.health ?? null;
      containerName = info?.name || containerName;
      checkedAt = at;
    } catch {
      health = null;
    }
  }

  const evidence = {
    service: where,
    container: containerName,
    containerId: typeof service.id === 'string' ? service.id.slice(0, 12) : null,
    state,
    health,
    application: health ? (health === 'healthy' ? 'proven by healthcheck' : 'healthcheck failing') : 'unproven — no healthcheck',
    checkedAt,
  };

  if (state === 'running') {
    if (health === 'unhealthy') {
      return { kind: DEGRADED, at, latencyMs: null, statusCode: null, errorType: 'unhealthy', code: 'unhealthy', reason: `${containerName} is running but its healthcheck is failing.`, hops: 0, evidence };
    }
    if (health === 'starting') {
      return { kind: UNKNOWN, at, latencyMs: null, statusCode: null, errorType: 'healthcheck_starting', code: 'healthcheck_starting', reason: `${containerName} is running; its healthcheck is still starting.`, hops: 0, evidence };
    }
    return {
      kind: OK, at, latencyMs: null, statusCode: null, errorType: null, code: null,
      reason: health === 'healthy' ? `${containerName} is running (healthcheck passing).` : `${containerName} is running (no healthcheck — container state only).`,
      hops: 0, evidence,
    };
  }
  if (TRANSIENT.has(state)) {
    return { kind: UNKNOWN, at, latencyMs: null, statusCode: null, errorType: state, code: state, reason: `${containerName} is ${state} — a transitional state, not a verdict.`, hops: 0, evidence };
  }
  if (STOPPED.has(state)) {
    return { kind: FAIL, at, latencyMs: null, statusCode: null, errorType: state, code: state, reason: `${containerName} is ${state}.`, hops: 0, evidence };
  }
  return { kind: UNKNOWN, at, latencyMs: null, statusCode: null, errorType: 'no_state', code: 'no_state', reason: `${containerName}: the engine reported no readable state.`, hops: 0, evidence };
}
