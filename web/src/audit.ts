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
  fetchAuditEvent,
  fetchAuditIntegrity,
  type AuditEvent,
  type AuditChange,
  type AuditEventPage,
  type AuditIntegrityResult,
  type EventFilters,
} from "./api/newtcon/audit.js";
import { el } from "./dom.js";
import { ApiError } from "./api/newtcon/services.js";
import { formatErrorBrief } from "./render-error.js";
import {
  activeFilterCount,
  eventStatusLabel,
  statusTooltip,
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

  // newtron's /audit/events defaults to newest-first (newtron #274:
  // offset 0 = most recent, paging walks back into history). We pass
  // order=desc explicitly so intent is clear and we're robust to any
  // future default change. Plain forward paging: append each page (it's
  // already newest-first), follow next_offset for "Load older".
  const collected: AuditEvent[] = [];
  let total = 0;
  let cursor: number | undefined = undefined;

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
        loading ? "Loading…" : "Load older");
      if (loading) more.setAttribute("disabled", "");
      more.addEventListener("click", () => { void loadNext(); });
      footer.appendChild(more);
    }
    tableHost.appendChild(footer);
  };

  const reloadEvents = async (): Promise<void> => {
    collected.length = 0;
    total = 0;
    cursor = undefined;
    renderTable(true);
    await loadNext();
  };

  const loadNext = async (): Promise<void> => {
    const q: EventFilters = { ...filters, order: "desc", limit: PAGE_LIMIT };
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
  const dot = el("span", { className: "status-dot status-dot--lg status-dot--" + (clean ? "ok" : "error") });
  head.appendChild(dot);
  head.appendChild(el("strong", { className: "audit-integrity-title" },
    clean ? "Hash chain intact" : "Hash chain TAMPERED"));
  head.appendChild(el("span", { className: "audit-integrity-count" },
    `${r.entry_count} integrity-protected ${r.entry_count === 1 ? "entry" : "entries"}`));
  box.appendChild(head);

  const meta = el("dl", { className: "kv kv--xs audit-integrity-meta" });
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
  head.appendChild(el("span", { className: "status-dot status-dot--lg" }));
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
  const row = el("tr", { className: "audit-row audit-row--expandable" });
  row.appendChild(el("td", { className: "audit-td audit-td-time" }, formatTimestamp(e.timestamp)));
  row.appendChild(el("td", { className: "audit-td" }, e.user || "—"));
  row.appendChild(el("td", { className: "audit-td" }, e.device || "—"));
  row.appendChild(el("td", { className: "audit-td audit-td-op" }, e.operation || "—"));
  const status = eventStatusLabel(e);
  const td = el("td", { className: "audit-td" });
  td.appendChild(el("span", {
    className: "audit-status audit-status--" + status,
    // Informational badge, not a button — the tooltip explains the
    // status so "PREVIEW" isn't misread as a clickable preview action.
    title: statusTooltip(e),
  }, status));
  row.appendChild(td);

  // Click → expand a detail row beneath with the request body + the
  // CONFIG_DB change-set (newtron #276), fetched lazily on first open and
  // cached. The detail row (and its cell) is destroyed on collapse, so re-open
  // builds a fresh cell — it must render from the cache, not just guard the
  // fetch (else the second open is stuck on "Loading…").
  let detailRow: HTMLElement | null = null;
  let detail: AuditEvent | null = null;
  row.addEventListener("click", () => {
    if (detailRow) {
      detailRow.remove();
      detailRow = null;
      row.classList.remove("audit-row--open");
      return;
    }
    detailRow = el("tr", { className: "audit-detail-row" });
    const cell = el("td", { className: "audit-detail-cell" });
    cell.colSpan = 5;
    detailRow.appendChild(cell);
    row.after(detailRow);
    row.classList.add("audit-row--open");
    if (detail) {
      renderEventDetail(cell, detail);
      return;
    }
    cell.appendChild(el("p", { className: "audit-detail-loading" }, "Loading…"));
    void fetchAuditEvent(e.id)
      .then((full) => { detail = full; cell.textContent = ""; renderEventDetail(cell, full); })
      .catch((err) => {
        // Leave detail null so the next open retries the fetch.
        cell.textContent = "";
        cell.appendChild(el("p", { className: "audit-detail-error" }, renderEventsError(err)));
      });
  });
  return row;
}

