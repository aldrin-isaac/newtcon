package handlers_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/handlers"
	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

func sshMux(upstreamURL string) *http.ServeMux {
	mux := http.NewServeMux()
	handlers.RegisterSSHCredentialsRoutes(mux, handlers.SSHCredentialsDeps{Client: newtronc.New(upstreamURL)})
	return mux
}

// GET forwards the scope query verbatim and returns the masked authored login.
func TestSSHCredentialsShow_ForwardsScopeQuery(t *testing.T) {
	var seenQuery string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtron/v1/networks/n1/ssh-credentials" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		seenQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"scope":"zone","scope_instance":"amer","ssh_user":"admin","ssh_pass":"${secret:amer_ssh_pass}"},"error":""}`))
	}))
	defer upstream.Close()

	req := httptest.NewRequest(http.MethodGet, "/api/networks/n1/ssh-credentials?scope=zone&scope_instance=amer", nil)
	rec := httptest.NewRecorder()
	sshMux(upstream.URL).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if seenQuery != "scope=zone&scope_instance=amer" {
		t.Errorf("query not forwarded verbatim: %q", seenQuery)
	}
	if !strings.Contains(rec.Body.String(), `"${secret:amer_ssh_pass}"`) {
		t.Errorf("masked ssh_pass reference missing: %s", rec.Body.String())
	}
}

// POST set forwards the body to /set-ssh-credentials.
func TestSSHCredentialsSet_ForwardsBody(t *testing.T) {
	var gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/n1/set-ssh-credentials" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"status":"set"},"error":""}`))
	}))
	defer upstream.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/networks/n1/set-ssh-credentials",
		strings.NewReader(`{"scope":"network","ssh_user":"admin","ssh_pass":"${secret:net_ssh_pass}"}`))
	rec := httptest.NewRecorder()
	sshMux(upstream.URL).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(gotBody, `"scope":"network"`) || !strings.Contains(gotBody, `${secret:net_ssh_pass}`) {
		t.Errorf("body not forwarded: %s", gotBody)
	}
}

// Upstream 400 (network-floor invariant) propagates.
func TestSSHCredentialsSet_NetworkFloor_400(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"data":null,"error":"set a network-scope login before overriding at zone/node"}`, http.StatusBadRequest)
	}))
	defer upstream.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/networks/n1/set-ssh-credentials",
		strings.NewReader(`{"scope":"zone","scope_instance":"amer","ssh_user":"x"}`))
	rec := httptest.NewRecorder()
	sshMux(upstream.URL).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// Upstream 409 (clearing the base while overrides exist) propagates as conflict.
func TestSSHCredentialsClear_Conflict_409(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtron/v1/networks/n1/clear-ssh-credentials" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		http.Error(w, `{"data":null,"error":"clear zone/node overrides before the network base"}`, http.StatusConflict)
	}))
	defer upstream.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/networks/n1/clear-ssh-credentials",
		strings.NewReader(`{"scope":"network"}`))
	rec := httptest.NewRecorder()
	sshMux(upstream.URL).ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", rec.Code, rec.Body.String())
	}
}
