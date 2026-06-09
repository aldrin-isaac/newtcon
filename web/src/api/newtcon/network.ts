// Typed client for newtcon-server's network-level spec list and write endpoints.
// List calls return the names defined for that spec type in the selected
// newtron network. Write calls forward JSON bodies to newtron's create/delete
// RPC verbs and sub-rule verbs.
//
// All routes are network-scoped — newtcon mirrors newtron's geometry
// /networks/{netID}/... at /api/networks/{netID}/... Every function below
// targets the operator's active network by default; pass `network` to target
// a specific network (cross-engine workflows).

import { ApiError } from "./services.js";
import { apiPath } from "../../api-path.js";

export interface SpecListResponse {
  names: string[];
}

export type SpecKind =
  | "services"
  | "ipvpns"
  | "macvpns"
  | "qos-policies"
  | "filters"
  | "prefix-lists"
  | "route-policies"
  | "profiles"
  | "zones"
  | "platforms";

function pathFor(suffix: string, network?: string): string {
  return network ? apiPath.network(network, suffix) : apiPath(suffix);
}

export async function fetchSpecDetail(kind: SpecKind, name: string, network?: string): Promise<unknown> {
  const url = pathFor(`${kind}/${encodeURIComponent(name)}`, network);
  const response = await fetch(url, { cache: "no-store" });
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    if (contentType.includes("application/json")) {
      const body = (await response.json()) as {
        error?: { kind: string; message: string; details?: Record<string, unknown> };
      };
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

// ============================================================================
// Write helpers
// ============================================================================

// apiPost sends POST to url with a JSON body and returns the parsed response.
// On non-2xx it throws ApiError (structured envelope) or plain Error.
async function apiPost(url: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
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

// apiDelete sends DELETE to url and returns the parsed response.
// On non-2xx it throws ApiError or plain Error.
async function apiDelete(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { method: "DELETE", cache: "no-store" });
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

// createSpec calls POST /api/networks/{netID}/{kind} with the given body.
export async function createSpec(kind: SpecKind, body: Record<string, unknown>, network?: string): Promise<unknown> {
  return apiPost(pathFor(kind, network), body);
}

// deleteSpec calls DELETE /api/networks/{netID}/{kind}/{name}.
export async function deleteSpec(kind: SpecKind, name: string, network?: string): Promise<unknown> {
  return apiDelete(pathFor(`${kind}/${encodeURIComponent(name)}`, network));
}

// addSubRule calls POST /api/networks/{netID}/{kind}/{name}/queues|rules|entries with the body.
// endpoint is the sub-collection segment: "queues", "rules", or "entries".
export async function addSubRule(kind: SpecKind, name: string, endpoint: string, body: Record<string, unknown>, network?: string): Promise<unknown> {
  return apiPost(pathFor(`${kind}/${encodeURIComponent(name)}/${endpoint}`, network), body);
}

// removeQoSQueue calls DELETE /api/networks/{netID}/qos-policies/{name}/queues/{queueId}.
export async function removeQoSQueue(name: string, queueId: number, network?: string): Promise<unknown> {
  return apiDelete(pathFor(`qos-policies/${encodeURIComponent(name)}/queues/${queueId}`, network));
}

// removeFilterRule calls DELETE /api/networks/{netID}/filters/{name}/rules/{seq}.
export async function removeFilterRule(name: string, seq: number, network?: string): Promise<unknown> {
  return apiDelete(pathFor(`filters/${encodeURIComponent(name)}/rules/${seq}`, network));
}

// removePrefixListEntry calls DELETE /api/networks/{netID}/prefix-lists/{name}/entries/{prefix}.
export async function removePrefixListEntry(name: string, prefix: string, network?: string): Promise<unknown> {
  return apiDelete(pathFor(`prefix-lists/${encodeURIComponent(name)}/entries/${encodeURIComponent(prefix)}`, network));
}

// removeRoutePolicyRule calls DELETE /api/networks/{netID}/route-policies/{name}/rules/{seq}.
export async function removeRoutePolicyRule(name: string, seq: number, network?: string): Promise<unknown> {
  return apiDelete(pathFor(`route-policies/${encodeURIComponent(name)}/rules/${seq}`, network));
}

// ============================================================================
// List endpoints
// ============================================================================

export async function fetchSpecList(kind: SpecKind, network?: string): Promise<string[]> {
  const url = pathFor(kind, network);
  const response = await fetch(url, { cache: "no-store" });
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    if (contentType.includes("application/json")) {
      const body = (await response.json()) as {
        error?: { kind: string; message: string; details?: Record<string, unknown> };
      };
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

  const body = (await response.json()) as { names?: string[] | null; services?: { name: string }[] };

  // /api/networks/{netID}/services returns {services: [{name, type, ...}]};
  // everything else returns {names: [string]}.
  if (kind === "services" && Array.isArray(body.services)) {
    return body.services.map((s) => s.name);
  }
  return Array.isArray(body.names) ? body.names : [];
}
