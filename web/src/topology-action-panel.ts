// topology-action-panel.ts — docked second-panel on the left of the topology
// workspace. Replaces the floating context menu for the primary editing flow.
//
// Drives:
//   - per-device pending-changes summary + Save / Discard
//   - per-device action catalog (newtron POST endpoints, grouped)
//   - per-interface action catalog (visible after picking an interface)
//   - common-set actions on multi-select
//   - 2-device link form
//   - dynamic source dropdowns (services, vpns, vrfs, …) for autofill
//
// All forms POST through the same generic catch-all (NodeRPC / InterfaceRPC).

import { iconSVG } from "./icons.js";
import { apiFetch, apiSend } from "./api/newtcon/_transport.js";
import { apiPath } from "./api-path.js";
import { formatErrorBrief as formatError } from "./render-error.js";
import { confirmInline } from "./confirm-inline.js";
import { showToast } from "./toast.js";
import {
  NODE_ACTIONS,
  INTERFACE_ACTIONS,
  type ActionDef,
  type ActionField,
  type ActionGroup,
} from "./topology-actions.js";
import {
  enqueueDeviceAction,
  enqueueInterfaceAction,
  deviceQueue,
  applyDevice,
  discardDevice,
  describePending,
} from "./staging.js";
import { comparePorts } from "./port-config.js";

// ---- HTTP plumbing --------------------------------------------------------

export async function postNodeRPC(device: string, subpath: string, body: Record<string, unknown>): Promise<unknown> {
  return apiSend(apiPath(`nodes/${encodeURIComponent(device)}/rpc/${subpath}`), "POST", body ?? {});
}

export async function postInterfaceRPC(device: string, iface: string, subpath: string, body: Record<string, unknown>): Promise<unknown> {
  return apiSend(
    apiPath(`nodes/${encodeURIComponent(device)}/interfaces/${encodeURIComponent(iface)}/rpc/${subpath}`),
    "POST",
    body ?? {},
  );
}

// ---- Source-fetch cache (autofill dropdowns) ------------------------------
//
// A "source" string declares where an enum dropdown should pull its options
// from. Some sources are network-scoped (e.g. "services"), others are
// device-scoped (e.g. "vrfs:<device>"). The cache lives for the panel session
// and is invalidated whenever the panel is rebuilt after a write.

const sourceCache: Map<string, string[]> = new Map();

export function invalidateSourceCache(prefix?: string): void {
  if (!prefix) { sourceCache.clear(); return; }
  for (const k of Array.from(sourceCache.keys())) {
    if (k.startsWith(prefix)) sourceCache.delete(k);
  }
}

async function fetchSource(source: string): Promise<string[]> {
  if (sourceCache.has(source)) return sourceCache.get(source)!;

  const [kind, scope] = source.includes(":") ? source.split(":") : [source, ""];
  const url = sourceURL(kind, scope);
  if (!url) return [];
  try {
    const data = await apiFetch(url);
    const names = extractNames(data);
    sourceCache.set(source, names);
    return names;
  } catch {
    return [];
  }
}

function sourceURL(kind: string, scope: string): string | null {
  switch (kind) {
    case "services":     return apiPath("services");
    case "ipvpns":       return apiPath("ipvpns");
    case "macvpns":      return apiPath("macvpns");
    case "qos-policies": return apiPath("qos-policies");
    case "filters":      return apiPath("filters");
    case "route-policies": return apiPath("route-policies");
    case "prefix-lists": return apiPath("prefix-lists");
    case "interfaces":   return scope ? apiPath(`nodes/${encodeURIComponent(scope)}/interfaces`) : null;
    case "vrfs":         return scope ? apiPath(`nodes/${encodeURIComponent(scope)}/vrfs`) : null;
    case "vlans":        return scope ? apiPath(`nodes/${encodeURIComponent(scope)}/vlans`) : null;
    case "acls":         return scope ? apiPath(`nodes/${encodeURIComponent(scope)}/acls`) : null;
    case "lags":         return scope ? apiPath(`nodes/${encodeURIComponent(scope)}/lags`) : null;
    default:             return null;
  }
}

