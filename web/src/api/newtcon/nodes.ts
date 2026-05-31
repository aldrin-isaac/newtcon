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
