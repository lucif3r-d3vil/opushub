// Phase 10C — Update Transaction Manager & State Machine
// Manages the state machine for container recreate/update lifecycle with crash recovery persistence.
//
// TRANSACTION STATES:
// - pending
// - pulling
// - inspecting
// - stopping
// - renaming
// - creating
// - starting
// - verifying
// - completed
// - rolling_back
// - rolled_back
// - recovery_required
// - failed

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../configStore.js';

const TX_DIR = path.join(DATA_DIR, 'updates');
const TX_FILE = path.join(TX_DIR, 'transactions.json');

function ensureDir() {
  try { fs.mkdirSync(TX_DIR, { recursive: true }); } catch {}
}

function readAllTx() {
  try {
    if (!fs.existsSync(TX_FILE)) return {};
    const text = fs.readFileSync(TX_FILE, 'utf8');
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function writeAllTx(data) {
  ensureDir();
  const tmp = `${TX_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, TX_FILE);
}

export function saveTransaction(tx) {
  if (!tx || !tx.id) return;
  const all = readAllTx();
  all[tx.id] = {
    ...tx,
    updatedAt: Date.now(),
  };
  writeAllTx(all);
}

export function getTransaction(id) {
  const all = readAllTx();
  return all[id] || null;
}

export function getIncompleteTransactions() {
  const all = readAllTx();
  const incomplete = [];
  const terminal = new Set(['completed', 'rolled_back', 'failed']);
  for (const [id, tx] of Object.entries(all)) {
    if (!terminal.has(tx.state)) {
      incomplete.push(tx);
    }
  }
  return incomplete;
}

export function clearTransaction(id) {
  const all = readAllTx();
  if (all[id]) {
    delete all[id];
    writeAllTx(all);
  }
}

// In-memory set of actively updating container IDs (narrowly scoped Autoheal suppression window)
const activeUpdatingContainers = new Set();

export function markContainerUpdating(containerId) {
  if (containerId) activeUpdatingContainers.add(String(containerId).toLowerCase());
}

export function unmarkContainerUpdating(containerId) {
  if (containerId) activeUpdatingContainers.delete(String(containerId).toLowerCase());
}

export function isContainerUpdating(containerId) {
  if (!containerId) return false;
  return activeUpdatingContainers.has(String(containerId).toLowerCase());
}