// renderEventDetail fills the expanded row with the request body the
// caller submitted (redacted server-side) and the resulting CONFIG_DB
// change-set. Spec-authoring ops legitimately have an empty change-set —
// their content is the request body.
function renderEventDetail(host: HTMLElement, e: AuditEvent): void {
  const wrap = el("div", { className: "audit-detail" });

  // Envelope — always present, so the panel is never empty. For events
  // recorded before newtron #276 (no request_body / changes) this is the
  // meaningful detail; the operation is shown in full (untruncated).
  wrap.appendChild(el("p", { className: "audit-detail-operation" }, e.operation || "—"));

  // Failure callout — for a failed event the *why* is the headline. Pin
  // the error above the body/changes so the operator sees it first. The
  // error string is whatever newtron recorded (today often just the HTTP
  // status text — see the audit-error-detail gap); show it verbatim, with
  // an honest fallback when none was captured.
  if (e.success === false) {
    const fail = el("div", { className: "audit-detail-failure" });
    fail.appendChild(el("span", { className: "audit-detail-failure-label" }, "Failed"));
    const msg = e.error && e.error.trim() !== "" ? e.error : "No error message recorded.";
    fail.appendChild(el("p", { className: "audit-detail-failure-msg" }, msg));
    wrap.appendChild(fail);
  }
  const envDl = el("dl", { className: "audit-detail-body" });
  for (const [k, v] of [["User", e.user], ["Client IP", e.client_ip], ["Duration", e.duration]] as Array<[string, unknown]>) {
    if (v === undefined || v === null || v === "") continue;
    envDl.appendChild(el("dt", { className: "audit-detail-key" }, k));
    envDl.appendChild(el("dd", { className: "audit-detail-val" }, String(v)));
  }
  if (envDl.children.length > 0) wrap.appendChild(envDl);

  const body = e.request_body;
  const bodyEmpty = body === undefined || body === null
    || (typeof body === "object" && Object.keys(body as object).length === 0);
  if (!bodyEmpty) {
    wrap.appendChild(el("p", { className: "audit-detail-label" }, "Request body"));
    if (typeof body === "object") {
      const dl = el("dl", { className: "audit-detail-body" });
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        dl.appendChild(el("dt", { className: "audit-detail-key" }, k));
        dl.appendChild(el("dd", { className: "audit-detail-val" }, formatDetailValue(v)));
      }
      wrap.appendChild(dl);
    } else {
      wrap.appendChild(el("pre", { className: "audit-detail-raw" }, String(body)));
    }
  }

  const changes: AuditChange[] = Array.isArray(e.changes) ? e.changes : [];
  if (changes.length > 0) {
    wrap.appendChild(el("p", { className: "audit-detail-label" }, `Device changes (${changes.length})`));
    const table = el("table", { className: "audit-changes-table" });
    const head = el("tr");
    for (const h of ["Table", "Key", "Type", "Fields"]) head.appendChild(el("th", { className: "audit-changes-th" }, h));
    table.appendChild(head);
    for (const c of changes) {
      const tr = el("tr");
      tr.appendChild(el("td", { className: "audit-changes-td" }, c.table || "—"));
      tr.appendChild(el("td", { className: "audit-changes-td" }, c.key || "—"));
      tr.appendChild(el("td", { className: "audit-changes-td audit-changes-type--" + c.type }, c.type || "—"));
      tr.appendChild(el("td", { className: "audit-changes-td" }, c.fields ? formatDetailValue(c.fields) : "—"));
      table.appendChild(tr);
    }
    wrap.appendChild(table);
  }

  // No body and no device changes — note it (e.g. a read op, a
  // spec-authoring op with an empty change-set, or an event recorded
  // before newtron #276 captured content). The operation above still
  // tells the operator what happened.
  if (bodyEmpty && changes.length === 0) {
    wrap.appendChild(el("p", { className: "audit-detail-empty" },
      "No request body or device changes recorded for this event."));
  }
  host.appendChild(wrap);
}

function formatDetailValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

