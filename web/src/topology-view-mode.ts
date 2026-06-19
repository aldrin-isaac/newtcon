// topology-view-mode.ts — view-mode selection + persistence for the
// layered Topology views (slice #210.B).
//
// The Topology graph supports three view modes, each overlaying a
// different actuation domain on the shared topology-spec substrate:
//
//   "spec"            — spec only; no actuation overlay
//   "spec-lab"        — spec + newtlab lifecycle (lab VMs)
//   "spec-physical"   — spec + physical devices (newtron probe + drift)
//
// The operator picks via a chip in the topology toolbar (slice #210.B);
// the choice persists per-network in localStorage so different
// networks can default to different views. Choice for a network that
// hasn't been visited gets defaultViewMode() based on which signals
// the active actuation sources show.

import type { LabState } from "./api/newtcon/lab.js";

export type TopologyViewMode = "spec" | "spec-lab" | "spec-physical";

export const ALL_VIEW_MODES: readonly TopologyViewMode[] = [
  "spec", "spec-lab", "spec-physical",
];

const STORAGE_KEY_PREFIX = "newtcon:topology-view:";

function storageKey(network: string): string {
  return STORAGE_KEY_PREFIX + network;
}

/**
 * loadViewMode reads the persisted choice for a network. Returns null
 * when none stored; the caller falls back to defaultViewMode().
 */
export function loadViewMode(network: string): TopologyViewMode | null {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(network));
    if (raw === "spec" || raw === "spec-lab" || raw === "spec-physical") return raw;
    return null;
  } catch {
    return null;
  }
}

/** saveViewMode persists the choice for a network. */
export function saveViewMode(network: string, mode: TopologyViewMode): void {
  try {
    globalThis.localStorage?.setItem(storageKey(network), mode);
  } catch {
    /* localStorage unavailable / quota — choice just won't persist */
  }
}

/**
 * defaultViewMode — picks a starting mode based on what signals are
 * available. Order of preference: lab if a lab has at least one
 * known node, physical if any device's /info probe succeeded,
 * otherwise spec-only.
 *
 * "spec-lab" is preferred over "spec-physical" because newtcon's
 * historical default behaviour (composite resolver before #210) was
 * lab-first; this preserves continuity for operators who haven't yet
 * picked a view per-network.
 */
export function defaultViewMode(
  labState: LabState | null,
  onlineByDevice: ReadonlyMap<string, boolean>,
): TopologyViewMode {
  if (labState && labState.nodes && Object.keys(labState.nodes).length > 0) {
    return "spec-lab";
  }
  for (const v of onlineByDevice.values()) {
    if (v === true) return "spec-physical";
  }
  return "spec";
}

/** availableViewModes returns the modes the operator can currently
 *  switch to (others render disabled-but-visible so the operator can
 *  see what would be possible when signals arrive). */
export function availableViewModes(
  labState: LabState | null,
  onlineByDevice: ReadonlyMap<string, boolean>,
): Set<TopologyViewMode> {
  const out = new Set<TopologyViewMode>(["spec"]);
  if (labState && labState.nodes && Object.keys(labState.nodes).length > 0) {
    out.add("spec-lab");
  }
  for (const v of onlineByDevice.values()) {
    if (v === true) {
      out.add("spec-physical");
      break;
    }
  }
  return out;
}

/** viewModeLabel — operator-facing UI text per mode. The spec substrate
 *  is implicit (every view layers on it), so the chip labels just name
 *  the actuation source. */
export function viewModeLabel(mode: TopologyViewMode): string {
  switch (mode) {
    case "spec":          return "Spec";
    case "spec-lab":      return "Lab";
    case "spec-physical": return "Physical";
  }
}
