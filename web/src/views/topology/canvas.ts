// views/topology/canvas.ts — the SVG canvas: the topology wire shape adapter,
// the layout cache, and renderTopologySVG itself (zones, links with
// neighbour-aware seating + occlusion routing, device cards, badges,
// drag-to-reposition, and pan/zoom wiring).
//
// The renderer is a pure-ish function of (data, opts) → SVG. It holds no view
// state: the caller (index.ts) owns view mode, lens, filter, viewport and
// pre-resolves everything positional or palette-related into opts. That's what
// makes it safe to call on every re-render.

import { type DeviceStatus } from "../../device-status.js";
import { computeTopologyLayout } from "../../topology-layout.js";
import {
  type LldpNeighbor, type PortState, type UnderlayState,
  classifyLink, distributeSeats, linkSpeedForLink, linkStrokeWidth, linkUnderlayState,
  portDotState, portDotTooltip,
} from "../../topology-links.js";
import { linkEndpointMembership } from "../../topology-lenses.js";
import { type PaletteState, resolveLinkPalette } from "../../topology-palette.js";
import { type PinnedPosition } from "../../topology-positions.js";
import { type ViewState, ZOOM_STEP, panBy, viewBoxStr, zoomAt } from "../../topology-viewport.js";
import { attachFastTip, buildPortTip } from "./port-tip.js";

// ---- Topology types ---------------------------------------------------------

