// topology-links.ts — pure link-truth derivations (uplift 4.2, #422).
//
// Sources (one bulk read per device, fetched at topology mount):
//   APPL_DB/LLDP_ENTRY_TABLE  — what each device actually hears on each port
//   APPL_DB/PORT_TABLE        — actuated port speed (thickness)
//   bgp/check                 — underlay session health per device
//
// The verdict vocabulary is the operator's: a link is VERIFIED when LLDP on
// either end hears exactly the far end the topology intends, INTENT-ONLY when
// nothing is heard yet (dashed — same law as spec-only nodes), and MISMATCH
// when a device hears a DIFFERENT far end than intended (mis-cable).
// Pure: no I/O, no DOM.

export interface TopoLinkEnds {
  local_device?: string;
  local_interface?: string;
  remote_device?: string;
  remote_interface?: string;
}

export interface LldpNeighbor {
  port: string;
  remoteSystem?: string;
  remotePort?: string;
}

const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** parseLldpTable — tolerant reader for newtron's LLDP_ENTRY_TABLE dump.
 *  Keys may be bare ports ("Ethernet0") or prefixed ("LLDP_ENTRY_TABLE:Ethernet0"). */
export function parseLldpTable(raw: unknown): LldpNeighbor[] {
  if (!rec(raw)) return [];
  const out: LldpNeighbor[] = [];
  for (const [key, val] of Object.entries(raw)) {
    if (!rec(val)) continue;
    const port = key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key;
    const n: LldpNeighbor = { port };
    const sys = str(val.lldp_rem_sys_name);
    const rport = str(val.lldp_rem_port_id) ?? str(val.lldp_rem_port_desc);
    if (sys !== undefined) n.remoteSystem = sys;
    if (rport !== undefined) n.remotePort = rport;
    out.push(n);
  }
  return out;
}

/** SONiC's virtual platforms report this sentinel when speed is unknowable. */
const SPEED_SENTINEL = "4294967295";

/** parsePortSpeeds — PORT_TABLE → Map(port → speed in Mbps). Sentinel and
 *  non-numeric speeds are omitted (callers fall back to default thickness). */
export function parsePortSpeeds(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!rec(raw)) return out;
  for (const [key, val] of Object.entries(raw)) {
    if (!rec(val)) continue;
    const port = key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key;
    const s = str(val.speed);
    if (s === undefined || s === SPEED_SENTINEL) continue;
    const mbps = Number(s);
    if (Number.isFinite(mbps) && mbps > 0) out.set(port, mbps);
  }
  return out;
}

export interface Pt { x: number; y: number }

/** perimeterSeat — the point on a card's rectangle edge (half-width hw,
 *  half-height hh, centre c) along the ray toward `toward`, pushed out by
 *  `standoff`. This is where a link terminates and its status dot seats —
 *  the dot becomes the port. Degenerate (same centre) returns c. */
export function perimeterSeat(c: Pt, toward: Pt, hw: number, hh: number, standoff = 0): Pt {
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return { x: c.x, y: c.y };
  // Scale the ray to the nearest edge: t = 1 / max(|dx|/hw, |dy|/hh).
  const t = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  const ex = c.x + dx * t, ey = c.y + dy * t;
  const len = Math.hypot(dx, dy) || 1;
  return { x: ex + (dx / len) * standoff, y: ey + (dy / len) * standoff };
}

export interface PortState {
  admin?: string;
  oper?: string;
  speedMbps?: number;
  mtu?: string;
}

/** parsePortStates — PORT_TABLE → per-port admin/oper/speed/mtu. Same
 *  key-normalization as parsePortSpeeds; ports with no useful field are
 *  omitted. Backs the per-link-end interface-state dots. */
export function parsePortStates(raw: unknown): Map<string, PortState> {
  const out = new Map<string, PortState>();
  if (!rec(raw)) return out;
  for (const [key, val] of Object.entries(raw)) {
    if (!rec(val)) continue;
    const port = key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key;
    const admin = str(val.admin_status);
    const oper = str(val.oper_status);
    const speedRaw = str(val.speed);
    const mtu = str(val.mtu);
    if (admin === undefined && oper === undefined && speedRaw === undefined && mtu === undefined) continue;
    const st: PortState = {};
    if (admin !== undefined) st.admin = admin;
    if (oper !== undefined) st.oper = oper;
    if (mtu !== undefined) st.mtu = mtu;
    if (speedRaw !== undefined && speedRaw !== SPEED_SENTINEL) {
      const mbps = Number(speedRaw);
      if (Number.isFinite(mbps) && mbps > 0) st.speedMbps = mbps;
    }
    if (Object.keys(st).length > 0) out.set(port, st); // all-sentinel → nothing useful
  }
  return out;
}

export type PortDotState = "ok" | "down" | "admin-down" | "unknown";

const upRe = /^(up|oper_up|1|true)$/i;

/** portDotState — an interface's visual state for its endpoint dot:
 *  ok       oper up (green — the link is live)
 *  down     admin up but oper NOT up (red — should be up, isn't)
 *  admin-down  admin down (grey — intentionally out of service)
 *  unknown  no admin/oper data (hollow — undeployed / unread). */
