// Package newtronc is the sole HTTP client of newtron-server in the newtcon
// codebase. CLAUDE.md §newtron API Consumption Rule forbids any other package
// from constructing an http.Client or calling http.Get/http.Post against the
// newtron-server address.
//
// This file defines the typed error families used across newtronc calls.
// Each family maps to one of the five ErrorKind values in internal/types.
package newtronc

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
)

// UnavailableError is returned when newtron-server is unreachable or returns a
// 5xx status. It maps to types.KindNewtronUnavailable.
//
// The Cause field carries the original transport error or the response body
// for 5xx responses, verbatim, for upstream inspection by handlers.
type UnavailableError struct {
	// StatusCode is the HTTP status code from newtron-server, or 0 for
	// transport-level failures (connection refused, DNS failure, timeout).
	StatusCode int

	// Cause is the raw underlying error string. Handlers surface this as
	// details.underlying_error_message per API_CONTRACT.md §newtron_unavailable.
	Cause string
}

func (e *UnavailableError) Error() string {
	if e.StatusCode != 0 {
		return fmt.Sprintf("newtron-server returned %d: %s", e.StatusCode, e.Cause)
	}
	return fmt.Sprintf("newtron-server unreachable: %s", e.Cause)
}

// ValidationError is returned when newtron-server returns a 400 with a
// parseable error body. It maps to types.KindValidationFailure.
type ValidationError struct {
	StatusCode  int
	Body        []byte // verbatim newtron response body
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("newtron-server validation error (%d): %s", e.StatusCode, string(e.Body))
}

// ConflictError is returned when newtron-server returns a 409. The concrete
// newtron error type (drift guard vs. VerificationFailedError) is discriminated
// by the response body in slices 2/3 when this error is consumed.
// It maps to types.KindDriftRefusal or a verify-failure path depending on body.
type ConflictError struct {
	StatusCode int
	Body       []byte // verbatim newtron response body
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("newtron-server conflict (%d): %s", e.StatusCode, string(e.Body))
}

// NotFoundError is returned when newtron-server returns a 404.
// It maps to types.KindPreconditionFailure.
type NotFoundError struct {
	StatusCode int
	Body       []byte // verbatim newtron response body
}

func (e *NotFoundError) Error() string {
	return fmt.Sprintf("newtron-server not found (%d): %s", e.StatusCode, string(e.Body))
}

// UnauthenticatedError is returned when newtron-server returns a 401.
// The operator either presented no credentials, expired credentials, or
// otherwise unrecognised credentials. It maps to types.KindAuthenticationFailure.
//
// Body carries the verbatim newtron response for diagnostics. Newtron's
// own auth-design.md leaves the 401 body free-form (no typed envelope),
// so callers should not try to extract structured fields.
type UnauthenticatedError struct {
	StatusCode int
	Body       []byte
}

func (e *UnauthenticatedError) Error() string {
	return fmt.Sprintf("newtron-server unauthenticated (%d): %s", e.StatusCode, string(e.Body))
}

// AuthorizationError is returned when newtron-server returns a 403 with its
// typed AuthorizationError envelope (newtcon#143). It maps to
// types.KindAuthorizationFailure.
//
// Wire shape (per newtron's pkg/newtron/types.go AuthorizationError + the
// regression test pkg/newtron/api/authorization_test.go TestAuthorization_
// DenyWireShape that pins these JSON keys):
//
//	{
//	  "data":  { "caller": "alice", "permission": "spec.author", "resource": "svc-b" },
//	  "error": "authorization denied: alice lacks spec.author on svc-b"
//	}
//
// Resource is optional — operations that aren't resource-scoped (e.g. global
// admin permissions) omit it.
type AuthorizationError struct {
	StatusCode int
	Caller     string `json:"caller"`
	Permission string `json:"permission"`
	Resource   string `json:"resource,omitempty"`
	Body       []byte `json:"-"` // raw body for diagnostics; never JSON-encoded
}

func (e *AuthorizationError) Error() string {
	if e.Resource != "" {
		return fmt.Sprintf("authorization denied: %s lacks %s on %s", e.Caller, e.Permission, e.Resource)
	}
	return fmt.Sprintf("authorization denied: %s lacks %s", e.Caller, e.Permission)
}

// decodeAuthorizationError extracts the AuthorizationError from a 403 envelope
// body. Falls back to a bare AuthorizationError carrying only StatusCode +
// Body when the envelope doesn't match the expected shape (e.g. newtron
// returned 403 without enabling enforcement, or a proxy injected one).
func decodeAuthorizationError(statusCode int, body []byte) *AuthorizationError {
	var env struct {
		Data  *AuthorizationError `json:"data"`
		Error string              `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err == nil && env.Data != nil {
		env.Data.StatusCode = statusCode
		env.Data.Body = body
		return env.Data
	}
	return &AuthorizationError{StatusCode: statusCode, Body: body}
}

// classifyResponse maps a newtron HTTP response status to the appropriate
// typed error. Returns nil on success.
//
// successCodes lists the statuses the caller treats as success (typically
// 200, sometimes 200+201 for writes, 200+202 for newtlab's async deploy).
// Any status in successCodes returns nil; everything else returns a typed
// error per the standard mapping:
//
//	400 → *ValidationError
//	403 → *AuthorizationError (decoded from the envelope body)
//	404 → *NotFoundError
//	409 → *ConflictError
//	5xx → *UnavailableError (StatusCode + body as Cause)
//	other → *UnavailableError ("unexpected status N: <body>")
//
// Before this helper, every newtronc method had its own status switch — same
// shape, 15 copies, diverging case sets (some had Conflict, some didn't, etc.).
// Per ai-instructions §7 + DESIGN_PRINCIPLES §39 the duplication collapsed
// here. Adding a new status case (e.g. newtcon#143's 403 handling) is now a
// one-line change instead of a 15-site sweep.
func classifyResponse(statusCode int, body []byte, successCodes ...int) error {
	if slices.Contains(successCodes, statusCode) {
		return nil
	}
	switch statusCode {
	case http.StatusBadRequest:
		return &ValidationError{StatusCode: statusCode, Body: body}
	case http.StatusUnauthorized:
		return &UnauthenticatedError{StatusCode: statusCode, Body: body}
	case http.StatusForbidden:
		return decodeAuthorizationError(statusCode, body)
	case http.StatusNotFound:
		return &NotFoundError{StatusCode: statusCode, Body: body}
	case http.StatusConflict:
		return &ConflictError{StatusCode: statusCode, Body: body}
	}
	if statusCode >= 500 {
		return &UnavailableError{StatusCode: statusCode, Cause: string(body)}
	}
	return &UnavailableError{
		StatusCode: statusCode,
		Cause:      fmt.Sprintf("unexpected status %d: %s", statusCode, string(body)),
	}
}
