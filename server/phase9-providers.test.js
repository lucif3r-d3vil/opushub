// Phase 9A — the provider registry: registration, independence, capabilities, caching and the
// honest status vocabulary. Every provider here is a stub, because this file is about the
// contract, not about any one provider's data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9prov-cfg-'));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opushub-p9prov-data-'));
process.env.OPUSHUB_CONFIG_DIR = CONFIG_DIR;
process.env.OPUSHUB_DATA_DIR = DATA_DIR;

const registry = await import('./infrastructure/registry.js');

function stub(id, { status = 'available', capabilities = [], error = null, data = null, throws = false } = {}) {
  return {
    id, type: 'storage', name: id, domain: 'storage', optional: true,
    capabilities, ttlMs: 60_000,
    check: async () => {
      if (throws) throw new Error('boom: /some/host/path EACCES');
      return { status, capabilities, version: null, error, data };
    },
  };
}

test.after(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test.beforeEach(() => registry._resetProviders());

test('a provider is registered once, and registration is what makes it exist', () => {
  assert.equal(registry.providerIds().length, 0);
  registry.registerProvider(stub('alpha', { capabilities: ['pools'] }));
  registry.registerProvider(stub('beta', { capabilities: ['datasets'] }));
  assert.deepEqual(registry.providerIds(), ['alpha', 'beta']);
  assert.equal(registry.isKnownProvider('alpha'), true);
  assert.equal(registry.isKnownProvider('nope'), false);
  // ids are unique: a second registration is a programming error, not an override
  assert.throws(() => registry.registerProvider(stub('alpha')), /already registered/);
  // and a provider cannot be registered without the two things that define it
  assert.throws(() => registry.registerProvider({ id: 'x', type: 'not-a-type' }), /unknown type/);
  assert.throws(() => registry.registerProvider({ id: 'x', type: 'storage' }), /no check/);
});

test('an unavailable provider is reported, not propagated', async () => {
  registry.registerProvider(stub('broken', { throws: true }));
  const [doc] = await registry.describeProviders();
  assert.equal(doc.status, 'unavailable');
  assert.equal(doc.error.code, 'provider_error');
  // the reason is a public sentence: a thrown error's own text (which can carry paths) is not
  assert.equal(doc.error.reason, 'The provider did not answer.');
  assert.ok(!JSON.stringify(doc).includes('/some/host/path'));
  assert.ok(!JSON.stringify(doc).includes('EACCES'));
});

test('every status in the vocabulary survives the round trip, and no other does', async () => {
  const statuses = ['connected', 'available', 'degraded', 'unavailable', 'not-configured', 'unknown'];
  for (const status of statuses) {
    registry._resetProviders();
    registry.registerProvider(stub('p', { status }));
    const [doc] = await registry.describeProviders();
    assert.equal(doc.status, status, status);
    assert.ok(doc.statusLabel && doc.statusLabel.length, `${status} needs a label`);
  }
  registry._resetProviders();
  registry.registerProvider(stub('p', { status: 'sort-of-fine' }));
  const [doc] = await registry.describeProviders();
  assert.equal(doc.status, 'unavailable', 'an unknown status word is never passed through');
});

test('capabilities are declared, and only declared capabilities can be reported active', async () => {
  registry.registerProvider(stub('p', {
    status: 'available',
    capabilities: ['pools', 'datasets'],
  }));
  const declared = registry.getProvider('p').capabilities;
  assert.deepEqual([...declared], ['pools', 'datasets']);
  assert.ok(Object.isFrozen(declared), 'the declared capability list is frozen');
  const [doc] = await registry.describeProviders();
  assert.deepEqual(doc.active, ['pools', 'datasets']);

  registry._resetProviders();
  registry.registerProvider({
    id: 'smuggler', type: 'storage', name: 'smuggler', domain: 'storage', optional: true,
    capabilities: ['pools'], ttlMs: 1000,
    check: async () => ({ status: 'available', capabilities: ['pools', 'scrub', 'destroy'] }),
  });
  const [smuggled] = await registry.describeProviders();
  assert.deepEqual(smuggled.active, ['pools'], 'a provider cannot grant itself a capability');
});

test('one in-flight check per provider, and a TTL cache behind it', async () => {
  let runs = 0;
  registry.registerProvider({
    id: 'slow', type: 'storage', name: 'slow', domain: 'storage', optional: true,
    capabilities: [], ttlMs: 60_000,
    check: async () => { runs += 1; await new Promise((r) => setTimeout(r, 20)); return { status: 'available' }; },
  });
  // five callers at once — one provider, one run
  await Promise.all(Array.from({ length: 5 }, () => registry.checkProvider('slow')));
  assert.equal(runs, 1, 'single-flight: concurrent callers share one run');
  await registry.checkProvider('slow');
  assert.equal(runs, 1, 'the cached answer is reused inside the TTL');
  await registry.checkProvider('slow', { force: true });
  assert.equal(runs, 2, 'force re-checks (used by an explicit refresh, never by a poll)');
});

test('one provider failing cannot change another provider’s answer', async () => {
  registry.registerProvider(stub('good', { status: 'available', capabilities: ['pools'] }));
  registry.registerProvider(stub('bad', { throws: true }));
  const docs = await registry.describeProviders();
  const byId = Object.fromEntries(docs.map((d) => [d.id, d]));
  assert.equal(byId.good.status, 'available');
  assert.equal(byId.bad.status, 'unavailable');
  assert.equal(docs.length, 2, 'a broken provider is still listed, with an honest status');
});

test('the status document is what crosses the API boundary — and nothing else', async () => {
  registry.registerProvider(stub('p', { status: 'available', capabilities: ['pools'], data: { pools: [{ name: 'tank' }], secret: 'hunter2' } }));
  await registry.checkProvider('p');
  const doc = registry.providerStatusDoc('p');
  assert.deepEqual(Object.keys(doc).sort(), [
    'active', 'capabilities', 'description', 'domain', 'error', 'id', 'lastChecked', 'name',
    'optional', 'planned', 'status', 'statusLabel', 'type', 'version',
  ]);
  assert.ok(!JSON.stringify(doc).includes('tank'), 'domain data is not part of the status document');
  assert.ok(!JSON.stringify(doc).includes('hunter2'));
  // data stays on the server, reachable only by an assembler
  assert.equal(registry.cachedData('p').pools[0].name, 'tank');
});

test('an unknown provider id is never checked and never invented', async () => {
  const result = await registry.checkProvider('does-not-exist');
  assert.equal(result.status, 'unknown');
  assert.equal(registry.providerStatusDoc('does-not-exist'), null);
  const docs = await registry.describeProviders({ ids: ['does-not-exist'] });
  assert.deepEqual(docs, []);
});

test('provider state transitions are recorded once, and "not configured" is not an event', async () => {
  const { readEvents } = await import('./activity.js');
  const before = readEvents({ limit: 500 }).items.filter((e) => e.type.startsWith('provider.'));
  registry.registerProvider(stub('flap', { status: 'available' }));
  registry.noteProviderStates(await registry.describeProviders());   // first observation
  registry._resetProviders();
  registry.registerProvider(stub('flap', { status: 'unavailable', error: { code: 'unreachable', reason: 'gone away' } }));
  registry.noteProviderStates(await registry.describeProviders());   // a real change
  registry._resetProviders();
  registry.registerProvider(stub('flap', { status: 'not-configured' }));
  registry.noteProviderStates(await registry.describeProviders());   // absence, not a fault
  const events = readEvents({ limit: 500 }).items
    .filter((e) => e.type.startsWith('provider.') && e.meta?.provider === 'flap');
  assert.equal(events.length, 1, `one event, not three: ${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(events[0].type, 'provider.disconnected');
  assert.equal(events[0].category, 'provider');
  assert.ok(events.length >= before.length);
});

test('the registry refuses an error reason that is not a public sentence', async () => {
  registry.registerProvider(stub('p', {
    status: 'unavailable',
    error: { code: 'definitely-not-a-known-code', reason: 'x'.repeat(500) },
  }));
  const [doc] = await registry.describeProviders();
  assert.equal(doc.error.code, 'provider_error', 'an unknown error code is normalized');
  assert.equal(doc.error.reason.length, 300, 'reasons are bounded');
});
