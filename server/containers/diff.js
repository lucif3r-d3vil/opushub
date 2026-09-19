// The configuration diff — what the confirmation dialog shows before an edit, a recreate, a
// duplicate or a stack deployment is applied.
//
//   CURRENT   image: jellyfin/jellyfin:latest
//   NEW       image: jellyfin/jellyfin:10.10.7
//   CHANGES   + image changed · ~ environment changed · unchanged: volumes, networks
//
// The diff is computed over canonical specs (containers/spec.js), field by field, so it is exact:
// two specs that differ only in key order are "unchanged". Environment VALUES are masked when
// the key looks like a secret, because this document crosses the API boundary to the operator's
// browser and will be pasted into bug reports.
import { SPEC_FIELDS, IN_PLACE_FIELDS } from './spec.js';
import { canonicalJson } from '../operations/params.js';

const SECRET_KEY = /(PASS(WOR)?D|PASSWD|SECRET|TOKEN|API[_-]?KEY|CREDENTIALS?|PRIVATE[_-]?KEY|AUTH|COOKIE|SESSION|LICENSE)/i;

export const FIELD_LABELS = Object.freeze({
  image: 'image', name: 'name', command: 'command', entrypoint: 'entrypoint', env: 'environment',
  labels: 'labels', ports: 'ports', volumes: 'volumes', networks: 'networks', networkMode: 'network mode',
  restartPolicy: 'restart policy', healthcheck: 'healthcheck', resources: 'resource limits',
  capabilities: 'capabilities', securityOpt: 'security options', privileged: 'privileged',
  readOnlyRootfs: 'read-only root filesystem', user: 'user', workingDir: 'working directory',
  hostname: 'hostname', dns: 'DNS', dnsSearch: 'DNS search', extraHosts: 'extra hosts', logging: 'logging',
  tty: 'TTY', stdinOpen: 'stdin', init: 'init', stopSignal: 'stop signal', stopTimeout: 'stop timeout', devices: 'devices',
});

/** Mask a value whose key looks secret. Length is kept so "changed" stays visible. */
export function maskEnvValue(key, value) {
  if (!SECRET_KEY.test(String(key))) return value;
  const s = String(value ?? '');
  return s.length ? `••••${s.length > 8 ? s.slice(-2) : ''}` : '';
}

function maskEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) out[k] = maskEnvValue(k, v);
  return out;
}

