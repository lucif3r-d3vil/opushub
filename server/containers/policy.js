// The configuration policy classifier — one judgement for a container spec, wherever it came
// from (the editor, a duplicate, a Compose service, a catalog manifest).
//
// A spec is classified into exactly one of four levels, with every finding listed:
//
//   SAFE       nothing to say
//   WARNING    worth knowing (a published port on every interface, a broad bind mount)
//   DANGEROUS  grants real host power — allowed, but only after an explicit strong confirmation
//   BLOCKED    grants OpusHub-equivalent host control, or uses something OpusHub cannot manage
//              safely — refused, whatever the operator confirms
//
// The lines are drawn on the side of the operator who is deploying their own homelab: bind mounts
// of a media library are normal; a Docker socket mount is what OpusHub itself has and therefore
// what an attacker who can get a Compose file past this classifier would want most.
//
// Nothing here executes; nothing here talks to Docker. Findings are data.

export const LEVELS = Object.freeze(['SAFE', 'WARNING', 'DANGEROUS', 'BLOCKED']);
const RANK = Object.freeze({ SAFE: 0, WARNING: 1, DANGEROUS: 2, BLOCKED: 3 });

/** Host paths that, mounted, hand over the host. Prefix match on the normalized source path. */
export const BLOCKED_HOST_PATHS = Object.freeze([
  '/var/run/docker.sock', '/run/docker.sock', '/var/run/docker', '/run/docker',
  '/var/run/containerd', '/run/containerd', '/var/lib/docker', '/var/lib/containerd',
  '/proc', '/sys/fs/cgroup', '/boot', '/etc/shadow', '/etc/sudoers', '/root/.ssh', '/etc/ssh',
]);

/** Host paths that are sensitive but legitimately mounted read-only by some tools. */
export const SENSITIVE_HOST_PATHS = Object.freeze([
  '/etc', '/root', '/home', '/var/log', '/sys', '/dev', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/var/lib', '/opt', '/srv', '/var',
]);

/** Capabilities that amount to root on the host. */
export const BLOCKED_CAPABILITIES = Object.freeze(['SYS_ADMIN', 'SYS_MODULE', 'SYS_RAWIO', 'SYS_PTRACE', 'SYS_BOOT', 'MAC_ADMIN', 'MAC_OVERRIDE', 'BPF', 'PERFMON', 'DAC_READ_SEARCH', 'ALL']);

/** Capabilities that are powerful but have honest homelab uses (VPN containers, network tools). */
export const DANGEROUS_CAPABILITIES = Object.freeze(['NET_ADMIN', 'NET_RAW', 'SYS_TIME', 'SYS_NICE', 'SYS_RESOURCE', 'SYS_CHROOT', 'MKNOD', 'AUDIT_WRITE', 'AUDIT_CONTROL', 'SYSLOG', 'IPC_LOCK', 'LINUX_IMMUTABLE', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'SETPCAP']);

const SUPPORTED_SECURITY_OPT = /^(no-new-privileges(:true|:false)?|apparmor=[A-Za-z0-9_.-]+|seccomp=(unconfined|runtime\/default|builtin)|label=(disable|type:[A-Za-z0-9_]+))$/;

const finding = (level, code, message, field = null) => ({ level, code, message, field });

function normalize(pth) {
  return String(pth || '').replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}
const under = (pth, root) => pth === root || pth.startsWith(`${root}/`);

/**
 * Classify one canonical spec.
 *
 * @param spec a spec from containers/spec.js
 * @param opts.current the container's existing spec, when this is an edit: a finding that is
 *   unchanged from the current configuration is reported but demoted from BLOCKED to DANGEROUS,
 *   because refusing to edit an environment variable on a container that already has a socket
 *   mount would make OpusHub useless for the very containers that most need care. Adding a new
 *   BLOCKED property is still blocked.
 * @returns {{level:string, findings:object[], blocked:boolean, dangerous:boolean}}
 */
