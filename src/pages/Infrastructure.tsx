// Infrastructure — the OpusGrid control-plane view: engine, networks, volumes, images,
// topology. Everything here is read from Docker or the host; nothing is configured here,
// nothing is controlled here. When the engine is gone the page says so and shows the last
// known state, labelled, with a way back.
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { usePolled } from '../lib/api';
import { bytes, pct, relTime, uptime } from '../lib/format';
import { useSettings } from '../lib/theme';
import type {
  DockerDoc, ExternalDomainDoc, HostDoc, ImagesDoc, NetworksDoc, OpusGridDoc, PowerDomainDoc,
  ResourcesDoc, ServicesDoc, StorageDoc, StorageDomainDoc, TopologyDoc, VolumesDoc,
} from '../lib/types';
import { Loading, PageHero, ProviderNote, StatusLine } from '../components/ui';
import { OpusGridTopology } from '../components/OpusGridTopology';
import { InfraStatusStrip } from '../components/InfraStatusStrip';
import { StoragePanel } from '../components/infrastructure/StoragePanel';
import { NetworkPanel } from '../components/infrastructure/NetworkPanel';
import { PowerPanel } from '../components/infrastructure/PowerPanel';

type Tab = 'docker' | 'storage' | 'network' | 'power' | 'networks' | 'volumes' | 'images' | 'topology';
const TABS: { id: Tab; label: string }[] = [
  { id: 'docker', label: 'Docker' },
  { id: 'storage', label: 'Storage' },
  { id: 'network', label: 'Network' },
  { id: 'power', label: 'Power' },
  { id: 'networks', label: 'Docker networks' },
  { id: 'volumes', label: 'Volumes' },
  { id: 'images', label: 'Images' },
  { id: 'topology', label: 'Topology' },
];

const NA = <span className="stale-note">Not available</span>;
const v = (x: unknown) => (x == null || x === '' ? NA : String(x));

function KV({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </>
  );
}

function StaleBanner({ at, onRetry }: { at: number | null; onRetry: () => void }) {
  return (
    <div className="unavailable" role="status" style={{ marginBottom: 'var(--sp-6)' }}>
      <span className="why">Docker unavailable — showing last known state{at ? ` from ${relTime(at)}` : ''}.</span>
      <span className="reason">Live data will return when the engine answers. Nothing below is current.</span>
      <button className="btn btn-sm" onClick={onRetry}>Retry</button>
    </div>
  );
}

