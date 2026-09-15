export type ProviderStatus = 'ok' | 'unavailable' | 'unconfigured' | 'error' | 'partial' | 'idle' | 'degraded';

export type ServiceStatusState = 'up' | 'down' | 'unhealthy' | 'unmanaged' | 'unavailable' | 'restarting' | 'paused' | string;

/** Where a service's URL came from. `none` means there is genuinely no web endpoint — OpusHub
 * never invents one. Surfaced in the service page's technical details and in Settings → System. */
export type UrlSource = 'manual' | 'traefik' | 'published-port' | 'none';

export interface ServiceMetaPair { label: string; value: string }

/** Container identity as Docker reports it. Everything here is infrastructure, not presentation. */
export interface ContainerInfo {
  name: string;
  id: string;
  image: string | null;
  state: string | null;
  status: string | null;
  health: string | null;
  created: number | null;
  restartCount: number | null;
  composeProject: string | null;
  composeService: string | null;
  networks: { name: string; ip?: string; gateway?: string; aliases?: string[] }[];
  ports: { ip: string; private: number; public: number | null; type: string }[];
  labels: {
    compose: { project: string | null; service: string | null; version: string | null } | null;
    proxy: { router: string; hosts: string[]; entrypoints: string[]; tls: boolean; path: string | null; service: string | null; servicePort: number | null }[] | null;
    overlay: { displayName: string | null; icon: string | null; group: string | null; url: string | null; description: string | null } | null;
  };
}

/** The single canonical service object: one per container. Infrastructure identity from Docker,
 * presentation identity from the OpusHub overlay — `configured` says whether an overlay matched. */
export interface Service {
  name: string;                 // container name — unique, and the key used in URLs
  displayName: string;
  slug: string;
  id: string;                   // container id (12)
  app: string | null;
  description: string | null;
  url: string | null;
  urlSource: UrlSource;
  urlNote?: string | null;
  icon: string | null;
  iconSource?: 'config' | 'label' | 'derived:image' | 'none' | null;
  group: string;
  groupSource?: string;
  keywords?: string[];
  meta?: ServiceMetaPair[];
  hidden?: boolean;
  showOnHub?: boolean;
  order?: number | null;
  configured: boolean;
  discovered: boolean;
  /** what enriched this container: null, 'container label', or 'services.yaml' */
  overlaid?: string | null;
  kind: 'application' | 'infrastructure';
  kindSource?: string;
  status: ServiceStatusState;
  statusReason?: string | null;
  stack: string | null;          // stack id (the compose project), not a config-invented name
  stackDisplayName: string | null;
  container: ContainerInfo;
}

export interface ServiceGroup {
  name: string;
  description?: string | null;
  icon?: string | null;
  configured?: boolean;
  services: Service[];
}

export interface UnmatchedOverlay {
  kind: 'service' | 'stack';
  name: string;
  group?: string | null;
  container?: string | null;
  conflict?: string | null;
  reason: string;
}

export interface DiscoveryStats {
  containers: number; running: number; stopped: number;
  applications: number; infrastructure: number;
  urlSources: Partial<Record<UrlSource, number>>;
  withUrl: number; configured: number; discovered: number; stacks: number; standalone: number;
}

export interface ServicesDoc {
  groups: ServiceGroup[];
  /** the full flat inventory (applications + infrastructure + hidden) — what the overlay editor binds to */
  services?: Service[];
  infrastructure: Service[];
  skipped?: { group: string; name: string; reason: string }[];
  unmatched?: UnmatchedOverlay[];
  live: boolean;
  statusSource: string;
  statusReason: string | null;
  lastKnown?: LastKnownSummary | null;
  discoveredAt?: number | null;
  stats?: DiscoveryStats;
}

export interface ContainerBrief {
  name: string; id: string; state: string; status: string; health: string | null; image: string;
  composeProject?: string | null; composeService?: string | null;
}