/** One field, rendered for a human — a short, deterministic string. */
export function renderField(field, value) {
  if (value === null || value === undefined) return '—';
  switch (field) {
    case 'command': case 'entrypoint': return Array.isArray(value) ? value.join(' ') : String(value);
    case 'env': return Object.entries(maskEnv(value)).map(([k, v]) => `${k}=${v}`).join('\n') || '—';
    case 'labels': return Object.entries(value).map(([k, v]) => `${k}=${v}`).join('\n') || '—';
    case 'ports': return value.map((p) => `${p.hostIp ? `${p.hostIp}:` : ''}${p.host ?? ''}${p.host ? ':' : ''}${p.container}/${p.protocol}`).join('\n') || '—';
    case 'volumes': return value.map((v) => (v.type === 'tmpfs' ? `tmpfs → ${v.target}` : `${v.source} → ${v.target}${v.readOnly ? ' (ro)' : ''}`)).join('\n') || '—';
    case 'networks': return value.map((n) => `${n.name}${n.aliases?.length ? ` (${n.aliases.join(', ')})` : ''}${n.ipv4 ? ` ${n.ipv4}` : ''}`).join('\n') || '—';
    case 'restartPolicy': return `${value.name}${value.name === 'on-failure' && value.maxRetries ? `:${value.maxRetries}` : ''}`;
    case 'healthcheck': return value.test?.[0] === 'NONE' ? 'disabled' : `${(value.test || []).slice(1).join(' ')}${value.intervalMs ? ` every ${value.intervalMs / 1000}s` : ''}${value.retries ? ` × ${value.retries}` : ''}`;
    case 'resources': {
      const parts = [];
      if (value.memory) parts.push(`memory ${fmtBytes(value.memory)}`);
      if (value.memorySwap) parts.push(`swap ${fmtBytes(value.memorySwap)}`);
      if (value.nanoCpus) parts.push(`cpus ${value.nanoCpus / 1e9}`);
      if (value.cpuShares) parts.push(`shares ${value.cpuShares}`);
      if (value.pidsLimit) parts.push(`pids ${value.pidsLimit}`);
      return parts.join(', ') || 'unlimited';
    }
    case 'capabilities': return [...(value.add || []).map((c) => `+${c}`), ...(value.drop || []).map((c) => `-${c}`)].join(' ') || '—';
    case 'devices': return value.map((d) => `${d.host}${d.container !== d.host ? ` → ${d.container}` : ''} (${d.permissions})`).join('\n') || '—';
    case 'logging': return `${value.driver}${Object.keys(value.options || {}).length ? ` ${Object.entries(value.options).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`;
    case 'securityOpt': case 'dns': case 'dnsSearch': case 'extraHosts': return value.join('\n') || '—';
    case 'stopTimeout': return `${value}s`;
    default: return typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
  }
}

function fmtBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n % 1024 ** 3 ? 1 : 0)} GiB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MiB`;
  return `${Math.round(n / 1024)} KiB`;
}

function envDelta(a, b) {
  const added = [], removed = [], changed = [];
  for (const k of Object.keys(b || {})) {
    if (!(k in (a || {}))) added.push(k);
    else if (a[k] !== b[k]) changed.push(k);
  }
  for (const k of Object.keys(a || {})) if (!(k in (b || {}))) removed.push(k);
  return { added, removed, changed };
}

/**
 * Diff two specs.
 *
 * @returns {{
 *   changed: string[], unchanged: string[], entries: object[], inPlace: boolean, recreate: boolean,
 *   summary: string[], current: object, next: object
 * }}
 */
export function diffSpecs(current, next, { fields = SPEC_FIELDS } = {}) {
  const changed = [];
  const unchanged = [];
  const entries = [];
  for (const f of fields) {
    if (!SPEC_FIELDS.includes(f)) continue;
    const a = current ? current[f] : undefined;
    const b = next ? next[f] : undefined;
    const same = canonicalJson(a ?? null) === canonicalJson(b ?? null);
    if (same) { unchanged.push(f); continue; }
    changed.push(f);
    const entry = {
      field: f,
      label: FIELD_LABELS[f] || f,
      kind: a === undefined || a === null || (Array.isArray(a) && !a.length) || (a && typeof a === 'object' && !Array.isArray(a) && !Object.keys(a).length) ? 'added'
        : b === undefined || b === null || (Array.isArray(b) && !b.length) || (b && typeof b === 'object' && !Array.isArray(b) && !Object.keys(b).length) ? 'removed' : 'changed',
      current: renderField(f, a),
      next: renderField(f, b),
      inPlace: IN_PLACE_FIELDS.includes(f),
    };
    if (f === 'env' || f === 'labels') entry.keys = envDelta(a, b);
    entries.push(entry);
  }
  const inPlace = changed.length > 0 && changed.every((f) => IN_PLACE_FIELDS.includes(f));
  const summary = [
    ...entries.map((e) => `${e.kind === 'added' ? '+' : e.kind === 'removed' ? '-' : '~'} ${e.label} ${e.kind}`),
    ...(unchanged.length ? [`unchanged: ${unchanged.map((f) => FIELD_LABELS[f] || f).join(', ')}`] : []),
  ];
  return {
    changed, unchanged, entries, inPlace, recreate: changed.length > 0 && !inPlace, summary,
    current: publicSpec(current), next: publicSpec(next),
  };
}

/** A spec as the browser may see it: environment values masked when the key looks secret. */
export function publicSpec(spec) {
  if (!spec) return null;
  const out = {};
  for (const f of SPEC_FIELDS) {
    if (spec[f] === undefined) continue;
    out[f] = f === 'env' ? maskEnv(spec[f]) : structuredClone(spec[f]);
  }
  if (spec._unsupported) out.unsupported = { ...spec._unsupported };
  return out;
}

/** Event-safe: the names of the fields that changed, and nothing else. */
export function eventSummary(diff) {
  return { changed: [...diff.changed], recreate: diff.recreate, inPlace: diff.inPlace };
}
