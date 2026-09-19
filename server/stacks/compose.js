// Compose documents are DATA.
//
// This module turns a Compose YAML text into the canonical stack model OpusHub deploys natively
// through the Engine API: one canonical container spec (containers/spec.js — the same allow-list
// the editor uses) per service, plus the project networks and volumes. Nothing in the document is
// ever executed: there is no shell, no `docker compose`, no file read. Relative bind paths,
// `env_file`, `build`, `configs`, `secrets`, `extends`, `include` and anything else that needs a
// project directory or a code path OpusHub does not have are reported as UNSUPPORTED and the
// policy classifier turns them into BLOCKED findings — the deployment is refused, not guessed.
//
// Variable substitution is the Compose grammar subset `${VAR}`, `${VAR:-default}`, `${VAR-default}`,
// `${VAR:?err}`, `$VAR` and `$$` (literal), resolved ONLY against the env map the operator stored
// with the stack. Process environment is never consulted.
import crypto from 'node:crypto';
import YAML from 'yaml';
import { normalizeSpec, parsePortString, durationToMs } from '../containers/spec.js';

export const MAX_SERVICES = 40;
export const MAX_DOC_BYTES = 256 * 1024;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const NET_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

/** Top-level keys OpusHub understands. Anything else is unsupported (x-* extensions are ignored). */
const TOP_KEYS = Object.freeze(['version', 'name', 'services', 'networks', 'volumes']);
/** Service keys mapped onto the canonical spec. */
const SERVICE_KEYS = Object.freeze([
  'image', 'container_name', 'command', 'entrypoint', 'environment', 'labels', 'ports', 'expose', 'volumes',
  'networks', 'network_mode', 'restart', 'healthcheck', 'deploy', 'mem_limit', 'memswap_limit', 'cpus',
  'cpu_shares', 'pids_limit', 'cap_add', 'cap_drop', 'security_opt', 'privileged', 'read_only', 'user',
  'working_dir', 'hostname', 'dns', 'dns_search', 'extra_hosts', 'logging', 'tty', 'stdin_open', 'init',
  'stop_signal', 'stop_grace_period', 'devices', 'depends_on', 'pull_policy', 'platform',
]);
/** Service keys that are recognised and refused — they need something OpusHub deliberately lacks. */
const UNSUPPORTED_SERVICE_KEYS = Object.freeze({
  build: 'building images is not supported — reference a published image',
  env_file: 'env_file reads the host filesystem — put the variables in the stack env instead',
  extends: 'extends needs other files on disk',
  secrets: 'compose secrets are not supported',
  configs: 'compose configs are not supported',
  pid: null, ipc: null, userns_mode: null, cgroup: null, cgroup_parent: null,
  volumes_from: 'volumes_from is not supported',
  links: 'legacy links are not supported — services on the same network resolve each other by name',
  external_links: 'external_links are not supported',
  sysctls: 'sysctls are not supported',
  ulimits: 'ulimits are not supported',
  shm_size: 'shm_size is not supported',
  tmpfs: 'use a volume entry of type tmpfs instead',
  runtime: 'alternative runtimes are not supported',
  gpus: 'GPU reservations are not supported',
  device_cgroup_rules: 'device cgroup rules are not supported',
  storage_opt: 'storage_opt is not supported',
  oom_kill_disable: 'disabling the OOM killer is not supported',
  oom_score_adj: 'oom_score_adj is not supported',
  isolation: 'isolation is not supported',
  domainname: 'domainname is not supported',
  mac_address: 'mac_address is not supported',
  profiles: 'profiles are not supported — every service in the document is deployed',
  scale: 'scaling is not supported — one container per service',
  develop: 'develop/watch is not supported',
  annotations: 'annotations are not supported',
  attach: null, blkio_config: 'blkio_config is not supported', cpu_count: null, cpu_percent: null,
  cpu_period: null, cpu_quota: null, cpu_rt_period: null, cpu_rt_runtime: null, cpuset: null,
  credential_spec: null, group_add: 'group_add is not supported', label_file: 'label_file reads the host filesystem',
  post_start: 'lifecycle hooks are not supported', pre_stop: 'lifecycle hooks are not supported',
  uts: null, provider: null, models: null,
});

/* ------------------------------------------------------------------ */
/* variable substitution                                               */
/* ------------------------------------------------------------------ */