function extractNames(data: unknown): string[] {
  if (Array.isArray(data)) {
    return data
      .map((it) => typeof it === "string" ? it
        : typeof (it as { name?: unknown }).name === "string" ? (it as { name: string }).name
        : typeof (it as { id?: unknown }).id !== "undefined" ? String((it as { id: unknown }).id)
        : null)
      .filter((n): n is string => typeof n === "string");
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["items", "interfaces", "vrfs", "vlans", "acls", "services", "names", "data"]) {
      if (Array.isArray(obj[key])) return extractNames(obj[key]);
    }
    return Object.keys(obj).sort();
  }
  return [];
}

// ---- Action panel state ---------------------------------------------------

export interface PanelSelection {
  devices: string[];   // selected device names (0 .. N)
  iface?: { device: string; name: string }; // when an interface is selected
}

export interface PanelDeps {
  panelRoot: HTMLElement;          // container element to render into
  topology: TopologyView;          // resolves device → interface list + type
  onChange: () => void;            // request a topology re-render
  onLinkRequest: (a: string, z: string) => void; // called when "Link" is clicked
}

// TopologyView is the minimal interface the panel needs into the topology data
// loaded by the main view. It pulls interface lists from the topology
// declaration (works even when the device is offline) and device "type" so
// the panel can decide which actions apply.
export interface TopologyView {
  interfacesFor(device: string): string[];
  deviceType(device: string): string;
}

// ---- Render ---------------------------------------------------------------

export function renderActionPanel(sel: PanelSelection, deps: PanelDeps): void {
  const root = deps.panelRoot;
  root.textContent = "";
  root.classList.toggle("topo-action-panel--empty", sel.devices.length === 0 && !sel.iface);

  // Header section (selection summary).
  root.appendChild(renderHeader(sel));

  if (sel.devices.length === 0 && !sel.iface) {
    const empty = el("div", { className: "topo-action-panel-empty" });
    empty.innerHTML = `<p>Click a device to act on it.</p>
      <p class="topo-action-panel-empty-hint">Shift-click to multi-select · Right-click for floating menu</p>`;
    root.appendChild(empty);
    return;
  }

  // 2-device link affordance (when exactly 2 devices and no interface).
  if (sel.devices.length === 2 && !sel.iface) {
    root.appendChild(renderLinkSection(sel.devices[0], sel.devices[1], deps));
  }

  // Interface action set (when an interface is selected).
  if (sel.iface) {
    root.appendChild(renderActionSection(
      INTERFACE_ACTIONS,
      { kind: "interface", device: sel.iface.device, iface: sel.iface.name },
      deps,
    ));
    appendQueuedForDevice(root, sel.iface.device);
    appendSaveDiscardRow(root, sel, deps);
    return;
  }

  // Multi-device action set — intersection of actions valid for all selected.
  if (sel.devices.length > 1) {
    const common = intersectActions(NODE_ACTIONS, sel.devices, deps.topology);
    const hint = el("p", { className: "topo-action-panel-hint" },
      `Showing actions available on all ${sel.devices.length} selected devices.`);
    root.appendChild(hint);
    if (common.length > 0) {
      root.appendChild(renderActionSection(
        common,
        { kind: "node-multi", devices: sel.devices },
        deps,
      ));
    } else {
      root.appendChild(el("p", { className: "topo-action-panel-empty-hint" },
        "Port mode and service binding are per-interface. Click an interface on one of the selected devices to configure it."));
    }
    appendSaveDiscardRow(root, sel, deps);
    return;
  }

  // Single-device action set. Per the "services only" scope, NODE_ACTIONS is
  // empty by design — service composition happens in the Specs tab, and
  // services apply at the interface level. Surface a hint pointing at the
  // interface list above instead of an empty "Actions" header.
  const device = sel.devices[0];
  root.appendChild(renderInterfacesTab(device, deps));
  if (NODE_ACTIONS.length > 0) {
    root.appendChild(renderActionSection(
      NODE_ACTIONS,
      { kind: "node", device },
      deps,
    ));
  } else {
    root.appendChild(el("p", { className: "topo-action-panel-empty-hint" },
      "Click an interface above to set its port mode (access / trunk / routed) and bind services. Compose new services in the Specs tab."));
  }
  appendQueuedForDevice(root, device);
  appendSaveDiscardRow(root, sel, deps);
}

