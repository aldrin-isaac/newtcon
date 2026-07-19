// device-model.ts — the one fetch bundle for a device's scattered facts
// (console-uplift 1.5, #389). The drawer's Interfaces view (and future
// consumers) joins four sources: the node spec (platform), the topology
// entry (ports + steps), the live interface read, and the live VLAN read.
// Fetching them lives here so every consumer shares one inventory-first
// contract: spec + topology always resolve (or yield empty), live reads are
// best-effort overlays whose absence flags `liveUnavailable` instead of
// blocking.

import { fetchSpecDetail } from "./api/newtcon/network.js";
import { fetchNodeInterfaces, fetchNodeVLANs, fetchTopology } from "./api/newtcon/nodes.js";
import type { LiveIface, PlatformPort } from "./device-interfaces.js";

export interface DeviceModel {
  platform: string;
  /** The device's topology entry ({} when absent). */
  entry: { ports?: Record<string, Record<string, unknown>>; steps?: unknown[] };
  /** Full topology links array (for linksForDevice). */
  links: unknown;
  /** Platform port inventory ([] when platform absent/HWSKU-less). */
  inventory: PlatformPort[];
  /** Live interface read ([] when unreachable). */
  live: LiveIface[];
  /** Live VLAN read (null when unreachable) — feeds the IRB section. */
  liveVlans: unknown;
  /** True when the live interface read failed (device un-deployed/unreachable). */
  liveUnavailable: boolean;
}

/** loadDeviceModel fetches the bundle for one device (spec + topology in
 *  parallel with both live reads; platform inventory follows the spec). */
export async function loadDeviceModel(device: string): Promise<DeviceModel> {
  let liveUnavailable = false;
  const [profile, topo, liveRaw, liveVlans] = await Promise.all([
    fetchSpecDetail("nodes", device).catch(() => null),
    fetchTopology().catch(() => null),
    fetchNodeInterfaces(device).catch(() => { liveUnavailable = true; return null; }),
    fetchNodeVLANs(device).catch(() => null),
  ]);
  const platform = (profile as { platform?: string } | null)?.platform ?? "";
  const entry = ((topo as { nodes?: Record<string, DeviceModel["entry"]> } | null)?.nodes ?? {})[device] ?? {};
  let inventory: PlatformPort[] = [];
  if (platform) {
    const plat = await fetchSpecDetail("platforms", platform).catch(() => null);
    const ports = (plat as { ports?: PlatformPort[] } | null)?.ports;
    if (Array.isArray(ports)) inventory = ports;
  }
  const live = Array.isArray(liveRaw) ? liveRaw as LiveIface[]
    : liveRaw && typeof liveRaw === "object" ? [liveRaw as LiveIface] : [];
  return {
    platform, entry, links: (topo as { links?: unknown } | null)?.links,
    inventory, live, liveVlans, liveUnavailable,
  };
}
