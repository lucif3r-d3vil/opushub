// Infrastructure → Storage.
//
// Three different things, kept apart on purpose:
//   Filesystems   mounts the kernel reports — device, type, size, usage
//   ZFS pools     what `zpool list` reported — capacity, health, and topology when ZFS says
//   Datasets      what `zfs list` reported — used, available, referenced, quota
//
// Values the provider could not determine read "Not available", never "0". A pool's capacity bar
// is proportional (a bar, not a chart) and turns amber / red at the same thresholds the alert
// engine uses, so the page and the alert never disagree.
import { usePolled } from '../../lib/api';
import { bytes, pct, relTime } from '../../lib/format';
import type { DatasetDetailDoc, PoolDetailDoc, StorageDomainDoc } from '../../lib/types';
import { Loading, ProviderNote } from '../ui';

const NA = <span className="stale-note">Not available</span>;
const v = (x: unknown) => (x == null || x === '' ? NA : String(x));
const n = (x: number | null | undefined, digits = 1) => (x == null ? NA : bytes(x, digits > 0));

/** The same thresholds the alert engine uses (server/infrastructure/model.js). */
function barClass(p: number | null | undefined) {
  if (p == null) return 'cap-bar';
  if (p >= 95) return 'cap-bar fail';
  if (p >= 90) return 'cap-bar warn';
  return 'cap-bar';
}

function UsageBar({ usedPct, label }: { usedPct: number | null | undefined; label?: string }) {
  if (usedPct == null) return <div className="stale-note" style={{ marginTop: 8 }}>Usage not reported.</div>;
  const clamped = Math.max(0, Math.min(100, usedPct));
  return (
    <>
      <div className={barClass(usedPct)} role="img" aria-label={`${label || 'Usage'}: ${Math.round(usedPct)} percent used`}>
        <i style={{ width: `${clamped}%` }} />
      </div>
      <div className="cap-legend">
        <span>{pct(usedPct)} used</span>
        {label && <span>{label}</span>}
      </div>
    </>
  );
}

function KV({ k, children }: { k: string; children: React.ReactNode }) {
  return (<><dt>{k}</dt><dd>{children}</dd></>);
}

/* ------------------------------------------------------------------ */
/* pool detail                                                         */
/* ------------------------------------------------------------------ */

function VdevList({ vdevs, depth = 0 }: { vdevs: PoolDetailDoc['topology']['vdevs']; depth?: number }) {
  return (
    <div className="vdev">
      {vdevs.map((v) => (
        <div key={`${v.name}-${depth}`}>
          <div className="vdev-row">
            <span className="nm">{v.name}</span>
            {v.pathHidden && <span className="vdev-redacted">device path hidden</span>}
            {v.size != null && <span className="meta">{bytes(v.size)}</span>}
            {v.capacityPct != null && <span className="meta">{pct(v.capacityPct)} used</span>}
            {v.health && <span className="meta">{v.health}</span>}
          </div>
          {!!v.children.length && <VdevList vdevs={v.children} depth={depth + 1} />}
        </div>
      ))}
    </div>
  );
}

