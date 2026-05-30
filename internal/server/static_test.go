package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/server"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// TestRegisterStaticAssets_ServesIndexHTML verifies that after registering a
// valid web-dir, GET / returns the contents of index.html and a 200 status.
func TestRegisterStaticAssets_ServesIndexHTML(t *testing.T) {
	t.Parallel()

	// Create a temporary directory with a minimal index.html.
	dir := t.TempDir()
	indexContent := "<html><body>newtcon</body></html>"
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(indexContent), 0o644); err != nil {
		t.Fatalf("setup: write index.html: %v", err)
	}

	mux := server.NewMux()
	server.RegisterStaticAssets(mux, dir)

	// GET / serves index.html (http.FileServer default directory listing
	// redirects to clean path; for a dir with index.html it serves it directly).
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "newtcon") {
		t.Fatalf("response body does not contain expected content; got: %q", rec.Body.String())
	}
}

// TestRegisterStaticAssets_APIRoutesTakePrecedence verifies that /api/* routes
// registered before RegisterStaticAssets continue to match their handlers and
// are not shadowed by the static file server.
func TestRegisterStaticAssets_APIRoutesTakePrecedence(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	// Place an api/ subdirectory with a file; the static server must NOT serve it
	// when an /api/ handler is also registered.
	apiDir := filepath.Join(dir, "api")
	if err := os.MkdirAll(apiDir, 0o755); err != nil {
		t.Fatalf("setup: mkdir api/: %v", err)
	}
	if err := os.WriteFile(filepath.Join(apiDir, "health"), []byte("static file"), 0o644); err != nil {
		t.Fatalf("setup: write api/health: %v", err)
	}

	mux := server.NewMux()

	// Register an /api/health route before static assets.
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	server.RegisterStaticAssets(mux, dir)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"status":"ok"`) {
		t.Fatalf("/api/health returned static file instead of handler: %q", body)
	}
}

// TestRegisterStaticAssets_EmptyDirSkips verifies that an empty --web-dir
// disables static serving without registering a catch-all that would shadow
// /api/* routes.
func TestRegisterStaticAssets_EmptyDirSkips(t *testing.T) {
	t.Parallel()

	mux := server.NewMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	// Register with an empty dir — should be a no-op for the catch-all.
	server.RegisterStaticAssets(mux, "")

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected /api/health to return 200 even with no static dir; got %d", rec.Code)
	}
}

// TestRegisterStaticAssets_NonExistentDirSkips verifies that a non-existent
// --web-dir disables static serving without panicking.
func TestRegisterStaticAssets_NonExistentDirSkips(t *testing.T) {
	t.Parallel()

	mux := server.NewMux()
	// This must not panic even when the directory does not exist.
	server.RegisterStaticAssets(mux, "/tmp/does-not-exist-newtcon-test-abc123")

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	// No handler matches "/" when static serving is skipped; the mux returns 404.
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 (no handler), got %d", rec.Code)
	}
}

// TestRegisterStaticAssets_Unknown404ReturnsJSONEnvelope verifies that a
// request for a path that does not exist under web-dir returns HTTP 404 with
// the API_CONTRACT.md §Error Schema JSON envelope — NOT the plaintext
// "404 page not found" response that http.FileServer emits by default.
//
// This test exercises acceptance criterion 5d of newtcon#104 and CLAUDE.md
// §Operator-Honest Errors: errors must be returned as JSON in domain terms,
// not as HTTP-status-approximation plain text.
func TestRegisterStaticAssets_Unknown404ReturnsJSONEnvelope(t *testing.T) {
	t.Parallel()

	// The web-dir contains only index.html; any other path must produce a
	// JSON 404 envelope.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>ok</html>"), 0o644); err != nil {
		t.Fatalf("setup: write index.html: %v", err)
	}

	mux := server.NewMux()
	server.RegisterStaticAssets(mux, dir)

	req := httptest.NewRequest(http.MethodGet, "/does-not-exist", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	// Status must be 404.
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d (body: %s)", rec.Code, rec.Body.String())
	}

	// Content-Type must be application/json, not text/plain.
	ct := rec.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("expected Content-Type application/json, got %q", ct)
	}

	// Body must parse as the ErrorEnvelope shape from API_CONTRACT.md §Error Schema.
	var env types.ErrorEnvelope
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("response body is not valid JSON ErrorEnvelope: %v (body: %s)", err, rec.Body.String())
	}

	// Kind must be "internal" — the only appropriate bounded kind for a missing
	// static asset (no "not_found" kind exists in the contract).
	if env.Error.Kind != types.KindInternal {
		t.Fatalf("expected kind %q, got %q", types.KindInternal, env.Error.Kind)
	}

	// Message must reference the requested path.
	if !strings.Contains(env.Error.Message, "/does-not-exist") {
		t.Fatalf("expected message to contain request path; got %q", env.Error.Message)
	}
}