export interface StackMember {
  service: string;
  name: string;
  containerName: string;
  group: string | null;
  icon: string | null;
  url: string | null;
  urlSource: UrlSource;
  kind: 'application' | 'infrastructure';
  configured: boolean;
  route: string | null;
  container: ContainerBrief | null;
  // enriched on the detail route:
  stats?: { cpu: number | null; memory: { used: number | null; limit: number | null }; net: { rx: number; tx: number } } | null;
  ports?: { private: string; host: string; hostPort: string }[];
  networks?: { name: string; ip: string; gateway: string; aliases: string[] }[];
  mounts?: { type: string; source: string; target: string; rw: boolean }[];
  startedAt?: string | null;
  health?: string | null;
  restartCount?: number;
  restartPolicy?: string | null;
  command?: string | null;
  error?: boolean;
}

export interface Stack {
  id: string;                    // compose project name (the URL key)
  project: string | null;        // null → a configured overlay grouping real containers
  name: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  notes: string | null;
  /** deliberately null: compose file paths stay server-side (see docs/04-discovery.md) */
  compose: string | null;
  source: 'configured' | 'discovered';
  configured: boolean;
  /** deterministic model — see server/discovery.js stackStatusOf:
   *  unavailable > unlinked > unknown > { operational | degraded | stopped | attention } */
  status: 'operational' | 'degraded' | 'attention' | 'stopped' | 'unknown' | 'unlinked' | 'unavailable' | string;
  statusReason: string | null;
  containerCount: number;
  runningCount: number;
  unhealthyCount?: number;
  stoppedCount?: number;
  attentionCount?: number;
  services: string[];
  members: StackMember[];
}

export interface StandaloneContainer extends ContainerBrief {
  displayName: string;
  kind: 'application' | 'infrastructure';
  url: string | null;
  urlSource: UrlSource;
}

export interface StacksDoc {
  stacks: Stack[];
  live: boolean;
  statusReason: string | null;
  lastKnown?: LastKnownSummary | null;
  standalone: StandaloneContainer[];
  unmatched?: UnmatchedOverlay[];
}

/** Settings → System: how discovery is going, with no engine internals beyond counts. */
export interface DiscoveryDoc {
  engine: { ok: boolean; state: string; version: string | null; api: string | null; containers: number; running: number; stopped: number; operatingSystem: string | null };
  urlDiscovery: {
    sources: Partial<Record<UrlSource, number>>;
    withUrl: number; withoutUrl: number;
    hostAddress: string | null; hostAddressSource: string;
    entrypointPorts: Record<string, string>;
    traefikRouters: number;
  };
  overlays: {
    /** overlays that bind to a live container/project */
    serviceOverlays: number;
    stackOverlays: number;
    /** what the YAML files actually contain — the difference is what silently does nothing */
    serviceEntries?: number;
    stackEntries?: number;
    unmatched: number;
    unmatchedList?: UnmatchedOverlay[];
    skipped: number;
  };
  inventory: { applications: number; infrastructure: number; stacks: number; standalone: number };
  discoveredAt: number | null;
}

export interface SystemSnapshot {
  at: number;
  host: { hostname: string; os: string; kernel: string; arch: string; node: string; uptimeSec: number | null; bootAt: string | null; model: string | null };
  cpu: {
    usage: number | null;
    perCore: { id: number; usage: number | null }[];
    cores: number;
    model: string | null;
    mhz: number | null;
    load1: number | null; load5: number | null; load15: number | null;
    temperature: { zone: string; label: string; celsius: number }[] | null;
  };
  memory: { total: number; available: number; free: number; buffers: number; cached: number; swapTotal: number; swapFree: number } | null;
  disks: { mount: string; device: string; fs: string; total: number; used: number; free: number }[];
  network: { name: string; rxBytes: number; txBytes: number; rxPerSec: number | null; txPerSec: number | null; mbps: number | null; ips: string[]; rxErrors: number; txErrors: number }[];
  processes: number | null;
  gpu: { present: boolean; vendor?: string; driver?: string; devices?: string[] };
}

export interface HistoryPoint { t: number; cpu: number | null; memUsedPct: number | null; load: number | null; rx: number | null; tx: number | null; temp: number | null; procs: number | null }

