// views/specs/subrules.ts — the unified sub-rule inline table (slice #173):
// the per-kind table definitions AND the renderers that draw them.
//
// Config and rendering live together deliberately. subRuleTables replaced an
// earlier split between subRuleWireField + subRuleForms + a hard-coded switch
// in the delete section — three places that went out of sync — so the table
// definition is the single source of truth for every sub-rule kind, sitting
// next to the only code that reads it.
//
// Pure helpers (row-cell extraction, key derivation, update-body composition,
// reorder-seq arithmetic, pending overlay) live in ../../subrule-table.ts and
// are unit-tested independently of the DOM.
//
// CYCLE (deliberate, load-safe): the renderers re-open the spec drawer after a
// staged mutation (openDetail from detail.ts), and detail.ts reads subRuleTables
// + calls renderSubRuleTable from here. subRuleTables is only READ at call time,
// never at module-init, and the functions are hoisted declarations — so
// evaluation order doesn't matter.

import { type SpecKind } from "../../api/newtcon/network.js";
import { fetchSchema, resolveSubRuleKind } from "../../api/newtcon/schema.js";
import { el } from "../../dom.js";
import { clearFieldErrors } from "../../form-error-binding.js";
import { formatErrorBrief } from "../../render-error.js";
import { renderSchemaForm } from "../../schema-form.js";
import { type SpecKind as StagingSpecKind, enqueueSubCreate, enqueueSubDelete, enqueueSubReorder, enqueueSubUpdate, pendingSubMutations, removeFromQueue } from "../../staging.js";
import { type SubDisplayRow, type SubRuleColumn, type SubRuleItemType, composeUpdateBody, computeReorderSeq, extractRowCells, getSubRuleItems, itemKey, overlaySubRuleItems } from "../../subrule-table.js";
import { openDetail } from "./detail.js";
import { type FieldDef, PATTERNS, buildFormFields } from "./fields.js";
import { kindTitleFor } from "./panels.js";

// subRuleTables is the single source of truth for every sub-rule kind.
// Each entry carries enough info to render the unified inline table
// (slice #173.A): the wire field on the spec detail, the POST endpoint,
// the singular item label, the item shape (object vs string for prefix-
// lists), the keyField used to delete an item, the table columns, and
// the FieldDefs for the inline Add form.
//
// Notably, prefix-lists's wire field is "prefixes" but its add endpoint
// is "entries" — historical newtron divergence. Both stay accurate
// because they're declared separately.
export interface SubRuleTable {
  wireField: string;
  endpoint: string;
  itemLabel: string;
  itemType: SubRuleItemType;
  keyField?: string;
  columns: SubRuleColumn[];
  addFields: FieldDef[];
  /**
   * When true, ↑/↓ reorder buttons appear in the per-row actions
   * (slice #173.C). Set for sequence-ordered kinds (filter rules,
   * route-policy rules) where reorder is operator-meaningful.
   * NOT set for qos-policies (queue_id is hardware-meaningful, not
   * an arbitrary order) or prefix-lists (unordered set).
   */
  reorderable?: boolean;
}

