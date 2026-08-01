// views/topology/index.ts — the Topology workspace view: mountTopologyTab.
//
// This file is the ORCHESTRATION layer. It owns the view's live state — view
// mode, lens, zone filter, viewport, pinned positions, palette + status-text
// maps, the cached lab state — and the render functions that read it. Those
// pieces genuinely share mutable state, so they stay in one closure; splitting
// them would mean threading a dozen refs through parameters for no gain.
//
// Everything that does NOT need that shared state lives in a sibling:
//
//   canvas.ts       the SVG renderer + topology shape adapter + layout cache
//   chrome.ts       static furniture: zoom toolbar, nav hint, legend, empty state
//   device-probe.ts the per-device probe fan-out (online / drift / link truth)
//   status-poll.ts  the 5s status poll + the in-place DOM patcher
//   live-heat.ts    the Live lens's per-link heat poll
//   lab-ops.ts      deploy / provision modals + the provisioning marker
//   add-link.ts     the Add-link drawer
//   port-tip.ts     the fast hover tip for canvas dots
//
// The re-exports at the bottom are the view's public API — router.ts and
// views/drawer/ import them from here, so the split stays internal.

import { type LabState, fetchLabStatus, postLabDestroy } from "../../api/newtcon/lab.js";
import { fetchSpecDetail, fetchSpecList } from "../../api/newtcon/network.js";
import { fetchTopology } from "../../api/newtcon/nodes.js";
import { ApiError } from "../../api/newtcon/services.js";
import { confirmInline } from "../../confirm-inline.js";
import { type DeviceStatus, resolveDeviceStatus } from "../../device-status.js";
import { el } from "../../dom.js";
import { mountFabricHealthStrip } from "../../fabric-health-strip.js";
import { activeNetwork } from "../../network-switcher.js";
import { hostLikeDevices } from "../../node-references.js";
import { comparePorts } from "../../port-config.js";
import { engineOpErrorBody } from "../../render-error.js";
import { pendingTopologyLinkAdds, subscribe as subscribePending } from "../../staging.js";
import { showToast } from "../../toast.js";
import { showContextMenu } from "../../topology-actions-ui.js";
import { NODE_ACTIONS } from "../../topology-actions.js";
import { type DeviceMetadata, type TopologyFilter, applyFilter, emptyFilter, isActive as filterIsActive, uniqueZones } from "../../topology-filters.js";
import { type LensState, availableLenses, availableVlans, lensEffect, vlanMembership } from "../../topology-lenses.js";
import { type NavDirection, focusDim, nearestInDirection } from "../../topology-focus.js";
import { type PaletteState, resolveLabDevicePalette, resolveLabStatusText, resolvePhysicalDevicePalette, resolvePhysicalStatusText } from "../../topology-palette.js";
import { clearPositions, loadPositions, savePosition } from "../../topology-positions.js";
import { collapseZones, loadCollapsedZones, saveCollapsedZones } from "../../topology-zones.js";
import { ALL_VIEW_MODES, type TopologyViewMode, defaultViewMode, loadViewMode, saveViewMode, viewModeLabel } from "../../topology-view-mode.js";
import { type ViewState, ZOOM_STEP, fitToBounds, viewBoxStr, zoomAt } from "../../topology-viewport.js";
import { openLinkDrawer, openNodeDrawer } from "../drawer/index.js";
import { openAddLinkDrawer } from "./add-link.js";
import { type PaletteByDevice, type StatusTextByDevice, adaptTopology, renderTopologySVG, resetLayoutCache } from "./canvas.js";
import { buildLinkLegend, buildNavHint, buildZoomToolbar, renderTopologyEmptyState } from "./chrome.js";
import { probeDevices } from "./device-probe.js";
import { isProvisioning, openDeployModal, openProvisionModal } from "./lab-ops.js";
import { createHeatPoll } from "./live-heat.js";
import { startTopologyPoll } from "./status-poll.js";

