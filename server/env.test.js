// env.js tests — discovery order, precedence, and .env parsing edge cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv, loadEnv, resolveConfigDir, APP_ROOT } from './env.js';

test('parseEnv handles quotes, export, comments, and inline comments', () => {
  const out = parseEnv([
    '# comment',
    'PLAIN=abc',
    'QUOTED="hello world"',
    "SINGLE='it works'",
    'export WITH_EXPORT=1',
    'ESCAPED="a\\nb"',
    'TRAILING=value # inline note',
    'EMPTY=',
    'not a kv line',
    'SPACED = spaced-out ',
  ].join('\n'));
  assert.equal(out.PLAIN, 'abc');
  assert.equal(out.QUOTED, 'hello world');
  assert.equal(out.SINGLE, 'it works');
  assert.equal(out.WITH_EXPORT, '1');
  assert.equal(out.ESCAPED, 'a\nb');
  assert.equal(out.TRAILING, 'value');
  assert.equal(out.EMPTY, '');
  assert.equal(out.SPACED, 'spaced-out');
  assert.ok(!('not a kv line' in out));
});

test('loadEnv: first hit wins per key; real env always beats files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-env-'));
  const first = path.join(dir, 'first.env');
  const second = path.join(dir, 'second.env');
  fs.writeFileSync(first, 'SHARED=from-first\nONLY_FIRST=yes\n');
  fs.writeFileSync(second, 'SHARED=from-second\nONLY_SECOND=yes\n');
  const OLD = { ...process.env };
  try {
    process.env.OPUSHUB_ENV_FILE = first;
    process.env.SHARED = 'from-process'; // real env beats both files
    const report = loadEnv(dir); // dir/.env does not exist; second.env is NOT a candidate
    assert.equal(process.env.SHARED, 'from-process');
    assert.equal(process.env.ONLY_FIRST, 'yes');
    assert.equal(process.env.ONLY_SECOND, undefined);
    assert.ok(report.tried.includes(first));
    assert.ok(report.loaded.some((f) => f.file === first && f.keys.includes('SHARED')));
    // loaded report carries names only — never values
    assert.ok(!JSON.stringify(report).includes('from-first'));
  } finally {
    process.env = OLD;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadEnv: config/.env is found next to the config dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-env-'));
  fs.writeFileSync(path.join(dir, '.env'), 'OPUSHUB_PHASE2_TEST_KEY=1\n');
  const OLD = { ...process.env };
  try {
    delete process.env.OPUSHUB_ENV_FILE;
    delete process.env.OPUSHUB_PHASE2_TEST_KEY;
    delete process.env.HOMEPAGE_DIR;
    const report = loadEnv(dir);
    assert.equal(process.env.OPUSHUB_PHASE2_TEST_KEY, '1');
    assert.ok(report.loaded.some((f) => f.file === path.join(dir, '.env')));
  } finally {
    process.env = OLD;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveConfigDir prefers OPUSHUB_CONFIG_DIR, falls back to app config', () => {
  const OLD = { ...process.env };
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-cfg-'));
    process.env.OPUSHUB_CONFIG_DIR = dir;
    assert.equal(resolveConfigDir().dir, dir);
    delete process.env.OPUSHUB_CONFIG_DIR;
    assert.equal(resolveConfigDir().dir, path.join(APP_ROOT, 'config'));
  } finally {
    process.env = OLD;
  }
});
