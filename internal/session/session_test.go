package session_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/session"
)

func TestStore_MintLookupDelete(t *testing.T) {
	s := session.NewStore()
	tok, err := s.Mint(session.Entry{Bearer: "abc", User: "alice", ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if tok == "" {
		t.Fatal("expected non-empty token")
	}
	e, ok := s.Lookup(tok)
	if !ok {
		t.Fatal("expected hit, got miss")
	}
	if e.Bearer != "abc" || e.User != "alice" {
		t.Errorf("entry mismatch: %#v", e)
	}
	s.Delete(tok)
	if _, ok := s.Lookup(tok); ok {
		t.Error("expected miss after Delete")
	}
}

func TestStore_Expiry_EvictsOnLookup(t *testing.T) {
	s := session.NewStore()
	tok, _ := s.Mint(session.Entry{Bearer: "b", User: "u", ExpiresAt: time.Now().Add(-time.Minute)})
	if _, ok := s.Lookup(tok); ok {
		t.Fatal("expected miss for expired entry")
	}
	if s.Len() != 0 {
		t.Errorf("expected Len=0 after eviction, got %d", s.Len())
	}
}

func TestStore_Mint_Unique(t *testing.T) {
	s := session.NewStore()
	tok1, _ := s.Mint(session.Entry{ExpiresAt: time.Now().Add(time.Hour)})
	tok2, _ := s.Mint(session.Entry{ExpiresAt: time.Now().Add(time.Hour)})
	if tok1 == tok2 {
		t.Error("expected unique tokens")
	}
}

func TestSetCookie_Attributes(t *testing.T) {
	w := httptest.NewRecorder()
	session.SetCookie(w, "tok", time.Now().Add(time.Hour), true)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected 1 cookie, got %d", len(cookies))
	}
	c := cookies[0]
	if c.Name != session.CookieName {
		t.Errorf("Name=%q want %q", c.Name, session.CookieName)
	}
	if c.Value != "tok" {
		t.Errorf("Value=%q", c.Value)
	}
	if !c.HttpOnly {
		t.Error("HttpOnly must be set")
	}
	if !c.Secure {
		t.Error("Secure must be set when secure=true")
	}
	if c.SameSite != http.SameSiteStrictMode {
		t.Errorf("SameSite=%v want Strict", c.SameSite)
	}
	if c.Path != "/" {
		t.Errorf("Path=%q want /", c.Path)
	}
}

func TestSetCookie_InsecureMode(t *testing.T) {
	w := httptest.NewRecorder()
	session.SetCookie(w, "tok", time.Now().Add(time.Hour), false)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected 1 cookie, got %d", len(cookies))
	}
	if cookies[0].Secure {
		t.Error("Secure must be unset when secure=false")
	}
	if !cookies[0].HttpOnly {
		t.Error("HttpOnly must remain set even in insecure mode")
	}
}

func TestClearCookie_DropsBrowserSide(t *testing.T) {
	w := httptest.NewRecorder()
	session.ClearCookie(w, true)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected 1 cookie, got %d", len(cookies))
	}
	if cookies[0].MaxAge != -1 {
		t.Errorf("MaxAge=%d want -1", cookies[0].MaxAge)
	}
	if cookies[0].Value != "" {
		t.Errorf("Value=%q want empty", cookies[0].Value)
	}
}

func TestMiddleware_ResolvesSession(t *testing.T) {
	s := session.NewStore()
	tok, _ := s.Mint(session.Entry{Bearer: "key", User: "alice", ExpiresAt: time.Now().Add(time.Hour)})

	var sawUser, sawBearer string
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawUser = session.UserFromContext(r.Context())
		// bearer is package-private to newtronc; verify indirectly through an
		// outbound request whose handler echoes the header.
		echo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sawBearer = r.Header.Get("Authorization")
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"data":[],"error":""}`))
		}))
		defer echo.Close()
		c := newtronc.New(echo.URL)
		_, _ = c.ListNetworks(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	mw := session.Middleware(s, false)
	handler := mw(inner)
	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: tok})
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if sawUser != "alice" {
		t.Errorf("UserFromContext=%q want alice", sawUser)
	}
	if sawBearer != "Bearer key" {
		t.Errorf("outbound Authorization=%q want Bearer key", sawBearer)
	}
}

func TestMiddleware_NoCookie_NoContext(t *testing.T) {
	s := session.NewStore()
	var sawUser string
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawUser = session.UserFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	})
	mw := session.Middleware(s, false)
	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	w := httptest.NewRecorder()
	mw(inner).ServeHTTP(w, req)
	if sawUser != "" {
		t.Errorf("expected empty user, got %q", sawUser)
	}
}

func TestMiddleware_401_ClearsCookieAndEvicts(t *testing.T) {
	s := session.NewStore()
	tok, _ := s.Mint(session.Entry{Bearer: "k", User: "alice", ExpiresAt: time.Now().Add(time.Hour)})

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	mw := session.Middleware(s, true)
	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: tok})
	w := httptest.NewRecorder()
	mw(inner).ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status=%d want 401", w.Code)
	}
	if _, ok := s.Lookup(tok); ok {
		t.Error("store entry must be evicted on 401")
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].MaxAge != -1 {
		t.Errorf("expected clearing cookie, got %#v", cookies)
	}
}

// TestMiddleware_401_NoSessionDoesNotClear verifies the middleware does not
// emit a Clear-Cookie when the request had no session in the first place.
func TestMiddleware_401_NoSessionDoesNotClear(t *testing.T) {
	s := session.NewStore()
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	mw := session.Middleware(s, true)
	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	w := httptest.NewRecorder()
	mw(inner).ServeHTTP(w, req)
	if len(w.Result().Cookies()) != 0 {
		t.Errorf("expected no Set-Cookie when no session was present, got %#v", w.Result().Cookies())
	}
}
