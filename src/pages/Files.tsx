// Phase 11A — Files: a read-only explorer for the filesystem roots this host exposes.
//
// What this page can do is exactly what the API can do: list a directory, stat one entry, preview a
// bounded slice of a file, search names, inspect permissions and ownership, and download. There is
// no create, rename, move, copy, delete, upload, mkdir, chmod or chown anywhere in this file — not
// behind a flag, not behind a permission, not behind a confirmation dialog. The server has no route
// for any of them, so a button would only be a lie with a spinner.
//
// Navigation lives in the URL (`/files?root=<id>&path=<relative>&sel=<relative>&q=<query>`), so a
// folder is shareable, the back button works, and a reload lands where the operator left off. The
// only thing never in the URL is a host path: every request names a root the server validated plus a
// path relative to it, and resolution to an absolute path happens server-side, every time.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { bytes, dayLabel, relTime, timeOfDay } from '../lib/format';
import {
  SORT_OPTIONS, asRefusal, downloadHref, isSaneRelative, kindGlyph, listingNote, operationFor,
  parentPath, pathSegments, refusalOf, refusalText, requestAccess, rootName, searchNote,
  useFileList, useFilePreview, useFileSearch, useFileStat, useFileTree, useFilesSurface,
  usePermissionStatus,
} from '../lib/files';
import { Freshness, Loading, PageHero } from '../components/ui';
import type { QueryState } from '../lib/api';
import type {
  FileEntry, FileListDoc, FilePreviewDoc, FileRoot, FileSearchDoc, FileStatDoc, FileTreeNode,
  FilesRefusal, PermissionStatusDoc, PrivilegedOperation, PrivilegedStatus,
} from '../lib/types';

/* ------------------------------------------------------------------ */
/* small shared bits                                                   */
/* ------------------------------------------------------------------ */

const GLYPH = 'fm-glyph';

function Glyph({ kind, ext, label }: { kind: string; ext?: string | null; label?: string }) {
  return (
    <svg className={GLYPH} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" role="img">
      <title>{label || kind}</title>
      <path d={kindGlyph(kind, ext)} />
    </svg>
  );
}

/** A one-word mark next to a name: what the entry is that its name alone does not say. */
function Mark({ tone = 'quiet', children, title }: { tone?: 'quiet' | 'warn' | 'fail'; children: string; title?: string }) {
  return <span className={`fm-mark fm-mark--${tone}`} title={title}>{children}</span>;
}

const when = (ms: number | null | undefined) => (ms ? `${dayLabel(ms)} ${timeOfDay(ms)} · ${relTime(ms)}` : '—');

/**
 * The refusal panel. One component renders every non-200 the files API can answer with, and it
 * switches on `code` — never on a message, which is prose the server may reword.
 */
