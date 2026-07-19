// views/specs/index.ts — the Specs workspace view (console-uplift 1.2,
// move-only extraction from app.ts): schema-driven panel discovery (PANELS),
// facet subnav + General section (SSH Login / Permissions), facet panels,
// create/edit/override drawers, sub-rule tables, spec detail, and the
// spec-detail drawer plumbing (openDetail/closeDetail).
//
// TEMPORARY CYCLE (dissolves in uplift 1.3): four shared render/nav helpers
// still live in app.ts (openNodeDrawer, renderErrorInto, renderSpecDetailInto,
// toSpecField) because the device drawer also uses them; they move to
// views/drawer/ in 1.3 and this import flips there. Function-declaration
// exports keep the cycle load-safe (no init-time evaluation either way).

interface Panel {
  kind: SpecKind;
  title: string;
  /** True when newtron's schema advertises a create path for this kind
   *  (drives the "+ Add" affordance). PlatformSpec — a read-only global
   *  registry — has no create path, so it gets no Add button. */
  canCreate: boolean;
  /** True when newtron's schema advertises a delete path (drives the
   *  per-row × affordance). */
  canDelete: boolean;
}

// PANELS is discovered dynamically from newtron's /api/schema/all. One
// HTTP round-trip returns every registered SchemaMeta; the list is
// loaded on first specs-view mount and cached for the session.
// Synchronous lookups (kindTitleFor) fall back to humanizing the slug
// when called before the cache populates.


import { type SpecKind, fetchSpecDetail, fetchSpecInstances, fetchSpecList } from "../../api/newtcon/network.js";
import { fetchTopology } from "../../api/newtcon/nodes.js";
import { fetchAllSchemas, fetchSchema, resolveSlugToKind, resolveSubRuleKind } from "../../api/newtcon/schema.js";
import { setSecret } from "../../api/newtcon/secrets.js";
import { ApiError } from "../../api/newtcon/services.js";
import { showSSHCredentials } from "../../api/newtcon/ssh-credentials.js";
import { openNodeDrawer, renderErrorInto, renderSpecDetailInto, toSpecField } from "../drawer/index.js";
import { mountAuthorizationTab } from "../../authorization.js";
import { confirmInline } from "../../confirm-inline.js";
import { el, renderValue } from "../../dom.js";
import { emptyStateFor } from "../../empty-states.js";
import { clearFieldErrors } from "../../form-error-binding.js";
import { activeNetwork } from "../../network-switcher.js";
import { deriveNodeLinks } from "../../node-references.js";
import { engineOpErrorBody, formatErrorBrief } from "../../render-error.js";
import { SAMPLE_SEEDS, planLoad, summarisePlan } from "../../sample-network.js";
import { renderSchemaForm } from "../../schema-form.js";
import { isSecretReference, secretReference } from "../../secret-field.js";
import { deriveServiceBindings } from "../../service-bindings.js";
import { type RefFieldDescriptor, deriveServiceReferences } from "../../service-references.js";
import { computePrefillForKind, strategiesFor } from "../../smart-defaults.js";
import { type SpecKind as StagingSpecKind, enqueueSSHLoginClear, enqueueSSHLoginSet, enqueueSpecCreate, enqueueSpecDelete, enqueueSpecUpdate, enqueueSubCreate, enqueueSubDelete, enqueueSubReorder, enqueueSubUpdate, isSpecPendingDelete, isSpecPendingUpdate, pendingSpecCreateItems, pendingSubMutations, removeFromQueue, subscribe as subscribePending } from "../../staging.js";
import { type SubDisplayRow, type SubRuleColumn, type SubRuleItemType, composeUpdateBody, computeReorderSeq, extractRowCells, getSubRuleItems, itemKey, overlaySubRuleItems } from "../../subrule-table.js";
import { showToast } from "../../toast.js";
let PANELS: Panel[] = [];
let panelsLoaded: Promise<Panel[]> | null = null;

async function loadPanels(): Promise<Panel[]> {
  if (panelsLoaded) return panelsLoaded;
  panelsLoaded = (async () => {
    const out: Panel[] = [];
    try {
      const schemas = await fetchAllSchemas();
      for (const meta of schemas) {
        const listPath = meta.paths?.list;
        if (!listPath) continue; // embedded / sub-rule — not a top-level panel
        const m = listPath.match(/\/([^/]+)$/);
        if (!m) continue;
        out.push({
          kind: m[1]! as SpecKind,
          title: meta.label,
          canCreate: !!meta.paths?.create,
          canDelete: !!meta.paths?.delete,
        });
      }
    } catch {
      // Schema endpoint unavailable — no panels. The Specs view will
      // mount with an empty subnav; the operator sees the error in the
      // network panel via standard ApiError flow.
    }
    PANELS = out;
    return out;
  })();
  try {
    return await panelsLoaded;
  } catch (e) {
    panelsLoaded = null;
    throw e;
  }
}

// ---- Form field definitions per spec type ----------------------------------
// Each field definition describes one HTML input in the "Add" form drawer.

interface FieldDef {
  name: string;        // JSON field name sent to newtron
  label: string;       // Operator-visible label (domain language)
  type: "text" | "number" | "select";
  required?: boolean;
  options?: string[];  // for type "select"
  placeholder?: string;

  // Numeric bounds — rendered as input[min] / input[max] HTML attributes;
  // the browser's native constraint UI fires on form.reportValidity() at
  // submit time. Use for fields with well-known wire-shape bounds (VLAN
  // ID 1-4094, ASN 1-4294967295, L3 VNI 1-16777215, etc.).
  min?: number;
  max?: number;

  // Contextual help — one short sentence explaining what the field means
  // when the label alone isn't enough (e.g. "L3 VNI" → "24-bit VXLAN ID
  // for routed traffic; unique per IPVPN"). Rendered as a "?" affordance
  // next to the label that toggles an inline help line.
  help?: string;

  // Regex source string for input[pattern]. The browser enforces it when
  // form.reportValidity() runs. patternTitle becomes the input[title]
  // attribute which the browser surfaces as the per-field error bubble
  // ("must look like …") rather than the default "Please match the
  // requested format." Only meaningful for type="text".
  pattern?: string;
  patternTitle?: string;
}

// PATTERNS — named regex sources for fields that share a constraint.
// Each is a string (HTML pattern attribute), not a RegExp literal, so it
// flows verbatim into the input[pattern] attr.
//
// Deliberately permissive: catch typos (commas, missing digits, dashes
// where dots belong) without rejecting valid edge cases. The substrate
// is authoritative for range / semantic checks — these patterns are the
// first-line filter that saves a backend round-trip on obvious wrong
// shapes.
//
//   IPV4         — single IPv4 address (no CIDR). No 0–255 enforcement.
//   IPV4_CIDR    — IPv4 address with optional /prefix. Prefix range not enforced.
//   MAC          — six octets, colon- or dash-separated, hex.
//
// IPv6 deferred: a single permissive regex that accepts every valid form
// (compressed, dual, zone-id) is too gnarly; field-level help nudges
// operators toward correctness, and the substrate validates.
const PATTERNS = {
  IPV4: String.raw`^(\d{1,3}\.){3}\d{1,3}$`,
  IPV4_CIDR: String.raw`^(\d{1,3}\.){3}\d{1,3}(/\d{1,2})?$`,
  MAC: String.raw`^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$`,
} as const;

// specForms maps each SpecKind to the form fields needed to create that spec.
// Field names and types are taken verbatim from the newtron request types in
// pkg/newtron/types.go (CreateServiceRequest, CreateIPVPNRequest, etc.).
//
// NOTE: this schema drives the CREATE form. The DETAIL-display layout uses
// `displaySchemaFor(kind)` (further down) which defaults to this schema but
// overrides where newtron's GET-detail wire shape diverges from the create
// request shape (e.g., services: "service_type" on detail, "type" on create).
// specForms is now a tiny fallback for kinds newtron's schema endpoint
// doesn't yet describe. The schema-driven dispatch (resolveSlugToKind
// → fetchSchema → renderSchemaForm) covers every authoring kind newtron
// registers; this map exists only as a safety net for schema-orphan
// kinds that newtron may register without metadata in the future.
//
// Empty as of newtron #242 — every registered kind has a schema. The
// fallback path stays wired (legacyCreateForm / legacyEditForm) so the
// system degrades gracefully when newtron-schema is unreachable or a
// future kind ships without metadata.
const specForms: Partial<Record<SpecKind, FieldDef[]>> = {};

// displaySchemaFor returns the legacy hand-typed display schema for a
// spec kind. Schema-driven kinds bypass this entirely (renderSpecDetailInto
// is called directly with the schema fields). This fallback only fires
// for schema-orphan kinds (prefix-lists today).
export function displaySchemaFor(kind: SpecKind): FieldDef[] | undefined {
  return specForms[kind];
}


// isEditableKind returns true when a spec kind has any top-level field
// beyond the identifier — those are the kinds where the Edit button shows
// up in the detail drawer. For schema-driven kinds this resolves async
// via the schema; the synchronous fallback below covers schema-orphan
// kinds via specForms.
function isEditableKind(kind: SpecKind): boolean {
  const fields = specForms[kind];
  if (!fields) {
    // Kinds backed by a schema (every kind newtron describes) — Edit
    // button is reasonable to show by default. The edit flow itself
    // resolves the schema and renders fields; if no editable fields
    // exist, the form will just contain the identifier.
    return true;
  }
  return fields.some((f) => f.name !== "name");
}

// prefillFromDetail copies the GET-detail wire shape into the legacy
// edit form's field map. Schema-driven kinds use renderSchemaForm's
// own prefill option (passes the entire detail object verbatim). This
// helper exists only for the legacy fallback path (schema-orphan kinds).
function prefillFromDetail(_kind: SpecKind, detail: unknown): Record<string, unknown> {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return {};
  return { ...detail as Record<string, unknown> };
}

