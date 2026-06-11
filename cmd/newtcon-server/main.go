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
	newtronURL := flag.String("newtron-url", "", "newtron-server base URL (e.g., http://127.0.0.1:9090 or https://newtron.example.com)")
	newtronTimeout := flag.Duration("newtron-timeout", 10*time.Second, "per-request timeout for newtron-server calls")
	newtronCACert := flag.String("newtron-ca-cert", "", "PEM file with CA roots to verify newtron-server's TLS cert (default: system roots). Only consulted when --newtron-url uses https://.")
	newtronSkipTLSVerify := flag.Bool("newtron-skip-tls-verify", false, "DEV ONLY: skip TLS cert verification on newtron-server. Defeats encryption guarantees; never use in production.")
	webDir := flag.String("web-dir", "web/dist", "directory of compiled frontend static assets to serve at /; empty or non-existent disables static serving")
	docsDir := flag.String("docs-dir", "docs", "directory of operator documentation to serve at /docs/; empty or non-existent disables docs serving")
	docsRootDir := flag.String("docs-root-dir", ".", "repository root directory; CLAUDE.md and API_CONTRACT.md are served from here at /CLAUDE.md and /API_CONTRACT.md")
	flag.Parse()

	tlsCfg, err := newtronc.BuildTLSConfig(*newtronCACert, *newtronSkipTLSVerify)
	if err != nil {
		log.Fatalf("newtcon-server: --newtron-ca-cert: %v", err)
	}
	if *newtronSkipTLSVerify {
		log.Printf("WARNING: --newtron-skip-tls-verify is on; outbound TLS cert verification is disabled. Development use only.")
	}

	ncOpts := []newtronc.Option{newtronc.WithTimeout(*newtronTimeout)}
	if tlsCfg != nil {
		ncOpts = append(ncOpts, newtronc.WithTLSConfig(tlsCfg))
	}
	nc := newtronc.New(*newtronURL, ncOpts...)

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

	// Network-level spec lists: every spec type the operator can author in
	// newtron. Read-only list endpoints; detail endpoints land in subsequent
	// slices.
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{
		Client:        nc,
		CorrelationID: server.CorrelationIDFromContext,
	})

	// Topology and per-device read endpoints (slice 3).
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client:        nc,
		CorrelationID: server.CorrelationIDFromContext,
	})

	// Lab lifecycle endpoints (slice 8): list topologies, status, deploy,
	// destroy, provision, SSE events, start/stop nodes.
	handlers.RegisterLabRoutes(mux, handlers.LabDeps{
		Client:        nc,
		CorrelationID: server.CorrelationIDFromContext,
	})

	// Topology-switcher meta surface: list registered networks + register
	// (with optional scaffold) so the operator can flip between networks
	// without a server restart.
	handlers.NewNetworksHandler(mux, nc, server.CorrelationIDFromContext)

	// Static-asset serving must be registered after all /api/* routes so
	// that the more-specific /api/* patterns take precedence in the mux.
	// server.RegisterStaticAssets logs a warning and skips registration when
	// webDir is empty or does not exist; the /api/* handlers remain active.
	server.RegisterStaticAssets(mux, *webDir)

	// Docs serving mounts the operator documentation at /docs/ (and CLAUDE.md,
	// API_CONTRACT.md at their root paths). Registration order does not affect
	// routing correctness; the more-specific "/docs/" wins over "/" regardless.
	server.RegisterDocsAssets(mux, *docsDir, *docsRootDir)

	handler := server.ApplyMiddleware(mux)

	srv := &http.Server{
		Addr:              *addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("newtcon-server listening on %s (newtron-url=%q newtron-timeout=%s newtron-ca-cert=%q newtron-skip-tls-verify=%t web-dir=%q docs-dir=%q)",
		*addr, *newtronURL, *newtronTimeout, *newtronCACert, *newtronSkipTLSVerify, *webDir, *docsDir)
	if err := srv.ListenAndServe(); err != nil {
		log.Printf("server exited: %v", err)
		os.Exit(1)
	}
}
