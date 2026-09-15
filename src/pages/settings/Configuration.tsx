// Phase 6 — the configuration panes: migration, history, export, and the scope boundary.
//
// These four screens are where the phase is actually visible to a person, and they are built to the
// rule in §18 of the brief: no giant form. Each one leads with one decision and expands into detail
// on demand —
//
//   Import   you paste files, you read a review, *then* you apply. Nothing is written before that.
//   History  a list of versions; opening one shows the diff restoring it would make.
//   Export   two formats, a checkbox list, one download. What was taken out is stated, not hidden.
//   Scope    the boundary as data. The point is that it is boring and specific.
//
// The review screen is the important one. Its whole job is to make the difference between "this
// imported entry matches a running container" and "this imported entry matches nothing" impossible
// to miss, because that difference is the phase's central invariant.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, invalidateShared, post, put } from '../../lib/api';
import { relTime } from '../../lib/format';
import type {
  ConfigOverviewDoc, ConfigScopeDoc, DiffDoc, ExportBundle, GroupsDoc, HistoryDoc, HistoryVersion,
  ImportApplyResult, ImportDecisions, ImportFilesDoc, ImportPreviewDoc, PresentationDoc, RestoreResult,
} from '../../lib/types';
import { Icon } from '../../components/Icon';
import { IconPickerModal } from '../../components/IconPicker';
import { Loading, Modal, Segmented, Switch } from '../../components/ui';
import { Block, Busy, Row, bytes, when } from './parts';

const DEFAULT_DECISIONS: ImportDecisions = {
  keepUnmatched: 'bookmark',
  includeBookmarks: true,
  includeWidgets: true,
  includeAppearance: true,
  includeCustom: false,
  skip: [],
  groupRenames: {},
};

/* ==========================================================================
   Import & migration
   ========================================================================== */

/**
 * The migration workflow, in three deliberate steps.
 *
 * The middle step is the product decision this whole phase turns on. An imported Homepage
 * configuration is *not* a set of services — it is a set of claims about services, some of which
 * are true on this host and some of which are not. So the review screen leads with the four counts
 * (matched / unmatched / conflicts / invalid) and only then shows the detail, because a user who
 * reads one line should come away knowing whether their dashboard will survive the move.
 */
