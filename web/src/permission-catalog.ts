// permission-catalog.ts — curated per-permission descriptions + group
// assignments. Drives the Permissions tab so the operator reads
// "Bind IP VPN to interface" instead of `vrf.bind`.
//
// Canonical source is newtron (see ../newtron/docs/newtron/authorization-
// howto.md and the live `GET /authorization` payload). Newtron does not
// expose per-permission descriptions over HTTP today — those would
// require a newtron-side ticket. Curated here in newtcon for v1; if
// newtron later ships a description endpoint, this catalog becomes the
// fallback for permissions newtron's response doesn't cover.
//
// Falls back gracefully: a permission newtcon hasn't catalogued yet
// renders with the bare wire name as both title and description, in
// the "Other" group, so a new newtron permission shows up legibly even
// before the catalog is updated.

/** Permission group ID — stable across the UI for state + CSS. */
export type PermissionGroupId =
  | "spec"
  | "service"
  | "interface"
  | "vlan"
  | "qos"
  | "filters"
  | "routing"
  | "device"
  | "other";

interface PermissionGroup {
  id: PermissionGroupId;
  label: string;
  /** Membership predicate — a permission name belongs here if this returns true. */
  matches: (name: string) => boolean;
}

/**
 * Order matters: the first matching group wins, so put more specific
 * matchers (`service.apply` → "Services") before broader ones.
 *
 * "Other" is the implicit catch-all; permissions matching nothing land
 * there. Not listed here — the resolver adds it.
 */
const GROUPS: PermissionGroup[] = [
  { id: "spec",      label: "Spec authoring",  matches: (p) => p === "spec.author" || p.startsWith("spec.") },
  { id: "service",   label: "Services",        matches: (p) => p.startsWith("service.") },
  { id: "device",    label: "Device admin",    matches: (p) => p === "device.write" || p.startsWith("device.") },
  { id: "interface", label: "Interface config", matches: (p) => p === "interface.modify" },
  { id: "vlan",      label: "VLANs & LAGs",    matches: (p) => p.startsWith("vlan.") || p.startsWith("lag.") },
  { id: "qos",       label: "QoS",             matches: (p) => p.startsWith("qos.") },
  { id: "filters",   label: "Filters & ACLs",  matches: (p) => p.startsWith("filter.") || p.startsWith("acl.") },
  { id: "routing",   label: "Routing (BGP / EVPN / VRF)", matches: (p) => p.startsWith("bgp.") || p.startsWith("evpn.") || p.startsWith("vrf.") },
];

/**
 * GROUP_ORDER is the operator-friendly display order — service-authoring
 * surfaces (what most operators care about day-to-day) first, plumbing
 * (BGP / VRF) after, "Other" last so unknowns trail the explicit groups.
 */
export const GROUP_ORDER: PermissionGroupId[] = [
  "spec", "service", "interface", "vlan", "qos", "filters", "routing", "device", "other",
];

/** Human label for a group ID. */
const GROUP_LABEL: Record<PermissionGroupId, string> = {
  spec: "Spec authoring",
  service: "Services",
  interface: "Interface config",
  vlan: "VLANs & LAGs",
  qos: "QoS",
  filters: "Filters & ACLs",
  routing: "Routing (BGP / EVPN / VRF)",
  device: "Device admin",
  other: "Other",
};

export function groupLabelFor(id: PermissionGroupId): string {
  return GROUP_LABEL[id];
}

/** Per-permission human description. */
export interface PermissionDescription {
  /** Operator-readable title (replaces the wire name in the Permissions tab). */
  title: string;
  /** One-sentence explanation of what holding the permission lets the operator do. */
  body: string;
}

/**
 * DESCRIPTIONS is the curated map. Sampled from the live grant table on
 * the dev newtron + cross-referenced with newtron's authorization-howto.
 * Add entries when newtron grows a new permission.
 */
