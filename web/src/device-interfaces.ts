// device-interfaces.ts — pure join that turns a device's scattered facts into
// one sorted, holistic per-interface view for the device drawer.
//
// A device's interface story is spread across five sources today: the platform
// inventory (every front-panel port — the menu), the topology port config
// (declared admin/mtu/speed), the live interface read (oper/admin/speed/mtu/
// pc_member), the service bindings + interface-config recorded as topology
// steps, and the topology links (neighbors). This module joins them into one
// InterfaceRow per inventory port — including ports with no config, which are
// the ones an operator can apply a service/config to next.
//
// Pure: no I/O, no DOM. Mirrors buildPicker / deriveServiceBindings.

import { comparePorts } from "./port-config.js";
import { parseDeviceSteps } from "./device-steps.js";

export interface PlatformPort {
  name: string;
  nic_index?: number;
  speed?: string;
  lanes?: number[];
}

/** Live interface read shape (newtron /nodes/{d}/interfaces[/{name}]). */
export interface LiveIface {
  name: string;
  admin_status?: string;
  oper_status?: string;
  speed?: string;   // Mbps as string, e.g. "40000"
  mtu?: number | string;
  pc_member?: boolean;
  [k: string]: unknown;
}

/** Per-interface binding derived from topology steps (apply-service / configure-interface). */
export interface IfaceBinding {
  service?: string;
  vlan?: string;       // access vlan or comma-joined trunk vlans
  vrf?: string;
  ip?: string;
  peerAs?: string;
  mode?: "access" | "trunk" | "routed";
}

export type IfaceStatus = "up" | "down" | "unknown";
export type IfaceRole =
  | "routed" | "access" | "trunk" | "lag-member" | "linked" | "configured" | "available";

export interface InterfaceRow {
  name: string;
  status: IfaceStatus;
  /** Operational detail label (admin/oper) for the expanded row. */
  adminStatus?: string;
  operStatus?: string;
  role: IfaceRole;
  speed?: string;       // normalized ("40G")
  mtu?: number | string;
  /** One-line L2/L3 summary (VLAN / VRF / IP) — "" when none. */
  l2l3: string;
  service: string;      // bound service name, "" when none
  link: string;         // neighbor "device:iface", "" when none
  /** True when no service is bound — the port can have a service applied. */
  canApplyService: boolean;
  /** True for a port with no config, service, or link at all. */
  available: boolean;
  /** Raw config + live for the expanded detail (no re-fetch). */
  config: Record<string, unknown>;
  live: Record<string, unknown> | null;
  binding: IfaceBinding | null;
}

interface TopoDeviceEntry {
  steps?: unknown[];
  ports?: Record<string, Record<string, unknown>>;
}

interface TopoLink { a?: string; z?: string; }

/** normalizeSpeed turns SONiC's Mbps string ("40000") into "40G"; passes
 *  through values already suffixed ("40G") or empty. */
export function normalizeSpeed(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "";
  const s = String(raw);
  if (/^\d+$/.test(s)) {
    const mbps = parseInt(s, 10);
    if (mbps % 1000 === 0) return `${mbps / 1000}G`;
    return `${mbps}M`;
  }
  return s;
}

/** deriveDeviceBindings walks a topology device's steps and returns the
 *  per-interface binding (service + interface-config) keyed by interface. */
export function deriveDeviceBindings(entry: TopoDeviceEntry | null | undefined): Map<string, IfaceBinding> {
  const out = new Map<string, IfaceBinding>();
  for (const step of parseDeviceSteps(entry?.steps)) {
    if (!step.iface || (step.verb !== "apply-service" && step.verb !== "configure-interface")) continue;
    const iface = step.iface;
    const verb = step.verb;
    const params = step.params;
    const cur = out.get(iface) ?? {};
    if (verb === "apply-service") {
      const svc = step.specName ?? strOrUndef(params.service);
      if (svc) cur.service = svc;
      assignIf(cur, "ip", strOrUndef(params.ip_address));
      assignIf(cur, "vlan", strOrUndef(params.vlan));
      assignIf(cur, "peerAs", strOrUndef(params.peer_as));
    } else {
      // configure-interface: tagged=false → access, tagged=true → trunk, vrf/ip → routed
      const vrf = strOrUndef(params.vrf);
      const ip = strOrUndef(params.ip);
      const vlanId = strOrUndef(params.vlan_id);
      if (vrf || ip) { cur.mode = "routed"; assignIf(cur, "vrf", vrf); assignIf(cur, "ip", ip); }
      else if (params.tagged === true) { cur.mode = "trunk"; if (vlanId) cur.vlan = mergeVlan(cur.vlan, vlanId); }
      else if (params.tagged === false) { cur.mode = "access"; assignIf(cur, "vlan", vlanId); }
    }
    out.set(iface, cur);
  }
  return out;
}

/** linksForDevice maps each of a device's interfaces to its link neighbor. */
export function linksForDevice(links: unknown, device: string): Map<string, string> {
  const out = new Map<string, string>();
  const arr = Array.isArray(links) ? links as TopoLink[] : [];
  for (const l of arr) {
    for (const [side, other] of [[l.a, l.z], [l.z, l.a]] as Array<[string | undefined, string | undefined]>) {
      if (typeof side !== "string" || typeof other !== "string") continue;
      const [dev, iface] = splitEndpoint(side);
      if (dev === device && iface) out.set(iface, other);
    }
  }
  return out;
}