const VAR_RE = /\$(?:\$|\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** Substitute `${VAR}` forms in one string against `env`. Records missing/erroring variables. */
export function substitute(text, env, problems, where) {
  return String(text).replace(VAR_RE, (m, braced, op, arg, bare) => {
    if (m === '$$') return '$';
    const name = braced || bare;
    const val = Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
    const set = val !== undefined;
    const nonEmpty = set && val !== '';
    switch (op) {
      case ':-': return nonEmpty ? val : arg;
      case '-': return set ? val : arg;
      case ':?': if (!nonEmpty) problems.push(`${where}: variable ${name} is required${arg ? ` (${arg})` : ''}`); return nonEmpty ? val : '';
      case '?': if (!set) problems.push(`${where}: variable ${name} is required${arg ? ` (${arg})` : ''}`); return set ? val : '';
      case ':+': return nonEmpty ? arg : '';
      case '+': return set ? arg : '';
      default:
        if (!set) { problems.push(`${where}: variable ${name} is not set (empty string used)`); return ''; }
        return val;
    }
  });
}

function substituteDeep(node, env, problems, where) {
  if (typeof node === 'string') return substitute(node, env, problems, where);
  if (Array.isArray(node)) return node.map((x, i) => substituteDeep(x, env, problems, `${where}[${i}]`));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = substituteDeep(v, env, problems, `${where}.${k}`);
    return out;
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* parse                                                               */
/* ------------------------------------------------------------------ */

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const str = (x) => (x === null || x === undefined ? null : String(x));
const bool = (x) => x === true || x === 'true' || x === 1;
const list = (x) => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);

/** A KEY=value list or a {KEY: value} map → {KEY: value}. */
function kvMap(v, where, problems) {
  const out = {};
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = String(item);
      const i = s.indexOf('=');
      if (i <= 0) { out[s] = ''; continue; }
      out[s.slice(0, i)] = s.slice(i + 1);
    }
    return out;
  }
  if (isObj(v)) { for (const [k, val] of Object.entries(v)) out[k] = val === null || val === undefined ? '' : String(val); return out; }
  if (v !== undefined) problems.push(`${where}: must be a list or a map`);
  return out;
}

function argv(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(String);
  return shellSplit(String(v));
}

/** Compose's string form of command/entrypoint: split on whitespace, honouring quotes. No shell. */
function shellSplit(s) {
  const out = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i]; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/**
 * Parse and validate a Compose document.
 *
 * @param {string} text        the YAML text (data)
 * @param {object} [o]
 * @param {string} [o.project] the project name (overrides `name:` in the document)
 * @param {object} [o.env]     substitution variables
 * @returns {{ok:boolean, errors:string[], warnings:string[], model:object|null}}
 */
