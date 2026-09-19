// Edit Container — the one place a container's configuration is changed.
//
// The editor is a *form over the server's canonical spec*: it loads `GET /api/v1/containers/:ref/spec`
// (secret env values already masked), lets the operator change the fields on the server's
// allow-list, previews the change with `POST /api/v1/containers/:ref/diff` (side-effect free), and
// then asks for a `container.edit` / `container.update` operation exactly like every other
// button does — the same dialog, the same dry-run, the same confirmation bound to the patch.
//
// It knows nothing about Docker's create API. It sends `{ spec: <patch> }` where every key is one
// of the fields the server listed, and the server refuses anything else.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, usePolled } from '../lib/api';
import { requestOperation, useOperationsCapabilities, type OperationAction, type OperationParams, type OperationTargetRef, type PlanDiff, type PolicyFinding } from '../lib/operations';
import { PlanPanel } from './Operations';
import { Modal } from './ui';

export type EditorMode = 'edit' | 'rename' | 'duplicate' | 'remove' | 'change_image' | 'networks' | 'resources';

interface EditorRequest { name: string; group: string | null; mode: EditorMode; key: number }

interface SpecDoc {
  target: { id: string | null; name: string; service: string; label: string; group: string | null; stack: string | null; state: string | null; self: boolean };
  spec: Record<string, unknown> & { unsupported?: Record<string, unknown> };
  policy: { level: string; findings: PolicyFinding[] };
  fields: { field: string; label: string; inPlace: boolean }[];
  reproducible: boolean;
  reproducibilityIssues: string[];
  secretKeys: string[];
}

interface DiffDoc {
  current: Record<string, unknown>;
  next: Record<string, unknown>;
  diff: PlanDiff;
  policy: { level: PolicyFinding['level']; findings: PolicyFinding[] };
  action: 'container.update' | 'container.edit' | null;
  confirmation: 'blocked' | 'strong' | 'normal';
}

export function openContainerEditor(name: string, group: string | null | undefined, mode: EditorMode = 'edit') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('opushub:container-editor', { detail: { name, group: group || null, mode } }));
}

/** Mount once inside the router (next to OperationsHost). */
export function ContainerEditorHost() {
  const [req, setReq] = useState<EditorRequest | null>(null);
  useEffect(() => {
    const handler = (e: Event) => setReq({ ...(e as CustomEvent).detail, key: Date.now() });
    window.addEventListener('opushub:container-editor', handler);
    return () => window.removeEventListener('opushub:container-editor', handler);
  }, []);
  if (!req) return null;
  return <ContainerEditor key={req.key} name={req.name} group={req.group} mode={req.mode} onClose={() => setReq(null)} />;
}

/* ------------------------------------------------------------------ */
/* field editors                                                       */
/* ------------------------------------------------------------------ */

type Draft = Record<string, string>;

