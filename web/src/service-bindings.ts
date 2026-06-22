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
 * canonicalizeServiceName matches the spec name (e.g. "OVERLAY_IRB_A")
 * to the canonicalized form newtron records in committed steps (e.g.
 * "overlay-irb-a"): lowercase, underscores → hyphens. This mirrors
 * newtron's committed-name canonicalization (#268); if that rule ever
 * diverges, matching degrades to "no bindings found" rather than wrong
 * bindings.
 */
export function canonicalizeServiceName(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

/**
 * deriveServiceBindings returns every interface this service is applied
 * to, read from the topology's per-device `steps`. `topology` is the raw
 * GET /topology payload ({ devices: { <name>: { steps: [...] } } }).
 * Tolerant of missing/odd shapes — returns [] rather than throwing.
 */
export function deriveServiceBindings(topology: unknown, serviceName: string): ServiceBinding[] {
  const target = canonicalizeServiceName(serviceName);
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
      const url = (step as { url?: unknown }).url;
      if (typeof url !== "string") continue;
      const m = url.match(/^\/interfaces\/(.+)\/apply-service$/);
      if (!m) continue;

      const params = (step as { params?: unknown }).params;
      const p = (params && typeof params === "object") ? params as Record<string, unknown> : {};
      const svc = p.service;
      if (typeof svc !== "string" || canonicalizeServiceName(svc) !== target) continue;

      const b: ServiceBinding = { device, iface: m[1]! };
      if (p.ip_address != null && p.ip_address !== "") b.ipAddress = String(p.ip_address);
      if (p.peer_as != null && p.peer_as !== "") b.peerAs = String(p.peer_as);
      if (p.vlan != null && p.vlan !== "") b.vlan = String(p.vlan);
      out.push(b);
    }
  }

  out.sort((a, b) => a.device.localeCompare(b.device) || a.iface.localeCompare(b.iface));
  return out;
}
