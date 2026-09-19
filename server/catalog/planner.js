// Catalog planner — manifest + operator configuration → canonical container spec + install plan.
//
// Runs inside the policy evaluation (dry-run and execution see the same plan). It never writes.
//
//   config (params.config, bounded plain object)  ─┐
//   manifest (server data)                          ├─► variables (typed, validated)
//                                                   │   ─► ${var} rendering over the manifest only
//                                                   │   ─► canonical spec (containers/spec.js normalizeSpec)
//                                                   │   ─► containers/policy.js classifySpec
//                                                   └─► plan { steps, resources, integrations, next, diff }
//
// The config's *shape* is fixed here: the operator may set `name`, `version` (or `tag`/`digest`
// when the manifest allows), `variables`, `ports`, `volumes`, `network`, `expose`, `restartPolicy`,
// `healthcheck` (on/off), `monitoring`, `autoheal`, `updates`. Nothing in the config reaches the
// spec except through these typed slots — there is no "extra spec" passthrough.
import * as docker from '../providers/docker.js';
import { normalizeSpec } from '../containers/spec.js';
import { classifySpec } from '../containers/policy.js';
import { diffSpecs, maskEnvValue } from '../containers/diff.js';
import { operationError } from '../operations/model.js';
import { getManifest } from './schema.js';
import { renderDeep, render } from './template.js';
import { activeProvider, normalizeExpose } from '../proxy/provider.js';
import * as registryStore from '../registries/store.js';
import { registryHostOf } from '../registries/endpoint.js';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const NETWORK_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const TZ_RE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const CONFIG_KEYS = ['name', 'version', 'tag', 'digest', 'registryId', 'variables', 'ports', 'volumes', 'network', 'expose', 'restartPolicy', 'healthcheck', 'monitoring', 'autoheal', 'updates'];
export const MANAGED_LABEL = 'io.opushub.catalog';

const fail = (code, reason, detail = null) => ({ ok: false, plan: null, policy: null, error: operationError(code, reason, detail) });

/* ------------------------------------------------------------------ */
/* target                                                              */
/* ------------------------------------------------------------------ */

/** A catalog target is a manifest id; the requested container name rides along for locking. */
export async function resolveCatalogTarget(ref, params = null) {
  const manifest = getManifest(ref?.id);
  if (!manifest) return { ok: false, error: operationError('not_found', 'There is no catalog entry with that id.', ref?.id || null) };
  const name = typeof params?.config?.name === 'string' && NAME_RE.test(params.config.name) ? params.config.name : manifest.id;
  return { ok: true, target: { type: 'catalog', id: manifest.id, name, label: manifest.name, self: false, manifest } };
}

/* ------------------------------------------------------------------ */
/* configuration → variables                                           */
/* ------------------------------------------------------------------ */

