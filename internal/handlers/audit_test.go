package handlers_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/handlers"
	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// TestAuditEvents_ForwardsFilters verifies the events handler forwards
// the query string verbatim to newtron and returns the data payload.
func TestAuditEvents_ForwardsFilters(t *testing.T) {
	var seenQuery string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtron/v1/networks/default/audit/events" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		seenQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":{"events":[{"id":"abc","user":"alice","success":true}],"total":1},"error":""}`))
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterAuditRoutes(mux, handlers.AuditDeps{Client: newtronc.New(upstream.URL)})

	req := httptest.NewRequest(http.MethodGet,
		"/api/networks/default/audit/events?user=alice&since=2026-06-17T00:00:00Z&limit=50", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if seenQuery != "user=alice&since=2026-06-17T00:00:00Z&limit=50" {
		t.Errorf("upstream did not see verbatim query: %s", seenQuery)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"user":"alice"`)) {
		t.Errorf("response body missing forwarded data: %s", rec.Body.String())
	}
}

// TestAuditEvents_404_AuditLogDisabled verifies that newtron's 404
// (the server was started without --audit-log) propagates so the
// renderer can show "audit logging is disabled".
func TestAuditEvents_404_AuditLogDisabled(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"data":null,"error":"audit log not configured"}`, http.StatusNotFound)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterAuditRoutes(mux, handlers.AuditDeps{Client: newtronc.New(upstream.URL)})

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/audit/events", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestAuditEvents_400_FilterValidation verifies newtron's malformed-
// filter 400 propagates as validation_failure.
func TestAuditEvents_400_FilterValidation(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"data":null,"error":"invalid since: not-a-date"}`, http.StatusBadRequest)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterAuditRoutes(mux, handlers.AuditDeps{Client: newtronc.New(upstream.URL)})

	req := httptest.NewRequest(http.MethodGet,
		"/api/networks/default/audit/events?since=not-a-date", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	var env map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decoding envelope: %v", err)
	}
	errBlock, _ := env["error"].(map[string]any)
	if errBlock == nil {
		t.Fatal("missing error block")
	}
	if kind, _ := errBlock["kind"].(string); kind != "validation_failure" {
		t.Errorf("error.kind: want validation_failure, got %q", kind)
	}
}

// TestAuditIntegrity_ForwardsResult verifies the integrity handler
// returns newtron's payload verbatim.
func TestAuditIntegrity_ForwardsResult(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtron/v1/networks/default/audit/integrity" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":{"chain_head_hash":"abc123","entry_count":42,"break_at":0,"break_reason":"","verified_at":"2026-06-17T07:34:43Z"},"error":""}`))
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterAuditRoutes(mux, handlers.AuditDeps{Client: newtronc.New(upstream.URL)})

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/audit/integrity", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"chain_head_hash":"abc123"`)) {
		t.Errorf("response missing integrity data: %s", rec.Body.String())
	}
}
