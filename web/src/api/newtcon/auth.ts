// web/src/api/newtcon/auth.ts — typed client for /api/auth/*.
//
// Three endpoints (mirror internal/handlers/auth.go):
//   POST /api/auth/login   {username, password} → {user, expires_at}
//   POST /api/auth/logout  → 204
//   GET  /api/auth/whoami  → {user, expires_at} | 401
//
// The newtron L2c bearer key is never visible from the browser — only the
// opaque session cookie newtcon-server sets is. login() returns just the
// fields the UI needs (display name + expiry).

import { apiFetch, apiSend } from "./_transport.js";
import { ApiError } from "./services.js";

/** WhoamiResponse mirrors internal/handlers/auth.go authResponse. */
export interface WhoamiResponse {
  user: string;
  expires_at: string;
}

/**
 * whoami fetches the current session, returning null when the operator is
 * not signed in (server returned 401 with `authentication_failure`).
 *
 * Any other error (network failure, unexpected status, missing fields)
 * propagates so callers can surface it honestly.
 */
export async function whoami(): Promise<WhoamiResponse | null> {
  // X-Suppress-Auth-Event: whoami's whole purpose is to detect 401 — letting
  // it dispatch the global auth:401 would race with the boot gate.
  try {
    return (await apiFetch("/api/auth/whoami", {
      cache: "no-store",
      headers: { "X-Suppress-Auth-Event": "1" },
    })) as WhoamiResponse;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/**
 * login submits credentials. On success the server sets the session cookie
 * automatically; the returned payload carries the display name + absolute
 * expiry the UI shows.
 *
 * Throws ApiError on credential failure (401), upstream gap (404), or
 * validation failure (400). The caller decides how to render those.
 */
export async function login(username: string, password: string): Promise<WhoamiResponse> {
  // X-Suppress-Auth-Event: a 401 from /api/auth/login itself ("bad password")
  // must surface as an inline form error, not as a global session-expired event.
  return (await apiFetch("/api/auth/login", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Suppress-Auth-Event": "1",
    },
    body: JSON.stringify({ username, password }),
  })) as WhoamiResponse;
}

/**
 * logout invalidates the session — both the newtcon-server-side store entry
 * and the upstream newtron L2c key. Idempotent: returns 204 even if no
 * session was active.
 */
export async function logout(): Promise<void> {
  await apiSend("/api/auth/logout", "POST");
}

// apiSend is exported from _transport but only logout() uses it from here;
// login() / whoami() drive apiFetch directly because they need to attach the
// X-Suppress-Auth-Event header.
