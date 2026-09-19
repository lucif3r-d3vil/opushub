// Target resolution — the bridge between "something the browser named" and "a container this
// engine actually has".
//
// The browser may only ever supply a *reference* (a service/container id, name, or a group +
// name pair). Every reference is resolved here against the canonical OpusGrid inventory, and the
// only thing that ever reaches Docker is the container id this module produced from that
// inventory. A reference that does not resolve to exactly one live container is refused.
//
// Refusals are specific, because "no" without a reason is how people start pasting container ids
// into things:
//   bad_target        malformed, oversized or wrong-typed input
//   unknown_target    nothing on this engine matches it
//   ambiguous_target  more than one service matches it — refuse rather than guess
//   stale_target      it resolved, but the container is no longer the one we recorded
//   docker_unavailable  there is no live inventory to resolve against
import os from 'node:os';
import * as model from '../model.js';
import { operationError } from './model.js';

const MAX_REF = 128;
const MIN_ID_PREFIX = 6;   // shorter than this and a container id prefix is not identifying

/** The reference shapes the API accepts. Anything else is a malformed request, not a target. */
export const TARGET_TYPES = Object.freeze(['service', 'container']);

/**
 * Phase 10D — the non-container target kinds. Each resolves in its own module and produces a
 * target record whose `type` says which kind it is; the engine dispatches on the action, never on
 * the reference, so a `stack` reference cannot reach a container action or vice versa.
 *
 *   stack     { type: 'stack', id: '<project or managed id>' }        → stacks/targets.js
 *   image     { type: 'image', id: '<image reference>' }              → engine (validated ref)
 *   new       { type: 'new' }                                         → a container that does not exist yet
 *   catalog   { type: 'catalog', id: '<manifest id>' }                → catalog/schema.js
 */
export const EXTENDED_TARGET_TYPES = Object.freeze(['stack', 'image', 'new', 'catalog']);
const STACK_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
const CATALOG_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Normalize and validate the client's target reference *before* it is compared with anything.
 * Returns `{ ok, ref, error }`.
 */
export function parseTargetRef(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: operationError('bad_target', 'The operation target is missing or malformed.') };
  }
  const type = typeof input.type === 'string' ? input.type.trim().toLowerCase() : 'service';
  if (!TARGET_TYPES.includes(type) && !EXTENDED_TARGET_TYPES.includes(type)) {
    return { ok: false, error: operationError('bad_target', `Unknown target type: ${String(input.type).slice(0, 40)}.`) };
  }
  const read = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_REF) : null);
  if (EXTENDED_TARGET_TYPES.includes(type)) {
    const id = read(input.id);
    if (type === 'new') return { ok: true, ref: { type, id: null, name: null, group: null } };
    if (type === 'stack' && !(id && STACK_ID_RE.test(id))) return { ok: false, error: operationError('bad_target', 'The stack reference is missing or malformed.') };
    if (type === 'catalog' && !(id && CATALOG_ID_RE.test(id))) return { ok: false, error: operationError('bad_target', 'The catalog reference is missing or malformed.') };
    if (type === 'image' && !(id && id.length <= 300 && !/[\s\x00-\x1f\x7f]/.test(id))) return { ok: false, error: operationError('bad_target', 'The image reference is missing or malformed.') };
    return { ok: true, ref: { type, id: type === 'stack' ? id.toLowerCase() : id, name: null, group: null } };
  }
  const id = read(input.id);
  const name = read(input.name);
  const group = read(input.group);
  // Nothing to look for is a malformed request, not an absent container.
  if (!id && !name) {
    return { ok: false, error: operationError('bad_target', 'The operation target does not name a service or container.') };
  }
  // Control characters have no place in an inventory reference — a container name cannot contain
  // them either, so this rejects only what could never be valid.
  for (const v of [id, name, group]) {
    if (v && /[\x00-\x1f\x7f]/.test(v)) {
      return { ok: false, error: operationError('bad_target', 'The operation target contains characters a container name cannot contain.') };
    }
  }
  return { ok: true, ref: { type, id, name, group } };
}

/**
 * The container OpusHub itself is running in, when it can be known.
 *
 * Docker sets the container's hostname to a prefix of its id by default. When the hostname looks
 * like a container id, operating on it is almost certainly a mistake worth warning about, not an
 * action worth racing. Detection is best-effort: if it cannot be known, it is simply not flagged.
 */
export function selfContainerId() {
  try {
    const host = String(os.hostname() || '').trim().toLowerCase();
    return /^[0-9a-f]{12}$|^[0-9a-f]{64}$/.test(host) ? host : null;
  } catch { return null; }
}

/** Every service in the inventory, flat — including infrastructure and hidden ones. */
function candidates(inv) {
  const out = [];
  for (const g of inv.groups || []) for (const s of g.services || []) out.push(s);
  const seen = new Set(out.map((s) => s.id));
  for (const s of inv.services || []) if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
  return out;
}

