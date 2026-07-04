// topology-undo-capture.ts — pure helpers that walk a fetched
// topology payload + the staged pending queue to extract the
// pre-apply state needed for topology.remove-link undo
// (slice #175.C.1 polish).
//
// remove-link needs BOTH endpoints (the queued op only carries one);
// the link is identified by walking topology.links.

import type { Pending } from "./staging.js";

/** Newtron's topology wire shape (subset newtcon cares about). */
export interface RawTopology {
  nodes?: Record<string, Record<string, unknown>>;
  links?: Array<{ a?: string; z?: string }>;
  [k: string]: unknown;
}

/**
 * extractRemoveLinkEndpoints finds the link in topology.links that
 * matches the queued remove-link's (device, iface) and returns both
 * endpoints as `{a, z}` strings. Returns null when:
 *
 *   - topology.links is missing or empty
 *   - no link matches the (device, iface) pair
 *   - a matching link has malformed endpoints
 *
 * Matches on EITHER endpoint — the operator may have clicked × on the
 * A side or the Z side.
 */
export function extractRemoveLinkEndpoints(
  topology: RawTopology,
  device: string,
  iface: string,
): { a: string; z: string } | null {
  const links = topology.links;
  if (!Array.isArray(links)) return null;
  const target = `${device}:${iface}`;
  for (const link of links) {
    if (!link || typeof link !== "object") continue;
    const a = typeof link.a === "string" ? link.a : null;
    const z = typeof link.z === "string" ? link.z : null;
    if (!a || !z) continue;
    if (a === target || z === target) return { a, z };
  }
  return null;
}

/**
 * captureTopologyBodies walks the queue and the topology together to
 * produce the preBody Map for topology.remove-link items. Pure — no I/O.
 * Returns an empty map when the queue has no topology removals or when
 * the topology has nothing matching.
 *
 * For remove-link the body is `{a, z}` so the planner can stage an
 * add-link with the original endpoints.
 */
export function captureTopologyBodies(
  topology: RawTopology,
  queue: readonly Pending[],
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const p of queue) {
    if (p.group === "topology" && p.op === "remove-link") {
      const endpoints = extractRemoveLinkEndpoints(topology, p.device, p.iface);
      if (endpoints) out.set(p.id, endpoints);
    }
  }
  return out;
}
