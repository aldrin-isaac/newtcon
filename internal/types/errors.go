// Package types defines the API DTOs for newtcon-server's HTTP responses.
//
// This file defines the error envelope shape required by API_CONTRACT.md §Error Schema
// (lines 55–167). Every non-2xx response from newtcon-server uses [ErrorEnvelope].
// The five bounded [ErrorKind] values are the only permitted error discriminators;
// new kinds require a Contract PR (see CLAUDE.md §Greenfield and AGENTS.md §Architect).
package types

import (
	"encoding/json"
	"net/http"
	"time"
)

// ErrorKind is the bounded discriminator for [ErrorBody.Kind].
// API_CONTRACT.md §Error Schema lines 61–62: "kind values are bounded; new kinds
// are a Contract PR."
type ErrorKind string

const (
	// KindValidationFailure is returned when a specific input field was wrong.
	// See API_CONTRACT.md §details for kind: "validation_failure".
	KindValidationFailure ErrorKind = "validation_failure"

	// KindDriftRefusal is returned when the device CONFIG_DB has diverged from
	// the projection derived from its actuated intents.
	// See API_CONTRACT.md §details for kind: "drift_refusal".
	KindDriftRefusal ErrorKind = "drift_refusal"

	// KindPreconditionFailure is returned for newtcon-server-side state violations
	// (stale preview_id, wrong batch state, evicted operation, etc.).
	// See API_CONTRACT.md §details for kind: "precondition_failure".
	KindPreconditionFailure ErrorKind = "precondition_failure"

	// KindNewtronUnavailable is returned when newtcon-server cannot reach
	// newtron-server. Per operator-philosophy invariant #9 this is surfaced
	// honestly — never silently retried.
	// See API_CONTRACT.md §details for kind: "newtron_unavailable".
	KindNewtronUnavailable ErrorKind = "newtron_unavailable"

	// KindInternal is the residual category for failures newtcon-server cannot
	// attribute to a recognized substrate cause. The only durable handle is the
	// correlation_id. See API_CONTRACT.md §details for kind: "internal".
	KindInternal ErrorKind = "internal"
)

// ErrorEnvelope is the top-level wrapper for every non-2xx response body.
// API_CONTRACT.md §Error Schema lines 57–66.
type ErrorEnvelope struct {
	Error ErrorBody `json:"error"`
}

// ErrorBody carries the kind discriminator, a human-readable message, and the
// per-kind typed details payload.
type ErrorBody struct {
	Kind    ErrorKind      `json:"kind"`
	Message string         `json:"message"`
	Details map[string]any `json:"details"`
}

// InternalDetails is the typed details payload for KindInternal errors.
// API_CONTRACT.md §details for kind: "internal" lines 672–716.
//
// The correlation_id field is the only durable handle; it is present on every
// emission. No stack trace, exception type, or file/line is included — those
// stay in logs (API_CONTRACT.md §internal, "No stack trace, no exception type").
type InternalDetails struct {
	CorrelationID  string     `json:"correlation_id"`
	At             time.Time  `json:"at"`
	Phase          string     `json:"phase"`
	PartialResults any        `json:"partial_results"`
}

// WriteError serialises an [ErrorEnvelope] and writes it as JSON to w.
//
// correlationID must be populated from the request context via
// [internal/server.CorrelationIDFromContext]; WriteError does not read the
// context itself so that it remains testable without an HTTP request.
//
// details must contain at minimum the "correlation_id" key — the caller is
// responsible for assembling the per-kind details map. This helper enforces
// the JSON structure but not the per-kind field set (the Critic and tests do
// that). Passing nil details writes an empty JSON object so callers that only
// need the envelope itself (e.g., 405 Method Not Allowed) still produce valid
// JSON.
func WriteError(w http.ResponseWriter, status int, kind ErrorKind, message string, details map[string]any) {
	if details == nil {
		details = map[string]any{}
	}
	env := ErrorEnvelope{
		Error: ErrorBody{
			Kind:    kind,
			Message: message,
			Details: details,
		},
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// Encoding errors are intentionally swallowed: if we cannot write the error
	// body, the HTTP status code is already committed and there is nothing
	// sensible to do. The server's Recovery middleware logs the panic path
	// separately.
	_ = json.NewEncoder(w).Encode(env)
}