export function parseCompose(text, { project = null, env = {} } = {}) {
  const errors = [];
  const warnings = [];
  const unsupported = [];
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: ['The Compose document is empty.'], warnings, model: null };
  if (text.length > MAX_DOC_BYTES) return { ok: false, errors: ['The Compose document is too large (256 KB max).'], warnings, model: null };

  let doc;
  try {
    // core schema: no custom tags, no merge keys resolving to code, bounded aliases
    doc = YAML.parse(text, { schema: 'core', maxAliasCount: 100, prettyErrors: false, uniqueKeys: true });
  } catch (err) {
    return { ok: false, errors: [`YAML: ${String(err?.message || err).split('\n')[0].slice(0, 200)}`], warnings, model: null };
  }
  if (!isObj(doc)) return { ok: false, errors: ['The document must be a YAML mapping with a `services` section.'], warnings, model: null };

  const subProblems = [];
  doc = substituteDeep(doc, isObj(env) ? env : {}, subProblems, '$');
  for (const p of subProblems) (p.includes('is required') ? errors : warnings).push(p);

  for (const k of Object.keys(doc)) {
    if (TOP_KEYS.includes(k) || k.startsWith('x-')) continue;
    unsupported.push({ where: k, reason: k === 'secrets' || k === 'configs' ? `top-level ${k} are not supported` : k === 'include' ? 'include needs other files on disk' : `unknown top-level key ${k}` });
  }
  if (doc.version !== undefined) warnings.push('`version` is obsolete and ignored.');

  const name = String(project || doc.name || '').trim().toLowerCase();
  if (!PROJECT_RE.test(name)) errors.push('A project name is required: lowercase letters, digits, "_" or "-" (max 64).');

  if (!isObj(doc.services) || !Object.keys(doc.services).length) errors.push('`services` must be a mapping with at least one service.');
  const serviceKeys = isObj(doc.services) ? Object.keys(doc.services) : [];
  if (serviceKeys.length > MAX_SERVICES) errors.push(`At most ${MAX_SERVICES} services per stack.`);

  // ---- networks ----
  const networks = new Map();
  if (doc.networks !== undefined && !isObj(doc.networks)) errors.push('`networks` must be a mapping.');
  for (const [key, def0] of Object.entries(isObj(doc.networks) ? doc.networks : {})) {
    const def = def0 === null ? {} : def0;
    if (!NET_KEY_RE.test(key)) { errors.push(`network key "${String(key).slice(0, 40)}" is not valid`); continue; }
    if (!isObj(def)) { errors.push(`network ${key} must be a mapping`); continue; }
    const external = def.external === true || isObj(def.external);
    const actual = str(isObj(def.external) && def.external.name ? def.external.name : def.name) || (external ? key : `${name}_${key}`);
    if (!NET_KEY_RE.test(actual)) { errors.push(`network name "${actual.slice(0, 40)}" is not valid`); continue; }
    const driver = str(def.driver) || 'bridge';
    if (!['bridge', 'overlay', 'macvlan', 'ipvlan', 'host', 'none'].includes(driver)) { unsupported.push({ where: `networks.${key}`, reason: `driver ${driver.slice(0, 20)} is not supported` }); continue; }
    if (driver !== 'bridge' && !external) unsupported.push({ where: `networks.${key}`, reason: `only bridge networks are created by OpusHub (${driver} must be external)` });
    for (const k of Object.keys(def)) if (!['external', 'name', 'driver', 'internal', 'attachable', 'labels', 'driver_opts', 'ipam', 'enable_ipv6'].includes(k)) unsupported.push({ where: `networks.${key}.${k}`, reason: 'unknown network option' });
    if (def.ipam !== undefined) unsupported.push({ where: `networks.${key}.ipam`, reason: 'custom IPAM is not supported — let Docker allocate the subnet' });
    if (def.driver_opts !== undefined) unsupported.push({ where: `networks.${key}.driver_opts`, reason: 'driver_opts are not supported' });
    networks.set(key, { key, name: actual, external, driver, internal: bool(def.internal), attachable: def.attachable === undefined ? true : bool(def.attachable), labels: kvMap(def.labels, `networks.${key}.labels`, errors) });
  }

  // ---- volumes ----
  const volumes = new Map();
  if (doc.volumes !== undefined && !isObj(doc.volumes)) errors.push('`volumes` must be a mapping.');
  for (const [key, def0] of Object.entries(isObj(doc.volumes) ? doc.volumes : {})) {
    const def = def0 === null ? {} : def0;
    if (!NET_KEY_RE.test(key)) { errors.push(`volume key "${String(key).slice(0, 40)}" is not valid`); continue; }
    if (!isObj(def)) { errors.push(`volume ${key} must be a mapping`); continue; }
    const external = def.external === true || isObj(def.external);
    const actual = str(isObj(def.external) && def.external.name ? def.external.name : def.name) || (external ? key : `${name}_${key}`);
    if (!NET_KEY_RE.test(actual)) { errors.push(`volume name "${actual.slice(0, 40)}" is not valid`); continue; }
    const driver = str(def.driver) || 'local';
    if (driver !== 'local') unsupported.push({ where: `volumes.${key}`, reason: `volume driver ${driver.slice(0, 20)} is not supported` });
    if (def.driver_opts !== undefined) unsupported.push({ where: `volumes.${key}.driver_opts`, reason: 'volume driver_opts (host paths, NFS) are not supported' });
    for (const k of Object.keys(def)) if (!['external', 'name', 'driver', 'driver_opts', 'labels'].includes(k)) unsupported.push({ where: `volumes.${key}.${k}`, reason: 'unknown volume option' });
    volumes.set(key, { key, name: actual, external, labels: kvMap(def.labels, `volumes.${key}.labels`, errors) });
  }

  // ---- services ----
  const services = [];
  const usedNames = new Set();
  const defaultNetwork = { key: 'default', name: `${name}_default`, external: false, driver: 'bridge', internal: false, attachable: true, labels: {} };
  let needsDefault = false;

  for (const key of serviceKeys) {
    const svc = doc.services[key];
    const where = `services.${key}`;
    if (!SERVICE_RE.test(key)) { errors.push(`${where}: service name is not valid`); continue; }
    if (!isObj(svc)) { errors.push(`${where}: must be a mapping`); continue; }
    for (const k of Object.keys(svc)) {
      if (SERVICE_KEYS.includes(k) || k.startsWith('x-')) continue;
      if (k in UNSUPPORTED_SERVICE_KEYS) {
        if (['pid', 'ipc', 'userns_mode', 'cgroup', 'uts'].includes(k)) { unsupported.push({ where: `${where}.${k}`, reason: `${k}: ${String(svc[k]).slice(0, 20)} shares a host namespace and is not supported` }); continue; }
        unsupported.push({ where: `${where}.${k}`, reason: UNSUPPORTED_SERVICE_KEYS[k] || `${k} is not supported` });
      } else unsupported.push({ where: `${where}.${k}`, reason: `unknown service key ${k}` });
    }
    if (!svc.image) { errors.push(`${where}: image is required`); continue; }

    const raw = { image: str(svc.image) };
    const containerName = str(svc.container_name) || `${name}-${key}-1`;
    if (usedNames.has(containerName)) errors.push(`${where}: container name ${containerName} is used twice`);
    usedNames.add(containerName);
    raw.name = containerName;
    if (svc.command !== undefined) raw.command = argv(svc.command);
    if (svc.entrypoint !== undefined) raw.entrypoint = argv(svc.entrypoint);
    raw.env = kvMap(svc.environment, `${where}.environment`, errors);
    raw.labels = kvMap(svc.labels, `${where}.labels`, errors);

    // ports: short strings, numbers, or long syntax
    raw.ports = [];
    for (const p of list(svc.ports)) {
      if (isObj(p)) {
        const target = Number(p.target);
        const published = p.published === undefined || p.published === null || p.published === '' ? null : Number(String(p.published).split('-')[0]);
        raw.ports.push({ container: target, host: published, protocol: str(p.protocol) || 'tcp', hostIp: str(p.host_ip) });
        if (p.mode && p.mode !== 'host' && p.mode !== 'ingress') unsupported.push({ where: `${where}.ports`, reason: `port mode ${String(p.mode).slice(0, 12)} is not supported` });
      } else {
        const s = String(p);
        if (/\d+-\d+/.test(s)) { unsupported.push({ where: `${where}.ports`, reason: `port ranges (${s.slice(0, 24)}) are not supported — list the ports individually` }); continue; }
        const parsed = parsePortString(s);
        if (!parsed) { errors.push(`${where}.ports: "${s.slice(0, 24)}" is not a valid port mapping`); continue; }
        raw.ports.push(parsed);
      }
    }
    for (const e of list(svc.expose)) {
      const n = Number(String(e).split('/')[0]);
      if (Number.isInteger(n) && !raw.ports.some((x) => x.container === n)) raw.ports.push({ container: n, host: null, protocol: String(e).includes('/udp') ? 'udp' : 'tcp', hostIp: null });
    }

    // volumes: short or long syntax; named volumes are resolved through the volumes section
    raw.volumes = [];
    for (const v of list(svc.volumes)) {
      let entry;
      if (isObj(v)) {
        const type = str(v.type) || (String(v.source || '').startsWith('/') ? 'bind' : 'volume');
        entry = { type, source: str(v.source), target: str(v.target), readOnly: bool(v.read_only) };
        if (v.bind?.propagation) unsupported.push({ where: `${where}.volumes`, reason: 'bind propagation is not supported' });
        if (type === 'tmpfs') entry = { type: 'tmpfs', target: str(v.target), options: v.tmpfs?.size ? `size=${v.tmpfs.size}` : null };
      } else {
        const parts = String(v).split(':');
        if (parts.length === 1) { entry = { type: 'volume', source: null, target: parts[0], readOnly: false }; unsupported.push({ where: `${where}.volumes`, reason: `anonymous volume ${parts[0].slice(0, 40)} is not supported — name it` }); continue; }
        const [source, target, mode] = parts;
        entry = { type: source.startsWith('/') || source.startsWith('.') || source.startsWith('~') ? 'bind' : 'volume', source, target, readOnly: mode === 'ro' };
      }
      if (entry.type === 'bind' && entry.source && !entry.source.startsWith('/')) { unsupported.push({ where: `${where}.volumes`, reason: `relative bind path ${entry.source.slice(0, 40)} needs a project directory OpusHub does not have — use an absolute path or a named volume` }); continue; }
      if (entry.type === 'volume' && entry.source) {
        const def = volumes.get(entry.source);
        if (def) entry.source = def.name;
        else if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(entry.source)) { errors.push(`${where}.volumes: volume ${entry.source.slice(0, 40)} is not valid`); continue; }
        else { warnings.push(`${where}.volumes: volume ${entry.source} is not declared in the volumes section; it is used as an external volume name`); }
      }
      raw.volumes.push(entry);
    }

    // networks
    const networkMode = str(svc.network_mode);
    if (networkMode) {
      if (networkMode.startsWith('service:') || networkMode.startsWith('container:')) unsupported.push({ where: `${where}.network_mode`, reason: 'sharing another container\'s network namespace is not supported' });
      raw.networkMode = networkMode;
      raw.networks = [];
    } else {
      const nets = [];
      const declared = svc.networks;
      if (declared === undefined || (Array.isArray(declared) && !declared.length) || (isObj(declared) && !Object.keys(declared).length)) {
        nets.push({ name: defaultNetwork.name, aliases: [key], ipv4: null });
        needsDefault = true;
      } else {
        const entries = Array.isArray(declared) ? declared.map((n) => [String(n), null]) : isObj(declared) ? Object.entries(declared) : [];
        if (!entries.length) errors.push(`${where}.networks: must be a list or a mapping`);
        for (const [nk, cfg] of entries) {
          const def = nk === 'default' ? (networks.get('default') || defaultNetwork) : networks.get(nk);
          if (!def) { errors.push(`${where}.networks: network ${String(nk).slice(0, 40)} is not declared in the networks section`); continue; }
          if (def === defaultNetwork) needsDefault = true;
          const aliases = [key, ...list(cfg?.aliases).map(String)];
          nets.push({ name: def.name, aliases: [...new Set(aliases)], ipv4: str(cfg?.ipv4_address) });
        }
      }
      raw.networks = nets;
      raw.networkMode = nets.length ? nets[0].name : 'bridge';
    }

    // restart
    const restart = str(svc.restart) || (isObj(svc.deploy?.restart_policy) ? { any: 'always', 'on-failure': 'on-failure', none: 'no' }[svc.deploy.restart_policy.condition] || 'unless-stopped' : 'unless-stopped');
    const m = /^on-failure(?::(\d+))?$/.exec(restart);
    raw.restartPolicy = m ? { name: 'on-failure', maxRetries: Number(m[1] || 0) } : { name: restart, maxRetries: 0 };

    // healthcheck
    if (svc.healthcheck !== undefined) {
      const h = svc.healthcheck;
      if (h === null || h.disable === true) raw.healthcheck = { test: ['NONE'] };
      else if (isObj(h)) raw.healthcheck = { test: h.test, interval: h.interval, timeout: h.timeout, retries: h.retries, startPeriod: h.start_period };
      else errors.push(`${where}.healthcheck: must be a mapping`);
    }

    // resources: v2 keys and deploy.resources.limits
    const limits = svc.deploy?.resources?.limits || {};
    if (svc.deploy) for (const k of Object.keys(svc.deploy)) if (!['resources', 'restart_policy'].includes(k)) unsupported.push({ where: `${where}.deploy.${k}`, reason: 'only deploy.resources.limits and deploy.restart_policy are supported' });
    if (svc.deploy?.resources?.reservations) warnings.push(`${where}.deploy.resources.reservations are ignored (no scheduler)`);
    raw.resources = {
      memory: svc.mem_limit ?? limits.memory ?? 0,
      memorySwap: svc.memswap_limit ?? 0,
      cpus: svc.cpus ?? limits.cpus ?? null,
      cpuShares: svc.cpu_shares ?? 0,
      pidsLimit: svc.pids_limit ?? limits.pids ?? 0,
    };
    raw.capabilities = { add: list(svc.cap_add).map(String), drop: list(svc.cap_drop).map(String) };
    raw.securityOpt = list(svc.security_opt).map(String);
    raw.privileged = bool(svc.privileged);
    raw.readOnlyRootfs = bool(svc.read_only);
    raw.user = str(svc.user);
    raw.workingDir = str(svc.working_dir);
    raw.hostname = str(svc.hostname);
    raw.dns = list(svc.dns).map(String);
    raw.dnsSearch = list(svc.dns_search).map(String);
    raw.extraHosts = isObj(svc.extra_hosts) ? Object.entries(svc.extra_hosts).map(([h, ip]) => `${h}:${ip}`) : list(svc.extra_hosts).map(String);
    if (svc.logging !== undefined) {
      if (!isObj(svc.logging)) errors.push(`${where}.logging: must be a mapping`);
      else raw.logging = { driver: str(svc.logging.driver) || 'json-file', options: kvMap(svc.logging.options, `${where}.logging.options`, errors) };
    }
    raw.tty = bool(svc.tty);
    raw.stdinOpen = bool(svc.stdin_open);
    raw.init = bool(svc.init);
    raw.stopSignal = str(svc.stop_signal);
    if (svc.stop_grace_period !== undefined) {
      const ms = typeof svc.stop_grace_period === 'number' ? svc.stop_grace_period * 1000 : durationToMs(String(svc.stop_grace_period));
      if (Number.isFinite(ms) && ms >= 0) raw.stopTimeout = Math.round(ms / 1000);
      else errors.push(`${where}.stop_grace_period: not a duration`);
    }
    raw.devices = list(svc.devices).map((d) => (isObj(d) ? `${d.source}:${d.target}${d.permissions ? `:${d.permissions}` : ''}` : String(d)));
    if (svc.platform) warnings.push(`${where}.platform is ignored (the engine pulls its native platform)`);

    // the canonical labels compose writes, so discovery groups the stack like any other project
    raw.labels = {
      ...raw.labels,
      'com.docker.compose.project': name,
      'com.docker.compose.service': key,
      'com.docker.compose.container-number': '1',
      'com.docker.compose.oneoff': 'False',
      'io.opushub.managed': 'stack',
    };

    const norm = normalizeSpec(raw);
    if (!norm.ok) { for (const e of norm.errors) errors.push(`${where}: ${e}`); continue; }
    const dependsOn = isObj(svc.depends_on) ? Object.keys(svc.depends_on) : list(svc.depends_on).map(String);
    for (const d of dependsOn) if (!serviceKeys.includes(d)) errors.push(`${where}.depends_on: ${String(d).slice(0, 40)} is not a service in this document`);
    const pullPolicy = str(svc.pull_policy) || 'missing';
    if (!['missing', 'always', 'never', 'if_not_present'].includes(pullPolicy)) errors.push(`${where}.pull_policy: ${pullPolicy.slice(0, 20)} is not valid`);
    services.push({ key, containerName, spec: norm.spec, dependsOn, pullPolicy: pullPolicy === 'if_not_present' ? 'missing' : pullPolicy });
  }

  if (needsDefault && !networks.has('default')) networks.set('default', defaultNetwork);

  // dependency order (Kahn); a cycle is an error
  const order = topoOrder(services, errors);

  const model = errors.length ? null : {
    name,
    services: order.map((k) => services.find((s) => s.key === k)),
    networks: [...networks.values()],
    volumes: [...volumes.values()],
    unsupported,
    hash: null,
  };
  if (model) model.hash = configHash(model);
  return { ok: errors.length === 0, errors, warnings, model };
}

