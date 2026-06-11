package newtronc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Pins the wire shape the upstream newtron regression test
// (pkg/newtron/api/authorization_test.go TestAuthorization_DenyWireShape)
// promises. If newtron changes these JSON keys, this test breaks first.
func TestDecodeAuthorizationError_WithResource(t *testing.T) {
	body := []byte(`{
	  "data":  { "caller": "alice", "permission": "spec.author", "resource": "svc-b" },
	  "error": "authorization denied: alice lacks spec.author on svc-b"
	}`)

	got := decodeAuthorizationError(http.StatusForbidden, body)

	if got.StatusCode != 403 {
		t.Errorf("StatusCode: want 403, got %d", got.StatusCode)
	}
	if got.Caller != "alice" {
		t.Errorf("Caller: want %q, got %q", "alice", got.Caller)
	}
	if got.Permission != "spec.author" {
		t.Errorf("Permission: want %q, got %q", "spec.author", got.Permission)
	}
	if got.Resource != "svc-b" {
		t.Errorf("Resource: want %q, got %q", "svc-b", got.Resource)
	}
	// Body is preserved verbatim for diagnostics.
	if !strings.Contains(string(got.Body), `"resource": "svc-b"`) {
		t.Errorf("Body should be the original envelope; got %q", string(got.Body))
	}
}

func TestDecodeAuthorizationError_NoResource(t *testing.T) {
	body := []byte(`{
	  "data":  { "caller": "mallory", "permission": "admin" },
	  "error": "authorization denied: mallory lacks admin"
	}`)

	got := decodeAuthorizationError(http.StatusForbidden, body)

	if got.Caller != "mallory" {
		t.Errorf("Caller: want %q, got %q", "mallory", got.Caller)
	}
	if got.Permission != "admin" {
		t.Errorf("Permission: want %q, got %q", "admin", got.Permission)
	}
	if got.Resource != "" {
		t.Errorf("Resource: want empty, got %q", got.Resource)
	}
}

func TestDecodeAuthorizationError_BadEnvelopeFallback(t *testing.T) {
	// Newtron returned 403 but with a non-envelope body — possibly a proxy
	// or a deployment running an older newtron. Returned error still
	// carries the status + body for diagnostics, but the structured fields
	// are empty.
	body := []byte(`Forbidden`)

	got := decodeAuthorizationError(http.StatusForbidden, body)

	if got.StatusCode != 403 {
		t.Errorf("StatusCode: want 403, got %d", got.StatusCode)
	}
	if got.Caller != "" || got.Permission != "" || got.Resource != "" {
		t.Errorf("structured fields should be empty on malformed envelope; got %+v", got)
	}
	if string(got.Body) != "Forbidden" {
		t.Errorf("Body: want %q, got %q", "Forbidden", string(got.Body))
	}
}

func TestAuthorizationError_Error_WithResource(t *testing.T) {
	e := &AuthorizationError{Caller: "alice", Permission: "spec.author", Resource: "svc-b"}
	want := "authorization denied: alice lacks spec.author on svc-b"
	if e.Error() != want {
		t.Errorf("Error():\n  want %q\n  got  %q", want, e.Error())
	}
}

func TestAuthorizationError_Error_NoResource(t *testing.T) {
	e := &AuthorizationError{Caller: "mallory", Permission: "admin"}
	want := "authorization denied: mallory lacks admin"
	if e.Error() != want {
		t.Errorf("Error():\n  want %q\n  got  %q", want, e.Error())
	}
}

func TestClassifyResponse(t *testing.T) {
	cases := []struct {
		name         string
		statusCode   int
		body         string
		successCodes []int
		wantType     string // empty = nil error
	}{
		{"OK in success list", 200, "", []int{200}, ""},
		{"Created in success list", 201, "", []int{200, 201}, ""},
		{"Accepted in success list", 202, "", []int{200, 202}, ""},
		{"OK not in success list returns unavailable", 200, "body", []int{201}, "*newtronc.UnavailableError"},
		{"400 → ValidationError", 400, "validation body", []int{200}, "*newtronc.ValidationError"},
		{"403 with envelope → AuthorizationError",
			403,
			`{"data":{"caller":"x","permission":"y"},"error":"denied"}`,
			[]int{200},
			"*newtronc.AuthorizationError"},
		{"403 bare body → AuthorizationError (fallback)",
			403, "Forbidden", []int{200}, "*newtronc.AuthorizationError"},
		{"404 → NotFoundError", 404, "not found body", []int{200}, "*newtronc.NotFoundError"},
		{"409 → ConflictError", 409, "conflict body", []int{200}, "*newtronc.ConflictError"},
		{"500 → UnavailableError", 500, "server error", []int{200}, "*newtronc.UnavailableError"},
		{"503 → UnavailableError", 503, "unavail", []int{200}, "*newtronc.UnavailableError"},
		{"418 → UnavailableError (unexpected)", 418, "teapot", []int{200}, "*newtronc.UnavailableError"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := classifyResponse(tc.statusCode, []byte(tc.body), tc.successCodes...)
			if tc.wantType == "" {
				if err != nil {
					t.Fatalf("want nil error, got %T: %v", err, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("want %s, got nil", tc.wantType)
			}
			got := strings.TrimPrefix(reflectTypeName(err), "newtronc.")
			want := strings.TrimPrefix(strings.TrimPrefix(tc.wantType, "*"), "newtronc.")
			if got != want {
				t.Errorf("type: want *%s, got *%s", want, got)
			}
		})
	}
}

// reflectTypeName returns the type name like "newtronc.NotFoundError".
func reflectTypeName(v any) string {
	return strings.TrimPrefix(fmt.Sprintf("%T", v), "*")
}

// End-to-end: ListNetworks against a fake upstream returning 403 with the
// typed envelope. The returned error must be *AuthorizationError with all
// fields populated, not "unexpected status 403".
func TestListNetworks_Forbidden(t *testing.T) {
	envelope := map[string]any{
		"data": map[string]string{
			"caller":     "alice",
			"permission": "network.read",
			"resource":   "test-network",
		},
		"error": "authorization denied: alice lacks network.read on test-network",
	}
	body, _ := json.Marshal(envelope)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write(body)
	}))
	defer upstream.Close()

	c := New(upstream.URL)
	_, err := c.ListNetworks(context.Background())

	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	authErr, ok := err.(*AuthorizationError)
	if !ok {
		t.Fatalf("want *AuthorizationError, got %T: %v", err, err)
	}
	if authErr.Caller != "alice" {
		t.Errorf("Caller: want %q, got %q", "alice", authErr.Caller)
	}
	if authErr.Permission != "network.read" {
		t.Errorf("Permission: want %q, got %q", "network.read", authErr.Permission)
	}
	if authErr.Resource != "test-network" {
		t.Errorf("Resource: want %q, got %q", "test-network", authErr.Resource)
	}
}
