// history.ts — History tab view (slice #175.A).
//
// Renders the client-side Apply All history for the active network as
// a list of expandable entries. Most recent first. Per-entry summary +
// expand to show each item's title, scope, outcome (applied / failed),
// and any failure message verbatim.
//
// This is explicitly the OPERATOR'S per-browser record, not newtron's
// authoritative audit log — the intro copy says so. The audit-log
// viewer is a separate slice (175.B) gated on newtron's HTTP surface.

import {
  type HistoryEntry,
  type HistoryItem,
  clearHistory,
  loadHistory,
} from "./action-history.js";
import { activeNetwork } from "./network-switcher.js";
import { planUndo, type UndoPlan } from "./undo-plan.js";
import {
  enqueueDeviceAction,
  enqueueInterfaceAction,
  enqueueSpecCreate,
  enqueueSpecDelete,
  enqueueTopologyAddDevice,
  enqueueTopologyAddLink,
  enqueueTopologyRemoveDevice,
  enqueueTopologyRemoveLink,
} from "./staging.js";

export function mountHistoryTab(root: HTMLElement): void {
  root.textContent = "";
  const network = activeNetwork();
  const entries = loadHistory(network);

  root.appendChild(el("h2", { className: "view-heading" }, "History"));
  root.appendChild(el("p", { className: "view-intro" },
    "Recent Apply All runs in this network, recorded by this browser. " +
    "Up to 50 entries; older fall off. Not a substitute for newtron's audit log."));

  if (entries.length === 0) {
    root.appendChild(el("p", { className: "view-empty" },
      "(no history yet — apply some pending changes to see them here)"));
    return;
  }

  const controls = el("div", { className: "history-controls" });
  const countLine = el("span", { className: "history-count" },
    `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
  controls.appendChild(countLine);
  const clearBtn = el("button", { type: "button", className: "history-clear-btn" }, "Clear history");
  clearBtn.addEventListener("click", () => {
    if (!window.confirm(`Clear ${entries.length} history entr${entries.length === 1 ? "y" : "ies"} for "${network}"?`)) return;
    clearHistory(network);
    mountHistoryTab(root);
  });
  controls.appendChild(clearBtn);
  root.appendChild(controls);

  const list = el("ol", { className: "history-list" });
  for (const e of entries) list.appendChild(renderEntry(e));
  root.appendChild(list);
}

function renderEntry(entry: HistoryEntry): HTMLElement {
  const li = el("li", { className: "history-entry" });
  const details = el("details", { className: "history-entry-details" });

  const head = el("summary", { className: "history-entry-head" });
  head.appendChild(el("span", { className: "history-time" }, formatTime(entry.timestamp)));
  if (entry.user) {
    head.appendChild(el("span", { className: "history-user" }, entry.user));
  }
  const statusText = entry.summary.failed > 0
    ? `${entry.summary.applied} applied / ${entry.summary.failed} failed`
    : `${entry.summary.applied} applied`;
  const statusEl = el("span", {
    className: "history-status" + (entry.summary.failed > 0 ? " history-status--failed" : ""),
  }, statusText);
  head.appendChild(statusEl);
  if (entry.summary.danger > 0) {
    head.appendChild(el("span", { className: "history-danger-tag" },
      `${entry.summary.danger} destructive`));
  }
  details.appendChild(head);

  // Per-entry Undo (slice #175.C.1). The button is enabled when AT
  // LEAST ONE item in this entry is undoable; per-item undoable status
  // is rendered honestly beside each row below. Click stages the
  // inverse Pending list and lets the operator confirm via the same
  // Apply modal any other change goes through.
  const undoablePlan = planUndo(entry, (i) => `undo-${entry.id}-${i}`);
  if (undoablePlan.counts.planned > 0) {
    details.appendChild(renderEntryUndoBar(entry, undoablePlan));
  }

  const itemsList = el("ol", { className: "history-items" });
  for (const item of entry.items) itemsList.appendChild(renderItem(item));
  details.appendChild(itemsList);

  li.appendChild(details);
  return li;
}

function renderEntryUndoBar(entry: HistoryEntry, plan: UndoPlan): HTMLElement {
  const bar = el("div", { className: "history-undo-bar" });
  const summary = el("span", { className: "history-undo-summary" });
  if (plan.counts.skipped === 0) {
    summary.textContent =
      `${plan.counts.planned} item${plan.counts.planned === 1 ? "" : "s"} can be undone.`;
  } else {
    summary.textContent =
      `${plan.counts.planned} can be undone, ${plan.counts.skipped} cannot.`;
  }
  bar.appendChild(summary);
  const btn = el("button", { type: "button", className: "history-undo-btn" }, "Stage undo");
  btn.title = "Stage the inverse operations. You'll confirm via the usual Apply preview.";
  btn.addEventListener("click", () => {
    const queuedNames: string[] = [];
    for (const item of plan.items) {
      if (!item.planned || !item.inverse) continue;
      const inv = item.inverse;
      if (inv.group === "spec" && inv.op === "create") {
        enqueueSpecCreate(inv.kind, inv.name, inv.body);
        queuedNames.push(`+ ${inv.kind} ${inv.name}`);
      } else if (inv.group === "spec" && inv.op === "delete") {
        enqueueSpecDelete(inv.kind, inv.name);
        queuedNames.push(`− ${inv.kind} ${inv.name}`);
      } else if (inv.group === "topology" && inv.op === "add-device") {
        enqueueTopologyAddDevice(inv.name, inv.body);
        queuedNames.push(`+ device ${inv.name}`);
      } else if (inv.group === "topology" && inv.op === "remove-device") {
        enqueueTopologyRemoveDevice(inv.name);
        queuedNames.push(`− device ${inv.name}`);
      } else if (inv.group === "topology" && inv.op === "add-link") {
        enqueueTopologyAddLink(inv.a, inv.z);
        queuedNames.push(`+ link ${inv.a} ↔ ${inv.z}`);
      } else if (inv.group === "topology" && inv.op === "remove-link") {
        enqueueTopologyRemoveLink(inv.device, inv.iface);
        queuedNames.push(`− link ${inv.device}:${inv.iface}`);
      } else if (inv.group === "device" && inv.op === "action") {
        enqueueDeviceAction(inv.device, inv.actionId, inv.label, inv.body, inv.danger);
        queuedNames.push(`${inv.device}: ${inv.label}`);
      } else if (inv.group === "interface" && inv.op === "action") {
        enqueueInterfaceAction(inv.device, inv.iface, inv.actionId, inv.label, inv.body, inv.danger);
        queuedNames.push(`${inv.device}:${inv.iface}: ${inv.label}`);
      }
    }
    btn.setAttribute("disabled", "");
    btn.textContent = "Staged";
    const note = el("p", { className: "history-undo-note" },
      `Staged ${queuedNames.length} inverse change${queuedNames.length === 1 ? "" : "s"} into the pending queue. ` +
      "Click Save in the header to apply (same confirm modal + per-device projection as any other Apply).");
    bar.appendChild(note);
    void entry; // entry id is in the bar for future re-mount hooks
  });
  bar.appendChild(btn);
  return bar;
}

function renderItem(item: HistoryItem): HTMLElement {
  const row = el("li", {
    className: "history-item history-item--" + item.effect
      + " history-item--" + item.outcome
      + (item.danger ? " history-item--danger" : ""),
  });

  const main = el("div", { className: "history-item-main" });
  const marker = item.effect === "create" ? "+" : item.effect === "delete" ? "−" : "•";
  main.appendChild(el("span", { className: "history-item-marker" }, marker));
  main.appendChild(el("span", { className: "history-item-kind" }, item.kind));
  main.appendChild(el("span", { className: "history-item-title" }, item.title));
  if (item.scope) {
    main.appendChild(el("span", { className: "history-item-scope" }, item.scope));
  }
  main.appendChild(el("span", {
    className: "history-item-outcome history-item-outcome--" + item.outcome,
    title: item.outcome === "applied" ? "Applied successfully" : "Failed",
  }, item.outcome === "applied" ? "✓" : "✗"));
  row.appendChild(main);

  if (item.error) {
    row.appendChild(el("p", { className: "history-item-error" }, item.error));
  }
  // Per-item undoable annotation (slice #175.C.1) — honest about
  // device/interface actions, missing pre-bodies, and the data-layer
  // scope.
  if (item.undoable === false) {
    row.appendChild(el("p", { className: "history-item-not-undoable" },
      itemUndoSkipReason(item)));
  }
  return row;
}

function itemUndoSkipReason(item: HistoryItem): string {
  if (item.kind === "device action" || item.kind === "interface action") {
    if (item.actionId) {
      return "Not undoable — no inverse mapping for actionId '" + item.actionId + "' yet.";
    }
    return "Not undoable — action kind not yet supported.";
  }
  if (item.effect === "delete" && item.preBody === undefined) {
    return "Not undoable — pre-apply body wasn't captured.";
  }
  return "Not undoable from this entry.";
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  for (const c of children) {
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}
