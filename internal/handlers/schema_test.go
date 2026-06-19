package handlers_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/handlers"
	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// constCID is the simplest CorrelationID source — fine for tests
// where we don't assert on the correlation header.
func constCID(_ context.Context) string { return "test-cid" }

// TestSchema_KindsListPassthrough — GET /api/schema forwards the
// upstream payload byte-for-byte once the envelope is unwrapped.
func TestSchema_KindsListPassthrough(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtron/v1/schema" {
			t.Errorf("unexpected upstream path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"kinds":[{"kind":"ZoneSpec","label":"Zone","description":""}]},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterSchemaRoutes(mux, handlers.SchemaDeps{
		Client:        newtronc.New(upstream.URL),
		CorrelationID: constCID,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/schema", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"kind":"ZoneSpec"`) {
		t.Errorf("kinds payload not forwarded: %s", rec.Body.String())
	}
}

// TestSchema_PerKindPassthrough — GET /api/schema/{kind} forwards
// newtron's per-kind shape so the browser sees enum/item_type/ref_kind
// fields verbatim.
func TestSchema_PerKindPassthrough(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtron/v1/schema/IPVPNSpec" {
			t.Errorf("unexpected upstream path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{
			"kind":"IPVPNSpec","label":"IP-VPN","description":"",
			"fields":[{"name":"l3vni","label":"L3VNI","type":"int","required":true}]
		},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterSchemaRoutes(mux, handlers.SchemaDeps{
		Client:        newtronc.New(upstream.URL),
		CorrelationID: constCID,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/schema/IPVPNSpec", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"kind":"IPVPNSpec"`) {
		t.Errorf("per-kind payload not forwarded: %s", rec.Body.String())
	}
}

// TestSchema_UnknownKindBubbles404 — newtron's 404 propagates to the
// browser via the upstream-error mapper.
func TestSchema_UnknownKindBubbles404(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterSchemaRoutes(mux, handlers.SchemaDeps{
		Client:        newtronc.New(upstream.URL),
		CorrelationID: constCID,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/schema/NoSuchKind", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 to propagate, got %d: %s", rec.Code, rec.Body.String())
	}
}
