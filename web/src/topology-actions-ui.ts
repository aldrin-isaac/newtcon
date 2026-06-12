// topology-actions-ui.ts — floating context menus + action forms over
// the topology view. The action catalogs come from topology-actions.ts;
// here we render the menu and the per-action form drawer, and POST the
// resulting parameters to the generic newtron RPC endpoints.

import { iconSVG } from "./icons.js";
import {
  type ActionDef,
  type ActionField,
  type ActionGroup,
} from "./topology-actions.js";
import { enqueueDeviceAction, enqueueInterfaceAction } from "./staging.js";
import { formatErrorBrief as formatError } from "./render-error.js";

// ---- API helpers (avoid importing app.ts to keep this self-contained) -----

// Direct-POST helpers were removed when the floating menu switched to
// queueing — actions go through staging.ts enqueue* functions, and the
// Apply changes buttons call applyDevice / applyAll.

// ---- Context menu ---------------------------------------------------------

let activeMenu: HTMLElement | null = null;

export function dismissContextMenu(): void {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

document.addEventListener("click", (e) => {
  if (!activeMenu) return;
  if (e.target instanceof Node && activeMenu.contains(e.target)) return;
  dismissContextMenu();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") dismissContextMenu();
});

interface MenuContext {
  kind: "node" | "interface";
  device: string;
  iface?: string;          // present for interface menus
  anchorX: number;
  anchorY: number;
  onComplete?: () => void; // re-render after a successful action
  onInspect?: () => void;  // open the inspector drawer when the header is clicked
}

export function showContextMenu(groups: ActionGroup[], ctx: MenuContext): void {
  dismissContextMenu();

  const menu = document.createElement("div");
  menu.className = "topo-menu";
  menu.setAttribute("role", "menu");

  // Header strip: shows what the operator clicked on, and (for nodes) acts
  // as a button that opens the inspector drawer.
  const header = document.createElement(ctx.onInspect ? "button" : "div");
  header.className = "topo-menu-header" + (ctx.onInspect ? " topo-menu-header--button" : "");
  if (ctx.onInspect) {
    (header as HTMLButtonElement).type = "button";
    header.addEventListener("click", (e) => {
      e.stopPropagation();
      dismissContextMenu();
      ctx.onInspect?.();
    });
  }
  const headerIcon = document.createElement("span");
  headerIcon.className = "topo-menu-header-icon";
  headerIcon.innerHTML = iconSVG(ctx.kind === "node" ? "server" : "network");
  header.appendChild(headerIcon);
  const headerLabel = document.createElement("span");
  headerLabel.className = "topo-menu-header-label";
  headerLabel.textContent = ctx.kind === "node"
    ? ctx.device
    : `${ctx.device} · ${ctx.iface ?? ""}`;
  header.appendChild(headerLabel);
  if (ctx.onInspect) {
    const hint = document.createElement("span");
    hint.className = "topo-menu-header-hint";
    hint.textContent = "Open inspector →";
    header.appendChild(hint);
  }
  menu.appendChild(header);

  for (const group of groups) {
    const groupLabel = document.createElement("div");
    groupLabel.className = "topo-menu-group-label";
    groupLabel.textContent = group.group;
    menu.appendChild(groupLabel);

    for (const action of group.items) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "topo-menu-item" + (action.danger ? " topo-menu-item--danger" : "");
      item.setAttribute("role", "menuitem");
      const ic = document.createElement("span");
      ic.className = "topo-menu-item-icon";
      ic.innerHTML = iconSVG(action.icon || "right-arrow");
      item.appendChild(ic);
      const lbl = document.createElement("span");
      lbl.className = "topo-menu-item-label";
      lbl.textContent = action.label;
      item.appendChild(lbl);
      if (action.fields && action.fields.length > 0) {
        const hint = document.createElement("span");
        hint.className = "topo-menu-item-hint";
        hint.textContent = "…";
        item.appendChild(hint);
      }
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        dismissContextMenu();
        handleActionInvoke(action, ctx);
      });
      menu.appendChild(item);
    }
  }

  document.body.appendChild(menu);
  activeMenu = menu;
  positionMenu(menu, ctx.anchorX, ctx.anchorY);
}