const toText = (field: string, v: unknown): string => {
  if (v === null || v === undefined) return '';
  switch (field) {
    case 'env': case 'labels': return Object.entries(v as Record<string, string>).map(([k, val]) => `${k}=${val}`).join('\n');
    case 'ports': return (v as { host: number | null; container: number; protocol: string; hostIp?: string | null }[]).map((p) => `${p.hostIp ? `${p.hostIp}:` : ''}${p.host ?? ''}${p.host ? ':' : ''}${p.container}${p.protocol && p.protocol !== 'tcp' ? `/${p.protocol}` : ''}`).join('\n');
    case 'volumes': return (v as { type: string; source: string | null; target: string; readOnly: boolean }[]).map((m) => (m.type === 'tmpfs' ? `tmpfs:${m.target}` : `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`)).join('\n');
    case 'networks': return (v as { name: string; aliases?: string[] }[]).map((n) => `${n.name}${n.aliases?.length ? ` (${n.aliases.join(', ')})` : ''}`).join('\n');
    case 'devices': return (v as { host: string; container: string; permissions: string }[]).map((d) => `${d.host}:${d.container}${d.permissions && d.permissions !== 'rwm' ? `:${d.permissions}` : ''}`).join('\n');
    case 'command': case 'entrypoint': case 'dns': case 'dnsSearch': case 'extraHosts': case 'securityOpt': return (v as string[]).join('\n');
    case 'capabilities': { const c = v as { add: string[]; drop: string[] }; return [...c.add.map((x) => `+${x}`), ...c.drop.map((x) => `-${x}`)].join('\n'); }
    case 'restartPolicy': { const r = v as { name: string; maxRetries: number }; return r.name === 'on-failure' && r.maxRetries ? `on-failure:${r.maxRetries}` : r.name; }
    case 'resources': { const r = v as { memory: number; nanoCpus: number; pidsLimit?: number }; return [r.memory ? `memory=${humanBytes(r.memory)}` : '', r.nanoCpus ? `cpus=${(r.nanoCpus / 1e9).toFixed(2).replace(/\.?0+$/, '')}` : '', r.pidsLimit ? `pids=${r.pidsLimit}` : ''].filter(Boolean).join('\n'); }
    case 'healthcheck': { const h = v as { test: string[]; intervalMs?: number | null; timeoutMs?: number | null; retries?: number | null; startPeriodMs?: number | null } | null; if (!h) return ''; if (h.test[0] === 'NONE') return 'NONE'; return [`test=${h.test.slice(h.test[0] === 'CMD' || h.test[0] === 'CMD-SHELL' ? 1 : 0).join(' ')}`, h.intervalMs ? `interval=${h.intervalMs / 1000}s` : '', h.timeoutMs ? `timeout=${h.timeoutMs / 1000}s` : '', h.retries ? `retries=${h.retries}` : '', h.startPeriodMs ? `start_period=${h.startPeriodMs / 1000}s` : ''].filter(Boolean).join('\n'); }
    case 'logging': { const l = v as { driver: string; options: Record<string, string> }; return [l.driver, ...Object.entries(l.options || {}).map(([k, val]) => `${k}=${val}`)].join('\n'); }
    case 'privileged': case 'readOnlyRootfs': case 'tty': case 'stdinOpen': case 'init': return v ? 'true' : 'false';
    default: return String(v);
  }
}

/** Text → the canonical shape the server accepts for this field. Throws a message on bad input. */
const fromText = (field: string, text: string): unknown => {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  switch (field) {
    case 'env': case 'labels': {
      const out: Record<string, string> = {};
      for (const l of lines) { const i = l.indexOf('='); if (i <= 0) throw new Error(`"${l}" is not KEY=value`); out[l.slice(0, i)] = l.slice(i + 1); }
      return out;
    }
    case 'ports': case 'volumes': case 'devices': case 'command': case 'entrypoint': case 'dns': case 'dnsSearch': case 'extraHosts': case 'securityOpt':
      return field === 'volumes' ? lines.map((l) => (l.startsWith('tmpfs:') ? { type: 'tmpfs', target: l.slice(6) } : l)) : lines;
    case 'networks': return lines.map((l) => { const m = l.match(/^([^\s(]+)(?:\s*\(([^)]*)\))?$/); if (!m) throw new Error(`"${l}" is not a network name`); return { name: m[1], aliases: m[2] ? m[2].split(',').map((a) => a.trim()).filter(Boolean) : [] }; });
    case 'capabilities': { const add: string[] = []; const drop: string[] = []; for (const l of lines) { if (l.startsWith('-')) drop.push(l.slice(1)); else add.push(l.replace(/^\+/, '')); } return { add, drop }; }
    case 'restartPolicy': { const [name, n] = text.trim().split(':'); return { name: name || 'no', maxRetries: Number(n) || 0 }; }
    case 'resources': {
      const out: Record<string, unknown> = {};
      for (const l of lines) { const [k, v] = l.split('='); if (k === 'memory') out.memory = v; else if (k === 'cpus') out.cpus = Number(v); else if (k === 'pids') out.pidsLimit = Number(v); else throw new Error(`unknown resource ${k}`); }
      return out;
    }
    case 'healthcheck': {
      if (!text.trim()) return null;
      if (text.trim() === 'NONE') return { test: ['NONE'] };
      const out: Record<string, unknown> = {};
      for (const l of lines) { const i = l.indexOf('='); const k = l.slice(0, i); const v = l.slice(i + 1); if (k === 'test') out.test = v; else if (k === 'interval') out.interval = v; else if (k === 'timeout') out.timeout = v; else if (k === 'retries') out.retries = Number(v); else if (k === 'start_period') out.startPeriod = v; else throw new Error(`unknown healthcheck option ${k}`); }
      return out;
    }
    case 'logging': { if (!lines.length) return null; const [driver, ...opts] = lines; const options: Record<string, string> = {}; for (const o of opts) { const i = o.indexOf('='); if (i <= 0) throw new Error(`"${o}" is not key=value`); options[o.slice(0, i)] = o.slice(i + 1); } return { driver, options }; }
    case 'privileged': case 'readOnlyRootfs': case 'tty': case 'stdinOpen': case 'init': return text.trim() === 'true';
    case 'stopTimeout': return text.trim() ? Number(text.trim()) : null;
    default: return text.trim() || null;
  }
};

const humanBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1).replace(/\.0$/, '')}g` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)}m` : `${Math.round(n / 1024)}k`);

const HELP: Record<string, string> = {
  image: 'repository[:tag] or repository@sha256:… — changing it pulls and recreates',
  name: 'letters, digits, "_", "." and "-"',
  command: 'one argument per line (replaces the image CMD)',
  entrypoint: 'one argument per line (replaces the image ENTRYPOINT)',
  env: 'KEY=value per line. Masked values (••••) are kept as they are unless you change them.',
  labels: 'key=value per line',
  ports: '[hostIp:]host:container[/udp] per line — or just "container" to expose without publishing',
  volumes: 'source:target[:ro] per line; "tmpfs:/path" for a tmpfs. Named volumes are never deleted.',
  networks: 'network name per line, optional aliases in parentheses',
  networkMode: 'bridge, host, none or a network name',
  restartPolicy: 'no, always, unless-stopped or on-failure[:retries]',
  healthcheck: 'test=… interval=30s timeout=5s retries=3 start_period=10s (one per line), or NONE',
  resources: 'memory=512m cpus=1.5 pids=200 (one per line) — applied in place',
  capabilities: '+CAP to add, -CAP to drop, one per line',
  securityOpt: 'one option per line (no-new-privileges, seccomp=…, apparmor=…)',
  devices: '/dev/host:/dev/container[:rwm] per line',
  logging: 'driver on the first line, then key=value options',
  extraHosts: 'host:ip per line',
  dns: 'one server per line',
  dnsSearch: 'one domain per line',
  stopTimeout: 'seconds',
};

const TEXTAREA = new Set(['command', 'entrypoint', 'env', 'labels', 'ports', 'volumes', 'networks', 'capabilities', 'securityOpt', 'devices', 'logging', 'extraHosts', 'dns', 'dnsSearch', 'healthcheck', 'resources']);
const BOOL = new Set(['privileged', 'readOnlyRootfs', 'tty', 'stdinOpen', 'init']);
const RESTART = ['no', 'always', 'unless-stopped', 'on-failure', 'on-failure:3', 'on-failure:5'];

const MODE_FIELDS: Record<EditorMode, string[] | null> = {
  edit: null,
  rename: ['name'],
  duplicate: ['name', 'ports', 'volumes', 'env'],
  remove: [],
  change_image: ['image'],
  networks: ['networks', 'networkMode'],
  resources: ['restartPolicy', 'resources'],
};

/* ------------------------------------------------------------------ */
/* the editor                                                          */
/* ------------------------------------------------------------------ */

