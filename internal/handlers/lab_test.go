package handlers_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/handlers"
	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// newLabMux registers lab routes against a fake upstream server and returns
// the newtcon ServeMux. upstream is the fake newtlab-server.
func newLabMux(upstream *httptest.Server) *http.ServeMux {
	mux := http.NewServeMux()
	handlers.RegisterLabRoutes(mux, handlers.LabDeps{
		Client:        newtronc.New(upstream.URL),
		CorrelationID: func(_ context.Context) string { return "test-corr-id" },
	})
	return mux
}

// TestLabListLabs_Handler_Success verifies GET /api/labs returns
// the lab list from newtlab verbatim.
func TestLabListLabs_Handler_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtlab/v1/labs" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":[{"name":"1node-vs"},{"name":"2node-vs-service"}],"error":""}`)
	}))
	defer upstream.Close()

	mux := newLabMux(upstream)
	req := httptest.NewRequest(http.MethodGet, "/api/labs", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body: %s", rec.Code, rec.Body.String())
	}

	var items []map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&items); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 labs, got %d", len(items))
	}
	if items[0]["name"] != "1node-vs" {
		t.Errorf("expected first lab 1node-vs, got %q", items[0]["name"])
	}
}

// TestLabListLabs_Handler_Unavailable verifies that a newtlab 503
// results in a newtron_unavailable error envelope.
func TestLabListLabs_Handler_Unavailable(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer upstream.Close()

	mux := newLabMux(upstream)
	req := httptest.NewRequest(http.MethodGet, "/api/labs", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", rec.Code)
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

// TestLabStatus_Handler_Success verifies GET /api/labs/{name}/status
// returns the LabState from newtlab.
func TestLabStatus_Handler_Success(t *testing.T) {
	const labName = "2node-vs-service"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/newtlab/v1/labs/" + labName + "/status"
		if r.URL.Path != expected {
			t.Errorf("unexpected path: want %s, got %s", expected, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"name":"2node-vs-service","nodes":{}},"error":""}`)
	}))
	defer upstream.Close()

	mux := newLabMux(upstream)
	req := httptest.NewRequest(http.MethodGet, "/api/labs/"+labName+"/status", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body: %s", rec.Code, rec.Body.String())
	}
	var state map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&state); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if name, _ := state["name"].(string); name != "2node-vs-service" {
		t.Errorf("expected name 2node-vs-service, got %q", name)
	}
}

// TestLabStatus_Handler_NotFound verifies that a 404 from newtlab
// results in a precondition_failure error envelope.
func TestLabStatus_Handler_NotFound(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintln(w, `{"error":"not found"}`)
	}))
	defer upstream.Close()

	mux := newLabMux(upstream)
	req := httptest.NewRequest(http.MethodGet, "/api/labs/nonexistent/status", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
	var env map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decoding error envelope: %v", err)
	}
	errBlock, _ := env["error"].(map[string]any)
	if kind, _ := errBlock["kind"].(string); kind != "precondition_failure" {
		t.Errorf("error.kind: want precondition_failure, got %q", kind)
	}
}

// TestLabDeploy_Handler_Success verifies POST /api/labs/{name}/deploy
// returns 202 with the deploy response.
func TestLabDeploy_Handler_Success(t *testing.T) {
	const labName = "1node-vs"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/newtlab/v1/labs/" + labName + "/deploy"
		if r.Method != http.MethodPost || r.URL.Path != expected {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		fmt.Fprintln(w, `{"data":{"lab":"1node-vs","started":"2026-05-31T12:00:00Z"},"error":""}`)
	}))
	defer upstream.Close()

	mux := newLabMux(upstream)
	req := httptest.NewRequest(http.MethodPost, "/api/labs/"+labName+"/deploy",
		strings.NewReader(`{"provision":false}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if lab, _ := resp["lab"].(string); lab != "1node-vs" {
		t.Errorf("expected lab 1node-vs, got %q", lab)
	}
}

// TestLabDeploy_Handler_Conflict verifies that a 409 from newtlab results in a
// drift_refusal error (deploy already in progress).
func TestLabDeploy_Handler_Conflict(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		fmt.Fprintln(w, `{"error":"deploy already in progress"}`)
	}))
	defer upstream.Close()

	mux := newLabMux(upstream)
	req := httptest.NewRequest(http.MethodPost, "/api/labs/1node-vs/deploy", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", rec.Code)
	}
	var env map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decoding error envelope: %v", err)
	}
	errBlock, _ := env["error"].(map[string]any)
	if kind, _ := errBlock["kind"].(string); kind != "drift_refusal" {
		t.Errorf("error.kind: want drift_refusal, got %q", kind)
	}
}

// TestLabStartNode_Handler_Success verifies POST /api/labs/{name}/nodes/{node}/start
// returns 200 with the node start result.
func TestLabStartNode_Handler_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/newtlab/v1/labs/my-lab/nodes/switch1/start"
		if r.Method != http.MethodPost || r.URL.Path != expected {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"lab":"my-lab","node":"switch1","status":"started"},"error":""}`)
	}))
	defer upstream.Close()

	mux := newLabMux(upstream)
	req := httptest.NewRequest(http.MethodPost, "/api/labs/my-lab/nodes/switch1/start", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if st, _ := resp["status"].(string); st != "started" {
		t.Errorf("expected status started, got %q", st)
	}
}

