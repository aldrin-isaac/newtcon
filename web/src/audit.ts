// audit.ts — Audit tab view (slice #175.B). Wraps newtron's
// /audit/events + /audit/integrity endpoints with operator-friendly
// filters, cursor-based pagination, and a chain-integrity badge.
//
// Honest about the gates: 404 means audit logging is disabled on this
// deployment; 403 means the `audit.read` permission gate engaged and
// the caller isn't granted. Both render teaching empty states rather
// than transient error messages.

import {
  fetchAuditEvents,
  fetchAuditIntegrity,
  type AuditEvent,
  type AuditEventPage,
  type AuditIntegrityResult,
  type EventFilters,
} from "./api/newtcon/audit.js";
import { ApiError } from "./api/newtcon/services.js";
import { formatErrorBrief } from "./render-error.js";
import {
  activeFilterCount,
  eventStatusLabel,
  formatTimestamp,
  shortHash,
} from "./audit-format.js";

const PAGE_LIMIT = 100;

export async function mountAuditTab(root: HTMLElement): Promise<void> {
  root.textContent = "";
  root.appendChild(el("h2", { className: "view-heading" }, "Audit"));
  root.appendChild(el("p", { className: "view-intro" },
    "Newtron's authoritative audit log across every operator in this network. The integrity badge surfaces L6 hash-chain tamper-evidence."));

  const integrityHost = el("div", { className: "audit-integrity-host" });
  root.appendChild(integrityHost);

  const filters: EventFilters = {};
  const filterRow = renderFilterRow(filters, () => reloadEvents());
  root.appendChild(filterRow);

  const tableHost = el("div", { className: "audit-table-host" });
  root.appendChild(tableHost);

  let cursor: number | undefined = undefined;
  const collected: AuditEvent[] = [];
  let total = 0;

  const renderTable = (loading: boolean, errorMsg?: string): void => {
    tableHost.textContent = "";
    if (errorMsg) {
      tableHost.appendChild(el("p", { className: "view-empty" }, errorMsg));
      return;
    }
    if (collected.length === 0 && !loading) {
      tableHost.appendChild(el("p", { className: "view-empty" },
        activeFilterCount(filters as Record<string, unknown>) > 0
          ? "No events match the current filters."
          : "No audit events yet."));
      return;
    }
    tableHost.appendChild(renderEventsTable(collected));
    const footer = el("div", { className: "audit-table-footer" });
    footer.appendChild(el("span", { className: "audit-table-footer-count" },
      `Showing ${collected.length} of ${total}`));
    if (cursor !== undefined) {
      const more = el("button", { type: "button", className: "audit-load-more" },
        loading ? "Loading…" : "Load more");
      if (loading) more.setAttribute("disabled", "");
      more.addEventListener("click", () => { void loadNext(); });
      footer.appendChild(more);
    }
    tableHost.appendChild(footer);
  };

  const reloadEvents = async (): Promise<void> => {
    cursor = undefined;
    collected.length = 0;
    total = 0;
    renderTable(true);
    await loadNext();
  };

  const loadNext = async (): Promise<void> => {
    const q: EventFilters = { ...filters, limit: PAGE_LIMIT };
    if (cursor !== undefined) q.offset = cursor;
    renderTable(true);
    try {
      const page: AuditEventPage = await fetchAuditEvents(q);
      collected.push(...page.events);
      total = page.total;
      cursor = page.next_offset;
      renderTable(false);
    } catch (err) {
      renderTable(false, renderEventsError(err));
    }
  };

  // Integrity first — operator should see chain state before scanning
  // events. Fetched in parallel with the first events page.
  void fetchAuditIntegrity()
    .then((r) => { integrityHost.replaceChildren(renderIntegrity(r)); })
    .catch((err) => { integrityHost.replaceChildren(renderIntegrityError(err)); });

  void reloadEvents();
}

function renderIntegrity(r: AuditIntegrityResult): HTMLElement {
  const clean = r.break_at === 0;
  const box = el("div", {
    className: "audit-integrity audit-integrity--" + (clean ? "clean" : "broken"),
  });
  const head = el("div", { className: "audit-integrity-head" });
  const dot = el("span", { className: "audit-integrity-dot" });
  head.appendChild(dot);
  head.appendChild(el("strong", { className: "audit-integrity-title" },
    clean ? "Hash chain intact" : "Hash chain TAMPERED"));
  head.appendChild(el("span", { className: "audit-integrity-count" },
    `${r.entry_count} integrity-protected ${r.entry_count === 1 ? "entry" : "entries"}`));
  box.appendChild(head);

  const meta = el("dl", { className: "audit-integrity-meta" });
  meta.appendChild(el("dt", {}, "Chain head"));
  const hashDd = el("dd", { className: "audit-integrity-hash", title: r.chain_head_hash },
    shortHash(r.chain_head_hash));
  meta.appendChild(hashDd);
  meta.appendChild(el("dt", {}, "Verified at"));
  meta.appendChild(el("dd", {}, formatTimestamp(r.verified_at)));
  if (!clean) {
    meta.appendChild(el("dt", {}, "Break at line"));
    meta.appendChild(el("dd", { className: "audit-integrity-break" }, String(r.break_at)));
    meta.appendChild(el("dt", {}, "Break reason"));
    meta.appendChild(el("dd", { className: "audit-integrity-break" }, r.break_reason));
  }
  box.appendChild(meta);
  return box;
}

