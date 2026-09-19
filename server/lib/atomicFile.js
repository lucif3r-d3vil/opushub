// One atomic file write for every store in the server: write to a fresh temp file next to the
// target, then rename over it — a reader never observes a torn write, on any platform OpusHub
// runs on. Fifteen call sites in ten stores used to write these same three lines; the stores
// differ in *what* they persist, *when* they trim and *how* they validate — not in how a write
// becomes durable, so the durable part lives here exactly once.
import fs from 'node:fs';

/**
 * Replace `file` with `text` atomically.
 *
 * `mode` (e.g. 0o600 for files that may hold secrets) is applied to the temp file *before* the
 * rename — so the secret never exists at a wider permission — and again to the target after it,
 * because rename carries the temp's permissions and an older target may have been wider.
 */
export function writeFileAtomic(file, text, { mode = null } = {}) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  if (mode != null) { try { fs.chmodSync(tmp, mode); } catch { /* the rename stays atomic either way */ } }
  fs.renameSync(tmp, file);
  if (mode != null) { try { fs.chmodSync(file, mode); } catch { /* best effort */ } }
}

/** The same discipline for a JSON document: two-space indent, trailing newline. */
export function writeJsonAtomic(file, value, { mode = null } = {}) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', { mode });
}
