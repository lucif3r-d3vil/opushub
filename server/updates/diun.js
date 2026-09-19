// Phase 10C — Diun webhook intake & update detector adapter
// Receives Diun webhook notifications, strictly validates against live Docker inventory,
// persists state, and publishes idempotent container.update_available events to the Event Bus.
//
// Diun does NOT independently send notifications to external providers.
// Diun talks ONLY to this endpoint: Diun -> OpusHub intake -> Event Bus -> Notification Policy.

import * as store from './store.js';
import * as docker from '../providers/docker.js';
import * as model from '../model.js';
import { evaluateEligibility } from './eligibility.js';
import { logEvent } from '../activity.js';
import { publishEvent } from '../events/index.js';

export async function handleDiunWebhook(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, code: 'invalid_payload', reason: 'Payload must be a JSON object' };
  }

  const image = typeof payload.image === 'string' ? payload.image.trim() : null;
  const status = typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : null;
  const digest = typeof payload.digest === 'string' ? payload.digest.trim() : null;
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};

  if (!image) {
    return { ok: false, code: 'missing_image', reason: 'Image reference is required' };
  }

  // 1. Strict target resolution against live Docker inventory
  const containerIdFromMeta = metadata.ctn_id || metadata.container_id || null;
  const containerNameFromMeta = metadata.ctn_names || metadata.container_name || null;

  const inv = await model.getInventory().catch(() => null);
  const services = inv?.services || [];

  let matchedService = null;

  // Match by container ID prefix or name
  if (containerIdFromMeta) {
    const idPrefix = String(containerIdFromMeta).toLowerCase().slice(0, 12);
    matchedService = services.find((s) => s.container?.id?.toLowerCase().startsWith(idPrefix));
  }
  if (!matchedService && containerNameFromMeta) {
    const cleanName = String(containerNameFromMeta).replace(/^\//, '').toLowerCase();
    matchedService = services.find((s) => s.container?.name?.toLowerCase() === cleanName || s.name?.toLowerCase() === cleanName);
  }
  if (!matchedService && image) {
    matchedService = services.find((s) => s.container?.image === image || image.includes(s.container?.image || '---'));
  }

  if (!matchedService) {
    return {
      ok: false,
      code: 'unmatched_target',
      reason: 'No matching container found in live Docker inventory for this update.',
    };
  }

  // 2. Strict repository verification: proposed image MUST match the container's current image repository
  const currentImage = matchedService.container?.image || '';
  const currentRepo = currentImage.split(':')[0].split('@')[0];
  const proposedRepo = image.split(':')[0].split('@')[0];

  // If repositories diverge (e.g. attempting to replace jellyfin with malicious image), REJECT!
  if (currentRepo && proposedRepo && !proposedRepo.endsWith(currentRepo) && !currentRepo.endsWith(proposedRepo)) {
    return {
      ok: false,
      code: 'image_repo_mismatch',
      reason: `Proposed image repository ${proposedRepo} does not match container repository ${currentRepo}.`,
    };
  }

  const containerId = matchedService.container?.id || 'unknown';
  const serviceId = matchedService.name || 'unknown';
  const serviceLabel = matchedService.displayName || matchedService.name || serviceId;

  // 3. Deduplication / Idempotency check:
  // Same container + same image + same available digest = DO NOT duplicate events!
  const existing = store.getUpdate(containerId) || store.getUpdate(serviceId);
  if (existing && existing.availableDigest === digest && existing.status === 'update_available' && existing.imageRef === image) {
    return { ok: true, duplicated: true, record: existing };
  }

  // 4. Check eligibility
  const inspect = containerId !== 'unknown' ? await docker.inspectContainer(containerId).catch(() => null) : null;
  const eligibility = evaluateEligibility({
    container: matchedService.container || { id: containerId, name: serviceId, image },
    inspect,
    imageRef: image,
  });

  // Extract tag from image string
  let tag = null;
  if (image.includes(':')) {
    tag = image.split(':').pop().split('@')[0];
  }

  const record = store.putUpdate({
    containerId,
    serviceId,
    imageRef: image,
    currentDigest: inspect?.imageId ? `sha256:${inspect.imageId}` : (matchedService.container?.imageId || null),
    currentTag: tag,
    availableDigest: digest,
    availableTag: tag,
    registry: image.includes('/') ? image.split('/')[0] : 'docker.io',
    detectedAt: Date.now(),
    lastCheckedAt: Date.now(),
    status: 'update_available',
    updateEligible: eligibility.eligible,
    ineligibilityReason: eligibility.reason,
  });

  // 5. Publish canonical update event (idempotent)
  try {
    publishEvent({
      type: 'container.update_available',
      severity: 'notice',
      source: 'docker',
      subject: {
        kind: 'service',
        id: containerId,
        label: serviceLabel,
        href: `/services`,
      },
      message: `${serviceLabel} update available (${tag || 'latest'})`,
      payload: {
        containerId,
        serviceId,
        imageRef: image,
        currentDigest: record.currentDigest,
        availableDigest: record.availableDigest,
        tag,
        updateEligible: record.updateEligible,
      },
      correlation: { service: serviceId, target: containerId },
    });
  } catch {}

  logEvent({
    source: 'docker',
    type: 'container.update_available',
    subject: serviceLabel,
    message: `Update available for ${serviceLabel}: ${tag || digest?.slice(0, 19) || 'new image'}`,
    meta: {
      containerId,
      image,
      digest,
    },
    severity: 'notice',
    category: 'service',
    signature: `update_available:${containerId}:${digest || image}`,
  });

  return { ok: true, duplicated: false, record };
}