function readVariables(manifest, raw, problems) {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const declared = new Set(manifest.variables.map((v) => v.key));
  for (const k of Object.keys(given)) if (!declared.has(k)) problems.push(`variable ${k} is not declared by this manifest`);
  const vars = {};
  // `generate` is a hint to the UI (offer a random value); the server never invents a secret,
  // because an operation result is persisted and a generated password would persist with it.
  for (const v of manifest.variables) {
    let val = given[v.key];
    if (val === undefined || val === null || val === '') {
      if (v.default !== null && v.default !== undefined) val = v.default;
      else if (v.required) { problems.push(`${v.label} is required`); continue; }
      else { vars[v.key] = ''; continue; }
    }
    switch (v.kind) {
      case 'number': case 'port': {
        const n = Number(val);
        const lo = v.min ?? (v.kind === 'port' ? 1 : -1e12); const hi = v.max ?? (v.kind === 'port' ? 65535 : 1e12);
        if (!Number.isFinite(n) || (v.kind === 'port' && !Number.isInteger(n)) || n < lo || n > hi) { problems.push(`${v.label} must be a number between ${lo} and ${hi}`); continue; }
        vars[v.key] = String(n); break;
      }
      case 'boolean': vars[v.key] = val === true || val === 'true' ? 'true' : 'false'; break;
      case 'enum': if (!v.options.includes(String(val))) { problems.push(`${v.label} must be one of ${v.options.join(', ')}`); continue; } vars[v.key] = String(val); break;
      case 'path': { const s = String(val); if (!/^\/[^\0]{0,1023}$/.test(s) || /(^|\/)\.\.(\/|$)/.test(s)) { problems.push(`${v.label} must be an absolute path`); continue; } vars[v.key] = s.replace(/\/+$/, '') || '/'; break; }
      case 'timezone': { const s = String(val); if (!TZ_RE.test(s) || s.length > 64) { problems.push(`${v.label} must be a timezone like Europe/Berlin`); continue; } vars[v.key] = s; break; }
      default: {
        const s = String(val);
        if (s.length > 4096 || /[\0\r\n]/.test(s)) { problems.push(`${v.label} is too long or contains line breaks`); continue; }
        if (v.pattern && !new RegExp(v.pattern).test(s)) { problems.push(`${v.label} does not match the expected format`); continue; }
        if (v.min !== null && s.length < v.min) { problems.push(`${v.label} must be at least ${v.min} characters`); continue; }
        vars[v.key] = s;
      }
    }
  }
  return { vars };
}

function chooseImage(manifest, config, problems) {
  const versions = manifest.image.versions;
  if (config.digest !== undefined) {
    if (!manifest.image.allowDigest) { problems.push('this catalog entry does not accept a digest'); return null; }
    if (!DIGEST_RE.test(String(config.digest))) { problems.push('digest must be sha256:<64 hex>'); return null; }
    return { ref: `${manifest.image.repository}@${config.digest}`, version: config.digest.slice(0, 19), pinned: true };
  }
  const tag = config.tag !== undefined ? String(config.tag) : config.version !== undefined ? String(config.version) : null;
  if (tag === null) {
    const rec = versions.find((v) => v.recommended) || versions[0];
    return { ref: `${manifest.image.repository}:${rec.tag}`, version: rec.tag, pinned: false };
  }
  if (!TAG_RE.test(tag)) { problems.push('version is not a valid tag'); return null; }
  if (!versions.some((v) => v.tag === tag) && !manifest.image.allowCustomTag) { problems.push(`version ${tag} is not one of the catalog's versions`); return null; }
  return { ref: `${manifest.image.repository}:${tag}`, version: tag, pinned: false };
}

/* ------------------------------------------------------------------ */
/* plan                                                                */
/* ------------------------------------------------------------------ */

/**
 * Build the spec and the plan. Pure with respect to Docker except for two reads: whether the
 * image is already present and which networks/containers exist (for the diff and the conflicts).
 */
