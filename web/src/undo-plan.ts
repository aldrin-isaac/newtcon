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
// inverseMutation composes the inverse of a flat mutation from its structured
// identity (resourceKind / resourceName / sub) + captured prior state. The
// inverse of a create is a delete of the same row; of a delete, a re-create
// from preBody; of an update, a restore to preBody.
function inverseMutation(item: HistoryItem, id: string): Pending | null {
  const kind = item.resourceKind as SpecKind | undefined;
  const name = item.resourceName;
  if (!kind || !name) return null;
  const e = encodeURIComponent;

  if (item.sub) {
    const { endpoint, key } = item.sub;
    const base = `${kind}/${e(name)}/${endpoint}`;
    if (item.effect === "create") {
      if (key === undefined) return null;
      return { id, group: "mutation", method: "DELETE", path: `${base}/${e(String(key))}`, effect: "delete", kind, name, title: item.title, sub: { endpoint, key } };
    }
    if (item.effect === "delete") {
      if (!item.preBody) return null;
      return { id, group: "mutation", method: "POST", path: base, effect: "create", kind, name, title: item.title, sub: { endpoint, ...(key !== undefined ? { key } : {}) }, body: item.preBody };
    }
    if (item.effect === "update") {
      // Key-changing update (reorder / rename): the body carries new_<key> =
      // where the row moved to, so the row now lives at newKey. Invert by
      // renumbering it back to the original key (restoring other fields from
      // preBody when present, e.g. an edit that also renamed).
      const renumberField = item.body ? Object.keys(item.body).find((k) => k.startsWith("new_")) : undefined;
      if (renumberField && key !== undefined) {
        const newKey = (item.body as Record<string, unknown>)[renumberField];
        if (newKey === undefined || newKey === null) return null;
        const invBody: Record<string, unknown> = { [renumberField]: key };
        if (item.preBody) {
          const kf = renumberField.slice(4); // strip "new_"
          for (const [k, v] of Object.entries(item.preBody)) if (k !== kf) invBody[k] = v;
        }
        return { id, group: "mutation", method: "PUT", path: `${base}/${e(String(newKey))}`, effect: "update", kind, name, title: item.title, sub: { endpoint, key: newKey as string | number }, body: invBody };
      }
      // Plain field edit: restore the prior body at the same key.
      if (!item.preBody || key === undefined) return null;
      return { id, group: "mutation", method: "PUT", path: `${base}/${e(String(key))}`, effect: "update", kind, name, title: item.title, sub: { endpoint, key }, body: item.preBody };
    }
    return null;
  }

  if (item.effect === "create") {
    return { id, group: "mutation", method: "DELETE", path: `${kind}/${e(name)}`, effect: "delete", kind, name, title: name };
  }
  if (item.effect === "delete") {
    if (!item.preBody) return null;
    return { id, group: "mutation", method: "POST", path: kind, effect: "create", kind, name, title: name, body: item.preBody };
  }
  if (item.effect === "update") {
    if (!item.preBody) return null;
    return { id, group: "mutation", method: "PUT", path: `${kind}/${e(name)}`, effect: "update", kind, name, title: name, body: item.preBody };
  }
  return null;
}

