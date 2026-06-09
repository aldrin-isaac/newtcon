// Typed client for newtcon-server's topology and node-inspector endpoints.
//
// All calls pass through newtcon-server which proxies to newtron verbatim.
// The data field is returned as-is (unknown) so callers can render with the
// recursive renderValue helper in app.ts without coupling to a concrete type.
//
// Every function targets the operator's active network by default; pass
// `network` to target a specific network (cross-engine workflows).

import { ApiError } from "./services.js";
import { apiPath } from "../../api-path.js";

function pathFor(suffix: string, network?: string): string {
  return network ? apiPath.network(network, suffix) : apiPath(suffix);
}

// fetchNodeRaw is the shared helper for all node-level GET endpoints.
// Returns the raw JSON value of the newtron response (any JSON value — object,
// array, or primitive).
//
// On non-2xx responses it throws ApiError with kind and message from the
// newtcon error envelope, or a plain Error for non-JSON bodies.
async function fetchNodeRaw(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch (cause) {
    throw new Error(`network error: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    if (contentType.includes("application/json")) {
      let body: { error?: { kind: string; message: string; details?: Record<string, unknown> } };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      if (body.error) {
        throw new ApiError(response.status, {
          error: {
            kind: body.error.kind,
            message: body.error.message,
            details: body.error.details ?? {},
          },
        });
      }
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.json();
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
  const url = qs ? `${base}?${qs}` : base;
  const response = await fetch(url, { method: "POST", cache: "no-store" });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    if (contentType.includes("application/json")) {
      const body = await response.json() as { error?: { kind: string; message: string; details?: Record<string, unknown> } };
      if (body.error) {
        throw new ApiError(response.status, {
          error: { kind: body.error.kind, message: body.error.message, details: body.error.details ?? {} },
        });
      }
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// ============================================================================
// Write helpers (topology editor + interface binding)
// ============================================================================

// nodeWrite is the shared POST/PUT/DELETE helper for write operations.
// Returns parsed response on 2xx; throws ApiError on structured error envelopes.
async function nodeWrite(
  url: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  const init: RequestInit = { method, cache: "no-store" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new Error(`network error: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      let envelope: { error?: { kind: string; message: string; details?: Record<string, unknown> } };
      try { envelope = (await response.json()) as typeof envelope; } catch { throw new Error(`HTTP ${response.status}`); }
      if (envelope.error) {
        throw new ApiError(response.status, {
          error: { kind: envelope.error.kind, message: envelope.error.message, details: envelope.error.details ?? {} },
        });
      }
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
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
  const init: RequestInit = { method: "POST", cache: "no-store" };
  if (body && Object.keys(body).length > 0) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    if (contentType.includes("application/json")) {
      const errBody = (await response.json()) as { error?: { kind: string; message: string; details?: Record<string, unknown> } };
      if (errBody.error) {
        throw new ApiError(response.status, {
          error: { kind: errBody.error.kind, message: errBody.error.message, details: errBody.error.details ?? {} },
        });
      }
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
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
  const init: RequestInit = { method: "POST", cache: "no-store" };
  if (body && Object.keys(body).length > 0) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    if (contentType.includes("application/json")) {
      const errBody = (await response.json()) as { error?: { kind: string; message: string; details?: Record<string, unknown> } };
      if (errBody.error) {
        throw new ApiError(response.status, {
          error: { kind: errBody.error.kind, message: errBody.error.message, details: errBody.error.details ?? {} },
        });
      }
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}
