// Phase 10B — notification policy (simple allow-list, no rule language)
//
// One policy document governs every channel: the global gates (enabled, minSeverity,
// allowedTypes, allowedSources) apply to all of them, and each channel adds its own
// enabled flag, its own minimum severity, and its own type/source allow-lists. Both
// levels must pass — the effective severity threshold is the STRICTER of the global
// and the channel minimum, and a type/source must be allowed by both levels. There is
// no separate per-provider filtering system; Telegram, webhook, browser and in-app all
// share this model.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../configStore.js';
import { writeJsonAtomic } from '../lib/atomicFile.js';
// The severity vocabulary and its rank order are owned by the canonical event model —
// notification filtering compares the same words, never a re-declared copy.
import { SEVERITIES, SEVERITY_ORDER as ORDER } from '../events/model.js';

const DIR = path.join(DATA_DIR, 'notifications');
const FILE = path.join(DIR, 'policy.json');

const DEFAULT_CHANNEL = Object.freeze({
  enabled: false,
  minSeverity: 'warning',
  allowedTypes: [],
  allowedSources: [],
});

const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  minSeverity: 'info', // info, notice, warning, critical
  allowedTypes: [], // empty = all
  allowedSources: [], // empty = all
  browser: {
    enabled: false,
    minSeverity: 'warning',
    allowedTypes: [],
    allowedSources: [],
  },
  webhook: {
    enabled: false,
    minSeverity: 'warning',
    allowedTypes: [],
    allowedSources: [],
  },
  // Phase 10B completion — Telegram is an outbound provider like webhook: same model,
  // same gates, no private filtering language.
  telegram: {
    enabled: false,
    minSeverity: 'warning',
    allowedTypes: [],
    allowedSources: [],
  },
  inApp: {
    enabled: true,
    minSeverity: 'info',
    allowedTypes: [],
    allowedSources: [],
  },
});

const CHANNELS = ['browser', 'webhook', 'telegram', 'inApp'];

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
}

function cleanTypes(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((t) => typeof t === 'string' && t.length > 0 && t.length <= 80).slice(0, 100);
}

function cleanSources(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((s) => typeof s === 'string' && s.length > 0 && s.length <= 40).slice(0, 20);
}

function normalizeChannel(raw, fallback) {
  const out = {
    enabled: fallback.enabled,
    minSeverity: fallback.minSeverity,
    allowedTypes: [...(fallback.allowedTypes || [])],
    allowedSources: [...(fallback.allowedSources || [])],
  };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (typeof raw.minSeverity === 'string' && SEVERITIES.includes(raw.minSeverity)) {
    out.minSeverity = raw.minSeverity;
  }
  if (Array.isArray(raw.allowedTypes)) out.allowedTypes = cleanTypes(raw.allowedTypes);
  if (Array.isArray(raw.allowedSources)) out.allowedSources = cleanSources(raw.allowedSources);
  return out;
}

function readRaw() {
  try {
    if (!fs.existsSync(FILE)) return structuredClone(DEFAULT_POLICY);
    const text = fs.readFileSync(FILE, 'utf8');
    const obj = JSON.parse(text);
    return normalize(obj);
  } catch {
    return structuredClone(DEFAULT_POLICY);
  }
}

function normalize(obj) {
  const out = structuredClone(DEFAULT_POLICY);
  if (!obj || typeof obj !== 'object') return out;
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  if (typeof obj.minSeverity === 'string' && SEVERITIES.includes(obj.minSeverity)) {
    out.minSeverity = obj.minSeverity;
  }
  if (Array.isArray(obj.allowedTypes)) out.allowedTypes = cleanTypes(obj.allowedTypes);
  if (Array.isArray(obj.allowedSources)) out.allowedSources = cleanSources(obj.allowedSources);
  for (const ch of CHANNELS) {
    out[ch] = normalizeChannel(obj[ch], DEFAULT_POLICY[ch]);
  }
  return out;
}

function atomicWrite(obj) {
  ensureDir();
  writeJsonAtomic(FILE, obj);
}

export function getPolicy() {
  return readRaw();
}

export function putPolicy(patch) {
  const current = readRaw();
  const merged = { ...current, ...(patch || {}) };
  for (const ch of CHANNELS) {
    merged[ch] = { ...current[ch], ...((patch && patch[ch]) || {}) };
  }
  const next = normalize(merged);
  // Explicit empty arrays are meaningful ("allow all") and must survive the merge above,
  // which would otherwise keep the previous list when the caller cleared it.
  if (patch && Object.hasOwn(patch, 'allowedTypes')) next.allowedTypes = cleanTypes(patch.allowedTypes);
  if (patch && Object.hasOwn(patch, 'allowedSources')) next.allowedSources = cleanSources(patch.allowedSources);
  for (const ch of CHANNELS) {
    if (patch?.[ch] && Object.hasOwn(patch[ch], 'allowedTypes')) next[ch].allowedTypes = cleanTypes(patch[ch].allowedTypes);
    if (patch?.[ch] && Object.hasOwn(patch[ch], 'allowedSources')) next[ch].allowedSources = cleanSources(patch[ch].allowedSources);
  }
  atomicWrite(next);
  return next;
}

export function shouldNotify(event, channel = 'inApp') {
  const policy = getPolicy();
  if (!policy.enabled) return false;
  const channelPolicy = policy[channel];
  if (channelPolicy && channelPolicy.enabled === false) return false;

  // Severity: the effective threshold is the stricter of global and channel.
  const eventOrder = ORDER[event.severity] ?? 0;
  const globalMin = ORDER[policy.minSeverity] ?? 0;
  if (eventOrder < globalMin) return false;
  if (channelPolicy && channelPolicy.minSeverity) {
    const channelMin = ORDER[channelPolicy.minSeverity] ?? 0;
    if (eventOrder < channelMin) return false;
  }

  // Type/source: both the global and the channel allow-list must pass (empty = all).
  if (policy.allowedTypes.length && !policy.allowedTypes.includes(event.type)) return false;
  if (policy.allowedSources.length && !policy.allowedSources.includes(event.source)) return false;
  if (channelPolicy?.allowedTypes?.length && !channelPolicy.allowedTypes.includes(event.type)) return false;
  if (channelPolicy?.allowedSources?.length && !channelPolicy.allowedSources.includes(event.source)) return false;

  return true;
}

export function shouldCreateInApp(event) {
  return shouldNotify(event, 'inApp');
}

export function shouldSendWebhook(event) {
  return shouldNotify(event, 'webhook');
}

export function shouldSendTelegram(event) {
  return shouldNotify(event, 'telegram');
}

export function shouldSendBrowser(event) {
  return shouldNotify(event, 'browser');
}

export const POLICY_FILE = FILE;
export const POLICY_CHANNELS = CHANNELS;
