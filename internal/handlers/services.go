// Package handlers contains one file per resource family served by
// newtcon-server. CLAUDE.md §File Ownership Map: "one file per resource
// family" — do not consolidate unrelated families.
//
// This file implements the Service Composer read endpoints:
//
//	GET /api/services
//	GET /api/services/{name}/instances    (v1 stub — newtron substrate not yet available)
//	GET /api/services/{name}/candidates   (v1 stub — newtron substrate not yet available)
//
// Contract reference: API_CONTRACT.md §GET /api/services lines 1356–1379,
// §GET /api/services/{name}/instances lines 1381–1405,
// §GET /api/services/{name}/candidates lines 1413–1443.
//
// The operator-facing mission this file serves: the first surface the Composer
// shows is a service-picker. GET /api/services is the foundational read that
// populates it. Without it, the operator cannot open the Composer and see what
// services are available — they cannot do the service-first mental verb that
// newtcon is built around (CLAUDE.md §Service-First, Not Device-First).
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
// All three methods are called only from the handler; the interface is local to
// this file per CLAUDE.md §File Ownership Map ("one file per resource family").
type servicesNewtronClient interface {
	Network(ctx context.Context) string
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
	// Set to server.CorrelationIDFromContext in router.go. Defined as a
	// function field (not a direct import of the server package) to break
	// the server → handlers → server import cycle: handlers must not import
	// server (server already imports handlers for route registration).
	//
	// If nil, the empty string is used — acceptable for tests that do not
	// exercise the error-envelope correlation_id field.
	CorrelationID func(ctx context.Context) string
}

// RegisterServicesRoutes registers the Service Composer read routes on mux.
//
// Routes registered:
//
//	GET /api/services
//	GET /api/services/{name}/instances
//	GET /api/services/{name}/candidates
//
// Called from internal/server/router.go after RegisterHealthRoutes per
// CLAUDE.md §File Ownership Map pattern established by Slice 1.
func RegisterServicesRoutes(mux *http.ServeMux, deps ServicesDeps) {
	correlationID := deps.CorrelationID
	if correlationID == nil {
		// Fallback so tests that don't inject a correlator still compile and
		// run; errors will carry an empty correlation_id in that case.
		correlationID = func(ctx context.Context) string { return "" }
	}
	h := &servicesHandler{client: deps.Client, correlationID: correlationID}

	mux.Handle("GET /api/services", http.HandlerFunc(h.handleListServices))
	mux.Handle("GET /api/services/{name}/instances", http.HandlerFunc(h.handleListInstances))
	mux.Handle("GET /api/services/{name}/candidates", http.HandlerFunc(h.handleListCandidates))
}

