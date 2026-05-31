// Typed client for newtcon-server's network-level spec list endpoints.
// Each call returns the list of names defined for that spec type in the
// configured newtron network.

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
