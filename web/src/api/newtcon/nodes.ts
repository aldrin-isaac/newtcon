// Typed client for newtcon-server's topology and node-inspector endpoints.
//
// All calls pass through newtcon-server which proxies to newtron verbatim.
// The data field is returned as-is (unknown) so callers can render with the
// recursive renderValue helper in app.ts without coupling to a concrete type.
//
// Every function targets the operator's active network by default; pass
// `network` to target a specific network (cross-engine workflows).

import { apiFetch, apiSend } from "./_transport.js";
import { apiPath } from "../../api-path.js";

function pathFor(suffix: string, network?: string): string {
  return network ? apiPath.network(network, suffix) : apiPath(suffix);
}

// fetchNodeRaw delegates to apiFetch with no-cache. Kept as a thin local
// alias so per-endpoint functions read consistently.
function fetchNodeRaw(url: string): Promise<unknown> {
  return apiFetch(url, { cache: "no-store" });
}

// fetchTopology returns the full topology payload from GET /api/networks/{netID}/topology.
export async function fetchTopology(network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor("topology", network));
}

// fetchNodeInfo returns device overview.
export async function fetchNodeInfo(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/info`, network));
}

// fetchNodeHealth returns health data.
export async function fetchNodeHealth(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/health`, network));
}

// fetchNodeInterfaces returns the interface list.
export async function fetchNodeInterfaces(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/interfaces`, network));
}

// fetchNodeInterface returns detail for one interface.
export async function fetchNodeInterface(device: string, ifaceName: string, network?: string): Promise<unknown> {
  // Encode "/" in interface names as %2F so the path segment is unambiguous.
  const encodedName = ifaceName.replace(/\//g, "%2F");
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/interfaces/${encodedName}`, network));
}

// fetchNodeInterfaceBinding returns the service binding for one interface.
export async function fetchNodeInterfaceBinding(device: string, ifaceName: string, network?: string): Promise<unknown> {
  const encodedName = ifaceName.replace(/\//g, "%2F");
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/interfaces/${encodedName}/binding`, network));
}

// fetchNodeVLANs returns VLAN status.
export async function fetchNodeVLANs(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/vlans`, network));
}

// fetchNodeVRFs returns VRF list.
export async function fetchNodeVRFs(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/vrfs`, network));
}

// fetchNodeACLs returns ACL list.
export async function fetchNodeACLs(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/acls`, network));
}

// fetchNodeLAGs returns LAG list.
export async function fetchNodeLAGs(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/lags`, network));
}

// fetchNodeNeighbors returns neighbors.
export async function fetchNodeNeighbors(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/neighbors`, network));
}

// fetchNodeBGPStatus returns BGP status.
export async function fetchNodeBGPStatus(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/bgp/status`, network));
}

// fetchNodeEVPNStatus returns EVPN status.
export async function fetchNodeEVPNStatus(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/evpn/status`, network));
}

// fetchNodeConfigDB returns the full CONFIG_DB snapshot.
export async function fetchNodeConfigDB(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/configdb`, network));
}

// fetchNodeConfigDBTable returns the key list for one CONFIG_DB table.
export async function fetchNodeConfigDBTable(device: string, table: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/configdb/${encodeURIComponent(table)}`, network));
}

// fetchNodeConfigDBEntry returns one CONFIG_DB entry.
export async function fetchNodeConfigDBEntry(
  device: string,
  table: string,
  key: string,
  network?: string,
): Promise<unknown> {
  return fetchNodeRaw(pathFor(
    `nodes/${encodeURIComponent(device)}/configdb/${encodeURIComponent(table)}/${encodeURIComponent(key)}`,
    network,
  ));
}

// fetchNodeDrift returns intent-vs-CONFIG_DB drift for a device.
export async function fetchNodeDrift(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/drift`, network));
}

// fetchNodeProjection returns the projected intent state.
export async function fetchNodeProjection(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/projection`, network));
}

// fetchNodeIntentTree returns the structured intent record graph.
export async function fetchNodeIntentTree(device: string, network?: string): Promise<unknown> {
  return fetchNodeRaw(pathFor(`nodes/${encodeURIComponent(device)}/intent-tree`, network));
}

// postNodeReconcile triggers reconcile: dry_run=true returns drift preview;
// dry_run=false executes corrective intent push.
export async function postNodeReconcile(
  device: string,
  opts: { dryRun: boolean; mode?: string } = { dryRun: true },
  network?: string,
): Promise<unknown> {
  const params = new URLSearchParams();
  if (opts.dryRun) params.set("dry_run", "true");
  if (opts.mode) params.set("mode", opts.mode);
  const qs = params.toString();
  const base = pathFor(`nodes/${encodeURIComponent(device)}/reconcile`, network);
  return apiSend(qs ? `${base}?${qs}` : base, "POST");
}

// ============================================================================
// Write helpers (topology editor + interface binding)
// ============================================================================

