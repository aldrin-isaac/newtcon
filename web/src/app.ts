// app.ts — newtcon workspace entry. Renders a three-tab layout:
//   Tab 1 (Specs)    — multi-panel spec view
//   Tab 2 (Topology) — SVG topology graph + node-inspector drawer
//   Tab 3 (Lab)      — lab topology lifecycle (deploy / destroy / nodes)

import {
  fetchSpecList,
  fetchSpecDetail,
  addSubRule,
  removeQoSQueue,
  removeFilterRule,
  removePrefixListEntry,
  removeRoutePolicyRule,
  type SpecKind,
} from "./api/newtcon/network.js";
import { ApiError } from "./api/newtcon/services.js";
import {
  fetchLabs,
  fetchLabStatus,
  postLabDeploy,
  postLabDestroy,
  postLabProvision,
  postLabStartNode,
  postLabStopNode,
  labEvents,
  type LabState,
  type LabListItem,
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
// Note: postTopologyDevice / deleteTopologyDevice / postTopologyLink
// were previously called directly from the topology view. With the staging
// queue introduced in staging.ts, those flows go through enqueue* + applyAll
// instead, so we don't import them here.
import { NODE_ACTIONS } from "./topology-actions.js";
import { showContextMenu } from "./topology-actions-ui.js";
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
  name: string;      // JSON field name sent to newtron
  label: string;     // Operator-visible label (domain language)
  type: "text" | "number" | "select";
  required?: boolean;
  options?: string[];   // for type "select"
  placeholder?: string;
}

// specForms maps each SpecKind to the form fields needed to create that spec.
// Field names and types are taken verbatim from the newtron request types in
// pkg/newtron/types.go (CreateServiceRequest, CreateIPVPNRequest, etc.).
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
    { name: "l3vni", label: "L3 VNI", type: "number", required: true, placeholder: "e.g. 10001" },
    { name: "vrf", label: "VRF", type: "text", placeholder: "VRF name (optional)" },
    { name: "description", label: "Description", type: "text" },
  ],
  macvpns: [
    { name: "name", label: "Name", type: "text", required: true, placeholder: "e.g. vlan100-vpn" },
    { name: "vni", label: "VNI", type: "number", required: true, placeholder: "e.g. 100" },
    { name: "vlan_id", label: "VLAN ID", type: "number", placeholder: "e.g. 100" },
    { name: "anycast_ip", label: "Anycast IP", type: "text", placeholder: "e.g. 10.0.100.1/24" },
    { name: "anycast_mac", label: "Anycast MAC", type: "text", placeholder: "e.g. 00:00:00:00:01:00" },
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
    { name: "mgmt_ip", label: "Management IP", type: "text", required: true, placeholder: "e.g. 192.168.1.1" },
    { name: "loopback_ip", label: "Loopback IP", type: "text", required: true, placeholder: "e.g. 10.0.0.1" },
    { name: "zone", label: "Zone", type: "text", required: true, placeholder: "Zone name" },
    { name: "platform", label: "Platform", type: "text", placeholder: "Platform name (optional)" },
    { name: "underlay_asn", label: "Underlay ASN", type: "number", placeholder: "e.g. 65001" },
    { name: "ssh_user", label: "SSH user", type: "text", placeholder: "e.g. admin" },
  ],
  zones: [
    { name: "name", label: "Name", type: "text", required: true, placeholder: "e.g. datacenter-a" },
  ],
};

