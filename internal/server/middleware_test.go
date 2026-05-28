package server_test

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/server"
)

// uuidV4RE matches the canonical UUIDv4 format produced by the server.newUUID
// helper. Used to verify X-Request-ID header values.
var uuidV4RE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// TestRequestID_SetsHeader verifies that a request without X-Request-ID receives
// a UUIDv4 header in the response, and the same value is accessible from the
// handler context.
func TestRequestID_SetsHeader(t *testing.T) {
	var contextID string
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contextID = server.RequestIDFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	h := server.RequestID(inner)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	headerID := rec.Header().Get("X-Request-ID")
	if headerID == "" {
		t.Fatal("X-Request-ID header not set")
	}
	if !uuidV4RE.MatchString(headerID) {
		t.Errorf("X-Request-ID %q is not a valid UUIDv4", headerID)
	}
	if contextID != headerID {
		t.Errorf("context request_id %q != header %q", contextID, headerID)
	}
}

// TestRequestID_PreservesIncoming verifies that an existing X-Request-ID header
// is preserved (not replaced with a new UUID).
func TestRequestID_PreservesIncoming(t *testing.T) {
	const existing = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

	var contextID string
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contextID = server.RequestIDFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	h := server.RequestID(inner)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Request-ID", existing)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if got := rec.Header().Get("X-Request-ID"); got != existing {
		t.Errorf("X-Request-ID: want %q, got %q", existing, got)
	}
	if contextID != existing {
		t.Errorf("context request_id: want %q, got %q", existing, contextID)
	}
}

// TestRecovery_PanicReturns500 verifies that a panicking handler produces a 500
// with the API_CONTRACT.md §Error Schema "internal" envelope carrying a
// populated details.correlation_id.
func TestRecovery_PanicReturns500(t *testing.T) {
	// Compose RequestID → Recovery (outermost → inner) so that when the panic
	// is caught by Recovery's deferred function, the request's context already
	// carries the correlation_id set by RequestID. This matches the production
	// middleware order in NewRouter: RequestID(Recovery(Logging(mux))).
	panicker := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("test panic from TestRecovery_PanicReturns500")
	})
	h := server.RequestID(server.Recovery(panicker))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rec.Code)
	}

	var env map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decoding recovery body: %v", err)
	}

	errBlock, _ := env["error"].(map[string]any)
	if errBlock == nil {
		t.Fatal("missing error block in recovery response")
	}
	if kind, _ := errBlock["kind"].(string); kind != "internal" {
		t.Errorf("kind: want \"internal\", got %q", kind)
	}
	details, _ := errBlock["details"].(map[string]any)
	if details == nil {
		t.Fatal("missing details in recovery response")
	}
	correlationID, _ := details["correlation_id"].(string)
	if correlationID == "" {
		t.Error("details.correlation_id must be non-empty per API_CONTRACT.md §Error Schema lines 152–155")
	}
}

// TestLogging_StructuredLine verifies that the Logging middleware emits exactly
// one structured log line per request containing method, path, status,
// duration_ms, and request_id.
func TestLogging_StructuredLine(t *testing.T) {
	var buf bytes.Buffer
	// Redirect the process-level logger to our buffer for the duration of this test.
	orig := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(orig)
	log.SetFlags(0) // suppress timestamp prefix so matching is simpler

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	h := server.RequestID(server.Logging(inner))
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	line := buf.String()
	for _, want := range []string{"method=GET", "path=/api/health", "status=200", "duration_ms=", "request_id="} {
		if !bytes.Contains([]byte(line), []byte(want)) {
			t.Errorf("log line missing %q; got: %s", want, line)
		}
	}
}
