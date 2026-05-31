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

// TestClient_Topology_Success verifies that Topology proxies the newtron
// GET /network/{netID}/topology envelope and returns the raw data field.
func TestClient_Topology_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtron/v1/network/default/topology" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"nodes":[],"links":[]},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.Topology(context.Background(), "default")
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil RawMessage")
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("decoding raw: %v", err)
	}
}

// TestClient_Topology_Unavailable verifies that a 503 from newtron yields
// a *UnavailableError.
func TestClient_Topology_Unavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.Topology(context.Background(), "default")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*newtronc.UnavailableError); !ok {
		t.Errorf("expected *UnavailableError, got %T: %v", err, err)
	}
}

// TestClient_NodeInfo_Success verifies that NodeInfo proxies the correct path
// and returns the decoded data field.
func TestClient_NodeInfo_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtron/v1/network/default/node/switch1/info" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"hostname":"switch1"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.NodeInfo(context.Background(), "default", "switch1")
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil RawMessage")
	}
}

// TestClient_NodeInfo_NotFound verifies that a 404 from newtron yields
// a *NotFoundError.
func TestClient_NodeInfo_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"data":null,"error":"not found"}`, http.StatusNotFound)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.NodeInfo(context.Background(), "default", "nodevice")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*newtronc.NotFoundError); !ok {
		t.Errorf("expected *NotFoundError, got %T: %v", err, err)
	}
}

// TestClient_NodeConfigDBEntry_Success verifies that NodeConfigDBEntry builds
// the correct 3-segment URL.
func TestClient_NodeConfigDBEntry_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtron/v1/network/default/node/switch1/configdb/PORT/Ethernet0" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"speed":"100G"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.NodeConfigDBEntry(context.Background(), "default", "switch1", "PORT", "Ethernet0")
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil RawMessage")
	}
}

// ============================================================================
// Topology write operations
// ============================================================================

// TestClient_CreateTopologyDevice_Success verifies that CreateTopologyDevice
// sends POST to the correct path with the JSON body and returns the data field.
func TestClient_CreateTopologyDevice_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/network/default/topology/create-node" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("expected Content-Type application/json, got %s", r.Header.Get("Content-Type"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"steps":[],"ports":{}},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	body := map[string]any{"name": "spine1", "device": map[string]any{}}
	raw, err := c.CreateTopologyDevice(context.Background(), "default", body)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil RawMessage")
	}
}

// TestClient_CreateTopologyDevice_ValidationError verifies that a 400 from
// newtron yields a *ValidationError.
func TestClient_CreateTopologyDevice_ValidationError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"data":null,"error":"name required"}`, http.StatusBadRequest)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.CreateTopologyDevice(context.Background(), "default", map[string]any{})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*newtronc.ValidationError); !ok {
		t.Errorf("expected *ValidationError, got %T: %v", err, err)
	}
}

// TestClient_DeleteTopologyDevice_Success verifies that DeleteTopologyDevice
// sends DELETE to the correct path and returns data.
func TestClient_DeleteTopologyDevice_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/network/default/topology/node/spine1" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"deleted":"spine1"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.DeleteTopologyDevice(context.Background(), "default", "spine1", false)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil RawMessage")
	}
}

// TestClient_DeleteTopologyDevice_Force verifies that force=true adds the
// query parameter.
func TestClient_DeleteTopologyDevice_Force(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("force") != "true" {
			t.Errorf("expected force=true query param, got: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"deleted":"spine1"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.DeleteTopologyDevice(context.Background(), "default", "spine1", true)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
}

// TestClient_UpdateTopologyDevice_Success verifies that UpdateTopologyDevice
// sends PUT with a JSON body.
func TestClient_UpdateTopologyDevice_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/network/default/topology/node/spine1" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"steps":[],"ports":{}},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.UpdateTopologyDevice(context.Background(), "default", "spine1", map[string]any{"steps": []any{}})
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil RawMessage")
	}
}

// TestClient_CreateTopologyLink_Success verifies that CreateTopologyLink sends
// POST to create-link with the {a,z} body.
func TestClient_CreateTopologyLink_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/network/default/topology/create-link" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"a":"spine1:Ethernet0","z":"leaf1:Ethernet0"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	body := map[string]string{"a": "spine1:Ethernet0", "z": "leaf1:Ethernet0"}
	raw, err := c.CreateTopologyLink(context.Background(), "default", body)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil RawMessage")
	}
}

// TestClient_DeleteTopologyLink_Success verifies that DeleteTopologyLink sends
// DELETE to the link/{device}/{interface} path.
func TestClient_DeleteTopologyLink_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/network/default/topology/link/spine1/Ethernet0" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"deleted":"spine1:Ethernet0"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.DeleteTopologyLink(context.Background(), "default", "spine1", "Ethernet0")
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil RawMessage")
	}
}

// ============================================================================
// Interface binding operations
// ============================================================================

// TestClient_ApplyService_Success verifies that ApplyService sends POST to
// the apply-service path with the JSON body.
func TestClient_ApplyService_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wantPath := "/network/default/node/switch1/interface/Ethernet0/apply-service"
		if r.Method != http.MethodPost || r.URL.Path != wantPath {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"ok"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	body := map[string]any{"service": "transit", "vlan": 100}
	raw, err := c.ApplyService(context.Background(), "default", "switch1", "Ethernet0", body)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil RawMessage")
	}
}

// TestClient_RemoveService_Success verifies that RemoveService sends POST to
// the remove-service path (no body).
func TestClient_RemoveService_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wantPath := "/network/default/node/switch1/interface/Ethernet0/remove-service"
		if r.Method != http.MethodPost || r.URL.Path != wantPath {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"ok"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.RemoveService(context.Background(), "default", "switch1", "Ethernet0")
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil RawMessage")
	}
}

// TestClient_RefreshService_Success verifies that RefreshService sends POST to
// the refresh-service path (no body).
func TestClient_RefreshService_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wantPath := "/network/default/node/switch1/interface/Ethernet0/refresh-service"
		if r.Method != http.MethodPost || r.URL.Path != wantPath {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"ok"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.RefreshService(context.Background(), "default", "switch1", "Ethernet0")
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil RawMessage")
	}
}