export type EventSeverity = 'info' | 'notice' | 'warning' | 'critical';
export type EventCategory = 'service' | 'stack' | 'docker' | 'system' | 'security' | 'config';
export interface ActivityEvent {
  id: string; t: number; iso: string;
  source: 'system' | 'config' | 'user' | 'docker' | string;
  type: string;
  subject: string | null;
  message: string | null;
  meta?: Record<string, unknown> | null;
  severity?: EventSeverity;
  category?: EventCategory;
}

/** A burst of same-type docker events folded into one row (see server/activity.js groupEvents).
 *  The underlying events stay accessible — grouping is presentation, not deletion. */
export interface ActivityGroup {
  grouped: true;
  id: string; t: number; iso: string;
  source: 'docker'; type: string;
  subject: string | null;
  project: string | null;
  count: number;
  subjects: string[];
  message: string | null;
  meta?: Record<string, unknown> | null;
  severity?: EventSeverity;
  category?: EventCategory;
  events: ActivityEvent[];
}

export interface NewsItem { title: string; link: string; source: string | null; publishedAt: string | null; summary: string | null; image: string | null }
export interface NewsDoc { status: ProviderStatus; reason?: string | null; items: NewsItem[]; errors?: { url: string; name: string | null; error: string }[]; fetchedAt?: number }

export interface WeatherDoc {
  status: ProviderStatus; reason?: string | null;
  place?: string;
  current?: { tempC: number; feelsC: number; humidity: number; windKph: number; precipMm: number; code: number; label: string; icon: string; isDay: boolean };
  today?: { highC: number | null; lowC: number | null; sunrise: string | null; sunset: string | null; precipChance: number | null };
  forecast?: { date: string; label: string; code: number | null; highC: number | null; lowC: number | null; precipChance: number | null }[];
  units?: 'c' | 'f';
}

export interface MarketItem {
  symbol: string; status: 'ok' | 'no-data' | string;
  price?: number; change?: number | null; changePct?: number | null;
  dayHigh?: number | null; dayLow?: number | null; volume?: number | null;
  quoteDate?: string; spark?: number[] | null; reason?: string;
}
export interface MarketDoc { status: ProviderStatus; reason?: string | null; items: MarketItem[] }

export interface SettingsDoc {
  app: { name: string; tagline: string };
  appearance: {
    theme: 'system' | 'dark' | 'light';
    accent: 'sage' | 'slate' | 'teal' | 'amber' | 'rose' | 'clay' | 'moss';
    density: 'comfortable' | 'compact';
    transparency: boolean;
    fontScale: number;
    background: {
      mode: 'quiet' | 'horizon' | 'photo'; photo: string | null; blur: number; scrim: number;
      position: 'center' | 'top' | 'bottom' | 'left' | 'right'; fit: 'cover' | 'contain';
    };
  };
  hub: { greetingName: string | null; clock24h: boolean; showSeconds: boolean };
  integrations: {
    news: { feeds: { url: string; name?: string | null }[] };
    weather: { location: string | null; latitude: number | null; longitude: number | null; place: string | null; units: 'c' | 'f' };
    markets: { symbols: string[] };
  };
  behavior: { logLaunches: boolean; refresh: { system: number; services: number } };
  infrastructure: { hostAddress: string | null; entrypointPorts: Record<string, string> };
  advanced: { customCss: boolean; customJs: boolean };
  _raw?: unknown;
  _text?: string;
}

/* ---------------- Hub composition (layout.json v2) ---------------- */

export type WidgetZone = 'main' | 'rail';
export type WidgetSize = 'sm' | 'md' | 'lg';
export type HubSpacing = 'cozy' | 'comfortable' | 'airy';

/** One Hub block. `type` decides what it is; the rest decides where it sits and how big it is. */
export interface WidgetInstance {
  id: string;
  type: string;
  title?: string;
  zone: WidgetZone;
  size: WidgetSize;
  visible: boolean;
  config: Record<string, unknown>;
}

export interface WidgetConfigField {
  key: string;
  label: string;
  type: 'text' | 'boolean' | 'number' | 'list' | 'group-list';
  hint?: string;
  options?: string[];
}