const lc = (v) => String(v ?? '').toLowerCase();

/** Does this reference name this service? ID/name matches are authoritative; labels are a fallback. */
function matches(svc, ref, type) {
  const id = lc(ref.id);
  const name = lc(ref.name);
  const containerId = lc(svc.container?.id || svc.id);
  const containerName = lc(svc.container?.name || svc.name);
  if (id) {
    // a full container id, an unambiguous prefix, the container name, or the service's own key
    if (containerId === id) return true;
    if (id.length >= MIN_ID_PREFIX && containerId.startsWith(id)) return true;
    if (containerName === id) return true;
    if (lc(svc.name) === id) return true;
    if (type === 'container') return false;
    if (lc(svc.slug) === id) return true;
    if (lc(svc.displayName) === id) return true;
  }
  if (name) {
    if (containerName === name || lc(svc.name) === name) return true;
    if (type === 'container') return false;
    if (lc(svc.slug) === name || lc(svc.displayName) === name) return true;
  }
  return false;
}

/**
 * Resolve a reference against the live inventory.
 *
 * @returns {{ok:true, target:object, inventory:object} | {ok:false, error:object}}
 */
export async function resolveTarget(input) {
  const parsed = parseTargetRef(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const inv = await model.getInventory({ force: true });
  if (!inv.live || !inv.services?.length) {
    return {
      ok: false,
      error: operationError('docker_unavailable', 'Docker is not connected, so there is no live inventory to operate on.'),
    };
  }

  const ref = parsed.ref;
  const group = ref.group ? lc(ref.group) : null;
  let hits = candidates(inv).filter((s) => matches(s, ref, ref.type));
  if (group) {
    const inGroup = hits.filter((s) => lc(s.group) === group);
    // A group that matches nothing must not silently widen the search: that would let a stale
    // group name resolve to an unrelated container that happens to share a name.
    hits = inGroup;
  }

  if (hits.length === 0) {
    return {
      ok: false,
      error: operationError('unknown_target', 'No service or container on this engine matches that target.',
        `${ref.type} ${ref.group ? `${ref.group}/` : ''}${ref.id || ref.name}`),
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      error: operationError('ambiguous_target',
        'More than one container matches that target, so OpusHub refused to guess which one you meant.',
        hits.slice(0, 5).map((s) => s.name).join(', ')),
    };
  }

  const svc = hits[0];
  const containerId = lc(svc.container?.id || svc.id);
  const self = _selfContainerId();
  const target = {
    type: ref.type,
    // canonical: the container id OpusHub read from the engine, never the string the client sent
    id: containerId,
    containerId,
    containerName: svc.container?.name || svc.name,
    service: svc.name,
    label: svc.displayName || svc.name,
    group: svc.group || null,
    stack: svc.stack || null,
    state: svc.container?.state || null,
    health: svc.container?.health ?? null,
    self: !!self && containerId.startsWith(self.slice(0, 12)),
  };
  return { ok: true, target, inventory: inv };
}

/**
 * Re-validate a resolved target immediately before the Docker call.
 *
 * A container can be replaced or removed between the confirmation and the execution (compose
 * redeployed, a crash, another operator). The check is deliberately strict: same id AND same
 * name, both straight from the engine. A container id that now carries a different name is not
 * the container the user confirmed.
 */
export async function revalidateTarget(target) {
  let snap;
  try {
    snap = await model.dockerContainers({ force: true });
  } catch {
    return { ok: false, error: operationError('docker_unavailable', 'Docker became unavailable before the operation could run.') };
  }
  if (!snap?.containers) {
    return { ok: false, error: operationError('docker_unavailable', 'Docker became unavailable before the operation could run.') };
  }
  const live = snap.containers.find((c) => lc(c.id) === lc(target.containerId));
  if (!live) {
    return {
      ok: false,
      error: operationError('stale_target', 'The container disappeared before the operation could run.',
        `${target.containerName} is no longer on this engine`),
    };
  }
  if (lc(live.name) !== lc(target.containerName)) {
    return {
      ok: false,
      error: operationError('stale_target', 'The container was replaced before the operation could run, so the operation was not executed.',
        `${target.containerId} is now ${live.name}`),
    };
  }
  return { ok: true, target: { ...target, state: live.state || target.state, health: live.health ?? target.health } };
}

/** Test hook: the matching rule itself, exercised with synthetic services. */
export { matches as _matches };

/** Test hook: pretend OpusHub itself is a given container id. */
let forcedSelf = null;
export function _forceSelf(id) { forcedSelf = id; }
export function _selfContainerId() { return forcedSelf !== null ? forcedSelf : selfContainerId(); }
