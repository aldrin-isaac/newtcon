// app.ts — newtcon workspace entry. Renders a three-tab layout:
//   Tab 1 (Specs)    — multi-panel spec view
//   Tab 2 (Topology) — SVG topology graph + node-inspector drawer
//   Tab 3 (Lab)      — lab topology lifecycle (deploy / destroy / nodes)

// Note: postTopologyDevice / deleteTopologyDevice / postTopologyLink
// were previously called directly from the topology view. With the staging
// queue introduced in staging.ts, those flows go through enqueue* + applyAll
// instead, so we don't import them here.


// ---- Specs tab -------------------------------------------------------------




// renderTopologyEmptyState renders the teaching block for an empty
// Topology view (slice #169.B). The action buttons (Create node, Bring
// up as lab) are already in the toolbar above this block — the text
// here explains what Topology is and what those buttons do, not where
// to find them.
import { type AuditEvent, fetchAuditEvents } from "./api/newtcon/audit.js";
import { type LabState, fetchLabStatus, labEvents, postLabDeploy, postLabDestroy, postLabProvision, postLabStartNode, postLabStopNode } from "./api/newtcon/lab.js";
import { type SpecKind, fetchPlatformPorts, fetchSpecDetail, fetchSpecList } from "./api/newtcon/network.js";
import { fetchNodeConfigDBEntry, fetchNodeConfigDBTable, fetchNodeDrift, fetchNodeInfo, fetchNodeInterface, fetchNodeInterfaceBinding, fetchNodeInterfaces, fetchTopology, postNodeReconcile } from "./api/newtcon/nodes.js";
import { fetchSchema, resolveKindToSlug, resolveSlugToKind } from "./api/newtcon/schema.js";
import { ApiError } from "./api/newtcon/services.js";
import { renderEventsError, renderEventsTable } from "./audit.js";
import { signedInOnce } from "./auth-gate.js";
import { confirmInline } from "./confirm-inline.js";
import { type DeviceStatus, resolveDeviceStatus } from "./device-status.js";
import { el, renderValue } from "./dom.js";
import { TOPOLOGY_EMPTY } from "./empty-states.js";
import { activeNetwork } from "./network-switcher.js";
import { hostLikeDevices } from "./node-references.js";
import { comparePorts } from "./port-config.js";
import { engineOpErrorBody, extractUnderlyingMessage, formatErrorBrief } from "./render-error.js";
import { type SpecField, buildSpecDetailShape } from "./spec-detail-shape.js";
import { enqueuePortConfig, enqueueTopologyAddLink, pendingTopologyLinkAdds, subscribe as subscribePending } from "./staging.js";
import { showToast } from "./toast.js";
import { showContextMenu } from "./topology-actions-ui.js";
import { NODE_ACTIONS } from "./topology-actions.js";
import { type DeviceMetadata, type TopologyFilter, applyFilter, emptyFilter, isActive as filterIsActive, uniqueZones } from "./topology-filters.js";
import { computeTopologyLayout } from "./topology-layout.js";
import { type PaletteState, resolveLabDevicePalette, resolveLabStatusText, resolveLinkPalette, resolvePhysicalDevicePalette, resolvePhysicalStatusText } from "./topology-palette.js";
import { type PinnedPosition, clearPositions, loadPositions, savePosition } from "./topology-positions.js";
import { ALL_VIEW_MODES, type TopologyViewMode, defaultViewMode, loadViewMode, saveViewMode, viewModeLabel } from "./topology-view-mode.js";
import { type ViewState, ZOOM_STEP, fitToBounds, panBy, viewBoxStr, zoomAt } from "./topology-viewport.js";
import { renderInterfaceTab } from "./views/drawer/interfaces.js";
import { renderRawSection, renderStateTab } from "./views/drawer/state.js";
import { viewFor } from "./views/index.js";
import { closeDetail, displaySchemaFor, kindTitleFor, mountSpecsView, openDetail } from "./views/specs/index.js";
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

