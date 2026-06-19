// topology-palette.ts — pure resolver from per-element actuation
// observation to a unified palette state (slice #210.A).
//
// Every spec element (device, link, interface pill, eventually
// service binding) renders with one class from the same five-state
// palette so the operator scans a consistent visual language across
// the topology graph and the drawer. Slice #210.A defines the state
// space + the device resolver; slices B-F wire the view toggle, the
// per-actuation signal sources, and per-element coverage.
//
// State precedence is intentional: down > drift > ok. A device that
// is both down and drifted reads as down (red) because reachability
// is the more urgent fact — operator can't address drift on an
// unreachable device.

import type { DeviceStatus } from "./device-status.js";
import type { LabState } from "./api/newtcon/lab.js";

/**
 * The five element-state classes the topology palette uses. Maps to
 * `.topo-elem--<state>` in workspace.css.
 */
export type PaletteState =
  | "spec-only"      // element declared; no actuation observed
  | "actuated-ok"    // actuated; matches spec
  | "actuated-down"  // actuated; operationally down (link down, device unreachable)
  | "drift"          // actuated; differs from spec
  | "unknown";       // signal not yet fetched / fetch failed

/**
 * ActuationSignal — what the renderer knows about one element's
 * observed state. Composed by the renderer per-element from whichever
 * actuation source the active view (lab or physical) is overlaying.
 *
 *   observed: false      → no signal at all → spec-only
 *   observed && down     → actuated-down
 *   observed && drift    → drift
 *   observed && neither  → actuated-ok
 */
export interface ActuationSignal {
  observed: boolean;
  down: boolean;
  drift: boolean;
}

/**
 * resolvePalette — pure: ActuationSignal | null → PaletteState.
 *
 * null means "signal not available" (fetch in flight, source not yet
 * wired for this element kind, etc.) — renders as unknown so the
 * operator can distinguish "checked: no actuation" (spec-only) from
 * "haven't checked yet" (unknown).
 */
export function resolvePalette(signal: ActuationSignal | null): PaletteState {
  if (!signal) return "unknown";
  if (!signal.observed) return "spec-only";
  if (signal.down) return "actuated-down";
  if (signal.drift) return "drift";
  return "actuated-ok";
}

/**
 * resolveDevicePalette — adapter from the existing per-device
 * `DeviceStatus` (substrate state: running / booting / down /
 * unrealized) + the drift count into the unified palette state.
 *
 * Maps:
 *   undefined status   → unknown (probe in flight)
 *   unrealized         → spec-only (no substrate is realizing it)
 *   down               → actuated-down
 *   booting            → unknown (mid-transition; don't read as ok or down)
 *   running + drift>0  → drift
 *   running            → actuated-ok
 */
export function resolveDevicePalette(
  status: DeviceStatus | undefined,
  driftCount: number,
): PaletteState {
  if (!status) return "unknown";
  switch (status.state) {
    case "unrealized": return "spec-only";
    case "down":       return "actuated-down";
    case "booting":    return "unknown";
    case "running":    return driftCount > 0 ? "drift" : "actuated-ok";
  }
}

/**
 * resolveLabDevicePalette — per-view resolver for the Spec+Lab view
 * (slice #210.D). Source: newtlab lifecycle per device.
 *
 *   labState null      → unknown (lab fetch in flight)
 *   no labNode         → spec-only (lab doesn't know about this device)
 *   status stopped/err → actuated-down
 *   phase present      → unknown (booting — mid-transition)
 *   status running     → actuated-ok
 *
 * Drift is NOT a lab-side concept (drift compares intent to CONFIG_DB
 * which is physical-side). In lab view, an unset port that the spec
 * declares isn't drift; it's just lifecycle. Drift surfaces only in
 * the physical view.
 */
export function resolveLabDevicePalette(
  labState: LabState | null,
  device: string,
): PaletteState {
  if (!labState) return "unknown";
  const labNode = labState.nodes?.[device];
  if (!labNode) return "spec-only";
  if (labNode.status === "stopped" || labNode.status === "error") return "actuated-down";
  if (labNode.phase) return "unknown"; // mid-boot
  if (labNode.status === "running") return "actuated-ok";
  return "unknown";
}

/**
 * resolvePhysicalDevicePalette — per-view resolver for the
 * Spec+Physical view (slice #210.C). Source: newtron /info reachability
 * + drift count.
 *
 *   online undefined    → unknown (probe in flight)
 *   !online             → spec-only (no physical actuation evidence —
 *                         could be "not deployed" or "currently
 *                         unreachable"; conservative read as spec-only)
 *   online + drift > 0  → drift
 *   online              → actuated-ok
 *
 * "down" as a state isn't currently distinguishable here (newtron's
 * /info probe doesn't surface "device crashed vs never existed"). If
 * newtron later differentiates those, this resolver folds the new
 * signal in.
 */
export function resolvePhysicalDevicePalette(
  online: boolean | undefined,
  driftCount: number,
): PaletteState {
  if (online === undefined) return "unknown";
  if (!online) return "spec-only";
  if (driftCount > 0) return "drift";
  return "actuated-ok";
}

/**
 * resolveLinkPalette — pure: pick the more-attention-worthy state of
 * the two endpoints. Used to color link lines (slice #210.E, subset).
 *
 * Priority order matches operator attention:
 *   actuated-down (worst — reachability)
 *   drift         (warning — config disagrees)
 *   spec-only     (no actuation yet)
 *   actuated-ok   (clean)
 *   unknown       (no info)
 *
 * The link inherits the worst endpoint's state — if one side is down,
 * the link is effectively down; if one side is drifted, the link
 * inherits that warning.
 */
const LINK_PRIORITY: Record<PaletteState, number> = {
  unknown: 0,
  "actuated-ok": 1,
  "spec-only": 2,
  drift: 3,
  "actuated-down": 4,
};

export function resolveLinkPalette(a: PaletteState, z: PaletteState): PaletteState {
  return LINK_PRIORITY[a] >= LINK_PRIORITY[z] ? a : z;
}
