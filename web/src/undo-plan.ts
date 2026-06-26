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
import type { Pending } from "./staging.js";

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
  // Reverse-order replay: undo applies inverses in the reverse of the forward
  // apply order. applySubset sorts by group (stable), so emitting the inverses
  // reversed keeps dependent ops (e.g. a delete that must precede its parent's)
  // correctly ordered within each tier.
  const items: UndoPlanItem[] = entry.items
    .slice().reverse()
    .map((item, i) => planItem(item, idGen(i)));
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
 * inverseFor returns a HistoryItem's inverse, ready to enqueue. Every op
 * carried its inverse from stage time (staging.ts) — undo is pure replay, no
 * derivation. Returns null when the item isn't undoable (no carried inverse,
 * or a remove whose prior state wasn't captured at apply).
 */
function inverseFor(item: HistoryItem, id: string): Pending | null {
  return item.inverse ? ({ id, ...item.inverse } as Pending) : null;
}

function skipReason(item: HistoryItem): string {
  if (item.kind === "device action" || item.kind === "interface action") {
    return "no faithful inverse exists for this action";
  }
  if (item.effect === "delete") {
    return "prior state wasn't captured at apply time; can't recreate";
  }
  return "no inverse for this item";
}
