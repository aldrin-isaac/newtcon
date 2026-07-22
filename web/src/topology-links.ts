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

export interface SeatLink { id: string; tx: number; ty: number }

/** distributeSeats — place each of a node's incident link seats on its card
 *  PERIMETER, on the edge facing that neighbour, WITHOUT overlap. Links whose
 *  rays exit the same edge are grouped and spread with a minimum gap, centred
 *  on where they point — so links to different neighbours never collide and
 *  parallel links to the same neighbour fan out. Recomputed on every render,
 *  so dragging a node re-distributes both its own and its neighbours' seats.
 *
 *  c = card centre; hw/hh = half extents; standoff = px off the edge;
 *  gap = min px between seats on an edge; pad = px kept clear of each corner. */
export function distributeSeats(
  c: Pt, hw: number, hh: number, links: readonly SeatLink[],
  standoff = 2, gap = 16, pad = 12,
): Map<string, Pt> {
  type Slotted = { id: string; edge: "T" | "R" | "B" | "L"; along: number };
  const slotted: Slotted[] = links.map((l) => {
    const dx = l.tx - c.x, dy = l.ty - c.y;
    if (dx === 0 && dy === 0) return { id: l.id, edge: "R", along: c.y };
    // Which edge does the ray hit first? Compare normalized reach.
    if (Math.abs(dx) / hw >= Math.abs(dy) / hh) {
      const y = c.y + dy * (hw / Math.abs(dx));       // exit height on the L/R edge
      return { id: l.id, edge: dx > 0 ? "R" : "L", along: y };
    }
    const x = c.x + dx * (hh / Math.abs(dy));          // exit x on the T/B edge
    return { id: l.id, edge: dy > 0 ? "B" : "T", along: x };
  });

  const out = new Map<string, Pt>();
  for (const edge of ["T", "R", "B", "L"] as const) {
    const grp = slotted.filter((s) => s.edge === edge).sort((a, b) => a.along - b.along);
    if (grp.length === 0) continue;
    const vertical = edge === "L" || edge === "R";
    const half = vertical ? hh : hw;
    const lo = (vertical ? c.y : c.x) - half + pad;
    const hi = (vertical ? c.y : c.x) + half - pad;
    // Centre the group's total extent on the mean of where they point,
    // clamped inside [lo, hi]; place at even gaps preserving sort order.
    const total = (grp.length - 1) * gap;
    const mean = grp.reduce((a, s) => a + s.along, 0) / grp.length;
    let start = Math.min(Math.max(mean - total / 2, lo), Math.max(lo, hi - total));
    if (hi - lo < total) { start = lo; } // more links than fit: pack from lo (rare)
    const step = grp.length > 1 && hi - lo < total ? (hi - lo) / (grp.length - 1) : gap;
    grp.forEach((s, i) => {
      const alongPos = start + i * step;
      const seat: Pt = edge === "R" ? { x: c.x + hw + standoff, y: alongPos }
        : edge === "L" ? { x: c.x - hw - standoff, y: alongPos }
        : edge === "T" ? { x: alongPos, y: c.y - hh - standoff }
        : { x: alongPos, y: c.y + hh + standoff };
      out.set(s.id, seat);
    });
  }
  return out;
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

/** parseLagMembers — LAG_MEMBER_TABLE → per-PortChannel member ports.
 *  SONiC keys the table `PortChannel{n}:Ethernet{m}` (one row per member);
 *  fetchNodeDBTable strips the table prefix, so keys arrive as
 *  `PortChannel1:Ethernet0`. Split on the FIRST colon: left = the LAG, right
 *  = the member port. Members are returned in interface-name order so the
 *  tooltip reads stably. Empty/garbled keys are skipped. Backs the "members"
 *  row on a PortChannel endpoint's hover tip. */
export function parseLagMembers(raw: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!rec(raw)) return out;
  for (const key of Object.keys(raw)) {
    const sep = key.indexOf(":");
    if (sep <= 0) continue; // no lag or no member
    const lag = key.slice(0, sep);
    const member = key.slice(sep + 1);
    if (!lag || !member) continue;
    const list = out.get(lag) ?? [];
    if (!list.includes(member)) list.push(member);
    out.set(lag, list);
  }
  for (const list of out.values()) list.sort(comparePortName);
  return out;
}

/** comparePortName — numeric-aware interface ordering (Ethernet2 < Ethernet10). */
function comparePortName(a: string, b: string): number {
  const na = a.match(/\d+/), nb = b.match(/\d+/);
  const pa = a.replace(/\d+/, ""), pb = b.replace(/\d+/, "");
  if (pa === pb && na && nb) return Number(na[0]) - Number(nb[0]);
  return a.localeCompare(b);
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
