package handlers_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/handlers"
	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/server"
)

// fakeNewtronServiceServer returns an httptest.Server that answers the two
// service endpoints newtronc uses.
//
// services is a map of name → service_type. The /service endpoint returns the
// names; the /service/{name} endpoint returns the typed detail.
//
// When a service name is in the failNames set, ShowService returns 503 to
// simulate a partial failure.
func fakeNewtronServiceServer(t *testing.T, services map[string]string, failNames map[string]bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// GET /network/default/service → list of names
		if r.URL.Path == "/newtron/v1/networks/default/services" {
			names := make([]string, 0, len(services))
			for name := range services {
				names = append(names, name)
			}
			jsonNames, _ := json.Marshal(names)
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"data":%s,"error":""}`, string(jsonNames))
			return
		}

		// GET /network/default/service/{name} → detail
		const prefix = "/newtron/v1/networks/default/services/"
		if len(r.URL.Path) > len(prefix) {
			name := r.URL.Path[len(prefix):]

			if failNames[name] {
				http.Error(w, "service unavailable", http.StatusServiceUnavailable)
				return
			}

			svcType, ok := services[name]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				fmt.Fprintf(w, `{"error":"service '%s' not found"}`, name)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"data":{"name":%q,"service_type":%q},"error":""}`, name, svcType)
			return
		}

		t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		http.Error(w, "unexpected path", http.StatusInternalServerError)
	}))
}

// withCorrelationID wraps a handler to inject a known correlation_id into the
// request context via server.WithCorrelationID. Used in tests to verify that
// error envelopes carry a populated correlation_id without needing the full
// middleware chain.
func withCorrelationID(next http.Handler, id string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := server.WithCorrelationID(r.Context(), id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// TestServices_Happy verifies the full GET /api/services response shape when
// newtron returns two services.
//
// Acceptance criteria verified:
//   - AC1: valid JSON matching API_CONTRACT.md §GET /api/services lines 1356–1379
//   - AC2: services[] sorted alphabetically by name
//   - instance_count: 0 (v1 honest zero per CLAUDE.md §No Hidden State)
//   - health: {healthy:0, degraded:0, failed:0}
//   - last_modified: "0001-01-01T00:00:00Z" (zero time.Time per RFC3339)
func TestServices_Happy(t *testing.T) {
	// Use a map with insertion order that is NOT alphabetical to verify sorting.
	// fakeNewtronServiceServer iterates the map non-deterministically, so the
	// handler must sort regardless of newtron's ordering.
	upstream := fakeNewtronServiceServer(t,
		map[string]string{
			"vpn":     "evpn-irb",
			"transit": "routed",
		},
		nil,
	)
	defer upstream.Close()

	nc := newtronc.New(upstream.URL)
	mux := http.NewServeMux()
	handlers.RegisterServicesRoutes(mux, handlers.ServicesDeps{Client: nc})

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/services", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body: %s", rec.Code, rec.Body.String())
	}

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decoding response: %v", err)
	}

	// Verify top-level "services" array is present.
	rawServices, ok := body["services"]
	if !ok {
		t.Fatal("response missing 'services' key")
	}
	serviceList, ok := rawServices.([]any)
	if !ok {
		t.Fatalf("'services' is not an array, got %T", rawServices)
	}
	if len(serviceList) != 2 {
		t.Fatalf("expected 2 services, got %d: %v", len(serviceList), serviceList)
	}

	// Verify alphabetical sort: "transit" before "vpn".
	first := serviceList[0].(map[string]any)
	second := serviceList[1].(map[string]any)

	if first["name"] != "transit" {
		t.Errorf("services[0].name: want \"transit\", got %v", first["name"])
	}
	if first["type"] != "routed" {
		t.Errorf("services[0].type: want \"routed\", got %v (verifies newtron's 'service_type' → contract's 'type' translation)", first["type"])
	}
	if v, _ := first["instance_count"].(float64); int(v) != 0 {
		t.Errorf("services[0].instance_count: want 0, got %v", v)
	}

	health, ok := first["health"].(map[string]any)
	if !ok {
		t.Fatal("services[0].health missing or wrong type")
	}
	for _, field := range []string{"healthy", "degraded", "failed"} {
		if v, _ := health[field].(float64); int(v) != 0 {
			t.Errorf("services[0].health.%s: want 0, got %v", field, v)
		}
	}

	// last_modified must be the zero time encoded per RFC3339.
	// time.Time{}.UTC() → "0001-01-01T00:00:00Z"
	if lm, _ := first["last_modified"].(string); lm != "0001-01-01T00:00:00Z" {
		t.Errorf("services[0].last_modified: want \"0001-01-01T00:00:00Z\", got %q", lm)
	}

	if second["name"] != "vpn" {
		t.Errorf("services[1].name: want \"vpn\", got %v", second["name"])
	}
	if second["type"] != "evpn-irb" {
		t.Errorf("services[1].type: want \"evpn-irb\", got %v", second["type"])
	}
}

