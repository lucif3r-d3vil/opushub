// Operation parameters — the ONLY request fields, beyond an action id and a target reference,
// that the operations engine will ever read.
//
// Phase 8 operations had no parameters at all. Phase 10D adds a handful (a new name, a network to
// attach, a container spec patch, a compose document…), and every one of them is declared here as
// a *schema*, keyed by the action's `params` kind. The parser is a static switch: an action whose
// registry entry says `params: 'none'` cannot be given parameters, and no action can receive a
// field its schema does not name. Unknown keys are refused — not ignored — because an ignored key
// is a key somebody will eventually start reading.
//
// The canonical, normalized parameters are hashed and bound into the confirmation token, so the
// plan the operator confirmed is, byte for byte, the plan that executes.
import crypto from 'node:crypto';
import { operationError } from './model.js';
import { normalizeSpec, normalizeSpecPatch } from '../containers/spec.js';
import { isValidImageRef } from '../updates/recreateAdapter.js';

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const NETWORK_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ALIAS_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const MAX_ALIASES = 8;
const MAX_STACK_ID = 64;
const MAX_COMPOSE = 256 * 1024;
const MAX_ENV_KEYS = 200;

/** The parameter kinds. Every registry action names exactly one. */
export const PARAM_KINDS = Object.freeze([
  'none', 'rename', 'remove', 'network', 'spec', 'spec_patch', 'image', 'duplicate', 'stack_source', 'install', 'pull',
]);

const bad = (reason, detail = null) => ({ ok: false, error: operationError('bad_params', reason, detail) });
const ok = (params) => ({ ok: true, params });

function onlyKeys(raw, allowed) {
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  return extra.length ? extra : null;
}

function readBool(v, fallback = false) {
  if (v === undefined || v === null) return fallback;
  return v === true;
}

/**
 * Parse the raw `params` object from a request body for one action.
 *
 * @returns {{ok:true, params:object} | {ok:false, error:object}}
 */
