// First-run setup — the five steps between `docker compose up -d` and a working OpusHub.
//
// The wizard asks for exactly one thing it cannot discover (the administrator's credentials), plus
// the two optional infrastructure knobs it cannot read off Docker (the host address used for
// published-port URLs, and a Traefik entrypoint→port mapping when the entrypoint is not 80/443).
// Everything else on these screens is *read* from the engine: stacks, containers, routes.
//
// The account is created in the final step, in one request, together with the environment values —
// so an abandoned wizard leaves an uninitialised install rather than a half-made one.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth, type SetupDiscovery } from '../lib/auth';
import { LogoMark } from '../components/Logo';

const STEPS = ['Welcome', 'Administrator', 'Environment', 'Discovery', 'Finish'] as const;

export default function SetupPage() {
  const { setup, completeSetup } = useAuth();
  const [step, setStep] = useState(0);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hostAddress, setHostAddress] = useState('');
  const [entrypointPorts, setEntrypointPorts] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [discovery, setDiscovery] = useState<SetupDiscovery | null>(setup?.discovery ?? null);
  const heading = useRef<HTMLHeadingElement>(null);

  // the wizard is the one screen that may talk to the discovery summary before an account exists
  useEffect(() => {
    void api<{ discovery?: SetupDiscovery }>('/api/setup/status')
      .then((s) => setDiscovery(s.discovery ?? null))
      .catch(() => setDiscovery(null));
  }, []);

  const detectedHost = discovery?.hostAddress ?? '';
  useEffect(() => { if (!hostAddress && detectedHost) setHostAddress(detectedHost); }, [detectedHost, hostAddress]);
  useEffect(() => { heading.current?.focus(); }, [step]);

  const entrypoints = useMemo(() => discovery?.traefik.entrypoints ?? [], [discovery]);

  const accountProblem = () => {
    if (username.trim().length < 3) return 'Choose a username of at least 3 characters.';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(username.trim())) return 'Usernames may use letters, digits, dot, dash and underscore.';
    if (password.length < 8) return 'Choose a password of at least 8 characters.';
    if (password !== confirm) return 'The two passwords do not match.';
    return null;
  };

  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const advanceFromAccount = () => {
    const p = accountProblem();
    if (p) { setProblem(p); return; }
    setProblem(null);
    next();
  };

  const finish = async () => {
    const p = accountProblem();
    if (p) { setProblem(p); setStep(1); return; }
    setBusy(true);
    setProblem(null);
    const infra: Record<string, unknown> = {};
    if (hostAddress.trim() && hostAddress.trim() !== detectedHost) infra.hostAddress = hostAddress.trim();
    const ports = Object.fromEntries(Object.entries(entrypointPorts).filter(([, v]) => String(v || '').trim()));
    if (Object.keys(ports).length) infra.entrypointPorts = ports;
    try {
      await completeSetup({ username: username.trim(), password, ...(Object.keys(infra).length ? { infrastructure: infra } : {}) });
      // the AuthProvider re-reads the state and the Hub takes over from here
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Setup could not be completed.');
      setBusy(false);
    }
  };

  return (
    <div className="auth auth--wide">
      <div className="auth-bg" aria-hidden="true" />
      <main className="auth-card setup-card">
        <header className="setup-head">
          <div className="auth-mark" aria-hidden="true"><LogoMark size={34} /></div>
          <div>
            <p className="setup-kicker">Set up OpusHub</p>
            <h1 className="auth-title setup-title" tabIndex={-1} ref={heading}>{STEPS[step]}</h1>
          </div>
        </header>

        <ol className="setup-rail" aria-label="Setup progress">
          {STEPS.map((label, i) => (
            <li key={label} data-state={i === step ? 'current' : i < step ? 'done' : 'todo'}>
              <span className="n">{i + 1}</span>{label}
            </li>
          ))}
        </ol>

        <div className="setup-body">
          {step === 0 && (
            <>
              <p className="lede">
                OpusHub reads this machine’s Docker engine and turns it into one screen: your stacks,
                the services inside them, and the URLs your proxy actually exposes. Nothing is added
                by hand — the inventory is what the engine reports.
              </p>
              <ul className="setup-points">
                <li><b>Read-only by design.</b> OpusHub never starts, stops or changes a container.</li>
                <li><b>One local account.</b> Passwords are hashed with scrypt; sessions are server-side cookies.</li>
                <li><b>Your configuration stays yours.</b> Presentation lives in <code>config/</code>, state in <code>data/</code>.</li>
              </ul>
            </>
          )}

          {step === 1 && (
            <>
              <p className="lede">This account is the only way into OpusHub. It is stored on this host, in the data volume — never in services.yaml.</p>
              <div className="field">
                <label htmlFor="setup-user">Username</label>
                <input id="setup-user" className="input" value={username} autoCapitalize="none" spellCheck={false}
                  autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="setup-pass">Password</label>
                <input id="setup-pass" className="input" type="password" value={password} autoComplete="new-password"
                  onChange={(e) => setPassword(e.target.value)} />
                <span className="hint">At least 8 characters. A passphrase is stronger than a short password.</span>
              </div>
              <div className="field">
                <label htmlFor="setup-pass2">Confirm password</label>
                <input id="setup-pass2" className="input" type="password" value={confirm} autoComplete="new-password"
                  onChange={(e) => setConfirm(e.target.value)} />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="lede">
                These two are what Docker cannot tell OpusHub. Leave them as they are if you publish no
                ports or if Traefik is on 80/443 — that is the common case.
              </p>
              <div className="field">
                <label htmlFor="setup-host">Host address for published ports</label>
                <input id="setup-host" className="input" value={hostAddress} placeholder="e.g. 192.168.1.20 or hub.lan"
                  onChange={(e) => setHostAddress(e.target.value)} />
                <span className="hint">
                  {detectedHost
                    ? <>Detected automatically ({describeSource(discovery?.hostAddressSource)}). Used only when a container has a published port and no proxy route.</>
                    : <>No address could be detected — set one and containers with published ports get a usable URL.</>}
                </span>
              </div>
              {entrypoints.length > 0 && (
                <div className="field">
                  <label>Traefik entrypoint ports</label>
                  <span className="hint">
                    Detected entrypoints: {entrypoints.join(', ')}. Only fill these in when an entrypoint does
                    not listen on 80/443 — the URL resolver will not guess a port.
                  </span>
                  <div className="setup-ports">
                    {entrypoints.map((ep) => (
                      <label key={ep} className="setup-port">
                        <span className="mono-meta">{ep}</span>
                        <input className="input" inputMode="numeric" placeholder="443"
                          value={entrypointPorts[ep] ?? ''}
                          onChange={(e) => setEntrypointPorts({ ...entrypointPorts, [ep]: e.target.value })} />
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <dl className="setup-kv">
                <dt>Docker endpoint</dt>
                <dd>
                  {discovery?.docker.ok
                    ? `Connected — engine ${discovery.docker.version || 'unknown'}`
                    : `Not connected (${discovery?.docker.state || 'unknown'})`}
                  <span className="hint"> — set with OPUSHUB_DOCKER_SOCKET and the socket mount; read at start-up.</span>
                </dd>
              </dl>
            </>
          )}

          {step === 3 && (
            <>
              <p className="lede">This is what the engine answered while you were reading. Nothing here was configured.</p>
              <div className="setup-grid">
                <Stat label="Docker" value={discovery?.docker.ok ? 'Connected' : 'Not connected'} tone={discovery?.docker.ok ? 'ok' : 'warn'}
                  note={discovery?.docker.version ? `engine ${discovery.docker.version}` : undefined} />
                <Stat label="Stacks" value={discovery?.stacks ?? 0} note="compose projects" />
                <Stat label="Containers" value={discovery?.containers ?? 0} note={`${discovery?.running ?? 0} running`} />
                <Stat label="Applications" value={discovery?.services ?? 0} note="the services you use" />
                <Stat label="Infrastructure" value={discovery?.infrastructure ?? 0} note="Traefik, Tailscale, … — listed, never hidden" />
                <Stat label="URLs" value={discovery?.urls.detected ?? 0} note="resolved from proxy metadata or published ports" />
                <Stat label="Traefik routes" value={discovery?.traefik.routes ?? 0} note={discovery?.traefik.tlsRoutes ? `${discovery.traefik.tlsRoutes} with TLS` : undefined} />
              </div>
              {(discovery?.urls.missing ?? 0) > 0 && (
                <p className="setup-attention" role="status">
                  <b>{discovery?.urls.missing}</b> container{discovery?.urls.missing === 1 ? '' : 's'} have no browser URL.
                  That is not a problem to fix now: a service with no proxy route and no published port honestly has no
                  URL, and you can set one later on its service page. Nothing is blocked by it.
                </p>
              )}
              <p className="hint">
                Infrastructure containers are kept and separated rather than filtered: you will find them on their own
                rail in Services, next to {(discovery?.standalone ?? 0) > 0
                  ? <>the {discovery?.standalone} container{discovery?.standalone === 1 ? '' : 's'} that are not part of a compose project.</>
                  : <>the applications.</>}
              </p>
              <p className="hint">
                Containers are grouped by their compose project: the project name becomes the group heading, with
                its containers underneath. Rename, re-file or re-icon anything afterwards — the grouping never has
                to be written by hand, and a container that appears tomorrow shows up on its own.
              </p>
            </>
          )}

          {step === 4 && (
            <>
              <p className="lede">
                Your OpusHub is ready. Creating the account closes setup for good — the wizard cannot be run again,
                and every API is locked behind a session from this moment on.
              </p>
              <ul className="setup-points">
                <li>Signing in as <b>{username || '—'}</b></li>
                <li>{discovery?.stacks ?? 0} stack{(discovery?.stacks ?? 0) === 1 ? '' : 's'} will appear on the Hub, grouped by project</li>
                <li>{discovery?.urls.detected ?? 0} service URL{(discovery?.urls.detected ?? 0) === 1 ? '' : 's'} resolved from real metadata</li>
              </ul>
            </>
          )}
        </div>

        {problem && <p className="auth-error" role="alert">{problem}</p>}

        <footer className="setup-foot">
          <button className="btn btn-quiet" onClick={back} disabled={step === 0 || busy}>Back</button>
          <span className="setup-step-note">Step {step + 1} of {STEPS.length}</span>
          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary" onClick={step === 1 ? advanceFromAccount : next}>
              {step === 0 ? 'Begin' : 'Continue'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={finish} disabled={busy}>
              {busy ? 'Creating account…' : 'Create account & enter OpusHub'}
            </button>
          )}
        </footer>
      </main>
    </div>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string | number; note?: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className="setup-stat" data-tone={tone}>
      <span className="setup-stat-label">{label}</span>
      <span className="setup-stat-value">{value}</span>
      {note && <span className="setup-stat-note">{note}</span>}
    </div>
  );
}

function describeSource(source?: string | null): string {
  switch (source) {
    case 'configured': return 'from OPUSHUB_HOST_ADDRESS or settings.yaml';
    case 'published-bind': return 'from a published container bind address';
    case 'outbound-interface': return 'from this host’s outbound interface';
    default: return 'no source';
  }
}
