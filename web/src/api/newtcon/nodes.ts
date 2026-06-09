// Typed client for newtcon-server's topology and node-inspector endpoints.
//
// All calls pass through newtcon-server which proxies to newtron verbatim.
// The data field is returned as-is (unknown) so callers can render with the
// recursive renderValue helper in app.ts without coupling to a concrete type.

import { ApiError } from "./services.js";

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

// fetchTopology returns the full topology payload from GET /api/topology.
export async function fetchTopology(): Promise<unknown> {
  return fetchNodeRaw("/api/topology");
}

// fetchNodeInfo returns device overview from GET /api/nodes/{device}/info.
export async function fetchNodeInfo(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/info`);
}

// fetchNodeHealth returns health data from GET /api/nodes/{device}/health.
export async function fetchNodeHealth(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/health`);
}

// fetchNodeInterfaces returns the interface list from GET /api/nodes/{device}/interfaces.
export async function fetchNodeInterfaces(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/interfaces`);
}

// fetchNodeInterface returns detail for one interface from
// GET /api/nodes/{device}/interfaces/{name}.
export async function fetchNodeInterface(device: string, ifaceName: string): Promise<unknown> {
  // Encode "/" in interface names as %2F so the path segment is unambiguous.
  const encodedName = ifaceName.replace(/\//g, "%2F");
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/interfaces/${encodedName}`);
}

// fetchNodeInterfaceBinding returns the service binding for one interface from
// GET /api/nodes/{device}/interfaces/{name}/binding.
export async function fetchNodeInterfaceBinding(device: string, ifaceName: string): Promise<unknown> {
  const encodedName = ifaceName.replace(/\//g, "%2F");
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/interfaces/${encodedName}/binding`);
}

// fetchNodeVLANs returns VLAN status from GET /api/nodes/{device}/vlans.
export async function fetchNodeVLANs(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/vlans`);
}

// fetchNodeVRFs returns VRF list from GET /api/nodes/{device}/vrfs.
export async function fetchNodeVRFs(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/vrfs`);
}

// fetchNodeACLs returns ACL list from GET /api/nodes/{device}/acls.
export async function fetchNodeACLs(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/acls`);
}

// fetchNodeLAGs returns LAG list from GET /api/nodes/{device}/lags.
export async function fetchNodeLAGs(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/lags`);
}

// fetchNodeNeighbors returns neighbors from GET /api/nodes/{device}/neighbors.
export async function fetchNodeNeighbors(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/neighbors`);
}

// fetchNodeBGPStatus returns BGP status from GET /api/nodes/{device}/bgp/status.
export async function fetchNodeBGPStatus(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/bgp/status`);
}

// fetchNodeEVPNStatus returns EVPN status from GET /api/nodes/{device}/evpn/status.
export async function fetchNodeEVPNStatus(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/evpn/status`);
}

// fetchNodeConfigDB returns the full CONFIG_DB snapshot from
// GET /api/nodes/{device}/configdb.
export async function fetchNodeConfigDB(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/configdb`);
}

// fetchNodeConfigDBTable returns the key list for one CONFIG_DB table from
// GET /api/nodes/{device}/configdb/{table}.
export async function fetchNodeConfigDBTable(device: string, table: string): Promise<unknown> {
  return fetchNodeRaw(
    `/api/nodes/${encodeURIComponent(device)}/configdb/${encodeURIComponent(table)}`
  );
}

// fetchNodeConfigDBEntry returns one CONFIG_DB entry from
// GET /api/nodes/{device}/configdb/{table}/{key}.
export async function fetchNodeConfigDBEntry(
  device: string,
  table: string,
  key: string
): Promise<unknown> {
  return fetchNodeRaw(
    `/api/nodes/${encodeURIComponent(device)}/configdb/${encodeURIComponent(table)}/${encodeURIComponent(key)}`
  );
}

// GET /api/nodes/{device}/drift.
export async function fetchNodeDrift(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/drift`);
}