// Shows the operator the queued changes scoped to this device, with green
// (add/modify) or red (remove) styling, so they can verify before Apply.
function appendQueuedForDevice(root: HTMLElement, device: string): void {
  const items = deviceQueue(device);
  if (items.length === 0) return;
  const section = el("section", { className: "topo-action-panel-section topo-action-panel-section--queued" });
  section.appendChild(el("h3", { className: "topo-action-panel-section-title" },
    `Queued for ${device} (${items.length})`));
  const list = el("ul", { className: "topo-queued-list" });
  for (const p of items) {
    const row = el("li", { className: "topo-queued-item" + ((p as { danger?: boolean }).danger ? " topo-queued-item--danger" : " topo-queued-item--add") });
    row.appendChild(el("span", { className: "topo-queued-item-label" }, describePending(p)));
    list.appendChild(row);
  }
  section.appendChild(list);
  root.appendChild(section);
}

// ---- Header --------------------------------------------------------------

function renderHeader(sel: PanelSelection): HTMLElement {
  const header = el("div", { className: "topo-action-panel-header" });

  let title: string;
  let kindLabel: string;
  let iconName: string;
  if (sel.iface) {
    title = `${sel.iface.device} · ${sel.iface.name}`;
    kindLabel = "Interface";
    iconName = "network";
  } else if (sel.devices.length === 0) {
    title = "Topology";
    kindLabel = "No selection";
    iconName = "list";
  } else if (sel.devices.length === 1) {
    title = sel.devices[0];
    kindLabel = "Device";
    iconName = "server";
  } else {
    title = `${sel.devices.length} devices`;
    kindLabel = "Multi-select";
    iconName = "server";
  }

  header.innerHTML = `
    <div class="topo-action-panel-kind">${escapeHtml(kindLabel)}</div>
    <div class="topo-action-panel-title">
      <span class="topo-action-panel-title-icon">${iconSVG(iconName)}</span>
      <span class="topo-action-panel-title-text">${escapeHtml(title)}</span>
    </div>`;

  return header;
}

// Adds the Apply/Discard row at the bottom of the panel (after actions),
// so the operator sees it after queueing some changes.
function appendSaveDiscardRow(root: HTMLElement, sel: PanelSelection, deps: PanelDeps): void {
  if (sel.devices.length >= 1 && !sel.iface) {
    root.appendChild(renderSaveDiscardRow(sel.devices, () => deps.onChange()));
  }
}

// ---- Apply / Discard (per-device, client-side queue) --------------------
//
// "Apply changes" runs the workspace queue items targeting this device(s)
// against newtron. "Discard changes" drops those queue items from the client
// queue without calling newtron.

function renderSaveDiscardRow(devices: string[], onChanged: () => void): HTMLElement {
  const row = el("div", { className: "topo-action-panel-savebar" });

  // Count queued items targeting these devices so the button shows a badge.
  let queued = 0;
  for (const d of devices) queued += deviceQueue(d).length;

  const applyBtn = el("button", { type: "button", className: "btn btn-primary btn-sm" + (queued === 0 ? " btn-disabled" : "") },
    queued > 0 ? `Apply changes (${queued})` : "Apply changes");
  if (queued === 0) applyBtn.setAttribute("disabled", "");
  applyBtn.addEventListener("click", async () => {
    if (queued === 0) return;
    const ok = await confirmInline({
      title: devices.length === 1
        ? `Apply ${queued} change${queued === 1 ? "" : "s"} on ${devices[0]}?`
        : `Apply ${queued} change${queued === 1 ? "" : "s"} across ${devices.length} devices?`,
      body: "Changes are sent to newtron and modify the running device(s).",
      confirmLabel: "Apply",
    });
    if (!ok) return;
    applyBtn.setAttribute("disabled", "");
    applyBtn.textContent = "Applying…";
    const errs: string[] = [];
    for (const d of devices) {
      const r = await applyDevice(d);
      for (const f of r.failed) errs.push(`${describePending(f.pending)}: ${f.error}`);
    }
    if (errs.length > 0) {
      showToast({
        kind: "error",
        title: `${errs.length} change${errs.length === 1 ? "" : "s"} failed to apply`,
        body: errs.join("\n"),
      });
    }
    onChanged();
  });
  row.appendChild(applyBtn);

  const discardBtn = el("button", { type: "button", className: "btn btn-danger btn-sm" + (queued === 0 ? " btn-disabled" : "") },
    "Discard changes");
  if (queued === 0) discardBtn.setAttribute("disabled", "");
  discardBtn.addEventListener("click", async () => {
    if (queued === 0) return;
    const ok = await confirmInline({
      title: devices.length === 1
        ? `Discard ${queued} change${queued === 1 ? "" : "s"} for ${devices[0]}?`
        : `Discard ${queued} change${queued === 1 ? "" : "s"} across ${devices.length} devices?`,
      body: "Nothing is sent to newtron.",
      danger: true,
      confirmLabel: "Discard",
    });
    if (!ok) return;
    for (const d of devices) discardDevice(d);
    onChanged();
  });
  row.appendChild(discardBtn);
  return row;
}

