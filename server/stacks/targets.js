// Stack targets — Phase 10D-B fills this in. Until then every stack action is refused honestly.
import { operationError } from '../operations/model.js';

export function stackLockKey(id) { return `stack:${String(id).toLowerCase()}`; }

export async function resolveStackTarget(ref) {
  return { ok: false, error: operationError('not_available', 'Stack operations are not available yet.', ref?.id || null) };
}

export async function planStackOperation() {
  return { ok: false, plan: null, policy: null, error: operationError('not_available', 'Stack operations are not available yet.') };
}
