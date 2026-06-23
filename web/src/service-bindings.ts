// service-bindings.ts — derive a service's interface bindings from the
// network topology, with no extra HTTP calls (one GET /topology already
// carries everything).
//
// Each topology device records its committed operations in a `steps`
// array; an interface binding is a step whose url is
// `/interfaces/{iface}/apply-service` with `params.service`. Walking
// every device's steps and filtering by service name yields "where is
// this service applied," plus the per-binding params (ip / peer_as /
// vlan). It's a spec-file read — no device reachability required.
//
// Pure + DOM-free so it's unit-testable; the renderer lives in app.ts.

/** One place a service is applied. */
export interface ServiceBinding {
  device: string;
  iface: string;
  ipAddress?: string;
  peerAs?: string;
  vlan?: string;
}

/**
 * deriveServiceBindings returns every interface this service is applied
 * to, read from the topology's per-device `steps`. `topology` is the raw
 * GET /topology payload ({ devices: { <name>: { steps: [...] } } }).
 *
 * Matches on newtron's server-derived `spec_kind`/`spec_name` (newtron
 * #282) — the authoritative provenance, rather than decoding the step
 * params ourselves. Since newtron #283, `spec_name` is the canonical
 * spec identity, equal to the `/services` list key — so `serviceName`
 * (the list name the drawer opened with) matches it exactly; no
 * client-side canonicalization. The interface comes from the step URL.
 * Tolerant of missing/odd shapes — returns [] rather than throwing.
 */
export function deriveServiceBindings(topology: unknown, serviceName: string): ServiceBinding[] {
  const out: ServiceBinding[] = [];

  const devices = (topology && typeof topology === "object")
    ? (topology as { devices?: unknown }).devices
    : undefined;
  if (!devices || typeof devices !== "object") return out;

  for (const [device, devVal] of Object.entries(devices as Record<string, unknown>)) {
    const steps = (devVal && typeof devVal === "object")
      ? (devVal as { steps?: unknown }).steps
      : undefined;
    if (!Array.isArray(steps)) continue;

    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const s = step as Record<string, unknown>;
      if (s.spec_kind !== "service" || s.spec_name !== serviceName) continue;

      // The interface comes from the step URL; a `service` step that
      // isn't an interface application (e.g. a node-level deploy-service)
      // has no interface, so skip it for the bindings view.
      const url = s.url;
      if (typeof url !== "string") continue;
      const m = url.match(/^\/interfaces\/(.+)\/apply-service$/);
      if (!m) continue;

      const params = (s.params && typeof s.params === "object") ? s.params as Record<string, unknown> : {};
      const b: ServiceBinding = { device, iface: m[1]! };
      if (params.ip_address != null && params.ip_address !== "") b.ipAddress = String(params.ip_address);
      if (params.peer_as != null && params.peer_as !== "") b.peerAs = String(params.peer_as);
      if (params.vlan != null && params.vlan !== "") b.vlan = String(params.vlan);
      out.push(b);
    }
  }

  out.sort((a, b) => a.device.localeCompare(b.device) || a.iface.localeCompare(b.iface));
  return out;
}
