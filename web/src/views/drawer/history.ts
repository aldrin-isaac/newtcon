// views/drawer/history.ts — the device drawer's History tab: a per-device
// audit timeline.
//
// Fetches newtron's audit.events filtered to {device} and renders the same row
// layout the global Audit tab uses (consistent operator vocabulary). The filter
// is server-side via ?device= so the response stays bounded on busy networks.
//
// Empty-state cases are first-class:
//   - 404 from newtron → audit logging disabled on this deployment.
//   - 403 → operator lacks audit.read for this network.
//   - empty events array → no recorded activity for this device yet.

import { type AuditEvent, fetchAuditEvents } from "../../api/newtcon/audit.js";
import { renderEventsError, renderEventsTable } from "../../audit.js";
import { el } from "../../dom.js";

export async function renderHistoryTab(container: HTMLElement, device: string): Promise<void> {
  container.textContent = "";

  const header = el("div", { className: "node-history-header" });
  header.appendChild(el("p", { className: "node-history-intro" },
    `Recorded activity targeting ${device}. Source: newtron's audit log.`));
  const refresh = el("button", { type: "button", className: "node-history-refresh" }, "Refresh");
  header.appendChild(refresh);
  container.appendChild(header);

  const body = el("div", { className: "node-history-body" });
  body.appendChild(el("p", { className: "node-summary-loading" }, "Loading…"));
  container.appendChild(body);

  const load = async (): Promise<void> => {
    body.textContent = "";
    body.appendChild(el("p", { className: "node-summary-loading" }, "Loading…"));
    // newtron returns audit events newest-first by default (newtron
    // #274); offset 0 = the most recent for this device. Pass order=desc
    // explicitly for clarity. Show the newest page (older history is on
    // the Audit tab).
    let total = 0;
    let events: AuditEvent[] = [];
    try {
      const page = await fetchAuditEvents({ device, order: "desc", limit: 100 });
      total = page.total;
      events = page.events ?? [];
    } catch (err) {
      body.textContent = "";
      body.appendChild(el("p", { className: "panel-error" }, renderEventsError(err)));
      return;
    }
    body.textContent = "";
    if (events.length === 0) {
      body.appendChild(el("p", { className: "node-summary-stat-clean" },
        `No recorded activity for ${device} yet. Operator writes that touch this device will appear here once audit logging captures them.`));
      return;
    }
    const summary = el("p", { className: "node-history-summary" },
      `${events.length} of ${total} event${total === 1 ? "" : "s"} (most recent first).`);
    body.appendChild(summary);
    body.appendChild(renderEventsTable(events));
    if (total > events.length) {
      body.appendChild(el("p", { className: "node-history-paging-hint" },
        "Older events exist. Use the Audit tab for full pagination + cross-device filters."));
    }
  };

  refresh.addEventListener("click", () => { void load(); });
  void load();
}