export const subRuleTables: Partial<Record<SpecKind, SubRuleTable>> = {
  "qos-policies": {
    wireField: "queues",
    endpoint: "queues",
    itemLabel: "queue",
    itemType: "object",
    keyField: "queue_id",
    columns: [
      { field: "queue_id", label: "ID" },
      { field: "name",     label: "Name" },
      { field: "type",     label: "Type" },
      { field: "weight",   label: "Weight" },
    ],
    addFields: [
      {
        name: "queue_id", label: "Queue ID", type: "number", required: true,
        min: 0, help: "Hardware queue index. Range and reserved IDs depend on the platform.",
      },
      { name: "name", label: "Queue name", type: "text", required: true },
      {
        name: "type", label: "Scheduling type", type: "select", required: true,
        options: ["strict", "wrr", "wfq", "dwrr"],
        help: "strict = highest-priority-first. wrr / wfq / dwrr = weighted round-robin variants; weight matters.",
      },
      {
        name: "weight", label: "Weight", type: "number",
        placeholder: "0 = strict", min: 0,
        help: "Round-robin weight. Ignored when scheduling type is strict.",
      },
    ],
  },
  filters: {
    wireField: "rules",
    endpoint: "rules",
    itemLabel: "rule",
    itemType: "object",
    keyField: "seq",
    reorderable: true,
    columns: [
      { field: "seq",       label: "Seq" },
      { field: "action",    label: "Action" },
      { field: "src_ip",    label: "Src IP" },
      { field: "dst_ip",    label: "Dst IP" },
      { field: "protocol",  label: "Proto" },
      { field: "src_port",  label: "Src port" },
      { field: "dst_port",  label: "Dst port" },
    ],
    addFields: [
      {
        name: "seq", label: "Sequence", type: "number", required: true,
        placeholder: "e.g. 10", min: 1,
        help: "Rules evaluate in ascending sequence order. Conventionally start at 10 and step by 10 so inserts don't require renumbering.",
      },
      {
        name: "action", label: "Action", type: "select", required: true,
        options: ["permit", "deny"],
      },
      {
        name: "src_ip", label: "Source IP/prefix", type: "text",
        placeholder: "e.g. 10.0.0.0/8",
        pattern: PATTERNS.IPV4_CIDR,
        patternTitle: "IPv4 address with optional /prefix (e.g. 10.0.0.0/8)",
      },
      {
        name: "dst_ip", label: "Destination IP/prefix", type: "text",
        placeholder: "e.g. 0.0.0.0/0",
        pattern: PATTERNS.IPV4_CIDR,
        patternTitle: "IPv4 address with optional /prefix (e.g. 0.0.0.0/0)",
      },
      { name: "protocol", label: "Protocol", type: "text", placeholder: "e.g. tcp, udp" },
      { name: "src_port", label: "Source port", type: "text", placeholder: "e.g. 80" },
      { name: "dst_port", label: "Destination port", type: "text", placeholder: "e.g. 443" },
    ],
  },
  "prefix-lists": {
    wireField: "prefixes",
    endpoint: "entries",
    itemLabel: "prefix",
    itemType: "string",
    columns: [
      { field: "", label: "Prefix" },
    ],
    addFields: [
      {
        name: "prefix", label: "Prefix (CIDR)", type: "text", required: true,
        placeholder: "e.g. 10.0.0.0/8",
        pattern: PATTERNS.IPV4_CIDR,
        patternTitle: "IPv4 prefix in CIDR form (e.g. 10.0.0.0/8). IPv6 entries are accepted by newtron but not validated here yet.",
      },
    ],
  },
  "route-policies": {
    wireField: "rules",
    endpoint: "rules",
    itemLabel: "rule",
    itemType: "object",
    keyField: "seq",
    reorderable: true,
    columns: [
      { field: "seq",         label: "Seq" },
      { field: "action",      label: "Action" },
      { field: "prefix_list", label: "Prefix list" },
      { field: "community",   label: "Community" },
    ],
    addFields: [
      {
        name: "seq", label: "Sequence", type: "number", required: true,
        placeholder: "e.g. 10", min: 1,
        help: "Statements evaluate in ascending sequence order. Conventionally start at 10 and step by 10 so inserts don't require renumbering.",
      },
      {
        name: "action", label: "Action", type: "select", required: true,
        options: ["permit", "deny"],
      },
      { name: "prefix_list", label: "Prefix list", type: "text", placeholder: "Match prefix list name" },
      { name: "community", label: "Community", type: "text", placeholder: "BGP community string" },
    ],
  },
};

