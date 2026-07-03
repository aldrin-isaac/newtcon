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

func secretsMux(upstreamURL string) *http.ServeMux {
	mux := http.NewServeMux()
	handlers.RegisterSecretsRoutes(mux, handlers.SecretsDeps{Client: newtronc.New(upstreamURL)})
	return mux
}

// GET returns the upstream key names (and only names).
func TestSecretsList_ReturnsKeyNames(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtron/v1/networks/n1/secrets" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"keys":["switch1_ssh_pass"]},"error":""}`))
	}))
	defer upstream.Close()

	req := httptest.NewRequest(http.MethodGet, "/api/networks/n1/secrets", nil)
	rec := httptest.NewRecorder()
	secretsMux(upstream.URL).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"switch1_ssh_pass"`) {
		t.Errorf("missing key names: %s", rec.Body.String())
	}
}

// GET with no store yet → newtron returns [], newtcon emits {"keys":[]}.
func TestSecretsList_EmptyIsArrayNotNull(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"keys":[]},"error":""}`))
	}))
	defer upstream.Close()

	req := httptest.NewRequest(http.MethodGet, "/api/networks/n1/secrets", nil)
	rec := httptest.NewRecorder()
	secretsMux(upstream.URL).ServeHTTP(rec, req)

	if got := strings.TrimSpace(rec.Body.String()); got != `{"keys":[]}` {
		t.Errorf(`expected {"keys":[]}, got %s`, got)
	}
}

// POST forwards {key,value} upstream but the RESPONSE never echoes the value.
func TestSecretsSet_ForwardsValue_ButNeverEchoesIt(t *testing.T) {
	var gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"status":"set","key":"leaf1_ssh_pass"},"error":""}`))
	}))
	defer upstream.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/networks/n1/secrets",
		strings.NewReader(`{"key":"leaf1_ssh_pass","value":"s3cr3t"}`))
	rec := httptest.NewRecorder()
	secretsMux(upstream.URL).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(gotBody, `"value":"s3cr3t"`) {
		t.Errorf("upstream did not receive the value: %s", gotBody)
	}
	if strings.Contains(rec.Body.String(), "s3cr3t") {
		t.Errorf("response echoed the secret value: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"status":"set"`) {
		t.Errorf("missing status: %s", rec.Body.String())
	}
}

// Missing key or value → 400 before any upstream call.
func TestSecretsSet_MissingFields_400(t *testing.T) {
	mux := secretsMux("http://unused.invalid")
	for _, body := range []string{`{"key":"","value":"x"}`, `{"key":"k","value":""}`, `{}`} {
		req := httptest.NewRequest(http.MethodPost, "/api/networks/n1/secrets", strings.NewReader(body))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: expected 400, got %d", body, rec.Code)
		}
	}
}

func TestSecretsSet_InvalidJSON_400(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/networks/n1/secrets", strings.NewReader(`{bad`))
	rec := httptest.NewRecorder()
	secretsMux("http://unused.invalid").ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestSecretsDelete_Idempotent_200(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/newtron/v1/networks/n1/secrets/leaf1_ssh_pass" {
			t.Errorf("unexpected: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"status":"deleted","key":"leaf1_ssh_pass"},"error":""}`))
	}))
	defer upstream.Close()

	req := httptest.NewRequest(http.MethodDelete, "/api/networks/n1/secrets/leaf1_ssh_pass", nil)
	rec := httptest.NewRecorder()
	secretsMux(upstream.URL).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"status":"deleted"`) {
		t.Errorf("missing status: %s", rec.Body.String())
	}
}

// Upstream 403 (missing spec.author on secrets) → newtcon 403.
func TestSecretsSet_Forbidden_MapsTo403(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"data":null,"error":"permission denied: spec.author on secrets"}`))
	}))
	defer upstream.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/networks/n1/secrets",
		strings.NewReader(`{"key":"k","value":"v"}`))
	rec := httptest.NewRecorder()
	secretsMux(upstream.URL).ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", rec.Code, rec.Body.String())
	}
}