function inverseFor(item: HistoryItem, id: string): Pending | null {
  // Flat mutations (spec + sub-rule) carry their structured identity, so the
  // inverse composes from real fields — no display-string parsing. The inverse
  // of a mutation is itself a mutation: create↔delete, update↔update(preBody).
  if (item.kind === "spec" || item.kind === "sub-rule") {
    return inverseMutation(item, id);
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
  if (item.kind === "interface action") {
    return inverseInterfaceAction(item, id);
  }
  if (item.kind === "device action") {
    return inverseDeviceAction(item, id);
  }
  if (item.kind === "link") {
    // topology add-link ↔ remove-link.
    //
    // For add-link items the preview title is "a:if ↔ z:if" — both
    // endpoints are encoded, so we parse the title.
    //
    // For remove-link items the preview title is just "device:iface"
    // (the queued endpoint the operator clicked); the OTHER endpoint
    // is supplied via item.preBody = {a, z} captured at apply-preview
    // time from the topology (slice #175.C.1 polish).
    if (item.effect === "create") {
      const endpoints = parseLinkTitle(item.title);
      if (!endpoints) return null;
      // Remove takes (device, iface) of one endpoint. Newtron's
      // delete endpoint matches a link by either endpoint, so the A
      // side is sufficient.
      const { aDev, aIf } = endpoints;
      return { id, group: "topology", op: "remove-link", device: aDev, iface: aIf };
    }
    if (item.effect === "delete") {
      // Use cached endpoints from preBody when present (the
      // shell.ts capture extracts them from the topology before the
      // queue runs).
      if (item.preBody && typeof item.preBody.a === "string" && typeof item.preBody.z === "string") {
        return { id, group: "topology", op: "add-link", a: item.preBody.a, z: item.preBody.z };
      }
      // Fallback: the title MAY carry both endpoints if some future
      // caller starts emitting that shape — parse as a last resort.
      const endpoints = parseLinkTitle(item.title);
      if (endpoints) {
        return { id, group: "topology", op: "add-link", a: endpoints.a, z: endpoints.z };
      }
      return null;
    }
  }
  return null;
}

function skipReason(item: HistoryItem): string {
  if (item.kind === "device action" || item.kind === "interface action") {
    // Distinguish "no inverse mapped yet for this actionId" from a generic
    // not-undoable so the operator knows whether a future slice will
    // light up the action.
    return "no inverse mapping for actionId '" + (item.actionId ?? "<unknown>") + "' yet";
  }
  if (item.effect === "delete") {
    return "pre-apply body wasn't captured at apply time; can't recreate";
  }
  return "no inverse mapping for this item";
}

/**
 * inverseInterfaceAction maps a queued interface RPC to its inverse.
 *
 *   175.C.2.a — apply-service → remove-service (no body)
 *   175.C.2.b — configure-interface with tagged:true → remove-trunk-vlan
 *               with the original vlan_id (newtron PR #225 made the
 *               trunk record per-VLAN and shipped this atomic strip).
 *
 * configure-interface variants without tagged:true (access mode,
 * routed mode) and unconfigure-interface still require composite
 * multi-step recovery — they remain not-undoable here pending the
 * 175.C.2.c slice and likely a newtron snapshot/restore primitive.
 */
function inverseInterfaceAction(item: HistoryItem, id: string): Pending | null {
  if (!item.actionId || !item.device || !item.iface) return null;
  if (item.actionId === "apply-service") {
    // Inverse: POST .../interfaces/{name}/remove-service with no body.
    return {
      id,
      group: "interface",
      op: "action",
      device: item.device,
      iface: item.iface,
      actionId: "remove-service",
      label: "Unbind service from " + item.device + ":" + item.iface,
      body: {},
      danger: true,
    };
  }
  if (item.actionId === "configure-interface") {
    return inverseConfigureInterface(item, id);
  }
  return null;
}

/**
 * inverseConfigureInterface — the three operator-facing variants
 * (trunk-add, set-access, set-routed) all map to the same wire verb
 * but distinct inverses (#175.C.2.b + #175.C.2.c).
 *
 *   tagged:true  + vlan_id  → remove-trunk-vlan (atomic per-VLAN
 *                             strip, newtron PR #225). Bookkeeping
 *                             matches the per-VLAN intent record.
 *   tagged:false + vlan_id  → unconfigure-interface (per-newtron case
 *                             A: cross-mode transitions rejected, so
 *                             prior state was always empty — clearing
 *                             the port restores it).
 *   vrf or ip               → unconfigure-interface (same reasoning
 *                             — routed mode can only be entered from
 *                             empty, so empty IS the prior state).
 *
 * Within-mode changes (e.g. routed-IP swap) are accepted by newtron
 * post-PR #229 (within-mode orphan fix) but undo isn't faithful for
 * those — clearing the port restores it to empty, not to the prior
 * IP. The apply-preview projection (171.B) surfaces what the undo
 * will actually do so the operator can Cancel if state has drifted.
 */
function inverseConfigureInterface(item: HistoryItem, id: string): Pending | null {
  const body = item.body;
  if (!body || !item.device || !item.iface) return null;

  // Trunk-add (#175.C.2.b) — atomic single-VLAN strip.
  if (body["tagged"] === true) {
    const vlanId = body["vlan_id"];
    if (typeof vlanId !== "number") return null;
    return {
      id,
      group: "interface",
      op: "action",
      device: item.device,
      iface: item.iface,
      actionId: "remove-trunk-vlan",
      label: "Remove trunk VLAN " + vlanId + " from " + item.device + ":" + item.iface,
      body: { vlan_id: vlanId },
      danger: true,
    };
  }

  // Access (tagged:false) or routed (vrf+ip) — both cleared via
  // unconfigure-interface (newtron case A enforcement).
  const isAccess = body["tagged"] === false && typeof body["vlan_id"] === "number";
  const isRouted = typeof body["vrf"] === "string" || typeof body["ip"] === "string";
  if (!isAccess && !isRouted) return null;
  return {
    id,
    group: "interface",
    op: "action",
    device: item.device,
    iface: item.iface,
    actionId: "unconfigure-interface",
    label: "Clear port configuration on " + item.device + ":" + item.iface,
    body: {},
    danger: true,
  };
}

/**
 * inverseDeviceAction is the hook for node-level RPC inverses. NODE_ACTIONS
 * is empty today so this slice ships zero device-level inverses; the
 * matching machinery is here for the moment they're added — every
 * node-level newtron verb has a paired inverse per the survey.
 */
function inverseDeviceAction(_item: HistoryItem, _id: string): Pending | null {
  return null;
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
