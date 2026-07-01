// app.ts — newtcon workspace entry. Renders a three-tab layout:
//   Tab 1 (Specs)    — multi-panel spec view
//   Tab 2 (Topology) — SVG topology graph + node-inspector drawer
//   Tab 3 (Lab)      — lab topology lifecycle (deploy / destroy / nodes)

import {
  fetchSpecList,
  fetchSpecInstances,
  fetchSpecDetail,
  type SpecKind,
} from "./api/newtcon/network.js";
import { ApiError } from "./api/newtcon/services.js";
import { formatErrorBrief } from "./render-error.js";
import { mountAuthorizationTab } from "./authorization.js";
import { mountHistoryTab } from "./history.js";
import { mountAuditTab, renderEventsTable, renderEventsError } from "./audit.js";
import { fetchAuditEvents, type AuditEvent } from "./api/newtcon/audit.js";
import { emptyStateFor, TOPOLOGY_EMPTY } from "./empty-states.js";
import {
  SAMPLE_SEEDS,
  planLoad,
  summarisePlan,
} from "./sample-network.js";
import { clearFieldErrors } from "./form-error-binding.js";
import {
  type ViewState,
  ZOOM_STEP,
  fitToBounds,
  panBy,
  viewBoxStr,
  zoomAt,
} from "./topology-viewport.js";
import {
  type PinnedPosition,
  clearPositions,
  loadPositions,
  savePosition,
} from "./topology-positions.js";
import {
  fetchLabStatus,
  postLabDeploy,
  postLabDestroy,
  postLabProvision,
  postLabStartNode,
  postLabStopNode,
  labEvents,
  type LabState,
} from "./api/newtcon/lab.js";
import {
  fetchTopology,
  fetchNodeInfo,
  fetchNodeInterfaces,
  fetchNodeInterface,
  fetchNodeInterfaceBinding,
  fetchNodeVLANs,
  fetchNodeVRFs,
  fetchNodeACLs,
  fetchNodeLAGs,
  fetchNodeNeighbors,
  fetchNodeBGPStatus,
  fetchNodeEVPNStatus,
  fetchNodeConfigDB,
  fetchNodeConfigDBTable,
  fetchNodeConfigDBEntry,
  fetchNodeDrift,
  fetchNodeProjection,
  fetchNodeIntentTree,
  postNodeReconcile,
} from "./api/newtcon/nodes.js";
import { apiPath } from "./api-path.js";
import { activeNetwork } from "./network-switcher.js";
import { buildSpecDetailShape, type SpecField } from "./spec-detail-shape.js";
import { deriveServiceBindings } from "./service-bindings.js";
import { deriveServiceReferences, type RefFieldDescriptor } from "./service-references.js";
import { computePrefillForKind, strategiesFor } from "./smart-defaults.js";
import {
  type SubRuleColumn,
  type SubRuleItemType,
  composeUpdateBody,
  computeReorderSeq,
  extractRowCells,
  getSubRuleItems,
  itemKey,
  overlaySubRuleItems,
  type SubDisplayRow,
} from "./subrule-table.js";
import {
  type DeviceMetadata,
  type TopologyFilter,
  applyFilter,
  emptyFilter,
  isActive as filterIsActive,
  uniqueZones,
} from "./topology-filters.js";
import { resolveDeviceStatus, type DeviceStatus } from "./device-status.js";
import { confirmInline } from "./confirm-inline.js";
import { showToast } from "./toast.js";
import { fetchAllSchemas, fetchSchema, resolveSlugToKind, resolveKindToSlug, resolveSubRuleKind } from "./api/newtcon/schema.js";
import { renderSchemaForm } from "./schema-form.js";
import {
  type PaletteState,
  resolveLabDevicePalette,
  resolveLabStatusText,
  resolveLinkPalette,
  resolvePhysicalDevicePalette,
  resolvePhysicalStatusText,
} from "./topology-palette.js";
import {
  type TopologyViewMode,
  ALL_VIEW_MODES,
  defaultViewMode,
  loadViewMode,
  saveViewMode,
  viewModeLabel,
} from "./topology-view-mode.js";
// Note: postTopologyDevice / deleteTopologyDevice / postTopologyLink
// were previously called directly from the topology view. With the staging
// queue introduced in staging.ts, those flows go through enqueue* + applyAll
// instead, so we don't import them here.
import { NODE_ACTIONS } from "./topology-actions.js";
import { showContextMenu } from "./topology-actions-ui.js";
import { iconSVG } from "./icons.js";
import { renderActionPanel } from "./topology-action-panel.js";
import { comparePorts } from "./port-config.js";
import {
  buildDeviceInterfaceView,
  deriveDeviceBindings,
  linksForDevice,
  countView,
  applyFilter as applyIfaceFilter,
  type InterfaceRow,
  type LiveIface,
  type PlatformPort,
} from "./device-interfaces.js";
import { INTERFACE_ACTIONS, type ActionDef, type ActionField } from "./topology-actions.js";
import { buildDeviceScaffold } from "./device-scaffold.js";
import {
  deviceServiceUsage, countServiceInstances, shapeResourceRows, isHealthCheckList,
  VRF_COLUMNS, VLAN_COLUMNS, ACL_COLUMNS, LAG_COLUMNS, HEALTH_COLUMNS, BGP_NEIGHBOR_COLUMNS,
  type ServiceUsage, type ResourceColumn,
} from "./device-resources.js";
import {
  enqueueSpecCreate,
  enqueueSpecDelete,
  enqueueTopologyAddDevice,
  enqueueTopologyRemoveDevice,
  enqueueTopologyAddLink,
  enqueueSpecUpdate,
  enqueueSubCreate,
  enqueueSubUpdate,
  enqueueSubDelete,
  enqueueSubReorder,
  pendingSpecCreateItems,
  pendingSubMutations,
  isSpecPendingDelete,
  isSpecPendingUpdate,
  removeFromQueue,
  pendingTopologyDeviceAdds,
  isDevicePendingRemove,
  pendingTopologyLinkAdds,
  enqueueInterfaceAction,
  enqueueTopologyRemoveLink,
  deviceQueue,
  subscribe as subscribePending,
  type SpecKind as StagingSpecKind,
} from "./staging.js";

// ---- DOM helper -------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  for (const child of children) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

// ---- Specs tab -------------------------------------------------------------

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
function displaySchemaFor(kind: SpecKind): FieldDef[] | undefined {
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

  saveBtn.addEventListener("click", () => {
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
  const form = el("form", { className: "spec-form" });
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
  const overrides: Record<string, import("./schema-form.js").SchemaFieldOverride> = {};
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
  const formOpts: import("./schema-form.js").SchemaFormOpts = { schema, overrides };
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

  submitBtn.addEventListener("click", () => {
    if (!validate()) return;
    errorOut.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Queued";
    try {
      const values = getValues();
      // Identifier comes from the schema-rendered field (per newtron's
      // synthetic prepend). Fall back to other common identifier names
      // for kinds whose identifier isn't "name" (defensive — schema's
      // `identifier` field is the authoritative source).
      const idField = schema.identifier || "name";
      const name = String(values[idField] ?? "(unnamed)");
      enqueueSpecCreate(kind as StagingSpecKind, name, values);
      const ok = el("p", { className: "form-success" }, "Added to pending changes (green). Click Save in the header to apply.");
      content.insertBefore(ok, buttons);
      onSuccess();
      setTimeout(() => { closeDetail(); }, 800);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create";
      errorOut.appendChild(el("p", { className: "panel-error" }, String(err)));
    }
  });
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

// renderTopologyEmptyState renders the teaching block for an empty
// Topology view (slice #169.B). The action buttons (Create node, Bring
// up as lab) are already in the toolbar above this block — the text
// here explains what Topology is and what those buttons do, not where
// to find them.
function renderTopologyEmptyState(): HTMLElement {
  const block = el("div", { className: "panel-empty topology-empty-state" });
  block.appendChild(el("p", { className: "panel-empty-headline" }, TOPOLOGY_EMPTY.title));
  block.appendChild(el("p", { className: "panel-empty-body" }, TOPOLOGY_EMPTY.body));
  if (TOPOLOGY_EMPTY.hint) {
    block.appendChild(el("p", { className: "panel-empty-hint" }, TOPOLOGY_EMPTY.hint));
  }
  return block;
}

// ---- Shared recursive value renderer ----------------------------------------

export function renderValue(value: unknown): HTMLElement | Text {
  if (value === null || value === undefined) {
    return el("span", { className: "detail-null" }, "—");
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return el("span", { className: "detail-null" }, "(empty)");
    const list = el("ol", { className: "detail-array" });
    for (const item of value) {
      const li = el("li");
      li.appendChild(renderValue(item));
      list.appendChild(li);
    }
    return list;
  }
  if (typeof value === "object") {
    const dl = el("dl", { className: "detail-object" });
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      dl.appendChild(el("dt", {}, k));
      const dd = el("dd");
      dd.appendChild(renderValue(v));
      dl.appendChild(dd);
    }
    return dl;
  }
  if (typeof value === "boolean") {
    return el("span", { className: "detail-bool" }, value ? "true" : "false");
  }
  return document.createTextNode(String(value));
}

// ---- Detail drawer (spec) ---------------------------------------------------

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
  const table = el("table", { className: "subrule-table" });
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
function kindTitleFor(kind: SpecKind): string {
  const panel = PANELS.find((p) => p.kind === kind);
  if (panel) return panel.title;
  // Humanize the slug: "qos-policies" → "Qos policies", "ipvpns" → "Ipvpns".
  // Operator sees the canonical label as soon as the schema cache loads.
  return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, " ");
}

async function openDetail(kind: SpecKind, kindTitle: string, name: string): Promise<void> {
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
      const table = el("table", { className: "svc-bindings-table" });
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

function closeDetail(): void {
  const drawer = document.getElementById("detail-drawer");
  if (!drawer) return;
  drawer.setAttribute("aria-hidden", "true");
  drawer.classList.remove("open");
}

// ---- Topology types ---------------------------------------------------------

interface TopoNode {
  name: string;
  type?: string;
  [k: string]: unknown;
}

interface TopoLink {
  local_device?: string;
  local_interface?: string;
  remote_device?: string;
  remote_interface?: string;
  [k: string]: unknown;
}

interface TopologyData {
  nodes?: TopoNode[];
  links?: TopoLink[];
  [k: string]: unknown;
}

// ---- Topology shape adapter -------------------------------------------------

// Newtron returns: { devices: { name1: { steps?, ... }, ... }, links: [{a: "dev:iface", z: "dev:iface"}], ... }
// The renderer expects:    { nodes:   [{ name, type? }, ...],          links: [{local_device, local_interface, remote_device, remote_interface}, ...] }
// Adapt before rendering so the renderer stays simple.
function adaptTopology(raw: unknown): TopologyData {
  const r = (raw ?? {}) as Record<string, unknown>;
  // If it's already in the renderer shape (nodes as an array), pass through;
  // newtron's raw topology has nodes as a map (newtron #320 key rename), which
  // we adapt below.
  if (Array.isArray((r as { nodes?: unknown }).nodes)) return r as TopologyData;

  const devices = (r.nodes ?? {}) as Record<string, Record<string, unknown>>;
  const nodes: TopoNode[] = Object.entries(devices).map(([name, def]) => {
    // Infer node type from common patterns: host* prefix → "host"; presence of steps → "switch".
    const lower = name.toLowerCase();
    let type: string | undefined;
    if (lower.startsWith("host")) type = "host";
    else if (Array.isArray((def as { steps?: unknown }).steps)) type = "switch";
    return type ? { name, type } : { name };
  });

  type RawLink = { a?: string; z?: string };
  const rawLinks = Array.isArray(r.links) ? (r.links as RawLink[]) : [];
  const links: TopoLink[] = rawLinks.map((lnk) => {
    const split = (s?: string): { device?: string; iface?: string } => {
      if (typeof s !== "string") return {};
      const idx = s.indexOf(":");
      if (idx < 0) return { device: s };
      return { device: s.slice(0, idx), iface: s.slice(idx + 1) };
    };
    const a = split(lnk.a);
    const z = split(lnk.z);
    const out: TopoLink = {};
    if (a.device) out.local_device = a.device;
    if (a.iface) out.local_interface = a.iface;
    if (z.device) out.remote_device = z.device;
    if (z.iface) out.remote_interface = z.iface;
    return out;
  });

  return { nodes, links };
}

// ---- Topology SVG renderer --------------------------------------------------

const NODE_W = 120;
const NODE_H = 52;
const H_GAP = 80;
const V_GAP = 60;

// layoutNodes assigns (cx, cy) to each node in a deterministic grid.
// Up to 4 nodes per row; rows stacked with V_GAP spacing. cellW lets the
// caller widen the column when interface bands are expanded.
function layoutNodes(
  nodes: TopoNode[],
  cellW: number,
  perRowExtraH: number[],
  pinned?: Map<string, PinnedPosition>,
): Map<string, { cx: number; cy: number }> {
  const cols = Math.min(nodes.length, 4);
  const positions = new Map<string, { cx: number; cy: number }>();
  // Track the cumulative y-offset added by each row's tallest expansion band.
  let yCursor = V_GAP / 2;
  for (let r = 0; r * cols < nodes.length; r++) {
    const rowExtra = perRowExtraH[r] ?? 0;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= nodes.length) break;
      const name = nodes[i].name;
      // Pinned position wins when present; otherwise fall back to the
      // grid slot. Pinned positions persist across re-renders via
      // localStorage (loaded by mountTopologyTab).
      const pin = pinned?.get(name);
      if (pin) {
        positions.set(name, { cx: pin.cx, cy: pin.cy });
      } else {
        positions.set(name, {
          cx: (cellW + H_GAP) * c + cellW / 2 + H_GAP / 2,
          cy: yCursor + NODE_H / 2,
        });
      }
    }
    yCursor += NODE_H + rowExtra + V_GAP;
  }
  return positions;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {}
): SVGElementTagNameMap[K] {
  const ns = "http://www.w3.org/2000/svg";
  const node = document.createElementNS(ns, tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  return node;
}

// PaletteByDevice — pre-resolved palette state per device, computed
// in mountTopologyTab based on the active view mode (slice #210.B/C/D).
// The renderer is palette-agnostic; the view mode is responsible for
// picking which source feeds each device's state.
type PaletteByDevice = Map<string, PaletteState>;

// StatusTextByDevice — short textual status drawn under each device's
// rect in lab/physical views. Empty string ("") suppresses the label
// for that device; missing entries also suppress.
type StatusTextByDevice = Map<string, string>;

interface TopologyRenderOpts {
  paletteByDevice?: PaletteByDevice;
  statusTextByDevice?: StatusTextByDevice;
  onNodeClick: (name: string, ev: MouseEvent) => void;
  onNodeContextMenu?: (name: string, ev: MouseEvent) => void;
  driftByDevice?: Map<string, number>;
  statusByDevice?: Map<string, DeviceStatus>;
  onNodeDelete?: (name: string) => void;
  selected?: Set<string>;
  pendingByDevice?: Map<string, number>;  // count of unsaved-intent items per device
  // Staging overlays — render device cards in green/red according to queue state.
  isPendingAdd?: (name: string) => boolean;
  isPendingRemove?: (name: string) => boolean;

  // Viewport — pan/zoom state persisted across re-renders by the caller
  // (mountTopologyTab). When provided, the SVG renders with the supplied
  // viewBox + wheel/drag listeners that mutate the state through
  // onViewStateChange. When omitted, the SVG uses its natural viewBox
  // (no pan/zoom interactivity) — kept as the fallback shape so tests /
  // ad-hoc callers don't need to opt in.
  viewState?: ViewState | undefined;
  onViewStateChange?: (next: ViewState) => void;

  // Per-device pinned positions overriding the grid layout. The caller
  // (mountTopologyTab) loads them from localStorage at mount time;
  // onNodeMoved fires when the operator drags + releases a node so the
  // caller can persist the new position.
  pinnedPositions?: Map<string, PinnedPosition>;
  onNodeMoved?: (name: string, pos: PinnedPosition) => void;

  // Link click → drawer with what's bound at each endpoint (#174.D).
  // When wired, links become interactive: cursor flips to pointer + a
  // wider invisible hit target is drawn under each visible link line.
  onLinkClick?: (link: TopoLink) => void;

  // Layered filter dimming (#174.E): devices in this set keep their
  // layout slot but render at reduced opacity so the operator sees the
  // filtered subset against the full topology context. Links touching
  // any dimmed endpoint are dimmed too.
  dimmedNames?: Set<string>;
}

interface TopologyRenderResult {
  svg: SVGSVGElement;
  // Per-device pixel position of the centre of the device card, relative to
  // the SVG's origin. Used by the HTML overlay (interface pills + selection
  // glow) so it can align with each device without going through SVG layout.
  positions: Map<string, { cx: number; cy: number }>;
  width: number;
  height: number;
}

function renderTopologySVG(
  data: TopologyData,
  opts: TopologyRenderOpts,
): TopologyRenderResult {
  const nodes: TopoNode[] = Array.isArray(data.nodes) ? data.nodes : [];
  const links: TopoLink[] = Array.isArray(data.links) ? data.links : [];
  const selected = opts.selected ?? new Set<string>();

  const cols = Math.min(nodes.length || 1, 4);
  const rowCount = nodes.length === 0 ? 1 : Math.ceil(nodes.length / cols);
  const perRowExtraH: number[] = new Array(rowCount).fill(0);
  const cellW = NODE_W;
  const svgW = (cellW + H_GAP) * cols + H_GAP;
  const svgH = (NODE_H + V_GAP) * rowCount + V_GAP;

  const naturalViewBox = `0 0 ${svgW} ${svgH}`;
  const initialViewBox = opts.viewState ? viewBoxStr(opts.viewState) : naturalViewBox;

  // No width/height attrs — CSS sizes the SVG to fill its slot, and
  // viewBox + preserveAspectRatio handle the coordinate mapping. This
  // lets the topology canvas grow to match the page viewport without
  // the SVG fighting browser scrollbars. preserveAspectRatio defaults
  // to xMidYMid meet, which centres the content and never squashes —
  // the right default for a network diagram.
  const svg = svgEl("svg", {
    viewBox: initialViewBox,
    preserveAspectRatio: "xMidYMid meet",
    "class": "topology-graph",
    role: "img",
    "aria-label": "Network topology diagram",
  });

  const positions = layoutNodes(nodes, cellW, perRowExtraH, opts.pinnedPositions);

  // Draw links first (under nodes). When onLinkClick is wired, each
  // visible line gets a wider invisible hit-target sibling so clicking
  // on or near the line is reliable — bare 1.5px strokes are nearly
  // impossible to hit.
  const dimmed = opts.dimmedNames ?? new Set<string>();
  const paletteByDevice = opts.paletteByDevice;
  for (const link of links) {
    const from = link.local_device ? positions.get(link.local_device) : undefined;
    const to = link.remote_device ? positions.get(link.remote_device) : undefined;
    if (!from || !to) continue;
    const linkDimmed = (link.local_device !== undefined && dimmed.has(link.local_device))
      || (link.remote_device !== undefined && dimmed.has(link.remote_device));
    // Link palette inherits the worst endpoint state (slice #210.E
    // subset): a link to a down or drifted device reads as down /
    // drifted; spec-only on either end colors the line spec-only;
    // otherwise it sits clean (actuated-ok) or unknown.
    let linkPalette: PaletteState = "unknown";
    if (paletteByDevice && link.local_device && link.remote_device) {
      const a = paletteByDevice.get(link.local_device) ?? "unknown";
      const z = paletteByDevice.get(link.remote_device) ?? "unknown";
      linkPalette = resolveLinkPalette(a, z);
    }
    if (opts.onLinkClick) {
      const hit = svgEl("line", {
        "class": "topo-link-hit",
        x1: String(from.cx),
        y1: String(from.cy),
        x2: String(to.cx),
        y2: String(to.cy),
      });
      const onLinkClick = opts.onLinkClick;
      hit.addEventListener("click", (e) => {
        e.stopPropagation();
        onLinkClick(link);
      });
      svg.appendChild(hit);
    }
    const line = svgEl("line", {
      "class": "topo-link topo-elem--" + linkPalette + (linkDimmed ? " topo-link--dimmed" : ""),
      x1: String(from.cx),
      y1: String(from.cy),
      x2: String(to.cx),
      y2: String(to.cy),
    });
    if (link.local_device) line.setAttribute("data-local-device", link.local_device);
    if (link.remote_device) line.setAttribute("data-remote-device", link.remote_device);
    svg.appendChild(line);
  }

  // Draw nodes.
  for (const node of nodes) {
    const pos = positions.get(node.name);
    if (!pos) continue;
    const isSelected = selected.has(node.name);
    const pendingCount = opts.pendingByDevice?.get(node.name) ?? 0;
    const isPendingAdd = opts.isPendingAdd?.(node.name) ?? false;
    const isPendingRemove = opts.isPendingRemove?.(node.name) ?? false;
    const status = opts.statusByDevice?.get(node.name);
    // Phase 2: substrate-agnostic state class. Tooltip carries the detail.
    // Unified palette (slice #210.A) — caller-pre-resolved per the
    // active view mode (slice #210.B/C/D). The renderer just looks up
    // the per-device class; pending-add / pending-del / selected /
    // dragging / dimmed classes are orthogonal (staging / UI state)
    // and continue to apply alongside.
    const driftCount = opts.driftByDevice?.get(node.name) ?? 0;
    const palette: PaletteState = opts.paletteByDevice?.get(node.name) ?? "unknown";
    const paletteClass = ` topo-elem--${palette}`;

    const ariaLabelParts = [`Device ${node.name}`, palette];
    if (driftCount > 0) {
      ariaLabelParts.push(`drift: ${driftCount} item${driftCount === 1 ? "" : "s"}`);
    }

    const isDimmed = dimmed.has(node.name);
    const g = svgEl("g", {
      "class": "topo-node"
        + (isSelected ? " topo-node--selected" : "")
        + (pendingCount > 0 ? " topo-node--pending" : "")
        + (isDimmed ? " topo-node--dimmed" : "")
        + (isPendingAdd ? " topo-node--pending-add" : "")
        + (isPendingRemove ? " topo-node--pending-del" : "")
        + paletteClass,
      role: "button",
      tabindex: "0",
      "aria-label": ariaLabelParts.join(" — "),
      "data-device": node.name,
    });

    if (isSelected) {
      // Selection ring drawn behind the node rect.
      g.appendChild(svgEl("rect", {
        "class": "topo-node-selection-ring",
        x: String(pos.cx - NODE_W / 2 - 5),
        y: String(pos.cy - NODE_H / 2 - 5),
        width: String(NODE_W + 10),
        height: String(NODE_H + 10),
        rx: "8",
      }));
    }

    const rect = svgEl("rect", {
      x: String(pos.cx - NODE_W / 2),
      y: String(pos.cy - NODE_H / 2),
      width: String(NODE_W),
      height: String(NODE_H),
      rx: "4",
    });
    g.appendChild(rect);

    const label = svgEl("text", {
      x: String(pos.cx),
      y: String(pos.cy - 8),
    });
    label.textContent = node.name;
    g.appendChild(label);

    if (node.type) {
      const typeLabel = svgEl("text", {
        "class": "topo-node-type",
        x: String(pos.cx),
        y: String(pos.cy + 10),
      });
      typeLabel.textContent = String(node.type);
      g.appendChild(typeLabel);
    }

    // Corner status text — short textual signal (lab phase / physical
    // online state) under the rect's bottom-right. Mutually exclusive
    // with empty / missing entries so Spec view stays text-free.
    const statusText = opts.statusTextByDevice?.get(node.name) ?? "";
    if (statusText !== "") {
      const statusLabel = svgEl("text", {
        "class": "topo-status-text",
        "data-status-text": node.name,
        x: String(pos.cx + NODE_W / 2),
        y: String(pos.cy + NODE_H / 2 + 12),
      });
      statusLabel.textContent = statusText;
      g.appendChild(statusLabel);
    } else {
      // Render a hidden anchor so patchDeviceStatuses can replace it
      // in place when the status text fills in later (poll tick).
      const placeholder = svgEl("text", {
        "class": "topo-status-text topo-status-text--empty",
        "data-status-text": node.name,
        x: String(pos.cx + NODE_W / 2),
        y: String(pos.cy + NODE_H / 2 + 12),
      });
      g.appendChild(placeholder);
    }

    // Drag-to-reposition wiring. Only active when the caller wired
    // onNodeMoved. A drag of more than a few pixels suppresses the
    // upcoming click — otherwise tiny-jitter clicks would feel like
    // they dropped events.
    let dragOccurred = false;
    if (opts.onNodeMoved) {
      const onNodeMoved = opts.onNodeMoved;
      const startCx = pos.cx;
      const startCy = pos.cy;
      g.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();  // don't let the SVG-level pan handler see it
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        let dragging = false;
        dragOccurred = false;

        const pixelToSVG = (dx: number, dy: number): { sx: number; sy: number } => {
          const rect = svg.getBoundingClientRect();
          const vb = svg.viewBox.baseVal;
          return {
            sx: (dx / rect.width) * vb.width,
            sy: (dy / rect.height) * vb.height,
          };
        };

        const onMove = (em: MouseEvent): void => {
          const dx = em.clientX - startClientX;
          const dy = em.clientY - startClientY;
          if (!dragging) {
            if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
            dragging = true;
            dragOccurred = true;
            g.classList.add("topo-node--dragging");
          }
          const { sx, sy } = pixelToSVG(dx, dy);
          g.setAttribute("transform", `translate(${sx}, ${sy})`);
        };
        const onUp = (em: MouseEvent): void => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          g.classList.remove("topo-node--dragging");
          if (dragging) {
            const { sx, sy } = pixelToSVG(em.clientX - startClientX, em.clientY - startClientY);
            onNodeMoved(node.name, { cx: startCx + sx, cy: startCy + sy });
            // The caller's onNodeMoved will mutate the pinned-positions
            // map + trigger renderGraph; the new SVG group will be at
            // the new position, so the transform we set here is gone
            // with the old element.
          }
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    }

    g.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dragOccurred) {
        dragOccurred = false;
        return;
      }
      opts.onNodeClick(node.name, e);
    });
    g.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      opts.onNodeContextMenu?.(node.name, e);
    });
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        opts.onNodeClick(node.name, new MouseEvent("click", {
          clientX: pos.cx,
          clientY: pos.cy,
        }));
      }
    });

    // Phase 2: substrate-agnostic status badge. Color matches state via CSS
    // (topo-status-dot--{state}); tooltip carries substrate detail.
    if (status) {
      const sx = pos.cx - NODE_W / 2 + 8;
      const sy = pos.cy + NODE_H / 2 - 8;
      const dot = svgEl("g", { "class": "topo-status-badge", "data-status-badge": node.name });
      dot.appendChild(svgEl("circle", {
        cx: String(sx), cy: String(sy), r: "5",
        "class": `topo-status-dot topo-status-dot--${status.state}`,
      }));
      const t = svgEl("title");
      t.textContent = `${node.name}: ${status.state} — ${status.detail}`;
      dot.appendChild(t);
      g.appendChild(dot);
    }

    // Pending-changes badge (small dot in the bottom-right; drift is top-right,
    // delete is top-left, so we avoid overlap.)
    if (pendingCount > 0) {
      const pBadge = svgEl("g", { "class": "topo-pending-badge" });
      const pcx = pos.cx + NODE_W / 2 - 8;
      const pcy = pos.cy + NODE_H / 2 - 8;
      pBadge.appendChild(svgEl("circle", { cx: String(pcx), cy: String(pcy), r: "7" }));
      const pcount = svgEl("text", {
        x: String(pcx), y: String(pcy),
        "text-anchor": "middle", "dominant-baseline": "central",
      });
      pcount.textContent = String(pendingCount);
      pBadge.appendChild(pcount);
      const ptitle = svgEl("title");
      ptitle.textContent = `${pendingCount} pending change${pendingCount === 1 ? "" : "s"}`;
      pBadge.appendChild(ptitle);
      g.appendChild(pBadge);
    }

    // Drift badge: small dot in the top-right when the device has drift.
    // driftCount + driftClass were computed up top alongside the other
    // node-level state classes; reuse that value here.
    if (driftCount > 0) {
      const badge = svgEl("g", { "class": "topo-drift-badge" });
      const cx = pos.cx + NODE_W / 2 - 8;
      const cy = pos.cy - NODE_H / 2 + 8;
      badge.appendChild(svgEl("circle", { cx: String(cx), cy: String(cy), r: "7" }));
      const count = svgEl("text", {
        x: String(cx),
        y: String(cy),
        "text-anchor": "middle",
        "dominant-baseline": "central",
      });
      count.textContent = String(driftCount);
      badge.appendChild(count);
      const title = svgEl("title");
      title.textContent = `${driftCount} drift item${driftCount === 1 ? "" : "s"}`;
      badge.appendChild(title);
      g.appendChild(badge);
    }

    // Delete button: × shown on node hover (top-left corner).
    if (opts.onNodeDelete) {
      const onNodeDelete = opts.onNodeDelete;
      const delBtn = svgEl("g", { "class": "topo-node-delete", "aria-label": `Remove ${node.name}` });
      const bx = pos.cx - NODE_W / 2;
      const by = pos.cy - NODE_H / 2;
      delBtn.appendChild(svgEl("rect", {
        x: String(bx),
        y: String(by),
        width: "16",
        height: "16",
        rx: "3",
        "class": "topo-node-delete-bg",
      }));
      const delText = svgEl("text", {
        x: String(bx + 8),
        y: String(by + 8),
        "text-anchor": "middle",
        "dominant-baseline": "central",
        "class": "topo-node-delete-x",
      });
      delText.textContent = "×";
      delBtn.appendChild(delText);
      const delTitle = svgEl("title");
      delTitle.textContent = `Remove ${node.name}`;
      delBtn.appendChild(delTitle);
      const capturedName = node.name;
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onNodeDelete(capturedName);
      });
      g.appendChild(delBtn);
    }

    svg.appendChild(g);
  }

  if (nodes.length === 0) {
    const msg = svgEl("text", {
      x: String(svgW / 2),
      y: String(svgH / 2),
      "text-anchor": "middle",
      "dominant-baseline": "central",
      "font-size": "13",
      fill: "#57534e",
    });
    msg.textContent = "No devices in topology";
    svg.appendChild(msg);
  }

  // Pan + zoom interactivity. Only wired when the caller threads
  // viewState through opts so re-renders don't re-init the listeners
  // (the SVG is recreated each render; the caller persists state).
  if (opts.viewState && opts.onViewStateChange) {
    const onChange = opts.onViewStateChange;
    let view: ViewState = opts.viewState;

    // Wheel → zoom around cursor. preventDefault stops the page from
    // scrolling while the operator is zooming the graph.
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      // Each wheel notch in or out multiplies by ZOOM_STEP. e.deltaY is
      // positive on scroll-down (zoom out) and negative on scroll-up
      // (zoom in) on most browsers / OSes; respect that.
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      view = zoomAt(view, factor, cx, cy, rect.width, rect.height, svgW);
      svg.setAttribute("viewBox", viewBoxStr(view));
      onChange(view);
    }, { passive: false });

    // Drag-empty-canvas → pan. A drag that lands on a node still
    // reaches the node click/contextmenu handlers because the listener
    // bails when the target is a node descendant.
    svg.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // Bail if the click landed inside any element with .topo-node — the
      // node handlers own those interactions.
      if (e.target instanceof Element && e.target.closest(".topo-node")) return;
      const dragStart = { clientX: e.clientX, clientY: e.clientY, view };
      svg.classList.add("topology-graph--panning");
      e.preventDefault();

      // Bind on window so the drag continues even if the cursor leaves
      // the SVG. Detach in onUp so the listeners don't leak across the
      // SVG's lifetime (renderGraph recreates the SVG on each call).
      const onMove = (em: MouseEvent): void => {
        const rect = svg.getBoundingClientRect();
        const dx = em.clientX - dragStart.clientX;
        const dy = em.clientY - dragStart.clientY;
        view = panBy(dragStart.view, dx, dy, rect.width, rect.height);
        svg.setAttribute("viewBox", viewBoxStr(view));
      };
      const onUp = (): void => {
        svg.classList.remove("topology-graph--panning");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        onChange(view);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }

  return { svg, positions, width: svgW, height: svgH };
}

