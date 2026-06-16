package newtronc_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

func TestLogin_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newt-server/v1/auth/login" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		user, pw, ok := r.BasicAuth()
		if !ok || user != "alice" || pw != "hunter2" {
			t.Errorf("Basic auth wrong: ok=%v user=%q", ok, user)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"key":"abc123","expires_at":"2026-06-11T20:00:00Z","user":"alice"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	lr, err := c.Login(context.Background(), "alice", "hunter2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if lr.Key != "abc123" || lr.User != "alice" || lr.ExpiresAt.IsZero() {
		t.Errorf("unexpected response: %#v", lr)
	}
}

// TestLogin_MissingKey guards against newtron returning a 200 but no key —
// the body decodes, but there's no session to remember. Should error.
func TestLogin_MissingKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"user":"alice","expires_at":"2026-06-11T20:00:00Z"}}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.Login(context.Background(), "alice", "hunter2")
	if err == nil {
		t.Fatal("expected error when key is missing")
	}
	var unavail *newtronc.UnavailableError
	if !errors.As(err, &unavail) {
		t.Errorf("expected *UnavailableError, got %T", err)
	}
}

func TestLogin_Unauthenticated(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `authentication failed`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.Login(context.Background(), "alice", "wrong")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var unauth *newtronc.UnauthenticatedError
	if !errors.As(err, &unauth) {
		t.Errorf("expected *UnauthenticatedError, got %T: %v", err, err)
	}
}

func TestLogin_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.Login(context.Background(), "alice", "hunter2")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var nf *newtronc.NotFoundError
	if !errors.As(err, &nf) {
		t.Errorf("expected *NotFoundError, got %T: %v", err, err)
	}
}

func TestLogout_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newt-server/v1/auth/logout" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		auth := r.Header.Get("Authorization")
		if auth != "Bearer xyz" {
			t.Errorf("unexpected Authorization: %q", auth)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	if err := c.Logout(context.Background(), "xyz"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestBearerInjector_AddsHeader verifies that an outbound request whose ctx
// carries WithBearer picks up the Authorization header.
func TestBearerInjector_AddsHeader(t *testing.T) {
	gotAuth := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":[{"id":"default"}],"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	ctx := newtronc.WithBearer(context.Background(), "session-key-xyz")
	if _, err := c.ListNetworks(ctx); err != nil {
		t.Fatalf("ListNetworks: %v", err)
	}
	if gotAuth != "Bearer session-key-xyz" {
		t.Errorf("expected Bearer header, got %q", gotAuth)
	}
}

// TestBearerInjector_NoBearer verifies anonymous requests stay anonymous.
func TestBearerInjector_NoBearer(t *testing.T) {
	gotAuth := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":[],"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	if _, err := c.ListNetworks(context.Background()); err != nil {
		t.Fatalf("ListNetworks: %v", err)
	}
	if gotAuth != "" {
		t.Errorf("expected no Authorization header, got %q", gotAuth)
	}
}

// TestClassifyResponse_Unauthorized verifies the 401 case lands on
// *UnauthenticatedError (added in slice 1.C).
func TestClassifyResponse_Unauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	// Use ListNetworks as the carrier — any classifyResponse caller would do.
	_, err := c.ListNetworks(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var unauth *newtronc.UnauthenticatedError
	if !errors.As(err, &unauth) {
		t.Errorf("expected *UnauthenticatedError, got %T: %v", err, err)
	}
}