export function portDotState(st: PortState | undefined): PortDotState {
  if (!st || (st.admin === undefined && st.oper === undefined)) return "unknown";
  if (st.admin !== undefined && !upRe.test(st.admin)) return "admin-down";
  if (st.oper !== undefined) return upRe.test(st.oper) ? "ok" : "down";
  return "unknown";
}

/** portDotTooltip — the hover line for an endpoint dot. */
export function portDotTooltip(iface: string, st: PortState | undefined): string {
  const parts = [iface];
  parts.push(`admin: ${st?.admin ?? "—"}`);
  parts.push(`oper: ${st?.oper ?? "—"}`);
  if (st?.speedMbps !== undefined) parts.push(`${st.speedMbps} Mbps`);
  if (st?.mtu !== undefined) parts.push(`MTU ${st.mtu}`);
  return parts.join(" · ");
}

export type LinkVerdict = "verified" | "intent-only" | "mismatch";

/** classifyLink — compare the topology's intended far end against what LLDP
 *  actually hears, checking both directions. Either direction hearing the
 *  intended device verifies the link; a direction hearing a DIFFERENT device
 *  is a mis-cable. Silence (no LLDP rows for the port) is intent-only. */
export function classifyLink(link: TopoLinkEnds, lldpByDevice: Map<string, LldpNeighbor[]>): LinkVerdict {
  const dirs: Array<{ dev: string | undefined; port: string | undefined; wantSys: string | undefined; wantPort: string | undefined }> = [
    { dev: link.local_device, port: link.local_interface, wantSys: link.remote_device, wantPort: link.remote_interface },
    { dev: link.remote_device, port: link.remote_interface, wantSys: link.local_device, wantPort: link.local_interface },
  ];
  let verdict: LinkVerdict = "intent-only";
  for (const d of dirs) {
    if (!d.dev || !d.port || !d.wantSys) continue;
    const heard = (lldpByDevice.get(d.dev) ?? []).find((n) => n.port === d.port);
    if (!heard) continue;
    if (heard.remoteSystem === undefined) continue; // row without identity — stay silent
    if (heard.remoteSystem !== d.wantSys) return "mismatch";
    if (heard.remotePort !== undefined && d.wantPort !== undefined && heard.remotePort !== d.wantPort) return "mismatch";
    verdict = "verified";
  }
  return verdict;
}

/** linkStrokeWidth — configured speed → stroke px. Unknown speeds get the
 *  base width so spec-only fabrics stay visually calm. */
export function linkStrokeWidth(speedMbps?: number): number {
  if (speedMbps === undefined) return 1.5;
  if (speedMbps >= 100000) return 3;
  if (speedMbps >= 40000) return 2.5;
  if (speedMbps >= 10000) return 2;
  return 1.5;
}

/** linkSpeedForLink — the link's configured speed is the min of its two
 *  endpoint ports (a 100G port cabled to a 10G port runs at the lower). */
export function linkSpeedForLink(link: TopoLinkEnds, speedsByDevice: Map<string, Map<string, number>>): number | undefined {
  const ends = [
    { dev: link.local_device, port: link.local_interface },
    { dev: link.remote_device, port: link.remote_interface },
  ];
  const known = ends
    .map((e) => (e.dev && e.port ? speedsByDevice.get(e.dev)?.get(e.port) : undefined))
    .filter((v): v is number => v !== undefined);
  if (known.length === 0) return undefined;
  return Math.min(...known);
}

export type UnderlayState = "ok" | "down" | "unknown";

/** parseBgpCheckOk — newtron's bgp/check → healthy? Tolerant: an explicit
 *  ok/pass boolean, a status string, or a checks list all count; anything
 *  reporting failure is down; unreadable shapes are unknown. */
export function parseBgpCheckOk(raw: unknown): UnderlayState {
  // newtron's live shape is a bare rows array ({check, status, message}…).
  if (Array.isArray(raw)) return checkRows(raw);
  if (!rec(raw)) return "unknown";
  if (typeof raw.ok === "boolean") return raw.ok ? "ok" : "down";
  const status = str(raw.status);
  if (status !== undefined) return /^(ok|pass|healthy|established)$/i.test(status) ? "ok" : "down";
  const checks = Array.isArray(raw.checks) ? raw.checks : Array.isArray(raw.results) ? raw.results : null;
  if (checks) return checkRows(checks);
  return "unknown";
}

function checkRows(rows: unknown[]): UnderlayState {
  let saw = false;
  for (const c of rows) {
    if (!rec(c)) continue;
    const s = str(c.status);
    if (s === undefined) continue;
    saw = true;
    if (!/^(ok|pass|healthy|established|up)$/i.test(s)) return "down";
  }
  return saw ? "ok" : "unknown";
}

/** linkUnderlayState — a link's underlay health is the worst of its ends. */
export function linkUnderlayState(link: TopoLinkEnds, byDevice: Map<string, UnderlayState>): UnderlayState {
  const a = link.local_device ? byDevice.get(link.local_device) ?? "unknown" : "unknown";
  const z = link.remote_device ? byDevice.get(link.remote_device) ?? "unknown" : "unknown";
  if (a === "down" || z === "down") return "down";
  if (a === "ok" && z === "ok") return "ok";
  return "unknown";
}
