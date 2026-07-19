// views/topology/index.ts — the Topology workspace view (console-uplift 1.4,
// move-only extraction from app.ts): the SVG canvas renderer + layered
// palette, viewport pan/zoom wiring, layout cache, view-mode chips + zone
// filter + header toolbar, the Add-link drawer, lab lifecycle modals
// (deploy / provision / destroy + SSE log), the newtlab status poll, and
// mountTopologyTab itself. This completes the Phase-1 view extractions —
// the last temp import (isProvisioning, ex-app.ts) now lives here and
// views/drawer imports it from its real home.

// renderTopologyEmptyState renders the teaching block for an empty
// Topology view (slice #169.B). The action buttons (Create node, Bring
// up as lab) are already in the toolbar above this block — the text
// here explains what Topology is and what those buttons do, not where
// to find them.
import { type LabState, fetchLabStatus, labEvents, postLabDeploy, postLabDestroy, postLabProvision } from "../../api/newtcon/lab.js";
import { fetchPlatformPorts, fetchSpecDetail, fetchSpecList } from "../../api/newtcon/network.js";
import { fetchNodeBGPCheck, fetchNodeDBTable, fetchNodeDrift, fetchNodeInfo, fetchTopology } from "../../api/newtcon/nodes.js";
import {
  type LldpNeighbor, type UnderlayState,
  parseLldpTable, parsePortSpeeds, parseBgpCheckOk,
  classifyLink, linkSpeedForLink, linkStrokeWidth, linkUnderlayState,
} from "../../topology-links.js";
import { ApiError } from "../../api/newtcon/services.js";
import { confirmInline } from "../../confirm-inline.js";
import { type DeviceStatus, resolveDeviceStatus } from "../../device-status.js";
import { el } from "../../dom.js";
import { TOPOLOGY_EMPTY } from "../../empty-states.js";
import { activeNetwork } from "../../network-switcher.js";
import { hostLikeDevices } from "../../node-references.js";
import { comparePorts } from "../../port-config.js";
import { engineOpErrorBody } from "../../render-error.js";
import { enqueuePortConfig, enqueueTopologyAddLink, pendingTopologyLinkAdds, subscribe as subscribePending } from "../../staging.js";
import { showToast } from "../../toast.js";
import { showContextMenu } from "../../topology-actions-ui.js";
import { NODE_ACTIONS } from "../../topology-actions.js";
import { type DeviceMetadata, type TopologyFilter, applyFilter, emptyFilter, isActive as filterIsActive, uniqueZones } from "../../topology-filters.js";
import { computeTopologyLayout } from "../../topology-layout.js";
import { type PaletteState, resolveLabDevicePalette, resolveLabStatusText, resolveLinkPalette, resolvePhysicalDevicePalette, resolvePhysicalStatusText } from "../../topology-palette.js";
import { type PinnedPosition, clearPositions, loadPositions, savePosition } from "../../topology-positions.js";
import { ALL_VIEW_MODES, type TopologyViewMode, defaultViewMode, loadViewMode, saveViewMode, viewModeLabel } from "../../topology-view-mode.js";
import { type ViewState, ZOOM_STEP, fitToBounds, panBy, viewBoxStr, zoomAt } from "../../topology-viewport.js";
import { openLinkDrawer, openNodeDrawer } from "../../views/drawer/index.js";
function renderTopologyEmptyState(): HTMLElement {
  const block = el("div", { className: "panel-empty topology-empty-state" });
  block.appendChild(el("p", { className: "panel-empty-headline" }, TOPOLOGY_EMPTY.title));
  block.appendChild(el("p", { className: "panel-empty-body" }, TOPOLOGY_EMPTY.body));
  if (TOPOLOGY_EMPTY.hint) {
    block.appendChild(el("p", { className: "panel-empty-hint" }, TOPOLOGY_EMPTY.hint));
  }
  return block;
}


// ---- Detail drawer (spec) ---------------------------------------------------

// ---- Topology types ---------------------------------------------------------

interface TopoNode {
  name: string;
  type?: string;
  [k: string]: unknown;
}

export interface TopoLink {
  local_device?: string;
  local_interface?: string;
  remote_device?: string;
  remote_interface?: string;
  [k: string]: unknown;
}

interface TopologyData {
  nodes?: TopoNode[];
  links?: TopoLink[];
  [k: string]: unknown;
}
// ---- Topology shape adapter -------------------------------------------------

// Newtron returns: { devices: { name1: { steps?, ... }, ... }, links: [{a: "dev:iface", z: "dev:iface"}], ... }
// The renderer expects:    { nodes:   [{ name, type? }, ...],          links: [{local_device, local_interface, remote_device, remote_interface}, ...] }
// Adapt before rendering so the renderer stays simple.
function adaptTopology(raw: unknown): TopologyData {
  const r = (raw ?? {}) as Record<string, unknown>;
  // If it's already in the renderer shape (nodes as an array), pass through;
  // newtron's raw topology has nodes as a map (newtron #320 key rename), which
  // we adapt below.
  if (Array.isArray((r as { nodes?: unknown }).nodes)) return r as TopologyData;

  const devices = (r.nodes ?? {}) as Record<string, Record<string, unknown>>;
  const nodes: TopoNode[] = Object.entries(devices).map(([name, def]) => {
    // Infer node type from common patterns: host* prefix → "host"; presence of steps → "switch".
    const lower = name.toLowerCase();
    let type: string | undefined;
    if (lower.startsWith("host")) type = "host";
    else if (Array.isArray((def as { steps?: unknown }).steps)) type = "switch";
    return type ? { name, type } : { name };
  });

  type RawLink = { a?: string; z?: string };
  const rawLinks = Array.isArray(r.links) ? (r.links as RawLink[]) : [];
  const links: TopoLink[] = rawLinks.map((lnk) => {
    const split = (s?: string): { device?: string; iface?: string } => {
      if (typeof s !== "string") return {};
      const idx = s.indexOf(":");
      if (idx < 0) return { device: s };
      return { device: s.slice(0, idx), iface: s.slice(idx + 1) };
    };
    const a = split(lnk.a);
    const z = split(lnk.z);
    const out: TopoLink = {};
    if (a.device) out.local_device = a.device;
    if (a.iface) out.local_interface = a.iface;
    if (z.device) out.remote_device = z.device;
    if (z.iface) out.remote_interface = z.iface;
    return out;
  });

  return { nodes, links };
}

// ---- Topology SVG renderer --------------------------------------------------

const NODE_W = 120;
const NODE_H = 52;
const H_GAP = 80;
const V_GAP = 60;

