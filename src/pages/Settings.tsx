import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, invalidateShared, post, put, usePolled, useSave } from '../lib/api';
import { relTime } from '../lib/format';
import { useLayout, useSettings, type DeepPartial } from '../lib/theme';
import { useAuth } from '../lib/auth';
import type {
  AlertsDoc, CustomDoc, DiscoveryDoc, HealthDoc, LayoutDoc, ProvidersDoc, Service, ServicesDoc, SettingsDoc, StacksDoc, TemplateEntry,
  TemplatesDoc, WidgetCatalogueEntry, WidgetDoc, WidgetInstance, WidgetZone,
} from '../lib/types';
import { Icon } from '../components/Icon';
import { IconPickerModal } from '../components/IconPicker';
import { Loading, Menu, MenuButton, type MenuItem, Modal, PageHero, ProviderNote, Segmented, StatusLine, Switch } from '../components/ui';
import { GroupNameField } from '../components/GroupNameField';
import { checkGroupName, renameGroupAt, uniqueGroupName } from '../lib/groupName';
import { Sortable } from '../components/Sortable';
import { Block, Row } from './settings/parts';
import { ConfigurationTab, ExportTab, HistoryTab, ImportTab } from './settings/Configuration';
import { OperationsSettingsTab } from './settings/Operations';
import { MonitoringSettingsTab } from './settings/Monitoring';
import ConnectionsTab from './settings/Connections';
import { HubPreview } from '../components/hub/HubPreview';
import {
  addWidget, configSummary, hiddenWidgets, moveWidget, removeWidget, setSpacing, setWidget, visibleInZone,
} from '../lib/hubLayout';
import {
  assignGroup, clearGroup, ensureOverlay, overlayFromInventory, removeEntry, removeGroup,
  saveOverlay, setGroupDescription, setGroupIcon, setIcon, type DraftGroup, type DraftService,
} from '../lib/overlay';

/**
 * The settings map. `section` is what the nav groups by — the ten surfaces this app actually has,
 * in the order they matter: who you are, how it looks, what it shows, how you get in, what it is
 * connected to, and the escape hatch.
 *
 * The panes themselves are unchanged by the grouping (nothing was rebuilt, only filed): every
 * route that existed before still exists at the same URL, so old bookmarks and the command palette
 * keep working. `system` is kept as an alias of `environment`, which is what it always described.
 */
// The settings information architecture: five groups, thirteen panes. Panes stay where they were —
// only their headings are new — so nothing an operator learned in Phase 4 moved.
//   Home          what this install is and how it looks
//   Hub           the composition of the front page
//   Content       what is presented, and how it is grouped
//   Connections   the outside world (feeds, weather, markets)
//   This install  the engine, the account and the escape hatches
const TABS = [
  { id: 'general', label: 'General', section: 'Home' },
  { id: 'appearance', label: 'Appearance', section: 'Home' },
  { id: 'background', label: 'Background', section: 'Home' },
  { id: 'hub', label: 'Hub layout', section: 'Hub' },
  { id: 'widgets', label: 'Widgets', section: 'Hub' },
  { id: 'templates', label: 'Templates', section: 'Hub' },
  { id: 'services', label: 'Services', section: 'Content' },
  { id: 'groups', label: 'Groups', section: 'Content' },
  { id: 'bookmarks', label: 'Bookmarks', section: 'Content' },
  { id: 'integrations', label: 'Integrations', section: 'Connections' },
  { id: 'notifications', label: 'Notifications', section: 'Connections' },
  // Phase 9 — the OpusGrid providers: what is connected, what it can do, and what it cannot
  { id: 'connections', label: 'Connections', section: 'Connections' },
  { id: 'import', label: 'Import & migration', section: 'Configuration' },
  { id: 'history', label: 'History', section: 'Configuration' },
  { id: 'export', label: 'Export', section: 'Configuration' },
  { id: 'configuration', label: 'Scope', section: 'Configuration' },
  { id: 'environment', label: 'Environment', section: 'This install' },
  // Phase 10A — the monitoring defaults, their server-side bounds, and the monitors that exist
  { id: 'monitoring', label: 'Monitoring', section: 'This install' },
  // Phase 8 — informational: what the operations engine is, what it may do, and what it refuses
  { id: 'operations', label: 'Operations', section: 'This install' },
  { id: 'authentication', label: 'Account & sessions', section: 'This install' },
  { id: 'advanced', label: 'Advanced', section: 'This install' },
];

/** Old route → current route. Nothing that worked before may 404 now. */
const TAB_ALIAS: Record<string, string> = { system: 'environment' };

/** Tabs where seeing the result is the point. */
const PREVIEW_TABS = new Set(['appearance', 'background', 'hub', 'widgets', 'templates']);

const SECTIONS = [...new Set(TABS.map((t) => t.section))];

export default function SettingsPage() {
  const params = useParams();
  const raw = params.tab ?? 'general';
  const tab = TAB_ALIAS[raw] ?? raw;
  const nav = useNavigate();
  const [previewTemplate, setPreviewTemplate] = useState<TemplateEntry | null>(null);
  const { layout } = useLayout();
  const showPreview = PREVIEW_TABS.has(tab);

  return (
    <>
      <PageHero
        title="Settings"
        desc="Everything here is presentation: OpusHub reads your infrastructure and never writes to it. Changes save themselves to config/*.yaml as you make them."
      />
      <div className={`settings-grid${showPreview ? ' settings-grid--preview' : ''}`}>
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((section) => (
            <div className="settings-nav-group" key={section}>
              <div className="settings-nav-label" aria-hidden="true">{section}</div>
              {TABS.filter((t) => t.section === section).map((t) => (
                <Link key={t.id} to={`/settings/${t.id}`} className={t.id === tab ? 'active' : ''} aria-current={t.id === tab ? 'page' : undefined}>{t.label}</Link>
              ))}
            </div>
          ))}
          <Link to="/icons" style={{ marginTop: 'var(--sp-4)' }}>Icon browser</Link>
        </nav>
        <div className="settings-pane">
          {showPreview && (
            <div className="settings-preview">
              <HubPreview
                layout={previewTemplate ? previewTemplate.preview : layout}
                label={previewTemplate ? `previewing “${previewTemplate.name}” — not applied yet` : 'updates as you change settings'}
                height={400}
              />
              {previewTemplate && (
                <button className="btn btn-quiet btn-sm settings-preview-clear" onClick={() => setPreviewTemplate(null)}>
                  Stop previewing “{previewTemplate.name}”
                </button>
              )}
            </div>
          )}
          {tab === 'general' && <GeneralTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'background' && <BackgroundTab />}
          {tab === 'hub' && <HubTab />}
          {tab === 'widgets' && <WidgetsTab />}
          {tab === 'templates' && <TemplatesTab onPreview={setPreviewTemplate} />}
          {tab === 'services' && <ServicesTab />}
          {tab === 'groups' && <GroupsTab />}
          {tab === 'bookmarks' && <BookmarksTab />}
          {tab === 'integrations' && <IntegrationsTab />}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'connections' && <ConnectionsTab />}
          {tab === 'authentication' && <AuthenticationTab />}
          {tab === 'environment' && <EnvironmentTab />}
          {tab === 'monitoring' && <MonitoringSettingsTab />}
          {tab === 'operations' && <OperationsSettingsTab />}
          {tab === 'advanced' && <AdvancedTab />}
          {tab === 'import' && <ImportTab />}
          {tab === 'history' && <HistoryTab />}
          {tab === 'export' && <ExportTab />}
          {tab === 'configuration' && <ConfigurationTab />}
          {!TABS.some((t) => t.id === tab) && (
            <p className="stale-note">Unknown section. <button className="section-link" onClick={() => nav('/settings/appearance')}>Go to Appearance →</button></p>
          )}
        </div>
      </div>
    </>
  );
}

/* ============ row primitives ============ */

/* ============ General ============ */
/**
 * Identity, not decoration: what this install calls itself, and the two lines of state the Hub
 * greets you with. Nothing here is infrastructure — the name is a string in settings.yaml.
 */
function GeneralTab() {
  const { settings, update } = useSettings();
  const { layout } = useLayout();
  const { data: health } = usePolled<HealthDoc>('/api/health', 0);
  if (!settings) return <Loading what="settings.yaml" />;
  return (
    <>
      <p className="lede">
        What this install calls itself and who it greets. The name is presentation only — it never
        changes how anything is discovered or addressed.
      </p>

      <Block title="Identity" aside={<span className="stale-note">settings.yaml → app</span>}>
        <Row label="Name" desc="The browser tab, on every page. `tagline` also lives in settings.yaml for Homepage-compatible files but is not rendered anywhere.">
          <input className="input" style={{ maxWidth: 240 }} defaultValue={settings.app.name} aria-label="App name"
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== settings.app.name) update({ app: { name: v } }); else e.target.value = settings.app.name; }} />
        </Row>
        <Row label="Greeting name" desc="Who the Hub says good morning to.">
          <input className="input" style={{ maxWidth: 220 }} defaultValue={settings.hub.greetingName || ''} placeholder="(none)" aria-label="Greeting name"
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => update({ hub: { greetingName: e.target.value.trim() || null } })} />
        </Row>
        <Row label="24-hour clock" tight><Switch checked={settings.hub.clock24h} onChange={(v) => update({ hub: { clock24h: v } })} label="24-hour clock" /></Row>
      </Block>

      <Block title="This install" aside={<span className="stale-note">read-only</span>}>
        <Row label="Version" tight><span className="mono-meta">OpusHub {health?.version || '0.1.0'} · node {health?.node || '…'}</span></Row>
        <Row label="Configured widgets" tight><span className="mono-meta">{layout?.hub.widgets.length ?? 0} instance(s)</span></Row>
        <Row label="Where the files live" desc="Presentation in config/, account and history in data/ — both mounted, never baked into the image.">
          <Link className="btn btn-sm" to="/settings/environment">Environment</Link>
        </Row>
      </Block>
    </>
  );
}

/* ============ Authentication ============ */
interface SessionRow {
  id: string; createdAt: number; lastSeenAt: number; expiresAt: number; idleExpiresAt: number;
  ip: string | null; current: boolean;
}
interface SessionsDoc {
  sessions: SessionRow[]; count: number; current: SessionRow | null;
  limits: { absoluteMs: number; idleMs: number; max: number };
}

/**
 * The account surface. Two things only, both real: the password, and what is currently signed in.
 *
 * Every value that could be a credential is absent by construction — the session list carries
 * derived handles (the server hashes the token and truncates it), and neither this pane nor the
 * API it reads can see a token or a hash. Revoking is by handle, so a compromised browser can be
 * cut off from here without ever printing what it holds.
 */