export default function InfrastructurePage() {
  const { settings } = useSettings();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'docker';
  const active: Tab = TABS.some((t) => t.id === tab) ? tab : 'docker';
  const setTab = (t: Tab) => setParams(t === 'docker' ? {} : { tab: t }, { replace: true });
  // Storage detail is a URL of its own, so a pool or a dataset can be linked to and reloaded.
  const pool = params.get('pool');
  const dataset = params.get('dataset');
  const selectPool = (name: string | null) => setParams(name ? { tab: 'storage', pool: name } : { tab: 'storage' }, { replace: true });
  const selectDataset = (name: string | null) => setParams(name ? { tab: 'storage', dataset: name } : { tab: 'storage' }, { replace: true });
  const poll = (settings?.behavior?.refresh?.services ?? 30) * 1000;

  const host = usePolled<HostDoc>('/api/host', poll);
  const eng = usePolled<DockerDoc>('/api/docker', poll);
  const nets = usePolled<NetworksDoc>('/api/networks', poll);
  const vols = usePolled<VolumesDoc>('/api/volumes', poll);
  const imgs = usePolled<ImagesDoc>('/api/images', poll);
  const res = usePolled<ResourcesDoc>('/api/resources', poll);
  const stor = usePolled<StorageDoc>('/api/storage', poll);
  const svc = usePolled<ServicesDoc>('/api/services', poll);
  // Phase 9 — the OpusGrid picture. The summary is always fetched (it carries the health strip);
  // the heavy domains are fetched only for the tab that shows them, which is what keeps a
  // poll of this page from asking for ZFS and OPNsense on every tick.
  const grid = usePolled<OpusGridDoc>('/api/infrastructure', poll);
  const storage = usePolled<StorageDomainDoc>(active === 'storage' ? '/api/infrastructure/storage' : null, Math.max(poll, 60_000));
  const network = usePolled<import('../lib/types').NetworkDomainDoc>(active === 'network' ? '/api/infrastructure/network' : null, poll);
  const external = usePolled<ExternalDomainDoc>(active === 'network' ? '/api/infrastructure/opnsense' : null, Math.max(poll, 60_000));
  const power = usePolled<PowerDomainDoc>(active === 'power' ? '/api/infrastructure/power' : null, Math.max(poll, 300_000));
  const topology = usePolled<TopologyDoc>(active === 'topology' ? '/api/infrastructure/topology' : null, Math.max(poll, 60_000));

  const live = eng.data?.live ?? nets.data?.live ?? true;
  const staleAt = eng.data?.lastKnown?.at ?? nets.data?.stale?.staleAt ?? null;
  const retry = () => { host.refresh(); eng.refresh(); nets.refresh(); vols.refresh(); imgs.refresh(); res.refresh(); stor.refresh(); svc.refresh(); grid.refresh(); storage.refresh(); network.refresh(); external.refresh(); power.refresh(); topology.refresh(); };

  const volumeBytes = useMemo(() => {
    const list = vols.data?.volumes || [];
    const known = list.filter((x) => x.size != null);
    return { total: known.reduce((a, x) => a + (x.size || 0), 0), known: known.length, of: list.length };
  }, [vols.data]);

  const imageBytes = useMemo(() => {
    const list = imgs.data?.images || [];
    return list.reduce((a, x) => a + (x.size || 0), 0);
  }, [imgs.data]);

  const loading = !host.data && !eng.data && !nets.data && host.loading;
  const counts = eng.data?.counts;

  return (
    <>
      <PageHero
        title="Infrastructure"
        desc="The machine and the engine underneath your services — Docker, networks, volumes, images and how they connect. Read-only: this page observes, it never changes anything."
        meta={
          <>
            <span>{counts?.containers ?? '—'} containers</span><span className="sep">·</span>
            <span>{counts?.networks ?? '—'} networks</span><span className="sep">·</span>
            <span>{counts?.volumes ?? '—'} volumes</span><span className="sep">·</span>
            <span>{counts?.images ?? '—'} images</span><span className="sep">·</span>
            <span>{eng.error ? 'refresh failed' : `updated ${relTime(eng.fetchedAt || Date.now())}`}</span>
            <Link className="btn btn-quiet btn-sm" to="/host">Host →</Link>
            <button className="btn btn-quiet btn-sm" onClick={retry}>Retry</button>
          </>
        }
      />

      <InfraStatusStrip health={grid.data?.health} providers={grid.data?.providers} />

      {!live && <StaleBanner at={staleAt} onRetry={retry} />}
      {loading && <Loading what="infrastructure" note="Reading the engine and the host." />}

      <div className="seg" role="tablist" aria-label="Infrastructure sections" style={{ marginBottom: 'var(--sp-8)' }}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={active === t.id} aria-pressed={active === t.id} onClick={() => setTab(t.id)} type="button">{t.label}</button>
        ))}
      </div>

      {active === 'docker' && (
        <div className="detail-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))' }}>
          <section className="sys-band">
            <div className="sys-band-head"><h2>Engine</h2><StatusLine state={eng.data?.status.ok ? 'up' : 'unavailable'} note={eng.data?.statusReason || undefined} /></div>
            {!eng.data?.status.ok && eng.data?.statusReason && <ProviderNote status="unavailable" reason={eng.data.statusReason} compact />}
            <dl className="kv">
              <KV k="Status">{eng.data?.status.ok ? 'Connected' : v(eng.data?.status.state)}</KV>
              <KV k="Version">{v(eng.data?.engine?.version)}</KV>
              <KV k="API">{v(eng.data?.engine?.apiVersion)}</KV>
              <KV k="OS / Arch">{host.data ? <span className="mono-meta">{v(host.data.docker.os)} / {v(host.data.docker.arch)}</span> : NA}</KV>
              <KV k="Driver">{v(eng.data?.engine?.driver)}</KV>
              <KV k="Containers">{counts?.containers ?? '—'}{counts?.running != null && <span className="stale-note"> · {counts.running} running{counts.stopped != null && counts.stopped > 0 ? `, ${counts.stopped} stopped` : ''}</span>}</KV>
            </dl>
          </section>

          <section className="sys-band">
            <div className="sys-band-head"><h2>Host</h2></div>
            <dl className="kv">
              <KV k="Hostname">{host.data?.host.hostname ? <span className="mono-meta">{host.data.host.hostname}</span> : NA}</KV>
              <KV k="OS">{v(host.data?.host.os)}</KV>
              <KV k="Kernel">{host.data?.host.kernel ? <span className="mono-meta">{host.data.host.kernel}</span> : NA}</KV>
              <KV k="CPU">{host.data?.cpu.model || NA}{host.data?.cpu.cores != null && <span className="stale-note"> · {host.data.cpu.cores} threads</span>}</KV>
              <KV k="Memory">{host.data?.memory.total ? bytes(host.data.memory.total) : NA}</KV>
              <KV k="Uptime">{host.data?.host.uptimeSec != null ? uptime(host.data.host.uptimeSec) : NA}</KV>
              <KV k="Address">{host.data?.address.effective ? <span className="mono-meta">{host.data.address.effective}</span> : NA}{host.data?.address.source && <span className="stale-note"> · {host.data.address.source}</span>}</KV>
            </dl>
          </section>

          <section className="sys-band">
            <div className="sys-band-head"><h2>Reverse proxy</h2></div>
            {host.data?.traefik.detected ? (
              <dl className="kv">
                <KV k="Traefik">Detected <span className="stale-note">· {host.data.traefik.source === 'container-labels' ? 'from container labels' : 'from container image'}</span></KV>
                <KV k="Routed">{host.data.traefik.routedContainers} containers · {host.data.traefik.routers} routers{host.data.traefik.tlsRouters > 0 && <span className="stale-note"> · {host.data.traefik.tlsRouters} TLS</span>}</KV>
                <KV k="Entrypoints">{host.data.traefik.entrypoints.length ? host.data.traefik.entrypoints.map((e) => <span key={e} className="mono-meta" style={{ marginRight: 8 }}>{e}</span>) : NA}</KV>
              </dl>
            ) : (
              <ProviderNote status="unconfigured" reason="No Traefik routing detected on this engine." compact />
            )}
          </section>

          <section className="sys-band">
            <div className="sys-band-head"><h2>Resources</h2><Link className="act" to="/system">System →</Link></div>
            <dl className="kv">
              <KV k="CPU">{res.data?.cpu.current != null ? pct(res.data.cpu.current, 1) : NA}{res.data?.cpu.peak != null && <span className="stale-note"> · peak {pct(res.data.cpu.peak, 0)} (1h)</span>}</KV>
              <KV k="Memory">{res.data?.memory.current != null ? bytes(res.data.memory.current) : NA}{res.data?.memory.usedPct != null && <span className="stale-note"> · {pct(res.data.memory.usedPct, 0)} used</span>}</KV>
              <KV k="Network">{res.data?.network.current ? <span className="mono-meta">↓ {bytes(res.data.network.current.rxPerSec, true)} · ↑ {bytes(res.data.network.current.txPerSec, true)}</span> : NA}</KV>
              <KV k="Storage">{stor.data?.providers.find((p) => p.id === 'filesystem')?.totals ? (
                <span>{bytes(stor.data.providers.find((p) => p.id === 'filesystem')!.totals!.used)} / {bytes(stor.data.providers.find((p) => p.id === 'filesystem')!.totals!.total)}</span>
              ) : NA}</KV>
              <KV k="GPU">{res.data?.gpu.availability === 'available' ? v(res.data.gpu.current?.vendor) : <span className="stale-note">Not available</span>}</KV>
            </dl>
          </section>

          <section className="sys-band">
            <div className="sys-band-head"><h2>This install</h2></div>
            <dl className="kv">
              <KV k="Version">{host.data ? <span className="mono-meta">OpusHub {host.data.opushub.version}</span> : NA}</KV>
              <KV k="Git SHA">{host.data?.opushub.gitSha ? <span className="mono-meta">{host.data.opushub.gitSha}</span> : NA}</KV>
              <KV k="Built">{host.data?.opushub.buildTime || NA}</KV>
              <KV k="Image">{host.data?.opushub.imageTag ? <span className="mono-meta">{host.data.opushub.imageTag}</span> : NA}</KV>
              <KV k="Mode">{host.data ? v(host.data.opushub.installationMode === 'docker' ? 'Docker image' : 'Source checkout') : NA}</KV>
            </dl>
          </section>
        </div>
      )}

      {active === 'storage' && (
        <StoragePanel
          storage={storage.data || grid.data?.domains.storage || null}
          pool={pool}
          dataset={dataset}
          onSelectPool={selectPool}
          onSelectDataset={selectDataset}
        />
      )}

      {active === 'network' && (
        <NetworkPanel network={network.data || null} external={external.data || null} />
      )}

      {active === 'power' && <PowerPanel power={power.data || null} />}

      {active === 'networks' && (
        <section className="sys-band">
          <div className="sys-band-head"><h2>Docker networks</h2><span className="hint">{nets.data?.count ?? '—'} on this engine</span></div>
          {!nets.data?.live && nets.data?.statusReason && <ProviderNote status="unavailable" reason={nets.data.statusReason} compact />}
          {(nets.data?.networks || []).map((n) => (
            <div className="disk-row" key={String(n.name)}>
              <div>
                <div className="disk-mount">{n.name}</div>
                <div className="disk-fs">{n.driver}{n.scope ? ` · ${n.scope}` : ''}{n.internal ? ' · internal' : ''}{n.attachable ? ' · attachable' : ''}</div>
                {!!n.containers.length && (
                  <div className="stale-note" style={{ marginTop: 4 }}>{n.containers.slice(0, 8).map((c) => c.name).join(' · ')}{n.containers.length > 8 && ` · +${n.containers.length - 8} more`}</div>
                )}
              </div>
              <div className="disk-nums">{n.containerCount} attached</div>
            </div>
          ))}
          {nets.data?.live && !nets.data.networks.length && <ProviderNote status="unconfigured" reason="The engine reports no networks." compact />}
        </section>
      )}

      {active === 'volumes' && (
        <section className="sys-band">
          <div className="sys-band-head">
            <h2>Volumes</h2>
            <span className="hint">{vols.data?.count ?? '—'} volumes{volumeBytes.of > 0 && volumeBytes.known > 0 && ` · ${bytes(volumeBytes.total)} reported`}</span>
          </div>
          {!vols.data?.live && vols.data?.statusReason && <ProviderNote status="unavailable" reason={vols.data.statusReason} compact />}
          {(vols.data?.volumes || []).map((x) => (
            <div className="disk-row" key={String(x.name)}>
              <div>
                <div className="disk-mount">{x.name}</div>
                <div className="disk-fs">{x.driver}{x.scope ? ` · ${x.scope}` : ''}{x.refCount != null && ` · ${x.refCount} container${x.refCount === 1 ? '' : 's'}`}</div>
              </div>
              <div className="disk-nums">{x.size != null ? bytes(x.size) : <span className="stale-note">size unknown</span>}</div>
            </div>
          ))}
          {vols.data?.live && !vols.data.volumes.length && <ProviderNote status="unconfigured" reason="The engine reports no volumes." compact />}
          <p className="stale-note" style={{ marginTop: 'var(--sp-4)' }}>Host paths are deliberately never shown here — names and usage only.</p>
        </section>
      )}

      {active === 'images' && (
        <section className="sys-band">
          <div className="sys-band-head">
            <h2>Images</h2>
            <span className="hint">{imgs.data?.count ?? '—'} images{imageBytes > 0 && ` · ${bytes(imageBytes)} recoverable space, at most`}</span>
          </div>
          {!imgs.data?.live && imgs.data?.statusReason && <ProviderNote status="unavailable" reason={imgs.data.statusReason} compact />}
          {(imgs.data?.images || []).map((img, i) => (
            <div className="disk-row" key={img.id || i}>
              <div style={{ minWidth: 0 }}>
                <div className="disk-mount" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{img.tags[0] || 'untagged'}</div>
                <div className="disk-fs">
                  {img.id && <span className="mono-meta">{img.id}</span>}
                  {img.tags.length > 1 && <span> · +{img.tags.length - 1} tags</span>}
                  {(img.usedBy || []).length > 0 && <span> · used by {(img.usedBy || []).slice(0, 4).join(', ')}{(img.usedBy || []).length > 4 && ` +${(img.usedBy || []).length - 4}`}</span>}
                </div>
              </div>
              <div className="disk-nums">{img.size != null ? bytes(img.size) : <span className="stale-note">size unknown</span>}</div>
            </div>
          ))}
          {imgs.data?.live && !imgs.data.images.length && <ProviderNote status="unconfigured" reason="The engine reports no images." compact />}
        </section>
      )}

      {active === 'topology' && (
        <>
          {!nets.data?.live && nets.data?.statusReason && <ProviderNote status="unavailable" reason={nets.data.statusReason} compact />}
          {topology.data
            ? <OpusGridTopology doc={topology.data} />
            : !loading && <ProviderNote status="unavailable" reason="Topology needs at least one provider to answer." compact />}
          {topology.data && !topology.data.physical.available && (
            <ProviderNote
              status="unconfigured"
              reason="No physical topology is configured. The Physical layer stays empty until you describe it in config/topology.yaml — OpusHub will not guess what your rack looks like."
              compact
            />
          )}
        </>
      )}
    </>
  );
}
