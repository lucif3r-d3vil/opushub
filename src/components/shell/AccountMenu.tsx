// The avatar and its menu: who is signed in, appearance (theme, background, accent), Settings,
// and Sign out. This is where the background picker lives; there is no floating dock.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useSettings } from '../../lib/theme';
import { BACKGROUND_IDS, type BackgroundId, type SettingsDoc } from '../../lib/types';

const BG_SWATCH: Record<BackgroundId, { name: string; css: string }> = {
  graphite: { name: 'Graphite', css: 'radial-gradient(70% 90% at 15% 0%, rgba(143,179,137,.5), transparent 70%), radial-gradient(60% 80% at 95% 10%, rgba(126,147,172,.4), transparent 70%), #0b0c0e' },
  dusk: { name: 'Dusk', css: 'radial-gradient(70% 90% at 80% 0%, rgba(138,104,204,.9), transparent 70%), radial-gradient(70% 80% at 5% 100%, rgba(222,122,138,.7), transparent 70%), #0d0b14' },
  forest: { name: 'Forest', css: 'radial-gradient(70% 90% at 10% 0%, rgba(78,168,128,.9), transparent 70%), radial-gradient(70% 80% at 100% 100%, rgba(40,122,124,.8), transparent 70%), #08100d' },
  ember: { name: 'Ember', css: 'radial-gradient(70% 90% at 90% 0%, rgba(232,144,76,.9), transparent 70%), radial-gradient(70% 80% at 0% 100%, rgba(178,76,66,.75), transparent 70%), #100b08' },
  photo: { name: 'Photo', css: 'url(/api/appearance/background)' },
};
const ACCENTS: { id: SettingsDoc['appearance']['accent']; color: string }[] = [
  { id: 'sage', color: '#8fb389' }, { id: 'slate', color: '#7e93ac' }, { id: 'teal', color: '#69a5a1' }, { id: 'amber', color: '#cfa15e' },
  { id: 'rose', color: '#c98189' }, { id: 'clay', color: '#c08a6d' }, { id: 'moss', color: '#93a56f' },
];
const THEMES: { id: SettingsDoc['appearance']['theme']; label: string }[] = [{ id: 'system', label: 'System' }, { id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }];

const Svg = ({ children }: { children: ReactNode }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
const GearIcon = () => <Svg><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Svg>;
const LayersIcon = () => <Svg><path d="m12 3 8.5 4.7L12 12.4 3.5 7.7zM3.5 12.5 12 17.2l8.5-4.7M3.5 17l8.5 4.7 8.5-4.7" /></Svg>;
const ChipIcon = () => <Svg><path d="M4 5.5h16v11H4zM8.5 20h7M12 16.5V20" /></Svg>;
const ClockIcon = () => <Svg><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2" /></Svg>;
const OutIcon = () => <Svg><path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 8l-4 4 4 4M6 12h9" /></Svg>;

export function AccountMenu() {
  const { user, logout } = useAuth();
  const { settings, update } = useSettings();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const name = user?.username || 'admin';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const a = settings?.appearance;
  const theme = a?.theme ?? 'system';
  const bg: BackgroundId = a?.background && BACKGROUND_IDS.includes(a.background) ? a.background : 'graphite';
  const accent = a?.accent ?? 'sage';
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  const ids = BACKGROUND_IDS.filter((id) => id !== 'photo' || a?.photoAvailable);
  const close = () => setOpen(false);

  return (
    <>
      <button ref={btn} type="button" className="av" aria-label={`Account menu, signed in as ${name}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {name.charAt(0).toUpperCase()}
      </button>
      {open && (
        <>
          <div className="acct-scrim" onMouseDown={close} />
          <div className="acct" role="dialog" aria-label="Account and appearance">
            <div className="mh">
              <span className="av lg" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
              <div><b>{name}</b><small>Administrator · signed in on this browser</small></div>
            </div>
            <div className="ms">
              <h4>Appearance</h4>
              <div className="row">
                <span>Theme</span>
                <span className="seg" role="group" aria-label="Theme">
                  {THEMES.map((t) => <button key={t.id} type="button" aria-pressed={theme === t.id} onClick={() => update({ appearance: { theme: t.id } }, true)}>{t.label}</button>)}
                </span>
              </div>
              <div className="row" style={{ marginBottom: 8 }}><span>Background</span><span style={{ color: 'var(--ink)', fontWeight: 560 }}>{BG_SWATCH[bg].name}</span></div>
              <div className="bggrid" role="group" aria-label="Background" data-off={light || undefined}>
                {ids.map((id) => (
                  <button key={id} type="button" className="bgsw" aria-pressed={bg === id} style={{ ['--swc' as never]: BG_SWATCH[id].css }} onClick={() => update({ appearance: { background: id } }, true)}>
                    <span>{BG_SWATCH[id].name}</span>
                  </button>
                ))}
              </div>
              {light && <p className="stale-note" style={{ margin: '-6px 0 12px' }}>Backgrounds apply to the dark theme.</p>}
              <div className="row" style={{ marginBottom: 8 }}><span>Accent</span></div>
              <div className="acrow" role="group" aria-label="Accent">
                {ACCENTS.map((c) => <button key={c.id} type="button" className="acsw" aria-label={c.id} aria-pressed={accent === c.id} style={{ ['--c' as never]: c.color }} onClick={() => update({ appearance: { accent: c.id } }, true)} />)}
              </div>
            </div>
            <div className="mi">
              <Link to="/settings" onClick={close}><GearIcon />Settings</Link>
              <Link to="/stacks" onClick={close}><LayersIcon />Stacks<span className="sub">until rebuilt</span></Link>
              <Link to="/system" onClick={close}><ChipIcon />System<span className="sub">until rebuilt</span></Link>
              <Link to="/activity" onClick={close}><ClockIcon />Activity<span className="sub">until rebuilt</span></Link>
              <button type="button" onClick={() => { close(); void logout(); }}><OutIcon />Sign out</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
