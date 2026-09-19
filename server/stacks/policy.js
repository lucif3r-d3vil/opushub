// Compose policy — the per-service container policy (containers/policy.js) applied to every
// service of a stack, plus the stack-level facts the container classifier cannot see: keys the
// parser refused (unsupported → BLOCKED), non-bridge networks, host ports claimed twice.
//
//   SAFE       nothing to say
//   WARNING    shown, confirmation as usual
//   DANGEROUS  strong confirmation, every finding listed
//   BLOCKED    the deployment is refused
import { classifySpec, LEVELS } from '../containers/policy.js';

const RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
const finding = (level, code, message, service = null, field = null) => ({ level, code, message, service, field });

/**
 * @param {object} model   parseCompose().model
 * @param {object} [o]
 * @param {Map<string,object>} [o.current]  service key → current spec (for pre-existing demotion)
 */
export function classifyStack(model, { current = null } = {}) {
  const findings = [];
  const perService = {};
  if (!model) return { level: 'BLOCKED', findings: [finding('BLOCKED', 'invalid', 'No stack to evaluate.')], perService, blocked: true, dangerous: false };

  for (const u of model.unsupported || []) findings.push(finding('BLOCKED', 'unsupported', `${u.where}: ${u.reason}`, u.where.split('.')[1] || null, u.where));

  for (const svc of model.services) {
    const c = classifySpec(svc.spec, { current: current?.get(svc.key) || null });
    perService[svc.key] = c.level;
    for (const f of c.findings) findings.push({ ...f, service: svc.key });
  }

  // host ports claimed by two services of the same stack — a deployment that cannot succeed
  const claimed = new Map();
  for (const svc of model.services) {
    for (const p of svc.spec.ports || []) {
      if (!p.host) continue;
      const k = `${p.hostIp || '0.0.0.0'}:${p.host}/${p.protocol}`;
      if (claimed.has(k)) findings.push(finding('BLOCKED', 'port_conflict', `Host port ${p.host}/${p.protocol} is published by both ${claimed.get(k)} and ${svc.key}.`, svc.key, 'ports'));
      else claimed.set(k, svc.key);
    }
  }

  for (const n of model.networks || []) {
    if (n.driver === 'host' || n.driver === 'none') findings.push(finding('DANGEROUS', 'host_network', `Network ${n.key} uses the ${n.driver} driver.`, null, `networks.${n.key}`));
    else if (n.driver === 'macvlan' || n.driver === 'ipvlan') findings.push(finding('WARNING', 'l2_network', `Network ${n.key} is an external ${n.driver} network — containers on it get addresses on your LAN.`, null, `networks.${n.key}`));
  }

  const level = findings.reduce((acc, f) => (RANK[f.level] > RANK[acc] ? f.level : acc), 'SAFE');
  return { level, findings, perService, blocked: level === 'BLOCKED', dangerous: RANK[level] >= RANK.DANGEROUS };
}
