// The Defaults popover and the Add monitor flow, beside the range switch.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { post, put, usePolled } from '../lib/api';
import {
  classifyTarget, defaultName, monitorDraft, toForm, typesFor, validateDefaults,
  type Bounds, type DefaultsForm, type MonitorType,
} from '../lib/monitorForm';
import { useSettings } from '../lib/theme';
import type { ServicesDoc } from '../lib/types';
import { Modal } from '../components/ui';

interface MonitoringSettings { settings: { intervalMs: number; timeoutMs: number; retentionHours: number; retentionSamples: number }; bounds: Bounds }

function DefaultsPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { settings, reload } = useSettings();
  const { data } = usePolled<MonitoringSettings>('/api/monitoring/settings', 0);
  const [form, setForm] = useState<DefaultsForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bounds: Bounds = data?.bounds ?? {};
  const slowMs = settings?.monitoring?.slowMs ?? 1000;
  useEffect(() => { if (data && !form) setForm(toForm(data.settings, slowMs)); }, [data, form, slowMs]);

  const checked = useMemo(() => (form ? validateDefaults(form, bounds) : null), [form, bounds]);
  const errors = checked && !checked.ok ? checked.errors : {};
  const set = (k: keyof DefaultsForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  const save = async () => {
    if (!checked || !checked.ok) return;
    setBusy(true); setError(null);
    try {
      await put('/api/monitoring/settings', checked.payload.monitoring);
      await put('/api/settings', { monitoring: { slowMs: checked.payload.slowMs } });
      reload(); onSaved(); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save the defaults.'); } finally { setBusy(false); }
  };
  const reset = () => {
    const d = (k: string, fallback: number) => (bounds[k]?.default ?? fallback);
    setForm(toForm({ intervalMs: d('intervalMs', 60_000), timeoutMs: d('timeoutMs', 5_000), retentionHours: d('retentionHours', 336) }, 1000));
  };

  const row = (id: keyof DefaultsForm, label: string, hint: string) => (
    <div className="ud-f">
      <label htmlFor={`ud-${id}`}>{label}<small>{errors[id] ? <span className="ud-err">{errors[id]}</span> : hint}</small></label>
      <input id={`ud-${id}`} className="ud-in" inputMode="decimal" value={form?.[id] ?? ''} onChange={set(id)} aria-invalid={!!errors[id]} disabled={!form} />
    </div>
  );

  return (
    <section className="ud-pop" role="dialog" aria-label="Monitoring defaults">
      <h3>Monitoring defaults</h3>
      <p className="hm-meta">Interval and timeout apply to new monitors. Existing monitors keep their own values.</p>
      {row('intervalS', 'Check every', 'seconds')}
      {row('timeoutS', 'Timeout', 'seconds')}
      {row('slowS', 'Slow threshold', 'seconds · the ribbon turns amber above this; it does not open an incident')}
      {row('days', 'Keep history', 'days · the last day of checks is kept in detail, the rest as hourly summaries')}
      {error && <p className="ud-err" role="alert">{error}</p>}
      <div className="ud-actions">
        <button type="button" className="btn btn-sm" onClick={reset} disabled={!form}>Reset</button>
        <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void save()} disabled={busy || !checked || !checked.ok}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </section>
  );
}

function AddMonitor({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { data } = usePolled<ServicesDoc>('/api/services', 0);
  const services = useMemo(() => (data?.services ?? []).filter((s) => !s.hidden), [data]);
  const [target, setTarget] = useState('');
  const [type, setType] = useState<MonitorType | null>(null);
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const c = useMemo(() => classifyTarget(target, services), [target, services]);
  const types = typesFor(c.kind);
  const chosen = type && types.some((t) => t.type === type) ? type : types[0]?.type ?? null;
  const shownName = named ? name : defaultName(c);

  const submit = async () => {
    if (!chosen || !shownName.trim()) return;
    setBusy(true); setError(null);
    try { await post('/api/monitoring/monitors', monitorDraft(c, chosen, shownName)); onCreated(); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : 'The monitor could not be created.'); } finally { setBusy(false); }
  };

  return (
    <Modal
      title="Add a monitor" onClose={onClose}
      footer={<><button className="btn btn-sm" onClick={onClose}>Cancel</button><button className="btn btn-sm btn-primary" onClick={() => void submit()} disabled={busy || !chosen || !shownName.trim()}>{busy ? 'Adding…' : 'Add monitor'}</button></>}
    >
      <div className="ud-add">
        <label htmlFor="ua-target">What to watch
          <input id="ua-target" className="ud-in wide" list="ua-services" value={target} onChange={(e) => { setTarget(e.target.value); setError(null); }} placeholder="A service, https://… or host:port" autoComplete="off" />
          <datalist id="ua-services">{services.map((s) => <option key={s.name} value={s.displayName} />)}</datalist>
          <small>{c.problem ?? (c.kind === 'service' ? `A discovered service: ${c.service!.displayName}` : c.kind === 'url' ? 'A web address' : c.kind === 'hostport' ? 'A host and port' : 'Pick a discovered service from the list, or type an address.')}</small>
        </label>
        <fieldset disabled={!types.length}>
          <legend>Check</legend>
          <div className="seg-sm" role="radiogroup" aria-label="Check type">
            {types.map((t) => <button key={t.type} type="button" role="radio" aria-checked={chosen === t.type} aria-pressed={chosen === t.type} onClick={() => setType(t.type)}>{t.label}</button>)}
            {!types.length && <span className="hm-meta" style={{ padding: '6px 12px' }}>Choose what to watch first</span>}
          </div>
          {chosen && <small>{types.find((t) => t.type === chosen)!.hint}</small>}
        </fieldset>
        <label htmlFor="ua-name">Name
          <input id="ua-name" className="ud-in wide" value={shownName} onChange={(e) => { setName(e.target.value); setNamed(true); }} maxLength={80} disabled={!types.length} />
        </label>
        {error && <p className="ud-err" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

export function UptimeActions({ onChanged }: { onChanged: () => void }) {
  const [defaults, setDefaults] = useState(false);
  const [adding, setAdding] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const closeDefaults = useCallback(() => { setDefaults(false); btn.current?.focus(); }, []);

  useEffect(() => {
    if (!defaults) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setDefaults(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDefaults(); };
    window.addEventListener('mousedown', onDown); window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [defaults, closeDefaults]);

  return (
    <div className="ud-wrap" ref={wrap}>
      <button ref={btn} type="button" className="btn btn-sm" aria-expanded={defaults} aria-haspopup="dialog" onClick={() => setDefaults((d) => !d)}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>Defaults
      </button>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>+ Add monitor</button>
      {defaults && <DefaultsPanel onClose={closeDefaults} onSaved={onChanged} />}
      {adding && <AddMonitor onClose={() => setAdding(false)} onCreated={onChanged} />}
    </div>
  );
}
