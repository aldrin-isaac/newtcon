// fabric-health-strip.ts — the header fabric-health strip (uplift 4.5, #425).
// Three cells — underlay / drift / lab — aggregated per network and visible
// on EVERY tab (it lives in the app header). Clicking jumps to Topology.
//
// Fetch posture: one sweep at mount + every 60s — per online device one
// bgp/check + one drift read (best-effort; a 503 just leaves that device
// out), plus one lab status call. Aggregation itself is pure
// (fabric-health.ts).

import { el } from "./dom.js";
import { activeNetwork } from "./network-switcher.js";
import { fetchNodeBGPCheck, fetchNodeDrift, fetchTopology } from "./api/newtcon/nodes.js";
import { fetchLabStatus } from "./api/newtcon/lab.js";
import { parseBgpCheckOk, type UnderlayState } from "./topology-links.js";
import { aggregateFabricHealth, type FabricHealthSummary } from "./fabric-health.js";

const REFRESH_MS = 60_000;

function render(host: HTMLElement, summary: FabricHealthSummary): void {
  host.textContent = "";
  for (const cell of [summary.underlay, summary.drift, summary.lab]) {
    host.appendChild(el("span", { className: `fabric-strip-cell fabric-strip-cell--${cell.tone}` }, cell.label));
  }
}

async function sweep(host: HTMLElement): Promise<void> {
  const net = activeNetwork();
  try {
    const topo = (await fetchTopology()) as { nodes?: Record<string, unknown> };
    const names = Object.keys(topo.nodes ?? {});

    const underlayByDevice = new Map<string, UnderlayState>();
    const driftByDevice = new Map<string, number>();
    await Promise.allSettled(names.map(async (name) => {
      const [bgp, drift] = await Promise.allSettled([
        fetchNodeBGPCheck(name),
        fetchNodeDrift(name),
      ]);
      if (bgp.status === "fulfilled") underlayByDevice.set(name, parseBgpCheckOk(bgp.value));
      if (drift.status === "fulfilled" && Array.isArray(drift.value)) driftByDevice.set(name, drift.value.length);
    }));

    const labNodeStatus = new Map<string, string>();
    try {
      const lab = (await fetchLabStatus(net)) as { nodes?: Record<string, { status?: string }> };
      for (const [n, entry] of Object.entries(lab.nodes ?? {})) {
        if (typeof entry?.status === "string") labNodeStatus.set(n, entry.status);
      }
    } catch { /* no lab for this network — the cell reads muted */ }

    render(host, aggregateFabricHealth({ underlayByDevice, driftByDevice, labNodeStatus }));
  } catch {
    // Topology unreadable (engine down / no network) — show nothing rather
    // than a wall of muted dashes.
    host.textContent = "";
  }
}

/** setupFabricHealthStrip — mount into #fabric-strip and keep it fresh. */
export function setupFabricHealthStrip(): void {
  const host = document.getElementById("fabric-strip");
  if (!host) return;
  host.addEventListener("click", () => {
    location.hash = `#/${activeNetwork()}/topology`;
  });
  void sweep(host);
  window.setInterval(() => {
    if (document.visibilityState === "visible") void sweep(host);
  }, REFRESH_MS);
}
