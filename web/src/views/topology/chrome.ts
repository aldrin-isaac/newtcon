// views/topology/chrome.ts — the canvas's static furniture: the floating zoom
// toolbar, the navigation hint, the link-truth legend, and the empty state.
//
// "Static" means these are pure builders — they construct DOM from nothing and
// hand back the element (plus button handles where the caller needs to wire
// behaviour). The stateful chrome (view-mode chips, zone filter, lens row)
// stays in index.ts because it reads and writes the mount's live view state.

import { el } from "../../dom.js";
import { TOPOLOGY_EMPTY } from "../../empty-states.js";
import { svgEl } from "./canvas.js";

// renderTopologyEmptyState renders the teaching block for an empty
// Topology view (slice #169.B). The action buttons (Create node, Bring
// up as lab) are already in the toolbar above this block — the text
// here explains what Topology is and what those buttons do, not where
// to find them.
export function renderTopologyEmptyState(): HTMLElement {
  const block = el("div", { className: "panel-empty topology-empty-state" });
  block.appendChild(el("p", { className: "panel-empty-headline" }, TOPOLOGY_EMPTY.title));
  block.appendChild(el("p", { className: "panel-empty-body" }, TOPOLOGY_EMPTY.body));
  if (TOPOLOGY_EMPTY.hint) {
    block.appendChild(el("p", { className: "panel-empty-hint" }, TOPOLOGY_EMPTY.hint));
  }
  return block;
}

export interface ZoomToolbar {
  toolbar: HTMLElement;
  zoomOutBtn: HTMLButtonElement;
  zoomInBtn: HTMLButtonElement;
  fitBtn: HTMLButtonElement;
  resetPosBtn: HTMLButtonElement;
  gridBtn: HTMLButtonElement;
}

/** buildZoomToolbar — the floating zoom/fit/grid/reset toolbar that sits over
 *  the SVG (absolute-positioned via .topology-zoom-toolbar) and outlives
 *  renderGraph() calls. The grid toggle is self-wired (pure presentation,
 *  persisted per browser); the rest are returned for the caller to wire against
 *  its viewport state. */
export function buildZoomToolbar(graphSlot: HTMLElement): ZoomToolbar {
  const toolbar = el("div", { className: "topology-zoom-toolbar", role: "toolbar", ariaLabel: "Topology zoom" });
  const zoomOutBtn = el("button", { type: "button", className: "topology-zoom-btn", title: "Zoom out" }, "−") as HTMLButtonElement;
  const zoomInBtn = el("button", { type: "button", className: "topology-zoom-btn", title: "Zoom in" }, "+") as HTMLButtonElement;
  const fitBtn = el("button", { type: "button", className: "topology-zoom-btn", title: "Fit to view" }, "⊡") as HTMLButtonElement;
  const resetPosBtn = el("button", {
    type: "button",
    className: "topology-zoom-btn topology-zoom-btn--reset",
    title: "Re-run auto layout (discards manual moves)",
  }, "↺") as HTMLButtonElement;
  const gridBtn = el("button", {
    type: "button",
    className: "topology-zoom-btn topology-grid-btn" + (localStorage.getItem("newtcon.topoGrid") === "off" ? "" : " topology-grid-btn--on"),
    title: "Toggle canvas grid",
  }, "⁙") as HTMLButtonElement;
  gridBtn.addEventListener("click", () => {
    const off = localStorage.getItem("newtcon.topoGrid") === "off";
    try { localStorage.setItem("newtcon.topoGrid", off ? "on" : "off"); } catch { /* session-only */ }
    gridBtn.classList.toggle("topology-grid-btn--on", off);
    graphSlot.querySelector(".topo-grid")?.classList.toggle("topo-grid--off", !off);
  });
  toolbar.append(zoomOutBtn, zoomInBtn, fitBtn, gridBtn, resetPosBtn);
  return { toolbar, zoomOutBtn, zoomInBtn, fitBtn, resetPosBtn, gridBtn };
}

/** buildNavHint — small chip in the bottom-left of the slot so the operator
 *  sees the pan/zoom affordances without discovering them by accident. */
export function buildNavHint(): HTMLElement {
  return el(
    "div",
    { className: "topology-nav-hint", ariaHidden: "true" },
    "scroll to zoom · drag to pan",
  );
}

/** buildLinkLegend — the link-truth legend (slice 4.2), bottom-right twin of the
 *  nav hint. Tiny inline SVG swatches teach the line grammar: solid =
 *  LLDP-verified, dashed = intent-only, red = mis-cabled / underlay-down,
 *  thickness = speed. */
export function buildLinkLegend(): HTMLElement {
  const legend = el("div", { className: "topo-legend", ariaHidden: "true" });
  const swatch = (cls: string, w: number, dash?: string): SVGElement => {
    const sw = svgEl("svg", { width: "22", height: "8", viewBox: "0 0 22 8" });
    sw.appendChild(svgEl("line", {
      "class": cls, x1: "1", y1: "4", x2: "21", y2: "4",
      "stroke-width": String(w), ...(dash !== undefined ? { "stroke-dasharray": dash } : {}),
    }));
    return sw;
  };
  const legendItem = (label: string, cls: string, w: number, dash?: string): HTMLElement => {
    const item = el("span", { className: "topo-legend-item" });
    item.append(swatch(cls, w, dash), el("span", {}, label));
    return item;
  };
  legend.append(
    legendItem("verified", "topo-link topo-elem--actuated-ok", 2),
    legendItem("intent-only", "topo-link topo-elem--spec-only", 1.5, "4 3"),
    legendItem("mis-cable / underlay down", "topo-link topo-link--mismatch", 3),
    legendItem("thickness = speed", "topo-link topo-elem--unknown", 3),
  );
  return legend;
}
