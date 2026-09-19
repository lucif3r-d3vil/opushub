// Registry authentication for pulls — the one function the runners call. Implemented by the
// registry client (registries/client.js) against the encrypted store. Anonymous when no stored
// registry matches the image's host.
export { authHeaderFor } from './client.js';
