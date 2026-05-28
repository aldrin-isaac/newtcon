// Package server implements HTTP routing, middleware, and request lifecycle
// management for newtcon-server.
//
// This file provides typed context keys and helper functions for the
// request-scoped identifiers that flow through the handler chain.
// See CLAUDE.md §File Ownership Map: internal/server/ → "HTTP routing,
// middleware, request lifecycle".
package server

import "context"

// contextKey is the unexported type for all newtcon context keys. Using a
// package-local type prevents collisions with keys from other packages.
type contextKey int

const (
	// keyRequestID is the context key for the X-Request-ID value assigned by
	// the RequestID middleware.
	keyRequestID contextKey = iota

	// keyCorrelationID is the context key for the operator-facing correlation
	// UUID required on every API_CONTRACT.md §Error Schema details.correlation_id.
	// In v1, correlation_id == request_id (one UUID per request). Slices 2/3
	// may derive it differently when chaining newtron calls.
	keyCorrelationID
)

// WithRequestID returns a copy of ctx carrying the given requestID.
// Called by the RequestID middleware after generating or preserving the UUID.
func WithRequestID(ctx context.Context, requestID string) context.Context {
	return context.WithValue(ctx, keyRequestID, requestID)
}

// RequestIDFromContext returns the request ID stored in ctx, or "" if none.
func RequestIDFromContext(ctx context.Context) string {
	v, _ := ctx.Value(keyRequestID).(string)
	return v
}

// WithCorrelationID returns a copy of ctx carrying the given correlationID.
// In v1 this is called immediately after WithRequestID, setting the same value.
func WithCorrelationID(ctx context.Context, correlationID string) context.Context {
	return context.WithValue(ctx, keyCorrelationID, correlationID)
}

// CorrelationIDFromContext returns the correlation ID stored in ctx, or "" if
// none. Handlers pass this value to types.WriteError so every error envelope
// carries the required details.correlation_id per API_CONTRACT.md §Error Schema
// lines 152–155.
func CorrelationIDFromContext(ctx context.Context) string {
	v, _ := ctx.Value(keyCorrelationID).(string)
	return v
}