// renderSubRuleTable renders the unified inline-table section
// (slice #173.A): one heading, one table for existing items with a
// per-row delete affordance, and one "+ Add <item>" button at the
// bottom that expands an inline form. Replaces the earlier two-section
// pattern (separate "Existing X" list + collapsed "Add X" form).
export function renderSubRuleTable(
  kind: SpecKind,
  specName: string,
  detail: unknown,
  content: HTMLElement,
  conf: SubRuleTable,
): void {
  const items = getSubRuleItems(detail, conf.wireField);

  const section = el("section", { className: "subrule-section" });

  // Plural heading — "Rules" / "Queues" / "Prefixes". The earlier UI
  // wrote "Existing rules" + "Add rule" as two separate concerns; one
  // section with the items + an Add affordance reads as the same
  // concern.
  const headingText = pluralize(conf.itemLabel);
  section.appendChild(el("h3", { className: "subrule-heading" },
    headingText.charAt(0).toUpperCase() + headingText.slice(1)));

  // Table
  const table = el("table", { className: "table table--mono-all table--headband subrule-table" });
  const thead = el("thead");
  const headRow = el("tr");
  for (const col of conf.columns) {
    headRow.appendChild(el("th", { className: "subrule-th" }, col.label));
  }
  // Trailing column for the per-row delete button.
  headRow.appendChild(el("th", { className: "subrule-th subrule-th--actions" }, ""));
  thead.appendChild(headRow);
  table.appendChild(thead);

  // Overlay queued sub-rule ops on the committed rows so staged adds (green),
  // edits (amber), and removes (struck) show before Apply.
  const pendingOps = pendingSubMutations(kind as StagingSpecKind, specName, conf.endpoint);
  const rows = overlaySubRuleItems(items, pendingOps, conf.itemType, conf.keyField);

  const tbody = el("tbody");
  if (rows.length === 0) {
    const emptyRow = el("tr", { className: "subrule-row-empty" });
    const cell = el("td", { className: "subrule-td subrule-td--empty" }, "(none)") as HTMLTableCellElement;
    cell.colSpan = conf.columns.length + 1;
    emptyRow.appendChild(cell);
    tbody.appendChild(emptyRow);
  } else {
    // Reorder targets the committed rows only, so compute seqs from `items`.
    const sortedSeqs = conf.reorderable && conf.keyField
      ? collectSortedSeqs(items, conf.keyField)
      : null;
    for (const dr of rows) {
      tbody.appendChild(renderSubRuleRow(kind, specName, dr, conf, sortedSeqs));
    }
  }
  table.appendChild(tbody);
  section.appendChild(table);

  // Add affordance — button below the table; click expands the form
  // inline within the section.
  section.appendChild(renderSubRuleAdd(kind, specName, conf));
  content.appendChild(section);
}

