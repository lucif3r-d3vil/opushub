// The door. One field pair, the OpusHub mark, and the same typography/spacing/motion vocabulary as
// the rest of the app — deliberately not a marketing page and not a SaaS auth template.
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth';
import { LogoMark } from '../components/Logo';

export default function LoginPage() {
  const { login, error, clearError } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => { userRef.current?.focus(); }, []);
  // The reason a sign-in failed has to stay on screen until the *user* changes something.
  // Clearing it whenever the fields change is not the same thing: a failed attempt clears the
  // password, and that programmatic change would wipe the explanation on the next render.
  const edit = (setter: (v: string) => void) => (value: string) => { setProblem(null); clearError(); setter(value); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) { setProblem('Enter your username and password.'); return; }
    setBusy(true);
    setProblem(null);
    clearError();
    try {
      await login(username.trim(), password);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not sign in.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-bg" aria-hidden="true" />
      <main className="auth-card" aria-labelledby="auth-title">
        <div className="auth-mark" aria-hidden="true"><LogoMark /></div>
        <h1 className="auth-title" id="auth-title">OpusHub</h1>
        <p className="auth-sub">Sign in to reach this machine’s Docker inventory.</p>

        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="login-user">Username</label>
            <input
              id="login-user" ref={userRef} className="input" name="username" value={username}
              autoComplete="username" autoCapitalize="none" spellCheck={false}
              onChange={(e) => edit(setUsername)(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="login-pass">Password</label>
            <input
              id="login-pass" className="input" type="password" name="password" value={password}
              autoComplete="current-password" onChange={(e) => edit(setPassword)(e.target.value)}
            />
          </div>
          {(problem || error) && <p className="auth-error" role="alert">{problem || error}</p>}
          <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="auth-foot">
          Access is local to this host. Sessions are server-side and expire; nothing is stored in the browser.
        </p>
      </main>
    </div>
  );
}