export function ContainerEditor({ name, group, mode, onClose }: { name: string; group: string | null; mode: EditorMode; onClose: () => void }) {
  const { can } = useOperationsCapabilities();
  const { data, error } = usePolled<SpecDoc>(`/api/v1/containers/${encodeURIComponent(name)}/spec`, 0);
  const { data: nets } = usePolled<{ networks?: { name: string }[] } | { name: string }[]>('/api/networks', 0);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<DiffDoc | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [force, setForce] = useState(false);
  const [dupName, setDupName] = useState(`${name}-copy`);

  const fields = useMemo(() => {
    if (!data) return [];
    const only = MODE_FIELDS[mode];
    return only ? data.fields.filter((f) => only.includes(f.field)) : data.fields;
  }, [data, mode]);

  const original = useMemo(() => {
    const o: Draft = {};
    if (data) for (const f of data.fields) o[f.field] = toText(f.field, data.spec[f.field]);
    return o;
  }, [data]);

  const dirtyFields = useMemo(() => Object.keys(draft).filter((k) => draft[k] !== original[k]), [draft, original]);

  /** The patch: only the fields the operator changed, converted to the canonical shape. */
  const patch = useMemo(() => {
    const p: Record<string, unknown> = {};
    const errs: Record<string, string> = {};
    for (const f of dirtyFields) {
      try {
        let v = fromText(f, draft[f]);
        // masked env values that were not touched stay masked on the way back — the server
        // keeps the real value when the masked placeholder is sent back unchanged
        if (f === 'env' && data) {
          const next = v as Record<string, string>;
          const cur = data.spec.env as Record<string, string>;
          for (const k of Object.keys(next)) if (next[k] === cur?.[k] && data.secretKeys.includes(k)) next[k] = cur[k];
        }
        if (f === 'volumes') v = (v as (string | { type: string; target: string })[]);
        p[f] = v;
      } catch (e) { errs[f] = e instanceof Error ? e.message : 'invalid'; }
    }
    return { patch: p, errs };
  }, [dirtyFields, draft, data]);

  useEffect(() => { setErrors(patch.errs); }, [patch.errs]);
  useEffect(() => { setPreview(null); setPreviewError(null); }, [dirtyFields.join(','), draft]);

  const runPreview = useCallback(async () => {
    if (!data || Object.keys(patch.errs).length) return;
    setPreviewing(true);
    try {
      const r = await api<DiffDoc>(`/api/v1/containers/${encodeURIComponent(name)}/diff`, { method: 'POST', body: JSON.stringify({ spec: patch.patch }) });
      setPreview(r);
      setPreviewError(null);
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { error?: string; errors?: string[] } | null) : null;
      setPreviewError(body?.errors?.join('; ') || body?.error || (err instanceof Error ? err.message : 'The preview failed.'));
      setPreview(null);
    } finally { setPreviewing(false); }
  }, [data, name, patch]);

  const target: OperationTargetRef = { type: 'service', id: name, ...(group ? { group } : {}) };

  const submit = useCallback((action: OperationAction, params: OperationParams) => {
    requestOperation(action, target, params);
    onClose();
  }, [target, onClose]);

  const title = { edit: `Edit ${name}`, rename: `Rename ${name}`, duplicate: `Duplicate ${name}`, remove: `Remove ${name}`, change_image: `Change image of ${name}`, networks: `Networks of ${name}`, resources: `Restart policy & resources of ${name}` }[mode];

  /* ---- body per mode ---- */
  let body: React.ReactNode;
  let footer: React.ReactNode;

  if (error) {
    body = <p className="op-note op-note--bad">{String(error || "The container could not be loaded.")}</p>;
    footer = <button className="btn" onClick={onClose}>Close</button>;
  } else if (!data) {
    body = <p className="op-note" role="status"><span className="op-spinner" aria-hidden="true" /> Reading the container configuration…</p>;
    footer = <button className="btn" onClick={onClose}>Cancel</button>;
  } else if (mode === 'remove') {
    const running = data.target.state === 'running' || data.target.state === 'paused';
    body = (
      <div className="cedit">
        <p className="op-prompt">The container <strong>{name}</strong> will be deleted. Named volumes and bind-mounted data are kept; anything written to the container filesystem itself is lost.</p>
        {running && (
          <label className="op-ack">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            <span>The container is {data.target.state}. Kill it first and remove it anyway (force).</span>
          </label>
        )}
        <VolumesNote spec={data.spec} />
      </div>
    );
    footer = (
      <>
        <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" disabled={running && !force || !can('container.remove')} onClick={() => submit('container.remove', { force })}>Continue to confirmation</button>
      </>
    );
  } else if (mode === 'rename') {
    const next = draft.name ?? original.name ?? '';
    body = (
      <div className="cedit">
        <Field field="name" label="New name" value={next} onChange={(v) => setDraft((d) => ({ ...d, name: v }))} help={HELP.name} error={errors.name} dirty={next !== original.name} />
        <p className="op-quiet">Anything that addresses this container by name (compose, links, reverse-proxy rules, monitors) will need updating.</p>
      </div>
    );
    footer = (
      <>
        <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!next || next === original.name} onClick={() => submit('container.rename', { name: next })}>Continue to confirmation</button>
      </>
    );
  } else if (mode === 'change_image') {
    const next = draft.image ?? original.image ?? '';
    body = (
      <div className="cedit">
        <Field field="image" label="Image" value={next} onChange={(v) => setDraft((d) => ({ ...d, image: v }))} help={HELP.image} error={errors.image} dirty={next !== original.image} />
        <p className="op-quiet">The new image is pulled first; the container is recreated only if the pull succeeds. Volumes are kept.</p>
      </div>
    );
    footer = (
      <>
        <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!next || next === original.image} onClick={() => submit('container.change_image', { image: next })}>Continue to confirmation</button>
      </>
    );
  } else if (mode === 'networks') {
    const list = Array.isArray(nets) ? nets : (nets?.networks || []);
    const attached = (data.spec.networks as { name: string }[] | undefined) || [];
    const attachable = list.map((n) => n.name).filter((n) => n && n !== 'bridge' && n !== 'host' && n !== 'none' && !attached.some((a) => a.name === n));
    body = (
      <div className="cedit">
        <div className="cedit-section">
          <h4>Attached</h4>
          {attached.length === 0 && <p className="op-quiet">Not connected to any user network.</p>}
          {attached.map((n) => (
            <div key={n.name} className="cedit-row">
              <code>{n.name}</code>
              <button className="btn btn-sm btn-quiet stop" disabled={attached.length <= 1 || !can('container.network_detach')} title={attached.length <= 1 ? 'Attach another network first' : `Detach ${n.name}`} onClick={() => submit('container.network_detach', { network: n.name })}>Detach</button>
            </div>
          ))}
        </div>
        <div className="cedit-section">
          <h4>Attach</h4>
          {attachable.length === 0 && <p className="op-quiet">No other network to attach.</p>}
          {attachable.map((n) => (
            <div key={n} className="cedit-row">
              <code>{n}</code>
              <button className="btn btn-sm" disabled={!can('container.network_attach')} onClick={() => submit('container.network_attach', { network: n })}>Attach</button>
            </div>
          ))}
        </div>
      </div>
    );
    footer = <button className="btn" onClick={onClose}>Close</button>;
  } else {
    // edit / duplicate / resources — the field form with a diff preview
    const isDup = mode === 'duplicate';
    const action = preview?.action || (mode === 'resources' ? 'container.update' : 'container.edit');
    const blocked = preview?.confirmation === 'blocked';
    body = (
      <div className="cedit">
        {data.policy.findings.length > 0 && mode === 'edit' && (
          <details className="op-steps"><summary>Current configuration: {data.policy.level.toLowerCase()} · {data.policy.findings.length} finding{data.policy.findings.length === 1 ? '' : 's'}</summary>
            <ul className="op-findings">{data.policy.findings.map((f, i) => <li key={i} data-level={f.level}><span className="op-finding-level">{f.level}</span><span>{f.message}</span></li>)}</ul>
          </details>
        )}
        {!data.reproducible && !isDup && mode !== 'resources' && (
          <p className="op-warn" role="alert">This container cannot be recreated by OpusHub: {data.reproducibilityIssues.join('; ')}. Only in-place fields (restart policy, resources) can be changed.</p>
        )}
        {data.spec.unsupported && Object.values(data.spec.unsupported).some(Boolean) && (
          <p className="op-quiet">Preserved but not editable here: {Object.entries(data.spec.unsupported).filter(([, v]) => v).map(([k]) => k).join(', ')}.</p>
        )}
        {isDup && (
          <Field field="name" label="Name of the copy" value={dupName} onChange={setDupName} help={HELP.name} dirty={true} />
        )}
        <div className="cedit-grid">
          {fields.filter((f) => !(isDup && f.field === 'name')).map((f) => {
            const v = draft[f.field] ?? original[f.field] ?? '';
            const disabled = !data.reproducible && !f.inPlace && !isDup;
            return (
              <Field
                key={f.field} field={f.field} label={f.label} value={v} inPlace={f.inPlace} disabled={disabled}
                onChange={(val) => setDraft((d) => ({ ...d, [f.field]: val }))}
                help={HELP[f.field]} error={errors[f.field]} dirty={v !== original[f.field]}
                secretKeys={f.field === 'env' ? data.secretKeys : undefined}
              />
            );
          })}
        </div>
        {isDup && <p className="op-quiet">Published host ports and named volumes are not copied unless you set them here — two containers cannot share either.</p>}
        {preview && <PlanPanel plan={{ kind: preview.action, summary: preview.diff.summary, steps: [], diff: preview.diff, current: preview.current, next: preview.next, policy: preview.policy, notes: [] }} compact />}
        {previewError && <p className="op-note op-note--bad">{previewError}</p>}
        {blocked && <p className="op-note op-note--bad">This configuration is not allowed by policy and cannot be confirmed.</p>}
      </div>
    );
    const ready = dirtyFields.length > 0 && !Object.keys(errors).length;
    footer = (
      <>
        <span className="cedit-summary">{dirtyFields.length ? `${dirtyFields.length} field${dirtyFields.length === 1 ? '' : 's'} changed` : 'No changes yet'}</span>
        <span style={{ flex: 1 }} />
        <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
        {isDup ? (
          <button className="btn btn-primary" disabled={!dupName || !!Object.keys(errors).length || !can('container.duplicate')} onClick={() => submit('container.duplicate', { name: dupName, ...(dirtyFields.length ? { spec: patch.patch } : {}) })}>Continue to confirmation</button>
        ) : preview ? (
          <button className={preview.confirmation === 'strong' ? 'btn btn-danger' : 'btn btn-primary'} disabled={blocked || !preview.action || !can(action)} onClick={() => submit(action, { spec: patch.patch })}>
            {preview.diff.recreate ? 'Continue — recreate required' : 'Continue to confirmation'}
          </button>
        ) : (
          <button className="btn btn-primary" disabled={!ready || previewing} onClick={() => void runPreview()}>{previewing ? 'Comparing…' : 'Preview changes'}</button>
        )}
      </>
    );
  }

  return <Modal title={title} onClose={onClose} footer={footer} wide={mode === 'edit' || mode === 'duplicate' || !!preview}>{body}</Modal>;
}

