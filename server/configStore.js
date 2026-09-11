// Atomic config store. YAML documents are rewritten through the `yaml` Document API so
// user comments and key order survive OpusHub's edits. JSON (layout) is rewritten wholesale.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { resolveConfigDir, resolveDataDir, APP_ROOT } from './env.js';

const { dir: CONFIG_DIR, created } = resolveConfigDir();
const DATA_DIR = resolveDataDir();
if (created) fs.mkdirSync(path.join(CONFIG_DIR, 'icons'), { recursive: true });
fs.mkdirSync(path.join(CONFIG_DIR, 'backgrounds'), { recursive: true });

export { CONFIG_DIR, DATA_DIR, APP_ROOT };

const YAML_FILES = new Set(['services.yaml', 'stacks.yaml', 'settings.yaml', 'bookmarks.yaml']);
const JSON_FILES = new Set(['layout.json']);
const TEXT_FILES = new Set(['theme.css', 'app.js']);

function assertName(name) {
  if (!YAML_FILES.has(name) && !JSON_FILES.has(name) && !TEXT_FILES.has(name)) {
    throw Object.assign(new Error(`config file not editable: ${name}`), { status: 400 });
  }
  return path.join(CONFIG_DIR, name);
}

export function readConfigText(name) {
  const file = assertName(name);
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

export function readYaml(name) {
  const text = readConfigText(name);
  if (text == null) return null;
  try {
    return YAML.parse(text);
  } catch (err) {
    throw Object.assign(new Error(`${name}: YAML parse error — ${err.message}`), { status: 500 });
  }
}

function deepMergeJson(base, patch) {
  if (patch == null) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof patch !== 'object' || Array.isArray(patch)) {
    return structuredClone(patch);
  }
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(patch)) out[k] = deepMergeJson(out[k], v);
  return out;
}

export function readJson(name, fallback) {
  const text = readConfigText(name);
  if (text == null) return structuredClone(fallback);
  try {
    return deepMergeJson(fallback, JSON.parse(text));
  } catch {
    return structuredClone(fallback);
  }
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// Homepage-style files carry a leading explanatory comment block. A fresh Document loses it, so
// we lift the existing header off the current file and re-attach it. Everything below the header
// is rewritten from the model — the header is documentation, not data.
export function headerOf(name) {
  const text = readConfigText(name);
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const head = [];
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') head.push(line);
    else break;
  }
  while (head.length && head[head.length - 1].trim() === '') head.pop();
  return head.length ? head.join('\n') + '\n\n' : '';
}

/** Rewrite a YAML config file with a freshly serialized document (header comment preserved). */
export function writeYaml(name, value, { header = null } = {}) {
  const file = assertName(name);
  if (!YAML_FILES.has(name)) throw Object.assign(new Error(`not a yaml file: ${name}`), { status: 400 });
  const doc = new YAML.Document(value);
  const body = String(doc).replace(/\n{3,}/g, '\n\n');
  atomicWrite(file, (header ?? headerOf(name)) + body);
  return { file };
}

/** Edit YAML while preserving comments: mutate a live Document, then serialize. */
export function editYaml(name, mutate, fallbackValue = {}) {
  const file = assertName(name);
  let doc;
  const text = readConfigText(name);
  doc = YAML.parseDocument(text ?? '', { keepSourceTokens: true });
  if (doc.isEmpty && fallbackValue != null) doc.setSchemaProps?.(null);
  mutate(doc, fallbackValue);
  atomicWrite(file, String(doc));
  return doc.toJS();
}

export function writeJson(name, value) {
  const file = assertName(name);
  if (!JSON_FILES.has(name)) throw Object.assign(new Error(`not a json file: ${name}`), { status: 400 });
  atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
  return { file };
}

export function writeText(name, text) {
  const file = assertName(name);
  if (!TEXT_FILES.has(name)) throw Object.assign(new Error(`not an editable text file: ${name}`), { status: 400 });
  if (text.length > 512_000) throw Object.assign(new Error('file too large (512 KB cap)'), { status: 413 });
  atomicWrite(file, text);
  return { file };
}

export function configFile(name) { return assertName(name); }
