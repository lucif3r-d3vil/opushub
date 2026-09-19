// Operation permissions — who may operate, and how that can grow without rewriting the engine.
//
// OpusHub has exactly one account today (the administrator created by the first-run wizard), so
// today this resolves to one role. The point of the indirection is the shape of the answer, not
// the number of roles: the operations engine asks `can(actor, permission)` and never asks "is
// this the admin?", so adding a second account with an `operator` or `viewer` role later is a
// change to `resolveRole()` plus an account store — not a change to any operation code path.
//
// Deliberately absent: any way for a request to declare its own role or permissions. The role
// comes from the authenticated session's username, server-side, and nothing else.
import * as auth from '../auth.js';

/** The permission vocabulary. Grows with the registry; never with client input. */
export const PERMISSIONS = Object.freeze({
  START: 'operations.container.start',
  RESTART: 'operations.container.restart',
  STOP: 'operations.container.stop',
  // Phase 10D
  PAUSE: 'operations.container.pause',
  KILL: 'operations.container.kill',
  CONFIGURE: 'operations.container.configure',   // rename, network attach/detach, in-place update, edit
  RECREATE: 'operations.container.recreate',     // recreate, change image
  CREATE: 'operations.container.create',         // create, duplicate, catalog install
  REMOVE: 'operations.container.remove',
  IMAGE_PULL: 'operations.image.pull',
  STACK_DEPLOY: 'operations.stack.deploy',
  STACK_REMOVE: 'operations.stack.remove',
  STACK_MANAGE: 'operations.stack.manage',       // create/edit managed stack definitions
  REGISTRY_MANAGE: 'operations.registry.manage', // registries (credentials) — server-side config
});

/**
 * Roles → permissions.
 *
 *   administrator  every approved operation (today: the only role in use)
 *   operator       lifecycle operations, but not the high-risk ones (reserved for Phase 9+)
 *   viewer         no operations at all — observation only
 *
 * The two future roles are declared here so the model is visible and testable now, while
 * `resolveRole()` still returns `administrator` for the single configured account. Nothing
 * grants them today because nothing can authenticate as them today.
 */
export const ROLES = Object.freeze({
  administrator: Object.freeze({
    id: 'administrator',
    label: 'Administrator',
    description: 'Full control: every approved operation.',
    permissions: Object.freeze(Object.values(PERMISSIONS)),
  }),
  operator: Object.freeze({
    id: 'operator',
    label: 'Operator',
    description: 'Reserved: lifecycle operations without the high-risk ones.',
    permissions: Object.freeze(['operations.container.start', 'operations.container.restart', 'operations.container.pause', 'operations.image.pull']),
  }),
  viewer: Object.freeze({
    id: 'viewer',
    label: 'Viewer',
    description: 'Reserved: observation only — no operations.',
    permissions: Object.freeze([]),
  }),
});

export const ROLE_IDS = Object.freeze(Object.keys(ROLES));

/**
 * Resolve the role of an authenticated username.
 *
 * There is one account (see auth.js), and it is the administrator. A username that does not
 * match it resolves to `viewer` — fail closed, never fail open — which means an unknown actor
 * is refused every operation rather than granted the administrator's.
 */
export function resolveRole(username) {
  const known = String(username || '').trim();
  const admin = safeAdminUsername();
  if (known && admin && known.toLowerCase() === String(admin).toLowerCase()) return 'administrator';
  return 'viewer';
}

/** The permissions a role carries. Unknown roles get none. */
export function permissionsForRole(role) {
  return ROLES[role]?.permissions ?? Object.freeze([]);
}

/** The permissions an actor carries. */
export function permissionsFor(username) {
  return permissionsForRole(resolveRole(username));
}

/** True when the actor's role carries this permission. No wildcards, no inheritance surprises. */
export function can(username, permission) {
  if (!permission) return false;
  return permissionsFor(username).includes(permission);
}

/**
 * Describe the caller's operational authority for the UI and for the dry-run report.
 * Never includes anything secret — just the role, the granted set, and the role's own words.
 */
export function describeActor(username) {
  const role = resolveRole(username);
  const def = ROLES[role] || ROLES.viewer;
  return {
    username: username || null,
    role: def.id,
    roleLabel: def.label,
    description: def.description,
    permissions: [...def.permissions],
  };
}

/**
 * The administrator's username, or null when there is no account yet (during setup there is
 * nobody to authorize — and the operations API is behind the session gate anyway).
 */
function safeAdminUsername() {
  try { return auth.getUser()?.username ?? null; } catch { return null; }
}
