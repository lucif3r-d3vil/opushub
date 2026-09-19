// The canonical container spec — the ONE shape a container configuration takes inside OpusHub.
//
// Three things are converted into it and one thing is built from it:
//
//   docker inspect  ──▶ spec   (specFromInspect)      what a container IS
//   editor / API    ──▶ spec   (normalizeSpec/Patch)  what the operator ASKED for — allow-listed
//   compose service ──▶ spec   (stacks/compose.js)    what a Compose document DESCRIBES
//   spec ──▶ engine create body (createBodyFromSpec)  what the daemon is TOLD, field by field
//
// The point of the indirection is the allow-list. The browser never sends an engine body and the
// engine never receives a field this file does not spell out. A field that is not here cannot be
// set through OpusHub, and adding one is a reviewable change to this file plus the policy
// classifier that judges it (containers/policy.js).
//
// Deliberately NOT in the spec (and therefore refused, not ignored, when supplied):
//   PidMode/IpcMode/UsernsMode/CgroupnsMode/Cgroup parent (host namespace sharing — the recreate
//   engine already refuses containers that use them), Sysctls, StorageOpt, Ulimits, OomScoreAdj,
//   Runtime, Isolation, MaskedPaths/ReadonlyPaths, VolumesFrom, Links, ShmSize, ConsoleSize,
//   GroupAdd, container:<id> network mode, Annotations, and every Swarm field.
import { isValidImageRef } from '../updates/recreateAdapter.js';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const LABEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const ALIAS_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const NETWORK_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const HOST_PATH_RE = /^\/[^\0]{0,1023}$/;
const CONTAINER_PATH_RE = /^\/[^\0:]{0,1023}$/;
const CAP_RE = /^(CAP_)?[A-Z_]{2,32}$/;
const SIGNAL_RE = /^(SIG)?[A-Z0-9]{2,12}$/;
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/;
const USER_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63})?$/;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const DEVICE_RE = /^\/dev\/[A-Za-z0-9_./-]{1,200}$/;
const LOG_DRIVERS = Object.freeze(['json-file', 'local', 'journald', 'syslog', 'none']);
const RESTART_POLICIES = Object.freeze(['no', 'always', 'unless-stopped', 'on-failure']);
const NETWORK_MODES = Object.freeze(['bridge', 'host', 'none']);

export const LIMITS = Object.freeze({
  env: 500, labels: 200, ports: 200, volumes: 100, networks: 16, aliases: 8, caps: 40, securityOpt: 8,
  dns: 4, dnsSearch: 8, extraHosts: 32, devices: 16, argv: 256, argvLen: 4096, valueLen: 65_536,
  healthTest: 32, logOptions: 16,
});

/** The editable field names, in the order the editor shows them. This IS the allow-list. */
export const SPEC_FIELDS = Object.freeze([
  'image', 'name', 'command', 'entrypoint', 'env', 'labels', 'ports', 'volumes', 'networks',
  'networkMode', 'restartPolicy', 'healthcheck', 'resources', 'capabilities', 'securityOpt',
  'privileged', 'readOnlyRootfs', 'user', 'workingDir', 'hostname', 'dns', 'dnsSearch',
  'extraHosts', 'logging', 'tty', 'stdinOpen', 'init', 'stopSignal', 'stopTimeout', 'devices',
]);

/** Fields the daemon can change in place (`POST /containers/<id>/update`). Everything else recreates. */
export const IN_PLACE_FIELDS = Object.freeze(['restartPolicy', 'resources']);

/* ------------------------------------------------------------------ */
/* inspect → spec                                                      */
/* ------------------------------------------------------------------ */

const parseEnv = (list) => {
  const env = {};
  for (const e of Array.isArray(list) ? list : []) {
    const s = String(e);
    const i = s.indexOf('=');
    if (i <= 0) { if (ENV_KEY_RE.test(s)) env[s] = ''; continue; }
    const k = s.slice(0, i);
    if (ENV_KEY_RE.test(k)) env[k] = s.slice(i + 1);
  }
  return env;
};

