// The controlled recreate transaction — Phase 10C's update ladder, generalized.
//
// One container is replaced by another built from a create body, with the old one kept (stopped,
// renamed) until the new one has provably started. Every step is recorded in the persistent
// transaction store, and every failure walks the ladder back:
//
//   stop old ──▶ rename old ──▶ create new ──▶ connect networks ──▶ start new ──▶ verify ──▶ remove old
//     │            │              │                                    │             │
//     └ untouched  └ restart old  └ rename back + restart old          └ remove new, rename back, restart old
//
// Used by: Update Now (updates/engine.js), container.recreate / edit / change_image / duplicate
// (containers/runners.js), and stack deployments (stacks/deployer.js). One ladder, one set of
// rollback guarantees, one place to fix.
import * as adapter from '../updates/recreateAdapter.js';
import * as txStore from '../updates/transaction.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {string} o.containerId     the full id of the container being replaced
 * @param {string} o.containerName   its current name (the replacement takes it)
 * @param {object} o.createBody      the allow-listed create body (containers/spec.js)
 * @param {Array}  o.auxiliaryNetworks [{name, endpointConfig}]
 * @param {string} [o.kind]          transaction kind for the store ('recreate' | 'update' | 'edit' | 'stack')
 * @param {boolean} [o.wasRunning]   start the replacement only if the original was running (default true)
 * @param {number} [o.verifyMs]      how long to wait for the replacement to be running
 * @param {function} [o.onStep]      (state) => void — progress callback
 * @param {object} [o.ops]           adapter override (tests)
 * @returns {Promise<{ok:true, newId:string, tx:object} | {ok:false, code:string, reason:string, tx:object, rolledBack:boolean}>}
 */
export async function recreateContainer({
  containerId, containerName, createBody, auxiliaryNetworks = [], kind = 'recreate', wasRunning = true,
  verifyMs = 8_000, stopTimeout = 15, onStep = null, ops = adapter, service = null, tx: existingTx = null,
}) {
  const originalName = String(containerName || '').replace(/^\//, '');
  const tempName = `${originalName}-old-${Date.now().toString(36)}`;
  // a caller with its own transaction record (Update Now) hands it in; the ladder continues it
  const tx = existingTx || {
    id: `tx-${containerId.slice(0, 12)}-${Date.now()}`,
    kind,
    containerId,
    service: service || originalName,
    state: 'pending',
    oldName: originalName,
    newId: null,
    startedAt: Date.now(),
  };
  tx.tempName = tempName;
  const step = (state) => { tx.state = state; txStore.saveTransaction(tx); try { onStep?.(state); } catch {} };
  const fail = (code, reason, rolledBack) => ({ ok: false, code, reason, tx, rolledBack });

  txStore.markContainerUpdating(containerId);
  if (originalName) txStore.markContainerUpdating(originalName);
  txStore.saveTransaction(tx);

  try {
    // 1 — stop the original (a stopped container answers 304, which the adapter maps to ok)
    step('stopping');
    const stopRes = await ops.stopContainer(containerId, { stopTimeout });
    if (!stopRes.ok) { step('failed'); return fail('stop_failed', 'The existing container could not be stopped; it was left untouched.', false); }

    // 2 — rename it out of the way
    step('renaming');
    const renameRes = await ops.renameContainer(containerId, tempName);
    if (!renameRes.ok) {
      if (wasRunning) await ops.startContainer(containerId).catch(() => {});
      step('rolled_back');
      return fail('rename_failed', 'The existing container could not be renamed; it was restored.', true);
    }

    // 3 — create the replacement under the original name
    step('creating');
    const createRes = await ops.createContainer(originalName, createBody);
    if (!createRes.ok || !createRes.id) {
      step('rolling_back');
      await ops.renameContainer(containerId, originalName).catch(() => {});
      if (wasRunning) await ops.startContainer(containerId).catch(() => {});
      step('rolled_back');
      return fail('create_failed', `The replacement container could not be created${createRes.detail ? ` (${createRes.detail})` : ''}; the previous container was restored.`, true);
    }
    const newId = createRes.id;
    tx.newId = newId;
    txStore.saveTransaction(tx);

    // 4 — auxiliary networks (a failure here is reported, not fatal: the primary network is in the create body)
    const netWarnings = [];
    for (const net of auxiliaryNetworks) {
      const r = await ops.connectNetwork(net.name, newId, net.endpointConfig).catch(() => ({ ok: false }));
      if (!r.ok) netWarnings.push(net.name);
    }

    // 5 — start (only if the original was running: recreating a stopped container keeps it stopped)
    if (wasRunning) {
      step('starting');
      const startRes = await ops.startContainer(newId);
      if (!startRes.ok) return await rollbackNew(ops, tx, containerId, newId, originalName, wasRunning, step, fail, 'start_failed', `The replacement container failed to start${startRes.detail ? ` (${startRes.detail})` : ''}; the previous container was restored.`);

      // 6 — verify: the replacement must be running (and not already dead) at the end of the window
      step('verifying');
      const deadline = Date.now() + verifyMs;
      let running = false;
      let lastState = null;
      while (Date.now() < deadline) {
        await sleep(Math.min(700, Math.max(100, verifyMs / 10)));
        const insp = await ops.inspectContainer(newId);
        lastState = insp.ok ? insp.data?.State : null;
        if (!insp.ok) continue;
        if (lastState?.Running === true && lastState?.Restarting !== true) { running = true; continue; }
        if (lastState?.Status === 'exited' || lastState?.Status === 'dead') { running = false; break; }
      }
      if (!running) return await rollbackNew(ops, tx, containerId, newId, originalName, wasRunning, step, fail, 'verification_failed', `The replacement container did not stay running${lastState?.ExitCode ? ` (exit code ${lastState.ExitCode})` : ''}; the previous container was restored.`);
    }

    // 7 — remove the old container. v=0: its volumes are the new container's volumes.
    step('removing_old');
    const del = await ops.deleteContainer(containerId, { force: true });
    step('completed');
    return { ok: true, newId, tx, warnings: [...netWarnings.map((n) => `network ${n} could not be attached`), ...(del.ok ? [] : [`the previous container (${tempName}) could not be removed and is still present, stopped`])] };
  } catch (err) {
    step('failed');
    return fail('engine_error', String(err?.message || err).slice(0, 200), false);
  } finally {
    txStore.unmarkContainerUpdating(containerId);
    if (originalName) txStore.unmarkContainerUpdating(originalName);
  }
}

async function rollbackNew(ops, tx, oldId, newId, originalName, wasRunning, step, fail, code, reason) {
  step('rolling_back');
  await ops.stopContainer(newId, { stopTimeout: 5 }).catch(() => {});
  await ops.deleteContainer(newId, { force: true }).catch(() => {});
  await ops.renameContainer(oldId, originalName).catch(() => {});
  if (wasRunning) await ops.startContainer(oldId).catch(() => {});
  step('rolled_back');
  return fail(code, reason, true);
}

/** Boot recovery: incomplete transactions, so the UI can say "recovery required" honestly. */
export function incompleteTransactions() {
  return txStore.getIncompleteTransactions();
}
