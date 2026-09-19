// The Operations action registry — the single, exhaustive list of things OpusHub is allowed to
// DO to the infrastructure (as opposed to the many things it is allowed to say about it).
//
// Everything here is metadata. No registry field is ever used to build a Docker path, choose an
// HTTP method or call a function by name: the adapter call is a static `switch` in engine.js, so
// a registry entry cannot smuggle a new capability in, and a new capability cannot appear without
// a new case in that switch.
//
// Adding an action is therefore a five-part, reviewable change:
//   1. an entry here (metadata + risk + confirmation + timeouts + parameter kind)
//   2. an explicit adapter method (providers/dockerOperations.js or updates/recreateAdapter.js)
//      or a transactional runner (containers/runners.js, stacks/deployer.js, catalog/installer.js)
//   3. a case in the engine's static dispatch switch
//   4. a parameter schema in operations/params.js when the action takes input
//   5. tests — including the mechanical proof that the action and endpoint sets are unchanged
//
// Phase 8 shipped three lifecycle actions. Phase 10D (a Docker control plane) adds the rest of
// the controlled container lifecycle, stack deployment and catalog installation. What is still
// deliberately NOT here: exec, attach, logs-follow as a mutation, image/volume/network removal
// outside a stack's own resources, prune, commit, copy, arbitrary compose commands, arbitrary
// shell. See docs/16-phase-10d.md.

/**
 * A timeout the operator may tune, clamped so it can only ever be a timeout: never zero
 * (an unbounded operation), never absurd (a request that outlives the browser's patience).
 */
function envMs(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.max(500, Math.min(120_000, v)) : fallback;
}

/** Risk levels, used only for confirmation strength and UI emphasis — never for authorization. */
export const RISKS = ['low', 'medium', 'high'];

/** Confirmation strength. `none` is not used by any shipped action. */
export const CONFIRMATIONS = ['none', 'normal', 'strong'];

/**
 * The registry. Frozen: no runtime mutation, and no way to reach a Docker operation that is
 * not one of these three ids.
 */
