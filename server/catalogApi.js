// Phase 10D-D — the service catalog.
//
//   GET  /api/v1/catalog                      entries (search ?q=, ?category=), categories, proxy provider
//   GET  /api/v1/catalog/installs             install history (no secrets are ever stored)
//   GET  /api/v1/catalog/:id                  one manifest (public projection) + installed instances
//   POST /api/v1/catalog/:id/plan             { config } → the same plan the operation will run, no mutation
//
// Installing is NOT a route here. It is the `service.install` operation: POST /api/v1/operations/
// dry-run then POST /api/v1/operations with the confirmation token — authz, params, planning,
// policy, locking, execution, verification and audit all happen in the operations engine.
import { listManifests, getManifest, loadManifests, CATEGORIES } from './catalog/schema.js';
import { buildInstall, planInstall, MANAGED_LABEL } from './catalog/planner.js';
import { listInstalls } from './catalog/store.js';
import { publicPlan } from './operations/policy.js';
import { getAction } from './operations/registry.js';
import { parseParams } from './operations/params.js';
import { can } from './operations/permissions.js';
import { activeProvider } from './proxy/provider.js';
import * as docker from './providers/docker.js';
import * as registryStore from './registries/store.js';
import { registryHostOf } from './registries/endpoint.js';

function publicManifest(m, { full = false } = {}) {
  const base = { id: m.id, name: m.name, summary: m.summary, category: m.category, tags: m.tags, icon: m.icon, homepage: m.homepage, image: { repository: m.image.repository, recommended: (m.image.versions.find((v) => v.recommended) || m.image.versions[0]).tag }, proxy: !!m.proxy, healthcheck: !!m.healthcheck };
  if (!full) return base;
  return {
    ...base, description: m.description, docs: m.docs, notes: m.notes,
    image: { ...base.image, versions: m.image.versions, allowCustomTag: m.image.allowCustomTag, allowDigest: m.image.allowDigest },
    variables: m.variables.map((v) => ({ ...v, pattern: v.pattern || null })),
    ports: m.ports, volumes: m.volumes, network: m.network, proxy: m.proxy, healthcheck: m.healthcheck ? { intervalMs: m.healthcheck.intervalMs, timeoutMs: m.healthcheck.timeoutMs, retries: m.healthcheck.retries } : null,
    restartPolicy: m.restartPolicy, monitoring: m.monitoring, autoheal: m.autoheal, updates: m.updates,
  };
}

export async function handleCatalogRoutes({ p, method, send, jsonBody, actor, query }) {
  const m = p.match(/^\/api\/(?:v1\/)?catalog(?:\/([^/]+)(?:\/(plan))?)?$/);
  if (!m) return false;
  const [, rawId, sub] = m;
  const bad = (status, code, error, extra = {}) => { send(status, { error, code, ...extra }); return true; };
  const action = getAction('service.install');
  const canInstall = can(actor, action.permission);
  const provider = activeProvider();

  if (rawId === undefined) {
    if (method !== 'GET') return bad(405, 'method_not_allowed', 'Method not allowed');
    const q = String(query?.get('q') || '').trim().toLowerCase().slice(0, 80);
    const category = String(query?.get('category') || '').trim().toLowerCase();
    let entries = listManifests();
    if (category) entries = entries.filter((e) => e.category === category);
    if (q) entries = entries.filter((e) => [e.id, e.name, e.summary, e.category, ...e.tags].some((s) => String(s).toLowerCase().includes(q)));
    let installed = [];
    try { installed = (await docker.listContainers({ all: true, withLabels: true })).filter((c) => c.rawLabels?.[MANAGED_LABEL]).map((c) => ({ manifest: c.rawLabels[MANAGED_LABEL], name: c.name, state: c.state, version: c.rawLabels[`${MANAGED_LABEL}.version`] || null })); } catch { installed = []; }
    const { problems } = loadManifests();
    send(200, {
      entries: entries.map((e) => publicManifest(e)), categories: CATEGORIES, installed,
      proxy: { provider: provider.id, label: provider.label, available: provider.available, network: provider.network },
      permissions: { install: canInstall }, invalidManifests: problems.length,
    });
    return true;
  }
  if (rawId === 'installs') {
    if (method !== 'GET') return bad(405, 'method_not_allowed', 'Method not allowed');
    send(200, { installs: listInstalls({ limit: 50 }) });
    return true;
  }
  const manifest = getManifest(decodeURIComponent(rawId).toLowerCase());
  if (!manifest) return bad(404, 'not_found', 'There is no catalog entry with that id.');

  if (!sub) {
    if (method !== 'GET') return bad(405, 'method_not_allowed', 'Method not allowed');
    let instances = [];
    try { instances = (await docker.listContainers({ all: true, withLabels: true })).filter((c) => c.rawLabels?.[MANAGED_LABEL] === manifest.id).map((c) => ({ name: c.name, state: c.state, image: c.image, version: c.rawLabels[`${MANAGED_LABEL}.version`] || null })); } catch { instances = []; }
    let networks = [];
    try { networks = (await docker.listNetworksRaw()).map((n) => n.name).filter((n) => n && !['host', 'none'].includes(n)); } catch { networks = []; }
    const registries = registryStore.registriesForHost(registryHostOf(`${manifest.image.repository}:x`)).map((r) => ({ id: r.id, name: r.name, hasSecret: r.hasSecret }));
    send(200, { entry: publicManifest(manifest, { full: true }), instances, networks, registries, proxy: { provider: provider.id, label: provider.label, available: provider.available, network: provider.network }, permissions: { install: canInstall }, history: listInstalls({ limit: 10, manifest: manifest.id }) });
    return true;
  }

  // plan — the same code path as the operation's dry-run, minus the confirmation token
  if (method !== 'POST') return bad(405, 'method_not_allowed', 'Method not allowed');
  let body = {};
  try { body = (await jsonBody()) || {}; } catch (err) { return bad(err?.status || 400, 'bad_request', String(err?.message || err)); }
  const parsed = parseParams('install', { config: body.config === undefined ? {} : body.config });
  if (!parsed.ok) return bad(400, parsed.error.code || 'bad_params', parsed.error.reason);
  const built = await buildInstall(manifest, parsed.params.config);
  if (!built.ok) { send(200, { ok: false, problems: built.problems, plan: null }); return true; }
  const planned = await planInstall(action, { type: 'catalog', id: manifest.id, manifest }, parsed.params);
  if (!planned.ok) { send(200, { ok: false, problems: [planned.error.reason, ...(planned.error.detail ? [planned.error.detail] : [])], plan: null }); return true; }
  send(200, { ok: planned.policy.level !== 'BLOCKED', problems: [], plan: publicPlan(planned.plan), variables: planned.plan.variables, policy: { level: planned.policy.level, findings: planned.policy.findings } });
  return true;
}