// servicesHandler holds the shared state for all service-family handlers.
// Using a struct groups the three handlers without exposing them individually
// to the router; each handler is attached via RegisterServicesRoutes above.
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
	network := h.client.Network(ctx)

	services, err := h.client.ListServices(ctx, network)
	if err != nil {
		writeServicesUnavailable(w, correlationID, err, "listing services")
		return
	}

	result := make([]types.Service, 0, len(services))
	for _, svc := range services {
		detail, err := h.client.ShowService(ctx, network, svc.Name)
		if err != nil {
			// Fail-fast: partial data without a Confidence object is dishonest
			// per CLAUDE.md §No Hidden State. See handler godoc.
			writeServicesUnavailable(w, correlationID, err,
				"fetching service detail for "+svc.Name)
			return
		}
		result = append(result, types.Service{
			Name: svc.Name,
			// Translate newtron's substrate "service_type" field to the
			// outward "type" field per API_CONTRACT.md §GET /api/services.
			// The json tag on NewtronServiceDetail.ServiceType is "service_type"
			// to match newtron's wire format; our outward DTO uses "type".
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

// handleListInstances serves GET /api/services/{name}/instances.
//
// v1 stub: newtron does not yet expose a per-service instance listing endpoint.
// This handler is registered to produce the correct 503 with kind
// "newtron_unavailable" rather than a 404 (the route exists; the substrate does
// not yet back it).
//
// TODO(post-ship): implement once newtron exposes instance aggregate data. See
// API_CONTRACT.md §GET /api/services/{name}/instances lines 1381–1405.
func (h *servicesHandler) handleListInstances(w http.ResponseWriter, r *http.Request) {
	correlationID := h.correlationID(r.Context())
	types.WriteError(w, http.StatusServiceUnavailable,
		types.KindNewtronUnavailable,
		"instances endpoint not yet backed by newtron substrate in v1",
		map[string]any{
			"correlation_id":            correlationID,
			"newtron_url":               "",
			"last_reachable_at":         nil,
			"last_attempt_at":           nil,
			"underlying_error":          "upstream_unhealthy",
			"underlying_error_message":  "newtron substrate for per-service instance aggregates not yet available",
			"affected_nodes":            nil,
			"last_known":                map[string]any{"kind": "none", "captured_at": nil, "payload": nil},
			"next_action_hint":          map[string]any{"verb": "check_newtron_health", "endpoint": "/api/health", "suggested_after": nil, "rationale": "instances endpoint requires a future newtron substrate addition"},
			"rationale_ref":             map[string]any{"substrate": "CLAUDE.md#newtron-api-consumption-rule", "principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit"},
		},
	)
}

// handleListCandidates serves GET /api/services/{name}/candidates.
//
// v1 stub: newtron does not yet expose a candidates endpoint. This handler is
// registered to produce the correct 503 with kind "newtron_unavailable" rather
// than a 404 (the route exists; the substrate does not yet back it).
//
// TODO(post-ship): implement once newtron exposes candidate interface data. See
// API_CONTRACT.md §GET /api/services/{name}/candidates lines 1413–1443.
func (h *servicesHandler) handleListCandidates(w http.ResponseWriter, r *http.Request) {
	correlationID := h.correlationID(r.Context())
	types.WriteError(w, http.StatusServiceUnavailable,
		types.KindNewtronUnavailable,
		"candidates endpoint not yet backed by newtron substrate in v1",
		map[string]any{
			"correlation_id":            correlationID,
			"newtron_url":               "",
			"last_reachable_at":         nil,
			"last_attempt_at":           nil,
			"underlying_error":          "upstream_unhealthy",
			"underlying_error_message":  "newtron substrate for candidate interface listing not yet available",
			"affected_nodes":            nil,
			"last_known":                map[string]any{"kind": "none", "captured_at": nil, "payload": nil},
			"next_action_hint":          map[string]any{"verb": "check_newtron_health", "endpoint": "/api/health", "suggested_after": nil, "rationale": "candidates endpoint requires a future newtron substrate addition"},
			"rationale_ref":             map[string]any{"substrate": "CLAUDE.md#newtron-api-consumption-rule", "principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit"},
		},
	)
}

// writeServicesUnavailable is a helper that writes a 503 newtron_unavailable
// error per API_CONTRACT.md §details for kind: "newtron_unavailable"
// (lines 547–655).
//
// It exists because the same 503 shape must be written on ListServices failure
// and ShowService partial failure — two sites with identical structure. Without
// this helper, they would be the second instance of the same pattern
// (ai-instructions directive 7: "second instance of a pattern = stop and
// question"), so the helper is justified.
func writeServicesUnavailable(w http.ResponseWriter, correlationID string, err error, operation string) {
	// Classify the underlying error kind for the bounded "underlying_error" field
	// per API_CONTRACT.md §newtron_unavailable lines 566–568.
	underlyingKind := "http_5xx"
	if unavail, ok := err.(*newtronc.UnavailableError); ok {
		if unavail.StatusCode == 0 {
			underlyingKind = "connection_refused"
		}
	}

	types.WriteError(w, http.StatusServiceUnavailable,
		types.KindNewtronUnavailable,
		"newtron-server unreachable during "+operation+": "+err.Error(),
		map[string]any{
			"correlation_id":           correlationID,
			"newtron_url":              "",
			"last_reachable_at":        nil,
			"last_attempt_at":          nil,
			"underlying_error":         underlyingKind,
			"underlying_error_message": err.Error(),
			// affected_nodes is null for /api/services — it is not Node-scoped.
			// API_CONTRACT.md §newtron_unavailable line 616: "null for endpoints
			// that are not Node-scoped (e.g., /api/services listing)."
			"affected_nodes": nil,
			"last_known": map[string]any{
				// kind: "none" for /api/services 503 — no prior cache.
				// API_CONTRACT.md §newtron_unavailable line 635: "All other
				// endpoints → kind: 'none', payload is null."
				"kind":        "service_list",
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
				"substrate":  "CLAUDE.md#newtron-api-consumption-rule",
				"principle":  "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit",
			},
		},
	)
}

// Compile-time assertion: *newtronc.Client satisfies servicesNewtronClient.
// If newtronc.Client's Network/ListServices/ShowService signatures change,
// this line fails at build time — catching the mismatch before runtime.
var _ servicesNewtronClient = (*newtronc.Client)(nil)