interface TopoLink {
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
    const line = svgEl("line", {
      "class": "topo-link topo-elem--" + linkPalette + (linkDimmed ? " topo-link--dimmed" : ""),
      x1: String(from.cx),
      y1: String(from.cy),
      x2: String(to.cx),
      y2: String(to.cy),
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
      rx: "4",
    });
    g.appendChild(rect);

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
      fill: "#57534e",
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

// NODE_TABS — the 6 primary tabs the device drawer surfaces. Down from
// 14 (collapsed VLANs / VRFs / ACLs / BGP / EVPN / LAGs / Neighbors
// under "State"; tucked Config DB / Intent Tree / Projection under a
// "Raw" disclosure rendered below the panels). Ordered by operator
// priority: Summary (at-a-glance dashboard) → Interfaces (most-acted-
// on surface) → State (observed reality, grouped) → Spec (declared
// intent, visually distinct) → Drift (actionable diff, first-class)
// → History (audit timeline).
const NODE_TABS = [
  { id: "interfaces", label: "Interfaces" },
  { id: "state",      label: "State" },
  { id: "spec",       label: "Spec" },
  { id: "drift",      label: "Drift" },
  { id: "history",    label: "History" },
] as const;

type NodeTabId = typeof NODE_TABS[number]["id"];

// renderLoadingInto clears a container and shows a loading indicator.
function renderLoadingInto(container: HTMLElement): void {
  container.textContent = "";
  container.appendChild(el("p", { className: "status-loading" }, "Loading…"));
}

// renderErrorInto clears a container and shows an error message.
export function renderErrorInto(container: HTMLElement, err: unknown): void {
  container.textContent = "";
  if (err instanceof ApiError && err.kind === "newtron_unavailable") {
    container.appendChild(el("p", { className: "panel-error" }, "Device unreachable"));
    const detailObj = err.details as { underlying_error_message?: string } | undefined;
    const detail = detailObj?.underlying_error_message ?? err.message;
    container.appendChild(el("p", { className: "panel-error-detail" }, detail));
  } else if (err instanceof ApiError && err.kind === "internal" && err.status === 404) {
    container.appendChild(el("p", { className: "panel-error" }, "Not found"));
  } else if (err instanceof ApiError) {
    container.appendChild(el("p", { className: "panel-error" }, err.message));
  } else {
    container.appendChild(el("p", { className: "panel-error" }, "Request failed"));
    container.appendChild(el("p", { className: "panel-error-detail" }, String(err)));
  }
}

// renderProfileNotFound renders the empty-state for the Profile sub-tab when
// no profile spec is named after the device. Two reasons this can happen:
//
//   - Older topologies created before the unified-substrate convention
//     (PR #148) may name profile and device differently.
//   - The profile was deleted but the topology entry survived.
//
// We surface this honestly rather than rendering a generic "not found" — the
// operator's mental model of "every node has a profile" should not be
// silently violated by the UI.
function renderProfileNotFound(container: HTMLElement, device: string): void {
  container.textContent = "";
  container.appendChild(el("p", { className: "panel-error" }, "No node found"));
  container.appendChild(el(
    "p",
    { className: "panel-error-detail" },
    `No profile spec named "${device}" exists for this device. ` +
    "Nodes and device names are conventionally identical (created together " +
    "from the Topology view). If this device's node uses a different name, " +
    "find it under the Specs view → Nodes."
  ));
}

// renderValueInto places renderValue output into a container, adding .drawer-detail.
export function renderValueInto(container: HTMLElement, data: unknown): void {
  container.textContent = "";
  const body = renderValue(data);
  if (body instanceof HTMLElement) {
    body.classList.add("drawer-detail");
  }
  container.appendChild(body);
}

// renderSpecDetailInto renders spec data with a tailored, schema-aware
// layout: each schema field becomes a labeled row in the order the schema
// defines, and any extra fields newtron returned (not in the schema) sit
// inside an "All fields" disclosure so the operator never silently loses
// visibility of newtron data — even fields the schema hasn't been updated
// to cover (additions made after this build). The one exception is ssh_pass,
// redacted below — it's a credential some reads return in the clear.
//
// extraExcludes is for fields already rendered elsewhere in the drawer
// (e.g. sub-rule children for kinds that have a dedicated rules / queues /
// prefixes section below the body). Pass [] for the default.
//
// Falls back to renderValueInto when data is not an object (defensive
// against newtron returning a primitive or null).
// toSpecField adapts a newtron SchemaField to the narrower SpecField the
// detail renderer consumes. ref_kind is carried through only for type
// "ref" fields, so the renderer knows which rows become cross-link chips.
export function toSpecField(f: import("./api/newtcon/schema.js").SchemaField): SpecField {
  const out: SpecField = { name: f.name, label: f.label };
  if (f.type === "ref" && f.ref_kind) out.refKind = f.ref_kind;
  return out;
}

export function renderSpecDetailInto(container: HTMLElement, fields: SpecField[], data: unknown, extraExcludes: string[] = []): void {
  container.textContent = "";
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    renderValueInto(container, data);
    return;
  }
  // "name" is rendered in the drawer header already (drawer-name); skip it
  // here to avoid a redundant row in the body. extraExcludes adds caller-
  // supplied fields (typically a sub-rule's wire-field name).
  //
  // ssh_pass is redacted globally: some reads (GET /nodes/{name}) return the
  // RESOLVED login with ssh_pass IN THE CLEAR (newtlab dials with it), and since
  // it left the NodeSpec schema (newtron#388) it would otherwise surface in the
  // "All fields" disclosure. The device password is never rendered here — the SSH
  // Login control shows only the masked, per-scope authored value.
  const shape = buildSpecDetailShape(fields, data as Record<string, unknown>, ["name", "ssh_pass", ...extraExcludes]);

  // Empty-state: the schema is just `name` (zones today) AND newtron returned
  // nothing else. Operator gets an honest "nothing more to see" rather than
  // a blank drawer body that looks like a render failure.
  if (shape.rows.length === 0 && shape.extras.length === 0) {
    container.appendChild(el("p", { className: "spec-detail-empty-state" },
      "This spec has no additional fields."));
    return;
  }

