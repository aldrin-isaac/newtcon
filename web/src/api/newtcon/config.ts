// web/src/api/newtcon/config.ts — typed client for GET /api/config.
//
// Returns the deployment-posture descriptor newtcon-server's startup
// configuration produces. Currently one field — auth_required — which the
// frontend reads at boot to decide whether to mount the login-overlay arc
// (auth-gate.ts) or skip straight into the workspace in anonymous mode.
//
// Shape mirrors internal/handlers/config.go ConfigResponse.

import { apiFetch } from "./_transport.js";

/** ConfigResponse mirrors internal/handlers/config.go ConfigResponse. */
export interface ConfigResponse {
  auth_required: boolean;
}

/**
 * fetchConfig reads /api/config. Throws on transport / non-2xx failures so
 * callers can decide how to surface them — the auth-gate treats a failure
 * here as "newtcon-server unreachable" and shows the user the error rather
 * than silently picking a posture.
 */
export async function fetchConfig(): Promise<ConfigResponse> {
  return (await apiFetch("/api/config", { cache: "no-store" })) as ConfigResponse;
}
