// interface-status.ts — pure shapers + formatters for the per-interface
// diagnostics panel (device drawer → Interfaces → expand a port). Backs the
// live operational read GET /nodes/{device}/interfaces/{iface}/status
// (newtron #431): admin/oper, cumulative counters, SONiC-computed rates
// (bps/pps + FEC BER), resolved ARP neighbors, LLDP far-end, and — on physical
// hardware only — transceiver optics.
//
// DOM rendering lives in app.ts (renderIfaceLiveStatus); everything here is
// pure so it's unit-tested without a browser. Fields are tolerant: newtron
// omits counters/rates where a platform doesn't populate COUNTERS_DB, omits
// lldp_peer when no neighbor is heard, and omits optics on -vs.

export interface IfaceCounters {
  rx_octets?: number; rx_unicast_packets?: number; rx_non_unicast_packets?: number;
  rx_discards?: number; rx_errors?: number;
  tx_octets?: number; tx_unicast_packets?: number; tx_non_unicast_packets?: number;
  tx_discards?: number; tx_errors?: number;
}

export interface IfaceRates {
  rx_bps?: number; rx_pps?: number; tx_bps?: number; tx_pps?: number;
  fec_pre_ber?: number; fec_post_ber?: number;
}

export interface IfaceNeighbor { address?: string; mac?: string; family?: string }

// IfaceMember — one member of a LAG (PortChannelN) or SVI (VlanN) bridge
// domain, from the kind-aware /status read (newtron #441). Omitted for
// physical ports.
export interface IfaceMember {
  name?: string;
  admin_status?: string;
  oper_status?: string;
  speed?: string;
}

export interface IfaceLldp {
  chassis_id?: string; port_id?: string; port_description?: string;
  system_name?: string; system_description?: string;
}

export interface InterfaceStatus {
  name?: string;
  admin_status?: string;
  oper_status?: string;
  speed?: string;
  mtu?: string;
  fec?: string;
  host_tx_ready?: string;
  counters?: IfaceCounters;
  rates?: IfaceRates;
  neighbors?: IfaceNeighbor[];
  lldp_peer?: IfaceLldp;
  optics?: Record<string, unknown>;
  members?: IfaceMember[];
}

// num coerces a wire value (number or numeric string) to a finite number, or
// undefined when it's absent/garbage.
function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

// formatBps renders a bits/sec rate with a scaled unit (bps → Tbps).
export function formatBps(bps: unknown): string {
  const v0 = num(bps);
  if (v0 === undefined || v0 < 0) return "—";
  const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let v = v0, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

// formatPps renders a packets/sec rate with a scaled unit (pps → Mpps).
export function formatPps(pps: unknown): string {
  const v0 = num(pps);
  if (v0 === undefined || v0 < 0) return "—";
  const units = ["pps", "Kpps", "Mpps"];
  let v = v0, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

// formatCount renders a cumulative counter as a grouped integer, or "—".
export function formatCount(v: unknown): string {
  const n = num(v);
  if (n === undefined) return "—";
  return Math.round(n).toLocaleString("en-US");
}

// lldpFarEnd summarizes the LLDP neighbor as "system · port", or null when no
// neighbor is heard. This is the wiring truth — what the port is actually
// cabled to — which is the single most useful signal for "is this link right".
export function lldpFarEnd(lldp: IfaceLldp | undefined | null): string | null {
  if (!lldp || typeof lldp !== "object") return null;
  const sys = lldp.system_name || lldp.chassis_id || "";
  const port = lldp.port_id || lldp.port_description || "";
  const parts = [sys, port].filter((s) => typeof s === "string" && s !== "");
  return parts.length ? parts.join(" · ") : null;
}

export interface CounterPair { label: string; rx: string; tx: string; alert: boolean }

// counterPairs turns the flat counter fields into labeled rx/tx display rows,
// flagging the two that indicate trouble (discards, errors) when non-zero.
export function counterPairs(c: IfaceCounters | undefined | null): CounterPair[] {
  if (!c || typeof c !== "object") return [];
  const pair = (label: string, rx: unknown, tx: unknown, alert = false): CounterPair =>
    ({ label, rx: formatCount(rx), tx: formatCount(tx), alert });
  const dAlert = (num(c.rx_discards) ?? 0) > 0 || (num(c.tx_discards) ?? 0) > 0;
  const eAlert = (num(c.rx_errors) ?? 0) > 0 || (num(c.tx_errors) ?? 0) > 0;
  return [
    pair("Octets", c.rx_octets, c.tx_octets),
    pair("Unicast", c.rx_unicast_packets, c.tx_unicast_packets),
    pair("Non-unicast", c.rx_non_unicast_packets, c.tx_non_unicast_packets),
    pair("Discards", c.rx_discards, c.tx_discards, dAlert),
    pair("Errors", c.rx_errors, c.tx_errors, eAlert),
  ];
}

// hasCounterAlerts is true when any error/discard counter is non-zero — used to
// surface a warning affordance on the panel header.
export function hasCounterAlerts(c: IfaceCounters | undefined | null): boolean {
  if (!c) return false;
  return (num(c.rx_errors) ?? 0) > 0 || (num(c.tx_errors) ?? 0) > 0
    || (num(c.rx_discards) ?? 0) > 0 || (num(c.tx_discards) ?? 0) > 0;
}

// STATE_DB's uint32 "no data" sentinel: -vs platforms report this for port
// speed because the virtual SAI never populates a real value (newtron #441
// wire note). Render as unknown, never as a literal.
const SPEED_SENTINEL = 4294967295;

// formatSpeed renders a SONiC port speed (Mbps as a string, e.g. "40000") as
// an operator-friendly "40G". Guards the -vs sentinel and garbage with "—".
export function formatSpeed(speed: unknown): string {
  const n = num(speed);
  if (n === undefined || n <= 0 || n >= SPEED_SENTINEL) return "—";
  if (n >= 1000) {
    const g = n / 1000;
    return `${Number.isInteger(g) ? g : g.toFixed(1)}G`;
  }
  return `${n}M`;
}

export interface MemberSummary { name: string; up: boolean; speed: string }

// memberSummaries shapes the kind-aware /status `members` array (LAG or SVI
// bridge-domain members) for display: name, an up/down flag (oper first,
// admin as fallback), and a sentinel-guarded speed. Entries without a name
// are dropped; wire order (sorted by name server-side) is preserved.
export function memberSummaries(members: IfaceMember[] | undefined | null): MemberSummary[] {
  if (!Array.isArray(members)) return [];
  return members
    .filter((m) => m && typeof m === "object" && typeof m.name === "string" && m.name !== "")
    .map((m) => ({
      name: m.name as string,
      up: (m.oper_status ?? m.admin_status) === "up",
      speed: formatSpeed(m.speed),
    }));
}

// neighborLines renders resolved ARP neighbors as "address → mac" strings.
// Per newtron's model APPL_DB carries only RESOLVED neighbors, so an EXPECTED
// peer being ABSENT here is the "ARP never resolved" signal — the caller
// interprets absence; this helper just formats what's present.
export function neighborLines(neighbors: IfaceNeighbor[] | undefined | null): string[] {
  if (!Array.isArray(neighbors)) return [];
  return neighbors
    .filter((n) => n && typeof n === "object" && n.address)
    .map((n) => `${n.address} → ${n.mac ?? "?"}`);
}
