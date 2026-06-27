// device-resources.ts — pure derivations for the device drawer's resource lens
// (the inverse of the interface table): "which services/resources are
// provisioned on this device, and on which interfaces."
//
// Service usage is read from the topology device's apply-service steps — the
// same source the interface table reads per-interface, grouped the other way
// (by service). Pure: no I/O, no DOM. Mirrors device-interfaces.ts.

import { comparePorts } from "./port-config.js";

export interface ServiceInstance {
  iface: string;
  vlan?: string;
  ip?: string;
  peerAs?: string;
}

export interface ServiceUsage {
  service: string;
  instances: ServiceInstance[];
}

interface TopoDeviceEntry { steps?: unknown[] }

const str = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s === "" ? undefined : s;
};

/**
 * deviceServiceUsage groups a topology device's apply-service steps by service,
 * each with the interfaces it's applied to (+ per-instance vlan/ip/peer-AS).
 * Services are sorted by name; instances by interface (numeric).
 */
export function deviceServiceUsage(entry: TopoDeviceEntry | null | undefined): ServiceUsage[] {
  const steps = Array.isArray(entry?.steps) ? entry!.steps! : [];
  const byService = new Map<string, ServiceInstance[]>();
  for (const raw of steps) {
    const step = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const url = typeof step.url === "string" ? step.url : "";
    const m = url.match(/^\/interfaces\/(.+)\/apply-service$/);
    if (!m) continue;
    const iface = m[1]!;
    const params = step.params && typeof step.params === "object" ? step.params as Record<string, unknown> : {};
    const service = str(step.spec_name) ?? str(params.service);
    if (!service) continue;
    const inst: ServiceInstance = { iface };
    const vlan = str(params.vlan);
    const ip = str(params.ip_address);
    const peerAs = str(params.peer_as);
    if (vlan !== undefined) inst.vlan = vlan;
    if (ip !== undefined) inst.ip = ip;
    if (peerAs !== undefined) inst.peerAs = peerAs;
    const list = byService.get(service) ?? [];
    list.push(inst);
    byService.set(service, list);
  }
  return Array.from(byService, ([service, instances]) => ({
    service,
    instances: instances.sort((a, b) => comparePorts(a.iface, b.iface)),
  })).sort((a, b) => a.service.localeCompare(b.service));
}

/** countServiceInstances totals the interface bindings across all services. */
export function countServiceInstances(usage: readonly ServiceUsage[]): number {
  return usage.reduce((n, u) => n + u.instances.length, 0);
}

// ---- Tailored State tables (VLANs / VRFs / ACLs) --------------------------
// The State sub-sections rendered every resource via a generic auto-table that
// dumped whatever keys newtron returned. shapeResourceRows picks a curated,
// ordered column set per resource so the tables are scannable. Empty/absent
// cells render as "—"; numeric 0 stays "0" (a real count, not "missing").

export interface ResourceColumn { key: string; label: string }

export interface ResourceTable { headers: string[]; rows: string[][] }

export function shapeResourceRows(data: unknown, columns: readonly ResourceColumn[]): ResourceTable {
  const list = Array.isArray(data) ? data : [];
  const headers = columns.map((c) => c.label);
  const rows = list
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => columns.map((c) => {
      const v = r[c.key];
      return v === undefined || v === null || v === "" ? "—" : String(v);
    }));
  return { headers, rows };
}

// Curated columns per resource (keys match newtron's list shapes).
export const VRF_COLUMNS: ResourceColumn[] = [
  { key: "name", label: "VRF" },
  { key: "state", label: "State" },
  { key: "interfaces", label: "Interfaces" },
];
export const VLAN_COLUMNS: ResourceColumn[] = [
  { key: "id", label: "VLAN" },
  { key: "name", label: "Name" },
  { key: "member_count", label: "Members" },
];
export const ACL_COLUMNS: ResourceColumn[] = [
  { key: "name", label: "ACL" },
  { key: "type", label: "Type" },
  { key: "stage", label: "Stage" },
  { key: "rule_count", label: "Rules" },
  { key: "interfaces", label: "Interfaces" },
];
