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

// TestSchema_CacheHeaders_Relay — upstream Last-Modified flows to
// browser; browser If-Modified-Since flows back upstream; upstream
// 304 propagates to browser as 304.
func TestSchema_CacheHeaders_Relay(t *testing.T) {
	const upstreamLastMod = "Mon, 19 Jun 2026 22:10:15 GMT"
	var seenIfMod string
	var upstreamCalls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		seenIfMod = r.Header.Get("If-Modified-Since")
		w.Header().Set("Last-Modified", upstreamLastMod)
		if seenIfMod == upstreamLastMod {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"schemas":[]},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterSchemaRoutes(mux, handlers.SchemaDeps{
		Client:        newtronc.New(upstream.URL),
		CorrelationID: constCID,
	})

	// Pass 1 — no If-Modified-Since. Expect 200 + Last-Modified relayed.
	req := httptest.NewRequest(http.MethodGet, "/api/schema/all", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("pass 1: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	gotLM := rec.Header().Get("Last-Modified")
	if gotLM != upstreamLastMod {
		t.Errorf("pass 1: Last-Modified not relayed; want %q got %q", upstreamLastMod, gotLM)
	}
	if rec.Header().Get("Cache-Control") == "" {
		t.Errorf("pass 1: Cache-Control header missing")
	}
	if seenIfMod != "" {
		t.Errorf("pass 1: upstream saw unexpected If-Modified-Since %q", seenIfMod)
	}

	// Pass 2 — browser sends If-Modified-Since matching upstream's
	// Last-Modified. Expect newtcon to forward the header upstream and
	// propagate the 304 back to the browser.
	req2 := httptest.NewRequest(http.MethodGet, "/api/schema/all", nil)
	req2.Header.Set("If-Modified-Since", upstreamLastMod)
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusNotModified {
		t.Fatalf("pass 2: expected 304, got %d: %s", rec2.Code, rec2.Body.String())
	}
	if seenIfMod != upstreamLastMod {
		t.Errorf("pass 2: upstream did not see relayed If-Modified-Since; got %q", seenIfMod)
	}
	if rec2.Body.Len() != 0 {
		t.Errorf("pass 2: 304 response should have empty body, got %d bytes", rec2.Body.Len())
	}
	if upstreamCalls != 2 {
		t.Errorf("expected 2 upstream calls (one per pass), got %d", upstreamCalls)
	}
}
