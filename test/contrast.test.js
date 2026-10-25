// The background contrast check (scripts/contrast.mjs) passes on the shipped styles, and it can fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.join(import.meta.dirname, '..');
const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/contrast.mjs'), ...args], { encoding: 'utf8' });

test('the shipped backgrounds keep every text colour above its floor', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const id of ['graphite', 'dusk', 'forest', 'ember', 'photo']) assert.match(r.stdout, new RegExp(`^${id}\\s`, 'm'), `${id} was not measured`);
});

test('the check fails when a tile gets too transparent, and when the photo scrim is too thin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-contrast-'));
  try {
    const tokens = fs.readFileSync(path.join(root, 'src/styles/tokens.css'), 'utf8');
    const weakTile = path.join(dir, 'tokens.css');
    fs.writeFileSync(weakTile, tokens.replace('--tile: rgba(19, 21, 25, 0.60);', '--tile: rgba(19, 21, 25, 0.10);'));
    const a = run('--tokens', weakTile);
    assert.equal(a.status, 1, 'a nearly clear tile passed');
    assert.match(a.stderr, /FAIL +.* on a tile/);

    const shell = fs.readFileSync(path.join(root, 'src/styles/shell.css'), 'utf8');
    const thin = path.join(dir, 'shell.css');
    fs.writeFileSync(thin, shell.replace('--scrim-top: .50; --scrim-bot: .62;', '--scrim-top: .05; --scrim-bot: .05;'));
    const b = run('--css', thin);
    assert.equal(b.status, 1, 'a thin photo scrim passed');
    assert.match(b.stderr, /FAIL +photo/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
