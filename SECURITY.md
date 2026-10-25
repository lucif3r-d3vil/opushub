# Security

## Threat model

OpusHub is built for a LAN or VPN, with one local administrator account. Do not expose it directly
to the public internet; put it behind a reverse proxy with its own authentication if you must.

Anyone who can sign in can see your container inventory, host metrics and logs, and can run the
operations listed below. Treat the OpusHub account like a Docker administrator account.

## Docker access

- **Reads** go through `server/providers/docker.js`, which is GET-only (asserted by
  `server/phase7-proof.test.js`).
- **Writes** are a fixed, enumerated set of calls in `server/providers/dockerOperations.js` and
  `server/updates/recreateAdapter.js`. There is no exec, no attach, no prune, and no
  pass-through to the Docker API. Every operation is registered in
  `server/operations/registry.js`, needs a server-minted confirmation token, and is audited.
- **The `:ro` socket mount is not a control.** Mounting `/var/run/docker.sock:ro` does not stop
  Docker API writes; it only prevents replacing the socket file. The boundary is OpusHub's own
  code. For a boundary enforced outside OpusHub, set `OPUSHUB_OPERATIONS_SOCKET` to a filtering
  socket proxy that exposes only the endpoints you want.

## Files explorer

Read-only by construction: there is no write endpoint. Requests name a configured root plus a
relative path; containment is resolved server-side, and credentials, keys, session material and
the Docker socket are refused by policy. Mount the roots `:ro` as well, because a mount is
enforced by the kernel rather than by our code. Details: `docs/archive/17-phase-11a.md`.

## Reporting a vulnerability

Please report privately through GitHub's "Report a vulnerability" (Security tab of
https://github.com/lucif3r-d3vil/opushub) rather than a public issue. Include the version, how
OpusHub is deployed, and steps to reproduce.
