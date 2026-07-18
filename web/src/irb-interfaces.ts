// irb-interfaces.ts — pure derivation for the device drawer's "IRB interfaces
// (VLAN)" section: the join that turns three partial views of a device's VLAN
// interfaces (SVIs) into one row list:
//
//   - the LIVE read (GET /nodes/{d}/vlans — id/svi/l2_vni/macvpn/members),
//     absent when the device is unreachable;
//   - the TOPOLOGY intent (device steps: /create-vlan authors the VLAN,
//     /interfaces/Vlan{N}/apply-service binds the irb service, /bind-macvpn
//     carries the macvpn linkage) — the authoritative offline view;
//   - the PENDING queue (staged create-vlan device actions not yet applied).
//
// A VlanN interface isn't declared like a physical port: it comes into
// existence when VLAN N exists (create-vlan → vlanmgr materializes the VlanN
// netdev), and an irb-type service is applied ON it (newtron #434–#438).
// Membership stays per-port and is not this section's concern.
//
// DOM rendering lives in app.ts (renderIrbSection); everything here is pure.

export interface IrbRow {
  /** Interface name, e.g. "Vlan100". */
  name: string;
  vlanId: number;
  /** Live SVI oper state ("up"/"down") — absent when device unreachable. */
  svi?: string;
  l2Vni?: number;
  macvpn?: string;
  memberCount?: number;
  /** Live member list, e.g. ["Ethernet2(t)"]. */
  members?: string[];
  /** irb service bound on this SVI (from topology intent apply-service). */
  service?: string;
  /** Strongest evidence for this row: live device > topology intent > queued. */
  source: "live" | "intent" | "pending";
}

interface StepLike { url?: unknown; params?: unknown }

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function param(step: StepLike, key: string): unknown {
  const p = step.params;
  if (!p || typeof p !== "object") return undefined;
  return (p as Record<string, unknown>)[key];
}

/**
 * deriveIrbRows merges the three views into sorted rows (ascending VLAN id).
 * Tolerant of malformed/missing inputs — an unreachable device or an empty
 * topology entry just narrows the sources.
 */
export function deriveIrbRows(input: {
  steps?: unknown;
  liveVlans?: unknown;
  pendingVlanIds?: readonly number[];
}): IrbRow[] {
  const byId = new Map<number, IrbRow>();
  const upsert = (id: number): IrbRow => {
    let row = byId.get(id);
    if (!row) { row = { name: `Vlan${id}`, vlanId: id, source: "pending" }; byId.set(id, row); }
    return row;
  };

  // Pending (weakest source — listed so the operator sees the staged SVI).
  for (const id of input.pendingVlanIds ?? []) {
    const n = num(id);
    if (n !== undefined && n >= 1 && n <= 4094) upsert(n);
  }

  // Topology intent.
  const steps: StepLike[] = Array.isArray(input.steps)
    ? (input.steps.filter((s) => s && typeof s === "object") as StepLike[])
    : [];
  for (const s of steps) {
    const url = typeof s.url === "string" ? s.url : "";
    if (url === "/create-vlan") {
      const id = num(param(s, "vlan_id") ?? param(s, "id"));
      if (id !== undefined) { const r = upsert(id); if (r.source !== "live") r.source = "intent"; }
    }
    if (url === "/bind-macvpn") {
      const id = num(param(s, "vlan_id"));
      const mac = param(s, "macvpn");
      const vni = num(param(s, "vni"));
      if (id !== undefined) {
        const r = upsert(id);
        if (r.source !== "live") r.source = "intent";
        if (typeof mac === "string" && mac !== "" && r.macvpn === undefined) r.macvpn = mac;
        if (vni !== undefined && r.l2Vni === undefined) r.l2Vni = vni;
      }
    }
    const m = /^\/interfaces\/Vlan(\d+)\/apply-service$/.exec(url);
    if (m) {
      const id = num(m[1]);
      const svc = param(s, "service");
      if (id !== undefined) {
        const r = upsert(id);
        if (r.source !== "live") r.source = "intent";
        if (typeof svc === "string" && svc !== "") r.service = svc;
      }
    }
  }

  // Live device read (strongest — overwrites the observational fields).
  const live = Array.isArray(input.liveVlans) ? input.liveVlans : [];
  for (const v of live) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const id = num(o.id);
    if (id === undefined) continue;
    const r = upsert(id);
    r.source = "live";
    if (typeof o.svi === "string") r.svi = o.svi;
    const vni = num(o.l2_vni);
    if (vni !== undefined) r.l2Vni = vni;
    if (typeof o.macvpn === "string" && o.macvpn !== "") r.macvpn = o.macvpn;
    const mc = num(o.member_count);
    if (mc !== undefined) r.memberCount = mc;
    if (Array.isArray(o.members)) r.members = o.members.filter((x): x is string => typeof x === "string");
  }

  return [...byId.values()].sort((a, b) => a.vlanId - b.vlanId);
}

/**
 * pendingCreateVlanIds extracts staged create-vlan device actions from a
 * device's queue slice, so a queued-but-unapplied SVI appears in the list.
 */
export function pendingCreateVlanIds(queue: readonly unknown[]): number[] {
  const out: number[] = [];
  for (const p of queue) {
    if (!p || typeof p !== "object") continue;
    const o = p as { group?: unknown; op?: unknown; actionId?: unknown; body?: unknown };
    if (o.group === "device" && o.op === "action" && o.actionId === "create-vlan") {
      const id = num((o.body as Record<string, unknown> | undefined)?.id
        ?? (o.body as Record<string, unknown> | undefined)?.vlan_id);
      if (id !== undefined) out.push(id);
    }
  }
  return out;
}

/**
 * macvpnVlanHints — "MACVPN pins VLAN 100" strings for the add-VLAN form, from
 * the network's macvpn details. The service's macvpn pins the VLAN id, so the
 * right N for an irb service is usually one of these, not a free choice.
 */
export function macvpnVlanHints(details: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const d of details) {
    if (!d || typeof d !== "object") continue;
    const o = d as Record<string, unknown>;
    const id = num(o.vlan_id);
    if (typeof o.name === "string" && o.name !== "" && id !== undefined) {
      out.push(`${o.name} pins VLAN ${id}`);
    }
  }
  return out;
}
