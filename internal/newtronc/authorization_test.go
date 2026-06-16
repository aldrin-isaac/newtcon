package newtronc_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// TestGetAuthorization_Success verifies the URL shape + envelope unwrap +
// that the forwarded payload preserves the polymorphic PermissionGrant
// shapes (shorthand list vs typed object) verbatim.
func TestGetAuthorization_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtron/v1/networks/default/authorization" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		// Both shorthand and typed PermissionGrant forms in the same response —
		// the renderer should see both shapes as-newtron-emits.
		fmt.Fprintln(w, `{"data":{
			"super_users": ["root"],
			"user_groups": {"netops": ["alice","bob"]},
			"permissions": {
				"create-service": ["netops"],
				"spec.author": {"allow": ["netops"], "where": {"service": "svc-a"}}
			}
		},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.GetAuthorization(context.Background(), "default")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil payload")
	}
	// Round-trip the polymorphic permissions field to assert both shapes
	// reach the caller unchanged.
	var parsed struct {
		Permissions map[string]json.RawMessage `json:"permissions"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("decode: %v", err)
	}
	shorthand := string(parsed.Permissions["create-service"])
	if shorthand != `["netops"]` {
		t.Errorf("shorthand grant not preserved: got %s", shorthand)
	}
	typed := string(parsed.Permissions["spec.author"])
	if typed == "" {
		t.Errorf("typed grant absent")
	}
}

func TestGetAuthorization_NetworkNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.GetAuthorization(context.Background(), "no-such-network")
	if err == nil {
		t.Fatal("expected error for 404")
	}
	var nf *newtronc.NotFoundError
	if !errorIs(err, &nf) {
		t.Errorf("expected *NotFoundError, got %T: %v", err, err)
	}
}

// errorIs wraps errors.As for terser test code.
func errorIs[T error](err error, target *T) bool {
	for {
		if t, ok := err.(T); ok {
			*target = t
			return true
		}
		type unwrapper interface{ Unwrap() error }
		u, ok := err.(unwrapper)
		if !ok {
			return false
		}
		err = u.Unwrap()
		if err == nil {
			return false
		}
	}
}
