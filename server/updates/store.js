// Phase 10C — persistent update state store
// Persists container update records in DATA_DIR/updates/state.json
// Corruption-resistant with atomic write + temp rename, bounded in size.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../configStore.js';
import { makeUpdateRecord } from './model.js';
import { writeJsonAtomic } from '../lib/atomicFile.js';

const DIR = path.join(DATA_DIR, 'updates');
const FILE = path.join(DIR, 'state.json');
const MAX_RECORDS = 500;

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
}

function readRaw() {
  try {
    if (!fs.existsSync(FILE)) return { updates: [] };
    const text = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.updates)) {
      return { updates: [] };
    }
    return obj;
  } catch {
    return { updates: [] };
  }
}

function atomicWrite(obj) {
  ensureDir();
  writeJsonAtomic(FILE, obj);
}

export function listUpdates({ status = null, serviceId = null } = {}) {
  const items = readRaw().updates;
  return items.filter((item) => {
    if (status && item.status !== status) return false;
    if (serviceId && item.serviceId !== serviceId && item.containerId !== serviceId) return false;
    return true;
  });
}

export function getUpdate(containerOrServiceId) {
  if (!containerOrServiceId) return null;
  const items = readRaw().updates;
  const id = String(containerOrServiceId).toLowerCase();
  return items.find((item) =>
    item.containerId?.toLowerCase() === id ||
    (item.serviceId && item.serviceId.toLowerCase() === id)
  ) || null;
}

export function putUpdate(record) {
  const clean = makeUpdateRecord(record);
  ensureDir();
  const raw = readRaw();
  const idx = raw.updates.findIndex((item) =>
    item.containerId === clean.containerId ||
    (clean.serviceId && item.serviceId === clean.serviceId)
  );

  if (idx >= 0) {
    raw.updates[idx] = {
      ...raw.updates[idx],
      ...clean,
      // preserve first detectedAt if already known
      detectedAt: raw.updates[idx].detectedAt || clean.detectedAt,
    };
  } else {
    raw.updates.push(clean);
  }

  // bounded retention
  if (raw.updates.length > MAX_RECORDS) {
    raw.updates.sort((a, b) => (b.lastCheckedAt || 0) - (a.lastCheckedAt || 0));
    raw.updates = raw.updates.slice(0, MAX_RECORDS);
  }

  atomicWrite(raw);
  return clean;
}

export function removeUpdate(containerOrServiceId) {
  if (!containerOrServiceId) return false;
  ensureDir();
  const raw = readRaw();
  const id = String(containerOrServiceId).toLowerCase();
  const prevLen = raw.updates.length;
  raw.updates = raw.updates.filter((item) =>
    item.containerId?.toLowerCase() !== id &&
    (!item.serviceId || item.serviceId.toLowerCase() !== id)
  );
  if (raw.updates.length !== prevLen) {
    atomicWrite(raw);
    return true;
  }
  return false;
}

export function clearUpdates() {
  ensureDir();
  atomicWrite({ updates: [] });
}

export const UPDATES_FILE = FILE;
export const UPDATES_DIR = DIR;