function renderSubRuleRow(
  kind: SpecKind,
  specName: string,
  dr: SubDisplayRow,
  conf: SubRuleTable,
  sortedSeqs: readonly number[] | null,
): HTMLElement {
  const item = dr.item;
  const row = el("tr", {
    className: "subrule-row" + (dr.pending !== "none" ? ` subrule-row--pending-${dr.pending}` : ""),
  });
  const cells = extractRowCells(item, conf.columns, conf.itemType);
  for (const v of cells) {
    const td = el("td", { className: "subrule-td" });
    if (v === "") {
      td.appendChild(el("span", { className: "subrule-empty-cell" }, "—"));
    } else {
      td.appendChild(document.createTextNode(v));
    }
    row.appendChild(td);
  }
  const actionsCell = el("td", { className: "subrule-td subrule-td--actions" });

  // Pending rows (staged add/edit/remove) carry no edit/delete/reorder — just
  // an undo that drops the queued op. The committed row stands until Apply.
  if (dr.pending !== "none") {
    const undoBtn = el("button", {
      type: "button",
      className: "subrule-undo-btn",
      title: dr.pending === "add" ? "Drop this queued addition"
        : dr.pending === "remove" ? "Keep this — undo the queued removal"
          : "Undo this queued edit",
    }, "↺");
    if (dr.opId) {
      undoBtn.addEventListener("click", () => {
        removeFromQueue(dr.opId!);
        openDetail(kind, kindTitleFor(kind), specName);
      });
    }
    actionsCell.appendChild(undoBtn);
    row.appendChild(actionsCell);
    return row;
  }

  const key = itemKey(item, conf.itemType, conf.keyField);
  if (key !== null) {
    // Reorder buttons (slice #173.C) — only for reorderable kinds with
    // sortedSeqs computed at the table level. Computes a target new_seq
    // via midpoint-of-gap heuristic; null result disables the button.
    if (conf.reorderable && sortedSeqs && typeof key === "number") {
      actionsCell.appendChild(makeReorderBtn(kind, specName, conf, key, sortedSeqs, "up"));
      actionsCell.appendChild(makeReorderBtn(kind, specName, conf, key, sortedSeqs, "down"));
    }
    // Edit button (slice #173.B). Swaps the row for an inline edit
    // form prefilled with the item's current values. Suppressed for
    // itemType "string" (prefix-list entries) — their only "field" is
    // the key, and newtron #239 removed the update verb. Renaming a
    // prefix is Remove + Add via the × button + the inline Add form.
    if (conf.itemType !== "string") {
      const editBtn = el("button", {
        type: "button",
        className: "subrule-edit-btn",
        title: `Edit ${conf.itemLabel} ${key}`,
      }, "✎");
      editBtn.addEventListener("click", () => {
        const editRow = renderSubRuleEdit(kind, specName, item, conf, row);
        row.replaceWith(editRow);
      });
      actionsCell.appendChild(editBtn);
    }

    const delBtn = el("button", {
      type: "button",
      className: "subrule-delete-btn",
      title: `Remove ${conf.itemLabel} ${key}`,
    }, "×");
    delBtn.addEventListener("click", () => {
      // Queue the removal; the row re-renders struck-through (pending) and is
      // confirmed at Apply, like every other staged change. preBody (the row +
      // the parent-ref the re-create POST needs) lets undo re-create it — for
      // object rows it's the row itself; for string entries (prefix lists) we
      // rebuild the add-body from the entry value + its add-form field name.
      let pre: Record<string, unknown> | undefined;
      if (conf.itemType === "object" && item && typeof item === "object") {
        pre = injectParentName(kind, specName, item as Record<string, unknown>);
      } else if (conf.itemType === "string" && typeof item === "string" && conf.addFields[0]) {
        pre = injectParentName(kind, specName, { [conf.addFields[0].name]: item });
      }
      enqueueSubDelete(kind as StagingSpecKind, specName, conf.endpoint, key, String(key), pre);
      openDetail(kind, kindTitleFor(kind), specName);
    });
    actionsCell.appendChild(delBtn);
  }
  row.appendChild(actionsCell);
  return row;
}

