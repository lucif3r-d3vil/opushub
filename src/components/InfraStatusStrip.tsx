// The compact infrastructure status strip — one glance at the whole OpusGrid.
//
// The rule that matters most here: absence is not health. An optional provider that was never
// configured says "Not configured" in grey, never "Healthy" in green. Only a provider that
// answered, or a domain that is genuinely working, earns a positive word.
//
// It shows DOMAINS (Compute, Storage, Network, Power, External) rather than raw providers, so the
// strip stays the same length whether or not OPNsense exists.
import { Link } from 'react-router-dom';
import type { DomainStatus, InfrastructureHealthDoc, ProviderDoc } from '../lib/types';
import { StatusDot } from './ui';

const WORDS: Record<DomainStatus, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  'not-configured': 'Not configured',
  unknown: 'Unknown',
};

const DOT: Record<DomainStatus, string> = {
  healthy: 'up',
  degraded: 'unhealthy',
  unavailable: 'down',
  'not-configured': 'absent',
  unknown: 'absent',
};

const ORDER = ['compute', 'storage', 'network', 'power', 'external'] as const;

/** Where the strip sends you when you click a domain. */
const HREFS: Record<string, string> = {
  compute: '/infrastructure?tab=docker',
  storage: '/infrastructure?tab=storage',
  network: '/infrastructure?tab=network',
  power: '/infrastructure?tab=power',
  external: '/infrastructure?tab=network',
};

export function InfraStatusStrip({
  health,
  providers = [],
  compact = false,
}: {
  health: InfrastructureHealthDoc | null | undefined;
  providers?: ProviderDoc[];
  compact?: boolean;
}) {
  if (!health?.domains) return null;
  const cells = ORDER.map((id) => health.domains[id]).filter(Boolean);
  return (
    <div className="infra-strip" role="group" aria-label="Infrastructure status">
      {cells.map((d) => {
        const names = (d.providers || [])
          .map((pid) => providers.find((p) => p.id === pid)?.name)
          .filter(Boolean)
          .join(' · ');
        const title = d.reasons?.length ? `${d.label}: ${d.reasons.join('; ')}` : `${d.label}${names ? ` — ${names}` : ''}`;
        return (
          <div key={d.domain} title={title}>
            <StatusDot state={DOT[d.status]} title={WORDS[d.status]} />
            <span className="k">{d.label}</span>
            {compact ? (
              <span className="v" aria-label={WORDS[d.status]}>{WORDS[d.status]}</span>
            ) : (
              <Link className="v" to={HREFS[d.domain] || '/infrastructure'} aria-label={`${d.label}: ${WORDS[d.status]}`}>
                {WORDS[d.status]}
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One provider's line, for the Connections pane and the Host page.
 * Deliberately says what it could not do as plainly as what it does.
 */
export function ProviderRow({ provider }: { provider: ProviderDoc }) {
  const dot = provider.status === 'connected' || provider.status === 'available' ? 'up'
    : provider.status === 'degraded' ? 'unhealthy'
      : provider.status === 'unavailable' ? 'down' : 'absent';
  return (
    <div className="prov-row">
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <StatusDot state={dot} title={provider.statusLabel} />
        <b style={{ fontWeight: 600 }}>{provider.name}</b>
      </span>
      <span className="stale-note" style={{ marginLeft: 'auto' }}>{provider.statusLabel}</span>
      {provider.version && <span className="mono-meta">{provider.version}</span>}
      {provider.error?.reason && <span className="stale-note" style={{ flexBasis: '100%' }}>{provider.error.reason}</span>}
      {!!provider.capabilities.length && (
        <span className="stale-note" style={{ flexBasis: '100%' }}>
          capabilities: {provider.capabilities.join(', ')}
          {provider.active.length && provider.active.length < provider.capabilities.length
            ? ` · answering now: ${provider.active.join(', ')}` : ''}
          {!!provider.planned.length && ` · planned: ${provider.planned.join(', ')}`}
        </span>
      )}
    </div>
  );
}