export interface TopoNode {
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

export interface TopologyData {
  nodes?: TopoNode[];
  links?: TopoLink[];
  [k: string]: unknown;
}

// ---- Topology shape adapter -------------------------------------------------

// Newtron returns: { devices: { name1: { steps?, ... }, ... }, links: [{a: "dev:iface", z: "dev:iface"}], ... }
// The renderer expects:    { nodes:   [{ name, type? }, ...],          links: [{local_device, local_interface, remote_device, remote_interface}, ...] }
// Adapt before rendering so the renderer stays simple.
export function adaptTopology(raw: unknown): TopologyData {
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

/** resetLayoutCache — drop the cached auto layout so the next render recomputes
 *  it from scratch. The "re-run layout" toolbar button calls this after
 *  discarding the operator's manual positions. */
export function resetLayoutCache(): void {
  topoLayoutCache = null;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
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
export type PaletteByDevice = Map<string, PaletteState>;

// StatusTextByDevice — short textual status drawn under each device's
// rect in lab/physical views. Empty string ("") suppresses the label
// for that device; missing entries also suppress.
export type StatusTextByDevice = Map<string, string>;

export interface TopologyRenderOpts {
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
  /** Lens emphasis (slice 4.3): devices to draw with a halo ring. */
  haloNames?: Set<string>;
  /** Zone tinting (uplift 6.8): device → zone name; zones render as
   *  barely-visible rounded regions behind their members. */
  zoneByDevice?: Map<string, string>;
  /** vni lens, port level: device → member ports. Member cards grow port
   *  pills; links get endpoint dots where a member port terminates —
   *  a one-ended link is the missing tagged join, visible. */
  vniMemberPorts?: Map<string, string[]>;
  /** Per-device port state (admin/oper), for the always-on interface-state
   *  dots at each link endpoint (hover → name / admin / oper / speed / mtu). */
  portStatesByDevice?: Map<string, Map<string, PortState>>;
  lagMembersByDevice?: Map<string, Map<string, string[]>>;
}

export interface TopologyRenderResult {
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

export function renderTopologySVG(
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
    layoutInputs.map((i) => i.name + (i.isHost ? "H" : "")).sort(),
    layoutEdges.map((e) => [e.a, e.z].sort().join("")).sort(),
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

  // Canvas texture: a subtle dot grid in userSpace units, so it pans and
  // zooms WITH the fabric (a CSS background would sit still). The rect is
  // oversized far past any layout; bounds/fit derive from node positions,
  // so it never affects them. Toggleable from the zoom toolbar; the
  // preference persists per browser.
  const gridDefs = svgEl("defs", {});
  const gridPat = svgEl("pattern", { id: "topo-grid-pat", width: "24", height: "24", patternUnits: "userSpaceOnUse" });
  gridPat.appendChild(svgEl("circle", { cx: "1", cy: "1", r: "1", "class": "topo-grid-dot" }));
  gridDefs.appendChild(gridPat);
  svg.appendChild(gridDefs);
  const gridRect = svgEl("rect", {
    x: "-100000", y: "-100000", width: "200000", height: "200000",
    fill: "url(#topo-grid-pat)", "class": "topo-grid",
  });
  if (localStorage.getItem("newtcon.topoGrid") === "off") gridRect.classList.add("topo-grid--off");
  svg.appendChild(gridRect);

  // Zone tinting (uplift 6.8): each zone is a rounded region behind its
  // member devices — geography, not state. Bounding box over member
  // positions + padding; token-tinted at whisper alpha; label in the
  // region's top-left. Never interactive; never affects fit (bounds come
  // from node positions).
  if (opts.zoneByDevice && opts.zoneByDevice.size > 0) {
    const members = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
    for (const nd of nodes) {
      const zone = opts.zoneByDevice.get(nd.name);
      const pos = positions.get(nd.name);
      if (zone === undefined || !pos) continue;
      const b = members.get(zone) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      b.minX = Math.min(b.minX, pos.cx - NODE_W / 2);
      b.minY = Math.min(b.minY, pos.cy - NODE_H / 2);
      b.maxX = Math.max(b.maxX, pos.cx + NODE_W / 2);
      b.maxY = Math.max(b.maxY, pos.cy + NODE_H / 2);
      members.set(zone, b);
    }
    const PAD = 26;
    let zi = 0;
    for (const [zone, b] of [...members.entries()].sort(([a], [z]) => a.localeCompare(z))) {
      const region = svgEl("g", { "class": `topo-zone-region topo-zone-region--${zi % 3}` });
      region.appendChild(svgEl("rect", {
        x: String(b.minX - PAD), y: String(b.minY - PAD),
        width: String(b.maxX - b.minX + PAD * 2), height: String(b.maxY - b.minY + PAD * 2),
        rx: "14",
      }));
      const label = svgEl("text", {
        "class": "topo-zone-label",
        x: String(b.minX - PAD + 10),
        y: String(b.minY - PAD + 14),
      });
      label.textContent = zone;
      region.appendChild(label);
      svg.appendChild(region);
      zi++;
    }
  }

  // Draw links first (under nodes). When onLinkClick is wired, each
  // visible line gets a wider invisible hit-target sibling so clicking
  // on or near the line is reliable — bare 1.5px strokes are nearly
  // impossible to hit.
  const dimmed = opts.dimmedNames ?? new Set<string>();
  const paletteByDevice = opts.paletteByDevice;
  // Neighbour-aware seating: distribute each node's incident link ends around
  // its perimeter (topology-links.distributeSeats) so links to different
  // neighbours never collide and parallel links fan out. Recomputed every
  // render, so dragging a node re-seats it AND its neighbours. Keyed by link
  // index; a link's two ends live under its from-device and to-device maps.
  // Links live in their own <g> layer so a drag can redraw JUST the links
  // (following the moved card live) without touching the node groups. pos()
  // consults a transient drag override, so redrawLinks() re-seats everything
  // against the dragged node's live position.
  const linkLayer = svgEl("g", { "class": "topo-link-layer" });
  svg.appendChild(linkLayer);
  let dragOverride: { name: string; cx: number; cy: number } | null = null;
  const pos = (d: string): { cx: number; cy: number } | undefined =>
    (dragOverride && dragOverride.name === d) ? { cx: dragOverride.cx, cy: dragOverride.cy } : positions.get(d);

  const HW = NODE_W / 2, HH = NODE_H / 2;
  // Occlusion-aware routing: a link whose straight segment would pass under a
  // NON-endpoint card deflects around it. Reads pos() so it tracks a drag.
  const occlusionOffset = (link: TopoLink): number => {
    const a = link.local_device ? pos(link.local_device) : undefined;
    const z = link.remote_device ? pos(link.remote_device) : undefined;
    if (!a || !z) return 0;
    let blockedSum = 0;
    let blockers = 0;
    for (const nd of nodes) {
      if (nd.name === link.local_device || nd.name === link.remote_device) continue;
      const p = pos(nd.name);
      if (!p) continue;
      const dx = z.cx - a.cx, dy = z.cy - a.cy;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      let t = ((p.cx - a.cx) * dx + (p.cy - a.cy) * dy) / len2;
      t = Math.max(0.08, Math.min(0.92, t));
      const qx = a.cx + t * dx, qy = a.cy + t * dy;
      const ex = (p.cx - qx) / (NODE_W / 2 + 16);
      const ey = (p.cy - qy) / (NODE_H / 2 + 16);
      if (ex * ex + ey * ey < 1) {
        const side = Math.sign((z.cx - a.cx) * (p.cy - a.cy) - (z.cy - a.cy) * (p.cx - a.cx)) || 1;
        blockedSum += -side;
        blockers++;
      }
    }
    if (blockers === 0) return 0;
    const dir = Math.sign(blockedSum) || 1;
    return dir * (NODE_H / 2 + 22 + (blockers - 1) * 10);
  };
  const arcPath = (x1: number, y1: number, x2: number, y2: number, off: number): string => {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const px = -(y2 - y1) / len, py = (x2 - x1) / len;
    return `M ${x1} ${y1} Q ${mx + px * off * 2} ${my + py * off * 2} ${x2} ${y2}`;
  };

  // redrawLinks — (re)build the link layer against the current pos(): seat
  // distribution + lines + endpoint dots. Called once per render and on every
  // drag tick (with the moved node overridden), so links follow the card.
  const redrawLinks = (): void => {
    linkLayer.replaceChildren();
    // Neighbour-aware seating: distribute each node's incident link ends
    // around its perimeter so links to different neighbours never collide.
    const incident = new Map<string, { id: string; tx: number; ty: number }[]>();
    links.forEach((lnk, i) => {
      const fp = lnk.local_device ? pos(lnk.local_device) : undefined;
      const tp = lnk.remote_device ? pos(lnk.remote_device) : undefined;
      if (!fp || !tp || !lnk.local_device || !lnk.remote_device) return;
      (incident.get(lnk.local_device) ?? incident.set(lnk.local_device, []).get(lnk.local_device)!).push({ id: String(i), tx: tp.cx, ty: tp.cy });
      (incident.get(lnk.remote_device) ?? incident.set(lnk.remote_device, []).get(lnk.remote_device)!).push({ id: String(i), tx: fp.cx, ty: fp.cy });
    });
    const seatsByDevice = new Map<string, Map<string, { x: number; y: number }>>();
    for (const [dev, list] of incident) {
      const p = pos(dev);
      if (p) seatsByDevice.set(dev, distributeSeats({ x: p.cx, y: p.cy }, HW, HH, list));
    }
    const seatFor = (dev: string | undefined, i: number, fallback: { cx: number; cy: number }): { x: number; y: number } =>
      (dev ? seatsByDevice.get(dev)?.get(String(i)) : undefined) ?? { x: fallback.cx, y: fallback.cy };

    links.forEach((link, linkIdx) => {
      const from = link.local_device ? pos(link.local_device) : undefined;
      const to = link.remote_device ? pos(link.remote_device) : undefined;
      if (!from || !to) return;
      const linkDimmed = (link.local_device !== undefined && dimmed.has(link.local_device))
        || (link.remote_device !== undefined && dimmed.has(link.remote_device));
      let linkPalette: PaletteState = "unknown";
      if (paletteByDevice && link.local_device && link.remote_device) {
        const a = paletteByDevice.get(link.local_device) ?? "unknown";
        const z = paletteByDevice.get(link.remote_device) ?? "unknown";
        linkPalette = resolveLinkPalette(a, z);
      }
      const arc = occlusionOffset(link);
      const fromP = seatFor(link.local_device, linkIdx, from);
      const toP = seatFor(link.remote_device, linkIdx, to);
      if (opts.onLinkClick) {
        const hit = arc === 0
          ? svgEl("line", { "class": "topo-link-hit", x1: String(fromP.x), y1: String(fromP.y), x2: String(toP.x), y2: String(toP.y) })
          : svgEl("path", { "class": "topo-link-hit", d: arcPath(fromP.x, fromP.y, toP.x, toP.y, arc), fill: "none" });
        const onLinkClick = opts.onLinkClick;
        hit.addEventListener("click", (e) => { e.stopPropagation(); onLinkClick(link); });
        linkLayer.appendChild(hit);
      }
      let truthClass = "";
      let widthAttr: string | undefined;
      if (opts.lldpByDevice) truthClass += ` topo-link--${classifyLink(link, opts.lldpByDevice)}`;
      if (opts.underlayByDevice && linkUnderlayState(link, opts.underlayByDevice) === "down") truthClass += " topo-link--underlay-down";
      if (opts.speedsByDevice) widthAttr = String(linkStrokeWidth(linkSpeedForLink(link, opts.speedsByDevice)));
      const linkClass = "topo-link topo-elem--" + linkPalette + (linkDimmed ? " topo-link--dimmed" : "") + truthClass;
      const line = arc === 0
        ? svgEl("line", { "class": linkClass, x1: String(fromP.x), y1: String(fromP.y), x2: String(toP.x), y2: String(toP.y), ...(widthAttr !== undefined ? { "stroke-width": widthAttr } : {}) })
        : svgEl("path", { "class": linkClass, d: arcPath(fromP.x, fromP.y, toP.x, toP.y, arc), fill: "none", ...(widthAttr !== undefined ? { "stroke-width": widthAttr } : {}) });
      if (link.local_device) line.setAttribute("data-local-device", link.local_device);
      if (link.remote_device) line.setAttribute("data-remote-device", link.remote_device);
      if (link.local_interface) line.setAttribute("data-local-iface", link.local_interface);
      if (link.remote_interface) line.setAttribute("data-remote-iface", link.remote_interface);
      linkLayer.appendChild(line);

      if (opts.vniMemberPorts) {
        const mem = linkEndpointMembership(link, opts.vniMemberPorts);
        if (mem.local) linkLayer.appendChild(svgEl("circle", { "class": "topo-vni-endpoint", cx: String(fromP.x), cy: String(fromP.y), r: "7" }));
        if (mem.remote) linkLayer.appendChild(svgEl("circle", { "class": "topo-vni-endpoint", cx: String(toP.x), cy: String(toP.y), r: "7" }));
      }
      if (opts.portStatesByDevice) {
        const ifaceDot = (dev: string | undefined, iface: string | undefined, at: { x: number; y: number }): void => {
          if (!dev || !iface) return;
          const st = opts.portStatesByDevice?.get(dev)?.get(iface);
          const state = portDotState(st);
          const members = opts.lagMembersByDevice?.get(dev)?.get(iface);
          const dot = svgEl("circle", { "class": `topo-iface-dot topo-iface-dot--${state}`, cx: String(at.x), cy: String(at.y), r: "4", "aria-label": portDotTooltip(iface, st) });
          attachFastTip(dot, () => buildPortTip(iface, st, state, members));
          linkLayer.appendChild(dot);
        };
        ifaceDot(link.local_device, link.local_interface, fromP);
        ifaceDot(link.remote_device, link.remote_interface, toP);
      }
    });
  };
  redrawLinks();
  // Exposed so the drag handler can follow the moved card live.
  const setDragOverride = (o: { name: string; cx: number; cy: number } | null): void => { dragOverride = o; redrawLinks(); };

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
        + (String(node.type) === "host" ? " topo-node--host" : " topo-node--switch")
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

    if (opts.haloNames?.has(node.name)) {
      // Lens halo — accent ring behind the card (never moves layout).
      g.appendChild(svgEl("rect", {
        "class": "topo-node-halo",
        x: String(pos.cx - NODE_W / 2 - 4),
        y: String(pos.cy - NODE_H / 2 - 4),
        width: String(NODE_W + 8),
        height: String(NODE_H + 8),
        rx: "9",
      }));
    }

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

    // vni lens port pills: the member ports themselves, named, in a row
    // under the card. The port is the unit that breaks; draw it.
    const vniPorts = opts.vniMemberPorts?.get(node.name) ?? [];
    if (vniPorts.length > 0) {
      const pillRow = svgEl("g", { "class": "topo-vni-ports" });
      let px = pos.cx - NODE_W / 2;
      const py = pos.cy + NODE_H / 2 + 8;
      for (const port of vniPorts.slice(0, 4)) {
        const short = port.replace(/^Ethernet/, "e").replace(/^Vlan/, "vl").replace(/^PortChannel/, "po");
        const w = 14 + short.length * 6.2;
        pillRow.appendChild(svgEl("rect", { x: String(px), y: String(py), width: String(w), height: "15", rx: "7" }));
        const label = svgEl("text", { x: String(px + w / 2), y: String(py + 8), "class": "topo-vni-port-label" });
        label.textContent = short;
        pillRow.appendChild(label);
        px += w + 5;
      }
      if (vniPorts.length > 4) {
        const more = svgEl("text", { x: String(px + 2), y: String(py + 8), "class": "topo-vni-port-more" });
        more.textContent = `+${vniPorts.length - 4}`;
        pillRow.appendChild(more);
      }
      g.appendChild(pillRow);
    }

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
      // Card footer (uplift 6.6): status lives INSIDE the card's bottom-right
      // corner — anchored, not floating in canvas space.
      const statusLabel = svgEl("text", {
        "class": "topo-status-text",
        "data-status-text": node.name,
        x: String(pos.cx + NODE_W / 2 - 6),
        y: String(pos.cy + NODE_H / 2 - 8),
      });
      statusLabel.textContent = statusText;
      g.appendChild(statusLabel);
    } else {
      // Render a hidden anchor so patchDeviceStatuses can replace it
      // in place when the status text fills in later (poll tick).
      const placeholder = svgEl("text", {
        "class": "topo-status-text topo-status-text--empty",
        "data-status-text": node.name,
        x: String(pos.cx + NODE_W / 2 - 6),
        y: String(pos.cy + NODE_H / 2 - 8),
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
          // Follow the moved card live: re-seat + redraw the link layer with
          // this node at its dragged position (neighbours re-seat too).
          setDragOverride({ name: node.name, cx: startCx + sx, cy: startCy + sy });
        };
        const onUp = (em: MouseEvent): void => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          g.classList.remove("topo-node--dragging");
          if (dragging) {
            const { sx, sy } = pixelToSVG(em.clientX - startClientX, em.clientY - startClientY);
            setDragOverride(null);
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