// subRuleForms defines the form fields for adding sub-rules to spec types
// that support child entries.
const subRuleForms: Partial<Record<SpecKind, { endpoint: string; label: string; fields: FieldDef[] }>> = {
  "qos-policies": {
    endpoint: "queues",
    label: "Add queue",
    fields: [
      { name: "queue_id", label: "Queue ID", type: "number", required: true },
      { name: "name", label: "Queue name", type: "text", required: true },
      {
        name: "type", label: "Scheduling type", type: "select", required: true,
        options: ["strict", "wrr", "wfq", "dwrr"],
      },
      { name: "weight", label: "Weight", type: "number", placeholder: "0 = strict" },
    ],
  },
  filters: {
    endpoint: "rules",
    label: "Add rule",
    fields: [
      { name: "seq", label: "Sequence", type: "number", required: true, placeholder: "e.g. 10" },
      {
        name: "action", label: "Action", type: "select", required: true,
        options: ["permit", "deny"],
      },
      { name: "src_ip", label: "Source IP/prefix", type: "text", placeholder: "e.g. 10.0.0.0/8" },
      { name: "dst_ip", label: "Destination IP/prefix", type: "text", placeholder: "e.g. 0.0.0.0/0" },
      { name: "protocol", label: "Protocol", type: "text", placeholder: "e.g. tcp, udp" },
      { name: "src_port", label: "Source port", type: "text", placeholder: "e.g. 80" },
      { name: "dst_port", label: "Destination port", type: "text", placeholder: "e.g. 443" },
    ],
  },
  "prefix-lists": {
    endpoint: "entries",
    label: "Add prefix",
    fields: [
      { name: "prefix", label: "Prefix (CIDR)", type: "text", required: true, placeholder: "e.g. 10.0.0.0/8" },
    ],
  },
  "route-policies": {
    endpoint: "rules",
    label: "Add rule",
    fields: [
      { name: "seq", label: "Sequence", type: "number", required: true, placeholder: "e.g. 10" },
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

// buildFormFields renders input elements for each field definition.
function buildFormFields(fields: FieldDef[]): { form: HTMLFormElement; getValues: () => Record<string, unknown> } {
  const form = el("form", { className: "spec-form" });

  form.addEventListener("submit", (e) => e.preventDefault());

  for (const field of fields) {
    const group = el("div", { className: "form-group" });
    const label = el("label", { className: "form-label" }, field.label);
    if (field.required) {
      label.appendChild(el("span", { className: "form-required" }, " *"));
    }
    group.appendChild(label);

    if (field.type === "select" && field.options) {
      const select = el("select", { className: "form-control", id: "field-" + field.name }) as HTMLSelectElement;
      if (!field.required) {
        select.appendChild(el("option", { value: "" }, "— optional —") as HTMLOptionElement);
      }
      for (const opt of field.options) {
        select.appendChild(el("option", { value: opt }, opt) as HTMLOptionElement);
      }
      label.setAttribute("for", "field-" + field.name);
      group.appendChild(select);
    } else {
      const input = el("input", {
        className: "form-control",
        id: "field-" + field.name,
        type: field.type === "number" ? "number" : "text",
        placeholder: field.placeholder ?? "",
      }) as HTMLInputElement;
      if (field.required) input.required = true;
      label.setAttribute("for", "field-" + field.name);
      group.appendChild(input);
    }

    form.appendChild(group);
  }

  const getValues = (): Record<string, unknown> => {
    const values: Record<string, unknown> = {};
    for (const field of fields) {
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

  return { form, getValues };
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

  const { form, getValues } = buildFormFields(fields);
  content.appendChild(form);

  const errorOut = el("div", { className: "form-error-out" });
  content.appendChild(errorOut);

  const submitBtn = el("button", { type: "button", className: "form-submit-btn" }, "Create");
  content.appendChild(submitBtn);

  submitBtn.addEventListener("click", () => {
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
      container.appendChild(el("p", { className: "panel-empty" }, "none defined"));
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

// renderSubRuleSection renders the "Add rule/entry/queue" section inside the
// detail drawer for spec types that support child entries.
function renderSubRuleSection(kind: SpecKind, specName: string, content: HTMLElement, subRuleConf: typeof subRuleForms[SpecKind]): void {
  if (!subRuleConf) return;

  const section = el("section", { className: "subrule-section" });
  const heading = el("h3", { className: "subrule-heading" }, subRuleConf.label);
  section.appendChild(heading);

  const formArea = el("div", { className: "subrule-form-area" });
  let formVisible = false;

  const toggleBtn = el("button", { type: "button", className: "subrule-toggle-btn" }, "Show form");
  toggleBtn.addEventListener("click", () => {
    formVisible = !formVisible;
    formArea.hidden = !formVisible;
    toggleBtn.textContent = formVisible ? "Hide form" : "Show form";
  });
  section.appendChild(toggleBtn);

  formArea.hidden = true;

  const { form, getValues } = buildFormFields(subRuleConf.fields);
  formArea.appendChild(form);

  const errOut = el("div", { className: "form-error-out" });
  formArea.appendChild(errOut);

  const submitBtn = el("button", { type: "button", className: "form-submit-btn" }, subRuleConf.label);
  formArea.appendChild(submitBtn);

  submitBtn.addEventListener("click", async () => {
    errOut.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    try {
      const values = getValues();
      // Inject the parent spec name into the request body for sub-rule verbs
      // that require it (e.g. filter requires "filter": name, policy requires
      // "policy": name, etc.).
      const bodyWithParent = injectParentName(kind, specName, values);
      await addSubRule(kind, specName, subRuleConf.endpoint, bodyWithParent);
      submitBtn.textContent = subRuleConf.label;
      submitBtn.disabled = false;
      errOut.textContent = "";
      // Re-open the detail to refresh the spec payload.
      openDetail(kind, kindTitleFor(kind), specName);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = subRuleConf.label;
      if (err instanceof ApiError) {
        errOut.appendChild(el("p", { className: "panel-error" },
          translateErrorKind(err.kind) + ": " + err.message));
      } else {
        errOut.appendChild(el("p", { className: "panel-error" }, String(err)));
      }
    }
  });

  section.appendChild(formArea);
  content.appendChild(section);
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

// renderSubRuleDeleteSection renders existing rules/entries/queues with
// per-item delete affordances. Called after the detail renders.
function renderSubRuleDeleteSection(kind: SpecKind, specName: string, detail: unknown, content: HTMLElement): void {
  let items: unknown[] = [];
  let itemField = "";
  let removeKey = "";

  switch (kind) {
    case "qos-policies": {
      const d = detail as { queues?: unknown[] };
      items = d.queues ?? [];
      itemField = "queue_id";
      removeKey = "queue";
      break;
    }
    case "filters": {
      const d = detail as { rules?: unknown[] };
      items = d.rules ?? [];
      itemField = "seq";
      removeKey = "rule";
      break;
    }
    case "prefix-lists": {
      const d = detail as { prefixes?: unknown[] };
      items = d.prefixes ?? [];
      itemField = "";
      removeKey = "prefix";
      break;
    }
    case "route-policies": {
      const d = detail as { rules?: unknown[] };
      items = d.rules ?? [];
      itemField = "seq";
      removeKey = "rule";
      break;
    }
    default:
      return;
  }

  if (items.length === 0) return;

  const section = el("section", { className: "subrule-delete-section" });
  section.appendChild(el("h3", { className: "subrule-heading" }, "Existing " + removeKey + "s"));

  const list = el("ul", { className: "subrule-list" });

  for (const item of items) {
    const row = el("li", { className: "subrule-row" });

    // Identify the item: for array-of-strings (prefix-lists) the item is the
    // string itself; for objects use the itemField or show seq/queue_id.
    let label: string;
    let key: string | number;

    if (typeof item === "string") {
      label = item;
      key = item;
    } else {
      const obj = item as Record<string, unknown>;
      if (itemField && obj[itemField] !== undefined) {
        key = obj[itemField] as string | number;
        label = `${removeKey} ${key}`;
        if (obj["name"]) label += ` (${obj["name"]})`;
        if (obj["action"]) label += ` — ${obj["action"]}`;
      } else {
        label = JSON.stringify(item);
        key = label;
      }
    }

    row.appendChild(el("span", { className: "subrule-label" }, label));

    const delBtn = el("button", { type: "button", className: "subrule-delete-btn", title: "Remove " + label }, "×");
    delBtn.addEventListener("click", async () => {
      if (!window.confirm(`Remove ${label} from ${specName}?`)) return;
      delBtn.disabled = true;
      try {
        switch (kind) {
          case "qos-policies":
            await removeQoSQueue(specName, Number(key));
            break;
          case "filters":
            await removeFilterRule(specName, Number(key));
            break;
          case "prefix-lists":
            await removePrefixListEntry(specName, String(key));
            break;
          case "route-policies":
            await removeRoutePolicyRule(specName, Number(key));
            break;
        }
        // Re-open the detail to refresh.
        openDetail(kind, kindTitleFor(kind), specName);
      } catch (err) {
        delBtn.disabled = false;
        const msg = err instanceof ApiError
          ? translateErrorKind(err.kind) + ": " + err.message
          : String(err);
        alert("Remove failed: " + msg);
      }
    });

    row.appendChild(delBtn);
    list.appendChild(row);
  }

  section.appendChild(list);
  content.appendChild(section);
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
    const body = renderValue(detail);
    if (body instanceof HTMLElement) {
      body.classList.add("drawer-detail");
    }
    content.appendChild(body);

    // Render existing sub-rule items with delete affordances.
    const subRuleConf = subRuleForms[kind];
    if (subRuleConf) {
      renderSubRuleDeleteSection(kind, name, detail, content);
      renderSubRuleSection(kind, name, content, subRuleConf);
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
function layoutNodes(nodes: TopoNode[], cellW: number, perRowExtraH: number[]): Map<string, { cx: number; cy: number }> {
  const cols = Math.min(nodes.length, 4);
  const positions = new Map<string, { cx: number; cy: number }>();
  // Track the cumulative y-offset added by each row's tallest expansion band.
  let yCursor = V_GAP / 2;
  for (let r = 0; r * cols < nodes.length; r++) {
    const rowExtra = perRowExtraH[r] ?? 0;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= nodes.length) break;
      positions.set(nodes[i].name, {
        cx: (cellW + H_GAP) * c + cellW / 2 + H_GAP / 2,
        cy: yCursor + NODE_H / 2,
      });
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
  onlineByDevice?: Map<string, boolean>;
  onNodeDelete?: (name: string) => void;
  selected?: Set<string>;
  pendingByDevice?: Map<string, number>;  // count of unsaved-intent items per device
  // Staging overlays — render device cards in green/red according to queue state.
  isPendingAdd?: (name: string) => boolean;
  isPendingRemove?: (name: string) => boolean;
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

  const svg = svgEl("svg", {
    width: String(svgW),
    height: String(svgH),
    viewBox: `0 0 ${svgW} ${svgH}`,
    "class": "topology-graph",
    role: "img",
    "aria-label": "Network topology diagram",
  });

  const positions = layoutNodes(nodes, cellW, perRowExtraH);

  // Draw links first (under nodes).
  for (const link of links) {
    const from = link.local_device ? positions.get(link.local_device) : undefined;
    const to = link.remote_device ? positions.get(link.remote_device) : undefined;
    if (!from || !to) continue;
    const line = svgEl("line", {
      "class": "topo-link",
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
    const onlineState = opts.onlineByDevice?.get(node.name);
    // unknown (probe still in flight or not run) → no class; online → green; offline → grey
    const onlineClass = onlineState === true ? " topo-node--online"
                      : onlineState === false ? " topo-node--offline"
                      : "";

    const g = svgEl("g", {
      "class": "topo-node"
        + (isSelected ? " topo-node--selected" : "")
        + (pendingCount > 0 ? " topo-node--pending" : "")
        + (isPendingAdd ? " topo-node--pending-add" : "")
        + (isPendingRemove ? " topo-node--pending-del" : "")
        + onlineClass,
      role: "button",
      tabindex: "0",
      "aria-label": `Device ${node.name}`,
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

    g.addEventListener("click", (e) => {
      e.stopPropagation();
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

    // Online/offline indicator — small status dot in the bottom-left.
    if (onlineState !== undefined) {
      const sx = pos.cx - NODE_W / 2 + 8;
      const sy = pos.cy + NODE_H / 2 - 8;
      const dot = svgEl("g", { "class": "topo-online-badge" });
      dot.appendChild(svgEl("circle", {
        cx: String(sx), cy: String(sy), r: "5",
        "class": onlineState ? "topo-online-dot topo-online-dot--ok" : "topo-online-dot topo-online-dot--off",
      }));
      const t = svgEl("title");
      t.textContent = onlineState ? `${node.name} is online` : `${node.name} is offline`;
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
    const driftCount = opts.driftByDevice?.get(node.name) ?? 0;
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

  return { svg, positions, width: svgW, height: svgH };
}

// ---- Node inspector drawer --------------------------------------------------

// NODE_TABS defines the sub-tabs in operator-domain words (no internal jargon
// vocabulary, per vocabulary discipline in the slice spec).
const NODE_TABS = [
  { id: "overview",  label: "Overview" },
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

// renderValueInto places renderValue output into a container, adding .drawer-detail.
function renderValueInto(container: HTMLElement, data: unknown): void {
  container.textContent = "";
  const body = renderValue(data);
  if (body instanceof HTMLElement) {
    body.classList.add("drawer-detail");
  }
  container.appendChild(body);
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

  const { form, getValues } = buildFormFields(fields);
  content.appendChild(form);

  const errorOut = el("div", { className: "form-error-out" });
  content.appendChild(errorOut);

  const submitBtn = el("button", { type: "button", className: "form-submit-btn" }, "Bind service");
  content.appendChild(submitBtn);

  submitBtn.addEventListener("click", async () => {
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
      if (err instanceof ApiError) {
        errorOut.appendChild(el("p", { className: "panel-error" },
          translateErrorKind(err.kind) + ": " + err.message));
      } else {
        errorOut.appendChild(el("p", { className: "panel-error" }, String(err)));
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
              fetch("/api/services", { cache: "no-store" })
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

// openAddDeviceDrawer opens the detail drawer with a form to add a device.
// onSuccess is called after the device is added to refresh the topology.
function openAddDeviceDrawer(onSuccess: () => void): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

  content.appendChild(el("p", { className: "drawer-kind" }, "Topology"));
  content.appendChild(el("h2", { className: "drawer-name" }, "Add device"));

  const fields: FieldDef[] = [
    { name: "name", label: "Device name", type: "text", required: true, placeholder: "e.g. spine1" },
  ];
  const { form, getValues } = buildFormFields(fields);
  content.appendChild(form);

  const errorOut = el("div", { className: "form-error-out" });
  content.appendChild(errorOut);

  const submitBtn = el("button", { type: "button", className: "form-submit-btn" }, "Add device");
  content.appendChild(submitBtn);

  submitBtn.addEventListener("click", async () => {
    errorOut.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Queued";
    try {
      const values = getValues();
      const name = values["name"] as string;
      if (!name) {
        errorOut.appendChild(el("p", { className: "panel-error" }, "Device name is required."));
        submitBtn.disabled = false;
        submitBtn.textContent = "Add device";
        return;
      }
      // Stage rather than POST. Final body is materialised on Save.
      enqueueTopologyAddDevice(name, { steps: [], ports: {} });
      content.insertBefore(el("p", { className: "form-success" }, "Device queued (green). Click Save in the header to apply."), submitBtn);
      onSuccess();
      setTimeout(() => {
        drawer.setAttribute("aria-hidden", "true");
        drawer.classList.remove("open");
      }, 800);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Add device";
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

// ---- Topology tab -----------------------------------------------------------

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

    // Build toolbar with Add device and Add link buttons.
    const toolbar = el("div", { className: "topology-toolbar" });

    const addDeviceBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "+ Add device");
    addDeviceBtn.addEventListener("click", () => {
      openAddDeviceDrawer(() => mountTopologyTab(root));
    });
    toolbar.appendChild(addDeviceBtn);

    const addLinkBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "+ Add link");
    addLinkBtn.addEventListener("click", () => {
      // Pass known device names; interface names pre-populated as empty (lazy).
      openAddLinkDrawer(deviceNames, new Map(), () => mountTopologyTab(root));
    });
    toolbar.appendChild(addLinkBtn);

    root.appendChild(toolbar);

    // Persistent UI state: which nodes are selected; the docked panel reads
    // this and renders the action set + Save/Discard for the selection.
    const selected: Set<string> = new Set();

    // Topology view: layout is a split — left = SVG diagram, right = docked
    // action panel. Both stay in sync via re-renders driven by `selected`.
    const split = el("div", { className: "topology-split" });
    const graphSlot = el("div", { className: "topology-graph-slot" });
    const panelRoot = el("aside", { className: "topo-action-panel" });
    split.appendChild(graphSlot);
    split.appendChild(panelRoot);
    root.appendChild(split);

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

    const renderGraph = (): void => {
      graphSlot.textContent = "";
      const result = renderTopologySVG(topoData, {
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
        onlineByDevice,
        onNodeDelete: (deviceName) => {
          // Stage the remove rather than fire immediately; toggles if already queued.
          enqueueTopologyRemoveDevice(deviceName);
          mountTopologyTab(root);
        },
        selected,
        isPendingAdd: (n) => pendingDeviceAdds.some((p) => p.name === n),
        isPendingRemove: (n) => isDevicePendingRemove(n),
      });
      graphSlot.appendChild(result.svg);
    };

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

    renderGraph();
    renderPanel();

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

// ---- Lab tab ----------------------------------------------------------------

// mountLabTab renders the Lab tab: list labs with status badges, and
// per-lab Deploy / Destroy / Provision buttons plus per-node Start/Stop.
// Deploy opens an SSE log panel streaming phase events in real time.
async function mountLabTab(root: HTMLElement): Promise<void> {
  root.textContent = "";
  root.appendChild(el("p", { className: "status-loading" }, "Loading labs…"));

  let labs: LabListItem[];
  try {
    labs = await fetchLabs();
  } catch (err) {
    root.textContent = "";
    root.appendChild(el("p", { className: "topology-error" }, "Could not reach the lab server."));
    if (err instanceof Error) {
      root.appendChild(el("p", { className: "panel-error-detail" }, err.message));
    }
    return;
  }

  root.textContent = "";

  if (labs.length === 0) {
    root.appendChild(el("p", { className: "topology-empty" }, "No labs found."));
    return;
  }

  // Render one card per lab.
  for (const lab of labs) {
    const card = el("section", { className: "lab-card" });
    card.appendChild(el("h2", { className: "lab-card-title" }, lab.name));

    // Status section — loaded lazily.
    const statusDiv = el("div", { className: "lab-card-status" });
    statusDiv.textContent = "Loading status…";
    card.appendChild(statusDiv);

    // Node list section — populated after status load.
    const nodesDiv = el("div", { className: "lab-card-nodes" });
    card.appendChild(nodesDiv);

    // SSE log panel — shown when Deploy is clicked.
    const logPanel = el("div", { className: "lab-card-log" });
    logPanel.hidden = true;
    card.appendChild(logPanel);

    // Action buttons row.
    const actions = el("div", { className: "lab-card-actions" });

    const deployBtn = el("button", { type: "button", className: "lab-btn lab-btn--primary" }, "Deploy");
    const destroyBtn = el("button", { type: "button", className: "lab-btn lab-btn--danger" }, "Destroy");
    const provisionBtn = el("button", { type: "button", className: "lab-btn" }, "Provision");

    actions.appendChild(deployBtn);
    actions.appendChild(destroyBtn);
    actions.appendChild(provisionBtn);
    card.appendChild(actions);

    root.appendChild(card);

    // Load status and render node list.
    const loadStatus = async (): Promise<void> => {
      try {
        const state = await fetchLabStatus(lab.name);
        renderLabStatus(statusDiv, state);
        renderLabNodes(nodesDiv, logPanel, lab.name, state);
      } catch (err) {
        statusDiv.textContent = "";
        statusDiv.appendChild(el("span", { className: "lab-status lab-status--unknown" }, "status unavailable"));
        if (err instanceof Error) {
          statusDiv.appendChild(el("span", { className: "lab-status-detail" }, " — " + err.message));
        }
        nodesDiv.textContent = "";
      }
    };

    loadStatus();

    // Deploy: open SSE log panel and stream events.
    deployBtn.addEventListener("click", () => {
      logPanel.hidden = false;
      logPanel.textContent = "";
      logPanel.appendChild(el("p", { className: "lab-log-header" }, "Deploying " + lab.name + "…"));

      const logLines = el("pre", { className: "lab-log-lines" });
      logPanel.appendChild(logLines);

      let src: EventSource | null = null;

      const startDeploy = async (): Promise<void> => {
        try {
          await postLabDeploy(lab.name, {});
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logLines.textContent += `\n[error] deploy failed: ${msg}`;
          return;
        }

        src = labEvents(
          lab.name,
          (eventType, data) => {
            try {
              const payload = JSON.parse(data) as Record<string, unknown>;
              if (eventType === "phase") {
                const phase = String(payload["phase"] ?? "");
                const detail = payload["detail"] ? " — " + String(payload["detail"]) : "";
                logLines.textContent += `\n${phase}${detail}`;
              } else if (eventType === "complete") {
                logLines.textContent += "\n[done] deploy complete";
                src?.close();
                loadStatus();
              } else if (eventType === "error") {
                logLines.textContent += "\n[error] " + String(payload["message"] ?? data);
                src?.close();
              }
            } catch {
              logLines.textContent += "\n" + data;
            }
          },
          () => {
            // SSE connection closed or error — could be normal end-of-stream.
            src?.close();
          },
        );
      };

      startDeploy();
    });

    // Destroy: gate with confirm to prevent accidental teardown.
    destroyBtn.addEventListener("click", () => {
      if (!window.confirm(`Destroy lab "${lab.name}"? This tears down all VMs and links.`)) return;
      destroyBtn.disabled = true;
      destroyBtn.textContent = "Destroying…";
      postLabDestroy(lab.name)
        .then(() => {
          destroyBtn.textContent = "Destroy";
          destroyBtn.disabled = false;
          loadStatus();
        })
        .catch((err) => {
          destroyBtn.textContent = "Destroy";
          destroyBtn.disabled = false;
          const msg = err instanceof Error ? err.message : String(err);
          alert("Destroy failed: " + msg);
        });
    });

    // Provision: run post-deploy provisioning pass.
    provisionBtn.addEventListener("click", () => {
      provisionBtn.disabled = true;
      provisionBtn.textContent = "Provisioning…";
      postLabProvision(lab.name)
        .then(() => {
          provisionBtn.textContent = "Provision";
          provisionBtn.disabled = false;
          loadStatus();
        })
        .catch((err) => {
          provisionBtn.textContent = "Provision";
          provisionBtn.disabled = false;
          const msg = err instanceof Error ? err.message : String(err);
          alert("Provision failed: " + msg);
        });
    });
  }
}

// renderLabStatus writes a status badge into statusDiv from a LabState.
function renderLabStatus(statusDiv: HTMLElement, state: LabState): void {
  statusDiv.textContent = "";
  const nodes = Object.values(state.nodes ?? {});
  const running = nodes.filter((n) => n.status === "running").length;
  const total = nodes.length;

  let statusClass = "lab-status--stopped";
  let statusText = "stopped";
  if (running === total && total > 0) {
    statusClass = "lab-status--running";
    statusText = `running (${running}/${total} nodes)`;
  } else if (running > 0) {
    statusClass = "lab-status--partial";
    statusText = `partial (${running}/${total} nodes running)`;
  }

  const badge = el("span", { className: "lab-status " + statusClass }, statusText);
  statusDiv.appendChild(badge);
}

// renderLabNodes writes per-node Start/Stop buttons into nodesDiv.
function renderLabNodes(
  nodesDiv: HTMLElement,
  _logPanel: HTMLElement,
  lab: string,
  state: LabState,
): void {
  nodesDiv.textContent = "";
  const nodeEntries = Object.entries(state.nodes ?? {});
  if (nodeEntries.length === 0) {
    nodesDiv.appendChild(el("p", { className: "lab-nodes-empty" }, "No nodes."));
    return;
  }

  const list = el("ul", { className: "lab-nodes-list" });
  for (const [nodeName, nodeState] of nodeEntries) {
    const item = el("li", { className: "lab-node-item" });

    const nameSpan = el("span", { className: "lab-node-name" }, nodeName);
    const stateClass = nodeState.status === "running"
      ? "lab-node-status--running"
      : "lab-node-status--stopped";
    const stateSpan = el("span", { className: "lab-node-status " + stateClass }, nodeState.status);

    item.appendChild(nameSpan);
    item.appendChild(stateSpan);

    if (nodeState.status === "stopped" || nodeState.status === "error") {
      const startBtn = el("button", { type: "button", className: "lab-btn lab-btn--sm lab-btn--primary" }, "Start");
      startBtn.addEventListener("click", () => {
        startBtn.disabled = true;
        startBtn.textContent = "Starting…";
        postLabStartNode(lab, nodeName)
          .then(() => {
            // Reload the parent card status to refresh all node states.
            fetchLabStatus(lab)
              .then((s) => {
                const parentCard = nodesDiv.closest(".lab-card");
                const statusDiv = parentCard?.querySelector(".lab-card-status") as HTMLElement | null;
                if (statusDiv) renderLabStatus(statusDiv, s);
                renderLabNodes(nodesDiv, _logPanel, lab, s);
              })
              .catch(() => {
                startBtn.textContent = "Start";
                startBtn.disabled = false;
              });
          })
          .catch((err) => {
            startBtn.textContent = "Start";
            startBtn.disabled = false;
            const msg = err instanceof Error ? err.message : String(err);
            alert("Start node failed: " + msg);
          });
      });
      item.appendChild(startBtn);
    }

    if (nodeState.status === "running") {
      const stopBtn = el("button", { type: "button", className: "lab-btn lab-btn--sm lab-btn--danger" }, "Stop");
      stopBtn.addEventListener("click", () => {
        if (!window.confirm(`Stop node "${nodeName}" in lab "${lab}"?`)) return;
        stopBtn.disabled = true;
        stopBtn.textContent = "Stopping…";
        postLabStopNode(lab, nodeName)
          .then(() => {
            fetchLabStatus(lab)
              .then((s) => {
                const parentCard = nodesDiv.closest(".lab-card");
                const statusDiv = parentCard?.querySelector(".lab-card-status") as HTMLElement | null;
                if (statusDiv) renderLabStatus(statusDiv, s);
                renderLabNodes(nodesDiv, _logPanel, lab, s);
              })
              .catch(() => {
                stopBtn.textContent = "Stop";
                stopBtn.disabled = false;
              });
          })
          .catch((err) => {
            stopBtn.textContent = "Stop";
            stopBtn.disabled = false;
            const msg = err instanceof Error ? err.message : String(err);
            alert("Stop node failed: " + msg);
          });
      });
      item.appendChild(stopBtn);
    }

    list.appendChild(item);
  }
  nodesDiv.appendChild(list);
}

// ---- Tab switching ----------------------------------------------------------

function setupTabs(): void {
  const tabSpecs = document.getElementById("tab-specs");
  const tabTopology = document.getElementById("tab-topology");
  const tabLab = document.getElementById("tab-lab");
  const panelSpecs = document.getElementById("panel-specs");
  const panelTopology = document.getElementById("panel-topology");
  const panelLab = document.getElementById("panel-lab");

  if (!tabSpecs || !tabTopology || !tabLab || !panelSpecs || !panelTopology || !panelLab) return;

  let topologyMounted = false;

  type TabName = "specs" | "topology" | "lab";

  const activateTab = (name: TabName): void => {
    const isSpecs = name === "specs";
    const isTopology = name === "topology";
    const isLab = name === "lab";

    tabSpecs.classList.toggle("workspace-tab--active", isSpecs);
    tabSpecs.setAttribute("aria-selected", isSpecs ? "true" : "false");
    tabTopology.classList.toggle("workspace-tab--active", isTopology);
    tabTopology.setAttribute("aria-selected", isTopology ? "true" : "false");
    tabLab.classList.toggle("workspace-tab--active", isLab);
    tabLab.setAttribute("aria-selected", isLab ? "true" : "false");

    (panelSpecs as HTMLElement).hidden = !isSpecs;
    (panelTopology as HTMLElement).hidden = !isTopology;
    (panelLab as HTMLElement).hidden = !isLab;

    if (isTopology && !topologyMounted) {
      topologyMounted = true;
      mountTopologyTab(panelTopology as HTMLElement);
    }

    if (isLab) {
      mountLabTab(panelLab as HTMLElement);
    }
  };

  tabSpecs.addEventListener("click", () => activateTab("specs"));
  tabTopology.addEventListener("click", () => activateTab("topology"));
  tabLab.addEventListener("click", () => activateTab("lab"));
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

mount();
