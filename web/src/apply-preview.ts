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

import { pendingPath, type Pending, type PendingInverse } from "./staging.js";

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
  /** HTTP method this change applies as (POST/PUT/DELETE) — the real verb. */
  method: string;
  /** Relative API path this change targets (scope query included for scoped
   *  mutations) — the endpoint+scope context, surfaced alongside the body. */
  path: string;
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
  /**
   * For flat-mutation items — the op that undoes this one, computed at stage
   * time and carried verbatim, so undo never re-derives it. Absent ⇒ not
   * undoable. (A spec-delete's inverse body is backfilled at apply.)
   */
  inverse?: PendingInverse;
  /** Prior server state for a delete/update mutation — shown in history, and
   *  backfilled into a spec-delete's inverse body at apply. */
  preBody?: Record<string, unknown>;
}

// ---- Drift check ---------------------------------------------------------
// A staged op assumes the server is in a certain state; between staging and
// Apply that can drift (a concurrent change, or undoing against a world that
// moved). driftVerdict turns "what the op assumes" + "what's there now" into a
// pre-apply warning, so the operator isn't surprised by a post-apply failure.
// Existence-based: it catches create-over-existing, edit/delete-of-missing, and
// undo-resurrect. (Detecting an update that silently *clobbers* a concurrent
// edit needs server-side versioning newtron doesn't expose yet — separate gap.)

export type DriftLevel = "none" | "warn" | "info";
export interface DriftVerdict { level: DriftLevel; reason: string; }

// shouldDriftCheck decides whether an op's drift is probeable by a plain
// GET {kind}/{name}. Only top-level spec mutations qualify. Override creates
// (scope ≠ network) target the override, not the base, so a base existence
// probe would falsely warn "already exists" — skip them (override existence
// needs /spec-instances; follow-up). Sub-rules are skipped likewise for now.
export function shouldDriftCheck(op: { group: string; sub?: unknown; body?: Record<string, unknown> | null }): boolean {
  if (op.group !== "mutation" || op.sub) return false;
  const scope = op.body?.scope;
  if (typeof scope === "string" && scope !== "network") return false;
  return true;
}

export function driftVerdict(effect: "create" | "update" | "delete", exists: boolean): DriftVerdict {
  if (effect === "create" && exists) return { level: "warn", reason: "already exists — apply will fail or overwrite it" };
  if (effect === "update" && !exists) return { level: "warn", reason: "no longer exists — the edit will fail" };
  if (effect === "delete" && !exists) return { level: "info", reason: "already gone — delete is a no-op" };
  return { level: "none", reason: "" };
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
function orderOf(p: Pending): number {
  if (p.group === "mutation") {
    const sub = !!p.sub;
    if (p.method === "POST") return sub ? 1.3 : 1.0;
    if (p.method === "PUT") return 1.5;
    return sub ? 7.7 : 8.0;
  }
  switch (`${p.group}.${p.op}`) {
    case "topology.update-device": return 2.5;
    case "topology.add-link": return 3;
    case "device.action": return 4;
    case "interface.action": return 5;
    case "topology.remove-link": return 6;
    default: return 9;
  }
}

/**
 * previewQueue computes the operator-facing preview for a pending queue.
 * Pure function — does not touch the queue, makes no network calls.
 */
export function previewQueue(queue: readonly Pending[]): ApplyPreview {
  const items = queue.slice()
    .sort((a, b) => orderOf(a) - orderOf(b))
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

// toPreview attaches the carried inverse + prior body uniformly, so every op
// type flows them into the history item for undo without per-branch wiring.
function toPreview(p: Pending): PendingPreview {
  const { method, path } = pendingPath(p);
  const pv: PendingPreview = { ...previewBase(p), method, path };
  if (p.inverse) pv.inverse = p.inverse;
  if ("preBody" in p && p.preBody) pv.preBody = p.preBody;
  return pv;
}

function previewBase(p: Pending): Omit<PendingPreview, "method" | "path"> {
  if (p.group === "mutation") {
    return {
      id: p.id, effect: p.effect,
      kind: p.sub ? "sub-rule" : "spec",
      title: p.title,
      scope: p.sub ? `${kindLabel(p.kind)} · ${p.sub.endpoint}` : kindLabel(p.kind),
      danger: p.effect === "delete",
      body: p.body ?? null,
    };
  }
  if (p.group === "ssh-login") {
    return {
      id: p.id,
      effect: p.op === "set" ? "update" : "delete",
      kind: "SSH login",
      title: p.title,
      scope: p.scope === "network" ? "network" : `${p.scope} ${p.scopeInstance}`,
      danger: p.op === "clear",
      body: p.body ?? null,
    };
  }
  if (p.group === "topology" && p.op === "update-device") {
    return {
      id: p.id, effect: "update", kind: "device",
      title: p.name, scope: "ports",
      danger: false, body: p.body,
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

// ---- Delivery-mode indicator (per-device apply semantics) -------------------
//
// Device-targeted actions (group "device" / "interface") apply in one of two
// modes, decided per device by applyDevice() in staging.ts at apply time:
//
//   device online  → actuated apply — the change is DELIVERED to the running
//                    switch (and recorded as intent);
//   device offline → topology mode — the change AUTHORS INTENT only, and
//                    actuates at the next provision.
//
// A topology-mode apply still reports success, so without an affordance the
// distinction is silent — an operator can believe a policy is enforcing when
// it is only authored (this bit us live; see the RCA-051 verification
// exchange). These helpers back the confirm-modal's "Delivery" section: the
// pure parts are here (testable), the async probe + DOM live in shell.ts.
//
// deliveryLabel mirrors applyDevice's decision EXACTLY: topology mode is
// chosen only when the probe says definitively false; anything else
// (true / undefined probe) attempts actuated delivery.

/** deliveryDevices — unique devices in the queue whose apply is
 *  mode-dependent (device/interface action items), in first-seen order.
 *  Spec + topology + ssh-login items are network-level and mode-independent. */
export function deliveryDevices(queue: readonly Pending[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of queue) {
    if ((p.group === "device" || p.group === "interface") && p.op === "action") {
      if (!seen.has(p.device)) { seen.add(p.device); out.push(p.device); }
    }
  }
  return out;
}

export interface DeliveryLabel {
  mode: "live" | "intent";
  label: string;
  hint: string;
}

/** deliveryLabel maps a probeOnline() result to the operator-facing chip.
 *  Mirrors applyDevice(): only a definitive offline (false) selects
 *  topology/authoring mode. */
export function deliveryLabel(online: boolean | undefined): DeliveryLabel {
  if (online === false) {
    return {
      mode: "intent",
      label: "authors intent",
      hint: "Device is offline — the change is recorded as intent and actuates at the next provision.",
    };
  }
  return {
    mode: "live",
    label: "delivers to device",
    hint: "Device is online — the change is applied to the running switch now.",
  };
}
