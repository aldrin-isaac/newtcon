// undo-plan.ts — pure planner that turns a HistoryEntry into the
// inverse Pending[] (slice #175.C.1).
//
// Design principle (per design discussion): undo is NOT a separate
// substrate operation. It's the operator authoring the intent that
// recreates a prior state, then applying through the same machinery
// every other Apply uses. This module exists to compose the inverse
// Pending list — the same Pending shape staging.ts already runs — so
// that "Undo" from the History tab feeds the existing confirm-modal +
// projection-diff + applyAll pipeline.
//
// Slice 175.C.1 covers spec + topology operations only. Per-action
// items (device.action / interface.action) are explicitly skipped —
// see the buildEntry guard in action-history.ts. The planner mirrors
// that decision: an item with undoable=false yields no plan entry.

import type { HistoryItem, HistoryEntry } from "./action-history.js";
import type { Pending, SpecKind } from "./staging.js";

/** Per-item plan result. */
export interface UndoPlanItem {
  /** Source HistoryItem id. */
  sourceId: string;
  /** True when the source item produced an inverse Pending. */
  planned: boolean;
  /** Operator-readable reason when planned=false (skipped). */
  reason?: string;
  /** The inverse pending op, when planned=true. */
  inverse?: Pending;
}

/** Result of planUndo for an entire HistoryEntry. */
export interface UndoPlan {
  items: UndoPlanItem[];
  /** Per-status counts for the UI summary. */
  counts: { planned: number; skipped: number };
}

/**
 * planUndo computes the inverse pending list for a HistoryEntry.
 * Pure — no I/O, no staging mutation. Caller enqueues planned
 * inverses through the existing enqueue* helpers and lets the modal
 * + applyAll machinery handle confirmation + projection + apply.
 *
 * idGen lets the caller plug in any id-minting strategy (a counter,
 * a timestamp prefix, etc.) so this module stays deterministic.
 */
export function planUndo(
  entry: HistoryEntry,
  idGen: (i: number) => string,
): UndoPlan {
  const items: UndoPlanItem[] = entry.items.map((item, i) =>
    planItem(item, idGen(i)),
  );
  return {
    items,
    counts: {
      planned: items.filter((p) => p.planned).length,
      skipped: items.filter((p) => !p.planned).length,
    },
  };
}

function planItem(item: HistoryItem, id: string): UndoPlanItem {
  if (!item.undoable) {
    return {
      sourceId: item.id,
      planned: false,
      reason: skipReason(item),
    };
  }
  const inverse = inverseFor(item, id);
  if (!inverse) {
    return {
      sourceId: item.id,
      planned: false,
      reason: "no inverse mapping for this item",
    };
  }
  return { sourceId: item.id, planned: true, inverse };
}

/**
 * inverseFor maps a HistoryItem to its inverse Pending. Returns null
 * when the item's shape doesn't carry enough information to compose an
 * inverse (e.g. a delete-style item with no preBody). The result is in
 * staging's Pending shape so it can be enqueued directly.
 */
function inverseFor(item: HistoryItem, id: string): Pending | null {
  // Spec kinds — the kind field on the preview is the operator label
  // ("spec"); the actual SpecKind lives on the scope as a space-joined
  // word ("services" / "qos policies" → "qos-policies"). The kind chip
  // shown to the operator and the wire SpecKind are different — undo
  // composes against the wire kind, which we derive from item.scope.
  if (item.kind === "spec") {
    const specKind = scopeToSpecKind(item.scope);
    if (!specKind) return null;
    if (item.effect === "create") {
      // Created → inverse is delete by name (operator's title is the name).
      return { id, group: "spec", kind: specKind, op: "delete", name: item.title };
    }
    if (item.effect === "delete") {
      if (!item.preBody) return null;
      return { id, group: "spec", kind: specKind, op: "create", name: item.title, body: item.preBody };
    }
  }
  if (item.kind === "device") {
    // topology add-device ↔ remove-device. Operator's title is the
    // device name; scope is always "topology".
    if (item.effect === "create") {
      return { id, group: "topology", op: "remove-device", name: item.title };
    }
    if (item.effect === "delete") {
      if (!item.preBody) return null;
      return { id, group: "topology", op: "add-device", name: item.title, body: item.preBody };
    }
  }
  if (item.kind === "link") {
    // topology add-link ↔ remove-link. The preview title carries both
    // endpoints joined by " ↔ " from apply-preview.ts.
    const endpoints = parseLinkTitle(item.title);
    if (!endpoints) return null;
    if (item.effect === "create") {
      // Remove takes (device, iface) of one endpoint. Newtron's delete
      // endpoint matches a link by either endpoint, so the A side is
      // sufficient. apply-preview.ts encodes the A endpoint first in
      // the title "a:if ↔ z:if".
      const { aDev, aIf } = endpoints;
      return { id, group: "topology", op: "remove-link", device: aDev, iface: aIf };
    }
    if (item.effect === "delete") {
      // Re-create the link by re-supplying both endpoints. We don't
      // need preBody — the title carries everything.
      return { id, group: "topology", op: "add-link", a: endpoints.a, z: endpoints.z };
    }
  }
  return null;
}

function skipReason(item: HistoryItem): string {
  if (item.kind === "device action" || item.kind === "interface action") {
    return "requires manual reconfiguration — device/interface undo is a separate slice";
  }
  if (item.effect === "delete") {
    return "pre-apply body wasn't captured at apply time; can't recreate";
  }
  return "no inverse mapping for this item";
}

/**
 * scopeToSpecKind turns a PendingPreview.scope (the operator label
 * like "services" or "qos policies" or "route policies") back into the
 * SpecKind wire string the staging queue uses ("services",
 * "qos-policies", "route-policies"). Dash-for-space.
 */
function scopeToSpecKind(scope: string): SpecKind | null {
  const wire = scope.trim().replace(/\s+/g, "-");
  switch (wire) {
    case "services":
    case "ipvpns":
    case "macvpns":
    case "qos-policies":
    case "filters":
    case "route-policies":
    case "prefix-lists":
    case "profiles":
    case "zones":
      return wire;
    default:
      return null;
  }
}

/**
 * parseLinkTitle parses the "a:if ↔ z:if" link title format used by
 * apply-preview.ts. Returns {a, z, aDev, aIf, zDev, zIf} on match,
 * null otherwise.
 */
function parseLinkTitle(title: string): {
  a: string; z: string;
  aDev: string; aIf: string;
  zDev: string; zIf: string;
} | null {
  // Separator is " ↔ " (space + arrow + space) per apply-preview.ts.
  const parts = title.split(" ↔ ");
  if (parts.length !== 2) return null;
  const [a, z] = parts;
  if (!a || !z) return null;
  const aColon = a.indexOf(":");
  const zColon = z.indexOf(":");
  if (aColon < 0 || zColon < 0) return null;
  return {
    a, z,
    aDev: a.slice(0, aColon), aIf: a.slice(aColon + 1),
    zDev: z.slice(0, zColon), zIf: z.slice(zColon + 1),
  };
}
