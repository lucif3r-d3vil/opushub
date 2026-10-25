// The Add monitor and Defaults forms: what the person types becomes exactly what the monitoring API
// accepts, and nothing else. Pure functions, so the rules are tested without a browser.
import type { Service } from './types';

export type MonitorType = 'http' | 'tcp' | 'docker';
export type TargetKind = 'service' | 'url' | 'hostport' | 'none';

export interface Classified {
  kind: TargetKind;
  /** a discovered service, when the text names one */
  service?: { group: string | null; name: string; displayName: string };
  url?: string;
  host?: string;
  port?: number;
  /** why the text is not yet a target, when it is not */
  problem?: string;
}

/** What the single "what to watch" field means: a discovered service, a web address, or host:port. */
export function classifyTarget(raw: string, services: Pick<Service, 'name' | 'displayName' | 'group'>[]): Classified {
  const text = raw.trim();
  if (!text) return { kind: 'none' };
  const lower = text.toLowerCase();
  const svc = services.find((s) => s.name.toLowerCase() === lower || s.displayName.toLowerCase() === lower);
  if (svc) return { kind: 'service', service: { group: svc.group || null, name: svc.name, displayName: svc.displayName } };
  if (/^https?:\/\//i.test(text)) {
    try { const u = new URL(text); if (!u.hostname) throw new Error('x'); return { kind: 'url', url: text }; } catch { return { kind: 'none', problem: 'That does not look like a web address.' }; }
  }
  const hp = text.match(/^([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\]):(\d{1,5})$/i);
  if (hp) {
    const port = Number(hp[3]);
    if (port < 1 || port > 65535) return { kind: 'none', problem: 'The port must be between 1 and 65535.' };
    return { kind: 'hostport', host: hp[1], port };
  }
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/.*)?$/i.test(text)) return { kind: 'none', problem: 'Start a web address with http:// or https://.' };
  return { kind: 'none', problem: 'Choose a discovered service, or type a web address (https://…) or host:port.' };
}

/** The checks that make sense for a target. Only valid combinations are offered. */
export function typesFor(kind: TargetKind): { type: MonitorType; label: string; hint: string }[] {
  if (kind === 'service') return [
    { type: 'http', label: 'Web check', hint: 'Its web address answers' },
    { type: 'docker', label: 'Container state', hint: 'The container is running and healthy' },
  ];
  if (kind === 'url') return [{ type: 'http', label: 'Web check', hint: 'The address answers' }];
  if (kind === 'hostport') return [{ type: 'tcp', label: 'Port check', hint: 'The port accepts a connection' }];
  return [];
}

export function defaultName(c: Classified): string {
  if (c.kind === 'service') return c.service!.displayName;
  if (c.kind === 'url') { try { return new URL(c.url!).hostname; } catch { return ''; } }
  if (c.kind === 'hostport') return `${c.host}:${c.port}`;
  return '';
}

/** The body for POST /api/monitoring/monitors: a name, a type and a target, nothing the engine would ignore. */
export function monitorDraft(c: Classified, type: MonitorType, name: string) {
  const target = c.kind === 'service' ? { service: { group: c.service!.group, name: c.service!.name } }
    : c.kind === 'url' ? { url: c.url }
      : { host: c.host, port: c.port };
  return { name: name.trim(), type, target };
}

/* ---------------- defaults ---------------- */

export interface Bounds { [k: string]: { min: number; max: number; default: number } }
export interface DefaultsForm { intervalS: string; timeoutS: string; slowS: string; days: string }

export const toForm = (s: { intervalMs: number; timeoutMs: number; retentionHours: number }, slowMs: number): DefaultsForm => ({
  intervalS: String(s.intervalMs / 1000), timeoutS: String(s.timeoutMs / 1000), slowS: String(slowMs / 1000), days: String(Math.round(s.retentionHours / 24)),
});

export interface DefaultsPayload { monitoring: { intervalMs: number; timeoutMs: number; retentionHours: number; retentionSamples: number }; slowMs: number }

/** Validate the form against the server's own bounds; returns the payload, or a message per field. */
export function validateDefaults(f: DefaultsForm, b: Bounds): { ok: true; payload: DefaultsPayload } | { ok: false; errors: Partial<Record<keyof DefaultsForm, string>> } {
  const errors: Partial<Record<keyof DefaultsForm, string>> = {};
  const num = (v: string) => (v.trim() === '' ? NaN : Number(v));
  const interval = num(f.intervalS) * 1000; const timeout = num(f.timeoutS) * 1000; const slow = num(f.slowS) * 1000; const days = num(f.days);
  const iv = b.intervalMs ?? { min: 10_000, max: 86_400_000 }; const tv = b.timeoutMs ?? { min: 500, max: 30_000 }; const rv = b.retentionHours ?? { min: 24, max: 2000 };
  if (!Number.isFinite(interval) || interval < iv.min || interval > iv.max) errors.intervalS = `${iv.min / 1000} to ${iv.max / 1000} seconds`;
  if (!Number.isFinite(timeout) || timeout < tv.min || timeout > tv.max) errors.timeoutS = `${tv.min / 1000} to ${tv.max / 1000} seconds`;
  else if (!errors.intervalS && timeout > interval - 1000) errors.timeoutS = 'at least a second shorter than the interval';
  if (!Number.isFinite(slow) || slow < 100 || slow > 30_000) errors.slowS = '0.1 to 30 seconds';
  if (!Number.isInteger(days) || days * 24 < rv.min || days * 24 > rv.max) errors.days = `${Math.ceil(rv.min / 24)} to ${Math.floor(rv.max / 24)} days`;
  if (Object.keys(errors).length) return { ok: false, errors };
  // detailed checks are kept for about a day (2000 at most), so the 24-hour ribbon is drawn from real checks
  const retentionSamples = Math.min(2000, Math.max(30, Math.ceil(86_400_000 / interval) + 12));
  return { ok: true, payload: { monitoring: { intervalMs: interval, timeoutMs: timeout, retentionHours: days * 24, retentionSamples }, slowMs: Math.round(slow) } };
}