// ---- Link form (multi-select 2 devices) ----------------------------------

function renderLinkSection(a: string, z: string, deps: PanelDeps): HTMLElement {
  const section = el("section", { className: "topo-action-panel-section topo-action-panel-section--highlight" });
  section.appendChild(el("h3", { className: "topo-action-panel-section-title" }, "Connect devices"));

  const form = el("form", { className: "topo-action-form" });
  const aIfaces = deps.topology.interfacesFor(a);
  const zIfaces = deps.topology.interfacesFor(z);

  const aField = renderFormField({
    name: "a", label: `${a} interface`, type: "select", required: true,
    options: aIfaces.map((i) => ({ value: i, label: i })),
  });
  const zField = renderFormField({
    name: "z", label: `${z} interface`, type: "select", required: true,
    options: zIfaces.map((i) => ({ value: i, label: i })),
  });
  form.appendChild(aField.group);
  form.appendChild(zField.group);

  const err = el("div", { className: "form-error-out" });
  form.appendChild(err);

  const actions = el("div", { className: "topo-action-form-actions" });
  const submit = el("button", { type: "submit", className: "btn btn-primary btn-sm" }, "Add link");
  actions.appendChild(submit);
  form.appendChild(actions);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const aIface = aField.value();
    const zIface = zField.value();
    if (!aIface || !zIface) {
      err.appendChild(panelError("Both interfaces are required."));
      return;
    }
    submit.disabled = true;
    submit.textContent = "Adding…";
    try {
      await apiSend(apiPath("topology/links"), "POST", { a: `${a}:${aIface}`, z: `${z}:${zIface}` });
      deps.onLinkRequest(a, z);
      deps.onChange();
    } catch (e) {
      submit.disabled = false;
      submit.textContent = "Add link";
      err.appendChild(panelError(formatError(e)));
    }
  });

  section.appendChild(form);
  return section;
}

// ---- Interfaces tab ------------------------------------------------------

function renderInterfacesTab(device: string, deps: PanelDeps): HTMLElement {
  const section = el("section", { className: "topo-action-panel-section topo-action-panel-section--ifaces" });

  const titleRow = el("div", { className: "topo-action-panel-section-title-row" });
  titleRow.appendChild(el("h3", { className: "topo-action-panel-section-title" }, "Interfaces"));
  const count = el("span", { className: "topo-action-panel-section-count" });
  titleRow.appendChild(count);
  section.appendChild(titleRow);

  const list = el("div", { className: "topo-iface-list" });
  section.appendChild(list);

  // Pull from the topology declaration first (works offline), then try the
  // live endpoint and merge any extras (which carries live admin/oper state).
  const topoPorts = deps.topology.interfacesFor(device);
  count.textContent = `${topoPorts.length}`;
  for (const iface of topoPorts) {
    list.appendChild(renderInterfaceChip(device, iface, deps));
  }

  // Fire a live-state refresh that may add detail later. Any live ports not in
  // the topology declaration are appended in numeric order (comparePorts), so
  // the list stays low→high rather than lexicographic.
  fetchSource(`interfaces:${device}`).then((live) => {
    const known = new Set(topoPorts);
    const extras = live.filter((iface) => !known.has(iface)).sort(comparePorts);
    for (const iface of extras) {
      list.appendChild(renderInterfaceChip(device, iface, deps));
    }
    count.textContent = `${list.querySelectorAll(".topo-iface-chip").length}`;
  });

  // Port-config authoring moved to the device drawer's Interfaces tab
  // ("Properties" action) — the drawer is the single home for per-port config
  // (mode, service, and physical properties). See openPortPropsForm in app.ts.

  return section;
}