export interface BuildViewInput {
  inventory: readonly PlatformPort[];
  topoPorts: Record<string, Record<string, unknown>> | undefined;
  live: readonly LiveIface[] | undefined;
  bindings: Map<string, IfaceBinding>;
  links: Map<string, string>;
}

/**
 * buildDeviceInterfaceView joins the five sources into one sorted row per
 * inventory port. Every platform port appears (configured or available), so the
 * operator sees the whole port surface and which ports are free to use.
 */
export function buildDeviceInterfaceView(input: BuildViewInput): InterfaceRow[] {
  const topo = input.topoPorts ?? {};
  const liveByName = new Map<string, LiveIface>();
  for (const li of input.live ?? []) if (li && typeof li.name === "string") liveByName.set(li.name, li);

  // Inventory is the menu; fall back to topo/live keys if inventory is empty
  // (non-SONiC platforms, or inventory unavailable).
  const names = input.inventory.length > 0
    ? input.inventory.map((p) => p.name)
    : Array.from(new Set([...Object.keys(topo), ...liveByName.keys()]));

  const invByName = new Map<string, PlatformPort>();
  for (const p of input.inventory) invByName.set(p.name, p);

  const rows = names.map((name) => {
    const inv = invByName.get(name);
    const cfg = topo[name] ?? {};
    const live = liveByName.get(name) ?? null;
    const binding = input.bindings.get(name) ?? null;
    const link = input.links.get(name) ?? "";

    const hasConfig = Object.keys(cfg).length > 0;
    const adminStatus = strOrUndef(live?.admin_status) ?? strOrUndef(cfg.admin_status);
    const operStatus = strOrUndef(live?.oper_status);
    const status: IfaceStatus = operStatus === "up" ? "up"
      : operStatus === "down" ? "down"
      : adminStatus === "up" ? "up"
      : adminStatus === "down" ? "down"
      : "unknown";

    const speed = normalizeSpeed(live?.speed ?? cfg.speed ?? inv?.speed);
    const mtu = (live?.mtu ?? cfg.mtu) as number | string | undefined;
    const service = binding?.service ?? "";
    const pcMember = live?.pc_member === true;

    const role: IfaceRole =
      binding?.mode === "routed" || binding?.vrf || binding?.ip ? "routed"
      : binding?.mode === "trunk" ? "trunk"
      : binding?.mode === "access" ? "access"
      : service ? "routed" // a bound service implies L3 intent until typed finer
      : pcMember ? "lag-member"
      : link ? "linked"
      : hasConfig ? "configured"
      : "available";

    const l2l3 = [
      binding?.vrf ? `VRF ${binding.vrf}` : "",
      binding?.ip ? binding.ip : "",
      binding?.vlan ? `VLAN ${binding.vlan}` : "",
    ].filter(Boolean).join(" · ");

    const row: InterfaceRow = {
      name,
      status,
      role,
      l2l3,
      service,
      link,
      canApplyService: service === "",
      available: role === "available",
      config: cfg,
      live: live as Record<string, unknown> | null,
      binding,
    };
    if (adminStatus !== undefined) row.adminStatus = adminStatus;
    if (operStatus !== undefined) row.operStatus = operStatus;
    if (speed) row.speed = speed;
    if (mtu !== undefined) row.mtu = mtu;
    return row;
  });

  rows.sort((a, b) => comparePorts(a.name, b.name));
  return rows;
}

export interface ViewCounts { total: number; configured: number; up: number; available: number; }

/** countView summarizes a built view for the header. */
export function countView(rows: readonly InterfaceRow[]): ViewCounts {
  return {
    total: rows.length,
    configured: rows.filter((r) => !r.available).length,
    up: rows.filter((r) => r.status === "up").length,
    available: rows.filter((r) => r.available).length,
  };
}

export type ViewFilter = "all" | "configured" | "available" | "up";

/** applyFilter narrows rows by the active segment. */
export function applyFilter(rows: readonly InterfaceRow[], filter: ViewFilter, query: string): InterfaceRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === "configured" && r.available) return false;
    if (filter === "available" && !r.available) return false;
    if (filter === "up" && r.status !== "up") return false;
    if (q && !(`${r.name} ${r.role} ${r.service} ${r.l2l3} ${r.link}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

// ---- small helpers -------------------------------------------------------

function strOrUndef(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s === "" ? undefined : s;
}
function assignIf(o: IfaceBinding, k: keyof IfaceBinding, v: string | undefined): void {
  if (v !== undefined) (o as Record<string, unknown>)[k] = v;
}
function mergeVlan(existing: string | undefined, add: string): string {
  if (!existing) return add;
  const set = new Set(existing.split(",").map((s) => s.trim()).filter(Boolean));
  set.add(add);
  return Array.from(set).join(",");
}
function splitEndpoint(s: string): [string, string] {
  const i = s.indexOf(":");
  return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ""];
}
