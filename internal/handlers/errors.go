// errors.go — single error-envelope helper for upstream (newtron / newtlab)
// HTTP failures. Per DESIGN_PRINCIPLES_NEWTRON §7 and ai-instructions §7
// (second instance of a pattern = stop and question), the per-file write*Error
// helpers that lived in lab.go / nodes.go / network.go / services.go were
// substantially identical switches on `*newtronc.{NotFoundError,ConflictError,
// ValidationError,UnavailableError}` — collapsed here into one.
//
// Two helpers:
//
//   writeUpstreamError(w, corrID, err, endpoint, extras)
//       Generic mapping for newtron-engine failures (most handlers). 503 for
//       UnavailableError. Use this for newtron/* routes.
//
//   writeLabEngineError(w, corrID, err, endpoint, extras)
//       Identical mapping except UnavailableError emits 502 BadGateway (the
//       lab engine is one substrate behind newtron-server). Use this for
//       newtlab/* routes.
//
// Status / kind mapping (both helpers):
//
//   *newtronc.NotFoundError       → 404 KindPreconditionFailure (the named
//                                     network / device / spec doesn't exist —
//                                     precondition for the operation)
//   *newtronc.ConflictError       → 409 KindDriftRefusal
//   *newtronc.ValidationError     → 400 KindValidationFailure
//   *newtronc.UnauthenticatedError→ 401 KindAuthenticationFailure (session
//                                     expired / missing — middleware will
//                                     clear the cookie as the 401 unwinds)
//   *newtronc.AuthorizationError  → 403 KindAuthorizationFailure (caller /
//                                     permission / resource surfaced in
//                                     details so the UI can render
//                                     "X lacks Y on Z"; newtcon#143)
//   *newtronc.UnavailableError   → 503 (or 502 for lab) KindNewtronUnavailable
//                                    with a default next_action_hint
//   default                      → 500 KindInternal
//
// extras is merged into the details map; pass nil if no per-call-site fields.
// Standard fields the helper always sets (correlation_id, underlying_error,
// underlying_error_message, next_action_hint for UnavailableError) can be
// overridden by extras when a call site needs to.
package handlers

import (
	"fmt"
	"maps"
	"net/http"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

func writeUpstreamError(w http.ResponseWriter, corrID string, err error, endpoint string, extras map[string]any) {
	writeUpstreamErrorWithStatus(w, corrID, err, endpoint, extras, http.StatusServiceUnavailable)
}

func writeLabEngineError(w http.ResponseWriter, corrID string, err error, endpoint string, extras map[string]any) {
	writeUpstreamErrorWithStatus(w, corrID, err, endpoint, extras, http.StatusBadGateway)
}

func writeUpstreamErrorWithStatus(w http.ResponseWriter, corrID string, err error, endpoint string, extras map[string]any, unavailableStatus int) {
	details := map[string]any{"correlation_id": corrID}
	maps.Copy(details, extras)

	switch e := err.(type) {
	case *newtronc.ValidationError:
		setIfAbsent(details, "underlying_error_message", string(e.Body))
		types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
			fmt.Sprintf("%s: validation failed", endpoint), details)
	case *newtronc.UnauthenticatedError:
		// newtron rejected the request with 401 — the operator's session is
		// expired, missing, or wrong. The session middleware will see the 401
		// status going out and evict + clear the cookie automatically.
		setIfAbsent(details, "underlying_error_message", string(e.Body))
		types.WriteError(w, http.StatusUnauthorized, types.KindAuthenticationFailure,
			fmt.Sprintf("%s: authentication required", endpoint), details)
	case *newtronc.NotFoundError:
		setIfAbsent(details, "underlying_error_message", string(e.Body))
		types.WriteError(w, http.StatusNotFound, types.KindPreconditionFailure,
			fmt.Sprintf("%s: not found", endpoint), details)
	case *newtronc.ConflictError:
		setIfAbsent(details, "underlying_error_message", string(e.Body))
		types.WriteError(w, http.StatusConflict, types.KindDriftRefusal,
			fmt.Sprintf("%s: conflict", endpoint), details)
	case *newtronc.AuthorizationError:
		// Surface caller / permission / resource so the operator sees
		// "alice lacks spec.author on svc-b" not "unexpected status 403".
		// newtcon#143.
		setIfAbsent(details, "caller", e.Caller)
		setIfAbsent(details, "permission", e.Permission)
		if e.Resource != "" {
			setIfAbsent(details, "resource", e.Resource)
		}
		setIfAbsent(details, "underlying_error_message", e.Error())
		types.WriteError(w, http.StatusForbidden, types.KindAuthorizationFailure,
			fmt.Sprintf("%s: %s", endpoint, e.Error()), details)
	case *newtronc.UnavailableError:
		setIfAbsent(details, "underlying_error", upstreamErrorKind(e))
		setIfAbsent(details, "underlying_error_message", e.Cause)
		setIfAbsent(details, "next_action_hint", defaultNextActionHint())
		types.WriteError(w, unavailableStatus, types.KindNewtronUnavailable,
			fmt.Sprintf("%s: upstream unreachable", endpoint), details)
	default:
		setIfAbsent(details, "underlying_error_message", err.Error())
		types.WriteError(w, http.StatusInternalServerError, types.KindInternal,
			fmt.Sprintf("%s: internal error", endpoint), details)
	}
}

// upstreamErrorKind classifies an UnavailableError into the bounded
// 'underlying_error' values per API_CONTRACT.md §newtron_unavailable.
func upstreamErrorKind(err *newtronc.UnavailableError) string {
	if err.StatusCode == 0 {
		return "connection_refused"
	}
	return "http_5xx"
}

func defaultNextActionHint() map[string]any {
	return map[string]any{
		"verb":      "check_newtron_health",
		"endpoint":  "/api/health",
		"rationale": "upstream engine is unreachable; verify the daemon is running on the configured --newtron-url",
	}
}

func setIfAbsent(m map[string]any, k string, v any) {
	if _, exists := m[k]; !exists {
		m[k] = v
	}
}
