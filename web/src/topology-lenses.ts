// topology-lenses.ts — pure lens derivations for the Topology canvas
// (uplift 4.3, #423). A lens re-weights the canvas around one concern —
// it NEVER changes layout, only which devices halo (emphasis) and which
// dim (recede):
//
//   vni      — the chosen VLAN's footprint: devices carrying it halo,
//              everything else dims; the badge lists that device's
//              member ports (RCA-051's tagged-join made visible).
//   underlay — routed-fabric health: devices with down BGP sessions
//              halo (something to fix), healthy ones stay normal,
//              unprobed ones dim.
//   drift    — devices whose CONFIG_DB diverges from intent halo,
//              clean ones dim.
//
// Pure: no I/O, no DOM. The mount layer feeds the same per-device maps
// the 4.2 link-truth fan-out already collects.

import { parseDeviceSteps } from "./device-steps.js";
import type { UnderlayState } from "./topology-links.js";

export type LensKind = "vni" | "underlay" | "drift";

export interface LensState {
  kind: LensKind | null;
  /** vni lens only: the chosen VLAN id. */
  vlanId?: number;
}

export interface LensEffect {
  /** Devices to emphasize (halo ring). */
  halo: Set<string>;
  /** Devices to recede. Never overlaps halo. */
  dim: Set<string>;
  /** Optional per-device annotation (vni lens: member ports). */
  badge: Map<string, string>;
}

const EMPTY: LensEffect = { halo: new Set(), dim: new Set(), badge: new Map() };

interface TopoDeviceEntryLike { steps?: unknown[] }

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** vlanMembership — which devices carry a VLAN, and on which ports.
 *  Read from topology intent steps: create-vlan declares participation;
 *  per-interface apply-service with a vlan param makes the port a member. */
export function vlanMembership(
  devices: Record<string, TopoDeviceEntryLike | null | undefined>,
  vlanId: number,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [device, entry] of Object.entries(devices)) {
    const ports: string[] = [];
    let participates = false;
    for (const step of parseDeviceSteps(entry?.steps)) {
      const vlan = num(step.params.vlan) ?? num(step.params.vlan_id) ?? num(step.params.id);
      if (vlan !== vlanId) continue;
      if (step.verb === "create-vlan") participates = true;
      if (step.iface !== undefined) { participates = true; ports.push(step.iface); }
    }
    if (participates) out.set(device, ports);
  }
  return out;
}

/** availableVlans — every VLAN id named by any device's intent steps,
 *  ascending. Feeds the vni-lens picker chips. */
export function availableVlans(devices: Record<string, TopoDeviceEntryLike | null | undefined>): number[] {
  const ids = new Set<number>();
  for (const entry of Object.values(devices)) {
    for (const step of parseDeviceSteps(entry?.steps)) {
      const vlan = num(step.params.vlan) ?? num(step.params.vlan_id);
      if (vlan !== undefined) ids.add(vlan);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

export interface LensInputs {
  allDevices: readonly string[];
  vlanMembers?: Map<string, string[]>;
  underlayByDevice?: Map<string, UnderlayState>;
  driftByDevice?: Map<string, number>;
}

/** lensEffect — resolve the active lens into halo/dim/badge sets.
 *  Null lens → empty effect (canvas untouched). */
export function lensEffect(lens: LensState, inputs: LensInputs): LensEffect {
  if (lens.kind === null) return { halo: new Set(), dim: new Set(), badge: new Map() };

  const halo = new Set<string>();
  const dim = new Set<string>();
  const badge = new Map<string, string>();

  if (lens.kind === "vni") {
    if (lens.vlanId === undefined || !inputs.vlanMembers) return EMPTY;
    for (const [device, ports] of inputs.vlanMembers) {
      halo.add(device);
      if (ports.length > 0) badge.set(device, ports.join(" "));
    }
    for (const d of inputs.allDevices) if (!halo.has(d)) dim.add(d);
  } else if (lens.kind === "underlay") {
    for (const d of inputs.allDevices) {
      const state = inputs.underlayByDevice?.get(d) ?? "unknown";
      if (state === "down") halo.add(d);
      else if (state === "unknown") dim.add(d);
      // "ok" devices stay normal — calm is the healthy signal.
    }
  } else if (lens.kind === "drift") {
    for (const d of inputs.allDevices) {
      const count = inputs.driftByDevice?.get(d) ?? 0;
      if (count > 0) {
        halo.add(d);
        badge.set(d, `${count} drift item${count === 1 ? "" : "s"}`);
      } else {
        dim.add(d);
      }
    }
  }
  return { halo, dim, badge };
}