  const dl = el("dl", { className: "spec-detail drawer-detail" });
  for (const row of shape.rows) {
    dl.appendChild(el("dt", { className: "spec-detail-label" }, row.label));
    const dd = el("dd", { className: "spec-detail-value" });
    dd.appendChild(renderSpecValue(row));
    dl.appendChild(dd);
  }
  container.appendChild(dl);

  if (shape.extras.length > 0) {
    const det = el("details", { className: "spec-detail-extras" });
    det.appendChild(el("summary", { className: "spec-detail-extras-summary" },
      `All fields (${shape.extras.length} additional)`));
    const dlx = el("dl", { className: "spec-detail" });
    for (const row of shape.extras) {
      dlx.appendChild(el("dt", { className: "spec-detail-label spec-detail-label--extra" }, row.label));
      const dd = el("dd", { className: "spec-detail-value" });
      dd.appendChild(renderSpecValue(row));
      dlx.appendChild(dd);
    }
    det.appendChild(dlx);
    container.appendChild(det);
  }
}

// humanizeStepUrl turns a topology step verb ("/setup-device") into a readable
// title ("Setup device").
function humanizeStepUrl(url: string): string {
  const slug = url.replace(/^\//, "").replace(/-/g, " ").trim();
  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : "Step";
}

// renderTopologyIntentInto renders a device's topology.json entry — its
// provisioning steps (the declared intent newtron replays on provision) and its
// per-port config — into the Spec tab. Steps render as labeled field groups;
// ports as a compact table ordered low→high (comparePorts).
function renderTopologyIntentInto(host: HTMLElement, entry: unknown): void {
  host.textContent = "";
  const e = entry && typeof entry === "object" ? entry as { steps?: unknown; ports?: unknown } : {};
  const steps = Array.isArray(e.steps) ? e.steps : [];
  const ports = e.ports && typeof e.ports === "object" ? e.ports as Record<string, Record<string, unknown>> : {};
  const portNames = Object.keys(ports).sort(comparePorts);

  if (steps.length === 0 && portNames.length === 0) {
    host.appendChild(el("p", { className: "spec-detail-empty-state" },
      "No topology intent declared — no provisioning steps or port config in topology.json for this device."));
    return;
  }

  if (steps.length > 0) {
    host.appendChild(el("h5", { className: "node-spec-subtitle" }, `Provisioning steps (${steps.length})`));
    for (const raw of steps) {
      const step = raw && typeof raw === "object" ? raw as { url?: unknown; params?: unknown } : {};
      const url = typeof step.url === "string" ? step.url : "step";
      const det = el("details", { className: "node-spec-step" });
      (det as HTMLDetailsElement).open = true;
      det.appendChild(el("summary", { className: "node-spec-step-summary" }, humanizeStepUrl(url)));
      const params = step.params && typeof step.params === "object" ? step.params as Record<string, unknown> : {};
      const fields = params.fields && typeof params.fields === "object" ? params.fields as Record<string, unknown> : params;
      const dl = el("dl", { className: "spec-detail drawer-detail" });
      const fieldEntries = Object.entries(fields);
      if (fieldEntries.length === 0) {
        dl.appendChild(el("dd", { className: "spec-detail-value spec-detail-empty" }, "—"));
      } else {
        for (const [k, v] of fieldEntries) {
          dl.appendChild(el("dt", { className: "spec-detail-label" }, k));
          const dd = el("dd", { className: "spec-detail-value" });
          dd.appendChild(renderValue(v));
          dl.appendChild(dd);
        }
      }
      det.appendChild(dl);
      host.appendChild(det);
    }
  }

  if (portNames.length > 0) {
    host.appendChild(el("h5", { className: "node-spec-subtitle" }, `Port config (${portNames.length})`));
    const cols = ["admin_status", "mtu", "speed", "description"];
    const table = el("table", { className: "node-spec-port-table" });
    const thead = el("thead");
    const hr = el("tr");
    for (const l of ["Port", "Admin", "MTU", "Speed", "Description"]) hr.appendChild(el("th", {}, l));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const name of portNames) {
      const cfg = ports[name] ?? {};
      const tr = el("tr");
      tr.appendChild(el("td", { className: "node-spec-port-name" }, name));
      for (const c of cols) {
        const v = cfg[c];
        tr.appendChild(el("td", {}, v === undefined || v === null || v === "" ? "—" : String(v)));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    host.appendChild(table);
  }
}

// renderSpecValue renders one SpecRow's value cell. Empty values show
// "—". Ref rows (refKind set) with a non-empty string value render as a
// clickable chip that opens the referenced spec's drawer; everything
// else falls through to the generic renderValue. Resolution of the
// ref's kind → URL slug happens lazily on click (the schema cache is
// already warm by the time a detail drawer is open, so it's instant).
function renderSpecValue(row: import("./spec-detail-shape.js").SpecRow): Node {
  if (row.empty) return el("span", { className: "spec-detail-empty" }, "—");
  if (row.refKind && typeof row.value === "string" && row.value !== "") {
    return renderRefChip(row.refKind, row.value);
  }
  return renderValue(row.value);
}

// renderRefChip builds a clickable chip for a cross-spec reference. The
// click resolves refKind (a newtron kind name) to its URL slug and
// opens that spec's detail drawer over the current one. A failed
// resolution (embedded kind, schema not loaded) surfaces a toast rather
// than a dead click.
function renderRefChip(refKind: string, name: string): HTMLElement {
  const chip = el("button", {
    type: "button",
    className: "spec-ref-chip",
    title: `Open ${name}`,
  }, name) as HTMLButtonElement;
  chip.addEventListener("click", () => {
    void (async () => {
      const slug = await resolveKindToSlug(refKind).catch(() => null);
      if (!slug) {
        showToast({
          kind: "error",
          title: `Can't open "${name}"`,
          body: "Its spec type isn't separately viewable.",
        });
        return;
      }
      const kind = slug as SpecKind;
      await openDetail(kind, kindTitleFor(kind), name);
    })();
  });
  return chip;
}

// renderConfigDBTab renders the CONFIG_DB sub-tab with 3-level navigation.
// renderDriftTab renders the drift list + a Reconcile button. Newtron returns
// either an empty array (no drift) or an array of drift items per table/key.
function renderDriftTab(container: HTMLElement, data: unknown, device?: string): void {
  container.textContent = "";
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    container.appendChild(
      el("p", { className: "drift-empty" }, "No delta drift detected. Device matches its last-applied intent."),
    );
    container.appendChild(
      el(
        "p",
        { className: "drift-empty-help" },
        "Use Reconcile (mode: topology) below to compare the device against the full topology spec from scratch.",
      ),
    );
    if (device) {
      container.appendChild(renderReconcileSection(device));
    }
    return;
  }
  const heading = el(
    "p",
    { className: "drift-header" },
    `${items.length} drift item${items.length === 1 ? "" : "s"} — device does not match intent.`,
  );
  container.appendChild(heading);
  const body = renderValue(data);
  if (body instanceof HTMLElement) body.classList.add("drift-detail");
  container.appendChild(body);

  if (device) {
    container.appendChild(renderReconcileSection(device));
  }
}

// renderReconcileSection emits the "Reconcile" button + preview/apply flow.
// Preview path: POST .../reconcile?dry_run=true → show ChangeSet structure.
// Apply path: confirm + POST without dry_run → show result + auto-refresh drift.
function renderReconcileSection(device: string): HTMLElement {
  const section = el("section", { className: "reconcile-section" });
  section.appendChild(el("h3", { className: "reconcile-heading" }, "Reconcile"));
  section.appendChild(
    el(
      "p",
      { className: "reconcile-help" },
      "Preview the corrective intent newtron would push to restore this device to its intent. Apply executes the change atomically per-device.",
    ),
  );

  const controls = el("div", { className: "reconcile-controls" });
  const modeLabel = el("label", { className: "reconcile-mode-label" }, "Mode: ");
  const modeSelect = el("select", { className: "reconcile-mode-select" }) as HTMLSelectElement;
  const optDelta = el("option", { value: "" }, "delta (changes since last apply)") as HTMLOptionElement;
  const optTopology = el("option", { value: "topology" }, "topology (full reconcile to topology spec)") as HTMLOptionElement;
  modeSelect.appendChild(optDelta);
  modeSelect.appendChild(optTopology);
  modeLabel.appendChild(modeSelect);
  controls.appendChild(modeLabel);
  const previewBtn = el("button", { type: "button", className: "reconcile-btn reconcile-btn--preview" }, "Preview reconcile");
  controls.appendChild(previewBtn);
  section.appendChild(controls);
  const out = el("div", { className: "reconcile-output" });
  section.appendChild(out);

  previewBtn.addEventListener("click", async () => {
    previewBtn.disabled = true;
    out.textContent = "";
    const chosenMode = modeSelect.value || undefined;
    out.appendChild(el("p", { className: "status-loading" }, `Previewing (mode: ${chosenMode ?? "delta"})…`));
    try {
      const preview = chosenMode === undefined ? await postNodeReconcile(device, { dryRun: true }) : await postNodeReconcile(device, { dryRun: true, mode: chosenMode });
      out.textContent = "";
      const previewItems = Array.isArray(preview) ? preview : [];
      out.appendChild(
        el(
          "p",
          { className: previewItems.length === 0 ? "reconcile-noop" : "reconcile-preview-header" },
          previewItems.length === 0
            ? "Preview returned no changes — nothing to reconcile."
            : `Preview: ${previewItems.length} corrective change${previewItems.length === 1 ? "" : "s"}. Review before applying.`,
        ),
      );
      const body = renderValue(preview);
      if (body instanceof HTMLElement) body.classList.add("reconcile-preview-body");
      out.appendChild(body);

      if (previewItems.length > 0) {
        const applyBtn = el("button", { type: "button", className: "reconcile-btn reconcile-btn--apply" }, "Apply reconcile (atomic per device)");
        out.appendChild(applyBtn);
        applyBtn.addEventListener("click", async () => {
          const ok = await confirmInline({
            title: `Reconcile ${device}?`,
            body: "Corrective changes will be written to the device's CONFIG_DB atomically. Verify the preview above first.",
            confirmLabel: "Apply reconcile",
          });
          if (!ok) return;
          applyBtn.disabled = true;
          previewBtn.disabled = true;
          applyBtn.textContent = "Applying…";
          try {
            const result = chosenMode === undefined ? await postNodeReconcile(device, { dryRun: false }) : await postNodeReconcile(device, { dryRun: false, mode: chosenMode });
            applyBtn.replaceWith(
              el("p", { className: "reconcile-applied" }, "Reconcile applied. Result:"),
            );
            const resBody = renderValue(result);
            if (resBody instanceof HTMLElement) resBody.classList.add("reconcile-result-body");
            out.appendChild(resBody);
            // Re-fetch drift to refresh the upper drift list.
            const fresh = await fetchNodeDrift(device);
            out.appendChild(el("hr", { className: "reconcile-sep" }));
            out.appendChild(el("p", { className: "reconcile-refresh-header" }, "Drift after reconcile:"));
            const driftBody = renderValue(fresh);
            if (driftBody instanceof HTMLElement) driftBody.classList.add("drift-detail");
            out.appendChild(driftBody);
          } catch (err) {
            applyBtn.replaceWith(el("p", { className: "panel-error" }, "Apply failed"));
            renderErrorInto(out, err);
          }
        });
      }
    } catch (err) {
      out.textContent = "";
      renderErrorInto(out, err);
    } finally {
      previewBtn.disabled = false;
    }
  });

  return section;
}

export function renderConfigDBTab(container: HTMLElement, device: string, tableMap: unknown): void {
  container.textContent = "";

  let tableNames: string[] = [];
  if (tableMap !== null && typeof tableMap === "object" && !Array.isArray(tableMap)) {
    tableNames = Object.keys(tableMap as Record<string, unknown>).sort();
  } else if (Array.isArray(tableMap)) {
    tableNames = tableMap.map(String).sort();
  }

  if (tableNames.length === 0) {
    container.appendChild(el("p", { className: "topology-empty" }, "CONFIG_DB is empty"));
    return;
  }

  const tableList = el("ul", { className: "configdb-tables" });

  for (const tableName of tableNames) {
    const tableItem = el("li", { className: "configdb-table-item", tabIndex: 0 }, tableName);

    const keysContainer = el("ul", { className: "configdb-keys" });
    keysContainer.hidden = true;

    let keysLoaded = false;

    const toggleTable = (): void => {
      if (keysContainer.hidden) {
        keysContainer.hidden = false;
        if (!keysLoaded) {
          keysLoaded = true;
          const loading = el("li", {}, "Loading…");
          keysContainer.appendChild(loading);
          fetchNodeConfigDBTable(device, tableName)
            .then((keyData) => {
              keysContainer.textContent = "";
              let keys: string[] = [];
              if (Array.isArray(keyData)) {
                keys = keyData.map(String).sort();
              } else if (keyData !== null && typeof keyData === "object") {
                keys = Object.keys(keyData as Record<string, unknown>).sort();
              }
              if (keys.length === 0) {
                keysContainer.appendChild(el("li", { className: "configdb-key-item" }, "(empty)"));
                return;
              }
              for (const keyName of keys) {
                const keyItem = el("li", { className: "configdb-key-item", tabIndex: 0 }, keyName);

                const entryContainer = el("li", {});
                const entryContent = el("div", { className: "configdb-entry" });
                entryContent.hidden = true;

                let entryLoaded = false;

                const toggleKey = (): void => {
                  if (entryContent.hidden) {
                    entryContent.hidden = false;
                    if (!entryLoaded) {
                      entryLoaded = true;
                      renderLoadingInto(entryContent);
                      fetchNodeConfigDBEntry(device, tableName, keyName)
                        .then((entry) => renderValueInto(entryContent, entry))
                        .catch((err) => renderErrorInto(entryContent, err));
                    }
                  } else {
                    entryContent.hidden = true;
                  }
                };

                keyItem.addEventListener("click", toggleKey);
                keyItem.addEventListener("keydown", (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleKey();
                  }
                });

                keysContainer.appendChild(keyItem);
                entryContainer.appendChild(entryContent);
                keysContainer.appendChild(entryContainer);
              }
            })
            .catch((err) => {
              keysContainer.textContent = "";
              const errItem = el("li", { className: "panel-error" }, String(err));
              keysContainer.appendChild(errItem);
            });
        }
      } else {
        keysContainer.hidden = true;
      }
    };

    tableItem.addEventListener("click", toggleTable);
    tableItem.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleTable();
      }
    });

    tableList.appendChild(tableItem);
    tableList.appendChild(el("li", {}, keysContainer));
  }

  container.appendChild(tableList);
}

