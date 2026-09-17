// Infrastructure → Network.
//
//   Interfaces   what the kernel lists in /sys/class/net, with the addresses and counters it
//                reports. No MAC addresses: nothing on this page needs to identify hardware.
//   Routing      the default route and a count. The full table is deliberately not exposed.
//   DNS          the resolver configuration, with its source stated — OpusHub never claims to
//                know what is behind an address (no "this is AdGuard" guesses).
//   OPNsense     optional, read-only, and honest when it is not connected.
import { bytes } from '../../lib/format';
import type { ExternalDomainDoc, NetworkDomainDoc, OpnsenseDoc } from '../../lib/types';
import { ProviderNote } from '../ui';

const NA = <span className="stale-note">Not available</span>;
const v = (x: unknown) => (x == null || x === '' ? NA : String(x));

function KV({ k, children }: { k: string; children: React.ReactNode }) {
  return (<><dt>{k}</dt><dd>{children}</dd></>);
}

/* ------------------------------------------------------------------ */
/* OPNsense                                                            */
/* ------------------------------------------------------------------ */

function CapabilityRow({ id, label, status, reason }: { id: string; label: string; status: string; reason: string | null }) {
  const word = status === 'available' ? 'Available'
    : status === 'planned' ? 'Planned'
      : status === 'unavailable' ? 'Capability unavailable'
        : status === 'error' ? 'Failed'
          : 'Not available';
  return (
    <div className="prov-row">
      <b style={{ fontWeight: 600 }}>{label}</b>
      <span className="stale-note" style={{ marginLeft: 'auto' }}>{word}</span>
      {reason && <span className="stale-note" style={{ flexBasis: '100%' }}>{reason}</span>}
      <span className="sr-only">{id}</span>
    </div>
  );
}

