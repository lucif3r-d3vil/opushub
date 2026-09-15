// First-run setup — the eight steps between `docker compose up -d` and a working OpusHub.
//
// Welcome → Administrator → Environment → Discovery → Presentation → Preview → Review → Finish
//
// The Presentation and Preview steps are Phase 6. They exist because the migration story has to
// start before the first page renders: someone arriving from Homepage should be able to say "import
// my config" on the way in, and someone with a bare engine should be able to see that "nothing to
// present yet" is a finished state rather than a broken one. Both steps are decisions, not writes —
// the only write in the wizard is still the account (plus, if chosen, one built-in template).
//
// The wizard asks for exactly one thing it cannot discover (the administrator's credentials), plus
// the two optional infrastructure knobs it cannot read off Docker (the host address used for
// published-port URLs, and a Traefik entrypoint→port mapping when the entrypoint is not 80/443).
// Everything else on these screens is *read* from the engine: the API version it answers on,
// stacks, containers, routes, and the reason every service does or does not have a URL.
//
// Two rules that shape the code below:
//   · nothing but counts and reason *categories* may exist before an account does — no container
//     name, image, domain or URL crosses the wire pre-auth (see `setupSummary()` in server/api.js);
//   · a URL is never required to finish. A service with no proxy route and no published port
//     honestly has no URL, and the wizard says so in words instead of blocking on it.
//
// The account is created when the Review step is confirmed, and the Finish screen is then shown
// *before* the Hub takes over — so the last thing the wizard does is explain what was created,
// rather than throwing the user straight into a dashboard.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth, type SetupDiscovery, type SetupTemplate } from '../lib/auth';
import { LogoMark } from '../components/Logo';

const STEPS = ['Welcome', 'Administrator', 'Environment', 'Discovery', 'Presentation', 'Preview', 'Review', 'Finish'] as const;
const STEP_REVIEW = 6;
const STEP_FINISH = 7;

