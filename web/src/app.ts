// app.ts — newtcon workspace entry. Renders a three-tab layout:
//   Tab 1 (Specs)    — multi-panel spec view
//   Tab 2 (Topology) — SVG topology graph + node-inspector drawer
//   Tab 3 (Lab)      — lab topology lifecycle (deploy / destroy / nodes)

import {
  fetchSpecList,
  fetchSpecDetail,
  addSubRule,
  updateSpec,
  removeQoSQueue,
  removeFilterRule,
  removePrefixListEntry,
  removeRoutePolicyRule,
  type SpecKind,
} from "./api/newtcon/network.js";
import { ApiError } from "./api/newtcon/services.js";
import { formatErrorBrief } from "./render-error.js";
import { mountAuthorizationTab } from "./authorization.js";
import { mountHistoryTab } from "./history.js";
import { emptyStateFor } from "./empty-states.js";
import { attachServerValidationToForm, clearFieldErrors } from "./form-error-binding.js";
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
  deleteTopologyLink,
  postBindService,
  postUnbindService,
  postRefreshService,
} from "./api/newtcon/nodes.js";
import { apiPath } from "./api-path.js";
import { activeNetwork } from "./network-switcher.js";
import { buildSpecDetailShape } from "./spec-detail-shape.js";
import { computePrefillForKind, strategiesFor } from "./smart-defaults.js";
import {
  type SubRuleColumn,
  type SubRuleItemType,
  extractRowCells,
  getSubRuleItems,
  itemKey,
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
// Note: postTopologyDevice / deleteTopologyDevice / postTopologyLink
// were previously called directly from the topology view. With the staging
// queue introduced in staging.ts, those flows go through enqueue* + applyAll
// instead, so we don't import them here.
import { NODE_ACTIONS } from "./topology-actions.js";
import { showContextMenu } from "./topology-actions-ui.js";
import { iconSVG } from "./icons.js";
import { renderActionPanel } from "./topology-action-panel.js";
import {
  enqueueSpecCreate,
  enqueueSpecDelete,
  enqueueTopologyAddDevice,
  enqueueTopologyRemoveDevice,
  enqueueTopologyAddLink,
  pendingSpecCreates,
  isSpecPendingDelete,
  pendingTopologyDeviceAdds,
  isDevicePendingRemove,
  pendingTopologyLinkAdds,
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
}

const PANELS: Panel[] = [
  { kind: "services", title: "Services" },
  { kind: "ipvpns", title: "IP VPNs" },
  { kind: "macvpns", title: "MAC VPNs" },
  { kind: "qos-policies", title: "QoS policies" },
  { kind: "filters", title: "Filters" },
  { kind: "route-policies", title: "Route policies" },
  { kind: "prefix-lists", title: "Prefix lists" },
  { kind: "profiles", title: "Device profiles" },
  { kind: "zones", title: "Zones" },
  { kind: "platforms", title: "Platforms" },
];

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
const specForms: Partial<Record<SpecKind, FieldDef[]>> = {
  services: [
    { name: "name", label: "Name", type: "text", required: true, placeholder: "e.g. transit" },
    {
      name: "type", label: "Type", type: "select", required: true,
      options: ["evpn-irb", "evpn-bridged", "evpn-routed", "irb", "bridged", "routed"],
    },
    { name: "ipvpn", label: "IP VPN", type: "text", placeholder: "IP VPN name (if applicable)" },
    { name: "macvpn", label: "MAC VPN", type: "text", placeholder: "MAC VPN name (if applicable)" },
    { name: "vrf_type", label: "VRF type", type: "text", placeholder: "e.g. L3" },
    { name: "qos_policy", label: "QoS policy", type: "text", placeholder: "Policy name (optional)" },
    { name: "ingress_filter", label: "Ingress filter", type: "text", placeholder: "Filter name (optional)" },
    { name: "egress_filter", label: "Egress filter", type: "text", placeholder: "Filter name (optional)" },
    { name: "description", label: "Description", type: "text" },
  ],
  ipvpns: [
    { name: "name", label: "Name", type: "text", required: true, placeholder: "e.g. corp-l3vpn" },
    {
      name: "l3vni", label: "L3 VNI", type: "number", required: true,
      placeholder: "e.g. 10001", min: 1, max: 16777215,
      help: "24-bit VXLAN VNI for routed traffic. Must be unique across IP VPNs in this network.",
    },
    { name: "vrf", label: "VRF", type: "text", placeholder: "VRF name (optional)" },
    { name: "description", label: "Description", type: "text" },
  ],
  macvpns: [
    { name: "name", label: "Name", type: "text", required: true, placeholder: "e.g. vlan100-vpn" },
    {
      name: "vni", label: "VNI", type: "number", required: true,
      placeholder: "e.g. 100", min: 1, max: 16777215,
      help: "24-bit VXLAN VNI for bridged traffic. Must be unique across MAC VPNs in this network.",
    },
    {
      name: "vlan_id", label: "VLAN ID", type: "number",
      placeholder: "e.g. 100", min: 1, max: 4094,
      help: "Local VLAN ID on each device the MAC VPN binds to. 802.1Q range is 1–4094.",
    },
    {
      name: "anycast_ip", label: "Anycast IP", type: "text",
      placeholder: "e.g. 10.0.100.1/24",
      pattern: PATTERNS.IPV4_CIDR,
      patternTitle: "IPv4 address with optional /prefix (e.g. 10.0.100.1 or 10.0.100.0/24)",
    },
    {
      name: "anycast_mac", label: "Anycast MAC", type: "text",
      placeholder: "e.g. 00:00:00:00:01:00",
      pattern: PATTERNS.MAC,
      patternTitle: "Six hex octets separated by colons or dashes (e.g. 00:00:00:00:01:00)",
    },
    { name: "description", label: "Description", type: "text" },
  ],
  "qos-policies": [
    { name: "name", label: "Name", type: "text", required: true, placeholder: "e.g. voip-qos" },
    { name: "description", label: "Description", type: "text" },
  ],
  filters: [
    { name: "name", label: "Name", type: "text", required: true, placeholder: "e.g. ingress-acl" },
    {
      name: "type", label: "Type", type: "select", required: true,
      options: ["ipv4", "ipv6", "l2", "acl"],
    },
    { name: "description", label: "Description", type: "text" },
  ],
  "prefix-lists": [
    { name: "name", label: "Name", type: "text", required: true, placeholder: "e.g. default-routes" },
  ],
  "route-policies": [
    { name: "name", label: "Name", type: "text", required: true, placeholder: "e.g. import-policy" },
    { name: "description", label: "Description", type: "text" },
  ],
  profiles: [
    { name: "name", label: "Name", type: "text", required: true, placeholder: "e.g. spine-1" },
    {
      name: "mgmt_ip", label: "Management IP", type: "text", required: true,
      placeholder: "e.g. 192.168.1.1",
      pattern: PATTERNS.IPV4,
      patternTitle: "IPv4 address (e.g. 192.168.1.1)",
    },
    {
      name: "loopback_ip", label: "Loopback IP", type: "text", required: true,
      placeholder: "e.g. 10.0.0.1",
      pattern: PATTERNS.IPV4,
      patternTitle: "IPv4 address (e.g. 10.0.0.1)",
    },
    { name: "zone", label: "Zone", type: "text", required: true, placeholder: "Zone name" },
    { name: "platform", label: "Platform", type: "text", placeholder: "Platform name (optional)" },
    {
      name: "underlay_asn", label: "Underlay ASN", type: "number",
      placeholder: "e.g. 65001", min: 1, max: 4294967295,
      help: "Autonomous System Number for the device's underlay BGP session. Private-use range: 64512–65535 (16-bit) or 4200000000–4294967294 (32-bit).",
    },
    { name: "ssh_user", label: "SSH user", type: "text", placeholder: "e.g. admin" },
  ],
  zones: [
    { name: "name", label: "Name", type: "text", required: true, placeholder: "e.g. datacenter-a" },
  ],
};

// displaySpecForms is a per-kind override for the DETAIL-display layout
// (renderSpecDetailInto). For most spec kinds the create-form schema in
// specForms matches what newtron returns on GET — those kinds aren't listed
// here and fall through to specForms via displaySchemaFor().
//
// Listed kinds are the ones where the wire-detail shape diverges from the
// create-request shape:
//
//   services: newtron returns "service_type" on GET but accepts "type" on
//             create. The display schema lists "service_type" so the value
//             lands in the prominent row labeled "Type" rather than in the
//             "All fields" disclosure. Heavier sub-fields (ipvpn, macvpn,
//             vrf_type, qos_policy, ingress_filter, egress_filter) appear
//             only when newtron returns them set — the disclosure surfaces
//             them automatically, no display-schema entry needed unless we
//             want them prominent.
const displaySpecForms: Partial<Record<SpecKind, FieldDef[]>> = {
  services: [
    { name: "name", label: "Name", type: "text" },
    { name: "service_type", label: "Type", type: "text" },
    { name: "description", label: "Description", type: "text" },
  ],
};

// displaySchemaFor returns the schema renderSpecDetailInto should use to
// render the GET-detail response for a spec kind. Falls back to the create
// form schema (specForms) when there is no override — that covers profiles
// (wire shape matches create shape) and zones (just `name`, excluded from
// the body — yielding the empty-state render).
function displaySchemaFor(kind: SpecKind): FieldDef[] | undefined {
  return displaySpecForms[kind] ?? specForms[kind];
}

// isEditableKind returns true when a spec kind has any top-level field
// beyond the identifier — those are the kinds where the Edit button shows
// up in the detail drawer. Schemas that are just `name` (zones, prefix-
// lists today) have nothing edit-worthy at the top level; their content
// lives in sub-rules, managed via the existing sub-rule UI.
function isEditableKind(kind: SpecKind): boolean {
  const fields = specForms[kind];
  if (!fields) return false;
  return fields.some((f) => f.name !== "name");
}

// prefillFromDetail maps the GET-detail wire shape to the create-form
// field names so the Edit form starts with the operator's current values.
//
// Most kinds are 1:1 — pass-through. Asymmetric kinds need explicit
// mappings; today services is the only one (wire `service_type` ↔ form
// `type`, same diversion already handled by displaySpecForms for the
// read-only render).
function prefillFromDetail(kind: SpecKind, detail: unknown): Record<string, unknown> {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return {};
  const d = detail as Record<string, unknown>;
  const out: Record<string, unknown> = { ...d };
  if (kind === "services" && "service_type" in d) {
    out["type"] = d["service_type"];
  }
  return out;
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

  saveBtn.addEventListener("click", async () => {
    clearFieldErrors(form);
    if (!validate()) return;
    errOut.textContent = "";
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      await updateSpec(kind, name, getValues());
      void openDetail(kind, kindTitle, name);
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
      // validation_failure: attach to the field if newtron named one.
      if (!attachServerValidationToForm(form, err)) {
        errOut.appendChild(el("p", { className: "panel-error" }, formatErrorBrief(err)));
      }
    }
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

// translateErrorKind converts error kind identifiers to operator-readable language.
function translateErrorKind(kind: string): string {
  switch (kind) {
    case "validation_failure": return "validation failed";
    case "precondition_failure": return "precondition not met";
    case "drift_refusal": return "drift detected — refused to apply";
    case "newtron_unavailable": return "newtron unreachable";
    default: return "error";
  }
}

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

// refreshPanel re-fetches the spec list for a panel and replaces its DOM node.
function refreshPanel(panel: Panel, container: HTMLElement): void {
  fetchSpecList(panel.kind)
    .then((names) => {
      const fresh = buildPanel(panel, { status: "fulfilled", value: names });
      container.replaceWith(fresh);
    })
    .catch((err) => {
      const fresh = buildPanel(panel, { status: "rejected", reason: err });
      container.replaceWith(fresh);
    });
}

// buildPanel constructs the panel DOM for a spec type.
// Separated from renderPanel so refreshPanel can rebuild after mutations.
function buildPanel(panel: Panel, result: PromiseSettledResult<string[]>): HTMLElement {
  const container = el("section", { className: "panel" });
  const header = el("div", { className: "panel-header" });
  header.appendChild(el("h2", { className: "panel-title" }, panel.title));

  if (result.status === "fulfilled") {
    const items = result.value;
    header.appendChild(el("span", { className: "panel-count" }, String(items.length)));

    // "Add" button — only for spec types that have a form defined.
    if (specForms[panel.kind]) {
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

    // Combine server-side items with pending creates (overlay so the operator
    // sees both committed and queued items in one list, with color).
    const queuedAdds = pendingSpecCreates(panel.kind as StagingSpecKind);
    type SpecRow = { name: string; pending: "none" | "create" };
    const allRows: SpecRow[] = items.map((n) => ({ name: n, pending: "none" as const }));
    for (const n of queuedAdds) {
      if (!items.includes(n)) allRows.push({ name: n, pending: "create" });
    }

    if (allRows.length === 0) {
      container.appendChild(renderPanelEmpty(panel.kind, !!specForms[panel.kind]));
    } else {
      const list = el("ul", { className: "panel-list" });
      for (const r of allRows) {
        const isPendingCreate = r.pending === "create";
        const isPendingDelete = isSpecPendingDelete(panel.kind as StagingSpecKind, r.name);
        const row = el("li", {
          className: "panel-list-row"
            + (isPendingCreate ? " panel-list-row--pending-add" : "")
            + (isPendingDelete ? " panel-list-row--pending-del" : ""),
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

        // Delete affordance — × button shown on hover.
        if (specForms[panel.kind] && !isPendingCreate) {
          const delBtn = el("button", {
            type: "button",
            className: "panel-delete-btn",
            title: isPendingDelete ? "Cancel delete" : "Delete " + r.name,
            ariaLabel: isPendingDelete ? "Cancel delete of " + r.name : "Delete " + r.name,
          }, isPendingDelete ? "↺" : "×");
          delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            enqueueSpecDelete(panel.kind as StagingSpecKind, r.name);
            refreshPanel(panel, container);
          });
          row.appendChild(delBtn);
        }

        list.appendChild(row);
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

function renderPanel(panel: Panel, result: PromiseSettledResult<string[]>): HTMLElement {
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

  const tbody = el("tbody");
  if (items.length === 0) {
    const emptyRow = el("tr", { className: "subrule-row-empty" });
    const cell = el("td", { className: "subrule-td subrule-td--empty" }, "(none)") as HTMLTableCellElement;
    cell.colSpan = conf.columns.length + 1;
    emptyRow.appendChild(cell);
    tbody.appendChild(emptyRow);
  } else {
    for (const item of items) {
      tbody.appendChild(renderSubRuleRow(kind, specName, item, conf));
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
  item: unknown,
  conf: SubRuleTable,
): HTMLElement {
  const row = el("tr", { className: "subrule-row" });
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
  const key = itemKey(item, conf.itemType, conf.keyField);
  if (key !== null) {
    const delBtn = el("button", {
      type: "button",
      className: "subrule-delete-btn",
      title: `Remove ${conf.itemLabel} ${key}`,
    }, "×");
    delBtn.addEventListener("click", async () => {
      if (!window.confirm(`Remove ${conf.itemLabel} ${key} from ${specName}?`)) return;
      delBtn.disabled = true;
      try {
        await deleteSubRuleItem(kind, specName, key);
        openDetail(kind, kindTitleFor(kind), specName);
      } catch (err) {
        delBtn.disabled = false;
        const msg = err instanceof ApiError
          ? translateErrorKind(err.kind) + ": " + err.message
          : String(err);
        alert("Remove failed: " + msg);
      }
    });
    actionsCell.appendChild(delBtn);
  }
  row.appendChild(actionsCell);
  return row;
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

  addBtn.addEventListener("click", () => {
    addBtn.hidden = true;
    formArea.hidden = false;
  });
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
    try {
      const values = getValues();
      const bodyWithParent = injectParentName(kind, specName, values);
      await addSubRule(kind, specName, conf.endpoint, bodyWithParent);
      openDetail(kind, kindTitleFor(kind), specName);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Add " + conf.itemLabel;
      if (!attachServerValidationToForm(form, err)) {
        errOut.appendChild(el("p", { className: "panel-error" },
          err instanceof ApiError
            ? translateErrorKind(err.kind) + ": " + err.message
            : String(err)));
      }
    }
  });

  return wrap;
}

// deleteSubRuleItem dispatches to the per-kind delete function.
function deleteSubRuleItem(kind: SpecKind, specName: string, key: string | number): Promise<unknown> {
  switch (kind) {
    case "qos-policies":   return removeQoSQueue(specName, Number(key));
    case "filters":        return removeFilterRule(specName, Number(key));
    case "prefix-lists":   return removePrefixListEntry(specName, String(key));
    case "route-policies": return removeRoutePolicyRule(specName, Number(key));
    default: return Promise.reject(new Error("no delete for " + kind));
  }
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

// kindTitleFor maps a SpecKind back to a human title.
function kindTitleFor(kind: SpecKind): string {
  const panel = PANELS.find((p) => p.kind === kind);
  return panel?.title ?? kind;
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
    const detail = await fetchSpecDetail(kind, name);
    content.removeChild(loading);

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

    // Schema-aware rendering when a display schema knows this kind; generic
    // recursive tree as the fallback so unknown kinds still render. Exclude
    // the sub-rule wire field (if any) so child rules don't double-display
    // — they get a dedicated section below via renderSubRuleTable.
    const fields = displaySchemaFor(kind);
    const subRuleConf = subRuleTables[kind];
    if (fields) {
      const body = el("div");
      const extraExcludes = subRuleConf ? [subRuleConf.wireField] : [];
      renderSpecDetailInto(body, fields, detail, extraExcludes);
      content.appendChild(body);
    } else {
      const body = renderValue(detail);
      if (body instanceof HTMLElement) {
        body.classList.add("drawer-detail");
      }
      content.appendChild(body);
    }

    // Sub-rules: one unified inline-table section per kind (#173.A).
    if (subRuleConf) {
      renderSubRuleTable(kind, name, detail, content, subRuleConf);
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
  // If it's already in the renderer shape, pass through.
  if (Array.isArray((r as { nodes?: unknown }).nodes)) return r as TopologyData;

  const devices = (r.devices ?? {}) as Record<string, Record<string, unknown>>;
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

interface TopologyRenderOpts {
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

  const svg = svgEl("svg", {
    width: String(svgW),
    height: String(svgH),
    viewBox: initialViewBox,
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
  for (const link of links) {
    const from = link.local_device ? positions.get(link.local_device) : undefined;
    const to = link.remote_device ? positions.get(link.remote_device) : undefined;
    if (!from || !to) continue;
    const linkDimmed = (link.local_device !== undefined && dimmed.has(link.local_device))
      || (link.remote_device !== undefined && dimmed.has(link.remote_device));
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
      "class": "topo-link" + (linkDimmed ? " topo-link--dimmed" : ""),
      x1: String(from.cx),
      y1: String(from.cy),
      x2: String(to.cx),
      y2: String(to.cy),
    });
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
    const stateClass = status ? ` topo-node--${status.state}` : "";
    // Drift: count of out-of-sync items between intent and CONFIG_DB.
    // Orthogonal to substrate state — a "running" device can have drift.
    // The .topo-node--drifted class tints the node outline so the operator
    // sees the drifted set at a glance, not just via the corner badge.
    const driftCount = opts.driftByDevice?.get(node.name) ?? 0;
    const driftClass = driftCount > 0 ? " topo-node--drifted" : "";

    const ariaLabelParts = [`Device ${node.name}`, status?.state ?? "unknown"];
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
        + stateClass
        + driftClass,
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

// NODE_TABS defines the sub-tabs in operator-domain words (no internal jargon
// vocabulary, per vocabulary discipline in the slice spec).
const NODE_TABS = [
  { id: "overview",  label: "Overview" },
  { id: "profile",   label: "Profile" },
  { id: "interfaces", label: "Interfaces" },
  { id: "vlans",     label: "VLANs" },
  { id: "vrfs",      label: "VRFs" },
  { id: "acls",      label: "ACLs" },
  { id: "bgp",       label: "BGP" },
  { id: "evpn",      label: "EVPN" },
  { id: "lags",      label: "LAGs" },
  { id: "neighbors", label: "Neighbors" },
  { id: "configdb",  label: "Config DB" },
  { id: "drift",     label: "Drift" },
  { id: "projection", label: "Projection" },
  { id: "intent-tree", label: "Intent Tree" },
] as const;

type NodeTabId = typeof NODE_TABS[number]["id"];

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
  container.appendChild(el("p", { className: "panel-error" }, "No profile found"));
  container.appendChild(el(
    "p",
    { className: "panel-error-detail" },
    `No profile spec named "${device}" exists for this device. ` +
    "Profiles and device names are conventionally identical (created together " +
    "from the Topology view). If this device's profile uses a different name, " +
    "find it under the Specs view → Device profiles."
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
function renderSpecDetailInto(container: HTMLElement, fields: FieldDef[], data: unknown, extraExcludes: string[] = []): void {
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
    dd.appendChild(row.empty
      ? el("span", { className: "spec-detail-empty" }, "—")
      : renderValue(row.value));
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
      dd.appendChild(row.empty
        ? el("span", { className: "spec-detail-empty" }, "—")
        : renderValue(row.value));
      dlx.appendChild(dd);
    }
    det.appendChild(dlx);
    container.appendChild(det);
  }
}

// openBindServiceDrawer opens a form drawer for binding a service to an interface.
// serviceNames is pre-fetched to populate the service dropdown.
function openBindServiceDrawer(
  device: string,
  ifaceName: string,
  serviceNames: string[],
  onSuccess: () => void
): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

  content.appendChild(el("p", { className: "drawer-kind" }, "Interface"));
  content.appendChild(el("h2", { className: "drawer-name" }, `Bind service — ${ifaceName}`));

  const serviceField: FieldDef = serviceNames.length > 0
    ? { name: "service", label: "Service", type: "select", required: true, options: serviceNames, placeholder: "service name" }
    : { name: "service", label: "Service", type: "text", required: true, placeholder: "service name" };
  const fields: FieldDef[] = [
    serviceField,
    { name: "vlan", label: "VLAN", type: "number", placeholder: "e.g. 100 (optional)" },
    { name: "ip_address", label: "IP address", type: "text", placeholder: "e.g. 10.0.0.1/24 (optional)" },
    { name: "peer_as", label: "Peer AS", type: "number", placeholder: "e.g. 65001 (optional)" },
  ];

  const { form, getValues, validate } = buildFormFields(fields);
  content.appendChild(form);

  const errorOut = el("div", { className: "form-error-out" });
  content.appendChild(errorOut);

  const submitBtn = el("button", { type: "button", className: "form-submit-btn" }, "Bind service");
  content.appendChild(submitBtn);

  submitBtn.addEventListener("click", async () => {
    clearFieldErrors(form);
    if (!validate()) return;
    errorOut.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Binding…";
    try {
      const values = getValues();
      if (!values["service"]) {
        errorOut.appendChild(el("p", { className: "panel-error" }, "Service name is required."));
        submitBtn.disabled = false;
        submitBtn.textContent = "Bind service";
        return;
      }
      await postBindService(device, ifaceName, values);
      submitBtn.textContent = "Bound";
      content.insertBefore(el("p", { className: "form-success" }, "Service bound."), submitBtn);
      onSuccess();
      setTimeout(() => {
        drawer.setAttribute("aria-hidden", "true");
        drawer.classList.remove("open");
      }, 800);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Bind service";
      if (!attachServerValidationToForm(form, err)) {
        if (err instanceof ApiError) {
          errorOut.appendChild(el("p", { className: "panel-error" },
            translateErrorKind(err.kind) + ": " + err.message));
        } else {
          errorOut.appendChild(el("p", { className: "panel-error" }, String(err)));
        }
      }
    }
  });
}

// renderInterfaceTab renders the interfaces sub-tab with click-to-expand detail
// and service binding/unbind/refresh actions.
function renderInterfaceTab(container: HTMLElement, device: string, data: unknown): void {
  container.textContent = "";

  let items: unknown[] = [];
  if (Array.isArray(data)) {
    items = data;
  } else if (data !== null && typeof data === "object") {
    // Some newtron endpoints return objects — wrap as single item.
    items = [data];
  }

  if (items.length === 0) {
    container.appendChild(el("p", { className: "topology-empty" }, "No interfaces found"));
    return;
  }

  const list = el("ul", { className: "iface-list" });

  for (const raw of items) {
    const iface = raw as Record<string, unknown>;
    const name = String(iface.name ?? iface.interface_name ?? iface.ifname ?? "—");
    const operStatus = String(iface.oper_status ?? iface.oper_state ?? "");

    const itemRow = el("li", { className: "iface-item", tabIndex: 0 });
    itemRow.appendChild(el("span", { className: "iface-name" }, name));
    if (operStatus) {
      itemRow.appendChild(el("span", {}, operStatus));
    }

    // Expand/collapse detail inline.
    const detailContainer = el("div", { className: "iface-detail" });
    detailContainer.hidden = true;

    let loaded = false;

    // refreshIfaceDetail re-fetches and re-renders the detail panel.
    const refreshIfaceDetail = (): void => {
      loaded = false;
      if (!detailContainer.hidden) {
        renderLoadingInto(detailContainer);
        loadIfaceDetail();
      }
    };

    const loadIfaceDetail = (): void => {
      if (loaded) return;
      loaded = true;
      renderLoadingInto(detailContainer);
      Promise.all([
        fetchNodeInterface(device, name),
        fetchNodeInterfaceBinding(device, name),
      ])
        .then(([detail, binding]) => {
          detailContainer.textContent = "";
          detailContainer.appendChild(el("p", { className: "drawer-kind" }, "Interface detail"));
          detailContainer.appendChild(renderValue(detail));
          detailContainer.appendChild(el("p", { className: "drawer-kind" }, "Service binding"));
          detailContainer.appendChild(renderValue(binding));

          // Service binding actions.
          const actionsRow = el("div", { className: "iface-actions" });
          const bindingData = binding as Record<string, unknown> | null;
          const hasBoundService = bindingData !== null &&
            typeof bindingData === "object" &&
            (bindingData["service"] != null);

          if (!hasBoundService) {
            // No service bound — show "Bind service" button.
            const bindBtn = el("button", { type: "button", className: "iface-action-btn" }, "Bind service");
            bindBtn.addEventListener("click", () => {
              // Fetch service names for the dropdown, then open the drawer.
              fetch(apiPath("services"), { cache: "no-store" })
                .then((r) => (r.ok ? r.json() : { services: [] }))
                .then((d: unknown) => {
                  const body = d as { services?: { name: string }[] };
                  const names = Array.isArray(body.services)
                    ? body.services.map((s) => s.name)
                    : [];
                  openBindServiceDrawer(device, name, names, refreshIfaceDetail);
                })
                .catch(() => openBindServiceDrawer(device, name, [], refreshIfaceDetail));
            });
            actionsRow.appendChild(bindBtn);
          } else {
            // Service is bound — show Refresh and Unbind.
            const refreshBtn = el("button", { type: "button", className: "iface-action-btn" }, "Refresh");
            refreshBtn.addEventListener("click", async () => {
              refreshBtn.disabled = true;
              refreshBtn.textContent = "Refreshing…";
              try {
                await postRefreshService(device, name);
                refreshIfaceDetail();
              } catch (err) {
                refreshBtn.disabled = false;
                refreshBtn.textContent = "Refresh";
                const msg = err instanceof ApiError
                  ? translateErrorKind(err.kind) + ": " + err.message
                  : String(err);
                alert("Refresh failed: " + msg);
              }
            });
            actionsRow.appendChild(refreshBtn);

            const unbindBtn = el("button", { type: "button", className: "iface-action-btn iface-action-btn--danger" }, "Unbind service");
            unbindBtn.addEventListener("click", async () => {
              if (!window.confirm(`Unbind service from interface ${name}? This cannot be undone.`)) return;
              unbindBtn.disabled = true;
              unbindBtn.textContent = "Unbinding…";
              try {
                await postUnbindService(device, name);
                refreshIfaceDetail();
              } catch (err) {
                unbindBtn.disabled = false;
                unbindBtn.textContent = "Unbind service";
                const msg = err instanceof ApiError
                  ? translateErrorKind(err.kind) + ": " + err.message
                  : String(err);
                alert("Unbind failed: " + msg);
              }
            });
            actionsRow.appendChild(unbindBtn);
          }

          // Link removal: offered when the interface may be a link endpoint.
          // Newtron's DeleteTopologyLink resolves the link from a single endpoint;
          // if the interface is not a link endpoint it returns 404, which is surfaced.
          const removeLinkBtn = el("button", { type: "button", className: "iface-action-btn" }, "Remove link");
          removeLinkBtn.title = "Remove the topology link that uses this interface as an endpoint";
          removeLinkBtn.addEventListener("click", () => {
            if (!window.confirm(`Remove the link on interface ${name}?`)) return;
            removeLinkBtn.disabled = true;
            removeLinkBtn.textContent = "Removing…";
            deleteTopologyLink(device, name)
              .then(() => {
                removeLinkBtn.replaceWith(el("span", { className: "form-success" }, "Link removed."));
              })
              .catch((err) => {
                removeLinkBtn.disabled = false;
                removeLinkBtn.textContent = "Remove link";
                const msg = err instanceof ApiError
                  ? translateErrorKind(err.kind) + ": " + err.message
                  : String(err);
                alert("Remove link failed: " + msg);
              });
          });
          actionsRow.appendChild(removeLinkBtn);

          detailContainer.appendChild(actionsRow);
        })
        .catch((err) => renderErrorInto(detailContainer, err));
    };

    const toggle = (): void => {
      if (detailContainer.hidden) {
        detailContainer.hidden = false;
        loadIfaceDetail();
      } else {
        detailContainer.hidden = true;
      }
    };

    itemRow.addEventListener("click", toggle);
    itemRow.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });

    list.appendChild(itemRow);
    list.appendChild(el("li", {}, detailContainer));
  }

  container.appendChild(list);
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
          const ok = window.confirm(
            `Reconcile ${device}? This will write the corrective changes to the device's CONFIG_DB atomically. Verify the preview above first.`,
          );
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
//   - Not realized     → guidance text pointing at "Bring up as lab"
//   - Reachable via probe (not lab) → state pill only (start/stop n/a)
//
// Phase 4 may move this into a standalone module if the lifecycle surface
// grows further (console viewer, log tail, etc.).
async function renderLifecycleSection(host: HTMLElement, device: string): Promise<void> {
  host.textContent = "";
  host.appendChild(el("p", { className: "lifecycle-header" }, "Lifecycle"));
  const body = el("div", { className: "lifecycle-body" });
  body.appendChild(el("p", { className: "lifecycle-loading" }, "Checking substrate…"));
  host.appendChild(body);

  const network = activeNetwork();
  let labState: LabState | null = null;
  try { labState = await fetchLabStatus(network); } catch { /* lab unknown */ }
  let online: boolean | undefined;
  try { await fetchNodeInfo(device); online = true; } catch { online = false; }

  const status = resolveDeviceStatus(device, labState, online);
  const labNode = labState?.nodes?.[device];

  body.textContent = "";

  // State pill: substrate-agnostic state on the left, substrate detail on the
  // right (the same content the topology badge tooltip shows).
  const pill = el("div", { className: `lifecycle-pill lifecycle-pill--${status.state}` });
  pill.appendChild(el("span", { className: "lifecycle-pill-state" }, status.state));
  pill.appendChild(el("span", { className: "lifecycle-pill-detail" }, status.detail));
  body.appendChild(pill);

  if (status.state === "unrealized") {
    body.appendChild(el("p", { className: "lifecycle-hint" },
      `No substrate is realizing ${device} yet. Click "Bring up as lab" in the topology toolbar to deploy this network as VMs.`));
    return;
  }

  // Start/Stop — only meaningful for lab-managed VMs.
  if (labNode) {
    const actions = el("div", { className: "lifecycle-actions" });
    if (status.state === "running" || status.state === "booting") {
      const stop = el("button", { type: "button", className: "btn btn-danger btn-sm" }, "Stop VM");
      stop.addEventListener("click", () => {
        if (!window.confirm(`Stop VM "${device}" in lab "${network}"? The device will go offline.`)) return;
        stop.setAttribute("disabled", "");
        stop.textContent = "Stopping…";
        postLabStopNode(network, device)
          .then(() => renderLifecycleSection(host, device))
          .catch((err) => {
            stop.removeAttribute("disabled");
            stop.textContent = "Stop VM";
            alert(`Stop failed: ${err instanceof Error ? err.message : String(err)}`);
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
          .then(() => renderLifecycleSection(host, device))
          .catch((err) => {
            start.removeAttribute("disabled");
            start.textContent = "Start VM";
            alert(`Start failed: ${err instanceof Error ? err.message : String(err)}`);
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
// both endpoints' interface configs + service bindings side-by-side.
// Wired by the Topology view (#174.D); the existing detail drawer is
// reused — opening this overwrites whatever the drawer was showing.
//
// Both fetches run in parallel; each endpoint section renders
// independently so a partial failure (one device unreachable) doesn't
// hide the other side.
function openLinkDrawer(link: TopoLink): void {
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
    body.appendChild(el("p", { className: "status-loading" }, "Loading…"));
    col.appendChild(body);
    grid.appendChild(col);

    void Promise.allSettled([
      fetchNodeInterface(endpoint.device, endpoint.iface),
      fetchNodeInterfaceBinding(endpoint.device, endpoint.iface),
    ]).then(([detailResult, bindingResult]) => {
      body.textContent = "";
      const detailHeading = el("p", { className: "drawer-kind" }, "Interface");
      body.appendChild(detailHeading);
      if (detailResult.status === "fulfilled") {
        body.appendChild(renderValue(detailResult.value));
      } else {
        body.appendChild(el("p", { className: "panel-error" }, formatErrorBrief(detailResult.reason)));
      }
      const bindHeading = el("p", { className: "drawer-kind" }, "Service binding");
      body.appendChild(bindHeading);
      if (bindingResult.status === "fulfilled") {
        body.appendChild(renderValue(bindingResult.value));
      } else {
        body.appendChild(el("p", { className: "panel-error" }, formatErrorBrief(bindingResult.reason)));
      }
    });
  }
}

// openNodeDrawer opens the detail drawer for a device and renders node-inspector
// sub-tabs. Each sub-tab fetches its data lazily on first activation.
function openNodeDrawer(device: string): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

  // Header.
  content.appendChild(el("p", { className: "drawer-kind" }, "Device"));
  content.appendChild(el("h2", { className: "drawer-name" }, device));

  // Phase 3: Lifecycle section — substrate badge + start/stop + SSH/console
  // snippets when the device is a lab VM. Renders empty placeholder first;
  // populated asynchronously from newtlab status.
  const lifecycleSection = el("section", { className: "lifecycle-section" });
  content.appendChild(lifecycleSection);
  void renderLifecycleSection(lifecycleSection, device);

  // Sub-tab strip.
  const tabStrip = el("nav", { className: "node-tabs", role: "tablist", ariaLabel: "Device information" });

  // Tab panels container — each panel is rendered lazily.
  const panelsContainer = el("div", {});

  const panels = new Map<NodeTabId, HTMLElement>();
  const tabButtons = new Map<NodeTabId, HTMLButtonElement>();
  const fetched = new Set<NodeTabId>();

  // activateTab shows the given tab panel and marks the button active.
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

    const panel = el("div", { className: "node-tab-panel" });
    panel.setAttribute("id", `node-panel-${tab.id}`);
    panel.setAttribute("role", "tabpanel");
    panel.hidden = true;
    panels.set(tab.id, panel);
    panelsContainer.appendChild(panel);
  }

  content.appendChild(tabStrip);
  content.appendChild(panelsContainer);

  // Activate the Overview tab by default.
  activateTab("overview");
}

// loadNodeTab fetches data for one node-inspector tab and renders it.
function loadNodeTab(id: NodeTabId, container: HTMLElement, device: string): void {
  renderLoadingInto(container);

  switch (id) {
    case "overview":
      fetchNodeInfo(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "profile":
      // The profile spec is the device's static identity (mgmt_ip, loopback_ip,
      // zone, platform, ssh_user). The unified-substrate convention (PR #148)
      // creates profiles with the same name as the device — so a per-device
      // fetch is just fetchSpecDetail("profiles", device). Older topologies
      // may use a different naming convention; the 404 branch surfaces that
      // honestly rather than rendering an opaque error.
      //
      // Render with the schema-aware layout (labeled rows) rather than the
      // generic recursive tree — the profile schema is known to specForms.
      fetchSpecDetail("profiles", device)
        .then((data) => {
          const fields = displaySchemaFor("profiles");
          if (fields) renderSpecDetailInto(container, fields, data);
          else renderValueInto(container, data);
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 404) {
            renderProfileNotFound(container, device);
            return;
          }
          renderErrorInto(container, err);
        });
      break;

    case "interfaces":
      fetchNodeInterfaces(device)
        .then((data) => renderInterfaceTab(container, device, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "vlans":
      fetchNodeVLANs(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "vrfs":
      fetchNodeVRFs(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "acls":
      fetchNodeACLs(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "bgp":
      fetchNodeBGPStatus(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "evpn":
      fetchNodeEVPNStatus(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "lags":
      fetchNodeLAGs(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "neighbors":
      fetchNodeNeighbors(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "configdb":
      fetchNodeConfigDB(device)
        .then((data) => renderConfigDBTab(container, device, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "drift":
      fetchNodeDrift(device)
        .then((data) => renderDriftTab(container, data, device))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "projection":
      fetchNodeProjection(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    case "intent-tree":
      fetchNodeIntentTree(device)
        .then((data) => renderValueInto(container, data))
        .catch((err) => renderErrorInto(container, err));
      break;

    default: {
      // Exhaustiveness check — TypeScript will catch missing cases at compile time.
      const _never: never = id;
      container.textContent = "";
      container.appendChild(el("p", { className: "topology-empty" }, `Unknown tab: ${_never}`));
    }
  }
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
// places: (a) `topology.json` as a TopologyDevice entry (steps + ports —
// initially empty) and (b) `profiles/{name}.json` as a DeviceProfile
// (mgmt_ip + loopback_ip + zone, plus optional platform/ssh_user). The
// drawer stages BOTH writes so every node always has a profile — newtron
// matches them by name. The staging queue's apply order already runs spec
// creates before topology adds, so the profile lands first.
//
// Zone is a required dropdown — newtron's DeviceProfile.Zone must reference
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
  content.appendChild(el("h2", { className: "drawer-name" }, "Create node"));
  content.appendChild(el("p", { className: "drawer-hint" },
    "Stages two writes: a profile (identity) and a topology entry (steps + ports). " +
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

  submitBtn.addEventListener("click", () => {
    if (!validate()) return;
    errorOut.textContent = "";
    try {
      const values = getValues();
      const name        = String(values["name"] ?? "").trim();
      const mgmtIP      = String(values["mgmt_ip"] ?? "").trim();
      const loopbackIP  = String(values["loopback_ip"] ?? "").trim();
      const zone        = String(values["zone"] ?? "").trim();
      const platform    = String(values["platform"] ?? "").trim();
      const sshUser     = String(values["ssh_user"] ?? "").trim();

      if (!name || !mgmtIP || !loopbackIP || !zone) {
        errorOut.appendChild(el("p", { className: "panel-error" },
          "Node name, management IP, loopback IP, and zone are all required."));
        return;
      }

      const profileBody: Record<string, unknown> = {
        mgmt_ip: mgmtIP,
        loopback_ip: loopbackIP,
        zone,
      };
      if (platform) profileBody["platform"] = platform;
      if (sshUser) profileBody["ssh_user"] = sshUser;

      // Stage profile first (apply order runs spec creates before topology
      // adds, so the profile lands before the topology entry references it
      // by name).
      enqueueSpecCreate("profiles", name, profileBody);
      enqueueTopologyAddDevice(name, { steps: [], ports: {} });

      submitBtn.disabled = true;
      submitBtn.textContent = "Staged";
      content.insertBefore(
        el("p", { className: "form-success" },
          `Node "${name}" staged (profile + topology). Click Save in the header to apply.`),
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
  });
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
}

function startTopologyPoll(args: PollArgs): void {
  stopTopologyPoll();
  topologyPollTimer = window.setInterval(async () => {
    let labState: LabState | null = null;
    try { labState = await fetchLabStatus(args.network); } catch { /* lab unknown — fall back */ }
    const fresh = new Map<string, DeviceStatus>();
    for (const name of args.deviceNames) {
      fresh.set(name, resolveDeviceStatus(name, labState, args.onlineByDevice.get(name)));
    }
    const svg = args.graphSlot.querySelector("svg.topology-graph") as SVGSVGElement | null;
    if (svg) patchDeviceStatuses(svg, fresh);
  }, 5000);
}

const STATUS_CLASSES = ["running", "booting", "down", "unrealized"] as const;

function patchDeviceStatuses(svg: SVGSVGElement, statuses: Map<string, DeviceStatus>): void {
  for (const [device, status] of statuses) {
    const sel = `g.topo-node[data-device="${CSS.escape(device)}"]`;
    const g = svg.querySelector(sel);
    if (!g) continue;
    for (const c of STATUS_CLASSES) g.classList.remove(`topo-node--${c}`);
    g.classList.add(`topo-node--${status.state}`);
    g.setAttribute("aria-label", `Device ${device} — ${status.state}`);
    const dot = g.querySelector("circle.topo-status-dot");
    if (dot) {
      for (const c of STATUS_CLASSES) dot.classList.remove(`topo-status-dot--${c}`);
      dot.classList.add(`topo-status-dot--${status.state}`);
    }
    const title = g.querySelector("g.topo-status-badge > title");
    if (title) title.textContent = `${device}: ${status.state} — ${status.detail}`;
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

    // Build toolbar with Add device and Add link buttons.
    const toolbar = el("div", { className: "topology-toolbar" });

    const createNodeBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "+ Create node");
    createNodeBtn.addEventListener("click", () => {
      openCreateNodeDrawer(() => mountTopologyTab(root));
    });
    toolbar.appendChild(createNodeBtn);

    const addLinkBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "+ Add link");
    addLinkBtn.addEventListener("click", () => {
      // Pass known device names; interface names pre-populated as empty (lazy).
      openAddLinkDrawer(deviceNames, new Map(), () => mountTopologyTab(root));
    });
    toolbar.appendChild(addLinkBtn);

    // Bring up as lab: newtlab boots VMs named after this network's topology
    // devices. Phase 1 of the unified-substrate direction — newtlab is plumbing,
    // not a separate domain. Once VMs are up, they're addressable through the
    // same per-device surface as physical hardware (future phase).
    //
    // Convention: lab name == active network ID (newtron#116 / PR #121 made
    // this the default on newtlab's side, so identity is mechanical).
    const bringUpBtn = el("button", { type: "button", className: "topology-toolbar-btn topology-toolbar-btn--primary" }, "Bring up as lab");
    bringUpBtn.addEventListener("click", () => {
      const network = activeNetwork();
      if (!window.confirm(`Bring up network "${network}" as a lab? VMs will boot for each device in the topology.`)) return;
      openDeployModal(network);
    });
    toolbar.appendChild(bringUpBtn);

    // Provision — newtlab's post-deploy provisioning pass. Phase 4 moved
    // this here from the retired Lab tab. Operator's typical flow:
    // Bring up → (wait for VMs to settle) → Provision → use the lab. Some
    // deploys carry `provision:true` and skip this; others split it out.
    const provisionBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "Provision");
    provisionBtn.addEventListener("click", () => {
      const network = activeNetwork();
      if (!window.confirm(`Run provisioning pass on lab "${network}"? Requires VMs to be up.`)) return;
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
          alert(`Provision failed: ${msg}`);
        });
    });
    toolbar.appendChild(provisionBtn);

    // Tear down — mirror of Bring up. Destructive: extra-warning confirm,
    // danger styling. Phase 3 ships this in the toolbar so the operator never
    // has to leave the Topology tab for lab lifecycle.
    const tearDownBtn = el("button", { type: "button", className: "topology-toolbar-btn topology-toolbar-btn--danger" }, "Tear down lab");
    tearDownBtn.addEventListener("click", () => {
      const network = activeNetwork();
      if (!window.confirm(`Tear down lab "${network}"? This will destroy all VMs and their state. The topology spec stays intact.`)) return;
      tearDownBtn.setAttribute("disabled", "");
      tearDownBtn.textContent = "Tearing down…";
      postLabDestroy(network)
        .then(() => {
          tearDownBtn.removeAttribute("disabled");
          tearDownBtn.textContent = "Tear down lab";
          // The 5s topology poll will pick up the new state within 5s and
          // patch device badges back to "unrealized"; force an immediate
          // re-render too so the operator sees the change without waiting.
          mountTopologyTab(root);
        })
        .catch((err) => {
          tearDownBtn.removeAttribute("disabled");
          tearDownBtn.textContent = "Tear down lab";
          const msg = err instanceof Error ? err.message : String(err);
          alert(`Tear down failed: ${msg}`);
        });
    });
    toolbar.appendChild(tearDownBtn);

    root.appendChild(toolbar);

    // Layered filter (slice #174.E): fetch profiles → build device→zone
    // metadata → render zone chips above the SVG. Filter state persists
    // across renderGraph() calls. Profiles fetch is best-effort: failure
    // just means the chip row stays empty (filter is a power affordance,
    // not on the critical path).
    const deviceMetadata = new Map<string, DeviceMetadata>();
    let filterState: TopologyFilter = emptyFilter();
    try {
      const profileNames = await fetchSpecList("profiles");
      const profileDetails = await Promise.all(
        profileNames.map((n) => fetchSpecDetail("profiles", n).catch(() => null)),
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
    const activeNet = activeNetwork();
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

    // Interface lists pulled from the topology declaration (works offline);
    // live-fetched lists merge in via the panel module's source cache.
    const interfacesByDevice: Map<string, string[]> = new Map();
    const rawData = (data ?? {}) as { devices?: Record<string, { ports?: Record<string, unknown>; steps?: Array<{ params?: { fields?: { type?: string } } }> }> };
    const rawDevices: Record<string, { ports?: Record<string, unknown>; steps?: Array<{ params?: { fields?: { type?: string } } }> }> = { ...(rawData.devices ?? {}) };
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
      interfacesByDevice.set(name, Object.keys(dev?.ports ?? {}).sort());
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
      const result = renderTopologySVG(topoData, {
        dimmedNames: dimmed,
        onNodeClick: (deviceName, ev) => {
          if (ev.shiftKey) {
            if (selected.has(deviceName)) selected.delete(deviceName);
            else selected.add(deviceName);
          } else {
            selected.clear();
            selected.add(deviceName);
          }
          renderGraph();
          renderPanel();
        },
        onNodeContextMenu: (deviceName, ev) => {
          // Right-click keeps the floating menu as a quick power-user gesture.
          showContextMenu(NODE_ACTIONS, {
            kind: "node",
            device: deviceName,
            anchorX: ev.clientX,
            anchorY: ev.clientY,
            onComplete: () => mountTopologyTab(root),
            onInspect: () => openNodeDrawer(deviceName),
          });
        },
        driftByDevice,
        statusByDevice,
        onNodeDelete: (deviceName) => {
          // Stage the remove rather than fire immediately; toggles if already queued.
          enqueueTopologyRemoveDevice(deviceName);
          mountTopologyTab(root);
        },
        selected,
        isPendingAdd: (n) => pendingDeviceAdds.some((p) => p.name === n),
        isPendingRemove: (n) => isDevicePendingRemove(n),
        viewState,
        onViewStateChange: (next) => { viewState = next; },
        pinnedPositions,
        onNodeMoved: (name, pos) => {
          pinnedPositions.set(name, pos);
          savePosition(activeNet, name, pos);
          // Re-render to redraw links from the new node position.
          renderGraph();
        },
        onLinkClick: (link) => openLinkDrawer(link),
      });
      // SVG sits behind the toolbar (toolbar is z-indexed above).
      graphSlot.insertBefore(result.svg, zoomToolbar);
      // Remember the natural width so the toolbar handlers can compute
      // zoom bounds + fit relative to a stable reference.
      lastNaturalWidth = result.width;
      lastResultBounds = { minX: 0, minY: 0, maxX: result.width, maxY: result.height };
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
    resetPosBtn.addEventListener("click", () => {
      if (pinnedPositions.size === 0) return;
      if (!window.confirm(`Reset ${pinnedPositions.size} pinned node position${pinnedPositions.size === 1 ? "" : "s"} to the grid layout?`)) return;
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

    // Background-dismiss menu on outside graph clicks.
    graphSlot.addEventListener("click", (e) => {
      if (e.target === graphSlot || (e.target as Element).tagName?.toLowerCase() === "svg") {
        selected.clear();
        renderGraph();
        renderPanel();
      }
    });

    // Right-click on empty canvas → "Create node" affordance. Per-device
    // right-click is handled inside renderTopologySVG via onNodeContextMenu;
    // here we only handle clicks on the canvas background (graphSlot or
    // the <svg> element itself), not on device <g> elements.
    graphSlot.addEventListener("contextmenu", (e) => {
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
    startTopologyPoll({ network: activeNetwork(), graphSlot, deviceNames, onlineByDevice });

    const totalDrift = Array.from(driftByDevice.values()).reduce((a, b) => a + b, 0);
    const summary = el(
      "p",
      { className: totalDrift > 0 ? "topology-drift-summary topology-drift-summary--present" : "topology-drift-summary" },
      totalDrift > 0
        ? `${totalDrift} drift item${totalDrift === 1 ? "" : "s"} across ${driftByDevice.size} device${driftByDevice.size === 1 ? "" : "s"} — click a device to inspect.`
        : "No drift detected on any device.",
    );
    root.appendChild(summary);
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
  const panelSpecs = document.getElementById("panel-specs");
  const panelTopology = document.getElementById("panel-topology");
  const panelPermissions = document.getElementById("panel-permissions");
  const panelHistory = document.getElementById("panel-history");

  if (!tabSpecs || !tabTopology || !tabPermissions || !tabHistory ||
      !panelSpecs || !panelTopology || !panelPermissions || !panelHistory) return;

  let topologyMounted = false;

  type TabName = "specs" | "topology" | "permissions" | "history";

  const activateTab = (name: TabName): void => {
    const isSpecs = name === "specs";
    const isTopology = name === "topology";
    const isPermissions = name === "permissions";
    const isHistory = name === "history";

    tabSpecs.classList.toggle("workspace-tab--active", isSpecs);
    tabSpecs.setAttribute("aria-selected", isSpecs ? "true" : "false");
    tabTopology.classList.toggle("workspace-tab--active", isTopology);
    tabTopology.setAttribute("aria-selected", isTopology ? "true" : "false");
    tabPermissions.classList.toggle("workspace-tab--active", isPermissions);
    tabPermissions.setAttribute("aria-selected", isPermissions ? "true" : "false");
    tabHistory.classList.toggle("workspace-tab--active", isHistory);
    tabHistory.setAttribute("aria-selected", isHistory ? "true" : "false");

    (panelSpecs as HTMLElement).hidden = !isSpecs;
    (panelTopology as HTMLElement).hidden = !isTopology;
    (panelPermissions as HTMLElement).hidden = !isPermissions;
    (panelHistory as HTMLElement).hidden = !isHistory;

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
  };

  tabSpecs.addEventListener("click", () => activateTab("specs"));
  tabTopology.addEventListener("click", () => activateTab("topology"));
  tabPermissions.addEventListener("click", () => activateTab("permissions"));
  tabHistory.addEventListener("click", () => activateTab("history"));
}

// ---- Entry ------------------------------------------------------------------

// Spec facets grouped into operator-domain categories. Replaces the flat
// 10-panel grid with a focused-one-at-a-time layout (secondary sidebar nav).
const SPEC_GROUPS: { id: string; label: string; kinds: SpecKind[] }[] = [
  { id: "services",  label: "Services",  kinds: ["services", "ipvpns", "macvpns"] },
  { id: "policies",  label: "Policies",  kinds: ["qos-policies", "filters", "route-policies", "prefix-lists"] },
  { id: "inventory", label: "Inventory", kinds: ["profiles", "platforms", "zones"] },
];

let activeFacet: SpecKind = "services";

async function mountSpecsView(root: HTMLElement): Promise<void> {
  root.textContent = "";
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
    for (const group of SPEC_GROUPS) {
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
      const items = await fetchSpecList(panel.kind);
      counts.set(panel.kind, items.length);
      renderSubnav();
      main.textContent = "";
      main.appendChild(renderPanel(panel, { status: "fulfilled", value: items } as PromiseSettledResult<string[]>));
    } catch (err) {
      counts.set(panel.kind, "error");
      renderSubnav();
      main.textContent = "";
      main.appendChild(renderPanel(panel, { status: "rejected", reason: err } as PromiseSettledResult<string[]>));
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
