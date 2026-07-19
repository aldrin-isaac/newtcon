// fabric-health.ts — pure aggregation for the header fabric-health strip
// (uplift 4.5, #425). One glance answers: is the underlay converged, is
// anything drifting, are the lab VMs up? Pure: no I/O; the strip module
// owns fetching.

import type { UnderlayState } from "./topology-links.js";

export interface FabricHealthInputs {
  /** Per-device underlay verdict (bgp/check), online devices only. */
  underlayByDevice: Map<string, UnderlayState>;
  /** Per-device drift item count. */
  driftByDevice: Map<string, number>;
  /** Lab node statuses (name → status string), empty when no lab. */
  labNodeStatus: Map<string, string>;
}

export type StripTone = "ok" | "warn" | "danger" | "muted";

export interface StripCell {
  label: string;
  tone: StripTone;
}

export interface FabricHealthSummary {
  underlay: StripCell;
  drift: StripCell;
  lab: StripCell;
}

/** aggregateFabricHealth — fold per-device maps into the three strip cells. */
export function aggregateFabricHealth(inputs: FabricHealthInputs): FabricHealthSummary {
  const down = [...inputs.underlayByDevice.values()].filter((s) => s === "down").length;
  const okCount = [...inputs.underlayByDevice.values()].filter((s) => s === "ok").length;
  const underlay: StripCell =
    down > 0 ? { label: `underlay: ${down} down`, tone: "danger" }
    : okCount > 0 ? { label: "underlay: converged", tone: "ok" }
    : { label: "underlay: —", tone: "muted" };

  const drifted = [...inputs.driftByDevice.values()].filter((n) => n > 0).length;
  const drift: StripCell =
    drifted > 0 ? { label: `drift: ${drifted} device${drifted === 1 ? "" : "s"}`, tone: "warn" }
    : inputs.driftByDevice.size > 0 ? { label: "drift: clean", tone: "ok" }
    : { label: "drift: —", tone: "muted" };

  const total = inputs.labNodeStatus.size;
  const running = [...inputs.labNodeStatus.values()].filter((s) => s === "running").length;
  const lab: StripCell =
    total === 0 ? { label: "lab: —", tone: "muted" }
    : running === total ? { label: `lab: ${running}/${total} up`, tone: "ok" }
    : running === 0 ? { label: `lab: 0/${total} up`, tone: "danger" }
    : { label: `lab: ${running}/${total} up`, tone: "warn" };

  return { underlay, drift, lab };
}
