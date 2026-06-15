package handlers_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/handlers"
	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/session"
)

func constCorrelationID(string) func(context.Context) string {
	return func(context.Context) string { return "corr-test" }
}

func newAuthMux(t *testing.T, upstreamURL string, store *session.Store) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()
	handlers.RegisterAuthRoutes(mux, handlers.AuthDeps{
		Client:        newtronc.New(upstreamURL),
		Store:         store,
		CookieSecure:  false, // tests use plain HTTP
		AuthRequired:  true,  // existing tests target the live auth path
		CorrelationID: constCorrelationID(""),
	})
	return mux
}

// newAnonymousAuthMux builds the mux as it would be when newtcon-server
// starts without --auth-required: every /api/auth/* route returns 404 with
// an "authentication not enabled" envelope.
func newAnonymousAuthMux(t *testing.T) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()
	handlers.RegisterAuthRoutes(mux, handlers.AuthDeps{
		Client:        newtronc.New("http://unused"),
		Store:         session.NewStore(),
		CookieSecure:  false,
		AuthRequired:  false,
		CorrelationID: constCorrelationID(""),
	})
	return mux
}

func TestAuthLogin_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":{"key":"k1","expires_at":"2026-06-11T20:00:00Z","user":"alice"},"error":""}`)
	}))
	defer upstream.Close()
	store := session.NewStore()

	body := strings.NewReader(`{"username":"alice","password":"hunter2"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	newAuthMux(t, upstream.URL, store).ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["user"] != "alice" {
		t.Errorf("user=%v want alice", resp["user"])
	}
	if resp["expires_at"] == nil {
		t.Error("expires_at missing")
	}
	if store.Len() != 1 {
		t.Errorf("expected 1 session in store, got %d", store.Len())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != session.CookieName {
		t.Errorf("expected session cookie, got %#v", cookies)
	}
}

func TestAuthLogin_BadBody(t *testing.T) {
	store := session.NewStore()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader("not json"))
	w := httptest.NewRecorder()
	newAuthMux(t, "http://unused", store).ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status=%d want 400", w.Code)
	}
	if store.Len() != 0 {
		t.Error("store must be empty after bad body")
	}
}

func TestAuthLogin_MissingFields(t *testing.T) {
	store := session.NewStore()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":""}`))
	w := httptest.NewRecorder()
	newAuthMux(t, "http://unused", store).ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status=%d want 400", w.Code)
	}
}

func TestAuthLogin_UpstreamRejected(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer upstream.Close()
	store := session.NewStore()

	body := strings.NewReader(`{"username":"alice","password":"wrong"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", body)
	w := httptest.NewRecorder()
	newAuthMux(t, upstream.URL, store).ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status=%d want 401", w.Code)
	}
	if store.Len() != 0 {
		t.Error("store must be empty after auth failure")
	}
	var env map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &env)
	errMap, _ := env["error"].(map[string]any)
	if errMap["kind"] != "authentication_failure" {
		t.Errorf("kind=%v want authentication_failure", errMap["kind"])
	}
}

func TestAuthLogout_NoCookie(t *testing.T) {
	store := session.NewStore()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	w := httptest.NewRecorder()
	newAuthMux(t, "http://unused", store).ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Errorf("status=%d want 204", w.Code)
	}
	// Logout always writes the clear cookie — idempotent for browsers that
	// already cleared it.
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].MaxAge != -1 {
		t.Errorf("expected clear cookie, got %#v", cookies)
	}
}

func TestAuthLogout_WithCookie(t *testing.T) {
	var loggedOut bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/newtron/v1/auth/logout" && r.Header.Get("Authorization") == "Bearer k1" {
			loggedOut = true
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer upstream.Close()
	store := session.NewStore()
	tok, _ := store.Mint(session.Entry{Bearer: "k1", User: "alice", ExpiresAt: time.Now().Add(time.Hour)})

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: tok})
	w := httptest.NewRecorder()
	newAuthMux(t, upstream.URL, store).ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Errorf("status=%d want 204", w.Code)
	}
	if !loggedOut {
		t.Error("expected upstream /auth/logout to be called with Bearer k1")
	}
	if store.Len() != 0 {
		t.Errorf("expected store cleared, got Len=%d", store.Len())
	}
}

func TestAuthWhoami_NoCookie(t *testing.T) {
	store := session.NewStore()
	req := httptest.NewRequest(http.MethodGet, "/api/auth/whoami", nil)
	w := httptest.NewRecorder()
	newAuthMux(t, "http://unused", store).ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status=%d want 401", w.Code)
	}
}

func TestAuthWhoami_Valid(t *testing.T) {
	store := session.NewStore()
	expires := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	tok, _ := store.Mint(session.Entry{Bearer: "k", User: "alice", ExpiresAt: expires})

	req := httptest.NewRequest(http.MethodGet, "/api/auth/whoami", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: tok})
	w := httptest.NewRecorder()
	newAuthMux(t, "http://unused", store).ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["user"] != "alice" {
		t.Errorf("user=%v want alice", resp["user"])
	}
}

func TestAuthWhoami_Expired(t *testing.T) {
	store := session.NewStore()
	tok, _ := store.Mint(session.Entry{Bearer: "k", User: "alice", ExpiresAt: time.Now().Add(-time.Minute)})

	req := httptest.NewRequest(http.MethodGet, "/api/auth/whoami", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: tok})
	w := httptest.NewRecorder()
	newAuthMux(t, "http://unused", store).ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status=%d want 401 (expired)", w.Code)
	}
	if store.Len() != 0 {
		t.Errorf("expected expired entry evicted, got Len=%d", store.Len())
	}
}

// ---- Anonymous mode (--auth-required=false) -------------------------------

func TestAuth_Anonymous_LoginReturns404(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"username":"a","password":"b"}`))
	w := httptest.NewRecorder()
	newAnonymousAuthMux(t).ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("status=%d want 404", w.Code)
	}
	var env map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &env)
	errMap, _ := env["error"].(map[string]any)
	if errMap["kind"] != "precondition_failure" {
		t.Errorf("kind=%v want precondition_failure", errMap["kind"])
	}
	msg, _ := errMap["message"].(string)
	if !strings.Contains(msg, "not enabled") {
		t.Errorf("message=%q should mention 'not enabled'", msg)
	}
}

func TestAuth_Anonymous_LogoutReturns404(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	w := httptest.NewRecorder()
	newAnonymousAuthMux(t).ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("status=%d want 404", w.Code)
	}
}

func TestAuth_Anonymous_WhoamiReturns404(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/auth/whoami", nil)
	w := httptest.NewRecorder()
	newAnonymousAuthMux(t).ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("status=%d want 404", w.Code)
	}
}
