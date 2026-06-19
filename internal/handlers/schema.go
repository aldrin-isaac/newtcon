// handlers/schema.go — schema-metadata read endpoints (newtron #240).
//
// Routes:
//
//	GET  /api/schema           → list of registered spec authoring kinds
//	GET  /api/schema/{kind}    → full per-kind field metadata
//
// Both are global to the newtron install (not per-network) — newtron
// derives them from struct tags at boot.
//
// Forwards the upstream payload verbatim. The newtcon UI consumes
// these to drive create-form labels + tooltips + types without
// hand-maintaining a parallel schema.
package handlers

import (
	"context"
	"net/http"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// SchemaDeps wires the two GET endpoints.
type SchemaDeps struct {
	Client        *newtronc.Client
	CorrelationID func(context.Context) string
}

// RegisterSchemaRoutes installs the two schema-metadata routes.
func RegisterSchemaRoutes(mux *http.ServeMux, deps SchemaDeps) {
	mux.Handle("GET /api/schema", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		payload, err := deps.Client.FetchSchemaKinds(ctx)
		if err != nil {
			writeUpstreamError(w, deps.CorrelationID(ctx), err, "GET /api/schema", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}))

	mux.Handle("GET /api/schema/{kind}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		kind := r.PathValue("kind")
		payload, err := deps.Client.FetchSchema(ctx, kind)
		if err != nil {
			writeUpstreamError(w, deps.CorrelationID(ctx), err,
				"GET /api/schema/"+kind, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}))
}