function positionMenu(menu: HTMLElement, x: number, y: number): void {
  // Default to anchoring below-right of the cursor.
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = Math.max(margin, y - rect.height);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

// ---- Action form (drawer) -------------------------------------------------

function handleActionInvoke(action: ActionDef, ctx: MenuContext): void {
  const needsForm = (action.fields ?? []).length > 0;
  if (!needsForm) {
    if (action.confirm && !window.confirm(action.confirm)) return;
    if (!window.confirm(`Queue "${action.label}"? Click Apply changes to apply.`)) return;
    if (action.danger && !window.confirm("Are you sure? This is destructive.")) return;
    queueFromMenu(action, ctx, {});
    ctx.onComplete?.();
    return;
  }
  openActionDrawer(action, ctx);
}

function queueFromMenu(action: ActionDef, ctx: MenuContext, body: Record<string, unknown>): void {
  if (ctx.kind === "node") {
    enqueueDeviceAction(ctx.device, action.id, action.label, body, action.danger);
  } else {
    enqueueInterfaceAction(ctx.device, ctx.iface ?? "", action.id, action.label, body, action.danger);
  }
}

function openActionDrawer(action: ActionDef, ctx: MenuContext): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;
  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

  const kindLabel = document.createElement("p");
  kindLabel.className = "drawer-kind";
  kindLabel.textContent = ctx.kind === "node"
    ? `Device · ${ctx.device}`
    : `Interface · ${ctx.device}:${ctx.iface ?? ""}`;
  content.appendChild(kindLabel);

  const title = document.createElement("h2");
  title.className = "drawer-name";
  title.textContent = action.label;
  content.appendChild(title);

  const form = document.createElement("form");
  form.className = "topo-action-form";
  form.noValidate = true;

  const refs: Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> = new Map();

  for (const field of action.fields ?? []) {
    form.appendChild(renderFormField(field, refs));
  }

  const errorOut = document.createElement("div");
  errorOut.className = "form-error-out";
  form.appendChild(errorOut);

  const actionsRow = document.createElement("div");
  actionsRow.className = "topo-action-form-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => closeDrawer());
  actionsRow.appendChild(cancel);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "btn btn-primary";
  submit.textContent = action.danger ? "Queue (destructive)" : "Queue";
  if (action.danger) submit.classList.add("btn-danger");
  actionsRow.appendChild(submit);

  form.appendChild(actionsRow);
  content.appendChild(form);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    errorOut.textContent = "";

    const body: Record<string, unknown> = {};
    for (const field of action.fields ?? []) {
      const ref = refs.get(field.name);
      if (!ref) continue;
      const raw = ref instanceof HTMLInputElement && ref.type === "checkbox"
        ? ref.checked
        : ref.value;
      if ((raw === "" || raw === undefined) && !field.required) continue;
      if ((raw === "" || raw === undefined) && field.required) {
        errorOut.appendChild(errorParagraph(`${field.label} is required.`));
        return;
      }
      body[field.name] = coerceFieldValue(field, raw);
    }

    if (action.confirm && !window.confirm(action.confirm)) return;
    if (!window.confirm(`Queue "${action.label}"? Click Apply changes to apply.`)) return;
    if (action.danger && !window.confirm("Are you sure? This is destructive.")) return;

    try {
      queueFromMenu(action, ctx, body);
      // Show a brief success summary, then close the drawer.
      const ok = document.createElement("p");
      ok.className = "form-success";
      ok.textContent = "Queued. Click Apply changes (per-device or workspace) to apply.";
      content.appendChild(ok);
      ctx.onComplete?.();
      setTimeout(() => closeDrawer(), 700);
    } catch (err) {
      const para = errorParagraph(formatError(err));
      errorOut.appendChild(para);
    }
  });
}

function renderFormField(
  field: ActionField,
  refs: Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
): HTMLElement {
  const group = document.createElement("div");
  group.className = "form-group";

  const label = document.createElement("label");
  label.className = "form-label";
  label.textContent = field.label + (field.required ? " *" : "");
  group.appendChild(label);

  let ctrl: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (field.type === "select") {
    const sel = document.createElement("select");
    sel.className = "form-control";
    if (!field.required) {
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "— none —";
      sel.appendChild(blank);
    }
    for (const opt of field.options ?? []) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      sel.appendChild(o);
    }
    if (field.defaultValue !== undefined) sel.value = String(field.defaultValue);
    ctrl = sel;
  } else if (field.type === "textarea") {
    const ta = document.createElement("textarea");
    ta.className = "form-control";
    ta.rows = 4;
    if (field.defaultValue !== undefined) ta.value = String(field.defaultValue);
    ctrl = ta;
  } else if (field.type === "checkbox") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "form-control form-control--checkbox";
    if (field.defaultValue === true) input.checked = true;
    ctrl = input;
  } else {
    const input = document.createElement("input");
    input.type = field.type === "number" ? "number" : "text";
    input.className = "form-control";
    if (field.defaultValue !== undefined) input.value = String(field.defaultValue);
    ctrl = input;
  }
  group.appendChild(ctrl);

  if (field.hint) {
    const hint = document.createElement("p");
    hint.className = "form-hint";
    hint.textContent = field.hint;
    group.appendChild(hint);
  }

  refs.set(field.name, ctrl);
  return group;
}