// TestLabStopNode_Handler_Success verifies POST /api/labs/{name}/nodes/{node}/stop
// returns 200 with the node stop result.
func TestLabStopNode_Handler_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/newtlab/v1/labs/my-lab/nodes/switch1/stop"
		if r.Method != http.MethodPost || r.URL.Path != expected {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"lab":"my-lab","node":"switch1","status":"stopped"},"error":""}`)
	}))
	defer upstream.Close()

	mux := newLabMux(upstream)
	req := httptest.NewRequest(http.MethodPost, "/api/labs/my-lab/nodes/switch1/stop", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if st, _ := resp["status"].(string); st != "stopped" {
		t.Errorf("expected status stopped, got %q", st)
	}
}

// TestLabEvents_Handler_SSEPassthrough verifies GET /api/labs/{name}/events
// proxies the SSE stream from newtlab to the browser client line-by-line.
func TestLabEvents_Handler_SSEPassthrough(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/newtlab/v1/labs/my-lab/events"
		if r.URL.Path != expected {
			t.Errorf("unexpected path: want %s, got %s", expected, r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		// Write one complete SSE event and close.
		flusher, ok := w.(http.Flusher)
		if ok {
			flusher.Flush()
		}
		fmt.Fprintln(w, "event: phase")
		fmt.Fprintln(w, `data: {"phase":"boot","detail":"starting QEMU"}`)
		fmt.Fprintln(w, "")
	}))
	defer upstream.Close()

	mux := newLabMux(upstream)
	req := httptest.NewRequest(http.MethodGet, "/api/labs/my-lab/events", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body: %s", rec.Code, rec.Body.String())
	}
	ct := rec.Header().Get("Content-Type")
	if ct != "text/event-stream" {
		t.Errorf("Content-Type: want text/event-stream, got %q", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "event: phase") {
		t.Errorf("expected SSE event line in body, got: %q", body)
	}
	if !strings.Contains(body, "boot") {
		t.Errorf("expected boot phase in SSE data, got: %q", body)
	}
}

// TestLabDestroy_Handler_Success verifies POST /api/labs/{name}/destroy
// returns 200 with the destroy result.
func TestLabDestroy_Handler_Success(t *testing.T) {
	const labName = "my-lab"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/newtlab/v1/labs/" + labName + "/destroy"
		if r.Method != http.MethodPost || r.URL.Path != expected {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"lab":"my-lab","status":"destroyed"},"error":""}`)
	}))
	defer upstream.Close()

	mux := newLabMux(upstream)
	req := httptest.NewRequest(http.MethodPost, "/api/labs/"+labName+"/destroy", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if st, _ := resp["status"].(string); st != "destroyed" {
		t.Errorf("expected status destroyed, got %q", st)
	}
}

// TestLabProvision_Handler_Success verifies POST /api/labs/{name}/provision
// returns 200 with the provision result.
func TestLabProvision_Handler_Success(t *testing.T) {
	const labName = "my-lab"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/newtlab/v1/labs/" + labName + "/provision"
		if r.Method != http.MethodPost || r.URL.Path != expected {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"lab":"my-lab","status":"provisioned"},"error":""}`)
	}))
	defer upstream.Close()

	mux := newLabMux(upstream)
	req := httptest.NewRequest(http.MethodPost, "/api/labs/"+labName+"/provision", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if st, _ := resp["status"].(string); st != "provisioned" {
		t.Errorf("expected status provisioned, got %q", st)
	}
}
