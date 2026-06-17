// projection-aggregator.ts — pure helpers backing the per-device
// projection in the apply-preview modal (slice #171.B).
//
// Groups the staging queue's per-device + per-interface actions by
// target device. Each device gets one POST /intent/projection-diff
// with that device's ops mapped to newtron's `{url, params}` shape
// (which is identical to the queue's `{actionId, body}` — only the
// path prefix changes).
//
// Spec mutations + topology changes are intentionally NOT included —
// they don't map to per-device URLs in the same way and need a
// services-affinity lookup to discover the affected device set.
// Separate follow-up slice.

import type { Pending } from "./staging.js";

/** One operation in newtron's TopologyStep wire shape — `{url, params}`. */
export interface ProjectionOp {
  url: string;
  params: Record<string, unknown>;
}

/** Per-device batch of operations, ready to POST to projection-diff. */
export interface DeviceBatch {
  device: string;
  ops: ProjectionOp[];
}

/**
 * groupByDevice partitions the queue into per-device batches for
 * device.action + interface.action items. Returns batches sorted by
 * device name so the modal renders deterministically.
 *
 * The url field carries the action path the way newtron's RPC
 * endpoint expects it:
 *
 *   device.action     →  /<actionId>
 *   interface.action  →  /interfaces/<iface>/<actionId>
 *
 * params is the same body the operator's call site enqueued.
 */
export function groupByDevice(queue: readonly Pending[]): DeviceBatch[] {
  const byDevice = new Map<string, ProjectionOp[]>();
  for (const p of queue) {
    if (p.group === "device" && p.op === "action") {
      const ops = byDevice.get(p.device) ?? [];
      ops.push({ url: "/" + p.actionId, params: p.body });
      byDevice.set(p.device, ops);
    } else if (p.group === "interface" && p.op === "action") {
      const ops = byDevice.get(p.device) ?? [];
      ops.push({
        url: "/interfaces/" + p.iface + "/" + p.actionId,
        params: p.body,
      });
      byDevice.set(p.device, ops);
    }
  }
  return [...byDevice.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([device, ops]) => ({ device, ops }));
}

/** One entry in newtron's ProjectionDiffResult.Diff (`[]sonic.DriftEntry`). */
export interface ProjectionDiffEntry {
  table?: string;
  key?: string;
  change?: string;
  [k: string]: unknown;
}

/** Newtron's per-device projection-diff response shape. */
export interface ProjectionDiffResult {
  before?: unknown;
  after?: unknown;
  diff?: ProjectionDiffEntry[];
}

/** Per-device outcome after the fanout completes (one slot per batch). */
export interface DeviceProjection {
  device: string;
  /** Number of operations in the batch (echoed for renderer context). */
  opCount: number;
  /** Newtron's diff list, when the fetch succeeded. */
  result?: ProjectionDiffResult;
  /** Human-readable error from the fetch, when it failed. */
  error?: string;
}

/**
 * summarizeDiff returns the count of {create, modify, delete} entries
 * in newtron's diff list. Newtron's sonic.DriftEntry.change is one of
 * "create" / "modify" / "delete" (string); unknown values are not
 * counted, so the totals never overstate. Used by the modal to render
 * a single-line per-device summary above the (collapsed) diff details.
 */
export function summarizeDiff(diff: readonly ProjectionDiffEntry[] | undefined): {
  create: number; modify: number; delete: number; total: number;
} {
  const out = { create: 0, modify: 0, delete: 0, total: 0 };
  if (!diff) return out;
  for (const d of diff) {
    if (d.change === "create") { out.create++; out.total++; }
    else if (d.change === "modify") { out.modify++; out.total++; }
    else if (d.change === "delete") { out.delete++; out.total++; }
  }
  return out;
}