// ---- Node inspector drawer --------------------------------------------------

// NODE_TABS — the 6 primary tabs the device drawer surfaces. Down from
// 14 (collapsed VLANs / VRFs / ACLs / BGP / EVPN / LAGs / Neighbors
// under "State"; tucked Config DB / Intent Tree / Projection under a
// "Raw" disclosure rendered below the panels). Ordered by operator
// priority: Summary (at-a-glance dashboard) → Interfaces (most-acted-
// on surface) → State (observed reality, grouped) → Spec (declared
// intent, visually distinct) → Drift (actionable diff, first-class)
// → History (audit timeline).
const NODE_TABS = [
  { id: "interfaces", label: "Interfaces" },
  { id: "state",      label: "State" },
  { id: "spec",       label: "Spec" },
  { id: "drift",      label: "Drift" },
  { id: "history",    label: "History" },
] as const;

type NodeTabId = typeof NODE_TABS[number]["id"];

// State sub-sections rendered inside the State tab as collapsible
// disclosures. Each fetches lazily on first expansion; sections with
// no data show "—" inline instead of empty disclosures.
const STATE_SUBSECTIONS = [
  { id: "vlans",     label: "VLANs" },
  { id: "vrfs",      label: "VRFs" },
  { id: "acls",      label: "ACLs" },
  { id: "bgp",       label: "BGP" },
  { id: "evpn",      label: "EVPN" },
  { id: "lags",      label: "LAGs" },
  { id: "neighbors", label: "Neighbors" },
] as const;

// Raw / debug-only data — Config DB / Intent Tree / Projection. These
// are storage-layer reads useful for power-user debugging but
// rarely the operator's first stop. Tucked behind a disclosure
// labelled "Raw" below the tab panels.
const RAW_SECTIONS = [
  { id: "configdb",    label: "Config DB" },
  { id: "projection",  label: "Projection" },
  { id: "intent-tree", label: "Intent Tree" },
] as const;

// renderLoadingInto clears a container and shows a loading indicator.
function renderLoadingInto(container: HTMLElement): void {
  container.textContent = "";
  container.appendChild(el("p", { className: "status-loading" }, "Loading…"));
}

// renderErrorInto clears a container and shows an error message.
function renderErrorInto(container: HTMLElement, err: unknown): void {
  container.textContent = "";
  if (err instanceof ApiError && err.kind === "newtron_unavailable") {
    container.appendChild(el("p", { className: "panel-error" }, "Device unreachable"));
    const detailObj = err.details as { underlying_error_message?: string } | undefined;
    const detail = detailObj?.underlying_error_message ?? err.message;
    container.appendChild(el("p", { className: "panel-error-detail" }, detail));
  } else if (err instanceof ApiError && err.kind === "internal" && err.status === 404) {
    container.appendChild(el("p", { className: "panel-error" }, "Not found"));
  } else if (err instanceof ApiError) {
    container.appendChild(el("p", { className: "panel-error" }, err.message));
  } else {
    container.appendChild(el("p", { className: "panel-error" }, "Request failed"));
    container.appendChild(el("p", { className: "panel-error-detail" }, String(err)));
  }
}

// renderProfileNotFound renders the empty-state for the Profile sub-tab when
// no profile spec is named after the device. Two reasons this can happen:
//
//   - Older topologies created before the unified-substrate convention
//     (PR #148) may name profile and device differently.
//   - The profile was deleted but the topology entry survived.
//
// We surface this honestly rather than rendering a generic "not found" — the
// operator's mental model of "every node has a profile" should not be
// silently violated by the UI.
function renderProfileNotFound(container: HTMLElement, device: string): void {
  container.textContent = "";
  container.appendChild(el("p", { className: "panel-error" }, "No node found"));
  container.appendChild(el(
    "p",
    { className: "panel-error-detail" },
    `No profile spec named "${device}" exists for this device. ` +
    "Nodes and device names are conventionally identical (created together " +
    "from the Topology view). If this device's node uses a different name, " +
    "find it under the Specs view → Nodes."
  ));
}

// renderValueInto places renderValue output into a container, adding .drawer-detail.
function renderValueInto(container: HTMLElement, data: unknown): void {
  container.textContent = "";
  const body = renderValue(data);
  if (body instanceof HTMLElement) {
    body.classList.add("drawer-detail");
  }
  container.appendChild(body);
}

// renderSpecDetailInto renders spec data with a tailored, schema-aware
// layout: each schema field becomes a labeled row in the order the schema
// defines, and any extra fields newtron returned (not in the schema) sit
// inside an "All fields" disclosure so the operator never silently loses
// visibility of newtron data — even fields the schema hasn't been updated
// to cover (e.g. ssh_pass, additions made after this build).
//
// extraExcludes is for fields already rendered elsewhere in the drawer
// (e.g. sub-rule children for kinds that have a dedicated rules / queues /
// prefixes section below the body). Pass [] for the default.
//
// Falls back to renderValueInto when data is not an object (defensive
// against newtron returning a primitive or null).
// toSpecField adapts a newtron SchemaField to the narrower SpecField the
// detail renderer consumes. ref_kind is carried through only for type
// "ref" fields, so the renderer knows which rows become cross-link chips.
function toSpecField(f: import("./api/newtcon/schema.js").SchemaField): SpecField {
  const out: SpecField = { name: f.name, label: f.label };
  if (f.type === "ref" && f.ref_kind) out.refKind = f.ref_kind;
  return out;
}

function renderSpecDetailInto(container: HTMLElement, fields: SpecField[], data: unknown, extraExcludes: string[] = []): void {
  container.textContent = "";
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    renderValueInto(container, data);
    return;
  }
  // "name" is rendered in the drawer header already (drawer-name); skip it
  // here to avoid a redundant row in the body. extraExcludes adds caller-
  // supplied fields (typically a sub-rule's wire-field name).
  const shape = buildSpecDetailShape(fields, data as Record<string, unknown>, ["name", ...extraExcludes]);

  // Empty-state: the schema is just `name` (zones today) AND newtron returned
  // nothing else. Operator gets an honest "nothing more to see" rather than
  // a blank drawer body that looks like a render failure.
  if (shape.rows.length === 0 && shape.extras.length === 0) {
    container.appendChild(el("p", { className: "spec-detail-empty-state" },
      "This spec has no additional fields."));
    return;
  }

  const dl = el("dl", { className: "spec-detail drawer-detail" });
  for (const row of shape.rows) {
    dl.appendChild(el("dt", { className: "spec-detail-label" }, row.label));
    const dd = el("dd", { className: "spec-detail-value" });
    dd.appendChild(renderSpecValue(row));
    dl.appendChild(dd);
  }
  container.appendChild(dl);

  if (shape.extras.length > 0) {
    const det = el("details", { className: "spec-detail-extras" });
    det.appendChild(el("summary", { className: "spec-detail-extras-summary" },
      `All fields (${shape.extras.length} additional)`));
    const dlx = el("dl", { className: "spec-detail" });
    for (const row of shape.extras) {
      dlx.appendChild(el("dt", { className: "spec-detail-label spec-detail-label--extra" }, row.label));
      const dd = el("dd", { className: "spec-detail-value" });
      dd.appendChild(renderSpecValue(row));
      dlx.appendChild(dd);
    }
    det.appendChild(dlx);
    container.appendChild(det);
  }
}

