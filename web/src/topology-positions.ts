// topology-positions.ts — per-device node position persistence for the
// Topology view. Operators can drag a node; on mouseup the position
// commits to localStorage keyed by the active network, so it survives
// reload. The grid layout in app.ts continues to serve as the fallback
// for devices that haven't been pinned yet.
//
// Storage shape (one key per network):
//
//   localStorage["newtcon.topology.positions.<network>"]
//     = JSON.stringify({ "<device-name>": { cx: <px>, cy: <px> }, … })
//
// cx / cy are SVG-coordinate-space pixels (the same units layoutNodes
// returns) so the renderer can substitute them directly.
//
// Pure helpers — no DOM. The drag wiring lives in app.ts where it can
// reach the SVG group element.

/** A pinned position in SVG coordinates. */
export interface PinnedPosition {
  cx: number;
  cy: number;
}

const KEY_PREFIX = "newtcon.topology.positions.";

function keyFor(network: string): string {
  return KEY_PREFIX + network;
}

/**
 * loadPositions returns the pinned-position map for a network. Empty map
 * when nothing's been pinned or when localStorage is unavailable / the
 * stored value is malformed.
 */
export function loadPositions(network: string): Map<string, PinnedPosition> {
  if (typeof localStorage === "undefined") return new Map();
  let raw: string | null;
  try { raw = localStorage.getItem(keyFor(network)); } catch { return new Map(); }
  if (!raw) return new Map();
  try {
    const obj = JSON.parse(raw) as Record<string, PinnedPosition>;
    const out = new Map<string, PinnedPosition>();
    for (const [name, pos] of Object.entries(obj)) {
      if (pos && typeof pos.cx === "number" && typeof pos.cy === "number") {
        out.set(name, { cx: pos.cx, cy: pos.cy });
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * savePosition writes one device's pinned position. Reads + merges the
 * current map so concurrent updates from other tabs don't overwrite each
 * other (best-effort — no cross-tab event coordination today).
 */
export function savePosition(network: string, device: string, pos: PinnedPosition): void {
  if (typeof localStorage === "undefined") return;
  const current = loadPositions(network);
  current.set(device, pos);
  const obj: Record<string, PinnedPosition> = {};
  for (const [k, v] of current) obj[k] = v;
  try { localStorage.setItem(keyFor(network), JSON.stringify(obj)); } catch { /* quota / privacy mode */ }
}

/** clearPositions wipes every pinned position for a network. */
export function clearPositions(network: string): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.removeItem(keyFor(network)); } catch { /* same */ }
}
