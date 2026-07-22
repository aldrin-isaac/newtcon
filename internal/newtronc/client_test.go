package newtronc_test

import (
	"context"
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
	// Truly unreachable = no HTTP response at all. Port 1 has nothing
	// listening → connection refused, deterministically. A 5xx or 401 is
	// the daemon ANSWERING and IS reachable — see TestClient_Health_AuthGuarded.
	c := newtronc.New("http://127.0.0.1:1")
	reachable, version := c.Health(context.Background())
	if reachable {
		t.Error("expected reachable=false when nothing answers")
	}
	if version != "" {
		t.Errorf("expected version=\"\", got %q", version)
	}
}

// TestClient_Health_AuthGuarded: under auth, newt-server answers /health with
// 401 (and could 5xx). It IS reachable — the daemon is up and guarding — so
// the pill must not read red. Version is unknown without a credential.
func TestClient_Health_AuthGuarded(t *testing.T) {
	for _, code := range []int{http.StatusUnauthorized, http.StatusServiceUnavailable} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "guarded", code)
		}))
		c := newtronc.New(srv.URL)
		reachable, version := c.Health(context.Background())
		if !reachable {
			t.Errorf("status %d: expected reachable=true (the daemon answered)", code)
		}
		if version != "" {
			t.Errorf("status %d: expected version=%q, got %q", code, "", version)
		}
		srv.Close()
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
// CreateNetwork — pins the three states of newtron's
// docs/newtron/api.md §POST /newtron/v1/networks (PRs #245 + #251):
//
//	201 Created → slot materialised (new)        → existed=false
//	200 OK      → id already registered          → existed=true
//	400         → malformed id / missing id      → ValidationError
//
// No 409 path on this endpoint anymore — same id always resolves to
// the same dir, so cross-dir disambiguation is structurally impossible.
// ============================================================================

func TestClient_CreateNetwork_Created(t *testing.T) {
	var seenBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		seenBody = string(body)
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"id":"lab","dir":"/etc/newtron/networks/lab","has_topology":true,"topology":"lab","nodes":[]}}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	info, existed, err := c.CreateNetwork(context.Background(), "lab", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if existed {
		t.Errorf("201 should map to existed=false")
	}
	if info.ID != "lab" || info.Dir != "/etc/newtron/networks/lab" {
		t.Errorf("response NetworkInfo not decoded: %+v", info)
	}
	if !strings.Contains(seenBody, `"id":"lab"`) {
		t.Errorf("body missing id: %s", seenBody)
	}
	// No `dir` or `scaffold` on the wire — both removed by newtron PRs
	// #245 + #251.
	if strings.Contains(seenBody, `"dir":`) {
		t.Errorf("body should not include dir: %s", seenBody)
	}
	if strings.Contains(seenBody, "scaffold") {
		t.Errorf("body should not include scaffold: %s", seenBody)
	}
	// Empty description is omitted.
	if strings.Contains(seenBody, "description") {
		t.Errorf("empty description should be omitted: %s", seenBody)
	}
}

func TestClient_CreateNetwork_AlreadyExisted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, `{"data":{"id":"demo","dir":"/etc/newtron/networks/demo","has_topology":true,"topology":"demo","nodes":["a","b"]}}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	info, existed, err := c.CreateNetwork(context.Background(), "demo", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !existed {
		t.Errorf("200 should map to existed=true")
	}
	if len(info.Nodes) != 2 {
		t.Errorf("decoded NetworkInfo.Nodes lost on 200: %+v", info)
	}
}

func TestClient_CreateNetwork_DescriptionFlows(t *testing.T) {
	var seenBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		seenBody = string(body)
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"id":"demo-1","dir":"/etc/newtron/networks/demo-1","has_topology":true,"topology":"demo-1","nodes":[]}}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, _, err := c.CreateNetwork(context.Background(), "demo-1", "Demo network")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(seenBody, `"description":"Demo network"`) {
		t.Errorf("body missing description: %s", seenBody)
	}
}

func TestClient_CreateNetwork_ValidationOnMissingFields(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprintln(w, `{"error":"id is required"}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, _, err := c.CreateNetwork(context.Background(), "", "")
	if _, ok := err.(*newtronc.ValidationError); !ok {
		t.Errorf("expected *ValidationError, got %T: %v", err, err)
	}
}
