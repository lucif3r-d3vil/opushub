// Service manifests — the DATA the catalog is built from, and the schema that keeps it data.
//
// A manifest describes ONE container: its image and versions, the variables an operator fills
// in, and how those map onto the canonical container spec (containers/spec.js) plus the
// integrations OpusHub already has (monitoring, Autoheal, updates, reverse proxy). It cannot
// contain: hooks, scripts, shell, arbitrary Docker fields (only the allow-listed keys below are
// read; anything else is a schema error), host namespaces, privileged mode, security options,
// devices, or the Docker socket. `command`/`entrypoint` are argv arrays handed to Docker as the
// container's own process — OpusHub never runs them.
//
// Manifests are loaded once from server/catalog/manifests/*.json, validated, and rendered through
// the same policy classifier as everything else; a manifest whose *fixed* configuration is
// BLOCKED never appears in the catalog.
import fs from 'node:fs';
import path from 'node:path';
import { referencesOf } from './template.js';

export const MANIFEST_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'manifests');
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
export const REPO_RE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{2,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
export const CATEGORIES = Object.freeze(['media', 'productivity', 'security', 'monitoring', 'developer', 'networking', 'database', 'storage', 'home', 'utilities']);
export const VARIABLE_KINDS = Object.freeze(['string', 'secret', 'number', 'boolean', 'enum', 'port', 'path', 'timezone']);
export const BUILTIN_VARS = Object.freeze(['name']);
const MAX_MANIFEST_BYTES = 64 * 1024;

const TOP_KEYS = ['schema', 'id', 'name', 'summary', 'description', 'category', 'tags', 'icon', 'homepage', 'docs', 'image', 'container', 'variables', 'env', 'ports', 'volumes', 'network', 'healthcheck', 'restartPolicy', 'proxy', 'monitoring', 'autoheal', 'updates', 'labels', 'notes'];
const IMAGE_KEYS = ['repository', 'versions', 'allowCustomTag', 'allowDigest'];
const CONTAINER_KEYS = ['command', 'entrypoint', 'user', 'workingDir', 'hostname', 'init', 'tty', 'stdinOpen', 'readOnlyRootfs', 'capabilities', 'stopSignal', 'stopTimeout'];
const VARIABLE_KEYS = ['key', 'label', 'description', 'kind', 'required', 'default', 'options', 'min', 'max', 'pattern', 'generate', 'advanced'];
const PORT_KEYS = ['container', 'protocol', 'host', 'label', 'required'];
const VOLUME_KEYS = ['target', 'label', 'description', 'default', 'readOnly', 'allowBind'];
const HEALTH_KEYS = ['test', 'intervalMs', 'timeoutMs', 'retries', 'startPeriodMs'];
const PROXY_KEYS = ['port', 'scheme', 'default'];
const MONITORING_KEYS = ['type', 'path', 'expectStatus', 'default'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 512) => typeof v === 'string' && v.length <= max;
const strList = (v, max, len = 256) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= len);

/**
 * Validate one manifest document. Returns `{ ok, manifest, errors }` where `manifest` is a
 * frozen, normalized copy (only allow-listed keys, defaults filled).
 */
