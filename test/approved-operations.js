// The frozen operation sets — the complete list of things OpusHub may DO to the engine.
//
// Every mechanical proof (server/phase8-proof.test.js, server/phase9-security.test.js,
// server/phase10d-*.test.js) asserts the live registry and adapters against THESE lists. Adding a
// line here is the reviewed act of adding a capability; nothing not listed here can execute.
//
// Phase 8 shipped the first three container actions. Phase 10D (the Docker control plane) added
// the rest of the controlled container lifecycle, stacks, image pulls and catalog installs.
// Still deliberately absent: exec, attach, prune, commit, copy, arbitrary compose commands, shell.

/** The frozen action set. Adding to it is a reviewed change to this file. */
export const APPROVED_ACTIONS = Object.freeze([
  'container.start', 'container.restart', 'container.stop',
  'container.pause', 'container.unpause', 'container.kill',
  'container.rename', 'container.pull_image', 'container.network_attach', 'container.network_detach',
  'container.update', 'container.recreate', 'container.edit', 'container.change_image',
  'container.duplicate', 'container.create', 'container.remove',
  'stack.deploy', 'stack.start', 'stack.stop', 'stack.remove',
  'image.pull', 'service.install',
]);
export const APPROVED_PERMISSIONS = Object.freeze([
  'operations.container.start', 'operations.container.restart', 'operations.container.stop',
  'operations.container.pause', 'operations.container.kill', 'operations.container.configure',
  'operations.image.pull', 'operations.container.recreate', 'operations.container.create',
  'operations.container.remove', 'operations.stack.deploy', 'operations.stack.remove',
]);
/** The lifecycle adapter's endpoint table (providers/dockerOperations.js). */
export const APPROVED_LIFECYCLE_ENDPOINTS = Object.freeze([
  ['start', '/start'], ['stop', '/stop'], ['restart', '/restart'], ['pause', '/pause'], ['unpause', '/unpause'], ['kill', '/kill'],
]);
/** The control adapter's endpoint table (updates/recreateAdapter.js). */
export const APPROVED_CONTROL_ENDPOINTS = Object.freeze([
  'pull', 'inspect', 'stop', 'rename', 'create', 'start', 'remove', 'update',
  'networkConnect', 'networkDisconnect', 'networkCreate', 'networkRemove', 'volumeCreate',
]);