// humanizeStepUrl turns a topology step verb ("/setup-device") into a readable
// title ("Setup device").
function humanizeStepUrl(url: string): string {
  const slug = url.replace(/^\//, "").replace(/-/g, " ").trim();
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : "Step";
}

// renderTopologyIntentInto renders a device's topology.json entry — its
// provisioning steps (the declared intent newtron replays on provision) and its
// per-port config — into the Spec tab. Steps render as labeled field groups;
// ports as a compact table ordered low→high (comparePorts).
function renderTopologyIntentInto(host: HTMLElement, entry: unknown): void {
  host.textContent = "";
  const e = entry && typeof entry === "object" ? entry as { steps?: unknown; ports?: unknown } : {};
  const steps = Array.isArray(e.steps) ? e.steps : [];
  const ports = e.ports && typeof e.ports === "object" ? e.ports as Record<string, Record<string, unknown>> : {};
  const portNames = Object.keys(ports).sort(comparePorts);

  if (steps.length === 0 && portNames.length === 0) {
    host.appendChild(el("p", { className: "spec-detail-empty-state" },
      "No topology intent declared — no provisioning steps or port config in topology.json for this device."));
    return;
  }

  if (steps.length > 0) {
    host.appendChild(el("h5", { className: "node-spec-subtitle" }, `Provisioning steps (${steps.length})`));
    for (const raw of steps) {
      const step = raw && typeof raw === "object" ? raw as { url?: unknown; params?: unknown } : {};
      const url = typeof step.url === "string" ? step.url : "step";
      const det = el("details", { className: "node-spec-step" });
      (det as HTMLDetailsElement).open = true;
      det.appendChild(el("summary", { className: "node-spec-step-summary" }, humanizeStepUrl(url)));
      const params = step.params && typeof step.params === "object" ? step.params as Record<string, unknown> : {};
      const fields = params.fields && typeof params.fields === "object" ? params.fields as Record<string, unknown> : params;
      const dl = el("dl", { className: "spec-detail drawer-detail" });
      const fieldEntries = Object.entries(fields);
      if (fieldEntries.length === 0) {
        dl.appendChild(el("dd", { className: "spec-detail-value spec-detail-empty" }, "—"));
      } else {
        for (const [k, v] of fieldEntries) {
          dl.appendChild(el("dt", { className: "spec-detail-label" }, k));
          const dd = el("dd", { className: "spec-detail-value" });
          dd.appendChild(renderValue(v));
          dl.appendChild(dd);
        }
      }
      det.appendChild(dl);
      host.appendChild(det);
    }
  }

  if (portNames.length > 0) {
    host.appendChild(el("h5", { className: "node-spec-subtitle" }, `Port config (${portNames.length})`));
    const cols = ["admin_status", "mtu", "speed", "description"];
    const table = el("table", { className: "node-spec-port-table" });
    const thead = el("thead");
    const hr = el("tr");
    for (const l of ["Port", "Admin", "MTU", "Speed", "Description"]) hr.appendChild(el("th", {}, l));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const name of portNames) {
      const cfg = ports[name] ?? {};
      const tr = el("tr");
      tr.appendChild(el("td", { className: "node-spec-port-name" }, name));
      for (const c of cols) {
        const v = cfg[c];
        tr.appendChild(el("td", {}, v === undefined || v === null || v === "" ? "—" : String(v)));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    host.appendChild(table);
  }
}

// renderSpecValue renders one SpecRow's value cell. Empty values show
// "—". Ref rows (refKind set) with a non-empty string value render as a
// clickable chip that opens the referenced spec's drawer; everything
// else falls through to the generic renderValue. Resolution of the
// ref's kind → URL slug happens lazily on click (the schema cache is
// already warm by the time a detail drawer is open, so it's instant).
function renderSpecValue(row: import("./spec-detail-shape.js").SpecRow): Node {
  if (row.empty) return el("span", { className: "spec-detail-empty" }, "—");
  if (row.refKind && typeof row.value === "string" && row.value !== "") {
    return renderRefChip(row.refKind, row.value);
  }
  return renderValue(row.value);
}

// renderRefChip builds a clickable chip for a cross-spec reference. The
// click resolves refKind (a newtron kind name) to its URL slug and
// opens that spec's detail drawer over the current one. A failed
// resolution (embedded kind, schema not loaded) surfaces a toast rather
// than a dead click.
function renderRefChip(refKind: string, name: string): HTMLElement {
  const chip = el("button", {
    type: "button",
    className: "spec-ref-chip",
    title: `Open ${name}`,
  }, name) as HTMLButtonElement;
  chip.addEventListener("click", () => {
    void (async () => {
      const slug = await resolveKindToSlug(refKind).catch(() => null);
      if (!slug) {
        showToast({
          kind: "error",
          title: `Can't open "${name}"`,
          body: "Its spec type isn't separately viewable.",
        });
        return;
      }
      const kind = slug as SpecKind;
      await openDetail(kind, kindTitleFor(kind), name);
    })();
  });
  return chip;
}

// renderInterfaceTab renders the unified, sorted device interface view: one row
// per platform port (configured AND available), joining inventory + topology
// port config + live state + service bindings + topology links. Rows expand
// in place to full per-port detail + actions. `data` is the live interface
// list already fetched by the tab loader; the rest is fetched here and joined
// via buildDeviceInterfaceView (pure).
function renderInterfaceTab(container: HTMLElement, device: string): void {
  container.textContent = "";
  const host = el("div", { className: "iface-view" });
  container.appendChild(host);
  void buildAndRenderIfaceView(host, device);
}

async function buildAndRenderIfaceView(host: HTMLElement, device: string): Promise<void> {
  host.textContent = "";
  host.appendChild(el("p", { className: "iface-view-loading" }, "Building interface view…"));

  // Inventory-first: the table is driven by the platform inventory + the
  // declared topology — both known from the spec, WITHOUT the node running. The
  // live interface read is a best-effort oper-status overlay; its absence (an
  // un-deployed/unreachable node) must NOT hide the ports or block staging
  // services. So the live read can fail and we still render every platform port.
  let liveUnavailable = false;
  const [profile, topo, liveRaw] = await Promise.all([
    fetchSpecDetail("nodes", device).catch(() => null),
    fetchTopology().catch(() => null),
    fetchNodeInterfaces(device).catch(() => { liveUnavailable = true; return null; }),
  ]);
  const platform = (profile as { platform?: string } | null)?.platform ?? "";
  const devEntry = ((topo as { nodes?: Record<string, { ports?: Record<string, Record<string, unknown>>; steps?: unknown[] }> } | null)?.nodes ?? {})[device] ?? {};
  const topoPorts = devEntry.ports ?? {};
  const bindings = deriveDeviceBindings(devEntry);
  const links = linksForDevice((topo as { links?: unknown } | null)?.links, device);
  let inventory: PlatformPort[] = [];
  if (platform) {
    const plat = await fetchSpecDetail("platforms", platform).catch(() => null);
    const ports = (plat as { ports?: PlatformPort[] } | null)?.ports;
    if (Array.isArray(ports)) inventory = ports;
  }
  const live = Array.isArray(liveRaw) ? liveRaw as LiveIface[]
    : liveRaw && typeof liveRaw === "object" ? [liveRaw as LiveIface] : [];

  const rows = buildDeviceInterfaceView({ inventory, topoPorts, live, bindings, links });
  if (rows.length === 0) {
    host.textContent = "";
    host.appendChild(el("p", { className: "topology-empty" },
      "No interfaces — this node has no platform (no port inventory) and no configured ports."));
    return;
  }
  renderIfaceTable(host, device, rows, liveUnavailable, () => { void buildAndRenderIfaceView(host, device); });
}

const IFACE_FILTERS: { id: import("./device-interfaces.js").ViewFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "configured", label: "Configured" },
  { id: "available", label: "Available" },
  { id: "up", label: "Up" },
];

function renderIfaceTable(host: HTMLElement, device: string, rows: InterfaceRow[], liveUnavailable: boolean, reload: () => void): void {
  host.textContent = "";
  const counts = countView(rows);

  // Header: port-utilization summary.
  host.appendChild(el("p", { className: "iface-view-counts" },
    `${counts.total} ports · ${counts.configured} configured · ${counts.up} up · ${counts.available} available`));

  // Live-state overlay unavailable (un-deployed / unreachable device): the table
  // still shows every platform port from the inventory + the declared topology,
  // so ports can be configured and services staged before the node comes up.
  if (liveUnavailable) {
    host.appendChild(el("p", { className: "iface-view-offline-note" },
      "Device not reachable — showing declared topology + platform inventory (live status unavailable). You can still configure ports and stage services; they apply on deploy."));
  }

  // Controls: segmented filter + text search.
  let filter: import("./device-interfaces.js").ViewFilter = "all";
  let query = "";
  const controls = el("div", { className: "iface-view-controls" });
  const seg = el("div", { className: "iface-seg" });
  const segBtns = new Map<string, HTMLButtonElement>();
  for (const f of IFACE_FILTERS) {
    const b = el("button", { type: "button", className: "iface-seg-btn" + (f.id === filter ? " iface-seg-btn--active" : "") }, f.label) as HTMLButtonElement;
    b.addEventListener("click", () => { filter = f.id; for (const [id, btn] of segBtns) btn.classList.toggle("iface-seg-btn--active", id === f.id); renderRows(); });
    seg.appendChild(b);
    segBtns.set(f.id, b);
  }
  controls.appendChild(seg);
  const search = el("input", { type: "search", className: "iface-search form-control", placeholder: "Filter ports…" }) as HTMLInputElement;
  search.addEventListener("input", () => { query = search.value; renderRows(); });
  controls.appendChild(search);
  host.appendChild(controls);

  // Table.
  const table = el("table", { className: "iface-table" });
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["Port", "Role", "Speed/MTU", "VLAN / VRF / IP", "Service", "Link"]) hr.appendChild(el("th", {}, h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  table.appendChild(tbody);
  host.appendChild(table);

  const empty = el("p", { className: "iface-table-empty" }, "No ports match this filter.");
  empty.hidden = true;
  host.appendChild(empty);

  const renderRows = (): void => {
    tbody.textContent = "";
    const pending = new Set(
      deviceQueue(device)
        .filter((p) => p.group === "interface")
        .map((p) => (p as { iface?: string }).iface)
        .filter((x): x is string => !!x),
    );
    const shown = applyIfaceFilter(rows, filter, query);
    empty.hidden = shown.length > 0;
    for (const row of shown) renderIfaceRow(tbody, device, row, reload, pending);
  };
  renderRows();
}

function renderIfaceRow(tbody: HTMLElement, device: string, row: InterfaceRow, reload: () => void, pending: Set<string>): void {
  const isPending = pending.has(row.name);
  const tr = el("tr", { className: "iface-row" + (row.available ? " iface-row--available" : "") + (isPending ? " iface-row--pending" : ""), tabIndex: 0 });

  // Port cell: status dot + name (+ pending marker when a queued action targets it).
  const portCell = el("td", { className: "iface-cell-port" });
  portCell.appendChild(el("span", { className: `iface-dot iface-dot--${row.status}`, title: statusTitle(row) }));
  portCell.appendChild(el("span", { className: "iface-name" }, row.name));
  if (isPending) portCell.appendChild(el("span", { className: "iface-pending-chip", title: "Queued changes — Save to apply" }, "pending"));
  tr.appendChild(portCell);

  tr.appendChild(el("td", {}, el("span", { className: `iface-role iface-role--${row.role}` }, roleLabel(row.role))));
  tr.appendChild(el("td", { className: "iface-cell-mono" }, [row.speed, row.mtu !== undefined ? String(row.mtu) : ""].filter(Boolean).join(" / ") || "—"));
  tr.appendChild(el("td", { className: "iface-cell-l2l3" }, row.l2l3 || "—"));

  // Service cell: chip if bound, else an inline "+ Apply" CTA on serviceless ports.
  const svcCell = el("td", { className: "iface-cell-svc" });
  if (row.service) {
    svcCell.appendChild(el("span", { className: "iface-svc-chip" }, row.service));
  } else {
    const apply = el("button", { type: "button", className: "iface-apply-cta" }, "+ Apply");
    apply.addEventListener("click", (e) => { e.stopPropagation(); expand(true); });
    svcCell.appendChild(apply);
  }
  tr.appendChild(svcCell);

  tr.appendChild(el("td", { className: "iface-cell-link" }, row.link || "—"));
  tbody.appendChild(tr);

  // Expand-in-place detail row.
  const detailTr = el("tr", { className: "iface-detail-row" });
  const detailTd = el("td", { className: "iface-detail-cell" });
  detailTd.setAttribute("colspan", "6");
  detailTr.appendChild(detailTd);
  detailTr.hidden = true;
  tbody.appendChild(detailTr);

  let built = false;
  // expand opens the detail (optionally auto-opening the Apply-service form);
  // toggle collapses if already open.
  const expand = (autoApply: boolean): void => {
    detailTr.hidden = false;
    tr.classList.add("iface-row--expanded");
    if (!built || autoApply) { built = true; renderIfaceDetail(detailTd, device, row, reload, autoApply); }
  };
  const toggle = (): void => {
    if (detailTr.hidden) { expand(false); return; }
    detailTr.hidden = true;
    tr.classList.remove("iface-row--expanded");
  };
  tr.addEventListener("click", toggle);
  tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
}

function renderIfaceDetail(host: HTMLElement, device: string, row: InterfaceRow, reload: () => void, autoApply = false): void {
  host.textContent = "";

  // Properties (tailored, not a JSON dump).
  const props: Array<[string, string]> = [
    ["Admin", row.adminStatus ?? "—"],
    ["Oper", row.operStatus || "—"],
    ["Speed", row.speed || "—"],
    ["MTU", row.mtu !== undefined ? String(row.mtu) : "—"],
    ["Role", roleLabel(row.role)],
  ];
  if (row.live?.pc_member === true) props.push(["Port-channel member", "yes"]);
  if (row.link) props.push(["Link", row.link]);
  const dl = el("dl", { className: "iface-prop-grid" });
  for (const [k, v] of props) { dl.appendChild(el("dt", {}, k)); dl.appendChild(el("dd", {}, v)); }
  host.appendChild(dl);

  // Service binding.
  if (row.service) {
    const svc = el("div", { className: "iface-detail-svc" });
    svc.appendChild(el("span", { className: "iface-svc-chip" }, row.service));
    if (row.l2l3) svc.appendChild(el("span", { className: "iface-detail-svc-meta" }, row.l2l3));
    host.appendChild(svc);
  }

  // Already-queued actions for this port (workspace queue overlay).
  const queued = deviceQueue(device).filter((p) => p.group === "interface" && (p as { iface?: string }).iface === row.name);
  if (queued.length > 0) {
    const q = el("div", { className: "iface-detail-queued" });
    q.appendChild(el("span", { className: "iface-pending-chip" }, "pending"));
    q.appendChild(el("span", { className: "iface-detail-queued-list" }, queued.map((p) => (p as { label: string }).label).join(" · ")));
    host.appendChild(q);
  }

  // Actions — staged through the workspace queue (preview + undo), consistent
  // with the rest of the workspace. Buttons reveal an inline form in formHost
  // for actions that take fields; field-less actions stage on click.
  const actions = el("div", { className: "iface-actions" });
  const formHost = el("div", { className: "iface-action-form-host" });

  actions.appendChild(portModeMenu(formHost, device, row.name, reload));

  if (row.canApplyService) {
    const apply = el("button", { type: "button", className: "iface-action-btn" }, "Apply service");
    apply.addEventListener("click", () => openIfaceForm(formHost, device, row.name, findIfaceAction("Service", "apply-service"), reload));
    actions.appendChild(apply);
  } else {
    const unbind = el("button", { type: "button", className: "iface-action-btn iface-action-btn--danger" }, "Unbind service");
    unbind.addEventListener("click", () => void stageIfaceAction(device, row.name, findIfaceAction("Service", "remove-service"), {}, reload));
    actions.appendChild(unbind);
  }

  if (row.link) {
    const rmLink = el("button", { type: "button", className: "iface-action-btn iface-action-btn--danger" }, "Remove link");
    rmLink.addEventListener("click", () => { enqueueTopologyRemoveLink(device, row.name); showToast({ kind: "success", title: "Queued", body: `Remove link on ${row.name} — Save to apply.` }); reload(); });
    actions.appendChild(rmLink);
  }
  host.appendChild(actions);
  host.appendChild(formHost);

  if (autoApply && row.canApplyService) {
    openIfaceForm(formHost, device, row.name, findIfaceAction("Service", "apply-service"), reload);
  }

  // Raw, tucked for power users (replaces the old always-on JSON dump).
  if (row.live) {
    const raw = el("details", { className: "iface-detail-raw" });
    raw.appendChild(el("summary", {}, "Raw"));
    raw.appendChild(renderValue(row.live));
    host.appendChild(raw);
  }
}

// findIfaceAction locates an INTERFACE_ACTIONS def by group + id (+ optional
// label, for the configure-interface variants that share one id).
function findIfaceAction(group: string, id: string, label?: string): ActionDef | undefined {
  const g = INTERFACE_ACTIONS.find((x) => x.group === group);
  return g?.items.find((a) => a.id === id && (label === undefined || a.label === label));
}

// portModeMenu builds the "Configure ▾" button; clicking it lists the Port-mode
// variants (access / trunk / routed / clear) into formHost. Field actions open
// an inline form; the field-less Clear confirms then stages.
function portModeMenu(formHost: HTMLElement, device: string, iface: string, reload: () => void): HTMLElement {
  const btn = el("button", { type: "button", className: "iface-action-btn" }, "Configure ▾");
  btn.addEventListener("click", () => {
    formHost.textContent = "";
    const menu = el("div", { className: "iface-portmode-menu" });
    const group = INTERFACE_ACTIONS.find((x) => x.group === "Port mode");
    for (const action of group?.items ?? []) {
      const b = el("button", { type: "button", className: "iface-action-btn" + (action.danger ? " iface-action-btn--danger" : "") }, action.label);
      b.addEventListener("click", async () => {
        if ((action.fields ?? []).length === 0) {
          if (action.confirm && !await confirmInline({ title: `${action.label}?`, body: action.confirm, danger: !!action.danger, confirmLabel: "Queue" })) return;
          await stageIfaceAction(device, iface, action, {}, reload);
        } else {
          openIfaceForm(formHost, device, iface, action, reload);
        }
      });
      menu.appendChild(b);
    }
    formHost.appendChild(menu);
  });
  return btn;
}

// openIfaceForm renders an interface action's inline form into formHost.
function openIfaceForm(formHost: HTMLElement, device: string, iface: string, action: ActionDef | undefined, reload: () => void): void {
  formHost.textContent = "";
  if (!action) return;
  const form = el("form", { className: "iface-action-form" });
  form.appendChild(el("p", { className: "iface-action-form-title" }, `${action.label} · ${iface}`));
  const reads: Array<{ field: ActionField; get: () => string | number }> = [];
  for (const field of action.fields ?? []) {
    const r = renderActionField(field);
    form.appendChild(r.row);
    reads.push({ field, get: r.get });
  }
  const errOut = el("div", { className: "form-error-out" });
  form.appendChild(errOut);
  const btnRow = el("div", { className: "iface-action-form-actions" });
  const cancel = el("button", { type: "button", className: "btn btn-ghost btn-sm" }, "Cancel");
  cancel.addEventListener("click", () => { formHost.textContent = ""; });
  const stage = el("button", { type: "submit", className: "btn btn-primary btn-sm" + (action.danger ? " btn-danger" : "") }, "Queue");
  btnRow.appendChild(cancel);
  btnRow.appendChild(stage);
  form.appendChild(btnRow);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errOut.textContent = "";
    const values: Record<string, unknown> = {};
    for (const { field, get } of reads) {
      const v = get();
      if (field.required && (v === "" || v === undefined)) {
        errOut.appendChild(el("p", { className: "panel-error" }, `${field.label} is required.`));
        return;
      }
      if (v !== "" && v !== undefined) values[field.name] = v;
    }
    if (action.confirm && !await confirmInline({ title: `${action.label}?`, body: action.confirm, danger: !!action.danger, confirmLabel: "Queue" })) return;
    formHost.textContent = "";
    await stageIfaceAction(device, iface, action, values, reload);
  });
  formHost.appendChild(form);
}

// renderActionField renders one interface action field (text / number / select).
// The "service" field is a dropdown populated from the network's services.
function renderActionField(field: ActionField): { row: HTMLElement; get: () => string | number } {
  const row = el("div", { className: "iface-field" });
  row.appendChild(el("label", { className: "iface-field-label" }, field.label + (field.required ? " *" : "")));
  if (field.name === "service") {
    const sel = el("select", { className: "form-control" }) as HTMLSelectElement;
    sel.appendChild(new Option("Loading…", ""));
    void fetch(apiPath("services"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { services: [] }))
      .then((d: unknown) => {
        sel.textContent = "";
        sel.appendChild(new Option("Select a service…", ""));
        for (const s of (d as { services?: { name: string }[] }).services ?? []) sel.appendChild(new Option(s.name, s.name));
      })
      .catch(() => { sel.textContent = ""; sel.appendChild(new Option("(couldn't load services)", "")); });
    row.appendChild(sel);
    return { row, get: () => sel.value };
  }
  const input = el("input", { type: field.type === "number" ? "number" : "text", className: "form-control" }) as HTMLInputElement;
  if (field.hint) input.placeholder = field.hint;
  row.appendChild(input);
  return {
    row,
    get: () => field.type === "number"
      ? (input.value.trim() === "" ? "" : Number(input.value))
      : input.value.trim(),
  };
}

// stageIfaceAction enqueues an interface action onto the workspace queue (which
// computes its undo inverse) and refreshes the view to reflect the pending edit.
async function stageIfaceAction(device: string, iface: string, action: ActionDef | undefined, values: Record<string, unknown>, reload: () => void): Promise<void> {
  if (!action) return;
  const body = { ...(action.wireBody ?? {}), ...values };
  enqueueInterfaceAction(device, iface, action.id, `${action.label} · ${iface}`, body, action.danger);
  showToast({ kind: "success", title: "Queued", body: `${action.label} on ${iface} — Save to apply.` });
  reload();
}

function statusTitle(row: InterfaceRow): string {
  return `admin ${row.adminStatus ?? "?"} · oper ${row.operStatus || "?"}`;
}
function roleLabel(role: InterfaceRow["role"]): string {
  switch (role) {
    case "lag-member": return "LAG member";
    case "available": return "Available";
    default: return role.charAt(0).toUpperCase() + role.slice(1);
  }
}

// renderConfigDBTab renders the CONFIG_DB sub-tab with 3-level navigation.
// renderDriftTab renders the drift list + a Reconcile button. Newtron returns
// either an empty array (no drift) or an array of drift items per table/key.
function renderDriftTab(container: HTMLElement, data: unknown, device?: string): void {
  container.textContent = "";
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    container.appendChild(
      el("p", { className: "drift-empty" }, "No delta drift detected. Device matches its last-applied intent."),
    );
    container.appendChild(
      el(
        "p",
        { className: "drift-empty-help" },
        "Use Reconcile (mode: topology) below to compare the device against the full topology spec from scratch.",
      ),
    );
    if (device) {
      container.appendChild(renderReconcileSection(device));
    }
    return;
  }
  const heading = el(
    "p",
    { className: "drift-header" },
    `${items.length} drift item${items.length === 1 ? "" : "s"} — device does not match intent.`,
  );
  container.appendChild(heading);
  const body = renderValue(data);
  if (body instanceof HTMLElement) body.classList.add("drift-detail");
  container.appendChild(body);

  if (device) {
    container.appendChild(renderReconcileSection(device));
  }
}

