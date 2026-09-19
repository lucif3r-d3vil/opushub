// Managed stacks — the Compose document as data.
//
//   /stacks/new          write a document → Validate → Save (nothing deployed)
//   /stacks/:id/edit     edit the document/env, see the plan, then Deploy / Start / Stop / Remove
//
// Every button that changes the engine goes through the ordinary operations dialog
// (`requestOperation('stack.<verb>', { type: 'stack', id })`): dry-run, plan, confirmation, then
// the same POST /api/v1/operations as a container restart. This page only edits the definition.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, invalidateShared, usePolled } from '../lib/api';
import { relTime } from '../lib/format';
import { requestOperation, useOperationsCapabilities, type PlanDoc as OpPlan, type PolicyFinding } from '../lib/operations';
import { PlanPanel } from '../components/Operations';
import { PageHero, ProviderNote } from '../components/ui';

interface Validation {
  ok: boolean; errors: string[]; warnings: string[];
  policy: { level: PolicyFinding['level']; findings: PolicyFinding[]; perService?: Record<string, string> } | null;
  services: { key: string; container: string; image: string; dependsOn?: string[]; policy?: string }[];
  networks?: { key: string; name: string; external: boolean }[];
  volumes?: { key: string; name: string; external: boolean }[];
  unsupported?: { where: string; reason: string }[];
}
interface ManagedStackDoc {
  stack: {
    id: string; name: string; revision: number; compose: string; env: Record<string, string>; envKeys: string[];
    createdAt: number; updatedAt: number; updatedBy: string | null;
    lastDeploy: { at: number; by: string | null; status: string; operationId: string | null; revision: number | null } | null;
    members: { containerName: string; service: string | null; state: string | null; health: string | null; image: string | null; id: string }[];
    state: 'not_deployed' | 'running' | 'partial' | 'stopped' | 'unknown';
    validation: Validation;
  };
  history: HistoryRow[];
  permissions: { manage: boolean; deploy: boolean; remove: boolean };
}
interface HistoryRow {
  id: string; at: number; status: string; operationId?: string | null; actor?: string | null; revision?: number | null;
  services?: { key: string; result: string; error?: string }[]; error?: string | null; hasDocument: boolean;
}
interface PlanDoc { plan: OpPlan & { services?: { key: string; action: string; image?: string; diff?: { changed: string[] } | null }[] | null; networks?: { name: string; action: string }[]; volumes?: { name: string; action: string }[]; counts?: Record<string, number> }; policy: Validation['policy']; target: { state: string; members: number } }

const TEMPLATE = `services:
  app:
    image: nginx:1.27-alpine
    ports:
      - "8080:80"
    environment:
      TZ: \${TZ:-UTC}
    restart: unless-stopped
`;

const envToText = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
const textToEnv = (text: string): { env: Record<string, string>; error: string | null } => {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) return { env, error: `"${line.slice(0, 40)}" is not KEY=value` };
    env[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return { env, error: null };
};