/** What the server will accept — the client renders from this, it does not define it. */
export interface WidgetCategory { id: string; label: string; description: string }

export interface WidgetCatalogueEntry {
  type: string;
  /** where this widget's information comes from — system · grid · information · personal */
  category?: string;
  title: string;
  description: string;
  zone: WidgetZone;
  size: WidgetSize;
  sizes: WidgetSize[];
  config: WidgetConfigField[];
}

export interface WidgetDoc {
  catalogue: WidgetCatalogueEntry[];
  /** the picker's organisation: system · grid · information · personal */
  categories?: WidgetCategory[];
  widgets: WidgetInstance[];
  spacing: HubSpacing;
}

export interface TemplateEntry {
  id: string;
  name: string;
  tagline: string;
  description: string;
  spacing: HubSpacing;
  widgets: { id: string; type: string; zone: WidgetZone; size: WidgetSize; title: string }[];
  groupPriority: string[];
  /** preferences that match no group on this system right now — shown, never faked */
  unmatchedGroups: string[];
  preview: LayoutDoc;
}

export interface TemplatesDoc {
  templates: TemplateEntry[];
  layout: LayoutDoc;
  spacing: HubSpacing;
  groupNames: string[];
}

export interface LayoutDoc {
  version?: number;
  hub: {
    /** ordered per zone: the array order IS the position */
    widgets: WidgetInstance[];
    spacing: HubSpacing;
    setupDismissed?: boolean;
  };
  services: { groupOrder: string[] | null; order: Record<string, string[]>; hiddenGroups: string[] };
}

export interface HealthDoc {
  name: string; version: string; configDir: string; dataDir: string; node?: string; platform?: string;
  env: { files: { file: string; keys: string[]; error?: string | null }[]; note: string };
  providers: {
    docker: { ok: boolean; state: 'connected' | 'no-socket' | 'socket-missing' | 'invalid-endpoint' | 'unreachable'; reason?: string; version?: string; api?: string };
    system: { ok: boolean; note: string };
  };
}

export interface IconSearchResult { ref: string; set: string; name: string; label: string; local: boolean }
export interface IconSearchDoc { results: IconSearchResult[]; total?: number; remote: { status: string; reason?: string } }

/* ---------------- Phase 3: read-only service intelligence ---------------- */

/** One sample of a container's resource history — real readings only, taken while somebody
 *  was looking at this service (never by a background loop; see server/statsHistory.js). */
export interface StatsSample {
  t: number;
  cpu: number | null;
  mem: number | null;
  memLimit: number | null;
  netRx: number | null;
  netTx: number | null;
  pids: number | null;
  blockIo: number | null;
}
export interface StatsHistoryDoc {
  service: string;
  samples: StatsSample[];
  watchingSince: number | null;
  capped: number;
}
export interface StatsDoc { status: 'ok' | 'unavailable' | string; stats: ContainerStats | null; at?: number }
export interface ContainerStats {
  cpu: number | null;
  memory: { used: number | null; limit: number | null };
  net: { rx: number; tx: number };
  pids: number | null;
  blockIo: number | null;
}

/** Real events OpusHub witnessed for one service, plus when it started watching. */
export interface ServiceHistoryDoc {
  service: string;
  events: ActivityEvent[];
  watchingSince: number | null; // null → the log is empty: NO history exists yet
  logStarted: number | null;
}

export interface ProviderHealth {
  name: 'docker' | 'system' | 'news' | 'weather' | 'markets' | string;
  state: 'available' | 'unavailable' | 'degraded' | 'idle';
  lastOk: number | null;
  lastTry: number | null;
  staleMs: number | null;
  reason: string | null;
}
export interface ProvidersDoc { at: number; providers: ProviderHealth[] }

/** Image facts from the engine — read-only, never an action surface. */
export interface ImageInfo {
  id: string | null;
  tags: string[];
  digests: string[];
  arch: string | null;
  os: string | null;
  created: string | null;
  size: number | null;
}

/* ==========================================================================
   Phase 6 — configuration, migration, history, export
   ========================================================================== */

