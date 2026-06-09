package newtronc_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// TestLabListLabs_Success verifies that LabListLabs proxies the
// newtlab GET /newtlab/v1/labs envelope and returns the raw data array.
func TestLabListLabs_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtlab/v1/labs" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":[{"name":"1node-vs"},{"name":"2node-vs-service"}],"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.LabListLabs(context.Background())
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	var items []map[string]string
	if err := json.Unmarshal(raw, &items); err != nil {
		t.Fatalf("decoding items: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}
	if items[0]["name"] != "1node-vs" {
		t.Errorf("expected first item name 1node-vs, got %q", items[0]["name"])
	}
}

// TestLabListLabs_Unavailable verifies that a 503 yields a
// *UnavailableError.
func TestLabListLabs_Unavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.LabListLabs(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*newtronc.UnavailableError); !ok {
		t.Errorf("expected *UnavailableError, got %T: %v", err, err)
	}
}

// TestLabStatus_Success verifies that LabStatus proxies the
// correct path and returns the LabState data.
func TestLabStatus_Success(t *testing.T) {
	const topoName = "2node-vs-service"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/newtlab/v1/labs/" + topoName + "/status"
		if r.URL.Path != expected {
			t.Errorf("unexpected path: want %s, got %s", expected, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"name":"2node-vs-service","nodes":{"switch1":{"status":"running","pid":1234,"ssh_port":10022,"console_port":10023,"original_mgmt_ip":""}}},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.LabStatus(context.Background(), topoName)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	var state map[string]any
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatalf("decoding state: %v", err)
	}
	if name, _ := state["name"].(string); name != "2node-vs-service" {
		t.Errorf("expected name 2node-vs-service, got %q", name)
	}
}

// TestLabStatus_NotFound verifies that a 404 yields a *NotFoundError.
func TestLabStatus_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintln(w, `{"error":"topology not found"}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.LabStatus(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*newtronc.NotFoundError); !ok {
		t.Errorf("expected *NotFoundError, got %T: %v", err, err)
	}
}

// TestLabDeploy_Success verifies that LabDeploy posts to the correct path and
// returns the 202 status code with the deploy response data.
func TestLabDeploy_Success(t *testing.T) {
	const topoName = "1node-vs"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/newtlab/v1/labs/" + topoName + "/deploy"
		if r.Method != http.MethodPost || r.URL.Path != expected {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		fmt.Fprintln(w, `{"data":{"topology":"1node-vs","started":"2026-05-31T12:00:00Z"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	status, raw, err := c.LabDeploy(context.Background(), topoName, newtronc.LabDeployRequest{})
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if status != http.StatusAccepted {
		t.Errorf("expected 202, got %d", status)
	}
	var resp map[string]any
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if name, _ := resp["topology"].(string); name != "1node-vs" {
		t.Errorf("expected topology 1node-vs, got %q", name)
	}
}

// TestLabDeploy_Conflict verifies that a 409 yields a *ConflictError (deploy
// already in progress).
func TestLabDeploy_Conflict(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		fmt.Fprintln(w, `{"error":"deploy already in progress"}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, _, err := c.LabDeploy(context.Background(), "1node-vs", newtronc.LabDeployRequest{})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*newtronc.ConflictError); !ok {
		t.Errorf("expected *ConflictError, got %T: %v", err, err)
	}
}

// TestLabStartNode_Success verifies that LabStartNode posts to the correct
// node-level path and returns the operation result.
func TestLabStartNode_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/newtlab/v1/labs/my-lab/nodes/switch1/start"
		if r.Method != http.MethodPost || r.URL.Path != expected {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"topology":"my-lab","node":"switch1","status":"started"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.LabStartNode(context.Background(), "my-lab", "switch1")
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	var resp map[string]any
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if st, _ := resp["status"].(string); st != "started" {
		t.Errorf("expected status started, got %q", st)
	}
}

// TestLabStopNode_Success verifies that LabStopNode posts to the correct path.
func TestLabStopNode_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/newtlab/v1/labs/my-lab/nodes/switch1/stop"
		if r.Method != http.MethodPost || r.URL.Path != expected {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"topology":"my-lab","node":"switch1","status":"stopped"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.LabStopNode(context.Background(), "my-lab", "switch1")
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	var resp map[string]any
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if st, _ := resp["status"].(string); st != "stopped" {
		t.Errorf("expected status stopped, got %q", st)
	}
}

// TestLabEventsRequest_Success verifies that LabEventsRequest returns an open
// *http.Response for an SSE stream (Content-Type: text/event-stream).
func TestLabEventsRequest_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := "/newtlab/v1/labs/my-lab/events"
		if r.URL.Path != expected {
			t.Errorf("unexpected path: want %s, got %s", expected, r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "event: phase")
		fmt.Fprintln(w, `data: {"phase":"boot","detail":"starting"}`)
		fmt.Fprintln(w, "")
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	resp, err := c.LabEventsRequest(context.Background(), "my-lab")
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

// TestLabEventsRequest_Unavailable verifies that a non-200 response from the
// events endpoint returns a *UnavailableError.
func TestLabEventsRequest_Unavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.LabEventsRequest(context.Background(), "no-such-lab")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*newtronc.UnavailableError); !ok {
		t.Errorf("expected *UnavailableError, got %T: %v", err, err)
	}
}
