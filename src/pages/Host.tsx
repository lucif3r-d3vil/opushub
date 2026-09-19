// Host — the parent context for everything OpusHub watches.
//
// Every other page talks about *part* of the machine: services, stacks, storage, the network.
// This one answers "what machine is this, and what can OpusHub see on it" — identity, resources,
// the engine, and the provider picture side by side, so an operator can tell the difference
// between "not configured" and "broken" in one place.
//
// Everything here is read-only and everything comes from a provider. A field no provider could
// measure reads "Not available" — never a zero standing in for one.
import { Link } from 'react-router-dom';
import { usePolled } from '../lib/api';
import { bytes, pct, relTime, uptime } from '../lib/format';
import { useSettings } from '../lib/theme';
import type { HostDoc, OpusGridDoc } from '../lib/types';
import { Loading, PageHero, ProviderNote } from '../components/ui';
import { InfraStatusStrip, ProviderRow } from '../components/InfraStatusStrip';
import { SystemNav } from '../components/SystemNav';

const NA = <span className="stale-note">Not available</span>;
const v = (x: unknown) => (x == null || x === '' ? NA : String(x));

function KV({ k, children }: { k: string; children: React.ReactNode }) {
  return (<><dt>{k}</dt><dd>{children}</dd></>);
}

function Band({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="sys-band">
      <div className="sys-band-head"><h2>{title}</h2>{hint && <span className="hint">{hint}</span>}</div>
      {children}
    </section>
  );
}

