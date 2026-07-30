// views/drawer/link-drawer.ts — the LINK drawer: a topology link's two
// endpoints rendered side by side.
//
// A different drawer from the device drawer — it shares the #detail-drawer
// element, not a concern. Opening it overwrites whatever the drawer was
// showing.
//
// The render is layered:
//
//   1. STATIC config from the topology data (always available, no fetch):
//      port admin_status, mtu, the link itself. This is what's in
//      topology.json — visible even when the device is offline / lab not
//      deployed.
//   2. LIVE data fetched per-endpoint (oper_status, real-time bindings,
//      runtime VLAN membership). Adds runtime context when the device is
//      reachable; renders as a pedagogical "device offline" line when not.
//
// Each endpoint renders independently so one device being unreachable doesn't
// hide the other side.

import { fetchNodeInterface, fetchNodeInterfaceBinding } from "../../api/newtcon/nodes.js";
import { ApiError } from "../../api/newtcon/services.js";
import { el, renderValue } from "../../dom.js";
import { formatErrorBrief } from "../../render-error.js";
import { type TopoLink } from "../topology/index.js";

export function openLinkDrawer(
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
