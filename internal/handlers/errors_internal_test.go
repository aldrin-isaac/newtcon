package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// An EngineError — newtron reached but reporting a domain failure — must
// translate to 502 KindEngineError, surface the engine's actual message, and
// NOT carry the "engine unreachable" health-check hint (the daemon is up).
// Regression guard for the apply-service RTD report: a missing peer_as came
// back as a 500 with a real message and the UI read "engine unreachable".
func TestWriteUpstreamError_EngineError(t *testing.T) {
	w := httptest.NewRecorder()
	engErr := &newtronc.EngineError{
		StatusCode: http.StatusInternalServerError,
		Body:       []byte(`{"error":"BGP peering config for Ethernet0: service requires peer_as parameter"}`),
	}
	writeUpstreamError(w, "corr-1", engErr, "POST /apply-service", nil)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status: want 502, got %d", w.Code)
	}
	var env types.ErrorEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decoding envelope: %v", err)
	}
	if env.Error.Kind != types.KindEngineError {
		t.Errorf("kind: want %q, got %q", types.KindEngineError, env.Error.Kind)
	}
	msg, _ := env.Error.Details["underlying_error_message"].(string)
	if msg != "BGP peering config for Ethernet0: service requires peer_as parameter" {
		t.Errorf("underlying message not surfaced verbatim; got %q", msg)
	}
	// The daemon is up — no unreachable health hint.
	if _, hinted := env.Error.Details["next_action_hint"]; hinted {
		t.Errorf("EngineError must not carry a health-check next_action_hint: %+v", env.Error.Details)
	}
}

// A genuine unreachable (transport failure — StatusCode 0) still translates to
// KindNewtronUnavailable with the health hint. Guards the split from
// regressing the true-unreachable path.
func TestWriteUpstreamError_UnavailableStillUnreachable(t *testing.T) {
	w := httptest.NewRecorder()
	unavail := &newtronc.UnavailableError{StatusCode: 0, Cause: "connection refused"}
	writeUpstreamError(w, "corr-2", unavail, "GET /health", nil)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status: want 503, got %d", w.Code)
	}
	var env types.ErrorEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decoding envelope: %v", err)
	}
	if env.Error.Kind != types.KindNewtronUnavailable {
		t.Errorf("kind: want %q, got %q", types.KindNewtronUnavailable, env.Error.Kind)
	}
	if _, hinted := env.Error.Details["next_action_hint"]; !hinted {
		t.Errorf("a true unreachable should carry the health-check hint")
	}
}
