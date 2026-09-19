import { useMemo, useState } from 'react';
import { usePolled } from '../lib/api';
import { bytes, num, pct, relTime, uptime } from '../lib/format';
import { useSettings } from '../lib/theme';
import type { HistoryPoint, ProvidersDoc, SystemSnapshot } from '../lib/types';
import { AreaChart, MeterBar } from '../components/Charts';
import { Freshness, PageHero, ProviderNote } from '../components/ui';
import { StatusLine } from '../components/ui';
import { AutohealStatusArea } from '../components/AutohealStatus';

const WINDOWS = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 3600_000 },
  { label: '6h', ms: 6 * 3600_000 },
  { label: '24h', ms: 24 * 3600_000 },
];

export default function SystemPage() {
  const { settings } = useSettings();
  const sys = usePolled<SystemSnapshot>('/api/system', (settings?.behavior?.refresh?.system ?? 5) * 1000);
  const providers = usePolled<ProvidersDoc>('/api/providers', 30_000);
  const [win, setWin] = useState(1);
  const hist = usePolled<{ points: HistoryPoint[] }>(`/api/system/history?window=${WINDOWS[win].ms}`, 10_000);
  const d = sys.data;

  const series = useMemo(() => {
    const pts = hist.data?.points ?? [];
    const mk = (key: 'cpu' | 'memUsedPct' | 'load' | 'rx' | 'tx' | 'temp') => pts.map((p) => ({ t: p.t, v: p[key] ?? null }));
    return { cpu: mk('cpu'), mem: mk('memUsedPct'), load: mk('load'), raw: pts };
  }, [hist.data]);

  if (sys.error && !d) return <ProviderNote status="error" reason={`System provider failed: ${sys.error}`} />;

  const s = d;
  const mem = s?.memory;
  const memUsed = mem ? mem.total - mem.available : null;
  const realDiskCount = s?.disks.length || 0;

  return (
    <>
      <PageHero
        title="System"
        desc={s ? `${s.host.hostname} — live readings from this host. Nothing estimated, nothing invented.` : 'Reading the host…'}
        meta={
          <>
            {s && <span>{s.host.os}</span>}
            {s && <span className="sep">·</span>}
            {s && <span>kernel {s.host.kernel}</span>}
            {s && <span className="sep">·</span>}
            {s && <span>up {uptime(s.host.uptimeSec)}</span>}
            <Freshness at={sys.fetchedAt} error={sys.error} />
          </>
        }
        actions={
          <div className="win-picks" role="group" aria-label="Chart window">
            {WINDOWS.map((w, i) => (
              <button key={w.label} aria-pressed={i === win} onClick={() => setWin(i)}>{w.label}</button>
            ))}
          </div>
        }
      />

      {providers.data && (
        <section className="sys-band sys-band--providers" aria-label="Provider health">
          <div className="prov-list">
            <span className="micro-label" style={{ marginBottom: 2 }}>Providers behind this page</span>
            {providers.data.providers.map((p) => (
              <div className="prov-row" key={p.name}>
                <StatusLine
                  state={p.state === 'available' ? 'up' : p.state === 'degraded' ? 'unstable' : p.state === 'unavailable' ? 'down' : 'unknown'}
                  note={p.state === 'available' ? undefined : p.state === 'idle' ? 'not used yet' : p.state}
                />
                <span className="prov-name">{p.name === 'markets' ? 'market data' : p.name}</span>
                <span className="stale-note">
                  {p.state === 'available' && p.staleMs != null
                    ? `read ${p.staleMs < 90_000 ? `${Math.round(p.staleMs / 1000)}s ago` : relTime(Date.now() - p.staleMs)}`
                    : p.reason || 'not called yet — nothing on this page needs it'}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* CPU */}
      <section className="sys-band">
        <div className="sys-band-head"><h2>Processor</h2>{s?.cpu.model && <span className="hint">{s.cpu.model}</span>}</div>
        <div className="sys-cols">
          <div>
            <div className="sys-stat-hero">
              <div className="v">{s?.cpu.usage == null ? <span title="sampling">—</span> : <>{s.cpu.usage.toFixed(s.cpu.usage >= 10 || s.cpu.usage % 1 === 0 ? 0 : 1)}<small>%</small></>}</div>
            </div>
            <div className="sys-kv">
              <KV k="Cores" v={s ? `${s.cpu.cores} logical${s.host.model ? ` · ${s.host.model}` : ''}` : '—'} />
              <KV k="Load 1 / 5 / 15" v={s?.cpu.load1 != null ? `${num(s.cpu.load1, 2)} · ${num(s.cpu.load5, 2)} · ${num(s.cpu.load15, 2)}` : 'sampling…'} />
              <KV k="Frequency" v={s?.cpu.mhz ? `${num(s.cpu.mhz)} MHz` : 'Unavailable'} />
              <KV
                k="Temperature"
                v={s?.cpu.temperature ? s.cpu.temperature.map((t) => `${t.celsius.toFixed(0)}°C ${t.label.toLowerCase()}`).join(' · ') : 'Unavailable — no thermal sensors exposed'}
              />
            </div>
          </div>
          <div>
            <div className="chart-cap"><span className="t">Utilisation — {WINDOWS[win].label}</span></div>
            <AreaChart
              windowMs={WINDOWS[win].ms}
              height={150}
              maxHint={100}
              fmt={(v) => `${v.toFixed(0)}%`}
              series={[{ points: series.cpu, label: 'CPU', color: 'var(--accent)' }]}
            />
            {series.load.some((p) => p.v != null) && (
              <div style={{ marginTop: 'var(--sp-6)' }}>
                <div className="chart-cap">
                  <span className="t">Load average (1 min) — {WINDOWS[win].label}</span>
                  <span className="v">{s?.cpu.load1 != null ? `${num(s.cpu.load1, 2)} of ${s.cpu.cores} core${s.cpu.cores === 1 ? '' : 's'}` : ''}</span>
                </div>
                <AreaChart
                  windowMs={WINDOWS[win].ms}
                  height={92}
                  maxHint={s?.cpu.cores}
                  fmt={(v) => num(v, 2)}
                  series={[{ points: series.load, label: 'Load', color: 'var(--warn)', fill: false }]}
                />
                <p className="stale-note">
                  Run-queue length from the host’s own load average. {s?.cpu.load1 != null && s.cpu.cores
                    ? (s.cpu.load1 > s.cpu.cores * 1.5
                      ? 'Above the core count: work is queuing.'
                      : 'At or below the core count: nothing is waiting.')
                    : ''}
                </p>
              </div>
            )}
            {!!s?.cpu.perCore?.length && (
              <div className="coregrid" style={{ marginTop: 'var(--sp-5)' }}>
                {s.cpu.perCore.map((c) => (
                  <div className="corecell" key={c.id}>
                    <div className="cv">{c.usage == null ? '—' : `${c.usage.toFixed(0)}%`}</div>
                    <div className="cl">core {c.id}</div>
                    <MeterBar value={c.usage} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Memory */}
      <section className="sys-band">
        <div className="sys-band-head"><h2>Memory</h2>{mem && <span className="hint">{bytes(mem.total)}</span>}</div>
        {mem ? (
          <div>
            <div style={{ maxWidth: 900 }}>
              <MemStack total={mem.total} used={Math.max(0, mem.total - mem.free - mem.cached - mem.buffers)} cached={mem.cached + mem.buffers} free={mem.free} />
              <div className="mem-legend">
                <span><i className="sw" style={{ background: 'var(--accent)' }} />used {bytes(Math.max(0, mem.total - mem.free - mem.cached - mem.buffers))}</span>
                <span><i className="sw" style={{ background: 'color-mix(in srgb, var(--ink) 30%, transparent)' }} />cached {bytes(mem.cached + mem.buffers)}</span>
                <span><i className="sw" style={{ background: 'color-mix(in srgb, var(--ink) 10%, transparent)' }} />free {bytes(mem.free)}</span>
                <span>available {bytes(mem.available)} of {bytes(mem.total)}</span>
                {mem.swapTotal > 0 && <span>swap {bytes(mem.swapTotal - mem.swapFree)} / {bytes(mem.swapTotal)}</span>}
                {mem.swapTotal === 0 && <span className="stale-note">no swap configured</span>}
              </div>
            </div>
            <div style={{ marginTop: 'var(--sp-8)', maxWidth: 900 }}>
              <div className="chart-cap"><span className="t">Used — {WINDOWS[win].label}</span><span className="v">{pct(mem.total ? 100 * (memUsed! / mem.total) : null, 1)}</span></div>
              <AreaChart windowMs={WINDOWS[win].ms} height={110} maxHint={100} fmt={(v) => `${v.toFixed(0)}%`} series={[{ points: series.mem, label: 'Used', color: 'var(--accent)' }]} />
            </div>
          </div>
        ) : (
          <ProviderNote status="unavailable" reason="This host does not expose /proc/meminfo." />
        )}
      </section>

      {/* Storage */}
      <section className="sys-band">
        <div className="sys-band-head">
          <h2>Storage</h2>
          <span className="hint">
            {realDiskCount ? `${realDiskCount} mounted volume${realDiskCount === 1 ? '' : 's'}` : ''}
            {realDiskCount ? ' · live readings only — no reliable history source for mounts' : ''}
          </span>
        </div>
        {s?.disks.length ? (
          <div style={{ maxWidth: 900 }}>
            {s.disks.map((dk) => (
              <div className="disk-row" key={dk.mount}>
                <div>
                  <div className="disk-mount">{dk.mount}</div>
                  <div className="disk-fs">{dk.fs} · {dk.device}</div>
                </div>
                <MeterBar value={100 * (dk.used / dk.total)} />
                <div className="disk-nums">{bytes(dk.used)} / {bytes(dk.total)} <span style={{ opacity: 0.6 }}>· {bytes(dk.free)} free</span></div>
              </div>
            ))}
          </div>
        ) : (
          <ProviderNote status="unavailable" reason="No mounted filesystems found." />
        )}
      </section>

      {/* Network */}
      <section className="sys-band">
        <div className="sys-band-head"><h2>Network</h2></div>
        {s?.network.length ? (
          <>
            <div style={{ maxWidth: 900 }}>
              {s.network.map((n) => (
                <div className="net-row" key={n.name}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{n.name}</div>
                    <div className="stale-note mono-meta">{n.ips.join(', ') || 'no IPv4'}</div>
                  </div>
                  <div>
                    <MeterBar value={n.rxPerSec != null && n.mbps ? Math.min(100, (n.rxPerSec * 8) / (n.mbps * 1e6) * 100) : null} />
                    <div style={{ display: 'flex', gap: 14, marginTop: 5 }}>
                      <span className="net-rate"><span className="rx">↓ {n.rxPerSec != null ? bytes(n.rxPerSec, true) : '—'}</span></span>
                      <span className="net-rate"><span className="tx">↑ {n.txPerSec != null ? bytes(n.txPerSec, true) : '—'}</span></span>
                    </div>
                  </div>
                  <div className="disk-nums" style={{ textAlign: 'right' }}>
                    {bytes(n.rxBytes)} rx · {bytes(n.txBytes)} tx
                    {(n.rxErrors > 0 || n.txErrors > 0) && <span style={{ color: 'var(--warn)' }}> · {n.rxErrors + n.txErrors} err</span>}
                    {n.mbps ? <div className="stale-note">{n.mbps} Mbps link</div> : null}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 'var(--sp-8)', maxWidth: 900 }}>
              <div className="chart-cap">
                <span className="t">Throughput — {WINDOWS[win].label}</span>
                <span className="v">
                  {series.raw.length ? `↓ ${bytes(series.raw[series.raw.length - 1]?.rx || 0, true)} ↑ ${bytes(series.raw[series.raw.length - 1]?.tx || 0, true)}` : ''}
                </span>
              </div>
              <AreaChart
                windowMs={WINDOWS[win].ms}
                height={120}
                fmt={(v) => bytes(v, true)}
                series={[
                  { points: series.raw.map((p) => ({ t: p.t, v: p.rx })), label: 'Down', color: 'var(--ok)' },
                  { points: series.raw.map((p) => ({ t: p.t, v: p.tx })), label: 'Up', color: 'var(--warn)' },
                ]}
              />
            </div>
          </>
        ) : (
          <ProviderNote status="unavailable" reason="No network interfaces beyond loopback." />
        )}
      </section>

      {/* Host + GPU */}
      <section className="sys-band">
        <div className="sys-band-head"><h2>Host</h2></div>
        <div className="detail-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <dl className="kv">
            <KV k="Hostname" v={<span className="mono-meta">{s?.host.hostname || '—'}</span>} />
            <KV k="Operating system" v={s?.host.os || '—'} />
            <KV k="Kernel" v={<span className="mono-meta">{s?.host.kernel || '—'}</span>} />
            <KV k="Architecture" v={s?.host.arch || '—'} />
            <KV k="Booted" v={s?.host.bootAt ? new Date(s.host.bootAt).toLocaleString() : 'Unavailable'} />
            <KV k="Processes" v={s?.processes != null ? num(s.processes) : 'Unavailable'} />
            <KV k="Runtime" v={<span className="mono-meta">node {s?.host.node}</span>} />
          </dl>
          <dl className="kv">
            <KV k="GPU" v={s?.gpu?.present ? `${s.gpu.vendor}${s.gpu.driver ? ` · ${s.gpu.driver}` : ''}` : 'Unavailable — no discrete GPU exposed'} />
            <KV k="Sensors" v={s?.cpu.temperature?.length ? s.cpu.temperature.length + ' thermal zone(s)' : 'Unavailable'} />
            <KV k="Data source" v={<span className="mono-meta">/proc, /sys — direct reads</span>} />
            <KV k="Sampling" v={`history keeps ${WINDOWS[win].label} at 5s interval`} />
            <KV k="Updated" v={sys.fetchedAt ? relTime(sys.fetchedAt) : '—'} />
          </dl>
        </div>
      </section>

      {/* Autoheal Recovery Area */}
      <section className="sys-band">
        <AutohealStatusArea />
      </section>

      {sys.error && <p className="stale-note" style={{ color: 'var(--warn)' }}>last refresh failed: {sys.error} — showing data from {relTime(sys.fetchedAt || Date.now())}.</p>}
    </>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (<><dt>{k}</dt><dd>{v}</dd></>);
}

function MemStack({ total, used, cached, free }: { total: number; used: number; cached: number; free: number }) {
  const p = (n: number) => `${(100 * n) / total}%`;
  return (
    <div className="memstack" role="img" aria-label="Memory usage composition">
      <i style={{ width: p(used), background: 'var(--accent)' }} />
      <i style={{ width: p(cached), background: 'color-mix(in srgb, var(--ink) 30%, transparent)' }} />
      <i style={{ width: p(free), background: 'color-mix(in srgb, var(--ink) 10%, transparent)' }} />
    </div>
  );
}
