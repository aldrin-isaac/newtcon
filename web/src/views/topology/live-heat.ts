// views/topology/live-heat.ts — the Live lens's per-link heat layer (slice 4.4).
//
// Bounded by design: ONE RATES read per online device per 5s tick, and only
// while shouldPollLive() says so (topology tab visible AND the Live lens on).
// The port→OID name map is static, so it's fetched once per device per mount.
// Ticks patch link classes in place — no re-render, no layout churn.
//
// The timer is module state so stopTopologyPoll() can kill it when the operator
// leaves the tab, while the per-mount inputs (which devices, which slot) come
// from the factory below.

import { fetchNodeDBTable } from "../../api/newtcon/nodes.js";
import { linkHeat, parsePortNameMap, parseRates, portUtilization, shouldPollLive } from "../../topology-live.js";

let heatPollTimer: number | null = null;

/** stopHeatTimer — clear the interval only. Used by stopTopologyPoll on tab
 *  leave, where the SVG is going away anyway so there are no classes to clear. */
export function stopHeatTimer(): void {
  if (heatPollTimer !== null) {
    window.clearInterval(heatPollTimer);
    heatPollTimer = null;
  }
}

export interface HeatPollArgs {
  graphSlot: HTMLElement;
  deviceNames: string[];
  onlineByDevice: Map<string, boolean>;
  speedsByDevice: Map<string, Map<string, number>>;
  /** Whether the Live lens is currently selected — read per tick, so the
   *  caller's lens state can change without rebuilding the poller. */
  isLiveLensOn: () => boolean;
}

export interface HeatPoll {
  /** sync — start the poll when the Live lens is on, stop it otherwise. */
  sync: () => void;
}

/** createHeatPoll — build the heat poller for one topology mount. */
export function createHeatPoll(args: HeatPollArgs): HeatPoll {
  const nameMapByDevice = new Map<string, Map<string, string>>();

  const applyHeat = (utilByDevice: Map<string, Map<string, number>>): void => {
    const svg = args.graphSlot.querySelector("svg.topology-graph");
    if (!svg) return;
    for (const line of svg.querySelectorAll<SVGLineElement>(".topo-link:not(.topo-link-hit)")) {
      const ends: { local_device?: string; local_interface?: string; remote_device?: string; remote_interface?: string } = {};
      const ld = line.getAttribute("data-local-device"); if (ld !== null) ends.local_device = ld;
      const li = line.getAttribute("data-local-iface"); if (li !== null) ends.local_interface = li;
      const rd = line.getAttribute("data-remote-device"); if (rd !== null) ends.remote_device = rd;
      const ri = line.getAttribute("data-remote-iface"); if (ri !== null) ends.remote_interface = ri;
      line.classList.remove("topo-link--heat-low", "topo-link--heat-med", "topo-link--heat-high");
      const tier = linkHeat(ends, utilByDevice);
      if (tier !== undefined && tier !== "idle") line.classList.add(`topo-link--heat-${tier}`);
    }
  };

  const heatTick = async (): Promise<void> => {
    if (!shouldPollLive({ tabVisible: document.visibilityState === "visible", liveLensOn: args.isLiveLensOn() })) return;
    const online = args.deviceNames.filter((n) => args.onlineByDevice.get(n) === true);
    const utilByDevice = new Map<string, Map<string, number>>();
    await Promise.allSettled(online.map(async (name) => {
      let nameMap = nameMapByDevice.get(name);
      if (!nameMap) {
        nameMap = parsePortNameMap(await fetchNodeDBTable(name, "COUNTERS_DB", "COUNTERS_PORT_NAME_MAP"));
        nameMapByDevice.set(name, nameMap);
      }
      const rates = parseRates(await fetchNodeDBTable(name, "COUNTERS_DB", "RATES"));
      const speeds = args.speedsByDevice.get(name);
      const util = new Map<string, number>();
      for (const port of nameMap.keys()) {
        const u = portUtilization(port, nameMap, rates, speeds?.get(port));
        if (u !== undefined) util.set(port, u);
      }
      utilByDevice.set(name, util);
    }));
    applyHeat(utilByDevice);
  };

  const start = (): void => {
    if (heatPollTimer !== null) return;
    void heatTick();
    heatPollTimer = window.setInterval(() => { void heatTick(); }, 5000);
  };
  const stop = (): void => {
    stopHeatTimer();
    applyHeat(new Map()); // clear any lingering heat classes
  };

  return {
    sync: (): void => {
      if (args.isLiveLensOn()) start();
      else stop();
    },
  };
}