function Refusal({
  refusal, fallback, rootId, path, kind = null, privileged, onResolved, retry, title,
}: {
  refusal: FilesRefusal | null;
  fallback: string | null;
  rootId?: string | null;
  path?: string | null;
  kind?: 'dir' | 'file' | null;
  privileged?: PrivilegedStatus | null;
  onResolved?: () => void;
  retry?: (() => void) | null;
  title?: string;
}) {
  const code = refusal?.code ?? null;
  const text = refusalText(refusal, fallback);

  // A real permission gap: say what is missing, and offer to ask — honestly.
  if (code === 'permission_required' || code === 'grant_required') {
    return (
      <AccessPanel
        rootId={rootId} path={path ?? null} operation={operationFor(kind, code === 'grant_required' ? 'read' : 'list')}
        reason={text} privileged={privileged ?? refusal?.privileged ?? null} onResolved={onResolved}
      />
    );
  }

  const tone = code === 'protected_path' || code === 'symlink_escape' || code === 'mount_escape'
    || code === 'root_isolation' || code === 'not_permitted' ? 'blocked' : 'error';

  return (
    <div className={`fm-refusal fm-refusal--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {title && <h3 className="fm-refusal-title">{title}</h3>}
      <p className="fm-refusal-text">{text}</p>
      {code === 'protected_path' && (
        <p className="fm-refusal-note">
          Protected locations are refused by server-side policy, not hidden by the interface: credentials,
          private keys, session state and the Docker API socket stay out of reach no matter how the
          request is phrased. This attempt is recorded in Activity.
        </p>
      )}
      {(code === 'symlink_escape' || code === 'mount_escape') && (
        <p className="fm-refusal-note">
          The link resolves outside the root OpusHub was given, so OpusHub stops at the link. Nothing
          was followed and nothing was read.
        </p>
      )}
      {code === 'bad_path' && refusal?.rule && (
        <p className="fm-refusal-note">Rejected by rule <code>{refusal.rule}</code>.</p>
      )}
      <div className="fm-refusal-foot">
        {code && <code className="fm-code-chip">{code}</code>}
        {retry && <button type="button" className="btn btn-sm" onClick={retry}>Try again</button>}
      </div>
    </div>
  );
}

/** The answer to an access request, in the words the operator needs. */
type AskResult = {
  state: string;
  error?: string | null;
  reason?: string | null;
  requestAccess?: boolean;
  grantable?: boolean | null;
  ttlMs?: number | null;
  provider?: { id: string; label: string } | null;
  privileged?: PrivilegedStatus | null;
};

/**
 * "OpusHub cannot read this" — the panel the phase exists to get right.
 *
 * It offers exactly one action: ask the privilege broker about *this* location and *one* fixed read
 * operation. There is no field for a command, an argument, a shell or a user, and the broker
 * re-validates the path itself. When no privileged provider is registered — which is the state of
 * every default install — the answer is `unavailable`, and this panel says so rather than pretending
 * something was elevated.
 */
function AccessPanel({
  rootId, path, operation, reason, privileged, onResolved,
}: {
  rootId?: string | null;
  path?: string | null;
  operation: PrivilegedOperation;
  reason: string | null;
  privileged?: PrivilegedStatus | null;
  onResolved?: () => void;
}) {
  const [asked, setAsked] = useState<AskResult | null>(null);
  const [busy, setBusy] = useState(false);
  const provider = asked?.privileged ?? privileged ?? null;
  const canAsk = asked?.requestAccess !== false && Boolean(rootId);

  const ask = async () => {
    if (!rootId || busy) return;
    setBusy(true);
    try {
      const res = await requestAccess({ root: rootId, path: path ?? '', operation });
      setAsked({ ...res, privileged: res.privileged ?? provider });
      if (res.state === 'granted' || res.state === 'not_needed') onResolved?.();
    } catch (err) {
      const r = asRefusal(err);
      setAsked({
        state: typeof r?.state === 'string' ? r.state : 'invalid',
        error: refusalText(r, err instanceof Error ? err.message : 'The request could not be made.'),
        reason: r?.reason ?? null,
        requestAccess: r?.requestAccess,
        grantable: r?.grantable ?? null,
        privileged: r?.privileged ?? provider,
      });
    } finally {
      setBusy(false);
    }
  };

  const state = asked?.state ?? null;
  // The unavailable answer carries the whole promise of this phase, so it is never abbreviated by
  // whatever sentence the server happened to send.
  const detail = state === 'unavailable'
    ? 'OpusHub will not run sudo, a shell or any other command to read a file, so this location stays unreadable until an operator registers a privileged provider on the host.'
    : state === 'denied'
      ? asked?.error || asked?.reason || 'A protected location is never grantable, and asking again will not change that.'
      : state === 'granted' || state === 'not_needed'
        ? 'Reading it again now.'
          : asked?.error || asked?.reason || '';
  const headline = state === 'granted'
    ? `Access granted for ${Math.max(1, Math.round((asked?.ttlMs ?? 0) / 60_000))} minutes.`
    : state === 'not_needed' ? 'OpusHub can already read this location.'
      : state === 'denied' ? 'Policy will not grant access here.'
        : state === 'unavailable' ? 'There is no privileged provider on this host.'
          : state === 'invalid' ? 'That request was not valid.' : null;

  return (
    <div className="fm-access" role="status" aria-live="polite">
      <h3 className="fm-access-title">Permission required</h3>
      {reason && <p className="fm-access-reason">{reason}</p>}
      <dl className="kv fm-access-kv">
        <dt>Location</dt>
        <dd className="mono-meta">{path || 'the folder itself'}</dd>
        <dt>Operation asked for</dt>
        <dd><code>{operation}</code> — a read. OpusHub never asks a host to run anything.</dd>
        <dt>Privileged provider</dt>
        <dd>
          {provider?.available
            ? <>{provider.provider?.label ?? 'registered'} (<code>{provider.provider?.id ?? '—'}</code>)</>
            : <>none registered{provider?.reason ? ` — ${provider.reason}` : ''}</>}
        </dd>
      </dl>

      {headline && (
        <p className={`fm-access-result fm-access-result--${state}`}>
          <strong>{headline}</strong> {detail}
        </p>
      )}

      {canAsk && (
        <div className="fm-access-foot">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void ask()} disabled={busy}>
            {busy ? 'Asking…' : 'Request Access'}
          </button>
          <span className="fm-access-hint">
            Asks only about this path and <code>{operation}</code>. Nothing else can be requested from here.
          </span>
        </div>
      )}
      {!canAsk && (
        <p className="fm-access-hint">Request Access is not offered here — the server said it could not help.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* sidebar                                                             */
/* ------------------------------------------------------------------ */

function RootsList({
  roots, refused, activeId, onPick, source, configuredVia,
}: {
  roots: FileRoot[];
  refused: { path: string | null; source: string; code: string; reason: string }[];
  activeId: string | null;
  onPick: (id: string) => void;
  source: string;
  configuredVia: string | null;
}) {
  return (
    <div className="fm-roots">
      <h2 className="fm-side-title">
        Roots
        <span className="fm-side-count">{roots.length}</span>
      </h2>
      <ul className="fm-root-list">
        {roots.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={`fm-root${r.id === activeId ? ' is-active' : ''}`}
              aria-current={r.id === activeId ? 'true' : undefined}
              title={r.label === r.path ? r.path : `${r.label} — ${r.path}`}
              onClick={() => onPick(r.id)}
            >
              <span className="fm-root-label">{rootName(r)}</span>
              <span className="fm-root-meta mono-meta">{r.path}</span>
              <span className="fm-root-facts">
                {r.sensitive && <Mark tone="warn" title="Reading or downloading this root is recorded in Activity">sensitive</Mark>}
                {r.readable === false && <Mark tone="fail" title={r.reason || 'OpusHub cannot read this root'}>unreadable</Mark>}
                {r.free != null && <span className="stale-note">{bytes(r.free)} free</span>}
                {r.dataset && <span className="stale-note mono-meta">{r.dataset}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="fm-side-note stale-note">
        Roots come from {source === 'configured' ? <code>{configuredVia || 'OPUSHUB_FILES_ROOTS'}</code> : 'the storage this host reports'} — never from
        a request. <code>/</code> is not a root and cannot be made one.
      </p>
      {refused.length > 0 && (
        <details className="fm-refused">
          <summary>{refused.length} candidate {refused.length === 1 ? 'root was' : 'roots were'} refused</summary>
          <ul>
            {refused.map((r, i) => (
              <li key={`${r.path ?? 'unknown'}-${i}`}>
                <code>{r.path ?? '(unreadable)'}</code>
                <span className="stale-note"> {r.code} — {r.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function FolderTree({
  nodes, onOpen, activePath, depth = 0,
}: { nodes: FileTreeNode[]; onOpen: (p: string) => void; activePath: string; depth?: number }) {
  if (!nodes.length) return depth === 0 ? <p className="fm-side-note stale-note">No folders in here.</p> : null;
  return (
    <ul className={`fm-tree${depth === 0 ? ' fm-tree--root' : ''}`}>
      {nodes.map((n) => (
        <li key={n.path}>
          <button
            type="button"
            className={`fm-tree-node${n.path === activePath ? ' is-active' : ''}${activePath.startsWith(`${n.path}/`) ? ' is-ancestor' : ''}`}
            aria-current={n.path === activePath ? 'true' : undefined}
            onClick={() => onOpen(n.path)}
          >
            <Glyph kind="dir" label={n.name} />
            <span className="fm-tree-name">{n.name}</span>
          </button>
          {n.children.length > 0 && (
            <FolderTree nodes={n.children} onOpen={onOpen} activePath={activePath} depth={depth + 1} />
          )}
          {n.truncated && <span className="fm-tree-more stale-note">…more folders</span>}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* listing                                                             */
/* ------------------------------------------------------------------ */

const COLUMNS: { key: string; label: string; sortable: boolean }[] = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'size', label: 'Size', sortable: true },
  { key: 'type', label: 'Type', sortable: true },
  { key: 'modified', label: 'Modified', sortable: true },
  { key: 'permissions', label: 'Permissions', sortable: true },
  { key: 'owner', label: 'Owner', sortable: true },
];

function ListingTable({
  entries, selected, onOpenDir, onSelect, hrefFor, sort, dir, onSort, canDownload,
}: {
  entries: FileEntry[];
  selected: string | null;
  onOpenDir: (p: string) => void;
  onSelect: (p: string) => void;
  /** the download URL for one entry, or null when this role may not download */
  hrefFor: (p: string) => string | null;
  sort: string;
  dir: 'asc' | 'desc';
  onSort: (key: string) => void;
  canDownload: boolean;
}) {
  return (
    <div className="fm-table-wrap">
      <table className="fm-table" data-sort={sort} data-dir={dir}>
        <caption className="sr-only">Files and folders in this directory</caption>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.key} scope="col" aria-sort={sort === c.key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button type="button" className="fm-th" onClick={() => onSort(c.key)}>
                  {c.label}
                  {sort === c.key && <span className="fm-th-arrow" aria-hidden="true">{dir === 'asc' ? '↑' : '↓'}</span>}
                </button>
              </th>
            ))}
            <th scope="col" className="fm-col-act"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.path} data-kind={e.kind} className={e.path === selected ? 'is-selected' : undefined}>
              <td className="fm-cell-name">
                <Glyph kind={e.kind} ext={e.ext} label={e.typeLabel} />
                <button
                  type="button"
                  className="fm-open"
                  aria-pressed={e.path === selected ? 'true' : undefined}
                  title={e.kind === 'dir' ? `Open ${e.name}` : `Show ${e.name}`}
                  onClick={() => (e.kind === 'dir' ? onOpenDir(e.path) : onSelect(e.path))}
                >
                  {e.name}
                </button>
                {e.symlink && (
                  <Mark title={e.link?.target ? `Points to ${e.link.target} (inside this root)` : 'A symbolic link whose target leaves this root'}>link</Mark>
                )}
                {e.sensitive && <Mark tone="warn" title="Reading or downloading this file is recorded in Activity">sensitive</Mark>}
                {e.accessible === false && <Mark tone="fail" title={e.statError ? `OpusHub could not stat this entry (${e.statError})` : 'OpusHub cannot read this entry'}>unreadable</Mark>}
              </td>
              <td className="fm-cell-num mono-meta">{e.size == null ? '—' : bytes(e.size)}</td>
              <td className="fm-cell-type">{e.typeLabel}</td>
              <td className="fm-cell-when" title={when(e.mtimeMs)}>
                {e.mtimeMs ? relTime(e.mtimeMs) : '—'}
              </td>
              <td className="fm-cell-mode mono-meta" title={e.octal ? `octal ${e.octal}` : undefined}>{e.modeText || '—'}</td>
              <td className="fm-cell-owner">
                {e.owner || (e.uid != null ? <span className="mono-meta">uid {e.uid}</span> : '—')}
                {e.group && <span className="stale-note"> : {e.group}</span>}
              </td>
              <td className="fm-cell-act">
                {canDownload && e.kind !== 'dir' && hrefFor(e.path) && (
                  /* A plain link, not a click handler: the server answers it by minting a
                     short-lived reference and redirecting, so the URL a person can copy names a
                     root and a relative path and never a location on the host. */
                  <a className="icon-btn fm-dl" href={hrefFor(e.path)!} download rel="noopener"
                    title={`Download ${e.name}`} aria-label={`Download ${e.name}`}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 4v10m0 0 3.5-3.5M12 14l-3.5-3.5M5 18.5h14" />
                    </svg>
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* detail: properties + preview                                        */
/* ------------------------------------------------------------------ */

function PreviewPane({
  doc, refusal, name, rootId, path, canDownload,
}: {
  doc: FilePreviewDoc | null;
  refusal: FilesRefusal | null;
  name: string;
  rootId: string | null;
  path: string;
  canDownload: boolean;
}) {
  const href = canDownload ? downloadHref(rootId, path) : null;
  if (refusal && !doc) {
    const code = refusal.code;
    // too_large / unsupported_preview are answers about the file, not failures.
    if (code === 'too_large' || code === 'unsupported_preview') {
      return (
        <div className="fm-preview fm-preview--refused" role="status">
          <p className="fm-preview-note">
            {refusal.error}
            {refusal.label ? <> Detected as <strong>{refusal.label}</strong>{refusal.subtype ? ` (${refusal.subtype})` : null}, by {refusal.detectedBy || 'its contents'}.</> : null}
          </p>
          {href && <a className="btn btn-sm" href={href} download>Download instead</a>}
        </div>
      );
    }
    if (code === 'permission_required' || code === 'grant_required') {
      return <AccessPanel rootId={rootId} path={path} operation="read" reason={refusal.error || null} privileged={refusal.privileged ?? null} />;
    }
    return <Refusal refusal={refusal} fallback={null} title="No preview" />;
  }
  if (!doc) return <Loading what="the preview" />;

  return (
    <div className="fm-preview" data-inline={doc.inline ?? 'none'}>
      <p className="fm-preview-meta">
        <strong>{doc.label || name}</strong>
        {doc.subtype && <span className="stale-note"> {doc.subtype}</span>}
        <span className="stale-note"> · {doc.mime}</span>
        <span className="stale-note"> · detected by {doc.detectedBy}</span>
      </p>
      {doc.activeContent && (
        <p className="fm-preview-warn" role="status">
          Markup is shown as text. Nothing in a preview is rendered inside OpusHub, so no script in a
          file can run in this origin.
        </p>
      )}
      {doc.sensitive && <p className="fm-preview-warn" role="status">Reading this file is recorded in Activity.</p>}

      {doc.inline === 'text' && (
        <pre className="fm-code" dir="ltr" data-subtype={doc.subtype || undefined}>{doc.text ?? ''}</pre>
      )}
      {doc.inline === 'image' && doc.bytesHref && (
        <img className="fm-image" src={doc.bytesHref} alt={`Preview of ${name}`} loading="lazy" decoding="async" />
      )}
      {doc.inline === 'pdf' && doc.bytesHref && (
        <p className="fm-preview-note">
          A PDF is not embedded here. <a href={doc.bytesHref} target="_blank" rel="noreferrer noopener">Open it in a new tab</a> — the
          browser's own viewer, outside this page's origin.
        </p>
      )}

      <p className="fm-preview-foot stale-note">
        {doc.note || (doc.truncated
          ? `Showing ${bytes(doc.bytes)} of ${bytes(doc.size)}.`
          : `${bytes(doc.size)}${doc.lines ? ` · ${doc.lines.toLocaleString('en')} lines` : ''}${doc.encoding ? ` · ${doc.encoding}` : ''}`)}
        {doc.lossy ? ' Some characters could not be decoded and are shown as replacements.' : ''}
      </p>
    </div>
  );
}

function Properties({
  entry, stat, permStatus, href, onOpen,
}: {
  entry: FileEntry | null;
  stat: FileStatDoc | null;
  permStatus: PermissionStatusDoc | null;
  /** the download URL for the selected file, or null when it may not be downloaded */
  href: string | null;
  onOpen: () => void;
}) {
  const kind = stat?.kind ?? entry?.kind ?? 'other';
  const ctx = stat?.context ?? null;
  const matches = ctx?.containers?.matches ?? [];
  return (
    <div className="fm-props">
      <h2 className="fm-side-title">Properties</h2>
      <dl className="kv">
        <dt>Kind</dt>
        <dd>{stat?.typeLabel ?? entry?.typeLabel ?? kind}{stat?.symlink ? ' (symbolic link)' : ''}</dd>

        <dt>Size</dt>
        <dd>{stat?.size != null ? <>{bytes(stat.size)} <span className="stale-note mono-meta">{stat.size.toLocaleString('en')} bytes</span></> : '—'}</dd>

        <dt>Modified</dt>
        <dd>{when(stat?.mtimeMs ?? entry?.mtimeMs ?? null)}</dd>
        {stat?.ctimeMs != null && <><dt>Changed</dt><dd>{when(stat.ctimeMs)}</dd></>}
        {stat?.birthtimeMs != null && stat.birthtimeMs > 0 && <><dt>Created</dt><dd>{when(stat.birthtimeMs)}</dd></>}

        <dt>Permissions</dt>
        <dd>
          <code>{stat?.modeText ?? entry?.modeText ?? '—'}</code>
          {(stat?.octal ?? entry?.octal) && <span className="stale-note mono-meta"> {stat?.octal ?? entry?.octal}</span>}
        </dd>

        <dt>Owner</dt>
        <dd>
          {stat?.owner ?? entry?.owner ?? (stat?.uid != null ? <span className="mono-meta">uid {stat.uid}</span> : '—')}
          <span className="stale-note">
            {' : '}
            {stat?.group ?? entry?.group ?? (stat?.gid != null ? `gid ${stat.gid}` : '—')}
          </span>
        </dd>

        {stat?.nlink != null && <><dt>Links</dt><dd>{stat.nlink}</dd></>}

        {stat?.link?.target && (
          <>
            <dt>Points to</dt>
            <dd className="mono-meta">
              {stat.link.target}
              {!stat.link.inside && <Mark tone="warn" title="The link leaves this root, so OpusHub stops at the link">outside root</Mark>}
            </dd>
          </>
        )}

        <dt>OpusHub can read</dt>
        <dd>
          {permStatus
            ? <>
              {permStatus.state === 'readable' && <>yes</>}
              {permStatus.state === 'sensitive' && <>yes — recorded in Activity</>}
              {permStatus.state === 'permission_required' && <>no — permission required</>}
              {permStatus.state === 'protected' && <>no — protected by policy</>}
              {permStatus.state === 'blocked' && <>no — outside the root</>}
              {permStatus.state === 'not_found' && <>nothing is at this path</>}
              {permStatus.state === 'unknown_root' && <>that root is not exposed</>}
              {permStatus.state === 'invalid' && <>that path is not valid</>}
              {!!permStatus.grants?.length && <span className="stale-note"> · {permStatus.grants.length} grant{permStatus.grants.length === 1 ? '' : 's'} held</span>}
            </>
            : (stat ? (stat.readable ? 'yes' : 'no') : '—')}
        </dd>

        <dt>Classification</dt>
        <dd>{stat?.classification ? `${stat.classification.level}${stat.classification.class ? ` · ${stat.classification.class}` : ''}` : 'ordinary'}</dd>

        {ctx?.mount && (
          <>
            <dt>Mount</dt>
            <dd>
              <span className="mono-meta">{ctx.mount.mountPoint}</span>
              <span className="stale-note"> {ctx.mount.fsType || ''}{ctx.mount.readOnly ? ' · read-only' : ''}{ctx.mount.bind ? ' · bind' : ''}</span>
              {ctx.mount.usage && <span className="stale-note"> · {bytes(ctx.mount.usage.free)} free of {bytes(ctx.mount.usage.total)}</span>}
            </dd>
          </>
        )}
        {ctx?.dataset?.available && (
          <>
            <dt>Dataset</dt>
            <dd>
              <span className="mono-meta">{ctx.dataset.name ?? '—'}</span>
              {ctx.dataset.compression && <span className="stale-note"> · {ctx.dataset.compression}</span>}
              {ctx.dataset.used != null && <span className="stale-note"> · {bytes(ctx.dataset.used)} used</span>}
            </dd>
          </>
        )}
        {ctx?.volume?.available && (
          <>
            <dt>Volume</dt>
            <dd><span className="mono-meta">{ctx.volume.name ?? '—'}</span>{ctx.volume.driver && <span className="stale-note"> · {ctx.volume.driver}</span>}</dd>
          </>
        )}
        {matches.length > 0 && (
          <>
            <dt>Used by</dt>
            <dd>
              <ul className="fm-usedby">
                {matches.slice(0, 6).map((m, i) => (
                  <li key={`${m.container ?? m.id ?? i}`}>
                    <span className="mono-meta">{m.container ?? m.id ?? 'a container'}</span>
                    <span className="stale-note"> {m.relation === 'served' ? 'serves' : 'mounts'} {m.target ?? ''}{m.rw === false ? ' read-only' : ''}</span>
                  </li>
                ))}
                {matches.length > 6 && <li className="stale-note">…and {matches.length - 6} more</li>}
              </ul>
            </dd>
          </>
        )}
      </dl>

      <div className="fm-props-foot">
        {kind === 'dir'
          ? <button type="button" className="btn btn-sm" onClick={onOpen}>Open folder</button>
          : href && <a className="btn btn-sm" href={href} download rel="noopener">Download</a>}
        <span className="stale-note">Read-only: OpusHub cannot change this file.</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the page                                                            */
/* ------------------------------------------------------------------ */

export default function FilesPage() {
  const [params, setParams] = useSearchParams();
  const surface = useFilesSurface();
  const doc = surface.data;
  const roots = doc?.roots ?? [];
  const perms = doc?.permissions ?? null;
  const privileged = doc?.privileged ?? null;

  /* ---- where the URL says we are ---- */
  const wanted = params.get('root');
  const askedRoot = wanted ? roots.find((r) => r.id === wanted) ?? null : null;
  const orphanRoot = Boolean(wanted) && !askedRoot && roots.length > 0;
  // An address naming a root this host does not expose gets a refusal, not a guess: falling back to
  // the first root would fetch a folder the operator never asked for.
  const activeRoot = orphanRoot ? null : askedRoot ?? roots[0] ?? null;
  const rootId = activeRoot?.id ?? null;

  const rawPath = params.get('path') ?? '';
  const path = isSaneRelative(rawPath) ? rawPath.replace(/^\/+|\/+$/g, '') : '';
  const pathWasRewritten = rawPath !== path;
  const sel = params.get('sel');
  const query = (params.get('q') ?? '').trim();
  const sort = SORT_OPTIONS.some((o) => o.value === params.get('sort')) ? String(params.get('sort')) : 'name';
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc';
  const offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);

  const [typed, setTyped] = useState(query);
  useEffect(() => { setTyped(query); }, [query]);

  const setUrl = useCallback((next: Record<string, string | null>, replace = false) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v == null || v === '') p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace });
  }, [params, setParams]);

  const openDir = useCallback((p: string) => {
    setUrl({ root: rootId, path: p || null, sel: null, q: null, offset: null });
  }, [rootId, setUrl]);
  const openRoot = useCallback((id: string) => {
    setUrl({ root: id, path: null, sel: null, q: null, offset: null });
  }, [setUrl]);
  const selectEntry = useCallback((p: string | null) => setUrl({ sel: p }), [setUrl]);
  /** Show a file in its own folder *and* select it — one URL update, so neither half is lost. */
  const revealFile = useCallback((p: string) => {
    setUrl({ root: rootId, path: parentPath(p) || null, sel: p, q: null, offset: null });
  }, [rootId, setUrl]);
  const onSort = useCallback((key: string) => {
    setUrl({ sort: key === sort ? null : key, dir: key === sort ? (dir === 'asc' ? 'desc' : 'asc') : null, offset: null });
  }, [dir, setUrl, sort]);

  /* ---- the reads ---- */
  const list = useFileList({ root: rootId, path, sort, dir, offset: offset || null });
  const tree = useFileTree(rootId, path, 2);
  const stat = useFileStat(rootId, sel, { context: true });
  const permStatus = usePermissionStatus(rootId, sel);
  const search = useFileSearch(rootId, path, query);

  /* A re-sort or a page change keeps the table on screen while it loads: the folder did not move,
     so emptying it would be a flash and a half-truth. Navigating *somewhere else* loads from
     nothing — showing the old folder's entries under a new address would simply be wrong. */
  const where = `${rootId ?? ''}:${path}`;
  const [held, setHeld] = useState<{ where: string; doc: FileListDoc } | null>(null);
  useEffect(() => { if (list.data) setHeld({ where, doc: list.data }); }, [list.data, where]);
  const listing = list.data ?? (held && held.where === where ? held.doc : null);
  const rereading = !list.data && listing != null;

  const entries = listing?.entries ?? [];
  const selectedEntry = useMemo(
    () => (sel ? entries.find((e) => e.path === sel) ?? null : null),
    [entries, sel],
  );
  const selKind = stat.data?.kind ?? selectedEntry?.kind ?? null;
  const selIsDir = selKind === 'dir';
  const preview = useFilePreview(rootId, sel && !selIsDir ? sel : null, { enabled: !selIsDir });

  const canDownload = perms?.download === true;
  const canSearch = perms?.search !== false;

  /**
   * A download is a plain link, never a fetch: `/api/files/download?root=<id>&path=<relative>`
   * answers with a 302 to a reference the server just minted, bound to this session, that path and
   * a two-minute expiry. So the token never lives in this page's state, the URL a person can copy
   * carries no host path, and the browser's own download UI does the rest.
   */
  const hrefFor = useCallback((target: string | null) => downloadHref(rootId, target), [rootId]);

  const refreshAll = useCallback(() => {
    surface.refresh();
    list.refresh();
    tree.refresh();
    if (sel) { stat.refresh(); permStatus.refresh(); }
    if (query) search.refresh();
  }, [list, permStatus, query, search, sel, stat, surface, tree]);

  /* ---- the shell ---- */
  const hero = (
    <PageHero
      title="Files"
      desc={
        doc
          ? <>
            Read-only. OpusHub can list, preview, search and download inside the {roots.length} exposed
            {roots.length === 1 ? ' root' : ' roots'} — it cannot create, rename, move, copy, delete or
            upload anything, and it never runs a command to reach a file.
          </>
          : 'Reading the filesystem roots this host exposes…'
      }
      meta={
        <>
          {doc && <span>{doc.provider.label}</span>}
          {doc && <span className="sep">·</span>}
          {doc && <span>{roots.length} {roots.length === 1 ? 'root' : 'roots'}</span>}
          {doc?.limits && <span className="sep">·</span>}
          {doc?.limits && <span>preview ≤ {bytes(doc.limits.maxPreviewBytes)}</span>}
          <Freshness at={surface.fetchedAt} error={surface.error} />
        </>
      }
      actions={
        <>
          <span className="chip fm-readonly" title="This phase has no write operation of any kind">Read-only</span>
          <button type="button" className="btn btn-sm" onClick={refreshAll} title="Re-read this folder">
            Refresh
          </button>
        </>
      }
    />
  );

  /* ---- states that own the whole page ---- */
  if (!doc && surface.loading) return <>{hero}<Loading what="the filesystem roots" /></>;

  if (!doc && surface.error) {
    return (
      <>
        {hero}
        <div className="fm-empty fm-empty--blocked" role="status">
          <h2>Files are not available to you</h2>
          <p>{surface.error}</p>
          <p className="fm-side-note stale-note">
            Reading files is a role permission: an administrator can read, search and download; an
            operator can read and search. Nothing about this can be requested from the interface.
          </p>
        </div>
      </>
    );
  }

  if (doc?.disabled) {
    return (
      <>
        {hero}
        <div className="fm-empty" role="status">
          <h2>The file manager is switched off on this host</h2>
          <p>
            <code>OPUSHUB_FILES_DISABLED</code> is set, so no filesystem root is exposed and no files
            route answers. Remove it from the environment and restart OpusHub to bring this page back.
          </p>
        </div>
      </>
    );
  }

  if (!roots.length) {
    return (
      <>
        {hero}
        <div className="fm-empty" role="status">
          <h2>No filesystem root is exposed</h2>
          <p>
            OpusHub only reads directories an operator named. Set <code>OPUSHUB_FILES_ROOTS</code> to a
            comma-separated list of absolute paths — for example the folders your stacks and media live
            in — and restart. The whole filesystem is never a root, <code>/</code> is refused outright,
            and a path that is not readable or not a directory is refused with a reason.
          </p>
          {doc?.source === 'discovered' && (
            <p className="fm-side-note stale-note">
              No roots are configured, so OpusHub looked at the storage this host reports and found
              nothing it is allowed to expose.
            </p>
          )}
          {(doc?.refused?.length ?? 0) > 0 && (
            <details className="fm-refused" open>
              <summary>{doc?.refused.length} candidate {doc?.refused.length === 1 ? 'root was' : 'roots were'} refused</summary>
              <ul>
                {doc?.refused.map((r, i) => (
                  <li key={`${r.path ?? 'unknown'}-${i}`}>
                    <code>{r.path ?? '(unreadable)'}</code>
                    <span className="stale-note"> {r.code} — {r.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {doc?.configuredVia && (
            <p className="fm-side-note stale-note">Read from <code>{doc.configuredVia}</code>.</p>
          )}
        </div>
      </>
    );
  }

  if (orphanRoot) {
    return (
      <>
        {hero}
        <div className="fm-empty" role="status">
          <h2>That root is not exposed</h2>
          <p>
            The address names a root this host does not expose — it may have been removed from the
            configuration, or the link came from another machine.
          </p>
          <div className="fm-root-picks">
            {roots.map((r) => (
              <button key={r.id} type="button" className="btn btn-sm" title={r.path} onClick={() => openRoot(r.id)}>{rootName(r)}</button>
            ))}
          </div>
        </div>
      </>
    );
  }

  /* ---- the explorer ---- */
  // From here on `activeRoot` cannot be null: every branch that could leave it null returned above.
  if (!activeRoot) return <>{hero}</>;
  const crumbs = pathSegments(path);
  const note = listingNote(listing);
  const searching = Boolean(query);

  return (
    <>
      {hero}
      <div className={`fm-shell${sel ? ' fm-shell--detail' : ''}`}>
        <aside className="fm-side" aria-label="Roots and folders">
          <RootsList
            roots={roots}
            refused={doc?.refused ?? []}
            activeId={rootId}
            onPick={openRoot}
            source={doc?.source ?? 'configured'}
            configuredVia={doc?.configuredVia ?? null}
          />
          <div className="fm-folders">
            <h2 className="fm-side-title">
              Folders
              <span className="fm-side-count">{tree.data?.children.length ?? 0}</span>
            </h2>
            {tree.loading && !tree.data && <Loading what="the folders" />}
            {tree.data
              ? <FolderTree nodes={tree.data.children} onOpen={openDir} activePath={path} />
              : tree.error && <p className="fm-side-note stale-note">{tree.error}</p>}
          </div>
          {doc?.notSupported?.length ? (
            <details className="fm-cannot">
              <summary>What OpusHub cannot do here</summary>
              <p className="stale-note">{doc.notSupported.join(', ')}.</p>
              <p className="stale-note">
                None of these has an endpoint, a permission or a hidden flag in this phase.
              </p>
            </details>
          ) : null}
        </aside>

        <section className="fm-main" aria-label="Files">
          <div className="fm-toolbar">
            <button
              type="button"
              className="icon-btn"
              aria-label="Up one folder"
              title={path ? `Up to ${parentPath(path) || rootName(activeRoot)}` : `Already at the top of ${rootName(activeRoot)}`}
              disabled={!path}
              onClick={() => openDir(parentPath(path))}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V6m0 0-5.5 5.5M12 6l5.5 5.5" />
              </svg>
            </button>

            <nav className="fm-crumbs" aria-label="Folder path">
              <ol>
                <li>
                  <button
                    type="button"
                    className={`fm-crumb${crumbs.length === 0 ? ' is-active' : ''}`}
                    title={activeRoot.path}
                    onClick={() => openDir('')}
                  >
                    <Glyph kind="dir" label={rootName(activeRoot)} />
                    {rootName(activeRoot)}
                  </button>
                </li>
                {crumbs.map((c, i) => (
                  <li key={c.path}>
                    <span className="fm-crumb-sep" aria-hidden="true">/</span>
                    <button
                      type="button"
                      className={`fm-crumb${i === crumbs.length - 1 ? ' is-active' : ''}`}
                      aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                      onClick={() => openDir(c.path)}
                    >
                      {c.name}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>

            <div className="fm-toolbar-right">
              {canSearch ? (
                <form
                  className="fm-search"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    const v = typed.trim();
                    setUrl({ q: v || null, sel: null, offset: null });
                  }}
                >
                  <input
                    className="input fm-search-input"
                    type="search"
                    value={typed}
                    onChange={(ev) => setTyped(ev.target.value)}
                    placeholder={`Search names in ${path || rootName(activeRoot)}`}
                    aria-label="Search file names in this folder"
                    maxLength={120}
                  />
                  <button type="submit" className="btn btn-sm">Search</button>
                  {query && (
                    <button type="button" className="btn btn-sm btn-quiet" onClick={() => { setTyped(''); setUrl({ q: null }); }}>
                      Clear
                    </button>
                  )}
                </form>
              ) : (
                <span className="stale-note" title="Your role may not search the filesystem">Search is not available to your role</span>
              )}

              <label className="fm-sort">
                <span className="sr-only">Sort by</span>
                <select
                  className="select fm-sort-select"
                  value={sort}
                  onChange={(ev) => setUrl({ sort: ev.target.value === 'name' ? null : ev.target.value, offset: null })}
                >
                  {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <button
                type="button"
                className="icon-btn"
                aria-label={dir === 'asc' ? 'Sort descending' : 'Sort ascending'}
                title={dir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
                onClick={() => setUrl({ dir: dir === 'asc' ? 'desc' : null, offset: null })}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {dir === 'asc' ? <path d="M12 5v14m0 0-4.5-4.5M12 19l4.5-4.5" /> : <path d="M12 19V5m0 0L7.5 9.5M12 5l4.5 4.5" />}
                </svg>
              </button>
            </div>
          </div>

          {pathWasRewritten && (
            <p className="fm-note fm-note--warn" role="status">
              That address contained a path OpusHub will not send (an absolute path, a traversal or a
              stray separator). Showing the folder it resolves to inside this root.
            </p>
          )}

          {searching ? (
            <SearchResults
              state={search}
              rootId={rootId}
              onOpenDir={openDir}
              onOpenFile={revealFile}
              onClear={() => { setTyped(''); setUrl({ q: null }); }}
            />
          ) : listing ? (
            <>
              {rereading && <p className="fm-note stale-note" role="status">Re-reading this folder…</p>}
              {entries.length === 0 ? (
                <div className="fm-empty fm-empty--quiet" role="status">
                  <p>This folder is empty{listing.hidden > 0 ? ` — ${listing.hidden} ${listing.hidden === 1 ? 'entry is' : 'entries are'} protected and not shown` : ''}.</p>
                </div>
              ) : (
                <ListingTable
                  entries={entries}
                  selected={sel}
                  onOpenDir={openDir}
                  onSelect={selectEntry}
                  hrefFor={hrefFor}
                  sort={sort}
                  dir={dir}
                  onSort={onSort}
                  canDownload={canDownload}
                />
              )}
              {note && <p className="fm-note">{note}</p>}
              {listing.truncated && (
                <div className="fm-pager">
                  {offset > 0 && (
                    <button type="button" className="btn btn-sm" onClick={() => setUrl({ offset: String(Math.max(0, offset - listing.count)) })}>
                      Previous {listing.count.toLocaleString('en')}
                    </button>
                  )}
                  <span className="stale-note">
                    {(offset + 1).toLocaleString('en')}–{Math.min(offset + listing.count, listing.total).toLocaleString('en')} of {listing.total.toLocaleString('en')}
                  </span>
                  {offset + listing.count < listing.total && (
                    <button type="button" className="btn btn-sm" onClick={() => setUrl({ offset: String(offset + listing.count) })}>
                      Next {Math.min(listing.count, listing.total - offset - listing.count).toLocaleString('en')}
                    </button>
                  )}
                </div>
              )}
            </>
          ) : list.error ? (
            <Refusal
              refusal={refusalOf(list.error, list.errorCode, list.errorBody)}
              onResolved={refreshAll}
              fallback={list.error}
              rootId={rootId}
              path={path}
              kind="dir"
              privileged={privileged}
              retry={() => list.refresh()}
              title="This folder could not be listed"
            />
          ) : (
            <Loading what="this folder" />
          )}

          <p className="fm-foot stale-note">
            {listing
              ? `${listing.count.toLocaleString('en')} of ${listing.total.toLocaleString('en')} entries · scanned ${listing.scanned.toLocaleString('en')}${listing.hidden ? ` · ${listing.hidden} protected` : ''}`
              : 'Entries are read with a bound on how many are listed, how deep a search walks and how much of a file is previewed.'}
            {doc?.limits ? ` · preview ≤ ${bytes(doc.limits.maxPreviewBytes)} · search ≤ ${doc.limits.maxSearchMatches} matches` : ''}
          </p>
        </section>

        {sel && (
          <aside className="fm-detail" aria-label="Selected file">
            <div className="fm-detail-head">
              <Glyph kind={selKind ?? 'file'} ext={selectedEntry?.ext} label={stat.data?.typeLabel} />
              <h2 className="fm-detail-name" title={sel}>{stat.data?.name ?? selectedEntry?.name ?? sel}</h2>
              <button type="button" className="icon-btn" aria-label="Close details" title="Close details" onClick={() => selectEntry(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>

            {stat.error && !stat.data ? (
              <Refusal
                refusal={refusalOf(stat.error, stat.errorCode, stat.errorBody)}
                onResolved={refreshAll}
                fallback={stat.error}
                rootId={rootId}
                path={sel}
                kind={selIsDir ? 'dir' : 'file'}
                privileged={privileged}
                retry={() => stat.refresh()}
                title="Properties could not be read"
              />
            ) : !stat.data && !selectedEntry ? (
              <Loading what="the properties" />
            ) : (
              <Properties
                entry={selectedEntry}
                stat={stat.data}
                permStatus={permStatus.data}
                href={canDownload && !selIsDir ? hrefFor(sel) : null}
                onOpen={() => openDir(sel)}
              />
            )}

            {!selIsDir && (
              <div className="fm-detail-preview">
                <h2 className="fm-side-title">Preview</h2>
                <PreviewPane
                  doc={preview.data}
                  refusal={refusalOf(preview.error, preview.errorCode, preview.errorBody)}
                  name={stat.data?.name ?? selectedEntry?.name ?? sel}
                  rootId={rootId}
                  path={sel}
                  canDownload={canDownload}
                />
              </div>
            )}
          </aside>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* search results                                                      */
/* ------------------------------------------------------------------ */

function SearchResults({
  state, rootId, onOpenDir, onOpenFile, onClear,
}: {
  state: QueryState<FileSearchDoc>;
  rootId: string | null;
  onOpenDir: (p: string) => void;
  onOpenFile: (p: string) => void;
  onClear: () => void;
}) {
  const d = state.data;
  if (state.error && !d) {
    return (
      <Refusal
        refusal={refusalOf(state.error, state.errorCode, state.errorBody)}
        fallback={state.error}
        rootId={rootId}
        path={null}
        kind="dir"
        retry={() => state.refresh()}
        title="That search could not run"
      />
    );
  }
  if (!d) return <Loading what="the search" note="names only — file contents are never read to search" />;

  const note = searchNote(d);
  return (
    <div className="fm-results">
      <div className="fm-results-head">
        <h2 className="fm-side-title">
          {d.count.toLocaleString('en')} {d.count === 1 ? 'match' : 'matches'} for “{d.query}”
        </h2>
        <button type="button" className="btn btn-sm btn-quiet" onClick={onClear}>Back to the folder</button>
      </div>
      {d.count === 0 ? (
        <p className="fm-empty fm-empty--quiet" role="status">
          Nothing in this folder is named like that. Protected locations are never matched, and folder
          symlinks are never followed — so a name behind one will not appear.
        </p>
      ) : (
        <ul className="fm-result-list">
          {d.matches.map((m) => (
            <li key={m.path}>
              <button type="button" className="fm-result" onClick={() => (m.kind === 'dir' ? onOpenDir(m.path) : onOpenFile(m.path))}>
                <Glyph kind={m.kind} label={m.typeLabel} />
                <span className="fm-result-name">{m.name}</span>
                <span className="fm-result-path mono-meta">{parentPath(m.path) || 'the folder itself'}</span>
                <span className="fm-result-facts stale-note">
                  {m.typeLabel}{m.size != null ? ` · ${bytes(m.size)}` : ''}{m.mtimeMs ? ` · ${relTime(m.mtimeMs)}` : ''}
                </span>
                {m.sensitive && <Mark tone="warn">sensitive</Mark>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="fm-note">{note}</p>}
    </div>
  );
}
