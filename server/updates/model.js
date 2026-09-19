// Phase 10C — Container update state model & validation
// Persistent update state model stored outside presentation files (DATA_DIR/updates/state.json)
// Honest digest and tag representation — no fake versions.

export const UPDATE_STATUSES = Object.freeze([
  'current',
  'update_available',
  'updating',
  'updated',
  'failed',
  'unknown',
]);

export function sanitizeDigest(d) {
  if (typeof d !== 'string') return null;
  const s = d.trim();
  if (/^sha256:[a-f0-9]{32,64}$/i.test(s)) return s.toLowerCase();
  return null;
}

export function sanitizeTag(t) {
  if (typeof t !== 'string') return null;
  const s = t.trim();
  // Safe Docker tag syntax (alphanumeric, dot, dash, underscore)
  if (/^[a-zA-Z0-9_.-]{1,128}$/.test(s)) return s;
  return null;
}

export function sanitizeImageRef(img) {
  if (typeof img !== 'string') return null;
  const s = img.trim();
  // Safe image reference (no control chars, spaces, or secrets)
  if (/^[a-zA-Z0-9_./:@-]+$/.test(s) && s.length <= 256) return s;
  return null;
}

export function makeUpdateRecord({
  containerId,
  serviceId = null,
  imageRef,
  currentDigest = null,
  currentTag = null,
  availableDigest = null,
  availableTag = null,
  registry = 'docker.io',
  detectedAt = Date.now(),
  lastCheckedAt = Date.now(),
  status = 'update_available',
  updateEligible = true,
  ineligibilityReason = null,
} = {}) {
  const cleanContainerId = typeof containerId === 'string' ? containerId.trim().slice(0, 64) : null;
  if (!cleanContainerId) throw new Error('containerId required');

  const cleanImageRef = sanitizeImageRef(imageRef);
  if (!cleanImageRef) throw new Error('valid imageRef required');

  const curDig = sanitizeDigest(currentDigest);
  const curTag = sanitizeTag(currentTag);
  const availDig = sanitizeDigest(availableDigest);
  const availTag = sanitizeTag(availableTag);

  const stat = UPDATE_STATUSES.includes(status) ? status : 'unknown';

  return {
    containerId: cleanContainerId,
    serviceId: typeof serviceId === 'string' ? serviceId.trim().slice(0, 128) : null,
    imageRef: cleanImageRef,
    currentDigest: curDig,
    currentTag: curTag,
    availableDigest: availDig,
    availableTag: availTag,
    registry: typeof registry === 'string' ? registry.trim().slice(0, 100) : 'docker.io',
    detectedAt: Number.isFinite(detectedAt) ? detectedAt : Date.now(),
    lastCheckedAt: Number.isFinite(lastCheckedAt) ? lastCheckedAt : Date.now(),
    status: stat,
    updateAvailable: stat === 'update_available',
    updateEligible: !!updateEligible,
    ineligibilityReason: ineligibilityReason ? String(ineligibilityReason).slice(0, 200) : null,
  };
}
