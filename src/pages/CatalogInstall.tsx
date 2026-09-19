// Phase 10D-D — install a catalog service.
//
// The page is a form over the manifest's declared slots (name, version, variables, ports,
// storage, network, exposure, restart, healthcheck, integrations). "Preview" asks the server for
// the plan (POST /api/v1/catalog/:id/plan — no mutation); "Install…" opens the operations dialog
// for `service.install`, which re-evaluates the same plan, requires the strong confirmation,
// and runs the transaction. The browser never sends a Docker field — only this config object.
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, invalidateShared, usePolled } from '../lib/api';
import { relTime } from '../lib/format';
import { Icon } from '../components/Icon';
import { Loading, PageHero, ProviderNote, Switch } from '../components/ui';
import { OperationDialog, PlanPanel } from '../components/Operations';
import type { PlanDoc, PolicyFinding } from '../lib/operations';

interface Variable { key: string; label: string; description: string; kind: string; required: boolean; default: string | number | boolean | null; options: string[] | null; min: number | null; max: number | null; pattern: string | null; generate: 'password' | 'hex' | null; advanced: boolean }
interface Entry {
  id: string; name: string; summary: string; description: string; category: string; tags: string[]; icon: string | null; homepage: string | null; docs: string | null; notes: string[];
  image: { repository: string; recommended: string; versions: { tag: string; label: string; recommended: boolean; notes: string | null }[]; allowCustomTag: boolean; allowDigest: boolean };
  variables: Variable[];
  ports: { container: number; protocol: string; host: number | string | null; label: string; required: boolean }[];
  volumes: { target: string; label: string; description: string; default: string; readOnly: boolean; allowBind: boolean }[];
  network: { default: string; aliases: string[] };
  proxy: { port: number; scheme: string; default: boolean } | null;
  healthcheck: { intervalMs: number; timeoutMs: number; retries: number } | null;
  restartPolicy: string;
  monitoring: { type: string; path: string; default: boolean };
  autoheal: { default: boolean };
  updates: { default: boolean };
}
interface Detail {
  entry: Entry; instances: { name: string; state: string; image: string; version: string | null }[]; networks: string[];
  registries: { id: string; name: string; hasSecret: boolean }[];
  proxy: { provider: string; label: string; available: boolean; network: string | null };
  permissions: { install: boolean };
  history: { id: string; at: number; name: string; status: string; error: string | null; actor: string | null; version: string | null }[];
}
interface PlanResponse { ok: boolean; problems: string[]; plan: PlanDoc | null; variables?: Record<string, string>; policy?: { level: PolicyFinding['level']; findings: PolicyFinding[] } }

type Config = Record<string, unknown>;

