// Phase 10B — the one canonical notification provider registry (Telegram
// registered; a further provider registers here without changing the core).

const providers = new Map(); // id -> provider instance

export function registerProvider(id, provider) {
  if (!id || typeof id !== 'string') throw new Error('provider id required');
  if (!provider || typeof provider.send !== 'function') throw new Error('provider must have send()');
  providers.set(id, provider);
}

export function getProvider(id) {
  return providers.get(id) || null;
}

export function listProviders() {
  return [...providers.entries()].map(([id, p]) => ({
    id,
    name: p.name || id,
    enabled: typeof p.isEnabled === 'function' ? p.isEnabled() : !!p.enabled,
    status: typeof p.getStatus === 'function' ? p.getStatus() : { state: 'unknown' },
    capabilities: p.capabilities || [],
  }));
}

// Future providers can register themselves via this registry without changing core.
