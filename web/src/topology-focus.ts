// topology-focus.ts — pure focus-mode derivations (uplift 4.5, #425).
// Focusing a device dims everything that isn't the device or a direct
// neighbor; arrow keys walk the graph geometrically. Pure: no DOM.

import type { TopoLinkEnds } from "./topology-links.js";

/** neighborsOf — devices sharing a link with the given device. */
export function neighborsOf(device: string, links: readonly TopoLinkEnds[]): Set<string> {
  const out = new Set<string>();
  for (const l of links) {
    if (l.local_device === device && l.remote_device) out.add(l.remote_device);
    if (l.remote_device === device && l.local_device) out.add(l.local_device);
  }
  out.delete(device);
  return out;
}

/** focusDim — the set to dim when `device` has focus: everyone except the
 *  device and its direct neighbors. */
export function focusDim(device: string, allDevices: readonly string[], links: readonly TopoLinkEnds[]): Set<string> {
  const keep = neighborsOf(device, links);
  keep.add(device);
  return new Set(allDevices.filter((d) => !keep.has(d)));
}

export type NavDirection = "up" | "down" | "left" | "right";

export interface NodePos { cx: number; cy: number }

/** nearestInDirection — the closest node in the pressed direction, or null.
 *  A candidate counts when its displacement along the axis dominates its
 *  cross-axis drift (a 90° cone), nearest by Euclidean distance wins. */
export function nearestInDirection(
  from: string,
  positions: Map<string, NodePos>,
  dir: NavDirection,
): string | null {
  const origin = positions.get(from);
  if (!origin) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const [name, pos] of positions) {
    if (name === from) continue;
    const dx = pos.cx - origin.cx;
    const dy = pos.cy - origin.cy;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const cross = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0 || along < cross) continue; // behind us, or outside the cone
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) { bestDist = dist; best = name; }
  }
  return best;
}
