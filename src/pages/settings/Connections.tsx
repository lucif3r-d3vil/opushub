// Settings → Connections — whether OpusHub can use the Docker engine.
//
// This pane is informational. It shows the result of a real check: the engine answers, and
// OpusHub is allowed to list its containers. A socket that merely exists is not "connected" — a
// group permission or a socket proxy can allow one and refuse the other, and the difference is
// exactly what an operator needs to see here.
//
// The check runs when something asks for it (this pane polls it once a minute while open).
import { relTime } from '../../lib/format';
import { DockerOffNote, useDockerStatus } from '../../lib/dockerStatus';
import { StatusDot } from '../../components/ui';

export default function ConnectionsTab() {
  const status = useDockerStatus(60_000);
  const d = status.data;

  return (
    <section className="sys-band" style={{ paddingTop: 0, borderTop: 0 }}>
      <div className="sys-band-head">
        <h2>Docker</h2>
        <span className="hint">
          {d ? (d.ok ? 'connected' : 'not connected') : status.error ? 'refresh failed' : 'checking…'}
          {status.fetchedAt ? ` · checked ${relTime(status.fetchedAt)}` : ''}
        </span>
      </div>
      <p className="stale-note" style={{ marginBottom: 'var(--sp-5)' }}>
        Connected means the engine answered and OpusHub was able to list its containers — not just
        that a socket file exists.
      </p>

      {d?.ok ? (
        <dl className="kv">
          <dt>Status</dt>
          <dd><StatusDot state="up" /> Connected</dd>
          <dt>Engine</dt>
          <dd>{d.version ? <span className="mono-meta">{d.version}</span> : <span className="stale-note">Not available</span>}</dd>
          <dt>API</dt>
          <dd>{d.api ? <span className="mono-meta">{d.api}</span> : <span className="stale-note">Not available</span>}</dd>
          <dt>Containers</dt>
          <dd>{d.containers != null ? `${d.containers} listed` : <span className="stale-note">Not available</span>}</dd>
        </dl>
      ) : d ? (
        <DockerOffNote reason={d.reason} fixHref="/settings/environment" />
      ) : null}
    </section>
  );
}