// renderSubRuleEdit returns an inline edit row (slice #173.B) for a
// single sub-rule item. Replaces the read-only row via row.replaceWith
// when the operator clicks the Edit button. On Save: queues the update
// and re-opens the detail to refresh; on Cancel: swaps the original row
// back in.
function renderSubRuleEdit(
  kind: SpecKind,
  specName: string,
  item: unknown,
  conf: SubRuleTable,
  originalRow: HTMLElement,
): HTMLElement {
  const editRow = el("tr", { className: "subrule-row subrule-row--editing" });
  const cell = el("td", { className: "subrule-td subrule-td--edit-cell" }) as HTMLTableCellElement;
  cell.colSpan = conf.columns.length + 1;

  // Reaches here only for object items (per the gate in renderSubRuleRow).
  // The addFields field names match the item's wire shape — prefill is
  // the item itself.
  const prefill: Record<string, unknown> = { ...(item as Record<string, unknown>) };

  const { form, getValues, validate } = buildFormFields(conf.addFields, { prefill });
  cell.appendChild(form);

  const errOut = el("div", { className: "form-error-out" });
  cell.appendChild(errOut);

  const buttons = el("div", { className: "form-button-row" });
  const saveBtn = el("button", { type: "button", className: "form-submit-btn" }, "Save");
  const cancelBtn = el("button", { type: "button", className: "form-cancel-btn" }, "Cancel");
  buttons.appendChild(saveBtn);
  buttons.appendChild(cancelBtn);
  cell.appendChild(buttons);

  editRow.appendChild(cell);

  cancelBtn.addEventListener("click", () => {
    editRow.replaceWith(originalRow);
  });

  saveBtn.addEventListener("click", async () => {
    clearFieldErrors(form);
    if (!validate()) return;
    errOut.textContent = "";
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    const values = getValues();
    const originalKey = itemKey(item, conf.itemType, conf.keyField);
    if (originalKey === null) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
      errOut.appendChild(el("p", { className: "panel-error" }, "Couldn't determine identifier for this row."));
      return;
    }
    const body = composeUpdateBody(values, conf.itemType, conf.keyField, originalKey);
    // preBody (the row before the edit) lets undo restore it.
    const pre = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
    enqueueSubUpdate(kind as StagingSpecKind, specName, conf.endpoint, originalKey, body, String(originalKey), pre);
    openDetail(kind, kindTitleFor(kind), specName);
  });
  return editRow;
}

function renderSubRuleAdd(
  kind: SpecKind,
  specName: string,
  conf: SubRuleTable,
): HTMLElement {
  const wrap = el("div", { className: "subrule-add" });
  const addBtn = el("button", { type: "button", className: "subrule-add-btn" },
    "+ Add " + conf.itemLabel);
  wrap.appendChild(addBtn);

  const formArea = el("div", { className: "subrule-add-form" });
  formArea.hidden = true;
  wrap.appendChild(formArea);

  // Dynamic dispatch — try the schema path first. resolveSubRuleKind
  // walks newtron's schema to find the sub-rule kind nested under
  // this parent (FilterSpec.rules → FilterRule, QoSPolicy.queues →
  // QoSQueue, prefix-lists → PrefixListEntry via parent_ref). When
  // it returns a kind, we render schema-driven; otherwise fall back
  // to conf.addFields. Decision is async — the form area shows a
  // loading state until resolution completes.
  const loading = el("p", { className: "status-loading" }, "Loading form…");
  formArea.appendChild(loading);

  addBtn.addEventListener("click", () => {
    addBtn.hidden = true;
    formArea.hidden = false;
  });

  void (async () => {
    const subKind = await resolveSubRuleKind(kind).catch(() => null);
    loading.remove();
    if (subKind !== null) {
      await mountSchemaSubRuleAddForm(
        kind, specName, conf, subKind, formArea, addBtn,
      );
    } else {
      mountLegacySubRuleAddForm(
        kind, specName, conf, formArea, addBtn,
      );
    }
  })();

  return wrap;
}

/**
 * mountSchemaSubRuleAddForm — renders the sub-rule add form from
 * newtron's schema for the sub-rule kind. parent_ref is injected
 * into the body at submit time so newtron's add-X verb gets
 * {<parent_ref>: <parent_name>, ...field_values}.
 */