function coerceFieldValue(field: ActionField, raw: unknown): unknown {
  if (field.type === "number") return Number(raw);
  if (field.type === "checkbox") return Boolean(raw);
  return raw;
}

function errorParagraph(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "panel-error";
  p.textContent = text;
  return p;
}


// runAction / renderResult are no longer needed: actions are queued (not
// POSTed immediately) via queueFromMenu / queueActionFromForm. The Apply
// changes buttons drain the queue against newtron.

function closeDrawer(): void {
  const drawer = document.getElementById("detail-drawer");
  if (!drawer) return;
  drawer.setAttribute("aria-hidden", "true");
  drawer.classList.remove("open");
}

// ---- Multi-select link form ----------------------------------------------

// openLinkBetweenDrawer is the variant used by the multi-select toolbar.
// Both endpoints are already known by device; we fetch interfaces for each
// and present a dropdown so the operator picks ports.
export function openLinkBetweenDrawer(
  aDevice: string,
  zDevice: string,
  interfacesByDevice: Map<string, string[]>,
  onCreate: (req: { a: string; z: string }) => Promise<unknown>,
  onSuccess: () => void,
): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

  const kindLabel = document.createElement("p");
  kindLabel.className = "drawer-kind";
  kindLabel.textContent = "Topology · Link";
  content.appendChild(kindLabel);

  const title = document.createElement("h2");
  title.className = "drawer-name";
  title.textContent = `Connect ${aDevice} ↔ ${zDevice}`;
  content.appendChild(title);

  const form = document.createElement("form");
  form.className = "topo-action-form";
  form.noValidate = true;

  const aField = endpointPicker(aDevice, "a", interfacesByDevice.get(aDevice) ?? []);
  const zField = endpointPicker(zDevice, "z", interfacesByDevice.get(zDevice) ?? []);
  form.appendChild(aField.group);
  form.appendChild(zField.group);

  const errorOut = document.createElement("div");
  errorOut.className = "form-error-out";
  form.appendChild(errorOut);

  const actionsRow = document.createElement("div");
  actionsRow.className = "topo-action-form-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => closeDrawer());
  actionsRow.appendChild(cancel);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "btn btn-primary";
  submit.textContent = "Add link";
  actionsRow.appendChild(submit);
  form.appendChild(actionsRow);
  content.appendChild(form);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    errorOut.textContent = "";
    const aIface = aField.value().trim();
    const zIface = zField.value().trim();
    if (!aIface || !zIface) {
      errorOut.appendChild(errorParagraph("Both interfaces are required."));
      return;
    }
    submit.disabled = true;
    submit.textContent = "Adding…";
    try {
      await onCreate({ a: `${aDevice}:${aIface}`, z: `${zDevice}:${zIface}` });
      const success = document.createElement("p");
      success.className = "form-success";
      success.textContent = `Link added: ${aDevice}:${aIface} ↔ ${zDevice}:${zIface}`;
      content.insertBefore(success, form);
      onSuccess();
      setTimeout(() => closeDrawer(), 700);
    } catch (err) {
      submit.disabled = false;
      submit.textContent = "Add link";
      errorOut.appendChild(errorParagraph(formatError(err)));
    }
  });
}

function endpointPicker(
  device: string,
  side: string,
  interfaces: string[],
): { group: HTMLElement; value: () => string } {
  const group = document.createElement("div");
  group.className = "form-group";
  const label = document.createElement("label");
  label.className = "form-label";
  label.textContent = `${device} interface *`;
  group.appendChild(label);

  // Use a select when we know the interfaces; fall back to a free-form input.
  let valueGetter: () => string;
  if (interfaces.length > 0) {
    const sel = document.createElement("select");
    sel.className = "form-control";
    sel.id = `link-${side}-iface`;
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— select interface —";
    sel.appendChild(blank);
    for (const iface of interfaces) {
      const o = document.createElement("option");
      o.value = iface;
      o.textContent = iface;
      sel.appendChild(o);
    }
    group.appendChild(sel);
    valueGetter = () => sel.value;
  } else {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "form-control";
    input.id = `link-${side}-iface`;
    input.placeholder = "interface name, e.g. Ethernet0";
    group.appendChild(input);
    const hint = document.createElement("p");
    hint.className = "form-hint";
    hint.textContent = "Interface list not available — type it.";
    group.appendChild(hint);
    valueGetter = () => input.value;
  }
  return { group, value: valueGetter };
}
