// views/topology/device-probe.ts — the per-device fan-out that gathers every
// live signal the canvas draws: reachability, drift, and the three link-truth
// reads (LLDP far-ends, port state/speeds, LAG members, underlay health).
//
// One pass over the device list, all devices in parallel, every read
// best-effort: a device that fails a read just stays silent in that map rather
// than failing the mount. Drift + link truth only run for ONLINE devices —
// they're meaningless otherwise and would just burn round-trips.

import { fetchNodeBGPCheck, fetchNodeDBTable, fetchNodeDrift, fetchNodeInfo } from "../../api/newtcon/nodes.js";
import {
  type LldpNeighbor, type PortState, type UnderlayState,
  parseBgpCheckOk, parseLagMembers, parseLldpTable, parsePortSpeeds, parsePortStates,
} from "../../topology-links.js";

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

export interface DeviceProbeResult {
  onlineByDevice: Map<string, boolean>;
  driftByDevice: Map<string, number>;
  lldpByDevice: Map<string, LldpNeighbor[]>;
  speedsByDevice: Map<string, Map<string, number>>;
  portStatesByDevice: Map<string, Map<string, PortState>>;
  lagMembersByDevice: Map<string, Map<string, string[]>>;
  underlayByDevice: Map<string, UnderlayState>;
}

/** probeDevices — run every per-device probe in parallel and return the
 *  populated maps the renderer + palette resolution consume. */
export async function probeDevices(deviceNames: string[]): Promise<DeviceProbeResult> {
  const onlineByDevice = new Map<string, boolean>();
  const driftByDevice = new Map<string, number>();
  // Link truth (slice 4.2): bulk reads per ONLINE device — LLDP far-ends,
  // actuated port speeds, underlay session health. All best-effort: a failed
  // read just leaves that device silent.
  const lldpByDevice = new Map<string, LldpNeighbor[]>();
  const speedsByDevice = new Map<string, Map<string, number>>();
  // Per-port interface state (admin/oper) for the per-link-end dots —
  // parsed from the SAME PORT_TABLE read that feeds speeds. No new fetch.
  const portStatesByDevice = new Map<string, Map<string, PortState>>();
  // Per-device PortChannel → member ports, so a LAG endpoint's hover tip can
  // name what the aggregate bundles. Same online-only read as port state.
  const lagMembersByDevice = new Map<string, Map<string, string[]>>();
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
      const [lldp, ports, lags, bgp] = await Promise.allSettled([
        fetchNodeDBTable(name, "APPL_DB", "LLDP_ENTRY_TABLE"),
        fetchNodeDBTable(name, "APPL_DB", "PORT_TABLE"),
        fetchNodeDBTable(name, "APPL_DB", "LAG_MEMBER_TABLE"),
        fetchNodeBGPCheck(name),
      ]);
      if (lldp.status === "fulfilled") lldpByDevice.set(name, parseLldpTable(lldp.value));
      if (ports.status === "fulfilled") {
        speedsByDevice.set(name, parsePortSpeeds(ports.value));
        portStatesByDevice.set(name, parsePortStates(ports.value));
      }
      if (lags.status === "fulfilled") lagMembersByDevice.set(name, parseLagMembers(lags.value));
      if (bgp.status === "fulfilled") underlayByDevice.set(name, parseBgpCheckOk(bgp.value));
    })
  );
  void probeResults;

  return {
    onlineByDevice, driftByDevice, lldpByDevice, speedsByDevice,
    portStatesByDevice, lagMembersByDevice, underlayByDevice,
  };
}
