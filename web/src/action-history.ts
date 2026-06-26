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
   * For flat-mutation items — the structured resource identity, so undo
   * composes the inverse directly (no display-string parsing). `resourceName`
   * is the parent spec; `sub` is set for sub-rule rows.
   */
  resourceKind?: string;
  resourceName?: string;
  sub?: { endpoint: string; key?: string | number };
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
    const undoable = isItemUndoable(p, preBodies);
    const it: HistoryItem = {
      id: p.id,
      effect: p.effect,
      kind: p.kind,
      title: p.title,
      scope: p.scope,
      danger: p.danger,
      outcome: failed ? "failed" : "applied",
      undoable,
    };
    const err = errorById.get(p.id);
    if (failed && err !== undefined) it.error = err;
    // preBody: a fetched-at-apply capture (spec/topology deletes) wins, else
    // the staged-from-UI preBody on the item (sub-rules, spec edits).
    const cached = preBodies.get(p.id) ?? p.preBody;
    if (cached !== undefined) it.preBody = cached;
    if (p.resourceKind !== undefined) it.resourceKind = p.resourceKind;
    if (p.resourceName !== undefined) it.resourceName = p.resourceName;
    if (p.sub !== undefined) it.sub = p.sub;
    if (p.actionId !== undefined) it.actionId = p.actionId;
    if (p.device !== undefined) it.device = p.device;
    if (p.iface !== undefined) it.iface = p.iface;
    // Capture the request body for every item that carries one (spec /
    // device creates + device / interface actions). The undo planner
    // reads it for action items (e.g. configure-interface's `tagged`
    // discriminator); the History renderer shows it as expandable detail
    // so the operator can see *what* a change submitted, not just that it
    // happened.
    if (p.body && typeof p.body === "object" && Object.keys(p.body).length > 0) {
      it.body = p.body as Record<string, unknown>;
    }
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

/**
 * isItemUndoable decides whether a preview item can be undone. Rules:
 *
 *   create-style (spec, device, link)  always undoable (DELETE by name)
 *   delete-style                       undoable iff preBody was captured
 *   action items                       undoable iff actionId is in the
 *                                      per-action-kind inverse map
 *                                      (slice #175.C.2.a + later
 *                                      sub-slices)
 *
 * Note: undoable does NOT mean the item succeeded. A FAILED apply may
 * still be undoable in principle; the History UI surfaces both flags so
 * the operator can choose.
 */
function isItemUndoable(
  item: {
    effect: "create" | "update" | "delete" | "action";
    kind: string;
    id: string;
    actionId?: string;
    body?: Record<string, unknown> | null;
    preBody?: Record<string, unknown>;
  },
  preBodies: ReadonlyMap<string, Record<string, unknown>>,
): boolean {
  // Action items — per-actionId predicate map; for some actionIds the
  // predicate inspects the body (e.g. configure-interface is only
  // undoable for the trunk-add variant where body.tagged === true).
  if (item.kind === "device action" || item.kind === "interface action") {
    if (item.actionId === undefined) return false;
    const predicate = ACTION_INVERSE_PREDICATES[item.actionId];
    if (!predicate) return false;
    return predicate(item.body ?? undefined);
  }
  // Spec / sub-rule / topology mutations: a create inverts to a delete (no
  // prior state needed); a delete/update inverts when we captured the prior
  // body (fetched at apply, or staged from the UI for sub-rules/edits).
  if (item.effect === "create") return true;
  if (preBodies.has(item.id) || !!item.preBody) return true;
  // A key-changing update (reorder / rename) carries its own renumber in the
  // body (new_<key>), so the inverse is computable without a prior body.
  if (item.effect === "update" && item.body
    && Object.keys(item.body).some((k) => k.startsWith("new_"))) return true;
  return false;
}

/**
 * ACTION_INVERSE_PREDICATES maps actionId → predicate(body) that
 * answers "is this specific call undoable?". Predicates inspect body
 * when the inverse depends on the request shape.
 *
 * Updated as sub-slices of 175.C.2 land:
 *
 *   175.C.2.a — apply-service (inverse: remove-service, no body)
 *   175.C.2.b — configure-interface tagged:true (trunk add) → inverse
 *               is remove-trunk-vlan {vlan_id} (newtron PR #225)
 *   175.C.2.c — configure-interface tagged:false (access) and routed
 *               (vrf+ip) → inverse is unconfigure-interface (newtron
 *               case A: cross-mode transitions rejected at the intent
 *               DAG, so the prior state was always empty — clearing
 *               the port restores it)
 *   future   — unconfigure-interface undo (needs InterfaceDetail +
 *              ServiceBindingDetail + ACL pre-state cache to compose
 *              the multi-call restore sequence)
 */
const ACTION_INVERSE_PREDICATES: Record<string, (body: Record<string, unknown> | undefined) => boolean> = {
  "apply-service": () => true,
  "configure-interface": (body) => {
    if (!body || typeof body !== "object") return false;
    // Trunk add (#175.C.2.b) — inverse via remove-trunk-vlan, needs
    // a numeric vlan_id alongside tagged:true.
    if (body["tagged"] === true) return typeof body["vlan_id"] === "number";
    // Access (#175.C.2.c) — inverse via unconfigure-interface;
    // requires the body actually describes an access set
    // (vlan_id present, tagged explicitly false).
    if (body["tagged"] === false && typeof body["vlan_id"] === "number") return true;
    // Routed (#175.C.2.c) — inverse via unconfigure-interface;
    // requires the body describes a routed set (vrf and/or ip).
    if (typeof body["vrf"] === "string" || typeof body["ip"] === "string") return true;
    return false;
  },
};

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
