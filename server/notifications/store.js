// Phase 10B — notification persistence (bounded, atomic, corruption-resistant)

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../configStore.js';

const DIR = path.join(DATA_DIR, 'notifications');
const FILE = path.join(DIR, 'notifications.json');
const MAX = 1000;
const KEEP = 800;

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
}

function readRaw() {
  try {
    if (!fs.existsSync(FILE)) return { notifications: [] };
    const text = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return { notifications: [] };
    if (!Array.isArray(obj.notifications)) return { notifications: [] };
    return obj;
  } catch {
    return { notifications: [] };
  }
}

function atomicWrite(obj) {
  ensureDir();
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
}

export function listNotifications({ limit = 100, unreadOnly = false, severity = null, source = null, before = null } = {}) {
  let items = readRaw().notifications.slice();
  // sort newest first
  items.sort((a, b) => (b.t || 0) - (a.t || 0));
  if (unreadOnly) items = items.filter((n) => !n.read);
  if (severity) {
    const order = { info: 0, notice: 1, warning: 2, critical: 3 };
    const min = order[severity] ?? 0;
    items = items.filter((n) => (order[n.severity] ?? 0) >= min);
  }
  if (source) items = items.filter((n) => n.source === source);
  if (before != null) items = items.filter((n) => (n.t || 0) < before);
  if (limit != null) items = items.slice(0, limit);
  return items;
}

export function getNotification(id) {
  if (!id) return null;
  const all = readRaw().notifications;
  return all.find((n) => n.id === id) || null;
}

export function addNotification(notif) {
  if (!notif || !notif.id) return null;
  ensureDir();
  const raw = readRaw();
  // idempotency by eventId: don't duplicate same event
  if (notif.eventId && raw.notifications.some((n) => n.eventId === notif.eventId)) {
    return raw.notifications.find((n) => n.eventId === notif.eventId);
  }
  raw.notifications.push(notif);
  // trim if over MAX
  if (raw.notifications.length > MAX) {
    // sort by t ascending, keep newest KEEP
    raw.notifications.sort((a, b) => (a.t || 0) - (b.t || 0));
    // preserve unread? Spec says bounded, but we should not lose unread if possible.
    // Simple: keep newest KEEP, but if unread would be dropped, keep them by prioritizing unread
    // For determinism, we keep newest KEEP regardless, as unread is expected to be marked.
    raw.notifications = raw.notifications.slice(-KEEP);
  }
  atomicWrite(raw);
  return notif;
}

export function markRead(id) {
  const raw = readRaw();
  const idx = raw.notifications.findIndex((n) => n.id === id);
  if (idx < 0) return null;
  raw.notifications[idx].read = true;
  raw.notifications[idx].readAt = Date.now();
  atomicWrite(raw);
  return raw.notifications[idx];
}

export function markAllRead() {
  const raw = readRaw();
  let changed = 0;
  const now = Date.now();
  for (const n of raw.notifications) {
    if (!n.read) {
      n.read = true;
      n.readAt = now;
      changed++;
    }
  }
  if (changed) atomicWrite(raw);
  return { changed, total: raw.notifications.length };
}

export function unreadCount() {
  const all = readRaw().notifications;
  return all.filter((n) => !n.read).length;
}

export function clearAll() {
  try {
    ensureDir();
    atomicWrite({ notifications: [] });
  } catch {}
}

export function stats() {
  try {
    if (!fs.existsSync(FILE)) return { count: 0, unread: 0, bytes: 0 };
    const st = fs.statSync(FILE);
    const raw = readRaw();
    return { count: raw.notifications.length, unread: raw.notifications.filter((n) => !n.read).length, bytes: st.size, file: FILE };
  } catch {
    return { count: 0, unread: 0, bytes: 0, file: FILE };
  }
}

export const NOTIFICATIONS_FILE = FILE;
export const NOTIFICATIONS_DIR = DIR;