// renderReconcileSection emits the "Reconcile" button + preview/apply flow.
// Preview path: POST .../reconcile?dry_run=true → show ChangeSet structure.
// Apply path: confirm + POST without dry_run → show result + auto-refresh drift.
function renderReconcileSection(device: string): HTMLElement {
  const section = el("section", { className: "reconcile-section" });
  section.appendChild(el("h3", { className: "reconcile-heading" }, "Reconcile"));
  section.appendChild(
    el(
      "p",
      { className: "reconcile-help" },
      "Preview the corrective intent newtron would push to restore this device to its intent. Apply executes the change atomically per-device.",
    ),
  );

  const controls = el("div", { className: "reconcile-controls" });
  const modeLabel = el("label", { className: "reconcile-mode-label" }, "Mode: ");
  const modeSelect = el("select", { className: "reconcile-mode-select" }) as HTMLSelectElement;
  const optDelta = el("option", { value: "" }, "delta (changes since last apply)") as HTMLOptionElement;
  const optTopology = el("option", { value: "topology" }, "topology (full reconcile to topology spec)") as HTMLOptionElement;
  modeSelect.appendChild(optDelta);
  modeSelect.appendChild(optTopology);
  modeLabel.appendChild(modeSelect);
  controls.appendChild(modeLabel);
  const previewBtn = el("button", { type: "button", className: "reconcile-btn reconcile-btn--preview" }, "Preview reconcile");
  controls.appendChild(previewBtn);
  section.appendChild(controls);
  const out = el("div", { className: "reconcile-output" });
  section.appendChild(out);

  previewBtn.addEventListener("click", async () => {
    previewBtn.disabled = true;
    out.textContent = "";
    const chosenMode = modeSelect.value || undefined;
    out.appendChild(el("p", { className: "status-loading" }, `Previewing (mode: ${chosenMode ?? "delta"})…`));
    try {
      const preview = chosenMode === undefined ? await postNodeReconcile(device, { dryRun: true }) : await postNodeReconcile(device, { dryRun: true, mode: chosenMode });
      out.textContent = "";
      const previewItems = Array.isArray(preview) ? preview : [];
      out.appendChild(
        el(
          "p",
          { className: previewItems.length === 0 ? "reconcile-noop" : "reconcile-preview-header" },
          previewItems.length === 0
            ? "Preview returned no changes — nothing to reconcile."
            : `Preview: ${previewItems.length} corrective change${previewItems.length === 1 ? "" : "s"}. Review before applying.`,
        ),
      );
      const body = renderValue(preview);
      if (body instanceof HTMLElement) body.classList.add("reconcile-preview-body");
      out.appendChild(body);

      if (previewItems.length > 0) {
        const applyBtn = el("button", { type: "button", className: "reconcile-btn reconcile-btn--apply" }, "Apply reconcile (atomic per device)");
        out.appendChild(applyBtn);
        applyBtn.addEventListener("click", async () => {
          const ok = await confirmInline({
            title: `Reconcile ${device}?`,
            body: "Corrective changes will be written to the device's CONFIG_DB atomically. Verify the preview above first.",
            confirmLabel: "Apply reconcile",
          });
          if (!ok) return;
          applyBtn.disabled = true;
          previewBtn.disabled = true;
          applyBtn.textContent = "Applying…";
          try {
            const result = chosenMode === undefined ? await postNodeReconcile(device, { dryRun: false }) : await postNodeReconcile(device, { dryRun: false, mode: chosenMode });
            applyBtn.replaceWith(
              el("p", { className: "reconcile-applied" }, "Reconcile applied. Result:"),
            );
            const resBody = renderValue(result);
            if (resBody instanceof HTMLElement) resBody.classList.add("reconcile-result-body");
            out.appendChild(resBody);
            // Re-fetch drift to refresh the upper drift list.
            const fresh = await fetchNodeDrift(device);
            out.appendChild(el("hr", { className: "reconcile-sep" }));
            out.appendChild(el("p", { className: "reconcile-refresh-header" }, "Drift after reconcile:"));
            const driftBody = renderValue(fresh);
            if (driftBody instanceof HTMLElement) driftBody.classList.add("drift-detail");
            out.appendChild(driftBody);
          } catch (err) {
            applyBtn.replaceWith(el("p", { className: "panel-error" }, "Apply failed"));
            renderErrorInto(out, err);
          }
        });
      }
    } catch (err) {
      out.textContent = "";
      renderErrorInto(out, err);
    } finally {
      previewBtn.disabled = false;
    }
  });

  return section;
}

function renderConfigDBTab(container: HTMLElement, device: string, tableMap: unknown): void {
  container.textContent = "";

  let tableNames: string[] = [];
  if (tableMap !== null && typeof tableMap === "object" && !Array.isArray(tableMap)) {
    tableNames = Object.keys(tableMap as Record<string, unknown>).sort();
  } else if (Array.isArray(tableMap)) {
    tableNames = tableMap.map(String).sort();
  }

  if (tableNames.length === 0) {
    container.appendChild(el("p", { className: "topology-empty" }, "CONFIG_DB is empty"));
    return;
  }

  const tableList = el("ul", { className: "configdb-tables" });

  for (const tableName of tableNames) {
    const tableItem = el("li", { className: "configdb-table-item", tabIndex: 0 }, tableName);

    const keysContainer = el("ul", { className: "configdb-keys" });
    keysContainer.hidden = true;

    let keysLoaded = false;

    const toggleTable = (): void => {
      if (keysContainer.hidden) {
        keysContainer.hidden = false;
        if (!keysLoaded) {
          keysLoaded = true;
          const loading = el("li", {}, "Loading…");
          keysContainer.appendChild(loading);
          fetchNodeConfigDBTable(device, tableName)
            .then((keyData) => {
              keysContainer.textContent = "";
              let keys: string[] = [];
              if (Array.isArray(keyData)) {
                keys = keyData.map(String).sort();
              } else if (keyData !== null && typeof keyData === "object") {
                keys = Object.keys(keyData as Record<string, unknown>).sort();
              }
              if (keys.length === 0) {
                keysContainer.appendChild(el("li", { className: "configdb-key-item" }, "(empty)"));
                return;
              }
              for (const keyName of keys) {
                const keyItem = el("li", { className: "configdb-key-item", tabIndex: 0 }, keyName);

                const entryContainer = el("li", {});
                const entryContent = el("div", { className: "configdb-entry" });
                entryContent.hidden = true;

                let entryLoaded = false;

                const toggleKey = (): void => {
                  if (entryContent.hidden) {
                    entryContent.hidden = false;
                    if (!entryLoaded) {
                      entryLoaded = true;
                      renderLoadingInto(entryContent);
                      fetchNodeConfigDBEntry(device, tableName, keyName)
                        .then((entry) => renderValueInto(entryContent, entry))
                        .catch((err) => renderErrorInto(entryContent, err));
                    }
                  } else {
                    entryContent.hidden = true;
                  }
                };

                keyItem.addEventListener("click", toggleKey);
                keyItem.addEventListener("keydown", (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleKey();
                  }
                });

                keysContainer.appendChild(keyItem);
                entryContainer.appendChild(entryContent);
                keysContainer.appendChild(entryContainer);
              }
            })
            .catch((err) => {
              keysContainer.textContent = "";
              const errItem = el("li", { className: "panel-error" }, String(err));
              keysContainer.appendChild(errItem);
            });
        }
      } else {
        keysContainer.hidden = true;
      }
    };

    tableItem.addEventListener("click", toggleTable);
    tableItem.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleTable();
      }
    });

    tableList.appendChild(tableItem);
    tableList.appendChild(el("li", {}, keysContainer));
  }

  container.appendChild(tableList);
}

// Phase 3: Lifecycle section in the device inspector. Substrate-agnostic
// state + substrate-aware actions:
//   - Lab VM running   → Stop button + SSH/console snippets
//   - Lab VM stopped   → Start button
//   - Lab VM booting   → state pill only (transition in progress)
//   - Not realized     → guidance text pointing at "Deploy as lab"
//   - Reachable via probe (not lab) → state pill only (start/stop n/a)
//
// Phase 4 may move this into a standalone module if the lifecycle surface
// grows further (console viewer, log tail, etc.).
async function renderLifecycleSection(host: HTMLElement, device: string, viewMode?: TopologyViewMode): Promise<void> {
  host.textContent = "";
  // Section label reflects the substrate the drawer is showing — same
  // operator-intent framing as the topology view chips. Default
  // ("Lifecycle") covers the cases where the drawer is opened outside
  // a view-mode context.
  const sectionLabel = viewMode === "spec-physical" ? "Physical state"
    : viewMode === "spec-lab" ? "Lab VM"
    : viewMode === "spec" ? "Spec"
    : "Lifecycle";
  host.appendChild(el("p", { className: "lifecycle-header" }, sectionLabel));
  const body = el("div", { className: "lifecycle-body" });
  body.appendChild(el("p", { className: "lifecycle-loading" }, "Checking substrate…"));
  host.appendChild(body);

  const network = activeNetwork();
  let labState: LabState | null = null;
  // Physical view inspects the physical substrate only — don't even
  // fetch lab state, so a coincidentally-running lab VM with the same
  // name can't bleed VM details into the drawer. Same principle for
  // Spec view (intent only, no actuation).
  if (viewMode !== "spec-physical" && viewMode !== "spec") {
    try { labState = await fetchLabStatus(network); } catch { /* lab unknown */ }
  }
  let online: boolean | undefined;
  try { await fetchNodeInfo(device); online = true; } catch { online = false; }

  const status = resolveDeviceStatus(device, labState, online);
  const labNode = labState?.nodes?.[device];

  body.textContent = "";

  // Spec view: intent only. Show a single hint that the device is
  // declared but no actuation overlay is being requested here.
  if (viewMode === "spec") {
    body.appendChild(el("p", { className: "lifecycle-hint" },
      `${device} is declared in this network's topology spec. Switch to Lab or Physical to inspect actuation state.`));
    return;
  }

  // Physical view: physical-substrate state only. Skip the lab pill
  // and any VM affordances even when a lab happens to be running.
  if (viewMode === "spec-physical") {
    const pill = el("div", { className: `lifecycle-pill lifecycle-pill--${online ? "running" : "down"}` });
    pill.appendChild(el("span", { className: "lifecycle-pill-state" }, online ? "online" : "offline"));
    pill.appendChild(el("span", { className: "lifecycle-pill-detail" },
      online ? "physical device reachable" : "no response from device"));
    body.appendChild(pill);
    if (!online) {
      body.appendChild(el("p", { className: "lifecycle-hint" },
        `Newtron's /info probe got no response from ${device}. The device may be unreachable, not yet provisioned, or running but firewalled.`));
    }
    return;
  }

  // Lab view (and the default "Lifecycle" fallback path for legacy
  // openNodeDrawer callers) — show the substrate pill, lab VM
  // controls, and SSH/console snippets.
  const pill = el("div", { className: `lifecycle-pill lifecycle-pill--${status.state}` });
  pill.appendChild(el("span", { className: "lifecycle-pill-state" }, status.state));
  pill.appendChild(el("span", { className: "lifecycle-pill-detail" }, status.detail));
  body.appendChild(pill);

  if (status.state === "unrealized") {
    body.appendChild(el("p", { className: "lifecycle-hint" },
      `No substrate is realizing ${device} yet. Switch to the Lab view and click "Deploy" to deploy this network as VMs.`));
    return;
  }

  // Start/Stop — only meaningful for lab-managed VMs.
  if (labNode) {
    const actions = el("div", { className: "lifecycle-actions" });
    if (status.state === "running" || status.state === "booting") {
      const stop = el("button", { type: "button", className: "btn btn-danger btn-sm" }, "Stop VM");
      stop.addEventListener("click", async () => {
        const ok = await confirmInline({
          title: `Stop VM "${device}"?`,
          body: `In lab "${network}". The device will go offline.`,
          danger: true,
          confirmLabel: "Stop",
        });
        if (!ok) return;
        stop.setAttribute("disabled", "");
        stop.textContent = "Stopping…";
        postLabStopNode(network, device)
          .then(() => renderLifecycleSection(host, device, viewMode))
          .catch((err) => {
            stop.removeAttribute("disabled");
            stop.textContent = "Stop VM";
            showToast({ kind: "error", title: "Stop failed", body: err instanceof Error ? err.message : String(err) });
          });
      });
      actions.appendChild(stop);
    }
    if (status.state === "down") {
      const start = el("button", { type: "button", className: "btn btn-primary btn-sm" }, "Start VM");
      start.addEventListener("click", () => {
        start.setAttribute("disabled", "");
        start.textContent = "Starting…";
        postLabStartNode(network, device)
          .then(() => renderLifecycleSection(host, device, viewMode))
          .catch((err) => {
            start.removeAttribute("disabled");
            start.textContent = "Start VM";
            showToast({ kind: "error", title: "Start failed", body: err instanceof Error ? err.message : String(err) });
          });
      });
      actions.appendChild(start);
    }
    body.appendChild(actions);

    // SSH/console snippets — only when the VM is up and ports are known.
    if (status.state === "running" && labNode.ssh_port) {
      const sshUser = labNode.ssh_user || "admin";
      const sshCmd = `ssh -p ${labNode.ssh_port} ${sshUser}@localhost`;
      body.appendChild(buildCopyRow("SSH", sshCmd));
    }
    if (labNode.console_port) {
      const consoleCmd = `telnet localhost ${labNode.console_port}`;
      body.appendChild(buildCopyRow("Console", consoleCmd));
    }
  }
}

function buildCopyRow(label: string, value: string): HTMLElement {
  const row = el("div", { className: "lifecycle-snippet" });
  row.appendChild(el("span", { className: "lifecycle-snippet-label" }, label));
  const code = el("code", { className: "lifecycle-snippet-value" }, value);
  row.appendChild(code);
  const copyBtn = el("button", {
    type: "button",
    className: "btn btn-ghost btn-sm lifecycle-snippet-copy",
    title: `Copy ${label.toLowerCase()} command`,
  }, "Copy");
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(value).then(() => {
      const orig = copyBtn.textContent;
      copyBtn.textContent = "Copied";
      window.setTimeout(() => { copyBtn.textContent = orig; }, 1200);
    });
  });
  row.appendChild(copyBtn);
  return row;
}

// openLinkDrawer opens the detail drawer for a topology link, rendering
// both endpoints' configuration side-by-side. Reuses the existing
// detail drawer; opening overwrites whatever the drawer was showing.
//
// The render is layered:
//
//   1. STATIC config from the topology data (always available, no
//      fetch): port admin_status, mtu, the link itself. This is
//      what's in topology.json — visible even when the device is
//      offline / lab not deployed.
//   2. LIVE data fetched per-endpoint (oper_status, real-time
//      bindings, runtime VLAN membership). Adds runtime context when
//      the device is reachable; renders as a pedagogical "device
//      offline" line when not.
//
// Each endpoint renders independently so one device being unreachable
// doesn't hide the other side.
function openLinkDrawer(
  link: TopoLink,
  rawDevices: Record<string, { ports?: Record<string, unknown> }>,
): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  const a = { device: link.local_device ?? "?", iface: link.local_interface ?? "?" };
  const z = { device: link.remote_device ?? "?", iface: link.remote_interface ?? "?" };

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";
  content.appendChild(el("p", { className: "drawer-kind" }, "Link"));
  content.appendChild(el(
    "h2",
    { className: "drawer-name" },
    `${a.device}:${a.iface} ↔ ${z.device}:${z.iface}`,
  ));

  const grid = el("div", { className: "link-drawer-grid" });
  content.appendChild(grid);

  for (const endpoint of [a, z]) {
    const col = el("section", { className: "link-drawer-endpoint" });
    col.appendChild(el("h3", { className: "link-drawer-endpoint-heading" }, `${endpoint.device}:${endpoint.iface}`));
    const body = el("div", { className: "link-drawer-endpoint-body" });
    col.appendChild(body);
    grid.appendChild(col);

    // Static port config — render immediately from the topology data
    // the operator already has on screen. No fetch dependency.
    const staticPort = extractStaticPortConfig(rawDevices, endpoint.device, endpoint.iface);
    body.appendChild(el("p", { className: "drawer-kind" }, "Port config (from topology)"));
    if (staticPort) {
      body.appendChild(renderValue(staticPort));
    } else {
      body.appendChild(el("p", { className: "panel-note" },
        "No port entry for " + endpoint.iface + " in this network's topology."));
    }

    // Live data — optional enhancement; failures render as the
    // "device offline" pedagogical line rather than a system error.
    const livePlaceholder = el("p", { className: "status-loading" }, "Loading live state…");
    body.appendChild(el("p", { className: "drawer-kind" }, "Live state"));
    body.appendChild(livePlaceholder);

    void Promise.allSettled([
      fetchNodeInterface(endpoint.device, endpoint.iface),
      fetchNodeInterfaceBinding(endpoint.device, endpoint.iface),
    ]).then(([detailResult, bindingResult]) => {
      livePlaceholder.remove();
      if (detailResult.status === "fulfilled") {
        body.appendChild(el("p", { className: "drawer-subkind" }, "Interface"));
        body.appendChild(renderValue(detailResult.value));
      } else {
        body.appendChild(renderLiveDataError(detailResult.reason, "interface", endpoint.device));
      }
      if (bindingResult.status === "fulfilled") {
        body.appendChild(el("p", { className: "drawer-subkind" }, "Service binding"));
        body.appendChild(renderValue(bindingResult.value));
      } else if (!(bindingResult.reason instanceof ApiError && bindingResult.reason.kind === "newtron_unavailable")) {
        // Skip the binding's offline note when the interface fetch
        // already showed the same message — avoids duplicate
        // "switch1 is not reachable" lines. Non-offline errors still
        // surface (the operator should see them).
        body.appendChild(renderLiveDataError(bindingResult.reason, "service binding", endpoint.device));
      }
    });
  }
}

// extractStaticPortConfig pulls a port's static config from the
// topology data (rawDevices), without fetching anything. Returns null
// when the port isn't in the topology (e.g. the link references a
// port that hasn't been declared in topology.json).
function extractStaticPortConfig(
  rawDevices: Record<string, { ports?: Record<string, unknown> }>,
  device: string,
  iface: string,
): unknown {
  const dev = rawDevices[device];
  if (!dev || !dev.ports) return null;
  const port = dev.ports[iface];
  if (port === undefined) return null;
  return port;
}

// renderLiveDataError translates a failed per-device live fetch into
// operator-friendly text. The common case in newtcon today is that a
// network's devices aren't deployed (the lab is down, the device's
// CONFIG_DB / SSH transport is unreachable) — surfacing the raw
// "newtron_unavailable" envelope reads as a system failure when
// actually it's the expected condition. For other error kinds (genuine
// problems worth seeing) fall back to formatErrorBrief.
function renderLiveDataError(
  err: unknown,
  what: "interface" | "service binding",
  device: string,
): HTMLElement {
  if (err instanceof ApiError && err.kind === "newtron_unavailable") {
    return el("p", { className: "panel-note" },
      `${device} is not reachable. Live ${what} state will appear here once the device is up.`);
  }
  return el("p", { className: "panel-error" }, formatErrorBrief(err));
}