export function validateManifest(doc) {
  const errors = [];
  const err = (m) => { if (errors.length < 40) errors.push(m); };
  if (!isObj(doc)) return { ok: false, manifest: null, errors: ['manifest must be an object'] };
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) err(`unknown key "${k}" — manifests are data; only the documented keys are read`);
  if (doc.schema !== undefined && doc.schema !== 1) err('schema must be 1');
  if (!str(doc.id, 64) || !ID_RE.test(doc.id)) err('id must be lowercase letters, digits and "-"');
  if (!str(doc.name, 80) || !doc.name.trim()) err('name is required');
  if (!str(doc.summary, 200)) err('summary is required (≤200 chars)');
  if (doc.description !== undefined && !str(doc.description, 4000)) err('description too long');
  if (!CATEGORIES.includes(doc.category)) err(`category must be one of ${CATEGORIES.join(', ')}`);
  if (doc.tags !== undefined && !strList(doc.tags, 12, 32)) err('tags must be ≤12 short strings');
  for (const k of ['icon']) if (doc[k] !== undefined && !(str(doc[k], 200) && /^[a-z0-9][a-z0-9-]*$/.test(doc[k]))) err(`${k} must be an icon slug`);
  for (const k of ['homepage', 'docs']) if (doc[k] !== undefined && !(str(doc[k], 300) && /^https:\/\/[^\s]+$/.test(doc[k]))) err(`${k} must be an https URL`);
  if (doc.notes !== undefined && !strList(doc.notes, 10, 400)) err('notes must be ≤10 strings');

  // image
  const img = doc.image;
  if (!isObj(img)) err('image is required');
  else {
    for (const k of Object.keys(img)) if (!IMAGE_KEYS.includes(k)) err(`image.${k} is not a manifest key`);
    if (!str(img.repository, 255) || !REPO_RE.test(img.repository)) err('image.repository must be a registry repository (no tag, no digest)');
    if (!Array.isArray(img.versions) || !img.versions.length || img.versions.length > 40) err('image.versions must list 1–40 versions');
    else img.versions.forEach((v, i) => {
      if (!isObj(v) || !str(v.tag, 128) || !TAG_RE.test(v.tag)) err(`image.versions[${i}].tag is not a tag`);
      for (const k of Object.keys(v || {})) if (!['tag', 'label', 'recommended', 'notes'].includes(k)) err(`image.versions[${i}].${k} is not a manifest key`);
    });
  }

  // variables
  const vars = new Map();
  if (doc.variables !== undefined) {
    if (!Array.isArray(doc.variables) || doc.variables.length > 60) err('variables must be a list of ≤60');
    else doc.variables.forEach((v, i) => {
      const at = `variables[${i}]`;
      if (!isObj(v)) { err(`${at} must be an object`); return; }
      for (const k of Object.keys(v)) if (!VARIABLE_KEYS.includes(k)) err(`${at}.${k} is not a manifest key`);
      if (!str(v.key, 64) || !VAR_KEY_RE.test(v.key) || BUILTIN_VARS.includes(v.key)) err(`${at}.key is not a valid variable name`);
      else if (vars.has(v.key)) err(`${at}: duplicate variable ${v.key}`);
      if (!VARIABLE_KINDS.includes(v.kind)) err(`${at}.kind must be one of ${VARIABLE_KINDS.join(', ')}`);
      if (v.label !== undefined && !str(v.label, 80)) err(`${at}.label too long`);
      if (v.description !== undefined && !str(v.description, 400)) err(`${at}.description too long`);
      if (v.kind === 'enum' && !strList(v.options, 40, 64)) err(`${at}.options required for enum`);
      if (v.pattern !== undefined) { if (!str(v.pattern, 200)) err(`${at}.pattern too long`); else try { new RegExp(v.pattern); } catch { err(`${at}.pattern is not a regular expression`); } }
      if (v.generate !== undefined && !['password', 'hex'].includes(v.generate)) err(`${at}.generate must be password or hex`);
      if (v.generate !== undefined && v.kind !== 'secret') err(`${at}.generate is only for secrets`);
      if (v.default !== undefined && !['string', 'number', 'boolean'].includes(typeof v.default)) err(`${at}.default must be a scalar`);
      if (v.default !== undefined && referencesOf(String(v.default)).size) err(`${at}.default must not reference other variables`);
      if (str(v.key, 64)) vars.set(v.key, v);
    });
  }
  const known = new Set([...vars.keys(), ...BUILTIN_VARS]);
  const checkRefs = (value, at) => {
    const refs = typeof value === 'string' ? referencesOf(value) : new Set();
    for (const r of refs) if (!known.has(r)) err(`${at} references undeclared variable ${r}`);
  };

  // env
  if (doc.env !== undefined) {
    if (!isObj(doc.env) || Object.keys(doc.env).length > 200) err('env must be an object of ≤200 entries');
    else for (const [k, v] of Object.entries(doc.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(k)) err(`env key ${k.slice(0, 40)} is not valid`);
      if (!['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 4096) err(`env.${k} must be a scalar`);
      else checkRefs(String(v), `env.${k}`);
    }
  }

  // container
  if (doc.container !== undefined) {
    if (!isObj(doc.container)) err('container must be an object');
    else {
      const c = doc.container;
      for (const k of Object.keys(c)) if (!CONTAINER_KEYS.includes(k)) err(`container.${k} is not allowed in a manifest`);
      for (const k of ['command', 'entrypoint']) if (c[k] !== undefined && c[k] !== null && !strList(c[k], 64, 1024)) err(`container.${k} must be an argv list`);
      for (const k of ['command', 'entrypoint']) if (Array.isArray(c[k])) c[k].forEach((a, i) => checkRefs(a, `container.${k}[${i}]`));
      for (const k of ['user', 'workingDir', 'hostname', 'stopSignal']) if (c[k] !== undefined && !str(c[k], 256)) err(`container.${k} must be a string`);
      if (c.user !== undefined) checkRefs(c.user, 'container.user');
      for (const k of ['init', 'tty', 'stdinOpen', 'readOnlyRootfs']) if (c[k] !== undefined && typeof c[k] !== 'boolean') err(`container.${k} must be boolean`);
      if (c.stopTimeout !== undefined && !(Number.isInteger(c.stopTimeout) && c.stopTimeout >= 0 && c.stopTimeout <= 600)) err('container.stopTimeout must be 0–600');
      if (c.capabilities !== undefined) {
        if (!isObj(c.capabilities)) err('container.capabilities must be {add, drop}');
        else for (const k of Object.keys(c.capabilities)) { if (!['add', 'drop'].includes(k)) err(`container.capabilities.${k}`); else if (!strList(c.capabilities[k], 40, 32)) err(`container.capabilities.${k} must be a list`); }
      }
    }
  }

  // ports
  if (doc.ports !== undefined) {
    if (!Array.isArray(doc.ports) || doc.ports.length > 40) err('ports must be a list of ≤40');
    else doc.ports.forEach((p, i) => {
      const at = `ports[${i}]`;
      if (!isObj(p)) { err(`${at} must be an object`); return; }
      for (const k of Object.keys(p)) if (!PORT_KEYS.includes(k)) err(`${at}.${k} is not a manifest key`);
      if (!(Number.isInteger(p.container) && p.container >= 1 && p.container <= 65535)) err(`${at}.container must be a port`);
      if (p.protocol !== undefined && !['tcp', 'udp'].includes(p.protocol)) err(`${at}.protocol must be tcp or udp`);
      if (p.host !== undefined && p.host !== null && !(Number.isInteger(p.host) && p.host >= 1 && p.host <= 65535) && !(typeof p.host === 'string' && referencesOf(p.host).size === 1 && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(p.host))) err(`${at}.host must be a port, null, or a single \${variable}`);
      if (typeof p.host === 'string') checkRefs(p.host, `${at}.host`);
      if (p.label !== undefined && !str(p.label, 80)) err(`${at}.label too long`);
    });
  }

  // volumes
  if (doc.volumes !== undefined) {
    if (!Array.isArray(doc.volumes) || doc.volumes.length > 30) err('volumes must be a list of ≤30');
    else doc.volumes.forEach((v, i) => {
      const at = `volumes[${i}]`;
      if (!isObj(v)) { err(`${at} must be an object`); return; }
      for (const k of Object.keys(v)) if (!VOLUME_KEYS.includes(k)) err(`${at}.${k} is not a manifest key`);
      if (!str(v.target, 1024) || !/^\/[^\0:]{0,1023}$/.test(v.target)) err(`${at}.target must be an absolute container path`);
      if (v.default !== undefined && !(str(v.default, 255) && /^(volume:[A-Za-z0-9_.${}-]{1,120}|\/[^\0]{0,1023})$/.test(v.default))) err(`${at}.default must be "volume:<name>" or an absolute host path`);
      if (typeof v.default === 'string') checkRefs(v.default, `${at}.default`);
      if (v.readOnly !== undefined && typeof v.readOnly !== 'boolean') err(`${at}.readOnly must be boolean`);
      if (v.allowBind !== undefined && typeof v.allowBind !== 'boolean') err(`${at}.allowBind must be boolean`);
    });
  }

  if (doc.network !== undefined) {
    if (!isObj(doc.network)) err('network must be an object');
    else { for (const k of Object.keys(doc.network)) if (!['default', 'aliases'].includes(k)) err(`network.${k} is not a manifest key`); if (doc.network.default !== undefined && !['bridge', 'dedicated'].includes(doc.network.default)) err('network.default must be bridge or dedicated'); if (doc.network.aliases !== undefined && !strList(doc.network.aliases, 4, 63)) err('network.aliases must be ≤4 DNS labels'); }
  }

  if (doc.healthcheck !== undefined && doc.healthcheck !== null) {
    const h = doc.healthcheck;
    if (!isObj(h)) err('healthcheck must be an object or null');
    else {
      for (const k of Object.keys(h)) if (!HEALTH_KEYS.includes(k)) err(`healthcheck.${k} is not a manifest key`);
      if (!strList(h.test, 32, 2048) || !h.test.length || !['CMD', 'CMD-SHELL'].includes(h.test[0])) err('healthcheck.test must be ["CMD"|"CMD-SHELL", ...] (run by Docker inside the container)');
      for (const k of ['intervalMs', 'timeoutMs', 'startPeriodMs']) if (h[k] !== undefined && !(Number.isInteger(h[k]) && h[k] >= 1000 && h[k] <= 3_600_000)) err(`healthcheck.${k} must be 1000–3600000`);
      if (h.retries !== undefined && !(Number.isInteger(h.retries) && h.retries >= 1 && h.retries <= 20)) err('healthcheck.retries must be 1–20');
    }
  }
  if (doc.restartPolicy !== undefined && !['no', 'always', 'unless-stopped', 'on-failure'].includes(doc.restartPolicy)) err('restartPolicy is not a Docker restart policy');
  if (doc.proxy !== undefined) {
    if (!isObj(doc.proxy)) err('proxy must be an object');
    else {
      for (const k of Object.keys(doc.proxy)) if (!PROXY_KEYS.includes(k)) err(`proxy.${k} is not a manifest key`);
      if (!(Number.isInteger(doc.proxy.port) && doc.proxy.port >= 1 && doc.proxy.port <= 65535)) err('proxy.port must be the container port the proxy forwards to');
      if (doc.proxy.scheme !== undefined && !['http', 'https'].includes(doc.proxy.scheme)) err('proxy.scheme must be http or https');
      if (doc.proxy.default !== undefined && typeof doc.proxy.default !== 'boolean') err('proxy.default must be boolean');
    }
  }
  if (doc.monitoring !== undefined) {
    if (!isObj(doc.monitoring)) err('monitoring must be an object');
    else {
      for (const k of Object.keys(doc.monitoring)) if (!MONITORING_KEYS.includes(k)) err(`monitoring.${k} is not a manifest key`);
      if (doc.monitoring.type !== undefined && !['docker', 'http'].includes(doc.monitoring.type)) err('monitoring.type must be docker or http');
      if (doc.monitoring.path !== undefined && !(str(doc.monitoring.path, 200) && /^\/[^\s?#]*$/.test(doc.monitoring.path))) err('monitoring.path must be an absolute URL path');
      if (doc.monitoring.expectStatus !== undefined && !(Number.isInteger(doc.monitoring.expectStatus) && doc.monitoring.expectStatus >= 100 && doc.monitoring.expectStatus <= 599)) err('monitoring.expectStatus');
      if (doc.monitoring.default !== undefined && typeof doc.monitoring.default !== 'boolean') err('monitoring.default must be boolean');
    }
  }
  for (const k of ['autoheal', 'updates']) if (doc[k] !== undefined && !(isObj(doc[k]) && Object.keys(doc[k]).every((x) => x === 'default') && (doc[k].default === undefined || typeof doc[k].default === 'boolean'))) err(`${k} must be { default: boolean }`);
  if (doc.labels !== undefined) {
    if (!isObj(doc.labels) || Object.keys(doc.labels).length > 40) err('labels must be an object of ≤40');
    else for (const [k, v] of Object.entries(doc.labels)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(k)) err(`label ${k.slice(0, 40)} is not valid`);
      if (/^(traefik|autoheal|diun|io\.opushub|com\.docker|opushub\.update)/.test(k)) err(`label ${k} is managed by OpusHub and may not be fixed by a manifest`);
      if (!str(v, 1024)) err(`label ${k} must be a string`);
      else checkRefs(v, `labels.${k}`);
    }
  }

  if (errors.length) return { ok: false, manifest: null, errors };
  const manifest = deepFreeze({
    schema: 1,
    id: doc.id, name: doc.name.trim(), summary: doc.summary, description: doc.description || '', category: doc.category,
    tags: doc.tags || [], icon: doc.icon || null, homepage: doc.homepage || null, docs: doc.docs || null, notes: doc.notes || [],
    image: { repository: img.repository, versions: img.versions.map((v) => ({ tag: v.tag, label: v.label || v.tag, recommended: v.recommended === true, notes: v.notes || null })), allowCustomTag: img.allowCustomTag === true, allowDigest: img.allowDigest === true },
    container: { ...(doc.container || {}) },
    variables: (doc.variables || []).map((v) => ({ key: v.key, label: v.label || v.key, description: v.description || '', kind: v.kind, required: v.required === true, default: v.default ?? null, options: v.options || null, min: v.min ?? null, max: v.max ?? null, pattern: v.pattern || null, generate: v.generate || null, advanced: v.advanced === true })),
    env: { ...(doc.env || {}) },
    ports: (doc.ports || []).map((p) => ({ container: p.container, protocol: p.protocol || 'tcp', host: p.host === undefined ? null : p.host, label: p.label || `port ${p.container}`, required: p.required === true })),
    volumes: (doc.volumes || []).map((v) => ({ target: v.target, label: v.label || v.target, description: v.description || '', default: v.default || 'volume:${name}-data', readOnly: v.readOnly === true, allowBind: v.allowBind !== false })),
    network: { default: doc.network?.default || 'bridge', aliases: doc.network?.aliases || [] },
    healthcheck: doc.healthcheck ? { test: doc.healthcheck.test, intervalMs: doc.healthcheck.intervalMs ?? 30_000, timeoutMs: doc.healthcheck.timeoutMs ?? 10_000, retries: doc.healthcheck.retries ?? 3, startPeriodMs: doc.healthcheck.startPeriodMs ?? 30_000 } : null,
    restartPolicy: doc.restartPolicy || 'unless-stopped',
    proxy: doc.proxy ? { port: doc.proxy.port, scheme: doc.proxy.scheme || 'http', default: doc.proxy.default === true } : null,
    monitoring: doc.monitoring ? { type: doc.monitoring.type || 'docker', path: doc.monitoring.path || '/', expectStatus: doc.monitoring.expectStatus ?? null, default: doc.monitoring.default !== false } : { type: 'docker', path: '/', expectStatus: null, default: true },
    autoheal: { default: doc.autoheal?.default === true },
    updates: { default: doc.updates?.default !== false },
    labels: { ...(doc.labels || {}) },
  });
  return { ok: true, manifest, errors: [] };
}

function deepFreeze(o) { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; }

/* ------------------------------------------------------------------ */
/* the bundled catalog                                                 */
/* ------------------------------------------------------------------ */

let loaded = null;

/** Load (once) every manifest in the manifests directory. Invalid ones are reported, not served. */
export function loadManifests({ dir = MANIFEST_DIR, force = false } = {}) {
  if (loaded && !force) return loaded;
  const manifests = new Map();
  const problems = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { files = []; }
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      if (st.size > MAX_MANIFEST_BYTES) { problems.push({ file: f, errors: ['manifest larger than 64 KiB'] }); continue; }
      const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
      const v = validateManifest(doc);
      if (!v.ok) { problems.push({ file: f, errors: v.errors }); continue; }
      if (manifests.has(v.manifest.id)) { problems.push({ file: f, errors: [`duplicate id ${v.manifest.id}`] }); continue; }
      manifests.set(v.manifest.id, v.manifest);
    } catch (e) { problems.push({ file: f, errors: [String(e?.message || e)] }); }
  }
  loaded = { manifests, problems, loadedAt: Date.now() };
  return loaded;
}

export function getManifest(id) { return loadManifests().manifests.get(String(id || '')) || null; }
export function listManifests() { return [...loadManifests().manifests.values()]; }
export function _resetManifests() { loaded = null; }
