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

  const itemsList = el("ol", { className: "history-items" });
  for (const item of entry.items) itemsList.appendChild(renderItem(item));
  details.appendChild(itemsList);

  li.appendChild(details);
  return li;
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
  return row;
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