async function mountSchemaSubRuleAddForm(
  kind: SpecKind,
  specName: string,
  conf: SubRuleTable,
  subKind: string,
  formArea: HTMLElement,
  addBtn: HTMLElement,
): Promise<void> {
  let schema;
  try {
    schema = await fetchSchema(subKind);
  } catch (err) {
    formArea.appendChild(el("p", { className: "panel-error" },
      `Schema for ${subKind} unavailable: ${formatErrorBrief(err)}`));
    return;
  }
  // A sub-rule is nested in its parent and isn't independently scoped — it
  // belongs to whichever parent instance the operator opened, so its scope is
  // the parent's (inferred), never a per-sub-rule choice. newtron's sub-item
  // schemas still carry scope/scope_instance (filed as a schema gap); exclude
  // them here so the add form doesn't ask.
  const { form, getValues, validate } = await renderSchemaForm({ schema, skipFields: new Set(["scope", "scope_instance"]) });
  formArea.appendChild(form);

  const errOut = el("div", { className: "form-error-out" });
  formArea.appendChild(errOut);

  const buttons = el("div", { className: "form-button-row" });
  const submitBtn = el("button", { type: "button", className: "form-submit-btn" },
    "Add " + conf.itemLabel);
  const cancelBtn = el("button", { type: "button", className: "form-cancel-btn" }, "Cancel");
  buttons.appendChild(submitBtn);
  buttons.appendChild(cancelBtn);
  formArea.appendChild(buttons);

  cancelBtn.addEventListener("click", () => {
    formArea.hidden = true;
    addBtn.hidden = false;
    errOut.textContent = "";
  });

  submitBtn.addEventListener("click", async () => {
    if (!validate()) return;
    errOut.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    const values = getValues();
    if (schema.parent_ref) {
      // Inject the parent's name into the body using newtron's declared wire
      // field. No newtcon-side semantic mapping.
      values[schema.parent_ref] = specName;
    }
    // Queue the add (same staging thread as everything else); re-render so the
    // table shows it as a green pending row.
    enqueueSubCreate(kind as StagingSpecKind, specName, conf.endpoint, subKeyFromBody(values, conf), values, subTitle(values, conf));
    openDetail(kind, kindTitleFor(kind), specName);
  });
}

// subTitle — a short label for a queued sub-rule op (the key value when there
// is one, else the item label). Used in the pending bar + apply-preview.
function subTitle(body: Record<string, unknown>, conf: SubRuleTable): string {
  const k = subKeyFromBody(body, conf);
  return k !== "" ? String(k) : conf.itemLabel;
}

// subKeyFromBody derives the row's identity from an add-form body so the queued
// create carries the key undo needs to DELETE exactly that row. Object items
// (rules/queues) key on conf.keyField; string items (prefix entries) key on
// their lone value field (injected parent-ref fields are skipped).
function subKeyFromBody(body: Record<string, unknown>, conf: SubRuleTable): string | number {
  if (conf.keyField && body[conf.keyField] != null) {
    const v = body[conf.keyField];
    if (typeof v === "string" || typeof v === "number") return v;
  }
  if (conf.itemType === "string") {
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === "string" && v !== "" && !/_list$|^policy$|^filter$/.test(k)) return v;
    }
  }
  return "";
}

/**
 * mountLegacySubRuleAddForm — fallback for sub-rule kinds newtron's
 * schema endpoint doesn't yet describe. Preserves the prior behavior:
 * build the form from conf.addFields with parent-name injection from
 * the kind→parent-field convention in injectParentName.
 */
function mountLegacySubRuleAddForm(
  kind: SpecKind,
  specName: string,
  conf: SubRuleTable,
  formArea: HTMLElement,
  addBtn: HTMLElement,
): void {
  const { form, getValues, validate } = buildFormFields(conf.addFields);
  formArea.appendChild(form);

  const errOut = el("div", { className: "form-error-out" });
  formArea.appendChild(errOut);

  const buttons = el("div", { className: "form-button-row" });
  const submitBtn = el("button", { type: "button", className: "form-submit-btn" },
    "Add " + conf.itemLabel);
  const cancelBtn = el("button", { type: "button", className: "form-cancel-btn" }, "Cancel");
  buttons.appendChild(submitBtn);
  buttons.appendChild(cancelBtn);
  formArea.appendChild(buttons);

  cancelBtn.addEventListener("click", () => {
    formArea.hidden = true;
    addBtn.hidden = false;
    clearFieldErrors(form);
    errOut.textContent = "";
  });

  submitBtn.addEventListener("click", async () => {
    clearFieldErrors(form);
    if (!validate()) return;
    errOut.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    const values = getValues();
    const bodyWithParent = injectParentName(kind, specName, values);
    enqueueSubCreate(kind as StagingSpecKind, specName, conf.endpoint, subKeyFromBody(bodyWithParent, conf), bodyWithParent, subTitle(bodyWithParent, conf));
    openDetail(kind, kindTitleFor(kind), specName);
  });
}

