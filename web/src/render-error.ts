// render-error.ts — single source of truth for translating wire error kinds
// and formatting brief error strings for the frontend.
//
// Before this module, staging.ts / topology-action-panel.ts /
// topology-actions-ui.ts each defined their own `formatError()` (three near-
// identical copies: `${err.kind}: ${err.message}`). services/services.ts had
// its own `translateErrorKind()`. Per ai-instructions §7 (second instance =
// stop and question) + DESIGN_PRINCIPLES §39 (one mechanism per capability),
// they collapse here.
//
// Slice 2.1 also lands the L5 authorization_failure rendering: when the typed
// envelope from newtcon#143 carries {caller, permission, resource}, the brief
// form becomes "permission denied: alice lacks spec.author on svc-b" rather
// than the generic "authorization_failure: <endpoint>: authorization denied: …"
// the server emits. The server message stays accurate; the operator just sees
// the structured form first.

import { ApiError } from "./api/newtcon/services.js";

/**
 * translateErrorKind converts a wire-shape error kind into operator-readable
 * text. The wire kind never appears in the UI; this function is the
 * translation boundary.
 */
export function translateErrorKind(kind: string): string {
  switch (kind) {
    case "validation_failure":     return "validation failed";
    case "precondition_failure":   return "precondition not met";
    case "drift_refusal":          return "drift detected — refused to apply";
    case "authorization_failure":  return "permission denied";
    case "authentication_failure": return "not signed in";
    case "newtron_unavailable":    return "newtron is unreachable";
    case "internal":               return "internal error";
    default:                       return kind.replace(/_/g, " ");
  }
}

/**
 * formatAuthorizationDetails returns "caller lacks permission on resource"
 * when the details object carries the typed fields the server emits for
 * KindAuthorizationFailure (per internal/handlers/errors.go + newtcon#143
 * substrate). Returns null when caller or permission is missing — the
 * caller falls back to the bare server message.
 *
 * Resource is optional: global permissions don't carry one, so the format
 * shortens to "caller lacks permission".
 */
export function formatAuthorizationDetails(details: Record<string, unknown>): string | null {
  const caller = typeof details.caller === "string" ? details.caller : null;
  const permission = typeof details.permission === "string" ? details.permission : null;
  const resource = typeof details.resource === "string" ? details.resource : null;
  if (!caller || !permission) return null;
  return resource
    ? `${caller} lacks ${permission} on ${resource}`
    : `${caller} lacks ${permission}`;
}

/**
 * formatConflictDetails renders newtron's referential-integrity 409 (#319) from
 * its structured fields — the referencing endpoints + whether a force delete can
 * cascade — into operator language, instead of leaking the engine's raw
 * "… pass force=true to cascade" message. Returns null when there are no
 * structured references (a plain device-drift conflict falls back).
 */
export function formatConflictDetails(details: Record<string, unknown>): string | null {
  const refs = Array.isArray(details?.references)
    ? details.references.filter((r): r is string => typeof r === "string")
    : [];
  if (refs.length === 0) return null;
  const shown = refs.slice(0, 6).join(", ");
  const more = refs.length > 6 ? `, +${refs.length - 6} more` : "";
  const forceable = details?.force_available === true ? " — force delete to also remove them" : "";
  return `still in use on ${shown}${more}${forceable}`;
}

/**
 * formatErrorBrief returns a short single-line operator-readable string for
 * any error — suitable for toasts, inline panel notices, the staging-apply
 * results dialog. The long-form panel rendering (with details disclosure)
 * lives in services/services.ts renderOtherApiError.
 *
 * Special cases:
 *
 *   ApiError kind = authorization_failure with typed details
 *     → "permission denied: alice lacks spec.author on svc-b"
 *   ApiError other kinds
 *     → "<translated kind>: <message>"
 *   Plain Error
 *     → err.message
 *   anything else
 *     → String(err)
 */
export function formatErrorBrief(err: unknown): string {
  if (err instanceof ApiError) {
    const kindLabel = translateErrorKind(err.kind);
    if (err.kind === "authorization_failure") {
      const structured = formatAuthorizationDetails(err.details);
      if (structured) return `${kindLabel}: ${structured}`;
    }
    if (err.kind === "drift_refusal") {
      // Referential-integrity 409 (#319): a complete operator phrase from the
      // structured references, not the "drift detected" label nor engine jargon.
      const conflict = formatConflictDetails(err.details);
      if (conflict) return conflict;
    }
    // Prefer newtron's specific reason (in details.underlying_error_message)
    // over the generic envelope message ("<verb> <path>: <kind phrase>").
    // This is what surfaces referential-integrity detail — the referrers on
    // a 409 delete ("X has 2 references: …") and the missing ref on a 400
    // create ("unresolved references: …") — instead of a bare "conflict" /
    // "validation failed".
    const underlying = extractUnderlyingMessage(err.details);
    return `${kindLabel}: ${underlying ?? err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * extractUnderlyingMessage pulls the operator-meaningful reason out of an
 * error envelope's `details.underlying_error_message`. newtron records its
 * raw response body there, usually wrapped as `{"error":"…"}` — this
 * unwraps to the inner string. Returns null when absent/empty so callers
 * fall back to the envelope message.
 */
export function extractUnderlyingMessage(details: Record<string, unknown>): string | null {
  const raw = details?.["underlying_error_message"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (parsed && typeof parsed.error === "string" && parsed.error.trim() !== "") {
      return parsed.error.trim();
    }
  } catch { /* not JSON — surface the raw string */ }
  return trimmed;
}


/**
 * engineOpErrorBody — one-line operator-facing reason for a failed engine
 * operation (deploy/provision/apply): the upstream's underlying message when
 * the error is a typed ApiError, else the plain message. (Moved from app.ts
 * in console-uplift 1.2 — it is error-shaping, so it lives here.)
 */
export function engineOpErrorBody(err: unknown): string {
  const reason = err instanceof ApiError ? extractUnderlyingMessage(err.details) : null;
  return reason ?? (err instanceof Error ? err.message : String(err));
}
