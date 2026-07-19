// topology-live.ts — pure derivations for the live utilization layer
// (uplift 4.4, #424). COUNTERS_DB shapes → per-port utilization → per-link
// heat tiers. Pure: no I/O, no DOM, no timers — the mount layer owns the
// (bounded, gated) poll.
//
// Wire shapes (runtime-verified against the live engine):
//   COUNTERS_PORT_NAME_MAP → { "": { Ethernet0: "oid:0x...", ... } }
//     (one redis hash; newtron nests it under its single empty field key —
//      tolerate both that nesting and a flat map)
//   RATES → { "oid:0x...": { RX_BPS: "0", TX_BPS: "12800", ... },
//             PORT: {...config...}, RIF: {...}, ... }  ← config rows skipped

import type { TopoLinkEnds } from "./topology-links.js";

const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** parsePortNameMap — port → counters OID. */
export function parsePortNameMap(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!rec(raw)) return out;
  // The whole map may sit under a single "" field key (newtron's dump of a
  // one-hash table); descend when that's the only plausible shape.
  const src = rec(raw[""]) ? (raw[""] as Record<string, unknown>) : raw;
  for (const [port, oid] of Object.entries(src)) {
    if (typeof oid === "string" && oid.startsWith("oid:")) out.set(port, oid);
  }
  return out;
}

export interface PortRate { rxBps: number; txBps: number }

/** parseRates — OID → {rxBps, txBps}. Non-oid rows (PORT/RIF/TRAP config)
 *  and unreadable numbers are skipped. */
export function parseRates(raw: unknown): Map<string, PortRate> {
  const out = new Map<string, PortRate>();
  if (!rec(raw)) return out;
  for (const [key, val] of Object.entries(raw)) {
    if (!key.startsWith("oid:") || !rec(val)) continue;
    const rx = Number(val.RX_BPS);
    const tx = Number(val.TX_BPS);
    if (!Number.isFinite(rx) && !Number.isFinite(tx)) continue;
    out.set(key, { rxBps: Number.isFinite(rx) ? rx : 0, txBps: Number.isFinite(tx) ? tx : 0 });
  }
  return out;
}

/** portUtilization — busiest direction over configured speed, 0..1 (capped).
 *  Undefined when the port, its OID, its rates, or its speed are unknown. */
export function portUtilization(
  port: string,
  nameMap: Map<string, string>,
  rates: Map<string, PortRate>,
  speedMbps: number | undefined,
): number | undefined {
  if (speedMbps === undefined || speedMbps <= 0) return undefined;
  const oid = nameMap.get(port);
  if (oid === undefined) return undefined;
  const rate = rates.get(oid);
  if (rate === undefined) return undefined;
  const bps = Math.max(rate.rxBps, rate.txBps);
  return Math.min(1, bps / (speedMbps * 1_000_000));
}

export type HeatTier = "idle" | "low" | "med" | "high";

/** heatTier — utilization → tier. Thresholds favor early visibility: real
 *  traffic shows at 5%, warning color from 40%, danger from 80%. */
export function heatTier(utilization: number): HeatTier {
  if (utilization >= 0.8) return "high";
  if (utilization >= 0.4) return "med";
  if (utilization >= 0.05) return "low";
  return "idle";
}

/** linkHeat — a link's heat is the busiest of its two endpoint ports.
 *  Undefined (no data on either end) means "no heat class at all". */
export function linkHeat(
  link: TopoLinkEnds,
  utilByDevice: Map<string, Map<string, number>>,
): HeatTier | undefined {
  const ends = [
    { dev: link.local_device, port: link.local_interface },
    { dev: link.remote_device, port: link.remote_interface },
  ];
  const utils = ends
    .map((e) => (e.dev && e.port ? utilByDevice.get(e.dev)?.get(e.port) : undefined))
    .filter((v): v is number => v !== undefined);
  if (utils.length === 0) return undefined;
  return heatTier(Math.max(...utils));
}

/** shouldPollLive — THE poll gate (pinned here so it's testable): rates are
 *  fetched only while the topology tab is visible AND the Live lens is on. */
export function shouldPollLive(opts: { tabVisible: boolean; liveLensOn: boolean }): boolean {
  return opts.tabVisible && opts.liveLensOn;
}
