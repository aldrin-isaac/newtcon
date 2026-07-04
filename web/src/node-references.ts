// node-references.ts — pure detection of what still references a node, so the
// delete flow can warn + force-cascade (parallel to service-bindings.ts).
//
// newtron's delete-node refuses (409) when a link still wires to the device — a
// bare, unreferenced node deletes cleanly; ?force=true cascades the links. The UI
// detects the links client-side for instant feedback and, on confirm, stages a
// force delete so newtron removes the node + its links together.

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