export default function HostPage() {
  const { settings } = useSettings();
  const poll = (settings?.behavior?.refresh?.system ?? 30) * 1000;
  const host = usePolled<HostDoc>('/api/host', Math.max(poll, 30_000));
  const grid = usePolled<OpusGridDoc>('/api/infrastructure', Math.max(poll, 30_000));

  const h = host.data;
  const storage = grid.data?.domains.storage || null;
  const network = grid.data?.domains.network || null;
  const loading = !h && host.loading;

  return (
    <>
      <PageHero
        title={h?.host.hostname || 'Host'}
        desc="The machine OpusGrid runs on: what it is, what it has, and which providers can see it. Read-only — no page in OpusHub changes the host."
        meta={
          <>
            <span>{h?.host.os || 'operating system unknown'}</span>
            <span className="sep">·</span>
            <span>{h ? `up ${uptime(h.host.uptimeSec)}` : '—'}</span>
            <span className="sep">·</span>
            <span>{host.error ? 'refresh failed' : `updated ${relTime(host.fetchedAt || Date.now())}`}</span>
          </>
        }
      />

      <SystemNav />

      <InfraStatusStrip health={grid.data?.health} providers={grid.data?.providers} />

      {loading && <Loading what="the host" note="Reading identity, resources and providers." />}
      {host.error && <ProviderNote status="unavailable" reason={host.error} compact />}

      {h && (
        <div className="detail-grid host-grid">
          <Band title="Identity">
            <dl className="kv">
              <KV k="Hostname">{h.host.hostname ? <span className="mono-meta">{h.host.hostname}</span> : NA}</KV>
              <KV k="OS">{v(h.host.os)}</KV>
              <KV k="Kernel">{h.host.kernel ? <span className="mono-meta">{h.host.kernel}</span> : NA}</KV>
              <KV k="Architecture">{v(h.host.arch)}</KV>
              <KV k="Model">{v(h.host.model)}</KV>
              <KV k="Uptime">{h.host.uptimeSec != null ? uptime(h.host.uptimeSec) : NA}</KV>
              <KV k="Address">{h.address.effective ? <span className="mono-meta">{h.address.effective}</span> : NA}{h.address.source && <span className="stale-note"> · {h.address.source}</span>}</KV>
            </dl>
          </Band>

          <Band title="Compute">
            <dl className="kv">
              <KV k="CPU">{v(h.cpu.model)}{h.cpu.cores != null && <span className="stale-note"> · {h.cpu.cores} threads</span>}</KV>
              <KV k="Clock">{h.cpu.mhz != null ? `${h.cpu.mhz} MHz` : NA}</KV>
              <KV k="Memory">{h.memory.total ? bytes(h.memory.total) : NA}</KV>
              <KV k="Docker">{h.docker.status === 'connected' ? 'Connected' : v(h.docker.status)}</KV>
              <KV k="Engine">{v(h.docker.version)}</KV>
              <KV k="Containers">
                {h.docker.containers ?? '—'}
                {h.docker.running != null && <span className="stale-note"> · {h.docker.running} running{h.docker.stopped ? `, ${h.docker.stopped} stopped` : ''}</span>}
              </KV>
            </dl>
          </Band>

          <Band title="Storage" hint={<Link className="act" to="/system/infrastructure?tab=storage">Storage →</Link>}>
            {storage?.filesystems.totals ? (
              <dl className="kv">
                <KV k="Filesystems">{storage.filesystems.mountCount} mounts</KV>
                <KV k="Used">{bytes(storage.filesystems.totals.used)} of {bytes(storage.filesystems.totals.total)}</KV>
                <KV k="Free">{bytes(storage.filesystems.totals.free)}</KV>
                <KV k="ZFS">
                  {storage.zfs.available
                    ? `${storage.zfs.poolCount} pool${storage.zfs.poolCount === 1 ? '' : 's'} · ${storage.zfs.datasetCount} dataset${storage.zfs.datasetCount === 1 ? '' : 's'}`
                    : <span className="stale-note">Not available</span>}
                </KV>
              </dl>
            ) : <ProviderNote status="unavailable" reason={storage?.filesystems.reason || 'Storage has not been read yet.'} compact />}
            {storage?.zfs.available === false && storage.zfs.reason && (
              <p className="stale-note">{storage.zfs.reason}</p>
            )}
          </Band>

          <Band title="Network" hint={<Link className="act" to="/system/infrastructure?tab=network">Network →</Link>}>
            {network ? (
              <dl className="kv">
                <KV k="Interfaces">{network.interfaceCount ?? NA}{network.counts ? <span className="stale-note"> · {network.counts.up} up</span> : null}</KV>
                <KV k="Default route">
                  {network.routes?.defaultRoute
                    ? <span className="mono-meta">{network.routes.defaultRoute.via ? `via ${network.routes.defaultRoute.via}` : 'no gateway'} · {network.routes.defaultRoute.iface}</span>
                    : <span className="stale-note">None reported</span>}
                </KV>
                <KV k="DNS">{network.dns?.nameservers.length ? network.dns.nameservers.join(', ') : <span className="stale-note">None configured</span>}</KV>
                <KV k="Namespace">{network.scope === 'container' ? 'Container' : network.scope === 'host' ? 'Host' : NA}</KV>
              </dl>
            ) : <ProviderNote status="unavailable" reason="Network has not been read yet." compact />}
            {network?.scopeNote && <p className="stale-note">{network.scopeNote}</p>}
          </Band>

          <Band title="Providers" hint={<Link className="act" to="/settings/connections">Connections →</Link>}>
            <div className="prov-list">
              {(grid.data?.providers || []).map((p) => <ProviderRow key={p.id} provider={p} />)}
              {!grid.data?.providers?.length && <p className="stale-note">No provider has been checked yet.</p>}
            </div>
            {grid.data?.health?.note && <p className="stale-note" style={{ marginTop: 'var(--sp-4)' }}>{grid.data.health.note}</p>}
          </Band>

          <Band title="This install">
            <dl className="kv">
              <KV k="OpusHub"><span className="mono-meta">{h.opushub.version}</span></KV>
              <KV k="Build">{h.opushub.gitSha ? <span className="mono-meta">{h.opushub.gitSha}</span> : NA}</KV>
              <KV k="Mode">{v(h.opushub.installationMode === 'docker' ? 'Docker image' : 'Source checkout')}</KV>
              <KV k="Reverse proxy">
                {h.traefik.detected
                  ? `Detected · ${h.traefik.routedContainers} routed containers`
                  : <span className="stale-note">Not detected</span>}
              </KV>
              <KV k="Load">{/* the load average belongs to the System page; name it here only if known */}<Link className="act" to="/system">System vitals →</Link></KV>
            </dl>
          </Band>
        </div>
      )}

      {grid.data?.health && grid.data.health.status !== 'healthy' && (
        <p className="stale-note" style={{ marginTop: 'var(--sp-6)' }}>
          {grid.data.health.counts.notConfigured > 0
            ? `${grid.data.health.counts.notConfigured} domain${grid.data.health.counts.notConfigured === 1 ? '' : 's'} are not configured. That is not a fault — an OpusGrid without them is complete.`
            : 'Some part of the infrastructure needs attention — the Alerts page says which.'}
        </p>
      )}
    </>
  );
}
