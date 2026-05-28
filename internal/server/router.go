// Package server implements HTTP routing, middleware, and request lifecycle
// management for newtcon-server.
//
// This file owns route registration. The pattern for adding new routes is:
// slices 2/3 call exported Register<Family>Routes(mux, deps) functions in
// their respective internal/handlers/<family>.go files. NewRouter constructs
// the mux, registers the health route, and returns the mux for those
// registration calls. See newtcon#79 §Risks resolved, "Multiple route
// registration patterns possible".
package server

import (
	"net/http"

	"github.com/aldrin-isaac/newtcon/internal/handlers"
	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// Config carries the dependencies NewRouter needs to wire up the handler tree.
// Fields are set from parsed flags in cmd/newtcon-server/main.go.
type Config struct {
	// NewtronClient is the sole newtron-server HTTP client.
	// Created in main.go via newtronc.New(newtronURL, ...).
	NewtronClient *newtronc.Client

	// NewtronURL is the configured newtron-server base URL. Passed through to
	// the health handler so HealthResponse.Newtron.URL is populated per
	// API_CONTRACT.md §GET /api/health line 1321.
	NewtronURL string
}

// NewRouter returns an *http.ServeMux with the newtcon-server route table
// registered and all three middleware layers (Recovery → RequestID → Logging)
// applied.
//
// Routes registered here (Slice 1):
//
//	GET /api/health
//
// Slices 2 and 3 call exported Register<Family>Routes(mux, deps) to add the
// Composer endpoints without modifying this function.
//
// The returned *http.ServeMux uses Go 1.22+ method+path routing patterns.
func NewRouter(cfg Config) http.Handler {
	mux := http.NewServeMux()

	healthCfg := handlers.HealthConfig{
		NewtronClient: cfg.NewtronClient,
		NewtronURL:    cfg.NewtronURL,
	}
	mux.Handle("GET /api/health", handlers.NewHealthHandler(healthCfg))

	// Middleware composition order (outermost first):
	//
	//   RequestID → Recovery → Logging → mux
	//
	// RequestID is outermost so that the correlation_id is populated in context
	// before Recovery's deferred panic handler reads it. If Recovery were
	// outermost, the deferred closure would hold the pre-RequestID request object
	// and CorrelationIDFromContext would return "". The UUID must be set first.
	return RequestID(Recovery(Logging(mux)))
}
