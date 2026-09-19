// Phase 10C — Update engine
// Executes container update lifecycle under the same security model as Phase 8 operations:
//
// request/dry-run → authorization → target resolution → update eligibility → confirmation
//                 → pull image → recreate → verify health → audit → event → notification
//
// TRANSACTION / ROLLBACK POLICY:
// A. Pull fails → old container remains untouched / running.
// B. Stop fails → old container remains untouched / running.
// C. Rename fails → restart old container.
// D. Create fails → rename old container back to original name and start it.
// E. Replacement start fails → remove failed replacement, rename old container back, and start it.
// F. Replacement healthcheck fails → rollback if verifiable, or flag recovery required.
// G. Crash during transaction → detect on boot via transactions.json; expose "recovery_required".

import * as docker from '../providers/docker.js';
import * as model from '../model.js';
import * as recreateAdapter from './recreateAdapter.js';
import { buildReplacementConfig } from './preserveConfig.js';
import { recreateContainer } from '../containers/recreate.js';
import { resolveTarget, revalidateTarget } from '../operations/targets.js';
import { issue as issueConfirmation, verify as spendConfirmation, cancel as cancelConfirmation } from '../operations/confirmation.js';
import { acquire, release, checkRate } from '../operations/locks.js';
import { operationError } from '../operations/model.js';
import { evaluateEligibility } from './eligibility.js';
import * as store from './store.js';
import * as txStore from './transaction.js';
import { logEvent } from '../activity.js';

// Phase 10B — best-effort publish onto the canonical event bus (the failure-isolated
// wrapper lives with the bus; every producer used to carry an identical local copy).
import { publishEventSafe } from '../events/index.js';

// Memory-bound mock or real image pull function
let pullHandler = null;
export function __setPullHandler(fn) {
  pullHandler = fn;
}

export async function pullImage(imageRef, { timeoutMs = 120_000 } = {}) {
  if (pullHandler) {
    return pullHandler(imageRef, { timeoutMs });
  }
  return recreateAdapter.pullImage(imageRef, { timeoutMs });
}

/**
 * Dry-run update preflight.
 * Validates target, eligibility, current update state, and issues a confirmation token.
 * NEVER modifies Docker.
 */
export async function dryRunUpdate({ targetRef, actor = null, sessionId = null, at = Date.now() }) {
  const rate = checkRate(sessionId, { at });
  if (!rate.ok) {
    return {
      ok: false,
      status: 429,
      error: operationError('rate_limited', 'Too many requests. Please wait a moment.'),
    };
  }

  const targetResult = await resolveTarget(targetRef);
  if (!targetResult.ok) {
    return { ok: false, status: 400, error: targetResult.error };
  }
  const target = targetResult.target;

  // Retrieve existing update record
  const updateRecord = store.getUpdate(target.containerId) || store.getUpdate(target.service);
  if (!updateRecord || updateRecord.status !== 'update_available') {
    return {
      ok: false,
      status: 409,
      error: operationError('no_update_available', 'No image update is currently pending for this container.'),
    };
  }

  // Inspect existing container configuration to verify preservation capability
  const inspect = await docker.inspectContainer(target.containerId).catch(() => null);
  const eligibility = evaluateEligibility({
    container: target,
    inspect,
    imageRef: updateRecord.imageRef,
  });

  if (!eligibility.eligible) {
    return {
      ok: false,
      status: 400,
      error: operationError('update_ineligible', `Update unavailable: ${eligibility.reason}`),
    };
  }

  // Build replacement preview to guarantee configuration preservation
  let planConfig = null;
  try {
    if (inspect) {
      planConfig = buildReplacementConfig(inspect, updateRecord.imageRef);
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: operationError('config_error', `Failed to construct replacement configuration: ${err.message}`),
    };
  }

  // Issue confirmation token bound to action 'container.update_now' and target container
  const conf = issueConfirmation({
    sessionId,
    actor,
    action: 'container.update_now',
    targetKey: `container:${target.containerId}`,
    opId: `upd-${target.containerId.slice(0, 12)}`,
    mode: 'strong',
    at,
  });

  return {
    ok: true,
    status: 200,
    plan: {
      action: 'container.update_now',
      target: {
        id: target.containerId,
        service: target.service,
        label: target.label,
        currentImage: updateRecord.imageRef,
        currentDigest: updateRecord.currentDigest,
        availableDigest: updateRecord.availableDigest,
        availableTag: updateRecord.availableTag,
      },
      preserved: {
        environmentCount: planConfig?.createBody?.Env?.length || 0,
        volumeBindsCount: planConfig?.createBody?.HostConfig?.Binds?.length || 0,
        networks: [planConfig?.createBody?.HostConfig?.NetworkMode, ...(planConfig?.auxiliaryNetworks || []).map((n) => n.name)].filter(Boolean),
        restartPolicy: planConfig?.createBody?.HostConfig?.RestartPolicy?.Name || 'unless-stopped',
        hasHealthcheck: !!planConfig?.createBody?.Healthcheck,
      },
      steps: [
        'Resolve and revalidate canonical target container',
        'Verify target update status in registry cache',
        `Pull updated image ${updateRecord.imageRef}`,
        'Inspect and clone existing configuration (volumes, environment, networks, Traefik labels)',
        'Stop and rename previous container',
        'Create and start replacement container with updated image',
        'Connect auxiliary networks',
        'Verify container healthy and running',
        'Safely remove old temporary container (volumes preserved)',
        'Refresh inventory and publish canonical update event',
      ],
      interruptionNote: 'The container will be briefly recreated to apply the new image.',
    },
    confirmation: {
      token: conf.token,
      expiresAt: conf.expiresAt,
      ttlMs: conf.ttlMs,
      prompt: {
        title: `Update ${target.label}?`,
        currentImage: updateRecord.imageRef,
        currentDigest: updateRecord.currentDigest,
        availableDigest: updateRecord.availableDigest,
        availableTag: updateRecord.availableTag,
        body: `This will pull the updated image and recreate ${target.label}. Volume mounts, networks, environment, and Traefik labels will be preserved.`,
        confirmLabel: `Update now`,
        cancelLabel: 'Cancel',
      },
    },
  };
}