/** The file-scope boundary, as the API states it. Rendered rather than described, so the
 *  separation between presentation configuration and protected state is visible in the UI. */
export interface ConfigScopeEntry { name: string; kind: string; label: string }
export interface ProtectedStateEntry { path: string; kind: string; why: string }
export interface ConfigScopeDoc {
  presentation: ConfigScopeEntry[];
  protected: ProtectedStateEntry[];
  rule: string;
}

export interface ConfigOverviewDoc {
  scope: ConfigScopeDoc;
  counts: { groups: number; services: number; configured: number; bookmarks: number; widgets: number; unmatched: number };
  custom: { cssEnabled: boolean; jsEnabled: boolean; cssBytes: number; jsBytes: number; cssModified: string | null; jsModified: string | null };
  history: HistoryStats;
  limits: Record<string, number>;
}

/* ---------- migration ---------- */

export interface ImportFileSpec { name: string; kind: string; label: string }
export interface RefusedFileSpec { name: string; why: string }
export interface ImportFilesDoc {
  accepted: ImportFileSpec[];
  refused: RefusedFileSpec[];
  note: string;
  limits: { fileBytes: number; bundleBytes: number; files: number; depth: number; nodes: number };
}

/** One entry from an imported file, after the engine has said what it is. */
export interface ImportedEntry {
  sourceGroup: string;
  sourceName: string;
  displayName: string | null;
  description: string | null;
  url: string | null;
  icon: string | null;
  iconDropped: string | null;
  group: string;
  containerHint: string | null;
}
export interface ImportMatch extends ImportedEntry {
  container: { id: string; name: string; containerName: string; displayName: string; group: string; image: string | null; state: string | null };
  matchHow: string;
  matchConfidence: 'explicit' | 'name' | 'url' | 'icon';
  existing: Record<string, unknown> | null;
}
export interface ImportUnmatched extends ImportedEntry {
  reason: string;
  suggestion: 'bookmark' | 'drop';
}
export interface ImportInvalid { name: string; group?: string; reason: string; kind: string }
export interface ImportConflict {
  container: string;
  service: string;
  source: string;
  changes: { field: string; current: string; imported: string }[];
}
export interface ImportGroupSummary { name: string; matched: number; unmatched: number; total: number }

export interface ImportPreviewDoc {
  source: 'homepage' | 'opushub';
  files: { file: string; kind: string; bytes: number; status: string; note?: string }[];
  refused: string[];
  ignored: { file: string; reason: string }[];
  secretsDropped: string[];
  summary: {
    groups: number; services: number; bookmarks: number; widgets: number; widgetGroups: number;
    matched: number; unmatched: number; invalid: number; conflicts: number;
    dockerConnected: boolean; dockerContainers: number;
  };
  groups: ImportGroupSummary[];
  matched: ImportMatch[];
  unmatched: ImportUnmatched[];
  invalid: ImportInvalid[];
  conflicts: ImportConflict[];
  bookmarks: { name: string; items: { name: string; href: string; description?: string }[] }[];
  widgets: { instances: { from: string; type: string }[]; unmapped: { name: string; reason: string }[]; credentials: string[] };
  unmappedWidgets: { name: string; reason: string }[];
  ignoredSettings: { key: string; value: string; reason: string }[];
  appearance: Record<string, unknown>;
  app: { name?: string; tagline?: string };
  custom: { css: string | null; js: string | null };
  layout: LayoutDoc | null;
  warnings: string[];
  plan?: {
    files: { name: string; entries: number }[];
    services: number; bookmarks: number; preservedUnmatched: number;
    settings: string[]; widgets: number; custom: string[];
  };
}

export interface ImportDecisions {
  keepUnmatched: 'bookmark' | 'drop' | 'overlay';
  includeBookmarks: boolean;
  includeWidgets: boolean;
  includeAppearance: boolean;
  includeCustom: boolean;
  skip: string[];
  groupRenames: Record<string, string>;
}

export interface ImportApplyResult {
  ok: boolean; mode: 'merge' | 'replace'; written: string[]; version: string | null;
  summary: ImportPreviewDoc['summary']; preservedUnmatched: number; skipped: number;
  warnings: string[]; secretsDropped: number;
}

