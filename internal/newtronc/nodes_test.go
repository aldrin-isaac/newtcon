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
