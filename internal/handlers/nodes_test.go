package handlers_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
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
		if r.URL.Path != "/newtron/v1/networks/default/topology" {
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

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/topology", nil)
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
// newtron_unavailable error envelope from /api/networks/{netID}/topology.
func TestTopology_Unavailable(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/topology", nil)
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
		if r.URL.Path != "/newtron/v1/networks/default/nodes/switch1/info" {
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

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/nodes/switch1/info", nil)
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

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/nodes/nodevice/info", nil)
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
		if r.URL.Path != "/newtron/v1/networks/default/nodes/switch1/configdb/PORT/Ethernet0" {
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

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/nodes/switch1/configdb/PORT/Ethernet0", nil)
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
		if r.URL.Path != "/newtron/v1/networks/default/nodes/switch1/interfaces" {
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

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/nodes/switch1/interfaces", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

// ============================================================================
// Topology write handlers
// ============================================================================

// TestCreateTopologyDevice_Success verifies that POST /api/topology/nodes
// forwards to newtron's create-node and returns 201 with the data payload.
func TestCreateTopologyDevice_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/topology/create-node" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"steps":[],"ports":{}},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	body, _ := json.Marshal(map[string]any{"name": "spine1", "device": map[string]any{}})
	req := httptest.NewRequest(http.MethodPost, "/api/networks/default/topology/nodes", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestCreateTopologyDevice_ValidationError verifies that a 400 from newtron
// returns a validation_failure envelope.
func TestCreateTopologyDevice_ValidationError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"data":null,"error":"name required"}`, http.StatusBadRequest)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	body, _ := json.Marshal(map[string]any{})
	req := httptest.NewRequest(http.MethodPost, "/api/networks/default/topology/nodes", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	var env map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decoding error envelope: %v", err)
	}
	errBlock, _ := env["error"].(map[string]any)
	if errBlock == nil {
		t.Fatal("missing error block")
	}
	if kind, _ := errBlock["kind"].(string); kind != "validation_failure" {
		t.Errorf("error.kind: want validation_failure, got %q", kind)
	}
}

// TestDeleteTopologyDevice_Success verifies that DELETE /api/topology/nodes/{name}
// forwards to newtron's DELETE topology/node/{name} and returns 200.
func TestDeleteTopologyDevice_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/newtron/v1/networks/default/topology/nodes/spine1" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"deleted":"spine1"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodDelete, "/api/networks/default/topology/nodes/spine1", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestUpdateTopologyDevice_Success verifies that PUT /api/topology/nodes/{name}
// forwards to newtron's PUT topology/node/{name}.
func TestUpdateTopologyDevice_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/newtron/v1/networks/default/topology/nodes/spine1" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"steps":[],"ports":{}},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	body, _ := json.Marshal(map[string]any{"steps": []any{}})
	req := httptest.NewRequest(http.MethodPut, "/api/networks/default/topology/nodes/spine1", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestCreateTopologyLink_Success verifies that POST /api/topology/links
// forwards to newtron's create-link and returns 201.
func TestCreateTopologyLink_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/topology/create-link" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"a":"spine1:Ethernet0","z":"leaf1:Ethernet0"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	body, _ := json.Marshal(map[string]string{"a": "spine1:Ethernet0", "z": "leaf1:Ethernet0"})
	req := httptest.NewRequest(http.MethodPost, "/api/networks/default/topology/links", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestDeleteTopologyLink_Success verifies that DELETE /api/topology/links/{device}/{interface}
// (newtcon's own REST surface) forwards to newtron's POST topology/delete-link
// with the colon-joined endpoint in the body (newtron #426).
func TestDeleteTopologyLink_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/topology/delete-link" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"deleted":"spine1:Ethernet0"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodDelete, "/api/networks/default/topology/links/spine1/Ethernet0", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

// ============================================================================
// Interface binding handlers
// ============================================================================

// TestBindService_Success verifies that POST /api/nodes/{device}/interfaces/{name}/bind-service
// forwards to newtron's apply-service.
func TestBindService_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := "/newtron/v1/networks/default/nodes/switch1/interfaces/Ethernet0/apply-service"
		if r.Method != http.MethodPost || r.URL.Path != want {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"ok"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	body, _ := json.Marshal(map[string]any{"service": "transit", "vlan": 100})
	req := httptest.NewRequest(http.MethodPost,
		"/api/networks/default/nodes/switch1/interfaces/Ethernet0/bind-service", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestUnbindService_Success verifies that POST .../unbind-service forwards to
// newtron's remove-service (no body).
func TestUnbindService_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := "/newtron/v1/networks/default/nodes/switch1/interfaces/Ethernet0/remove-service"
		if r.Method != http.MethodPost || r.URL.Path != want {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"ok"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodPost,
		"/api/networks/default/nodes/switch1/interfaces/Ethernet0/unbind-service", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestRefreshService_Success verifies that POST .../refresh-service forwards
// to newtron's refresh-service (no body).
func TestRefreshService_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := "/newtron/v1/networks/default/nodes/switch1/interfaces/Ethernet0/refresh-service"
		if r.Method != http.MethodPost || r.URL.Path != want {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"ok"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodPost,
		"/api/networks/default/nodes/switch1/interfaces/Ethernet0/refresh-service", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestBindService_Unavailable verifies that a newtron_unavailable error is
// returned when newtron is unreachable for bind-service.
func TestBindService_Unavailable(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	body, _ := json.Marshal(map[string]any{"service": "transit"})
	req := httptest.NewRequest(http.MethodPost,
		"/api/networks/default/nodes/switch1/interfaces/Ethernet0/bind-service", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
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

// TestProjectionDiff_ForwardsBody verifies the projection-diff handler
// forwards the request body verbatim to newtron and returns the diff
// payload to the client. Covers slice #171.B.
func TestProjectionDiff_ForwardsBody(t *testing.T) {
	var seenBody []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/nodes/r1/intent/projection-diff" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		seenBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, `{"data":{"before":{},"after":{},"diff":[{"table":"VLAN","key":"100","change":"create"}]},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	body, _ := json.Marshal(map[string]any{
		"operations": []map[string]any{
			{"url": "/create-vlan", "params": map[string]any{"vlan_id": 100}},
		},
	})
	req := httptest.NewRequest(http.MethodPost,
		"/api/networks/default/nodes/r1/projection-diff", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(seenBody, []byte("create-vlan")) {
		t.Errorf("upstream did not see the operations body: got %s", seenBody)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"change":"create"`)) {
		t.Errorf("response missing diff: %s", rec.Body.String())
	}
}

// TestProjectionDiff_MalformedJSON verifies a 400 validation_failure
// when the request body isn't JSON. Doesn't reach upstream.
func TestProjectionDiff_MalformedJSON(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("upstream should not be called for malformed JSON; got %s %s", r.Method, r.URL.Path)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNodesRoutes(mux, handlers.NodesDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodPost,
		"/api/networks/default/nodes/r1/projection-diff",
		bytes.NewReader([]byte("not-json")))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	var env map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decoding error envelope: %v", err)
	}
	errBlock, _ := env["error"].(map[string]any)
	if errBlock == nil {
		t.Fatal("missing error block")
	}
	if kind, _ := errBlock["kind"].(string); kind != "validation_failure" {
		t.Errorf("error.kind: want validation_failure, got %q", kind)
	}
}