/** The spec of a container as it exists. `inspect` is the raw daemon document. */
export function specFromInspect(inspect) {
  const cfg = inspect?.Config || {};
  const hc = inspect?.HostConfig || {};
  const ns = inspect?.NetworkSettings || {};
  const ports = [];
  for (const [key, binds] of Object.entries(hc.PortBindings || {})) {
    const [container, protocol = 'tcp'] = String(key).split('/');
    for (const b of binds || []) {
      ports.push({ container: Number(container), host: b?.HostPort ? Number(b.HostPort) : null, protocol, hostIp: b?.HostIp || null });
    }
  }
  const volumes = [];
  const seenTargets = new Set();
  for (const m of Array.isArray(inspect?.Mounts) ? inspect.Mounts : []) {
    if (!m?.Destination) continue;
    seenTargets.add(m.Destination);
    if (m.Type === 'bind') volumes.push({ type: 'bind', source: m.Source, target: m.Destination, readOnly: m.RW === false });
    else if (m.Type === 'volume') volumes.push({ type: 'volume', source: m.Name || m.Source, target: m.Destination, readOnly: m.RW === false });
    else if (m.Type === 'tmpfs') volumes.push({ type: 'tmpfs', source: null, target: m.Destination, readOnly: false });
  }
  for (const [target, opts] of Object.entries(hc.Tmpfs || {})) {
    if (!seenTargets.has(target)) volumes.push({ type: 'tmpfs', source: null, target, readOnly: false, options: String(opts || '') || null });
  }
  const shortId = String(inspect?.Id || '').slice(0, 12);
  const networks = Object.entries(ns.Networks || {}).map(([name, n]) => ({
    name,
    aliases: (Array.isArray(n?.Aliases) ? n.Aliases : []).filter((a) => typeof a === 'string' && a !== shortId && !shortId.startsWith(a)),
    ipv4: n?.IPAMConfig?.IPv4Address || null,
  }));
  const mode = String(hc.NetworkMode || 'bridge');
  const health = cfg.Healthcheck && Array.isArray(cfg.Healthcheck.Test) && cfg.Healthcheck.Test.length && cfg.Healthcheck.Test[0] !== 'NONE'
    ? {
      test: [...cfg.Healthcheck.Test],
      intervalMs: nsToMs(cfg.Healthcheck.Interval), timeoutMs: nsToMs(cfg.Healthcheck.Timeout),
      retries: Number.isFinite(cfg.Healthcheck.Retries) ? cfg.Healthcheck.Retries : null,
      startPeriodMs: nsToMs(cfg.Healthcheck.StartPeriod),
    }
    : (cfg.Healthcheck?.Test?.[0] === 'NONE' ? { test: ['NONE'] } : null);
  return {
    image: cfg.Image || null,
    name: String(inspect?.Name || '').replace(/^\//, '') || null,
    command: Array.isArray(cfg.Cmd) ? [...cfg.Cmd] : null,
    entrypoint: Array.isArray(cfg.Entrypoint) ? [...cfg.Entrypoint] : (typeof cfg.Entrypoint === 'string' ? [cfg.Entrypoint] : null),
    env: parseEnv(cfg.Env),
    labels: cfg.Labels && typeof cfg.Labels === 'object' ? { ...cfg.Labels } : {},
    ports,
    volumes,
    networks,
    // a named network as the primary (`NetworkMode: myproject_default`) is kept as such — the
    // create body writes it back the same way, so a compare between the two is exact
    networkMode: NETWORK_MODES.includes(mode) || mode === 'default' ? (mode === 'default' ? 'bridge' : mode) : (mode.startsWith('container:') || NETWORK_RE.test(mode) ? mode : 'bridge'),
    restartPolicy: { name: RESTART_POLICIES.includes(hc.RestartPolicy?.Name) ? hc.RestartPolicy.Name : 'no', maxRetries: Number(hc.RestartPolicy?.MaximumRetryCount) || 0 },
    healthcheck: health,
    resources: {
      memory: Number(hc.Memory) || 0,
      memorySwap: Number(hc.MemorySwap) || 0,
      nanoCpus: Number(hc.NanoCpus) || 0,
      cpuShares: Number(hc.CpuShares) || 0,
      pidsLimit: Number(hc.PidsLimit) || 0,
    },
    capabilities: { add: (hc.CapAdd || []).map(String), drop: (hc.CapDrop || []).map(String) },
    securityOpt: (hc.SecurityOpt || []).map(String),
    privileged: hc.Privileged === true,
    readOnlyRootfs: hc.ReadonlyRootfs === true,
    user: cfg.User || null,
    workingDir: cfg.WorkingDir || null,
    hostname: cfg.Hostname || null,
    dns: (hc.Dns || []).map(String),
    dnsSearch: (hc.DnsSearch || []).map(String),
    extraHosts: (hc.ExtraHosts || []).map(String),
    logging: hc.LogConfig?.Type ? { driver: hc.LogConfig.Type, options: { ...(hc.LogConfig.Config || {}) } } : null,
    tty: cfg.Tty === true,
    stdinOpen: cfg.OpenStdin === true,
    init: hc.Init === true,
    stopSignal: cfg.StopSignal || null,
    stopTimeout: Number.isFinite(cfg.StopTimeout) ? cfg.StopTimeout : (Number.isFinite(hc.StopTimeout) ? hc.StopTimeout : null),
    devices: (hc.Devices || []).map((d) => ({ host: d.PathOnHost, container: d.PathInContainer, permissions: d.CgroupPermissions || 'rwm' })),
    // read-only facts the policy needs and the editor cannot set
    _unsupported: {
      pidMode: hc.PidMode || null, ipcMode: hc.IpcMode || null, usernsMode: hc.UsernsMode || null,
      cgroupnsMode: hc.CgroupnsMode || null, sysctls: hc.Sysctls && Object.keys(hc.Sysctls).length ? { ...hc.Sysctls } : null,
    },
  };
}

const nsToMs = (ns) => (Number.isFinite(ns) && ns > 0 ? Math.round(ns / 1e6) : null);
const msToNs = (ms) => (Number.isFinite(ms) && ms > 0 ? Math.round(ms * 1e6) : 0);

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

class Problems {
  constructor() { this.list = []; }
  add(field, msg) { if (this.list.length < 40) this.list.push(`${field}: ${msg}`); }
  get ok() { return this.list.length === 0; }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const strList = (v, max, len = 512) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= len);

function readArgv(v, field, p) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length ? [v] : null; // a single word, not a shell line
  if (!Array.isArray(v) || v.length > LIMITS.argv) { p.add(field, 'must be a list of arguments'); return null; }
  if (!v.every((x) => typeof x === 'string' && x.length <= LIMITS.argvLen)) { p.add(field, 'every argument must be a string'); return null; }
  return [...v];
}

