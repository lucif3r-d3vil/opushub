// Phase 11A — what a file *is*, decided on the server, from its bytes.
//
// Two rules make this module a security boundary rather than a convenience:
//
//   1. The extension is a hint, never the answer. A file named `notes.txt` that starts with the PNG
//      signature is an image; a file named `photo.png` that holds JSON is text. Detection reads the
//      first bytes (a bounded sniff) and only then consults the name.
//   2. Nothing here is ever *executed* or *rendered*. HTML and SVG are detected so the UI can say
//      "this is markup, shown as text" — the bytes go out as text, escaped by React, and the raw
//      route refuses to serve them inline at all. Active content is named, not opened.
//
// Previews are bounded by files/limits.js; a file too big to preview is reported as too big, with
// the download as the honest alternative.
import { LIMITS } from './limits.js';

/** Text subtypes whose content is markup that a browser would execute if we let it. */
export const ACTIVE_SUBTYPES = Object.freeze(['html', 'svg', 'xml', 'xsl', 'mhtml']);

const MAGIC = [
  { kind: 'image', subtype: 'png', mime: 'image/png', label: 'PNG image', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { kind: 'image', subtype: 'jpeg', mime: 'image/jpeg', label: 'JPEG image', bytes: [0xff, 0xd8, 0xff] },
  { kind: 'image', subtype: 'gif', mime: 'image/gif', label: 'GIF image', ascii: 'GIF8' },
  { kind: 'image', subtype: 'bmp', mime: 'image/bmp', label: 'BMP image', ascii: 'BM' },
  { kind: 'image', subtype: 'ico', mime: 'image/x-icon', label: 'Icon', bytes: [0x00, 0x00, 0x01, 0x00] },
  { kind: 'image', subtype: 'tiff', mime: 'image/tiff', label: 'TIFF image', bytes: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]] },
  { kind: 'pdf', subtype: 'pdf', mime: 'application/pdf', label: 'PDF document', ascii: '%PDF-' },
  { kind: 'archive', subtype: 'zip', mime: 'application/zip', label: 'ZIP archive', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { kind: 'archive', subtype: 'gzip', mime: 'application/gzip', label: 'Gzip archive', bytes: [0x1f, 0x8b] },
  { kind: 'archive', subtype: 'bzip2', mime: 'application/x-bzip2', label: 'Bzip2 archive', ascii: 'BZh' },
  { kind: 'archive', subtype: 'xz', mime: 'application/x-xz', label: 'XZ archive', bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { kind: 'archive', subtype: '7z', mime: 'application/x-7z-compressed', label: '7-Zip archive', ascii: '7z\xbc\xaf\x27\x1c' },
  { kind: 'archive', subtype: 'rar', mime: 'application/vnd.rar', label: 'RAR archive', ascii: 'Rar!' },
  { kind: 'archive', subtype: 'tar', mime: 'application/x-tar', label: 'Tape archive', ascii: 'ustar', at: 257 },
  { kind: 'database', subtype: 'sqlite', mime: 'application/vnd.sqlite3', label: 'SQLite database', ascii: 'SQLite format 3\u0000' },
  { kind: 'binary', subtype: 'elf', mime: 'application/x-executable', label: 'Executable (ELF)', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { kind: 'media', subtype: 'ogg', mime: 'application/ogg', label: 'Ogg media', ascii: 'OggS' },
  { kind: 'media', subtype: 'flac', mime: 'audio/flac', label: 'FLAC audio', ascii: 'fLaC' },
  { kind: 'media', subtype: 'mp3', mime: 'audio/mpeg', label: 'MP3 audio', ascii: 'ID3' },
  { kind: 'media', subtype: 'wav', mime: 'audio/wav', label: 'WAV audio', ascii: 'WAVE', at: 8 },
];

/** `ftyp` at offset 4 covers the ISO base media family: mp4, m4a, mov, heic, avif. */
const FTYP = {
  avif: { kind: 'image', subtype: 'avif', mime: 'image/avif', label: 'AVIF image' },
  heic: { kind: 'image', subtype: 'heic', mime: 'image/heic', label: 'HEIC image' },
  heif: { kind: 'image', subtype: 'heif', mime: 'image/heif', label: 'HEIF image' },
  m4a: { kind: 'media', subtype: 'm4a', mime: 'audio/mp4', label: 'M4A audio' },
  mov: { kind: 'media', subtype: 'mov', mime: 'video/quicktime', label: 'QuickTime video' },
  mp4: { kind: 'media', subtype: 'mp4', mime: 'video/mp4', label: 'MP4 video' },
  m4v: { kind: 'media', subtype: 'm4v', mime: 'video/x-m4v', label: 'M4V video' },
};

const EXT = {
  txt: { kind: 'text', subtype: 'plain', label: 'Text document' },
  text: { kind: 'text', subtype: 'plain', label: 'Text document' },
  log: { kind: 'text', subtype: 'log', label: 'Log file' },
  json: { kind: 'text', subtype: 'json', label: 'JSON document' },
  jsonc: { kind: 'text', subtype: 'json', label: 'JSON document' },
  ndjson: { kind: 'text', subtype: 'log', label: 'JSON lines' },
  yaml: { kind: 'text', subtype: 'yaml', label: 'YAML document' },
  yml: { kind: 'text', subtype: 'yaml', label: 'YAML document' },
  md: { kind: 'text', subtype: 'markdown', label: 'Markdown document' },
  markdown: { kind: 'text', subtype: 'markdown', label: 'Markdown document' },
  csv: { kind: 'text', subtype: 'csv', label: 'CSV document' },
  tsv: { kind: 'text', subtype: 'csv', label: 'TSV document' },
  xml: { kind: 'text', subtype: 'xml', label: 'XML document' },
  html: { kind: 'text', subtype: 'html', label: 'HTML document' },
  htm: { kind: 'text', subtype: 'html', label: 'HTML document' },
  xhtml: { kind: 'text', subtype: 'html', label: 'XHTML document' },
  svg: { kind: 'text', subtype: 'svg', label: 'SVG image (markup)' },
  css: { kind: 'text', subtype: 'css', label: 'Stylesheet' },
  js: { kind: 'text', subtype: 'javascript', label: 'JavaScript source' },
  mjs: { kind: 'text', subtype: 'javascript', label: 'JavaScript source' },
  cjs: { kind: 'text', subtype: 'javascript', label: 'JavaScript source' },
  ts: { kind: 'text', subtype: 'typescript', label: 'TypeScript source' },
  tsx: { kind: 'text', subtype: 'typescript', label: 'TypeScript source' },
  jsx: { kind: 'text', subtype: 'javascript', label: 'JSX source' },
  sh: { kind: 'text', subtype: 'shell', label: 'Shell script' },
  bash: { kind: 'text', subtype: 'shell', label: 'Shell script' },
  zsh: { kind: 'text', subtype: 'shell', label: 'Shell script' },
  py: { kind: 'text', subtype: 'python', label: 'Python source' },
  rb: { kind: 'text', subtype: 'ruby', label: 'Ruby source' },
  go: { kind: 'text', subtype: 'go', label: 'Go source' },
  rs: { kind: 'text', subtype: 'rust', label: 'Rust source' },
  c: { kind: 'text', subtype: 'c', label: 'C source' },
  h: { kind: 'text', subtype: 'c', label: 'C header' },
  conf: { kind: 'text', subtype: 'config', label: 'Configuration file' },
  cfg: { kind: 'text', subtype: 'config', label: 'Configuration file' },
  ini: { kind: 'text', subtype: 'config', label: 'INI file' },
  toml: { kind: 'text', subtype: 'toml', label: 'TOML document' },
  env: { kind: 'text', subtype: 'config', label: 'Environment file' },
  sql: { kind: 'text', subtype: 'sql', label: 'SQL file' },
  compose: { kind: 'text', subtype: 'yaml', label: 'Compose document' },
  png: { kind: 'image', subtype: 'png', mime: 'image/png', label: 'PNG image' },
  jpg: { kind: 'image', subtype: 'jpeg', mime: 'image/jpeg', label: 'JPEG image' },
  jpeg: { kind: 'image', subtype: 'jpeg', mime: 'image/jpeg', label: 'JPEG image' },
  gif: { kind: 'image', subtype: 'gif', mime: 'image/gif', label: 'GIF image' },
  webp: { kind: 'image', subtype: 'webp', mime: 'image/webp', label: 'WebP image' },
  avif: { kind: 'image', subtype: 'avif', mime: 'image/avif', label: 'AVIF image' },
  ico: { kind: 'image', subtype: 'ico', mime: 'image/x-icon', label: 'Icon' },
  pdf: { kind: 'pdf', subtype: 'pdf', mime: 'application/pdf', label: 'PDF document' },
  mp3: { kind: 'media', subtype: 'mp3', mime: 'audio/mpeg', label: 'MP3 audio' },
  flac: { kind: 'media', subtype: 'flac', mime: 'audio/flac', label: 'FLAC audio' },
  m4a: { kind: 'media', subtype: 'm4a', mime: 'audio/mp4', label: 'M4A audio' },
  opus: { kind: 'media', subtype: 'opus', mime: 'audio/ogg', label: 'Opus audio' },
  wav: { kind: 'media', subtype: 'wav', mime: 'audio/wav', label: 'WAV audio' },
  mp4: { kind: 'media', subtype: 'mp4', mime: 'video/mp4', label: 'MP4 video' },
  mkv: { kind: 'media', subtype: 'mkv', mime: 'video/x-matroska', label: 'Matroska video' },
  webm: { kind: 'media', subtype: 'webm', mime: 'video/webm', label: 'WebM video' },
  mov: { kind: 'media', subtype: 'mov', mime: 'video/quicktime', label: 'QuickTime video' },
  avi: { kind: 'media', subtype: 'avi', mime: 'video/x-msvideo', label: 'AVI video' },
  zip: { kind: 'archive', subtype: 'zip', mime: 'application/zip', label: 'ZIP archive' },
  tar: { kind: 'archive', subtype: 'tar', mime: 'application/x-tar', label: 'Tape archive' },
  gz: { kind: 'archive', subtype: 'gzip', mime: 'application/gzip', label: 'Gzip archive' },
  tgz: { kind: 'archive', subtype: 'gzip', mime: 'application/gzip', label: 'Gzip archive' },
  xz: { kind: 'archive', subtype: 'xz', mime: 'application/x-xz', label: 'XZ archive' },
  iso: { kind: 'archive', subtype: 'iso', mime: 'application/x-iso9660-image', label: 'Disk image' },
  deb: { kind: 'archive', subtype: 'deb', mime: 'application/vnd.debian.binary-package', label: 'Debian package' },
  rpm: { kind: 'archive', subtype: 'rpm', mime: 'application/x-rpm', label: 'RPM package' },
  db: { kind: 'database', subtype: 'sqlite', mime: 'application/vnd.sqlite3', label: 'Database file' },
  sqlite: { kind: 'database', subtype: 'sqlite', mime: 'application/vnd.sqlite3', label: 'SQLite database' },
};

const EXT_OF = (name) => {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  if (i <= 0 || i === n.length - 1) return '';
  return n.slice(i + 1).toLowerCase().slice(0, 12);
};

function startsWith(head, bytes, at = 0) {
  if (head.length < at + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (head[at + i] !== bytes[i]) return false;
  return true;
}
function startsWithAscii(head, ascii, at = 0) {
  return startsWith(head, Buffer.from(String(ascii), 'latin1'), at);
}

/**
 * Decide what a file is.
 *
 * @param head  the first (bounded) bytes — may be the whole file
 * @param name  the file name, used only as a hint for text subtypes and as a fallback
 * @param size  the full size, so an empty file is not "binary"
 * @returns {{kind, subtype, label, mime, textual, activeContent, detectedBy}}
 */
export function detect({ head = Buffer.alloc(0), name = '', size = null } = {}) {
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  const ext = EXT_OF(name);

  if ((size === 0 || (size == null && buf.length === 0)) && buf.length === 0) {
    return { kind: 'empty', subtype: 'empty', label: 'Empty file', mime: 'application/octet-stream', textual: false, activeContent: false, detectedBy: 'size' };
  }

  // 1. magic bytes win
  for (const m of MAGIC) {
    if (m.bytes && Array.isArray(m.bytes[0])) {
      if (m.bytes.some((alt) => startsWith(buf, alt, m.at || 0))) return hit(m, 'magic');
    } else if (m.bytes && startsWith(buf, m.bytes, m.at || 0)) return hit(m, 'magic');
    else if (m.ascii && startsWithAscii(buf, m.ascii, m.at || 0)) return hit(m, 'magic');
  }
  if (buf.length >= 12 && startsWithAscii(buf, 'ftyp', 4)) {
    const brand = buf.subarray(8, 12).toString('latin1').toLowerCase();
    const m = FTYP[brand] || { kind: 'media', subtype: 'mp4', mime: 'video/mp4', label: 'MP4 media' };
    return hit(m, 'magic');
  }
  if (buf.length >= 12 && startsWithAscii(buf, 'RIFF', 0) && startsWithAscii(buf, 'WEBP', 8)) {
    return hit({ kind: 'image', subtype: 'webp', mime: 'image/webp', label: 'WebP image' }, 'magic');
  }

  // 2. is it text at all? No NUL byte in the sniff, and it decodes as UTF-8 (or nearly).
  const nul = buf.indexOf(0);
  const looksTextual = nul === -1 && buf.length > 0;
  if (looksTextual) {
    const decoded = decodeText(buf);
    const strong = strongSubtype(decoded.text);          // what the content proves on its own
    const hinted = EXT[ext];
    const hint = hinted && hinted.kind === 'text' ? hinted.subtype : null;
    // a `.log` of JSON lines stays a log; a `.txt` holding a JSON object becomes JSON
    const contentWon = !!strong && (!hint || hint === 'plain');
    const subtype = contentWon ? strong : (hint || strong || 'plain');
    return {
      kind: 'text', subtype, label: SUBTYPE_LABELS[subtype] || hinted?.label || 'Text document',
      mime: TEXT_MIME[subtype] || 'text/plain; charset=utf-8',
      textual: true, activeContent: ACTIVE_SUBTYPES.includes(subtype), encoding: decoded.encoding,
      // `detectedBy` says which evidence decided, so a wrong label can be diagnosed: the content
      // alone, the name alone, or both agreeing.
      detectedBy: contentWon ? 'content' : hint ? `content+extension:${ext}` : 'content',
    };
  }

  // 3. not text: the extension may still name a known binary family
  const hinted = EXT[ext];
  if (hinted && hinted.kind !== 'text') return hit({ ...hinted, mime: hinted.mime || 'application/octet-stream' }, `extension:${ext}`);
  if (nul >= 0) return { kind: 'binary', subtype: 'binary', label: 'Binary file', mime: 'application/octet-stream', textual: false, activeContent: false, detectedBy: 'content' };
  return { kind: 'binary', subtype: 'binary', label: 'Binary file', mime: 'application/octet-stream', textual: false, activeContent: false, detectedBy: 'unknown' };
}

function hit(m, detectedBy) {
  return {
    kind: m.kind, subtype: m.subtype, label: m.label, mime: m.mime || 'application/octet-stream',
    textual: false, activeContent: false, detectedBy,
  };
}

const SUBTYPE_LABELS = Object.freeze({
  plain: 'Text document', log: 'Log file', json: 'JSON document', yaml: 'YAML document',
  markdown: 'Markdown document', csv: 'CSV document', xml: 'XML document', html: 'HTML document',
  svg: 'SVG image (markup)', css: 'Stylesheet', javascript: 'JavaScript source',
  typescript: 'TypeScript source', shell: 'Shell script', python: 'Python source',
  config: 'Configuration file', toml: 'TOML document', sql: 'SQL file',
});

const TEXT_MIME = Object.freeze({
  json: 'application/json', yaml: 'application/yaml', xml: 'application/xml',
  html: 'text/html', svg: 'image/svg+xml', css: 'text/css', javascript: 'text/javascript',
  csv: 'text/csv', markdown: 'text/markdown',
});

/**
 * The subtypes the *content* can prove on its own. Everything else stays a hint from the name,
 * because guessing "markdown" from a `#` character is how a log file gets the wrong label.
 */
function strongSubtype(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) return 'json';
  if (/^<\?xml\b/i.test(t)) return 'xml';
  if (/^<!doctype html[\s>]/i.test(t) || /^<html[\s>]/i.test(t)) return 'html';
  if (/^<svg[\s>]/i.test(t)) return 'svg';
  if (/^---\r?\n/.test(t) && /\n[A-Za-z_][\w.-]*:/.test(t)) return 'yaml';
  return null;
}

/** Decode a bounded buffer as UTF-8, honestly reporting lossy content instead of throwing. */
export function decodeText(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8', lossy: false };
  } catch {
    // control characters are replaced so a mixed-encoding log cannot smuggle escape sequences into
    // a terminal or a browser console
    const text = new TextDecoder('utf-8', { fatal: false }).decode(b).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '\uFFFD');
    const isLatin = /^[\x00-\xff]*$/.test(text);
    return { text, encoding: isLatin ? 'utf-8 (lossy)' : 'utf-8 (lossy)', lossy: true };
  }
}

