// handlers/schema.go — schema-metadata read endpoints
// (newtron PR #240 universal-engine + #242 /schema/all + cache headers).
//
// Routes:
//
//	GET  /api/schema           → list of registered spec authoring kinds
//	GET  /api/schema/all       → every registered kind's full SchemaMeta
//	GET  /api/schema/{kind}    → full per-kind field metadata
//
// All three are global to the newtron install (not per-network) —
// newtron derives them from struct tags at boot.
//
// Cache headers: newtron emits `Last-Modified` (build time, with
// process start time as a fallback) and accepts `If-Modified-Since`
// for conditional fetches. Newtcon-server relays both directions so
// browser tabs avoid re-downloading unchanged schemas:
//
//	browser If-Modified-Since → newtron → 304 → browser
//	browser (no If-Modified-Since) → newtron 200 → browser 200
//	                                     ↑
//	                  copy Last-Modified upstream → downstream
//
// The upstream's `Last-Modified` is always copied to the downstream
// response so the browser caches the validator for the next request.
package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// SchemaDeps wires the schema endpoints.
type SchemaDeps struct {
	Client        *newtronc.Client
	CorrelationID func(context.Context) string
}

// RegisterSchemaRoutes installs the schema-metadata routes.
func RegisterSchemaRoutes(mux *http.ServeMux, deps SchemaDeps) {
	mux.Handle("GET /api/schema", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		writeSchemaPassthrough(w, ctx, r,
			func(ifMod string) (json.RawMessage, newtronc.SchemaCacheValidator, error) {
				return deps.Client.FetchSchemaKindsConditional(ctx, ifMod)
			},
			"GET /api/schema",
			deps.CorrelationID,
		)
	}))

	mux.Handle("GET /api/schema/all", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		writeSchemaPassthrough(w, ctx, r,
			func(ifMod string) (json.RawMessage, newtronc.SchemaCacheValidator, error) {
				return deps.Client.FetchAllSchemasConditional(ctx, ifMod)
			},
			"GET /api/schema/all",
			deps.CorrelationID,
		)
	}))

	mux.Handle("GET /api/schema/{kind}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		kind := r.PathValue("kind")
		writeSchemaPassthrough(w, ctx, r,
			func(ifMod string) (json.RawMessage, newtronc.SchemaCacheValidator, error) {
				return deps.Client.FetchSchemaConditional(ctx, kind, ifMod)
			},
			"GET /api/schema/"+kind,
			deps.CorrelationID,
		)
	}))
}

// writeSchemaPassthrough is the shared cache-header relay used by the
// three schema handlers. fetch() forwards the browser's
// If-Modified-Since upstream and returns the body + validator. The
// helper:
//
//  1. Calls fetch with the browser's If-Modified-Since (or "" if absent).
//  2. Copies upstream's Last-Modified to the downstream response.
//  3. If upstream returned 304, returns 304 to the browser with no body.
//  4. Otherwise writes 200 + the decoded data payload.
//  5. On upstream error, falls through to writeUpstreamError.
func writeSchemaPassthrough(
	w http.ResponseWriter,
	ctx context.Context,
	r *http.Request,
	fetch func(ifModifiedSince string) (json.RawMessage, newtronc.SchemaCacheValidator, error),
	logLabel string,
	cid func(context.Context) string,
) {
	ifMod := r.Header.Get("If-Modified-Since")
	body, validator, err := fetch(ifMod)
	if err != nil {
		writeUpstreamError(w, cid(ctx), err, logLabel, nil)
		return
	}
	if validator.LastModified != "" {
		w.Header().Set("Last-Modified", validator.LastModified)
	}
	// Caching policy mirrors newtron's: schemas don't change at
	// runtime, but per-deploy turnover is real. private,
	// must-revalidate tells well-behaved browsers/proxies to revalidate
	// before serving from cache — matches the schema's actual freshness.
	w.Header().Set("Cache-Control", "private, must-revalidate")

	if validator.NotModified {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