// GET /api/nodes/{device}/projection.
export async function fetchNodeProjection(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/projection`);
}

// GET /api/nodes/{device}/intent-tree.
export async function fetchNodeIntentTree(device: string): Promise<unknown> {
  return fetchNodeRaw(`/api/nodes/${encodeURIComponent(device)}/intent-tree`);
}

// POST /api/nodes/{device}/reconcile?dry_run=...&mode=...
export async function postNodeReconcile(
  device: string,
  opts: { dryRun: boolean; mode?: string } = { dryRun: true }
): Promise<unknown> {
  const params = new URLSearchParams();
  if (opts.dryRun) params.set("dry_run", "true");
  if (opts.mode) params.set("mode", opts.mode);
  const qs = params.toString();
  const url = `/api/nodes/${encodeURIComponent(device)}/reconcile${qs ? "?" + qs : ""}`;
  const response = await fetch(url, { method: "POST", cache: "no-store" });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    if (contentType.includes("application/json")) {
      const body = await response.json() as { error?: { kind: string; message: string; details?: Record<string, unknown> } };
      if (body.error) {
        const { ApiError } = await import("./services.js");
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
  body?: unknown
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
// Forwards to POST /api/topology/nodes.
export async function postTopologyDevice(body: Record<string, unknown>): Promise<unknown> {
  return nodeWrite("/api/topology/nodes", "POST", body);
}

// putTopologyDevice replaces a device entry (full replacement).
// body: TopologyDevice — { steps?: ..., ports?: ... }
// Forwards to PUT /api/topology/nodes/{name}.
export async function putTopologyDevice(name: string, body: Record<string, unknown>): Promise<unknown> {
  return nodeWrite(`/api/topology/nodes/${encodeURIComponent(name)}`, "PUT", body);
}

// deleteTopologyDevice removes a device from the topology.
// force=true cascade-deletes referring links.
// Forwards to DELETE /api/topology/nodes/{name}.
export async function deleteTopologyDevice(name: string, force = false): Promise<unknown> {
  const qs = force ? "?force=true" : "";
  return nodeWrite(`/api/topology/nodes/${encodeURIComponent(name)}${qs}`, "DELETE");
}

// postTopologyLink adds a link between two interfaces.
// body: { a: "device:interface", z: "device:interface" }
// Forwards to POST /api/topology/links.
export async function postTopologyLink(body: { a: string; z: string }): Promise<unknown> {
  return nodeWrite("/api/topology/links", "POST", body);
}

// deleteTopologyLink removes the link that includes the given endpoint.
// Forwards to DELETE /api/topology/links/{device}/{interface}.
export async function deleteTopologyLink(device: string, ifaceName: string): Promise<unknown> {
  const encodedIface = ifaceName.replace(/\//g, "%2F");
  return nodeWrite(
    `/api/topology/links/${encodeURIComponent(device)}/${encodedIface}`,
    "DELETE"
  );
}

// ---- Interface service binding ----------------------------------------------

// postBindService binds a service to an interface.
// body: { service: string, ip_address?: string, vlan?: number, peer_as?: number, params?: object }
// service is required; all others optional.
// Forwards to POST /api/nodes/{device}/interfaces/{name}/bind-service.
export async function postBindService(
  device: string,
  ifaceName: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const encodedIface = ifaceName.replace(/\//g, "%2F");
  return nodeWrite(
    `/api/nodes/${encodeURIComponent(device)}/interfaces/${encodedIface}/bind-service`,
    "POST",
    body
  );
}

// postUnbindService removes the service binding from an interface (no body).
// Forwards to POST /api/nodes/{device}/interfaces/{name}/unbind-service.
export async function postUnbindService(device: string, ifaceName: string): Promise<unknown> {
  const encodedIface = ifaceName.replace(/\//g, "%2F");
  return nodeWrite(
    `/api/nodes/${encodeURIComponent(device)}/interfaces/${encodedIface}/unbind-service`,
    "POST"
  );
}

// postRefreshService re-applies the bound service on an interface (no body).
// Forwards to POST /api/nodes/{device}/interfaces/{name}/refresh-service.
export async function postRefreshService(device: string, ifaceName: string): Promise<unknown> {
  const encodedIface = ifaceName.replace(/\//g, "%2F");
  return nodeWrite(
    `/api/nodes/${encodeURIComponent(device)}/interfaces/${encodedIface}/refresh-service`,
    "POST"
  );
}

// postNodeRPC POSTs to any node-level newtron action via the generic
// /api/nodes/{device}/rpc/{subpath} proxy. body may be null/empty for
// actions that take no params.
export async function postNodeRPC(
  device: string,
  subpath: string,
  body: Record<string, unknown> | null = null,
): Promise<unknown> {
  const url = `/api/nodes/${encodeURIComponent(device)}/rpc/${subpath}`;
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
        const { ApiError } = await import("./services.js");
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
): Promise<unknown> {
  const ifaceEnc = iface.replace(/\//g, "%2F");
  const url = `/api/nodes/${encodeURIComponent(device)}/interfaces/${encodeURIComponent(ifaceEnc)}/rpc/${subpath}`;
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
        const { ApiError } = await import("./services.js");
        throw new ApiError(response.status, {
          error: { kind: errBody.error.kind, message: errBody.error.message, details: errBody.error.details ?? {} },
        });
      }
    }
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}
