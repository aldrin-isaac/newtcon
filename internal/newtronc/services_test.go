package newtronc_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// TestListServices_Success verifies that ListServices parses the newtron
// APIResponse envelope — {"data":["transit","vpn"],"error":""} — and returns
// the expected NewtronService slice.
//
// Substrate: GET /network/{netID}/service confirmed at
// pkg/newtron/api/handler.go:30.
func TestListServices_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtron/v1/networks/default/services" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":["transit","vpn"],"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	services, err := c.ListServices(context.Background(), "default")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(services) != 2 {
		t.Fatalf("expected 2 services, got %d: %v", len(services), services)
	}
	if services[0].Name != "transit" {
		t.Errorf("services[0].Name: want \"transit\", got %q", services[0].Name)
	}
	if services[1].Name != "vpn" {
		t.Errorf("services[1].Name: want \"vpn\", got %q", services[1].Name)
	}
}

// TestListServices_NetworkNotFound verifies that a 404 from newtron-server
// (network not registered) yields a *NotFoundError.
//
// This maps to the case where the newtron network ID passed is not registered.
func TestListServices_NetworkNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"network 'default' not found"}`, http.StatusNotFound)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.ListServices(context.Background(), "default")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*newtronc.NotFoundError); !ok {
		t.Errorf("expected *NotFoundError, got %T: %v", err, err)
	}
}

// TestListServices_Unavailable verifies that a 503 from newtron-server yields
// a *UnavailableError.
func TestListServices_Unavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.ListServices(context.Background(), "default")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*newtronc.UnavailableError); !ok {
		t.Errorf("expected *UnavailableError, got %T: %v", err, err)
	}
}

// TestShowService_Success verifies that ShowService decodes the newtron
// ServiceDetail envelope correctly, including the "service_type" JSON field
// that newtron uses (not "type").
//
// Substrate: GET /network/{netID}/services/{name} confirmed at
// pkg/newtron/api/handler.go:31.
// JSON field: pkg/newtron/types.go:476 ServiceDetail.ServiceType json:"service_type".
func TestShowService_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtron/v1/networks/default/services/transit" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		// Newtron uses "service_type" (not "type") — this test verifies the
		// DTO's json tag is correct. If it were "type", ServiceType would be "".
		fmt.Fprintln(w, `{"data":{"name":"transit","service_type":"routed"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	detail, err := c.ShowService(context.Background(), "default", "transit")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if detail.Name != "transit" {
		t.Errorf("Name: want \"transit\", got %q", detail.Name)
	}
	if detail.ServiceType != "routed" {
		t.Errorf("ServiceType: want \"routed\", got %q", detail.ServiceType)
	}
	if detail.Raw == nil {
		t.Error("Raw: want non-nil (forward-compat payload)")
	}
}

// TestShowService_NotFound verifies that a 404 from newtron-server yields a
// *NotFoundError.
func TestShowService_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"service 'unknown' not found"}`, http.StatusNotFound)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.ShowService(context.Background(), "default", "unknown")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*newtronc.NotFoundError); !ok {
		t.Errorf("expected *NotFoundError, got %T: %v", err, err)
	}
}