// enterSpecEditMode replaces the drawer body with an edit form pre-filled
// from the current detail. On Save: PUT /api/networks/.../{kind}/{name}
// (newtron's update-<kind>) → re-open the drawer to read the fresh values.
// On Cancel: re-open the drawer (discards changes).
//
// Why re-open instead of swap-back? Newtron's update can synthesize fields
// (timestamps, derived names) we don't know about. Re-fetching is the
// honest path that surfaces the new state verbatim.
function enterSpecEditMode(
  kind: SpecKind,
  kindTitle: string,
  name: string,
  detail: unknown,
  content: HTMLElement,
): void {
  // Clear the body but keep the kind / name header.
  content.textContent = "";
  content.appendChild(el("p", { className: "drawer-kind" }, kindTitle));
  content.appendChild(el("h2", { className: "drawer-name" }, name));

  // Schema-driven path: resolve the URL slug to a newtron kind, fetch
  // its schema, render an edit form prefilled from the GET-detail wire
  // shape. Fields with `immutable: true` render read-only — newtron
  // rejects identifier changes via the update verb.
  void (async () => {
    const schemaKind = await resolveSlugToKind(kind).catch(() => null);
    if (schemaKind !== null) {
      await renderSchemaDrivenEdit(kind, kindTitle, name, detail, schemaKind, content);
      return;
    }
    legacyEditForm(kind, kindTitle, name, detail, content);
  })();
}

async function renderSchemaDrivenEdit(
  kind: SpecKind,
  kindTitle: string,
  name: string,
  detail: unknown,
  schemaKind: string,
  content: HTMLElement,
): Promise<void> {
  const loading = el("p", { className: "status-loading" }, "Loading schema…");
  content.appendChild(loading);
  let schema;
  try {
    schema = await fetchSchema(schemaKind);
  } catch (err) {
    loading.remove();
    content.appendChild(el("p", { className: "panel-error" },
      `Schema for ${schemaKind} unavailable: ${formatErrorBrief(err)}`));
    return;
  }
  loading.remove();
  const { form, getValues, validate } = await renderSchemaForm({
    schema,
    prefill: detail && typeof detail === "object" ? detail as Record<string, unknown> : {},
    editMode: true,
  });
  content.appendChild(form);

  const errOut = el("div", { className: "form-error-out" });
  content.appendChild(errOut);

  const buttons = el("div", { className: "form-button-row" });
  const saveBtn = el("button", { type: "button", className: "form-submit-btn" }, "Save");
  const cancelBtn = el("button", { type: "button", className: "form-cancel-btn" }, "Cancel");
  buttons.appendChild(saveBtn);
  buttons.appendChild(cancelBtn);
  content.appendChild(buttons);

  cancelBtn.addEventListener("click", () => {
    void openDetail(kind, kindTitle, name);
  });

  saveBtn.addEventListener("click", async () => {
    if (!validate()) return;
    errOut.textContent = "";
    const values = getValues();
    // The PUT URL identifies the row; newtcon-server overwrites any
    // identifier in the body with the URL value. Strip the identifier
    // here too to keep the wire payload clean.
    //
    // Sub-collection fields (array/map of item_kind — e.g. rules, queues)
    // flow into `values` as empty per renderSchemaForm's "not authorable"
    // notice path. newtron preserves sub-collections on update-X per
    // docs/newtron/api.md §5 (sub-rule verbs own the sub-collection
    // lifecycle), so emitting an empty array doesn't wipe existing rules —
    // but stripping here is belt-and-braces against any future contract change.
    const idField = schema.identifier || "name";
    delete values[idField];
    for (const f of schema.fields) {
      if ((f.type === "array" || f.type === "map") && f.item_kind) {
        delete values[f.name];
      }
    }
    // Queue the edit (PUT /update-<kind>) — it stages and applies through the
    // Save loop like create/delete, not instantly. The list shows the row as
    // pending-modified; the committed values stand until Apply. preBody (the
    // spec before the edit) lets undo restore it.
    const preBody = detail && typeof detail === "object" ? detail as Record<string, unknown> : undefined;
    enqueueSpecUpdate(kind as StagingSpecKind, name, values, preBody);
    saveBtn.disabled = true;
    saveBtn.textContent = "Queued";
    content.insertBefore(
      el("p", { className: "form-success" },
        "Edit added to pending changes. Click Save in the header to apply."),
      buttons);
    setTimeout(() => { closeDetail(); }, 800);
  });
}

function legacyEditForm(
  kind: SpecKind,
  kindTitle: string,
  name: string,
  detail: unknown,
  content: HTMLElement,
): void {
  const fields = specForms[kind];
  if (!fields) return;

  const { form, getValues, validate } = buildFormFields(fields, {
    prefill: prefillFromDetail(kind, detail),
    // Identifier comes from the URL on the server side; rendering it in
    // the form would imply renames are supported here (they aren't).
    excludeNames: ["name"],
  });
  content.appendChild(form);

  const errOut = el("div", { className: "form-error-out" });
  content.appendChild(errOut);

  const buttons = el("div", { className: "form-button-row" });
  const saveBtn = el("button", { type: "button", className: "form-submit-btn" }, "Save");
  const cancelBtn = el("button", { type: "button", className: "form-cancel-btn" }, "Cancel");
  buttons.appendChild(saveBtn);
  buttons.appendChild(cancelBtn);
  content.appendChild(buttons);

  cancelBtn.addEventListener("click", () => {
    void openDetail(kind, kindTitle, name);
  });

  saveBtn.addEventListener("click", () => {
    clearFieldErrors(form);
    if (!validate()) return;
    errOut.textContent = "";
    // Queue the edit (same staging path as create/delete) rather than PUT now.
    const preBody = detail && typeof detail === "object" ? detail as Record<string, unknown> : undefined;
    enqueueSpecUpdate(kind as StagingSpecKind, name, getValues(), preBody);
    saveBtn.disabled = true;
    saveBtn.textContent = "Queued";
    content.insertBefore(
      el("p", { className: "form-success" },
        "Edit added to pending changes. Click Save in the header to apply."),
      buttons);
    setTimeout(() => { closeDetail(); }, 800);
  });
}

// subRuleTables is the single source of truth for every sub-rule kind.
// Each entry carries enough info to render the new unified inline table
// (slice #173.A): the wire field on the spec detail, the POST endpoint,
// the singular item label, the item shape (object vs string for prefix-
// lists), the keyField used to delete an item, the table columns, and
// the FieldDefs for the inline Add form.
//
// Replaces the earlier split between subRuleWireField + subRuleForms +
// the hard-coded switch in renderSubRuleDeleteSection — three places
// went out of sync, so they're consolidated here.
//
// Notably, prefix-lists's wire field is "prefixes" but its add endpoint
// is "entries" — historical newtron divergence. Both stay accurate
// because they're declared separately.
interface SubRuleTable {
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

const subRuleTables: Partial<Record<SpecKind, SubRuleTable>> = {
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

// ---- Form drawer (create spec) ---------------------------------------------

// FormOptions controls how buildFormFields renders + reads values.
//   prefill — initial values, keyed by FieldDef.name. Used by edit mode to
//             populate the form from the current spec detail.
//   excludeNames — fields to skip rendering entirely (e.g. "name" in edit
//                  mode — identifier can't be changed via update-X; the
//                  drawer header still shows it).
interface FormOptions {
  prefill?: Record<string, unknown>;
  excludeNames?: string[];
}

// buildFormFields renders input elements for each field definition.
function buildFormFields(fields: FieldDef[], opts: FormOptions = {}): {
  form: HTMLFormElement;
  getValues: () => Record<string, unknown>;
  // validate runs the browser's native constraint UI (required, min, max,
  // pattern) and returns true iff every field passes. Save / Add handlers
  // should call this before getValues() so the operator sees the
  // browser's per-field "must be N–M" message rather than a backend
  // round-trip failure.
  validate: () => boolean;
} {
  const form = el("form", { className: "vform vform--roomy spec-form" });
  const prefill = opts.prefill ?? {};
  const exclude = new Set(opts.excludeNames ?? []);
  const renderFields = fields.filter((f) => !exclude.has(f.name));

  form.addEventListener("submit", (e) => e.preventDefault());

  for (const field of renderFields) {
    const group = el("div", { className: "form-group" });
    const labelRow = el("div", { className: "form-label-row" });
    const label = el("label", { className: "form-label" }, field.label);
    if (field.required) {
      label.appendChild(el("span", { className: "form-required" }, " *"));
    }
    label.setAttribute("for", "field-" + field.name);
    labelRow.appendChild(label);

    // Help affordance — "?" icon → click toggles the inline help line.
    // Click here doesn't blur the field, so the operator can read help
    // mid-typing without losing place.
    let helpEl: HTMLElement | null = null;
    if (field.help) {
      const helpBtn = el("button", {
        type: "button",
        className: "form-help-btn",
        title: "Show help",
      }, "?") as HTMLButtonElement;
      helpEl = el("p", { className: "form-help-text" }, field.help);
      helpEl.hidden = true;
      helpBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (helpEl) helpEl.hidden = !helpEl.hidden;
      });
      labelRow.appendChild(helpBtn);
    }
    group.appendChild(labelRow);

    const prefillStr = field.name in prefill && prefill[field.name] != null
      ? String(prefill[field.name])
      : "";

    if (field.type === "select" && field.options) {
      const select = el("select", { className: "form-control", id: "field-" + field.name, name: field.name }) as HTMLSelectElement;
      if (!field.required) {
        select.appendChild(el("option", { value: "" }, "— optional —") as HTMLOptionElement);
      }
      for (const opt of field.options) {
        const o = el("option", { value: opt }, opt) as HTMLOptionElement;
        if (opt === prefillStr) o.selected = true;
        select.appendChild(o);
      }
      group.appendChild(select);
    } else {
      const input = el("input", {
        className: "form-control",
        id: "field-" + field.name,
        name: field.name,
        type: field.type === "number" ? "number" : "text",
        placeholder: field.placeholder ?? "",
      }) as HTMLInputElement;
      if (field.required) input.required = true;
      if (field.type === "number") {
        if (field.min !== undefined) input.min = String(field.min);
        if (field.max !== undefined) input.max = String(field.max);
      }
      if (field.type === "text" && field.pattern) {
        input.pattern = field.pattern;
        // title becomes the browser's per-field invalid-bubble text.
        if (field.patternTitle) input.title = field.patternTitle;
      }
      if (prefillStr) input.value = prefillStr;
      group.appendChild(input);
    }

    if (helpEl) group.appendChild(helpEl);

    form.appendChild(group);
  }

