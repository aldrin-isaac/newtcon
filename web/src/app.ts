// app.ts — newtcon workspace entry. Renders a three-tab layout:
//   Tab 1 (Specs)    — multi-panel spec view
//   Tab 2 (Topology) — SVG topology graph + node-inspector drawer
//   Tab 3 (Lab)      — lab topology lifecycle (deploy / destroy / nodes)

// Note: postTopologyDevice / deleteTopologyDevice / postTopologyLink
// were previously called directly from the topology view. With the staging
// queue introduced in staging.ts, those flows go through enqueue* + applyAll
// instead, so we don't import them here.


// ---- Specs tab -------------------------------------------------------------





// ---- Tab switching ----------------------------------------------------------

import { signedInOnce } from "./auth-gate.js";
import { viewFor } from "./views/index.js";
import { closeDetail, mountSpecsView } from "./views/specs/index.js";
import { mountTopologyTab, stopTopologyPoll } from "./views/topology/index.js";
function setupTabs(): void {
  const tabSpecs = document.getElementById("tab-specs");
  const tabTopology = document.getElementById("tab-topology");
  const tabHistory = document.getElementById("tab-history");
  const tabAudit = document.getElementById("tab-audit");
  const panelSpecs = document.getElementById("panel-specs");
  const panelTopology = document.getElementById("panel-topology");
  const panelHistory = document.getElementById("panel-history");
  const panelAudit = document.getElementById("panel-audit");

  if (!tabSpecs || !tabTopology || !tabHistory || !tabAudit ||
      !panelSpecs || !panelTopology || !panelHistory || !panelAudit) return;

  let topologyMounted = false;

  // Permissions moved into Specs → General → Permissions (it's current-state
  // network config, a sibling of the spec facets, not a top-level surface).
  type TabName = "specs" | "topology" | "history" | "audit";

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
    const isHistory = name === "history";
    const isAudit = name === "audit";

    tabSpecs.classList.toggle("workspace-tab--active", isSpecs);
    tabSpecs.setAttribute("aria-selected", isSpecs ? "true" : "false");
    tabTopology.classList.toggle("workspace-tab--active", isTopology);
    tabTopology.setAttribute("aria-selected", isTopology ? "true" : "false");
    tabHistory.classList.toggle("workspace-tab--active", isHistory);
    tabHistory.setAttribute("aria-selected", isHistory ? "true" : "false");
    tabAudit.classList.toggle("workspace-tab--active", isAudit);
    tabAudit.setAttribute("aria-selected", isAudit ? "true" : "false");

    (panelSpecs as HTMLElement).hidden = !isSpecs;
    (panelTopology as HTMLElement).hidden = !isTopology;
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
    // Registry-driven re-mounts (views/index.ts): fresh-data views re-mount
    // on every activation — History so newly-applied entries surface
    // immediately, Audit for fresh events + integrity status (no auto-poll).
    const view = viewFor(name);
    if (view && (view.remountOnActivate || view.shouldRemount?.())) {
      const panel = document.getElementById(view.panelId);
      if (panel) void view.mount(panel);
    }
  };

  tabSpecs.addEventListener("click", () => activateTab("specs"));
  tabTopology.addEventListener("click", () => activateTab("topology"));
  tabHistory.addEventListener("click", () => activateTab("history"));
  tabAudit.addEventListener("click", () => activateTab("audit"));
}

// ---- Entry ------------------------------------------------------------------

async function mount(): Promise<void> {
  const root = document.getElementById("panel-specs");
  if (!root) return;

  await mountSpecsView(root);

  setupTabs();

  document.getElementById("drawer-close")?.addEventListener("click", closeDetail);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
  });

  // Reflect the drawer's open/closed state onto <body> so the active view can make
  // room for it. The drawer is a fixed overlay pinned to the right; without this,
  // an open drawer sits ON TOP of the right half of the Topology canvas (including
  // its centre), so pan/zoom/drag there hit the drawer instead of the SVG. The CSS
  // shrinks the Topology view by the drawer's width so the whole graph stays
  // interactive to the left of it. Observing the element covers every opener
  // (node inspector, add-node, add-link, create/edit forms) centrally.
  const drawerEl = document.getElementById("detail-drawer");
  if (drawerEl) {
    const syncDrawerBodyClass = (): void => {
      document.body.classList.toggle("drawer-open", drawerEl.classList.contains("open"));
    };
    new MutationObserver(syncDrawerBodyClass).observe(drawerEl, { attributes: true, attributeFilter: ["class"] });
    syncDrawerBodyClass();
  }
}

// Gate the workspace mount on a successful sign-in so we don't fire /api/*
// calls anonymously at boot and trigger spurious 401s. signedInOnce resolves
// when auth-gate.ts has either confirmed an existing session via /api/auth/whoami
// or completed an interactive login.
void signedInOnce.then(mount);