// openNodeDrawer opens the detail drawer for a device and renders
// node-inspector sub-tabs. Each sub-tab fetches its data lazily on
// first activation.
//
// viewMode (optional) — the topology view-mode the drawer was opened
// from. Threads through to renderLifecycleSection so the substrate
// section matches the operator's view intent: Lab view shows VM
// state + SSH/console; Physical view shows only physical-substrate
// state (no lab VM bleed-through); Spec view shows a "no actuation"
// hint. Defaults to "Lifecycle" (legacy behavior) when omitted.
function openNodeDrawer(device: string, viewMode?: TopologyViewMode): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

  // ── Header ──────────────────────────────────────────────────────
  // Three rows: name + status badges · subtitle · quick-action row.
  // All three fill in async — name + viewMode are sync; identity
  // chips wait on /info; drift badge waits on /drift; action buttons
  // wait on labState. The skeleton renders immediately so the drawer
  // doesn't look blank during the round-trips.
  const header = el("header", { className: "node-drawer-header" });
  const titleRow = el("div", { className: "node-drawer-title-row" });
  const titleName = el("h2", { className: "node-drawer-name" }, device);
  titleRow.appendChild(titleName);
  const badges = el("div", { className: "node-drawer-badges" });
  titleRow.appendChild(badges);
  header.appendChild(titleRow);

  const subtitle = el("p", { className: "node-drawer-subtitle" }, "");
  header.appendChild(subtitle);

  // At-a-glance stats (interface counts + drift) — folds the old Summary tab
  // into the always-visible header so triage facts travel across every tab.
  const stats = el("div", { className: "node-drawer-stats" });
  header.appendChild(stats);

  const actions = el("div", { className: "node-drawer-actions" });
  header.appendChild(actions);

  content.appendChild(header);

  // Async-populate header chips + badges + stats + actions. Per-source
  // failures degrade silently — operator still gets the rest of the
  // header rendered.
  void renderDrawerHeader(badges, subtitle, stats, actions, device, viewMode);

  // Lifecycle section (existing) — view-mode-aware substrate state +
  // Start/Stop/SSH/console. Stays for now; the Summary tab also
  // surfaces the substrate state from its own pull, so this section
  // is a touch redundant in observation views — kept here as the
  // canonical "lifecycle controls live here" surface until per-domain
  // renderers absorb its action buttons.
  const lifecycleSection = el("section", { className: "lifecycle-section" });
  content.appendChild(lifecycleSection);
  void renderLifecycleSection(lifecycleSection, device, viewMode);

  // ── Tab strip + panels ─────────────────────────────────────────
  const tabStrip = el("nav", { className: "node-tabs", role: "tablist", ariaLabel: "Device information" });
  const panelsContainer = el("div", {});

  const panels = new Map<NodeTabId, HTMLElement>();
  const tabButtons = new Map<NodeTabId, HTMLButtonElement>();
  const fetched = new Set<NodeTabId>();

  const activateTab = (id: NodeTabId): void => {
    for (const [tid, btn] of tabButtons) {
      btn.classList.toggle("node-tab--active", tid === id);
      btn.setAttribute("aria-selected", tid === id ? "true" : "false");
    }
    for (const [tid, panel] of panels) {
      panel.hidden = tid !== id;
    }
    if (!fetched.has(id)) {
      fetched.add(id);
      loadNodeTab(id, panels.get(id)!, device);
    }
  };

  for (const tab of NODE_TABS) {
    const btn = el("button", {
      className: "node-tab",
      type: "button",
      tabIndex: 0,
    }, tab.label);
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.setAttribute("aria-controls", `node-panel-${tab.id}`);
    btn.addEventListener("click", () => activateTab(tab.id));
    tabStrip.appendChild(btn);
    tabButtons.set(tab.id, btn);

    const panel = el("div", {
      className: "node-tab-panel" + (tab.id === "spec" ? " node-tab-panel--spec" : ""),
    });
    panel.setAttribute("id", `node-panel-${tab.id}`);
    panel.setAttribute("role", "tabpanel");
    panel.hidden = true;
    panels.set(tab.id, panel);
    panelsContainer.appendChild(panel);
  }

  content.appendChild(tabStrip);
  content.appendChild(panelsContainer);

  // Raw (debugging) disclosure — Config DB / Projection / Intent
  // Tree tucked away below the primary panels. Most operators never
  // open it; the ones who need it know where to look.
  renderRawSection(content, device);

  // Pick the default tab based on the view-mode the drawer was
  // opened from: Spec view → Spec; Lab/Physical → Summary (the
  // operator's at-a-glance triage view). Legacy callers without a
  // view-mode also default to Summary.
  const defaultTab: NodeTabId = viewMode === "spec" ? "spec" : "interfaces";
  activateTab(defaultTab);
}

// renderDrawerHeader — populates the badges + subtitle + actions row
// asynchronously from /info + /drift + lab state. Each source
// failure degrades silently; the header always renders the name +
// device label even if every fetch fails.
async function renderDrawerHeader(
  badges: HTMLElement,
  subtitle: HTMLElement,
  stats: HTMLElement,
  actions: HTMLElement,
  device: string,
  viewMode: TopologyViewMode | undefined,
): Promise<void> {
  // /info — full identity line in the subtitle (folds the old Summary identity
  // card: platform · zone · ASN · mgmt · loopback · router-id · vtep) + the
  // substrate badge. One fetch, used for both.
  void fetchNodeInfo(device).then((data) => {
    const d = (data ?? {}) as Record<string, unknown>;
    const fact = (label: string, key: string): string => {
      const v = d[key];
      return typeof v === "string" && v !== "" || typeof v === "number" ? `${label} ${String(v)}` : "";
    };
    subtitle.textContent = [
      typeof d.platform === "string" ? d.platform : "",
      fact("zone", "zone"),
      fact("AS", "bgp_as"),
      fact("mgmt", "mgmt_ip"),
      fact("lo", "loopback_ip"),
      fact("rtr-id", "router_id"),
      fact("vtep", "vtep_source_ip"),
    ].filter(Boolean).join(" · ");
    // Substrate badge stays view-mode-aware (physical only; lab/spec defer to
    // the lifecycle section, preserving the intent-only stance of spec view).
    if (viewMode === "spec-physical") {
      badges.appendChild(el("span", { className: "node-drawer-badge node-drawer-badge--running" }, "● online"));
    }
  }).catch(() => {
    // /info is a live probe — unavailable when the device is unreachable or not
    // yet deployed. Fall back to the NodeSpec so the identity line still shows the
    // declared facts (platform · zone · AS · mgmt · loopback) rather than going
    // blank. router-id / vtep are live-only and omitted here.
    void fetchSpecDetail("nodes", device).then((spec) => {
      if (subtitle.textContent !== "") return; // /info already populated it
      const s = (spec ?? {}) as Record<string, unknown>;
      const fact = (label: string, key: string): string => {
        const v = s[key];
        return (typeof v === "string" && v !== "") || typeof v === "number" ? `${label} ${String(v)}` : "";
      };
      subtitle.textContent = [
        typeof s.platform === "string" ? s.platform : "",
        fact("zone", "zone"),
        fact("AS", "underlay_asn"),
        fact("mgmt", "mgmt_ip"),
        fact("lo", "loopback_ip"),
      ].filter(Boolean).join(" · ");
    }).catch(() => { /* spec also unavailable — leave the subtitle empty */ });
    if (viewMode === "spec-physical") {
      badges.appendChild(el("span", { className: "node-drawer-badge node-drawer-badge--down" }, "● offline"));
    }
  });

  // /interfaces — interface counts in the stats row (folds the Summary
  // interfaces card).
  void fetchNodeInterfaces(device).then((data) => {
    const list = Array.isArray(data) ? data : [];
    let up = 0, down = 0;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const oper = String((item as Record<string, unknown>).oper_state ?? (item as Record<string, unknown>).oper_status ?? "").toLowerCase();
      if (oper === "up") up++; else if (oper === "down") down++;
    }
    stats.appendChild(el("span", { className: "node-drawer-stat" }, `${list.length} interfaces`));
    if (up > 0) stats.appendChild(el("span", { className: "node-drawer-stat node-drawer-stat--up" }, `${up} up`));
    if (down > 0) stats.appendChild(el("span", { className: "node-drawer-stat node-drawer-stat--down" }, `${down} down`));
  }).catch(() => { /* counts unavailable */ });

  // /drift — once: drives the badge, the stat chip, and the Review-drift action
  // (folds the Summary drift card).
  void fetchNodeDrift(device).then((data) => {
    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) {
      stats.appendChild(el("span", { className: "node-drawer-stat node-drawer-stat--clean" }, "no drift"));
      return;
    }
    const label = `${items.length} drift item${items.length === 1 ? "" : "s"}`;
    badges.appendChild(el("span", { className: "node-drawer-badge node-drawer-badge--drift" }, `⚠ ${label}`));
    stats.appendChild(el("span", { className: "node-drawer-stat node-drawer-stat--drift" }, label));
    const reconcileBtn = el("button", { type: "button", className: "node-drawer-action-btn node-drawer-action-btn--primary" }, "Review drift");
    reconcileBtn.addEventListener("click", () => {
      (document.querySelector('.node-tab[aria-controls="node-panel-drift"]') as HTMLButtonElement | null)?.click();
    });
    actions.appendChild(reconcileBtn);
  }).catch(() => { /* drift unavailable */ });
}

// loadNodeTab fetches data for one node-inspector tab and renders it.
// Each tab is operator-priority-ordered (Summary first; History last)
// and uses a per-domain renderer rather than the generic recursive
// tree.
function loadNodeTab(id: NodeTabId, container: HTMLElement, device: string): void {
  renderLoadingInto(container);

  switch (id) {
    case "interfaces":
      // Inventory-first; the live read is best-effort inside the builder, so an
      // un-deployed/unreachable node still shows its full port inventory.
      renderInterfaceTab(container, device);
      break;

    case "state":
      void renderStateTab(container, device);
      break;

    case "spec": {
      // A device's declared intent lives in TWO places in the network spec:
      //   - the device profile — static identity (mgmt_ip, loopback_ip, zone,
      //     platform, service bindings). Unified-substrate convention (PR #148)
      //     names the profile after the device → fetchSpecDetail("nodes", …).
      //   - the topology.json device entry — provisioning steps + per-port
      //     config, i.e. the intents provisioning actually replays.
      // The Spec tab shows both so "declared intent" is complete.
      container.textContent = "";
      container.appendChild(el("p", { className: "node-spec-intro" },
        "Declared intent for this device — node + topology.json. To inspect actuated reality, switch tabs."));

      const profSection = el("div", { className: "node-spec-section" });
      profSection.appendChild(el("h4", { className: "node-spec-section-title" }, "Node"));
      const profBody = el("div", { className: "node-spec-body" });
      profBody.appendChild(el("p", { className: "spec-detail-empty-state" }, "Loading…"));
      profSection.appendChild(profBody);
      container.appendChild(profSection);

      const topoSection = el("div", { className: "node-spec-section" });
      topoSection.appendChild(el("h4", { className: "node-spec-section-title" }, "Topology intent"));
      const topoBody = el("div", { className: "node-spec-body" });
      topoBody.appendChild(el("p", { className: "spec-detail-empty-state" }, "Loading…"));
      topoSection.appendChild(topoBody);
      container.appendChild(topoSection);

      void fetchSpecDetail("nodes", device)
        .then(async (data) => {
          const schemaKindForDetail = await resolveSlugToKind("nodes").catch(() => null);
          const schemaForDetail = schemaKindForDetail
            ? await fetchSchema(schemaKindForDetail).catch(() => null)
            : null;
          profBody.textContent = "";
          if (schemaForDetail) {
            renderSpecDetailInto(profBody, schemaForDetail.fields.map(toSpecField), data, ["name"]);
          } else {
            const fields = displaySchemaFor("nodes");
            if (fields) renderSpecDetailInto(profBody, fields, data, ["name"]);
            else renderValueInto(profBody, data);
          }
        })
        .catch((err) => {
          profBody.textContent = "";
          if (err instanceof ApiError && err.status === 404) renderProfileNotFound(profBody, device);
          else renderErrorInto(profBody, err);
        });

      void fetchTopology()
        .then((topo) => {
          const devices = (topo as { nodes?: Record<string, unknown> } | null)?.nodes ?? {};
          renderTopologyIntentInto(topoBody, devices[device] ?? null);
        })
        .catch((err) => { topoBody.textContent = ""; renderErrorInto(topoBody, err); });
      break;
    }

    case "drift":
      fetchNodeDrift(device)
        .then((data) => renderDriftTab(container, data, device))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "history":
      void renderHistoryTab(container, device);
      break;

    default: {
      const _never: never = id;
      container.textContent = "";
      container.appendChild(el("p", { className: "topology-empty" }, `Unknown tab: ${_never}`));
    }
  }
}


// renderStateTab — collapses the 7 prior reality tabs into one tab
// with disclosable sub-sections. Each sub-section fetches lazily on
// first expansion. A device with no VRFs / ACLs / etc. shows "—"
// inline so the operator doesn't have to expand to discover absence.
async function renderStateTab(container: HTMLElement, device: string): Promise<void> {
  container.textContent = "";
  container.appendChild(el("p", { className: "node-state-intro" },
    "Provisioned resources on this device + observed runtime state. Sub-sections fetch on expand."));

  // Resource lens (the inverse of the interface table): provisioned services on
  // this device, grouped by service → the interfaces they're applied to.
  container.appendChild(renderServicesDisclosure(device));

  for (const sub of STATE_SUBSECTIONS) {
    const details = el("details", { className: "node-state-section" }) as HTMLDetailsElement;
    const summary = el("summary", { className: "node-state-section-summary" });
    const title = el("span", { className: "node-state-section-title" }, sub.label);
    summary.appendChild(title);
    const badge = el("span", { className: "node-state-section-badge" }, "");
    summary.appendChild(badge);
    details.appendChild(summary);

    const body = el("div", { className: "node-state-section-body" });
    body.appendChild(el("p", { className: "node-summary-loading" }, "Loading…"));
    details.appendChild(body);

    let loaded = false;
    details.addEventListener("toggle", () => {
      if (loaded || !details.open) return;
      loaded = true;
      void fetchStateSubsection(sub.id, device).then((data) => {
        body.textContent = "";
        const count = countItems(data);
        badge.textContent = count === 0 ? "—" : `${count}`;
        if (count === 0) {
          body.appendChild(el("p", { className: "node-summary-stat-clean" }, "(none)"));
          return;
        }
        renderStateSubsection(sub.id, body, data);
      }).catch((err) => renderErrorInto(body, err));
    });

    container.appendChild(details);
  }
}

// renderServicesDisclosure builds the resource-lens "Services" disclosure:
// services provisioned on this device → the interfaces they're applied to
// (derived from the topology's apply-service steps; the inverse of the
// per-interface service column in the Interfaces table).
function renderServicesDisclosure(device: string): HTMLElement {
  const details = el("details", { className: "node-state-section node-state-section--services" }) as HTMLDetailsElement;
  details.open = true;
  const summary = el("summary", { className: "node-state-section-summary" });
  summary.appendChild(el("span", { className: "node-state-section-title" }, "Services"));
  const badge = el("span", { className: "node-state-section-badge" }, "");
  summary.appendChild(badge);
  details.appendChild(summary);
  const body = el("div", { className: "node-state-section-body" });
  body.appendChild(el("p", { className: "node-summary-loading" }, "Loading…"));
  details.appendChild(body);

  void fetchTopology()
    .then((topo) => {
      const entry = ((topo as { nodes?: Record<string, unknown> } | null)?.nodes ?? {})[device] ?? null;
      const usage = deviceServiceUsage(entry);
      const n = countServiceInstances(usage);
      badge.textContent = n === 0 ? "—" : `${n}`;
      renderServiceLensInto(body, usage);
    })
    .catch((err) => renderErrorInto(body, err));
  return details;
}

// renderServiceLensInto renders each provisioned service as a card listing the
// interfaces it's applied to (+ per-interface vlan / ip / peer-AS).
function renderServiceLensInto(body: HTMLElement, usage: ServiceUsage[]): void {
  body.textContent = "";
  if (usage.length === 0) {
    body.appendChild(el("p", { className: "node-summary-stat-clean" },
      "No services applied to this device's interfaces yet — apply one from the Interfaces tab."));
    return;
  }
  for (const u of usage) {
    const card = el("div", { className: "svc-lens-card" });
    const head = el("div", { className: "svc-lens-head" });
    head.appendChild(el("span", { className: "iface-svc-chip" }, u.service));
    head.appendChild(el("span", { className: "svc-lens-count" },
      `${u.instances.length} interface${u.instances.length === 1 ? "" : "s"}`));
    card.appendChild(head);
    const table = el("table", { className: "svc-lens-table" });
    const hr = el("tr");
    for (const h of ["Interface", "VLAN", "IP", "Peer AS"]) hr.appendChild(el("th", {}, h));
    table.appendChild(hr);
    for (const inst of u.instances) {
      const tr = el("tr");
      tr.appendChild(el("td", { className: "iface-name" }, inst.iface));
      tr.appendChild(el("td", {}, inst.vlan ?? "—"));
      tr.appendChild(el("td", { className: "iface-cell-mono" }, inst.ip ?? "—"));
      tr.appendChild(el("td", {}, inst.peerAs ?? "—"));
      table.appendChild(tr);
    }
    card.appendChild(table);
    body.appendChild(card);
  }
}

function fetchStateSubsection(id: typeof STATE_SUBSECTIONS[number]["id"], device: string): Promise<unknown> {
  switch (id) {
    case "vlans":     return fetchNodeVLANs(device);
    case "vrfs":      return fetchNodeVRFs(device);
    case "acls":      return fetchNodeACLs(device);
    case "bgp":       return fetchNodeBGPStatus(device);
    case "evpn":      return fetchNodeEVPNStatus(device);
    case "lags":      return fetchNodeLAGs(device);
    case "neighbors": return fetchNodeNeighbors(device);
  }
}

// Best-effort item count for a state sub-section's response. Arrays
// use length directly; objects use key count; primitives count as 0.
// Used for the badge next to each disclosure title.
function countItems(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") return Object.keys(data).length;
  return 0;
}

// renderStateSubsection — dispatches to a per-domain renderer for the
// State tab's sub-sections. Each renderer knows the shape of its own
// endpoint and emits a tabular or labeled view; falls back to a
// generic auto-table for shapes we haven't specifically handled.
function renderStateSubsection(
  id: typeof STATE_SUBSECTIONS[number]["id"],
  body: HTMLElement,
  data: unknown,
): void {
  switch (id) {
    case "bgp":       renderBGPStatus(body, data); break;
    case "evpn":      renderEVPNStatus(body, data); break;
    case "vrfs":      renderResourceTable(body, data, VRF_COLUMNS); break;
    case "vlans":     renderResourceTable(body, data, VLAN_COLUMNS); break;
    case "acls":      renderResourceTable(body, data, ACL_COLUMNS); break;
    case "lags":      renderResourceTable(body, data, LAG_COLUMNS); break;
    // /neighbors returns device health-checks (check/status/message); render
    // those as a status table, falling back to the auto-table for any other
    // shape (e.g. real LLDP neighbor records).
    case "neighbors":
      if (isHealthCheckList(data)) renderResourceTable(body, data, HEALTH_COLUMNS);
      else renderAutoTable(body, data);
      break;
  }
}

// renderResourceTable renders a State resource as a curated, scannable table —
// replacing the generic auto-table's raw key dump. Columns flagged `status`
// render as colored pills (up/ok → ok, warn → warn, else down).
function renderResourceTable(body: HTMLElement, data: unknown, columns: ResourceColumn[]): void {
  body.textContent = "";
  const { headers, rows } = shapeResourceRows(data, columns);
  if (rows.length === 0) {
    body.appendChild(el("p", { className: "node-summary-stat-clean" }, "(none)"));
    return;
  }
  const table = el("table", { className: "resource-table" });
  const hr = el("tr");
  for (const h of headers) hr.appendChild(el("th", {}, h));
  table.appendChild(hr);
  for (const row of rows) {
    const tr = el("tr");
    row.forEach((cell, j) => {
      if (columns[j]?.status && cell !== "—") {
        tr.appendChild(el("td", {}, el("span", { className: `resource-pill resource-pill--${statusTone(cell)}` }, cell)));
      } else {
        tr.appendChild(el("td", {}, cell));
      }
    });
    table.appendChild(tr);
  }
  body.appendChild(table);
}

// statusTone maps a status string to a pill tone.
function statusTone(value: string): "ok" | "warn" | "down" {
  const s = value.toLowerCase();
  if (/\b(up|ok|ready|enabled|healthy|active|established|pass)\b/.test(s)) return "ok";
  if (/\b(warn|warning|degraded|pending|partial)\b/.test(s)) return "warn";
  return "down";
}

// renderBGPStatus — BGP /status returns
//   { local_as, router_id, loopback_ip, neighbors: [{address, vrf, type, remote_as, admin_status}], evpn_peers: [string] }
// Rendered as: top-level facts as labeled rows + neighbors table +
// EVPN peer chips. Falls back to generic tree for unfamiliar shapes.
function renderBGPStatus(body: HTMLElement, data: unknown): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    renderValueInto(body, data);
    return;
  }
  const d = data as Record<string, unknown>;
  const facts: Array<[string, unknown]> = [
    ["Local ASN", d.local_as],
    ["Router ID", d.router_id],
    ["Loopback IP", d.loopback_ip],
  ];
  const factDl = el("dl", { className: "node-summary-dl" });
  for (const [label, value] of facts) {
    if (value === undefined || value === null || value === "") continue;
    factDl.appendChild(el("dt", { className: "node-summary-dt" }, label));
    factDl.appendChild(el("dd", { className: "node-summary-dd" }, String(value)));
  }
  body.appendChild(factDl);

  const neighbors = Array.isArray(d.neighbors) ? d.neighbors : [];
  if (neighbors.length > 0) {
    body.appendChild(el("p", { className: "node-subsection-label" }, "Neighbors"));
    renderResourceTable(body, neighbors, BGP_NEIGHBOR_COLUMNS);
  }
  const evpnPeers = Array.isArray(d.evpn_peers) ? d.evpn_peers : [];
  if (evpnPeers.length > 0) {
    body.appendChild(el("p", { className: "node-subsection-label" }, "EVPN peers"));
    const chips = el("p", { className: "node-chip-row" });
    for (const p of evpnPeers) {
      chips.appendChild(el("span", { className: "node-chip" }, String(p)));
    }
    body.appendChild(chips);
  }
}

