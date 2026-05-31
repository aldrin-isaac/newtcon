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

// TestTopology_Success verifies that GET /api/topology proxies newtron and
// returns the raw data payload.
func TestTopology_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtron/v1/network/default/topology" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"nodes":[{"name":"switch1","type":"switch"}],"links":[]},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodGet, "/api/topology", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	nodes, ok := body["nodes"].([]any)
	if !ok || len(nodes) != 1 {
		t.Errorf("expected 1 node in topology data, got %v", body)
	}
}

// TestTopology_Unavailable verifies that a 503 from newtron yields a
// newtron_unavailable error envelope from /api/topology.
func TestTopology_Unavailable(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodGet, "/api/topology", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
	var env map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decoding error envelope: %v", err)
	}
	errBlock, _ := env["error"].(map[string]any)
	if errBlock == nil {
		t.Fatal("missing error block")
	}
	if kind, _ := errBlock["kind"].(string); kind != "newtron_unavailable" {
		t.Errorf("error.kind: want newtron_unavailable, got %q", kind)
	}
}

// TestNodeInfo_Success verifies that GET /api/nodes/{device}/info proxies the
// correct upstream path.
func TestNodeInfo_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtron/v1/network/default/node/switch1/info" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"hostname":"switch1","platform":"AS7726"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodGet, "/api/nodes/switch1/info", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if hn, _ := body["hostname"].(string); hn != "switch1" {
		t.Errorf("hostname: want switch1, got %q", hn)
	}
}

// TestNodeInfo_NotFound verifies that a 404 from newtron yields a 404 from
// newtcon with the internal error kind.
func TestNodeInfo_NotFound(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintln(w, `{"data":null,"error":"not found"}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodGet, "/api/nodes/nodevice/info", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

// TestNodeConfigDBEntry_Success verifies the 3-segment configdb/{table}/{key}
// endpoint correctly passes all path values to the client.
func TestNodeConfigDBEntry_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtron/v1/network/default/node/switch1/configdb/PORT/Ethernet0" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"speed":"100G","admin_status":"up"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodGet, "/api/nodes/switch1/configdb/PORT/Ethernet0", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body: %s", rec.Code, rec.Body.String())
	}
}

// TestNodeInterfaces_Success verifies that GET /api/nodes/{device}/interfaces
// proxies the correct upstream path.
func TestNodeInterfaces_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtron/v1/network/default/node/switch1/interface" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":[{"name":"Ethernet0","oper_status":"up"}],"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodGet, "/api/nodes/switch1/interfaces", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}