export default function SetupPage() {
  const { setup, completeSetup, enter } = useAuth();
  const [step, setStep] = useState(0);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hostAddress, setHostAddress] = useState('');
  const [entrypointPorts, setEntrypointPorts] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [discovery, setDiscovery] = useState<SetupDiscovery | null>(setup?.discovery ?? null);
  const [created, setCreated] = useState<{ username: string; revoked: number } | null>(null);
  // Phase 6 — the presentation decision. `detected` writes nothing at all; `template` applies one of
  // the six built-in templates in the same request that creates the account. Importing is offered as
  // the step *after* sign-in: it is an authenticated configuration write, and the wizard may not
  // touch configuration before an account exists.
  const [mode, setMode] = useState<'detected' | 'template'>('detected');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [importAfter, setImportAfter] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const nav = useNavigate();
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

  /** The one mutation in the whole wizard: create the account, together with the infra knobs. */
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
      const r = await completeSetup({
        username: username.trim(), password,
        ...(Object.keys(infra).length ? { infrastructure: infra } : {}),
        ...(mode === 'template' && templateId ? { presentation: { mode: 'template' as const, template: templateId } } : {}),
      });
      setApplied(r?.presentation?.template ?? null);
      setCreated({ username: username.trim(), revoked: 0 });
      setStep(STEP_FINISH);
      setBusy(false);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Setup could not be completed.');
      setBusy(false);
    }
  };

  const urlReasons = discovery?.urls.reasons ?? [];
  const resolvedReasons = urlReasons.filter((r) => r.resolved);
  const missingReasons = urlReasons.filter((r) => !r.resolved);

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
              <p className="hint">Six short steps. The only thing you have to decide is the account; everything else is what the engine already answered.</p>
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
              <p className="hint">The account is created at the end of the wizard, in one request — an abandoned setup leaves an uninitialized install, never a half-made one.</p>
            </>
          )}

          {step === 2 && (
            <>
              <p className="lede">
                First, the engine. This is what Docker answered — nothing here was configured, and
                nothing here can be changed from this screen.
              </p>
              <dl className="setup-kv">
                <dt>Docker engine</dt>
                <dd>
                  {discovery?.docker.ok
                    ? <>Connected{discovery.docker.version ? <> — engine <span className="mono-meta">{discovery.docker.version}</span></> : null}</>
                    : <span className="stale-note">Not connected ({discovery?.docker.state || 'unknown'})</span>}
                </dd>
                <dt>Docker API</dt>
                <dd>
                  {discovery?.docker.apiVersion
                    ? <span className="mono-meta">v{discovery.docker.apiVersion}</span>
                    : <span className="stale-note">Not negotiated yet — OpusHub adopts the daemon’s own version on the first call</span>}
                </dd>
                <dt>Endpoint</dt>
                <dd className="stale-note">
                  set with <code>OPUSHUB_DOCKER_SOCKET</code> (or <code>DOCKER_HOST</code>) and the socket mount; read once at start-up
                </dd>
                {discovery?.docker.operatingSystem && <><dt>Host OS</dt><dd className="mono-meta">{discovery.docker.operatingSystem}</dd></>}
              </dl>
              {!discovery?.docker.ok && (
                <p className="setup-attention" role="status">
                  OpusHub runs fine without Docker — it just has nothing to show. Mount
                  <code> /var/run/docker.sock</code> read-only, add the socket’s group, and restart the
                  container; this page will say “Connected”.
                </p>
              )}

              <p className="lede" style={{ marginTop: 'var(--sp-8)' }}>
                Two things Docker cannot tell OpusHub. Leave them as they are if you publish no ports
                or if Traefik is on 80/443 — that is the common case.
              </p>
              <div className="field">
                <label htmlFor="setup-host">Host address for published ports</label>
                <input id="setup-host" className="input" value={hostAddress} placeholder="e.g. 192.168.1.20 or hub.lan"
                  onChange={(e) => setHostAddress(e.target.value)} />
                <span className="hint">
                  {detectedHost
                    ? <>Detected automatically ({describeSource(discovery?.hostAddressSource)}). Used only when a container has a published port and no proxy route.</>
                    : <>No address could be detected — set one and containers with published ports get a usable URL. Without it, OpusHub shows a name instead of inventing a link.</>}
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
            </>
          )}

          {step === 3 && (
            <>
              <p className="lede">This is what the engine answered while you were reading. Nothing here was configured.</p>
              <div className="setup-grid">
                <Stat label="Containers" value={discovery?.containers ?? 0} note={discovery ? `${discovery.running} running${discovery.stopped ? ` · ${discovery.stopped} stopped` : ''}` : undefined} />
                <Stat label="Stacks" value={discovery?.stacks ?? 0} note="compose projects" />
                <Stat label="Applications" value={discovery?.services ?? 0} note="the services you use" />
                <Stat label="Infrastructure" value={discovery?.infrastructure ?? 0} note="Traefik, databases, exporters — listed, never hidden" />
                <Stat label="Standalone" value={discovery?.standalone ?? 0} note="not part of a compose project" />
                <Stat label="Traefik routers" value={discovery?.traefik.routes ?? 0} note={discovery?.traefik.tlsRoutes ? `${discovery.traefik.tlsRoutes} with TLS` : 'none published'} />
                <Stat label="URLs resolved" value={discovery?.urls.detected ?? 0} note={`of ${discovery?.containers ?? 0} containers`} tone={(discovery?.urls.detected ?? 0) > 0 ? 'ok' : undefined} />
                <Stat label="No URL" value={discovery?.urls.missing ?? 0} note="honest absences, not errors" />
              </div>

              <div className="setup-explain">
                <h3 className="setup-explain-title">Why a service has a URL</h3>
                {resolvedReasons.length === 0 && <p className="hint">No URL could be resolved yet.</p>}
                <ul className="setup-reasons">
                  {resolvedReasons.map((r) => (
                    <li key={r.code}>
                      <span className="count">{r.count}</span>
                      <span className="why">{r.explain || r.code}</span>
                    </li>
                  ))}
                </ul>
                <h3 className="setup-explain-title">Why a service has no URL</h3>
                {missingReasons.length === 0 && <p className="hint">Every container has a usable browser URL.</p>}
                <ul className="setup-reasons">
                  {missingReasons.map((r) => (
                    <li key={r.code}>
                      <span className="count">{r.count}</span>
                      <span className="why">{r.explain || r.code}</span>
                    </li>
                  ))}
                </ul>
                <p className="hint">
                  Nothing is blocked by a missing URL. OpusHub prefers an honest absence to a link that
                  would not load, and you can add an override later on the service’s own page — or in{' '}
                  <code>services.yaml</code>. A container that appears tomorrow shows up on its own.
                </p>
              </div>

              <p className="hint">
                Containers are grouped by their compose project: the project name becomes the group
                heading, with its containers underneath. Infrastructure keeps its own rail rather than
                being filtered out — you will find it next to the applications.
              </p>
            </>
          )}

          {step === 4 && (
            <>
              <p className="lede">
                Docker decided what exists. This decides how it looks on the way in — and it is the
                only part of setup where your own taste enters. Anything you pick here can be changed
                later in Settings; nothing here changes what Docker reports.
              </p>

              <div className="setup-choices" role="radiogroup" aria-label="Starting presentation">
                <button
                  type="button" role="radio" aria-checked={mode === 'detected' && !importAfter}
                  className={`setup-choice${mode === 'detected' && !importAfter ? ' sel' : ''}`}
                  onClick={() => { setMode('detected'); setTemplateId(null); setImportAfter(false); }}
                >
                  <span className="setup-choice-title">Use what Docker found</span>
                  <span className="setup-choice-desc">
                    Every container is listed under its compose project with the name, icon and URL the
                    engine and your proxy already imply. Nothing is written. This is the right answer
                    for a fresh install, and the wrong one for nobody.
                  </span>
                  <span className="setup-choice-meta">
                    {discovery?.presentation?.detected.groups ?? discovery?.stacks ?? 0} group(s) ·
                    {' '}{discovery?.presentation?.detected.services ?? discovery?.services ?? 0} application(s)
                  </span>
                </button>

                <button
                  type="button" role="radio" aria-checked={mode === 'template'}
                  className={`setup-choice${mode === 'template' ? ' sel' : ''}`}
                  onClick={() => { setMode('template'); setImportAfter(false); if (!templateId) setTemplateId(discovery?.presentation?.templates[0]?.id ?? null); }}
                >
                  <span className="setup-choice-title">Start from a template</span>
                  <span className="setup-choice-desc">
                    A pre-arranged Hub: which blocks appear, how big they are and how tightly the page
                    is set. Presentation only — a template can never add, remove or rename a service.
                  </span>
                  <span className="setup-choice-meta">{discovery?.presentation?.templates.length ?? 0} built in</span>
                </button>

                <button
                  type="button" role="radio" aria-checked={importAfter}
                  className={`setup-choice${importAfter ? ' sel' : ''}`}
                  onClick={() => { setImportAfter(!importAfter); }}
                >
                  <span className="setup-choice-title">Import a Homepage configuration</span>
                  <span className="setup-choice-desc">
                    Comes from a Homepage install: <code className="mono-meta">services.yaml</code>,{' '}
                    <code className="mono-meta">bookmarks.yaml</code>, widgets, theme and custom assets.
                    You will review what matched and what did not before a single file is written, and
                    entries that match no container stay links rather than becoming fake services.
                  </span>
                  <span className="setup-choice-meta">
                    {importAfter ? 'Opens the import screen after you sign in' : 'Nothing imported yet — this only takes you there next'}
                  </span>
                </button>
              </div>

              {mode === 'template' && !importAfter && (
                <>
                  <h3 className="setup-explain-title" style={{ marginTop: 'var(--sp-8)' }}>Which template</h3>
                  <div className="setup-templates" role="radiogroup" aria-label="Template">
                    {(discovery?.presentation?.templates ?? []).map((t) => (
                      <button
                        key={t.id} type="button" role="radio" aria-checked={templateId === t.id}
                        className={`setup-template${templateId === t.id ? ' sel' : ''}`}
                        onClick={() => setTemplateId(t.id)}
                      >
                        <span className="setup-template-name">{t.name}</span>
                        <span className="setup-template-tag">{t.tagline}</span>
                        <span className="setup-template-meta">
                          {t.widgets.length} block{t.widgets.length === 1 ? '' : 's'} · {t.spacing}
                        </span>
                      </button>
                    ))}
                    {!(discovery?.presentation?.templates ?? []).length && (
                      <p className="hint">No templates available — the engine is reachable but the catalogue could not be read.</p>
                    )}
                  </div>
                  <p className="hint">
                    Group preferences inside a template are matched against the groups your containers
                    actually produce. Names that match nothing are simply not applied, and the choice is
                    recorded as a configuration version you can undo.
                  </p>
                </>
              )}
            </>
          )}

          {step === 5 && (
            <>
              <p className="lede">
                {importAfter
                  ? 'Nothing has been chosen yet, and nothing has been written.'
                  : mode === 'template'
                    ? `This is the shape “${(discovery?.presentation?.templates ?? []).find((t) => t.id === templateId)?.name || templateId}” produces.`
                    : 'This is the shape your Hub takes with no configuration at all.'}
              </p>

              {importAfter ? (
                <>
                  <div className="setup-result">
                    <p>
                      The import is next, and it begins with a review: every entry in the files you
                      provide is classified as <b>matched to a running container</b>,{' '}
                      <b>unmatched</b>, or <b>invalid</b>, with the counts in front of you before you
                      apply anything.
                    </p>
                    <p className="hint">
                      Unmatched entries are kept only as bookmarks or presentation overlays. They can
                      never enter the Docker inventory — a configuration file cannot invent a container.
                      Credentials found in widget blocks are dropped and never re-exported.
                    </p>
                  </div>
                  <p className="hint">
                    Your account is created first (that request is the only write in this wizard), and
                    then you land on the import screen with it already open.
                  </p>
                </>
              ) : (
                <>
                  <SetupPreview
                    widgets={mode === 'template'
                      ? (discovery?.presentation?.templates ?? []).find((t) => t.id === templateId)?.widgets ?? []
                      : discovery?.presentation?.widgets ?? []}
                    spacing={mode === 'template'
                      ? (discovery?.presentation?.templates ?? []).find((t) => t.id === templateId)?.spacing ?? 'comfortable'
                      : 'comfortable'}
                    tiles={Math.min(discovery?.presentation?.detected.services ?? discovery?.services ?? 0, 12)}
                    groups={discovery?.presentation?.detected.groups ?? discovery?.stacks ?? 0}
                  />
                  <p className="hint">
                    A wireframe, not a screenshot: the blocks and their arrangement are exactly what
                    {' '}{mode === 'template' ? 'the template' : 'a fresh install'} sets up, while the tiles stand in for
                    your {discovery?.presentation?.detected.services ?? discovery?.services ?? 0} applications — their real
                    names, icons and URLs come from the engine once you are signed in.
                  </p>
                </>
              )}
            </>
          )}

          {step === STEP_REVIEW && (
            <>
              <p className="lede">
                One last look before anything is written. Creating the account closes setup for good:
                the wizard cannot be run again, and every API locks behind a session.
              </p>
              <dl className="setup-kv">
                <dt>Administrator</dt>
                <dd className="mono-meta">{username.trim() || '—'}</dd>
                <dt>Docker engine</dt>
                <dd>
                  {discovery?.docker.ok
                    ? <>Connected{discovery.docker.apiVersion ? <> · API v{discovery.docker.apiVersion}</> : null}</>
                    : <span className="stale-note">Not connected — OpusHub will list nothing until it is</span>}
                </dd>
                <dt>Inventory</dt>
                <dd className="mono-meta">
                  {discovery?.containers ?? 0} containers · {discovery?.stacks ?? 0} stacks · {discovery?.services ?? 0} applications
                </dd>
                <dt>URLs</dt>
                <dd className="mono-meta">
                  {discovery?.urls.detected ?? 0} reachable · {discovery?.urls.missing ?? 0} without a link
                </dd>
                <dt>Host address</dt>
                <dd className="mono-meta">
                  {hostAddress.trim() || detectedHost || <span className="stale-note">none — published ports will not become links</span>}
                  {hostAddress.trim() && hostAddress.trim() !== detectedHost && <span className="stale-note"> · set by you</span>}
                </dd>
                {entrypoints.length > 0 && (
                  <>
                    <dt>Entrypoint ports</dt>
                    <dd className="mono-meta">
                      {Object.entries(entrypointPorts).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ') || <span className="stale-note">defaults (80/443)</span>}
                    </dd>
                  </>
                )}
                <dt>Files</dt>
                <dd className="mono-meta">account → <code>data/auth.json</code> · presentation → <code>config/</code></dd>
              </dl>
              <p className="hint">
                Nothing is installed, started, stopped or pulled — including by this button. It writes
                one account and, if you changed them, the two infrastructure values above.
              </p>
            </>
          )}

          {step === STEP_FINISH && (
            <>
              <p className="lede">
                OpusHub is ready. You are signed in as <b>{created?.username || username}</b>, and the
                inventory below is already live — it was read from the engine, not typed in.
              </p>
              <ul className="setup-points">
                <li>{discovery?.stacks ?? 0} stack{(discovery?.stacks ?? 0) === 1 ? '' : 's'} will appear on the Hub, grouped by project</li>
                <li>{discovery?.urls.detected ?? 0} service URL{(discovery?.urls.detected ?? 0) === 1 ? '' : 's'} resolved from real metadata</li>
                <li>Change the password, review sessions, or sign other browsers out any time in <b>Settings → Account &amp; sessions</b></li>
              </ul>
              <p className="hint">
                This screen is the last step of setup only — it will not come back. A reload now goes
                straight to the Hub.
              </p>
            </>
          )}
        </div>

        {problem && <p className="auth-error" role="alert">{problem}</p>}

        <footer className="setup-foot">
          <button className="btn btn-quiet" onClick={back} disabled={step === 0 || step >= STEP_FINISH || busy}>Back</button>
          <span className="setup-step-note">Step {Math.min(step + 1, STEPS.length)} of {STEPS.length}</span>
          {step < STEP_REVIEW && (
            <button className="btn btn-primary" onClick={step === 1 ? advanceFromAccount : next}>
              {step === 0 ? 'Begin' : 'Continue'}
            </button>
          )}
          {step === STEP_REVIEW && (
            <button className="btn btn-primary" onClick={finish} disabled={busy}>
              {busy ? 'Creating account…' : 'Create account'}
            </button>
          )}
          {step === STEP_FINISH && (
            <button
              className="btn btn-primary"
              onClick={() => { enter(); if (importAfter) nav('/settings/import'); }}
            >{importAfter ? 'Enter OpusHub and import' : 'Enter OpusHub'}</button>
          )}
        </footer>
      </main>
    </div>
  );
}

