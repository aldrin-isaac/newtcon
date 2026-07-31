// views/drawer/index.ts — the device drawer core: opening it, the pinned
// mini-header, the async-populated header (identity / stats / badges /
// actions), the tab strip, and the tab dispatch.
//
// One file per tab, the convention this directory already set:
//
//   interfaces.ts  Interfaces tab (+ the IRB section)
//   state.ts       State tab + Debug tab
//   spec-tab.ts    Spec tab (node spec + topology intent)
//   drift.ts       Drift tab (+ the Reconcile preview/apply flow)
//   history.ts     History tab (per-device audit timeline)
//   config-db.ts   the CONFIG_DB browser the Debug tab embeds
//   lifecycle.ts   the substrate section (state pill, VM start/stop, SSH)
//   link-drawer.ts the LINK drawer — a different drawer, same element
//
// The shared spec/detail render helpers are NOT here: they live in
// ../../spec-render.ts because views/specs needs them too, and a view
// shouldn't reach into a sibling view's internals for generic rendering.

import { fetchSpecDetail } from "../../api/newtcon/network.js";
import { fetchLabStatus } from "../../api/newtcon/lab.js";
import { fetchNodeDrift, fetchNodeInfo, fetchNodeInterfaces } from "../../api/newtcon/nodes.js";
import { resolveDeviceStatus } from "../../device-status.js";
import { el } from "../../dom.js";
import { activeNetwork } from "../../network-switcher.js";
import { renderErrorInto, renderLoadingInto } from "../../spec-render.js";
import { type TopologyViewMode } from "../../topology-view-mode.js";
import { isProvisioning } from "../topology/index.js";
import { renderDriftTab } from "./drift.js";
import { renderHistoryTab } from "./history.js";
import { renderInterfaceTab } from "./interfaces.js";
import { renderLifecycleSection } from "./lifecycle.js";
import { renderSpecTab } from "./spec-tab.js";
import { renderDebugTab, renderStateTab } from "./state.js";

// NODE_TABS — the primary tabs the device drawer surfaces. Down from
// 14 (collapsed VLANs / VRFs / ACLs / BGP / EVPN / LAGs / Neighbors
// under "State"; tucked Config DB / Intent Tree / Projection under a
// "Raw" disclosure rendered below the panels). Ordered by operator
// priority: Interfaces (most-acted-on surface) → State (observed
// reality, grouped) → Spec (declared intent, visually distinct)
// → Drift (actionable diff, first-class) → History (audit timeline).
const NODE_TABS = [
  { id: "interfaces", label: "Interfaces" },
  { id: "state",      label: "State" },
  { id: "spec",       label: "Spec" },
  { id: "drift",      label: "Drift" },
  { id: "history",    label: "History" },
  { id: "debug",      label: "Debug" },
] as const;

type NodeTabId = typeof NODE_TABS[number]["id"];

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
export function openNodeDrawer(device: string, viewMode?: TopologyViewMode): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  // Tell the router (uplift 2.4) so #/{net}/topology/device/{device} tracks
  // the open inspector. Inert when nothing listens (unit tests).
  document.dispatchEvent(new CustomEvent("newtcon:route-state", { detail: { device, detail: null } }));

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

  // ── Pinned mini-header (uplift 6.2, #445) ───────────────────────
  // The drawer's FIXED header row (outside the scrolling content) carries
  // the device identity + a live substrate chip — visible through every
  // tab switch and any scroll depth. The chip fills when the substrate
  // resolves (same resolver the lifecycle section uses).
  const crumb = document.getElementById("drawer-breadcrumb");
  if (crumb) {
    crumb.textContent = "";
    crumb.appendChild(el("span", { className: "crumb-main" }, device));
    const miniStatus = el("span", { className: "drawer-mini-status" });
    crumb.appendChild(miniStatus);
    void (async () => {
      try {
        const [labState, online] = await Promise.all([
          fetchLabStatus(activeNetwork()).catch(() => null),
          fetchNodeInfo(device).then(() => true).catch(() => false),
        ]);
        const status = resolveDeviceStatus(device, labState, online, isProvisioning(activeNetwork()));
        if (!miniStatus.isConnected) return; // drawer moved on
        miniStatus.appendChild(el("span", { className: `status-dot status-dot--${status.state === "running" ? "ok" : status.state === "down" ? "error" : status.state === "unrealized" ? "muted" : "warning"}` }));
        miniStatus.appendChild(el("span", { className: "drawer-mini-status-label" }, status.state));
      } catch { /* identity alone is fine */ }
    })();
  }

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

  // Lifecycle section — view-mode-aware substrate state +
  // Start/Stop/SSH/console. Stays for now; the header also surfaces the
  // substrate state from its own pull, so this section is a touch
  // redundant in observation views — kept here as the canonical
  // "lifecycle controls live here" surface until per-domain renderers
  // absorb its action buttons.
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

  // Pick the default tab based on the view-mode the drawer was
  // opened from: Spec view → Spec; Lab/Physical → Interfaces (the
  // operator's most-acted-on surface). Legacy callers without a
  // view-mode also default to Interfaces.
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
// Each tab is operator-priority-ordered and uses a per-domain renderer
// rather than the generic recursive tree.
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

    case "debug":
      renderDebugTab(container, device);
      break;

    case "spec":
      renderSpecTab(container, device);
      break;

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

// ---- Public API -------------------------------------------------------------
// router.ts + views/topology + views/specs import the drawer entry points from
// here. The shared render helpers that used to be re-exported from this module
// now live in ../../spec-render.ts — import them from there.
export { openLinkDrawer } from "./link-drawer.js";