  const getValues = (): Record<string, unknown> => {
    const values: Record<string, unknown> = {};
    for (const field of renderFields) {
      const el2 = form.querySelector(`#field-${field.name}`) as HTMLInputElement | HTMLSelectElement | null;
      if (!el2) continue;
      const raw = el2.value.trim();
      if (!raw && !field.required) continue;
      if (field.type === "number") {
        const n = Number(raw);
        if (!isNaN(n)) values[field.name] = n;
      } else {
        if (raw) values[field.name] = raw;
      }
    }
    return values;
  };

  return { form, getValues, validate: () => form.reportValidity() };
}

// Schema dispatch is dynamic — given newtcon's URL slug, we look up the
// newtron kind name from /api/schema's `paths.list` per kind. No
// hardcoded slug→kind map: newtron is the source of truth for which
// kinds exist, and newtcon discovers them at runtime. See
// resolveSlugToKind() in web/src/api/newtcon/schema.ts.

// openCreateDrawer opens the drawer for creating a new spec of the given kind.
// onSuccess is called after a successful create to refresh the panel list.
function openCreateDrawer(kind: SpecKind, kindTitle: string, onSuccess: () => void): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

  content.appendChild(el("p", { className: "drawer-kind" }, kindTitle));
  content.appendChild(el("h2", { className: "drawer-name" }, "Add " + kindTitle.toLowerCase().replace(/s$/, "")));

  // Dispatch is dynamic: resolve the URL slug to newtron's kind name
  // via /api/schema. If newtron knows the kind, use the schema-driven
  // path; otherwise fall back to legacy specForms. resolveSlugToKind
  // is async (one lazy fetch per session to build the slug map); we
  // await it before deciding the path.
  void (async () => {
    const schemaKind = await resolveSlugToKind(kind).catch(() => null);
    if (schemaKind !== null) {
      void renderSchemaDrivenCreate(kind, schemaKind, content, onSuccess);
      return;
    }
    // Fall through to the legacy hand-typed specForms path for any
    // kind newtron's schema endpoint doesn't cover.
    legacyCreateForm(kind, content, drawer, onSuccess);
  })();
}

// openOverrideDrawer — "Add override" from a network-level record. Opens the
// create drawer prefilled with the base spec's current values, so the operator
// changes only the scope (and any field that should legitimately differ at the
// zone/node) instead of re-keying the whole spec from a second window. The
// identifier is locked to the base name; scope is seeded to "zone" so the form
// lands on the override path (must pick a scope_instance) rather than the base.
function openOverrideDrawer(
  kind: SpecKind,
  kindTitle: string,
  baseName: string,
  onSuccess: () => void,
): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";
  content.appendChild(el("p", { className: "drawer-kind" }, kindTitle + " override"));
  content.appendChild(el("h2", { className: "drawer-name" }, baseName));

  void (async () => {
    const schemaKind = await resolveSlugToKind(kind).catch(() => null);
    if (schemaKind === null) {
      content.appendChild(el("p", { className: "panel-error" },
        "Overrides aren't available for this spec type."));
      return;
    }
    // Pull the network base so the override starts as a faithful copy.
    const loading = el("p", { className: "status-loading" }, "Loading base values…");
    content.appendChild(loading);
    let baseDetail: Record<string, unknown> = {};
    try {
      const d = await fetchSpecDetail(kind, baseName);
      if (d && typeof d === "object") baseDetail = d as Record<string, unknown>;
    } catch { /* fall through — operator can fill it in */ }
    loading.remove();
    // Seed scope=zone (+ empty instance) so the form opens on the override
    // path; the operator can switch to node. scope/scope_instance aren't part
    // of the spec detail, so we set them explicitly.
    const prefill: Record<string, unknown> = { ...baseDetail, scope: "zone", scope_instance: "" };
    await renderSchemaDrivenCreate(kind, schemaKind, content, onSuccess,
      { prefill, lockIdentifier: true });
  })();
}

// legacyCreateForm — fallback path for kinds newtron's schema endpoint
// doesn't yet describe (e.g. prefix-lists today). Lifted out of
// openCreateDrawer so the dynamic-dispatch flow can call it without
// duplicating the original body.
function legacyCreateForm(
  kind: SpecKind,
  content: HTMLElement,
  drawer: HTMLElement,
  onSuccess: () => void,
): void {
  const fields = specForms[kind];
  if (!fields || fields.length === 0) {
    content.appendChild(el("p", { className: "panel-error" }, "No form defined for this spec type."));
    return;
  }

  const { form, getValues, validate } = buildFormFields(fields);
  content.appendChild(form);

  // Smart defaults (slice #172.D): asynchronously fetch existing specs of
  // this kind and suggest the next-available value for integer-ID fields
  // (l3vni on ipvpns, vni on macvpns). Fire-and-forget — the form is
  // already usable, and any fetch failure leaves it unprefilled.
  if (strategiesFor(kind)) {
    void computePrefillForKind(kind).then((defaults) => {
      for (const [name, value] of Object.entries(defaults)) {
        const input = form.querySelector("#field-" + name) as HTMLInputElement | null;
        // Only fill when the operator hasn't already started typing — the
        // suggestion is a starting point, never an override.
        if (input && input.value === "") input.value = String(value);
      }
    });
  }

  const errorOut = el("div", { className: "form-error-out" });
  content.appendChild(errorOut);

  const submitBtn = el("button", { type: "button", className: "form-submit-btn" }, "Create");
  content.appendChild(submitBtn);

  submitBtn.addEventListener("click", () => {
    if (!validate()) return;
    errorOut.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Queued";
    try {
      const values = getValues();
      const name = String(values["name"] ?? values["id"] ?? "(unnamed)");
      enqueueSpecCreate(kind as StagingSpecKind, name, values);
      const ok = el("p", { className: "form-success" }, "Added to pending changes (green). Click Save in the header to apply.");
      content.insertBefore(ok, submitBtn);
      onSuccess();
      setTimeout(() => {
        drawer.setAttribute("aria-hidden", "true");
        drawer.classList.remove("open");
      }, 800);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create";
      errorOut.appendChild(el("p", { className: "panel-error" }, String(err)));
    }
  });
}

// renderSchemaDrivenCreate — schema-metadata flavour of openCreateDrawer
// (newtron PR #240). Fetches the schema for the kind, renders a `name`
// identifier input + the schema fields, and wires the same staging
// enqueue + drawer close that the legacy path uses.
async function renderSchemaDrivenCreate(
  kind: SpecKind,
  schemaKind: string,
  content: HTMLElement,
  onSuccess: () => void,
  opts: { prefill?: Record<string, unknown>; lockIdentifier?: boolean } = {},
): Promise<void> {
  // Loading placeholder while the schema fetch is in flight — the
  // first open per session waits one HTTP round-trip; subsequent
  // opens hit the cache.
  const loading = el("p", { className: "status-loading" }, "Loading schema…");
  content.appendChild(loading);
  let schema;
  try {
    schema = await fetchSchema(schemaKind);
  } catch (err) {
    loading.remove();
    content.appendChild(el("p", { className: "panel-error" },
      `Schema for ${schemaKind} unavailable: ${formatErrorBrief(err)}`));
    return;
  }
  loading.remove();

  // Per-field UX overrides — schema gives shape, newtcon decides UX.
  // For ipvpns / macvpns the smart-default integer fields use the same
  // strategiesFor()/computePrefillForKind() machinery as the legacy
  // path so we share one bug surface.
  const overrides: Record<string, import("../../schema-form.js").SchemaFieldOverride> = {};
  // Smart next-available defaults only apply to a blank create — when the
  // override flow supplies a prefill, the base's values win, so skip them.
  if (strategiesFor(kind) && !opts.prefill) {
    const defaults = await computePrefillForKind(kind);
    for (const [name, value] of Object.entries(defaults)) {
      const v: string | number = typeof value === "number" ? value : String(value);
      overrides[name] = { smartDefault: () => v };
    }
  }
  // Override flow: lock the identifier to the base spec's name (prefilled),
  // so the operator can't accidentally retarget the override to another spec.
  if (opts.lockIdentifier) {
    const idField = schema.identifier || "name";
    overrides[idField] = { ...(overrides[idField] ?? {}), readOnly: true };
  }

  // Newtron prepends the identifier field (e.g. `name`) to `fields` as
  // a synthetic field with `immutable: true`. The schema-form renderer
  // emits an input for it like any other field, so we render the form
  // directly with no manual identifier injection.
  const formOpts: import("../../schema-form.js").SchemaFormOpts = { schema, overrides };
  if (opts.prefill) formOpts.prefill = opts.prefill;
  const { form, getValues, validate } = await renderSchemaForm(formOpts);
  content.appendChild(form);

  const errorOut = el("div", { className: "form-error-out" });
  content.appendChild(errorOut);

  // Create + Cancel pair, mirroring the edit form's .form-button-row.
  const buttons = el("div", { className: "form-button-row" });
  const submitBtn = el("button", { type: "button", className: "form-submit-btn" }, "Create");
  const cancelBtn = el("button", { type: "button", className: "form-cancel-btn" }, "Cancel");
  buttons.appendChild(submitBtn);
  buttons.appendChild(cancelBtn);
  content.appendChild(buttons);

  // Cancel discards the unsubmitted form and closes the drawer. Unlike
  // the edit form (which returns to the read view) there's no prior
  // detail to fall back to, so just close.
  cancelBtn.addEventListener("click", () => {
    closeDetail();
  });

  submitBtn.addEventListener("click", async () => {
    if (!validate()) return;
    errorOut.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    try {
      const values = getValues();
      // Identifier comes from the schema-rendered field (per newtron's
      // synthetic prepend). Fall back to other common identifier names
      // for kinds whose identifier isn't "name" (defensive — schema's
      // `identifier` field is the authoritative source).
      const idField = schema.identifier || "name";
      const name = String(values[idField] ?? "(unnamed)");
      enqueueSpecCreate(kind as StagingSpecKind, name, values);
      submitBtn.textContent = "Queued";
      const ok = el("p", { className: "form-success" }, "Added to pending changes (green). Click Save in the header to apply.");
      content.insertBefore(ok, buttons);
      onSuccess();
      setTimeout(() => { closeDetail(); }, 800);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create";
      errorOut.appendChild(el("p", { className: "panel-error" }, formatErrorBrief(err)));
    }
  });
}

