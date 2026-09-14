// Homepage compatibility, as a contract rather than a claim.
//
// OpusHub reads Homepage-shaped presentation files (services.yaml, stacks.yaml, bookmarks.yaml,
// layout.json, settings.yaml) and one rule decides whether that is safe:
//
//     Docker decides what EXISTS. Configuration decides how it is PRESENTED.
//
// The way to keep that true is not to be careful — it is to write configuration that tries to
// break it and assert that the inventory does not move. This file loads a deliberately hostile
// overlay: entries naming containers that do not exist, a stack for a project no container claims,
// a group nobody fills, a bookmark that looks like a service, a widget pointing at a ghost. Every
// assertion below is a count taken from the engine, not from the files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockEngine, FLEET } from './mock-engine.js';

const ENGINE = await startMockEngine();
process.env.OPUSHUB_DOCKER_SOCKET = ENGINE.socketPath;
delete process.env.DOCKER_HOST;
delete process.env.OPUSHUB_HOST_ADDRESS;

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-compat-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-compat-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

// Every file exists only to claim things Docker never said.
fs.writeFileSync(path.join(CONFIG_DIR, 'services.yaml'), `
groups:
  - name: Ghosts
    description: Nothing here is real
    icon: lucide:ghost
    order: 1
    services:
      - container: imaginary-app
        displayName: Imaginary
        description: no such container
        url: https://imaginary.example.org
      - name: also-imaginary
        displayName: Also Imaginary
        group: Ghosts
  - name: Empty Group
    description: declared, never filled
    order: 2
    services: []
`);
fs.writeFileSync(path.join(CONFIG_DIR, 'stacks.yaml'), `
stacks:
  - project: project-that-does-not-exist
    name: Phantom Stack
    description: no container carries this project label
  - id: another-ghost
    name: Another Ghost
`);
fs.writeFileSync(path.join(CONFIG_DIR, 'bookmarks.yaml'), `
groups:
  - name: Links
    items:
      - name: Not A Service
        href: https://example.org
        description: a link, never a row in the inventory
      - name: also-imaginary
        href: https://example.org/two
`);
// A layout that points at services which do not exist: widget instances are presentation, and a
// ghost reference must be ignored rather than rendered as an empty tile.
fs.writeFileSync(path.join(CONFIG_DIR, 'layout.json'), JSON.stringify({
  version: 2,
  hub: {
    zones: {
      main: [
        { id: 'w1', type: 'service-launcher', props: {} },
        { id: 'w2', type: 'services', props: { pick: ['imaginary-app', 'also-imaginary'] } },
        { id: 'w3', type: 'system', props: {} },
      ],
      rail: [],
    },
  },
}, null, 2));

const m = await import('../server/model.js');

test.after(async () => {
  await ENGINE.stop();
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const ALL = (doc) => [...doc.groups.flatMap((g) => g.services), ...doc.infrastructure];

test('a services.yaml entry with no container is reported, not rendered', async () => {
  await m.invalidateDiscovery();
  const doc = await m.getServicesView();
  const names = ALL(doc).map((s) => s.name);
  assert.ok(!names.includes('imaginary-app'), 'a configured service with no container became a service');
  assert.ok(!names.includes('also-imaginary'), 'a configured name with no container became a service');
  assert.ok(!ALL(doc).some((s) => s.url === 'https://imaginary.example.org'), 'a ghost kept its URL');

  // ...and the overlay is not silently swallowed: it is counted and named as unmatched
  const disc = await m.getDiscoveryStatus({ refreshMs: 0 });
  assert.ok(disc.overlays.unmatched >= 2, `unmatched overlays were not reported (${disc.overlays.unmatched})`);
  const reported = (disc.overlays.unmatchedList || []).map((u) => u.name || '');
  assert.ok(reported.some((n) => n.includes('imaginary')), 'the ghosts are not named in the report');
});

test('a group nothing fills does not appear, and an empty group is not a group', async () => {
  await m.invalidateDiscovery();
  const doc = await m.getServicesView();
  assert.ok(!doc.groups.some((g) => g.name === 'Ghosts'), 'a group with no containers was rendered');
  assert.ok(!doc.groups.some((g) => g.name === 'Empty Group'), 'an empty group was rendered');
  const flat = ALL(doc);
  assert.ok(flat.every((s) => s.group && s.group !== 'Ghosts'), 'a service was placed in a phantom group');
});

test('a stacks.yaml entry for a project no container claims is a stack that does not exist', async () => {
  await m.invalidateDiscovery();
  const doc = await m.getStacksDoc();
  assert.ok(!doc.stacks.some((s) => s.name === 'Phantom Stack'), 'a configured stack with no project became a stack');
  assert.ok(!doc.stacks.some((s) => s.name === 'Another Ghost'));
  const projects = new Set(FLEET.map((f) => f.Labels?.['com.docker.compose.project']).filter(Boolean));
  assert.equal(doc.stacks.length, projects.size, 'stacks are exactly the compose projects the engine reports');
});

test('every service maps to a container the engine reported — 1:1, no additions', async () => {
  await m.invalidateDiscovery();
  const doc = await m.getServicesView();
  const ids = ALL(doc).map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'a container appeared twice');
  const engineIds = new Set(FLEET.map((f) => f.Id.slice(0, 12)));
  for (const id of ids) assert.ok(engineIds.has(id), `service ${id} does not exist in the engine`);
  assert.equal(ALL(doc).length, FLEET.length, 'the inventory is exactly the fleet, whatever the files say');
  assert.equal(doc.stats.discovered, FLEET.length);
});

test('a bookmark is a link, and never becomes an inventory object', async () => {
  await m.invalidateDiscovery();
  const services = ALL(await m.getServicesView()).map((s) => s.name);
  const { flat } = m.readBookmarks();
  assert.ok(flat.length >= 1, 'the bookmark fixture did not load');
  for (const b of flat) {
    assert.ok(!services.includes(b.name), `bookmark “${b.name}” was rendered as a service`);
  }
});

test('a layout naming ghosts is presentation-only: it changes nothing about the inventory', async () => {
  await m.invalidateDiscovery();
  const before = ALL(await m.getServicesView()).map((s) => s.name).sort();
  const layout = m.getLayout();
  assert.ok(layout, 'the layout never loaded');
  // the file stays exactly as written — OpusHub does not "fix" it by inventing services
  const raw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'layout.json'), 'utf8'));
  assert.ok(JSON.stringify(raw).includes('imaginary-app'), 'the layout file was rewritten');
  const after = ALL(await m.getServicesView()).map((s) => s.name).sort();
  assert.deepEqual(after, before, 'reading a layout changed the inventory');
});

test('writing an overlay through the API cannot create a service either', async () => {
  await m.invalidateDiscovery();
  // the same shape the Settings editor writes: a new entry for a container that does not exist
  m.writeServices({
    groups: [
      { name: 'Ghosts', services: [{ container: 'imaginary-app', displayName: 'Imaginary' }] },
    ],
  });
  await m.invalidateDiscovery();
  const doc = await m.getServicesView();
  assert.ok(!ALL(doc).some((s) => s.name === 'imaginary-app'), 'a write invented a service');
  assert.equal(ALL(doc).length, FLEET.length);
  // and removing every overlay still leaves the (real) inventory intact
  m.writeServices({ groups: [] });
  await m.invalidateDiscovery();
  const bare = await m.getServicesView();
  assert.equal(ALL(bare).length, FLEET.length, 'removing configuration removed services');
  assert.ok(ALL(bare).every((s) => s.displayName), 'every container still presents a name without an overlay');
});
