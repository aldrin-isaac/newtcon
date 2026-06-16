package handlers_test

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/handlers"
	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

func TestAuthorization_Handler_Forwards(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtron/v1/networks/default/authorization" {
			t.Errorf("unexpected upstream URL: %s", r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"super_users":["root"],"user_groups":{},"permissions":{}},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterAuthorizationRoutes(mux, handlers.AuthorizationDeps{
		Client:        newtronc.New(upstream.URL),
		CorrelationID: func(context.Context) string { return "corr-x" },
	})

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/authorization", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want 200: %s", rec.Code, rec.Body.String())
	}
	body, _ := io.ReadAll(rec.Body)
	if !contains(string(body), `"super_users":["root"]`) {
		t.Errorf("forwarded payload missing super_users: %s", string(body))
	}
}

func TestAuthorization_Handler_UpstreamUnavailable(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterAuthorizationRoutes(mux, handlers.AuthorizationDeps{
		Client:        newtronc.New(upstream.URL),
		CorrelationID: func(context.Context) string { return "corr-y" },
	})

	req := httptest.NewRequest(http.MethodGet, "/api/networks/default/authorization", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d want 503", rec.Code)
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
