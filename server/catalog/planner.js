// Catalog planner — Phase 10D-D fills this in. Until then installs are refused honestly.
import { operationError } from '../operations/model.js';

export async function resolveCatalogTarget(ref) {
  return { ok: false, error: operationError('not_available', 'The service catalog is not available yet.', ref?.id || null) };
}

export async function planInstall() {
  return { ok: false, plan: null, policy: null, error: operationError('not_available', 'The service catalog is not available yet.') };
}
