import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, post, put, usePolled, useSave } from '../lib/api';
import { relTime } from '../lib/format';
import { useLayout, useSettings, type DeepPartial } from '../lib/theme';
import type { DiscoveryDoc, HealthDoc, LayoutDoc, Service, ServicesDoc, SettingsDoc } from '../lib/types';
import { Icon } from '../components/Icon';
import { IconPickerModal } from '../components/IconPicker';
import { Menu, type MenuItem, Modal, PageHero, ProviderNote, Segmented, Switch } from '../components/ui';

const TABS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'hub', label: 'Hub' },
  { id: 'services', label: 'Services' },
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'system', label: 'System' },
];

export default function SettingsPage() {
  const { tab = 'appearance' } = useParams();
  const nav = useNavigate();
  return (
    <>
      <PageHero title="Settings" desc="OpusHub reads config/*.yaml — every change here writes the file it belongs in. Comments survive." />
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="Settings sections">
          {TABS.map((t) => (
            <Link key={t.id} to={`/settings/${t.id}`} className={t.id === tab ? 'active' : ''}>{t.label}</Link>
          ))}
          <Link to="/icons" style={{ marginTop: 'var(--sp-4)' }}>Icon browser</Link>
        </nav>
        <div className="settings-pane">
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'hub' && <HubTab />}
          {tab === 'services' && <ServicesTab />}
          {tab === 'bookmarks' && <BookmarksTab />}
          {tab === 'integrations' && <IntegrationsTab />}
          {tab === 'system' && <SystemTab />}
          {!TABS.some((t) => t.id === tab) && (
            <p className="stale-note">Unknown section. <button className="section-link" onClick={() => nav('/settings/appearance')}>Go to Appearance →</button></p>
          )}
        </div>
      </div>
    </>
  );
}

/* ============ row primitives ============ */
function Row({ label, desc, children, tight }: { label: string; desc?: string; children: React.ReactNode; tight?: boolean }) {
  return (
    <div className="form-row" style={tight ? { padding: '10px 0' } : undefined}>
      <div>
        <div className="fr-label">{label}</div>
        {desc && <div className="fr-desc">{desc}</div>}
      </div>
      <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>{children}</div>
    </div>
  );
}
function Block({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 'var(--section-gap)' }}>
      <div className="section-head" style={{ marginBottom: 2 }}><h2 className="section-title">{title}</h2><span className="section-aside">{aside}</span></div>
      {children}
    </section>
  );
}

/* ============ Appearance ============ */
const ACCENTS = [
  { id: 'sage', name: 'Sage' }, { id: 'slate', name: 'Slate' }, { id: 'teal', name: 'Teal' },
  { id: 'amber', name: 'Amber' }, { id: 'rose', name: 'Rose' }, { id: 'clay', name: 'Clay' }, { id: 'moss', name: 'Moss' },
];