// openSSHLoginDrawer — the scoped "SSH Login" control (the scalar mirror of the
// ip-vpn override affordance). Sets ssh_user + masked ssh_pass at network / zone /
// node scope via newtron's set/clear-ssh-credentials, reusing the schema-form scope
// machinery and the ${secret:} store flow. Direct write (not staged) — substrate
// config, applied immediately. The network-floor invariant is enforced upstream
// (400 override-without-base / 409 clear-base-with-overrides), surfaced verbatim.
// Rendered inline as the "SSH Login" facet under the Specs → General group (it's a
// spec, not a topology action). Re-renders itself after set/clear to refresh context.
async function renderSSHLoginInto(content: HTMLElement): Promise<void> {
  const network = activeNetwork();
  // Build into a DETACHED panel and swap it in atomically at the end. This facet
  // re-renders on every pending-queue change (subscribePending), and the build
  // awaits (fetchSchema / renderSchemaForm) — so two overlapping renders (open +
  // a staging notify) would each clear-then-append and stack DUPLICATE forms.
  // Replacing content in one shot at the end makes concurrent renders last-wins.
  const panel = document.createElement("div");
  panel.appendChild(el("h2", { className: "spec-panel-title" }, "SSH Login"));
  panel.appendChild(el("p", { className: "node-spec-intro" },
    "The login newtron uses to reach devices — resolved node > zone > network > platform > \"admin\". Set it once at network scope; override at zone/node for exceptions."));

  let schema;
  try {
    schema = await fetchSchema("SSHCredentials");
  } catch (err) {
    content.replaceChildren(el("p", { className: "panel-error" }, `SSH-login schema unavailable: ${formatErrorBrief(err)}`));
    return;
  }

  const { form, getValues, validate } = await renderSchemaForm({ schema });
  panel.appendChild(form);

  // Scope-aware context: pre-fill the login AUTHORED at the selected scope, and for
  // a chosen node also show the EFFECTIVE (resolved) login it dials with. Reaches
  // into the rendered inputs by name and re-reads whenever scope/instance changes.
  const scopeSel = form.querySelector<HTMLSelectElement>('[name="scope"]');
  const instSel = form.querySelector<HTMLSelectElement>('[name="scope_instance"]');
  const userInput = form.querySelector<HTMLInputElement>('[name="ssh_user"]');
  const passInput = form.querySelector<HTMLInputElement>('[name="ssh_pass"]');
  const ctxBox = el("div", { className: "ssh-login-context" });
  panel.appendChild(ctxBox);
  const refreshContext = async (): Promise<void> => {
    const scope = scopeSel?.value || "network";
    const instance = instSel?.value || "";
    if (scope !== "network" && !instance) { ctxBox.textContent = ""; return; }
    try {
      const authored = await showSSHCredentials(network, scope, instance || undefined);
      // Pre-fill ssh_user from what's authored at this scope (blank when it inherits);
      // never prefill the masked password — reflect its set/inherit state in the hint.
      if (userInput) userInput.value = authored.ssh_user || "";
      if (passInput) passInput.placeholder = authored.ssh_pass
        ? (isSecretReference(authored.ssh_pass) ? "•••••• set — type to replace" : "•••••• set")
        : "leave blank to inherit";
      ctxBox.textContent = "";
      const has = authored.ssh_user || authored.ssh_pass;
      ctxBox.appendChild(el("p", { className: "lifecycle-hint" },
        `Authored at ${scope}${instance ? " " + instance : ""}: ` +
        (has ? `user ${authored.ssh_user || "(none)"}, password ${authored.ssh_pass ? "set" : "(none)"}`
             : "nothing — inherits from the next scope up")));
      if (scope === "node" && instance) {
        void fetchSpecDetail("nodes", instance).then((node) => {
          // Show only the resolved USER (fine to display). NOT the password —
          // GET /nodes/{name} returns ssh_pass in the clear (newtlab dials with
          // it); the password state is shown above from the masked authored read.
          const n = node as { ssh_user?: string };
          ctxBox.appendChild(el("p", { className: "lifecycle-hint lifecycle-hint--detail" },
            `Effective login ${instance} connects as: ${n.ssh_user || "admin"} (resolved through the scope chain).`));
        }).catch(() => { /* effective read is best-effort context */ });
      }
    } catch {
      ctxBox.textContent = "";
    }
  };
  scopeSel?.addEventListener("change", () => void refreshContext());
  instSel?.addEventListener("change", () => void refreshContext());
  void refreshContext();

  const errOut = el("div", { className: "form-error-out" });
  panel.appendChild(errOut);

  // Buttons match the spec-authoring pattern: Save stages an upsert, Clear stages
  // a delete-style removal. Both go into the pending queue → committed by the
  // header Save (Apply All), with preview + undo — like ip-vpn / filters / nodes.
  const buttons = el("div", { className: "form-button-row" });
  const saveBtn = el("button", { type: "button", className: "form-submit-btn" }, "Save");
  const clearBtn = el("button", { type: "button", className: "form-cancel-btn" }, "Clear override");
  buttons.appendChild(saveBtn);
  buttons.appendChild(clearBtn);
  panel.appendChild(buttons);

  const scopeLabel = (s: string, i: string): string => (s === "network" ? "network" : `${s} ${i}`);
  const stagedToast = (): void =>
    showToast({ kind: "success", title: "Added to pending changes", body: "Click Save in the header to apply." });

  saveBtn.addEventListener("click", async () => {
    if (!validate()) return;
    errOut.textContent = "";
    const values = getValues();
    const scope = String(values["scope"] ?? "network");
    const instance = String(values["scope_instance"] ?? "");
    saveBtn.disabled = true;
    saveBtn.textContent = "Staging…";
    try {
      // The plaintext password goes to the secret store NOW (a write-only side
      // effect) — this keeps plaintext OUT of the staged body, which carries only
      // the ${secret:KEY} reference (key: <instance>_ssh_pass, or "ssh_pass" at
      // network). Empty password ⇒ inherit.
      const body: Record<string, unknown> = {};
      if (values["ssh_user"]) body["ssh_user"] = values["ssh_user"];
      const pass = String(values["ssh_pass"] ?? "");
      if (pass && !isSecretReference(pass)) {
        const key = scope === "network" ? "ssh_pass" : `${instance}_ssh_pass`;
        await setSecret(network, key, pass);
        body["ssh_pass"] = secretReference(key);
      } else if (isSecretReference(pass)) {
        body["ssh_pass"] = pass;
      }
      // Prior authored value at this scope → the undo inverse.
      const prior = await showSSHCredentials(network, scope, instance || undefined).catch(() => null);
      enqueueSSHLoginSet(scope, instance, body, `SSH login — set at ${scopeLabel(scope, instance)}`, prior);
      stagedToast();
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
      errOut.textContent = engineOpErrorBody(err);
    }
  });

  clearBtn.addEventListener("click", async () => {
    const values = getValues();
    const scope = String(values["scope"] ?? "network");
    const instance = String(values["scope_instance"] ?? "");
    const ok = await confirmInline({
      title: `Clear the SSH login at ${scopeLabel(scope, instance)} scope?`,
      body: "Stages removal of the override at this scope; it will inherit from the next scope up.",
      confirmLabel: "Clear",
    });
    if (!ok) return;
    try {
      const prior = await showSSHCredentials(network, scope, instance || undefined).catch(() => null);
      enqueueSSHLoginClear(scope, instance, `SSH login — clear at ${scopeLabel(scope, instance)}`, prior);
      stagedToast();
    } catch (err) {
      errOut.textContent = engineOpErrorBody(err);
    }
  });

  // Atomic swap — the ONLY mutation of `content`. Concurrent renders → last wins,
  // never a stacked duplicate form.
  content.replaceChildren(panel);
}

// One row in a spec panel: a spec definition at a given scope. The same
// name appears once per scope it's defined at (network base + each
// override) — that duplication is the override signal (newtron #285/#287).
interface SpecRowData { name: string; scope: string; scope_instance: string; }

// Kinds that support scope overrides (newtron P2). For these the panel
// rows come from /spec-instances (real scope + scope_instance); the
// container kinds (profiles/zones/platforms) aren't overridable and aren't
// in that inventory, so they keep the network-only list.
const SCOPED_KINDS: ReadonlySet<SpecKind> = new Set<SpecKind>([
  "services", "ipvpns", "macvpns", "prefix-lists", "filters", "qos-policies", "route-policies",
]);

