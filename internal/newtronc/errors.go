// Package newtronc is the sole HTTP client of newtron-server in the newtcon
// codebase. CLAUDE.md §newtron API Consumption Rule forbids any other package
// from constructing an http.Client or calling http.Get/http.Post against the
// newtron-server address.
//
// This file defines the typed error families used across newtronc calls.
// Each family maps to one of the five ErrorKind values in internal/types.
package newtronc

import "fmt"

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