function AppearanceTab() {
  const { settings, update, resolvedTheme } = useSettings();
  const { data: bgs } = usePolled<{ files: { name: string; url: string }[] }>('/api/backgrounds', 0);
  const a = settings?.appearance;
  const set = useCallback((patch: DeepPartial<SettingsDoc>) => update(patch), [update]);
  if (!settings || !a) return <p className="stale-note">Loading settings…</p>;
  return (
    <>
      <p className="lede">Changes preview instantly and save themselves to <span className="mono-meta">settings.yaml</span>. No restarts.</p>

      <Block title="Theme">
        <Row label="Mode" desc="Auto follows the OS, with a manual cycle from the rail.">
          <Segmented value={a.theme} onChange={(v) => set({ appearance: { theme: v } })} ariaLabel="Theme mode"
            options={[{ value: 'system', label: 'Auto' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
        </Row>
        <Row label="Accent" desc="One quiet hue for focus, selection and charts.">
          <div className="swatches">
            {ACCENTS.map((c) => (
              <button
                key={c.id} aria-pressed={a.accent === c.id} title={c.name} className="swatch"
                style={{ background: ACCENT_HEX[c.id] }}
                onClick={() => set({ appearance: { accent: c.id as SettingsDoc['appearance']['accent'] } })}
              >
                <span style={{ display: 'none' }}>{c.name}</span>
              </button>
            ))}
          </div>
        </Row>
        <Row label="Density" desc="Compact tightens rows, paddings and body type.">
          <Segmented value={a.density} onChange={(v) => set({ appearance: { density: v } })} ariaLabel="Density"
            options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
        </Row>
        <Row label="Type scale">
          <input type="range" min={0.9} max={1.2} step={0.05} value={a.fontScale} aria-label="Type scale"
            onChange={(e) => set({ appearance: { fontScale: Number(e.target.value) } })} />
          <span className="mono-meta" style={{ width: 42 }}>{Math.round(a.fontScale * 100)}%</span>
        </Row>
        <Row label="Translucency" desc="Only the rail and overlays — content stays opaque." tight>
          <Switch checked={a.transparency} onChange={(v) => set({ appearance: { transparency: v } })} label="Translucency" />
        </Row>
      </Block>

      <Block title="Background">
        <Row label="Style">
          <Segmented value={a.background.mode} onChange={(v) => set({ appearance: { background: { mode: v } } })} ariaLabel="Background mode"
            options={[{ value: 'quiet', label: 'Quiet' }, { value: 'horizon', label: 'Horizon' }, { value: 'photo', label: 'Photo' }]} />
        </Row>
        {a.background.mode === 'photo' && (
          <>
            <div style={{ marginTop: 'var(--sp-4)' }}>
              <div className="bg-tile-grid">
                <button className={`bg-tile ${!a.background.photo ? 'sel' : ''}`} onClick={() => set({ appearance: { background: { photo: null } } })}>
                  <span className="none">None</span>
                </button>
                {(bgs?.files || []).map((f) => (
                  <button
                    key={f.url} className={`bg-tile ${a.background.photo === f.url ? 'sel' : ''}`}
                    style={{ backgroundImage: `url("${f.url}")` }} title={f.name}
                    onClick={() => set({ appearance: { background: { photo: f.url } } })}
                  />
                ))}
              </div>
              <p className="stale-note" style={{ marginTop: 'var(--sp-3)' }}>
                Drop images into <code className="mono-meta">config/backgrounds/</code>, or paste a URL.
              </p>
              <div className="field" style={{ marginTop: 'var(--sp-4)', maxWidth: 420 }}>
                <label htmlFor="bgurl">Background URL</label>
                <input id="bgurl" className="input mono-meta" placeholder="https://… or /user/backgrounds/photo.jpg"
                  defaultValue={a.background.photo || ''}
                  onKeyDown={(e) => { if (e.key === 'Enter') set({ appearance: { background: { photo: (e.target as HTMLInputElement).value.trim() || null } } }); }}
                  onBlur={(e) => { if (e.target.value.trim() !== (a.background.photo || '')) set({ appearance: { background: { photo: e.target.value.trim() || null } } }); }}
                />
              </div>
            </div>
            <Row label="Blur" desc="Applied to the photo so text keeps contrast.">
              <input type="range" min={0} max={48} value={a.background.blur} onChange={(e) => set({ appearance: { background: { blur: Number(e.target.value) } } })} aria-label="Background blur" />
              <span className="mono-meta" style={{ width: 40 }}>{a.background.blur}px</span>
            </Row>
            <Row label="Scrim" desc="Dark (or light) veil between photo and content.">
              <input type="range" min={0} max={100} value={a.background.scrim} onChange={(e) => set({ appearance: { background: { scrim: Number(e.target.value) } } })} aria-label="Background scrim" />
              <span className="mono-meta" style={{ width: 40 }}>{a.background.scrim}%</span>
            </Row>
          </>
        )}
      </Block>

      <Block title="Clock & greeting">
        <Row label="Greeting name" desc="“Good evening, Nora” — leave empty for no name." tight>
          <input className="input" style={{ maxWidth: 220 }} defaultValue={settings.hub.greetingName || ''}
            placeholder="(none)" aria-label="Greeting name"
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => update({ hub: { greetingName: e.target.value.trim() || null } })} />
        </Row>
        <Row label="24-hour clock" tight><Switch checked={settings.hub.clock24h} onChange={(v) => update({ hub: { clock24h: v } })} label="24-hour clock" /></Row>
        <Row label="Seconds" desc="Off by default — the clock shouldn't twitch." tight><Switch checked={settings.hub.showSeconds} onChange={(v) => update({ hub: { showSeconds: v } })} label="Show seconds" /></Row>
      </Block>
      <p className="stale-note">Rendering as <b>{resolvedTheme}</b> right now.</p>
    </>
  );
}

/** swatch colors (static hexes for the picker; the real tokens live on html[data-accent]) */
const ACCENT_HEX: Record<string, string> = {
  sage: '#7ea074', slate: '#68809b', teal: '#4e928d', amber: '#c08f43', rose: '#b76b74', clay: '#a3715a', moss: '#7c8f57',
};

/* ============ Hub ============ */
const TEMPLATES: Record<string, { desc: string; layout: LayoutDoc['hub'] }> = {
  Minimal: { desc: 'Overview + services, nothing else', layout: { main: ['overview', 'services'], rail: [], hidden: ['weather', 'markets', 'news', 'bookmarks', 'activity'], sizes: {} } },
  Classic: { desc: 'Balanced home — the default', layout: { main: ['overview', 'services'], rail: ['weather', 'markets', 'news', 'activity'], hidden: ['bookmarks'], sizes: { overview: 'md', services: 'md', weather: 'md', markets: 'md', news: 'md', activity: 'md', bookmarks: 'md' } } },
  Media: { desc: 'Services first, quieter rail', layout: { main: ['services', 'overview'], rail: ['weather', 'activity'], hidden: ['markets', 'news', 'bookmarks'], sizes: { services: 'lg' } } },
  Monitoring: { desc: 'System lead, live rail', layout: { main: ['overview', 'services'], rail: ['activity', 'markets', 'weather'], hidden: ['news', 'bookmarks'], sizes: { activity: 'lg', overview: 'md' } } },
  Information: { desc: 'News and weather up front', layout: { main: ['services'], rail: ['news', 'weather', 'markets', 'bookmarks', 'activity'], hidden: ['overview'], sizes: { news: 'lg' } } },
  Full: { desc: 'Everything visible', layout: { main: ['overview', 'services'], rail: ['weather', 'markets', 'news', 'bookmarks', 'activity'], hidden: [], sizes: { news: 'lg', activity: 'lg', markets: 'lg', bookmarks: 'md', weather: 'md', overview: 'md', services: 'md' } } },
};

function HubTab() {
  const { layout, setLayout } = useLayout();
  const hidden = layout?.hub?.hidden ?? [];
  const allWidgets = ['weather', 'markets', 'news', 'bookmarks', 'activity'];
  if (!layout) return <p className="stale-note">Loading layout…</p>;
  const toggle = (w: string) => setLayout({ hub: { hidden: hidden.includes(w) ? hidden.filter((h) => h !== w) : [...hidden, w] } });
  return (
    <>
      <p className="lede">The Hub is a real page you arrange. Drag anywhere on the Hub to reorder — these controls are the precise version.</p>
      <Block title="Layout templates" aside={<span className="stale-note">presets, then fine-tune as you like</span>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginTop: 'var(--sp-2)' }}>
          {Object.entries(TEMPLATES).map(([name, t]) => (
            <button key={name} className="svc-tile" style={{ padding: 'var(--sp-4)' }} onClick={() => setLayout({ hub: { ...t.layout, sizes: { ...t.layout.sizes, ...(layout?.hub?.sizes || {}) } } })}>
              <div className="tile-name">{name}</div>
              <div className="tile-app">{t.desc}</div>
            </button>
          ))}
        </div>
      </Block>
      <Block title="Widgets" aside={<span className="stale-note">visible in the right rail of the Hub</span>}>
        {allWidgets.map((w) => (
          <Row key={w} label={w[0].toUpperCase() + w.slice(1)} desc={`Size: ${layout.hub.sizes?.[w] || 'md'}`} tight>
            <Segmented value={(layout.hub.sizes?.[w] || 'md') as 'sm' | 'md' | 'lg'} onChange={(v) => setLayout({ hub: { sizes: { [w]: v } } })} ariaLabel={`${w} size`}
              options={[{ value: 'sm', label: 'S' }, { value: 'md', label: 'M' }, { value: 'lg', label: 'L' }]} />
            <Switch checked={!hidden.includes(w)} onChange={() => toggle(w)} label={`Show ${w}`} />
          </Row>
        ))}
      </Block>
      <Block title="Data sources">
        <SourceRow label="News" path="/api/news" feeds />
        <SourceRow label="Weather" path="/api/weather" />
        <SourceRow label="Markets" path="/api/market" />
      </Block>
    </>
  );
}

function SourceRow({ label, path, feeds = false }: { label: string; path: string; feeds?: boolean }) {
  const { data } = usePolled<{ status: string; reason?: string; items?: unknown[] }>(path, 60_000);
  const s = data?.status;
  const color = s === 'ok' || s === 'partial' ? 'var(--ok)' : s === 'unconfigured' ? 'var(--ink-3)' : 'var(--warn)';
  return (
    <Row label={label} desc={feeds ? (s === 'unconfigured' ? 'No feeds — add some under Integrations.' : `status: ${s}`) : `status: ${s || '…'}`} tight>
      <span style={{ width: 8, height: 8, borderRadius: 9, background: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)` }} />
      <span className="mono-meta">{s || '…'}</span>
    </Row>
  );
}

/* ============ Services overlay editor ============ */
/**
 * What this editor edits is *presentation*, not infrastructure: an entry here can rename, file,
 * icon, order, hide, or re-URL a container that Docker actually reports. It cannot create one —
 * entries that match no container are listed under "unmatched" so they are fixable, not silent.
 */
interface DraftService {
  name: string; container: string | null; displayName: string | null; app: string | null;
  description: string | null; url: string | null; icon: string | null; group: string | null;
  order: number | null; hidden: boolean; showOnHub: boolean; keywords: string[]; meta: { label: string; value: string }[];
}
interface DraftGroup { name: string; description?: string | null; icon?: string | null; order?: number | null; services: DraftService[] }

const draftFromService = (s: Service): DraftService => ({
  name: s.container.composeService || s.name,
  container: s.name,
  displayName: s.configured ? s.displayName : null,
  app: s.app ?? null,
  description: s.description ?? null,
  url: s.urlSource === 'manual' ? s.url : null,
  icon: s.iconSource === 'config' ? s.icon : null,
  group: s.groupSource === 'config' ? s.group : null,
  order: null,
  hidden: false,
  showOnHub: true,
  keywords: s.keywords ?? [],
  meta: s.meta ?? [],
});

function ServicesTab() {
  const { data } = usePolled<ServicesDoc>('/api/services', 0);
  const { busy, err, okAt, save } = useSave();
  const [draft, setDraft] = useState<DraftGroup[] | null>(null);
  const [editing, setEditing] = useState<{ gi: number; si: number | null } | null>(null);
  const [iconFor, setIconFor] = useState<{ gi: number; si: number } | null>(null);
  const inventory = useMemo(() => data?.services ?? [], [data]);
  const bound = useMemo(() => new Set(inventory.filter((s) => s.configured).map((s) => s.name)), [inventory]);
  const groups = useMemo<DraftGroup[] | null>(() => {
    if (!data) return null;
    if (!draft) {
      return data.groups.map((g) => ({
        name: g.name,
        description: g.description ?? null,
        services: g.services.filter((s) => s.configured).map((s) => ({
          name: s.name, container: s.name, displayName: s.displayName, app: s.app, description: s.description,
          url: s.urlSource === 'manual' ? s.url : null, icon: s.icon, group: s.group, order: s.order ?? null,
          hidden: !!s.hidden, showOnHub: s.showOnHub !== false, keywords: s.keywords ?? [], meta: s.meta ?? [],
        })),
      })).filter((g) => g.services.length || g.description);
    }
    return draft;
  }, [data, draft]);
  if (!groups) return <p className="stale-note">Loading services.yaml…</p>;

  const dirty = !!draft;
  const commit = () => save(async () => {
    await put('/api/services', { groups: groups.map((g) => ({ ...g, services: g.services.map((s) => ({ ...s, group: undefined })) })) });
    setDraft(null);
  });
  const patchService = (gi: number, si: number, p: Partial<DraftService>) =>
    setDraft((d) => {
      const base = (d ?? groups) as DraftGroup[];
      const next = structuredClone(base);
      next[gi].services[si] = { ...next[gi].services[si], ...p };
      return next;
    });
  const addOverlay = (containerName: string) => setDraft((d) => {
    const next = structuredClone((d ?? groups) as DraftGroup[]);
    const svc = inventory.find((x) => x.name === containerName);
    if (!svc) return next;
    const gname = svc.group || 'Other';
    let gi = next.findIndex((g) => g.name === gname);
    if (gi < 0) { next.push({ name: gname, description: null, services: [] }); gi = next.length - 1; }
    if (next[gi].services.some((x) => x.container === containerName)) return next;
    next[gi].services.push(draftFromService(svc));
    return next;
  });
  const unbound = inventory.filter((s) => !bound.has(s.name));
  const unmatched = (data?.unmatched ?? []).filter((u) => u.kind === 'service');

  return (
    <>
      <p className="lede">
        This is a presentation layer over live discovery. Docker decides what exists;{' '}
        <span className="mono-meta">config/services.yaml</span> only decides how a container is
        named, filed, iconed and ordered.
        {dirty && <b style={{ color: 'var(--warn)' }}> · unsaved changes</b>}
      </p>
      {err && <p className="stale-note" style={{ color: 'var(--fail)' }}>{err}</p>}

      {!data?.live && (
        <ProviderNote
          status="unavailable"
          reason={data?.statusReason || 'Docker is not connected, so there is nothing to overlay. Connect the engine and every container appears here automatically.'}
          fixHref="/settings/system"
          fixLabel="Discovery status →"
        />
      )}

      {groups.map((g, gi) => (
        <Block
          key={g.name}
          title={g.name}
          aside={
            <span style={{ display: 'flex', gap: 'var(--sp-2)' }}>
              <button className="btn btn-quiet btn-sm" onClick={() => setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next[gi].services.push({ name: 'new', container: null, displayName: null, app: null, description: null, url: null, icon: null, group: null, order: null, hidden: false, showOnHub: true, keywords: [], meta: [] }); return next; })}>+ entry</button>
              <button className="btn btn-quiet btn-sm" onClick={() => setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next.splice(gi, 1); return next; })}>remove group</button>
            </span>
          }
        >
          <ul style={{ listStyle: 'none' }}>
            {g.services.map((s, si) => {
              const live = inventory.find((x) => x.name === s.container);
              const label = live ? (live.container.composeService || live.name) : s.container;
              return (
                <li key={`${s.container || s.name}-${si}`} style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: '9px 0', borderTop: '1px solid var(--hair)' }}>
                  <button className="icon-btn" style={{ width: 34, height: 34 }} title="Choose icon" onClick={() => setIconFor({ gi, si })}>
                    <Icon ref={s.icon || live?.icon} name={s.displayName || s.name} size={24} />
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 570 }}>
                      {s.displayName || live?.displayName || s.name}
                      {live && (s.displayName || live.displayName) !== label && <span className="stale-note"> · {label}</span>}
                    </div>
                    <div className="stale-note" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.container
                        ? <span className="mono-meta">container {s.container}</span>
                        : <i>not bound to a container — it will not be listed</i>}
                      {live?.url && <span className="mono-meta"> · {live.url.replace(/^https?:\/\//, '')} ({live.urlSource})</span>}
                      {!live?.url && s.url && <span className="mono-meta"> · {s.url.replace(/^https?:\/\//, '')} (manual)</span>}
                      {s.hidden ? <span> · hidden</span> : null}
                    </div>
                  </div>
                  {!live && s.container && <span className="chip" title={unmatched.find((u) => u.name === s.name)?.reason || 'no such container on this engine'}>not installed</span>}
                  <button className="btn btn-sm" onClick={() => setEditing({ gi, si })}>Edit</button>
                  <button className="btn btn-sm" title={`Remove ${s.name}`} onClick={() => setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next[gi].services.splice(si, 1); return next; })}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ width: 14, height: 14 }}><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
                  </button>
                </li>
              );
            })}
            {!g.services.length && <li className="stale-note" style={{ padding: '8px 0' }}>no overlays in this group yet — it only renders if a container matches</li>}
          </ul>
        </Block>
      ))}

      {unbound.length > 0 && (
        <Block title="Discovered, no overlay" aside={<span className="stale-note">{unbound.length} container{unbound.length === 1 ? '' : 's'} rendering with derived names and icons — fine to leave alone</span>}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {unbound.map((s) => (
              <button key={s.id} className="chip" title={`${s.container.image || ''} · ${s.url || s.urlNote || 'no url'}`} onClick={() => addOverlay(s.name)}>
                <Icon ref={s.icon} name={s.displayName} size={14} plain /> {s.displayName} · customize
              </button>
            ))}
          </div>
        </Block>
      )}

      {unmatched.length > 0 && (
        <Block title="Unmatched overlays" aside={<span className="stale-note">in services.yaml, but no container on this engine</span>}>
          <ul style={{ listStyle: 'none' }}>
            {unmatched.map((u, i) => (
              <li key={`${u.name}-${i}`} className="form-row" style={{ padding: '9px 0' }}>
                <div>
                  <div className="fr-label">{u.name}</div>
                  <div className="fr-desc">{u.reason}{u.container ? <span className="mono-meta"> · looked for container {u.container}</span> : null}</div>
                </div>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {inventory.length > 0 && (
                    <select
                      className="input"
                      style={{ width: 210 }}
                      value=""
                      aria-label={`Rebind ${u.name} to a container`}
                      onChange={(e) => { const v = e.target.value; if (v) addOverlay(v); }}
                    >
                      <option value="">bind to a live container…</option>
                      {inventory.map((s) => <option key={s.id} value={s.name}>{s.displayName} ({s.name})</option>)}
                    </select>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Block>
      )}

      <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center', marginTop: 'var(--sp-6)' }}>
        <button className="btn" onClick={() => setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next.push({ name: 'New group', description: null, services: [] }); return next; })}>+ group</button>
        <button className="btn btn-primary" onClick={commit} disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save to services.yaml'}</button>
        {dirty && <button className="btn btn-quiet" onClick={() => setDraft(null)}>Discard</button>}
        {okAt && !dirty && <span className="stale-note" style={{ color: 'var(--ok)' }}>saved {relTime(okAt)}</span>}
      </div>

      {editing && groups[editing.gi] && (
        <ServiceEditor
          group={groups[editing.gi].name}
          inventory={inventory}
          svc={groups[editing.gi].services[editing.si!]}
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            const { gi, si } = editing;
            if (si != null) patchService(gi, si, patch);
            else setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next[gi].services.push(patch as DraftService); setEditing(null); return next; });
            setEditing(null);
          }}
        />
      )}
      {iconFor && (
        <IconPickerModal
          initial={groups[iconFor.gi]?.services[iconFor.si]?.icon ?? null}
          onPick={(ref) => patchService(iconFor.gi, iconFor.si, { icon: ref })}
          onClose={() => setIconFor(null)}
        />
      )}
    </>
  );
}

function ServiceEditor({ group, svc, inventory, onSave, onClose }: { group: string; svc: DraftService; inventory: Service[]; onSave: (p: Partial<DraftService>) => void; onClose: () => void }) {
  const [form, setForm] = useState({ ...svc, keywordsText: (svc.keywords || []).join(', '), metaText: (svc.meta || []).map((m) => `${m.label}: ${m.value}`).join('\n') });
  const f = (k: string, v: unknown) => setForm((x) => ({ ...x, [k]: v }));
  const live = inventory.find((x) => x.name === form.container);
  return (
    <Modal title={`${svc.displayName || svc.name || 'New overlay'} — ${group}`} onClose={onClose}
      footer={
        <>
          <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => {
            onSave({
              name: (form.container || form.name || '').trim(),
              container: form.container?.trim() || null,
              displayName: form.displayName?.trim() || null, app: form.app?.trim() || null, description: form.description?.trim() || null,
              url: form.url?.trim() || null, icon: form.icon ?? null, group: form.group?.trim() || null,
              order: form.order, hidden: form.hidden, showOnHub: form.showOnHub,
              keywords: form.keywordsText.split(',').map((x: string) => x.trim()).filter(Boolean),
              meta: form.metaText.split('\n').map((l: string) => l.trim()).filter(Boolean).map((l: string) => { const [label, ...rest] = l.split(/[:=]\s*/); return { label: label.trim(), value: rest.join(': ').trim() }; }),
            });
          }}>Apply</button>
        </>
      }
    >
      <div className="field">
        <label>Container <span className="hint">(what this overlay is about — required for it to show anywhere)</span></label>
        <input className="input mono-meta" list="opus-live-containers" value={form.container || ''} onChange={(e) => f('container', e.target.value)} placeholder={live ? live.name : 'start typing a running container'} />
        <datalist id="opus-live-containers">
          {inventory.map((s) => <option key={s.id} value={s.name}>{`${s.displayName} · ${s.container.state}`}</option>)}
        </datalist>
        {form.container && !live && <p className="stale-note" style={{ color: 'var(--warn)' }}>no container named “{form.container}” on this engine — this entry will be reported as unmatched, and no service will appear.</p>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 var(--sp-5)' }}>
        <div className="field"><label>Display name</label><input className="input" value={form.displayName || ''} onChange={(e) => f('displayName', e.target.value)} placeholder={live ? live.displayName : 'derived from the container'} /></div>
        <div className="field"><label>Group</label><input className="input" value={form.group || ''} onChange={(e) => f('group', e.target.value)} placeholder={live?.group || 'Other'} /></div>
      </div>
      <div className="field"><label>App / software <span className="hint">(shown as identity; the image is the default)</span></label><input className="input" value={form.app || ''} onChange={(e) => f('app', e.target.value)} /></div>
      <div className="field"><label>Description</label><input className="input" value={form.description || ''} onChange={(e) => f('description', e.target.value)} /></div>
      <div className="field">
        <label>URL override <span className="hint">(optional — wins over Traefik and published ports)</span></label>
        <input className="input mono-meta" value={form.url || ''} onChange={(e) => f('url', e.target.value)} placeholder={live && live.url ? `discovered: ${live.url}` : 'leave empty to use what the engine says'} />
        {live?.url && !form.url && (
          <p className="stale-note">discovered from {live.urlSource === 'traefik' ? 'Traefik metadata' : live.urlSource === 'published-port' ? 'a published port' : 'config'} · <span className="mono-meta">{live.url}</span></p>
        )}
        {!live?.url && !form.url && <p className="stale-note">{live?.urlNote || 'this container has no web endpoint — it will read “No web endpoint detected”, which is honest, not broken'}</p>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 var(--sp-5)' }}>
        <div className="field"><label>Order in group</label><input type="number" className="input" value={form.order ?? ''} onChange={(e) => f('order', e.target.value === '' ? null : Number(e.target.value))} /></div>
        <div className="field"><label>Visibility</label>
          <div style={{ display: 'flex', gap: 'var(--sp-4)', alignItems: 'center', paddingTop: 6 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={form.hidden} onChange={(e) => f('hidden', e.target.checked)} /> hide everywhere</label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={form.showOnHub} onChange={(e) => f('showOnHub', e.target.checked)} /> show on Hub</label>
          </div>
        </div>
      </div>
      <div className="field"><label>Keywords (comma separated)</label><input className="input" value={form.keywordsText} onChange={(e) => f('keywordsText', e.target.value)} /></div>
      <div className="field"><label>Notes / meta — one per line as <span className="mono-meta">Label: value</span></label><textarea className="textarea" rows={3} value={form.metaText} onChange={(e) => f('metaText', e.target.value)} /></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-4)' }}>
        <Icon ref={form.icon || live?.icon} name={form.displayName || form.name || 'svc'} size={40} />
        <span className="stale-note">current icon — set it from the list so it overrides the derived one</span>
      </div>
    </Modal>
  );
}

/* ============ Bookmarks ============ */
interface BmGroup { name: string; items: { name: string; href: string; description?: string | null }[] }
function BookmarksTab() {
  const { data } = usePolled<{ groups: BmGroup[] }>('/api/bookmarks', 0);
  const { busy, err, save } = useSave();
  const [draft, setDraft] = useState<BmGroup[] | null>(null);
  const groups = draft ?? data?.groups ?? [];
  if (!data && !draft) return <p className="stale-note">Loading bookmarks…</p>;
  return (
    <>
      <p className="lede">Flat links, no icons machinery, no status. They appear in search and can be shown on the Hub later.</p>
      {err && <p className="stale-note" style={{ color: 'var(--fail)' }}>{err}</p>}
      {groups.map((g, gi) => (
        <Block key={g.name + gi} title={g.name} aside={
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-quiet btn-sm" onClick={() => setDraft(cloneAt(groups, (d) => d[gi].items.push({ name: 'New', href: 'https://' })))}>+ link</button>
            <button className="btn btn-quiet btn-sm" onClick={() => setDraft(cloneAt(groups, (d) => d.splice(gi, 1)))}>remove</button>
          </span>
        }>
          <ul style={{ listStyle: 'none' }}>
            {g.items.map((b, bi) => (
              <li key={bi} style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto auto', gap: 'var(--sp-3)', alignItems: 'center', padding: '7px 0', borderTop: '1px solid var(--hair)' }}>
                <input className="input" value={b.name} onChange={(e) => setDraft(cloneAt(groups, (d) => { d[gi].items[bi].name = e.target.value; }))} aria-label="Bookmark name" />
                <input className="input mono-meta" value={b.href} onChange={(e) => setDraft(cloneAt(groups, (d) => { d[gi].items[bi].href = e.target.value; }))} aria-label="Bookmark URL" />
                <button className="btn btn-quiet btn-sm" onClick={() => { window.open(b.href, '_blank', 'noreferrer'); }}>Open</button>
                <button className="icon-btn" aria-label="Remove" onClick={() => setDraft(cloneAt(groups, (d) => d[gi].items.splice(bi, 1)))}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
                </button>
              </li>
            ))}
            {!g.items.length && <li className="stale-note" style={{ padding: 8 }}>no links here yet</li>}
          </ul>
        </Block>
      ))}
      <div style={{ display: 'flex', gap: 'var(--sp-3)', marginTop: 'var(--sp-6)' }}>
        <button className="btn" onClick={() => setDraft(cloneAt(groups, (d) => d.push({ name: 'New group', items: [] })))}>+ group</button>
        <button className="btn btn-primary" disabled={!draft || busy} onClick={async () => { await save(async () => { await put('/api/bookmarks', { groups }); setDraft(null); }); }}>Save bookmarks.yaml</button>
        {draft && <button className="btn btn-quiet" onClick={() => setDraft(null)}>Discard</button>}
      </div>
    </>
  );
}
function cloneAt<T>(arr: T[], mutate: (copy: T[]) => void): T[] { const c = structuredClone(arr); mutate(c); return c; }

/* ============ Discovery diagnostics ============ */
const URL_SOURCE_LABEL: Record<string, string> = {
  manual: 'manual overrides',
  traefik: 'Traefik metadata',
  'published-port': 'published ports',
  none: 'no web endpoint',
};

function DiscoveryBlock({ health }: { health: HealthDoc | null | undefined }) {
  const { data, refresh, fetchedAt } = usePolled<DiscoveryDoc>('/api/discovery', 30_000);
  const { settings, update } = useSettings();
  const { busy, save } = useSave();
  const eng = data?.engine;
  const url = data?.urlDiscovery;
  const counts = [
    { k: 'Containers', v: eng?.containers },
    { k: 'Running', v: eng?.running },
    { k: 'Stopped', v: eng?.stopped },
    { k: 'Applications', v: data?.inventory.applications },
    { k: 'Infrastructure', v: data?.inventory.infrastructure },
    { k: 'Stacks', v: data?.inventory.stacks },
  ];
  const sources = url ? Object.entries(url.sources).sort((a, b) => b[1]! - a[1]!) : [];
  return (
    <Block title="Service discovery" aside={<span className="stale-note">{fetchedAt ? `checked ${relTime(fetchedAt)}` : 'reading the engine…'}</span>}>
      <Row label="Docker engine" desc="What the Services, Hub and Stacks pages are built from." tight>
        <span className="mono-meta" style={{ color: eng?.ok ? 'var(--ok)' : 'var(--ink-3)' }}>
          {eng?.ok
            ? `connected · engine ${eng.version || '?'}${eng.api ? ` · API ${eng.api}` : ''}`
            : health?.providers.docker.reason || eng?.state || '…'}
        </span>
      </Row>

      {eng?.ok && (
        <div className="stat-strip" style={{ margin: 'var(--sp-3) 0 var(--sp-5)' }}>
          {counts.map((c) => (
            <div className="stat" key={c.k}>
              <div className="stat-k">{c.k}</div>
              <div className="stat-v">{c.v ?? '—'}</div>
            </div>
          ))}
        </div>
      )}

      <Row label="URL discovery" desc="Where each service’s clickable address comes from — the first source that answers wins.">
        <span className="mono-meta" style={{ textAlign: 'right' }}>
          {sources.length
            ? sources.map(([k, n]) => `${n} ${URL_SOURCE_LABEL[k] || k}`).join(' · ')
            : 'nothing resolved yet'}
        </span>
      </Row>

      <Row label="Host address" desc="Only used for published-port URLs. Leave empty to detect it from this machine — never guessed, and nothing is ever assumed to live on a particular domain.">
        <input
          className="input mono-meta"
          style={{ width: 230 }}
          defaultValue={settings?.infrastructure?.hostAddress || ''}
          placeholder={url?.hostAddress ? `auto: ${url.hostAddress}` : 'e.g. 10.0.0.5'}
          aria-label="Host address for published ports"
          onBlur={(e) => update({ infrastructure: { hostAddress: e.target.value.trim() || null } }, true)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        <span className="stale-note">{url?.hostAddress ? `using ${url.hostAddress} (${url.hostAddressSource})` : 'not detected'}</span>
      </Row>

      <Row label="Proxy entrypoint ports" desc="Optional: only needed when your Traefik entrypoint is not reachable on 80/443, e.g. web=8080. Traefik’s own metadata supplies everything else." tight>
        <input
          className="input mono-meta"
          style={{ width: 230 }}
          defaultValue={Object.entries(settings?.infrastructure?.entrypointPorts || {}).map(([k, v]) => `${k}=${v}`).join(', ')}
          placeholder="web=8080, websecure=8443"
          aria-label="Entrypoint port map"
          onBlur={(e) => {
            const map: Record<string, string> = {};
            for (const part of e.target.value.split(/[,\n]/)) {
              const [k, v] = part.split('=').map((x) => x.trim());
              if (k && v) map[k] = v;
            }
            update({ infrastructure: { entrypointPorts: map } }, true);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </Row>

      <Row label="Presentation overlays" desc="How much of what you see comes from config rather than from the engine itself." tight>
        <span className="mono-meta">
          {data
            ? [
              `${data.overlays.serviceOverlays}${data.overlays.serviceEntries != null && data.overlays.serviceEntries !== data.overlays.serviceOverlays ? ` of ${data.overlays.serviceEntries}` : ''} service entries bound`,
              `${data.overlays.stackOverlays}${data.overlays.stackEntries != null && data.overlays.stackEntries !== data.overlays.stackOverlays ? ` of ${data.overlays.stackEntries}` : ''} stack entries bound`,
              data.overlays.skipped ? `${data.overlays.skipped} unreadable` : null,
            ].filter(Boolean).join(' · ')
            : '…'}
        </span>
      </Row>

      <Row label="Last discovery" tight>
        <span className="mono-meta">{data?.discoveredAt ? new Date(data.discoveredAt).toLocaleTimeString() : '—'}</span>
        <button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => save(async () => { await post('/api/discovery/refresh'); refresh(); })}>
          {busy ? 'Looking…' : 'Re-discover now'}
        </button>
      </Row>

      {!!(data?.overlays.unmatchedList?.length) && (
        <div style={{ marginTop: 'var(--sp-4)', paddingTop: 'var(--sp-4)', borderTop: '1px solid var(--line)' }}>
          <p className="stale-note" style={{ color: 'var(--warn)' }}>
            {data.overlays.unmatchedList.length} overlay {data.overlays.unmatchedList.length === 1 ? 'entry describes' : 'entries describe'} nothing on this engine. They are reported, never rendered — a config entry cannot make a service exist.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 'var(--sp-2) 0 0', display: 'grid', gap: 4 }}>
            {data.overlays.unmatchedList.map((u) => (
              <li key={`${u.kind}:${u.name}`} className="mono-meta" style={{ fontSize: 12.5 }}>
                <span style={{ color: 'var(--ink-3)' }}>{u.kind}</span> {u.name}
                {u.container ? ` → ${u.container}` : ''}
                <span className="muted"> · {u.reason}</span>
              </li>
            ))}
          </ul>
          <Link className="btn btn-quiet btn-sm" to="/settings/services" style={{ alignSelf: 'start', marginTop: 'var(--sp-3)' }}>
            Fix the overlays
          </Link>
        </div>
      )}
    </Block>
  );
}

/* ============ Integrations ============ */
const FEED_SUGGESTIONS = [
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { name: 'r/selfhosted', url: 'https://www.reddit.com/r/selfhosted.rss' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
];
const SYMBOL_SUGGESTIONS = ['AAPL', 'NVDA', 'MSFT', 'TSLA', 'RELIANCE.NS', 'TCS.NS', '^NSEI', '^NIFTYSMLCAP'];

function IntegrationsTab() {
  const { settings, update } = useSettings();
  const intg = settings?.integrations;
  if (!settings || !intg) return <p className="stale-note">Loading…</p>;
  const [feedUrl, setFeedUrl] = useState('');
  const [sym, setSym] = useState('');
  const feeds = intg.news.feeds || [];
  const symbols = intg.markets.symbols || [];
  return (
    <>
      <p className="lede">Everything here is user configuration — OpusHub ships no defaults and never invents values. Each widget shows its real provider state.</p>

      <Block title="News" aside={<Link className="section-link" to="/">test it on the Hub →</Link>}>
        <div className="editor-list">
          {feeds.map((f, i) => (
            <div className="editor-item" key={i}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontWeight: 560 }}>{f.name || URLSafe(f.url)}</b>
                <div className="stale-note mono-meta" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.url}</div>
              </span>
              <button className="icon-btn" aria-label="Remove feed" onClick={() => update({ integrations: { news: { feeds: feeds.filter((_, j) => j !== i) } } })}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
              </button>
            </div>
          ))}
          {!feeds.length && <div className="editor-item stale-note">No feeds yet.</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 'var(--sp-3)' }}>
          <input className="input" style={{ flex: 1 }} placeholder="https://example.com/feed.xml" value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} aria-label="Feed URL" />
          <button className="btn" disabled={!feedUrl.trim()} onClick={() => { update({ integrations: { news: { feeds: [...feeds, { url: feedUrl.trim(), name: null }] } } }, true); setFeedUrl(''); }}>Add</button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'var(--sp-3)' }}>
          {FEED_SUGGESTIONS.filter((s) => !feeds.some((f) => f.url === s.url)).map((s) => (
            <button key={s.url} className="chip" onClick={() => update({ integrations: { news: { feeds: [...feeds, s] } } }, true)}>+ {s.name}</button>
          ))}
        </div>
      </Block>

      <Block title="Weather">
        <Row label="Location" desc="City name or explicit coordinates — used with Open-Meteo (keyless)." tight>
          <input className="input" style={{ width: 240 }} defaultValue={intg.weather.location || ''} placeholder="Amsterdam" aria-label="Weather location"
            onBlur={(e) => update({ integrations: { weather: { location: e.target.value.trim() || null } } }, true)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </Row>
        <Row label="Units" tight>
          <Segmented value={intg.weather.units} onChange={(v) => update({ integrations: { weather: { units: v } } }, true)} ariaLabel="Units"
            options={[{ value: 'c', label: '°C' }, { value: 'f', label: '°F' }]} />
        </Row>
      </Block>

      <Block title="Markets" aside={<span className="stale-note">Stooq symbol syntax — bare tickers assume US, use <code>.NS</code> for NSE</span>}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 'var(--sp-3)' }}>
          {symbols.map((s, i) => (
            <span className="chip" key={s}>
              {s}
              <button className="x" aria-label={`Remove ${s}`} onClick={() => update({ integrations: { markets: { symbols: symbols.filter((_, j) => j !== i) } } }, true)}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
              </button>
            </span>
          ))}
          {!symbols.length && <span className="stale-note">No symbols configured.</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" style={{ width: 200 }} placeholder="AAPL, RELIANCE.NS…" value={sym} onChange={(e) => setSym(e.target.value)} aria-label="Add symbol" />
          <button className="btn" disabled={!sym.trim()} onClick={() => {
            const add = sym.toUpperCase().split(/[,\s]+/).filter(Boolean).filter((x) => !symbols.includes(x));
            if (add.length) update({ integrations: { markets: { symbols: [...symbols, ...add] } } }, true);
            setSym('');
          }}>Add</button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'var(--sp-3)' }}>
          {SYMBOL_SUGGESTIONS.filter((s) => !symbols.includes(s)).map((s) => (
            <button key={s} className="chip" onClick={() => update({ integrations: { markets: { symbols: [...symbols, s] } } }, true)}>+ {s}</button>
          ))}
        </div>
      </Block>
    </>
  );
}
function URLSafe(u: string) { try { return new URL(u).host; } catch { return u.slice(0, 30); } }

/* ============ System ============ */
function SystemTab() {
  const { settings, update } = useSettings();
  const { data: health } = usePolled<HealthDoc>('/api/health', 0);
  const { data: custom } = usePolled<{ cssEnabled: boolean; jsEnabled: boolean; css: string | null; jsPresent: boolean }>('/api/custom', 0);
  const { save, busy, err } = useSave();
  const [cssText, setCssText] = useState<string | null>(null);
  return (
    <>
      <p className="lede">Where OpusHub is plugged in. All paths are resolved at startup and logged on the server.</p>
      <Block title="Configuration">
        <Row label="Config directory" tight><span className="mono-meta">{health?.configDir || '…'}</span></Row>
        <Row label="Data directory" tight><span className="mono-meta">{health?.dataDir || '…'}</span></Row>
        <Row
          label=".env discovery"
          desc="Order: $OPUSHUB_ENV_FILE → config/.env → ./.env → $HOMEPAGE_DIR/.env → /app/config/.env. First hit wins; real env vars always beat files. Values never reach the browser."
        >
          <span className="mono-meta">
            {health?.env.files.length
              ? health.env.files.map((f) => `${f.file.split('/').slice(-2).join('/')} (${f.keys.length} key${f.keys.length === 1 ? '' : 's'}${f.error ? ' — ' + f.error : ''})`).join(' · ')
              : 'none found — keys fall through to process.env only'}
          </span>
        </Row>
        <Row label="Runtime" tight><span className="mono-meta">OpusHub {health?.version || '0.1'} · node {health?.node || '…'} · {health?.platform || ''}</span></Row>
      </Block>

      <DiscoveryBlock health={health} />

      <Block title="Behavior">
        <Row label="Log service launches" desc="Adds an Activity event when you open a service from OpusHub." tight>
          <Switch checked={settings?.behavior.logLaunches ?? true} onChange={(v) => update({ behavior: { logLaunches: v } }, true)} label="Log launches" />
        </Row>
        <Row label="System refresh" desc="Seconds between host metric polls." tight>
          <input type="number" min={2} max={300} className="input" style={{ width: 90 }} defaultValue={settings?.behavior.refresh.system}
            onBlur={(e) => update({ behavior: { refresh: { system: Math.max(2, Number(e.target.value) || 5) } } }, true)} aria-label="System refresh seconds" />
        </Row>
        <Row label="Services refresh" desc="Containers are polled gently — Docker API calls are not free." tight>
          <input type="number" min={5} max={600} className="input" style={{ width: 90 }} defaultValue={settings?.behavior.refresh.services}
            onBlur={(e) => update({ behavior: { refresh: { services: Math.max(5, Number(e.target.value) || 30) } } }, true)} aria-label="Services refresh seconds" />
        </Row>
      </Block>

      <Block title="Custom CSS & JS" aside={<span className="stale-note">files live next to services.yaml</span>}>
        <Row label="theme.css" desc="Homepage-style custom CSS. Linked into every page when enabled." tight>
          <Switch checked={custom?.cssEnabled ?? false} onChange={(v) => update({ advanced: { customCss: v } }, true)} label="Enable custom CSS" />
        </Row>
        <Row label="app.js" desc="Custom JS, same-origin. Enable deliberately — it runs on every page." tight>
          <Switch checked={custom?.jsEnabled ?? false} onChange={(v) => update({ advanced: { customJs: v } }, true)} label="Enable custom JS" />
        </Row>
        {(custom?.cssEnabled) && (
          <div className="field" style={{ marginTop: 'var(--sp-4)' }}>
            <label>config/theme.css</label>
            <textarea className="textarea" rows={8} value={cssText ?? custom?.css ?? ''} onChange={(e) => setCssText(e.target.value)} />
            <span>
              <button className="btn btn-sm" disabled={busy} onClick={() => save(async () => { await put('/api/custom', { css: cssText ?? '' }); setCssText(null); })}>{busy ? 'Saving…' : 'Save theme.css'}</button>
              {err && <span className="stale-note" style={{ color: 'var(--fail)', marginLeft: 10 }}>{err}</span>}
            </span>
          </div>
        )}
      </Block>
    </>
  );
}


