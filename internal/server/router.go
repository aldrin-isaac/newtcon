// Package server implements HTTP routing, middleware, and request lifecycle
// management for newtcon-server.
//
// This file owns the middleware composition layer. Route registration is
// performed by [NewMux] which returns a bare *http.ServeMux; callers (main.go)
// register routes on the mux before passing it to [ApplyMiddleware] which wraps
// it in the three standard middleware layers.
//
// The split between NewMux and ApplyMiddleware is required to break the import
// cycle that arises when route registration is done here:
//
//	server imports handlers (for route registration)
//	handlers imports server (for CorrelationIDFromContext)
//	→ cycle
//
// By separating mux creation from route registration, server does not need to
// import handlers. Route registration is the caller's (main.go's) responsibility.
// This is consistent with CLAUDE.md §File Ownership Map: "cmd/newtcon-server/main.go
// → process entry, flag parsing, server boot." Wiring routes is part of server boot.
//
// Handlers that need CorrelationIDFromContext receive it as a dependency
// function (e.g., ServicesDeps.CorrelationID = server.CorrelationIDFromContext)
// set by main.go at boot time. This passes the accessor through without
// creating an import dependency.
package server

import (
	"net/http"
)

// NewMux returns a bare *http.ServeMux for route registration.
//
// Callers register routes on the returned mux, then pass it to
// [ApplyMiddleware] to get the fully-wrapped handler. See main.go for the
// canonical usage pattern.
func NewMux() *http.ServeMux {
	return http.NewServeMux()
}

// ApplyMiddleware wraps the given handler in the three standard middleware layers:
//
//	RequestID → Recovery → Logging → handler
//
// Composition order is critical: RequestID is outermost so that the
// correlation_id is populated in context before Recovery's deferred panic
// handler reads it. If Recovery were outermost, the deferred closure would
// hold the pre-RequestID request object and CorrelationIDFromContext would
// return "". The UUID must be set first.
func ApplyMiddleware(handler http.Handler) http.Handler {
	return RequestID(Recovery(Logging(handler)))
}