function renderInterfaceChip(device: string, iface: string, deps: PanelDeps): HTMLElement {
  const chip = el("button", {
    type: "button",
    className: "topo-iface-chip",
    title: `Open actions for ${iface}`,
  }, iface);
  chip.addEventListener("click", () => {
    renderActionPanel({ devices: [device], iface: { device, name: iface } }, deps);
  });
  return chip;
}

// ---- Action sections -----------------------------------------------------

type ActionTarget =
  | { kind: "node"; device: string }
  | { kind: "node-multi"; devices: string[] }
  | { kind: "interface"; device: string; iface: string };

function renderActionSection(groups: ActionGroup[], target: ActionTarget, deps: PanelDeps): HTMLElement {
  const section = el("section", { className: "topo-action-panel-section" });
  section.appendChild(el("h3", { className: "topo-action-panel-section-title" }, "Actions"));

  for (const group of groups) {
    const groupEl = el("details", { className: "topo-action-group", open: false });
    const summary = el("summary", { className: "topo-action-group-summary" }, group.group);
    groupEl.appendChild(summary);

    for (const action of group.items) {
      const item = el("button", {
        type: "button",
        className: "topo-action-item" + (action.danger ? " topo-action-item--danger" : ""),
      });
      item.innerHTML = `
        <span class="topo-action-item-icon">${iconSVG(action.icon || "arrow-right")}</span>
        <span class="topo-action-item-label">${escapeHtml(action.label)}</span>
        ${(action.fields ?? []).length > 0 ? '<span class="topo-action-item-hint">…</span>' : ""}`;
      item.addEventListener("click", () => openActionForm(action, target, item, deps));
      groupEl.appendChild(item);
    }

    section.appendChild(groupEl);
  }
  return section;
}

// ---- Action form (inline) ------------------------------------------------

function openActionForm(action: ActionDef, target: ActionTarget, anchor: HTMLElement, deps: PanelDeps): void {
  // Remove any previously open inline form (one at a time keeps things clear).
  document.querySelectorAll(".topo-inline-form").forEach((el) => el.remove());

  // No-fields path: confirm + queue (do not POST). Apply changes runs the queue.
  if ((action.fields ?? []).length === 0) {
    void queueActionWithConfirm(action, target, {}, () => {
      flash(anchor, "Queued");
      deps.onChange();
    });
    return;
  }

  const formWrap = el("div", { className: "topo-inline-form" });
  formWrap.appendChild(el("p", { className: "topo-inline-form-title" }, action.label));

  const form = el("form", { className: "topo-action-form" });
  const refs: Array<{ field: ActionField; get: () => string }> = [];

  for (const field of action.fields ?? []) {
    const sourcedField = applyAutofillSource(field, target, action.id);
    const r = renderFormField(sourcedField);
    form.appendChild(r.group);
    refs.push({ field: sourcedField, get: r.value });
  }

  const errOut = el("div", { className: "form-error-out" });
  form.appendChild(errOut);

  const actions = el("div", { className: "topo-action-form-actions" });
  const cancel = el("button", { type: "button", className: "btn btn-ghost btn-sm" }, "Cancel");
  cancel.addEventListener("click", () => formWrap.remove());
  actions.appendChild(cancel);

  const submit = el("button", { type: "submit", className: "btn btn-primary btn-sm" + (action.danger ? " btn-danger" : "") },
    action.danger ? "Queue (destructive)" : "Queue");
  actions.appendChild(submit);
  form.appendChild(actions);

  formWrap.appendChild(form);
  anchor.insertAdjacentElement("afterend", formWrap);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    errOut.textContent = "";
    const body: Record<string, unknown> = {};
    for (const { field, get } of refs) {
      const raw = get();
      if ((raw === "" || raw === undefined) && !field.required) continue;
      if ((raw === "" || raw === undefined) && field.required) {
        errOut.appendChild(panelError(`${field.label} is required.`));
        return;
      }
      body[field.name] = coerceFieldValue(field, raw);
    }
    void queueActionWithConfirm(action, target, body, () => {
      formWrap.remove();
      flash(anchor, "Queued");
      deps.onChange();
    }, (e) => {
      errOut.appendChild(panelError(formatError(e)));
    });
  });
}

