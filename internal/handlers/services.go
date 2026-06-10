// Package handlers contains one file per resource family served by
// newtcon-server. CLAUDE.md §File Ownership Map: "one file per resource
// family" — do not consolidate unrelated families.
//
// This file implements the Service Composer read endpoint:
//
//	GET /api/networks/{netID}/services
//
// Contract reference: API_CONTRACT.md §GET /api/services lines 1356–1379.
//
// The operator-facing mission this file serves: the first surface the Composer
// shows is a service-picker. GET /api/services is the foundational read that
// populates it. Without it, the operator cannot open the Composer and see what
// services are available — they cannot do the service-first mental verb that
// newtcon is built around (CLAUDE.md §Service-First, Not Device-First).
//
// Scope (newtcon#80 Slice 2/4): GET /api/services only. The /instances and
// /candidates sub-endpoints are not in this slice and are not registered here.
// They land in a future slice once newtron exposes the required substrate.
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// servicesNewtronClient is the minimal interface the services handler requires
// from the newtron client. Defined as an interface so tests can inject a stub
// without an httptest.Server.
//
// All methods are called only from the handler; the interface is local to this
// file per CLAUDE.md §File Ownership Map ("one file per resource family").
type servicesNewtronClient interface {
	ListServices(ctx context.Context, network string) ([]newtronc.NewtronService, error)
	ShowService(ctx context.Context, network, name string) (*newtronc.NewtronServiceDetail, error)
}

// ServicesDeps carries the dependencies for [RegisterServicesRoutes].
type ServicesDeps struct {
	// Client is the newtron-server HTTP client. Must not be nil.
	Client *newtronc.Client

	// CorrelationID extracts the operator-facing correlation UUID from the
	// request context. Every error envelope must carry this value per
	// API_CONTRACT.md §Error Schema lines 152–155.
	//
	// Set to server.CorrelationIDFromContext in main.go at boot time. Defined
	// as a function field (not a direct import of the server package) to avoid
	// the server → handlers → server import cycle: server imports handlers for
	// route registration; if handlers imported server for CorrelationIDFromContext
	// the cycle would be complete. The function-value approach breaks it.
	//
	// If nil, the empty string is used — acceptable for tests that do not
	// exercise the error-envelope correlation_id field.
	CorrelationID func(ctx context.Context) string
}

// RegisterServicesRoutes registers the Service Composer read routes on mux.
//
// Routes registered (Slice 2/4 scope only):
//
//	GET /api/networks/{netID}/services
//
// Called from cmd/newtcon-server/main.go at boot time per CLAUDE.md §File
// Ownership Map: main.go is responsible for server boot and route wiring.
func RegisterServicesRoutes(mux *http.ServeMux, deps ServicesDeps) {
	correlationID := deps.CorrelationID
	if correlationID == nil {
		// Fallback so tests that don't inject a correlator still compile and
		// run; errors carry an empty correlation_id in that case.
		correlationID = func(ctx context.Context) string { return "" }
	}
	h := &servicesHandler{client: deps.Client, correlationID: correlationID}

	mux.Handle("GET /api/networks/{netID}/services", http.HandlerFunc(h.handleListServices))
}

// servicesHandler holds the shared state for the services handler family.
type servicesHandler struct {
	client        servicesNewtronClient
	correlationID func(ctx context.Context) string
}

// handleListServices serves GET /api/services.
//
// Algorithm (N+1 query, sequential, bounded by typical service count <20):
//  1. Calls client.ListServices to get all service names.
//  2. For each name, calls client.ShowService to read the Type field.
//  3. Sorts the resulting slice alphabetically by name (contract + test
//     requirement: acceptance criterion 2 in newtcon#80).
//  4. Builds the ServiceListResponse with zero-valued InstanceCount / Health /
//     LastModified per CLAUDE.md §No Hidden State: the fields are structurally
//     present (contract honored) and the values are honest (newtron does not
//     yet expose these aggregates).
//
// Partial failure: if any ShowService call fails, the whole handler returns 503
// rather than returning partial data without a Confidence object.
// Per CLAUDE.md §No Hidden State: surfacing partial data without
// confidence.level:"low" (which v1 does not implement) would be dishonest.
// Rationale documented in newtcon#80 §Risks resolved.
//
// TODO(post-ship): once newtron exposes per-service instance aggregates, replace
// the zero-valued InstanceCount / Health / LastModified with real values.
func (h *servicesHandler) handleListServices(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	correlationID := h.correlationID(ctx)
	network := r.PathValue("netID")

	services, err := h.client.ListServices(ctx, network)
	if err != nil {
		writeUpstreamError(w, correlationID, err, "listing services", servicesListExtras())
		return
	}

	result := make([]types.Service, 0, len(services))
	for _, svc := range services {
		detail, err := h.client.ShowService(ctx, network, svc.Name)
		if err != nil {
			// Fail-fast: partial data without a Confidence object is dishonest
			// per CLAUDE.md §No Hidden State. See handler godoc.
			writeUpstreamError(w, correlationID, err,
				"fetching service detail for "+svc.Name, servicesListExtras())
			return
		}
		result = append(result, types.Service{
			Name: svc.Name,
			// Translate newtron's substrate "service_type" field to the outward
			// "type" field per API_CONTRACT.md §GET /api/services line 1365.
			// NewtronServiceDetail.ServiceType has json tag "service_type" to match
			// newtron's wire format; the outward Service DTO uses "type".
			Type: detail.ServiceType,
			// InstanceCount, Health, and LastModified are zero-valued in v1.
			// Newtron substrate does not yet expose per-service aggregates.
			// Per CLAUDE.md §No Hidden State: honest zero values, not fabricated.
			InstanceCount: 0,
			Health:        types.ServiceHealth{},
			LastModified:  time.Time{},
		})
	}

	// Sort alphabetically by name — acceptance criterion 2 (newtcon#80).
	sort.Slice(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})

	resp := types.ServiceListResponse{Services: result}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// servicesListExtras returns the per-endpoint extras the /api/services route
// supplies on top of writeUpstreamError's defaults. Per API_CONTRACT.md
// §details for kind: "newtron_unavailable" (lines 547–655). Fields that are
// honestly null for this endpoint (no Node scope, no prior-payload cache, no
// reachable_at timestamp tracking yet) are emitted explicitly per the
// no-hidden-state invariant.
func servicesListExtras() map[string]any {
	return map[string]any{
		"newtron_url":       "",
		"last_reachable_at": nil,
		"last_attempt_at":   nil,
		// affected_nodes is null: /api/services is not Node-scoped.
		// API_CONTRACT.md §newtron_unavailable line 616.
		"affected_nodes": nil,
		"last_known": map[string]any{
			"kind":        "none",
			"captured_at": nil,
			"payload":     nil,
		},
		"next_action_hint": map[string]any{
			"verb":            "check_newtron_health",
			"endpoint":        "/api/health",
			"suggested_after": nil,
			"rationale":       "check /api/health to see current newtron-server reachability status",
		},
		"rationale_ref": map[string]any{
			"substrate": "CLAUDE.md#newtron-api-consumption-rule",
			"principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit",
		},
	}
}

// Compile-time assertion: *newtronc.Client satisfies servicesNewtronClient.
// If newtronc.Client's ListServices/ShowService signatures change, this line
// fails at build time — catching the mismatch before runtime.
var _ servicesNewtronClient = (*newtronc.Client)(nil)