// Phase 3: Lifecycle section in the device inspector. Substrate-agnostic
// state + substrate-aware actions:
//   - Lab VM running   → Stop button + SSH/console snippets
//   - Lab VM stopped   → Start button
//   - Lab VM booting   → state pill only (transition in progress)
//   - Not realized     → guidance text pointing at "Deploy as lab"
//   - Reachable via probe (not lab) → state pill only (start/stop n/a)
//
// engineOpErrorBody: for newtlab lifecycle ops (deploy / provision / destroy),
// prefer newtron's real underlying error — e.g. a reconcile failure
// "…DEVICE_METADATA|localhost not found in CONFIG_DB" (device booted but SONiC
// config uninitialised, so Provision can't bootstrap it) — over newtcon's generic
// "upstream unreachable" wrapper, which points the operator at the wrong thing.
// Phase 4 may move this into a standalone module if the lifecycle surface
// grows further (console viewer, log tail, etc.).
async function renderLifecycleSection(host: HTMLElement, device: string, viewMode?: TopologyViewMode): Promise<void> {
  host.textContent = "";
  // Section label reflects the substrate the drawer is showing — same
  // operator-intent framing as the topology view chips. Default
  // ("Lifecycle") covers the cases where the drawer is opened outside
  // a view-mode context.
  const sectionLabel = viewMode === "spec-physical" ? "Physical state"
    : viewMode === "spec-lab" ? "Lab VM"
    : viewMode === "spec" ? "Spec"
    : "Lifecycle";
  host.appendChild(el("p", { className: "lifecycle-header" }, sectionLabel));
  const body = el("div", { className: "lifecycle-body" });
  body.appendChild(el("p", { className: "lifecycle-loading" }, "Checking substrate…"));
  host.appendChild(body);

  const network = activeNetwork();
  let labState: LabState | null = null;
  // Physical view inspects the physical substrate only — don't even
  // fetch lab state, so a coincidentally-running lab VM with the same
  // name can't bleed VM details into the drawer. Same principle for
  // Spec view (intent only, no actuation).
  if (viewMode !== "spec-physical" && viewMode !== "spec") {
    try { labState = await fetchLabStatus(network); } catch { /* lab unknown */ }
  }
  let online: boolean | undefined;
  let probeErr: unknown;
  try { await fetchNodeInfo(device); online = true; } catch (e) { online = false; probeErr = e; }

  const status = resolveDeviceStatus(device, labState, online, isProvisioning(network));
  const labNode = labState?.nodes?.[device];

  body.textContent = "";

  // Spec view: intent only. Show a single hint that the device is
  // declared but no actuation overlay is being requested here.
  if (viewMode === "spec") {
    body.appendChild(el("p", { className: "lifecycle-hint" },
      `${device} is declared in this network's topology spec. Switch to Lab or Physical to inspect actuation state.`));
    return;
  }

  // Physical view: physical-substrate state only. Skip the lab pill
  // and any VM affordances even when a lab happens to be running.
  if (viewMode === "spec-physical") {
    const pill = el("div", { className: `lifecycle-pill lifecycle-pill--${online ? "running" : "down"}` });
    pill.appendChild(el("span", { className: "lifecycle-pill-state" }, online ? "online" : "offline"));
    pill.appendChild(el("span", { className: "lifecycle-pill-detail" },
      online ? "physical device reachable" : "no response from device"));
    body.appendChild(pill);
    if (!online) {
      body.appendChild(el("p", { className: "lifecycle-hint" },
        `Newtron's /info probe got no response from ${device}. The device may be unreachable, not yet provisioned, or running but firewalled.`));
    }
    return;
  }

  // Lab view (and the default "Lifecycle" fallback path for legacy
  // openNodeDrawer callers) — show the substrate pill, lab VM
  // controls, and SSH/console snippets.
  const pill = el("div", { className: `lifecycle-pill lifecycle-pill--${status.state}` });
  pill.appendChild(el("span", { className: "lifecycle-pill-state" }, status.state));
  pill.appendChild(el("span", { className: "lifecycle-pill-detail" }, status.detail));
  body.appendChild(pill);

  if (status.state === "unrealized") {
    body.appendChild(el("p", { className: "lifecycle-hint" },
      `No substrate is realizing ${device} yet. Switch to the Lab view and click "Deploy" to deploy this network as VMs.`));
    return;
  }

  if (status.state === "unreachable") {
    // Surface the REAL cause. newtcon classifies newtron's http_5xx as
    // "newtron_unavailable", but newtron is up — the device is. The genuinely
    // useful detail (e.g. "DEVICE_METADATA|localhost not found in CONFIG_DB" →
    // the device is booted but SONiC config isn't initialized) lives in the
    // probe error's underlying_error_message, not the generic "upstream
    // unreachable" wrapper.
    const reason = probeErr instanceof ApiError ? extractUnderlyingMessage(probeErr.details) : null;
    const hint = el("p", { className: "lifecycle-hint" },
      `${device}'s VM is running, but newtron can't read its live state. You can still stop the VM or SSH in to investigate.`);
    body.appendChild(hint);
    if (reason) {
      body.appendChild(el("p", { className: "lifecycle-hint lifecycle-hint--detail" },
        `newtron reports: ${reason}`));
    }
  }

  if (status.state === "provisioning") {
    body.appendChild(el("p", { className: "lifecycle-hint" },
      `${device} is being provisioned — newtron is pushing config + restarting containers. Live reads pause until it completes; the status returns to running automatically.`));
  }

  // Start/Stop — only meaningful for lab-managed VMs.
  if (labNode) {
    const actions = el("div", { className: "lifecycle-actions" });
    if (status.state === "running" || status.state === "booting" || status.state === "unreachable" || status.state === "provisioning") {
      const stop = el("button", { type: "button", className: "btn btn-danger btn-sm" }, "Stop VM");
      stop.addEventListener("click", async () => {
        const ok = await confirmInline({
          title: `Stop VM "${device}"?`,
          body: `In lab "${network}". The device will go offline.`,
          danger: true,
          confirmLabel: "Stop",
        });
        if (!ok) return;
        stop.setAttribute("disabled", "");
        stop.textContent = "Stopping…";
        postLabStopNode(network, device)
          .then(() => renderLifecycleSection(host, device, viewMode))
          .catch((err) => {
            stop.removeAttribute("disabled");
            stop.textContent = "Stop VM";
            showToast({ kind: "error", title: "Stop failed", body: engineOpErrorBody(err) });
          });
      });
      actions.appendChild(stop);
    }
    if (status.state === "down") {
      const start = el("button", { type: "button", className: "btn btn-primary btn-sm" }, "Start VM");
      start.addEventListener("click", () => {
        start.setAttribute("disabled", "");
        start.textContent = "Starting…";
        postLabStartNode(network, device)
          .then(() => renderLifecycleSection(host, device, viewMode))
          .catch((err) => {
            start.removeAttribute("disabled");
            start.textContent = "Start VM";
            showToast({ kind: "error", title: "Start failed", body: engineOpErrorBody(err) });
          });
      });
      actions.appendChild(start);
    }
    body.appendChild(actions);

    // SSH/console snippets — only when the VM is up and ports are known
    // (incl. unreachable: the VM is up, so SSH is exactly how you'd investigate).
    if ((status.state === "running" || status.state === "unreachable") && labNode.ssh_port) {
      const sshUser = labNode.ssh_user || "admin";
      const sshCmd = `ssh -p ${labNode.ssh_port} ${sshUser}@localhost`;
      body.appendChild(buildCopyRow("SSH", sshCmd));
    }
    if (labNode.console_port) {
      const consoleCmd = `telnet localhost ${labNode.console_port}`;
      body.appendChild(buildCopyRow("Console", consoleCmd));
    }
  }
}

