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
import { bootNetSync, startRouter } from "./router.js";
import { closeDetail, mountSpecsView } from "./views/specs/index.js";

// ---- Entry ------------------------------------------------------------------

async function mount(): Promise<void> {
  const root = document.getElementById("panel-specs");
  if (!root) return;

  // Net-from-hash must win BEFORE any view fetches (deep-link authority),
  // then the first mount, then the router applies the rest of the route
  // (tab, facet/detail, device drawer) and starts tracking history.
  bootNetSync();
  await mountSpecsView(root);
  startRouter();

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
