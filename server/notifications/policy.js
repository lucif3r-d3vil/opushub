// Phase 10B — notification policy (simple allow-list, no rule language)

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../configStore.js';

const DIR = path.join(DATA_DIR, 'notifications');
const FILE = path.join(DIR, 'policy.json');

const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  minSeverity: 'info', // info, notice, warning, critical
  allowedTypes: [], // empty = all
  allowedSources: [], // empty = all
  browser: {
    enabled: false,
    minSeverity: 'warning',
  },
  webhook: {
    enabled: false,
    minSeverity: 'warning',
  },
  inApp: {
    enabled: true,
    minSeverity: 'info',
  },
});

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
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
  if (typeof obj.minSeverity === 'string' && ['info', 'notice', 'warning', 'critical'].includes(obj.minSeverity)) {
    out.minSeverity = obj.minSeverity;
  }
  if (Array.isArray(obj.allowedTypes)) {
    out.allowedTypes = obj.allowedTypes.filter((t) => typeof t === 'string' && t.length <= 80).slice(0, 100);
  }
  if (Array.isArray(obj.allowedSources)) {
    out.allowedSources = obj.allowedSources.filter((s) => typeof s === 'string' && s.length <= 40).slice(0, 20);
  }
  if (obj.browser && typeof obj.browser === 'object') {
    if (typeof obj.browser.enabled === 'boolean') out.browser.enabled = obj.browser.enabled;
    if (typeof obj.browser.minSeverity === 'string' && ['info', 'notice', 'warning', 'critical'].includes(obj.browser.minSeverity)) {
      out.browser.minSeverity = obj.browser.minSeverity;
    }
  }
  if (obj.webhook && typeof obj.webhook === 'object') {
    if (typeof obj.webhook.enabled === 'boolean') out.webhook.enabled = obj.webhook.enabled;
    if (typeof obj.webhook.minSeverity === 'string' && ['info', 'notice', 'warning', 'critical'].includes(obj.webhook.minSeverity)) {
      out.webhook.minSeverity = obj.webhook.minSeverity;
    }
  }
  if (obj.inApp && typeof obj.inApp === 'object') {
    if (typeof obj.inApp.enabled === 'boolean') out.inApp.enabled = obj.inApp.enabled;
    if (typeof obj.inApp.minSeverity === 'string' && ['info', 'notice', 'warning', 'critical'].includes(obj.inApp.minSeverity)) {
      out.inApp.minSeverity = obj.inApp.minSeverity;
    }
  }
  return out;
}

function atomicWrite(obj) {
  ensureDir();
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
}

export function getPolicy() {
  return readRaw();
}

export function putPolicy(patch) {
  const current = readRaw();
  const next = normalize({ ...current, ...patch,
    browser: { ...current.browser, ...(patch?.browser || {}) },
    webhook: { ...current.webhook, ...(patch?.webhook || {}) },
    inApp: { ...current.inApp, ...(patch?.inApp || {}) },
  });
  // special handling for allowedTypes/allowedSources if explicitly set
  if (patch && Object.hasOwn(patch, 'allowedTypes')) {
    next.allowedTypes = Array.isArray(patch.allowedTypes) ? patch.allowedTypes.filter((t) => typeof t === 'string').slice(0, 100) : [];
  }
  if (patch && Object.hasOwn(patch, 'allowedSources')) {
    next.allowedSources = Array.isArray(patch.allowedSources) ? patch.allowedSources.filter((s) => typeof s === 'string').slice(0, 20) : [];
  }
  atomicWrite(next);
  return next;
}

const ORDER = { info: 0, notice: 1, warning: 2, critical: 3 };

export function shouldNotify(event, channel = 'inApp') {
  const policy = getPolicy();
  if (!policy.enabled) return false;
  const channelPolicy = policy[channel];
  if (channelPolicy && channelPolicy.enabled === false) return false;

  const minSev = (channelPolicy && channelPolicy.minSeverity) || policy.minSeverity;
  const eventOrder = ORDER[event.severity] ?? 0;
  const minOrder = ORDER[minSev] ?? 0;
  if (eventOrder < minOrder) return false;

  if (policy.allowedTypes.length && !policy.allowedTypes.includes(event.type)) return false;
  if (policy.allowedSources.length && !policy.allowedSources.includes(event.source)) return false;

  return true;
}

export function shouldCreateInApp(event) {
  return shouldNotify(event, 'inApp');
}

export function shouldSendWebhook(event) {
  return shouldNotify(event, 'webhook');
}

export function shouldSendBrowser(event) {
  return shouldNotify(event, 'browser');
}

export const POLICY_FILE = FILE;
