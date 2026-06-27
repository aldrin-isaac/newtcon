// action-history.ts — client-side per-network history of Apply All
// outcomes (slice #175.A).
//
// After every applyAll(), shell.ts captures an entry combining the
// pre-Apply preview (apply-preview.ts) with the post-Apply result
// (staging.ApplyResult). The entry is persisted to localStorage keyed
// by the active network, so the operator can browse "what did I do
// here" without dependence on a newtron audit log endpoint (which is
// the goal of follow-up slice 175.B — separate concern).
//
// Scope: this is the operator's PER-SESSION record of what THIS browser
// applied. It is NOT a substitute for newtron's authoritative audit
// log; the History tab is honest about that distinction in its intro
// copy.

import type { ApplyPreview } from "./apply-preview.js";
import type { PendingInverse } from "./staging.js";

/** Per-item record — mirrors PendingPreview + the apply outcome + any error. */
export interface HistoryItem {
  id: string;
  effect: "create" | "update" | "delete" | "action";
  kind: string;
  title: string;
  scope: string;
  danger: boolean;
  outcome: "applied" | "failed";
  error?: string;
  /**
   * Pre-apply body for delete-style operations (slice #175.C.1). Populated
   * at apply-preview time before the queue runs, so undo can re-create
   * what was deleted. Absent for create-style items (the inverse needs
   * only the name) and for items where the pre-apply fetch failed.
   */
  preBody?: Record<string, unknown>;
  /**
   * For flat-mutation items — the carried inverse op, computed at stage time.
   * undo just replays it; no derivation. (A spec-delete's inverse body is
   * backfilled here from preBody, captured at apply.)
   */
  inverse?: PendingInverse;
  /**
   * Whether this specific item can be undone via the data-layer or
   * device-action planner. Computed at buildEntry time. False for
   * action items whose actionId isn't in the supported-inverse list
   * (configure-interface family pending narrow trunk-semantics survey).
   * The History renderer surfaces this honestly per row.
   */
  undoable: boolean;
  /**
   * For action items: the newtron RPC subpath (e.g. "apply-service").
   * Needed by the undo planner. Absent for spec + topology items.
   */
  actionId?: string;
  /**
   * For action items: the target device (action items) + interface
   * (interface action items only). Threaded from PendingPreview so the
   * undo planner can compose the inverse RPC URL without re-parsing the
   * scope string.
   */
  device?: string;
  iface?: string;
  /**
   * For action items: the request body of the original RPC. Required by
   * the undo planner for kinds whose inverse depends on body content
   * (e.g. configure-interface — the trunk-add variant has tagged:true
   * and its inverse needs the vlan_id). Spec + topology items don't
   * populate this (their preBody covers the pre-state cache).
   */
  body?: Record<string, unknown>;
}

/** One Apply All event. */
export interface HistoryEntry {
  /** Stable per-entry ID for keyed-render + delete. */
  id: string;
  /** ISO 8601 timestamp the Apply happened, captured at the call site. */
  timestamp: string;
  /** Operator identity from /api/auth/whoami; null when auth is disabled. */
  user: string | null;
  /** Active network at apply time. */
  network: string;
  /** Per-effect counts; same shape as ApplyPreview.counts. */
  summary: { total: number; applied: number; failed: number; danger: number };
  /** Items in apply order. */
  items: HistoryItem[];
}

/** ApplyResult subset — only the fields the entry-builder needs. */
export interface ApplyResultLike {
  applied: { id: string }[];
  failed: { pending: { id: string }; error: string }[];
}

/**
 * buildEntry composes a HistoryEntry from a pre-apply preview + the
 * post-apply result + caller-supplied identity + timestamp. Pure: no
 * I/O, no localStorage, no Date.now() inside (timestamp is passed in
 * so callers can stamp once and the function stays deterministic).
 *
 * `preBodies` is the map of pre-apply bodies captured for delete-style
 * items at preview time (slice #175.C.1). Keyed by Pending.id; absent
 * keys yield items with `undoable: false` for those rows.
 */