export async function buildInstall(manifest, rawConfig) {
  const problems = [];
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  for (const k of Object.keys(config)) if (!CONFIG_KEYS.includes(k)) problems.push(`config.${k} is not an install setting`);

  const name = config.name === undefined ? manifest.id : String(config.name);
  if (!NAME_RE.test(name)) problems.push('name must be a valid container name');

  const { vars } = readVariables(manifest, config.variables, problems);
  const scope = { ...vars, name };
  const image = chooseImage(manifest, config, problems);
  if (problems.length) return { ok: false, problems };

  // env: manifest env (rendered) — operator variables reach the container ONLY through the manifest's mapping
  const env = renderDeep(manifest.env, scope, 'env');
  if (!env.ok) problems.push(...env.missing.map((m) => `unresolved ${m}`));

  // ports: manifest declares container ports; operator picks host ports (or none)
  const givenPorts = config.ports && typeof config.ports === 'object' && !Array.isArray(config.ports) ? config.ports : {};
  for (const k of Object.keys(givenPorts)) if (!manifest.ports.some((p) => `${p.container}/${p.protocol}` === k || String(p.container) === k)) problems.push(`port ${k} is not declared by this manifest`);
  const ports = [];
  for (const p of manifest.ports) {
    const key = `${p.container}/${p.protocol}`;
    const given = givenPorts[key] !== undefined ? givenPorts[key] : givenPorts[String(p.container)];
    let host;
    if (given === undefined) { const d = typeof p.host === 'string' ? render(p.host, scope) : { ok: true, value: p.host }; if (!d.ok) { problems.push(`port ${key}: unresolved ${d.missing.join(', ')}`); continue; } host = d.value === null ? null : Number(d.value); }
    else if (given === null || given === '' || given === false) host = null;
    else { host = Number(given); if (!Number.isInteger(host) || host < 1 || host > 65535) { problems.push(`port ${key}: host port must be 1–65535 or empty`); continue; } }
    if (host === null && p.required) problems.push(`port ${key} (${p.label}) must be published`);
    // an unpublished port stays unpublished (the image's EXPOSE still documents it); publishing
    // to an ephemeral host port is never what a catalog install means
    if (host !== null) ports.push({ container: p.container, protocol: p.protocol, host, hostIp: null });
  }

  // volumes: each manifest target gets a named volume (default) or a bind the operator chose
  const givenVols = config.volumes && typeof config.volumes === 'object' && !Array.isArray(config.volumes) ? config.volumes : {};
  for (const k of Object.keys(givenVols)) if (!manifest.volumes.some((v) => v.target === k)) problems.push(`volume ${k} is not declared by this manifest`);
  const volumes = [];
  const namedVolumes = [];
  for (const v of manifest.volumes) {
    const d = render(v.default, scope);
    if (!d.ok) { problems.push(`volume ${v.target}: unresolved ${d.missing.join(', ')}`); continue; }
    const choice = givenVols[v.target] !== undefined ? String(givenVols[v.target]) : d.value;
    if (choice.startsWith('volume:')) {
      const vol = choice.slice(7);
      if (!VOLUME_NAME_RE.test(vol)) { problems.push(`volume ${v.target}: ${vol.slice(0, 40)} is not a volume name`); continue; }
      volumes.push({ type: 'volume', source: vol, target: v.target, readOnly: v.readOnly });
      namedVolumes.push(vol);
    } else {
      if (!v.allowBind) { problems.push(`volume ${v.target} must be a named volume for this service`); continue; }
      if (!/^\/[^\0]{0,1023}$/.test(choice) || /(^|\/)\.\.(\/|$)/.test(choice)) { problems.push(`volume ${v.target}: a host path must be absolute`); continue; }
      volumes.push({ type: 'bind', source: choice, target: v.target, readOnly: v.readOnly });
    }
  }

  // network: bridge | dedicated (<name>_net, created) | an existing named network
  const netChoice = config.network === undefined ? manifest.network.default : String(config.network);
  let networks = [];
  let networkMode = 'bridge';
  const createNetworks = [];
  if (netChoice === 'bridge') { /* default */ }
  else if (netChoice === 'dedicated') { const n = `${name}_net`; if (!NETWORK_RE.test(n)) problems.push('name is too long for a dedicated network'); else { networks = [{ name: n, aliases: manifest.network.aliases, ipv4: null }]; networkMode = n; createNetworks.push(n); } }
  else if (['host', 'none'].includes(netChoice) || netChoice.startsWith('container:')) problems.push(`network ${netChoice} is not offered by the catalog — installs get an isolated bridge network`);
  else if (NETWORK_RE.test(netChoice)) { networks = [{ name: netChoice, aliases: manifest.network.aliases, ipv4: null }]; networkMode = netChoice; }
  else problems.push('network must be bridge, dedicated, or an existing network name');

  // reverse proxy (through the provider abstraction — the manifest only says which port)
  const provider = activeProvider();
  let expose = null;
  let proxyLabels = {};
  if (config.expose !== undefined && config.expose !== null && config.expose !== false) {
    if (!manifest.proxy) problems.push('this catalog entry does not declare a web port to expose');
    else {
      const e = normalizeExpose({ ...(typeof config.expose === 'object' ? config.expose : {}), port: manifest.proxy.port, scheme: manifest.proxy.scheme });
      if (!e.ok) problems.push(e.reason);
      else if (!provider.available) problems.push(`no reverse-proxy provider is configured on this OpusHub (OPUSHUB_PROXY_PROVIDER), so ${e.expose.domain} cannot be routed`);
      else {
        expose = e.expose;
        proxyLabels = provider.labelsFor(expose, { name });
        if (provider.network && !networks.some((n) => n.name === provider.network)) networks.push({ name: provider.network, aliases: [], ipv4: null });
      }
    }
  }

  const restartPolicy = config.restartPolicy === undefined ? manifest.restartPolicy : String(config.restartPolicy);
  if (!['no', 'always', 'unless-stopped', 'on-failure'].includes(restartPolicy)) problems.push('restartPolicy is not a Docker restart policy');
  const healthOn = config.healthcheck === undefined ? !!manifest.healthcheck : config.healthcheck !== false;
  if (healthOn && !manifest.healthcheck) problems.push('this catalog entry has no healthcheck to enable');
  const monitoring = config.monitoring === undefined ? manifest.monitoring.default : config.monitoring !== false;
  const autoheal = config.autoheal === undefined ? manifest.autoheal.default : config.autoheal === true;
  const updates = config.updates === undefined ? manifest.updates.default : config.updates !== false;
  if (autoheal && !healthOn) problems.push('Autoheal needs the healthcheck enabled — it restarts containers Docker reports unhealthy');
  if (config.registryId !== undefined && !registryStore.getRegistry(String(config.registryId))) problems.push('registryId does not name a stored registry');

  // fixed container fields + rendered argv/user
  const c = renderDeep(manifest.container, scope, 'container');
  if (!c.ok) problems.push(...c.missing.map((m) => `unresolved ${m}`));
  const lbl = renderDeep(manifest.labels, scope, 'labels');
  const hc = renderDeep(manifest.healthcheck?.test || [], scope, 'healthcheck.test');
  if (!hc.ok) problems.push(...hc.missing.map((m) => `unresolved ${m}`));
  if (!lbl.ok) problems.push(...lbl.missing.map((m) => `unresolved ${m}`));
  if (problems.length) return { ok: false, problems };

  const labels = {
    ...lbl.value,
    [MANAGED_LABEL]: manifest.id,
    [`${MANAGED_LABEL}.version`]: image.version,
    'opushub.name': manifest.name,
    'opushub.update': updates ? 'true' : 'false',
    ...(updates ? { 'diun.enable': 'true' } : {}),
    ...(autoheal ? { autoheal: 'true' } : {}),
    ...proxyLabels,
  };

  const raw = {
    image: image.ref, name, env: env.value, labels, ports, volumes, networks, networkMode,
    restartPolicy: { name: restartPolicy, maxRetries: 0 },
    healthcheck: healthOn ? { test: hc.value, interval: manifest.healthcheck.intervalMs, timeout: manifest.healthcheck.timeoutMs, retries: manifest.healthcheck.retries, startPeriod: manifest.healthcheck.startPeriodMs } : null,
    ...c.value,
  };
  const norm = normalizeSpec(raw);
  if (!norm.ok) return { ok: false, problems: norm.errors };

  return {
    ok: true,
    spec: norm.spec, image, name, vars, expose, provider: { id: provider.id, label: provider.label, network: provider.network },
    createNetworks, namedVolumes,
    integrations: { monitoring: monitoring ? { type: manifest.monitoring.type, path: manifest.monitoring.path, expectStatus: manifest.monitoring.expectStatus } : null, autoheal, updates, proxy: expose ? { domain: expose.domain, url: provider.urlFor(expose) } : null },
  };
}