/* ---------- history ---------- */

export interface HistoryStats {
  count: number; retention: { versions: number; bytes: number };
  totalBytes: number; oldest: string | null; newest: string | null;
}
export interface HistoryVersion {
  id: string; at: string; reason: string; subject: string | null; label: string | null;
  actor: string | null; bytes: number; files: string[]; changed: { file: string; from: string; to: string }[];
}
export interface HistoryDoc { versions: HistoryVersion[]; stats: HistoryStats; current: string | null; scope: string[] }
export interface DiffEntry { text: string; kind: 'added' | 'removed' | 'changed'; scope?: string; service?: string; field?: string; path?: string }
export interface DiffSection { file: string; title: string; kind?: 'added' | 'removed'; entries: DiffEntry[] }
export interface DiffDoc { version: string; against: string; sections: DiffSection[]; changes: number; identical: boolean }
export interface RestoreResult {
  ok: boolean; restored: string; restoredFrom: string; files: string[]; skipped: { file: string; reason: string }[];
  undoVersion: string | null; scope: string[];
}

/* ---------- export ---------- */

export interface ExportRedaction { kind: 'userinfo' | 'query' | 'machine'; url: string; note: string; where?: string }
export interface ExportBundle {
  format: 'opushub' | 'homepage';
  formatVersion: number;
  generatedAt: string;
  kind: 'native' | 'homepage';
  files: Record<string, string>;
  notes: string[];
  redactions: ExportRedaction[];
  machineSpecific?: string[];
  scope: string[];
}

/* ---------- per-service presentation ---------- */

export interface PresentationDoc {
  id: string;
  identity: {
    containerName: string; composeProject: string | null; composeService: string | null;
    image: string | null; state: string | null; labels: unknown;
  };
  detected: { displayName: string; group: string; url: string | null; urlSource: string | null; icon: string | null };
  override: {
    displayName: string | null; description: string | null; icon: string | null; group: string | null;
    url: string | null; hidden: boolean; showOnHub: boolean; order: number | null;
    app: string | null; keywords: string[];
  };
  effective: { displayName: string; group: string; url: string | null; urlSource: string | null; icon: string | null; status: string };
  configured: boolean;
}

/* ---------- groups ---------- */

export interface GroupEntry {
  name: string; description: string | null; icon: string | null; configured: boolean;
  hidden: boolean; serviceCount: number; running: number; composeProjects: string[];
}
export interface GroupsDoc {
  groups: GroupEntry[];
  order: string[] | null;
  hiddenGroups: string[];
  empty: string[];
  note: string;
}

/** Settings → Advanced: the custom-code editor's read. */
export interface CustomDoc {
  cssEnabled: boolean; jsEnabled: boolean;
  css: string; js: string;
  cssModified: string | null; jsModified: string | null;
  jsPresent: boolean;
}

/* Phase 7 — host, infrastructure, resources, unified health ------------------ */

export interface LastKnownSummary {
  at: number; containers: number; running: number; stopped: number;
  applications: number; infrastructure: number; stacks: number; withUrl: number;
  engine: { version: string | null; apiVersion: string | null } | null;
}

export interface HostDoc {
  at: number;
  host: { hostname: string | null; os: string | null; kernel: string | null; arch: string | null; model: string | null; uptimeSec: number | null; bootAt: string | null };
  cpu: { model: string | null; cores: number | null; threads: number | null; mhz: number | null };
  memory: { total: number | null };
  docker: {
    status: string; available: boolean; version: string | null; apiVersion: string | null;
    os: string | null; arch: string | null; driver: string | null;
    containers: number | null; running: number | null; stopped: number | null; paused: number | null;
  };
  address: { configured: string | null; detected: string | null; effective: string | null; source: string };
  traefik: {
    detected: boolean; source: string; routedContainers: number; routers: number; tlsRouters: number;
    entrypoints: string[]; container: { name: string; state: string | null } | null;
  };
  opushub: { name: string; version: string; gitSha: string | null; buildTime: string | null; imageTag: string | null; installationMode: string };
}