// Module-level cache for the layered auto layout. Keyed by a signature of the
// graph (node names + host flags + link pairs) so re-renders that don't change the
// graph — the 5s status poll, staging changes — reuse the exact same arrangement
// instead of re-running the layout (deterministic, but recompute is wasted work).
let topoLayoutCache: { sig: string; pos: Map<string, { cx: number; cy: number }> } | null = null;

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {}
): SVGElementTagNameMap[K] {
  const ns = "http://www.w3.org/2000/svg";
  const node = document.createElementNS(ns, tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  return node;
}

// PaletteByDevice — pre-resolved palette state per device, computed
// in mountTopologyTab based on the active view mode (slice #210.B/C/D).
// The renderer is palette-agnostic; the view mode is responsible for
// picking which source feeds each device's state.
type PaletteByDevice = Map<string, PaletteState>;

// StatusTextByDevice — short textual status drawn under each device's
// rect in lab/physical views. Empty string ("") suppresses the label
// for that device; missing entries also suppress.
type StatusTextByDevice = Map<string, string>;

interface TopologyRenderOpts {
  paletteByDevice?: PaletteByDevice;
  statusTextByDevice?: StatusTextByDevice;
  onNodeClick: (name: string, ev: MouseEvent) => void;
  onNodeContextMenu?: (name: string, ev: MouseEvent) => void;
  driftByDevice?: Map<string, number>;
  statusByDevice?: Map<string, DeviceStatus>;
  // Link truth (slice 4.2) — LLDP far-ends / actuated speeds / underlay
  // health per device; the link loop derives verdict + width + state class.
  lldpByDevice?: Map<string, LldpNeighbor[]>;
  speedsByDevice?: Map<string, Map<string, number>>;
  underlayByDevice?: Map<string, UnderlayState>;
  selected?: Set<string>;
  pendingByDevice?: Map<string, number>;  // count of unsaved-intent items per device
  // Staging overlays — render device cards in green/red according to queue state.
  isPendingAdd?: (name: string) => boolean;
  isPendingRemove?: (name: string) => boolean;

  // Viewport — pan/zoom state persisted across re-renders by the caller
  // (mountTopologyTab). When provided, the SVG renders with the supplied
  // viewBox + wheel/drag listeners that mutate the state through
  // onViewStateChange. When omitted, the SVG uses its natural viewBox
  // (no pan/zoom interactivity) — kept as the fallback shape so tests /
  // ad-hoc callers don't need to opt in.
  viewState?: ViewState | undefined;
  onViewStateChange?: (next: ViewState) => void;

  // Per-device pinned positions overriding the grid layout. The caller
  // (mountTopologyTab) loads them from localStorage at mount time;
  // onNodeMoved fires when the operator drags + releases a node so the
  // caller can persist the new position.
  pinnedPositions?: Map<string, PinnedPosition>;
  onNodeMoved?: (name: string, pos: PinnedPosition) => void;

  // Link click → drawer with what's bound at each endpoint (#174.D).
  // When wired, links become interactive: cursor flips to pointer + a
  // wider invisible hit target is drawn under each visible link line.
  onLinkClick?: (link: TopoLink) => void;

  // Layered filter dimming (#174.E): devices in this set keep their
  // layout slot but render at reduced opacity so the operator sees the
  // filtered subset against the full topology context. Links touching
  // any dimmed endpoint are dimmed too.
  dimmedNames?: Set<string>;
}

interface TopologyRenderResult {
  svg: SVGSVGElement;
  // Per-device pixel position of the centre of the device card, relative to
  // the SVG's origin. Used by the HTML overlay (interface pills + selection
  // glow) so it can align with each device without going through SVG layout.
  positions: Map<string, { cx: number; cy: number }>;
  width: number;
  height: number;
  // Actual content bounds (node-box extents) in SVG coordinates — the force
  // layout has no fixed origin, so callers must frame these, not (0,0,w,h).
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

function renderTopologySVG(
  data: TopologyData,
  opts: TopologyRenderOpts,
): TopologyRenderResult {
  const nodes: TopoNode[] = Array.isArray(data.nodes) ? data.nodes : [];
  const links: TopoLink[] = Array.isArray(data.links) ? data.links : [];
  const selected = opts.selected ?? new Set<string>();

  // Layered fabric layout (topology-layout.ts): rank by tier (BFS from hosts →
  // hosts on the bottom line, leaves above, spines on top), pods kept contiguous,
  // crossings minimised, no boxes overlap. The auto layout is a pure function of
  // the graph, so cache it by graph signature — re-renders that don't change the
  // graph (status poll, staging) reuse the exact same arrangement. Operator-dragged
  // (pinned) positions override the auto layout.
  const layoutInputs = nodes.map((nd) => ({ name: nd.name, isHost: nd.type === "host" }));
  const layoutEdges = links
    .filter((l) => l.local_device && l.remote_device)
    .map((l) => ({ a: l.local_device as string, z: l.remote_device as string }));
  const sig = JSON.stringify([
    layoutInputs.map((i) => i.name + (i.isHost ? "H" : "")).sort(),
    layoutEdges.map((e) => [e.a, e.z].sort().join("")).sort(),
  ]);
  let autoPos: Map<string, { cx: number; cy: number }>;
  if (topoLayoutCache && topoLayoutCache.sig === sig) {
    autoPos = topoLayoutCache.pos;
  } else {
    autoPos = computeTopologyLayout(layoutInputs, layoutEdges, {
      nodeW: NODE_W, nodeH: NODE_H, hGap: H_GAP, vGap: V_GAP,
    });
    topoLayoutCache = { sig, pos: autoPos };
  }

  const positions = new Map<string, { cx: number; cy: number }>();
  for (const nd of nodes) {
    const pin = opts.pinnedPositions?.get(nd.name);
    positions.set(nd.name, pin ? { cx: pin.cx, cy: pin.cy } : (autoPos.get(nd.name) ?? { cx: 0, cy: 0 }));
  }

  // Fit the viewBox to the actual layout bounds — the force layout has no fixed
  // origin and positions can be negative. MARGIN keeps boxes off the edge.
  const MARGIN = Math.max(NODE_W, NODE_H);
  let minX = 0, minY = 0, maxX = NODE_W, maxY = NODE_H;
  if (positions.size > 0) {
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    for (const p of positions.values()) {
      minX = Math.min(minX, p.cx - NODE_W / 2);
      minY = Math.min(minY, p.cy - NODE_H / 2);
      maxX = Math.max(maxX, p.cx + NODE_W / 2);
      maxY = Math.max(maxY, p.cy + NODE_H / 2);
    }
  }
  const svgW = (maxX - minX) + MARGIN * 2;
  const svgH = (maxY - minY) + MARGIN * 2;
  const naturalViewBox = `${minX - MARGIN} ${minY - MARGIN} ${svgW} ${svgH}`;
  const initialViewBox = opts.viewState ? viewBoxStr(opts.viewState) : naturalViewBox;

  // No width/height attrs — CSS sizes the SVG to fill its slot, and
  // viewBox + preserveAspectRatio handle the coordinate mapping. This
  // lets the topology canvas grow to match the page viewport without
  // the SVG fighting browser scrollbars. preserveAspectRatio defaults
  // to xMidYMid meet, which centres the content and never squashes —
  // the right default for a network diagram.
  const svg = svgEl("svg", {
    viewBox: initialViewBox,
    preserveAspectRatio: "xMidYMid meet",
    "class": "topology-graph",
    role: "img",
    "aria-label": "Network topology diagram",
  });

  // Draw links first (under nodes). When onLinkClick is wired, each
  // visible line gets a wider invisible hit-target sibling so clicking
  // on or near the line is reliable — bare 1.5px strokes are nearly
  // impossible to hit.
  const dimmed = opts.dimmedNames ?? new Set<string>();
  const paletteByDevice = opts.paletteByDevice;
  for (const link of links) {
    const from = link.local_device ? positions.get(link.local_device) : undefined;
    const to = link.remote_device ? positions.get(link.remote_device) : undefined;
    if (!from || !to) continue;
    const linkDimmed = (link.local_device !== undefined && dimmed.has(link.local_device))
      || (link.remote_device !== undefined && dimmed.has(link.remote_device));
    // Link palette inherits the worst endpoint state (slice #210.E
    // subset): a link to a down or drifted device reads as down /
    // drifted; spec-only on either end colors the line spec-only;
    // otherwise it sits clean (actuated-ok) or unknown.
    let linkPalette: PaletteState = "unknown";
    if (paletteByDevice && link.local_device && link.remote_device) {
      const a = paletteByDevice.get(link.local_device) ?? "unknown";
      const z = paletteByDevice.get(link.remote_device) ?? "unknown";
      linkPalette = resolveLinkPalette(a, z);
    }
    if (opts.onLinkClick) {
      const hit = svgEl("line", {
        "class": "topo-link-hit",
        x1: String(from.cx),
        y1: String(from.cy),
        x2: String(to.cx),
        y2: String(to.cy),
      });
      const onLinkClick = opts.onLinkClick;
      hit.addEventListener("click", (e) => {
        e.stopPropagation();
        onLinkClick(link);
      });
      svg.appendChild(hit);
    }
    // Link truth (slice 4.2): LLDP verdict → solid/dashed/mismatch class;
    // configured speed → stroke-width ATTRIBUTE (CSS palette rules for
    // down/drift still win over attributes, keeping their emphasis).
    let truthClass = "";
    let widthAttr: string | undefined;
    if (opts.lldpByDevice) {
      const verdict = classifyLink(link, opts.lldpByDevice);
      truthClass += ` topo-link--${verdict}`;
    }
    if (opts.underlayByDevice && linkUnderlayState(link, opts.underlayByDevice) === "down") {
      truthClass += " topo-link--underlay-down";
    }
    if (opts.speedsByDevice) {
      widthAttr = String(linkStrokeWidth(linkSpeedForLink(link, opts.speedsByDevice)));
    }
    const line = svgEl("line", {
      "class": "topo-link topo-elem--" + linkPalette + (linkDimmed ? " topo-link--dimmed" : "") + truthClass,
      x1: String(from.cx),
      y1: String(from.cy),
      x2: String(to.cx),
      y2: String(to.cy),
      ...(widthAttr !== undefined ? { "stroke-width": widthAttr } : {}),
    });
    if (link.local_device) line.setAttribute("data-local-device", link.local_device);
    if (link.remote_device) line.setAttribute("data-remote-device", link.remote_device);
    svg.appendChild(line);
  }

  // Draw nodes.
  for (const node of nodes) {
    const pos = positions.get(node.name);
    if (!pos) continue;
    const isSelected = selected.has(node.name);
    const pendingCount = opts.pendingByDevice?.get(node.name) ?? 0;
    const isPendingAdd = opts.isPendingAdd?.(node.name) ?? false;
    const isPendingRemove = opts.isPendingRemove?.(node.name) ?? false;
    const status = opts.statusByDevice?.get(node.name);
    // Phase 2: substrate-agnostic state class. Tooltip carries the detail.
    // Unified palette (slice #210.A) — caller-pre-resolved per the
    // active view mode (slice #210.B/C/D). The renderer just looks up
    // the per-device class; pending-add / pending-del / selected /
    // dragging / dimmed classes are orthogonal (staging / UI state)
    // and continue to apply alongside.
    const driftCount = opts.driftByDevice?.get(node.name) ?? 0;
    const palette: PaletteState = opts.paletteByDevice?.get(node.name) ?? "unknown";
    const paletteClass = ` topo-elem--${palette}`;

    const ariaLabelParts = [`Device ${node.name}`, palette];
    if (driftCount > 0) {
      ariaLabelParts.push(`drift: ${driftCount} item${driftCount === 1 ? "" : "s"}`);
    }

    const isDimmed = dimmed.has(node.name);
    const g = svgEl("g", {
      "class": "topo-node"
        + (isSelected ? " topo-node--selected" : "")
        + (pendingCount > 0 ? " topo-node--pending" : "")
        + (isDimmed ? " topo-node--dimmed" : "")
        + (isPendingAdd ? " topo-node--pending-add" : "")
        + (isPendingRemove ? " topo-node--pending-del" : "")
        + paletteClass,
      role: "button",
      tabindex: "0",
      "aria-label": ariaLabelParts.join(" — "),
      "data-device": node.name,
    });

    if (isSelected) {
      // Selection ring drawn behind the node rect.
      g.appendChild(svgEl("rect", {
        "class": "topo-node-selection-ring",
        x: String(pos.cx - NODE_W / 2 - 5),
        y: String(pos.cy - NODE_H / 2 - 5),
        width: String(NODE_W + 10),
        height: String(NODE_H + 10),
        rx: "8",
      }));
    }

    const rect = svgEl("rect", {
      x: String(pos.cx - NODE_W / 2),
      y: String(pos.cy - NODE_H / 2),
      width: String(NODE_W),
      height: String(NODE_H),
      rx: "6",
    });
    g.appendChild(rect);

    // Role glyph (uplift 4.1): a small silhouette anchoring the card's
    // top-left — switch = fabric glyph, host = server glyph. Outline paths
    // (Lucide, MIT) scaled 24→11px; stroke inherits the palette accent via CSS.
    const glyphPath = String(node.type) === "host"
      ? "M2 2h20v8H2zM2 14h20v8H2zM6 6h.01M6 18h.01"
      : "M3 3h6v6H3zM15 3h6v6h-6zM9 15h6v6H9zM6 9v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9";
    const glyph = svgEl("g", {
      "class": "topo-node-glyph",
      transform: `translate(${pos.cx - NODE_W / 2 + 7}, ${pos.cy - NODE_H / 2 + 7}) scale(${11 / 24})`,
    });
    glyph.appendChild(svgEl("path", { d: glyphPath }));
    g.appendChild(glyph);

    const label = svgEl("text", {
      x: String(pos.cx),
      y: String(pos.cy - 8),
    });
    label.textContent = node.name;
    g.appendChild(label);

    if (node.type) {
      const typeLabel = svgEl("text", {
        "class": "topo-node-type",
        x: String(pos.cx),
        y: String(pos.cy + 10),
      });
      typeLabel.textContent = String(node.type);
      g.appendChild(typeLabel);
    }

    // Corner status text — short textual signal (lab phase / physical
    // online state) under the rect's bottom-right. Mutually exclusive
    // with empty / missing entries so Spec view stays text-free.
    const statusText = opts.statusTextByDevice?.get(node.name) ?? "";
    if (statusText !== "") {
      const statusLabel = svgEl("text", {
        "class": "topo-status-text",
        "data-status-text": node.name,
        x: String(pos.cx + NODE_W / 2),
        y: String(pos.cy + NODE_H / 2 + 12),
      });
      statusLabel.textContent = statusText;
      g.appendChild(statusLabel);
    } else {
      // Render a hidden anchor so patchDeviceStatuses can replace it
      // in place when the status text fills in later (poll tick).
      const placeholder = svgEl("text", {
        "class": "topo-status-text topo-status-text--empty",
        "data-status-text": node.name,
        x: String(pos.cx + NODE_W / 2),
        y: String(pos.cy + NODE_H / 2 + 12),
      });
      g.appendChild(placeholder);
    }

    // Drag-to-reposition wiring. Only active when the caller wired
    // onNodeMoved. A drag of more than a few pixels suppresses the
    // upcoming click — otherwise tiny-jitter clicks would feel like
    // they dropped events.
    let dragOccurred = false;
    if (opts.onNodeMoved) {
      const onNodeMoved = opts.onNodeMoved;
      const startCx = pos.cx;
      const startCy = pos.cy;
      g.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();  // don't let the SVG-level pan handler see it
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        let dragging = false;
        dragOccurred = false;

        const pixelToSVG = (dx: number, dy: number): { sx: number; sy: number } => {
          const rect = svg.getBoundingClientRect();
          const vb = svg.viewBox.baseVal;
          return {
            sx: (dx / rect.width) * vb.width,
            sy: (dy / rect.height) * vb.height,
          };
        };

        const onMove = (em: MouseEvent): void => {
          const dx = em.clientX - startClientX;
          const dy = em.clientY - startClientY;
          if (!dragging) {
            if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
            dragging = true;
            dragOccurred = true;
            g.classList.add("topo-node--dragging");
          }
          const { sx, sy } = pixelToSVG(dx, dy);
          g.setAttribute("transform", `translate(${sx}, ${sy})`);
        };
        const onUp = (em: MouseEvent): void => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          g.classList.remove("topo-node--dragging");
          if (dragging) {
            const { sx, sy } = pixelToSVG(em.clientX - startClientX, em.clientY - startClientY);
            onNodeMoved(node.name, { cx: startCx + sx, cy: startCy + sy });
            // The caller's onNodeMoved will mutate the pinned-positions
            // map + trigger renderGraph; the new SVG group will be at
            // the new position, so the transform we set here is gone
            // with the old element.
          }
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    }

    g.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dragOccurred) {
        dragOccurred = false;
        return;
      }
      opts.onNodeClick(node.name, e);
    });
    g.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      opts.onNodeContextMenu?.(node.name, e);
    });
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        opts.onNodeClick(node.name, new MouseEvent("click", {
          clientX: pos.cx,
          clientY: pos.cy,
        }));
      }
    });

    // Phase 2: substrate-agnostic status badge. Color matches state via CSS
    // (topo-status-dot--{state}); tooltip carries substrate detail.
    if (status) {
      const sx = pos.cx - NODE_W / 2 + 8;
      const sy = pos.cy + NODE_H / 2 - 8;
      const dot = svgEl("g", { "class": "topo-status-badge", "data-status-badge": node.name });
      dot.appendChild(svgEl("circle", {
        cx: String(sx), cy: String(sy), r: "5",
        "class": `topo-status-dot topo-status-dot--${status.state}`,
      }));
      const t = svgEl("title");
      t.textContent = `${node.name}: ${status.state} — ${status.detail}`;
      dot.appendChild(t);
      g.appendChild(dot);
    }

    // Pending-changes badge (small dot in the bottom-right; drift is top-right,
    // delete is top-left, so we avoid overlap.)
    if (pendingCount > 0) {
      const pBadge = svgEl("g", { "class": "topo-pending-badge" });
      const pcx = pos.cx + NODE_W / 2 - 8;
      const pcy = pos.cy + NODE_H / 2 - 8;
      pBadge.appendChild(svgEl("circle", { cx: String(pcx), cy: String(pcy), r: "7" }));
      const pcount = svgEl("text", {
        x: String(pcx), y: String(pcy),
        "text-anchor": "middle", "dominant-baseline": "central",
      });
      pcount.textContent = String(pendingCount);
      pBadge.appendChild(pcount);
      const ptitle = svgEl("title");
      ptitle.textContent = `${pendingCount} pending change${pendingCount === 1 ? "" : "s"}`;
      pBadge.appendChild(ptitle);
      g.appendChild(pBadge);
    }

    // Drift badge: small dot in the top-right when the device has drift.
    // driftCount + driftClass were computed up top alongside the other
    // node-level state classes; reuse that value here.
    if (driftCount > 0) {
      const badge = svgEl("g", { "class": "topo-drift-badge" });
      const cx = pos.cx + NODE_W / 2 - 8;
      const cy = pos.cy - NODE_H / 2 + 8;
      badge.appendChild(svgEl("circle", { cx: String(cx), cy: String(cy), r: "7" }));
      const count = svgEl("text", {
        x: String(cx),
        y: String(cy),
        "text-anchor": "middle",
        "dominant-baseline": "central",
      });
      count.textContent = String(driftCount);
      badge.appendChild(count);
      const title = svgEl("title");
      title.textContent = `${driftCount} drift item${driftCount === 1 ? "" : "s"}`;
      badge.appendChild(title);
      g.appendChild(badge);
    }

    // No node-delete affordance on the canvas: node lifecycle (create AND delete)
    // lives solely in Specs → Nodes. Creating a node is Specs-only (it auto-places
    // here), so deleting is too — the canvas is for viewing + links + port editing,
    // not authoring nodes.

    svg.appendChild(g);
  }

  if (nodes.length === 0) {
    const msg = svgEl("text", {
      x: String(svgW / 2),
      y: String(svgH / 2),
      "text-anchor": "middle",
      "dominant-baseline": "central",
      "font-size": "13",
      fill: "var(--color-text-secondary)",
    });
    msg.textContent = "No devices in topology";
    svg.appendChild(msg);
  }

  // Pan + zoom interactivity. Only wired when the caller threads
  // viewState through opts so re-renders don't re-init the listeners
  // (the SVG is recreated each render; the caller persists state).
  if (opts.viewState && opts.onViewStateChange) {
    const onChange = opts.onViewStateChange;
    let view: ViewState = opts.viewState;

    // Wheel → zoom around cursor. preventDefault stops the page from
    // scrolling while the operator is zooming the graph.
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      // Each wheel notch in or out multiplies by ZOOM_STEP. e.deltaY is
      // positive on scroll-down (zoom out) and negative on scroll-up
      // (zoom in) on most browsers / OSes; respect that.
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      view = zoomAt(view, factor, cx, cy, rect.width, rect.height, svgW);
      svg.setAttribute("viewBox", viewBoxStr(view));
      onChange(view);
    }, { passive: false });

    // Drag-empty-canvas → pan. A drag that lands on a node still
    // reaches the node click/contextmenu handlers because the listener
    // bails when the target is a node descendant.
    svg.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // Bail if the click landed inside any element with .topo-node — the
      // node handlers own those interactions.
      if (e.target instanceof Element && e.target.closest(".topo-node")) return;
      const dragStart = { clientX: e.clientX, clientY: e.clientY, view };
      svg.classList.add("topology-graph--panning");
      e.preventDefault();

      // Bind on window so the drag continues even if the cursor leaves
      // the SVG. Detach in onUp so the listeners don't leak across the
      // SVG's lifetime (renderGraph recreates the SVG on each call).
      const onMove = (em: MouseEvent): void => {
        const rect = svg.getBoundingClientRect();
        const dx = em.clientX - dragStart.clientX;
        const dy = em.clientY - dragStart.clientY;
        view = panBy(dragStart.view, dx, dy, rect.width, rect.height);
        svg.setAttribute("viewBox", viewBoxStr(view));
      };
      const onUp = (): void => {
        svg.classList.remove("topology-graph--panning");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        onChange(view);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }

  return { svg, positions, width: svgW, height: svgH, bounds: { minX, minY, maxX, maxY } };
}