const DESCRIPTIONS: Record<string, PermissionDescription> = {
  // Spec authoring
  "spec.author": {
    title: "Author specs",
    body: "Create or modify spec files (services, nodes, zones, VPNs) in network.json.",
  },

  // Services
  "service.apply": {
    title: "Apply service to interface",
    body: "Bind a defined service to a device interface so its config rolls out.",
  },
  "service.remove": {
    title: "Remove service from interface",
    body: "Unbind a service from an interface, removing the device-level config.",
  },

  // Device admin
  "device.write": {
    title: "Write device config",
    body: "Direct device-level writes outside the spec / interface flow (init-device, setup-device, daemon control).",
  },

  // Interface config
  "interface.modify": {
    title: "Modify interface",
    body: "Change per-interface attributes — mode (access/trunk/routed), MTU, description, admin state.",
  },

  // VLANs
  "vlan.create":  { title: "Create VLAN", body: "Define a new VLAN on a device." },
  "vlan.delete":  { title: "Delete VLAN", body: "Remove a VLAN definition from a device." },
  "vlan.modify":  { title: "Modify VLAN", body: "Change a VLAN's attributes (description, IP, MTU)." },

  // LAGs
  "lag.create":   { title: "Create LAG", body: "Define a link aggregation group." },
  "lag.delete":   { title: "Delete LAG", body: "Remove a LAG." },
  "lag.modify":   { title: "Modify LAG", body: "Change LAG member ports or attributes." },

  // QoS
  "qos.create":   { title: "Create QoS policy", body: "Define a new QoS policy spec." },
  "qos.delete":   { title: "Delete QoS policy", body: "Remove a QoS policy." },
  "qos.modify":   { title: "Modify QoS policy", body: "Change a QoS policy's queues, weights, or shaping." },

  // Filters / ACLs
  "filter.create": { title: "Create filter",  body: "Define a new packet-filter spec." },
  "filter.delete": { title: "Delete filter",  body: "Remove a packet-filter spec." },
  "acl.create":    { title: "Create ACL",     body: "Define a new access-control list on a device." },
  "acl.delete":    { title: "Delete ACL",     body: "Remove an access-control list." },
  "acl.modify":    { title: "Modify ACL",     body: "Change an ACL's rules." },

  // BGP / EVPN
  "bgp.peer":      { title: "Configure BGP peer",  body: "Add or remove a per-interface BGP peer (direct-BGP case)." },
  "evpn.peer":     { title: "Configure EVPN peer", body: "Add or remove an EVPN BGP peer." },
  "evpn.macvpn":   { title: "Bind MAC VPN to VLAN", body: "Attach a MAC VPN to a VLAN on a device." },

  // VRF
  "vrf.bind":      { title: "Bind IP VPN to interface", body: "Attach an IP VPN to a per-interface VRF." },
  "vrf.route":     { title: "Add static route",         body: "Add or remove a static route inside a VRF." },
  "vrf.create":    { title: "Create VRF",               body: "Define a new VRF." },
  "vrf.delete":    { title: "Delete VRF",               body: "Remove a VRF." },
};

/**
 * describePermission returns the curated entry for a permission name.
 * Falls back to {title: name, body: ""} so unknown permissions still
 * render legibly with the wire name visible to the operator.
 */
export function describePermission(name: string): PermissionDescription {
  return DESCRIPTIONS[name] ?? { title: name, body: "" };
}

/**
 * groupFor returns the group ID a permission belongs to. Permissions
 * not matching any explicit group land in "other".
 */
export function groupFor(name: string): PermissionGroupId {
  for (const g of GROUPS) {
    if (g.matches(name)) return g.id;
  }
  return "other";
}

/**
 * groupPermissions partitions a list of permission names by group,
 * returning a Map keyed by group ID in GROUP_ORDER. Empty groups are
 * omitted so the renderer doesn't draw empty sections.
 */
export function groupPermissions(names: string[]): Map<PermissionGroupId, string[]> {
  const buckets = new Map<PermissionGroupId, string[]>();
  for (const name of names) {
    const id = groupFor(name);
    const arr = buckets.get(id) ?? [];
    arr.push(name);
    buckets.set(id, arr);
  }
  // Sort within each bucket alphabetically; preserve GROUP_ORDER outside.
  for (const arr of buckets.values()) arr.sort((a, b) => a.localeCompare(b));
  const ordered = new Map<PermissionGroupId, string[]>();
  for (const id of GROUP_ORDER) {
    const arr = buckets.get(id);
    if (arr && arr.length > 0) ordered.set(id, arr);
  }
  return ordered;
}