function scopeRank(scope: string): number {
  return scope === "network" ? 0 : scope === "zone" ? 1 : scope === "node" ? 2 : 3;
}

// loadFacetRows returns the rows for a facet: scope-tagged from
// /spec-instances for overridable kinds, network-only (from the plain
// list) for the rest. Sorted by name, then network-before-overrides.
async function loadFacetRows(kind: SpecKind): Promise<SpecRowData[]> {
  if (SCOPED_KINDS.has(kind)) {
    const [instances, newtronKind] = await Promise.all([
      fetchSpecInstances(),
      resolveSlugToKind(kind).catch(() => null),
    ]);
    if (newtronKind) {
      return instances
        .filter((i) => i.kind === newtronKind)
        .map((i) => ({ name: i.name, scope: i.scope, scope_instance: i.scope_instance }))
        .sort((a, b) =>
          a.name.localeCompare(b.name)
          || scopeRank(a.scope) - scopeRank(b.scope)
          || a.scope_instance.localeCompare(b.scope_instance));
    }
    // newtronKind unresolved → fall through to the plain list.
  }
  const names = await fetchSpecList(kind);
  return names.map((n) => ({ name: n, scope: "network", scope_instance: "" }));
}

// refreshPanel re-fetches the spec list for a panel and replaces its DOM node.
function refreshPanel(panel: Panel, container: HTMLElement): void {
  loadFacetRows(panel.kind)
    .then((rows) => {
      const fresh = buildPanel(panel, { status: "fulfilled", value: rows });
      container.replaceWith(fresh);
    })
    .catch((err) => {
      const fresh = buildPanel(panel, { status: "rejected", reason: err });
      container.replaceWith(fresh);
    });
}

// buildPanel constructs the panel DOM for a spec type.
// Separated from renderPanel so refreshPanel can rebuild after mutations.
function buildPanel(panel: Panel, result: PromiseSettledResult<SpecRowData[]>): HTMLElement {
  const container = el("section", { className: "panel" });
  const header = el("div", { className: "panel-header" });
  header.appendChild(el("h2", { className: "panel-title" }, panel.title));
  const scoped = SCOPED_KINDS.has(panel.kind);

  if (result.status === "fulfilled") {
    const items = result.value;
    header.appendChild(el("span", { className: "panel-count" }, String(items.length)));

    // "Add" button — only for kinds newtron's schema says are creatable.
    if (panel.canCreate) {
      const addBtn = el("button", {
        type: "button",
        className: "panel-add-btn",
        title: "Add " + panel.title.toLowerCase().replace(/s$/, ""),
      }, "+ Add");
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openCreateDrawer(panel.kind, panel.title, () => refreshPanel(panel, container));
      });
      header.appendChild(addBtn);
    }

    container.appendChild(header);

    // Combine server-side definitions with pending creates (overlay so the
    // operator sees both committed and queued items in one list, with color).
    // A pending create carries its scope/scope_instance, so an override queues
    // as a green sub-line at its real scope — not collapsed onto the base.
    type Row = SpecRowData & { pending: "none" | "create" };
    const allRows: Row[] = items.map((i) => ({ ...i, pending: "none" as const }));
    const committedKeys = new Set(items.map((i) => `${i.scope}::${i.scope_instance}::${i.name}`));
    for (const q of pendingSpecCreateItems(panel.kind as StagingSpecKind)) {
      const scope = typeof q.body.scope === "string" && q.body.scope !== "" ? q.body.scope : "network";
      const scope_instance = typeof q.body.scope_instance === "string" ? q.body.scope_instance : "";
      const key = `${scope}::${scope_instance}::${q.name}`;
      if (!committedKeys.has(key)) allRows.push({ name: q.name, scope, scope_instance, pending: "create" });
    }

    if (allRows.length === 0) {
      container.appendChild(renderPanelEmpty(panel.kind, panel.canCreate));
    } else {
      const list = el("ul", {
        className: "panel-list" + (scoped ? " panel-list--scoped panel-list--nested" : ""),
      });

      // buildNameRow renders a clickable name row. Used for unscoped rows and
      // for the network-base parent row of a scoped kind. `deleteDisabled`,
      // when set, renders the × disabled with that tooltip — the delete-floor
      // made visible: a base with overrides can't be deleted until they go.
      const buildNameRow = (
        r: Row,
        opts: { overrideCount?: number; deleteDisabled?: string; onAddOverride?: () => void } = {},
      ): HTMLElement => {
        const isPendingCreate = r.pending === "create";
        const isPendingDelete = isSpecPendingDelete(panel.kind as StagingSpecKind, r.name);
        // Pending edit (queued update) — only meaningful on a committed row,
        // and superseded by a queued delete.
        const isPendingUpdate = !isPendingCreate && !isPendingDelete
          && isSpecPendingUpdate(panel.kind as StagingSpecKind, r.name);
        const row = el("li", {
          className: "panel-list-row"
            + (isPendingCreate ? " panel-list-row--pending-add" : "")
            + (isPendingDelete ? " panel-list-row--pending-del" : "")
            + (isPendingUpdate ? " panel-list-row--pending-mod" : ""),
        });
        const item = el("span", { className: "panel-list-item", tabIndex: 0 }, r.name);
        item.addEventListener("click", () => openDetail(panel.kind, panel.title, r.name));
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDetail(panel.kind, panel.title, r.name);
          }
        });
        row.appendChild(item);

        // Override count hint on the parent — signals there's more nested below.
        if (opts.overrideCount && opts.overrideCount > 0) {
          row.appendChild(el("span", { className: "panel-override-count" },
            `${opts.overrideCount} override${opts.overrideCount === 1 ? "" : "s"}`));
        }

        // "Add override" — opens the create drawer prefilled from this base so
        // the operator only sets the scope (newtron P2). On hover, like ×.
        if (opts.onAddOverride && !isPendingCreate) {
          const ovBtn = el("button", {
            type: "button",
            className: "panel-override-add-btn",
            title: "Add a zone/node override of " + r.name,
            ariaLabel: "Add override of " + r.name,
          }, "+ override");
          ovBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            opts.onAddOverride!();
          });
          row.appendChild(ovBtn);
        }

        // Delete affordance — × on hover. A network base with overrides shows
        // the × disabled (the floor: delete-<kind> would 409 until the
        // overrides are removed); otherwise it maps to delete-<kind>.
        if (panel.canDelete && !isPendingCreate) {
          const disabled = opts.deleteDisabled !== undefined;
          const delBtn = el("button", {
            type: "button",
            className: "panel-delete-btn",
            title: disabled ? opts.deleteDisabled!
              : (isPendingDelete ? "Cancel delete" : "Delete " + r.name),
            ariaLabel: disabled ? opts.deleteDisabled!
              : (isPendingDelete ? "Cancel delete of " + r.name : "Delete " + r.name),
          }, isPendingDelete ? "↺" : "×");
          if (disabled) {
            delBtn.disabled = true;
          } else {
            delBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              void (async () => {
                // A service that's still applied can't be plain-deleted —
                // newtron's #319 guard 409s. Detect the bindings client-side
                // (instant feedback), and on confirm stage a FORCE delete so
                // newtron cascades the binding steps. (spec→spec refs are
                // guarded engine-side; only services — applied via apply-service
                // steps — surface bindings here.)
                let force = false;
                if (panel.kind === "services") {
                  const topo = await fetchTopology().catch(() => null);
                  const bindings = deriveServiceBindings(topo, r.name);
                  if (bindings.length > 0) {
                    const where = bindings.slice(0, 6).map((b) => `${b.device}:${b.iface}`).join(", ");
                    const more = bindings.length > 6 ? `, +${bindings.length - 6} more` : "";
                    const n = bindings.length, s = n === 1 ? "" : "s";
                    const ok = await confirmInline({
                      title: `Force-delete service "${r.name}"?`,
                      body: `It's applied on ${n} interface${s} (${where}${more}). newtron won't delete an applied service; "Force delete" also removes those ${n} binding${s} from the topology. (On a deployed device, un-apply there first to avoid CONFIG_DB drift.)`,
                      danger: true,
                      confirmLabel: "Force delete",
                    });
                    if (!ok) return;
                    force = true;
                  }
                } else if (panel.kind === "nodes") {
                  // newtron won't delete a node a link still wires to (409); detect
                  // the links client-side and, on confirm, force-cascade them so the
                  // node + its links are removed together.
                  const topo = await fetchTopology().catch(() => null);
                  const links = deriveNodeLinks(topo, r.name);
                  if (links.length > 0) {
                    const peers = [...new Set(links.map((l) => l.peer).filter(Boolean))];
                    const shown = peers.slice(0, 6).join(", ");
                    const more = peers.length > 6 ? `, +${peers.length - 6} more` : "";
                    const n = links.length, s = n === 1 ? "" : "s";
                    const ok = await confirmInline({
                      title: `Force-delete node "${r.name}"?`,
                      body: `${n} link${s} still wire to it (${shown}${more}). newtron won't delete a linked node; "Force delete" removes the node and cascades those ${n} link${s} from the topology.`,
                      danger: true,
                      confirmLabel: "Force delete",
                    });
                    if (!ok) return;
                    force = true;
                  }
                }
                enqueueSpecDelete(panel.kind as StagingSpecKind, r.name, undefined, undefined, force);
                refreshPanel(panel, container);
              })();
            });
          }
          row.appendChild(delBtn);
        }
        return row;
      };

      // buildOverrideRow renders a zone/node override as an indented sub-line
      // (scope · instance) beneath its network base. No × yet — scoped delete
      // needs scope on the wire (not built); clicking opens detail (the base,
      // until per-scope override detail lands).
      const buildOverrideRow = (r: Row): HTMLElement => {
        const isPendingCreate = r.pending === "create";
        const isPendingDelete = isSpecPendingDelete(panel.kind as StagingSpecKind, r.name, r.scope, r.scope_instance);
        const row = el("li", {
          className: "panel-list-row panel-list-row--override"
            + (isPendingCreate ? " panel-list-row--pending-add" : "")
            + (isPendingDelete ? " panel-list-row--pending-del" : ""),
        });
        row.appendChild(el("span", { className: "panel-override-marker", ariaHidden: "true" }, "↳"));
        row.appendChild(el("span", {
          className: "panel-scope-badge panel-scope-badge--" + r.scope,
        }, r.scope));
        const item = el("span", { className: "panel-list-item panel-list-item--override", tabIndex: 0 },
          r.scope_instance || "—");
        item.addEventListener("click", () => openDetail(panel.kind, panel.title, r.name));
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openDetail(panel.kind, panel.title, r.name);
          }
        });
        row.appendChild(item);

        // Scoped delete (newtron #319): remove just this zone/node override. A
        // scoped delete falls back to the network base, so it's safe — no
        // binding guard to trip, no confirm needed (staged + reversible).
        if (panel.canDelete) {
          const label = `${r.scope} override (${r.scope_instance || "—"}) of ${r.name}`;
          const delBtn = el("button", {
            type: "button",
            className: "panel-delete-btn",
            title: isPendingDelete ? "Cancel delete" : (isPendingCreate ? "Cancel add" : "Delete " + label),
            ariaLabel: isPendingDelete ? "Cancel delete of " + label : "Delete " + label,
          }, isPendingDelete ? "↺" : "×");
          delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            enqueueSpecDelete(panel.kind as StagingSpecKind, r.name, r.scope, r.scope_instance);
            refreshPanel(panel, container);
          });
          row.appendChild(delBtn);
        }
        return row;
      };

      if (!scoped) {
        for (const r of allRows) list.appendChild(buildNameRow(r));
      } else {
        // Group by name: the network base is the parent record; zone/node
        // overrides nest beneath it as dependents (mirrors the floor: an
        // override requires its base; deleting/pausing the base reckons with
        // the children). allRows arrives name-sorted then scope-ranked.
        const order: string[] = [];
        const byName = new Map<string, { base?: Row; overrides: Row[] }>();
        for (const r of allRows) {
          let g = byName.get(r.name);
          if (!g) { g = { overrides: [] }; byName.set(r.name, g); order.push(r.name); }
          if (r.scope === "network") g.base = r; else g.overrides.push(r);
        }
        for (const name of order) {
          const g = byName.get(name)!;
          // Floor invariant guarantees a base; synthesize a label row if a
          // stray override ever arrives without one rather than dropping it.
          const base: Row = g.base ?? { name, scope: "network", scope_instance: "", pending: "none" };
          const baseOpts: { overrideCount?: number; deleteDisabled?: string; onAddOverride?: () => void } = {
            overrideCount: g.overrides.length,
          };
          if (g.overrides.length > 0) {
            baseOpts.deleteDisabled =
              `Remove ${g.overrides.length} override${g.overrides.length === 1 ? "" : "s"} first`;
          }
          // Overrides are authored from the base so they autofill from it — only
          // available when the kind is creatable (newtron exposes create-<kind>).
          if (panel.canCreate) {
            baseOpts.onAddOverride = () =>
              openOverrideDrawer(panel.kind, panel.title, name, () => refreshPanel(panel, container));
          }
          const baseRow = buildNameRow(base, baseOpts);
          const ovRows = g.overrides.map((ov) => buildOverrideRow(ov));
          if (ovRows.length > 0) {
            // Collapsible override group: a disclosure caret on the base toggles
            // its nested overrides. Default collapsed — the override-count badge
            // already signals there's content, keeping the facet compact.
            let expanded = false;
            const caret = el("button", {
              type: "button",
              className: "panel-override-toggle",
              ariaLabel: `Show/hide ${ovRows.length} override${ovRows.length === 1 ? "" : "s"} of ${name}`,
            }, "▸");
            const apply = () => {
              caret.textContent = expanded ? "▾" : "▸";
              caret.setAttribute("aria-expanded", String(expanded));
              for (const r of ovRows) r.hidden = !expanded;
            };
            const toggle = (e: Event) => { e.stopPropagation(); expanded = !expanded; apply(); };
            caret.addEventListener("click", toggle);
            baseRow.insertBefore(caret, baseRow.firstChild);
            // The count badge doubles as a click target for the disclosure.
            const countBadge = baseRow.querySelector(".panel-override-count");
            if (countBadge) {
              countBadge.classList.add("panel-override-count--toggle");
              countBadge.addEventListener("click", toggle);
            }
            apply();
            list.appendChild(baseRow);
            for (const r of ovRows) list.appendChild(r);
          } else {
            // No overrides: reserve the caret's width so the name lines up with
            // base rows that do carry a disclosure caret.
            baseRow.insertBefore(
              el("span", { className: "panel-override-toggle panel-override-toggle--placeholder", ariaHidden: "true" }, "▸"),
              baseRow.firstChild,
            );
            list.appendChild(baseRow);
          }
        }
      }
      container.appendChild(list);
    }
    return container;
  }

  // rejected
  container.appendChild(header);
  const err = result.reason;
  if (err instanceof ApiError && err.kind === "newtron_unavailable") {
    container.appendChild(el("p", { className: "panel-error" }, "newtron is unreachable"));
    const detailObj = err.details as { underlying_error_message?: string } | undefined;
    const detail = detailObj?.underlying_error_message ?? err.message;
    container.appendChild(el("p", { className: "panel-error-detail" }, detail));
  } else if (err instanceof ApiError) {
    container.appendChild(el("p", { className: "panel-error" }, err.message));
  } else {
    container.appendChild(el("p", { className: "panel-error" }, "request failed"));
    container.appendChild(el("p", { className: "panel-error-detail" }, String(err)));
  }
  return container;
}