// queueActionWithConfirm folds the per-action confirm + base queue
// confirm + (when destructive) danger confirmation into a single
// confirmInline call. Replaces the prior three-stacked window.confirm
// sequence (slice — inline-dialogs polish).
async function queueActionWithConfirm(
  action: ActionDef,
  target: ActionTarget,
  body: Record<string, unknown>,
  onQueued: () => void,
  onError?: (e: unknown) => void,
): Promise<void> {
  const bodyParts: string[] = [];
  if (action.confirm) bodyParts.push(action.confirm);
  bodyParts.push("Click Apply changes to send it to newtron.");
  if (action.danger) bodyParts.push("This is destructive.");
  const ok = await confirmInline({
    title: `Queue "${action.label}"?`,
    body: bodyParts.join("\n\n"),
    danger: !!action.danger,
    confirmLabel: "Queue",
  });
  if (!ok) return;
  try {
    queueActionFromForm(action, target, body);
    onQueued();
  } catch (e) {
    if (onError) onError(e);
  }
}

// Queue an action (does NOT POST). For node-multi, queues one per device.
// Merges action.wireBody (constants set by the action definition, e.g.
// {tagged: true} for the trunk-add variant of configure-interface) on
// top of the form-derived body. Form values take precedence over
// wireBody so an operator can never accidentally override a wire-level
// discriminator with a stray field, but no current action defines
// overlapping keys.
function queueActionFromForm(action: ActionDef, target: ActionTarget, body: Record<string, unknown>): void {
  const finalBody = action.wireBody
    ? { ...action.wireBody, ...body }
    : body;
  if (target.kind === "interface") {
    enqueueInterfaceAction(target.device, target.iface, action.id, action.label, finalBody, action.danger);
    return;
  }
  if (target.kind === "node") {
    enqueueDeviceAction(target.device, action.id, action.label, finalBody, action.danger);
    return;
  }
  for (const d of target.devices) {
    enqueueDeviceAction(d, action.id, action.label, finalBody, action.danger);
  }
}

// ---- Field rendering -----------------------------------------------------

interface RenderedField {
  group: HTMLElement;
  value: () => string;
}

function renderFormField(field: ActionField): RenderedField {
  const group = el("div", { className: "form-group" });
  group.appendChild(el("label", { className: "form-label" }, field.label + (field.required ? " *" : "")));

  let getValue: () => string;
  if (field.type === "select" || (field.options && field.options.length > 0)) {
    const sel = el("select", { className: "form-control" }) as HTMLSelectElement;
    if (!field.required) {
      const blank = document.createElement("option");
      blank.value = ""; blank.textContent = "— none —";
      sel.appendChild(blank);
    }
    for (const opt of field.options ?? []) {
      const o = document.createElement("option");
      o.value = opt.value; o.textContent = opt.label;
      sel.appendChild(o);
    }
    if (field.defaultValue !== undefined) sel.value = String(field.defaultValue);
    group.appendChild(sel);
    getValue = () => sel.value;
  } else if (field.type === "textarea") {
    const ta = el("textarea", { className: "form-control", rows: 3 }) as HTMLTextAreaElement;
    if (field.defaultValue !== undefined) ta.value = String(field.defaultValue);
    group.appendChild(ta);
    getValue = () => ta.value;
  } else if (field.type === "checkbox") {
    const input = el("input", { className: "form-control form-control--checkbox" }) as HTMLInputElement;
    input.type = "checkbox";
    if (field.defaultValue === true) input.checked = true;
    group.appendChild(input);
    getValue = () => String(input.checked);
  } else {
    const input = el("input", { className: "form-control" }) as HTMLInputElement;
    input.type = field.type === "number" ? "number" : "text";
    if (field.defaultValue !== undefined) input.value = String(field.defaultValue);
    if (field.hint) input.placeholder = field.hint;
    group.appendChild(input);
    getValue = () => input.value;
  }

  if (field.hint) group.appendChild(el("p", { className: "form-hint" }, field.hint));
  return { group, value: getValue };
}

// ---- Autofill expansion --------------------------------------------------
//
// Map well-known field-name → source-key so existing schemas pick up dropdowns
// automatically without re-declaring every action.