export default function ManagedStackPage() {
  const { id } = useParams();
  const isNew = !id;
  const nav = useNavigate();
  const caps = useOperationsCapabilities();
  const { data, error, refresh } = usePolled<ManagedStackDoc>(isNew ? null : `/api/v1/stacks/managed/${encodeURIComponent(id!)}`, 15_000);

  const [name, setName] = useState('');
  const [compose, setCompose] = useState(TEMPLATE);
  const [envText, setEnvText] = useState('');
  const [loadedRev, setLoadedRev] = useState<number | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [plan, setPlan] = useState<PlanDoc | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  // load the stored revision into the editor once (and again when a newer revision arrives and the editor is clean)
  useEffect(() => {
    if (!data) return;
    const dirty = loadedRev !== null && (compose !== data.stack.compose || envText !== envToText(data.stack.env));
    if (loadedRev === null || (!dirty && data.stack.revision !== loadedRev)) {
      setName(data.stack.id);
      setCompose(data.stack.compose);
      setEnvText(envToText(data.stack.env));
      setLoadedRev(data.stack.revision);
      setValidation(data.stack.validation);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const dirty = !!data && (compose !== data.stack.compose || envText !== envToText(data.stack.env));
  const envParsed = useMemo(() => textToEnv(envText), [envText]);
  const nameOk = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);

  const fail = (err: unknown, fallback: string) => {
    const body = err instanceof ApiError ? (err.body as { error?: string; errors?: string[] } | null) : null;
    setNotice({ kind: 'bad', text: body?.errors?.length ? body.errors.slice(0, 3).join(' · ') : body?.error || (err instanceof Error ? err.message : fallback) });
  };

  const validate = useCallback(async () => {
    if (envParsed.error) { setNotice({ kind: 'bad', text: envParsed.error }); return; }
    setBusy('validate'); setNotice(null); setPlan(null);
    try {
      const path = isNew ? `/api/v1/stacks/managed/${encodeURIComponent(name || 'new')}/validate` : `/api/v1/stacks/managed/${encodeURIComponent(id!)}/validate`;
      const v = await api<Validation>(path, { method: 'POST', body: JSON.stringify({ compose, env: envParsed.env }) });
      setValidation(v);
      setNotice(v.ok ? { kind: 'ok', text: `Valid — ${v.services.length} service${v.services.length === 1 ? '' : 's'}, policy ${v.policy?.level.toLowerCase()}.` } : { kind: 'bad', text: v.errors[0] || 'The document is not allowed by policy.' });
    } catch (err) { fail(err, 'Validation failed.'); } finally { setBusy(null); }
  }, [compose, envParsed, id, isNew, name]);

  const save = useCallback(async () => {
    if (envParsed.error) { setNotice({ kind: 'bad', text: envParsed.error }); return; }
    setBusy('save'); setNotice(null);
    try {
      if (isNew) {
        const r = await api<{ stack: { id: string; adopted?: boolean; members?: number } }>('/api/v1/stacks/managed', { method: 'POST', body: JSON.stringify({ name, compose, env: envParsed.env }) });
        invalidateShared('/api/v1/stacks');
        nav(`/stacks/${encodeURIComponent(r.stack.id)}/edit`, { replace: true });
      } else {
        await api(`/api/v1/stacks/managed/${encodeURIComponent(id!)}`, { method: 'PATCH', body: JSON.stringify({ compose, env: envParsed.env }) });
        invalidateShared('/api/v1/stacks');
        setLoadedRev(null);
        setPlan(null);
        refresh();
        setNotice({ kind: 'ok', text: 'Saved as a new revision. Nothing is deployed until you deploy.' });
      }
    } catch (err) { fail(err, 'Saving failed.'); } finally { setBusy(null); }
  }, [compose, envParsed, id, isNew, name, nav, refresh]);

  const preview = useCallback(async () => {
    setBusy('plan'); setNotice(null);
    try {
      const body = dirty ? { compose, env: envParsed.env } : {};
      const p = await api<PlanDoc>(`/api/v1/stacks/managed/${encodeURIComponent(id!)}/plan`, { method: 'POST', body: JSON.stringify(body) });
      setPlan(p);
    } catch (err) { fail(err, 'The plan could not be made.'); } finally { setBusy(null); }
  }, [compose, dirty, envParsed.env, id]);

  const rollback = useCallback(async () => {
    setBusy('rollback'); setNotice(null);
    try {
      await api(`/api/v1/stacks/managed/${encodeURIComponent(id!)}/rollback`, { method: 'POST', body: '{}' });
      setLoadedRev(null); setPlan(null); refresh();
      setNotice({ kind: 'ok', text: 'The last successfully deployed document was restored as a new revision. Deploy to apply it.' });
    } catch (err) { fail(err, 'Rollback failed.'); } finally { setBusy(null); }
  }, [id, refresh]);

  const forget = useCallback(async () => {
    if (!window.confirm(`Forget the managed definition of ${id}? Containers on the engine are not touched.`)) return;
    setBusy('forget');
    try { await api(`/api/v1/stacks/managed/${encodeURIComponent(id!)}`, { method: 'DELETE' }); invalidateShared('/api/v1/stacks'); nav('/stacks'); } catch (err) { fail(err, 'Could not forget the stack.'); } finally { setBusy(null); }
  }, [id, nav]);

  const op = (verb: 'deploy' | 'start' | 'stop' | 'remove') => requestOperation(`stack.${verb}`, { type: 'stack', id: id! });

  if (!isNew && error && !data) return <ProviderNote status="error" reason={String(error)} fixHref="/stacks" fixLabel="All stacks →" />;
  const s = data?.stack;
  const canManage = data ? data.permissions.manage : caps.can('stack.deploy');

  return (
    <>
      <PageHero
        title={isNew ? 'New stack' : `${s?.id ?? id}`}
        desc={isNew
          ? 'Paste or write a Compose document. OpusHub validates it, stores it, and deploys it natively through the Docker API — no compose binary, no shell. Nothing runs until you deploy.'
          : 'The Compose document OpusHub deploys for this stack. Edit, validate, preview the plan, then deploy. Docker remains the source of truth for what is actually running.'}
        meta={
          <>
            <Link to="/stacks" className="section-link">← Stacks</Link>
            {s && <><span className="sep">·</span><span>revision {s.revision}</span><span className="sep">·</span><span>{stateWord(s.state, s.members.length)}</span></>}
            {s?.lastDeploy && <><span className="sep">·</span><span className={s.lastDeploy.status === 'succeeded' ? '' : 'op-note--bad'}>last deploy {s.lastDeploy.status} {relTime(s.lastDeploy.at)}</span></>}
            {s && <Link to={`/stacks/${encodeURIComponent(s.id)}`} className="section-link">Live view →</Link>}
          </>
        }
      />

      {!canManage && <ProviderNote status="unavailable" reason="Your account can read managed stacks but not change them." />}

      <div className="mstack">
        <div className="mstack-editor">
          {isNew && (
            <div className="field">
              <label htmlFor="ms-name">Project name</label>
              <input id="ms-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="my-stack" spellCheck={false} />
              <span className="hint">Lowercase letters, digits, "_" or "-". Containers are named <code>{name || 'my-stack'}-&lt;service&gt;-1</code> unless the service sets <code>container_name</code>.</span>
              {name && !nameOk && <span className="cedit-err">That is not a valid project name.</span>}
            </div>
          )}
          <div className="field">
            <label htmlFor="ms-compose">Compose document</label>
            <textarea id="ms-compose" className="mstack-yaml" value={compose} onChange={(e) => { setCompose(e.target.value); setPlan(null); }} spellCheck={false} rows={Math.min(40, Math.max(14, compose.split('\n').length + 2))} disabled={!canManage} />
            <span className="hint">Supported: image, command, entrypoint, environment, labels, ports, expose, volumes (absolute binds and named volumes), networks, network_mode, restart, healthcheck, resources, cap_add/drop, security_opt, devices, logging, depends_on. Not supported and refused: build, env_file, extends, secrets/configs, relative bind paths, host pid/ipc, privileged, the Docker socket.</span>
          </div>
          <div className="field">
            <label htmlFor="ms-env">Variables (<code>${'{'}VAR{'}'}</code> substitution)</label>
            <textarea id="ms-env" className="mstack-yaml" value={envText} onChange={(e) => { setEnvText(e.target.value); setPlan(null); }} spellCheck={false} rows={Math.min(12, Math.max(3, envText.split('\n').length + 1))} placeholder={'TZ=Europe/Berlin\nDB_PASSWORD=…'} disabled={!canManage} />
            <span className="hint">One KEY=value per line. Values whose key looks secret are masked here (••••) and kept on the server unless you type a new one. Only these variables are substituted — never OpusHub's own environment.</span>
            {envParsed.error && <span className="cedit-err">{envParsed.error}</span>}
          </div>

          <div className="mstack-actions">
            <button className="btn" disabled={!!busy || !canManage || (isNew && !nameOk)} onClick={() => void validate()}>{busy === 'validate' ? 'Validating…' : 'Validate'}</button>
            <button className="btn btn-primary" disabled={!!busy || !canManage || (isNew ? !nameOk : !dirty) || !!envParsed.error} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : isNew ? 'Save (do not deploy)' : 'Save revision'}</button>
            {!isNew && <button className="btn" disabled={!!busy || !s} onClick={() => void preview()}>{busy === 'plan' ? 'Comparing…' : dirty ? 'Preview plan for unsaved changes' : 'Preview deploy plan'}</button>}
            <span style={{ flex: 1 }} />
            {!isNew && s && (
              <>
                <button className="btn btn-primary" disabled={!!busy || dirty || !data?.permissions.deploy} title={dirty ? 'Save the revision first' : `Deploy revision ${s.revision}`} onClick={() => op('deploy')}>Deploy…</button>
                {s.members.length > 0 && s.state !== 'running' && <button className="btn" disabled={!!busy} onClick={() => op('start')}>Start…</button>}
                {s.members.length > 0 && s.state !== 'stopped' && <button className="btn btn-quiet stop" disabled={!!busy} onClick={() => op('stop')}>Stop…</button>}
                {(s.members.length > 0) && <button className="btn btn-danger" disabled={!!busy || !data?.permissions.remove} onClick={() => op('remove')}>Remove…</button>}
              </>
            )}
          </div>
          {notice && <p className={notice.kind === 'ok' ? 'op-note op-note--ok' : 'op-note op-note--bad'} role="status">{notice.text}</p>}
          {!isNew && dirty && <p className="op-quiet">Unsaved changes. Deploy always uses the saved revision, so save first — a confirmation issued for an older revision is refused automatically.</p>}
        </div>

        <aside className="mstack-side">
          {validation && <ValidationPanel v={validation} />}
          {plan && (
            <section className="mstack-card">
              <h3>Deploy plan {dirty && <span className="op-quiet">(unsaved document)</span>}</h3>
              <ul className="mstack-services">
                {(plan.plan.networks || []).filter((n) => n.action !== 'exists').map((n) => <li key={`n-${n.name}`}><span className="mstack-act" data-act={n.action}>{n.action}</span> network <code>{n.name}</code></li>)}
                {(plan.plan.volumes || []).filter((v) => v.action !== 'exists').map((v) => <li key={`v-${v.name}`}><span className="mstack-act" data-act={v.action}>{v.action}</span> volume <code>{v.name}</code></li>)}
                {(plan.plan.services || []).map((svc) => (
                  <li key={svc.key}>
                    <span className="mstack-act" data-act={svc.action}>{svc.action}</span> <code>{svc.key}</code>
                    {svc.image && <span className="op-quiet"> {svc.image}</span>}
                    {svc.diff?.changed?.length ? <span className="op-quiet"> — {svc.diff.changed.join(', ')}</span> : null}
                  </li>
                ))}
              </ul>
              <PlanPanel plan={{ ...plan.plan, services: null }} compact />
            </section>
          )}
          {s && (
            <section className="mstack-card">
              <h3>On the engine</h3>
              {s.members.length === 0 ? <p className="op-quiet">No containers carry this project. {s.lastDeploy ? 'The last deployment did not leave anything running.' : 'Never deployed.'}</p> : (
                <ul className="mstack-services">
                  {s.members.map((m) => (
                    <li key={m.id}>
                      <span className="mstack-act" data-act={m.state === 'running' ? (m.health === 'unhealthy' ? 'unhealthy' : 'running') : 'stopped'}>{m.state}{m.health ? ` · ${m.health}` : ''}</span> <code>{m.service || m.containerName}</code>
                      <span className="op-quiet"> {m.image}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {data && (
            <section className="mstack-card">
              <div className="mstack-card-head">
                <h3>Deployments</h3>
                {data.history.some((h) => h.status === 'succeeded' && h.hasDocument) && canManage && <button className="btn btn-sm btn-quiet" disabled={!!busy} onClick={() => void rollback()}>Restore last good document</button>}
              </div>
              {data.history.length === 0 ? <p className="op-quiet">No deployments yet.</p> : (
                <ul className="mstack-history">
                  {data.history.map((h) => (
                    <li key={h.id} data-status={h.status}>
                      <span className="mstack-hist-status">{h.status}</span>
                      <span>{relTime(h.at)}{h.revision ? ` · rev ${h.revision}` : ''}{h.actor ? ` · ${h.actor}` : ''}</span>
                      {h.services?.length ? <span className="op-quiet">{h.services.map((x) => `${x.key}: ${x.result}`).join(' · ')}</span> : null}
                      {h.error && <span className="cedit-err">{h.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {!isNew && canManage && s && s.members.length === 0 && (
            <button className="btn btn-sm btn-quiet stop" disabled={!!busy} onClick={() => void forget()}>Forget this definition</button>
          )}
        </aside>
      </div>
    </>
  );
}

function stateWord(state: string, n: number) {
  switch (state) {
    case 'running': return `${n} container${n === 1 ? '' : 's'} running`;
    case 'partial': return 'partially running';
    case 'stopped': return `${n} container${n === 1 ? '' : 's'} stopped`;
    case 'not_deployed': return 'not deployed';
    default: return 'state unknown';
  }
}

function ValidationPanel({ v }: { v: Validation }) {
  return (
    <section className="mstack-card">
      <h3>Validation {v.policy && <span className="op-finding-level" data-level={v.policy.level}>{v.policy.level}</span>}</h3>
      {v.errors.length > 0 && <ul className="op-findings">{v.errors.map((e, i) => <li key={i} data-level="BLOCKED"><span className="op-finding-level">ERROR</span><span>{e}</span></li>)}</ul>}
      {v.services.length > 0 && (
        <ul className="mstack-services">
          {v.services.map((s) => <li key={s.key}><span className="mstack-act" data-act={(s.policy || 'SAFE').toLowerCase()}>{s.policy || 'SAFE'}</span> <code>{s.key}</code> <span className="op-quiet">{s.image} → {s.container}{s.dependsOn?.length ? ` · after ${s.dependsOn.join(', ')}` : ''}</span></li>)}
        </ul>
      )}
      {v.policy && v.policy.findings.length > 0 && (
        <ul className="op-findings">{v.policy.findings.map((f, i) => <li key={i} data-level={f.level}><span className="op-finding-level">{f.level}</span><span>{f.service ? <code>{f.service}</code> : null} {f.message}</span></li>)}</ul>
      )}
      {v.warnings.length > 0 && <ul className="op-findings">{v.warnings.map((w, i) => <li key={i} data-level="WARNING"><span className="op-finding-level">NOTE</span><span>{w}</span></li>)}</ul>}
    </section>
  );
}
