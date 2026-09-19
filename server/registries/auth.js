// Registry authentication for pulls — Phase 10D-C fills this in with the encrypted credential
// store. Until then every pull is anonymous, which is what Phase 10C did.
export async function authHeaderFor(_imageRef, _registryId = null) {
  return null;
}