// renderEVPNStatus — EVPN /status returns
//   { vteps: {name: ip}, nvos: {name: vtep}, vni_count: number }
// Small structured object; render as labeled groups.
function renderEVPNStatus(body: HTMLElement, data: unknown): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    renderValueInto(body, data);
    return;
  }
  const d = data as Record<string, unknown>;
  const vteps = (d.vteps && typeof d.vteps === "object") ? d.vteps as Record<string, unknown> : {};
  const nvos  = (d.nvos  && typeof d.nvos  === "object") ? d.nvos  as Record<string, unknown> : {};
  const vniCount = typeof d.vni_count === "number" ? d.vni_count : null;

  if (vniCount !== null) {
    const row = el("p", { className: "node-summary-stat-row" });
    row.appendChild(el("span", { className: "node-summary-stat-total" }, String(vniCount)));
    row.appendChild(el("span", { className: "node-summary-stat-label" }, `VNI${vniCount === 1 ? "" : "s"}`));
    body.appendChild(row);
  }
  if (Object.keys(vteps).length > 0) {
    body.appendChild(el("p", { className: "node-subsection-label" }, "VTEPs"));
    const dl = el("dl", { className: "node-summary-dl" });
    for (const [k, v] of Object.entries(vteps)) {
      dl.appendChild(el("dt", { className: "node-summary-dt" }, k));
      dl.appendChild(el("dd", { className: "node-summary-dd" }, String(v)));
    }
    body.appendChild(dl);
  }
  if (Object.keys(nvos).length > 0) {
    body.appendChild(el("p", { className: "node-subsection-label" }, "NVOs"));
    const dl = el("dl", { className: "node-summary-dl" });
    for (const [k, v] of Object.entries(nvos)) {
      dl.appendChild(el("dt", { className: "node-summary-dt" }, k));
      dl.appendChild(el("dd", { className: "node-summary-dd" }, String(v)));
    }
    body.appendChild(dl);
  }
}