function renderPanel(panel: Panel, result: PromiseSettledResult<SpecRowData[]>): HTMLElement {
  return buildPanel(panel, result);
}

// renderPanelEmpty renders the pedagogical empty-state block for a spec
// facet (slice #169.A). Replaces the previous bare "none defined" line
// with copy that tells the operator what the kind is and what to do
// next.
function renderPanelEmpty(kind: SpecKind, canAdd: boolean): HTMLElement {
  const copy = emptyStateFor(kind);
  const block = el("div", { className: "panel-empty" });
  block.appendChild(el("p", { className: "panel-empty-headline" }, copy.title));
  if (copy.body) {
    block.appendChild(el("p", { className: "panel-empty-body" }, copy.body));
  }
  if (canAdd) {
    block.appendChild(el("p", { className: "panel-empty-cta" },
      "Click + Add above to create one."));
  }
  if (copy.hint) {
    block.appendChild(el("p", { className: "panel-empty-hint" }, copy.hint));
  }
  // Sample-seed quickstart (slice #169.E). Surface a "Load sample"
  // affordance on the Services facet — the most common landing point
  // for a new operator — so they can stage a representative pair of
  // specs (IP VPN + service) and see the apply workflow without
  // authoring from scratch.
  if (kind === "services" && canAdd) {
    block.appendChild(renderSampleSeedAffordance());
  }
  return block;
}

// renderSampleSeedAffordance renders the "Load sample" link + its
// post-click status line. Idempotent — repeated clicks plan against
// the current spec names so previously-loaded seeds are skipped, not
// duplicated.
function renderSampleSeedAffordance(): HTMLElement {
  const wrap = el("div", { className: "panel-empty-sample" });
  const link = el("button", {
    type: "button",
    className: "panel-empty-sample-link",
    title: "Stage a small IP VPN + service so you can see the apply workflow",
  }, "Or load a sample IP VPN + service");
  wrap.appendChild(link);
  const status = el("p", { className: "panel-empty-sample-status" });
  status.hidden = true;
  wrap.appendChild(status);

  link.addEventListener("click", async () => {
    link.setAttribute("disabled", "");
    link.textContent = "Loading…";
    try {
      const existing = await loadSampleConflictMap();
      const plan = planLoad(existing);
      const summary = summarisePlan(plan);
      for (const p of plan) {
        if (p.action === "queue") {
          enqueueSpecCreate(p.seed.kind as StagingSpecKind, p.seed.name, p.seed.body);
        }
      }
      status.textContent = "";
      const head = el("strong", { className: "panel-empty-sample-status-head" },
        summary.queued > 0
          ? `Staged ${summary.queued} change${summary.queued === 1 ? "" : "s"} — click Save in the header to apply.`
          : "Nothing to load — all sample specs already exist.");
      status.appendChild(head);
      const list = el("ul", { className: "panel-empty-sample-status-list" });
      for (const line of summary.lines) {
        list.appendChild(el("li", { className: "panel-empty-sample-status-line" }, line));
      }
      status.appendChild(list);
      status.hidden = false;
      link.remove();
    } catch (err) {
      link.removeAttribute("disabled");
      link.textContent = "Or load a sample IP VPN + service";
      status.textContent = "Couldn't load sample: " + formatErrorBrief(err);
      status.hidden = false;
    }
  });
  return wrap;
}

// loadSampleConflictMap fetches the current name lists for each
// SAMPLE_SEEDS kind in parallel, then builds the existing-names map
// planLoad expects. A list fetch failure is tolerated (the kind is
// treated as empty — planLoad will queue the seed; if it duplicates,
// newtron's create will reject with a conflict the operator sees).
async function loadSampleConflictMap(): Promise<Map<SpecKind, Set<string>>> {
  const kinds = Array.from(new Set(SAMPLE_SEEDS.map((s) => s.kind)));
  const results = await Promise.all(
    kinds.map((kind) =>
      fetchSpecList(kind).then(
        (names) => [kind, new Set(names)] as const,
        () => [kind, new Set<string>()] as const,
      ),
    ),
  );
  return new Map(results);
}

