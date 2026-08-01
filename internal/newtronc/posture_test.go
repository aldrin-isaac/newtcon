package newtronc_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// postureServer stands in for newt-server: it answers the three routes
// Posture() probes and lets each test dictate the status codes.
//
//	POST /newt-server/v1/auth/login                        → authStatus
//	GET  /newtron/v1/networks                              → netsStatus (+ one network)
//	GET  /newtron/v1/networks/{id}/audit/events?limit=1     → auditStatus
func postureServer(t *testing.T, authStatus, netsStatus, auditStatus int, auditBody string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/newt-server/v1/auth/login":
			w.WriteHeader(authStatus)
		case "/newtron/v1/networks":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(netsStatus)
			if netsStatus == http.StatusOK {
				fmt.Fprintln(w, `{"data":[{"id":"lab"}]}`)
			}
		case "/newtron/v1/networks/lab/audit/events":
			w.WriteHeader(auditStatus)
			if auditBody != "" {
				fmt.Fprint(w, auditBody)
			}
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// The audit posture is decided by STATUS CODE, per newtron's documented
// contract (docs/newtron/api.md §audit): with --audit unset, the audit
// endpoints return 404.
//
// This is the regression guard for the bug this test file was added with:
// the probe used to decide "disabled" by sniffing the response body for the
// word "disabled", which newtron never emits — so an engine running without
// --audit reported "unknown" instead of "disabled", and the console could
// never tell an operator that no tamper-evident record was being written.
func TestPosture_AuditLog(t *testing.T) {
	cases := []struct {
		name        string
		auditStatus int
		auditBody   string
		want        string
	}{
		{"200 → audit enabled", http.StatusOK, `{"data":{"events":[]}}`, "enabled"},
		{"404 → audit disabled (--audit unset)", http.StatusNotFound, "", "disabled"},
		{"403 → unknown (audit.read denied, not proof either way)", http.StatusForbidden, "", "unknown"},
		{"500 → unknown", http.StatusInternalServerError, "boom", "unknown"},
		{"401 → unknown", http.StatusUnauthorized, "", "unknown"},
		// The old body-sniff would have called this "disabled" on a 200; the
		// status code says the log is plainly there and readable.
		{"200 whose payload merely mentions the word", http.StatusOK, `{"data":{"events":[{"detail":"port disabled"}]}}`, "enabled"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := postureServer(t, http.StatusUnauthorized, http.StatusOK, tc.auditStatus, tc.auditBody)
			_, auditLog := newtronc.New(srv.URL).Posture(context.Background())
			if auditLog != tc.want {
				t.Errorf("auditLog: want %q, got %q", tc.want, auditLog)
			}
		})
	}
}

func TestPosture_AuthSurface(t *testing.T) {
	cases := []struct {
		name       string
		authStatus int
		want       string
	}{
		{"401 on a credential-less login → auth enabled", http.StatusUnauthorized, "enabled"},
		{"400 → auth enabled (route exists, body rejected)", http.StatusBadRequest, "enabled"},
		{"404 → no auth surface (--auth-pam-service unset)", http.StatusNotFound, "absent"},
		{"200 → unknown (a login that needs no credential is not a posture we model)", http.StatusOK, "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := postureServer(t, tc.authStatus, http.StatusOK, http.StatusOK, `{"data":{"events":[]}}`)
			authSurface, _ := newtronc.New(srv.URL).Posture(context.Background())
			if authSurface != tc.want {
				t.Errorf("authSurface: want %q, got %q", tc.want, authSurface)
			}
		})
	}
}

// An engine started WITH --auth-pam-service 401s every route, so the probe —
// which is unauthenticated by design, because it backs the public
// /api/health — cannot reach the audit read at all. The honest answer is
// "unknown", never a guess. Filed upstream as newtron#476 (no unauthenticated
// liveness/posture surface).
func TestPosture_AuthGuardedEngine_AuditUnknown(t *testing.T) {
	srv := postureServer(t, http.StatusUnauthorized, http.StatusUnauthorized, http.StatusUnauthorized, "")
	authSurface, auditLog := newtronc.New(srv.URL).Posture(context.Background())
	if authSurface != "enabled" {
		t.Errorf("authSurface: want %q, got %q", "enabled", authSurface)
	}
	if auditLog != "unknown" {
		t.Errorf("auditLog: want %q (cannot ask), got %q", "unknown", auditLog)
	}
}

// No networks registered → nothing to read an audit log from. Not evidence
// that audit is off.
func TestPosture_NoNetworks_AuditUnknown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/newtron/v1/networks" {
			fmt.Fprintln(w, `{"data":[]}`)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	_, auditLog := newtronc.New(srv.URL).Posture(context.Background())
	if auditLog != "unknown" {
		t.Errorf("auditLog: want %q, got %q", "unknown", auditLog)
	}
}

// Engine unreachable entirely — both layers unknown, no guessing.
func TestPosture_Unreachable(t *testing.T) {
	authSurface, auditLog := newtronc.New("http://127.0.0.1:1").Posture(context.Background())
	if authSurface != "unknown" || auditLog != "unknown" {
		t.Errorf("want both unknown, got authSurface=%q auditLog=%q", authSurface, auditLog)
	}
}