export const ACTIONS = Object.freeze({
  'container.start': Object.freeze({
    id: 'container.start',
    targetType: 'container',
    permission: 'operations.container.start',
    confirmation: 'normal',
    risk: 'low',
    // words, so the UI never has to assemble sentences from a verb and a guess
    verb: 'start',
    progressive: 'Starting',
    past: 'started',
    imperative: 'Start',
    consequence: null,
    // bounded: the Docker call itself, and how long we will wait for the state to be reached
    timeoutMs: envMs('OPUSHUB_OP_START_TIMEOUT_MS', 10_000),
    verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 15_000),
    // what "it worked" means — checked against a fresh inspect, not against the 204
    expect: 'running',
    auditCategory: 'service',
    // which adapter method this maps to — read by the engine's static switch only
    adapter: 'start',
    // Container states in which offering this action makes sense. This is *presentation*: it
    // decides what the UI offers, never what it may do — the engine re-checks the state itself.
    offerWhen: Object.freeze(['exited', 'created', 'dead']),
    summary: 'Start a stopped container.',
    // which parameter schema (operations/params.js) the request may carry; `none` = nothing
    params: 'none',
    // how the engine runs it: `lifecycle` (one POST, state verified), `control` (one enumerated
    // control call), `transaction` (a multi-step recreate/deploy with rollback)
    executor: 'lifecycle',
  }),
  'container.restart': Object.freeze({
    id: 'container.restart',
    targetType: 'container',
    permission: 'operations.container.restart',
    confirmation: 'normal',
    risk: 'medium',
    verb: 'restart',
    progressive: 'Restarting',
    past: 'restarted',
    imperative: 'Restart',
    consequence: 'The service will be unavailable for a moment while the container restarts.',
    timeoutMs: envMs('OPUSHUB_OP_RESTART_TIMEOUT_MS', 25_000),
    verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 20_000),
    expect: 'running',
    auditCategory: 'service',
    adapter: 'restart',
    offerWhen: Object.freeze(['running']),
    summary: 'Restart a running container.',
    params: 'none',
    executor: 'lifecycle',
  }),
  'container.stop': Object.freeze({
    id: 'container.stop',
    targetType: 'container',
    permission: 'operations.container.stop',
    confirmation: 'strong',
    risk: 'high',
    verb: 'stop',
    progressive: 'Stopping',
    past: 'stopped',
    imperative: 'Stop',
    consequence: 'The service will be unavailable until it is started again.',
    timeoutMs: envMs('OPUSHUB_OP_STOP_TIMEOUT_MS', 15_000),
    verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 15_000),
    expect: 'exited',
    auditCategory: 'service',
    adapter: 'stop',
    offerWhen: Object.freeze(['running']),
    summary: 'Stop a running container. It stays stopped until you start it again.',
    params: 'none',
    executor: 'lifecycle',
  }),

  /* ---------------- Phase 10D-A: the rest of the container lifecycle ---------------- */

  'container.pause': Object.freeze({
    id: 'container.pause', targetType: 'container', permission: 'operations.container.pause',
    confirmation: 'normal', risk: 'medium',
    verb: 'pause', progressive: 'Pausing', past: 'paused', imperative: 'Pause',
    consequence: 'Every process in the container is frozen until it is unpaused. Connections will hang.',
    timeoutMs: envMs('OPUSHUB_OP_PAUSE_TIMEOUT_MS', 10_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 10_000),
    expect: 'paused', auditCategory: 'service', adapter: 'pause', offerWhen: Object.freeze(['running']),
    summary: 'Freeze a running container without stopping it.', params: 'none', executor: 'lifecycle',
  }),
  'container.unpause': Object.freeze({
    id: 'container.unpause', targetType: 'container', permission: 'operations.container.pause',
    confirmation: 'normal', risk: 'low',
    verb: 'unpause', progressive: 'Unpausing', past: 'unpaused', imperative: 'Unpause',
    consequence: null,
    timeoutMs: envMs('OPUSHUB_OP_PAUSE_TIMEOUT_MS', 10_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 10_000),
    expect: 'running', auditCategory: 'service', adapter: 'unpause', offerWhen: Object.freeze(['paused']),
    summary: 'Resume a paused container.', params: 'none', executor: 'lifecycle',
  }),
  'container.kill': Object.freeze({
    id: 'container.kill', targetType: 'container', permission: 'operations.container.kill',
    confirmation: 'strong', risk: 'high',
    verb: 'kill', progressive: 'Killing', past: 'killed', imperative: 'Kill',
    consequence: 'The main process is terminated immediately (SIGKILL) with no chance to flush or shut down cleanly. Data the application had not written yet may be lost.',
    timeoutMs: envMs('OPUSHUB_OP_KILL_TIMEOUT_MS', 10_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 10_000),
    expect: 'exited', auditCategory: 'service', adapter: 'kill', offerWhen: Object.freeze(['running', 'paused', 'restarting']),
    summary: 'Terminate a container immediately. Use when stop does not work.', params: 'none', executor: 'lifecycle',
  }),
  'container.rename': Object.freeze({
    id: 'container.rename', targetType: 'container', permission: 'operations.container.configure',
    confirmation: 'normal', risk: 'medium',
    verb: 'rename', progressive: 'Renaming', past: 'renamed', imperative: 'Rename',
    consequence: 'Anything that addresses this container by name (compose, links, reverse-proxy rules, monitors) will need updating.',
    timeoutMs: envMs('OPUSHUB_OP_CONTROL_TIMEOUT_MS', 15_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 10_000),
    expect: 'same', auditCategory: 'service', adapter: 'rename', offerWhen: Object.freeze(['running', 'exited', 'created', 'paused', 'dead']),
    summary: 'Give a container a new name.', params: 'rename', executor: 'control',
  }),
  'container.pull_image': Object.freeze({
    id: 'container.pull_image', targetType: 'container', permission: 'operations.image.pull',
    confirmation: 'normal', risk: 'low',
    verb: 'pull', progressive: 'Pulling', past: 'pulled', imperative: 'Pull image for',
    consequence: 'The image the container was created from is pulled again. The running container is not changed — recreate it to use the new image.',
    timeoutMs: envMs('OPUSHUB_OP_PULL_TIMEOUT_MS', 120_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 5_000),
    expect: 'same', auditCategory: 'docker', adapter: 'pull', offerWhen: Object.freeze(['running', 'exited', 'created', 'paused', 'dead']),
    summary: "Pull the container's image from its registry.", params: 'none', executor: 'control',
  }),
  'container.network_attach': Object.freeze({
    id: 'container.network_attach', targetType: 'container', permission: 'operations.container.configure',
    confirmation: 'normal', risk: 'medium',
    verb: 'attach', progressive: 'Attaching', past: 'attached', imperative: 'Attach network to',
    consequence: 'The container gains an interface on the chosen network.',
    timeoutMs: envMs('OPUSHUB_OP_CONTROL_TIMEOUT_MS', 15_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 10_000),
    expect: 'same', auditCategory: 'service', adapter: 'network_attach', offerWhen: Object.freeze(['running', 'exited', 'created', 'paused']),
    summary: 'Connect a container to an existing Docker network.', params: 'network', executor: 'control',
  }),
  'container.network_detach': Object.freeze({
    id: 'container.network_detach', targetType: 'container', permission: 'operations.container.configure',
    confirmation: 'strong', risk: 'high',
    verb: 'detach', progressive: 'Detaching', past: 'detached', imperative: 'Detach network from',
    consequence: 'The container loses its interface on that network. Anything reaching it through that network will fail.',
    timeoutMs: envMs('OPUSHUB_OP_CONTROL_TIMEOUT_MS', 15_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 10_000),
    expect: 'same', auditCategory: 'service', adapter: 'network_detach', offerWhen: Object.freeze(['running', 'exited', 'created', 'paused']),
    summary: 'Disconnect a container from a Docker network.', params: 'network', executor: 'control',
  }),
  'container.update': Object.freeze({
    id: 'container.update', targetType: 'container', permission: 'operations.container.configure',
    confirmation: 'normal', risk: 'medium',
    verb: 'update', progressive: 'Updating', past: 'updated', imperative: 'Update',
    consequence: 'Restart policy and resource limits are changed in place; the container keeps running.',
    timeoutMs: envMs('OPUSHUB_OP_CONTROL_TIMEOUT_MS', 20_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 10_000),
    expect: 'same', auditCategory: 'service', adapter: 'update', offerWhen: Object.freeze(['running', 'exited', 'created', 'paused']),
    summary: 'Change restart policy or resource limits without recreating.', params: 'spec_patch', executor: 'control',
  }),
  'container.recreate': Object.freeze({
    id: 'container.recreate', targetType: 'container', permission: 'operations.container.recreate',
    confirmation: 'strong', risk: 'high',
    verb: 'recreate', progressive: 'Recreating', past: 'recreated', imperative: 'Recreate',
    consequence: 'The container is replaced by a fresh one with the same configuration and image. The service is briefly unavailable; the container filesystem is reset, volumes are kept.',
    timeoutMs: envMs('OPUSHUB_OP_TX_TIMEOUT_MS', 90_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 15_000),
    expect: 'replaced', auditCategory: 'service', adapter: 'recreate', offerWhen: Object.freeze(['running', 'exited', 'created', 'paused', 'dead']),
    summary: 'Replace the container with a new one built from the same configuration.', params: 'none', executor: 'transaction',
  }),
  'container.edit': Object.freeze({
    id: 'container.edit', targetType: 'container', permission: 'operations.container.configure',
    confirmation: 'strong', risk: 'high',
    verb: 'edit', progressive: 'Applying changes to', past: 'reconfigured', imperative: 'Apply changes to',
    consequence: 'Changes that Docker cannot apply in place recreate the container: it is briefly unavailable and its container filesystem is reset. Volumes are kept.',
    timeoutMs: envMs('OPUSHUB_OP_TX_TIMEOUT_MS', 90_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 15_000),
    expect: 'replaced', auditCategory: 'service', adapter: 'edit', offerWhen: Object.freeze(['running', 'exited', 'created', 'paused', 'dead']),
    summary: 'Change the container configuration (shown as a diff first).', params: 'spec_patch', executor: 'transaction',
  }),
  'container.change_image': Object.freeze({
    id: 'container.change_image', targetType: 'container', permission: 'operations.container.recreate',
    confirmation: 'strong', risk: 'high',
    verb: 'change image of', progressive: 'Changing image of', past: 'moved to a new image', imperative: 'Change image of',
    consequence: 'The new image is pulled and the container is recreated on it. The service is briefly unavailable; volumes are kept.',
    timeoutMs: envMs('OPUSHUB_OP_TX_TIMEOUT_MS', 180_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 15_000),
    expect: 'replaced', auditCategory: 'service', adapter: 'change_image', offerWhen: Object.freeze(['running', 'exited', 'created', 'paused', 'dead']),
    summary: 'Pull a different image or tag and recreate the container on it.', params: 'image', executor: 'transaction',
  }),
  'container.duplicate': Object.freeze({
    id: 'container.duplicate', targetType: 'container', permission: 'operations.container.create',
    confirmation: 'strong', risk: 'medium',
    verb: 'duplicate', progressive: 'Duplicating', past: 'duplicated', imperative: 'Duplicate',
    consequence: 'A second container is created from this one\'s configuration. Published host ports and named volumes are not copied unless you change them — two containers cannot share a host port.',
    timeoutMs: envMs('OPUSHUB_OP_TX_TIMEOUT_MS', 90_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 15_000),
    expect: 'created', auditCategory: 'service', adapter: 'duplicate', offerWhen: Object.freeze(['running', 'exited', 'created', 'paused', 'dead']),
    summary: 'Create a new container from this one\'s configuration.', params: 'duplicate', executor: 'transaction',
  }),
  'container.create': Object.freeze({
    id: 'container.create', targetType: 'new', permission: 'operations.container.create',
    confirmation: 'strong', risk: 'medium',
    verb: 'create', progressive: 'Creating', past: 'created', imperative: 'Create',
    consequence: 'The image is pulled if missing and a new container is created and started.',
    timeoutMs: envMs('OPUSHUB_OP_TX_TIMEOUT_MS', 180_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 15_000),
    expect: 'created', auditCategory: 'service', adapter: 'create', offerWhen: Object.freeze([]),
    summary: 'Create a new container from a configuration.', params: 'spec', executor: 'transaction',
  }),

  'container.remove': Object.freeze({
    id: 'container.remove', targetType: 'container', permission: 'operations.container.remove',
    confirmation: 'strong', risk: 'high',
    verb: 'remove', progressive: 'Removing', past: 'removed', imperative: 'Remove',
    consequence: 'The container is deleted. Its named volumes and bind-mounted data are kept; anything written to the container filesystem itself is lost.',
    timeoutMs: envMs('OPUSHUB_OP_CONTROL_TIMEOUT_MS', 20_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 10_000),
    expect: 'gone', auditCategory: 'service', adapter: 'remove', offerWhen: Object.freeze(['exited', 'created', 'dead', 'running', 'paused']),
    summary: 'Delete a container. Volumes are never deleted. A running container needs `force`.', params: 'remove', executor: 'control',
  }),

  /* ---------------- Phase 10D-B: stacks ---------------- */

  'stack.deploy': Object.freeze({
    id: 'stack.deploy', targetType: 'stack', permission: 'operations.stack.deploy',
    confirmation: 'strong', risk: 'high',
    verb: 'deploy', progressive: 'Deploying', past: 'deployed', imperative: 'Deploy',
    consequence: 'Networks and volumes are created as needed, changed services are recreated and new ones created. Unchanged services are left alone.',
    timeoutMs: envMs('OPUSHUB_OP_STACK_TIMEOUT_MS', 600_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 20_000),
    expect: 'stack', auditCategory: 'stack', adapter: 'stack_deploy', offerWhen: Object.freeze([]),
    summary: 'Deploy or redeploy a managed stack from its Compose document.', params: 'none', executor: 'transaction',
  }),
  'stack.start': Object.freeze({
    id: 'stack.start', targetType: 'stack', permission: 'operations.container.start',
    confirmation: 'normal', risk: 'low',
    verb: 'start', progressive: 'Starting', past: 'started', imperative: 'Start',
    consequence: null,
    timeoutMs: envMs('OPUSHUB_OP_STACK_TIMEOUT_MS', 120_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 20_000),
    expect: 'stack', auditCategory: 'stack', adapter: 'stack_start', offerWhen: Object.freeze([]),
    summary: 'Start every container of a stack.', params: 'none', executor: 'transaction',
  }),
  'stack.stop': Object.freeze({
    id: 'stack.stop', targetType: 'stack', permission: 'operations.container.stop',
    confirmation: 'strong', risk: 'high',
    verb: 'stop', progressive: 'Stopping', past: 'stopped', imperative: 'Stop',
    consequence: 'Every container of the stack is stopped. They stay stopped until the stack is started again.',
    timeoutMs: envMs('OPUSHUB_OP_STACK_TIMEOUT_MS', 120_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 20_000),
    expect: 'stack', auditCategory: 'stack', adapter: 'stack_stop', offerWhen: Object.freeze([]),
    summary: 'Stop every container of a stack.', params: 'none', executor: 'transaction',
  }),
  'stack.remove': Object.freeze({
    id: 'stack.remove', targetType: 'stack', permission: 'operations.stack.remove',
    confirmation: 'strong', risk: 'high',
    verb: 'remove', progressive: 'Removing', past: 'removed', imperative: 'Remove',
    consequence: 'Every container of the stack is stopped and deleted, and the networks the stack created are removed. Volumes are never deleted.',
    timeoutMs: envMs('OPUSHUB_OP_STACK_TIMEOUT_MS', 300_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 20_000),
    expect: 'stack', auditCategory: 'stack', adapter: 'stack_remove', offerWhen: Object.freeze([]),
    summary: 'Tear a stack down. Volumes are kept.', params: 'none', executor: 'transaction',
  }),

  /* ---------------- Phase 10D-D: images & catalog ---------------- */

  'image.pull': Object.freeze({
    id: 'image.pull', targetType: 'image', permission: 'operations.image.pull',
    confirmation: 'normal', risk: 'low',
    verb: 'pull', progressive: 'Pulling', past: 'pulled', imperative: 'Pull',
    consequence: 'The image is downloaded to this host. Nothing running is changed.',
    timeoutMs: envMs('OPUSHUB_OP_PULL_TIMEOUT_MS', 300_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 5_000),
    expect: 'image', auditCategory: 'docker', adapter: 'image_pull', offerWhen: Object.freeze([]),
    summary: 'Pull an image from a registry.', params: 'pull', executor: 'control',
  }),
  'service.install': Object.freeze({
    id: 'service.install', targetType: 'catalog', permission: 'operations.container.create',
    confirmation: 'strong', risk: 'high',
    verb: 'install', progressive: 'Installing', past: 'installed', imperative: 'Install',
    consequence: 'The image is pulled, volumes and networks are created as needed, the container is created and started, and it is registered with monitoring (and Autoheal/updates when the manifest asks for it).',
    timeoutMs: envMs('OPUSHUB_OP_TX_TIMEOUT_MS', 300_000), verifyMs: envMs('OPUSHUB_OP_VERIFY_MS', 30_000),
    expect: 'created', auditCategory: 'service', adapter: 'install', offerWhen: Object.freeze([]),
    summary: 'Install a service from the catalog.', params: 'install', executor: 'transaction',
  }),
});

