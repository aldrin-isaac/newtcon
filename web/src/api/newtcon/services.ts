// web/src/api/newtcon/services.ts — typed client for GET /api/services.
//
// This module mirrors internal/types/services.go's ServiceListResponse and
// ServiceHealth structs, following the wire-shape discipline from
// docs/adr/0002-frontend-framework.md §Why this decision: "typed clients under
// web/src/api/newtcon/ are straightforward TypeScript modules whose exported
// types mirror newtcon-server's internal/types/." No codegen; types are hand-
// maintained per ADR-0002.
//
// Error handling: network failures and non-200 responses both surface as
// ApiError so callers can distinguish the structured error envelope (kind +
// message from the server) from a raw network failure (message only).
//
// Import paths use .js extensions per the Node16 moduleResolution rule
// documented in web/README.md.

import { apiPath } from "../../api-path.js";
import { apiFetch } from "./_transport.js";

/** ServiceHealth mirrors internal/types/services.go ServiceHealth. */
export interface ServiceHealth {
  healthy: number;
  degraded: number;
  failed: number;
}

/**
 * Service mirrors internal/types/services.go Service.
 *
 * instance_count, health, and last_modified are structurally present per the
 * contract but are zero-valued in v1 — newtron substrate does not yet expose
 * per-service aggregates. Per CLAUDE.md §No Hidden State these fields are
 * present (contract honored) and zero (honest, not fabricated). Do NOT render
 * instance_count, health, or last_modified in operator-facing UI until the
 * substrate populates them — rendering zero-valued aggregates violates
 * operator-philosophy invariant #9 (false confidence is worse than no
 * confidence). See ADR-0001 §Consequences.
 */
export interface Service {
  name: string;
  type: string;
  instance_count: number;
  health: ServiceHealth;
  last_modified: string;
}

/** ServiceListResponse mirrors internal/types/services.go ServiceListResponse. */
export interface ServiceListResponse {
  services: Service[];
}

/**
 * ErrorEnvelope mirrors the error shape from API_CONTRACT.md §Error Schema.
 * Surfaced verbatim to the caller; newtcon does not translate error messages
 * per operator-philosophy invariant #9 (confidence and limits are explicit).
 */
export interface ErrorEnvelope {
  error: {
    kind: string;
    message: string;
    details: Record<string, unknown>;
  };
}

/**
 * ApiError is thrown by fetchServices when newtcon-server returns a non-2xx
 * response. The structured envelope is preserved verbatim — callers surface
 * kind and message to the operator without translation.
 */
export class ApiError extends Error {
  readonly kind: string;
  readonly details: Record<string, unknown>;
  readonly status: number;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.error.message);
    this.name = "ApiError";
    this.kind = envelope.error.kind;
    this.details = envelope.error.details;
    this.status = status;
  }
}

/**
 * fetchServices calls GET /api/networks/{netID}/services and returns the
 * decoded response. By default targets the operator's active network; pass
 * `network` to target a specific network (cross-engine workflows).
 *
 * Throws ApiError when newtcon-server returns a non-2xx status with a
 * structured error envelope. Throws a plain Error for network failures
 * (fetch rejected, non-JSON body on error response).
 */
export async function fetchServices(network?: string): Promise<ServiceListResponse> {
  const url = network ? apiPath.network(network, "services") : apiPath("services");
  // cache: "no-store" — no client-side caching per newtcon#105 criterion.
  // The services list reflects live newtron state; a stale cached copy
  // would silently hide additions or removals (invariant #9).
  return (await apiFetch(url, { cache: "no-store" })) as ServiceListResponse;
}
