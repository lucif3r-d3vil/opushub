// Phase 10C — Configuration preservation & build replacement
// Inspects existing container and builds an exact, safe allow-listed Docker Engine create body.
//
// Preserves:
// - Container Name, Hostname, Domainname, User, WorkingDir
// - Entrypoint, Cmd, Environment variables
// - Labels (Traefik, Autoheal, Diun, OpusGrid presentation)
// - ExposedPorts, PortBindings (published ports)
// - Mounts & Binds (read-only/read-write modes, volume sources)
// - Tmpfs mounts
// - RestartPolicy, Healthcheck
// - NetworkMode, primary network endpoint config, IP, aliases
// - SecurityOpt, Privileged, CapAdd, CapDrop
// - Resource limits (Memory, NanoCpus, PidsLimit, CpuShares)
// - DNS, ExtraHosts, LogConfig, StopSignal, StopTimeout, Init
//
// Replaces:
// - Image (points to target updated image tag or digest)

export function buildReplacementConfig(originalInspect, targetImageRef) {
  if (!originalInspect || typeof originalInspect !== 'object') {
    throw new Error('Original container inspect object required');
  }

  const origConfig = originalInspect.Config || {};
  const origHostConfig = originalInspect.HostConfig || {};
  const origNetworkSettings = originalInspect.NetworkSettings || {};

  // 1. Prepare Binds & Mounts (Preserve persistent data)
  // Docker returns mounts in HostConfig.Binds or Mounts array
  const binds = Array.isArray(origHostConfig.Binds) ? [...origHostConfig.Binds] : [];
  if (binds.length === 0 && Array.isArray(originalInspect.Mounts)) {
    for (const m of originalInspect.Mounts) {
      if (m.Type === 'bind' && m.Source && m.Destination) {
        binds.push(`${m.Source}:${m.Destination}:${m.RW ? 'rw' : 'ro'}`);
      } else if (m.Type === 'volume' && m.Name && m.Destination) {
        binds.push(`${m.Name}:${m.Destination}:${m.RW ? 'rw' : 'ro'}`);
      }
    }
  }

  // 2. Prepare Networks & Endpoints
  const networks = origNetworkSettings.Networks || {};
  const networkNames = Object.keys(networks);
  let primaryNetwork = networkNames[0] || origHostConfig.NetworkMode || 'bridge';
  let primaryEndpointConfig = null;

  if (networks[primaryNetwork]) {
    const origEp = networks[primaryNetwork];
    primaryEndpointConfig = {
      Aliases: Array.isArray(origEp.Aliases) ? origEp.Aliases.filter((a) => !a.startsWith(originalInspect.Id?.slice(0, 12))) : [],
      IPAMConfig: origEp.IPAMConfig || (origEp.IPAddress ? { IPv4Address: origEp.IPAddress } : undefined),
    };
  }

  const auxiliaryNetworks = networkNames.slice(1).map((name) => ({
    name,
    endpointConfig: {
      Aliases: Array.isArray(networks[name].Aliases) ? networks[name].Aliases.filter((a) => !a.startsWith(originalInspect.Id?.slice(0, 12))) : [],
      IPAMConfig: networks[name].IPAMConfig || (networks[name].IPAddress ? { IPv4Address: networks[name].IPAddress } : undefined),
    },
  }));

  // 3. Construct explicit allow-listed Create Body
  const createBody = {
    // Replaced Image
    Image: targetImageRef,

    // Identity & Execution
    Hostname: origConfig.Hostname || undefined,
    Domainname: origConfig.Domainname || undefined,
    User: origConfig.User || undefined,
    WorkingDir: origConfig.WorkingDir || undefined,
    Entrypoint: origConfig.Entrypoint || undefined,
    Cmd: origConfig.Cmd || undefined,

    // Environment variables
    Env: Array.isArray(origConfig.Env) ? [...origConfig.Env] : [],

    // Labels (Critical for Traefik routers/services, Autoheal, and OpusGrid)
    Labels: typeof origConfig.Labels === 'object' && origConfig.Labels ? { ...origConfig.Labels } : {},

    // Ports
    ExposedPorts: typeof origConfig.ExposedPorts === 'object' && origConfig.ExposedPorts ? { ...origConfig.ExposedPorts } : {},

    // Healthcheck
    Healthcheck: origConfig.Healthcheck ? { ...origConfig.Healthcheck } : undefined,

    // Stop signal & timeout
    StopSignal: origConfig.StopSignal || undefined,
    StopTimeout: origConfig.StopTimeout || origHostConfig.StopTimeout || undefined,

    // HostConfig
    HostConfig: {
      // Storage & Volume Data Safety
      Binds: binds,
      Mounts: Array.isArray(origHostConfig.Mounts) ? [...origHostConfig.Mounts] : undefined,
      Tmpfs: typeof origHostConfig.Tmpfs === 'object' ? { ...origHostConfig.Tmpfs } : undefined,

      // Network & Ports
      NetworkMode: origHostConfig.NetworkMode || primaryNetwork,
      PortBindings: typeof origHostConfig.PortBindings === 'object' && origHostConfig.PortBindings ? { ...origHostConfig.PortBindings } : {},
      PublishAllPorts: !!origHostConfig.PublishAllPorts,

      // Lifecycle & Health
      RestartPolicy: origHostConfig.RestartPolicy ? { ...origHostConfig.RestartPolicy } : { Name: 'unless-stopped' },
      Init: origHostConfig.Init,

      // Security Context
      Privileged: !!origHostConfig.Privileged,
      SecurityOpt: Array.isArray(origHostConfig.SecurityOpt) ? [...origHostConfig.SecurityOpt] : undefined,
      CapAdd: Array.isArray(origHostConfig.CapAdd) ? [...origHostConfig.CapAdd] : undefined,
      CapDrop: Array.isArray(origHostConfig.CapDrop) ? [...origHostConfig.CapDrop] : undefined,
      ReadonlyRootfs: !!origHostConfig.ReadonlyRootfs,

      // Resource Limits
      Memory: origHostConfig.Memory || 0,
      NanoCpus: origHostConfig.NanoCpus || 0,
      CpuShares: origHostConfig.CpuShares || 0,
      PidsLimit: origHostConfig.PidsLimit || undefined,

      // DNS & Extra Hosts
      Dns: Array.isArray(origHostConfig.Dns) ? [...origHostConfig.Dns] : undefined,
      DnsSearch: Array.isArray(origHostConfig.DnsSearch) ? [...origHostConfig.DnsSearch] : undefined,
      ExtraHosts: Array.isArray(origHostConfig.ExtraHosts) ? [...origHostConfig.ExtraHosts] : undefined,

      // Logging
      LogConfig: origHostConfig.LogConfig ? { ...origHostConfig.LogConfig } : undefined,
    },

    // Primary NetworkingConfig
    NetworkingConfig: primaryEndpointConfig
      ? {
          EndpointsConfig: {
            [primaryNetwork]: primaryEndpointConfig,
          },
        }
      : undefined,
  };

  return {
    createBody,
    auxiliaryNetworks,
    containerName: (originalInspect.Name || '').replace(/^\//, ''),
  };
}
