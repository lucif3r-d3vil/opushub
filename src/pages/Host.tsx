// Host — the parent context for everything OpusHub watches.
//
// Every other page talks about *part* of the machine: services, stacks, the vitals. This one
// answers "what machine is this, and what can OpusHub see on it" — identity, compute and the
// engine.
//
// Everything here is read-only and everything comes from a provider. A field no provider could
// measure reads "Not available" — never a zero standing in for one.
import { Link } from 'react-router-dom';
import { usePolled } from '../lib/api';
import { bytes, pct, relTime, uptime } from '../lib/format';
import { useSettings } from '../lib/theme';
import type { HostDoc } from '../lib/types';
import { Loading, PageHero, ProviderNote } from '../components/ui';
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

  const h = host.data;
  const loading = !h && host.loading;

  return (
    <>
      <PageHero
        title={h?.host.hostname || 'Host'}
        desc="The machine OpusGrid runs on: what it is and what it has. Read-only — no page in OpusHub changes the host."
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

      {loading && <Loading what="the host" note="Reading identity and resources." />}
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

    </>
  );
}