// TestServices_NewtronUnavailable verifies that a 503 on the ListServices call
// propagates as a 503 newtron_unavailable with a non-empty details.correlation_id.
//
// Acceptance criterion 3 (newtcon#80): with newtron stopped, /api/services
// returns 503 with kind:"newtron_unavailable" and a populated
// details.correlation_id.
func TestServices_NewtronUnavailable(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer upstream.Close()

	nc := newtronc.New(upstream.URL)
	innerMux := http.NewServeMux()
	// Pass server.CorrelationIDFromContext as the CorrelationID extractor.
	// This matches the production wiring in router.go and verifies that the
	// correlation_id injected by withCorrelationID appears in the error details.
	handlers.RegisterServicesRoutes(innerMux, handlers.ServicesDeps{
		Client:        nc,
		CorrelationID: server.CorrelationIDFromContext,
	})

	// Wrap with correlation_id injection to verify it appears in the details.
	handler := withCorrelationID(innerMux, "test-correlation-id-unavail")

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/services", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d; body: %s", rec.Code, rec.Body.String())
	}

	var env map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decoding error envelope: %v", err)
	}

	errBlock, ok := env["error"].(map[string]any)
	if !ok {
		t.Fatal("response missing 'error' block")
	}
	if kind, _ := errBlock["kind"].(string); kind != "newtron_unavailable" {
		t.Errorf("error.kind: want \"newtron_unavailable\", got %q", kind)
	}

	details, ok := errBlock["details"].(map[string]any)
	if !ok {
		t.Fatal("error.details missing or wrong type")
	}
	if cid, _ := details["correlation_id"].(string); cid == "" {
		t.Error("details.correlation_id: want non-empty (must be populated by middleware or test wrapper)")
	}

	// Verify last_known.kind == "none" per API_CONTRACT.md §newtron_unavailable
	// line 635: "All other endpoints → kind: 'none', payload is null."
	// This assertion catches the Defect 3 regression: "service_list" is not a
	// bounded value in the last_known.kind enum.
	lastKnown, ok := details["last_known"].(map[string]any)
	if !ok {
		t.Fatal("details.last_known missing or wrong type")
	}
	if kind, _ := lastKnown["kind"].(string); kind != "none" {
		t.Errorf("details.last_known.kind: want \"none\" (per API_CONTRACT.md line 635), got %q", kind)
	}
}

// TestServices_ShowServiceFails_OneService verifies the fail-fast behaviour:
// when ListServices succeeds but ShowService fails for one service, the whole
// handler returns 503 rather than partial data.
//
// Binding decision: partial data without a Confidence object is dishonest per
// CLAUDE.md §No Hidden State. See newtcon#80 §Risks resolved.
func TestServices_ShowServiceFails_OneService(t *testing.T) {
	// "transit" will succeed; "vpn" will trigger 503 on ShowService.
	// Note: because map iteration is non-deterministic, the handler may process
	// "vpn" or "transit" first. Either way, when "vpn" is encountered, the
	// handler must fail-fast and return 503.
	upstream := fakeNewtronServiceServer(t,
		map[string]string{
			"transit": "routed",
			"vpn":     "evpn-irb",
		},
		map[string]bool{"vpn": true}, // vpn ShowService returns 503
	)
	defer upstream.Close()

	nc := newtronc.New(upstream.URL)
	mux := http.NewServeMux()
	handlers.RegisterServicesRoutes(mux, handlers.ServicesDeps{Client: nc})

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/services", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d; body: %s", rec.Code, rec.Body.String())
	}

	var env map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decoding error envelope: %v", err)
	}
	errBlock, ok := env["error"].(map[string]any)
	if !ok {
		t.Fatal("response missing 'error' block")
	}
	if kind, _ := errBlock["kind"].(string); kind != "newtron_unavailable" {
		t.Errorf("error.kind: want \"newtron_unavailable\", got %q", kind)
	}
}

