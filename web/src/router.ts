// router.ts — hash-route navigation owner (uplift 2.4).
//
// One module owns tab switching + URL state: the workspace hash is
// #/{net}/{view}[+params] (codec in route.ts). Deep links restore state on
// load, back/forward walk real history, and in-app navigation (tab clicks,
// drawer opens, facet switches) keeps the hash current.
//
// Wiring pattern (no import cycles): views announce state changes by
// dispatching a "newtcon:route-state" CustomEvent on document with a partial
// params object ({device?, facet?, detail?} — null clears a key). The router
// listens and rewrites the hash. Applying a route (boot / hashchange) calls
// the views' exported functions directly.

import { parseHash, formatHash, type Route, type ViewName } from "./route.js";
import { activeNetwork, adoptNetwork } from "./network-switcher.js";
import { viewFor } from "./views/index.js";
import { applySpecsRoute, closeDetail } from "./views/specs/index.js";
import { openNodeDrawer } from "./views/drawer/index.js";
import { mountTopologyTab, stopTopologyPoll } from "./views/topology/index.js";

/** Partial route-params announcement from a view (null clears a key). */
export interface RouteStateDetail {
  device?: string | null;
  facet?: string | null;
  detail?: string | null;
}

let current: Route = { net: "default", view: "specs" };
// Hash values this module wrote itself — the hashchange handler skips them
// so our own writes don't re-apply (only back/forward and manual edits do).
let lastWritten = "";
// True while applyRoute drives the views programmatically: their announce
// events + intermediate hash writes are suppressed so one navigation is one
// history entry (applyRoute writes the final hash itself).
let applying = false;

function writeHash(): void {
  if (applying) return;
  const h = formatHash(current);
  if (location.hash === h) return;
  lastWritten = h;
  location.hash = h;
}

/** bootNetSync — before any view fetches data: if the URL hash names a
 *  network, it is the deep-link authority — adopt it into localStorage so
 *  every activeNetwork() consumer (api-path, switcher) sees it. */
export function bootNetSync(): void {
  const route = parseHash(location.hash);
  if (route && route.net !== activeNetwork()) adoptNetwork(route.net);
}