// renderAutoTable — generic renderer for "array of homogeneous objects":
// derives columns from the union of keys, renders as <table>. Falls
// back to renderValueInto for shapes that aren't tabular (single
// object, mixed-shape array, primitives).
function renderAutoTable(body: HTMLElement, data: unknown): void {
  if (!Array.isArray(data) || data.length === 0) {
    renderValueInto(body, data);
    return;
  }
  // All items must be plain objects for table mode; one non-object
  // and we fall back to the tree renderer (safer than rendering a
  // wonky table with blank cells).
  const allObjects = data.every((x) => x && typeof x === "object" && !Array.isArray(x));
  if (!allObjects) {
    renderValueInto(body, data);
    return;
  }
  const rows = data as Array<Record<string, unknown>>;
  // Column order: first-row insertion order, plus any keys other
  // rows add at the end (rare but possible).
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  const table = el("table", { className: "node-state-table" });
  const thead = el("thead", {});
  const trHead = el("tr", {});
  for (const c of cols) {
    trHead.appendChild(el("th", { className: "node-state-th" }, humanizeKey(c)));
  }
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = el("tbody", {});
  for (const row of rows) {
    const tr = el("tr", {});
    for (const c of cols) {
      const v = row[c];
      const cell = el("td", { className: "node-state-td" });
      if (v === undefined || v === null || v === "") {
        cell.appendChild(el("span", { className: "node-state-td--empty" }, "—"));
      } else if (typeof v === "object") {
        // Nested object/array in a cell — collapse to a short JSON
        // marker rather than blow out the column width.
        cell.appendChild(el("code", { className: "node-state-td--nested" },
          Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}`));
      } else {
        cell.appendChild(document.createTextNode(String(v)));
      }
      tr.appendChild(cell);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);
}

// humanizeKey — wire field name → operator label. Snake-case turned
// into Title Case so columns read as words rather than identifiers.
//   "admin_status" → "Admin status"
//   "remote_as"    → "Remote ASN"  (special-case common acronyms)
function humanizeKey(key: string): string {
  const special: Record<string, string> = {
    as:     "ASN",
    asn:    "ASN",
    ip:     "IP",
    vrf:    "VRF",
    vlan:   "VLAN",
    vni:    "VNI",
    bgp:    "BGP",
    evpn:   "EVPN",
    id:     "ID",
    url:    "URL",
    mac:    "MAC",
    sonic:  "SONiC",
  };
  const parts = key.split(/[_\-]/);
  const titled = parts.map((p, i) => {
    const lower = p.toLowerCase();
    if (special[lower]) return special[lower];
    if (i === 0) return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    return p.toLowerCase();
  });
  return titled.join(" ");
}

// renderRawSection — collapsed disclosure rendering the three
// power-user / debugging surfaces (Config DB · Projection · Intent
// Tree). Hidden by default below the primary tab panels.
function renderRawSection(host: HTMLElement, device: string): void {
  const wrap = el("details", { className: "node-raw-wrap" }) as HTMLDetailsElement;
  const sum = el("summary", { className: "node-raw-summary" }, "Raw (debugging)");
  wrap.appendChild(sum);
  const inner = el("div", { className: "node-raw-body" });
  wrap.appendChild(inner);

  for (const sec of RAW_SECTIONS) {
    const d = el("details", { className: "node-raw-section" }) as HTMLDetailsElement;
    d.appendChild(el("summary", { className: "node-raw-section-summary" }, sec.label));
    const body = el("div", { className: "node-raw-section-body" });
    body.appendChild(el("p", { className: "node-summary-loading" }, "Loading…"));
    d.appendChild(body);
    let loaded = false;
    d.addEventListener("toggle", () => {
      if (loaded || !d.open) return;
      loaded = true;
      const fetcher: Promise<unknown> =
        sec.id === "configdb" ? fetchNodeConfigDB(device).then((data) => {
          body.textContent = "";
          renderConfigDBTab(body, device, data);
          return data;
        }) :
        sec.id === "projection" ? fetchNodeProjection(device).then((data) => {
          body.textContent = "";
          renderValueInto(body, data);
          return data;
        }) :
        fetchNodeIntentTree(device).then((data) => {
          body.textContent = "";
          renderValueInto(body, data);
          return data;
        });
      void fetcher.catch((err) => renderErrorInto(body, err));
    });
    inner.appendChild(d);
  }

  host.appendChild(wrap);
}

// renderHistoryTab — per-device audit timeline. Fetches newtron's
// audit.events filtered to {device} and renders the same row layout
// the global Audit tab uses (consistent operator vocabulary). The
// per-device filter is server-side via the ?device= query param so
// the response size stays bounded even on busy networks.
//
// Empty-state cases are first-class:
//   - 404 from newtron → audit logging disabled on this deployment.
//   - 403 → operator lacks audit.read for this network.
//   - empty events array → no recorded activity for this device yet.
async function renderHistoryTab(container: HTMLElement, device: string): Promise<void> {
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

// ---- Topology write forms ---------------------------------------------------

// showCanvasContextMenu pops a small floating menu at (x, y) with a single
// "Create node" entry. Used by the empty-canvas right-click handler. Reuses
// .topo-menu / .topo-menu-item CSS from the per-device menu so the visual
// language is consistent.
function showCanvasContextMenu(x: number, y: number, onCreated: () => void): void {
  // Remove any prior canvas menu.
  document.querySelectorAll(".topo-menu--canvas").forEach((m) => m.remove());

  const menu = el("div", { className: "topo-menu topo-menu--canvas", role: "menu" });
  const item = el("button", { type: "button", className: "topo-menu-item" });
  const icon = el("span", { className: "topo-menu-item-icon" });
  icon.innerHTML = iconSVG("plus");
  item.appendChild(icon);
  item.appendChild(el("span", { className: "topo-menu-item-label" }, "Create node"));
  item.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.remove();
    openCreateNodeDrawer(onCreated);
  });
  menu.appendChild(item);

  document.body.appendChild(menu);

  // Position with viewport-bound clamp (mirror positionMenu in topology-actions-ui).
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - margin);
  const top = Math.min(y, window.innerHeight - rect.height - margin);
  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;

  // Auto-dismiss on outside click or Escape.
  const dismiss = (): void => {
    menu.remove();
    document.removeEventListener("click", outsideClick, true);
    document.removeEventListener("keydown", onEsc, true);
  };
  const outsideClick = (ev: MouseEvent): void => {
    if (ev.target instanceof Node && menu.contains(ev.target)) return;
    dismiss();
  };
  const onEsc = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") dismiss();
  };
  // Defer so the contextmenu event that opened us doesn't immediately close.
  setTimeout(() => {
    document.addEventListener("click", outsideClick, true);
    document.addEventListener("keydown", onEsc, true);
  }, 0);
}

// openCreateNodeDrawer opens the detail drawer with a form to create a node.
//
// A node is a single operator-domain concept that newtron stores in two
// places: (a) `topology.json` as a topology node entry (steps + ports —
// initially empty) and (b) `nodes/{name}.json` as a NodeSpec
// (mgmt_ip + loopback_ip + zone, plus optional platform/ssh_user). The
// drawer stages BOTH writes so every node always has a spec — newtron
// matches them by name. The staging queue's apply order already runs spec
// creates before topology adds, so the node lands first.
//
// Zone is a required dropdown — newtron's NodeSpec.Zone must reference
// an existing entry in network.json zones; freeform input would let the
// operator queue an invalid profile that fails on Save.
function openCreateNodeDrawer(onSuccess: () => void): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

  content.appendChild(el("p", { className: "drawer-kind" }, "Topology"));
  content.appendChild(el("h2", { className: "drawer-name" }, "Add node"));

  // ── Path 1: add an existing Device Profile to the topology ───────────
  // A profile can exist without a topology entry (authored in Specs, or a
  // prior add that didn't land). Let the operator drop one onto the
  // topology by name — no need to re-author the profile (which would
  // collide). Stages only the topology entry.
  const existing = el("section", { className: "create-node-section" });
  existing.appendChild(el("h3", { className: "create-node-section-title" }, "Add an existing node"));
  existing.appendChild(el("p", { className: "drawer-hint" },
    "Nodes that exist but aren't placed in the topology yet."));
  const existingRow = el("div", { className: "create-node-existing-row" });
  const profileSelect = el("select", { className: "form-control" }) as HTMLSelectElement;
  profileSelect.appendChild(new Option("Loading…", ""));
  profileSelect.disabled = true;
  const addExistingBtn = el("button", { type: "button", className: "form-submit-btn" }, "Add to topology");
  addExistingBtn.disabled = true;
  existingRow.appendChild(profileSelect);
  existingRow.appendChild(addExistingBtn);
  existing.appendChild(existingRow);
  const existingError = el("div", { className: "form-error-out" });
  existing.appendChild(existingError);
  content.appendChild(existing);

  profileSelect.addEventListener("change", () => {
    addExistingBtn.disabled = profileSelect.value === "";
  });
  addExistingBtn.addEventListener("click", () => { void (async () => {
    const name = profileSelect.value;
    if (!name) return;
    existingError.textContent = "";
    addExistingBtn.disabled = true;
    // Scaffold the setup-device step from the existing profile (platform→hwsku,
    // underlay_asn) so the dropped-in node is service-ready like a new one (#283).
    const prof = await fetchSpecDetail("nodes", name).catch(() => null);
    const platform = (prof as { platform?: string } | null)?.platform ?? "";
    const underlayAsn = (prof as { underlay_asn?: number } | null)?.underlay_asn;
    let hwsku = "";
    if (platform) {
      const plat = await fetchSpecDetail("platforms", platform).catch(() => null);
      hwsku = (plat as { hwsku?: string } | null)?.hwsku ?? "";
    }
    const device = buildDeviceScaffold({ hostname: name, type: "LeafRouter", hwsku, ...(underlayAsn !== undefined ? { bgpAsn: underlayAsn } : {}) });
    enqueueTopologyAddDevice(name, device as unknown as Record<string, unknown>);
    existing.appendChild(el("p", { className: "form-success" },
      `Node "${name}" staged (topology entry + setup-device). Click Save in the header to apply.`));
    onSuccess();
    setTimeout(() => { closeDetail(); }, 1000);
  })(); });

  // Populate with profiles that have no topology entry (and aren't already
  // queued for one). Best-effort: failure leaves the picker disabled and
  // the operator can still create a new node below.
  void (async () => {
    try {
      const [profiles, topo] = await Promise.all([fetchSpecList("nodes"), fetchTopology()]);
      const placed = new Set<string>();
      const nodes = adaptTopology(topo).nodes;
      for (const n of Array.isArray(nodes) ? nodes : []) {
        if (typeof n.name === "string") placed.add(n.name);
      }
      for (const a of pendingTopologyDeviceAdds()) placed.add(a.name);
      const unplaced = profiles.filter((p) => !placed.has(p));
      profileSelect.textContent = "";
      if (unplaced.length === 0) {
        profileSelect.appendChild(new Option("(every node is already in the topology)", ""));
        profileSelect.disabled = true;
        addExistingBtn.disabled = true;
      } else {
        profileSelect.appendChild(new Option("Select a node…", ""));
        for (const p of unplaced) profileSelect.appendChild(new Option(p, p));
        profileSelect.disabled = false;
      }
    } catch {
      profileSelect.textContent = "";
      profileSelect.appendChild(new Option("(couldn't load nodes)", ""));
      profileSelect.disabled = true;
    }
  })();

  content.appendChild(el("p", { className: "create-node-divider" }, "or create a new node"));

  content.appendChild(el("p", { className: "drawer-hint" },
    "Stages two writes: a node (identity) and a topology entry (steps + ports). " +
    "Both land on Save. Disconnected nodes are fine — links are added separately."));

  // Build the form first; populate zone/platform dropdowns asynchronously so
  // the drawer opens immediately. If newtron is unreachable, the dropdowns
  // fall back to text inputs so the operator can still type.
  const fields: FieldDef[] = [
    { name: "name",         label: "Node name",         type: "text",   required: true, placeholder: "e.g. spine1" },
    { name: "mgmt_ip",      label: "Management IP",     type: "text",   required: true, placeholder: "e.g. 192.168.1.1" },
    { name: "loopback_ip",  label: "Loopback IP",       type: "text",   required: true, placeholder: "e.g. 10.0.0.1" },
    { name: "zone",         label: "Zone",              type: "select", required: true, options: ["Loading…"] },
    { name: "platform",     label: "Platform",          type: "select",                  options: [""] },
    { name: "role",         label: "Device role",       type: "select", required: true, options: ["LeafRouter", "SpineRouter"],
      help: "SONiC device role; drives the setup-device bring-up step so the node can host services." },
    { name: "underlay_asn", label: "Underlay BGP ASN",  type: "number", required: true, min: 1, max: 4294967295, placeholder: "e.g. 65001",
      help: "BGP ASN for the underlay fabric; required by the device's setup-device/configure-bgp step." },
    { name: "ssh_user",     label: "SSH user (opt)",    type: "text",   placeholder: "e.g. admin" },
  ];
  const { form, getValues, validate } = buildFormFields(fields);
  content.appendChild(form);

  const errorOut = el("div", { className: "form-error-out" });
  content.appendChild(errorOut);

  const submitBtn = el("button", { type: "button", className: "form-submit-btn" }, "Stage node");
  content.appendChild(submitBtn);

  // Populate dropdowns from live network specs.
  void (async () => {
    try {
      const zones = await fetchSpecList("zones");
      const zoneSelect = form.querySelector('select[name="zone"]') as HTMLSelectElement | null;
      if (zoneSelect) {
        zoneSelect.textContent = "";
        if (zones.length === 0) {
          zoneSelect.appendChild(new Option("(no zones defined — add one in Specs first)", ""));
          zoneSelect.disabled = true;
        } else {
          zoneSelect.appendChild(new Option("Select a zone…", ""));
          for (const z of zones) zoneSelect.appendChild(new Option(z, z));
        }
      }
    } catch { /* leave the dropdown showing "Loading…"; submit will surface the error */ }
    try {
      const platforms = await fetchSpecList("platforms");
      const platformSelect = form.querySelector('select[name="platform"]') as HTMLSelectElement | null;
      if (platformSelect) {
        platformSelect.textContent = "";
        platformSelect.appendChild(new Option("(none)", ""));
        for (const p of platforms) platformSelect.appendChild(new Option(p, p));
      }
    } catch { /* same — platform is optional */ }
  })();

  submitBtn.addEventListener("click", () => { void (async () => {
    if (!validate()) return;
    errorOut.textContent = "";
    try {
      const values = getValues();
      const name        = String(values["name"] ?? "").trim();
      const mgmtIP      = String(values["mgmt_ip"] ?? "").trim();
      const loopbackIP  = String(values["loopback_ip"] ?? "").trim();
      const zone        = String(values["zone"] ?? "").trim();
      const platform    = String(values["platform"] ?? "").trim();
      const role        = String(values["role"] ?? "LeafRouter").trim() || "LeafRouter";
      const sshUser     = String(values["ssh_user"] ?? "").trim();
      const asnRaw      = values["underlay_asn"];
      const underlayAsn = typeof asnRaw === "number" ? asnRaw : parseInt(String(asnRaw ?? ""), 10);

      if (!name || !mgmtIP || !loopbackIP || !zone) {
        errorOut.appendChild(el("p", { className: "panel-error" },
          "Node name, management IP, loopback IP, and zone are all required."));
        return;
      }
      if (!Number.isFinite(underlayAsn) || underlayAsn <= 0) {
        errorOut.appendChild(el("p", { className: "panel-error" }, "Underlay BGP ASN is required."));
        return;
      }

      const profileBody: Record<string, unknown> = {
        name,
        mgmt_ip: mgmtIP,
        loopback_ip: loopbackIP,
        zone,
        underlay_asn: underlayAsn,
      };
      if (platform) profileBody["platform"] = platform;
      if (sshUser) profileBody["ssh_user"] = sshUser;

      // hwsku from the chosen platform's inventory → the setup-device step, so
      // the new node is provisionable + service-ready out of the box (#283).
      let hwsku = "";
      if (platform) {
        const plat = await fetchSpecDetail("platforms", platform).catch(() => null);
        hwsku = (plat as { hwsku?: string } | null)?.hwsku ?? "";
      }
      const device = buildDeviceScaffold({ hostname: name, type: role, hwsku, bgpAsn: underlayAsn });

      // Stage profile first (apply order runs spec creates before topology
      // adds, so the profile lands before the topology entry references it
      // by name).
      enqueueSpecCreate("nodes", name, profileBody);
      enqueueTopologyAddDevice(name, device as unknown as Record<string, unknown>);

      submitBtn.disabled = true;
      submitBtn.textContent = "Staged";
      content.insertBefore(
        el("p", { className: "form-success" },
          `Node "${name}" staged (profile + setup-device + topology). Click Save in the header to apply.`),
        submitBtn,
      );
      onSuccess();
      setTimeout(() => {
        drawer.setAttribute("aria-hidden", "true");
        drawer.classList.remove("open");
      }, 1000);
    } catch (err) {
      errorOut.appendChild(el("p", { className: "panel-error" }, String(err)));
    }
  })(); });
}

// openAddLinkDrawer opens the detail drawer with a form to add a link.
// deviceNames populates the endpoint dropdowns.
function openAddLinkDrawer(deviceNames: string[], interfacesByDevice: Map<string, string[]>, onSuccess: () => void): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

  content.appendChild(el("p", { className: "drawer-kind" }, "Topology"));
  content.appendChild(el("h2", { className: "drawer-name" }, "Add link"));

  // Helper to build a "device:interface" endpoint picker row.
  const buildEndpointPicker = (label: string, idPrefix: string): HTMLDivElement => {
    const group = el("div", { className: "form-group" });
    group.appendChild(el("label", { className: "form-label" }, label));

    const devSelect = el("select", { className: "form-control", id: idPrefix + "-device" }) as HTMLSelectElement;
    devSelect.appendChild(el("option", { value: "" }, "— select device —") as HTMLOptionElement);
    for (const d of deviceNames) {
      devSelect.appendChild(el("option", { value: d }, d) as HTMLOptionElement);
    }
    group.appendChild(devSelect);

    const ifaceInput = el("input", {
      className: "form-control",
      id: idPrefix + "-iface",
      type: "text",
      placeholder: "interface name, e.g. Ethernet0",
    }) as HTMLInputElement;

    // Populate with known interfaces when device is selected.
    devSelect.addEventListener("change", () => {
      const ifaces = interfacesByDevice.get(devSelect.value) ?? [];
      if (ifaces.length > 0 && ifaceInput.value === "") {
        ifaceInput.placeholder = ifaces.join(", ");
      }
    });

    group.appendChild(ifaceInput);
    return group;
  };

  const aGroup = buildEndpointPicker("Endpoint A (device + interface)", "link-a");
  const zGroup = buildEndpointPicker("Endpoint Z (device + interface)", "link-z");
  content.appendChild(aGroup);
  content.appendChild(zGroup);

  const errorOut = el("div", { className: "form-error-out" });
  content.appendChild(errorOut);

  const submitBtn = el("button", { type: "button", className: "form-submit-btn" }, "Add link");
  content.appendChild(submitBtn);

  submitBtn.addEventListener("click", async () => {
    errorOut.textContent = "";
    const aDevice = (content.querySelector("#link-a-device") as HTMLSelectElement)?.value ?? "";
    const aIface = (content.querySelector("#link-a-iface") as HTMLInputElement)?.value.trim() ?? "";
    const zDevice = (content.querySelector("#link-z-device") as HTMLSelectElement)?.value ?? "";
    const zIface = (content.querySelector("#link-z-iface") as HTMLInputElement)?.value.trim() ?? "";

    if (!aDevice || !aIface || !zDevice || !zIface) {
      errorOut.appendChild(el("p", { className: "panel-error" }, "Both endpoints (device and interface) are required."));
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Queued";
    try {
      enqueueTopologyAddLink(`${aDevice}:${aIface}`, `${zDevice}:${zIface}`);
      content.insertBefore(el("p", { className: "form-success" }, "Link queued (green). Click Save in the header to apply."), submitBtn);
      onSuccess();
      setTimeout(() => {
        drawer.setAttribute("aria-hidden", "true");
        drawer.classList.remove("open");
      }, 800);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Add link";
      errorOut.appendChild(el("p", { className: "panel-error" }, String(err)));
    }
  });
}

// ---- Deploy-as-lab modal ----------------------------------------------------

// openDeployModal posts the deploy and streams newtlab's SSE phase events into
// an in-place log panel. Phase 1 of unifying lab + physical substrate: this is
// invoked from the Topology toolbar; future phases will fold the resulting
// per-device status back into the SVG diagram so the operator never has to
// switch tabs to see "is it running".
function openDeployModal(network: string): void {
  const overlay = el("div", { className: "network-modal-overlay" });
  const modal = el("div", { className: "network-modal deploy-modal" });

  const title = el("h2", { className: "network-modal-title" }, `Bringing up "${network}" as a lab`);
  const hint = el("p", { className: "network-modal-hint" },
    "newtlab is booting one VM per device in the topology. Streaming progress below — close this window once the deploy completes.");
  const logLines = el("pre", { className: "deploy-modal-log" });

  // Always-enabled Close — the operator can dismiss whenever. Deploy continues
  // at newtlab's pace regardless; phase 2 will surface running status back in
  // the topology view, so losing the log stream isn't operationally fatal.
  const closeBtn = el("button", { type: "button", className: "btn btn-primary btn-sm" }, "Close");

  const actions = el("div", { className: "network-modal-actions" });
  actions.appendChild(closeBtn);

  modal.appendChild(title);
  modal.appendChild(hint);
  modal.appendChild(logLines);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const append = (line: string): void => {
    logLines.textContent += (logLines.textContent ? "\n" : "") + line;
    logLines.scrollTop = logLines.scrollHeight;
  };

  const close = (): void => {
    src?.close();
    overlay.remove();
  };
  closeBtn.addEventListener("click", close);

  let src: EventSource | null = null;

  const start = async (): Promise<void> => {
    try {
      append(`POST deploy lab=${network}…`);
      await postLabDeploy(network, {});
      append("accepted; streaming events…");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      append(`[error] deploy request failed: ${msg}`);
      return;
    }

    src = labEvents(
      network,
      (eventType, data) => {
        try {
          const payload = JSON.parse(data) as Record<string, unknown>;
          if (eventType === "phase") {
            const phase = String(payload["phase"] ?? "");
            const detail = payload["detail"] ? " — " + String(payload["detail"]) : "";
            append(`${phase}${detail}`);
          } else if (eventType === "complete") {
            append("[done] deploy complete — devices are addressable through the topology view");
            src?.close();
          } else if (eventType === "error") {
            append("[error] " + String(payload["message"] ?? data));
            src?.close();
          }
        } catch {
          append(data);
        }
      },
      () => {
        // Stream closed or errored. EventSource will normally try to reconnect
        // on a clean close, so we don't auto-close the modal here — the
        // operator stays in control via the always-enabled Close button.
      },
    );
  };
  void start();
}

// ---- Topology tab -----------------------------------------------------------

// 5s newtlab-status poll while the Topology tab is active. Cheap (one HTTP
// call) and only re-renders the per-device status badges in place — the full
// topology + /info + drift fetch only runs on tab mount.
let topologyPollTimer: number | null = null;

function stopTopologyPoll(): void {
  if (topologyPollTimer !== null) {
    window.clearInterval(topologyPollTimer);
    topologyPollTimer = null;
  }
}

interface PollArgs {
  network: string;
  graphSlot: HTMLElement;
  deviceNames: string[];
  onlineByDevice: Map<string, boolean>;
  /**
   * rebuildPalette — called with the freshly-fetched lab state each
   * tick so the poller doesn't need to know which view mode is active
   * or which actuation source feeds it. The mountTopologyTab caller
   * owns the view mode + drift state and decides per-tick what the
   * palette should be (slice #210.B/C/D).
   */
  rebuildPalette: (labState: LabState | null) => PaletteByDevice;
  /**
   * rebuildStatusText — called with the freshly-fetched lab state each
   * tick. The caller resolves the per-view textual status (lab phase
   * vs. physical online state) and returns the map for the patcher.
   */
  rebuildStatusText: (labState: LabState | null) => StatusTextByDevice;
  /**
   * onLabStateRefresh — lets the mount handler keep its own cached
   * labState ref in sync with what the poll just fetched, so a
   * post-tick view-mode switch resolves the palette against the
   * latest signal rather than the initial snapshot.
   */
  onLabStateRefresh: (lab: LabState | null) => void;
}

function startTopologyPoll(args: PollArgs): void {
  stopTopologyPoll();
  topologyPollTimer = window.setInterval(async () => {
    let labState: LabState | null = null;
    try { labState = await fetchLabStatus(args.network); } catch { /* lab unknown — fall back */ }
    args.onLabStateRefresh(labState);
    const fresh = new Map<string, DeviceStatus>();
    for (const name of args.deviceNames) {
      fresh.set(name, resolveDeviceStatus(name, labState, args.onlineByDevice.get(name)));
    }
    const palette = args.rebuildPalette(labState);
    const statusText = args.rebuildStatusText(labState);
    const svg = args.graphSlot.querySelector("svg.topology-graph") as SVGSVGElement | null;
    if (svg) patchDeviceStatuses(svg, fresh, palette, statusText);
  }, 5000);
}

// Lifecycle classes for the small status dot inside each device card.
// Orthogonal to the palette: the dot reads as "what stage of life is
// this in" (booting pulses) while the outline reads as "is intent +
// reality aligned" (palette state). Both update together on poll.
const STATUS_CLASSES = ["running", "booting", "down", "unrealized"] as const;
const PALETTE_CLASSES = ["spec-only", "actuated-ok", "actuated-down", "drift", "unknown"] as const;

function patchDeviceStatuses(
  svg: SVGSVGElement,
  statuses: Map<string, DeviceStatus>,
  paletteByDevice: PaletteByDevice,
  statusTextByDevice: StatusTextByDevice,
): void {
  for (const [device, status] of statuses) {
    const sel = `g.topo-node[data-device="${CSS.escape(device)}"]`;
    const g = svg.querySelector(sel);
    if (!g) continue;
    const palette: PaletteState = paletteByDevice.get(device) ?? "unknown";
    for (const c of PALETTE_CLASSES) g.classList.remove(`topo-elem--${c}`);
    g.classList.add(`topo-elem--${palette}`);
    g.setAttribute("aria-label", `Device ${device} — ${palette}`);
    const dot = g.querySelector("circle.topo-status-dot");
    if (dot) {
      for (const c of STATUS_CLASSES) dot.classList.remove(`topo-status-dot--${c}`);
      dot.classList.add(`topo-status-dot--${status.state}`);
    }
    const title = g.querySelector("g.topo-status-badge > title");
    if (title) title.textContent = `${device}: ${status.state} — ${status.detail}`;
    // Per-device corner status text (Lab / Physical views). The renderer
    // mounts an anchor element even when the text is empty so we can
    // fill it in place on the next poll without re-rendering the SVG.
    const statusLabel = g.querySelector('text.topo-status-text[data-status-text]');
    if (statusLabel) {
      const text = statusTextByDevice.get(device) ?? "";
      statusLabel.textContent = text;
      if (text === "") statusLabel.classList.add("topo-status-text--empty");
      else statusLabel.classList.remove("topo-status-text--empty");
    }
  }
  // Repaint link lines (slice #210.E subset) — endpoint palette may
  // have shifted on this tick (device went down, drift surfaced, etc.),
  // so each link inherits the latest worst-of-two endpoint state.
  const lines = svg.querySelectorAll("line.topo-link");
  for (const ln of Array.from(lines)) {
    const a = ln.getAttribute("data-local-device") ?? "";
    const z = ln.getAttribute("data-remote-device") ?? "";
    if (!a || !z) continue;
    const aPal = paletteByDevice.get(a) ?? "unknown";
    const zPal = paletteByDevice.get(z) ?? "unknown";
    const linkPal = resolveLinkPalette(aPal, zPal);
    for (const c of PALETTE_CLASSES) ln.classList.remove(`topo-elem--${c}`);
    ln.classList.add(`topo-elem--${linkPal}`);
  }
}

async function mountTopologyTab(root: HTMLElement): Promise<void> {
  root.textContent = "";
  root.appendChild(el("p", { className: "status-loading" }, "Loading topology…"));

  try {
    const data = await fetchTopology();
    root.textContent = "";
    const topoData = adaptTopology(data);

    // Per-device probes: online (does newtron reach the device?) and drift
    // (does the device's CONFIG_DB diverge from the projected intent?).
    // Both probe in parallel; both tolerate failure (a device that is offline
    // is rendered with the offline badge; drift is only meaningful if online).
    const deviceNames = Array.isArray(topoData.nodes)
      ? topoData.nodes.map((n) => n.name).filter((n) => typeof n === "string")
      : [];

    const onlineByDevice = new Map<string, boolean>();
    const driftByDevice = new Map<string, number>();
    const probeResults = await Promise.allSettled(
      deviceNames.map(async (name) => {
        // Hit /info as the cheapest available liveness probe. Success → online.
        // Failure → offline (we don't distinguish reasons in v1; newtron#75
        // tracks a dedicated /status endpoint).
        try {
          await fetchNodeInfo(name);
          onlineByDevice.set(name, true);
        } catch {
          onlineByDevice.set(name, false);
          return;
        }
        // Drift only makes sense for online devices.
        try {
          const drift = await fetchNodeDrift(name);
          if (Array.isArray(drift)) driftByDevice.set(name, drift.length);
        } catch { /* drift unavailable; leave count undefined */ }
      })
    );
    void probeResults;

    // Phase 2: unify lab + /info into one per-device status. Lab name == active
    // network ID by convention (newtron#116). If newtlab doesn't know about
    // the network/lab yet, labState stays null and resolveDeviceStatus falls
    // back to the /info probe alone (today's behaviour).
    let labState: LabState | null = null;
    try {
      labState = await fetchLabStatus(activeNetwork());
    } catch { /* lab unknown — fall back to probe-only resolution */ }
    const statusByDevice = new Map<string, DeviceStatus>();
    for (const name of deviceNames) {
      statusByDevice.set(name, resolveDeviceStatus(name, labState, onlineByDevice.get(name)));
    }

    // Layered Topology views (slice #210.B/C/D) — pick the actuation
    // source to overlay. The mode is persisted per-network; first visit
    // gets defaultViewMode() which prefers spec-lab when any lab node
    // is known, then spec-physical when any /info probe succeeded,
    // otherwise spec (no actuation overlay). The labState ref is held
    // here so a post-tick view switch reads the latest snapshot.
    let labStateRef: LabState | null = labState;
    const activeNetName = activeNetwork();
    let viewMode: TopologyViewMode =
      loadViewMode(activeNetName) ?? defaultViewMode(labState, onlineByDevice);
    const computePaletteByDevice = (): PaletteByDevice => {
      const m: PaletteByDevice = new Map<string, PaletteState>();
      for (const name of deviceNames) {
        let p: PaletteState;
        switch (viewMode) {
          case "spec":
            p = "spec-only";
            break;
          case "spec-lab":
            p = resolveLabDevicePalette(labStateRef, name);
            break;
          case "spec-physical":
            p = resolvePhysicalDevicePalette(
              onlineByDevice.get(name),
              driftByDevice.get(name) ?? 0,
            );
            break;
        }
        m.set(name, p);
      }
      return m;
    };
    // Per-device corner status text — Lab view shows the newtlab
    // phase/status string ("booting", "patching", "running"); Physical
    // view shows the probe outcome ("offline", "online", "online · 3
    // drift"); Spec view shows nothing (the absence is the message).
    const computeStatusTextByDevice = (): StatusTextByDevice => {
      const m: StatusTextByDevice = new Map<string, string>();
      for (const name of deviceNames) {
        let t = "";
        switch (viewMode) {
          case "spec":
            t = "";
            break;
          case "spec-lab":
            t = resolveLabStatusText(labStateRef, name);
            break;
          case "spec-physical":
            t = resolvePhysicalStatusText(
              onlineByDevice.get(name),
              driftByDevice.get(name) ?? 0,
            );
            break;
        }
        m.set(name, t);
      }
      return m;
    };
    let paletteByDevice = computePaletteByDevice();
    let statusTextByDevice = computeStatusTextByDevice();

    // Toolbar — buttons gate by view mode (slice #210 polish): Spec
    // view is the only place that authors the topology spec (create
    // node / add link); Lab view exposes lab substrate lifecycle
    // (deploy / provision / destroy) because those operate on the
    // lab, not the spec; Physical view is pure observation (no
    // mutation, no lifecycle).
    // Toolbar is created here but appended below the view-mode chip
    // row so the operator reads top-to-bottom as: pick a view → take
    // an action appropriate to that view.
    const toolbar = el("div", { className: "topology-toolbar" });

    const renderToolbar = (): void => {
      toolbar.textContent = "";
      if (viewMode === "spec") {
        // Spec authoring — Create node / Add link mutate the topology
        // spec. Lab + physical lifecycle live in their respective views.
        const createNodeBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "+ Create node");
        createNodeBtn.addEventListener("click", () => {
          openCreateNodeDrawer(() => mountTopologyTab(root));
        });
        toolbar.appendChild(createNodeBtn);

        const addLinkBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "+ Add link");
        addLinkBtn.addEventListener("click", () => {
          openAddLinkDrawer(deviceNames, new Map(), () => mountTopologyTab(root));
        });
        toolbar.appendChild(addLinkBtn);
      } else if (viewMode === "spec-lab") {
        // Lab substrate lifecycle: Deploy → Provision → Destroy (newtlab's own
        // verbs). Blue (spec-only) devices become green via Deploy + Provision.
        // Convention: lab name == active network ID (newtron#116 / PR #121).
        const deployBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "Deploy");
        deployBtn.addEventListener("click", async () => {
          const network = activeNetwork();
          const ok = await confirmInline({
            title: `Deploy "${network}" as a lab?`,
            body: "VMs will boot for each device in the topology.",
            confirmLabel: "Deploy",
          });
          if (!ok) return;
          openDeployModal(network);
        });
        toolbar.appendChild(deployBtn);

        const provisionBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "Provision");
        provisionBtn.addEventListener("click", async () => {
          const network = activeNetwork();
          const ok = await confirmInline({
            title: `Run provisioning on lab "${network}"?`,
            body: "Requires VMs to be up.",
            confirmLabel: "Provision",
          });
          if (!ok) return;
          provisionBtn.setAttribute("disabled", "");
          provisionBtn.textContent = "Provisioning…";
          postLabProvision(network)
            .then(() => {
              provisionBtn.removeAttribute("disabled");
              provisionBtn.textContent = "Provision";
            })
            .catch((err) => {
              provisionBtn.removeAttribute("disabled");
              provisionBtn.textContent = "Provision";
              const msg = err instanceof Error ? err.message : String(err);
              showToast({ kind: "error", title: "Provision failed", body: msg });
            });
        });
        toolbar.appendChild(provisionBtn);

        const destroyBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "Destroy");
        destroyBtn.addEventListener("click", async () => {
          const network = activeNetwork();
          const ok = await confirmInline({
            title: `Destroy lab "${network}"?`,
            body: "All VMs and their state will be destroyed. The topology spec stays intact.",
            danger: true,
            confirmLabel: "Destroy",
          });
          if (!ok) return;
          destroyBtn.setAttribute("disabled", "");
          destroyBtn.textContent = "Destroying…";
          postLabDestroy(network)
            .then(() => {
              destroyBtn.removeAttribute("disabled");
              destroyBtn.textContent = "Destroy";
              mountTopologyTab(root);
            })
            .catch((err) => {
              destroyBtn.removeAttribute("disabled");
              destroyBtn.textContent = "Destroy";
              const msg = err instanceof Error ? err.message : String(err);
              showToast({ kind: "error", title: "Destroy failed", body: msg });
            });
        });
        toolbar.appendChild(destroyBtn);
      } else {
        // Physical substrate — only Provision (no deploy / destroy
        // because physical hardware isn't lifecycle-managed by newtcon).
        // Provision drives spec-only (blue) devices toward actuated-ok
        // (green) by pushing the spec projection at the substrate.
        const provisionBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "Provision");
        provisionBtn.addEventListener("click", async () => {
          const network = activeNetwork();
          const ok = await confirmInline({
            title: `Provision physical substrate for "${network}"?`,
            confirmLabel: "Provision",
          });
          if (!ok) return;
          provisionBtn.setAttribute("disabled", "");
          provisionBtn.textContent = "Provisioning…";
          // newtcon currently routes both lab and physical provisioning
          // through the same backend pass. If newtron later splits the
          // primitives, swap this call for the physical-specific one.
          postLabProvision(network)
            .then(() => {
              provisionBtn.removeAttribute("disabled");
              provisionBtn.textContent = "Provision";
            })
            .catch((err) => {
              provisionBtn.removeAttribute("disabled");
              provisionBtn.textContent = "Provision";
              const msg = err instanceof Error ? err.message : String(err);
              showToast({ kind: "error", title: "Provision failed", body: msg });
            });
        });
        toolbar.appendChild(provisionBtn);
      }
    };
    renderToolbar();

    // Teaching empty state (slice #169.B). When the topology has zero
    // committed devices AND no pending add-device in the queue, skip
    // the graph + filter + panel and render an explanatory block.
    //
    // The toolbar carries the action buttons (Create node / Add link),
    // but it's only appended further down in the non-empty path — so on
    // an empty network we must append it HERE too, or the operator has
    // no way to add the first device (the empty-state copy tells them to
    // "Create node" but there'd be no button). viewMode defaults to
    // "spec" for a no-lab/no-device network, so renderToolbar() above
    // has already populated it with the spec-authoring buttons.
    if (deviceNames.length === 0 && pendingTopologyDeviceAdds().length === 0) {
      root.appendChild(toolbar);
      root.appendChild(renderTopologyEmptyState());
      return;
    }

    // Layered filter (slice #174.E): fetch profiles → build device→zone
    // metadata → render zone chips above the SVG. Filter state persists
    // across renderGraph() calls. Profiles fetch is best-effort: failure
    // just means the chip row stays empty (filter is a power affordance,
    // not on the critical path).
    const deviceMetadata = new Map<string, DeviceMetadata>();
    let filterState: TopologyFilter = emptyFilter();
    try {
      const profileNames = await fetchSpecList("nodes");
      const profileDetails = await Promise.all(
        profileNames.map((n) => fetchSpecDetail("nodes", n).catch(() => null)),
      );
      for (let i = 0; i < profileNames.length; i++) {
        const d = profileDetails[i];
        const zone = (d && typeof d === "object" && !Array.isArray(d))
          ? (d as Record<string, unknown>).zone
          : null;
        deviceMetadata.set(profileNames[i]!, {
          zone: typeof zone === "string" && zone !== "" ? zone : null,
        });
      }
    } catch { /* profiles unavailable — chip row stays empty */ }

    // View-mode chip row (slice #210.B) — sits above the zone filter
    // row so the operator sees the actuation-source switch as a
    // first-class control. The chip is always mounted (even with one
    // mode available). All three chips are always enabled — the
    // "no actuation signal" condition is communicated by the view
    // itself (blue spec-only coloring on every element) rather than
    // by a redundant disabled-chip state.
    const viewRow = el("div", { className: "topology-view-row" });
    root.appendChild(viewRow);
    root.appendChild(toolbar);
    const renderViewRow = (): void => {
      viewRow.textContent = "";
      const label = el("span", { className: "topology-view-label" }, "View:");
      viewRow.appendChild(label);
      for (const mode of ALL_VIEW_MODES) {
        const isActive = mode === viewMode;
        const cls = ["topology-view-chip"];
        if (isActive) cls.push("topology-view-chip--active");
        const chip = el("button", {
          type: "button",
          className: cls.join(" "),
          title: `Switch to ${viewModeLabel(mode)}`,
        }, viewModeLabel(mode)) as HTMLButtonElement;
        chip.addEventListener("click", () => {
          if (mode === viewMode) return;
          viewMode = mode;
          saveViewMode(activeNetName, mode);
          paletteByDevice = computePaletteByDevice();
          statusTextByDevice = computeStatusTextByDevice();
          // View mode change re-renders the chip row (active highlight),
          // the toolbar (different mutation buttons per view), the
          // graph (palette + status-text swap), the panel (hidden in
          // observation views), and the drift summary (Physical-only).
          renderViewRow();
          renderToolbar();
          selected.clear();
          renderGraph();
          renderPanel();
          renderDriftSummary();
        });
        viewRow.appendChild(chip);
      }
    };
    renderViewRow();

    // Filter chip row — rendered as its own row below the toolbar. Only
    // mounted when there's more than one distinct zone to pick from; a
    // single-zone topology has nothing to filter by, so the row stays
    // out of the way. The mount target is captured so toggling can
    // re-render the row without disturbing other DOM.
    const zones = uniqueZones(deviceMetadata);
    const filterRow = el("div", { className: "topology-filter-row" });
    if (zones.length > 1) root.appendChild(filterRow);
    const renderFilterRow = (): void => {
      filterRow.textContent = "";
      const label = el("span", { className: "topology-filter-label" }, "Zone:");
      filterRow.appendChild(label);
      for (const z of zones) {
        const active = filterState.zones.has(z);
        const chip = el("button", {
          type: "button",
          className: "topology-filter-chip" + (active ? " topology-filter-chip--active" : ""),
        }, z) as HTMLButtonElement;
        chip.addEventListener("click", () => {
          const next = new Set(filterState.zones);
          if (next.has(z)) next.delete(z);
          else next.add(z);
          filterState = { zones: next };
          renderFilterRow();
          renderGraph();
        });
        filterRow.appendChild(chip);
      }
      if (filterIsActive(filterState)) {
        const clear = el("button", { type: "button", className: "topology-filter-clear" }, "clear");
        clear.addEventListener("click", () => {
          filterState = emptyFilter();
          renderFilterRow();
          renderGraph();
        });
        filterRow.appendChild(clear);
      }
    };
    if (zones.length > 1) renderFilterRow();

    // Persistent UI state: which nodes are selected; the docked panel reads
    // this and renders the action set + Save/Discard for the selection.
    const selected: Set<string> = new Set();

    // Pan/zoom viewport state — persists across renderGraph() calls so
    // the operator's view doesn't snap back to natural after every
    // selection / pending-bar / status tick.
    let viewState: ViewState | undefined;

    // Per-device pinned positions — loaded once at mount, mutated when
    // the operator drag-drops a node, persisted to localStorage. Keyed
    // by the active network so multiple operator topologies don't share.
    const activeNet = activeNetName;
    const pinnedPositions = loadPositions(activeNet);

    // Topology view: layout is a split — left = SVG diagram + toolbar,
    // right = docked action panel.
    const split = el("div", { className: "topology-split" });
    const graphSlot = el("div", { className: "topology-graph-slot" });
    const panelRoot = el("aside", { className: "topo-action-panel" });
    split.appendChild(graphSlot);
    split.appendChild(panelRoot);
    root.appendChild(split);

    // Floating zoom toolbar — absolute-positioned over the SVG via
    // .topology-zoom-toolbar styling; outlives renderGraph() calls.
    const zoomToolbar = el("div", { className: "topology-zoom-toolbar", role: "toolbar", ariaLabel: "Topology zoom" });
    const zoomOutBtn = el("button", { type: "button", className: "topology-zoom-btn", title: "Zoom out" }, "−") as HTMLButtonElement;
    const zoomInBtn = el("button", { type: "button", className: "topology-zoom-btn", title: "Zoom in" }, "+") as HTMLButtonElement;
    const fitBtn = el("button", { type: "button", className: "topology-zoom-btn", title: "Fit to view" }, "⊡") as HTMLButtonElement;
    const resetPosBtn = el("button", {
      type: "button",
      className: "topology-zoom-btn topology-zoom-btn--reset",
      title: "Reset node positions to grid layout",
    }, "↺") as HTMLButtonElement;
    zoomToolbar.append(zoomOutBtn, zoomInBtn, fitBtn, resetPosBtn);
    graphSlot.appendChild(zoomToolbar);

    // Navigation hint — small chip in the bottom-left of the slot so
    // the operator sees the affordances without having to discover
    // them by accident. Pure CSS positioning (.topology-nav-hint).
    const navHint = el(
      "div",
      { className: "topology-nav-hint", ariaHidden: "true" },
      "scroll to zoom · drag to pan",
    );
    graphSlot.appendChild(navHint);

    // Interface lists pulled from the topology declaration (works offline);
    // live-fetched lists merge in via the panel module's source cache.
    const interfacesByDevice: Map<string, string[]> = new Map();
    const rawData = (data ?? {}) as { nodes?: Record<string, { ports?: Record<string, unknown>; steps?: Array<{ params?: { fields?: { type?: string } } }> }> };
    const rawDevices: Record<string, { ports?: Record<string, unknown>; steps?: Array<{ params?: { fields?: { type?: string } } }> }> = { ...(rawData.nodes ?? {}) };
    // Overlay pending topology additions so the diagram shows them in green.
    const pendingDeviceAdds = pendingTopologyDeviceAdds();
    for (const p of pendingDeviceAdds) {
      if (!(p.name in rawDevices)) rawDevices[p.name] = (p.body as { ports?: Record<string, unknown>; steps?: Array<{ params?: { fields?: { type?: string } } }> });
    }
    // Merge pending-link adds into topoData.links so the graph draws them.
    for (const ln of pendingTopologyLinkAdds()) {
      topoData.links = topoData.links ?? [];
      const [aDev, aIf] = ln.a.split(":");
      const [zDev, zIf] = ln.z.split(":");
      topoData.links.push({
        local_device: aDev, local_interface: aIf,
        remote_device: zDev, remote_interface: zIf,
      });
    }
    // Add pending-device nodes (green) to topoData.nodes.
    topoData.nodes = topoData.nodes ?? [];
    for (const p of pendingDeviceAdds) {
      if (!topoData.nodes.some((n) => n.name === p.name)) {
        topoData.nodes.push({ name: p.name, type: "queued" });
      }
    }
    for (const [name, dev] of Object.entries(rawDevices)) {
      interfacesByDevice.set(name, Object.keys(dev?.ports ?? {}).sort(comparePorts));
    }
    const deviceTypeOf = (name: string): string => {
      const steps = (rawDevices[name] as { steps?: Array<{ params?: { fields?: { type?: string } } }> })?.steps ?? [];
      for (const s of steps) {
        const t = s.params?.fields?.type;
        if (typeof t === "string" && t !== "") return t;
      }
      return "device";
    };

    let renderGraph: () => void;
    renderGraph = (): void => {
      // Preserve the zoom toolbar across re-renders; only clear the SVG.
      const oldSvg = graphSlot.querySelector("svg.topology-graph");
      if (oldSvg) oldSvg.remove();
      // Compute dimmed set from the current filter; passed through to
      // renderTopologySVG which applies the dim class to nodes + links.
      const allNames = (topoData.nodes ?? []).map((n) => n.name);
      const dimmed = applyFilter(filterState, allNames, deviceMetadata).hidden;
      // Spec view = authoring (select + side panel + right-click
      // context menu + node delete). Observation views (Lab / Physical)
      // = left-click opens the drawer directly for inspection; right-
      // click + delete affordance omitted.
      const isSpec = viewMode === "spec";
      const specOnlyOpts = isSpec
        ? {
            onNodeContextMenu: (deviceName: string, ev: MouseEvent) => {
              showContextMenu(NODE_ACTIONS, {
                kind: "node",
                device: deviceName,
                anchorX: ev.clientX,
                anchorY: ev.clientY,
                onComplete: () => mountTopologyTab(root),
                onInspect: () => openNodeDrawer(deviceName, viewMode),
              });
            },
            onNodeDelete: (deviceName: string) => {
              enqueueTopologyRemoveDevice(deviceName);
              mountTopologyTab(root);
            },
          }
        : {};
      const result = renderTopologySVG(topoData, {
        paletteByDevice,
        statusTextByDevice,
        dimmedNames: dimmed,
        onNodeClick: isSpec
          ? (deviceName, ev) => {
              if (ev.shiftKey) {
                if (selected.has(deviceName)) selected.delete(deviceName);
                else selected.add(deviceName);
              } else {
                selected.clear();
                selected.add(deviceName);
              }
              renderGraph();
              renderPanel();
            }
          : (deviceName) => { openNodeDrawer(deviceName, viewMode); },
        driftByDevice,
        statusByDevice,
        selected: isSpec ? selected : new Set<string>(),
        isPendingAdd: (n) => pendingDeviceAdds.some((p) => p.name === n),
        isPendingRemove: (n) => isDevicePendingRemove(n),
        viewState,
        onViewStateChange: (next) => { viewState = next; },
        pinnedPositions,
        onNodeMoved: (name, pos) => {
          pinnedPositions.set(name, pos);
          savePosition(activeNet, name, pos);
          renderGraph();
        },
        onLinkClick: (link) => openLinkDrawer(link, rawDevices),
        ...specOnlyOpts,
      });
      // SVG sits behind the toolbar (toolbar is z-indexed above).
      graphSlot.insertBefore(result.svg, zoomToolbar);
      // Remember the natural width so the toolbar handlers can compute
      // zoom bounds + fit relative to a stable reference.
      lastNaturalWidth = result.width;
      lastResultBounds = { minX: 0, minY: 0, maxX: result.width, maxY: result.height };

      // First-mount fit: the SVG uses preserveAspectRatio="xMidYMid meet",
      // so a viewBox whose aspect differs from the slot's aspect would
      // letterbox the diagram (centered with padding on the longer axis).
      // That centering throws off the screen-to-viewBox math used by
      // wheel-zoom and drag-pan because clientX/clientY map to a region
      // inside the slot that doesn't cover the full slot. Compute a
      // fit-to-bounds viewBox that matches the slot's aspect on initial
      // render — the diagram still occupies its natural area, the
      // viewBox just extends to slot aspect with even margin.
      //
      // requestAnimationFrame ensures getBoundingClientRect runs after
      // layout when the SVG is actually sized.
      if (viewState === undefined) {
        requestAnimationFrame(() => {
          const rect = result.svg.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            viewState = fitToBounds(lastResultBounds, rect.width, rect.height);
            result.svg.setAttribute("viewBox", viewBoxStr(viewState));
          }
        });
      }
    };
    let lastNaturalWidth = 1;
    let lastResultBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

    // Toolbar handlers — apply to the current SVG via setAttribute,
    // then notify viewState so the next renderGraph keeps the change.
    const applyZoom = (factor: number): void => {
      const svgEl = graphSlot.querySelector("svg.topology-graph") as SVGSVGElement | null;
      if (!svgEl) return;
      const rect = svgEl.getBoundingClientRect();
      const base = viewState ?? {
        x: 0, y: 0, w: lastNaturalWidth,
        h: (lastResultBounds.maxY - lastResultBounds.minY),
      };
      viewState = zoomAt(base, factor, rect.width / 2, rect.height / 2,
        rect.width, rect.height, lastNaturalWidth);
      svgEl.setAttribute("viewBox", viewBoxStr(viewState));
    };
    zoomInBtn.addEventListener("click", () => applyZoom(ZOOM_STEP));
    zoomOutBtn.addEventListener("click", () => applyZoom(1 / ZOOM_STEP));
    fitBtn.addEventListener("click", () => {
      const svgEl = graphSlot.querySelector("svg.topology-graph") as SVGSVGElement | null;
      if (!svgEl) return;
      const rect = svgEl.getBoundingClientRect();
      viewState = fitToBounds(lastResultBounds, rect.width, rect.height);
      svgEl.setAttribute("viewBox", viewBoxStr(viewState));
    });
    resetPosBtn.addEventListener("click", async () => {
      if (pinnedPositions.size === 0) return;
      const ok = await confirmInline({
        title: `Reset ${pinnedPositions.size} pinned node position${pinnedPositions.size === 1 ? "" : "s"}?`,
        body: "Nodes will return to the grid layout.",
        confirmLabel: "Reset",
      });
      if (!ok) return;
      pinnedPositions.clear();
      clearPositions(activeNet);
      renderGraph();
    });

    // Re-render the graph + panel when the pending queue changes — but do
    // NOT remount: that would clear the current selection. The panel reads
    // the queue and shows per-device queued items + Apply/Discard buttons.
    const unsub = subscribePending(() => { renderGraph(); renderPanel(); });
    if ((root as unknown as { _topoUnsub?: () => void })._topoUnsub) {
      (root as unknown as { _topoUnsub?: () => void })._topoUnsub!();
    }
    (root as unknown as { _topoUnsub?: () => void })._topoUnsub = unsub;

    const renderPanel = (): void => {
      if (viewMode !== "spec") {
        // Observation views — hide the action panel entirely so the
        // SVG fills the width. Drawer (left-click) is the inspection
        // affordance; spec mutation is unavailable here by design.
        //
        // Also collapse the grid column: display:none on the panel
        // itself doesn't collapse the .topology-split grid track, so
        // the 380px right column would stay allocated and leave a
        // visible empty margin. .topology-split--no-panel switches the
        // grid to a single 1fr column.
        panelRoot.style.display = "none";
        panelRoot.textContent = "";
        split.classList.add("topology-split--no-panel");
        return;
      }
      panelRoot.style.display = "";
      split.classList.remove("topology-split--no-panel");
      renderActionPanel(
        { devices: Array.from(selected) },
        {
          panelRoot,
          topology: {
            interfacesFor: (d) => interfacesByDevice.get(d) ?? [],
            deviceType: deviceTypeOf,
          },
          onChange: () => { renderGraph(); renderPanel(); },
          onLinkRequest: () => { selected.clear(); mountTopologyTab(root); },
        },
      );
    };

    // Background-dismiss selection on outside graph clicks (Spec only —
    // observation views don't carry selection state).
    graphSlot.addEventListener("click", (e) => {
      if (viewMode !== "spec") return;
      if (e.target === graphSlot || (e.target as Element).tagName?.toLowerCase() === "svg") {
        selected.clear();
        renderGraph();
        renderPanel();
      }
    });

    // Right-click on empty canvas → "Create node" affordance. Suppressed
    // in observation views (no spec mutation there). Per-device
    // right-click is handled inside renderTopologySVG.
    graphSlot.addEventListener("contextmenu", (e) => {
      if (viewMode !== "spec") return;
      const tag = (e.target as Element).tagName?.toLowerCase();
      if (e.target !== graphSlot && tag !== "svg") return;
      e.preventDefault();
      showCanvasContextMenu(e.clientX, e.clientY, () => mountTopologyTab(root));
    });

    renderGraph();
    renderPanel();

    // Phase 2: live-update device badges on a 5s tick. Patches in place — the
    // operator can keep interacting with the panel + drawers while statuses
    // refresh. Restart on every mount so re-renders don't accumulate timers.
    startTopologyPoll({
      network: activeNetName,
      graphSlot,
      deviceNames,
      onlineByDevice,
      rebuildPalette: (lab) => {
        labStateRef = lab;
        paletteByDevice = computePaletteByDevice();
        return paletteByDevice;
      },
      rebuildStatusText: () => {
        statusTextByDevice = computeStatusTextByDevice();
        return statusTextByDevice;
      },
      onLabStateRefresh: (lab) => {
        labStateRef = lab;
      },
    });

    // Drift summary is a physical-substrate signal — surface only in
    // Physical view. Re-renders alongside view-mode changes via
    // renderDriftSummary().
    const driftSummaryRow = el("div");
    root.appendChild(driftSummaryRow);
    const renderDriftSummary = (): void => {
      driftSummaryRow.textContent = "";
      if (viewMode !== "spec-physical") return;
      const totalDrift = Array.from(driftByDevice.values()).reduce((a, b) => a + b, 0);
      const summary = el(
        "p",
        { className: totalDrift > 0 ? "topology-drift-summary topology-drift-summary--present" : "topology-drift-summary" },
        totalDrift > 0
          ? `${totalDrift} drift item${totalDrift === 1 ? "" : "s"} across ${driftByDevice.size} device${driftByDevice.size === 1 ? "" : "s"} — click a device to inspect.`
          : "No drift detected on any device.",
      );
      driftSummaryRow.appendChild(summary);
    };
    renderDriftSummary();
  } catch (err) {
    root.textContent = "";
    if (err instanceof ApiError && err.kind === "newtron_unavailable") {
      root.appendChild(el("p", { className: "topology-error" }, "newtron is unreachable"));
      const detailObj = err.details as { underlying_error_message?: string } | undefined;
      const detail = detailObj?.underlying_error_message ?? err.message;
      root.appendChild(el("p", { className: "panel-error-detail" }, detail));
    } else if (err instanceof ApiError) {
      root.appendChild(el("p", { className: "topology-error" }, err.message));
    } else {
      root.appendChild(el("p", { className: "topology-error" }, "Failed to load topology"));
      root.appendChild(el("p", { className: "panel-error-detail" }, String(err)));
    }
  }
}

// ---- Tab switching ----------------------------------------------------------

function setupTabs(): void {
  const tabSpecs = document.getElementById("tab-specs");
  const tabTopology = document.getElementById("tab-topology");
  const tabPermissions = document.getElementById("tab-permissions");
  const tabHistory = document.getElementById("tab-history");
  const tabAudit = document.getElementById("tab-audit");
  const panelSpecs = document.getElementById("panel-specs");
  const panelTopology = document.getElementById("panel-topology");
  const panelPermissions = document.getElementById("panel-permissions");
  const panelHistory = document.getElementById("panel-history");
  const panelAudit = document.getElementById("panel-audit");

  if (!tabSpecs || !tabTopology || !tabPermissions || !tabHistory || !tabAudit ||
      !panelSpecs || !panelTopology || !panelPermissions || !panelHistory || !panelAudit) return;

  let topologyMounted = false;

  type TabName = "specs" | "topology" | "permissions" | "history" | "audit";

  const activateTab = (name: TabName): void => {
    // Drawers (spec detail, node inspector, sub-rule add forms) live in
    // #detail-drawer overlaid on top of the workspace. Switching tabs
    // changes the panel behind the drawer; leaving it open would
    // display stale content (e.g. a Service detail floating over the
    // Topology view). Close on every tab switch — Escape closes
    // similarly; tab clicks should too.
    closeDetail();

    const isSpecs = name === "specs";
    const isTopology = name === "topology";
    const isPermissions = name === "permissions";
    const isHistory = name === "history";
    const isAudit = name === "audit";

    tabSpecs.classList.toggle("workspace-tab--active", isSpecs);
    tabSpecs.setAttribute("aria-selected", isSpecs ? "true" : "false");
    tabTopology.classList.toggle("workspace-tab--active", isTopology);
    tabTopology.setAttribute("aria-selected", isTopology ? "true" : "false");
    tabPermissions.classList.toggle("workspace-tab--active", isPermissions);
    tabPermissions.setAttribute("aria-selected", isPermissions ? "true" : "false");
    tabHistory.classList.toggle("workspace-tab--active", isHistory);
    tabHistory.setAttribute("aria-selected", isHistory ? "true" : "false");
    tabAudit.classList.toggle("workspace-tab--active", isAudit);
    tabAudit.setAttribute("aria-selected", isAudit ? "true" : "false");

    (panelSpecs as HTMLElement).hidden = !isSpecs;
    (panelTopology as HTMLElement).hidden = !isTopology;
    (panelPermissions as HTMLElement).hidden = !isPermissions;
    (panelHistory as HTMLElement).hidden = !isHistory;
    (panelAudit as HTMLElement).hidden = !isAudit;

    if (isTopology && !topologyMounted) {
      topologyMounted = true;
      mountTopologyTab(panelTopology as HTMLElement);
    }
    if (!isTopology) {
      // Stop polling newtlab status when leaving the Topology tab.
      stopTopologyPoll();
    }
    if (isPermissions) {
      // Always re-mount so the operator sees the live authorization table —
      // a change upstream (network.json edit + reload) shouldn't surface
      // stale here.
      void mountAuthorizationTab(panelPermissions as HTMLElement);
    }
    if (isHistory) {
      // Re-mount so newly-applied entries surface immediately when the
      // operator opens the tab after an Apply.
      mountHistoryTab(panelHistory as HTMLElement);
    }
    if (isAudit) {
      // Re-mount so the operator gets fresh events + integrity status
      // every time they open the tab (no auto-poll for now).
      void mountAuditTab(panelAudit as HTMLElement);
    }
  };

  tabSpecs.addEventListener("click", () => activateTab("specs"));
  tabTopology.addEventListener("click", () => activateTab("topology"));
  tabPermissions.addEventListener("click", () => activateTab("permissions"));
  tabHistory.addEventListener("click", () => activateTab("history"));
  tabAudit.addEventListener("click", () => activateTab("audit"));
}

// ---- Entry ------------------------------------------------------------------

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

async function mountSpecsView(root: HTMLElement): Promise<void> {
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
          activeFacet = kind;
          renderSubnav();
          renderActiveFacet();
        });
        groupList.appendChild(btn);
      }
      section.appendChild(groupList);
      subnav.appendChild(section);
    }
  }

  async function renderActiveFacet(): Promise<void> {
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

async function mount(): Promise<void> {
  const root = document.getElementById("panel-specs");
  if (!root) return;

  await mountSpecsView(root);

  setupTabs();

  document.getElementById("drawer-close")?.addEventListener("click", closeDetail);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
  });
}

// Gate the workspace mount on a successful sign-in so we don't fire /api/*
// calls anonymously at boot and trigger spurious 401s. signedInOnce resolves
// when auth-gate.ts has either confirmed an existing session via /api/auth/whoami
// or completed an interactive login.
import { signedInOnce } from "./auth-gate.js";
void signedInOnce.then(mount);