function Field({ field, label, value, onChange, help, error, dirty, inPlace, disabled, secretKeys }: {
  field: string; label: string; value: string; onChange: (v: string) => void; help?: string; error?: string; dirty?: boolean; inPlace?: boolean; disabled?: boolean; secretKeys?: string[];
}) {
  const id = `cedit-${field}`;
  return (
    <div className="cedit-field" data-dirty={dirty || undefined} style={TEXTAREA.has(field) ? { gridColumn: field === 'env' || field === 'labels' || field === 'volumes' ? '1 / -1' : undefined } : undefined}>
      <label htmlFor={id}>
        <span>{label}</span>
        {inPlace !== undefined && (inPlace ? <span className="cedit-inplace">in place</span> : <span className="cedit-recreate">recreates</span>)}
      </label>
      {BOOL.has(field) ? (
        <select id={id} value={value || 'false'} onChange={(e) => onChange(e.target.value)} disabled={disabled}><option value="false">false</option><option value="true">true</option></select>
      ) : field === 'restartPolicy' ? (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>{[...new Set([value, ...RESTART])].filter(Boolean).map((r) => <option key={r} value={r}>{r}</option>)}</select>
      ) : TEXTAREA.has(field) ? (
        <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} spellCheck={false} rows={Math.min(10, Math.max(3, value.split('\n').length + 1))} />
      ) : (
        <input id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} spellCheck={false} />
      )}
      {secretKeys && secretKeys.length > 0 && <span className="cedit-help cedit-secret">Masked: {secretKeys.join(', ')} — values stay on the server unless you type a new one.</span>}
      {error ? <span className="cedit-err">{error}</span> : help ? <span className="cedit-help">{help}</span> : null}
    </div>
  );
}

function VolumesNote({ spec }: { spec: Record<string, unknown> }) {
  const vols = (spec.volumes as { type: string; source: string | null }[] | undefined) || [];
  const named = vols.filter((v) => v.type === 'volume');
  if (!named.length) return null;
  return <p className="op-quiet">Named volumes kept: {named.map((v) => v.source).join(', ')}.</p>;
}
