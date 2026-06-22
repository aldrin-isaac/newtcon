// service-references.ts — the reverse index of the cross-link chips:
// given a resource (IP-VPN, MAC-VPN, filter, QoS/route policy, prefix
// list), which services reference it, and through which field.
//
// A service spec's references live in its own fields — ipvpn / macvpn /
// ingress_filter / egress_filter / qos_policy, plus the nested routing
// block (import_policy / export_policy / import_prefix_list /
// export_prefix_list). The schema says which of those are refs and to
// which kind (ref_kind), so the caller derives the field set per target
// kind from the schema — no field names hardcoded here.
//
// Pure + DOM-free (unit-testable); the renderer + schema resolution live
// in app.ts.

/** A service field that may reference the target kind. `path` is the
 *  nested accessor (e.g. ["routing","import_policy"]); `label` is the
 *  operator-facing field name for the "via" annotation. */
export interface RefFieldDescriptor {
  path: string[];
  label: string;
}

/** A service that references the target, and through which field(s). */
export interface ServiceReference {
  service: string;
  via: string[];
}

function readPath(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * deriveServiceReferences returns the services that reference `targetName`
 * through any of `refFields`. Match is exact on the spec name (service
 * ref values are spec names, same domain — no canonicalization). A
 * service referencing the target via two fields (e.g. ingress + egress
 * filter) lists both labels. Sorted by service name.
 */
export function deriveServiceReferences(
  services: ReadonlyArray<{ name: string; detail: unknown }>,
  refFields: readonly RefFieldDescriptor[],
  targetName: string,
): ServiceReference[] {
  const out: ServiceReference[] = [];
  for (const s of services) {
    const via: string[] = [];
    for (const rf of refFields) {
      const v = readPath(s.detail, rf.path);
      if (typeof v === "string" && v === targetName) via.push(rf.label);
    }
    if (via.length > 0) out.push({ service: s.name, via });
  }
  out.sort((a, b) => a.service.localeCompare(b.service));
  return out;
}