/** The Preview step's wireframe.
 *
 *  It shows two true things and invents nothing: the arrangement of blocks the choice produces
 *  (template constants, or the built-in default composition), and how many applications will be
 *  listed. Tiles are deliberately blank — the real names, icons and URLs belong to the engine and
 *  are only readable once an account exists. */
function SetupPreview({ widgets, spacing, tiles, groups }: {
  widgets: { type: string; zone: string; size: string; title: string }[];
  spacing: string; tiles: number; groups: number;
}) {
  const rail = widgets.filter((w) => w.zone === 'rail');
  const main = widgets.filter((w) => w.zone !== 'rail');
  return (
    <div className={`setup-preview spacing-${spacing}`} aria-label="Illustrative preview of the Hub">
      <div className="setup-preview-chrome" aria-hidden="true">
        <span className="setup-preview-dot" /><span className="setup-preview-dot" /><span className="setup-preview-dot" />
        <span className="setup-preview-name">The Hub</span>
      </div>
      <div className="setup-preview-cols">
        <div className="setup-preview-main">
          {main.map((w, i) => <SetupBlock key={`${w.type}-${i}`} w={w} />)}
          <div className="setup-preview-group">
            <span className="setup-preview-group-name">
              {groups ? `${groups} group${groups === 1 ? '' : 's'} from your engine` : 'Your services'}
            </span>
            <div className="setup-tiles">
              {Array.from({ length: tiles }).map((_, i) => <span key={i} className="setup-tile" aria-hidden="true" />)}
              {!tiles && <span className="stale-note">Nothing to list yet — an empty inventory is a finished state, not a broken one.</span>}
            </div>
          </div>
        </div>
        <div className="setup-preview-rail">
          {rail.map((w, i) => <SetupBlock key={`${w.type}-${i}`} w={w} />)}
          {!rail.length && <span className="stale-note">No rail blocks in this arrangement.</span>}
        </div>
      </div>
    </div>
  );
}

function SetupBlock({ w }: { w: { size: string; title: string } }) {
  return (
    <div className={`setup-block setup-block--${w.size || 'md'}`}>
      <span className="setup-block-title">{w.title}</span>
      <span className="setup-block-skel" aria-hidden="true" />
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