export interface DockerDoc {
  at: number;
  status: { ok: boolean; state: string; version?: string | null; api?: string | null; reason?: string };
  engine: { version: string | null; apiVersion: string | null; os: string | null; arch: string | null; driver: string | null } | null;
  counts: { containers: number | null; running: number | null; stopped: number | null; images: number | null; volumes: number | null; networks: number | null };
  live: boolean; statusReason: string | null; code: string | null;
  lastKnown: LastKnownSummary | null;
}

export interface InfraNetwork { id: string | null; name: string | null; driver: string | null; scope: string | null; internal: boolean; attachable: boolean; created: string | null; containerCount: number; containers: { name: string }[] }
export interface InfraVolume { name: string | null; driver: string | null; scope: string | null; createdAt: string | null; refCount: number | null; size: number | null }
export interface InfraImage { id: string | null; tags: string[]; digests: string[]; created: number | null; size: number | null; containers: number | null; usedBy: string[] }

export interface InfraSlice<T> { at: number; live: boolean; statusReason: string | null; code: string | null; count: number | null; stale: { at: number; staleAt: number; networks: InfraNetwork[]; volumes: InfraVolume[]; images: InfraImage[] } | null }
export interface NetworksDoc extends InfraSlice<InfraNetwork> { networks: InfraNetwork[] }
export interface VolumesDoc extends InfraSlice<InfraVolume> { volumes: InfraVolume[] }
export interface ImagesDoc extends InfraSlice<InfraImage> { images: InfraImage[] }

export interface StorageDoc {
  at: number;
  providers: { id: string; label: string; available: boolean | 'not-implemented'; reason: string | null; mounts?: { mount: string; device: string; fs: string; total: number; used: number; free: number; usedPct: number | null }[]; totals?: { mounts: number; total: number; used: number; free: number } | null; at: number }[];
}

export interface ResourcesDoc {
  at: number;
  cpu: { current: number | null; unit: string; average: number | null; peak: number | null; samples: number; cores: number | null; load: (number | null)[]; availability: string; source: string; timestamp: number | null };
  memory: { current: number | null; total: number | null; available: number | null; cached: number | null; usedPct: number | null; unit: string; averagePct: number | null; peakPct: number | null; samples: number; availability: string; source: string; timestamp: number | null };
  network: { current: { rxPerSec: number; txPerSec: number } | null; unit: string; averageRx: number | null; peakRx: number | null; averageTx: number | null; peakTx: number | null; samples: number; interfaces: string[]; availability: string; source: string; timestamp: number | null };
  storage: { current: { mounts: number; total: number; used: number; free: number } | null; mounts: number | null; availability: string; source: string; timestamp: number | null };
  gpu: { current: { vendor: string; devices: string[] | null; driver: string | null } | null; availability: string; reason?: string; source: string; timestamp: number | null };
}

export type HealthState = 'available' | 'healthy' | 'degraded' | 'unhealthy' | 'stopped' | 'starting' | 'unknown' | 'unreachable';

export interface ServiceHealthDoc {
  service: string | null; displayName: string | null;
  health: { state: HealthState; evidence: { container: string; healthcheck: string; http: string }; stack: string | null; startedAt: string | null; url: string | null; urlSource: string; detail: string };
  probe: { checked: boolean; reachable?: boolean | null; statusCode?: number | null; latencyMs?: number | null; checkedAt?: string | null; source?: string | null; errorType?: string | null; code?: string; reason?: string };
  evaluatedAt: number;
}

export interface AlertItem {
  id: string; signature: string;
  severity: 'warning' | 'critical';
  title: string; detail: string;
  evidence?: Record<string, unknown> | null;
  links?: { label: string; href: string }[];
  firedAt: number;
  acknowledged: boolean; ackAt: number | null;
}
export interface AlertChannel { id: string; label: string; blurb: string; status: string; configured: boolean }
export interface AlertsDoc {
  at: string;
  alerts: AlertItem[];
  counts: { critical: number; warning: number };
  channels: AlertChannel[];
}
