// Phase 11A — the bounds every filesystem read obeys.
//
// A file manager is the one surface in OpusHub where "read this" can mean "read 400 GB", so the
// limits are not tuning knobs: they are the difference between a browser and a denial of service.
// Every number here is enforced server-side, before any I/O, and reported to the UI so the page can
// say *why* a listing is short or a preview is truncated instead of looking broken.
//
// Nothing in this file is configurable from a request. Changing a bound is a code change.

export const LIMITS = Object.freeze({
  /* ---- listing ---- */
  /** Entries returned for one directory. A directory with more is reported as `truncated`. */
  maxDirectoryEntries: 2_000,
  /** Entries readdir may hand back before we stop counting (protects the walk, not the response). */
  maxDirectoryScan: 20_000,
  /** Concurrent lstat calls while enriching one listing. */
  statConcurrency: 16,

  /* ---- the sidebar tree ---- */
  /** Levels the tree endpoint will return in one answer (the tree is lazy below that). */
  maxTreeDepth: 3,
  /** Entries per tree level. */
  maxTreeEntriesPerLevel: 200,

  /* ---- preview ---- */
  /** Bytes of a text file a preview may carry. */
  maxPreviewBytes: 256 * 1024,
  /** Bytes sniffed to decide what a file is (magic bytes beat the extension). */
  sniffBytes: 8 * 1024,
  /** A file larger than this is never previewed — download is the honest answer. */
  maxPreviewFileSize: 32 * 1024 * 1024,
  /** An image larger than this is not inlined (it would be a slow, memory-hungry render). */
  maxInlineImageBytes: 8 * 1024 * 1024,

  /* ---- download ---- */
  /**
   * Downloads are streamed, never buffered: the byte cap is therefore `null` (no cap) and the
   * protection is the stream itself plus the deadline below. A cap that buffered first would be
   * worse than no cap.
   */
  maxDownloadBytes: null,

  /* ---- search ---- */
  maxSearchMatches: 500,
  /** Directories and files visited by one search — the real cost bound. */
  maxSearchNodes: 20_000,
  /** How deep below the search origin one search may go. */
  maxSearchDepth: 8,
  /** Characters of a query; shorter than this is refused as `bad_query`. */
  minSearchQuery: 1,
  maxSearchQuery: 128,

  /* ---- path shape ---- */
  maxPathLength: 4_096,
  maxPathDepth: 64,
  maxNameLength: 255,
  /** Exposed roots. Bounded so a wild mount table cannot produce a wild UI. */
  maxRoots: 24,

  /* ---- time ---- */
  listTimeoutMs: 8_000,
  statTimeoutMs: 3_000,
  previewTimeoutMs: 8_000,
  searchTimeoutMs: 8_000,
  contextTimeoutMs: 8_000,
  /** One privileged grant, at most. The broker caps whatever a provider claims. */
  grantTtlMs: 15 * 60_000,

  /* ---- tokens ---- */
  downloadTokenTtlMs: 120_000,
  previewTokenTtlMs: 300_000,
  maxTokens: 400,

  /* ---- caches ---- */
  rootTtlMs: 30_000,
  mountTableTtlMs: 60_000,
  storageContextTtlMs: 60_000,
  containerIndexTtlMs: 120_000,
  /** Container inspects performed to build the bind-mount index for one properties request. */
  maxContainerInspects: 32,
  nameCacheTtlMs: 60_000,
  nameCacheEntries: 4_096,
});

/** The bounds the UI is allowed to know about (everything above is safe: no paths, no secrets). */
export function publicLimits() {
  return {
    maxDirectoryEntries: LIMITS.maxDirectoryEntries,
    maxPreviewBytes: LIMITS.maxPreviewBytes,
    maxPreviewFileSize: LIMITS.maxPreviewFileSize,
    maxInlineImageBytes: LIMITS.maxInlineImageBytes,
    maxSearchMatches: LIMITS.maxSearchMatches,
    maxSearchNodes: LIMITS.maxSearchNodes,
    maxSearchDepth: LIMITS.maxSearchDepth,
    maxSearchQuery: LIMITS.maxSearchQuery,
    maxTreeDepth: LIMITS.maxTreeDepth,
    maxPathDepth: LIMITS.maxPathDepth,
    downloads: LIMITS.maxDownloadBytes == null ? 'streamed' : 'capped',
    grantTtlMs: LIMITS.grantTtlMs,
    downloadTokenTtlMs: LIMITS.downloadTokenTtlMs,
  };
}
