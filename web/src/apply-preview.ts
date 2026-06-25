// apply-preview.ts — pure derivation that turns the pending queue into
// a structured preview suitable for rendering before Apply All
// (slice #171.A).
//
// The preview is honest about apply order — items appear in the same
// order applySubset() in staging.ts will execute them. Each item carries
// its effect (create / delete / action), category, one-line title,
// optional scope sub-line, danger flag, and optional body (for the
// expand-detail panel).
//
// This slice covers spec-level + topology-level + queued device-action
// previews — i.e. everything in the workspace queue. Device-level
// configuration projection (what newtron's reconcile loop will push to
// the switch) is a separate diff layer and needs a newtron-side
// projection endpoint; out of scope here.

import type { Pending } from "./staging.js";

export type PreviewEffect = "create" | "update" | "delete" | "action";

export interface PendingPreview {
  id: string;
  effect: PreviewEffect;
  /** Operator-readable category ("spec", "device", "link", "device action", "interface action"). */
  kind: string;
  /** One-line title — the primary identifier of what's changing. */
  title: string;
  /** Optional sub-line — spec kind, scope, host, etc. */
  scope: string;
  /** True when the source-of-truth flagged this as destructive. */
  danger: boolean;
  /** Detail body for the expand-on-demand panel; null when nothing to show. */
  body: Record<string, unknown> | null;
  /**
   * For "device action" + "interface action" items only: the underlying
   * newtron RPC subpath (e.g. "apply-service", "configure-interface").
   * Needed by the undo planner to compose the inverse RPC (slice #175.C.2).
   * Absent for spec + topology items.
   */
  actionId?: string;
  /**
   * For action items only: the device the action targets. Same purpose as
   * actionId above — the inverse RPC needs to know which device the call
   * went to. Absent for spec + topology items.
   */
  device?: string;
  /**
   * For "interface action" items only: the interface name. Required to
   * compose the inverse RPC URL.
   */
  iface?: string;
}

export interface ApplyPreview {
  total: number;
  /** Items in apply order (same order staging.applySubset uses). */
  items: PendingPreview[];
  counts: { create: number; update: number; delete: number; action: number; danger: number };
  hasDangerous: boolean;
  hasDeletes: boolean;
}

// Mirrors staging.ts groupOrder() exactly so the preview shows the same
// order the apply loop will execute.
const ORDER: Record<string, number> = {
  "spec.create": 1,
  "spec.update": 1.5,
  "topology.add-device": 2,
  "topology.add-link": 3,
  "device.action": 4,
  "interface.action": 5,
  "topology.remove-link": 6,
  "topology.remove-device": 7,
  "spec.delete": 8,
};

function keyOf(p: Pending): string {
  return `${p.group}.${p.op}`;
}

/**
 * previewQueue computes the operator-facing preview for a pending queue.
 * Pure function — does not touch the queue, makes no network calls.
 */
export function previewQueue(queue: readonly Pending[]): ApplyPreview {
  const items = queue.slice()
    .sort((a, b) => (ORDER[keyOf(a)] ?? 99) - (ORDER[keyOf(b)] ?? 99))
    .map(toPreview);
  const counts = { create: 0, update: 0, delete: 0, action: 0, danger: 0 };
  for (const it of items) {
    counts[it.effect] += 1;
    if (it.danger) counts.danger += 1;
  }
  return {
    total: items.length,
    items,
    counts,
    hasDangerous: counts.danger > 0,
    hasDeletes: counts.delete > 0,
  };
}

function toPreview(p: Pending): PendingPreview {
  if (p.group === "spec" && p.op === "create") {
    return {
      id: p.id, effect: "create", kind: "spec",
      title: p.name, scope: kindLabel(p.kind),
      danger: false, body: p.body,
    };
  }
  if (p.group === "spec" && p.op === "update") {
    return {
      id: p.id, effect: "update", kind: "spec",
      title: p.name, scope: kindLabel(p.kind),
      danger: false, body: p.body,
    };
  }
  if (p.group === "spec" && p.op === "delete") {
    return {
      id: p.id, effect: "delete", kind: "spec",
      title: p.name, scope: kindLabel(p.kind),
      danger: true, body: null,
    };
  }
  if (p.group === "topology" && p.op === "add-device") {
    return {
      id: p.id, effect: "create", kind: "device",
      title: p.name, scope: "topology",
      danger: false, body: p.body,
    };
  }
  if (p.group === "topology" && p.op === "remove-device") {
    return {
      id: p.id, effect: "delete", kind: "device",
      title: p.name, scope: "topology",
      danger: true, body: null,
    };
  }
  if (p.group === "topology" && p.op === "add-link") {
    return {
      id: p.id, effect: "create", kind: "link",
      title: `${p.a} ↔ ${p.z}`, scope: "topology",
      danger: false, body: null,
    };
  }
  if (p.group === "topology" && p.op === "remove-link") {
    return {
      id: p.id, effect: "delete", kind: "link",
      title: `${p.device}:${p.iface}`, scope: "topology",
      danger: true, body: null,
    };
  }
  if (p.group === "device" && p.op === "action") {
    return {
      id: p.id, effect: "action", kind: "device action",
      title: p.label, scope: p.device,
      danger: p.danger === true, body: p.body,
      actionId: p.actionId, device: p.device,
    };
  }
  if (p.group === "interface" && p.op === "action") {
    return {
      id: p.id, effect: "action", kind: "interface action",
      title: p.label, scope: `${p.device}:${p.iface}`,
      danger: p.danger === true, body: p.body,
      actionId: p.actionId, device: p.device, iface: p.iface,
    };
  }
  // Defensive fallback — keeps the preview rendering honest when the
  // Pending union grows a new variant the preview hasn't been taught yet.
  return {
    id: (p as { id: string }).id, effect: "action", kind: "unknown",
    title: "(unknown pending operation)", scope: "", danger: false, body: null,
  };
}

function kindLabel(k: string): string {
  return k.replace(/-/g, " ");
}