function applyAutofillSource(field: ActionField, target: ActionTarget, actionID: string): ActionField {
  if (field.options && field.options.length > 0) return field;     // explicit options win

  const device = target.kind === "interface" ? target.device
    : target.kind === "node" ? target.device
    : target.devices[0]; // for multi: use first device's lists (best-effort)

  const source = fieldSource(field.name, device, actionID);
  if (!source) return field;

  // Replace synchronously with empty select; hydrate async.
  const f: ActionField = { ...field, type: "select", options: [] };
  setTimeout(() => hydrateSelect(field.name, source), 0);
  return f;
}

// Whether a field on this action is creating a new entity (free-form input)
// or referencing an existing one (dropdown). For "create-X" / "add-X" the
// entity's own identifier is free-form; for everything else, dropdown.
function isCreatingNewEntity(actionID: string): boolean {
  return actionID.startsWith("create-")
      || actionID.startsWith("add-")
      || actionID === "configure-irb"
      || actionID === "configure-interface";
}

function fieldSource(name: string, device: string, actionID: string): string | null {
  const creating = isCreatingNewEntity(actionID);

  // Per-action-id "name" field semantics. For delete-X / unbind-X, "name"
  // refers to an existing entity; for create-X it's a new identifier.
  if (name === "name" && !creating) {
    if (actionID === "delete-vrf")          return `vrfs:${device}`;
    if (actionID === "delete-acl")          return `acls:${device}`;
    if (actionID === "delete-portchannel")  return `lags:${device}`;
  }

  // Identifier fields (vlan id, port-channel name…) — autofill only for
  // delete/remove/unbind/configure-irb (existing VLAN). For create/add they
  // stay free-form so the operator types a new value.
  if (name === "id" || name === "vlan_id" || name === "vlan") {
    return creating ? null : `vlans:${device}`;
  }

  // Cross-entity reference fields — always dropdown from the named source.
  switch (name) {
    case "service":      return "services";
    case "ipvpn":        return "ipvpns";
    case "macvpn":       return "macvpns";
    case "policy":       return "qos-policies"; // apply-qos
    case "qos_policy":   return "qos-policies";
    case "filter":       return "filters";
    case "route_policy": return "route-policies";
    case "prefix_list":  return "prefix-lists";
    case "acl":          return `acls:${device}`;
    case "vrf":          return `vrfs:${device}`;
    case "portchannel":  return `lags:${device}`;
    case "interface":    return `interfaces:${device}`;
    default:             return null;
  }
}

async function hydrateSelect(name: string, source: string): Promise<void> {
  const names = await fetchSource(source);
  // Find every <select> in the active inline form keyed by the field label.
  document.querySelectorAll<HTMLSelectElement>(".topo-inline-form .form-control").forEach((el) => {
    if (!(el instanceof HTMLSelectElement)) return;
    const labelEl = el.parentElement?.querySelector(".form-label");
    if (!labelEl) return;
    // The data-name attr isn't set; identify by matching the field name as a slug.
    if (!labelEl.textContent?.toLowerCase().includes(name.replace(/_/g, " ").toLowerCase())) return;
    el.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = ""; blank.textContent = names.length === 0 ? "— none defined —" : "— select —";
    el.appendChild(blank);
    for (const n of names) {
      const o = document.createElement("option");
      o.value = n; o.textContent = n;
      el.appendChild(o);
    }
  });
}

// ---- Common-set intersection (multi-device) ------------------------------

function intersectActions(groups: ActionGroup[], _devices: string[], _view: TopologyView): ActionGroup[] {
  // Today every device exposes the same newtron POST endpoints (SONiC-only),
  // so the intersection is identical. We still surface the structure so the
  // hook is in place when device-type-specific gating arrives.
  return groups;
}

// ---- Utilities -----------------------------------------------------------

function coerceFieldValue(field: ActionField, raw: unknown): unknown {
  if (field.type === "number") return Number(raw);
  if (field.type === "checkbox") return raw === "true" || raw === true;
  return raw;
}

function panelError(text: string): HTMLElement {
  return el("p", { className: "panel-error" }, text);
}


function flash(target: HTMLElement, text: string, danger = false): void {
  const tag = el("span", { className: "topo-action-flash" + (danger ? " topo-action-flash--danger" : "") }, text);
  target.appendChild(tag);
  setTimeout(() => tag.remove(), 1800);
}

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;");
}
