// Typed client for newtcon-server's network-level spec list and write endpoints.
// List calls return the names defined for that spec type in the configured
// newtron network. Write calls forward JSON bodies to newtron's create/delete
// RPC verbs and sub-rule verbs.

import { ApiError } from "./services.js";

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

export async function fetchSpecDetail(kind: SpecKind, name: string): Promise<unknown> {
  const url = `/api/${kind}/${encodeURIComponent(name)}`;
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

// createSpec calls POST /api/{kind} with the given body.
export async function createSpec(kind: SpecKind, body: Record<string, unknown>): Promise<unknown> {
  return apiPost(`/api/${kind}`, body);
}

// deleteSpec calls DELETE /api/{kind}/{name}.
export async function deleteSpec(kind: SpecKind, name: string): Promise<unknown> {
  return apiDelete(`/api/${kind}/${encodeURIComponent(name)}`);
}

// addSubRule calls POST /api/{kind}/{name}/queues|rules|entries with the body.
// endpoint is the sub-collection segment: "queues", "rules", or "entries".
export async function addSubRule(kind: SpecKind, name: string, endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  return apiPost(`/api/${kind}/${encodeURIComponent(name)}/${endpoint}`, body);
}

// removeQoSQueue calls DELETE /api/qos-policies/{name}/queues/{queueId}.
export async function removeQoSQueue(name: string, queueId: number): Promise<unknown> {
  return apiDelete(`/api/qos-policies/${encodeURIComponent(name)}/queues/${queueId}`);
}

// removeFilterRule calls DELETE /api/filters/{name}/rules/{seq}.
export async function removeFilterRule(name: string, seq: number): Promise<unknown> {
  return apiDelete(`/api/filters/${encodeURIComponent(name)}/rules/${seq}`);
}

// removePrefixListEntry calls DELETE /api/prefix-lists/{name}/entries/{prefix}.
export async function removePrefixListEntry(name: string, prefix: string): Promise<unknown> {
  return apiDelete(`/api/prefix-lists/${encodeURIComponent(name)}/entries/${encodeURIComponent(prefix)}`);
}

// removeRoutePolicyRule calls DELETE /api/route-policies/{name}/rules/{seq}.
export async function removeRoutePolicyRule(name: string, seq: number): Promise<unknown> {
  return apiDelete(`/api/route-policies/${encodeURIComponent(name)}/rules/${seq}`);
}

// ============================================================================
// List endpoints
// ============================================================================

export async function fetchSpecList(kind: SpecKind): Promise<string[]> {
  const url = kind === "services" ? "/api/services" : `/api/${kind}`;
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

  // /api/services returns {services: [{name, type, ...}]}; everything else
  // returns {names: [string]}.
  if (kind === "services" && Array.isArray(body.services)) {
    return body.services.map((s) => s.name);
  }
  return Array.isArray(body.names) ? body.names : [];
}