const randomValue = (kind: 'password' | 'hex') => {
  const bytes = new Uint8Array(kind === 'hex' ? 16 : 18);
  crypto.getRandomValues(bytes);
  if (kind === 'hex') return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export default function CatalogInstallPage() {
  const { id } = useParams();
  const { data, error } = usePolled<Detail>(id ? `/api/v1/catalog/${encodeURIComponent(id)}` : null, 60_000);
  const entry = data?.entry;

  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [customTag, setCustomTag] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [volumes, setVolumes] = useState<Record<string, string>>({});
  const [network, setNetwork] = useState('');
  const [expose, setExpose] = useState(false);
  const [domain, setDomain] = useState('');
  const [restart, setRestart] = useState('');
  const [health, setHealth] = useState(true);
  const [monitoring, setMonitoring] = useState(true);
  const [autoheal, setAutoheal] = useState(false);
  const [updates, setUpdates] = useState(true);
  const [registryId, setRegistryId] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<Config | null>(null);

  useEffect(() => {
    if (!entry) return;
    setName(entry.id);
    setVersion(entry.image.recommended);
    const v: Record<string, string> = {};
    for (const x of entry.variables) v[x.key] = x.default === null ? '' : String(x.default);
    setVars(v);
    const p: Record<string, string> = {};
    for (const x of entry.ports) p[`${x.container}/${x.protocol}`] = x.host === null ? '' : String(x.host).replace(/^\$\{(.+)\}$/, (_, k) => v[k] ?? '');
    setPorts(p);
    const vol: Record<string, string> = {};
    for (const x of entry.volumes) vol[x.target] = x.default.startsWith('volume:') ? '' : x.default;
    setVolumes(vol);
    setNetwork(entry.network.default);
    setExpose(!!entry.proxy?.default && !!data?.proxy.available);
    setRestart(entry.restartPolicy);
    setHealth(!!entry.healthcheck);
    setMonitoring(entry.monitoring.default);
    setAutoheal(entry.autoheal.default);
    setUpdates(entry.updates.default);
    setRegistryId(data?.registries[0]?.id ?? '');
  }, [entry, data]);

  const config = useMemo<Config>(() => {
    if (!entry) return {};
    const c: Config = { name };
    if (version === '__custom__') c.tag = customTag; else if (version) c.version = version;
    const v: Record<string, string> = {};
    for (const x of entry.variables) if (vars[x.key] !== undefined && vars[x.key] !== '') v[x.key] = vars[x.key];
    if (Object.keys(v).length) c.variables = v;
    const p: Record<string, number | null> = {};
    for (const x of entry.ports) { const k = `${x.container}/${x.protocol}`; p[k] = ports[k] === '' || ports[k] === undefined ? null : Number(ports[k]); }
    if (Object.keys(p).length) c.ports = p;
    const vol: Record<string, string> = {};
    for (const x of entry.volumes) if (volumes[x.target]) vol[x.target] = volumes[x.target];
    if (Object.keys(vol).length) c.volumes = vol;
    c.network = network || entry.network.default;
    if (expose && entry.proxy) c.expose = { domain: domain.trim().toLowerCase() };
    c.restartPolicy = restart || entry.restartPolicy;
    if (entry.healthcheck) c.healthcheck = health;
    c.monitoring = monitoring;
    c.autoheal = autoheal;
    c.updates = updates;
    if (registryId) c.registryId = registryId;
    return c;
  }, [entry, name, version, customTag, vars, ports, volumes, network, expose, domain, restart, health, monitoring, autoheal, updates, registryId]);

  useEffect(() => { setPlan(null); }, [config]);

  const preview = async () => {
    if (!entry) return;
    setBusy(true);
    try { setPlan(await api<PlanResponse>(`/api/v1/catalog/${encodeURIComponent(entry.id)}/plan`, { method: 'POST', body: JSON.stringify({ config }) })); }
    catch (err) { setPlan({ ok: false, problems: [err instanceof ApiError ? String((err.body as { error?: string } | null)?.error || err.message) : String(err)], plan: null }); }
    finally { setBusy(false); }
  };

  if (error && !data) return <ProviderNote status="error" reason={String(error)} fixHref="/catalog" fixLabel="Catalog →" />;
  if (!data || !entry) return <Loading what="catalog entry" />;
  const canInstall = data.permissions.install;
  const visibleVars = entry.variables.filter((v) => showAdvanced || !v.advanced);

  return (
    <>
      <PageHero
        title={<span className="catalog-title"><Icon ref={entry.icon} name={entry.name} size={32} /> {entry.name}</span>}
        desc={entry.description || entry.summary}
        meta={
          <>
            <Link to="/catalog" className="section-link">← Catalog</Link>
            <span className="sep">·</span><span>{entry.image.repository}</span>
            {entry.homepage && <><span className="sep">·</span><a href={entry.homepage} target="_blank" rel="noreferrer">Homepage ↗</a></>}
            {entry.docs && <><span className="sep">·</span><a href={entry.docs} target="_blank" rel="noreferrer">Docs ↗</a></>}
            {data.instances.length > 0 && <><span className="sep">·</span><span>{data.instances.length} installed</span></>}
          </>
        }
      />
      {!canInstall && <ProviderNote status="unavailable" reason="Your account can browse the catalog but not install from it." />}
      {entry.notes.map((n, i) => <p key={i} className="op-note">{n}</p>)}

      <div className="mstack">
        <div className="mstack-editor catalog-form">
          <section className="mstack-card">
            <h3>Container</h3>
            <div className="field">
              <label htmlFor="ci-name">Name</label>
              <input id="ci-name" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} disabled={!canInstall} />
              <span className="hint">Docker container name. Volumes and the dedicated network are derived from it.</span>
            </div>
            <div className="field">
              <label htmlFor="ci-version">Version</label>
              <select id="ci-version" value={version} onChange={(e) => setVersion(e.target.value)} disabled={!canInstall}>
                {entry.image.versions.map((v) => <option key={v.tag} value={v.tag}>{v.label}{v.recommended ? ' (recommended)' : ''}</option>)}
                {entry.image.allowCustomTag && <option value="__custom__">Other tag…</option>}
              </select>
              {version === '__custom__' && <input value={customTag} onChange={(e) => setCustomTag(e.target.value)} placeholder="tag" spellCheck={false} />}
            </div>
            {data.registries.length > 0 && (
              <div className="field">
                <label htmlFor="ci-registry">Pull credentials</label>
                <select id="ci-registry" value={registryId} onChange={(e) => setRegistryId(e.target.value)} disabled={!canInstall}>
                  <option value="">Anonymous</option>
                  {data.registries.map((r) => <option key={r.id} value={r.id}>{r.name}{r.hasSecret ? '' : ' (no secret)'}</option>)}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="ci-restart">Restart policy</label>
              <select id="ci-restart" value={restart} onChange={(e) => setRestart(e.target.value)} disabled={!canInstall}>
                {['unless-stopped', 'always', 'on-failure', 'no'].map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </section>

          {entry.variables.length > 0 && (
            <section className="mstack-card">
              <div className="mstack-card-head"><h3>Settings</h3>{entry.variables.some((v) => v.advanced) && <button className="btn btn-sm btn-quiet" onClick={() => setShowAdvanced((s) => !s)}>{showAdvanced ? 'Hide advanced' : 'Show advanced'}</button>}</div>
              {visibleVars.map((v) => (
                <div className="field" key={v.key}>
                  <label htmlFor={`ci-var-${v.key}`}>{v.label}{v.required && <span aria-hidden="true"> *</span>}</label>
                  {v.kind === 'boolean' ? (
                    <Switch checked={vars[v.key] === 'true'} onChange={(on) => setVars({ ...vars, [v.key]: on ? 'true' : 'false' })} />
                  ) : v.kind === 'enum' ? (
                    <select id={`ci-var-${v.key}`} value={vars[v.key] ?? ''} onChange={(e) => setVars({ ...vars, [v.key]: e.target.value })} disabled={!canInstall}>{(v.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
                  ) : (
                    <div className="cedit-row">
                      <input id={`ci-var-${v.key}`} type={v.kind === 'secret' ? 'password' : v.kind === 'number' || v.kind === 'port' ? 'number' : 'text'} value={vars[v.key] ?? ''} onChange={(e) => setVars({ ...vars, [v.key]: e.target.value })} spellCheck={false} autoComplete="off" disabled={!canInstall} />
                      {v.generate && <button className="btn btn-sm" type="button" onClick={() => setVars({ ...vars, [v.key]: randomValue(v.generate!) })} disabled={!canInstall}>Generate</button>}
                    </div>
                  )}
                  {v.description && <span className="hint">{v.description}</span>}
                </div>
              ))}
            </section>
          )}

          {entry.ports.length > 0 && (
            <section className="mstack-card">
              <h3>Ports</h3>
              {entry.ports.map((p) => { const k = `${p.container}/${p.protocol}`; return (
                <div className="field" key={k}>
                  <label htmlFor={`ci-port-${k}`}>{p.label} <span className="op-quiet">(container {k})</span>{p.required && ' *'}</label>
                  <input id={`ci-port-${k}`} type="number" min={1} max={65535} value={ports[k] ?? ''} onChange={(e) => setPorts({ ...ports, [k]: e.target.value })} placeholder="not published" disabled={!canInstall} />
                </div>
              ); })}
              <span className="hint">Leave a port empty to keep it internal (reachable through the reverse proxy or from other containers only).</span>
            </section>
          )}

          {entry.volumes.length > 0 && (
            <section className="mstack-card">
              <h3>Storage</h3>
              {entry.volumes.map((v) => (
                <div className="field" key={v.target}>
                  <label htmlFor={`ci-vol-${v.target}`}>{v.label} <span className="op-quiet">({v.target}{v.readOnly ? ', read-only' : ''})</span></label>
                  <input id={`ci-vol-${v.target}`} value={volumes[v.target] ?? ''} onChange={(e) => setVolumes({ ...volumes, [v.target]: e.target.value })} placeholder={v.allowBind ? `named volume ${name || entry.id}-data — or an absolute host path` : 'named volume (managed by Docker)'} spellCheck={false} disabled={!canInstall || !v.allowBind} />
                  {v.description && <span className="hint">{v.description}</span>}
                </div>
              ))}
            </section>
          )}

          <section className="mstack-card">
            <h3>Network</h3>
            <div className="field">
              <label htmlFor="ci-net">Network</label>
              <select id="ci-net" value={network} onChange={(e) => setNetwork(e.target.value)} disabled={!canInstall}>
                <option value="bridge">Default bridge</option>
                <option value="dedicated">Dedicated network ({name || entry.id}_net, created)</option>
                {data.networks.filter((n) => n !== 'bridge').map((n) => <option key={n} value={n}>{n} (existing)</option>)}
              </select>
            </div>
            {entry.proxy && (
              <>
                <div className="field">
                  <Switch checked={expose} onChange={setExpose} label={`Route through ${data.proxy.label}${data.proxy.available ? '' : ' (no provider configured)'}`} />
                </div>
                {expose && (
                  <div className="field">
                    <label htmlFor="ci-domain">Domain</label>
                    <input id="ci-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.example.com" spellCheck={false} disabled={!canInstall} />
                    <span className="hint">{data.proxy.label} forwards https://{domain || 'app.example.com'}/ to container port {entry.proxy.port}{data.proxy.network ? `, joining network ${data.proxy.network}` : ''}.</span>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="mstack-card">
            <h3>Health &amp; integrations</h3>
            {entry.healthcheck && <div className="field"><Switch checked={health} onChange={setHealth} label={`Healthcheck (every ${Math.round(entry.healthcheck.intervalMs / 1000)}s, ${entry.healthcheck.retries} retries)`} /></div>}
            <div className="field"><Switch checked={monitoring} onChange={setMonitoring} label={`Register a ${entry.monitoring.type === 'http' && expose ? 'HTTP' : 'Docker'} monitor`} /></div>
            <div className="field"><Switch checked={autoheal} onChange={setAutoheal} label="Autoheal opt-in (restart when Docker reports unhealthy)" /></div>
            <div className="field"><Switch checked={updates} onChange={setUpdates} label="Track image updates (Diun / Update Now)" /></div>
          </section>

          <div className="mstack-actions">
            <button className="btn" disabled={busy || !canInstall} onClick={() => void preview()}>{busy ? 'Planning…' : 'Preview plan'}</button>
            <button className="btn btn-primary" disabled={busy || !canInstall || !name} onClick={() => setInstalling(config)}>Install…</button>
          </div>
        </div>

        <aside className="mstack-side">
          {installing && (
            <section className="mstack-card">
              <OperationDialog inline action="service.install" target={{ type: 'catalog', id: entry.id }} params={{ config: installing }} onClose={() => { setInstalling(null); invalidateShared('/api/v1/catalog'); }} />
            </section>
          )}
          {plan && (
            <section className="mstack-card">
              <h3>Install plan {plan.policy && <span className="op-finding-level" data-level={plan.policy.level}>{plan.policy.level}</span>}</h3>
              {plan.problems.length > 0 && <ul className="op-findings">{plan.problems.map((p, i) => <li key={i} data-level="BLOCKED"><span className="op-finding-level">FIX</span><span>{p}</span></li>)}</ul>}
              {plan.plan && <PlanPanel plan={plan.plan} />}
            </section>
          )}
          {data.instances.length > 0 && (
            <section className="mstack-card">
              <h3>Installed</h3>
              <ul className="mstack-services">{data.instances.map((i) => <li key={i.name}><span className="mstack-act" data-act={i.state === 'running' ? 'running' : 'stopped'}>{i.state}</span> <Link to={`/services/Other/${encodeURIComponent(i.name)}`}><code>{i.name}</code></Link> <span className="op-quiet">{i.version || i.image}</span></li>)}</ul>
            </section>
          )}
          {data.history.length > 0 && (
            <section className="mstack-card">
              <h3>Install history</h3>
              <ul className="mstack-history">{data.history.map((h) => <li key={h.id} data-status={h.status}><span className="mstack-hist-status">{h.status}</span><span>{relTime(h.at)} · {h.name}{h.version ? ` · ${h.version}` : ''}{h.actor ? ` · ${h.actor}` : ''}</span>{h.error && <span className="cedit-err">{h.error}</span>}</li>)}</ul>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