function AuthenticationTab() {
  const { user, refresh } = useAuth();
  const { data, refresh: reload } = usePolled<SessionsDoc>('/api/auth/sessions', 30_000);
  const { save, busy, err } = useSave();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    setProblem(null); setNote(null);
    if (next.length < 8) { setProblem('Choose a password of at least 8 characters.'); return; }
    if (next !== confirm) { setProblem('The two passwords do not match.'); return; }
    const r = await save(async () => {
      await post<{ revoked: number }>('/api/auth/password', { currentPassword: current, newPassword: next });
      return true;
    });
    if (r) {
      setCurrent(''); setNext(''); setConfirm('');
      setNote('Password changed. Other sessions were signed out.');
      reload(); void refresh();
    }
  };

  const revoke = (body: { scope: string; id?: string }) => save(async () => {
    const r = await post<{ revoked: number; signedOut: boolean }>('/api/auth/sessions/revoke', body);
    if (r?.signedOut) { window.location.reload(); return r; }
    setNote(`Revoked ${r?.revoked ?? 0} session(s).`);
    reload();
    return r;
  });

  const when = (ms: number) => new Date(ms).toLocaleString();
  const age = (ms: number) => relTime(ms);

  return (
    <>
      <p className="lede">
        One local account guards this Hub, and sessions live on the server — the browser only holds an
        opaque cookie it cannot read. Nothing on this page is a credential: the list below identifies
        sessions by a derived handle, never by the token itself.
      </p>

      <Block title="Account" aside={<span className="stale-note">stored in data/auth.json</span>}>
        <Row label="Username" tight><span className="mono-meta">{user?.username || '—'}</span></Row>
        <Row label="Password hashing" desc="scrypt with a per-account salt. The hash never leaves the server and is never logged." tight>
          <span className="mono-meta">scrypt · N=32768 · r=8 · p=1</span>
        </Row>
        <Row label="Recovery" desc="A forgotten password is a host-level action: stop the container, remove data/auth.json, start it again — the wizard returns. Nothing else can reset it." tight>
          <span className="stale-note">data/auth.json</span>
        </Row>
      </Block>

      <Block title="Change password">
        <div className="field">
          <label htmlFor="pw-current">Current password</label>
          <input id="pw-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pw-new">New password</label>
          <input id="pw-new" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          <span className="hint">At least 8 characters. Changing it signs every other browser out and rotates this one.</span>
        </div>
        <div className="field">
          <label htmlFor="pw-confirm">Confirm new password</label>
          <input id="pw-confirm" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--sp-4)', alignItems: 'center', marginTop: 'var(--sp-2)' }}>
          <button className="btn btn-primary btn-sm" disabled={busy || !current || !next} onClick={() => void submit()}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
          {note && <span className="stale-note" role="status">{note}</span>}
          {(problem || err) && <span className="stale-note" role="alert" style={{ color: 'var(--fail)' }}>{problem || err}</span>}
        </div>
      </Block>

      <Block
        title="Signed-in sessions"
        aside={data ? <span className="stale-note">{data.count} of {data.limits.max} · expires after {Math.round(data.limits.absoluteMs / 86400000)} days, or {Math.round(data.limits.idleMs / 86400000)} days idle</span> : undefined}
      >
        {!data && <Loading what="signed-in browsers" />}
        {data?.sessions.map((s) => (
          <div className="session-row" key={s.id}>
            <div style={{ minWidth: 0 }}>
              <div className="session-head">
                {s.current ? 'This browser' : 'Another browser'}
                {s.current && <span className="chip tl-src">current</span>}
              </div>
              <div className="stale-note">
                signed in {age(s.createdAt)} · last seen {age(s.lastSeenAt)} · expires {when(s.expiresAt)}
                {s.ip ? ` · ${s.ip}` : ''}
              </div>
              <div className="mono-meta" style={{ fontSize: 11, opacity: 0.65 }}>handle {s.id}</div>
            </div>
            <button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => void revoke({ scope: 'one', id: s.id })}>
              {s.current ? 'Sign out' : 'Revoke'}
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 'var(--sp-3)', marginTop: 'var(--sp-4)', flexWrap: 'wrap' }}>
          <button className="btn btn-sm" disabled={busy || (data?.count ?? 0) < 2} onClick={() => void revoke({ scope: 'others' })}>
            Sign out other browsers
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => void revoke({ scope: 'all' })}>Sign out everywhere</button>
          <button className="btn btn-quiet btn-sm" onClick={reload}>Refresh</button>
          {err && <span className="stale-note" style={{ color: 'var(--fail)' }}>{err}</span>}
        </div>
      </Block>
    </>
  );
}

/* ============ Environment ============ */
/**
 * Where OpusHub is plugged in, and what the presentation layer is allowed to decide. This is the
 * same pane that used to be called "System": the name now matches what it describes, and the
 * Homepage-compatibility block below is a statement of the rule the whole app is built on.
 */
function EnvironmentTab() {
  const { data: health } = usePolled<HealthDoc>('/api/health', 0);
  // Every field is read defensively: this pane must render even when a provider is down and the
  // route answers with an error object rather than the document.
  const { data: discovery } = usePolled<{
    overlays?: { serviceOverlays?: number; stackOverlays?: number; serviceEntries?: number; stackEntries?: number; unmatched?: number; unmatchedList?: { name?: string; kind?: string; reason?: string }[] };
    inventory?: { applications?: number; infrastructure?: number; stacks?: number; standalone?: number };
    urlDiscovery?: { sources?: Record<string, number>; withUrl?: number; withoutUrl?: number; hostAddress?: string | null; hostAddressSource?: string | null };
  }>('/api/discovery', 30_000);
  const { data: bookmarks } = usePolled<{ groups?: { name: string; bookmarks: unknown[] }[] }>('/api/bookmarks', 0);
  const { data: updates, refresh: refreshUpdates } = usePolled<{
    check?: { state: string; current?: string; latest?: string | null; url?: string; checkedAt?: number; reason?: string } | null;
    repo?: string;
    install?: { version?: string; gitSha?: string | null; buildTime?: string | null; imageTag?: string | null; installationMode?: string };
  }>('/api/updates', 0);
  const [checking, setChecking] = useState(false);
  const checkNow = async () => {
    setChecking(true);
    try { await post('/api/updates/check', {}); } catch { /* the refresh below shows whatever the server knows */ }
    setChecking(false);
    refreshUpdates();
  };
  const overlays = discovery?.overlays;
  const inventory = discovery?.inventory;
  const urls = discovery?.urlDiscovery;
  const bookmarkCount = (bookmarks?.groups || []).reduce((a, g) => a + (g?.bookmarks?.length || 0), 0);
  return (
    <>
      <p className="lede">Where OpusHub is plugged in. Paths are resolved at startup and logged on the server; infrastructure access stays read-only.</p>
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

      <Block
        title="Updates"
        aside={updates?.check?.checkedAt ? <span className="stale-note">checked {new Date(updates.check.checkedAt).toLocaleString()}</span> : <span className="stale-note">never checked</span>}
      >
        <p className="stale-note" style={{ marginBottom: 'var(--sp-4)' }}>
          OpusHub never checks on its own — no boot ping, no timer, no page-load call. The button below is the only
          thing that contacts github.com, and the answer is cached for six hours.
        </p>
        <Row
          label="This install"
          desc={updates?.install?.installationMode === 'docker' ? 'Running as a container image.' : 'Running from a source checkout.'}
          tight
        >
          <span className="mono-meta">
            {updates?.install ? `${updates.install.version || '?'}${updates.install.gitSha ? ` · ${updates.install.gitSha}` : ''}` : '…'}
          </span>
        </Row>
        <Row label="Newest release" tight>
          <span className="mono-meta">
            {!updates ? '…' : !updates.check ? 'unknown — check once to find out'
              : updates.check.state === 'current' ? `${updates.check.latest || updates.check.current} · you are up to date`
              : updates.check.state === 'available' ? `${updates.check.latest} available`
              : `unknown — ${updates.check.reason || 'the check did not answer'}`}
          </span>
        </Row>
        {updates?.check?.state === 'available' && (
          <Row label="" tight>
            <a className="btn btn-sm" href={updates.check.url || updates.repo} target="_blank" rel="noreferrer">Read the release notes →</a>
          </Row>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 'var(--sp-3)' }}>
          <button className="btn btn-sm" disabled={checking} onClick={checkNow}>{checking ? 'Checking…' : 'Check for updates'}</button>
          {updates?.repo && <a className="btn btn-quiet btn-sm" href={updates.repo} target="_blank" rel="noreferrer">Repository →</a>}
        </div>
      </Block>

      <Block title="Host address for published ports" aside={<span className="stale-note">used by the URL resolver</span>}>
        <Row label="Address" desc="Only consulted when a container publishes a port and has no proxy route. Detected automatically from the host's own interfaces when it is not set.">
          <span className="mono-meta">
            {urls?.hostAddress
              ? <>{urls.hostAddress} <span className="stale-note">· {urls.hostAddressSource}</span></>
              : <span className="stale-note">none detected — published-port URLs are omitted rather than guessed</span>}
          </span>
        </Row>
      </Block>

      <Block title="Homepage-compatible presentation layer" aside={<span className="stale-note">config/</span>}>
        <p className="stale-note" style={{ marginBottom: 'var(--sp-4)' }}>
          The files are shaped like Homepage's, and they do the same one job: <b>Docker decides what
          exists; configuration decides how it is presented.</b> A group with no containers is not a
          group, an overlay entry with no container binds to nothing, and a bookmark is a link —
          never an infrastructure object. Nothing below can add, rename or remove a service.
        </p>
        <Row label="services.yaml" desc="Renames, icons, groups, ordering, URL overrides, visibility." tight>
          <span className="mono-meta">
            {overlays ? `${overlays.serviceOverlays ?? 0} bound of ${overlays.serviceEntries ?? 0} entr${overlays.serviceEntries === 1 ? 'y' : 'ies'}` : '…'}
            {overlays?.unmatched ? <span className="stale-note"> · {overlays.unmatched} unmatched</span> : null}
          </span>
        </Row>
        <Row label="stacks.yaml" desc="Renames and describes a compose project the engine reported." tight>
          <span className="mono-meta">
            {overlays ? `${overlays.stackOverlays ?? 0} bound of ${overlays.stackEntries ?? 0} entr${overlays.stackEntries === 1 ? 'y' : 'ies'}` : '…'}
          </span>
        </Row>
        <Row label="bookmarks.yaml" desc="Flat links with groups. No status, no discovery — they are yours, not the engine's." tight>
          <span className="mono-meta">{bookmarks ? `${bookmarkCount} in ${bookmarks.groups?.length ?? 0} group(s)` : '…'}</span>
        </Row>
        <Row label="layout.json" desc="The Hub composition: widget instances, zones, sizes, spacing and ordering." tight>
          <span className="mono-meta">widgets, groups and order</span>
        </Row>
        <Row label="theme.css · app.js · icons/ · backgrounds/" desc="Custom code and assets, all opt-in, all same-origin, all served behind the session." tight>
          <Link className="btn btn-sm" to="/settings/advanced">Custom code</Link>
        </Row>
        {!!overlays?.unmatchedList?.length && (
          <Row label="Unmatched overlays" desc="Entries naming a container that is not on this engine right now. They are reported here and rendered nowhere — that is the phantom-service rule working.">
            <span className="mono-meta">{overlays.unmatchedList.slice(0, 4).map((u) => u.name || u.kind || 'entry').join(', ')}</span>
          </Row>
        )}
        <Row label="Inventory" desc="Everything the engine reports, after presentation." tight>
          <span className="mono-meta">{inventory ? `${inventory.applications ?? 0} applications · ${inventory.infrastructure ?? 0} infrastructure · ${inventory.stacks ?? 0} stacks · ${inventory.standalone ?? 0} standalone` : '…'}</span>
        </Row>
      </Block>

      <ProvidersBlock />
      <DiscoveryBlock health={health} />
    </>
  );
}