// renderSubRuleTable renders the unified inline-table section
// (slice #173.A): one heading, one table for existing items with a
// per-row delete affordance, and one "+ Add <item>" button at the
// bottom that expands an inline form. Replaces the earlier two-section
// pattern (separate "Existing X" list + collapsed "Add X" form).
function renderSubRuleTable(
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
// when the operator clicks the Edit button. On Save: calls
// updateSubRuleItem and re-opens the detail to refresh; on Cancel:
// the caller swaps the original row back in.
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

// Sub-rule add/update/remove now queue as flat mutations (enqueueSub*); the
// apply layer replays them as POST/PUT/DELETE on {kind}/{spec}/{endpoint}[/key],
// so the per-kind client dispatchers are gone.

// composeUpdateBody is imported from ./subrule-table.js — pure helper
// so it can be unit-tested independently of the DOM-bound renderer.

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

// kindTitleFor maps a SpecKind back to a human title. Reads the
// schema-loaded PANELS cache; falls back to a humanized slug when the
// cache hasn't loaded yet (e.g. a deep link to a detail drawer that
// fires before the Specs tab mounts).
export function kindTitleFor(kind: SpecKind): string {
  const panel = PANELS.find((p) => p.kind === kind);
  if (panel) return panel.title;
  // Humanize the slug: "qos-policies" → "Qos policies", "ipvpns" → "Ipvpns".
  // Operator sees the canonical label as soon as the schema cache loads.
  return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, " ");
}

export async function openDetail(kind: SpecKind, kindTitle: string, name: string): Promise<void> {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";
  content.appendChild(el("p", { className: "drawer-kind" }, kindTitle));
  content.appendChild(el("h2", { className: "drawer-name" }, name));
  const loading = el("p", { className: "status-loading" }, "Loading…");
  content.appendChild(loading);

  try {
    // A not-yet-applied (pending-create) spec has no server detail —
    // fetchSpecDetail would 404. Fall back to the staged create body so the
    // operator can author sub-rules (QoS queues, filter / route-policy rules)
    // BEFORE the first Save: they stage as sub-creates and apply right after the
    // parent in the same Save (no more "apply the parent first, then add rules").
    const pendingCreate = pendingSpecCreateItems(kind as StagingSpecKind).find((p) => p.name === name);
    const detail = pendingCreate ? pendingCreate.body : await fetchSpecDetail(kind, name);
    content.removeChild(loading);

    if (pendingCreate) {
      content.appendChild(el("p", { className: "drawer-pending-note" },
        "Not applied yet — fields and sub-rules you add here are staged and apply together on Save."));
    }

    // Edit-mode controls — Edit button if the kind has any top-level field
    // beyond the identifier. Kinds whose schema is just `name` (zones,
    // prefix-lists) get no Edit button — their meaningful content lives in
    // sub-rules and is managed via the existing sub-rule UI.
    if (isEditableKind(kind)) {
      const controls = el("div", { className: "drawer-controls" });
      const editBtn = el("button", { type: "button", className: "drawer-edit-btn" }, "Edit");
      editBtn.addEventListener("click", () => {
        enterSpecEditMode(kind, kindTitle, name, detail, content);
      });
      controls.appendChild(editBtn);
      content.appendChild(controls);
    }

    // Schema-aware rendering — prefer newtron's schema (canonical labels +
    // tooltips), fall back to newtcon's hand-typed displaySpecForms /
    // specForms for kinds without a schema, and finally to the generic
    // recursive tree so unknown kinds still render.
    //
    // Sub-rule wire fields are excluded so child rules don't double-
    // display — they get a dedicated section below via renderSubRuleTable.
    const subRuleConf = subRuleTables[kind];
    const extraExcludes = subRuleConf ? [subRuleConf.wireField] : [];
    const schemaKindForDetail = await resolveSlugToKind(kind).catch(() => null);
    const schemaForDetail = schemaKindForDetail
      ? await fetchSchema(schemaKindForDetail).catch(() => null)
      : null;
    if (schemaForDetail) {
      const body = el("div");
      // Adapter: SchemaField → SpecField shape. buildSpecDetailShape
      // needs name + label for the layout, plus ref_kind so ref fields
      // render as clickable cross-link chips. Other field metadata
      // (required / immutable / etc.) is irrelevant for read-only display.
      renderSpecDetailInto(
        body,
        schemaForDetail.fields.map(toSpecField),
        detail,
        extraExcludes,
      );
      content.appendChild(body);
    } else {
      const fields = displaySchemaFor(kind);
      if (fields) {
        const body = el("div");
        renderSpecDetailInto(body, fields, detail, extraExcludes);
        content.appendChild(body);
      } else {
        const body = renderValue(detail);
        if (body instanceof HTMLElement) {
          body.classList.add("drawer-detail");
        }
        content.appendChild(body);
      }
    }

    // Sub-rules: one unified inline-table section per kind (#173.A).
    if (subRuleConf) {
      renderSubRuleTable(kind, name, detail, content, subRuleConf);
    }

    // Services: show where the service is actually applied (its interface
    // bindings), derived from the topology's per-device steps — one
    // GET /topology, no device round-trips. Other kinds: show which
    // services reference this resource (the reverse of the cross-link
    // chips), derived from the service specs' ref fields.
    if (kind === "services") {
      renderServiceBindings(content, name);
    } else {
      renderServiceUsage(content, kind, name);
    }
  } catch (err) {
    content.removeChild(loading);
    if (err instanceof ApiError && err.status === 404) {
      content.appendChild(el("p", { className: "panel-error" }, `${kindTitle} not found`));
    } else if (err instanceof ApiError) {
      content.appendChild(el("p", { className: "panel-error" }, err.message));
    } else {
      content.appendChild(el("p", { className: "panel-error" }, "request failed"));
      content.appendChild(el("p", { className: "panel-error-detail" }, String(err)));
    }
  }
}

// renderServiceBindings appends a "Bindings" section to the service
// detail drawer: every interface this service is applied to, read from
// the topology's per-device steps (deriveServiceBindings). Each row
// drills into that device's inspector. Empty → a teaching line.
function renderServiceBindings(container: HTMLElement, serviceName: string): void {
  const section = el("section", { className: "svc-bindings" });
  section.appendChild(el("h3", { className: "svc-bindings-title" }, "Bindings"));
  const body = el("div", { className: "svc-bindings-body" });
  body.appendChild(el("p", { className: "status-loading" }, "Loading…"));
  section.appendChild(body);
  container.appendChild(section);

  void fetchTopology()
    .then((topo) => {
      body.textContent = "";
      const bindings = deriveServiceBindings(topo, serviceName);
      if (bindings.length === 0) {
        body.appendChild(el("p", { className: "svc-bindings-empty" },
          "Not applied to any interface yet. Bind it from the Topology view (a port's Bind service action)."));
        return;
      }
      body.appendChild(el("p", { className: "svc-bindings-count" },
        `Applied to ${bindings.length} interface${bindings.length === 1 ? "" : "s"}.`));
      const table = el("table", { className: "table table--mono-all svc-bindings-table" });
      const head = el("tr");
      for (const h of ["Device", "Interface", "Details"]) {
        head.appendChild(el("th", { className: "svc-bindings-th" }, h));
      }
      table.appendChild(head);
      for (const b of bindings) {
        const tr = el("tr", { className: "svc-bindings-row" });
        // Device drills into the inspector (shares #detail-drawer).
        const devCell = el("td", { className: "svc-bindings-td" });
        const devBtn = el("button", { type: "button", className: "svc-bindings-device" }, b.device);
        devBtn.addEventListener("click", () => openNodeDrawer(b.device));
        devCell.appendChild(devBtn);
        tr.appendChild(devCell);
        tr.appendChild(el("td", { className: "svc-bindings-td svc-bindings-iface" }, b.iface));
        const detailParts: string[] = [];
        if (b.ipAddress) detailParts.push(b.ipAddress);
        if (b.peerAs) detailParts.push(`peer-as ${b.peerAs}`);
        if (b.vlan) detailParts.push(`vlan ${b.vlan}`);
        tr.appendChild(el("td", { className: "svc-bindings-td" }, detailParts.join(" · ") || "—"));
        table.appendChild(tr);
      }
      body.appendChild(table);
    })
    .catch((err) => { body.textContent = ""; renderErrorInto(body, err); });
}

// buildServiceRefFields derives, from the schema, which ServiceSpec
// fields (incl. one level of nested object — the routing block) are refs
// to `targetKind`. Schema-driven so no service field names are hardcoded.
async function buildServiceRefFields(serviceKind: string, targetKind: string): Promise<RefFieldDescriptor[]> {
  const out: RefFieldDescriptor[] = [];
  const svc = await fetchSchema(serviceKind).catch(() => null);
  if (!svc || !Array.isArray(svc.fields)) return out;
  for (const f of svc.fields) {
    if (f.type === "ref" && f.ref_kind === targetKind) {
      out.push({ path: [f.name], label: f.label });
    } else if (f.type === "object" && f.item_kind) {
      const inner = await fetchSchema(f.item_kind).catch(() => null);
      if (inner && Array.isArray(inner.fields)) {
        for (const inf of inner.fields) {
          if (inf.type === "ref" && inf.ref_kind === targetKind) {
            out.push({ path: [f.name, inf.name], label: inf.label });
          }
        }
      }
    }
  }
  return out;
}