// TestServices_MethodNotAllowed verifies that POST /api/services returns 405.
//
// The Go 1.22 ServeMux method+path pattern "GET /api/services" enforces this
// at the router level. We exercise it via a mux that mirrors the production
// registration.
func TestServices_MethodNotAllowed(t *testing.T) {
	nc := newtronc.New("http://127.0.0.1:1") // unreachable; never called for 405
	mux := http.NewServeMux()
	handlers.RegisterServicesRoutes(mux, handlers.ServicesDeps{Client: nc})

	req := httptest.NewRequest(http.MethodPost, "/api/networks/default/services", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /api/services: expected 405, got %d", rec.Code)
	}
}

// TestServices_Empty verifies that GET /api/services returns {"services":[]}
// (empty array, not null) when newtron has no registered services.
func TestServices_Empty(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/newtron/v1/networks/default/services" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintln(w, `{"data":[],"error":""}`)
			return
		}
		t.Errorf("unexpected ShowService call: %s", r.URL.Path)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	defer upstream.Close()

	nc := newtronc.New(upstream.URL)
	mux := http.NewServeMux()
	handlers.RegisterServicesRoutes(mux, handlers.ServicesDeps{Client: nc})

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/services", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body: %s", rec.Code, rec.Body.String())
	}

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decoding response: %v", err)
	}

	rawServices, ok := body["services"]
	if !ok {
		t.Fatal("response missing 'services' key")
	}
	serviceList, ok := rawServices.([]any)
	if !ok {
		t.Fatalf("'services' is not an array: %T", rawServices)
	}
	if len(serviceList) != 0 {
		t.Errorf("expected empty services array, got %d items", len(serviceList))
	}
}

// Compile-time: verify time.Time{} encodes to "0001-01-01T00:00:00Z" per RFC3339.
// This is the expected value of last_modified in v1.
var _ = func() string { return time.Time{}.UTC().Format(time.RFC3339) }()

// TestServices_AuthorizationDenied verifies that a 403 from newtron with the
// typed AuthorizationError envelope (newtron PR #133 / newtcon#143) surfaces
// at the newtcon edge as a 403 KindAuthorizationFailure response with
// caller / permission / resource in details — operator-honest, not
// "unexpected status 403".
func TestServices_AuthorizationDenied(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		envelope := map[string]any{
			"data": map[string]string{
				"caller":     "alice",
				"permission": "spec.read",
				"resource":   "default",
			},
			"error": "authorization denied: alice lacks spec.read on default",
		}
		body, _ := json.Marshal(envelope)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write(body)
	}))
	defer upstream.Close()

	nc := newtronc.New(upstream.URL)
	mux := http.NewServeMux()
	handlers.RegisterServicesRoutes(mux, handlers.ServicesDeps{Client: nc})

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/services", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d; body: %s", rec.Code, rec.Body.String())
	}

	var env map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	errBlock, ok := env["error"].(map[string]any)
	if !ok {
		t.Fatal("response missing 'error' block")
	}
	if kind, _ := errBlock["kind"].(string); kind != "authorization_failure" {
		t.Errorf("error.kind: want %q, got %q", "authorization_failure", kind)
	}
	msg, _ := errBlock["message"].(string)
	if !strings.Contains(msg, "alice lacks spec.read on default") {
		t.Errorf("error.message should contain the operator-honest text, got %q", msg)
	}

	details, ok := errBlock["details"].(map[string]any)
	if !ok {
		t.Fatal("error.details missing or wrong type")
	}
	if got, _ := details["caller"].(string); got != "alice" {
		t.Errorf("details.caller: want %q, got %q", "alice", got)
	}
	if got, _ := details["permission"].(string); got != "spec.read" {
		t.Errorf("details.permission: want %q, got %q", "spec.read", got)
	}
	if got, _ := details["resource"].(string); got != "default" {
		t.Errorf("details.resource: want %q, got %q", "default", got)
	}
}
