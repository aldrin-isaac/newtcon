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