// renderServiceUsage appends a "Used by services" section to a resource
// (IP-VPN / MAC-VPN / filter / QoS or route policy / prefix list) detail
// drawer — the reverse of the forward cross-link chips. Renders nothing
// when the kind isn't referenced by any service field (e.g. zones,
// platforms). Scans the service specs (cheap spec-file reads) for refs
// to this resource.
function renderServiceUsage(container: HTMLElement, slug: SpecKind, name: string): void {
  if (slug === "services") return;
  void (async () => {
    const targetKind = await resolveSlugToKind(slug).catch(() => null);
    const serviceKind = await resolveSlugToKind("services").catch(() => null);
    if (!targetKind || !serviceKind) return;
    const refFields = await buildServiceRefFields(serviceKind, targetKind);
    if (refFields.length === 0) return; // not a service-referenceable kind

    const section = el("section", { className: "svc-usage" });
    section.appendChild(el("h3", { className: "svc-usage-title" }, "Used by services"));
    const body = el("div", { className: "svc-usage-body" });
    body.appendChild(el("p", { className: "status-loading" }, "Loading…"));
    section.appendChild(body);
    container.appendChild(section);

    try {
      const names = await fetchSpecList("services");
      const details = await Promise.all(
        names.map((n) =>
          fetchSpecDetail("services", n)
            .then((detail) => ({ name: n, detail }))
            .catch(() => ({ name: n, detail: {} as unknown })),
        ),
      );
      const refs = deriveServiceReferences(details, refFields, name);
      body.textContent = "";
      if (refs.length === 0) {
        body.appendChild(el("p", { className: "svc-usage-empty" },
          "Not referenced by any service yet."));
        return;
      }
      body.appendChild(el("p", { className: "svc-usage-count" },
        `Referenced by ${refs.length} service${refs.length === 1 ? "" : "s"}.`));
      const ul = el("ul", { className: "svc-usage-list" });
      for (const r of refs) {
        const li = el("li", { className: "svc-usage-item" });
        const btn = el("button", { type: "button", className: "svc-usage-link" }, r.service);
        btn.addEventListener("click", () => { void openDetail("services", kindTitleFor("services"), r.service); });
        li.appendChild(btn);
        li.appendChild(el("span", { className: "svc-usage-via" }, r.via.join(", ")));
        ul.appendChild(li);
      }
      body.appendChild(ul);
    } catch (err) {
      body.textContent = "";
      renderErrorInto(body, err);
    }
  })();
}

export function closeDetail(): void {
  const drawer = document.getElementById("detail-drawer");
  if (!drawer) return;
  drawer.setAttribute("aria-hidden", "true");
  drawer.classList.remove("open");
}



// Spec facets grouped into operator-domain categories. Newtcon owns
// the grouping (UX policy — what's a Service vs. a Policy is editorial),
// but the panels within each group come from the schema-derived PANELS
// list. Any panel kind not named here lands in the "Other" fallback
// group so a new kind newtron registers still appears in the UI.
const SPEC_GROUPS: { id: string; label: string; kinds: SpecKind[] }[] = [
  { id: "services",  label: "Services",         kinds: ["services"] },
  // IP-VPN (L3VPN / VRF) + MAC-VPN (L2VPN) are the overlay virtual
  // networks a service rides on — their own group, not lumped under
  // Services.
  { id: "vpns",      label: "Virtual Networks", kinds: ["ipvpns", "macvpns"] },
  { id: "policies",  label: "Policies",         kinds: ["qos-policies", "filters", "route-policies", "prefix-lists"] },
  { id: "inventory", label: "Inventory",        kinds: ["nodes", "platforms", "zones"] },
];

// resolveGroupings returns the SPEC_GROUPS list extended with an
// "Other" group containing any kind present in PANELS but not named in
// SPEC_GROUPS. Catches new kinds newtron registers between releases.
function resolveGroupings(): { id: string; label: string; kinds: SpecKind[] }[] {
  const grouped = new Set<string>(SPEC_GROUPS.flatMap((g) => g.kinds));
  const others = PANELS
    .map((p) => p.kind)
    .filter((k) => !grouped.has(k));
  if (others.length === 0) return SPEC_GROUPS;
  return [...SPEC_GROUPS, { id: "other", label: "Other", kinds: others }];
}

let activeFacet: SpecKind = "services";
// The "General" group holds network-wide surfaces that aren't named-instance spec
// facets, so they sit outside the SpecKind/PANELS list machinery: the SSH login
// (a scoped-singleton setting) and Permissions (a read-only view of newtron's
// grant table). When non-null, the panel renders that surface instead of a facet
// list; the facet subnav items go inactive.
let activeGeneral: null | "ssh" | "permissions" = null;

export async function mountSpecsView(root: HTMLElement): Promise<void> {
  root.textContent = "";
  // Schema-driven panel discovery — fetch the kind list before
  // building the subnav. Cached for the session after the first call.
  await loadPanels();

  const layout = el("div", { className: "specs-layout" });
  const subnav = el("aside", { className: "specs-subnav" });
  const main = el("div", { className: "specs-main" });
  layout.append(subnav, main);
  root.appendChild(layout);

  // Fetch counts in parallel for the subnav badges.
  const counts = new Map<SpecKind, number | "error">();
  await Promise.all(
    PANELS.map(async (p) => {
      try {
        const items = await fetchSpecList(p.kind);
        counts.set(p.kind, items.length);
      } catch {
        counts.set(p.kind, "error");
      }
    }),
  );

  function renderSubnav(): void {
    subnav.textContent = "";
    for (const group of resolveGroupings()) {
      const section = el("div", { className: "specs-subnav-section" });
      section.appendChild(el("h3", { className: "specs-subnav-heading" }, group.label));
      const groupList = el("div", { className: "specs-subnav-list" });
      for (const kind of group.kinds) {
        const panel = PANELS.find((p) => p.kind === kind);
        if (!panel) continue;
        const isActive = kind === activeFacet;
        const btn = el(
          "button",
          {
            type: "button",
            className: "specs-subnav-item" + (isActive ? " specs-subnav-item--active" : ""),
            ariaSelected: isActive ? "true" : "false",
          },
          panel.title,
        );
        btn.dataset.kind = kind;
        const count = counts.get(kind);
        const badge = el(
          "span",
          { className: "specs-subnav-count" + (count === "error" ? " specs-subnav-count--error" : "") },
          count === "error" ? "!" : String(count ?? 0),
        );
        btn.appendChild(badge);
        btn.addEventListener("click", () => {
          // Close any open detail/create drawer — switching facets
          // changes the list behind it, so a Service detail (or an
          // IP-VPN create form) left open over the MAC-VPN facet is
          // stale. Mirrors the close-on-tab-switch behaviour.
          closeDetail();
          activeGeneral = null;
          activeFacet = kind;
          renderSubnav();
          renderActiveFacet();
        });
        groupList.appendChild(btn);
      }
      section.appendChild(groupList);
      subnav.appendChild(section);
    }

    // General — network-wide surfaces that aren't a named-instance spec facet:
    // the SSH login (a scoped-singleton setting) and Permissions (a read-only view
    // of newtron's grant table). Rendered inline, not via the list machinery, so
    // they live outside SPEC_GROUPS/PANELS.
    const genSection = el("div", { className: "specs-subnav-section" });
    genSection.appendChild(el("h3", { className: "specs-subnav-heading" }, "General"));
    const genList = el("div", { className: "specs-subnav-list" });
    const genItem = (label: string, key: "ssh" | "permissions"): HTMLElement => {
      const active = activeGeneral === key;
      const btn = el("button", {
        type: "button",
        className: "specs-subnav-item" + (active ? " specs-subnav-item--active" : ""),
        ariaSelected: active ? "true" : "false",
      }, label);
      btn.addEventListener("click", () => {
        closeDetail();
        activeGeneral = key;
        renderSubnav();
        void renderActiveFacet();
      });
      return btn;
    };
    genList.append(genItem("SSH Login", "ssh"), genItem("Permissions", "permissions"));
    genSection.appendChild(genList);
    subnav.appendChild(genSection);
  }

  async function renderActiveFacet(): Promise<void> {
    if (activeGeneral === "ssh") {
      // renderSSHLoginInto swaps content atomically at the end — no pre-clear, so
      // a re-render (on pending-queue change) doesn't flicker or stack forms.
      await renderSSHLoginInto(main);
      return;
    }
    if (activeGeneral === "permissions") {
      // Read-only view of newtron's grant table (super-users + user-groups +
      // permissions). Always re-mounts against the live authorization table so an
      // upstream network.json edit + reload doesn't surface stale here.
      await mountAuthorizationTab(main);
      return;
    }
    const panel = PANELS.find((p) => p.kind === activeFacet);
    if (!panel) return;
    main.textContent = "";
    main.appendChild(el("p", { className: "status-loading" }, "Loading…"));
    try {
      const rows = await loadFacetRows(panel.kind);
      counts.set(panel.kind, rows.length);
      renderSubnav();
      main.textContent = "";
      main.appendChild(renderPanel(panel, { status: "fulfilled", value: rows } as PromiseSettledResult<SpecRowData[]>));
    } catch (err) {
      counts.set(panel.kind, "error");
      renderSubnav();
      main.textContent = "";
      main.appendChild(renderPanel(panel, { status: "rejected", reason: err } as PromiseSettledResult<SpecRowData[]>));
    }
  }

  renderSubnav();
  await renderActiveFacet();

  // Subscribe to the staging queue so pending creates/deletes re-render the
  // active facet immediately (green/red overlays + after-Save refresh).
  if ((root as unknown as { _specsUnsub?: () => void })._specsUnsub) {
    (root as unknown as { _specsUnsub?: () => void })._specsUnsub!();
  }
  const unsub = subscribePending(() => { void renderActiveFacet(); });
  (root as unknown as { _specsUnsub?: () => void })._specsUnsub = unsub;
}

