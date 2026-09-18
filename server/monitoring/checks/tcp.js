// The TCP check — one explicitly configured endpoint, and nothing else.
//
// This is a monitor, not a scanner. The whole capability is: "connect to this one host on this one
// port, within this deadline, and say whether the connection was accepted". There is
//   · no port range and no port list (validation refuses them — see net.parseTcpEndpoint and
//     model.parsePort),
//   · no subnet, no sweep, no discovery: a TCP monitor names exactly one host,
//   · no banner read, no protocol probe, no bytes written — the socket is closed the moment it
//     connects, so a monitored service sees a connect/close and nothing else.
//
// The address is resolved and classified first (loopback, link-local/metadata, multicast and the
// rest of the refused classes are never contacted), and the connection is made to the validated
// address itself, not to the name.
import net from 'node:net';
import { parseTcpEndpoint, resolveHost as resolveHostDefault } from '../net.js';

const FAIL = 'fail';
const UNKNOWN = 'unknown';

const classifyError = (err) => {
  if (err?.errorType) return err.errorType;
  const code = err?.code || '';
  const msg = String(err?.message || err);
  if (code === 'ETIMEDOUT' || err?.timedOut || /timed out|timeout/i.test(msg)) return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ECONNRESET') return 'reset';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'unreachable';
  return 'network';
};

/** One connect attempt against a pinned address. Resolves with the connect latency in ms. */
export function oneConnect({ address, family, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = net.connect({ host: address, port, family });
    const fail = (errorType) => {
      socket.destroy();
      reject(Object.assign(new Error(`connect ${errorType}`), { errorType }));
    };
    socket.setTimeout(timeoutMs, () => fail('timeout'));
    socket.once('error', (err) => { socket.destroy(); reject(Object.assign(err, { errorType: classifyError(err) })); });
    socket.once('connect', () => {
      const latencyMs = Date.now() - started;
      socket.destroy(); // connect is the whole measurement: no data is written or read
      resolve({ latencyMs });
    });
  });
}

/**
 * Run one TCP check.
 *
 * @param {object} target `{ host, port }`
 * @param {object} opts   `{ timeoutMs, now, resolveHost, connect }`
 */
export async function checkTcp(target, { timeoutMs = 5000, now = Date.now(), resolveHost = resolveHostDefault, connect = oneConnect, allowInternal = true } = {}) {
  const at = now;
  const endpoint = parseTcpEndpoint(target?.host, target?.port);
  if (!endpoint.ok) {
    return { kind: UNKNOWN, at, latencyMs: null, statusCode: null, errorType: endpoint.code, code: endpoint.code, reason: endpoint.reason, hops: 0, evidence: null };
  }

  const resolved = await resolveHost(endpoint.host, { allowInternal });
  if (!resolved.ok) {
    // Refused classes and policy refusals are configuration answers, not outages.
    const refused = resolved.code === 'blocked_address' || resolved.code === 'internal_blocked';
    const kind = refused ? UNKNOWN : FAIL;
    return {
      kind, at, latencyMs: null, statusCode: null,
      errorType: refused ? resolved.code : 'dns',
      code: resolved.code, reason: resolved.reason, hops: 0,
      evidence: { port: endpoint.port },
    };
  }

  try {
    const { latencyMs } = await connect({
      address: resolved.pinned,
      family: resolved.addresses[0].family,
      port: endpoint.port,
      timeoutMs,
    });
    return {
      kind: 'ok', at, latencyMs, statusCode: null, errorType: null, code: null,
      reason: `Connected to ${endpoint.host}:${endpoint.port}`, hops: 0,
      evidence: { port: endpoint.port, addressClass: resolved.addresses[0].klass, addressClasses: resolved.addresses.map((a) => a.klass) },
    };
  } catch (err) {
    const errorType = classifyError(err);
    return {
      kind: FAIL, at, latencyMs: null, statusCode: null, errorType, code: null,
      reason: `No connection (${errorType}).`, hops: 0,
      evidence: { port: endpoint.port, addressClass: resolved.addresses[0].klass, addressClasses: resolved.addresses.map((a) => a.klass) },
    };
  }
}
