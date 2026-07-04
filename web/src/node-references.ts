// node-references.ts — pure topology-reference helpers for the delete + add-link
// flows: what still references a node (delete force-cascade), and which interfaces
// are free to wire (add-link pickers).
//
// newtron's delete-node refuses (409) when a link still wires to the device — a
// bare, unreferenced node deletes cleanly; ?force=true cascades the links. The UI
// detects the links client-side for instant feedback and, on confirm, stages a
// force delete so newtron removes the node + its links together.

import { comparePorts } from "./port-config.js";

export interface NodeLink {
  a: string;   // "device:iface"
  z: string;
  peer: string; // the OTHER device on this link (not nodeName)
}

// deviceOf extracts the device from a "device:iface" endpoint string.
function deviceOf(endpoint: unknown): string {
  if (typeof endpoint !== "string") return "";
  const idx = endpoint.indexOf(":");
  return idx < 0 ? endpoint : endpoint.slice(0, idx);
}

// deriveNodeLinks returns every topology link with nodeName as an endpoint, each
// tagged with the peer device on the other end.
export function deriveNodeLinks(topology: unknown, nodeName: string): NodeLink[] {
  const links = (topology && typeof topology === "object")
    ? (topology as { links?: unknown }).links
    : undefined;
  if (!Array.isArray(links)) return [];

  const out: NodeLink[] = [];
  for (const l of links) {
    if (!l || typeof l !== "object") continue;
    const a = (l as { a?: unknown }).a;
    const z = (l as { z?: unknown }).z;
    const da = deviceOf(a);
    const dz = deviceOf(z);
    if (da !== nodeName && dz !== nodeName) continue;
    out.push({ a: String(a ?? ""), z: String(z ?? ""), peer: da === nodeName ? dz : da });
  }
  return out;
}

// availableInterfacesByDevice returns, per device, the DECLARED ports that aren't
// already wired to a link — the interfaces you can pick when adding a link.
// newtron's add-link requires both endpoints to be declared ports and refuses an
// already-wired one, so offering only free declared ports keeps the picker honest
// (no undeclared-interface 500s, no already-wired 409s). `extraWired` carries
// pending (not-yet-applied) link endpoints ("device:iface") so they're excluded too.
export function availableInterfacesByDevice(
  topology: unknown,
  extraWired: string[] = [],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const t = (topology && typeof topology === "object")
    ? (topology as { nodes?: unknown; links?: unknown })
    : {};
  const nodes = t.nodes;
  if (!nodes || typeof nodes !== "object") return out;

  const wired = new Set<string>(extraWired);
  if (Array.isArray(t.links)) {
    for (const l of t.links) {
      if (!l || typeof l !== "object") continue;
      const a = (l as { a?: unknown }).a;
      const z = (l as { z?: unknown }).z;
      if (typeof a === "string") wired.add(a);
      if (typeof z === "string") wired.add(z);
    }
  }

  for (const [dev, def] of Object.entries(nodes as Record<string, unknown>)) {
    const ports = (def && typeof def === "object")
      ? (def as { ports?: unknown }).ports
      : undefined;
    if (!ports || typeof ports !== "object") { out.set(dev, []); continue; }
    const free = Object.keys(ports as Record<string, unknown>)
      .filter((p) => !wired.has(`${dev}:${p}`))
      .sort(comparePorts);
    out.set(dev, free);
  }
  return out;
}

// hostLikeDevices returns devices whose topology entry has NO /setup-device step —
// hosts (HWSKU-less platform, no SONiC bring-up) and bare nodes. newtron doesn't
// require declared ports for a device with no ports map, so their link interfaces
// are free-text (e.g. eth0), not a dropdown of declared SONiC ports. Switch nodes
// carry a setup-device step and constrain to declared ports.
export function hostLikeDevices(topology: unknown): Set<string> {
  const out = new Set<string>();
  const nodes = (topology && typeof topology === "object")
    ? (topology as { nodes?: unknown }).nodes
    : undefined;
  if (!nodes || typeof nodes !== "object") return out;
  for (const [dev, def] of Object.entries(nodes as Record<string, unknown>)) {
    const steps = (def && typeof def === "object") ? (def as { steps?: unknown }).steps : undefined;
    const hasSetup = Array.isArray(steps) && steps.some(
      (s) => s && typeof s === "object" && (s as { url?: unknown }).url === "/setup-device",
    );
    if (!hasSetup) out.add(dev);
  }
  return out;
}