const FIELD_READERS = {
  image(v, p) {
    if (typeof v !== 'string' || !isValidImageRef(v.trim())) { p.add('image', 'must be a valid image reference (repository[:tag][@digest])'); return undefined; }
    return v.trim();
  },
  name(v, p) {
    if (v === null) return null;
    const n = typeof v === 'string' ? v.trim().replace(/^\//, '') : '';
    if (!NAME_RE.test(n)) { p.add('name', 'letters, digits, "_", ".", "-"; 1–128 characters'); return undefined; }
    return n;
  },
  command(v, p) { return readArgv(v, 'command', p); },
  entrypoint(v, p) { return readArgv(v, 'entrypoint', p); },
  env(v, p) {
    if (!isObj(v)) { p.add('env', 'must be an object of KEY: value'); return undefined; }
    const keys = Object.keys(v);
    if (keys.length > LIMITS.env) { p.add('env', `at most ${LIMITS.env} variables`); return undefined; }
    const out = {};
    for (const k of keys) {
      if (!ENV_KEY_RE.test(k)) { p.add('env', `"${k.slice(0, 40)}" is not a valid variable name`); continue; }
      const val = v[k];
      if (val === null || val === undefined) { out[k] = ''; continue; }
      if (!['string', 'number', 'boolean'].includes(typeof val)) { p.add('env', `${k} must be a string`); continue; }
      const s = String(val);
      if (s.length > LIMITS.valueLen) { p.add('env', `${k} is too long`); continue; }
      out[k] = s;
    }
    return out;
  },
  labels(v, p) {
    if (!isObj(v)) { p.add('labels', 'must be an object'); return undefined; }
    const keys = Object.keys(v);
    if (keys.length > LIMITS.labels) { p.add('labels', `at most ${LIMITS.labels} labels`); return undefined; }
    const out = {};
    for (const k of keys) {
      if (!LABEL_KEY_RE.test(k)) { p.add('labels', `"${k.slice(0, 40)}" is not a valid label key`); continue; }
      const s = v[k] === null || v[k] === undefined ? '' : String(v[k]);
      if (s.length > 4096) { p.add('labels', `${k} is too long`); continue; }
      out[k] = s;
    }
    return out;
  },
  ports(v, p) {
    if (!Array.isArray(v) || v.length > LIMITS.ports) { p.add('ports', `must be a list of at most ${LIMITS.ports}`); return undefined; }
    const out = [];
    for (const raw of v) {
      const e = typeof raw === 'string' ? parsePortString(raw) : raw;
      if (!isObj(e)) { p.add('ports', 'each entry is {host, container, protocol}'); continue; }
      const container = Number(e.container);
      const host = e.host === null || e.host === undefined || e.host === '' ? null : Number(e.host);
      const protocol = String(e.protocol || 'tcp').toLowerCase();
      if (!Number.isInteger(container) || container < 1 || container > 65535) { p.add('ports', `container port ${String(e.container).slice(0, 12)} is not valid`); continue; }
      if (host !== null && (!Number.isInteger(host) || host < 1 || host > 65535)) { p.add('ports', `host port ${String(e.host).slice(0, 12)} is not valid`); continue; }
      if (!['tcp', 'udp', 'sctp'].includes(protocol)) { p.add('ports', `protocol ${protocol.slice(0, 8)} is not valid`); continue; }
      const hostIp = e.hostIp ? String(e.hostIp) : null;
      if (hostIp && !IPV4_RE.test(hostIp) && hostIp !== '::' && !/^[0-9a-f:]{2,45}$/i.test(hostIp)) { p.add('ports', 'host IP is not valid'); continue; }
      out.push({ container, host, protocol, hostIp });
    }
    return out;
  },
  volumes(v, p) {
    if (!Array.isArray(v) || v.length > LIMITS.volumes) { p.add('volumes', `must be a list of at most ${LIMITS.volumes}`); return undefined; }
    const out = [];
    const targets = new Set();
    for (const raw of v) {
      const e = typeof raw === 'string' ? parseVolumeString(raw) : raw;
      if (!isObj(e)) { p.add('volumes', 'each entry is {type, source, target, readOnly}'); continue; }
      const type = String(e.type || (String(e.source || '').startsWith('/') ? 'bind' : 'volume'));
      const target = typeof e.target === 'string' ? e.target : '';
      if (!CONTAINER_PATH_RE.test(target)) { p.add('volumes', `target ${target.slice(0, 40) || '(empty)'} must be an absolute container path`); continue; }
      if (targets.has(target)) { p.add('volumes', `target ${target} is mounted twice`); continue; }
      const readOnly = e.readOnly === true;
      if (type === 'bind') {
        const source = typeof e.source === 'string' ? e.source : '';
        if (!HOST_PATH_RE.test(source)) { p.add('volumes', `bind source ${source.slice(0, 40) || '(empty)'} must be an absolute host path`); continue; }
        if (/(^|\/)\.\.(\/|$)/.test(source)) { p.add('volumes', 'bind source must not contain ".."'); continue; }
        out.push({ type, source: normalizePath(source), target, readOnly });
      } else if (type === 'volume') {
        const source = typeof e.source === 'string' ? e.source : '';
        if (!VOLUME_NAME_RE.test(source)) { p.add('volumes', `volume name ${source.slice(0, 40) || '(empty)'} is not valid`); continue; }
        out.push({ type, source, target, readOnly });
      } else if (type === 'tmpfs') {
        const options = e.options ? String(e.options).slice(0, 200) : null;
        if (options && !/^[a-z0-9=,]+$/i.test(options)) { p.add('volumes', 'tmpfs options are not valid'); continue; }
        out.push({ type, source: null, target, readOnly: false, ...(options ? { options } : {}) });
      } else { p.add('volumes', `type ${type.slice(0, 12)} is not supported`); continue; }
      targets.add(target);
    }
    return out;
  },
  networks(v, p) {
    if (!Array.isArray(v) || v.length > LIMITS.networks) { p.add('networks', `must be a list of at most ${LIMITS.networks}`); return undefined; }
    const out = [];
    const seen = new Set();
    for (const raw of v) {
      const e = typeof raw === 'string' ? { name: raw } : raw;
      if (!isObj(e) || !NETWORK_RE.test(String(e.name || ''))) { p.add('networks', 'each entry needs a valid network name'); continue; }
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      const aliases = Array.isArray(e.aliases) ? e.aliases.map(String) : [];
      if (aliases.length > LIMITS.aliases || !aliases.every((a) => ALIAS_RE.test(a))) { p.add('networks', `aliases for ${e.name} must be DNS labels`); continue; }
      const ipv4 = e.ipv4 ? String(e.ipv4) : null;
      if (ipv4 && !IPV4_RE.test(ipv4)) { p.add('networks', `${ipv4.slice(0, 20)} is not an IPv4 address`); continue; }
      out.push({ name: e.name, aliases, ipv4 });
    }
    return out;
  },
  networkMode(v, p) {
    if (v === null || v === undefined) return 'bridge';
    const m = String(v);
    if (NETWORK_MODES.includes(m)) return m;
    if (m.startsWith('container:')) { p.add('networkMode', 'sharing another container\'s network namespace is not supported'); return undefined; }
    if (NETWORK_RE.test(m)) return m; // a named network as primary
    p.add('networkMode', 'must be bridge, host, none or a network name');
    return undefined;
  },
  restartPolicy(v, p) {
    const e = typeof v === 'string' ? { name: v } : v;
    if (!isObj(e) || !RESTART_POLICIES.includes(String(e.name))) { p.add('restartPolicy', `must be one of ${RESTART_POLICIES.join(', ')}`); return undefined; }
    const maxRetries = e.name === 'on-failure' ? Math.max(0, Math.min(1000, Number(e.maxRetries) || 0)) : 0;
    return { name: e.name, maxRetries };
  },
  healthcheck(v, p) {
    if (v === null) return null;
    if (!isObj(v)) { p.add('healthcheck', 'must be an object or null'); return undefined; }
    if (v.disable === true || (Array.isArray(v.test) && v.test[0] === 'NONE')) return { test: ['NONE'] };
    let test = v.test;
    if (typeof test === 'string') test = ['CMD-SHELL', test];
    if (!Array.isArray(test) || !test.length || test.length > LIMITS.healthTest || !test.every((x) => typeof x === 'string' && x.length <= 2048)) { p.add('healthcheck', 'test must be a command list'); return undefined; }
    if (!['CMD', 'CMD-SHELL'].includes(test[0])) test = ['CMD', ...test];
    const ms = (x, name, lo, hi) => {
      if (x === null || x === undefined || x === '') return null;
      const n = typeof x === 'string' && /[a-z]$/i.test(x) ? durationToMs(x) : Number(x);
      if (!Number.isFinite(n) || n < lo || n > hi) { p.add('healthcheck', `${name} must be between ${lo} and ${hi} ms`); return null; }
      return Math.round(n);
    };
    return {
      test,
      intervalMs: ms(v.intervalMs ?? v.interval, 'interval', 1000, 3_600_000),
      timeoutMs: ms(v.timeoutMs ?? v.timeout, 'timeout', 1000, 600_000),
      retries: v.retries === null || v.retries === undefined ? null : Math.max(0, Math.min(100, Number(v.retries) || 0)),
      startPeriodMs: ms(v.startPeriodMs ?? v.startPeriod ?? v.start_period, 'start period', 0, 3_600_000),
    };
  },
  resources(v, p) {
    if (!isObj(v)) { p.add('resources', 'must be an object'); return undefined; }
    const num = (x, name, max) => {
      if (x === null || x === undefined || x === '') return 0;
      const n = typeof x === 'string' && /[kmgb]$/i.test(x) ? sizeToBytes(x) : Number(x);
      if (!Number.isFinite(n) || n < 0 || n > max) { p.add('resources', `${name} is out of range`); return 0; }
      return Math.round(n);
    };
    const memory = num(v.memory, 'memory', 2 ** 48);
    if (memory && memory < 6 * 1024 * 1024) p.add('resources', 'memory limit must be at least 6 MB');
    const cpus = v.cpus !== undefined && v.cpus !== null && v.cpus !== '' ? Number(v.cpus) : null;
    if (cpus !== null && (!Number.isFinite(cpus) || cpus < 0 || cpus > 1024)) p.add('resources', 'cpus is out of range');
    return {
      memory,
      memorySwap: num(v.memorySwap, 'memorySwap', 2 ** 48),
      nanoCpus: cpus !== null ? Math.round(cpus * 1e9) : num(v.nanoCpus, 'nanoCpus', 1024e9),
      cpuShares: num(v.cpuShares, 'cpuShares', 262144),
      pidsLimit: num(v.pidsLimit, 'pidsLimit', 4_194_304),
    };
  },
  capabilities(v, p) {
    if (!isObj(v)) { p.add('capabilities', 'must be {add: [], drop: []}'); return undefined; }
    const norm = (list, k) => {
      if (list === undefined || list === null) return [];
      if (!strList(list, LIMITS.caps, 40)) { p.add('capabilities', `${k} must be a list of capability names`); return []; }
      const out = [];
      for (const c of list) {
        const cap = c.trim().toUpperCase().replace(/^CAP_/, '');
        if (!CAP_RE.test(cap)) { p.add('capabilities', `${c.slice(0, 20)} is not a capability`); continue; }
        if (!out.includes(cap)) out.push(cap);
      }
      return out;
    };
    return { add: norm(v.add, 'add'), drop: norm(v.drop, 'drop') };
  },
  securityOpt(v, p) {
    if (!strList(v, LIMITS.securityOpt, 200)) { p.add('securityOpt', 'must be a short list of strings'); return undefined; }
    return v.map((s) => s.trim()).filter(Boolean);
  },
  privileged(v, p) { if (typeof v !== 'boolean') { p.add('privileged', 'must be true or false'); return undefined; } return v; },
  readOnlyRootfs(v, p) { if (typeof v !== 'boolean') { p.add('readOnlyRootfs', 'must be true or false'); return undefined; } return v; },
  user(v, p) { if (v === null || v === '') return null; if (typeof v !== 'string' || !USER_RE.test(v)) { p.add('user', 'must be user[:group] (name or id)'); return undefined; } return v; },
  workingDir(v, p) { if (v === null || v === '') return null; if (typeof v !== 'string' || !CONTAINER_PATH_RE.test(v)) { p.add('workingDir', 'must be an absolute path'); return undefined; } return v; },
  hostname(v, p) { if (v === null || v === '') return null; if (typeof v !== 'string' || !HOSTNAME_RE.test(v)) { p.add('hostname', 'is not a valid hostname'); return undefined; } return v; },
  dns(v, p) {
    if (!strList(v, LIMITS.dns, 45)) { p.add('dns', 'must be a list of up to 4 addresses'); return undefined; }
    if (!v.every((a) => IPV4_RE.test(a) || /^[0-9a-f:]{2,45}$/i.test(a))) { p.add('dns', 'entries must be IP addresses'); return undefined; }
    return [...v];
  },
  dnsSearch(v, p) {
    if (!strList(v, LIMITS.dnsSearch, 253) || !v.every((d) => HOSTNAME_RE.test(d))) { p.add('dnsSearch', 'must be a list of domains'); return undefined; }
    return [...v];
  },
  extraHosts(v, p) {
    if (!strList(v, LIMITS.extraHosts, 300)) { p.add('extraHosts', 'must be a list of host:ip'); return undefined; }
    const out = [];
    for (const h of v) {
      const m = h.match(/^([a-zA-Z0-9.-]{1,253}):(.+)$/);
      if (!m || !(IPV4_RE.test(m[2]) || /^[0-9a-f:]{2,45}$/i.test(m[2]) || m[2] === 'host-gateway')) { p.add('extraHosts', `${h.slice(0, 40)} must be host:ip`); continue; }
      out.push(h);
    }
    return out;
  },
  logging(v, p) {
    if (v === null) return null;
    if (!isObj(v) || !LOG_DRIVERS.includes(String(v.driver))) { p.add('logging', `driver must be one of ${LOG_DRIVERS.join(', ')}`); return undefined; }
    const options = {};
    if (v.options !== undefined) {
      if (!isObj(v.options) || Object.keys(v.options).length > LIMITS.logOptions) { p.add('logging', 'options must be a small object'); return undefined; }
      for (const [k, val] of Object.entries(v.options)) {
        if (!/^[a-z][a-z0-9-]{0,40}$/.test(k)) { p.add('logging', `option ${k.slice(0, 20)} is not valid`); continue; }
        options[k] = String(val).slice(0, 200);
      }
    }
    return { driver: v.driver, options };
  },
  tty(v, p) { if (typeof v !== 'boolean') { p.add('tty', 'must be true or false'); return undefined; } return v; },
  stdinOpen(v, p) { if (typeof v !== 'boolean') { p.add('stdinOpen', 'must be true or false'); return undefined; } return v; },
  init(v, p) { if (typeof v !== 'boolean') { p.add('init', 'must be true or false'); return undefined; } return v; },
  stopSignal(v, p) { if (v === null || v === '') return null; if (typeof v !== 'string' || !SIGNAL_RE.test(v.toUpperCase())) { p.add('stopSignal', 'must be a signal name'); return undefined; } return v.toUpperCase(); },
  stopTimeout(v, p) {
    if (v === null || v === '' || v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 600) { p.add('stopTimeout', 'must be 1–600 seconds'); return undefined; }
    return n;
  },
  devices(v, p) {
    if (!Array.isArray(v) || v.length > LIMITS.devices) { p.add('devices', `must be a list of at most ${LIMITS.devices}`); return undefined; }
    const out = [];
    for (const raw of v) {
      const e = typeof raw === 'string' ? parseDeviceString(raw) : raw;
      if (!isObj(e) || !DEVICE_RE.test(String(e.host || ''))) { p.add('devices', 'each entry needs a /dev host path'); continue; }
      const container = e.container ? String(e.container) : e.host;
      if (!DEVICE_RE.test(container)) { p.add('devices', 'container device path must be under /dev'); continue; }
      const permissions = String(e.permissions || 'rwm');
      if (!/^[rwm]{1,3}$/.test(permissions)) { p.add('devices', 'permissions must be a combination of r, w, m'); continue; }
      if (/(^|\/)\.\.(\/|$)/.test(e.host)) { p.add('devices', 'device path must not contain ".."'); continue; }
      out.push({ host: normalizePath(e.host), container, permissions });
    }
    return out;
  },
};

/** Defaults for a brand-new spec, so a create never sends an undefined where the daemon wants a value. */
export const SPEC_DEFAULTS = Object.freeze({
  name: null, command: null, entrypoint: null, env: {}, labels: {}, ports: [], volumes: [], networks: [],
  networkMode: 'bridge', restartPolicy: { name: 'unless-stopped', maxRetries: 0 }, healthcheck: null,
  resources: { memory: 0, memorySwap: 0, nanoCpus: 0, cpuShares: 0, pidsLimit: 0 },
  capabilities: { add: [], drop: [] }, securityOpt: [], privileged: false, readOnlyRootfs: false,
  user: null, workingDir: null, hostname: null, dns: [], dnsSearch: [], extraHosts: [], logging: null,
  tty: false, stdinOpen: false, init: false, stopSignal: null, stopTimeout: null, devices: [],
});

/**
 * Normalize a *complete* spec (a create or a compose service). Missing optional fields take the
 * defaults; `image` is required. Unknown keys are refused.
 */
export function normalizeSpec(raw) {
  const p = new Problems();
  if (!isObj(raw)) return { ok: false, errors: ['spec must be an object'], spec: null };
  const unknown = Object.keys(raw).filter((k) => !SPEC_FIELDS.includes(k));
  if (unknown.length) return { ok: false, errors: [`unsupported field${unknown.length > 1 ? 's' : ''}: ${unknown.slice(0, 6).join(', ')}`], spec: null };
  if (raw.image === undefined) p.add('image', 'is required');
  const spec = {};
  for (const f of SPEC_FIELDS) {
    if (raw[f] === undefined) { if (f !== 'image') spec[f] = structuredClone(SPEC_DEFAULTS[f]); continue; }
    const v = FIELD_READERS[f](raw[f], p);
    if (v !== undefined) spec[f] = v;
  }
  if (spec.networkMode && ['host', 'none'].includes(spec.networkMode) && spec.networks?.length) p.add('networks', `cannot attach networks in ${spec.networkMode} network mode`);
  if (spec.networkMode === 'host' && spec.ports?.length) p.add('ports', 'published ports are meaningless in host network mode');
  return p.ok ? { ok: true, errors: [], spec } : { ok: false, errors: p.list, spec: null };
}

/** Normalize a *partial* spec (an edit). Only the present fields are validated and returned. */
export function normalizeSpecPatch(raw) {
  const p = new Problems();
  if (!isObj(raw)) return { ok: false, errors: ['spec must be an object'], patch: null };
  const unknown = Object.keys(raw).filter((k) => !SPEC_FIELDS.includes(k));
  if (unknown.length) return { ok: false, errors: [`unsupported field${unknown.length > 1 ? 's' : ''}: ${unknown.slice(0, 6).join(', ')}`], patch: null };
  const patch = {};
  for (const f of SPEC_FIELDS) {
    if (raw[f] === undefined) continue;
    const v = FIELD_READERS[f](raw[f], p);
    if (v !== undefined) patch[f] = v;
  }
  return p.ok ? { ok: true, errors: [], patch } : { ok: false, errors: p.list, patch: null };
}

/**
 * Apply a patch to a spec — field-level replacement, never a deep merge (a diff must be exact).
 *
 * One exception, for the editor: an env value that arrives as the *masked placeholder* of the
 * current value (the browser only ever saw the mask) means "keep the value you have". The real
 * value never left the server, so it cannot be "changed back" to the mask by accident.
 */
export function applyPatch(spec, patch) {
  const next = structuredClone(spec);
  for (const [k, v] of Object.entries(patch || {})) {
    if (!SPEC_FIELDS.includes(k)) continue;
    if (k === 'env' && v && typeof v === 'object' && spec?.env) {
      const env = {};
      for (const [key, val] of Object.entries(v)) env[key] = isMaskOf(val, spec.env[key]) ? spec.env[key] : val;
      next.env = env;
      continue;
    }
    next[k] = structuredClone(v);
  }
  return next;
}

/** True when `val` is exactly what the browser was shown for `current` (see containers/diff.js). */
function isMaskOf(val, current) {
  if (current === undefined || typeof val !== 'string' || !val.startsWith('••••')) return false;
  const s = String(current ?? '');
  return val === (s.length ? `••••${s.length > 8 ? s.slice(-2) : ''}` : '');
}

/* ------------------------------------------------------------------ */
/* spec → engine bodies                                                */
/* ------------------------------------------------------------------ */

/**
 * The create body. Every key written here is one of the allow-listed fields above; there is no
 * spread of a client object into it anywhere.
 */
export function createBodyFromSpec(spec, { extraLabels = null } = {}) {
  const env = Object.entries(spec.env || {}).map(([k, v]) => `${k}=${v}`);
  const exposed = {};
  const bindings = {};
  for (const pt of spec.ports || []) {
    const key = `${pt.container}/${pt.protocol}`;
    exposed[key] = {};
    (bindings[key] ||= []).push({ HostIp: pt.hostIp || '', HostPort: pt.host ? String(pt.host) : '' });
  }
  const binds = [];
  const tmpfs = {};
  for (const v of spec.volumes || []) {
    if (v.type === 'tmpfs') tmpfs[v.target] = v.options || '';
    else binds.push(`${v.source}:${v.target}${v.readOnly ? ':ro' : ''}`);
  }
  const networks = spec.networks || [];
  const mode = spec.networkMode || 'bridge';
  const primary = ['host', 'none'].includes(mode) ? null : (networks[0] || (mode !== 'bridge' ? { name: mode, aliases: [], ipv4: null } : null));
  const networkMode = ['host', 'none'].includes(mode) ? mode : (primary ? primary.name : 'bridge');
  const endpoint = (n) => ({
    Aliases: n.aliases?.length ? [...n.aliases] : undefined,
    IPAMConfig: n.ipv4 ? { IPv4Address: n.ipv4 } : undefined,
  });
  const hc = spec.healthcheck;
  const labels = { ...(spec.labels || {}), ...(extraLabels || {}) };
  const body = {
    Image: spec.image,
    Hostname: spec.hostname || undefined,
    User: spec.user || undefined,
    WorkingDir: spec.workingDir || undefined,
    Entrypoint: spec.entrypoint || undefined,
    Cmd: spec.command || undefined,
    Env: env,
    Labels: labels,
    ExposedPorts: exposed,
    Tty: spec.tty === true,
    OpenStdin: spec.stdinOpen === true,
    StopSignal: spec.stopSignal || undefined,
    StopTimeout: Number.isInteger(spec.stopTimeout) ? spec.stopTimeout : undefined,
    Healthcheck: hc
      ? (hc.test[0] === 'NONE' ? { Test: ['NONE'] } : {
        Test: [...hc.test],
        Interval: msToNs(hc.intervalMs), Timeout: msToNs(hc.timeoutMs),
        Retries: Number.isInteger(hc.retries) ? hc.retries : 0, StartPeriod: msToNs(hc.startPeriodMs),
      })
      : undefined,
    HostConfig: {
      Binds: binds,
      Tmpfs: Object.keys(tmpfs).length ? tmpfs : undefined,
      NetworkMode: networkMode,
      PortBindings: bindings,
      RestartPolicy: { Name: spec.restartPolicy?.name || 'no', MaximumRetryCount: spec.restartPolicy?.maxRetries || 0 },
      Init: spec.init === true ? true : undefined,
      Privileged: spec.privileged === true,
      ReadonlyRootfs: spec.readOnlyRootfs === true,
      SecurityOpt: spec.securityOpt?.length ? [...spec.securityOpt] : undefined,
      CapAdd: spec.capabilities?.add?.length ? [...spec.capabilities.add] : undefined,
      CapDrop: spec.capabilities?.drop?.length ? [...spec.capabilities.drop] : undefined,
      Memory: spec.resources?.memory || 0,
      MemorySwap: spec.resources?.memorySwap || 0,
      NanoCpus: spec.resources?.nanoCpus || 0,
      CpuShares: spec.resources?.cpuShares || 0,
      PidsLimit: spec.resources?.pidsLimit || undefined,
      Dns: spec.dns?.length ? [...spec.dns] : undefined,
      DnsSearch: spec.dnsSearch?.length ? [...spec.dnsSearch] : undefined,
      ExtraHosts: spec.extraHosts?.length ? [...spec.extraHosts] : undefined,
      LogConfig: spec.logging ? { Type: spec.logging.driver, Config: { ...(spec.logging.options || {}) } } : undefined,
      Devices: spec.devices?.length ? spec.devices.map((d) => ({ PathOnHost: d.host, PathInContainer: d.container, CgroupPermissions: d.permissions })) : undefined,
    },
    NetworkingConfig: primary ? { EndpointsConfig: { [primary.name]: endpoint(primary) } } : undefined,
  };
  const auxiliaryNetworks = primary ? networks.filter((n) => n.name !== primary.name).map((n) => ({ name: n.name, endpointConfig: endpoint(n) })) : [];
  return { createBody: body, auxiliaryNetworks, primaryNetwork: primary?.name || null };
}

/** The in-place update body, for the fields the daemon lets us change without a recreate. */
export function updateBodyFromSpec(spec, fields) {
  const body = {};
  if (fields.includes('restartPolicy')) body.RestartPolicy = { Name: spec.restartPolicy?.name || 'no', MaximumRetryCount: spec.restartPolicy?.maxRetries || 0 };
  if (fields.includes('resources')) {
    body.Memory = spec.resources?.memory || 0;
    body.MemorySwap = spec.resources?.memorySwap || 0;
    body.NanoCpus = spec.resources?.nanoCpus || 0;
    body.CpuShares = spec.resources?.cpuShares || 0;
    if (spec.resources?.pidsLimit) body.PidsLimit = spec.resources.pidsLimit;
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function normalizePath(pth) {
  return String(pth).replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

/** "8080:80/tcp", "127.0.0.1:8080:80", "80" */
export function parsePortString(s) {
  const m = String(s).trim().match(/^(?:(\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3}):)?(?:(\d{1,5}):)?(\d{1,5})(?:\/(tcp|udp|sctp))?$/i);
  if (!m) return null;
  return { hostIp: m[1] ? m[1].replace(/^\[|\]$/g, '') : null, host: m[2] ? Number(m[2]) : (m[1] ? null : Number(m[3])), container: Number(m[3]), protocol: (m[4] || 'tcp').toLowerCase() };
}

/** "/host:/ctr:ro", "name:/ctr", "/ctr" (anonymous volume → not supported: refused) */
export function parseVolumeString(s) {
  const parts = String(s).trim().split(':');
  if (parts.length === 1) return null;
  const [source, target, opts = ''] = parts;
  const readOnly = opts.split(',').includes('ro');
  return { type: source.startsWith('/') || source.startsWith('.') || source.startsWith('~') ? 'bind' : 'volume', source, target, readOnly };
}

export function parseDeviceString(s) {
  const [host, container, permissions] = String(s).trim().split(':');
  return { host, container: container || host, permissions: permissions || 'rwm' };
}

/** "512m", "2g", "1024k" → bytes */
export function sizeToBytes(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i);
  if (!m) return NaN;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}

/** "30s", "1m30s", "500ms", "1h" → ms */
export function durationToMs(s) {
  const str = String(s).trim();
  if (/^\d+$/.test(str)) return Number(str);
  let total = 0;
  let matched = false;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    matched = true;
    total += Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
  }
  return matched ? total : NaN;
}

export const _internals = Object.freeze({ FIELD_READERS, NAME_RE, RESTART_POLICIES, NETWORK_MODES, LOG_DRIVERS });