/* ============ Appearance ============ */
const ACCENTS = [
  { id: 'sage', name: 'Sage' }, { id: 'slate', name: 'Slate' }, { id: 'teal', name: 'Teal' },
  { id: 'amber', name: 'Amber' }, { id: 'rose', name: 'Rose' }, { id: 'clay', name: 'Clay' }, { id: 'moss', name: 'Moss' },
];
const ACCENT_HEX: Record<string, string> = {
  sage: '#7ea074', slate: '#68809b', teal: '#4e928d', amber: '#c08f43', rose: '#b76b74', clay: '#a3715a', moss: '#7c8f57',
};

function AppearanceTab() {
  const { settings, update, resolvedTheme } = useSettings();
  const a = settings?.appearance;
  const set = useCallback((patch: DeepPartial<SettingsDoc>) => update(patch), [update]);
  if (!settings || !a) return <Loading what="appearance settings" />;
  return (
    <>
      <Block title="Theme">
        <Row label="Mode" desc="Auto follows the OS; the rail button cycles it too.">
          <Segmented value={a.theme} onChange={(v) => set({ appearance: { theme: v } })} ariaLabel="Theme mode"
            options={[{ value: 'system', label: 'Auto' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
        </Row>
        <Row label="Accent" desc="One quiet hue: focus, selection, charts.">
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
      <p className="stale-note">Rendering as <b>{resolvedTheme}</b> right now.</p>
    </>
  );
}

/* ============ Background ============ */
interface BgCheckResult { ok: boolean; url?: string | null; error?: string; kind?: string }

/**
 * The Background URL field, with a server-side verdict before anything is stored.
 *
 * What the user may paste:
 *   · a direct image URL (https://…/photo.jpg) — the server probes it and refuses anything
 *     that is not an image (a pasted web page is the old way this field silently "broke")
 *   · an Unsplash photo page (https://unsplash.com/photos/…) — resolved server-side to the
 *     photo's direct image URL, which is what gets stored
 *   · a local file as /user/backgrounds/<name> (config/backgrounds/ on disk)
 *
 * The input is uncontrolled and keyed on the saved value: a failed check leaves the user's
 * text in place with the reason beside it, a successful one remounts the field with the
 * canonical (possibly resolved) URL.
 */
function BackgroundTab() {
  const { settings, update } = useSettings();
  const { data: bgs } = usePolled<{ files: { name: string; url: string }[] }>('/api/backgrounds', 0);
  const a = settings?.appearance;
  const set = (patch: DeepPartial<SettingsDoc>) => update(patch);
  const photo = a?.background.photo ?? null;
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  // a ref (not state): Enter blurs the field, and the blur commit must see the attempt that
  // the Enter commit just recorded — state would not have flushed yet
  const lastAttemptRef = useRef<string | null>(null);
  if (!settings || !a) return <Loading what="service settings" />;

  const check = async (value: string) => {
    const v = value.trim();
    if (v === (photo || '') || v === lastAttemptRef.current) return; // nothing new to verify
    lastAttemptRef.current = v;
    setChecking(true);
    setVerdict(null);
    if (!v) return setChecking(false);
    try {
      const r = await api<BgCheckResult>('/api/background/check?url=' + encodeURIComponent(v));
      if (r.ok) {
        const url = r.url ?? null;
        set({ appearance: { background: { photo: url } } });
        setVerdict(url == null ? null : url === v
          ? { ok: true, text: 'Direct image — the Hub will use it.' }
          : { ok: true, text: `Resolved to a direct image on ${hostOf(url)}.` });
      } else {
        setVerdict({ ok: false, text: r.error || 'This URL could not be used as a background.' });
      }
    } catch {
      setVerdict({ ok: false, text: 'Could not verify this URL right now — check the connection and try again.' });
    } finally {
      setChecking(false);
    }
  };

  const files = bgs?.files || [];
  const urlPhoto = photo && !files.some((f) => f.url === photo) ? photo : null;
  return (
    <>
      <Block title="Background">
        <Row label="Style" desc="Quiet is flat. Horizon is one muted ramp. Photo uses your own image behind an automatic scrim.">
          <Segmented value={a.background.mode} onChange={(v) => set({ appearance: { background: { mode: v } } })} ariaLabel="Background mode"
            options={[{ value: 'quiet', label: 'Quiet' }, { value: 'horizon', label: 'Horizon' }, { value: 'photo', label: 'Photo' }]} />
        </Row>
      </Block>
      {a.background.mode === 'photo' && (
        <Block title="Image">
          <div className="bg-tile-grid">
            <button className={`bg-tile ${!photo ? 'sel' : ''}`} onClick={() => { setVerdict(null); set({ appearance: { background: { photo: null } } }); }}>
              <span className="none">None</span>
            </button>
            {urlPhoto && (
              <div className={`bg-tile sel bg-tile--url`} style={{ backgroundImage: `url("${urlPhoto.replace(/"/g, '\\"')}")` }} title={urlPhoto}>
                <span className="bg-tile-tag">URL</span>
              </div>
            )}
            {files.map((f) => (
              <button
                key={f.url} className={`bg-tile ${photo === f.url ? 'sel' : ''}`}
                style={{ backgroundImage: `url("${f.url}")` }} title={f.name}
                onClick={() => { setVerdict(null); set({ appearance: { background: { photo: f.url } } }); }}
              />
            ))}
          </div>
          <p className="stale-note" style={{ marginTop: 'var(--sp-3)' }}>
            Drop images into <code className="mono-meta">config/backgrounds/</code>, or paste a URL below.
            {' '}{photo
              ? <>In use: <span className="mono-meta">{files.some((f) => f.url === photo) ? photo.replace('/user/backgrounds/', '') : photo}</span>{files.some((f) => f.url === photo) ? ' (local file)' : urlPhoto ? ' (remote — validated when you set it)' : ''}</>
              : 'Nothing selected.'}
          </p>
          <div className="field" style={{ marginTop: 'var(--sp-4)', maxWidth: 480 }}>
            <label htmlFor="bgurl">Background URL</label>
            <input id="bgurl" className="input mono-meta" key={photo || 'none'} placeholder="https://…/photo.jpg · an Unsplash photo page · /user/backgrounds/photo.jpg"
              defaultValue={photo || ''}
              aria-busy={checking}
              onKeyDown={(e) => { if (e.key === 'Enter') { void check((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); } }}
              onBlur={(e) => { void check(e.target.value); }}
            />
            <span className="hint">
              A direct link to an image file (https), an Unsplash photo page — resolved to the image for you — or a file
              from <code className="mono-meta">config/backgrounds/</code>. Web pages are refused, and http:// is not allowed.
            </span>
            {checking
              ? <span className="stale-note bg-url-state" role="status">Checking the URL…</span>
              : verdict
                ? <span className={`stale-note bg-url-state ${verdict.ok ? 'bg-url-state--ok' : 'bg-url-state--err'}`} role="status">{verdict.ok ? '✓ ' : '✗ '}{verdict.text}</span>
                : null}
          </div>
          <Row label="Blur" desc="Applied to the photo so text keeps its contrast.">
            <input type="range" min={0} max={48} value={a.background.blur} onChange={(e) => set({ appearance: { background: { blur: Number(e.target.value) } } })} aria-label="Background blur" />
            <span className="mono-meta" style={{ width: 40 }}>{a.background.blur}px</span>
          </Row>
          <Row label="Scrim" desc="Veil between photo and content. Below 45% the preview will tell you what it costs.">
            <input type="range" min={0} max={100} value={a.background.scrim} onChange={(e) => set({ appearance: { background: { scrim: Number(e.target.value) } } })} aria-label="Background scrim" />
            <span className="mono-meta" style={{ width: 40 }}>{a.background.scrim}%</span>
          </Row>
          <Row label="Position" desc="Which part of the image survives the crop. The subject is rarely in the middle of a photo.">
            <Segmented
              value={a.background.position} ariaLabel="Background position"
              onChange={(v) => set({ appearance: { background: { position: v } } })}
              options={[
                { value: 'center', label: 'Centre' }, { value: 'top', label: 'Top' },
                { value: 'bottom', label: 'Bottom' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' },
              ]}
            />
          </Row>
          <Row label="Fit" desc="Cover fills the viewport and crops; contain shows the whole image and lets the base background show through.">
            <Segmented
              value={a.background.fit} ariaLabel="Background fit"
              onChange={(v) => set({ appearance: { background: { fit: v } } })}
              options={[{ value: 'cover', label: 'Cover' }, { value: 'contain', label: 'Contain' }]}
            />
          </Row>
          <Row label="Remove" desc="Clears the photo but keeps your blur, scrim, position and fit for the next one." tight>
            <button className="btn btn-sm" disabled={!photo} onClick={() => { setVerdict(null); set({ appearance: { background: { photo: null } } }); }}>Remove background</button>
          </Row>
        </Block>
      )}
      <p className="stale-note">The preview above uses the same background layer as the Hub — what you see is what `/` renders. If an image stops loading later, the Hub quietly falls back to its base background.</p>
    </>
  );
}

/* ============ Hub layout ============ */
function HubTab() {
  const { settings, update } = useSettings();
  const { layout, setLayout, resetLayout } = useLayout();
  if (!settings || !layout) return <Loading what="the Hub composition" />;
  return (
    <>
      <Block title="Greeting" aside={<Link className="section-link" to="/settings/general">General →</Link>}>
        <Row label="Name and clock" desc="“Good evening, Nora.” Leave the name empty for a greeting with nobody in it — nothing is assumed about you.">
          <span className="mono-meta">{settings.hub.greetingName || '(no name)'} · {settings.hub.clock24h ? '24-hour' : '12-hour'}{settings.hub.showSeconds ? ' · seconds' : ''}</span>
        </Row>
      </Block>

      <Block title="Rhythm" aside={<span className="stale-note">the air between sections</span>}>
        <Row label="Spacing" desc="Templates set this too; change it here to fine-tune.">
          <Segmented value={layout.hub.spacing} onChange={(v) => setLayout({ hub: { spacing: v } })} ariaLabel="Hub spacing"
            options={[{ value: 'cozy', label: 'Cozy' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'airy', label: 'Airy' }]} />
        </Row>
        <Row label="Composition" desc={`${visibleInZone(layout, 'main').length} widget(s) in the main column · ${visibleInZone(layout, 'rail').length} in the sidebar · ${hiddenWidgets(layout).length} hidden`}>
          <Link className="btn btn-sm" to="/settings/widgets">Arrange widgets</Link>
          <Link className="btn btn-sm" to="/settings/templates">Templates</Link>
        </Row>
        <Row label="First-run banner" desc="Shown until Docker answers or you dismiss it." tight>
          <Switch checked={!layout.hub.setupDismissed} onChange={(v) => setLayout({ hub: { setupDismissed: !v } })} label="Show first-run banner" />
        </Row>
      </Block>

      <Block title="Reset">
        <Row label="Hub composition" desc="Back to the default arrangement. Services, overlays and settings are untouched." tight>
          <button className="btn btn-sm" onClick={() => void resetLayout()}>Reset layout</button>
        </Row>
      </Block>
    </>
  );
}

/* ============ Widgets ============ */
function WidgetsTab() {
  const { layout, setLayout, resetLayout } = useLayout();
  const { data } = usePolled<WidgetDoc>('/api/widgets', 0);
  const [configFor, setConfigFor] = useState<WidgetInstance | null>(null);
  const catalogue = data?.catalogue ?? [];
  const widgets = layout?.hub.widgets ?? [];
  const missing = catalogue.filter((c) => !widgets.some((w) => w.type === c.type));
  // the catalogue's own organisation; a client newer than the server still renders ungrouped
  const categories = data?.categories ?? [{ id: 'grid', label: 'Widgets', description: '' }];
  const categoryLabel = (id: string) => categories.find((c) => c.id === id)?.label || id;

  const entries = useMemo(() => new Map(catalogue.map((c) => [c.type, c])), [catalogue]);
  if (!layout) return <Loading what="layout.json" />;

  const zoneBlock = (zone: WidgetZone) => {
    const list = widgets.filter((w) => w.zone === zone);
    const ids = list.map((w) => w.id);
    const render = (id: string, handle?: ReactNode) => {
      const w = widgets.find((x) => x.id === id);
      if (!w) return null;
      const entry = entries.get(w.type);
      return (
        <div className="widget-row" id={`w-${w.id}`} key={w.id}>
          {handle}
          <span className="widget-row-main">
            <span className="widget-row-title">{w.title || entry?.title || w.type}</span>
            <span className="widget-row-sub">
              {entry?.description || w.type}
              {entry?.category && <span className="mono-meta"> · {categoryLabel(entry.category)}</span>}
              {configSummary(w) && <span className="mono-meta"> · {configSummary(w)}</span>}
            </span>
          </span>
          {w.visible === false && <span className="chip">hidden</span>}
          <span className="widget-row-actions">
            {entry && entry.sizes.length > 1 && (
              <Segmented value={w.size} onChange={(v) => setLayout({ hub: { widgets: setWidget(layout, w.id, { size: v }).hub.widgets } })} ariaLabel={`${w.title || entry.title} size`}
                options={entry.sizes.map((s) => ({ value: s, label: s.toUpperCase() }))} />
            )}
            <Segmented value={w.zone} onChange={(v) => setLayout({ hub: { widgets: moveWidget(layout, w.id, v).hub.widgets } })} ariaLabel={`${w.title || entry?.title} column`}
              options={[{ value: 'main' as const, label: 'Main' }, { value: 'rail' as const, label: 'Sidebar' }]} />
            <Switch checked={w.visible !== false} onChange={(v) => setLayout({ hub: { widgets: setWidget(layout, w.id, { visible: v }).hub.widgets } })} label={`Show ${w.title || w.type}`} />
            {entry?.config.length ? (
              <button className="btn btn-sm" onClick={() => setConfigFor(w)}>Configure</button>
            ) : null}
            <button className="icon-btn" aria-label={`Remove ${w.title || w.type}`} title="Remove from the Hub"
              onClick={() => setLayout({ hub: { widgets: removeWidget(layout, w.id).hub.widgets } })}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
            </button>
          </span>
        </div>
      );
    };
    return (
      <Block key={zone} title={zone === 'main' ? 'Main column' : 'Sidebar'}
        aside={<span className="stale-note">{list.filter((w) => w.visible !== false).length} visible</span>}>
        {ids.length === 0 ? (
          <p className="stale-note" style={{ padding: '10px 0' }}>Nothing here yet.</p>
        ) : (
          <Sortable
            ids={ids}
            className="widget-rows"
            onReorder={(next) => setLayout({ hub: { widgets: reorderWidgets(layout, zone, next) } })}
            renderItem={(id, ctx) => render(id, ctx.handle)}
          />
        )}
      </Block>
    );
  };

  return (
    <>
      <p className="lede">
        Widgets are the Hub’s blocks. Reorder them by dragging, move them between columns, resize where a
        smaller or larger form makes sense — everything here is layout, never infrastructure.
      </p>
      {zoneBlock('main')}
      {zoneBlock('rail')}

      <Block title="Add a widget" aside={<span className="stale-note">{missing.length} type{missing.length === 1 ? '' : 's'} not on the Hub</span>}>
        {categories.map((cat) => {
          const inCat = missing.filter((c) => (c.category || 'grid') === cat.id);
          if (!inCat.length) return null;
          return (
            <div className="widget-cat" key={cat.id}>
              <div className="widget-cat-head">
                <span className="micro-label">{cat.label}</span>
                <span className="stale-note">{cat.description}</span>
              </div>
              <div className="widget-add">
                {inCat.map((c) => (
                  <button key={c.type} className="widget-add-item" onClick={() => setLayout({ hub: { widgets: addWidget(layout, c).hub.widgets } })}>
                    <span className="wa-title">+ {c.title}</span>
                    <span className="wa-desc">{c.description}</span>
                    <span className="wa-zone">default: {c.zone === 'main' ? 'main column' : 'sidebar'}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {!missing.length && <p className="stale-note">Every widget type this build has is already on the Hub. You can add duplicates of a type — say, two clocks for two timezones — from the menu below.</p>}
        <details className="tech" style={{ marginTop: 'var(--sp-3)' }}>
          <summary className="stale-note">Add a duplicate of a type already in use</summary>
          <div className="widget-add" style={{ marginTop: 10 }}>
            {catalogue.map((c) => (
              <button key={c.type} className="widget-add-item" onClick={() => setLayout({ hub: { widgets: addWidget(layout, c).hub.widgets } })}>
                <span className="wa-title">+ {c.title}</span>
                <span className="wa-desc">{c.description}</span>
              </button>
            ))}
          </div>
        </details>
      </Block>

      <Block title="Defaults">
        <Row label="Reset the composition" desc="Back to the balanced default arrangement. Services and settings are untouched." tight>
          <button className="btn btn-sm" onClick={() => void resetLayout()}>Reset layout</button>
        </Row>
      </Block>

      {configFor && (
        <WidgetConfigModal
          widget={configFor}
          entry={entries.get(configFor.type) || null}
          onClose={() => setConfigFor(null)}
          onSave={(config) => {
            setLayout({ hub: { widgets: setWidget(layout, configFor.id, { config }).hub.widgets } });
            setConfigFor(null);
          }}
        />
      )}
    </>
  );
}

/** Reorder visible widgets of one zone; hidden ones keep their slots (same rule as the Hub). */
function reorderWidgets(layout: LayoutDoc, zone: WidgetZone, orderedVisibleIds: string[]): WidgetInstance[] {
  const queue = [...orderedVisibleIds];
  const out: WidgetInstance[] = [];
  for (const w of layout.hub.widgets) {
    if (w.zone !== zone || w.visible === false) { out.push(w); continue; }
    const next = queue.shift();
    out.push(next ? layout.hub.widgets.find((x) => x.id === next) || w : w);
  }
  for (const id of queue) {
    const w = layout.hub.widgets.find((x) => x.id === id);
    if (w) out.push(w);
  }
  return out;
}

function WidgetConfigModal({ widget, entry, onSave, onClose }: {
  widget: WidgetInstance;
  entry: WidgetCatalogueEntry | null;
  onSave: (config: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [config, setConfig] = useState<Record<string, unknown>>({ ...widget.config });
  const { data: services } = usePolled<ServicesDoc>('/api/services', 0);
  const groupNames = (services?.groups || []).map((g) => g.name);
  const fields = entry?.config || [];
  const set = (k: string, v: unknown) => setConfig((c) => ({ ...c, [k]: v }));
  return (
    <Modal
      title={`${widget.title || entry?.title || widget.type} — configuration`}
      onClose={onClose}
      footer={<>
        <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => onSave(config)}>Save widget</button>
      </>}
    >
      {!fields.length && <p className="stale-note">This widget has no configuration — its content follows the engine.</p>}
      {fields.map((f) => {
        const value = config[f.key];
        if (f.type === 'group-list') {
          const chosen = Array.isArray(value) ? (value as string[]) : [];
          if (!groupNames.length) return <p className="stale-note" key={f.key}>No groups discovered on this engine yet.</p>;
          return (
            <div className="field" key={f.key}>
              <label>{f.label}</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {groupNames.map((g) => (
                  <button key={g} className="chip" aria-pressed={chosen.includes(g)}
                    style={chosen.includes(g) ? { borderColor: 'var(--accent)', color: 'var(--ink)' } : undefined}
                    onClick={() => set(f.key, chosen.includes(g) ? chosen.filter((x) => x !== g) : [...chosen, g])}>
                    {g}
                  </button>
                ))}
              </div>
              <span className="hint">{f.hint || 'Leave empty for every group.'}</span>
            </div>
          );
        }
        if (f.type === 'list') {
          const chosen = Array.isArray(value) ? (value as string[]) : [];
          return (
            <div className="field" key={f.key}>
              <label>{f.label}</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(f.options || []).map((o) => (
                  <button key={o} className="chip" aria-pressed={chosen.includes(o)}
                    style={chosen.includes(o) ? { borderColor: 'var(--accent)', color: 'var(--ink)' } : undefined}
                    onClick={() => set(f.key, chosen.includes(o) ? chosen.filter((x) => x !== o) : [...chosen, o])}>
                    {o}
                  </button>
                ))}
              </div>
              <span className="hint">{f.hint || 'Leave empty for all sources.'}</span>
            </div>
          );
        }
        if (f.type === 'boolean') {
          return (
            <Row key={f.key} label={f.label} desc={f.hint} tight>
              <Switch checked={value === true} onChange={(v) => set(f.key, v)} label={f.label} />
            </Row>
          );
        }
        return (
          <div className="field" key={f.key}>
            <label>{f.label}</label>
            <input className="input" value={typeof value === 'string' ? value : ''} onChange={(e) => set(f.key, e.target.value)} />
            {f.hint && <span className="hint">{f.hint}</span>}
          </div>
        );
      })}
    </Modal>
  );
}

/* ============ Templates ============ */
function TemplatesTab({ onPreview }: { onPreview: (t: TemplateEntry | null) => void }) {
  const { layout, reload } = useLayout();
  const { data, loading } = usePolled<TemplatesDoc>('/api/templates', 0);
  const { busy, err, save } = useSave();
  const [applied, setApplied] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<TemplateEntry | null>(null);
  const templates = data?.templates || [];
  const currentSpacing = layout?.hub.spacing;

  return (
    <>
      <p className="lede">
        Templates are <b>arrangements</b>. They decide which widgets show, where they sit and how much air the page
        gets. They never install, create or rename anything — applying one to a system with no media containers
        simply leaves that ordering unused.
      </p>
      {err && <p className="stale-note" style={{ color: 'var(--fail)' }}>{err}</p>}
      {loading && !templates.length && <p className="stale-note">Reading templates…</p>}
      <div className="tpl-grid">
        {templates.map((t) => {
          const matches = t.spacing === currentSpacing;
          return (
            <article className="tpl" key={t.id}>
              <header>
                <h3>{t.name}</h3>
                <p className="tpl-tagline">{t.tagline}</p>
              </header>
              <p className="tpl-desc">{t.description}</p>
              <div className="tpl-widgets">
                {t.widgets.map((w) => (
                  <span className="tpl-widget" key={w.id}>
                    <span className="tpl-widget-zone">{w.zone === 'main' ? '▤' : '▎'}</span>
                    {w.title}
                  </span>
                ))}
              </div>
              {(t.groupPriority?.length ?? 0) > 0 && (
                <p className="stale-note">
                  Prefers {t.groupPriority.join(' › ')}
                  {(t.unmatchedGroups?.length ?? 0) > 0 && <> · not on this system: {t.unmatchedGroups.join(', ')} (ignored)</>}
                </p>
              )}
              <footer>
                <button className="btn btn-sm" onMouseEnter={() => onPreview(t)} onFocus={() => onPreview(t)} onMouseLeave={() => onPreview(null)} onClick={() => onPreview(t)}>
                  Preview
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => setConfirming(t)}
                >
                  {applied === t.id ? 'Applied' : 'Apply'}
                </button>
                {matches && <span className="stale-note">matches your spacing</span>}
              </footer>
            </article>
          );
        })}
      </div>
      <p className="stale-note" style={{ marginTop: 'var(--sp-5)' }}>
        Applying keeps your service ordering, hidden groups and first-run dismissal — a template only rearranges the page.
        A configuration version is recorded immediately before it is applied, so the previous arrangement is one
        click away in <Link className="section-link" to="/settings/history">History</Link>.
      </p>

      {confirming && (
        <Modal
          title={`Apply “${confirming.name}”?`}
          onClose={() => setConfirming(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => save(async () => {
                  await post('/api/layout/template', { id: confirming.id });
                  invalidateShared('/api/layout');
                  await reload();
                  onPreview(null);
                  setApplied(confirming.id);
                  setConfirming(null);
                })}
              >Replace my arrangement</button>
            </>
          )}
        >
          <p>
            This replaces the current Hub arrangement — {(layout?.hub.widgets || []).length} block(s) at{' '}
            <span className="mono-meta">{layout?.hub.spacing}</span> — with the {(confirming.widgets || []).length} block(s)
            this template defines.
          </p>
          <p className="stale-note">
            Your service ordering, hidden groups, icon and naming choices are not touched: a template
            rearranges the page, it never edits what a service is.
          </p>
          <p className="stale-note">
            A snapshot of the current arrangement is recorded first and appears in History, so this is undoable.
          </p>
        </Modal>
      )}
    </>
  );
}

/* ============ Services overlay editor ============ */
/**
 * What this editor edits is *presentation*, not infrastructure: an entry here can rename, file,
 * icon, order, hide, or re-URL a container that Docker actually reports. It cannot create one —
 * entries that match no container are listed under "unmatched" so they are fixable, not silent.
 */
function ServicesTab() {
  const { data } = usePolled<ServicesDoc>('/api/services', 0);
  const { busy, err, okAt, save } = useSave();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<DraftGroup[] | null>(null);
  const [editing, setEditing] = useState<{ gi: number; si: number | null } | null>(null);
  const [iconFor, setIconFor] = useState<{ gi: number; si: number } | null>(null);
  const inventory = useMemo(() => data?.services ?? [], [data]);
  const bound = useMemo(() => new Set(inventory.filter((s) => s.configured).map((s) => s.name)), [inventory]);
  const groups = useMemo<DraftGroup[] | null>(() => draft ?? (data ? overlayFromInventory(data) : null), [draft, data]);

  // ?container=<name> — "Customize" from the Hub lands straight in the editor for that service.
  // ?service=<name> is the same thing from the command palette, which addresses containers by the
  // name the engine reports; both are accepted so neither link can land on a closed drawer.
  const focus = params.get('container') || params.get('service');
  useEffect(() => {
    if (!focus || !data || draft) return;
    const svc = inventory.find((s) => s.name === focus);
    if (!svc) return;
    const base = overlayFromInventory(data);
    const has = base.some((g) => g.services.some((s) => s.container === svc.name));
    const withEntry = has ? base : ensureOverlay(base, svc);
    setDraft(withEntry);
    const gi = withEntry.findIndex((g) => g.services.some((s) => s.container === svc.name));
    const si = withEntry[gi]?.services.findIndex((s) => s.container === svc.name) ?? -1;
    if (gi >= 0 && si >= 0) setEditing({ gi, si });
    params.delete('container');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, data]);

  if (!groups) return <Loading what="services.yaml" />;

  const dirty = !!draft;
  const commit = () => save(async () => { await saveOverlay(groups); setDraft(null); });
  const patchService = (gi: number, si: number, p: Partial<DraftService>) =>
    setDraft((d) => {
      const next = structuredClone((d ?? groups) as DraftGroup[]);
      next[gi].services[si] = { ...next[gi].services[si], ...p };
      return next;
    });
  const unbound = inventory.filter((s) => !bound.has(s.name) && !s.hidden);
  const unmatched = (data?.unmatched ?? []).filter((u) => u.kind === 'service');

  return (
    <>
      <p className="lede">
        Docker decides what exists; <span className="mono-meta">config/services.yaml</span> only decides how a container is
        named, filed, iconed and ordered.
        {dirty && <b style={{ color: 'var(--warn)' }}> · unsaved changes</b>}
      </p>
      {err && <p className="stale-note" style={{ color: 'var(--fail)' }}>{err}</p>}

      {!data?.live && (
        <ProviderNote
          status="unavailable"
          reason={data?.statusReason || 'Docker is not connected, so there is nothing to overlay. Connect the engine and every container appears here automatically.'}
          fixHref="/settings/environment"
          fixLabel="Discovery status →"
        />
      )}

      {groups.map((g, gi) => (
        <Block
          key={`${g.name}-${gi}`}
          title={
            // the same rename contract as Settings → Groups: Enter commits, Escape reverts, blur
            // commits, an invalid or duplicate name is refused with a reason beside the field
            <GroupNameField
              name={g.name}
              existing={groups.filter((_, i) => i !== gi).map((x) => x.name)}
              ariaLabel={`Group name for ${g.name}`}
              className="input group-name-heading"
              onCommit={(next) => setDraft(renameGroupAt(groups, gi, next))}
            />
          }
          aside={
            <span style={{ display: 'flex', gap: 'var(--sp-2)' }}>
              <button className="btn btn-quiet btn-sm" onClick={() => setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next[gi].services.push({ name: 'new', container: null, displayName: null, app: null, description: null, url: null, icon: null, group: g.name, order: null, hidden: false, showOnHub: true, keywords: [], meta: [] }); return next; })}>+ entry</button>
              <button className="btn btn-quiet btn-sm" onClick={() => setDraft(removeGroup(groups, g.name))}>remove group</button>
            </span>
          }
        >
          <ul style={{ listStyle: 'none' }}>
            {g.services.map((s, si) => {
              const live = inventory.find((x) => x.name === s.container);
              const label = live ? (live.container.composeService || live.name) : s.container;
              const customized = !!(s.displayName || s.icon || s.description || s.url || s.hidden || s.showOnHub === false || (s.group && s.group !== g.name));
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
                      {!s.showOnHub ? <span> · not on Hub</span> : null}
                    </div>
                  </div>
                  {/* discovered vs customized is a word, not a badge */}
                  <span className="stale-note">{customized ? 'customized' : live ? 'discovered' : ''}</span>
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
              <button key={s.id} className="chip" title={`${s.container.image || ''} · ${s.url || s.urlNote || 'no url'}`} onClick={() => setDraft(ensureOverlay(groups, s))}>
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
                      onChange={(e) => {
                        const v = e.target.value;
                        const svc = inventory.find((x) => x.name === v);
                        if (svc) setDraft(ensureOverlay(groups, svc));
                      }}
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
        <button className="btn" onClick={() => setDraft((d) => { const next = structuredClone((d ?? groups) as DraftGroup[]); next.push({ name: `Group ${next.length + 1}`, description: null, services: [] }); return next; })}>+ group</button>
        <button className="btn btn-primary" disabled={!dirty || busy} onClick={commit}>{busy ? 'Saving…' : 'Save to services.yaml'}</button>
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

/** Marks whether the field it sits beside is the detected value or your own override. */
function FieldOrigin({ overridden }: { overridden: boolean }) {
  return <span className={`field-origin${overridden ? ' field-origin--override' : ''}`}>{overridden ? 'override' : 'detected'}</span>;
}

function urlSourceWord(source: string | null | undefined): string {
  switch (source) {
    case 'traefik': return 'Traefik route';
    case 'published-port': return 'published port';
    case 'manual': return 'your override';
    default: return 'no source';
  }
}

function iconSourceWord(source: string | null | undefined): string {
  switch (source) {
    case 'config': return 'services.yaml';
    case 'label': return 'a container label';
    case 'derived:image': return 'the image name';
    default: return 'nothing in particular';
  }
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
      {live && (
        <div className="svc-identity" aria-label="Container identity, read from Docker">
          <div className="svc-identity-head">
            <span className="svc-identity-tag">From Docker</span>
            <span className="stale-note">read-only — OpusHub never edits infrastructure</span>
          </div>
          <dl className="svc-identity-kv">
            <dt>Container</dt>
            <dd className="mono-meta">{live.name}</dd>
            <dt>Image</dt>
            <dd className="mono-meta">{live.container.image || '—'}</dd>
            <dt>Compose project</dt>
            <dd className="mono-meta">
              {live.container.composeProject || <span className="stale-note">standalone — not part of a project</span>}
              {live.container.composeService ? <span className="stale-note"> · service {live.container.composeService}</span> : null}
            </dd>
            <dt>Container ID</dt>
            <dd className="mono-meta">{live.id}</dd>
            <dt>State</dt>
            <dd className="mono-meta">{live.container.state || 'unknown'}</dd>
          </dl>
        </div>
      )}

      <div className="field">
        <label>Container <span className="hint">(what this overlay is about — required for it to show anywhere)</span></label>
        <input className="input mono-meta" list="opus-live-containers" value={form.container || ''} onChange={(e) => f('container', e.target.value)} placeholder={live ? live.name : 'start typing a running container'} />
        <datalist id="opus-live-containers">
          {inventory.map((s) => <option key={s.id} value={s.name}>{`${s.displayName} · ${s.container.state}`}</option>)}
        </datalist>
        {form.container && !live && <p className="stale-note" style={{ color: 'var(--warn)' }}>no container named “{form.container}” on this engine — this entry will be reported as unmatched, and no service will appear.</p>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 var(--sp-5)' }}>
        <div className="field">
          <label>Display name <FieldOrigin overridden={!!form.displayName} /></label>
          <input className="input" value={form.displayName || ''} onChange={(e) => f('displayName', e.target.value)} placeholder={live ? live.displayName : 'derived from the container'} />
          {live && <span className="hint">Detected: <span className="mono-meta">{live.displayName}</span>{live.overlaid ? ` · from ${live.overlaid}` : ''}</span>}
        </div>
        <div className="field">
          <label>Group <FieldOrigin overridden={!!form.group} /></label>
          <input className="input" value={form.group || ''} onChange={(e) => f('group', e.target.value)} placeholder={live?.group || 'Other'} />
          {live && <span className="hint">Detected: <span className="mono-meta">{live.group}</span> ({live.groupSource || 'derived'})</span>}
        </div>
      </div>
      <div className="field"><label>App / software <span className="hint">(shown as identity; the image is the default)</span></label><input className="input" value={form.app || ''} onChange={(e) => f('app', e.target.value)} /></div>
      <div className="field"><label>Description</label><input className="input" value={form.description || ''} onChange={(e) => f('description', e.target.value)} /></div>
      <div className="field">
        <label>URL <FieldOrigin overridden={!!form.url} /></label>
        <input className="input mono-meta" value={form.url || ''} onChange={(e) => f('url', e.target.value)} placeholder={live && live.url ? `leave empty to keep ${live.url}` : 'leave empty unless you need to point somewhere else'} />
        {live?.url ? (
          <span className="hint">
            Detected: <span className="mono-meta">{live.url}</span> · source <b>{urlSourceWord(live.urlSource)}</b>
            {form.url ? ' — your override wins until you clear this field.' : ' — this is what the Hub links to.'}
          </span>
        ) : (
          <span className="hint">
            No URL was detected ({live?.urlNote || 'no proxy route and no published port'}). Setting one here is an
            override, not a discovery, and it is shown as such everywhere.
          </span>
        )}
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
        <span className="stale-note">
          {form.icon
            ? <>Override in use — <span className="mono-meta">{form.icon}</span></>
            : live?.icon
              ? <>Detected from {iconSourceWord(live.iconSource)}: <span className="mono-meta">{live.icon}</span>. Set one from the list to override it.</>
              : 'No icon detected — the monogram below the name is what renders. Choose one, or leave it.'}
        </span>
      </div>
    </Modal>
  );
}

/* ============ Groups ============ */
function GroupsTab() {
  const { data } = usePolled<ServicesDoc>('/api/services', 0);
  const { layout, setLayout } = useLayout();
  const { busy, err, save } = useSave();
  const [draft, setDraft] = useState<DraftGroup[] | null>(null);
  // `editing` is an INDEX, never a name: a rename must not move its own identity out from under
  // the row that is being edited (that was the bug behind “can't rename New group”).
  const [editing, setEditing] = useState<number | null>(null);
  const [freshGroup, setFreshGroup] = useState<number | null>(null);
  const [iconFor, setIconFor] = useState<string | null>(null);
  const inventory = useMemo(() => data?.services ?? [], [data]);
  const hiddenGroups = layout?.services?.hiddenGroups || [];
  // ?group=<name> from the command palette: open that row rather than making someone hunt for it
  const [params, setParams] = useSearchParams();
  const focus = params.get('group');

  const groups = useMemo<DraftGroup[] | null>(() => {
    if (draft) return draft;
    if (!data) return null;
    const base = overlayFromInventory(data);
    for (const g of data.groups) if (!base.some((x) => x.name === g.name)) base.push({ name: g.name, description: g.description ?? null, services: [] });
    return base;
  }, [draft, data]);

  const discoveredGroups = useMemo(() => {
    const seen = new Map<string, Service[]>();
    for (const s of inventory) {
      if (!s.group || s.hidden) continue;
      seen.set(s.group, [...(seen.get(s.group) || []), s]);
    }
    return seen;
  }, [inventory]);

  // ?group=<name> from the command palette: open that row rather than making someone hunt for it.
  useEffect(() => {
    if (!focus || !groups?.length) return;
    const at = groups.findIndex((g) => g.name === focus);
    if (at >= 0) setEditing((current) => current ?? at);
    params.delete('group');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, groups?.length]);

  if (!groups) return <Loading what="the service groups" />;
  const dirty = !!draft;
  const renameAt = (index: number, next: string) => setDraft(renameGroupAt(groups, index, next));
  const addGroup = () => {
    const name = uniqueGroupName(groups.map((g) => g.name));
    setDraft([...groups, { name, description: null, services: [] }]);
    setFreshGroup(groups.length);
    setEditing(groups.length);
  };

  const moveService = (container: string, to: string | null) => {
    const svc = inventory.find((s) => s.name === container);
    if (!svc) return;
    setDraft(to === null ? clearGroup(groups, container) : assignGroup(groups, svc, to));
  };

  return (
    <>
      <p className="lede">
        Groups are presentation. A group heading exists because containers are filed under it — either by
        discovery (their compose project) or by an overlay you write here. Nothing in this pane can create a service.
        {dirty && <b style={{ color: 'var(--warn)' }}> · unsaved changes</b>}
      </p>
      <p className="stale-note" style={{ marginBottom: 'var(--sp-5)' }}>
        <b>An OpusHub group is not a Docker Compose project.</b> Compose projects decide the default filing
        Docker produces; a group is what you choose to call that heading, and it can hold containers from
        several projects, bookmarks with no container at all, or nothing yet.
      </p>
      {err && <p className="stale-note" style={{ color: 'var(--fail)' }}>{err}</p>}

      <Sortable
        ids={groups.map((g) => g.name)}
        className="group-rows"
        onReorder={(next) => {
          const reordered = [...next].map((n) => groups.find((g) => g.name === n)!).filter(Boolean);
          setDraft(reordered);
          setLayout({ services: { groupOrder: next } });
        }}
        renderItem={(name, ctx) => {
          const gi = groups.findIndex((x) => x.name === name);
          const g = groups[gi];
          if (!g) return null;
          const discovered = discoveredGroups.get(name) || [];
          const isHidden = hiddenGroups.includes(name);
          return (
            <div className="group-row" key={name}>
              <div className="group-row-head">
                {ctx.handle}
                <button
                  className="icon-btn group-icon-btn" title={`Icon for ${g.name}`}
                  aria-label={`Choose an icon for ${g.name}`}
                  onClick={() => setIconFor(g.name)}
                >
                  <Icon ref={g.icon} name={g.name} size={22} />
                </button>
                <GroupNameField
                  name={g.name}
                  existing={groups.filter((_, i) => i !== gi).map((x) => x.name)}
                  ariaLabel={`Group name for ${g.name}`}
                  autoFocus={freshGroup === gi}
                  onCommit={(next) => { renameAt(gi, next); setFreshGroup(null); }}
                />
                <input
                  className="input group-desc"
                  value={g.description || ''}
                  placeholder="one line about this group (optional)"
                  aria-label={`Description for ${g.name}`}
                  onChange={(e) => setDraft(setGroupDescription(groups, g.name, e.target.value))}
                />
                <span className="stale-note">{g.services.length} overlay · {discovered.length} discovered</span>
                <Switch checked={!isHidden} onChange={() => setLayout({ services: { hiddenGroups: isHidden ? hiddenGroups.filter((x) => x !== g.name) : [...hiddenGroups, g.name] } })} label={`Show ${g.name} on the Hub`} />
                <button className="btn btn-sm" onClick={() => setEditing(editing === gi ? null : gi)}>{editing === gi ? 'Done' : 'Services'}</button>
                <button
                  className="icon-btn"
                  aria-label={`Delete group ${g.name}`}
                  title="Delete this group — its services fall back to discovery"
                  onClick={() => { setDraft(removeGroup(groups, g.name)); setLayout({ services: { hiddenGroups: hiddenGroups.filter((x) => x !== g.name) } }); }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
                </button>
              </div>

              {editing === gi && (
                <div className="group-row-body">
                  {g.services.length === 0 && discovered.length === 0 && <p className="stale-note">Nothing is filed here yet. Assign a discovered service below, or leave the group empty — it renders nothing until a container matches.</p>}
                  {g.services.map((s) => (
                    <div className="group-svc" key={s.container || s.name}>
                      <Icon ref={s.icon} name={s.displayName || s.name} size={20} plain />
                      <span className="grow">{s.displayName || inventory.find((x) => x.name === s.container)?.displayName || s.container || s.name}</span>
                      <span className="stale-note">overlay</span>
                      <button className="btn btn-quiet btn-sm" onClick={() => setDraft(removeEntry(groups, s.container || ''))}>Remove overlay</button>
                    </div>
                  ))}
                  {discovered.filter((d) => !g.services.some((s) => s.container === d.name)).map((d) => (
                    <div className="group-svc" key={d.name}>
                      <Icon ref={d.icon} name={d.displayName} size={20} plain />
                      <span className="grow">{d.displayName}</span>
                      <span className="stale-note">discovered · {d.container.composeProject || 'standalone'}</span>
                      <button className="btn btn-quiet btn-sm" onClick={() => setDraft(assignGroup(groups, d, g.name))}>File here</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }}
      />

      <Block title="Unfiled" aside={<span className="stale-note">containers with a derived group — moving one writes an overlay</span>}>
        <div className="group-rows">
          {inventory.filter((s) => !s.hidden && !groups.some((g) => g.services.some((x) => x.container === s.name))).slice(0, 40).map((s) => (
            <div className="group-svc" key={s.name}>
              <Icon ref={s.icon} name={s.displayName} size={20} plain />
              <span className="grow">{s.displayName}<span className="stale-note"> · currently “{s.group}” ({s.groupSource || 'derived'})</span></span>
              <select className="input" style={{ width: 190 }} value="" aria-label={`File ${s.displayName} under a group`}
                onChange={(e) => { if (e.target.value) moveService(s.name, e.target.value); }}>
                <option value="">file under…</option>
                {groups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
              </select>
            </div>
          ))}
          {!inventory.length && <p className="stale-note">No containers discovered — nothing to file.</p>}
        </div>
      </Block>

      <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center' }}>
        <button className="btn" onClick={addGroup} title="Add a group and name it">+ New group</button>
        <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => save(async () => { await saveOverlay(groups); setDraft(null); })}>{busy ? 'Saving…' : 'Save groups'}</button>
        {dirty && <button className="btn btn-quiet" onClick={() => setDraft(null)}>Discard</button>}
      </div>
      {iconFor && (
        <IconPickerModal
          initial={groups.find((g) => g.name === iconFor)?.icon ?? null}
          onPick={(ref) => setDraft(setGroupIcon(groups, iconFor, ref))}
          onClose={() => setIconFor(null)}
        />
      )}
    </>
  );
}

/* ============ Bookmarks ============ */
interface BmGroup { name: string; items: { name: string; href: string; description?: string | null }[] }
function BookmarksTab() {
  const { data } = usePolled<{ groups: BmGroup[] }>('/api/bookmarks', 0);
  const { busy, err, save } = useSave();
  const [draft, setDraft] = useState<BmGroup[] | null>(null);
  const [freshGroup, setFreshGroup] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const groups = draft ?? data?.groups ?? [];
  if (!data && !draft) return <Loading what="bookmarks.yaml" />;
  const renameAt = (index: number, next: string) => setDraft(cloneAt(groups, (d) => { d[index].name = next; }));
  const addGroup = () => {
    const name = uniqueGroupName(groups.map((g) => g.name));
    setDraft(cloneAt(groups, (d) => d.push({ name, items: [] })));
    setFreshGroup(groups.length);
  };
  return (
    <>
      <p className="lede">Flat links, no status, no icon machinery. They appear in search and can be shown in the Hub sidebar.</p>
      {err && <p className="stale-note" style={{ color: 'var(--fail)' }}>{err}</p>}
      {problem && <p className="name-note" role="alert">{problem}</p>}
      {groups.map((g, gi) => (
        <Block
          key={`${g.name}-${gi}`}
          title={
            <GroupNameField
              name={g.name}
              existing={groups.filter((_, i) => i !== gi).map((x) => x.name)}
              ariaLabel={`Bookmark group name for ${g.name}`}
              className="input group-name-heading"
              autoFocus={freshGroup === gi}
              onCommit={(next) => { renameAt(gi, next); setFreshGroup(null); }}
            />
          }
          aside={
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
        <button className="btn" onClick={addGroup} title="Add a group and name it">+ New group</button>
        <button className="btn btn-primary" disabled={!draft || busy} onClick={async () => {
          // the same rule the editor enforces per field, applied to the whole document: a blank
          // group is a mistake, and two groups with one name is a different mistake
          const names = groups.map((g) => g.name);
          const blank = names.some((n) => !String(n || '').trim());
          const dupes = names.filter((n, i) => names.findIndex((m) => m.toLowerCase() === String(n || '').toLowerCase()) !== i);
          if (blank || dupes.length) {
            setProblem(blank ? 'Every bookmark group needs a name.' : `Two groups cannot both be called “${dupes[0]}”.`);
            return;
          }
          setProblem(null);
          await save(async () => { await put('/api/bookmarks', { groups }); setDraft(null); });
        }}>Save bookmarks.yaml</button>
      </div>
    </>
  );
}
function cloneAt(groups: BmGroup[], fn: (d: BmGroup[]) => void): BmGroup[] {
  const next = structuredClone(groups);
  fn(next);
  return next;
}

/* ============ Integrations ============ */
const FEED_SUGGESTIONS = [
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { name: 'r/selfhosted', url: 'https://www.reddit.com/r/selfhosted.rss' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
];
const SYMBOL_SUGGESTIONS = ['AAPL', 'NVDA', 'MSFT', 'TSLA', 'RELIANCE.NS', 'TCS.NS', '^GSPC', '^NSEI', 'BTC-USD', 'EURUSD=X'];

/**
 * The same rule the server applies (server/providers/market.js): symbols are letters and
 * digits with the Yahoo alphabet ( . ^ - = ) — never a URL or free text. A Stooq-era .US
 * suffix is migrated away. The UI mirrors it so a bad symbol is refused before the save
 * round-trip, with the reason next to the field.
 */
const SYMBOL_RE = /^[A-Z0-9^](?:[A-Z0-9.^\-=]{0,23})$/;
function normalizeSymbolInput(raw: string): { symbol: string | null; reason: string | null } {
  const s = raw.trim().toUpperCase();
  const symbol = s.endsWith('.US') ? s.slice(0, -3) : s;
  if (!symbol) return { symbol: null, reason: 'empty' };
  if (!SYMBOL_RE.test(symbol)) return { symbol: null, reason: 'symbols are letters/digits with . ^ - = only (e.g. AAPL, ^GSPC, BTC-USD)' };
  return { symbol, reason: null };
}

function NotificationsTab() {
  const { data } = usePolled<AlertsDoc>('/api/alerts', 30_000);
  const channels = data?.channels || [];
  return (
    <>
      <p className="lede">
        When something needs your attention — an unhealthy service, a degraded stack, a full disk — OpusHub raises an
        alert on the <Link className="section-link" to="/activity">Activity page</Link>. Delivery channels will forward
        those alerts elsewhere; the registry below is the plan, and every entry says plainly what exists today.
      </p>
      <Block title="Channels" aside={data ? <span className="stale-note">{data.alerts.length} active alert{data.alerts.length === 1 ? '' : 's'}</span> : undefined}>
        {!data && <Loading what="notification channels" />}
        <div className="editor-list">
          {channels.map((c) => (
            <div className="editor-item" key={c.id}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontWeight: 560 }}>{c.label}</b>
                <div className="stale-note">{c.blurb}</div>
              </span>
              <span className="chip">{c.configured ? 'Configured' : c.status === 'ready' ? 'Not configured' : 'Coming later'}</span>
            </div>
          ))}
        </div>
      </Block>
      <Block title="How alerting works">
        <Row label="Evaluation" desc="Alert conditions run over data OpusHub already holds — no extra polling of your engine, no external calls.">
          <span className="stale-note">on each Activity visit</span>
        </Row>
        <Row label="Record" desc="Every firing and every recovery is written to the activity log, so the history survives restarts.">
          <Link className="section-link" to="/activity">open the log →</Link>
        </Row>
      </Block>
    </>
  );
}

function IntegrationsTab() {
  const { settings, update } = useSettings();
  const intg = settings?.integrations;
  const [feedUrl, setFeedUrl] = useState('');
  const [sym, setSym] = useState('');
  const [symProblem, setSymProblem] = useState<string | null>(null);
  if (!settings || !intg) return <Loading what="integration settings" />;
  const feeds = intg.news.feeds || [];
  const symbols = intg.markets.symbols || [];
  const touch = () => { invalidateShared('/api/news'); invalidateShared('/api/weather'); invalidateShared('/api/market'); };
  // Commit the symbol field: normalize every entry through the provider's rules, refuse the
  // whole batch with a reason if one entry is not a symbol (no silent dropping, no URLs)
  const commitSymbols = () => {
    const parts = sym.toUpperCase().split(/[,\s]+/).filter(Boolean);
    if (!parts.length) { setSym(''); setSymProblem(null); return; }
    const norm = parts.map(normalizeSymbolInput);
    const badIdx = norm.findIndex((n) => n.symbol == null);
    if (badIdx !== -1) { setSymProblem(`“${parts[badIdx]}” — ${norm[badIdx].reason}`); return; }
    const add = norm.map((n) => n.symbol as string).filter((x) => !symbols.includes(x));
    if (add.length) { update({ integrations: { markets: { symbols: [...symbols, ...add] } } }, true); touch(); }
    setSym(''); setSymProblem(null);
  };
  return (
    <>
      <p className="lede">Every value here is yours. OpusHub ships no defaults and never invents a reading — each widget shows its real provider state, and nothing is displayed that could not be fetched.</p>

      <Block title="News" aside={<Link className="section-link" to="/">see it on the Hub →</Link>}>
        <div className="editor-list">
          {feeds.map((f, i) => (
            <div className="editor-item" key={i}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontWeight: 560 }}>{f.name || URLSafe(f.url)}</b>
                <div className="stale-note mono-meta" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.url}</div>
              </span>
              <button className="icon-btn" aria-label="Remove feed" onClick={() => { update({ integrations: { news: { feeds: feeds.filter((_, j) => j !== i) } } }, true); touch(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
              </button>
            </div>
          ))}
          {!feeds.length && <div className="editor-item stale-note">No feeds yet — the News widget will say so rather than show an empty box.</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 'var(--sp-3)' }}>
          <input className="input" style={{ flex: 1 }} placeholder="https://example.com/feed.xml" value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} aria-label="Feed URL" />
          <button className="btn" disabled={!feedUrl.trim()} onClick={() => { update({ integrations: { news: { feeds: [...feeds, { url: feedUrl.trim(), name: null }] } } }, true); touch(); setFeedUrl(''); }}>Add</button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'var(--sp-3)' }}>
          {FEED_SUGGESTIONS.filter((s) => !feeds.some((f) => f.url === s.url)).map((s) => (
            <button key={s.url} className="chip" onClick={() => { update({ integrations: { news: { feeds: [...feeds, s] } } }, true); touch(); }}>+ {s.name}</button>
          ))}
        </div>
      </Block>

      <Block title="Weather">
        <Row label="Location" desc="City name or explicit coordinates — used with Open-Meteo (keyless)." tight>
          <input className="input" style={{ width: 240 }} defaultValue={intg.weather.location || ''} placeholder="Amsterdam" aria-label="Weather location"
            onBlur={(e) => { update({ integrations: { weather: { location: e.target.value.trim() || null } } }, true); touch(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </Row>
        <Row label="Units" tight>
          <Segmented value={intg.weather.units} onChange={(v) => { update({ integrations: { weather: { units: v } } }, true); touch(); }} ariaLabel="Units"
            options={[{ value: 'c', label: '°C' }, { value: 'f', label: '°F' }]} />
        </Row>
        <Row label="Where it appears" desc="The Hub header shows the current temperature when weather is available; the sidebar widget shows the full reading." tight>
          <Link className="btn btn-sm" to="/settings/widgets">Widget settings</Link>
        </Row>
      </Block>

      <Block title="Markets" aside={<span className="stale-note">Yahoo Finance (keyless) — bare tickers are US, <code>.NS</code> NSE, <code>^</code> indices, <code>-USD</code> crypto, <code>=X</code> FX, <code>=F</code> futures</span>}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 'var(--sp-3)' }}>
          {symbols.map((s, i) => (
            <span className="chip" key={s}>
              {s}
              <button className="x" aria-label={`Remove ${s}`} onClick={() => { update({ integrations: { markets: { symbols: symbols.filter((_, j) => j !== i) } } }, true); touch(); }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" /></svg>
              </button>
            </span>
          ))}
          {!symbols.length && <span className="stale-note">No symbols configured.</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" style={{ width: 200 }} placeholder="AAPL, RELIANCE.NS, ^GSPC…" value={sym}
            onChange={(e) => { setSym(e.target.value); setSymProblem(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') commitSymbols(); }}
            onBlur={commitSymbols}
            aria-label="Add symbol" />
          <button className="btn" disabled={!sym.trim()} onClick={commitSymbols}>Add</button>
        </div>
        {symProblem && <span className="stale-note" style={{ color: 'var(--fail)', display: 'inline-block', marginTop: 6 }}>✗ {symProblem}</span>}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'var(--sp-3)' }}>
          {SYMBOL_SUGGESTIONS.filter((s) => !symbols.includes(s)).map((s) => (
            <button key={s} className="chip" onClick={() => { update({ integrations: { markets: { symbols: [...symbols, s] } } }, true); touch(); }}>+ {s}</button>
          ))}
        </div>
      </Block>
    </>
  );
}
function URLSafe(u: string) { try { return new URL(u).host; } catch { return u.slice(0, 30); } }
function hostOf(u: string) { try { return new URL(u).hostname; } catch { return u; } }

/* ============ Advanced ============ */
function AdvancedTab() {
  const { settings, update } = useSettings();
  return (
    <>
      <p className="lede">
        Custom assets and polling. Everything here is opt-in and stays on the frontend: a stylesheet can add to
        OpusHub's rendering, a script runs in the page only (never on the server), and the refresh values decide how
        often each provider is asked — lower is not better.
      </p>

      <Block title="Hub behaviour">
        <Row label="Log service launches" desc="Adds an Activity event when you open a service from OpusHub." tight>
          <Switch checked={settings?.behavior.logLaunches ?? true} onChange={(v) => update({ behavior: { logLaunches: v } }, true)} label="Log launches" />
        </Row>
        <Row label="System refresh" desc="Seconds between host metric polls." tight>
          <input type="number" min={2} max={300} className="input" style={{ width: 90 }} defaultValue={settings?.behavior.refresh.system}
            onBlur={(e) => update({ behavior: { refresh: { system: Math.max(2, Number(e.target.value) || 5) } } }, true)} aria-label="System refresh seconds" />
        </Row>
        <Row label="Services refresh" desc="Containers are polled gently — the engine's API is not free." tight>
          <input type="number" min={5} max={600} className="input" style={{ width: 90 }} defaultValue={settings?.behavior.refresh.services}
            onBlur={(e) => update({ behavior: { refresh: { services: Math.max(5, Number(e.target.value) || 30) } } }, true)} aria-label="Services refresh seconds" />
        </Row>
      </Block>

      <CustomCodeBlock
        cssEnabled={settings?.advanced?.customCss ?? false}
        jsEnabled={settings?.advanced?.customJs ?? false}
        onToggle={(which, v) => update(which === 'css' ? { advanced: { customCss: v } } : { advanced: { customJs: v } }, true)}
      />
    </>
  );
}

/**
 * The custom-code editor. Two files, each with its own switch, its own draft and its own failure.
 *
 * What it deliberately does not do is hide the file behind the switch: an operator who turns custom
 * CSS off still sees what is in theme.css, because the alternative is a file they cannot read
 * without a shell. Editing stays available either way — nothing here is loaded into a page until
 * the switch is on, and nothing here is ever executed by the server.
 *
 * A save is refused as a whole when the syntax check fails (server-side, in `PUT /api/custom`), so
 * the draft is preserved on screen and the previous file stays on disk. Reset is the escape hatch.
 */
function CustomCodeBlock({ cssEnabled, jsEnabled, onToggle }: {
  cssEnabled: boolean; jsEnabled: boolean; onToggle: (which: 'css' | 'js', v: boolean) => void;
}) {
  const { data: custom, refresh } = usePolled<CustomDoc>('/api/custom', 0);
  const { save, busy, err } = useSave();
  const [cssDraft, setCssDraft] = useState<string | null>(null);
  const [jsDraft, setJsDraft] = useState<string | null>(null);
  const [noted, setNoted] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'theme.css' | 'app.js' | null>(null);

  const commit = (which: 'css' | 'js') => save(async () => {
    const body = which === 'css' ? { css: cssDraft ?? '' } : { js: jsDraft ?? '' };
    await put('/api/custom', body);
    if (which === 'css') setCssDraft(null); else setJsDraft(null);
    await refresh();
    invalidateShared('/api/custom');
    setNoted(`${which === 'css' ? 'theme.css' : 'app.js'} saved — versions recorded`);
  });

  const reset = async (file: 'theme.css' | 'app.js') => {
    await save(async () => {
      await post('/api/custom/reset', { file });
      setConfirming(null);
      if (file === 'theme.css') setCssDraft(null); else setJsDraft(null);
      await refresh();
      invalidateShared('/api/custom');
      setNoted(`${file} emptied`);
    });
  };

  const dirty = (which: 'css' | 'js') => (which === 'css' ? cssDraft != null && cssDraft !== (custom?.css ?? '') : jsDraft != null && jsDraft !== (custom?.js ?? ''));

  return (
    <Block title="Custom CSS & JS" aside={<span className="stale-note">config/theme.css · config/app.js</span>}>
      <p className="stale-note" style={{ marginBottom: 'var(--sp-3)' }}>
        Same-origin, authenticated, opt-in, and never executed by the server: theme.css is a stylesheet
        the browser loads, app.js is a script the browser runs in the page. A syntax error is refused
        at save time, so the file that is live stays valid. Every save is a configuration version.
      </p>

      <Row label="theme.css" desc={custom?.cssEnabled ? 'Loading on every page.' : 'Not loaded — the file is saved but no page links it.'} tight>
        <span className="mono-meta">
          {custom ? `${new Blob([cssDraft ?? custom.css]).size} B · ${custom.cssModified ? relTime(Date.parse(custom.cssModified)) : 'never written'}` : '—'}
        </span>
        <Switch checked={cssEnabled} onChange={(v) => onToggle('css', v)} label="Enable custom CSS" />
      </Row>
      <div className="field" style={{ marginBottom: 'var(--sp-4)' }}>
        <textarea
          className="textarea mono-meta cfg-code" rows={9} spellCheck={false} aria-label="theme.css"
          value={cssDraft ?? custom?.css ?? ''}
          onChange={(e) => { setCssDraft(e.target.value); setNoted(null); }}
        />
        <div className="cfg-code-actions">
          <button className="btn btn-sm btn-primary" disabled={busy || !dirty('css')} onClick={() => void commit('css')}>{busy ? 'Saving…' : 'Save theme.css'}</button>
          {dirty('css') && <button className="btn btn-sm btn-quiet" onClick={() => setCssDraft(null)}>Discard</button>}
          <button className="btn btn-sm btn-quiet" disabled={busy || !(custom?.css)} onClick={() => setConfirming('theme.css')}>Reset</button>
          <span className="stale-note">
            stylesheets add — they cannot remove OpusHub&apos;s own rules, and <code className="mono-meta">@import</code> is refused
            so a theme cannot pull in a third-party page.
          </span>
        </div>
      </div>

      <Row label="app.js" desc={custom?.jsEnabled ? 'Running in every page you open.' : 'Not loaded — the file is saved but no page includes it.'} tight>
        <span className="mono-meta">
          {custom ? `${new Blob([jsDraft ?? custom.js]).size} B · ${custom.jsModified ? relTime(Date.parse(custom.jsModified)) : 'never written'}` : '—'}
        </span>
        <Switch checked={jsEnabled} onChange={(v) => onToggle('js', v)} label="Enable custom JS" />
      </Row>
      <div className="field">
        <textarea
          className="textarea mono-meta cfg-code" rows={9} spellCheck={false} aria-label="app.js"
          value={jsDraft ?? custom?.js ?? ''}
          onChange={(e) => { setJsDraft(e.target.value); setNoted(null); }}
        />
        <div className="cfg-code-actions">
          <button className="btn btn-sm btn-primary" disabled={busy || !dirty('js')} onClick={() => void commit('js')}>{busy ? 'Saving…' : 'Save app.js'}</button>
          {dirty('js') && <button className="btn btn-sm btn-quiet" onClick={() => setJsDraft(null)}>Discard</button>}
          <button className="btn btn-sm btn-quiet" disabled={busy || !(custom?.js)} onClick={() => setConfirming('app.js')}>Reset</button>
          <span className="stale-note">
            this runs in your browser only. It has exactly the privileges the page has — no shell, no
            filesystem, no Docker — because the server never evaluates it.
          </span>
        </div>
      </div>

      {(err || noted) && (
        <p className="stale-note" role="status" style={{ marginTop: 'var(--sp-3)', color: err ? 'var(--fail)' : 'var(--ok)' }}>
          {err || noted}
        </p>
      )}

      {confirming && (
        <Modal
          title={`Empty ${confirming}?`}
          onClose={() => setConfirming(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void reset(confirming)}>Reset the file</button>
            </>
          )}
        >
          <p>This writes an empty file and records a version first, so it can be restored from History.</p>
          <p className="stale-note">Nothing else is touched — the enable switch stays where it is.</p>
        </Modal>
      )}
    </Block>
  );
}

/** Provider health — one quiet table, technical detail behind disclosure. The Hub itself is
 *  never dominated by this; it lives here for the moment something stops answering. */
function ProvidersBlock() {
  const { data } = usePolled<ProvidersDoc>('/api/providers', 30_000);
  if (!data) return <Block title="Providers"><p className="stale-note">Checking providers…</p></Block>;
  const word = (s: string) => s === 'available' ? 'Available' : s === 'degraded' ? 'Degraded' : s === 'idle' ? 'Idle' : 'Unavailable';
  return (
    <Block title="Providers" aside={<span className="stale-note">checked {relTime(data.at)}</span>}>
      <div className="prov-table" role="table" aria-label="Provider health">
        {data.providers.map((p) => (
          <div className="prov-row" role="row" key={p.name}>
            <span role="cell" className="prov-name">{p.name[0].toUpperCase() + p.name.slice(1)}</span>
            <span role="cell"><StatusLine state={p.state} note={word(p.state)} /></span>
            <span role="cell" className="stale-note">
              {p.lastOk ? `last success ${relTime(p.lastOk)}` : 'never succeeded'}
            </span>
            {p.reason && (
              <details className="tech" role="cell"><summary>Why</summary><code>{p.reason}</code></details>
            )}
          </div>
        ))}
      </div>
    </Block>
  );
}

/** Discovery status — the honest answer to “why is nothing showing up?”. */
function DiscoveryBlock(_props: { health: HealthDoc | null }) {
  const { data, refresh } = usePolled<DiscoveryDoc>('/api/discovery', 30_000);
  const { busy, save } = useSave();
  if (!data) return <Block title="Service discovery"><Loading what="the engine's status" /></Block>;
  const e = data.engine;
  return (
    <Block
      title="Service discovery"
      aside={
        <button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => save(async () => { await post('/api/discovery/refresh'); invalidateShared('/api/services'); invalidateShared('/api/discovery'); refresh(); })}>
          {busy ? 'Refreshing…' : 'Refresh now'}
        </button>
      }
    >
      <p className="lede" style={{ marginBottom: 'var(--sp-4)' }}>
        Docker decides what exists; URLs come from Traefik labels, published ports or your own override. Nothing is
        assumed about domains or ports, and no socket path ever reaches this page.
      </p>
      <div className="sys-kv" style={{ marginTop: 0 }}>
        <dt>Engine</dt><dd>{e.ok ? `connected${e.version ? ` · v${e.version}` : ''}${e.api ? ` · API ${e.api}` : ''}` : e.state}</dd>
        <dt>Containers</dt><dd>{e.containers} · {e.running} running · {e.stopped} stopped</dd>
        <dt>Inventory</dt><dd>{data.inventory.applications} applications · {data.inventory.infrastructure} infrastructure · {data.inventory.stacks} stacks · {data.inventory.standalone} standalone</dd>
        <dt>URLs</dt><dd>{data.urlDiscovery.withUrl} with a URL · {data.urlDiscovery.withoutUrl} without {data.urlDiscovery.hostAddress ? <span className="mono-meta"> · host {data.urlDiscovery.hostAddress} ({data.urlDiscovery.hostAddressSource})</span> : null}</dd>
        <dt>Overlays</dt><dd>{data.overlays.serviceOverlays} of {data.overlays.serviceEntries ?? data.overlays.serviceOverlays} service entries bind · {data.overlays.stackOverlays} of {data.overlays.stackEntries ?? data.overlays.stackOverlays} stack entries bind</dd>
      </div>
      {data.overlays.unmatched > 0 && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <div className="micro-label">Unmatched overlays</div>
          <ul style={{ display: 'grid', gap: 4, marginTop: 6 }}>
            {(data.overlays.unmatchedList || []).slice(0, 12).map((u, i) => (
              <li key={i} className="stale-note">{u.kind === 'stack' ? 'stack' : 'service'} <b>{u.name}</b> — {u.reason}</li>
            ))}
          </ul>
          <Link className="section-link" to="/settings/services">Fix the overlays →</Link>
        </div>
      )}
      {!e.ok && (
        <ProviderNote
          status="unavailable"
          reason="OpusHub cannot see containers right now, so live status, stats and logs stay off. Set OPUSHUB_DOCKER_SOCKET (or DOCKER_HOST) and restart."
          fixHref="/settings/environment"
          fixLabel="How discovery resolves →"
        />
      )}
    </Block>
  );
}