function buildCopyRow(label: string, value: string): HTMLElement {
  const row = el("div", { className: "lifecycle-snippet" });
  row.appendChild(el("span", { className: "lifecycle-snippet-label" }, label));
  const code = el("code", { className: "lifecycle-snippet-value" }, value);
  row.appendChild(code);
  const copyBtn = el("button", {
    type: "button",
    className: "btn btn-ghost btn-sm lifecycle-snippet-copy",
    title: `Copy ${label.toLowerCase()} command`,
  }, "Copy");
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(value).then(() => {
      const orig = copyBtn.textContent;
      copyBtn.textContent = "Copied";
      window.setTimeout(() => { copyBtn.textContent = orig; }, 1200);
    });
  });
  row.appendChild(copyBtn);
  return row;
}

// openLinkDrawer opens the detail drawer for a topology link, rendering
// both endpoints' configuration side-by-side. Reuses the existing
// detail drawer; opening overwrites whatever the drawer was showing.
//
// The render is layered:
//
//   1. STATIC config from the topology data (always available, no
//      fetch): port admin_status, mtu, the link itself. This is
//      what's in topology.json — visible even when the device is
//      offline / lab not deployed.
//   2. LIVE data fetched per-endpoint (oper_status, real-time
//      bindings, runtime VLAN membership). Adds runtime context when
//      the device is reachable; renders as a pedagogical "device
//      offline" line when not.
//
// Each endpoint renders independently so one device being unreachable
// doesn't hide the other side.
function openLinkDrawer(
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

  drawer.setAttribute("aria-hidden", "false");
  drawer.classList.add("open");
  content.textContent = "";

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

  // Lifecycle section (existing) — view-mode-aware substrate state +
  // Start/Stop/SSH/console. Stays for now; the Summary tab also
  // surfaces the substrate state from its own pull, so this section
  // is a touch redundant in observation views — kept here as the
  // canonical "lifecycle controls live here" surface until per-domain
  // renderers absorb its action buttons.
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

  // Raw (debugging) disclosure — Config DB / Projection / Intent
  // Tree tucked away below the primary panels. Most operators never
  // open it; the ones who need it know where to look.
  renderRawSection(content, device);

  // Pick the default tab based on the view-mode the drawer was
  // opened from: Spec view → Spec; Lab/Physical → Summary (the
  // operator's at-a-glance triage view). Legacy callers without a
  // view-mode also default to Summary.
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
// Each tab is operator-priority-ordered (Summary first; History last)
// and uses a per-domain renderer rather than the generic recursive
// tree.
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

    case "spec": {
      // A device's declared intent lives in TWO places in the network spec:
      //   - the device profile — static identity (mgmt_ip, loopback_ip, zone,
      //     platform, service bindings). Unified-substrate convention (PR #148)
      //     names the profile after the device → fetchSpecDetail("nodes", …).
      //   - the topology.json device entry — provisioning steps + per-port
      //     config, i.e. the intents provisioning actually replays.
      // The Spec tab shows both so "declared intent" is complete.
      container.textContent = "";
      container.appendChild(el("p", { className: "node-spec-intro" },
        "Declared intent for this device — node + topology.json. To inspect actuated reality, switch tabs."));

      const profSection = el("div", { className: "node-spec-section" });
      profSection.appendChild(el("h4", { className: "node-spec-section-title" }, "Node"));
      const profBody = el("div", { className: "node-spec-body" });
      profBody.appendChild(el("p", { className: "spec-detail-empty-state" }, "Loading…"));
      profSection.appendChild(profBody);
      container.appendChild(profSection);

      const topoSection = el("div", { className: "node-spec-section" });
      topoSection.appendChild(el("h4", { className: "node-spec-section-title" }, "Topology intent"));
      const topoBody = el("div", { className: "node-spec-body" });
      topoBody.appendChild(el("p", { className: "spec-detail-empty-state" }, "Loading…"));
      topoSection.appendChild(topoBody);
      container.appendChild(topoSection);

      void fetchSpecDetail("nodes", device)
        .then(async (data) => {
          const schemaKindForDetail = await resolveSlugToKind("nodes").catch(() => null);
          const schemaForDetail = schemaKindForDetail
            ? await fetchSchema(schemaKindForDetail).catch(() => null)
            : null;
          profBody.textContent = "";
          if (schemaForDetail) {
            renderSpecDetailInto(profBody, schemaForDetail.fields.map(toSpecField), data, ["name"]);
          } else {
            const fields = displaySchemaFor("nodes");
            if (fields) renderSpecDetailInto(profBody, fields, data, ["name"]);
            else renderValueInto(profBody, data);
          }
        })
        .catch((err) => {
          profBody.textContent = "";
          if (err instanceof ApiError && err.status === 404) renderProfileNotFound(profBody, device);
          else renderErrorInto(profBody, err);
        });

      void fetchTopology()
        .then((topo) => {
          const devices = (topo as { nodes?: Record<string, unknown> } | null)?.nodes ?? {};
          renderTopologyIntentInto(topoBody, devices[device] ?? null);
        })
        .catch((err) => { topoBody.textContent = ""; renderErrorInto(topoBody, err); });
      break;
    }

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


// renderHistoryTab — per-device audit timeline. Fetches newtron's
// audit.events filtered to {device} and renders the same row layout
// the global Audit tab uses (consistent operator vocabulary). The
// per-device filter is server-side via the ?device= query param so
// the response size stays bounded even on busy networks.
//
// Empty-state cases are first-class:
//   - 404 from newtron → audit logging disabled on this deployment.
//   - 403 → operator lacks audit.read for this network.
//   - empty events array → no recorded activity for this device yet.
async function renderHistoryTab(container: HTMLElement, device: string): Promise<void> {
  container.textContent = "";

  const header = el("div", { className: "node-history-header" });
  header.appendChild(el("p", { className: "node-history-intro" },
    `Recorded activity targeting ${device}. Source: newtron's audit log.`));
  const refresh = el("button", { type: "button", className: "node-history-refresh" }, "Refresh");
  header.appendChild(refresh);
  container.appendChild(header);

  const body = el("div", { className: "node-history-body" });
  body.appendChild(el("p", { className: "node-summary-loading" }, "Loading…"));
  container.appendChild(body);

  const load = async (): Promise<void> => {
    body.textContent = "";
    body.appendChild(el("p", { className: "node-summary-loading" }, "Loading…"));
    // newtron returns audit events newest-first by default (newtron
    // #274); offset 0 = the most recent for this device. Pass order=desc
    // explicitly for clarity. Show the newest page (older history is on
    // the Audit tab).
    let total = 0;
    let events: AuditEvent[] = [];
    try {
      const page = await fetchAuditEvents({ device, order: "desc", limit: 100 });
      total = page.total;
      events = page.events ?? [];
    } catch (err) {
      body.textContent = "";
      body.appendChild(el("p", { className: "panel-error" }, renderEventsError(err)));
      return;
    }
    body.textContent = "";
    if (events.length === 0) {
      body.appendChild(el("p", { className: "node-summary-stat-clean" },
        `No recorded activity for ${device} yet. Operator writes that touch this device will appear here once audit logging captures them.`));
      return;
    }
    const summary = el("p", { className: "node-history-summary" },
      `${events.length} of ${total} event${total === 1 ? "" : "s"} (most recent first).`);
    body.appendChild(summary);
    body.appendChild(renderEventsTable(events));
    if (total > events.length) {
      body.appendChild(el("p", { className: "node-history-paging-hint" },
        "Older events exist. Use the Audit tab for full pagination + cross-device filters."));
    }
  };

  refresh.addEventListener("click", () => { void load(); });
  void load();
}

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

function stopTopologyPoll(): void {
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
function isProvisioning(network: string): boolean {
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

async function mountTopologyTab(root: HTMLElement): Promise<void> {
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
        const cls = ["topology-view-chip"];
        if (isActive) cls.push("topology-view-chip--active");
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
          className: "topology-filter-chip" + (active ? " topology-filter-chip--active" : ""),
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

// ---- Tab switching ----------------------------------------------------------

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
    if (view?.remountOnActivate) {
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
