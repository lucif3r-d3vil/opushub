// Standing security proofs, read from the source.
//
// Static assertions over server code that must keep holding whatever feature work happens around
// them: the Docker write surface is exactly the frozen operation set, the read client cannot write,
// and adding a state-changing route to api.js is a deliberate change to a reviewed list rather
// than a side effect. (These lived in phase9-security.test.js until the infrastructure area was
// removed; its provider-specific proofs went with it.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from '../test/source-scan.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped — assertions are about code, not the prose around it. */
const code = (rel) => stripComments(read(rel));

test('the Docker operation allow-list is exactly the frozen set proved in phase8-proof', async () => {
  // The set is documented and frozen in server/phase8-proof.test.js. This test asserts the registry
  // and the lifecycle adapter match that ONE list.
  const { APPROVED_ACTIONS, APPROVED_LIFECYCLE_ENDPOINTS } = await import('../test/approved-operations.js');
  const registry = await import('./operations/registry.js');
  assert.deepEqual(Object.keys(registry.ACTIONS), [...APPROVED_ACTIONS]);
  const adapter = code('server/providers/dockerOperations.js');
  const table = adapter.match(/const OP_PATHS = Object\.freeze\(\{([\s\S]*?)\}\);/);
  const declared = [...table[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(declared.sort(), [...APPROVED_LIFECYCLE_ENDPOINTS].sort());
});

test('the Docker read provider is still GET-only', () => {
  const src = code('server/providers/docker.js');
  assert.ok(src.includes('http.get'), 'the read client still issues http.get');
  for (const banned of ['http.request(', 'method:', '.post(', '.put(', '.patch(']) {
    assert.ok(!src.includes(banned), `the read client contains ${banned}`);
  }
});

test('the source scanner these proofs read with does not delete code', () => {
  // A static proof is only as good as the text it reads. api.js documents its versioned namespace
  // with a line comment containing `/api/v1/*`, and the naive block-comment strip treats that `/*`
  // as the start of a comment and deletes everything up to the next `*/` — 30% of the file,
  // including the setup, auth, settings and layout routes. That version of this assertion passed
  // while looking at a file with those routes missing, which is worse than having no assertion.
  const raw = read('server/api.js');
  const stripped = code('server/api.js');
  const routes = (s) => [...s.matchAll(/route === '(POST|PUT|PATCH|DELETE) ([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`).sort();
  assert.deepEqual(routes(stripped), routes(raw), 'comment stripping removed a route from the source');
  assert.ok(!stripped.includes('/*'), 'a block comment survived the stripper');
  assert.ok(stripped.length < raw.length && stripped.length > raw.length * 0.5,
    'the stripper removed an implausible amount of the file');
  // it must not invent code either: everything it reports is present in the file as written
  for (const r of routes(stripped)) assert.ok(raw.includes(`'${r}'`), `${r} does not appear in api.js`);
});

test('the set of non-GET routes in api.js is exactly the reviewed list', () => {
  const src = code('server/api.js');
  const mutations = [...src.matchAll(/route === '(POST|PUT|PATCH|DELETE) ([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`).sort();
  // the complete list of state-changing application routes — reviewed, audited and
  // CSRF-protected. Adding one is a deliberate change to this list, not a side effect of a feature.
  assert.deepEqual(mutations, [
    'POST /api/alerts/ack',
    'POST /api/auth/login',
    'POST /api/auth/logout',
    'POST /api/auth/password',
    'POST /api/auth/sessions/revoke',
    'POST /api/config/import/apply',
    'POST /api/config/import/parse',
    'POST /api/config/validate',
    'POST /api/custom/reset',
    'POST /api/discovery/refresh',
    'POST /api/layout/reset',
    'POST /api/layout/template',
    'POST /api/setup',
    'POST /api/updates/check',
    'PUT /api/bookmarks',
    'PUT /api/custom',
    'PUT /api/groups',
    'PUT /api/layout',
    'PUT /api/services',
    'PUT /api/settings',
    'PUT /api/stacks',
  ], 'a new state-changing route appeared in api.js');
});