export function ImportTab() {
  const [files, setFiles] = useState<Record<string, string>>({});
  const [spec, setSpec] = useState<ImportFilesDoc | null>(null);
  const [preview, setPreview] = useState<ImportPreviewDoc | null>(null);
  const [decisions, setDecisions] = useState<ImportDecisions>(DEFAULT_DECISIONS);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportApplyResult | null>(null);
  const [showDetail, setShowDetail] = useState<'matched' | 'unmatched' | 'conflicts' | 'invalid' | null>('unmatched');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { void api<ImportFilesDoc>('/api/config/import/files').then(setSpec).catch(() => {}); }, []);

  const fileCount = Object.keys(files).length;

  const addFiles = useCallback(async (list: FileList | null) => {
    if (!list?.length) return;
    const next: Record<string, string> = {};
    for (const f of Array.from(list)) next[f.name] = await f.text();
    setFiles((prev) => ({ ...prev, ...next }));
    setPreview(null); setResult(null); setError(null);
  }, []);

  const review = useCallback(async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await post<ImportPreviewDoc>('/api/config/import/parse', { files, decisions });
      setPreview(r);
      setShowDetail(r.summary.unmatched > 0 ? 'unmatched' : 'matched');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPreview(null);
    } finally { setBusy(false); }
  }, [files, decisions]);

  const apply = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await post<ImportApplyResult>('/api/config/import/apply', { files, decisions, mode });
      setResult(r); setPreview(null); setFiles({});
      invalidateShared();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [files, decisions, mode]);

  const segment = (value: 'bookmark' | 'drop', label: string, desc: string) => (
    <label className={`cfg-choice${decisions.keepUnmatched === value ? ' sel' : ''}`}>
      <input type="radio" checked={decisions.keepUnmatched === value} onChange={() => setDecisions((d) => ({ ...d, keepUnmatched: value }))} />
      <span>
        <strong>{label}</strong>
        <em>{desc}</em>
      </span>
    </label>
  );

  return (
    <>
      <p className="lede">
        Bring a Homepage configuration across. Everything is parsed, validated and counted first —
        you read what would happen, and nothing is written until you apply it.
      </p>

      {/* ---------- step 1 ---------- */}
      <Block title="1 · The files" aside={<span className="stale-note">accepted and refused by name</span>}>
        <div className="cfg-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer.files); }}>
          <p>
            Drop your Homepage configuration here, or
            {' '}
            <button className="section-link" onClick={() => fileInput.current?.click()}>choose files</button>.
            Pasting also works — anything you paste is treated as <code className="mono-meta">services.yaml</code>.
          </p>
          <input
            ref={fileInput} type="file" multiple className="visually-hidden"
            accept=".yaml,.yml,.css,.js,.json,text/*"
            onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }}
          />
          {fileCount > 0 && (
            <ul className="cfg-filelist">
              {Object.entries(files).map(([name, text]) => (
                <li key={name}>
                  <code className="mono-meta">{name}</code>
                  <span className="stale-note">{bytes(new Blob([text]).size)}</span>
                  <button className="btn btn-quiet btn-sm" onClick={() => { setFiles((f) => { const n = { ...f }; delete n[name]; return n; }); setPreview(null); }}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <details className="cfg-details">
          <summary>Paste a configuration instead</summary>
          <textarea
            className="input mono-meta cfg-paste" rows={8} spellCheck={false}
            placeholder={'- Media:\n    - Jellyfin:\n        icon: si-jellyfin\n        href: https://stream.example.com'}
            onBlur={(e) => { const v = e.target.value.trim(); if (v) { setFiles((f) => ({ ...f, 'services.yaml': v })); setPreview(null); } }}
          />
          <span className="hint">Committed when the box loses focus. Existing <code className="mono-meta">services.yaml</code> from a file drop is replaced.</span>
        </details>
        {spec && (
          <details className="cfg-details">
            <summary>{spec.accepted.length} files can be imported · {spec.refused.length} are refused</summary>
            <div className="cfg-two">
              <div>
                <h4 className="cfg-sub">Imported</h4>
                <ul className="cfg-list">{spec.accepted.map((f) => <li key={f.name}><code className="mono-meta">{f.name}</code> <span className="stale-note">{f.label}</span></li>)}</ul>
              </div>
              <div>
                <h4 className="cfg-sub">Refused, on purpose</h4>
                <ul className="cfg-list cfg-list--warn">
                  {spec.refused.map((f) => <li key={f.name}><code className="mono-meta">{f.name}</code> <span className="stale-note">{f.why}</span></li>)}
                </ul>
              </div>
            </div>
          </details>
        )}
      </Block>

      {/* ---------- step 2 ---------- */}
      <Block title="2 · Review" aside={preview ? <span className="stale-note">{preview.source === 'opushub' ? 'an OpusHub export' : 'a Homepage configuration'}</span> : null}>
        <Row label="Parse and classify" desc="Reads the files, matches each entry against the containers Docker is reporting, and counts the result. Nothing is written.">
          <button className="btn btn-primary" disabled={!fileCount || busy} onClick={() => void review()}>Review</button>
        </Row>

        {busy && <Busy state error={null} />}
        {error && <p className="cfg-error" role="alert">{error}</p>}

        {preview && (
          <>
            <div className="cfg-counts">
              <Count n={preview.summary.groups} label="Groups" />
              <Count n={preview.summary.services} label="Services" />
              <Count n={preview.summary.bookmarks} label="Bookmarks" />
              <Count n={preview.summary.widgets} label="Widgets" />
            </div>
            <div className="cfg-counts cfg-counts--verdict">
              <Count n={preview.summary.matched} label="Matched to Docker" tone="ok" />
              <Count n={preview.summary.unmatched} label="Unmatched" tone={preview.summary.unmatched ? 'warn' : undefined} />
              <Count n={preview.summary.conflicts} label="Conflicts" tone={preview.summary.conflicts ? 'warn' : undefined} />
              <Count n={preview.summary.invalid} label="Invalid" tone={preview.summary.invalid ? 'err' : undefined} />
            </div>

            {!preview.summary.dockerConnected && (
              <p className="cfg-note cfg-note--warn">
                Docker is not connected, so nothing could be matched. The import still works — every entry will be
                reported as unmatched — but start the engine and review again if you want your services bound.
              </p>
            )}

            <div className="cfg-tabs" role="tablist">
              {([
                ['matched', `Matched (${preview.matched.length})`],
                ['unmatched', `Unmatched (${preview.unmatched.length})`],
                ['conflicts', `Conflicts (${preview.conflicts.length})`],
                ['invalid', `Invalid (${preview.invalid.length})`],
              ] as const).map(([id, label]) => (
                <button
                  key={id} role="tab" aria-selected={showDetail === id}
                  className={`cfg-tab${showDetail === id ? ' active' : ''}`}
                  onClick={() => setShowDetail(showDetail === id ? null : id)}
                >{label}</button>
              ))}
            </div>

            {showDetail === 'matched' && (
              <>
                <p className="stale-note">These entries name a container Docker is really running. Their presentation will be applied to it.</p>
                <table className="cfg-table">
                  <thead><tr><th>Imported</th><th>Container</th><th>Why it matched</th><th>Applied</th></tr></thead>
                  <tbody>
                    {preview.matched.map((m) => (
                      <tr key={`${m.sourceGroup}/${m.sourceName}`}>
                        <td><strong>{m.sourceName}</strong><br /><span className="stale-note">{m.sourceGroup}</span></td>
                        <td><code className="mono-meta">{m.container.containerName}</code><br /><span className="stale-note">{m.container.state}</span></td>
                        <td><span className={`cfg-conf cfg-conf--${m.matchConfidence}`}>{m.matchConfidence}</span> {m.matchHow}</td>
                        <td><span className="cfg-applied">{m.icon ? <Icon ref={m.icon} name={m.displayName || m.sourceName} size={18} /> : null}{m.displayName || '—'}</span></td>
                      </tr>
                    ))}
                    {!preview.matched.length && <tr><td colSpan={4} className="stale-note">Nothing matched. Nothing will be presented.</td></tr>}
                  </tbody>
                </table>
              </>
            )}

            {showDetail === 'unmatched' && (
              <>
                <p className="stale-note">
                  These entries do not match any container. They will <strong>not</strong> become services — a
                  configuration entry cannot invent one. Keep them as bookmarks and they stay useful links.
                </p>
                <ul className="cfg-items">
                  {preview.unmatched.map((u) => (
                    <li key={`${u.sourceGroup}/${u.sourceName}`}>
                      <div>
                        <strong>{u.displayName || u.sourceName}</strong>
                        <span className="stale-note"> · {u.sourceGroup}</span>
                        <div className="stale-note">{u.reason}</div>
                      </div>
                      {u.url && <code className="mono-meta">{u.url}</code>}
                    </li>
                  ))}
                  {!preview.unmatched.length && <li className="stale-note">Nothing unmatched.</li>}
                </ul>
                {preview.unmatched.length > 0 && (
                  <div className="cfg-choices">
                    {segment('bookmark', 'Keep as bookmarks', 'They stay as links in Bookmarks. The inventory is untouched either way.')}
                    {segment('drop', 'Drop them', 'Only entries backed by a real container are carried across.')}
                  </div>
                )}
              </>
            )}

            {showDetail === 'conflicts' && (
              <>
                <p className="stale-note">These entries match a container you have already presented. Both sides are shown — nothing is replaced silently.</p>
                {preview.conflicts.map((c) => (
                  <div className="cfg-conflict" key={c.container}>
                    <h4><code className="mono-meta">{c.container}</code> <span className="stale-note">already presented as “{c.service}” · from {c.source}</span></h4>
                    <table className="cfg-table">
                      <thead><tr><th>Field</th><th>Yours now</th><th>Imported</th></tr></thead>
                      <tbody>{c.changes.map((ch) => <tr key={ch.field}><td>{ch.field}</td><td>{ch.current}</td><td><strong>{ch.imported}</strong></td></tr>)}</tbody>
                    </table>
                  </div>
                ))}
                {!preview.conflicts.length && <p className="stale-note">No conflicts — nothing you have already presented is affected.</p>}
                {preview.conflicts.length > 0 && (
                  <Row label="When they disagree" desc="Merge keeps everything you have and applies only the fields the import carries. Replace rebuilds the overlay from the import alone.">
                    <Segmented
                      value={mode} ariaLabel="Conflict handling"
                      onChange={(v) => setMode(v as 'merge' | 'replace')}
                      options={[{ value: 'merge', label: 'Merge' }, { value: 'replace', label: 'Replace' }]}
                    />
                  </Row>
                )}
              </>
            )}

            {showDetail === 'invalid' && (
              <>
                <p className="stale-note">These entries could not be represented safely. They are reported instead of being partially applied.</p>
                <ul className="cfg-items">
                  {preview.invalid.map((i, n) => <li key={`${i.name}-${n}`}><div><strong>{i.name}</strong><div className="stale-note">{i.reason}</div></div></li>)}
                  {!preview.invalid.length && <li className="stale-note">Every entry was valid.</li>}
                </ul>
              </>
            )}

            <div className="cfg-checklist">
              <h4 className="cfg-sub">What to carry across</h4>
              <Check label="Bookmarks" desc="Links from the imported file." checked={decisions.includeBookmarks} onChange={(v) => setDecisions((d) => ({ ...d, includeBookmarks: v }))} />
              <Check label="Widgets" desc="Only blocks with an honest OpusHub equivalent." checked={decisions.includeWidgets} onChange={(v) => setDecisions((d) => ({ ...d, includeWidgets: v }))} />
              <Check label="Appearance" desc="Theme, accent and background, where a mapping exists." checked={decisions.includeAppearance} onChange={(v) => setDecisions((d) => ({ ...d, includeAppearance: v }))} />
              <Check label="Custom CSS & JS"
                desc="Opt-in. Imported code is linted and never executed during the import — it stays a file, served same-origin, until you enable it."
                checked={decisions.includeCustom} onChange={(v) => setDecisions((d) => ({ ...d, includeCustom: v }))} />
            </div>

            {preview.plan && (
              <div className="cfg-notes">
                <h4 className="cfg-sub">This will write</h4>
                <ul className="cfg-list">
                  {preview.plan.files.map((f) => <li key={f.name}><code className="mono-meta">{f.name}</code> <span className="stale-note">{f.entries} entries</span></li>)}
                </ul>
                {preview.plan.preservedUnmatched > 0 && <p className="stale-note">{preview.plan.preservedUnmatched} unmatched entry(ies) will be kept as bookmark links.</p>}
              </div>
            )}

            {preview.secretsDropped.length > 0 && (
              <div className="cfg-notes cfg-notes--warn">
                <h4 className="cfg-sub">Credentials found and dropped</h4>
                <p className="stale-note">
                  These keys held live secrets with no meaning in OpusHub&apos;s presentation model. They were not
                  imported, and they are never exported.
                </p>
                <ul className="cfg-list">{preview.secretsDropped.map((s, n) => <li key={n} className="mono-meta">{s}</li>)}</ul>
              </div>
            )}

            {preview.unmappedWidgets.length > 0 && (
              <div className="cfg-notes">
                <h4 className="cfg-sub">Widgets with no OpusHub equivalent</h4>
                <ul className="cfg-list">{preview.unmappedWidgets.map((w) => <li key={w.name}><strong>{w.name}</strong> <span className="stale-note">{w.reason}</span></li>)}</ul>
              </div>
            )}

            {preview.ignoredSettings.length > 0 && (
              <div className="cfg-notes">
                <h4 className="cfg-sub">Settings that did not map</h4>
                <ul className="cfg-list">{preview.ignoredSettings.map((s) => <li key={s.key}><strong>{s.key}</strong> <span className="stale-note">{s.reason}</span></li>)}</ul>
              </div>
            )}

            {preview.warnings.length > 0 && (
              <div className="cfg-notes cfg-notes--warn">
                <h4 className="cfg-sub">Adjustments</h4>
                <ul className="cfg-list">{preview.warnings.map((w, n) => <li key={n}>{w}</li>)}</ul>
              </div>
            )}

            <div className="cfg-apply">
              <Row label="3 · Apply" desc="Writes the reviewed files, records a configuration version, and leaves a pre-import snapshot you can restore from History.">
                <button className="btn btn-primary" disabled={busy} onClick={() => void apply()}>Apply import</button>
              </Row>
            </div>
          </>
        )}

        {result && (
          <div className="cfg-result" role="status">
            <h4>Imported.</h4>
            <p>
              Wrote {result.written.length} file{result.written.length === 1 ? '' : 's'}
              {' '}({result.written.map((f) => <code className="mono-meta" key={f}>{f} </code>)}).
              {' '}{result.summary.matched} service{result.summary.matched === 1 ? '' : 's'} bound to real containers
              {result.preservedUnmatched > 0 && <> · {result.preservedUnmatched} kept as bookmark{result.preservedUnmatched === 1 ? '' : 's'}</>}
              {result.secretsDropped > 0 && <> · {result.secretsDropped} credential{result.secretsDropped === 1 ? '' : 's'} dropped</>}.
            </p>
            <p className="stale-note">
              Docker was not touched. <Link className="section-link" to="/settings/history">Open History</Link> to see what changed or undo the whole thing.
            </p>
          </div>
        )}
      </Block>
    </>
  );
}

function Count({ n, label, tone }: { n: number; label: string; tone?: 'ok' | 'warn' | 'err' }) {
  return (
    <div className={`cfg-count${tone ? ` cfg-count--${tone}` : ''}`}>
      <strong>{n}</strong>
      <span>{label}</span>
    </div>
  );
}

function Check({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="cfg-check">
      <Switch checked={checked} onChange={onChange} label={label} />
      <span><strong>{label}</strong><em>{desc}</em></span>
    </label>
  );
}

/* ==========================================================================
   History
   ========================================================================== */

/**
 * Every configuration version, what changed, and how to go back.
 *
 * Restore is the operation with the most to get wrong, so the screen states what it does before it
 * does it: the diff is computed *against the present* ("this is what restoring would change"), the
 * scope of what restore can touch is printed in full, and the button says what it is restoring to.
 */
export function HistoryTab() {
  const [doc, setDoc] = useState<HistoryDoc | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<HistoryVersion | null>(null);

  const load = useCallback(async () => {
    try { setDoc(await api<HistoryDoc>('/api/config/history')); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const inspect = useCallback(async (id: string) => {
    if (open === id) { setOpen(null); setDiff(null); return; }
    setOpen(id); setDiff(null); setError(null);
    try { setDiff(await api<DiffDoc>(`/api/config/history/${encodeURIComponent(id)}/diff`)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [open]);

  const restore = useCallback(async (id: string) => {
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await post<RestoreResult>(`/api/config/history/${encodeURIComponent(id)}/restore`, {});
      setDone(`Restored ${r.files.length} file${r.files.length === 1 ? '' : 's'}.${r.skipped.length ? ` ${r.skipped.length} file(s) refused by the configuration boundary.` : ''}`);
      setConfirming(null); setDiff(null); setOpen(null);
      invalidateShared();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [load]);

  const remove = useCallback(async (id: string) => {
    try { await api(`/api/config/history/${encodeURIComponent(id)}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [load]);

  if (!doc) return <Loading what="configuration history" />;

  return (
    <>
      <p className="lede">
        Every successful configuration write leaves a version behind. Restoring one rewrites
        presentation files only — it never touches your account, your sessions, the activity log,
        the metric history, or Docker.
      </p>

      <Block title="Retention" aside={<span className="stale-note">bounded, on purpose</span>}>
        <Row label="Versions kept" desc={`The newest ${doc.stats.retention.versions} versions, up to ${bytes(doc.stats.retention.bytes)} in total. Older ones are pruned automatically — history must never grow without limit.`} tight>
          <span className="mono-meta">{doc.stats.count} of {doc.stats.retention.versions} · {bytes(doc.stats.totalBytes)}</span>
        </Row>
        <Row label="Window" desc="The oldest and newest version currently held." tight>
          <span className="mono-meta">{when(doc.stats.oldest)} → {when(doc.stats.newest)}</span>
        </Row>
      </Block>

      <Block title="Versions" aside={<span className="stale-note">{doc.scope.length} presentation files per version</span>}>
        {busy && <Busy state error={null} />}
        {error && <p className="cfg-error" role="alert">{error}</p>}
        {done && <p className="cfg-note cfg-note--ok" role="status">{done}</p>}

        <ul className="cfg-versions">
          {doc.versions.map((v) => (
            <li key={v.id} className={open === v.id ? 'open' : ''}>
              <div className="cfg-version-head">
                <button className="cfg-version-main" onClick={() => void inspect(v.id)} aria-expanded={open === v.id}>
                  <span className="cfg-when">{when(v.at)}</span>
                  <span className="cfg-label">{v.label || v.reason}</span>
                  <span className="stale-note">{relTime(Date.parse(v.at))} · {bytes(v.bytes)}{v.changed.length ? ` · ${v.changed.length} file(s) changed` : ''}</span>
                </button>
                {v.id === doc.current && <span className="cfg-badge">current</span>}
                <button className="btn btn-sm" disabled={busy} onClick={() => setConfirming(v)}>Restore</button>
                <button className="btn btn-quiet btn-sm" onClick={() => void remove(v.id)} title="Remove this version from history">Forget</button>
              </div>

              {open === v.id && (
                <div className="cfg-version-body">
                  {!diff && <span className="stale-note" role="status">Computing what restoring this would change…</span>}
                  {diff && diff.identical && <p className="stale-note">Identical to the current configuration. Restoring it would change nothing.</p>}
                  {diff && !diff.identical && (
                    <>
                      <p className="stale-note">Restoring this version would make {diff.changes} change{diff.changes === 1 ? '' : 's'} against what you have now:</p>
                      {diff.sections.map((s) => (
                        <div className="cfg-diffsection" key={s.file}>
                          <h4 className="cfg-sub">{s.title} <code className="mono-meta">{s.file}</code></h4>
                          <ul className="cfg-diff">
                            {s.entries.slice(0, 60).map((e, n) => (
                              <li key={n} className={`cfg-diff--${e.kind}`}>
                                <span className="cfg-difftag">{e.kind === 'added' ? '+' : e.kind === 'removed' ? '−' : '~'}</span>
                                {e.text}
                              </li>
                            ))}
                            {s.entries.length > 60 && <li className="stale-note">…and {s.entries.length - 60} more</li>}
                          </ul>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
          {!doc.versions.length && <li className="stale-note">No versions yet. The next configuration write will create the first one.</li>}
        </ul>
      </Block>

      {confirming && (
        <Modal
          title={`Restore “${confirming.label || confirming.reason}”?`}
          onClose={() => setConfirming(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void restore(confirming.id)}>Restore this version</button>
            </>
          )}
        >
          <p>
            This rewrites {doc.scope.map((f) => <code className="mono-meta" key={f}>{f} </code>)}
            {' '}from {when(confirming.at)}.
          </p>
          <p className="stale-note">
            Your current configuration is snapshotted first, so this is itself undoable — the undo
            appears as a new version immediately after.
          </p>
          <p className="stale-note">
            It will not touch authentication, sessions, activity, metrics, environment secrets or Docker.
          </p>
        </Modal>
      )}
    </>
  );
}

/* ==========================================================================
   Export
   ========================================================================== */

export function ExportTab() {
  const [format, setFormat] = useState<'native' | 'homepage'>('native');
  const [include, setInclude] = useState<string[] | null>(null);
  const [bundle, setBundle] = useState<ExportBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<string | null>(null);

  const preview = useCallback(async (fmt: 'native' | 'homepage') => {
    setBusy(true); setError(null); setSeen(null);
    try {
      const q = new URLSearchParams({ format: fmt });
      if (fmt === 'native' && include) q.set('include', include.join(','));
      setBundle(await api<ExportBundle>(`/api/config/export?${q}`));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [include]);

  useEffect(() => { void preview(format); }, [format, preview]);

  const download = () => {
    setSeen('Download started.');
    window.location.href = `/api/config/export/download?format=${format}`;
  };

  const NATIVE_PARTS = [
    ['services.yaml', 'Groups, service presentation, icons, URL overrides'],
    ['stacks.yaml', 'Stack names and descriptions'],
    ['bookmarks.yaml', 'All bookmark groups'],
    ['settings.yaml', 'Appearance, background, markets, feeds'],
    ['layout.json', 'Hub composition: widgets, order, visibility'],
    ['theme.css', 'Custom CSS'],
    ['app.js', 'Custom JS'],
  ] as const;

  return (
    <>
      <p className="lede">
        Take your configuration somewhere else. An export is presentation only — it carries what you
        chose, and never what OpusHub knows about your host.
      </p>

      <Block title="Format">
        <Row label="What to write" desc="Native keeps everything and re-imports through the review screen. Homepage writes files Homepage itself can read.">
          <Segmented
            value={format} ariaLabel="Export format"
            onChange={(v) => setFormat(v as 'native' | 'homepage')}
            options={[{ value: 'native', label: 'OpusHub native' }, { value: 'homepage', label: 'Homepage-compatible' }]}
          />
        </Row>
        {format === 'native' && (
          <div className="cfg-checklist">
            <h4 className="cfg-sub">Include</h4>
            {NATIVE_PARTS.map(([name, desc]) => {
              const on = !include || include.includes(name);
              return (
                <Check
                  key={name} label={name} desc={desc} checked={on}
                  onChange={(v) => {
                    const base = include ? [...include] : NATIVE_PARTS.map(([n]) => n);
                    const next = v ? [...new Set([...base, name])] : base.filter((n) => n !== name);
                    setInclude(next);
                  }}
                />
              );
            })}
          </div>
        )}
      </Block>

      <Block title="Preview" aside={bundle ? <span className="stale-note">{bundle.files ? Object.keys(bundle.files).length : 0} file(s)</span> : null}>
        <Row label="Inspect before downloading" desc="The same payload the download serves, so you can read what leaves the server.">
          <button className="btn" disabled={busy} onClick={() => void preview(format)}>Refresh</button>
          <button className="btn btn-primary" disabled={busy || !bundle} onClick={download}>Download</button>
        </Row>
        <Busy state={busy} error={error} done={seen} />

        {bundle && (
          <>
            <ul className="cfg-filelist">
              {Object.entries(bundle.files).map(([name, text]) => (
                <li key={name}>
                  <code className="mono-meta">{name}</code>
                  <span className="stale-note">{bytes(new Blob([text]).size)}</span>
                  <a className="btn btn-sm" href={`/api/config/export/download?format=${format}&file=${encodeURIComponent(name)}`} download>Download</a>
                </li>
              ))}
            </ul>

            {bundle.notes.length > 0 && (
              <div className="cfg-notes">
                <h4 className="cfg-sub">Notes</h4>
                <ul className="cfg-list">{bundle.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </div>
            )}

            {bundle.redactions.length > 0 && (
              <div className="cfg-notes cfg-notes--warn">
                <h4 className="cfg-sub">Removed before export</h4>
                <ul className="cfg-list">
                  {bundle.redactions.map((r, i) => (
                    <li key={i}>
                      <strong>{r.where ? `${r.where}: ` : ''}</strong>{r.note}
                      {r.url && <code className="mono-meta"> {r.url}</code>}
                    </li>
                  ))}
                </ul>
                <p className="stale-note">These are live secrets. Re-add them on the new installation — they are deliberately not carried.</p>
              </div>
            )}
          </>
        )}
      </Block>
    </>
  );
}

/* ==========================================================================
   Scope
   ========================================================================== */

/**
 * The boundary, stated as data rather than as a promise.
 *
 * §17 asks for the separation to be real. The most useful thing this pane can do is show the
 * *list* — the seven files configuration may touch, and the specific runtime files it may not,
 * each with the reason it is excluded. A reader can then check the claim instead of believing it.
 */
export function ConfigurationTab() {
  const [overview, setOverview] = useState<ConfigOverviewDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<ConfigOverviewDoc>('/api/config/overview').then(setOverview).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) return <p className="cfg-error" role="alert">{error}</p>;
  if (!overview) return <Loading what="configuration scope" />;
  const { scope, counts, custom, history: hist } = overview;

  return (
    <>
      <p className="lede">{scope.rule}</p>

      <div className="cfg-counts">
        <Count n={counts.groups} label="Groups" />
        <Count n={counts.services} label="Containers discovered" />
        <Count n={counts.configured} label="With presentation" />
        <Count n={counts.bookmarks} label="Bookmarks" />
        <Count n={counts.widgets} label="Hub widgets" />
        <Count n={counts.unmatched} label="Unmatched overlays" tone={counts.unmatched ? 'warn' : undefined} />
      </div>

      <Block title="Presentation configuration" aside={<span className="stale-note">{scope.presentation.length} files</span>}>
        <p className="stale-note">
          These are the only files a configuration write, import, restore or template may touch. They live in
          <code className="mono-meta"> config/</code> and are safe to version, copy and edit by hand.
        </p>
        <table className="cfg-table">
          <thead><tr><th>File</th><th>Holds</th></tr></thead>
          <tbody>{scope.presentation.map((f) => <tr key={f.name}><td><code className="mono-meta">{f.name}</code></td><td>{f.label}</td></tr>)}</tbody>
        </table>
      </Block>

      <Block title="Never touched by configuration" aside={<span className="stale-note">declared, and enforced</span>}>
        <p className="stale-note">
          Restoring a version, applying an import or exporting cannot reach any of these. Each is excluded for a
          different reason, which is why they are listed rather than summarised.
        </p>
        <table className="cfg-table">
          <thead><tr><th>State</th><th>Kind</th><th>Why it is excluded</th></tr></thead>
          <tbody>
            {scope.protected.map((p) => (
              <tr key={p.path}>
                <td><code className="mono-meta">{p.path}</code></td>
                <td><span className="cfg-badge cfg-badge--quiet">{p.kind}</span></td>
                <td className="stale-note">{p.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Block>

      <Block title="Custom code" aside={<span className="stale-note">{custom.cssEnabled || custom.jsEnabled ? 'enabled' : 'off'}</span>}>
        <Row label="theme.css" desc="Loaded same-origin, authenticated, and only while custom CSS is enabled. Linted before it is saved." tight>
          <span className="mono-meta">{bytes(custom.cssBytes)} · {custom.cssModified ? when(custom.cssModified) : 'none'}</span>
        </Row>
        <Row label="app.js" desc="Runs in your browser only. It never gains server-side capability — the server never executes it." tight>
          <span className="mono-meta">{bytes(custom.jsBytes)} · {custom.jsModified ? when(custom.jsModified) : 'none'}</span>
        </Row>
        <Row label="Enabled in" desc="Both are opt-in and stay off until you turn them on.">
          <Link className="btn btn-sm" to="/settings/advanced">Advanced</Link>
        </Row>
      </Block>

      <Block title="History" aside={<span className="stale-note">{hist.count} version(s)</span>}>
        <Row label="Retained" desc="Bounded by count and by total size, so configuration history cannot grow without limit." tight>
          <span className="mono-meta">{bytes(hist.totalBytes)} of {bytes(hist.retention.bytes)}</span>
        </Row>
        <Row label="Manage" tight><Link className="btn btn-sm" to="/settings/history">Open History</Link></Row>
      </Block>
    </>
  );
}