/** The action ids, in the order the UI should offer them. */
export const ACTION_IDS = Object.freeze([
  'container.start', 'container.restart', 'container.stop',
  'container.pause', 'container.unpause', 'container.kill',
  'container.rename', 'container.pull_image', 'container.network_attach', 'container.network_detach',
  'container.update', 'container.recreate', 'container.edit', 'container.change_image',
  'container.duplicate', 'container.create', 'container.remove',
  'stack.deploy', 'stack.start', 'stack.stop', 'stack.remove',
  'image.pull', 'service.install',
]);

/** The action ids that target an existing container (the ones a service page may offer). */
export const CONTAINER_ACTION_IDS = Object.freeze(ACTION_IDS.filter((id) => ACTIONS[id].targetType === 'container'));

/** Every permission the operations engine knows about (deduplicated, in registry order). */
export const OPERATION_PERMISSIONS = Object.freeze([...new Set(Object.values(ACTIONS).map((a) => a.permission))]);

/** True when the id is one of the registered actions — the only gate the API applies to input. */
export function isKnownAction(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ACTIONS, id);
}

/**
 * Look an action up. Unknown ids return null instead of throwing so the caller can answer with
 * a structured rejection (and an audit record) rather than a stack trace.
 */
export function getAction(id) {
  return isKnownAction(id) ? ACTIONS[id] : null;
}

/**
 * The registry as the Settings → Operations pane describes it. Informational: this is what the
 * engine can do, and there is no switch here that turns any of it off or on.
 */
export function registrySummary() {
  return ACTION_IDS.map((id) => {
    const a = ACTIONS[id];
    return {
      id: a.id,
      label: a.targetType === 'container' ? `${a.imperative} container` : a.targetType === 'stack' ? `${a.imperative} stack` : a.targetType === 'image' ? `${a.imperative} image` : a.targetType === 'catalog' ? `${a.imperative} service` : `${a.imperative} container`,
      targetType: a.targetType,
      params: a.params,
      executor: a.executor,
      offerWhen: [...a.offerWhen],
      permission: a.permission,
      risk: a.risk,
      confirmation: a.confirmation,
      summary: a.summary,
      timeoutMs: a.timeoutMs,
      verifyMs: a.verifyMs,
      enabled: true,
    };
  });
}

/** Test/ops helper. */
export function _internals() {
  return { ACTIONS, ACTION_IDS };
}
