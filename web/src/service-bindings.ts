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
 * canonicalizeServiceName bridges newtron's two name surfaces: the
 * services list/detail echo the *authored* name ("OVERLAY_IRB_A"), but
 * the topology step `spec_name` (and intent) use the *canonical* form
 * ("overlay-irb-a"): lowercase, underscores → hyphens. newtron exposes
 * no authored↔canonical mapping, so we normalize both sides here. If
 * newtron's rule ever diverges, matching degrades to "no bindings",
 * never wrong ones.
 */
export function canonicalizeServiceName(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

/**
 * deriveServiceBindings returns every interface this service is applied
 * to, read from the topology's per-device `steps`. `topology` is the raw
 * GET /topology payload ({ devices: { <name>: { steps: [...] } } }).
 *
 * Matches on newtron's server-derived `spec_kind`/`spec_name` (newtron
 * #282) — the authoritative provenance, rather than decoding the step
 * params ourselves. `spec_name` is canonical while `serviceName` (from
 * the list/detail) is authored, so both are canonicalized for the
 * compare. The interface comes from the step URL. Tolerant of
 * missing/odd shapes — returns [] rather than throwing.
 */
export function deriveServiceBindings(topology: unknown, serviceName: string): ServiceBinding[] {
  const out: ServiceBinding[] = [];
  const target = canonicalizeServiceName(serviceName);

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
      if (s.spec_kind !== "service" || typeof s.spec_name !== "string"
        || canonicalizeServiceName(s.spec_name) !== target) continue;

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
