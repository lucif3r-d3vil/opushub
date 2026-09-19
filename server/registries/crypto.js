// Secrets at rest — AES-256-GCM with a per-installation key.
//
// The key comes from OPUSHUB_SECRET_KEY (base64/hex, ≥32 bytes) when set, otherwise from
// DATA_DIR/registries/key, created on first use with mode 0600. Every ciphertext carries its
// own 12-byte IV and 16-byte tag: `v1:<iv b64url>:<tag b64url>:<ciphertext b64url>`. A
// registry id is bound in as additional authenticated data, so a ciphertext copied from one
// entry to another does not decrypt.
//
// Nothing here logs. Nothing here returns the key. A missing or unreadable key is an error the
// caller reports as "credentials unavailable" — never as an empty password.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../configStore.js';

const DIR = path.join(DATA_DIR, 'registries');
const KEY_FILE = path.join(DIR, 'key');
let cachedKey = null;

function keyFromEnv() {
  const raw = process.env.OPUSHUB_SECRET_KEY;
  if (!raw) return null;
  let buf = null;
  if (/^[0-9a-f]{64,}$/i.test(raw)) buf = Buffer.from(raw, 'hex');
  else { try { buf = Buffer.from(raw, 'base64'); } catch { buf = null; } }
  if (!buf || buf.length < 32) throw new Error('OPUSHUB_SECRET_KEY must be at least 32 bytes (hex or base64).');
  return crypto.createHash('sha256').update(buf).digest();
}

function loadKey() {
  if (cachedKey) return cachedKey;
  const env = keyFromEnv();
  if (env) { cachedKey = env; return cachedKey; }
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(KEY_FILE)) {
    const st = fs.statSync(KEY_FILE);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* reported below if still open */ }
    }
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) throw new Error('The registry key file is corrupt.');
    cachedKey = buf;
    return cachedKey;
  }
  const key = crypto.randomBytes(32);
  const tmp = `${KEY_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, key.toString('base64') + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, KEY_FILE);
  cachedKey = key;
  return cachedKey;
}

const b64u = (b) => Buffer.from(b).toString('base64url');

/** Encrypt a UTF-8 string. `aad` (e.g. the registry id) must be supplied identically to decrypt. */
export function encrypt(plaintext, aad = '') {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1:${b64u(iv)}:${b64u(cipher.getAuthTag())}:${b64u(ct)}`;
}

/** Decrypt; throws on tamper, wrong key or wrong aad. */
export function decrypt(token, aad = '') {
  const key = loadKey();
  const parts = String(token || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Not a sealed value.');
  const [, iv, tag, ct] = parts.map((p, i) => (i === 0 ? p : Buffer.from(p, 'base64url')));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** True when the key is usable (exists or can be created). Never returns the key. */
export function keyAvailable() {
  try { loadKey(); return { ok: true, source: keyFromEnv() ? 'env' : 'file' }; } catch (err) { return { ok: false, reason: String(err?.message || err) }; }
}

export function _resetCryptoCache() { cachedKey = null; }
export const _internals = Object.freeze({ KEY_FILE, DIR });