export function classifySpec(spec, { current = null } = {}) {
  const findings = [];
  if (!spec || typeof spec !== 'object') return { level: 'BLOCKED', findings: [finding('BLOCKED', 'invalid', 'No configuration to evaluate.')], blocked: true, dangerous: false };

  // ---- privilege ----
  if (spec.privileged === true) findings.push(finding('BLOCKED', 'privileged', 'Privileged mode disables every container isolation boundary — equivalent to root on the host.', 'privileged'));

  // ---- namespaces (only present when read from an existing container) ----
  const u = spec._unsupported || {};
  if (u.pidMode === 'host') findings.push(finding('BLOCKED', 'host_pid', 'The container shares the host PID namespace.', 'pidMode'));
  if (u.ipcMode === 'host') findings.push(finding('BLOCKED', 'host_ipc', 'The container shares the host IPC namespace.', 'ipcMode'));
  if (u.usernsMode === 'host') findings.push(finding('WARNING', 'host_userns', 'The container uses the host user namespace.', 'usernsMode'));
  if (u.cgroupnsMode === 'host') findings.push(finding('WARNING', 'host_cgroupns', 'The container uses the host cgroup namespace.', 'cgroupnsMode'));
  if (u.sysctls) findings.push(finding('WARNING', 'sysctls', 'The container sets kernel parameters (sysctls); OpusHub preserves but cannot edit them.', 'sysctls'));

  // ---- network mode ----
  if (spec.networkMode === 'host') findings.push(finding('DANGEROUS', 'host_network', 'Host networking exposes every port the process opens directly on the host and bypasses Docker network isolation.', 'networkMode'));
  if (typeof spec.networkMode === 'string' && spec.networkMode.startsWith('container:')) findings.push(finding('BLOCKED', 'container_network', 'Sharing another container\'s network namespace is not supported.', 'networkMode'));

  // ---- mounts ----
  for (const v of spec.volumes || []) {
    if (v.type !== 'bind') continue;
    const src = normalize(v.source);
    const blocked = BLOCKED_HOST_PATHS.find((b) => under(src, b));
    if (blocked) {
      const isSocket = /docker|containerd/.test(blocked);
      findings.push(finding('BLOCKED', isSocket ? 'docker_socket' : 'blocked_host_path',
        isSocket ? `Mounting ${src} grants full control of the Docker engine — and therefore of the host and of OpusHub itself.` : `Mounting ${src} exposes a critical host path.`, 'volumes'));
      continue;
    }
    if (src === '/') { findings.push(finding('BLOCKED', 'root_mount', 'Mounting the host root filesystem exposes the whole host.', 'volumes')); continue; }
    const sensitive = SENSITIVE_HOST_PATHS.find((s) => under(src, s));
    if (sensitive) {
      // /etc/localtime and /etc/timezone read-only are the classic, harmless case
      if (/^\/etc\/(localtime|timezone)$/.test(src) && v.readOnly) continue;
      if (src === sensitive) findings.push(finding(v.readOnly ? 'DANGEROUS' : 'BLOCKED', 'broad_host_path', `Mounting ${src}${v.readOnly ? ' read-only' : ' read-write'} gives the container ${v.readOnly ? 'broad read access to' : 'the ability to modify'} the host system.`, 'volumes'));
      else findings.push(finding(v.readOnly ? 'WARNING' : 'DANGEROUS', 'sensitive_host_path', `${src} is under a sensitive host directory (${sensitive})${v.readOnly ? '' : ' and is writable'}.`, 'volumes'));
      continue;
    }
    if (!v.readOnly && src.split('/').filter(Boolean).length === 1) findings.push(finding('WARNING', 'broad_bind', `${src} is a top-level host directory mounted read-write.`, 'volumes'));
  }

  // ---- devices ----
  for (const d of spec.devices || []) {
    const host = normalize(d.host);
    if (/^\/dev\/(sd[a-z]+|nvme\d|vd[a-z]+|mem|kmem|port|disk\/)/.test(host)) findings.push(finding('BLOCKED', 'raw_device', `${host} is a raw disk or memory device.`, 'devices'));
    else if (/^\/dev\/(dri|dri\/.*|nvidia.*|ttyUSB\d+|ttyACM\d+|video\d+|snd|snd\/.*|bus\/usb.*|fuse|net\/tun)$/.test(host)) findings.push(finding('WARNING', 'device', `${host} is passed through to the container.`, 'devices'));
    else findings.push(finding('DANGEROUS', 'device', `${host} is passed through to the container.`, 'devices'));
  }

  // ---- capabilities ----
  for (const c of spec.capabilities?.add || []) {
    const cap = String(c).toUpperCase().replace(/^CAP_/, '');
    if (BLOCKED_CAPABILITIES.includes(cap)) findings.push(finding('BLOCKED', 'blocked_capability', `Capability ${cap} is equivalent to root on the host.`, 'capabilities'));
    else if (DANGEROUS_CAPABILITIES.includes(cap)) findings.push(finding('DANGEROUS', 'dangerous_capability', `Capability ${cap} grants elevated privileges.`, 'capabilities'));
    else findings.push(finding('WARNING', 'capability', `Capability ${cap} is added.`, 'capabilities'));
  }

  // ---- security options ----
  for (const s of spec.securityOpt || []) {
    if (!SUPPORTED_SECURITY_OPT.test(s)) findings.push(finding('BLOCKED', 'unsupported_security_opt', `Security option "${String(s).slice(0, 60)}" is not supported.`, 'securityOpt'));
    else if (/^(seccomp=unconfined|apparmor=unconfined|label=disable)$/.test(s)) findings.push(finding('DANGEROUS', 'unconfined', `Security option ${s} removes a kernel confinement layer.`, 'securityOpt'));
  }

  // ---- ports ----
  const wide = (spec.ports || []).filter((p) => p.host && (!p.hostIp || p.hostIp === '0.0.0.0' || p.hostIp === '::'));
  if (wide.length > 20) findings.push(finding('WARNING', 'many_ports', `${wide.length} ports are published on every interface.`, 'ports'));
  for (const p of wide) {
    if ([22, 2375, 2376, 6443].includes(p.host)) findings.push(finding('DANGEROUS', 'sensitive_port', `Host port ${p.host} is published on every interface.`, 'ports'));
  }
  const privileged = (spec.ports || []).filter((p) => p.host && p.host < 1024 && (!p.hostIp || p.hostIp === '0.0.0.0'));
  if (privileged.length) findings.push(finding('WARNING', 'privileged_port', `Privileged host port${privileged.length > 1 ? 's' : ''} ${privileged.map((p) => p.host).join(', ')} published on every interface.`, 'ports'));

  // ---- user ----
  if (spec.user && /^(0|root)(:|$)/.test(spec.user) && (spec.volumes || []).some((v) => v.type === 'bind' && !v.readOnly)) {
    findings.push(finding('WARNING', 'root_with_bind', 'Runs as root with writable host bind mounts.', 'user'));
  }

  // ---- demote pre-existing BLOCKED findings on an edit ----
  if (current) {
    const before = new Set(classifySpec(current).findings.map((f) => `${f.code}:${f.message}`));
    for (const f of findings) {
      if (f.level === 'BLOCKED' && before.has(`${f.code}:${f.message}`)) {
        f.level = 'DANGEROUS';
        f.preexisting = true;
        f.message = `${f.message} (already present on this container — preserved, not added)`;
      }
    }
  }

  const level = findings.reduce((acc, f) => (RANK[f.level] > RANK[acc] ? f.level : acc), 'SAFE');
  return { level, findings, blocked: level === 'BLOCKED', dangerous: RANK[level] >= RANK.DANGEROUS };
}

/** The higher of two levels. */
export function maxLevel(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}

export const _internals = Object.freeze({ RANK, SUPPORTED_SECURITY_OPT });