export function OpnsenseSection({ external }: { external: ExternalDomainDoc | null }) {
  const opn = (external?.opnsense || null) as Partial<OpnsenseDoc> | null;
  if (!opn) return <ProviderNote status="unknown" reason="OPNsense has not been checked yet." compact />;

  if (opn.status === 'not-configured' || !opn.configured) {
    return (
      <>
        <ProviderNote
          status="unconfigured"
          reason={opn.reason || 'OPNsense is not configured.'}
          compact
          fixHref="/settings/connections"
          fixLabel="Connections →"
        />
        <p className="stale-note" style={{ marginTop: 'var(--sp-4)' }}>
          OPNsense is optional. Nothing else in OpusHub changes because it is not connected, and an
          install without it is not unhealthy.
        </p>
      </>
    );
  }

  return (
    <>
      <dl className="kv">
        <KV k="Status">{v(opn.status === 'connected' ? 'Connected' : opn.status === 'degraded' ? 'Degraded' : 'Unavailable')}</KV>
        <KV k="Address">{opn.url ? <span className="mono-meta">{opn.url}</span> : NA}</KV>
        <KV k="Version">{v(opn.version)}</KV>
        <KV k="Credentials">
          {opn.credentialPresent
            ? 'Present, in the environment — never shown here and never written to configuration'
            : 'Not present'}
        </KV>
        {opn.system?.hostname && <KV k="Hostname">{v(opn.system.hostname)}</KV>}
        {opn.system?.product && <KV k="Product">{v(opn.system.product)}</KV>}
        {opn.reason && <KV k="Note">{v(opn.reason)}</KV>}
      </dl>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        <div className="sys-band-head"><h2>Capabilities</h2></div>
        {(opn.capabilities || []).map((c) => (
          <CapabilityRow key={c.id} id={c.id} label={c.label} status={c.status} reason={c.reason} />
        ))}
      </div>

      {!!opn.interfaces?.length && (
        <div style={{ marginTop: 'var(--sp-5)' }}>
          <div className="sys-band-head"><h2>Interfaces</h2></div>
          {opn.interfaces.map((i, idx) => (
            <div className="if-row" key={`${i.name || i.device}-${idx}`}>
              <span className="if-name">{i.name || i.device || 'unnamed'}</span>
              <span className="mono-meta">{i.address ? v(i.address) : NA}</span>
              <span className="if-state">{v(i.status)}{i.enabled === false ? ' · disabled' : ''}</span>
            </div>
          ))}
        </div>
      )}

      {!!opn.gateways?.length && (
        <div style={{ marginTop: 'var(--sp-5)' }}>
          <div className="sys-band-head"><h2>Gateways</h2></div>
          {opn.gateways.map((g, idx) => (
            <div className="if-row" key={`${g.name || g.address}-${idx}`}>
              <span className="if-name">{g.name || g.address || 'unnamed'}</span>
              <span className="mono-meta">{v(g.address)}</span>
              <span className="if-state">{v(g.status)}</span>
            </div>
          ))}
        </div>
      )}

      {opn.dns && (
        <div style={{ marginTop: 'var(--sp-5)' }}>
          <div className="sys-band-head"><h2>DNS resolver</h2></div>
          <dl className="kv">
            <KV k="Enabled">{opn.dns.enabled == null ? NA : (opn.dns.enabled ? 'Yes' : 'No')}</KV>
            <KV k="Port">{v(opn.dns.port)}</KV>
            <KV k="DNSSEC">{opn.dns.dnssecEnabled == null ? NA : (opn.dns.dnssecEnabled ? 'Yes' : 'No')}</KV>
          </dl>
        </div>
      )}

      {!!opn.planned?.length && (
        <p className="stale-note" style={{ marginTop: 'var(--sp-4)' }}>
          Planned and not implemented: {opn.planned.join(', ')}.
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* the panel                                                          */
/* ------------------------------------------------------------------ */

export function NetworkPanel({ network, external }: { network: NetworkDomainDoc | null; external: ExternalDomainDoc | null }) {
  if (!network) return <p className="stale-note" role="status">Reading the host network…</p>;

  const upCount = network.interfaces.filter((i) => i.state === 'up').length;

  return (
    <>
      {network.scopeNote && (
        <div className="unavailable compact" role="status">
          <span className="why">{network.scope === 'container' ? 'Container namespace.' : 'Host namespace.'}</span>
          <span className="reason">{network.scopeNote}</span>
        </div>
      )}

      <section className="sys-band">
        <div className="sys-band-head">
          <h2>Interfaces</h2>
          <span className="hint">
            {network.interfaceCount != null ? `${network.interfaceCount} reported` : '—'}
            {upCount ? ` · ${upCount} up` : ''}
          </span>
        </div>
        {network.status !== 'available' && (
          <ProviderNote status="unavailable" reason={network.reason || 'Interface information is not available.'} compact />
        )}
        {network.interfaces.map((i) => (
          <div className="if-row" key={i.name}>
            <span className="if-name">
              <span className={`status-dot ${i.state === 'up' ? 'up' : 'absent'}`} aria-hidden="true" />
              {i.name}
              <span className="if-state">{i.kind}{i.mtu != null ? ` · mtu ${i.mtu}` : ''}{i.speedMbps ? ` · ${i.speedMbps} Mbps` : ''}</span>
            </span>
            <span className="grow" style={{ minWidth: 0 }}>
              {i.addresses.length
                ? i.addresses.slice(0, 3).map((a) => (
                  <div className="mono-meta" key={`${a.address}-${a.family}`}>
                    {a.address}{a.scope === 'link' ? ' (link-local)' : ''}
                  </div>
                ))
                : <span className="stale-note">no address</span>}
            </span>
            <span className="if-traffic mono-meta">
              {i.rx ? `↓ ${bytes(i.rx.bytes)}` : NA}{i.tx ? ` · ↑ ${bytes(i.tx.bytes)}` : ''}
              {i.rx?.errors || i.tx?.errors ? <div className="stale-note">{i.rx?.errors ?? 0} rx / {i.tx?.errors ?? 0} tx errors</div> : null}
            </span>
          </div>
        ))}
        {network.status === 'available' && !network.interfaces.length && (
          <ProviderNote status="unconfigured" reason="No interfaces were reported." compact />
        )}
        {network.summaryOnly && <p className="stale-note">Open the Network tab for the full list.</p>}
      </section>

      <section className="sys-band">
        <div className="sys-band-head"><h2>Routing</h2></div>
        {network.routes?.defaultRoute ? (
          <dl className="kv">
            <KV k="Default route">
              {network.routes.defaultRoute.via
                ? <span className="mono-meta">via {network.routes.defaultRoute.via}</span>
                : <span className="stale-note">no gateway address</span>}
              {' '}<span className="stale-note">on {network.routes.defaultRoute.iface}</span>
            </KV>
            {network.routes.defaultRoutes.filter((r) => r.protocol === 'ipv6').map((r) => (
              <KV key="v6" k="Default route (IPv6)">
                {r.via ? <span className="mono-meta">via {r.via}</span> : <span className="stale-note">no gateway address</span>}
                {' '}<span className="stale-note">on {r.iface}</span>
              </KV>
            ))}
            {network.routes.routeCount != null && <KV k="IPv4 routes">{network.routes.routeCount}</KV>}
            {network.routes.routeCount6 != null && <KV k="IPv6 routes">{network.routes.routeCount6}</KV>}
          </dl>
        ) : (
          <ProviderNote status="unconfigured" reason="No default route was reported." compact />
        )}
        <p className="stale-note" style={{ marginTop: 'var(--sp-4)' }}>
          {network.routes?.note || 'Only the default route is shown. The full routing table is not exposed.'}
        </p>
      </section>

      <section className="sys-band">
        <div className="sys-band-head"><h2>DNS</h2><span className="hint">source: {network.dns?.source || 'unknown'}</span></div>
        {network.dns?.available ? (
          <dl className="kv">
            <KV k="Resolver">
              {network.dns.nameservers.length ? 'Available' : 'None configured'}
              {network.dns.viaStubResolver && <span className="stale-note"> · via a local stub resolver</span>}
            </KV>
            <KV k="Nameservers">
              {network.dns.nameservers.length
                ? network.dns.nameservers.map((s) => <span className="mono-meta" key={s} style={{ marginRight: 10 }}>{s}</span>)
                : NA}
            </KV>
            <KV k="Search domains">
              {network.dns.search.length ? network.dns.search.map((s) => <span className="mono-meta" key={s} style={{ marginRight: 10 }}>{s}</span>) : <span className="stale-note">None</span>}
            </KV>
          </dl>
        ) : (
          <ProviderNote status="unavailable" reason={network.dns?.note || 'The resolver configuration is not readable.'} compact />
        )}
        {network.dns?.viaStubResolver && (
          <p className="stale-note" style={{ marginTop: 'var(--sp-4)' }}>
            OpusHub reports the address it was given. It does not guess which resolver answers behind it.
          </p>
        )}
      </section>

      {network.docker && (
        <section className="sys-band">
          <div className="sys-band-head">
            <h2>Docker networks</h2>
            <span className="hint">{network.docker.networkCount ?? '—'} on this engine</span>
          </div>
          {!network.docker.live && <ProviderNote status="unavailable" reason={network.docker.reason || 'The engine is not answering.'} compact />}
          {network.docker.networks.map((n) => (
            <div className="disk-row" key={String(n.name)}>
              <div style={{ minWidth: 0 }}>
                <div className="disk-mount">{n.name}</div>
                <div className="disk-fs">{[n.driver, n.scope, n.internal ? 'internal' : null, n.attachable ? 'attachable' : null].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="disk-nums">{n.containerCount} attached</div>
            </div>
          ))}
          {network.docker.live && !network.docker.networks.length && (
            <ProviderNote status="unconfigured" reason="The engine reports no networks." compact />
          )}
        </section>
      )}

      <section className="sys-band">
        <div className="sys-band-head"><h2>OPNsense</h2><span className="hint">optional · read-only</span></div>
        <OpnsenseSection external={external} />
      </section>
    </>
  );
}