export function PoolDetail({ name, onClose }: { name: string; onClose: () => void }) {
  // Lazy: the detail (one `zpool list -v`) is fetched only while a pool is open, and the name was
  // chosen from the pool list the provider itself reported.
  const { data, loading, error } = usePolled<PoolDetailDoc>(`/api/infrastructure/storage/pool?name=${encodeURIComponent(name)}`, 60_000);
  return (
    <section className="sys-band">
      <div className="sys-band-head">
        <h2>Pool {name}</h2>
        <button className="btn btn-quiet btn-sm" onClick={onClose}>Back to pools</button>
      </div>
      {loading && !data && <Loading what={`pool ${name}`} />}
      {error && <ProviderNote status="unavailable" reason={error} compact />}
      {data && (
        <>
          <dl className="kv">
            <KV k="State">{v(data.health)}</KV>
            <KV k="Size">{n(data.size)}</KV>
            <KV k="Used">{n(data.allocated)}</KV>
            <KV k="Free">{n(data.free)}</KV>
            <KV k="Capacity">{data.capacityPct != null ? pct(data.capacityPct) : NA}</KV>
            <KV k="Fragmentation">{data.fragmentationPct != null ? pct(data.fragmentationPct) : NA}</KV>
            <KV k="Datasets">{data.datasets?.length ?? NA}</KV>
          </dl>
          <div style={{ marginTop: 'var(--sp-5)' }}>
            <UsageBar usedPct={data.capacityPct} label={`${bytes(data.allocated)} of ${bytes(data.size)}`} />
          </div>
          <div className="sys-band" style={{ paddingBottom: 0 }}>
            <div className="sys-band-head"><h2>Topology</h2></div>
            {data.topology?.available ? (
              <>
                <VdevList vdevs={data.topology.vdevs} />
                <p className="stale-note" style={{ marginTop: 'var(--sp-4)' }}>
                  Vdev layout as ZFS reported it. Device paths are never published.
                </p>
              </>
            ) : (
              <ProviderNote status="unconfigured" reason={data.topology?.reason || 'Not available'} compact />
            )}
          </div>
          {!!data.datasets?.length && (
            <div className="sys-band" style={{ paddingBottom: 0 }}>
              <div className="sys-band-head"><h2>Datasets in this pool</h2></div>
              {data.datasets.slice(0, 40).map((d) => (
                <div className="ds-row" key={d.name}>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="title" style={{ fontWeight: 560 }}>{d.name}</span>
                    <div className="stale-note">{d.mountpoint ? d.mountpoint : 'not mounted here'}</div>
                  </span>
                  <span className="mono-meta ds-avail">{n(d.available)} free</span>
                  <span className="mono-meta">{n(d.used)} used</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* dataset detail                                                      */
/* ------------------------------------------------------------------ */

export function DatasetDetail({ name, onClose }: { name: string; onClose: () => void }) {
  const { data, loading, error } = usePolled<DatasetDetailDoc>(`/api/infrastructure/storage/dataset?name=${encodeURIComponent(name)}`, 60_000);
  return (
    <section className="sys-band">
      <div className="sys-band-head">
        <h2>Dataset {name}</h2>
        <button className="btn btn-quiet btn-sm" onClick={onClose}>Back to datasets</button>
      </div>
      {loading && !data && <Loading what={`dataset ${name}`} />}
      {error && <ProviderNote status="unavailable" reason={error} compact />}
      {data && (
        <>
          <dl className="kv">
            <KV k="Pool">{v(data.pool)}</KV>
            <KV k="Used">{n(data.used)}</KV>
            <KV k="Available">{n(data.available)}</KV>
            <KV k="Referenced">{n(data.referenced)}</KV>
            <KV k="Compression">{v(data.compression)}</KV>
            <KV k="Recordsize">{data.recordsize != null ? bytes(data.recordsize) : NA}</KV>
            <KV k="Quota">{data.quota != null ? bytes(data.quota) : <span className="stale-note">None set</span>}</KV>
            <KV k="Mount">{v(data.mountpoint)}</KV>
          </dl>
          {data.quotaUsedPct != null && (
            <div style={{ marginTop: 'var(--sp-5)' }}>
              <UsageBar usedPct={data.quotaUsedPct} label={`${bytes(data.used)} of a ${bytes(data.quota)} quota`} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* the panel                                                          */
/* ------------------------------------------------------------------ */

export function StoragePanel({
  storage,
  pool,
  dataset,
  onSelectPool,
  onSelectDataset,
}: {
  storage: StorageDomainDoc | null;
  pool: string | null;
  dataset: string | null;
  onSelectPool: (name: string | null) => void;
  onSelectDataset: (name: string | null) => void;
}) {
  if (pool) return <PoolDetail name={pool} onClose={() => onSelectPool(null)} />;
  if (dataset) return <DatasetDetail name={dataset} onClose={() => onSelectDataset(null)} />;
  if (!storage) return <Loading what="storage" note="Reading filesystems and ZFS." />;

  const fs = storage.filesystems;
  const zfs = storage.zfs;
  const totals = fs.totals;

  return (
    <>
      <section className="sys-band">
        <div className="sys-band-head">
          <h2>Storage</h2>
          <span className="hint">
            {[fs.mountCount ? `${fs.mountCount} filesystem${fs.mountCount === 1 ? '' : 's'}` : null,
              zfs.available ? `${zfs.poolCount} ZFS pool${zfs.poolCount === 1 ? '' : 's'}` : null,
              zfs.available ? `${zfs.datasetCount} dataset${zfs.datasetCount === 1 ? '' : 's'}` : null]
              .filter(Boolean).join(' · ') || 'no storage providers answered'}
          </span>
        </div>
        {totals ? (
          <>
            <div className="storage-total">
              <span className="num">{bytes(totals.used)}</span>
              <span className="of">used of {bytes(totals.total)}</span>
              <span className="of">{bytes(totals.free)} free</span>
            </div>
            <UsageBar usedPct={totals.total ? (100 * totals.used) / totals.total : null} label={`across ${totals.mounts} mount${totals.mounts === 1 ? '' : 's'}`} />
          </>
        ) : (
          <ProviderNote status="unavailable" reason={fs.reason || 'No filesystem information is available.'} compact />
        )}
      </section>

      <section className="sys-band">
        <div className="sys-band-head">
          <h2>Filesystems</h2>
          <span className="hint">mounts the kernel reports, from /proc/mounts</span>
        </div>
        {!fs.available && <ProviderNote status="unavailable" reason={fs.reason || 'Mount information is not available.'} compact />}
        {fs.mounts.map((m) => (
          <div className="disk-row" key={m.mount}>
            <div style={{ minWidth: 0 }}>
              <div className="disk-mount">{m.mount}</div>
              <div className="disk-fs">{m.fs}{m.device ? ` · ${m.device}` : ''}</div>
              <div style={{ marginTop: 6 }}>
                <UsageBar usedPct={m.usedPct} label={`${bytes(m.free)} free`} />
              </div>
            </div>
            <div className="disk-nums">{bytes(m.total)}</div>
          </div>
        ))}
        {fs.truncated && <p className="stale-note">Showing the first {fs.mounts.length} of {fs.mountCount} mounts.</p>}
        {fs.available && !fs.mounts.length && <ProviderNote status="unconfigured" reason="No mounted filesystems were reported." compact />}
      </section>

      <section className="sys-band">
        <div className="sys-band-head">
          <h2>ZFS pools</h2>
          <span className="hint">{zfs.available ? 'read-only, from the zpool command' : 'ZFS is not answering here'}</span>
        </div>
        {!zfs.available && (
          <ProviderNote
            status="unavailable"
            reason={zfs.reason || 'ZFS is not available.'}
            compact
            details="OpusHub reads ZFS through zpool and zfs only. If it runs in a container those tools are not reachable unless you make them available to it."
          />
        )}
        {zfs.available && zfs.empty && (
          <ProviderNote status="unconfigured" reason="ZFS is available, but no pools are imported." compact />
        )}
        {zfs.available && !!zfs.pools.length && (
          <div className="pool-grid">
            {zfs.pools.map((p) => (
              <button key={p.name} className="pool-card" type="button" onClick={() => onSelectPool(p.name)}>
                <div className="pool-name">{p.name}</div>
                <div className="pool-health">
                  <span className={`status-dot ${p.health && p.health !== 'ONLINE' ? (['FAULTED', 'UNAVAIL', 'REMOVED', 'OFFLINE', 'SUSPENDED'].includes(p.health) ? 'down' : 'unhealthy') : 'up'}`} />
                  {p.health || 'health not reported'}
                </div>
                <UsageBar usedPct={p.capacityPct ?? p.usedPct} label={`${bytes(p.allocated)} of ${bytes(p.size)}`} />
                <div className="cap-legend">
                  <span>{bytes(p.free)} free</span>
                  {p.fragmentationPct != null && <span>{pct(p.fragmentationPct)} fragmented</span>}
                  <span>updated {relTime(storage.at)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="sys-band">
        <div className="sys-band-head">
          <h2>Datasets</h2>
          <span className="hint">{zfs.available ? 'click one for its properties' : 'ZFS is not answering here'}</span>
        </div>
        {zfs.available && !zfs.datasets.length && (
          <ProviderNote status="unconfigured" reason="No datasets were reported." compact />
        )}
        {!!zfs.datasets.length && (
          <>
            {zfs.datasets.map((d) => (
              <button key={d.name} className="ds-row" type="button" onClick={() => onSelectDataset(d.name)}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="title" style={{ fontWeight: 560 }}>{d.name}</span>
                  <div className="stale-note">
                    {[d.mountpoint ? `mounted at ${d.mountpoint}` : 'not mounted here',
                      d.compression ? `compression ${d.compression}` : null,
                      d.quota != null ? `quota ${bytes(d.quota)}` : null].filter(Boolean).join(' · ')}
                  </div>
                </span>
                <span className="mono-meta ds-avail">{d.available != null ? bytes(d.available) : NA}</span>
                <span className="mono-meta">{d.used != null ? bytes(d.used) : NA}</span>
              </button>
            ))}
            {zfs.truncated && <p className="stale-note">Showing the first {zfs.datasets.length} of {zfs.datasetCount} datasets.</p>}
          </>
        )}
      </section>
    </>
  );
}
