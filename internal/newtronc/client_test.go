package newtronc_test

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// TestClient_ListNetworks_Success verifies that ListNetworks parses the newtron
// APIResponse envelope and returns the network IDs.
//
// Substrate: GET /network confirmed at pkg/newtron/api/handler.go:23.
func TestClient_ListNetworks_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/network" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":[{"id":"default"}],"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	ids, err := c.ListNetworks(context.Background())
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if len(ids) != 1 || ids[0] != "default" {
		t.Errorf("expected [\"default\"], got %v", ids)
	}
}

// TestClient_ListNetworks_Unreachable verifies that a 503 from newtron-server
// yields a *UnavailableError.
func TestClient_ListNetworks_Unreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.ListNetworks(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var unavail *newtronc.UnavailableError
	if ok := asUnavailableError(err, &unavail); !ok {
		t.Errorf("expected *UnavailableError, got %T: %v", err, err)
	}
}

// TestClient_ListNetworks_TransportError verifies that a transport-level failure
// (connection refused to a closed listener) yields a *UnavailableError.
func TestClient_ListNetworks_TransportError(t *testing.T) {
	// Open a listener then immediately close it so the port is guaranteed refused.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to open listener: %v", err)
	}
	addr := l.Addr().String()
	l.Close()

	c := newtronc.New("http://" + addr)
	_, err = c.ListNetworks(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var unavail *newtronc.UnavailableError
	if ok := asUnavailableError(err, &unavail); !ok {
		t.Errorf("expected *UnavailableError, got %T: %v", err, err)
	}
}

// TestClient_Health_Reachable verifies that Health returns (true, "") when
// ListNetworks succeeds.
func TestClient_Health_Reachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":[],"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	reachable, version := c.Health(context.Background())
	if !reachable {
		t.Error("expected reachable=true")
	}
	if version != "" {
		t.Errorf("expected version=\"\", got %q", version)
	}
}

// TestClient_Health_Unreachable verifies that Health returns (false, "") when
// newtron-server is unavailable.
func TestClient_Health_Unreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	reachable, version := c.Health(context.Background())
	if reachable {
		t.Error("expected reachable=false")
	}
	if version != "" {
		t.Errorf("expected version=\"\", got %q", version)
	}
}

// asUnavailableError is a helper that uses errors.As semantics without importing
// errors, avoiding the external package version of errors.As. We use type
// assertion directly since UnavailableError is not wrapped in a chain.
func asUnavailableError(err error, target **newtronc.UnavailableError) bool {
	if e, ok := err.(*newtronc.UnavailableError); ok {
		*target = e
		return true
	}
	return false
}