// ---- Node inspector drawer --------------------------------------------------

// ---- Topology write forms ---------------------------------------------------

// AddLinkCtx — inputs for the Add-link drawer.
interface AddLinkCtx {
  deviceNames: string[];
  topology: unknown;        // raw topology: nodes[dev].ports (configured) + links (wired)
  pendingWired: string[];   // pending-link endpoints "device:iface"
  hostLike: Set<string>;
  onSuccess: () => void;
}

// openAddLinkDrawer opens the drawer to add a link. Each endpoint picker offers the
// device's FREE (unwired) interfaces from its PLATFORM inventory — not just the
// already-configured topology ports — so any platform interface is linkable. A
// needs-config interface (in the platform, not yet in the node's ports) can be
// configured with the platform defaults inline: submit stages the port config
// (update-device, which applies before the link) alongside the link. Host-like
// devices (no platform inventory — newtron#403) fall back to a free-text field.
function openAddLinkDrawer(ctx: AddLinkCtx): void {
  const drawer = document.getElementById("detail-drawer");
  const content = document.getElementById("drawer-content");
  if (!drawer || !content) return;

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";
  content.appendChild(el("p", { className: "drawer-kind" }, "Topology"));
  content.appendChild(el("h2", { className: "drawer-name" }, "Add link"));

  const raw = (ctx.topology && typeof ctx.topology === "object")
    ? ctx.topology as { nodes?: Record<string, { ports?: Record<string, unknown> }>; links?: { a?: string; z?: string }[] }
    : {};
  const wired = new Set<string>(ctx.pendingWired);
  for (const l of raw.links ?? []) { if (l?.a) wired.add(l.a); if (l?.z) wired.add(l.z); }
  const configuredOf = (dev: string): Set<string> => new Set(Object.keys(raw.nodes?.[dev]?.ports ?? {}));
  const platformCache = new Map<string, { inventory: string[]; template: Record<string, Record<string, unknown>> }>();
  const deviceToPlatform = new Map<string, string>();

  // One endpoint picker: device dropdown + an interface control that adapts to the
  // device (switch → dropdown of free platform interfaces; host-like → free text),
  // plus an inline "configure with defaults" affordance for a needs-config port.
  // Returns resolve() for the submit.
  interface Endpoint { device: string; iface: string; configure?: { iface: string; body: Record<string, unknown> }; }
  const buildEndpointPicker = (label: string): { group: HTMLElement; resolve: () => Endpoint | null } => {
    const group = el("div", { className: "form-group" });
    group.appendChild(el("label", { className: "form-label" }, label));
    const devSelect = el("select", { className: "form-control" }) as HTMLSelectElement;
    devSelect.appendChild(el("option", { value: "" }, "— select device —") as HTMLOptionElement);
    for (const d of ctx.deviceNames) devSelect.appendChild(el("option", { value: d }, d) as HTMLOptionElement);
    group.appendChild(devSelect);

    const ifaceWrap = el("div", { className: "link-iface-wrap" });
    const cfgWrap = el("div", { className: "link-configure-wrap" });
    group.appendChild(ifaceWrap);
    group.appendChild(cfgWrap);

    let ifaceCtrl: HTMLSelectElement | HTMLInputElement | null = null;
    let hostFree = false;
    let curTemplate: Record<string, Record<string, unknown>> = {};
    let curConfigured = new Set<string>();
    let cfgCheckbox: HTMLInputElement | null = null;

    const renderConfigureOpt = (): void => {
      cfgWrap.textContent = "";
      cfgCheckbox = null;
      if (hostFree || !ifaceCtrl || ifaceCtrl.tagName !== "SELECT") return;
      const iface = ifaceCtrl.value;
      if (!iface || curConfigured.has(iface)) return; // already configured — nothing to do
      const lbl = el("label", { className: "link-configure-opt" });
      const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
      cb.checked = true;
      cfgCheckbox = cb;
      lbl.appendChild(cb);
      lbl.appendChild(el("span", {}, `Configure ${iface} with platform defaults — it isn't configured yet`));
      cfgWrap.appendChild(lbl);
    };

    const renderIface = async (): Promise<void> => {
      ifaceWrap.textContent = "";
      cfgWrap.textContent = "";
      ifaceCtrl = null; hostFree = false; cfgCheckbox = null;
      const dev = devSelect.value;
      const mkInput = (ph: string, disabled = false): HTMLInputElement => {
        const inp = el("input", { className: "form-control", type: "text", autocomplete: "off", placeholder: ph }) as HTMLInputElement;
        inp.disabled = disabled;
        return inp;
      };
      if (!dev) { ifaceWrap.appendChild(mkInput("select a device first", true)); return; }
      if (ctx.hostLike.has(dev)) {
        hostFree = true;
        ifaceCtrl = mkInput("interface, e.g. eth0");
        ifaceWrap.appendChild(ifaceCtrl);
        return;
      }
      ifaceWrap.appendChild(el("p", { className: "iface-view-loading" }, "Loading interfaces…"));
      try {
        let platform = deviceToPlatform.get(dev);
        if (platform === undefined) {
          platform = ((await fetchSpecDetail("nodes", dev)) as { platform?: string }).platform ?? "";
          deviceToPlatform.set(dev, platform);
        }
        let pc = platformCache.get(platform);
        if (!pc) {
          const [pd, tmpl] = await Promise.all([
            fetchSpecDetail("platforms", platform).catch(() => null),
            fetchPlatformPorts(platform).catch(() => ({})),
          ]);
          const inventory = ((pd as { ports?: { name?: string }[] } | null)?.ports ?? [])
            .map((p) => p.name ?? "").filter(Boolean).sort(comparePorts);
          pc = { inventory, template: tmpl as Record<string, Record<string, unknown>> };
          platformCache.set(platform, pc);
        }
        if (devSelect.value !== dev) return; // selection changed while awaiting
        curTemplate = pc.template;
        curConfigured = configuredOf(dev);
        const available = pc.inventory.filter((i) => !wired.has(`${dev}:${i}`));
        ifaceWrap.textContent = "";
        if (available.length === 0) {
          ifaceWrap.appendChild(mkInput(pc.inventory.length ? "every interface is already wired" : "platform declares no interfaces (newtron#403)", true));
          return;
        }
        const sel = el("select", { className: "form-control" }) as HTMLSelectElement;
        sel.appendChild(el("option", { value: "" }, "— select interface —") as HTMLOptionElement);
        for (const i of available) {
          sel.appendChild(el("option", { value: i }, curConfigured.has(i) ? i : `${i} · needs config`) as HTMLOptionElement);
        }
        sel.addEventListener("change", renderConfigureOpt);
        ifaceCtrl = sel;
        ifaceWrap.appendChild(sel);
      } catch {
        ifaceWrap.textContent = "";
        hostFree = true; // fall back to free-text on fetch failure
        ifaceCtrl = mkInput("interface name");
        ifaceWrap.appendChild(ifaceCtrl);
      }
    };
    devSelect.addEventListener("change", () => void renderIface());
    void renderIface();

    const resolve = (): Endpoint | null => {
      const device = devSelect.value;
      const iface = (ifaceCtrl?.value ?? "").trim();
      if (!device || !iface) return null;
      const ep: Endpoint = { device, iface };
      if (!hostFree && !curConfigured.has(iface) && cfgCheckbox?.checked) {
        ep.configure = { iface, body: { ...(curTemplate[iface] ?? {}) } };
      }
      return ep;
    };
    return { group, resolve };
  };

  const aPick = buildEndpointPicker("Endpoint A (device + interface)");
  const zPick = buildEndpointPicker("Endpoint Z (device + interface)");
  content.appendChild(aPick.group);
  content.appendChild(zPick.group);

  const errorOut = el("div", { className: "form-error-out" });
  content.appendChild(errorOut);
  const submitBtn = el("button", { type: "button", className: "form-submit-btn" }, "Add link");
  content.appendChild(submitBtn);

  submitBtn.addEventListener("click", () => {
    errorOut.textContent = "";
    const a = aPick.resolve();
    const z = zPick.resolve();
    if (!a || !z) {
      errorOut.appendChild(el("p", { className: "panel-error" }, "Both endpoints (device and interface) are required."));
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Queued";
    try {
      // Stage the port config for any needs-config endpoint first (update-device
      // applies before the link), then the link itself.
      const configured: string[] = [];
      for (const e of [a, z]) {
        if (e.configure) {
          enqueuePortConfig(e.device, e.configure.iface, e.configure.body, (raw.nodes?.[e.device] as Record<string, unknown>) ?? {});
          configured.push(`${e.device}:${e.configure.iface}`);
        }
      }
      enqueueTopologyAddLink(`${a.device}:${a.iface}`, `${z.device}:${z.iface}`);
      const note = configured.length ? ` — configured ${configured.join(", ")}` : "";
      content.insertBefore(el("p", { className: "form-success" }, `Link queued${note}. Click Save in the header to apply.`), submitBtn);
      ctx.onSuccess();
      setTimeout(() => {
        drawer.setAttribute("aria-hidden", "true");
        drawer.classList.remove("open");
      }, 900);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Add link";
      errorOut.appendChild(el("p", { className: "panel-error" }, String(err)));
    }
  });
}

// ---- Deploy-as-lab modal ----------------------------------------------------

// openLabOpModal runs a newtlab lifecycle op (deploy / provision) in a modal that
// streams the per-lab SSE event stream (phase / complete / error) into a live log.
// Both ops are async (newtron#373): the POST returns 202 immediately and the SSE
// "complete"/"error" ends it. run() fires the op-specific POST + first messages; the
// shared shell owns the DOM, the SSE subscription, teardown, and the settle hook.
// onSettle fires exactly once when the op finishes — SSE complete/error, or the
// operator closing the panel — for callers that hold op-scoped state (e.g. the
// provisioning marker that tints the topology dots).
function openLabOpModal(
  network: string,
  opts: {
    title: string;
    hint: string;
    completeLine?: string;
    onSettle?: () => void;
    run: (ctx: { append: (line: string) => void; finish: () => void }) => Promise<void>;
  },
): void {
  // Non-blocking floating panel — NOT a full-screen modal backdrop. Deploy/provision
  // are long ops the operator is told to "close once complete" (they continue in the
  // background via SSE + the status poll), so the operator must be able to watch the
  // topology fill in and pan/zoom while progress streams. A backdrop would freeze the
  // canvas for the whole op. Blocking modals (network create/remove) keep their overlay.
  const modal = el("div", { className: "network-modal deploy-modal lab-op-panel" });
  const title = el("h2", { className: "network-modal-title" }, opts.title);
  const hint = el("p", { className: "network-modal-hint" }, opts.hint);
  const logLines = el("pre", { className: "deploy-modal-log" });
  // Always-enabled Close — the operator can dismiss whenever; the op continues at
  // newtlab's pace and its status surfaces back in the topology view.
  const closeBtn = el("button", { type: "button", className: "btn btn-primary btn-sm" }, "Close");
  const actions = el("div", { className: "network-modal-actions" });
  actions.appendChild(closeBtn);
  modal.appendChild(title);
  modal.appendChild(hint);
  modal.appendChild(logLines);
  modal.appendChild(actions);
  document.body.appendChild(modal);

  const append = (line: string): void => {
    logLines.textContent += (logLines.textContent ? "\n" : "") + line;
    logLines.scrollTop = logLines.scrollHeight;
  };
  let src: EventSource | null = null;
  let settled = false;
  const finish = (): void => { src?.close(); src = null; };
  const settle = (): void => { if (settled) return; settled = true; opts.onSettle?.(); };
  const close = (): void => { finish(); settle(); modal.remove(); };
  closeBtn.addEventListener("click", close);

  // Stream the per-lab SSE events (newtron#373: deploy AND provision both emit
  // phase → complete/error). The terminal event ends the stream + settles.
  src = labEvents(
    network,
    (eventType, data) => {
      try {
        const payload = JSON.parse(data) as Record<string, unknown>;
        if (eventType === "phase") {
          const phase = String(payload["phase"] ?? "");
          const detail = payload["detail"] ? " — " + String(payload["detail"]) : "";
          append(`${phase}${detail}`);
        } else if (eventType === "complete") {
          append(opts.completeLine ?? "[done] complete");
          finish();
          settle();
        } else if (eventType === "error") {
          append("[error] " + String(payload["message"] ?? data));
          finish();
          settle();
        }
      } catch {
        append(data);
      }
    },
    () => {
      // Stream closed or errored. EventSource normally reconnects on a clean
      // close, so we don't auto-close the modal — the operator stays in control.
    },
  );

  void opts.run({ append, finish });
}

// openDeployModal — async op: POST returns 202, the SSE "complete" ends it.
function openDeployModal(network: string): void {
  openLabOpModal(network, {
    title: `Bringing up "${network}" as a lab`,
    hint: "newtlab is booting one VM per device in the topology. Streaming progress below — close this window once the deploy completes.",
    completeLine: "[done] deploy complete — devices are addressable through the topology view",
    run: async ({ append }) => {
      append(`POST deploy lab=${network}…`);
      try {
        await postLabDeploy(network, {});
        append("accepted; streaming events…");
      } catch (err) {
        append(`[error] deploy request failed: ${engineOpErrorBody(err)}`);
      }
    },
  });
}

// openProvisionModal — async provision (newtron#373): POST 202, the SSE stream
// drives the log + completion, exactly like deploy. Marks the network provisioning
// (topology dots read "provisioning" while devices reconcile) and clears the marker
// when the op settles. `physical` only varies the title (same backend pass today).
function openProvisionModal(network: string, opts: { physical?: boolean } = {}): void {
  provisioningNetworks.add(network);
  openLabOpModal(network, {
    title: opts.physical ? `Provisioning physical substrate for "${network}"` : `Provisioning "${network}"`,
    hint: "newtlab is reconciling each device to the network spec — this can take a few minutes. Streaming progress below; close this window once it completes.",
    completeLine: "[done] provision complete — devices reconciled to the network spec",
    onSettle: () => provisioningNetworks.delete(network),
    run: async ({ append }) => {
      append(`POST provision lab=${network}…`);
      try {
        await postLabProvision(network);
        append("accepted; streaming events…");
      } catch (err) {
        append(`[error] provision request failed: ${engineOpErrorBody(err)}`);
      }
    },
  });
}

// ---- Topology tab -----------------------------------------------------------

// 5s newtlab-status poll while the Topology tab is active. Cheap (one HTTP
// call) and only re-renders the per-device status badges in place — the full
// topology + /info + drift fetch only runs on tab mount.
let topologyPollTimer: number | null = null;

export function stopTopologyPoll(): void {
  if (topologyPollTimer !== null) {
    window.clearInterval(topologyPollTimer);
    topologyPollTimer = null;
  }
}

interface PollArgs {
  network: string;
  graphSlot: HTMLElement;
  deviceNames: string[];
  onlineByDevice: Map<string, boolean>;
  /**
   * rebuildPalette — called with the freshly-fetched lab state each
   * tick so the poller doesn't need to know which view mode is active
   * or which actuation source feeds it. The mountTopologyTab caller
   * owns the view mode + drift state and decides per-tick what the
   * palette should be (slice #210.B/C/D).
   */
  rebuildPalette: (labState: LabState | null) => PaletteByDevice;
  /**
   * rebuildStatusText — called with the freshly-fetched lab state each
   * tick. The caller resolves the per-view textual status (lab phase
   * vs. physical online state) and returns the map for the patcher.
   */
  rebuildStatusText: (labState: LabState | null) => StatusTextByDevice;
  /**
   * onLabStateRefresh — lets the mount handler keep its own cached
   * labState ref in sync with what the poll just fetched, so a
   * post-tick view-mode switch resolves the palette against the
   * latest signal rather than the initial snapshot.
   */
  onLabStateRefresh: (lab: LabState | null) => void;
}

function startTopologyPoll(args: PollArgs): void {
  stopTopologyPoll();
  topologyPollTimer = window.setInterval(async () => {
    let labState: LabState | null = null;
    try { labState = await fetchLabStatus(args.network); } catch { /* lab unknown — fall back */ }
    args.onLabStateRefresh(labState);
    const fresh = new Map<string, DeviceStatus>();
    for (const name of args.deviceNames) {
      fresh.set(name, resolveDeviceStatus(name, labState, args.onlineByDevice.get(name), isProvisioning(args.network)));
    }
    const palette = args.rebuildPalette(labState);
    const statusText = args.rebuildStatusText(labState);
    const svg = args.graphSlot.querySelector("svg.topology-graph") as SVGSVGElement | null;
    if (svg) patchDeviceStatuses(svg, fresh, palette, statusText);
  }, 5000);
}

// Lifecycle classes for the small status dot inside each device card.
// Orthogonal to the palette: the dot reads as "what stage of life is
// this in" (booting pulses) while the outline reads as "is intent +
// reality aligned" (palette state). Both update together on poll.
const STATUS_CLASSES = ["running", "booting", "provisioning", "unreachable", "down", "unrealized"] as const;
const PALETTE_CLASSES = ["spec-only", "actuated-ok", "actuated-down", "drift", "unknown"] as const;

// Networks with a console-initiated provision in flight. While a network is in
// this set, its running lab devices read as "provisioning" (a known transition)
// instead of flapping to "unreachable" when their live /info reads fail — which
// they do for the whole provision (newtron reconfigures + restarts containers).
// newtlab emits no provision events (newtron#373), so the console is the only
// thing that knows a provision is running: the provision modal owns this set.
const provisioningNetworks = new Set<string>();
export function isProvisioning(network: string): boolean {
  return provisioningNetworks.has(network);
}

// Reachability probes (/info) are bounded so a HANGING newtron response resolves
// as offline rather than leaving it in limbo. newtron#380 now fails the device
// dial fast (~3s) during a provision, so 5s gives headroom above that without
// making an already-stalled poll wait out a longer budget.
const REACHABILITY_PROBE_TIMEOUT_MS = 5000;
function withProbeTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("reachability probe timed out")), REACHABILITY_PROBE_TIMEOUT_MS)),
  ]);
}