/** The planner entry the policy evaluation calls. */
export async function planInstall(action, target, params) {
  const manifest = target.manifest || getManifest(target.id);
  if (!manifest) return fail('not_found', 'There is no catalog entry with that id.');
  const built = await buildInstall(manifest, params?.config || {});
  if (!built.ok) return fail('bad_params', built.problems[0], built.problems.slice(1, 6).join('; ') || null);
  const { spec } = built;

  // conflicts against Docker (the source of truth)
  let containers = [];
  try { containers = await docker.listContainers({ all: true }); } catch { return fail('docker_unavailable', 'Docker is not reachable, so the installation cannot be planned.'); }
  if (containers.some((c) => c.name === spec.name)) return fail('name_taken', `A container named ${spec.name} already exists. Choose another name.`);
  const usedPorts = new Set(containers.flatMap((c) => (c.ports || []).filter((p) => p.public).map((p) => `${p.public}/${p.type}`)));
  const portClash = spec.ports.find((p) => p.host && usedPorts.has(`${p.host}/${p.protocol}`));
  if (portClash) return fail('port_in_use', `Host port ${portClash.host}/${portClash.protocol} is already published by another container.`);
  let networks = [];
  try { networks = await docker.listNetworksRaw(); } catch { networks = []; }
  const netNames = new Set(networks.map((n) => n.name));
  for (const n of spec.networks) if (!built.createNetworks.includes(n.name) && !netNames.has(n.name)) return fail('network_missing', `Network ${n.name} does not exist on this host.`);
  if (built.createNetworks.some((n) => netNames.has(n))) return fail('network_taken', `Network ${built.createNetworks[0]} already exists; choose another name or select it as an existing network.`);
  const imagePresent = !!(await docker.imageInfo(spec.image).catch(() => null));

  const policy = classifySpec(spec);
  const reg = built.image ? registryStore.registriesForHost(registryHostOf(spec.image)) : [];
  const auth = params?.config?.registryId ? registryStore.getRegistry(String(params.config.registryId)) : reg[0] || null;

  const steps = [
    imagePresent ? `image ${spec.image} is present` : `pull ${spec.image}${auth ? ` (credentials: ${auth.name})` : ''}`,
    ...built.createNetworks.map((n) => `create network ${n}`),
    ...built.namedVolumes.map((v) => `create volume ${v} if missing`),
    `create container ${spec.name}`,
    ...(spec.networks.length > 1 ? ['connect additional networks'] : []),
    'start', spec.healthcheck ? 'verify running and healthy' : 'verify running',
    ...(built.integrations.monitoring ? ['register monitor'] : []),
    'refresh inventory',
  ];
  const notes = [];
  if (built.integrations.proxy) notes.push(`${built.provider.label} will route ${built.integrations.proxy.url} to port ${manifest.proxy.port}${built.provider.network ? ` via network ${built.provider.network}` : ''}`);
  if (built.integrations.autoheal) notes.push('Autoheal opt-in label set (autoheal=true); it acts only when Docker reports unhealthy');
  if (!built.integrations.updates) notes.push('update tracking disabled for this container (opushub.update=false)');
  if (spec.volumes.some((v) => v.type === 'bind')) notes.push('host paths are mounted as given; nothing is created on the host by OpusHub');

  return {
    ok: true, policy,
    plan: {
      kind: 'install', policy,
      current: null, next: diffSpecs(null, spec).next, diff: diffSpecs(null, spec),
      steps, notes,
      summary: [`install ${manifest.name} as ${spec.name}`, `image ${spec.image}`, ...(built.integrations.proxy ? [`expose ${built.integrations.proxy.domain}`] : [])],
      resources: { networks: built.createNetworks.map((n) => ({ name: n, action: 'create' })), volumes: built.namedVolumes.map((v) => ({ name: v, action: 'ensure' })), image: { ref: spec.image, present: imagePresent, registry: auth ? auth.id : null } },
      integrations: built.integrations,
      variables: Object.fromEntries(Object.entries(built.vars).map(([k, v]) => [k, manifest.variables.find((x) => x.key === k)?.kind === 'secret' ? maskEnvValue('secret', v) : v])),
      // for the runner only — never crosses the API (publicPlan drops it)
      _install: { spec, manifest, built, registryId: auth ? auth.id : null },
    },
  };
}