function renderIntegrityError(err: unknown): HTMLElement {
  const box = el("div", { className: "audit-integrity audit-integrity--unknown" });
  const head = el("div", { className: "audit-integrity-head" });
  head.appendChild(el("span", { className: "audit-integrity-dot" }));
  head.appendChild(el("strong", { className: "audit-integrity-title" },
    integrityErrorTitle(err)));
  box.appendChild(head);
  box.appendChild(el("p", { className: "audit-integrity-detail" }, integrityErrorDetail(err)));
  return box;
}

function integrityErrorTitle(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "Audit logging is disabled on this deployment";
    if (err.status === 403) return "audit.read permission required to view chain status";
  }
  return "Couldn't fetch integrity status";
}

function integrityErrorDetail(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return "Start newtron-server with --audit-log + --audit-log-integrity to enable the L6 hash-chain.";
  }
  if (err instanceof ApiError && err.status === 403) {
    return "Operator's grant doesn't include audit.read with field=audit_integrity (or full audit.read).";
  }
  return formatErrorBrief(err);
}

export function renderEventsError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return "Audit logging is disabled on this deployment. Start newtron-server with --audit-log to enable.";
  }
  if (err instanceof ApiError && err.status === 403) {
    return "Operator's grant doesn't include audit.read for this network.";
  }
  return "Couldn't fetch audit events: " + formatErrorBrief(err);
}

function renderFilterRow(filters: EventFilters, onChange: () => void): HTMLElement {
  const row = el("div", { className: "audit-filter-row" });
  // Use delete-on-empty to satisfy exactOptionalPropertyTypes — the
  // filter object's optional fields cannot be assigned undefined; the
  // key has to be removed.
  row.appendChild(makeFilterField(
    "since", "Since", "datetime-local",
    (v) => {
      if (v) filters.since = new Date(v).toISOString();
      else delete filters.since;
    }));
  row.appendChild(makeFilterField(
    "until", "Until", "datetime-local",
    (v) => {
      if (v) filters.until = new Date(v).toISOString();
      else delete filters.until;
    }));
  row.appendChild(makeFilterField(
    "device", "Device", "text",
    (v) => {
      if (v) filters.device = v;
      else delete filters.device;
    }));
  row.appendChild(makeFilterField(
    "user", "User", "text",
    (v) => {
      if (v) filters.user = v;
      else delete filters.user;
    }));

  // success filter — select with any/true/false
  const successWrap = el("label", { className: "audit-filter-field" });
  successWrap.appendChild(el("span", { className: "audit-filter-label" }, "Success"));
  const successSel = el("select", { className: "audit-filter-input" }) as HTMLSelectElement;
  for (const [v, label] of [["", "any"], ["true", "yes"], ["false", "no"]]) {
    const opt = el("option", { value: v }, label) as HTMLOptionElement;
    successSel.appendChild(opt);
  }
  successSel.addEventListener("change", () => {
    if (successSel.value === "") delete filters.success;
    else filters.success = successSel.value === "true";
  });
  successWrap.appendChild(successSel);
  row.appendChild(successWrap);

  const apply = el("button", { type: "button", className: "audit-filter-apply" }, "Apply");
  apply.addEventListener("click", () => { onChange(); });
  row.appendChild(apply);

  const reset = el("button", { type: "button", className: "audit-filter-reset" }, "Reset");
  reset.addEventListener("click", () => {
    for (const k of Object.keys(filters) as (keyof EventFilters)[]) {
      delete (filters as Record<string, unknown>)[k];
    }
    row.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".audit-filter-input")
      .forEach((input) => { input.value = ""; });
    onChange();
  });
  row.appendChild(reset);
  return row;
}

function makeFilterField(
  _name: string,
  label: string,
  type: "text" | "datetime-local",
  onInput: (value: string) => void,
): HTMLElement {
  const wrap = el("label", { className: "audit-filter-field" });
  wrap.appendChild(el("span", { className: "audit-filter-label" }, label));
  const input = el("input", { className: "audit-filter-input", type }) as HTMLInputElement;
  input.addEventListener("input", () => onInput(input.value));
  wrap.appendChild(input);
  return wrap;
}

export function renderEventsTable(events: AuditEvent[]): HTMLElement {
  const table = el("table", { className: "audit-table" });
  const head = el("thead");
  const headRow = el("tr");
  for (const h of ["Time", "User", "Device", "Operation", "Status"]) {
    headRow.appendChild(el("th", { className: "audit-th" }, h));
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el("tbody");
  for (const e of events) {
    body.appendChild(renderEventRow(e));
  }
  table.appendChild(body);
  return table;
}

function renderEventRow(e: AuditEvent): HTMLElement {
  const row = el("tr", { className: "audit-row" });
  row.appendChild(el("td", { className: "audit-td audit-td-time" }, formatTimestamp(e.timestamp)));
  row.appendChild(el("td", { className: "audit-td" }, e.user || "—"));
  row.appendChild(el("td", { className: "audit-td" }, e.device || "—"));
  row.appendChild(el("td", { className: "audit-td audit-td-op" }, e.operation || "—"));
  const status = eventStatusLabel(e);
  const td = el("td", { className: "audit-td" });
  td.appendChild(el("span", {
    className: "audit-status audit-status--" + status,
    title: e.error ?? "",
  }, status));
  row.appendChild(td);
  return row;
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
