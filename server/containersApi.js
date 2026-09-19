// Phase 10D-A — the container read surface behind the Edit Container UI and the detail views.
//
//   GET  /api/v1/containers/:ref                 the safe inspect projection (providers/docker.js)
//   GET  /api/v1/containers/:ref/spec            the canonical, editable spec (env values masked)
//   GET  /api/v1/containers/:ref/top             processes (read-only, args redacted)
//   GET  /api/v1/containers/:ref/volumes         the volumes and binds the container uses
//   GET  /api/v1/containers/:ref/health          the unified health verdict (health model)
//   GET  /api/v1/containers/spec-fields          the field allow-list and per-field editability
//   POST /api/v1/containers/:ref/diff            preview: CURRENT / NEW / CHANGES for a spec patch.
//                                                Side-effect free — it reads the container and runs
//                                                the same planner the dry-run runs. Nothing is written.
//
// Every mutation goes through POST /api/v1/operations (operations engine). This module never
// imports the write adapters, and the proof in phase10d tests checks that it cannot.
import * as docker from './providers/docker.js';
import * as model from './model.js';
import { resolveTarget } from './operations/targets.js';
import { operationError } from './operations/model.js';
import { specFromInspect, applyPatch, normalizeSpecPatch, normalizeSpec, SPEC_FIELDS, IN_PLACE_FIELDS } from './containers/spec.js';
import { diffSpecs, publicSpec, FIELD_LABELS } from './containers/diff.js';
import { classifySpec } from './containers/policy.js';
import { inspectContainer as inspectRaw } from './updates/recreateAdapter.js';
import { evaluateServiceHealth } from './healthModel.js';

const REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** Returns true when the route was handled. */
export async function handleContainersRoutes({ p, method, send, jsonBody }) {
  const base = p.replace(/^\/api\/v1\/containers/, '').replace(/^\/api\/containers/, '');
  if (base === p) return false;

  if (method === 'GET' && base === '/spec-fields') {
    send(200, {
      fields: SPEC_FIELDS.map((f) => ({ field: f, label: FIELD_LABELS[f] || f, inPlace: IN_PLACE_FIELDS.includes(f) })),
      inPlace: [...IN_PLACE_FIELDS],
    });
    return true;
  }

  const m = base.match(/^\/([^/]+)(?:\/(spec|top|volumes|health|diff))?$/);
  if (!m) { send(404, { error: 'Not found', code: 'not_found' }); return true; }
  const ref = decodeURIComponent(m[1]);
  const sub = m[2] || null;
  if (!REF_RE.test(ref)) { send(400, { error: 'That is not a container reference.', code: 'bad_target' }); return true; }
  if (sub === 'diff' ? method !== 'POST' : method !== 'GET') { send(405, { error: 'Method not allowed', code: 'method_not_allowed' }); return true; }

  // resolve through the same target resolver the operations engine uses: name, id prefix or
  // service id — never a free-form string handed to the engine
  const resolved = await resolveTarget({ type: 'container', id: ref });
  if (!resolved.ok) {
    const alt = await resolveTarget({ type: 'service', id: ref });
    if (!alt.ok) { send(resolved.error.code === 'ambiguous_target' ? 409 : 404, { error: resolved.error.reason, code: resolved.error.code }); return true; }
    resolved.target = alt.target;
  }
  const target = resolved.target;

  if (!sub) {
    const insp = await docker.inspectContainer(target.containerId).catch(() => null);
    if (!insp) { send(503, { error: 'The container could not be inspected.', code: 'docker_unavailable' }); return true; }
    send(200, { container: insp, target: publicTarget(target) });
    return true;
  }

  if (sub === 'top') {
    const top = await docker.containerTop(target.containerId);
    send(200, { target: publicTarget(target), top: top || { titles: [], processes: [] }, available: !!top });
    return true;
  }

  if (sub === 'health') {
    try {
      const inv = await model.getInventory();
      const svc = (inv.services || []).find((s) => s.name === target.service || String(s.id).startsWith(target.containerId));
      if (!svc) { send(404, { error: 'Service not in inventory.', code: 'unknown_target' }); return true; }
      const doc = await evaluateServiceHealth(svc, {});
      send(200, { target: publicTarget(target), health: doc?.health || null, probe: doc?.probe || null });
    } catch {
      send(503, { error: 'Health could not be evaluated.', code: 'docker_unavailable' });
    }
    return true;
  }

  // spec / volumes / diff read the full inspect through the control adapter (the read client
  // deliberately drops env and entrypoint, which the editor needs — masked)
  const raw = await inspectRaw(target.containerId);
  if (!raw.ok || !raw.data) { send(503, { error: 'The container could not be inspected.', code: 'docker_unavailable' }); return true; }
  const current = specFromInspect(raw.data);

  if (sub === 'spec') {
    const policy = classifySpec(current);
    const reproducible = normalizeSpec(editable(current));
    send(200, {
      target: publicTarget(target),
      spec: publicSpec(current),
      policy: { level: policy.level, findings: policy.findings },
      fields: SPEC_FIELDS.map((f) => ({ field: f, label: FIELD_LABELS[f] || f, inPlace: IN_PLACE_FIELDS.includes(f) })),
      reproducible: reproducible.ok,
      reproducibilityIssues: reproducible.ok ? [] : reproducible.errors,
      secretKeys: Object.keys(current.env || {}).filter((k) => publicSpec({ env: { [k]: 'x' } }).env[k] !== 'x'),
    });
    return true;
  }

  if (sub === 'volumes') {
    let known = [];
    try { known = await docker.listVolumes(); } catch { known = []; }
    const byName = new Map(known.map((v) => [v.name, v]));
    const volumes = (current.volumes || []).map((v) => ({
      ...v,
      details: v.type === 'volume' ? (byName.get(v.source) || null) : null,
    }));
    const anonymous = (Array.isArray(raw.data.Mounts) ? raw.data.Mounts : [])
      .filter((mm) => mm.Type === 'volume' && !(current.volumes || []).some((v) => v.source === (mm.Name || mm.Source)))
      .map((mm) => ({ type: 'volume', source: mm.Name || null, target: mm.Destination, readOnly: mm.RW === false, anonymous: true }));
    send(200, { target: publicTarget(target), volumes, anonymous });
    return true;
  }

  // diff preview
  const body = await readJson(jsonBody);
  if (!body.ok) { send(400, { error: body.error.reason, code: body.error.code }); return true; }
  const patchIn = body.value?.spec;
  const norm = normalizeSpecPatch(patchIn);
  if (!norm.ok) { send(400, { error: norm.errors[0], code: 'bad_params', errors: norm.errors }); return true; }
  const next = applyPatch(editable(current), norm.patch);
  const full = normalizeSpec(next);
  if (!full.ok) { send(400, { error: full.errors[0], code: 'bad_params', errors: full.errors }); return true; }
  const diff = diffSpecs(current, full.spec);
  const policy = classifySpec(full.spec, { current });
  send(200, {
    target: publicTarget(target),
    current: publicSpec(current),
    next: publicSpec(full.spec),
    diff: { changed: diff.changed, unchanged: diff.unchanged, entries: diff.entries, inPlace: diff.inPlace, recreate: diff.recreate, summary: diff.summary },
    policy: { level: policy.level, findings: policy.findings },
    // which operation the UI should request for this patch
    action: !diff.changed.length ? null : diff.inPlace ? 'container.update' : 'container.edit',
    confirmation: policy.level === 'BLOCKED' ? 'blocked' : (policy.level === 'DANGEROUS' || diff.recreate) ? 'strong' : 'normal',
  });
  return true;
}

function editable(spec) {
  const out = {};
  for (const [k, v] of Object.entries(spec)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

function publicTarget(t) {
  return { id: t.containerId?.slice(0, 12) || null, name: t.containerName, service: t.service, label: t.label, group: t.group, stack: t.stack, state: t.state, self: t.self === true };
}

async function readJson(jsonBody) {
  try {
    const value = await jsonBody();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: operationError('bad_request', 'Expected a JSON object.') };
    if (Object.keys(value).length > 4) return { ok: false, error: operationError('bad_request', 'The request has too many fields.') };
    return { ok: true, value };
  } catch {
    return { ok: false, error: operationError('bad_request', 'The request body is not valid JSON.') };
  }
}
