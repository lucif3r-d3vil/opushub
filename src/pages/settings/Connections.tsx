// Settings → Connections — every provider, what it can do, and how it is doing.
//
// This pane is deliberately mostly informational. Connecting infrastructure is not the same kind
// of configuration as choosing a theme: it reaches outside OpusHub, so the writeable surface here
// is one non-secret field (the OPNsense address). Credentials are never stored in configuration
// at all — they come from the environment, which is why this pane can print their names without
// ever being able to print their values.
//
// Nothing here connects anything on its own: a provider is checked when something asks for it,
// and the timestamp below is when that last happened.
import { useEffect, useState } from 'react';
import { usePolled } from '../../lib/api';
import { relTime } from '../../lib/format';
import { useSettings } from '../../lib/theme';
import type { InfrastructureProvidersDoc, PhysicalTopologyDoc } from '../../lib/types';
import { ProviderRow } from '../../components/InfraStatusStrip';
import { ProviderNote } from '../../components/ui';

const OPN_ENV = { key: 'OPUSHUB_OPNSENSE_KEY', secret: 'OPUSHUB_OPNSENSE_SECRET' };

export default function ConnectionsTab() {
  const { settings, update, saveState } = useSettings();
  const doc = usePolled<InfrastructureProvidersDoc>('/api/infrastructure/providers', 60_000);
  const physical = usePolled<PhysicalTopologyDoc>('/api/infrastructure/physical', 0);

  const configuredUrl = settings?.infrastructure?.opnsense?.url ?? null;
  const [url, setUrl] = useState(configuredUrl || '');
  useEffect(() => { setUrl(configuredUrl || ''); }, [configuredUrl]);

  const dirty = (url.trim() || null) !== (configuredUrl || null);
  const save = () => update({ infrastructure: { opnsense: { url: url.trim() || null } } });

  const opnsense = doc.data?.providers.find((p) => p.id === 'opnsense') || null;

  return (
    <>
      <section className="sys-band" style={{ paddingTop: 0, borderTop: 0 }}>
        <div className="sys-band-head">
          <h2>Providers</h2>
          <span className="hint">{doc.data ? `${doc.data.count} registered` : 'reading…'}</span>
        </div>
        <p className="stale-note" style={{ marginBottom: 'var(--sp-5)' }}>
          Each provider is independent: one that cannot answer never stops the others, and an
          optional provider that was never configured is not a fault. Nothing here is polled in the
          background — a provider is checked when something asks for it.
        </p>
        <div className="prov-list">
          {(doc.data?.providers || []).map((p) => (
            <div key={p.id}>
              <ProviderRow provider={p} />
              <div className="stale-note" style={{ paddingBottom: 6 }}>
                {p.optional ? 'optional' : 'required'} · last checked {relTime(p.lastChecked)}
              </div>
            </div>
          ))}
          {!doc.data?.providers.length && <p className="stale-note">No provider has answered yet.</p>}
        </div>
      </section>

      <section className="sys-band">
        <div className="sys-band-head">
          <h2>OPNsense</h2>
          <span className="hint">
            {opnsense ? opnsense.statusLabel : 'not checked yet'}
          </span>
        </div>
        <p className="stale-note" style={{ marginBottom: 'var(--sp-5)' }}>
          Optional and read-only. OpusHub starts, and stays healthy, without it.
        </p>

        <div className="field">
          <label className="field-label" htmlFor="opnsense-url">Address</label>
          <div className="form-row">
            <input
              id="opnsense-url"
              className="input"
              type="url"
              inputMode="url"
              placeholder="https://fw.lan"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn btn-sm" type="button" onClick={save} disabled={!dirty || saveState === 'saving'}>
              {saveState === 'saving' ? 'Saving…' : 'Save'}
            </button>
            {configuredUrl && dirty && (
              <button className="btn btn-quiet btn-sm" type="button" onClick={() => setUrl(configuredUrl)}>Cancel</button>
            )}
          </div>
          <p className="stale-note">
            A plain <code>https://host</code> or <code>https://host:port</code>. Paths, query strings and
            credentials are refused: the endpoint list lives on the server, not in a URL you type.
          </p>
        </div>

        <dl className="kv" style={{ marginTop: 'var(--sp-6)' }}>
          <dt>Credentials</dt>
          <dd>
            {opnsense?.id && opnsense.status !== 'not-configured'
              ? 'Read from the environment — never shown here, never written to configuration'
              : 'Not configured'}
            <div className="stale-note" style={{ marginTop: 4 }}>
              Set <span className="mono-meta">{OPN_ENV.key}</span> and <span className="mono-meta">{OPN_ENV.secret}</span> in
              the environment OpusHub runs in. They cannot be entered here on purpose: configuration files are
              exported, restored and versioned, and a secret has no business in any of those.
            </div>
          </dd>
          <dt>Capabilities</dt>
          <dd>
            {(opnsense?.capabilities || []).join(', ') || 'none'}
            {!!opnsense?.planned.length && <span className="stale-note"> · planned: {opnsense.planned.join(', ')}</span>}
          </dd>
        </dl>

        {opnsense?.error?.reason && (
          <ProviderNote
            status={opnsense.status === 'not-configured' ? 'unconfigured' : 'unavailable'}
            reason={opnsense.error.reason}
            compact
          />
        )}
      </section>

      <section className="sys-band">
        <div className="sys-band-head"><h2>Power</h2><span className="hint">not configured</span></div>
        <p className="stale-note">
          UPS and PDU support is an abstraction in this release: the model, the provider slots and
          the read-only field list exist, but no client is connected, so both answer
          "Not configured". OpusHub cannot detect power hardware from inside a container, and it
          will not guess. Outlet switching and UPS shutdown are not part of OpusHub.
        </p>
      </section>

      <section className="sys-band">
        <div className="sys-band-head"><h2>Physical topology</h2><span className="hint">config file</span></div>
        {physical.data?.available ? (
          <dl className="kv">
            <dt>Configured</dt>
            <dd>{physical.data.nodes.length} devices · {physical.data.links.length} links</dd>
          </dl>
        ) : (
          <ProviderNote
            status="unconfigured"
            reason={physical.data?.reason || 'No physical topology is configured.'}
            compact
          />
        )}
        <p className="stale-note" style={{ marginTop: 'var(--sp-4)' }}>
          The physical layer — ISP, ONT, router, switch, NAS, UPS, PDU — cannot be discovered from
          inside a container, and inventing it would be a lie. It is described instead in
          {' '}<span className="mono-meta">config/topology.yaml</span>, and rendered with its relationships
          labelled "configured" so they are never mistaken for something OpusHub proved. There is no
          editor here yet: the file is written by hand, and it stays out of exports because it
          describes one room's hardware.
        </p>
      </section>
    </>
  );
}