export async function mountTopologyTab(root: HTMLElement): Promise<void> {
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

    const {
      onlineByDevice, driftByDevice, lldpByDevice, speedsByDevice,
      portStatesByDevice, lagMembersByDevice, underlayByDevice,
    } = await probeDevices(deviceNames);

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
      statusByDevice.set(name, resolveDeviceStatus(name, labState, onlineByDevice.get(name), isProvisioning(activeNetwork())));
    }

    // Layered Topology views (slice #210.B/C/D) — pick the actuation
    // source to overlay. The mode is persisted per-network; first visit
    // gets defaultViewMode() which prefers spec-lab when any lab node
    // is known, then spec-physical when any /info probe succeeded,
    // otherwise spec (no actuation overlay). The labState ref is held
    // here so a post-tick view switch reads the latest snapshot.
    let labStateRef: LabState | null = labState;
    const activeNetName = activeNetwork();
    let viewMode: TopologyViewMode =
      loadViewMode(activeNetName) ?? defaultViewMode(labState, onlineByDevice);
    const computePaletteByDevice = (): PaletteByDevice => {
      const m: PaletteByDevice = new Map<string, PaletteState>();
      for (const name of deviceNames) {
        let p: PaletteState;
        switch (viewMode) {
          case "spec":
            p = "spec-only";
            break;
          case "spec-lab":
            p = resolveLabDevicePalette(labStateRef, name);
            break;
          case "spec-physical":
            p = resolvePhysicalDevicePalette(
              onlineByDevice.get(name),
              driftByDevice.get(name) ?? 0,
            );
            break;
        }
        m.set(name, p);
      }
      return m;
    };
    // Per-device corner status text — Lab view shows the newtlab
    // phase/status string ("booting", "patching", "running"); Physical
    // view shows the probe outcome ("offline", "online", "online · 3
    // drift"); Spec view shows nothing (the absence is the message).
    const computeStatusTextByDevice = (): StatusTextByDevice => {
      const m: StatusTextByDevice = new Map<string, string>();
      for (const name of deviceNames) {
        let t = "";
        switch (viewMode) {
          case "spec":
            t = "";
            break;
          case "spec-lab":
            t = resolveLabStatusText(labStateRef, name);
            break;
          case "spec-physical":
            t = resolvePhysicalStatusText(
              onlineByDevice.get(name),
              driftByDevice.get(name) ?? 0,
            );
            break;
        }
        m.set(name, t);
      }
      return m;
    };
    let paletteByDevice = computePaletteByDevice();
    let statusTextByDevice = computeStatusTextByDevice();

    // Toolbar — buttons gate by view mode (slice #210 polish): Spec
    // view is the only place that authors the topology spec (create
    // node / add link); Lab view exposes lab substrate lifecycle
    // (deploy / provision / destroy) because those operate on the
    // lab, not the spec; Physical view is pure observation (no
    // mutation, no lifecycle).
    // Toolbar is created here but appended below the view-mode chip
    // row so the operator reads top-to-bottom as: pick a view → take
    // an action appropriate to that view.
    const toolbar = el("div", { className: "topology-toolbar" });

    const renderToolbar = (): void => {
      toolbar.textContent = "";
      if (viewMode === "spec") {
        // Spec authoring — Add link mutates the topology spec.
        // Lab + physical lifecycle live in their respective views.
        const addLinkBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "+ Add link");
        addLinkBtn.addEventListener("click", () => {
          openAddLinkDrawer({
            deviceNames,
            topology: data,
            pendingWired: pendingTopologyLinkAdds().flatMap((l) => [l.a, l.z]),
            hostLike: hostLikeDevices(data),
            onSuccess: () => mountTopologyTab(root),
          });
        });
        toolbar.appendChild(addLinkBtn);
      } else if (viewMode === "spec-lab") {
        // Lab substrate lifecycle: Deploy → Provision → Destroy (newtlab's own
        // verbs). Blue (spec-only) devices become green via Deploy + Provision.
        // Convention: lab name == active network ID (newtron#116 / PR #121).
        //
        // Gate each verb on the lab's actual state so the operator can't fire a
        // transition that means nothing — no Provision/Destroy without a deployed
        // lab, no Deploy over one that already exists. labStateRef is the poll-
        // synced lab status (null = not deployed / no lab); the toolbar re-renders
        // when that deployed-ness flips (see onLabStateRefresh).
        const deployed = labStateRef != null;
        const gate = (btn: HTMLElement, enabled: boolean, why: string): void => {
          if (enabled) { btn.removeAttribute("disabled"); btn.removeAttribute("title"); }
          else { btn.setAttribute("disabled", ""); btn.title = why; }
        };
        const deployBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "Deploy");
        deployBtn.addEventListener("click", async () => {
          const network = activeNetwork();
          const ok = await confirmInline({
            title: `Deploy "${network}" as a lab?`,
            body: "VMs will boot for each device in the topology.",
            confirmLabel: "Deploy",
          });
          if (!ok) return;
          openDeployModal(network);
        });
        toolbar.appendChild(deployBtn);

        const provisionBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "Provision");
        provisionBtn.addEventListener("click", async () => {
          const network = activeNetwork();
          const ok = await confirmInline({
            title: `Run provisioning on lab "${network}"?`,
            body: "Requires VMs to be up.",
            confirmLabel: "Provision",
          });
          if (!ok) return;
          openProvisionModal(network);
        });
        toolbar.appendChild(provisionBtn);

        const destroyBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "Destroy");
        destroyBtn.addEventListener("click", async () => {
          const network = activeNetwork();
          const ok = await confirmInline({
            title: `Destroy lab "${network}"?`,
            body: "All VMs and their state will be destroyed. The topology spec stays intact.",
            danger: true,
            confirmLabel: "Destroy",
          });
          if (!ok) return;
          destroyBtn.setAttribute("disabled", "");
          destroyBtn.textContent = "Destroying…";
          postLabDestroy(network)
            .then(() => {
              destroyBtn.removeAttribute("disabled");
              destroyBtn.textContent = "Destroy";
              mountTopologyTab(root);
            })
            .catch((err) => {
              destroyBtn.removeAttribute("disabled");
              destroyBtn.textContent = "Destroy";
              const msg = engineOpErrorBody(err);
              showToast({ kind: "error", title: "Destroy failed", body: msg });
            });
        });
        toolbar.appendChild(destroyBtn);

        gate(deployBtn, !deployed, "Already deployed — Destroy the lab first to redeploy.");
        gate(provisionBtn, deployed, "Deploy the lab first — provisioning needs running VMs.");
        gate(destroyBtn, deployed, "Nothing to destroy — this lab isn't deployed.");
      } else {
        // Physical substrate — only Provision (no deploy / destroy
        // because physical hardware isn't lifecycle-managed by newtcon).
        // Provision drives spec-only (blue) devices toward actuated-ok
        // (green) by pushing the spec projection at the substrate.
        const provisionBtn = el("button", { type: "button", className: "topology-toolbar-btn" }, "Provision");
        provisionBtn.addEventListener("click", async () => {
          const network = activeNetwork();
          const ok = await confirmInline({
            title: `Provision physical substrate for "${network}"?`,
            confirmLabel: "Provision",
          });
          if (!ok) return;
          openProvisionModal(network, { physical: true });
        });
        toolbar.appendChild(provisionBtn);
      }
    };
    renderToolbar();

    // Teaching empty state (slice #169.B). When the topology has zero
    // committed devices, skip the graph + filter + panel and render
    // an explanatory block. The toolbar (Add link) is still appended
    // so the operator has a visible entry point once nodes appear via
    // Specs → Nodes → Save.
    if (deviceNames.length === 0) {
      root.appendChild(toolbar);
      root.appendChild(renderTopologyEmptyState());
      return;
    }

    // Layered filter (slice #174.E): fetch profiles → build device→zone
    // metadata → render zone chips above the SVG. Filter state persists
    // across renderGraph() calls. Profiles fetch is best-effort: failure
    // just means the chip row stays empty (filter is a power affordance,
    // not on the critical path).
    const deviceMetadata = new Map<string, DeviceMetadata>();
    let filterState: TopologyFilter = emptyFilter();
    try {
      const profileNames = await fetchSpecList("nodes");
      const profileDetails = await Promise.all(
        profileNames.map((n) => fetchSpecDetail("nodes", n).catch(() => null)),
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

    // View-mode chip row (slice #210.B) — sits above the zone filter
    // row so the operator sees the actuation-source switch as a
    // first-class control. The chip is always mounted (even with one
    // mode available). All three chips are always enabled — the
    // "no actuation signal" condition is communicated by the view
    // itself (blue spec-only coloring on every element) rather than
    // by a redundant disabled-chip state.
    //
    // Header bar (toolbar convention): view controls left, mutation/action
    // buttons (Add link / Deploy / Provision / Destroy) pushed right, so the
    // operator reads "what am I looking at" on the left and "what can I do"
    // on the right instead of everything stacked into the left gutter.
    // Canvas command bar (uplift 6.1, #444): EVERYTHING that steers the
    // canvas lives in one compact bar — view modes, lenses, zone filter,
    // fabric health, lifecycle actions. The canvas is the home; chrome is
    // one line. Legacy row classes stay on the groups so existing smokes'
    // selectors keep meaning what they meant.
    const headerBar = el("div", { className: "topology-header-bar topology-command-bar" });
    const healthStrip = el("button", { type: "button", className: "fabric-strip" });
    mountFabricHealthStrip(healthStrip);
    const viewRow = el("div", { className: "topology-view-row" });
    const renderViewRow = (): void => {
      viewRow.textContent = "";
      const label = el("span", { className: "topology-view-label" }, "View:");
      viewRow.appendChild(label);
      for (const mode of ALL_VIEW_MODES) {
        const isActive = mode === viewMode;
        const cls = ["chip", "chip--md", "chip--clickable"];
        if (isActive) cls.push("chip--accent");
        const chip = el("button", {
          type: "button",
          className: cls.join(" "),
          title: `Switch to ${viewModeLabel(mode)}`,
        }, viewModeLabel(mode)) as HTMLButtonElement;
        chip.addEventListener("click", () => {
          if (mode === viewMode) return;
          viewMode = mode;
          saveViewMode(activeNetName, mode);
          paletteByDevice = computePaletteByDevice();
          statusTextByDevice = computeStatusTextByDevice();
          // View mode change re-renders the chip row (active highlight),
          // the toolbar (different mutation buttons per view), the
          // graph (palette + status-text swap), the panel (hidden in
          // observation views), and the drift summary (Physical-only).
          renderViewRow();
          renderToolbar();
          renderGraph();
          renderDriftSummary();
        });
        viewRow.appendChild(chip);
      }
    };
    renderViewRow();

    // Filter chip row — rendered as its own row below the toolbar. Only
    // mounted when there's more than one distinct zone to pick from; a
    // single-zone topology has nothing to filter by, so the row stays
    // out of the way. The mount target is captured so toggling can
    // re-render the row without disturbing other DOM.
    // Collapsed zones — the density affordance. A folded zone renders as ONE
    // card standing in for its members (topology-zones.ts does the graph
    // transform); the choice persists per network like pinned positions do.
    //
    // Declared HERE, above the zone chrome, because renderZoneFoldRow() runs at
    // mount to paint the initial button state and reads this — leaving it down
    // with the viewport state put it in the temporal dead zone and threw during
    // mount (surfacing, unhelpfully, as "Failed to load topology").
    let collapsedZones = loadCollapsedZones(activeNetName);
    // applyZoneFold — the one commit path for a fold change (single toggle or
    // the bulk buttons). Folding changes the graph SHAPE, so the cached auto
    // layout no longer describes it: drop the cache and refit the viewport.
    const applyZoneFold = (next: Set<string>): void => {
      collapsedZones = next;
      saveCollapsedZones(activeNetName, collapsedZones);
      resetLayoutCache();
      viewState = undefined;
      renderZoneFoldRow();
      renderGraph();
    };
    const toggleZone = (zone: string): void => {
      const next = new Set(collapsedZones);
      if (next.has(zone)) next.delete(zone); else next.add(zone);
      applyZoneFold(next);
    };

    const zones = uniqueZones(deviceMetadata);

    // Zone fold controls. Deliberately NOT in `toolbar`: that group is gated by
    // view mode (Add link in Spec, the lab lifecycle in Lab), and folding is a
    // way of LOOKING at the canvas — it has to work in every view. So it sits in
    // the command bar beside the zone filter, which is the other zone control.
    const zoneFoldRow = el("div", { className: "topology-filter-row topology-zone-fold-row" });
    const renderZoneFoldRow = (): void => {
      zoneFoldRow.textContent = "";
      if (zones.length === 0) { zoneFoldRow.hidden = true; return; }
      zoneFoldRow.hidden = false;
      zoneFoldRow.appendChild(el("span", { className: "topology-filter-label" }, "Zones:"));
      const folded = zones.filter((z) => collapsedZones.has(z)).length;
      const mk = (label: string, enabled: boolean, title: string, next: () => Set<string>): void => {
        const btn = el("button", {
          type: "button",
          className: "chip chip--md chip--clickable",
          title,
        }, label) as HTMLButtonElement;
        if (!enabled) btn.disabled = true;
        else btn.addEventListener("click", () => applyZoneFold(next()));
        zoneFoldRow.appendChild(btn);
      };
      mk(`Collapse all${zones.length > 1 ? ` (${zones.length})` : ""}`, folded < zones.length,
        folded < zones.length
          ? "Fold every zone into a single card — the compact view for a large fabric"
          : "Every zone is already collapsed",
        () => new Set(zones));
      mk("Expand all", folded > 0,
        folded > 0 ? "Unfold every zone back to its devices" : "No zones are collapsed",
        () => new Set<string>());
      if (folded > 0) {
        zoneFoldRow.appendChild(el("span", { className: "topology-zone-fold-count" },
          `${folded} of ${zones.length} folded`));
      }
    };

    const filterRow = el("div", { className: "topology-filter-row" });
    const renderFilterRow = (): void => {
      filterRow.textContent = "";
      const label = el("span", { className: "topology-filter-label" }, "Zone:");
      filterRow.appendChild(label);
      for (const z of zones) {
        const active = filterState.zones.has(z);
        const chip = el("button", {
          type: "button",
          className: "chip chip--md chip--clickable" + (active ? " chip--accent" : ""),
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

    // Lens chip row (slice 4.3) — always mounted: lenses re-weight the
    // canvas around one concern (VNI footprint / underlay health / drift)
    // without touching layout. Session-scoped state; chips re-render in
    // place, then the graph re-renders with the lens effect applied.
    let lensState: LensState = { kind: null };
    const lensRow = el("div", { className: "topology-filter-row topology-lens-row" });
    headerBar.append(viewRow, lensRow);
    if (zones.length > 1) headerBar.appendChild(filterRow);
    if (zones.length > 0) { renderZoneFoldRow(); headerBar.appendChild(zoneFoldRow); }
    headerBar.append(toolbar);
    root.appendChild(headerBar);
    const renderLensRow = (): void => {
      lensRow.textContent = "";
      // Inert-chip suppression (operator feedback): only lenses that can
      // BITE render — vni needs VLANs, underlay/drift need probe results,
      // live needs online devices. No lenses → the whole group hides.
      const lensesUp = availableLenses({
        vlanCount: availableVlans(rawDevices).length,
        underlayProbes: underlayByDevice.size,
        driftProbes: driftByDevice.size,
        onlineDevices: [...onlineByDevice.values()].filter(Boolean).length,
      });
      if (lensState.kind !== null && !lensesUp.includes(lensState.kind)) {
        lensState = { kind: null }; // active lens lost its footing — reset
      }
      lensRow.hidden = lensesUp.length === 0;
      if (lensesUp.length === 0) return;
      lensRow.appendChild(el("span", { className: "topology-filter-label" }, "Lens:"));
      const lensChip = (label: string, kind: "vni" | "underlay" | "drift" | "live"): void => {
        const active = lensState.kind === kind;
        const chip = el("button", {
          type: "button",
          className: "chip chip--md chip--clickable" + (active ? " chip--accent" : ""),
        }, label) as HTMLButtonElement;
        chip.addEventListener("click", () => {
          lensState = active ? { kind: null } : kind === "vni"
            ? { kind, ...(availableVlans(rawDevices).length === 1 ? { vlanId: availableVlans(rawDevices)[0] } : {}) }
            : { kind };
          renderLensRow();
          renderGraph();
          heatPoll.sync();
        });
        lensRow.appendChild(chip);
      };
      if (lensesUp.includes("vni")) lensChip("VNI", "vni");
      if (lensesUp.includes("underlay")) lensChip("Underlay", "underlay");
      if (lensesUp.includes("drift")) lensChip("Drift", "drift");
      if (lensesUp.includes("live")) lensChip("Live", "live");
      if (lensState.kind === "vni") {
        for (const vlan of availableVlans(rawDevices)) {
          const active = lensState.vlanId === vlan;
          const chip = el("button", {
            type: "button",
            className: "chip chip--sm chip--clickable" + (active ? " chip--accent" : ""),
          }, `VLAN ${vlan}`) as HTMLButtonElement;
          chip.addEventListener("click", () => {
            lensState = { kind: "vni", ...(active ? {} : { vlanId: vlan }) };
            renderLensRow();
            renderGraph();
          });
          lensRow.appendChild(chip);
        }
      }
    };

    // Pan/zoom viewport state — persists across renderGraph() calls so
    // the operator's view doesn't snap back to natural after every
    // selection / pending-bar / status tick.
    let viewState: ViewState | undefined;

    // Per-device pinned positions — loaded once at mount, mutated when
    // the operator drag-drops a node, persisted to localStorage. Keyed
    // by the active network so multiple operator topologies don't share.
    const activeNet = activeNetName;
    const pinnedPositions = loadPositions(activeNet);


    // Topology view: layout is a split — left = SVG diagram + toolbar,
    // right = docked action panel.
    const split = el("div", { className: "topology-split" });
    const graphSlot = el("div", { className: "topology-graph-slot" });
    split.appendChild(graphSlot);
    root.appendChild(split);

    // Status strip BELOW the canvas: the fabric's health is a footer on the
    // picture it describes. The view is a flex column sized to the content
    // area, so this row is always on screen however the window is resized —
    // the canvas gives up height, the footer keeps its own.
    const footer = el("div", { className: "topology-footer" });
    footer.appendChild(healthStrip);
    root.appendChild(footer);

    // Floating zoom toolbar — absolute-positioned over the SVG via
    // .topology-zoom-toolbar styling; outlives renderGraph() calls.
    const { toolbar: zoomToolbar, zoomOutBtn, zoomInBtn, fitBtn, resetPosBtn } = buildZoomToolbar(graphSlot);
    graphSlot.appendChild(zoomToolbar);

    graphSlot.appendChild(buildNavHint());
    graphSlot.appendChild(buildLinkLegend());

    // Interface lists pulled from the topology declaration (works offline);
    // live-fetched lists merge in via the panel module's source cache.
    const interfacesByDevice: Map<string, string[]> = new Map();
    const rawData = (data ?? {}) as { nodes?: Record<string, { ports?: Record<string, unknown>; steps?: Array<{ params?: { fields?: { type?: string } } }> }> };
    const rawDevices: Record<string, { ports?: Record<string, unknown>; steps?: Array<{ params?: { fields?: { type?: string } } }> }> = { ...(rawData.nodes ?? {}) };
    // Initial lens-row render deferred to here: availability consults
    // rawDevices (VLAN catalog) — rendering earlier is a TDZ trap.
    renderLensRow();
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
    for (const [name, dev] of Object.entries(rawDevices)) {
      interfacesByDevice.set(name, Object.keys(dev?.ports ?? {}).sort(comparePorts));
    }

    // Live-layer heat poll (slice 4.4) — bounded + gated on the Live lens;
    // see live-heat.ts. Ticks patch link classes in place, no re-render.
    const heatPoll = createHeatPoll({
      graphSlot,
      deviceNames,
      onlineByDevice,
      speedsByDevice,
      isLiveLensOn: () => lensState.kind === "live",
    });

    let renderGraph: () => void;
    renderGraph = (): void => {
      // Preserve the zoom toolbar across re-renders; only clear the SVG.
      const oldSvg = graphSlot.querySelector("svg.topology-graph");
      if (oldSvg) oldSvg.remove();
      // Compute dimmed set from the current filter; passed through to
      // renderTopologySVG which applies the dim class to nodes + links.
      // Zone→device map drives BOTH the zone tinting and the fold.
      const zoneByDevice = new Map(
        [...deviceMetadata.entries()].filter(([, m]) => m.zone !== null).map(([d, m]) => [d, m.zone as string]),
      );
      // Fold collapsed zones into single cards BEFORE anything else looks at
      // the graph, so layout, filtering and lenses all operate on what is
      // actually drawn. A no-op when nothing is folded.
      const folded = collapseZones(topoData.nodes ?? [], topoData.links ?? [], zoneByDevice, collapsedZones);
      const drawData = { ...topoData, nodes: folded.nodes, links: folded.links };
      const allNames = folded.nodes.map((n) => n.name);
      const dimmed = applyFilter(filterState, allNames, deviceMetadata).hidden;
      // Lens effect (slice 4.3): dim merges with the zone filter; halo and
      // badges pass through. Same positions either way — layout-stable.
      const lens = lensEffect(lensState, {
        allDevices: allNames,
        ...(lensState.kind === "vni" && lensState.vlanId !== undefined
          ? { vlanMembers: vlanMembership(rawDevices, lensState.vlanId) } : {}),
        underlayByDevice,
        driftByDevice,
      });
      for (const d of lens.dim) dimmed.add(d);
      const lensStatusText = new Map(statusTextByDevice);
      // vni carries its detail as PORT PILLS now — only non-vni lenses
      // (drift's count) still annotate via the footer text.
      if (lensState.kind !== "vni") {
        for (const [d, text] of lens.badge) lensStatusText.set(d, text);
      }
      const vniMemberPorts = lensState.kind === "vni" && lensState.vlanId !== undefined
        ? vlanMembership(rawDevices, lensState.vlanId)
        : undefined;
      // Spec view = authoring (select + side panel + right-click
      // context menu + node delete). Observation views (Lab / Physical)
      // = left-click opens the drawer directly for inspection; right-
      // click + delete affordance omitted.
      const isSpec = viewMode === "spec";
      const specOnlyOpts = isSpec
        ? {
            onNodeContextMenu: (deviceName: string, ev: MouseEvent) => {
              showContextMenu(NODE_ACTIONS, {
                kind: "node",
                device: deviceName,
                anchorX: ev.clientX,
                anchorY: ev.clientY,
                onComplete: () => mountTopologyTab(root),
                onInspect: () => openNodeDrawer(deviceName, viewMode),
              });
            },
          }
        : {};
      const result = renderTopologySVG(drawData, {
        paletteByDevice,
        statusTextByDevice: lensStatusText,
        haloNames: lens.halo,
        dimmedNames: dimmed,
        // Click a device — in EVERY view — opens the drawer, the single home for
        // device inspection + per-port/interface config. (There is no docked
        // action panel + selection any more; link creation is on the toolbar.)
        onNodeClick: (deviceName) => { openNodeDrawer(deviceName, viewMode); },
        driftByDevice,
        statusByDevice,
        // A folded zone IS its card — it must not also draw a tinted region.
        zoneByDevice: new Map([...zoneByDevice].filter(([, z]) => !collapsedZones.has(z))),
        onZoneToggle: toggleZone,
        ...(vniMemberPorts !== undefined ? { vniMemberPorts } : {}),
        lldpByDevice,
        speedsByDevice,
        portStatesByDevice,
        lagMembersByDevice,
        underlayByDevice,
        selected: new Set<string>(),
        viewState,
        onViewStateChange: (next) => { viewState = next; },
        pinnedPositions,
        onNodeMoved: (name, pos) => {
          pinnedPositions.set(name, pos);
          savePosition(activeNet, name, pos);
          renderGraph();
        },
        onLinkClick: (link) => openLinkDrawer(link, rawDevices),
        ...specOnlyOpts,
      });
      // Focus mode (slice 4.5): keyboard focus on a device dims everything
      // but the device + its direct neighbors — patched IN PLACE so focus
      // survives (a re-render would drop the focused element). Esc restores;
      // arrow keys walk the graph geometrically.
      const applyFocusDim = (dim: Set<string> | null): void => {
        for (const g of result.svg.querySelectorAll<SVGGElement>(".topo-node")) {
          const name = g.getAttribute("data-device") ?? "";
          g.classList.toggle("topo-node--focus-dimmed", dim !== null && dim.has(name));
        }
        for (const line of result.svg.querySelectorAll<SVGLineElement>(".topo-link:not(.topo-link-hit)")) {
          const a = line.getAttribute("data-local-device") ?? "";
          const z = line.getAttribute("data-remote-device") ?? "";
          line.classList.toggle("topo-link--focus-dimmed", dim !== null && (dim.has(a) || dim.has(z)));
        }
      };
      result.svg.addEventListener("focusin", (ev) => {
        const g = (ev.target as Element | null)?.closest?.(".topo-node");
        const name = g?.getAttribute("data-device");
        if (name) applyFocusDim(focusDim(name, folded.nodes.map((n) => n.name), folded.links));
      });
      result.svg.addEventListener("focusout", (ev) => {
        // Leaving the SVG entirely clears the focus dim; moving between
        // nodes re-applies via the next focusin.
        const next = (ev as FocusEvent).relatedTarget as Element | null;
        if (!next || !result.svg.contains(next)) applyFocusDim(null);
      });
      result.svg.addEventListener("keydown", (ev) => {
        const g = (ev.target as Element | null)?.closest?.(".topo-node");
        const name = g?.getAttribute("data-device");
        if (!name) return;
        if (ev.key === "Escape") {
          applyFocusDim(null);
          (g as unknown as { blur?: () => void }).blur?.();
          return;
        }
        const dir: NavDirection | null =
          ev.key === "ArrowUp" ? "up" : ev.key === "ArrowDown" ? "down"
          : ev.key === "ArrowLeft" ? "left" : ev.key === "ArrowRight" ? "right" : null;
        if (dir === null) return;
        ev.preventDefault();
        const next = nearestInDirection(name, result.positions, dir);
        if (next) (result.svg.querySelector(`.topo-node[data-device="${next}"]`) as unknown as { focus?: () => void })?.focus?.();
      });

      // SVG sits behind the toolbar (toolbar is z-indexed above).
      graphSlot.insertBefore(result.svg, zoomToolbar);
      // Remember the natural width so the toolbar handlers can compute
      // zoom bounds + fit relative to a stable reference.
      lastNaturalWidth = result.width;
      lastResultBounds = result.bounds;

      // First-mount fit: the SVG uses preserveAspectRatio="xMidYMid meet",
      // so a viewBox whose aspect differs from the slot's aspect would
      // letterbox the diagram (centered with padding on the longer axis).
      // That centering throws off the screen-to-viewBox math used by
      // wheel-zoom and drag-pan because clientX/clientY map to a region
      // inside the slot that doesn't cover the full slot. Compute a
      // fit-to-bounds viewBox that matches the slot's aspect on initial
      // render — the diagram still occupies its natural area, the
      // viewBox just extends to slot aspect with even margin.
      //
      // requestAnimationFrame ensures getBoundingClientRect runs after
      // layout when the SVG is actually sized.
      if (viewState === undefined) {
        requestAnimationFrame(() => {
          const rect = result.svg.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            viewState = fitToBounds(lastResultBounds, rect.width, rect.height);
            // Re-render with the fit viewState — NOT just setAttribute. Pan/zoom is
            // only wired when renderTopologySVG receives a defined viewState (the
            // SVG is recreated each render), so without this re-render the first
            // mount shows the fit view but the wheel/drag handlers never attach.
            renderGraph();
          }
        });
      }
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
    resetPosBtn.addEventListener("click", async () => {
      // Re-run the auto layout: discard any manual drags, recompute fresh, refit.
      // Confirm only when there are manual positions to throw away.
      if (pinnedPositions.size > 0) {
        const ok = await confirmInline({
          title: `Re-run layout — discard ${pinnedPositions.size} manual position${pinnedPositions.size === 1 ? "" : "s"}?`,
          body: "Nodes return to the automatic layout.",
          confirmLabel: "Re-run layout",
        });
        if (!ok) return;
        pinnedPositions.clear();
        clearPositions(activeNet);
      }
      resetLayoutCache();      // force a fresh layout pass
      viewState = undefined;   // refit the viewport to the new layout
      renderGraph();
    });

    // Re-render the graph when the pending queue changes — but do NOT remount
    // (that would reset the pan/zoom viewport). The graph reflects pending
    // adds/removes; per-device apply lives on the drawer + the workspace bar.
    const unsub = subscribePending(() => { renderGraph(); });
    if ((root as unknown as { _topoUnsub?: () => void })._topoUnsub) {
      (root as unknown as { _topoUnsub?: () => void })._topoUnsub!();
    }
    (root as unknown as { _topoUnsub?: () => void })._topoUnsub = unsub;

    renderGraph();

    // Phase 2: live-update device badges on a 5s tick. Patches in place — the
    // operator can keep interacting with the panel + drawers while statuses
    // refresh. Restart on every mount so re-renders don't accumulate timers.
    startTopologyPoll({
      network: activeNetName,
      graphSlot,
      deviceNames,
      onlineByDevice,
      rebuildPalette: (lab) => {
        labStateRef = lab;
        paletteByDevice = computePaletteByDevice();
        return paletteByDevice;
      },
      rebuildStatusText: () => {
        statusTextByDevice = computeStatusTextByDevice();
        return statusTextByDevice;
      },
      onLabStateRefresh: (lab) => {
        // Re-gate the lab toolbar when deployment state flips (deploy brought the
        // lab up / destroy tore it down) so Deploy/Provision/Destroy enable-state
        // tracks reality. Only when the boolean actually changes — no per-poll churn.
        const was = labStateRef != null;
        labStateRef = lab;
        if (was !== (lab != null) && viewMode === "spec-lab") renderToolbar();
      },
    });

    // Drift summary is a physical-substrate signal — surface only in
    // Physical view. Re-renders alongside view-mode changes via
    // renderDriftSummary().
    const driftSummaryRow = el("div");
    footer.appendChild(driftSummaryRow);
    const renderDriftSummary = (): void => {
      driftSummaryRow.textContent = "";
      if (viewMode !== "spec-physical") return;
      const totalDrift = Array.from(driftByDevice.values()).reduce((a, b) => a + b, 0);
      const summary = el(
        "p",
        { className: totalDrift > 0 ? "topology-drift-summary topology-drift-summary--present" : "topology-drift-summary" },
        totalDrift > 0
          ? `${totalDrift} drift item${totalDrift === 1 ? "" : "s"} across ${driftByDevice.size} device${driftByDevice.size === 1 ? "" : "s"} — click a device to inspect.`
          : "No drift detected on any device.",
      );
      driftSummaryRow.appendChild(summary);
    };
    renderDriftSummary();
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

// ---- Public API -------------------------------------------------------------
// The view's outward surface. router.ts (mountTopologyTab / stopTopologyPoll)
// and views/drawer/ (isProvisioning / TopoLink) import from this module, so
// re-exporting here keeps the internal file split invisible to them.
export { type TopoLink } from "./canvas.js";
export { isProvisioning } from "./lab-ops.js";
export { stopTopologyPoll } from "./status-poll.js";
