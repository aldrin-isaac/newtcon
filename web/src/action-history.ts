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
  effect: "create" | "delete" | "action";
  kind: string;
  title: string;
  scope: string;
  danger: boolean;
  outcome: "applied" | "failed";
  error?: string;
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
 */
export function buildEntry(args: {
  id: string;
  timestamp: string;
  user: string | null;
  network: string;
  preview: ApplyPreview;
  result: ApplyResultLike;
}): HistoryEntry {
  const failedIds = new Set(args.result.failed.map((f) => f.pending.id));
  const errorById = new Map<string, string>();
  for (const f of args.result.failed) errorById.set(f.pending.id, f.error);
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
    };
    const err = errorById.get(p.id);
    if (failed && err !== undefined) it.error = err;
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