function patchDeviceStatuses(
  svg: SVGSVGElement,
  statuses: Map<string, DeviceStatus>,
  paletteByDevice: PaletteByDevice,
  statusTextByDevice: StatusTextByDevice,
): void {
  for (const [device, status] of statuses) {
    const sel = `g.topo-node[data-device="${CSS.escape(device)}"]`;
    const g = svg.querySelector(sel);
    if (!g) continue;
    const palette: PaletteState = paletteByDevice.get(device) ?? "unknown";
    for (const c of PALETTE_CLASSES) g.classList.remove(`topo-elem--${c}`);
    g.classList.add(`topo-elem--${palette}`);
    g.setAttribute("aria-label", `Device ${device} — ${palette}`);
    const dot = g.querySelector("circle.topo-status-dot");
    if (dot) {
      for (const c of STATUS_CLASSES) dot.classList.remove(`topo-status-dot--${c}`);
      dot.classList.add(`topo-status-dot--${status.state}`);
    }
    const title = g.querySelector("g.topo-status-badge > title");
    if (title) title.textContent = `${device}: ${status.state} — ${status.detail}`;
    // Per-device corner status text (Lab / Physical views). The renderer
    // mounts an anchor element even when the text is empty so we can
    // fill it in place on the next poll without re-rendering the SVG.
    const statusLabel = g.querySelector('text.topo-status-text[data-status-text]');
    if (statusLabel) {
      const text = statusTextByDevice.get(device) ?? "";
      statusLabel.textContent = text;
      if (text === "") statusLabel.classList.add("topo-status-text--empty");
      else statusLabel.classList.remove("topo-status-text--empty");
    }
  }
  // Repaint link lines (slice #210.E subset) — endpoint palette may
  // have shifted on this tick (device went down, drift surfaced, etc.),
  // so each link inherits the latest worst-of-two endpoint state.
  const lines = svg.querySelectorAll("line.topo-link");
  for (const ln of Array.from(lines)) {
    const a = ln.getAttribute("data-local-device") ?? "";
    const z = ln.getAttribute("data-remote-device") ?? "";
    if (!a || !z) continue;
    const aPal = paletteByDevice.get(a) ?? "unknown";
    const zPal = paletteByDevice.get(z) ?? "unknown";
    const linkPal = resolveLinkPalette(aPal, zPal);
    for (const c of PALETTE_CLASSES) ln.classList.remove(`topo-elem--${c}`);
    ln.classList.add(`topo-elem--${linkPal}`);
  }
}

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

    const onlineByDevice = new Map<string, boolean>();
    const driftByDevice = new Map<string, number>();
    // Link truth (slice 4.2): three bulk reads per ONLINE device — LLDP
    // far-ends, actuated port speeds, underlay session health. All
    // best-effort: a failed read just leaves that device silent.
    const lldpByDevice = new Map<string, LldpNeighbor[]>();
    const speedsByDevice = new Map<string, Map<string, number>>();
    const underlayByDevice = new Map<string, UnderlayState>();
    const probeResults = await Promise.allSettled(
      deviceNames.map(async (name) => {
        // Hit /info as the cheapest available liveness probe. Success → online.
        // Failure → offline (we don't distinguish reasons in v1; newtron#75
        // tracks a dedicated /status endpoint).
        //
        // BOUND the probe: a fast 503 (newtron rejects) already resolves as
        // offline, but a HANGING /info (newtron blocking on an unreachable/
        // mid-boot device, no response) would otherwise leave `online` unset —
        // the device would sit in limbo ("running", optimistic) instead of
        // showing unreachable. Time it out so a hang resolves as offline too.
        try {
          await withProbeTimeout(fetchNodeInfo(name));
          onlineByDevice.set(name, true);
        } catch {
          onlineByDevice.set(name, false);
          return;
        }
        // Drift only makes sense for online devices.
        try {
          const drift = await fetchNodeDrift(name);
          if (Array.isArray(drift)) driftByDevice.set(name, drift.length);
        } catch { /* drift unavailable; leave count undefined */ }
        // Link truth, same online-only rule.
        const [lldp, ports, bgp] = await Promise.allSettled([
          fetchNodeDBTable(name, "APPL_DB", "LLDP_ENTRY_TABLE"),
          fetchNodeDBTable(name, "APPL_DB", "PORT_TABLE"),
          fetchNodeBGPCheck(name),
        ]);
        if (lldp.status === "fulfilled") lldpByDevice.set(name, parseLldpTable(lldp.value));
        if (ports.status === "fulfilled") speedsByDevice.set(name, parsePortSpeeds(ports.value));
        if (bgp.status === "fulfilled") underlayByDevice.set(name, parseBgpCheckOk(bgp.value));
      })
    );
    void probeResults;

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
    const headerBar = el("div", { className: "topology-header-bar" });
    const viewRow = el("div", { className: "topology-view-row" });
    headerBar.append(viewRow, toolbar);
    root.appendChild(headerBar);
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
    const zones = uniqueZones(deviceMetadata);
    const filterRow = el("div", { className: "topology-filter-row" });
    if (zones.length > 1) root.appendChild(filterRow);
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

    // Floating zoom toolbar — absolute-positioned over the SVG via
    // .topology-zoom-toolbar styling; outlives renderGraph() calls.
    const zoomToolbar = el("div", { className: "topology-zoom-toolbar", role: "toolbar", ariaLabel: "Topology zoom" });
    const zoomOutBtn = el("button", { type: "button", className: "topology-zoom-btn", title: "Zoom out" }, "−") as HTMLButtonElement;
    const zoomInBtn = el("button", { type: "button", className: "topology-zoom-btn", title: "Zoom in" }, "+") as HTMLButtonElement;
    const fitBtn = el("button", { type: "button", className: "topology-zoom-btn", title: "Fit to view" }, "⊡") as HTMLButtonElement;
    const resetPosBtn = el("button", {
      type: "button",
      className: "topology-zoom-btn topology-zoom-btn--reset",
      title: "Re-run auto layout (discards manual moves)",
    }, "↺") as HTMLButtonElement;
    zoomToolbar.append(zoomOutBtn, zoomInBtn, fitBtn, resetPosBtn);
    graphSlot.appendChild(zoomToolbar);

    // Navigation hint — small chip in the bottom-left of the slot so
    // the operator sees the affordances without having to discover
    // them by accident. Pure CSS positioning (.topology-nav-hint).
    const navHint = el(
      "div",
      { className: "topology-nav-hint", ariaHidden: "true" },
      "scroll to zoom · drag to pan",
    );
    graphSlot.appendChild(navHint);

    // Link-truth legend (slice 4.2) — bottom-right twin of the nav hint.
    // Tiny inline SVG swatches teach the line grammar: solid = LLDP-verified,
    // dashed = intent-only, red = mis-cabled/underlay-down, thickness = speed.
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
    graphSlot.appendChild(legend);

    // Interface lists pulled from the topology declaration (works offline);
    // live-fetched lists merge in via the panel module's source cache.
    const interfacesByDevice: Map<string, string[]> = new Map();
    const rawData = (data ?? {}) as { nodes?: Record<string, { ports?: Record<string, unknown>; steps?: Array<{ params?: { fields?: { type?: string } } }> }> };
    const rawDevices: Record<string, { ports?: Record<string, unknown>; steps?: Array<{ params?: { fields?: { type?: string } } }> }> = { ...(rawData.nodes ?? {}) };
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

    let renderGraph: () => void;
    renderGraph = (): void => {
      // Preserve the zoom toolbar across re-renders; only clear the SVG.
      const oldSvg = graphSlot.querySelector("svg.topology-graph");
      if (oldSvg) oldSvg.remove();
      // Compute dimmed set from the current filter; passed through to
      // renderTopologySVG which applies the dim class to nodes + links.
      const allNames = (topoData.nodes ?? []).map((n) => n.name);
      const dimmed = applyFilter(filterState, allNames, deviceMetadata).hidden;
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
      const result = renderTopologySVG(topoData, {
        paletteByDevice,
        statusTextByDevice,
        dimmedNames: dimmed,
        // Click a device — in EVERY view — opens the drawer, the single home for
        // device inspection + per-port/interface config. (There is no docked
        // action panel + selection any more; link creation is on the toolbar.)
        onNodeClick: (deviceName) => { openNodeDrawer(deviceName, viewMode); },
        driftByDevice,
        statusByDevice,
        lldpByDevice,
        speedsByDevice,
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
      topoLayoutCache = null;   // force a fresh layout pass
      viewState = undefined;    // refit the viewport to the new layout
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
    root.appendChild(driftSummaryRow);
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
