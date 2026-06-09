package newtronc_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// TestClient_ListNetworks_Success verifies that ListNetworks parses the newtron
// APIResponse envelope and returns the network IDs.
//
// Newtron-server v1.2 serves the API under /newtron/v1/ (composed under
// newt-server alongside /newtrun/v1/ and /newtlab/v1/).
func TestClient_ListNetworks_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtron/v1/networks" {
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

// TestClient_Health_Reachable verifies that Health hits the server-level
// liveness endpoint (/newt-server/v1/health) and returns (true, version)
// when the server responds 200 with status:"ok".
//
// docs/newt-server.md (newtron repo) documents this endpoint. Response shape
// observed live as {"data":{"status":"ok","version":"dev"}}.
func TestClient_Health_Reachable(t *testing.T) {
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"ok","version":"v1.2.3"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	reachable, version := c.Health(context.Background())
	if seen != "/newt-server/v1/health" {
		t.Errorf("Health hit %q, want /newt-server/v1/health", seen)
	}
	if !reachable {
		t.Error("expected reachable=true")
	}
	if version != "v1.2.3" {
		t.Errorf("expected version=\"v1.2.3\", got %q", version)
	}
}

// TestClient_Health_Unreachable verifies that Health returns (false, "") when
// newt-server's health endpoint is unavailable.
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

// TestClient_Health_OkWithoutVersion verifies that Health treats a status:"ok"
// response without a version string as reachable=true, version="".
func TestClient_Health_OkWithoutVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"ok"},"error":""}`)
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

// ============================================================================
// RegisterNetwork — pins the four rows of docs/newtron/api.md
// §POST /newtron/v1/network "behavior matrix":
//
//	scaffold=false + valid spec  → 201 register
//	scaffold=true  + missing dir → scaffold + register, 201
//	scaffold=true  + initialized → 409 (ConflictError)
//	id already registered        → 409 (ConflictError)
//	missing id/spec_dir          → 400 (ValidationError)
// ============================================================================

func TestClient_RegisterNetwork_RegisterExisting(t *testing.T) {
	var seenBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		seenBody = string(body)
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"id":"lab"}}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	id, err := c.RegisterNetwork(context.Background(), "lab", "/etc/newtron/lab", false, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != "lab" {
		t.Errorf("got id=%q, want %q", id, "lab")
	}
	// scaffold=false MUST NOT serialize the scaffold/description fields — they're
	// additive on RegisterNetworkRequest, and the client should look identical
	// to a pre-scaffold caller for the default path.
	if !strings.Contains(seenBody, `"id":"lab"`) || !strings.Contains(seenBody, `"spec_dir":"/etc/newtron/lab"`) {
		t.Errorf("body missing required fields: %s", seenBody)
	}
	if strings.Contains(seenBody, "scaffold") {
		t.Errorf("body should not include scaffold when scaffold=false: %s", seenBody)
	}
	if strings.Contains(seenBody, "description") {
		t.Errorf("body should not include description when scaffold=false: %s", seenBody)
	}
}

func TestClient_RegisterNetwork_ScaffoldAndRegister(t *testing.T) {
	var seenBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		seenBody = string(body)
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"id":"demo-1"}}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	id, err := c.RegisterNetwork(context.Background(), "demo-1", "/var/topologies/demo-1/specs", true, "Demo network")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != "demo-1" {
		t.Errorf("got id=%q, want %q", id, "demo-1")
	}
	if !strings.Contains(seenBody, `"scaffold":true`) {
		t.Errorf("body missing scaffold=true: %s", seenBody)
	}
	if !strings.Contains(seenBody, `"description":"Demo network"`) {
		t.Errorf("body missing description: %s", seenBody)
	}
}

func TestClient_RegisterNetwork_ConflictOnAlreadyRegistered(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		fmt.Fprintln(w, `{"error":"network 'lab' already registered"}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.RegisterNetwork(context.Background(), "lab", "/etc/newtron/lab", false, "")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var ce *newtronc.ConflictError
	if !errors.As(err, &ce) {
		t.Errorf("expected *ConflictError, got %T: %v", err, err)
	}
}

// TestClient_RegisterNetwork_ConflictOnScaffoldInitialized pins the 409 that
// newtron returns when scaffold=true but spec_dir already contains specs.
// Same typed error as the "id already registered" 409 — callers disambiguate
// via *ConflictError.Body (open question #2 in the migration plan).
func TestClient_RegisterNetwork_ConflictOnScaffoldInitialized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		fmt.Fprintln(w, `{"error":"scaffold target /tmp/foo: directory not empty"}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.RegisterNetwork(context.Background(), "demo-1", "/tmp/foo", true, "")
	var ce *newtronc.ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("expected *ConflictError, got %T: %v", err, err)
	}
	if !strings.Contains(string(ce.Body), "directory not empty") {
		t.Errorf("expected scaffold-conflict message in body, got: %s", ce.Body)
	}
}

func TestClient_RegisterNetwork_ValidationOnMissingFields(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprintln(w, `{"error":"id and spec_dir are required"}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.RegisterNetwork(context.Background(), "", "", false, "")
	if _, ok := err.(*newtronc.ValidationError); !ok {
		t.Errorf("expected *ValidationError, got %T: %v", err, err)
	}
}