// nodeWrite is a thin wrapper for write methods. Delegates to apiSend.
function nodeWrite(
  url: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  return apiSend(url, method, body);
}

// ---- Topology editor --------------------------------------------------------

// postTopologyDevice adds a device to the topology.
// body: { name: string, device: { steps?: ..., ports?: ... } }
export async function postTopologyDevice(body: Record<string, unknown>, network?: string): Promise<unknown> {
  return nodeWrite(pathFor("topology/nodes", network), "POST", body);
}

// putTopologyDevice replaces a device entry (full replacement).
// body: TopologyDevice — { steps?: ..., ports?: ... }
export async function putTopologyDevice(name: string, body: Record<string, unknown>, network?: string): Promise<unknown> {
  return nodeWrite(pathFor(`topology/nodes/${encodeURIComponent(name)}`, network), "PUT", body);
}

// deleteTopologyDevice removes a device from the topology.
// force=true cascade-deletes referring links.
export async function deleteTopologyDevice(name: string, force = false, network?: string): Promise<unknown> {
  const base = pathFor(`topology/nodes/${encodeURIComponent(name)}`, network);
  const url = force ? `${base}?force=true` : base;
  return nodeWrite(url, "DELETE");
}

// postTopologyLink adds a link between two interfaces.
// body: { a: "device:interface", z: "device:interface" }
export async function postTopologyLink(body: { a: string; z: string }, network?: string): Promise<unknown> {
  return nodeWrite(pathFor("topology/links", network), "POST", body);
}

// deleteTopologyLink removes the link that includes the given endpoint.
export async function deleteTopologyLink(device: string, ifaceName: string, network?: string): Promise<unknown> {
  const encodedIface = ifaceName.replace(/\//g, "%2F");
  return nodeWrite(
    pathFor(`topology/links/${encodeURIComponent(device)}/${encodedIface}`, network),
    "DELETE",
  );
}

// ---- Interface service binding ----------------------------------------------

// postBindService binds a service to an interface.
// body: { service: string, ip_address?: string, vlan?: number, peer_as?: number, params?: object }
export async function postBindService(
  device: string,
  ifaceName: string,
  body: Record<string, unknown>,
  network?: string,
): Promise<unknown> {
  const encodedIface = ifaceName.replace(/\//g, "%2F");
  return nodeWrite(
    pathFor(`nodes/${encodeURIComponent(device)}/interfaces/${encodedIface}/bind-service`, network),
    "POST",
    body,
  );
}

// postUnbindService removes the service binding from an interface (no body).
export async function postUnbindService(device: string, ifaceName: string, network?: string): Promise<unknown> {
  const encodedIface = ifaceName.replace(/\//g, "%2F");
  return nodeWrite(
    pathFor(`nodes/${encodeURIComponent(device)}/interfaces/${encodedIface}/unbind-service`, network),
    "POST",
  );
}

// postRefreshService re-applies the bound service on an interface (no body).
export async function postRefreshService(device: string, ifaceName: string, network?: string): Promise<unknown> {
  const encodedIface = ifaceName.replace(/\//g, "%2F");
  return nodeWrite(
    pathFor(`nodes/${encodeURIComponent(device)}/interfaces/${encodedIface}/refresh-service`, network),
    "POST",
  );
}

// postNodeRPC POSTs to any node-level newtron action via the generic
// /api/networks/{netID}/nodes/{device}/rpc/{subpath} proxy. body may be
// null/empty for actions that take no params.
export async function postNodeRPC(
  device: string,
  subpath: string,
  body: Record<string, unknown> | null = null,
  network?: string,
): Promise<unknown> {
  const url = pathFor(`nodes/${encodeURIComponent(device)}/rpc/${subpath}`, network);
  return apiSend(url, "POST", body && Object.keys(body).length > 0 ? body : undefined);
}

// postInterfaceRPC POSTs to any per-interface newtron action.
export async function postInterfaceRPC(
  device: string,
  iface: string,
  subpath: string,
  body: Record<string, unknown> | null = null,
  network?: string,
): Promise<unknown> {
  const ifaceEnc = iface.replace(/\//g, "%2F");
  const url = pathFor(`nodes/${encodeURIComponent(device)}/interfaces/${encodeURIComponent(ifaceEnc)}/rpc/${subpath}`, network);
  return apiSend(url, "POST", body && Object.keys(body).length > 0 ? body : undefined);
}

// postProjectionDiff POSTs a list of {url, params} ops to newtron's
// per-device intent/projection-diff endpoint via the newtcon-server
// proxy. Powers the per-device projection in the apply-preview modal
// (slice #171.B). Operations apply in-memory only on newtron and the
// substrate state is restored before the response returns.
export async function postProjectionDiff(
  device: string,
  ops: Array<{ url: string; params: Record<string, unknown> }>,
  network?: string,
): Promise<unknown> {
  const url = pathFor(`nodes/${encodeURIComponent(device)}/projection-diff`, network);
  return apiSend(url, "POST", { operations: ops });
}
