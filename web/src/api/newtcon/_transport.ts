// _transport.ts — shared transport helper for every /api/* call from the
// browser frontend.
//
// Before this file, lab.ts / nodes.ts / network.ts / services.ts each had
// their own near-identical "fetch + parse error envelope" implementation,
// plus the topology-action-panel.ts panel had its own jsonFetch. Per
// ai-instructions §7 (second instance = stop and question) + DESIGN_PRINCIPLES
// §39 (one mechanism per capability), they collapse to one helper.
//
// apiFetch performs the request and:
//   - returns the parsed JSON body on 2xx
//   - throws ApiError when newtcon-server returns a non-2xx with a structured
//     error envelope (kind / message / details)
//   - throws plain Error on network failure or non-JSON error body
//
// apiSend is a convenience for write methods (POST/PUT/DELETE) — encodes the
// body as JSON, sets Content-Type, calls apiFetch.

import { ApiError } from "./services.js";

export async function apiFetch(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new Error(`network error: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  if (response.ok) {
    // Some endpoints (DELETE, SSE-handoff) return empty bodies. Try to parse;
    // any failure (empty body, non-JSON, missing content-type) yields null so
    // callers see something falsy without crashing on response.json().
    try {
      if (response.status === 204) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  // Try to decode an error envelope; if anything fails fall through to the
  // generic HTTP error. Same tolerance as the OK path.
  type ErrEnv = { error?: { kind: string; message: string; details?: Record<string, unknown> } };
  let body: ErrEnv | null = null;
  try { body = (await response.json()) as ErrEnv; } catch { /* not JSON */ }
  if (body?.error) {
    throw new ApiError(response.status, {
      error: {
        kind: body.error.kind,
        message: body.error.message,
        details: body.error.details ?? {},
      },
    });
  }
  throw new Error(`HTTP ${response.status} ${response.statusText}`);
}

export async function apiSend(
  url: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  const init: RequestInit = { method, cache: "no-store" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return apiFetch(url, init);
}