/**
 * Execute confirmed container update with strict transaction state machine & rollback.
 */
export async function executeUpdate({ targetRef, confirmationToken, actor = null, sessionId = null, at = Date.now() }) {
  const rate = checkRate(sessionId, { at });
  if (!rate.ok) {
    return {
      ok: false,
      status: 429,
      error: operationError('rate_limited', 'Too many requests. Please wait a moment.'),
    };
  }

  // 1. Target resolution
  const targetResult = await resolveTarget(targetRef);
  if (!targetResult.ok) {
    cancelConfirmation(confirmationToken);
    return { ok: false, status: 400, error: targetResult.error };
  }
  let target = targetResult.target;

  // 2. Spend confirmation token
  const spend = spendConfirmation({
    token: confirmationToken,
    sessionId,
    actor,
    action: 'container.update_now',
    targetKey: `container:${target.containerId}`,
    at,
  });
  if (!spend.ok) {
    return { ok: false, status: 409, error: spend.error };
  }

  // 3. Acquire per-target lock
  const lock = acquire(target.containerId, {
    opId: `upd-${target.containerId.slice(0, 12)}`,
    action: 'container.update_now',
    actor,
    sessionId,
    at,
  });
  if (!lock.ok) {
    return { ok: false, status: 409, error: operationError('conflict', 'Another operation is already running on this container.') };
  }

  // Enter Autoheal suppression window
  txStore.markContainerUpdating(target.containerId);
  if (target.containerName) txStore.markContainerUpdating(target.containerName);

  const txId = `tx-${target.containerId.slice(0, 12)}-${Date.now()}`;
  let tx = {
    id: txId,
    containerId: target.containerId,
    service: target.service,
    state: 'pending',
    oldName: target.containerName || target.service,
    tempName: null,
    newId: null,
    startedAt: Date.now(),
  };
  txStore.saveTransaction(tx);

  try {
    // 4. Revalidate target immediately before execution
    const reval = await revalidateTarget(target);
    if (!reval.ok) {
      tx.state = 'failed';
      txStore.saveTransaction(tx);
      return { ok: false, status: 409, error: reval.error };
    }
    target = reval.target;

    // 5. Verify update is still pending
    const updateRecord = store.getUpdate(target.containerId) || store.getUpdate(target.service);
    if (!updateRecord || updateRecord.status !== 'update_available') {
      const err = operationError('stale_update', 'No update is available or it has already been applied.');
      tx.state = 'failed';
      txStore.saveTransaction(tx);
      return { ok: false, status: 409, error: err };
    }

    // 6. Pull updated image
    tx.state = 'pulling';
    txStore.saveTransaction(tx);
    store.putUpdate({ ...updateRecord, status: 'updating', lastCheckedAt: Date.now() });

    const pullRes = await pullImage(updateRecord.imageRef);
    if (!pullRes.ok) {
      tx.state = 'failed';
      txStore.saveTransaction(tx);
      store.putUpdate({
        ...updateRecord,
        status: 'failed',
        ineligibilityReason: pullRes.reason || 'Failed to pull image',
        lastCheckedAt: Date.now(),
      });
      emitUpdateEvent('failed', target, updateRecord, pullRes.reason);
      logActivity(target, 'failed', pullRes.reason || 'Failed to pull image');
      return {
        ok: false,
        status: 502,
        error: operationError('pull_failed', pullRes.reason || 'Failed to pull image from registry.'),
      };
    }

    // 7. Inspect existing container to clone configuration
    tx.state = 'inspecting';
    txStore.saveTransaction(tx);
    const inspectRes = await recreateAdapter.inspectContainer(target.containerId);
    if (!inspectRes.ok || !inspectRes.data) {
      tx.state = 'failed';
      txStore.saveTransaction(tx);
      return {
        ok: false,
        status: 500,
        error: operationError('inspect_failed', 'Failed to inspect container before recreate.'),
      };
    }

    const { createBody, auxiliaryNetworks, containerName } = buildReplacementConfig(inspectRes.data, updateRecord.imageRef);
    const originalName = containerName || target.containerName || target.service;

    // 8–14. The shared recreate ladder (containers/recreate.js): stop → rename → create → connect
    // → start → verify → remove old, with rollback at every rung. One transaction, one story.
    const wasRunning = inspectRes.data?.State?.Running !== false;
    const rec = await recreateContainer({
      containerId: target.containerId,
      containerName: originalName,
      createBody,
      auxiliaryNetworks,
      kind: 'update',
      wasRunning,
      service: target.service,
      verifyMs: 1500,
      tx,
    });
    if (!rec.ok) {
      store.putUpdate({ ...updateRecord, status: 'failed', ineligibilityReason: rec.reason, lastCheckedAt: Date.now() });
      emitUpdateEvent('failed', target, updateRecord, rec.reason);
      logActivity(target, 'failed', rec.reason);
      return { ok: false, status: 500, error: operationError(rec.code, rec.reason) };
    }
    const newContainerId = rec.newId;

    // 15. Complete transaction
    tx.state = 'completed';
    txStore.saveTransaction(tx);

    // Update state store
    const updatedRecord = store.putUpdate({
      ...updateRecord,
      containerId: newContainerId.slice(0, 12),
      currentDigest: updateRecord.availableDigest || updateRecord.currentDigest,
      currentTag: updateRecord.availableTag || updateRecord.currentTag,
      status: 'updated',
      updateAvailable: false,
      lastCheckedAt: Date.now(),
    });

    emitUpdateEvent('updated', target, updatedRecord);
    logActivity(target, 'updated', `Updated to ${updatedRecord.availableTag || updatedRecord.availableDigest || 'latest'}`);

    return {
      ok: true,
      status: 200,
      record: updatedRecord,
      container: {
        id: newContainerId.slice(0, 12),
        name: originalName,
        service: target.service,
        state: 'running',
      },
    };
  } finally {
    // Release locks and end Autoheal suppression window
    txStore.unmarkContainerUpdating(target.containerId);
    if (target.containerName) txStore.unmarkContainerUpdating(target.containerName);
    release(target.containerId);
    try { model.invalidateDiscovery(); } catch {}
  }
}