export function buildEntry(args: {
  id: string;
  timestamp: string;
  user: string | null;
  network: string;
  preview: ApplyPreview;
  result: ApplyResultLike;
  preBodies?: ReadonlyMap<string, Record<string, unknown>>;
}): HistoryEntry {
  const failedIds = new Set(args.result.failed.map((f) => f.pending.id));
  const errorById = new Map<string, string>();
  for (const f of args.result.failed) errorById.set(f.pending.id, f.error);
  const preBodies = args.preBodies ?? new Map<string, Record<string, unknown>>();
  const items: HistoryItem[] = args.preview.items.map((p) => {
    const failed = failedIds.has(p.id);
    const it: HistoryItem = {
      id: p.id,
      effect: p.effect,
      kind: p.kind,
      title: p.title,
      scope: p.scope,
      danger: p.danger,
      outcome: failed ? "failed" : "applied",
      undoable: false,
    };
    const err = errorById.get(p.id);
    if (failed && err !== undefined) it.error = err;
    // preBody: a fetched-at-apply capture (spec/topology deletes) wins, else
    // the staged-from-UI preBody on the item (sub-rules, spec edits).
    const cached = preBodies.get(p.id) ?? p.preBody;
    if (cached !== undefined) it.preBody = cached;
    // Carry the inverse verbatim, backfilling the prior state a remove couldn't
    // know at stage time (a re-create's body / a re-link's far endpoint).
    if (p.inverse) it.inverse = backfilledInverse(p.inverse, cached);
    if (p.actionId !== undefined) it.actionId = p.actionId;
    if (p.device !== undefined) it.device = p.device;
    if (p.iface !== undefined) it.iface = p.iface;
    // Capture the request body for action items (the undo predicates read it,
    // e.g. configure-interface's `tagged` discriminator) and for the history
    // detail view (so the operator sees *what* a change submitted).
    if (p.body && typeof p.body === "object" && Object.keys(p.body).length > 0) {
      it.body = p.body as Record<string, unknown>;
    }
    it.undoable = isItemUndoable(it);
    return it;
  });
  return {
    id: args.id,
    timestamp: args.timestamp,
    user: args.user,
    network: args.network,
    summary: {
      total: args.preview.total,
      applied: args.result.applied.length,
      failed: args.result.failed.length,
      danger: args.preview.counts.danger,
    },
    items,
  };
}

// backfilledInverse fills the prior state a remove couldn't know at stage time
// (captured at apply): a re-create's body, or a re-link's far endpoint. Every
// other inverse is already complete, so this is a no-op for them.
function backfilledInverse(inv: PendingInverse, prior?: Record<string, unknown>): PendingInverse {
  if (!prior) return inv;
  if (inv.group === "mutation" && inv.body === undefined) return { ...inv, body: prior };
  if (inv.group === "topology" && inv.op === "add-device" && inv.body === undefined) return { ...inv, body: prior };
  if (inv.group === "topology" && inv.op === "add-link" && (inv.a === undefined || inv.z === undefined)
    && typeof prior.a === "string" && typeof prior.z === "string") return { ...inv, a: prior.a, z: prior.z };
  return inv;
}

/**
 * isItemUndoable — one rule now that every op carries its inverse: undoable iff
 * the inverse exists and is *ready* (a re-create/re-link has its prior state).
 * undoable does NOT mean the item succeeded; the History UI surfaces both.
 */
function isItemUndoable(item: HistoryItem): boolean {
  return !!item.inverse && inverseReady(item.inverse);
}

// inverseReady — an inverse is enqueueable when it has everything it needs. A
// remove inverse needs no body; a re-create/re-link needs its backfilled state.
function inverseReady(inv: PendingInverse): boolean {
  if (inv.group === "mutation") return inv.effect === "delete" || inv.body !== undefined;
  if (inv.group === "topology") {
    if (inv.op === "add-device") return inv.body !== undefined && Object.keys(inv.body).length > 0;
    if (inv.op === "update-device") return inv.body !== undefined; // pre-edit device restore
    if (inv.op === "add-link") return typeof inv.a === "string" && typeof inv.z === "string";
    return true; // remove-device / remove-link need no prior state
  }
  return true; // device / interface action inverses are self-contained
}

const STORAGE_KEY_PREFIX = "newtcon:history:";

/** Per-network cap. Older entries fall off when an Apply pushes past it. */
export const MAX_ENTRIES_PER_NETWORK = 50;

function storageKey(network: string): string {
  return STORAGE_KEY_PREFIX + network;
}

/**
 * loadHistory returns the persisted entries for the network, newest
 * first. Returns [] on missing key / malformed JSON / non-array body —
 * the History tab should never crash on bad storage state.
 */
export function loadHistory(network: string): HistoryEntry[] {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(network));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as HistoryEntry[];
  } catch {
    return [];
  }
}

/**
 * prependEntry returns a new sorted list with `entry` at the head,
 * capped at MAX_ENTRIES_PER_NETWORK. Pure: does not touch storage.
 * Persist with saveHistory if needed.
 */
export function prependEntry(existing: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [entry, ...existing].slice(0, MAX_ENTRIES_PER_NETWORK);
}

/** saveHistory writes entries to localStorage; swallows quota / disabled-storage errors. */
export function saveHistory(network: string, entries: readonly HistoryEntry[]): void {
  try {
    globalThis.localStorage?.setItem(storageKey(network), JSON.stringify(entries));
  } catch { /* quota full, storage disabled — drop the write silently */ }
}

/**
 * appendEntry is the convenience used by the shell call site:
 * loadHistory → prependEntry → saveHistory in one call. Returns the
 * new list so the History tab can re-render without a second load.
 */
export function appendEntry(network: string, entry: HistoryEntry): HistoryEntry[] {
  const next = prependEntry(loadHistory(network), entry);
  saveHistory(network, next);
  return next;
}

/** clearHistory removes every entry for a network. */
export function clearHistory(network: string): void {
  try { globalThis.localStorage?.removeItem(storageKey(network)); } catch { /* swallow */ }
}