/** How a preview may be shown: as text here, as an inline image, or only in a new tab. */
export function inlineMode(detected) {
  if (!detected) return null;
  if (detected.kind === 'text' || detected.kind === 'empty') return 'text';
  if (detected.kind === 'image') return 'image';
  if (detected.kind === 'pdf') return 'pdf';
  return null;
}

/** Whether a preview is refused, and with which code — the API turns this into a status. */
export function previewRefusal(detected, { size }) {
  if (size != null && size > LIMITS.maxPreviewFileSize) {
    return { code: 'too_large', reason: `This file is larger than ${Math.round(LIMITS.maxPreviewFileSize / 1024 / 1024)} MB; download it instead of previewing it.` };
  }
  if (detected?.kind === 'image' && size != null && size > LIMITS.maxInlineImageBytes) {
    return { code: 'too_large', reason: 'This image is too large to display inline; download it instead.' };
  }
  if (detected && !inlineMode(detected)) {
    return { code: 'unsupported_preview', reason: `${detected.label} cannot be previewed — it is not text, an image or a PDF. Download it instead.` };
  }
  return null;
}

export const _internals = Object.freeze({ MAGIC, EXT, EXT_OF, ACTIVE_SUBTYPES, SUBTYPE_LABELS, TEXT_MIME, strongSubtype });