function topoOrder(services, errors) {
  const keys = services.map((s) => s.key);
  const indeg = new Map(keys.map((k) => [k, 0]));
  const out = new Map(keys.map((k) => [k, []]));
  for (const s of services) for (const d of s.dependsOn) if (indeg.has(d)) { indeg.set(s.key, indeg.get(s.key) + 1); out.get(d).push(s.key); }
  const queue = keys.filter((k) => indeg.get(k) === 0).sort();
  const order = [];
  while (queue.length) {
    const k = queue.shift();
    order.push(k);
    for (const n of out.get(k)) { indeg.set(n, indeg.get(n) - 1); if (indeg.get(n) === 0) queue.push(n); }
  }
  if (order.length !== keys.length) errors.push('depends_on forms a cycle.');
  return order;
}

/** A stable hash of one service's canonical spec — written as a label, read back to detect drift. */
export function serviceHash(spec) {
  return crypto.createHash('sha256').update(stable(spec)).digest('hex').slice(0, 32);
}

/** The hash of the whole model. */
export function configHash(model) {
  return crypto.createHash('sha256').update(stable({ s: model.services.map((s) => [s.key, s.spec]), n: model.networks, v: model.volumes })).digest('hex').slice(0, 32);
}

function stable(x) {
  if (Array.isArray(x)) return `[${x.map(stable).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}`;
  return JSON.stringify(x === undefined ? null : x);
}

export const _internals = Object.freeze({ shellSplit, kvMap, topoOrder, UNSUPPORTED_SERVICE_KEYS, SERVICE_KEYS, TOP_KEYS });
