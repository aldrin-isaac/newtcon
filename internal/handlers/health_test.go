package handlers_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/handlers"
	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// TestHealth_Reachable verifies the full HealthResponse shape when newtron-server
// is reachable (upstream returns {"data":[]}).
//
// Contract reference: API_CONTRACT.md §GET /api/health lines 1311–1354.
func TestHealth_Reachable(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":[],"error":""}`)
	}))
	defer upstream.Close()

	nc := newtronc.New(upstream.URL)
	cfg := handlers.HealthConfig{
		NewtronClient: nc,
		NewtronURL:    upstream.URL,
	}
	h := handlers.NewHealthHandler(cfg)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decoding response: %v", err)
	}

	// status: "ok"
	if got, _ := body["status"].(string); got != "ok" {
		t.Errorf("status: want \"ok\", got %q", got)
	}

	// newtron.reachable: true
	newtronBlock, _ := body["newtron"].(map[string]any)
	if newtronBlock == nil {
		t.Fatal("missing newtron block")
	}
	if reachable, _ := newtronBlock["reachable"].(bool); !reachable {
		t.Error("newtron.reachable: want true")
	}

	// newtron.url: upstream.URL
	if url, _ := newtronBlock["url"].(string); url != upstream.URL {
		t.Errorf("newtron.url: want %q, got %q", upstream.URL, url)
	}

	// operations_retention.source: "newtcon_operations_store"
	ret, _ := body["operations_retention"].(map[string]any)
	if ret == nil {
		t.Fatal("missing operations_retention block")
	}
	if src, _ := ret["source"].(string); src != "newtcon_operations_store" {
		t.Errorf("operations_retention.source: want \"newtcon_operations_store\", got %q", src)
	}

	// operations_retention.terminal_floor_seconds: 2592000
	if v, _ := ret["terminal_floor_seconds"].(float64); int(v) != 2592000 {
		t.Errorf("operations_retention.terminal_floor_seconds: want 2592000, got %v", v)
	}
}

// TestHealth_Unreachable verifies that when newtron-server is unavailable the
// handler still returns HTTP 200 with newtron.reachable: false.
//
// API_CONTRACT.md line 1337: "If newtron-server is unreachable, reachable is
// false and the endpoint still returns 200."
func TestHealth_Unreachable(t *testing.T) {
	// Genuinely unreachable = nothing listening. (A 5xx/401 is the daemon
	// answering and is reachable — see newtronc.TestClient_Health_AuthGuarded.)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := upstream.URL
	upstream.Close()

	nc := newtronc.New(deadURL)
	cfg := handlers.HealthConfig{
		NewtronClient: nc,
		NewtronURL:    upstream.URL,
	}
	h := handlers.NewHealthHandler(cfg)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decoding response: %v", err)
	}

	newtronBlock, _ := body["newtron"].(map[string]any)
	if newtronBlock == nil {
		t.Fatal("missing newtron block")
	}
	if reachable, _ := newtronBlock["reachable"].(bool); reachable {
		t.Error("newtron.reachable: want false when upstream is unavailable")
	}
}

// TestHealth_MethodNotAllowed verifies that POST /api/health is rejected with 405.
//
// The Go 1.22 ServeMux method+path pattern "GET /api/health" enforces the
// method constraint at the router level. We exercise this via a minimal mux
// that mirrors the production registration in router.go.
func TestHealth_MethodNotAllowed(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":[],"error":""}`)
	}))
	defer upstream.Close()

	nc := newtronc.New(upstream.URL)
	cfg := handlers.HealthConfig{
		NewtronClient: nc,
		NewtronURL:    upstream.URL,
	}

	// Register with the same method+path pattern used in router.go so the mux
	// enforces the 405 for non-GET methods.
	mux := http.NewServeMux()
	mux.Handle("GET /api/health", handlers.NewHealthHandler(cfg))

	req := httptest.NewRequest(http.MethodPost, "/api/health", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /api/health: expected 405, got %d", rec.Code)
	}
}
