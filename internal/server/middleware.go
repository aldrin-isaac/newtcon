// Package server implements HTTP routing, middleware, and request lifecycle
// management for newtcon-server.
//
// This file implements the three middleware layers required by newtcon#79:
//
//   - RequestID: assigns a UUIDv4 to each request, sets X-Request-ID response
//     header, stashes the value in context.Context for handlers to read.
//   - Logging: emits one structured log line per request (method, path, status,
//     duration, request_id).
//   - Recovery: converts panics to 500 responses with the API_CONTRACT.md §Error
//     Schema "internal" envelope (correlation_id populated from context).
//
// All three are composed in [NewRouter] in router.go. The composition order is
// RequestID → Recovery → Logging so that correlation_id is in context before
// Recovery's deferred panic handler runs.
package server

import (
	"crypto/rand"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/types"
)

// newUUID returns a random UUID v4 string in the canonical
// "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx" format (RFC 4122 §4.4).
//
// Panics if crypto/rand is unavailable — an unrecoverable condition on any
// supported platform. Called only by [RequestID].
func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("newtcon: crypto/rand unavailable: %v", err))
	}
	// Set version 4 (random).
	b[6] = (b[6] & 0x0f) | 0x40
	// Set variant bits (RFC 4122 §4.1.1).
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// RequestID is an HTTP middleware that ensures every request carries a UUIDv4
// request identifier.
//
// If the incoming request already has an X-Request-ID header with a non-empty
// value, that value is preserved (pass-through for upstream correlation).
// Otherwise a new UUIDv4 is generated.
//
// The identifier is:
//   - Set as the X-Request-ID response header.
//   - Stored in ctx under the typed key via [WithRequestID].
//   - Also stored as the correlation_id (v1: correlation_id == request_id) via
//     [WithCorrelationID].
//
// API_CONTRACT.md §Error Schema lines 152–155: correlation_id is REQUIRED on
// every details payload. Handlers obtain it via [CorrelationIDFromContext].
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" {
			id = newUUID()
		}
		ctx := WithRequestID(r.Context(), id)
		ctx = WithCorrelationID(ctx, id) // v1: correlation_id == request_id
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// statusRecorder wraps http.ResponseWriter to capture the status code written
// by the inner handler. Used by [Logging].
type statusRecorder struct {
	http.ResponseWriter
	status int
}

// WriteHeader captures the status code and delegates to the embedded writer.
func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Flush delegates to the inner writer's Flush if supported. Required so
// SSE handlers downstream can flush events to the client; the type-assertion
// `w.(http.Flusher)` fails on the bare embedded struct.
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Logging is an HTTP middleware that emits one structured log line per request.
//
// The line format is:
//
//	method=<METHOD> path=<PATH> status=<STATUS> duration_ms=<N> request_id=<UUID>
//
// This satisfies the newtcon#79 acceptance criterion for structured logging.
// The log destination is the process-level log output (set in main.go or tests).
func Logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		durationMs := time.Since(start).Milliseconds()
		log.Printf("method=%s path=%s status=%d duration_ms=%d request_id=%s",
			r.Method, r.URL.Path, rec.status, durationMs,
			RequestIDFromContext(r.Context()),
		)
	})
}

// Recovery is an HTTP middleware that catches panics in downstream handlers and
// converts them to 500 responses with the API_CONTRACT.md §Error Schema
// "internal" envelope.
//
// The envelope carries:
//   - correlation_id from [CorrelationIDFromContext] (populated earlier by [RequestID]).
//   - at: the server-side timestamp of the failure.
//   - phase: "unknown" (the panic may originate anywhere).
//   - partial_results: null.
//
// The panic value is logged (not leaked to the wire per API_CONTRACT.md §internal
// "No stack trace, no exception type, no file/line"). Downstream handlers that
// call recover themselves are not affected; Recovery is the outermost safety net.
func Recovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				correlationID := CorrelationIDFromContext(r.Context())
				log.Printf("PANIC recovered: %v [correlation_id=%s]", rec, correlationID)
				now := time.Now().UTC()
				details := map[string]any{
					"correlation_id":  correlationID,
					"at":              fmt.Sprintf("%s", now.Format(time.RFC3339)),
					"phase":           "unknown",
					"partial_results": nil,
				}
				// WriteHeader may already be called if the panic happened
				// mid-response. We attempt to write anyway; the http package
				// discards writes to a hijacked connection gracefully.
				types.WriteError(w, http.StatusInternalServerError,
					types.KindInternal,
					"newtcon-server failed mid-request; quote correlation_id when reporting",
					details,
				)
			}
		}()
		next.ServeHTTP(w, r)
	})
}