function logActivity(target, status, detail) {
  logEvent({
    source: 'user',
    type: status === 'updated' ? 'container.updated' : 'container.update_failed',
    subject: target.label || target.containerName,
    message: detail,
    meta: {
      container: target.containerName,
      service: target.service,
      status,
    },
    severity: status === 'updated' ? 'notice' : 'warning',
    category: 'service',
    signature: `update:${target.containerId}:${status}`,
  });
}

function emitUpdateEvent(kind, target, record, errorReason = null) {
  const subject = {
    kind: 'service',
    id: target.containerId,
    label: target.label || target.containerName,
    href: `/services`,
  };

  if (kind === 'updated') {
    publishEventSafe({
      type: 'container.updated',
      severity: 'notice',
      source: 'docker',
      subject,
      message: `${subject.label} updated successfully`,
      payload: {
        containerId: target.containerId,
        serviceId: target.service,
        imageRef: record.imageRef,
        digest: record.currentDigest,
      },
      correlation: { service: target.service, target: target.containerId },
    });
  } else if (kind === 'failed') {
    publishEventSafe({
      type: 'container.update_failed',
      severity: 'warning',
      source: 'docker',
      subject,
      message: `${subject.label} update failed: ${errorReason || 'recreate error'}`,
      payload: {
        containerId: target.containerId,
        serviceId: target.service,
        imageRef: record.imageRef,
        error: errorReason,
      },
      correlation: { service: target.service, target: target.containerId },
    });
  }
}
