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
	"github.com/aldrin-isaac/newtcon/internal/session"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "listen address for newtcon-server")
	newtronURL := flag.String("newtron-url", "", "newtron-server base URL (e.g., http://127.0.0.1:9090 or https://newtron.example.com)")
	newtronTimeout := flag.Duration("newtron-timeout", 10*time.Second, "per-request timeout for newtron-server calls")
	newtronProvisionTimeout := flag.Duration("newtron-provision-timeout", 10*time.Minute, "timeout for long synchronous lab operations (provision)")
	newtronCACert := flag.String("newtron-ca-cert", "", "PEM file with CA roots to verify newtron-server's TLS cert (default: system roots). Only consulted when --newtron-url uses https://. Env: NEWTRON_TLS_CA.")
	newtronClientCert := flag.String("newtron-client-cert", "", "PEM file with newtcon-server's client cert for outbound mTLS to newtron-server (newtron's --tls-ca path). Must be set together with --newtron-client-key. Env: NEWTRON_TLS_CERT.")
	newtronClientKey := flag.String("newtron-client-key", "", "PEM file with the matching private key for --newtron-client-cert. Env: NEWTRON_TLS_KEY.")
	newtronSkipTLSVerify := flag.Bool("newtron-skip-tls-verify", false, "DEV ONLY: skip TLS cert verification on newtron-server. Defeats encryption guarantees; never use in production.")
	tlsCert := flag.String("tls-cert", "", "PEM file with newtcon-server's TLS certificate chain. When set together with --tls-key, the server serves HTTPS; otherwise it serves plain HTTP (dev). Env: NEWTCON_TLS_CERT.")
	tlsKey := flag.String("tls-key", "", "PEM file with newtcon-server's TLS private key. Must be set together with --tls-cert. Env: NEWTCON_TLS_KEY.")
	cookieSecure := flag.String("cookie-secure", "auto", "Session-cookie Secure attribute: \"auto\" (default — true when --tls-cert/--tls-key are set, false otherwise), \"true\" (reverse-proxy deployments where TLS terminates upstream), or \"false\" (plain-HTTP dev only).")
	authRequired := flag.Bool("auth-required", false, "When set, newtcon-server runs the L2c login flow: /api/auth/{login,logout,whoami} are active, the frontend gates the workspace behind a login overlay, and outbound newtronc calls carry the operator's bearer. Default is false (anonymous / playground mode) so a fresh clone reaches the workspace with one command. PRODUCTION DEPLOYMENTS MUST SET THIS.")
	webDir := flag.String("web-dir", "web/dist", "directory of compiled frontend static assets to serve at /; empty or non-existent disables static serving")
	docsDir := flag.String("docs-dir", "docs", "directory of operator documentation to serve at /docs/; empty or non-existent disables docs serving")
	docsRootDir := flag.String("docs-root-dir", ".", "repository root directory; CLAUDE.md and API_CONTRACT.md are served from here at /CLAUDE.md and /API_CONTRACT.md")
	flag.Parse()

	// Env-var fallback for unset TLS flags — adopts the NEWTRON_TLS_*
	// convention (newtron PR #179) for outbound (newtcon-server is a
	// newtron client) and a parallel NEWTCON_TLS_* for inbound. Flags
	// always win; env vars only fill in when the flag is unset.
	if *newtronCACert == "" {
		*newtronCACert = os.Getenv("NEWTRON_TLS_CA")
	}
	if *newtronClientCert == "" {
		*newtronClientCert = os.Getenv("NEWTRON_TLS_CERT")
	}
	if *newtronClientKey == "" {
		*newtronClientKey = os.Getenv("NEWTRON_TLS_KEY")
	}
	if *tlsCert == "" {
		*tlsCert = os.Getenv("NEWTCON_TLS_CERT")
	}
	if *tlsKey == "" {
		*tlsKey = os.Getenv("NEWTCON_TLS_KEY")
	}

	// Inbound TLS mode: both --tls-cert and --tls-key, or neither. Catch
	// misconfig before doing any other setup work.
	if (*tlsCert == "") != (*tlsKey == "") {
		log.Fatalf("newtcon-server: --tls-cert and --tls-key must be set together (got cert=%q key=%q)", *tlsCert, *tlsKey)
	}
	tlsOn := *tlsCert != "" && *tlsKey != ""

	// Cookie.Secure resolution: --cookie-secure=auto (default) tracks tlsOn;
	// explicit "true" overrides upward (reverse-proxy with upstream TLS);
	// "false" overrides downward (plain-HTTP dev). Any other value rejected.
	var cookieSecureResolved bool
	switch *cookieSecure {
	case "auto":
		cookieSecureResolved = tlsOn
	case "true":
		cookieSecureResolved = true
	case "false":
		cookieSecureResolved = false
	default:
		log.Fatalf("newtcon-server: --cookie-secure must be one of \"auto\", \"true\", \"false\" (got %q)", *cookieSecure)
	}
	if !cookieSecureResolved {
		log.Printf("WARNING: session cookie will be sent without the Secure attribute. Operator credentials over plain HTTP are at risk; this mode is intended for dev only.")
	}
	if !*authRequired {
		log.Printf("WARNING: --auth-required=false; newtcon-server is serving anonymous traffic. Intended for development / playground use; PRODUCTION DEPLOYMENTS MUST SET --auth-required.")
	}

	tlsCfg, err := newtronc.BuildTLSConfig(newtronc.OutboundTLSOptions{
		CAPath:     *newtronCACert,
		CertPath:   *newtronClientCert,
		KeyPath:    *newtronClientKey,
		SkipVerify: *newtronSkipTLSVerify,
	})
	if err != nil {
		log.Fatalf("newtcon-server: outbound TLS config: %v", err)
	}
	if *newtronSkipTLSVerify {
		log.Printf("WARNING: --newtron-skip-tls-verify is on; outbound TLS cert verification is disabled. Development use only.")
	}

	ncOpts := []newtronc.Option{
		newtronc.WithTimeout(*newtronTimeout),
		newtronc.WithProvisionTimeout(*newtronProvisionTimeout),
	}
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

	// Read-only inspector for newtron's authorization table (super_users +
	// user_groups + permissions). Backs the Permissions tab in the SPA.
	handlers.RegisterAuthorizationRoutes(mux, handlers.AuthorizationDeps{
		Client:        nc,
		CorrelationID: server.CorrelationIDFromContext,
	})

	// Audit log + integrity status (slice #175.B). Forwards newtron's
	// /audit/events + /audit/integrity endpoints (newtron PR #197).
	// Backs the Audit tab in the SPA.
	handlers.RegisterAuditRoutes(mux, handlers.AuditDeps{
		Client:        nc,
		CorrelationID: server.CorrelationIDFromContext,
	})

	// Network-scoped secret store (newtron#371 et al.). Write-only credential
	// authoring: the create-node form POSTs a masked value here and references
	// it from a spec field as ${secret:<key>}; no route returns a value.
	handlers.RegisterSecretsRoutes(mux, handlers.SecretsDeps{
		Client:        nc,
		CorrelationID: server.CorrelationIDFromContext,
	})

	// Network SSH login (scoped scalar). set/clear/show the login at
	// network/zone/node scope — the scalar mirror of the ip-vpn override
	// affordance; backs the "SSH Login" control. ssh_pass rides the secret store.
	handlers.RegisterSSHCredentialsRoutes(mux, handlers.SSHCredentialsDeps{
		Client:        nc,
		CorrelationID: server.CorrelationIDFromContext,
	})

	// Spec-authoring schema metadata (newtron PR #240). Two global
	// read-only endpoints (no /networks/{netID}/ prefix — the schema
	// is per-install, not per-network). Frontend drives create-form
	// labels + tooltips + types from these.
	handlers.RegisterSchemaRoutes(mux, handlers.SchemaDeps{
		Client:        nc,
		CorrelationID: server.CorrelationIDFromContext,
	})

	// Operator-identity endpoints: /api/auth/{login,logout,whoami}.
	// Cookie.Secure is auto-derived from tlsOn — production HTTPS deployments
	// get Secure cookies; plain-HTTP dev gets non-Secure (so the browser will
	// re-send). Reverse-proxy scenarios may need a future override flag.
	sessionStore := session.NewStore()
	handlers.RegisterAuthRoutes(mux, handlers.AuthDeps{
		Client:        nc,
		Store:         sessionStore,
		CookieSecure:  cookieSecureResolved,
		AuthRequired:  *authRequired,
		CorrelationID: server.CorrelationIDFromContext,
	})

	// Deployment posture surface for the frontend to read at boot (auth-gate
	// uses it to skip the overlay flow entirely in anonymous mode).
	mux.Handle("GET /api/config", handlers.NewConfigHandler(*authRequired))

	// Static-asset serving must be registered after all /api/* routes so
	// that the more-specific /api/* patterns take precedence in the mux.
	// server.RegisterStaticAssets logs a warning and skips registration when
	// webDir is empty or does not exist; the /api/* handlers remain active.
	server.RegisterStaticAssets(mux, *webDir)

	// Docs serving mounts the operator documentation at /docs/ (and CLAUDE.md,
	// API_CONTRACT.md at their root paths). Registration order does not affect
	// routing correctness; the more-specific "/docs/" wins over "/" regardless.
	server.RegisterDocsAssets(mux, *docsDir, *docsRootDir)

	// Session middleware wraps the mux: read cookie → resolve bearer + user
	// into request context for downstream handlers + newtronc transport;
	// watch for 401 on the way out to evict + clear the cookie.
	sessionMW := session.Middleware(sessionStore, cookieSecureResolved)
	handler := server.ApplyMiddleware(sessionMW(mux))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	scheme := "http"
	if tlsOn {
		scheme = "https"
	}

	log.Printf("newtcon-server listening on %s://%s (newtron-url=%q newtron-timeout=%s newtron-ca-cert=%q newtron-client-cert=%q newtron-client-key=%q newtron-skip-tls-verify=%t tls-cert=%q tls-key=%q cookie-secure=%s (resolved=%t) auth-required=%t web-dir=%q docs-dir=%q)",
		scheme, *addr, *newtronURL, *newtronTimeout, *newtronCACert, *newtronClientCert, *newtronClientKey, *newtronSkipTLSVerify, *tlsCert, *tlsKey, *cookieSecure, cookieSecureResolved, *authRequired, *webDir, *docsDir)

	var serveErr error
	if tlsOn {
		serveErr = srv.ListenAndServeTLS(*tlsCert, *tlsKey)
	} else {
		log.Printf("WARNING: newtcon-server is serving plain HTTP. Operator credentials sent over this listener will be transmitted in cleartext. Set --tls-cert and --tls-key for production.")
		serveErr = srv.ListenAndServe()
	}
	if serveErr != nil {
		log.Printf("server exited: %v", serveErr)
		os.Exit(1)
	}
}