// Sub-rule add/update/remove queue as flat mutations (enqueueSub*); the
// apply layer replays them as POST/PUT/DELETE on {kind}/{spec}/{endpoint}[/key],
// so the per-kind client dispatchers are gone.

// collectSortedSeqs (slice #173.C) — extracts the sequence-key values
// from a sub-rule item list and returns them sorted ascending. Skips
// items whose key isn't a number (defensive; current schemas only
// have integer seq/queue_id).
function collectSortedSeqs(items: readonly unknown[], keyField: string): number[] {
  const out: number[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const v = (item as Record<string, unknown>)[keyField];
    if (typeof v === "number") out.push(v);
  }
  out.sort((a, b) => a - b);
  return out;
}

// makeReorderBtn (slice #173.C) — builds a ↑ or ↓ button for one row.
// Click computes the target new_seq via computeReorderSeq and fires the
// update verb. When the heuristic returns null (already at top/bottom,
// or no integer gap), the button is disabled with an explanatory title
// so the operator knows why and what to do (renumber via Edit).
function makeReorderBtn(
  kind: SpecKind,
  specName: string,
  conf: SubRuleTable,
  currentSeq: number,
  sortedSeqs: readonly number[],
  direction: "up" | "down",
): HTMLButtonElement {
  const target = computeReorderSeq(sortedSeqs, currentSeq, direction);
  const arrow = direction === "up" ? "↑" : "↓";
  const btn = el("button", {
    type: "button",
    className: "subrule-reorder-btn",
  }, arrow) as HTMLButtonElement;
  if (target === null) {
    btn.disabled = true;
    btn.title = direction === "up"
      ? "Can't move up (already at top, or no room — renumber via Edit)"
      : "Can't move down (already at bottom, or no room — renumber via Edit)";
    return btn;
  }
  btn.title = `Move ${direction} (new seq ${target})`;
  btn.addEventListener("click", () => {
    // A reorder renumbers currentSeq → target. composeUpdateBody emits the
    // new_<keyField>. We compose both directions here (we have the keyField),
    // so the queued op carries its own inverse — the opposite renumber — and
    // undo needs no body-sniffing.
    const fwdBody = composeUpdateBody({ [conf.keyField!]: target }, conf.itemType, conf.keyField, currentSeq);
    const invBody = composeUpdateBody({ [conf.keyField!]: currentSeq }, conf.itemType, conf.keyField, target);
    enqueueSubReorder(kind as StagingSpecKind, specName, conf.endpoint, currentSeq, target, fwdBody, invBody, String(currentSeq));
    openDetail(kind, kindTitleFor(kind), specName);
  });
  return btn;
}

// pluralize handles the singular item labels in subRuleTables — all
// English-regular except "prefix" → "prefixes".
function pluralize(noun: string): string {
  if (noun.endsWith("x") || noun.endsWith("s") || noun.endsWith("z")) return noun + "es";
  return noun + "s";
}

// injectParentName adds the parent spec's name to the sub-rule request body
// using newtron's expected field name per pkg/newtron/types.go.
function injectParentName(kind: SpecKind, specName: string, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  switch (kind) {
    case "qos-policies": out["policy"] = specName; break;
    case "filters":      out["filter"] = specName; break;
    case "prefix-lists": out["prefix_list"] = specName; break;
    case "route-policies": out["policy"] = specName; break;
  }
  return out;
}