export function startRouter(): void {
  const tabs: Record<ViewName, HTMLElement | null> = {
    specs: document.getElementById("tab-specs"),
    topology: document.getElementById("tab-topology"),
    history: document.getElementById("tab-history"),
    audit: document.getElementById("tab-audit"),
  };
  const panels: Record<ViewName, HTMLElement | null> = {
    specs: document.getElementById("panel-specs"),
    topology: document.getElementById("panel-topology"),
    history: document.getElementById("panel-history"),
    audit: document.getElementById("panel-audit"),
  };
  if (Object.values(tabs).some((t) => !t) || Object.values(panels).some((p) => !p)) return;

  let topologyMounted = false;

  const activateTab = (name: ViewName): void => {
    // Drawers (spec detail, node inspector, add forms) overlay the workspace;
    // switching tabs changes the panel behind them — close to avoid stale
    // floating content. Escape and drawer-× close similarly (app.ts wiring).
    closeDetail();

    for (const view of Object.keys(tabs) as ViewName[]) {
      const active = view === name;
      tabs[view]!.classList.toggle("workspace-tab--active", active);
      // Workspace nav items are links, not tabs — the active one is the
      // current PAGE, so aria-current is the right signal (aria-selected
      // only means anything inside a tablist, which this isn't).
      if (active) tabs[view]!.setAttribute("aria-current", "page");
      else tabs[view]!.removeAttribute("aria-current");
      panels[view]!.hidden = !active;
    }

    if (name === "topology" && !topologyMounted) {
      topologyMounted = true;
      mountTopologyTab(panels.topology!);
    }
    // Stop polling newtlab status when leaving the Topology tab.
    if (name !== "topology") stopTopologyPoll();

    // Registry-driven re-mounts (views/index.ts): fresh-data views re-mount on
    // every activation (History / Audit); shouldRemount heals degraded mounts
    // (Specs after a failed schema load, #390).
    const view = viewFor(name);
    if (view && (view.remountOnActivate || view.shouldRemount?.())) {
      const panel = document.getElementById(view.panelId);
      if (panel) void view.mount(panel);
    }

    if (current.view !== name) {
      // Params are per-view; entering a view starts clean (a deep-link apply
      // sets params right after activation).
      current = { net: current.net, view: name };
      writeHash();
      syncTabHrefs();
    }
  };

  // syncTabHrefs — keep each workspace link's href pointing at its real URL for
  // the active network, so middle-click / ⌘-click / right-click → "open in new
  // tab" land on the right workspace. Re-run on every navigation because the
  // network can change under us.
  const syncTabHrefs = (): void => {
    for (const view of Object.keys(tabs) as ViewName[]) {
      tabs[view]!.setAttribute("href", formatHash({ net: current.net, view }));
    }
  };
  syncTabHrefs();

  for (const view of Object.keys(tabs) as ViewName[]) {
    tabs[view]!.addEventListener("click", (e) => {
      // Let the browser handle modified clicks natively — that's what makes
      // "open this workspace in a new tab" work. Only plain left-clicks are
      // intercepted for in-page navigation (no reload).
      const me = e as MouseEvent;
      if (me.button !== 0 || me.metaKey || me.ctrlKey || me.shiftKey || me.altKey) return;
      e.preventDefault();
      activateTab(view);
    });
  }

  // Views announce param changes; merge into the current route + rewrite hash.
  document.addEventListener("newtcon:route-state", (e) => {
    const d = (e as CustomEvent<RouteStateDetail>).detail;
    if (!d) return;
    for (const key of ["device", "facet", "detail"] as const) {
      if (!(key in d)) continue;
      const v = d[key];
      if (v === null || v === undefined) delete current[key];
      else current[key] = v;
    }
    writeHash();
  });

  const applyRoute = (route: Route): void => {
    if (route.net !== activeNetwork()) {
      // Cross-network navigation (back/forward over a network switch, or a
      // pasted deep link): adopt + reload, mirroring the switcher's model —
      // every view re-fetches against the new network from a clean slate.
      adoptNetwork(route.net);
      location.reload();
      return;
    }
    applying = true;
    try {
      // Real .click() so the shell's own listeners (breadcrumb, sidebar
      // active state) stay in sync with programmatic navigation.
      tabs[route.view]!.click();
      current = { ...route }; // activateTab/closeDetail reset params; restore
      syncTabHrefs();         // hrefs follow the route's network
      if (route.view === "specs") {
        void applySpecsRoute(route.facet, route.detail);
      } else if (route.view === "topology") {
        if (route.device) openNodeDrawer(route.device);
      }
    } finally {
      applying = false;
    }
    writeHash();
  };

  window.addEventListener("hashchange", () => {
    if (location.hash === lastWritten) {
      // Our own write landing — already applied. Consume the marker so a
      // LATER back/forward onto this same hash re-applies (e.g. forward
      // returning to a state we once wrote).
      lastWritten = "";
      return;
    }
    const route = parseHash(location.hash);
    if (route) applyRoute(route);
  });

  // Boot: apply the deep link if present; otherwise stamp the default route
  // (replaceState — landing on the app must not create an extra history hop).
  const initial = parseHash(location.hash);
  if (initial) {
    applyRoute(initial);
  } else {
    current = { net: activeNetwork(), view: "specs" };
    lastWritten = formatHash(current);
    history.replaceState(null, "", lastWritten);
  }
  // Stamp hrefs LAST: `current.net` is only correct once the boot route has
  // resolved (it starts as the "default" placeholder). Doing this earlier
  // advertised the wrong network, so middle-clicking a workspace would have
  // opened someone else's fabric.
  syncTabHrefs();
}
