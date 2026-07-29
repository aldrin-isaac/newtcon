// views/topology/status-poll.ts — the 5s newtlab-status poll and the in-place
// DOM patcher it drives.
//
// Cheap by design: one HTTP call per tick, and the result is patched onto the
// existing SVG (status dot, palette class, corner text, link repaint) rather
// than re-rendering. A re-render would drop the operator's pan/zoom and any
// focus state mid-interaction.
//
// The poller doesn't know which view mode is active — the caller passes
// rebuild* callbacks that resolve the palette + status text from the freshly
// fetched lab state (slice #210.B/C/D).

import { type LabState, fetchLabStatus } from "../../api/newtcon/lab.js";
import { type DeviceStatus, resolveDeviceStatus } from "../../device-status.js";
import { type PaletteState, resolveLinkPalette } from "../../topology-palette.js";
import { type PaletteByDevice, type StatusTextByDevice } from "./canvas.js";
import { isProvisioning } from "./lab-ops.js";
import { stopHeatTimer } from "./live-heat.js";

let topologyPollTimer: number | null = null;

export function stopTopologyPoll(): void {
  if (topologyPollTimer !== null) {
    window.clearInterval(topologyPollTimer);
    topologyPollTimer = null;
  }
  // The live-layer heat poll is owned by live-heat.ts, but leaving the tab
  // stops both — the canvas it patches is going away.
  stopHeatTimer();
}

export interface PollArgs {
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

export function startTopologyPoll(args: PollArgs): void {
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
