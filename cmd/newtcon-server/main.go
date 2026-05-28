// Package main is the newtcon-server entry point.
//
// Flag parsing, newtronc client construction, route registration, and HTTP
// server startup. HTTP middleware is applied in [internal/server]; handler
// logic is in [internal/handlers]. See CLAUDE.md §File Ownership Map for the
// binding file-to-concern assignments.
//
// Route registration is the responsibility of main.go, not server/router.go.
// This avoids the import cycle that arises when server imports handlers for
// route registration while handlers need server.CorrelationIDFromContext:
//
//	server imports handlers → handlers imports server → cycle
//
// The resolution: server exposes NewMux() and ApplyMiddleware(); main.go does
// the wiring. CorrelationIDFromContext is passed as a function value into each
// handler's Deps struct so handlers never need to import server directly.
//
// Build command (per CLAUDE.md §Build Convention):
//
//	go build -o bin/newtcon-server ./cmd/newtcon-server
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/handlers"
	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/server"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "listen address for newtcon-server")
	newtronURL := flag.String("newtron-url", "", "newtron-server base URL (e.g., http://127.0.0.1:9090)")
	newtronTimeout := flag.Duration("newtron-timeout", 10*time.Second, "per-request timeout for newtron-server calls")
	flag.Parse()

	nc := newtronc.New(*newtronURL, newtronc.WithTimeout(*newtronTimeout))

	mux := server.NewMux()

	// Slice 1: health endpoint.
	mux.Handle("GET /api/health", handlers.NewHealthHandler(handlers.HealthConfig{
		NewtronClient: nc,
		NewtronURL:    *newtronURL,
	}))

	// Slice 2: Service Composer read endpoints.
	// server.CorrelationIDFromContext is passed as a function value to avoid
	// the handlers → server import cycle. See package godoc.
	handlers.RegisterServicesRoutes(mux, handlers.ServicesDeps{
		Client:        nc,
		CorrelationID: server.CorrelationIDFromContext,
	})

	// Slice 3: Service Composer write endpoints — preview + apply.
	// The PreviewStore is shared: preview mints and stores entries; apply
	// consumes (Take, single-use) entries by preview_id.
	store := handlers.NewPreviewStore(5*time.Minute, time.Now)
	handlers.RegisterPreviewRoutes(mux, handlers.PreviewDeps{
		Client:        nc,
		Store:         store,
		Clock:         time.Now,
		NewtronURL:    *newtronURL,
		CorrelationID: server.CorrelationIDFromContext,
	})
	handlers.RegisterApplyRoutes(mux, handlers.ApplyDeps{
		Client:        nc,
		Store:         store,
		Clock:         time.Now,
		NewtronURL:    *newtronURL,
		CorrelationID: server.CorrelationIDFromContext,
	})

	handler := server.ApplyMiddleware(mux)

	srv := &http.Server{
		Addr:              *addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("newtcon-server listening on %s (newtron-url=%q newtron-timeout=%s)",
		*addr, *newtronURL, *newtronTimeout)
	if err := srv.ListenAndServe(); err != nil {
		log.Printf("server exited: %v", err)
		os.Exit(1)
	}
}
