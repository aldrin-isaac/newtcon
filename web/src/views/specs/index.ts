// views/specs/index.ts — the Specs workspace view: mount, the facet subnav,
// and which facet is showing. Everything the view is MADE of lives in
// siblings; this file is the entry point and the module's public face.
//
//   panels.ts       the facet catalog (schema discovery, titles, grouping)
//   facet-panels.ts the per-facet list + its row affordances
//   detail.ts       the spec detail drawer (openDetail / closeDetail)
//   drawers.ts      the create / edit / override authoring drawers
//   subrules.ts     the sub-rule inline table (config + renderers)
//   fields.ts       the legacy FieldDef vocabulary + form builder
//   ssh-login.ts    the General → SSH Login facet
//   route-state.ts  the router announce
//
// The re-exports at the bottom are the view's public API — router.ts, app.ts,
// and views/drawer/ import them from here, so the split stays internal.

import { type SpecKind, fetchSpecList } from "../../api/newtcon/network.js";
import { mountAuthorizationTab } from "../../authorization.js";
import { el } from "../../dom.js";
import { subscribe as subscribePending } from "../../staging.js";
import { type SpecRowData, loadFacetRows, renderPanel } from "./facet-panels.js";
import { closeDetail, openDetail } from "./detail.js";
import { loadPanels, panels, resolveGroupings, specsViewDegraded } from "./panels.js";
import { announceRoute } from "./route-state.js";
import { renderSSHLoginInto } from "./ssh-login.js";

let activeFacet: SpecKind = "services";
// The "General" group holds network-wide surfaces that aren't named-instance spec
// facets, so they sit outside the SpecKind/PANELS list machinery: the SSH login
// (a scoped-singleton setting) and Permissions (a read-only view of newtron's
// grant table). When non-null, the panel renders that surface instead of a facet
// list; the facet subnav items go inactive.
let activeGeneral: null | "ssh" | "permissions" = null;

// Root of the last mount — applySpecsRoute re-mounts against it when a
// deep link / back-forward changes the facet (uplift 2.4).
let lastRoot: HTMLElement | null = null;

/** applySpecsRoute — drive the Specs view to a hash route's facet/detail
 *  (router-only entry point; user clicks go through the subnav handlers). */
export async function applySpecsRoute(facet?: string, detail?: string): Promise<void> {
  // Boot may apply a facet deep link while the panel catalog is still
  // loading — resolve against the real catalog, not an empty PANELS.
  await loadPanels().catch(() => undefined);
  if (!lastRoot) return;
  if (facet === "general") {
    const key: "ssh" | "permissions" = detail === "permissions" ? "permissions" : "ssh";
    if (activeGeneral !== key) {
      activeGeneral = key;
      await mountSpecsView(lastRoot);
    }
    return;
  }
  const target: SpecKind = facet && panels().some((p) => p.kind === facet) ? (facet as SpecKind) : "services";
  const changed = activeGeneral !== null || activeFacet !== target;
  activeGeneral = null;
  activeFacet = target;
  if (changed || specsViewDegraded()) await mountSpecsView(lastRoot);
  if (detail) {
    const panel = panels().find((p) => p.kind === target);
    if (panel) void openDetail(target, panel.title, detail);
  }
}

export async function mountSpecsView(root: HTMLElement): Promise<void> {
  lastRoot = root;
  root.textContent = "";
  // Schema-driven panel discovery — fetch the kind list before
  // building the subnav. Cached for the session after the first call.
  await loadPanels();

  if (panels().length === 0) {
    // Schema unavailable — render an explicit, retryable error state instead
    // of a dead empty subnav (#390).
    root.textContent = "";
    const box = el("div", { className: "panel-empty specs-degraded" });
    box.appendChild(el("h3", {}, "Couldn't load the spec catalog"));
    box.appendChild(el("p", {},
      "The engine's schema wasn't reachable, so no spec facets are available. This is usually transient."));
    const retry = el("button", { type: "button", className: "btn btn-primary btn-sm" }, "Retry");
    retry.addEventListener("click", () => { void mountSpecsView(root); });
    box.appendChild(retry);
    root.appendChild(box);
    return;
  }

  const layout = el("div", { className: "specs-layout" });
  const subnav = el("aside", { className: "specs-subnav" });
  const main = el("div", { className: "specs-main" });
  layout.append(subnav, main);
  root.appendChild(layout);

  // Fetch counts in parallel for the subnav badges.
  const counts = new Map<SpecKind, number | "error">();
  await Promise.all(
    panels().map(async (p) => {
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
        const panel = panels().find((p) => p.kind === kind);
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
          activeGeneral = null;
          activeFacet = kind;
          announceRoute({ facet: kind, detail: null });
          renderSubnav();
          renderActiveFacet();
        });
        groupList.appendChild(btn);
      }
      section.appendChild(groupList);
      subnav.appendChild(section);
    }

    // General — network-wide surfaces that aren't a named-instance spec facet:
    // the SSH login (a scoped-singleton setting) and Permissions (a read-only view
    // of newtron's grant table). Rendered inline, not via the list machinery, so
    // they live outside SPEC_GROUPS/PANELS.
    const genSection = el("div", { className: "specs-subnav-section" });
    genSection.appendChild(el("h3", { className: "specs-subnav-heading" }, "General"));
    const genList = el("div", { className: "specs-subnav-list" });
    const genItem = (label: string, key: "ssh" | "permissions"): HTMLElement => {
      const active = activeGeneral === key;
      const btn = el("button", {
        type: "button",
        className: "specs-subnav-item" + (active ? " specs-subnav-item--active" : ""),
        ariaSelected: active ? "true" : "false",
      }, label);
      btn.addEventListener("click", () => {
        closeDetail();
        activeGeneral = key;
        announceRoute({ facet: "general", detail: key });
        renderSubnav();
        void renderActiveFacet();
      });
      return btn;
    };
    genList.append(genItem("SSH Login", "ssh"), genItem("Permissions", "permissions"));
    genSection.appendChild(genList);
    subnav.appendChild(genSection);
  }

  async function renderActiveFacet(): Promise<void> {
    if (activeGeneral === "ssh") {
      // renderSSHLoginInto swaps content atomically at the end — no pre-clear, so
      // a re-render (on pending-queue change) doesn't flicker or stack forms.
      await renderSSHLoginInto(main);
      return;
    }
    if (activeGeneral === "permissions") {
      // Read-only view of newtron's grant table (super-users + user-groups +
      // permissions). Always re-mounts against the live authorization table so an
      // upstream network.json edit + reload doesn't surface stale here.
      await mountAuthorizationTab(main);
      return;
    }
    const panel = panels().find((p) => p.kind === activeFacet);
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

// ---- Public API -------------------------------------------------------------
// The view's outward surface. router.ts (applySpecsRoute / closeDetail),
// app.ts (closeDetail / mountSpecsView), and views/drawer/ (displaySchemaFor /
// kindTitleFor / openDetail) import from this module, so re-exporting here
// keeps the internal file split invisible to them.
export { openDetail, closeDetail } from "./detail.js";
export { displaySchemaFor } from "./fields.js";
export { kindTitleFor, specsViewDegraded } from "./panels.js";
