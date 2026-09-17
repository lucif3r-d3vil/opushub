// Infrastructure → Power.
//
// Phase 9 builds the abstraction and nothing behind it: no UPS or PDU client exists, so both
// answers are "Not configured". That is the honest state — OpusHub cannot detect power hardware
// from inside a container, and claiming otherwise would be fabrication.
//
// The panel still earns its place: it names what a future client will fill in, and it states
// plainly what OpusHub will never do through it (no shutdown, no battery test, no outlet
// switching). Power control is an infrastructure operation and belongs to a future phase.
import type { PowerDeviceDoc, PowerDomainDoc } from '../../lib/types';
import { ProviderNote } from '../ui';

const FIELD_LABELS: Record<string, string> = {
  status: 'Status',
  batteryChargePct: 'Battery charge',
  runtimeSec: 'Runtime remaining',
  loadPct: 'Load',
  inputVoltage: 'Input voltage',
  outputVoltage: 'Output voltage',
  temperatureC: 'Temperature',
  lastUpdate: 'Last update',
  outletCount: 'Outlets',
  outletStatus: 'Outlet status',
  powerWatts: 'Power draw',
};

function Device({
  title,
  device,
  blurb,
}: {
  title: string;
  device: PowerDeviceDoc | null;
  blurb: string;
}) {
  const status = device?.status || 'unknown';
  const notConfigured = status === 'not-configured';
  return (
    <section className="sys-band">
      <div className="sys-band-head">
        <h2>{title}</h2>
        <span className="hint">{notConfigured ? 'Not configured' : status === 'unavailable' ? 'Not available' : status}</span>
      </div>
      <ProviderNote
        status={notConfigured ? 'unconfigured' : 'unavailable'}
        reason={device?.reason || 'Power hardware is not connected.'}
        compact
      />
      <p className="stale-note" style={{ marginTop: 'var(--sp-4)' }}>{blurb}</p>
      {!!device?.planned?.length && (
        <dl className="kv" style={{ marginTop: 'var(--sp-5)' }}>
          {device.planned.map((f) => (
            <div key={f} style={{ display: 'contents' }}>
              <dt>{FIELD_LABELS[f] || f}</dt>
              <dd><span className="stale-note">Not available</span></dd>
            </div>
          ))}
        </dl>
      )}
      {!!device?.refused?.length && (
        <p className="stale-note" style={{ marginTop: 'var(--sp-5)' }}>
          Not implemented, and not planned for this phase: {device.refused.join(', ')}.
        </p>
      )}
    </section>
  );
}

export function PowerPanel({ power }: { power: PowerDomainDoc | null }) {
  if (!power) return <p className="stale-note" role="status">Reading the power domain…</p>;
  return (
    <>
      <Device
        title="UPS"
        device={power.ups}
        blurb="Uninterruptible power supply status. When a client exists, this is read-only: charge, runtime, load, voltages and temperature. OpusHub will not issue shutdown commands or battery tests."
      />
      <Device
        title="PDU"
        device={power.pdu}
        blurb="Power distribution unit status. When a client exists, this is read-only: outlet status and power draw. Switching outlets is out of scope for OpusHub."
      />
      <p className="stale-note">{power.note}</p>
    </>
  );
}
