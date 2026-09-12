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
  status: 'operational' | 'degraded' | 'attention' | 'unlinked' | 'unavailable' | string;
  statusReason: string | null;
  containerCount: number;
  runningCount: number;
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

export interface ActivityEvent {
  id: string; t: number; iso: string;
  source: 'system' | 'config' | 'user' | 'docker' | string;
  type: string;
  subject: string | null;
  message: string | null;
  meta?: Record<string, unknown> | null;
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
    background: { mode: 'quiet' | 'horizon' | 'photo'; photo: string | null; blur: number; scrim: number };
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

export interface LayoutDoc {
  hub: {
    main: string[];
    rail: string[];
    hidden: string[];
    sizes: Record<string, 'sm' | 'md' | 'lg'>;
    setupDismissed?: boolean;
  };
  services: { groupOrder: string[] | null; order: Record<string, string[]> };
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
