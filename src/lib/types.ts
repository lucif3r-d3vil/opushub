export type ProviderStatus = 'ok' | 'unavailable' | 'unconfigured' | 'error' | 'partial' | 'idle' | 'degraded';

export type ServiceStatusState = 'up' | 'down' | 'unhealthy' | 'unmanaged' | 'unavailable' | 'restarting' | 'paused' | string;

export interface ServiceMetaPair { label: string; value: string }

export interface Service {
  name: string;
  app: string | null;
  description: string | null;
  href: string | null;
  icon: string | null;
  container: string | null;
  stack: string | null;
  keywords: string[];
  meta: ServiceMetaPair[];
  group?: string;
  status?: ServiceStatusState;
  statusDetail?: { name: string; image: string; status: string; health: string | null } | null;
  statusReason?: string | null;
}

export interface ServiceGroup { name: string; description?: string | null; services: Service[] }
export interface ServicesDoc { groups: ServiceGroup[]; skipped?: { group: string; name: string; reason: string }[]; live: boolean; statusSource: string; statusReason: string | null }

export interface ContainerBrief { name: string; id: string; state: string; status: string; health: string | null; image: string }

export interface StackMember {
  service: string;
  icon: string | null;
  group: string | null;
  href: string | null;
  container: ContainerBrief | null;
  discovered?: boolean;
  // enriched on detail route:
  stats?: { cpu: number | null; memory: { used: number | null; limit: number | null }; net: { rx: number; tx: number } } | null;
  ports?: { private: string; host: string; hostPort: string }[];
  networks?: { name: string; ip: string; gateway: string; aliases: string[] }[];
  mounts?: { type: string; source: string; target: string; rw: boolean }[];
  startedAt?: string | null;
  health?: string | null;
}

export interface Stack {
  name: string;
  description: string | null;
  icon: string | null;
  services: string[];
  compose: string | null;
  notes: string | null;
  source: 'configured' | 'discovered';
  members: StackMember[];
  status: 'operational' | 'degraded' | 'attention' | 'unlinked' | 'unavailable' | string;
  statusReason: string | null;
  containerCount: number;
}

export interface StacksDoc {
  stacks: Stack[];
  live: boolean;
  statusReason: string | null;
  standalone: ContainerBrief[];
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