export function parseParams(kind, raw) {
  const input = raw === undefined || raw === null ? {} : raw;
  if (typeof input !== 'object' || Array.isArray(input)) return bad('Operation parameters must be an object.');
  if (JSON.stringify(input).length > MAX_COMPOSE + 64 * 1024) return bad('Operation parameters are too large.');

  switch (kind) {
    case 'none': {
      if (Object.keys(input).length) return bad('This operation takes no parameters.');
      return ok({});
    }
    case 'rename': {
      const extra = onlyKeys(input, ['name']);
      if (extra) return bad(`Unexpected parameter: ${extra[0]}`);
      const name = typeof input.name === 'string' ? input.name.trim().replace(/^\//, '') : '';
      if (!NAME_RE.test(name)) return bad('The new name must be 1–128 characters: letters, digits, "_", ".", "-" — starting with a letter or digit.');
      return ok({ name });
    }
    case 'remove': {
      const extra = onlyKeys(input, ['force']);
      if (extra) return bad(`Unexpected parameter: ${extra[0]}`);
      return ok({ force: readBool(input.force) });
    }
    case 'network': {
      const extra = onlyKeys(input, ['network', 'aliases']);
      if (extra) return bad(`Unexpected parameter: ${extra[0]}`);
      const network = typeof input.network === 'string' ? input.network.trim() : '';
      if (!NETWORK_RE.test(network)) return bad('A network name is required.');
      let aliases = [];
      if (input.aliases !== undefined) {
        if (!Array.isArray(input.aliases) || input.aliases.length > MAX_ALIASES) return bad(`Aliases must be a list of at most ${MAX_ALIASES} names.`);
        aliases = input.aliases.map((a) => String(a).trim());
        if (!aliases.every((a) => ALIAS_RE.test(a))) return bad('Aliases must be DNS labels (letters, digits, "-").');
      }
      return ok({ network, aliases });
    }
    case 'image': {
      const extra = onlyKeys(input, ['image']);
      if (extra) return bad(`Unexpected parameter: ${extra[0]}`);
      const image = typeof input.image === 'string' ? input.image.trim() : '';
      if (!isValidImageRef(image)) return bad('That is not a valid image reference (repository[:tag][@digest]).');
      return ok({ image });
    }
    case 'pull': {
      const extra = onlyKeys(input, ['image', 'registryId']);
      if (extra) return bad(`Unexpected parameter: ${extra[0]}`);
      const image = typeof input.image === 'string' ? input.image.trim() : '';
      if (image && !isValidImageRef(image)) return bad('That is not a valid image reference (repository[:tag][@digest]).');
      const registryId = typeof input.registryId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(input.registryId) ? input.registryId : null;
      return ok({ image: image || null, registryId });
    }
    case 'spec': {
      const extra = onlyKeys(input, ['spec']);
      if (extra) return bad(`Unexpected parameter: ${extra[0]}`);
      const r = normalizeSpec(input.spec);
      if (!r.ok) return bad(r.errors[0], r.errors.slice(1).join('; ') || null);
      return ok({ spec: r.spec });
    }
    case 'spec_patch': {
      const extra = onlyKeys(input, ['spec']);
      if (extra) return bad(`Unexpected parameter: ${extra[0]}`);
      const r = normalizeSpecPatch(input.spec);
      if (!r.ok) return bad(r.errors[0], r.errors.slice(1).join('; ') || null);
      if (!Object.keys(r.patch).length) return bad('The edit contains no changes.');
      return ok({ spec: r.patch });
    }
    case 'duplicate': {
      const extra = onlyKeys(input, ['name', 'spec']);
      if (extra) return bad(`Unexpected parameter: ${extra[0]}`);
      const name = typeof input.name === 'string' ? input.name.trim().replace(/^\//, '') : '';
      if (!NAME_RE.test(name)) return bad('A name for the copy is required (letters, digits, "_", ".", "-").');
      let patch = {};
      if (input.spec !== undefined) {
        const r = normalizeSpecPatch(input.spec);
        if (!r.ok) return bad(r.errors[0], r.errors.slice(1).join('; ') || null);
        patch = r.patch;
      }
      return ok({ name, spec: patch });
    }
    case 'stack_source': {
      // stack create/update carry the compose document as DATA; nothing in it is executed here
      const extra = onlyKeys(input, ['name', 'compose', 'env']);
      if (extra) return bad(`Unexpected parameter: ${extra[0]}`);
      const name = typeof input.name === 'string' ? input.name.trim().toLowerCase() : '';
      if (name && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) return bad('A stack name is lowercase letters, digits, "_" or "-" (max 64).');
      const compose = typeof input.compose === 'string' ? input.compose : '';
      if (!compose.trim()) return bad('A Compose document is required.');
      if (compose.length > MAX_COMPOSE) return bad('The Compose document is too large (256 KB max).');
      const env = {};
      if (input.env !== undefined) {
        if (!input.env || typeof input.env !== 'object' || Array.isArray(input.env)) return bad('env must be an object of KEY: value pairs.');
        const keys = Object.keys(input.env);
        if (keys.length > MAX_ENV_KEYS) return bad(`env has too many keys (max ${MAX_ENV_KEYS}).`);
        for (const k of keys) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)) return bad(`env key "${k.slice(0, 40)}" is not a valid variable name.`);
          const v = input.env[k];
          if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return bad(`env value for ${k} must be a string.`);
          env[k] = String(v).slice(0, 4096);
        }
      }
      return ok({ name: name || null, compose, env });
    }
    case 'install': {
      const extra = onlyKeys(input, ['config']);
      if (extra) return bad(`Unexpected parameter: ${extra[0]}`);
      const config = input.config === undefined ? {} : input.config;
      if (!config || typeof config !== 'object' || Array.isArray(config)) return bad('config must be an object.');
      if (JSON.stringify(config).length > 64 * 1024) return bad('config is too large.');
      // the catalog planner validates every field against the manifest's declared variables;
      // here we only guarantee a bounded, plain-object shape with scalar leaves
      const clean = {};
      for (const [k, v] of Object.entries(config)) {
        if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(k)) return bad(`config key "${k.slice(0, 40)}" is not valid.`);
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) clean[k] = v;
        else if (Array.isArray(v) && v.every((x) => ['string', 'number', 'boolean'].includes(typeof x)) && v.length <= 64) clean[k] = v.map(String);
        else if (v && typeof v === 'object' && Object.values(v).every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) clean[k] = { ...v };
        else return bad(`config value for ${k} must be a scalar, a list of scalars, or an object of scalars.`);
      }
      return ok({ config: clean });
    }
    default:
      return bad('This operation has no parameter schema.');
  }
}

/** A canonical, order-independent JSON encoding so two equal plans hash equal. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** The parameter hash bound into the confirmation token. */
export function paramsHash(params) {
  return crypto.createHash('sha256').update(canonicalJson(params ?? {})).digest('base64url').slice(0, 22);
}

/** The confirmation target key: type, canonical id, and the hash of what will be done. */
export function confirmationKey(target, params) {
  const id = target?.containerId || target?.id || 'none';
  return `${target?.type || 'container'}:${id}:${paramsHash(params)}`;
}

export const _internals = Object.freeze({ NAME_RE, NETWORK_RE, ALIAS_RE, MAX_COMPOSE });
