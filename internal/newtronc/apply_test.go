package newtronc

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestExecuteApplyService_Success(t *testing.T) {
	const newtronResp = `{
		"data": {
			"applied": true,
			"verified": true,
			"verification": {"passed": 14, "failed": 0},
			"per_write": [
				{
					"seq": 0,
					"kind": "redis_write",
					"table": "BGP_NEIGHBOR",
					"key": "default|10.1.0.1",
					"fields": {"asn": "65002"},
					"result": "applied",
					"device_response": "(integer) 1",
					"at": "2026-05-28T14:06:01Z"
				}
			],
			"change_count": 1
		}
	}`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify dry_run is NOT present for execute path.
		if r.URL.Query().Get("dry_run") == "true" {
			t.Error("unexpected dry_run=true on execute path")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(newtronResp)) //nolint:errcheck
	}))
	defer srv.Close()

	c := New(srv.URL)
	wr, vf, err := c.ExecuteApplyService(context.Background(), "default", "switch1", "Ethernet0", "transit", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if vf != nil {
		t.Fatalf("unexpected verify failure: %v", vf)
	}
	if !wr.Applied {
		t.Error("Applied should be true")
	}
	if wr.Verification == nil {
		t.Fatal("Verification should not be nil")
	}
	if wr.Verification.Passed != 14 {
		t.Errorf("Passed = %d, want 14", wr.Verification.Passed)
	}
	if len(wr.PerWrite) != 1 {
		t.Fatalf("PerWrite: got %d, want 1", len(wr.PerWrite))
	}
	if wr.PerWrite[0].Kind != "redis_write" {
		t.Errorf("PerWrite[0].Kind = %q, want redis_write", wr.PerWrite[0].Kind)
	}
}

// TestExecuteApplyService_VerificationFailure is the CRITICAL conformance test.
// Fake newtron returns 409 with the typed data:*WriteResult envelope per newtron#21.
// The newtronc layer must decode this as *VerifyFailure (NOT an error),
// byte-preserving device_response.
func TestExecuteApplyService_VerificationFailure(t *testing.T) {
	// This payload matches the shape newtron#21 introduced (handler.go:215–225 writeError).
	// The device_response "local_asn=99999 router_id=10.0.0.1" must survive byte-for-byte.
	const newtronResp = `{
		"error": "verification failed on switch1: 1/14",
		"data": {
			"applied": true,
			"verified": false,
			"verification": {
				"passed": 13,
				"failed": 1,
				"errors": [
					{
						"table": "BGP_NEIGHBOR",
						"key": "default|10.1.0.1",
						"field": "asn",
						"expected": "65002",
						"actual": "",
						"device_response": "local_asn=99999 router_id=10.0.0.1"
					}
				]
			},
			"per_write": [
				{
					"seq": 0,
					"kind": "verify_read",
					"table": "BGP_NEIGHBOR",
					"key": "default|10.1.0.1",
					"result": "rejected",
					"device_response": "local_asn=99999",
					"at": "2026-05-28T14:06:02Z"
				}
			],
			"change_count": 14
		}
	}`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict) // 409
		w.Write([]byte(newtronResp))       //nolint:errcheck
	}))
	defer srv.Close()

	c := New(srv.URL)
	wr, vf, err := c.ExecuteApplyService(context.Background(), "default", "switch1", "Ethernet0", "transit", nil)

	// Must NOT be a Go error — VerifyFailure is the typed carrier.
	if err != nil {
		t.Fatalf("unexpected error: %v (should be VerifyFailure, not error)", err)
	}
	if wr != nil {
		t.Fatalf("wr should be nil on verify failure path")
	}
	if vf == nil {
		t.Fatal("VerifyFailure should not be nil")
	}

	// WriteResult must be present (newtron#21 typed envelope).
	if vf.WriteResult == nil {
		t.Fatal("VerifyFailure.WriteResult should not be nil")
	}
	if !vf.WriteResult.Applied {
		t.Error("VerifyFailure.WriteResult.Applied should be true (write landed)")
	}
	if vf.WriteResult.Verification == nil {
		t.Fatal("VerifyFailure.WriteResult.Verification should not be nil")
	}
	if vf.WriteResult.Verification.Failed != 1 {
		t.Errorf("Verification.Failed = %d, want 1", vf.WriteResult.Verification.Failed)
	}

	// The critical byte-preservation check: device_response must survive verbatim.
	if len(vf.WriteResult.Verification.Errors) != 1 {
		t.Fatalf("Verification.Errors: got %d, want 1", len(vf.WriteResult.Verification.Errors))
	}
	got := vf.WriteResult.Verification.Errors[0].DeviceResponse
	want := "local_asn=99999 router_id=10.0.0.1"
	if got != want {
		t.Errorf("DeviceResponse = %q, want %q (byte-preservation violation — invariant #7)", got, want)
	}

	// PerWrite must be populated (newtron#21 also surfaces per_write on failure path).
	if len(vf.WriteResult.PerWrite) != 1 {
		t.Fatalf("PerWrite: got %d, want 1", len(vf.WriteResult.PerWrite))
	}
	if vf.WriteResult.PerWrite[0].Kind != "verify_read" {
		t.Errorf("PerWrite[0].Kind = %q, want verify_read", vf.WriteResult.PerWrite[0].Kind)
	}
}

func TestExecuteApplyService_DriftRefusal(t *testing.T) {
	// 409 with no data field → drift_refusal (ConflictError).
	const newtronResp = `{"error": "drift detected on switch1"}`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(newtronResp)) //nolint:errcheck
	}))
	defer srv.Close()

	c := New(srv.URL)
	wr, vf, err := c.ExecuteApplyService(context.Background(), "default", "switch1", "Ethernet0", "transit", nil)

	if wr != nil || vf != nil {
		t.Fatalf("expected (nil, nil, error) on drift refusal, got wr=%v vf=%v", wr, vf)
	}
	if err == nil {
		t.Fatal("expected ConflictError, got nil")
	}
	if _, ok := err.(*ConflictError); !ok {
		t.Errorf("expected *ConflictError, got %T: %v", err, err)
	}
}

func TestExecuteApplyService_Unavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"error": "upstream down"}`)) //nolint:errcheck
	}))
	defer srv.Close()

	c := New(srv.URL)
	_, _, err := c.ExecuteApplyService(context.Background(), "default", "switch1", "Ethernet0", "transit", nil)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*UnavailableError); !ok {
		t.Errorf("expected *UnavailableError, got %T: %v", err, err)
	}
}

func TestDecodeConflict409_VerifyFailureHasApplied(t *testing.T) {
	// Body with data.applied:true and verification.failed > 0 → VerifyFailure.
	body := []byte(`{
		"error": "verification failed",
		"data": {
			"applied": true,
			"verified": false,
			"verification": {"passed": 5, "failed": 1, "errors": []},
			"change_count": 6
		}
	}`)

	vf, isDriftRefusal, err := decodeConflict409(body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if isDriftRefusal {
		t.Error("should not be drift_refusal")
	}
	if vf == nil {
		t.Fatal("VerifyFailure should not be nil")
	}
	if !vf.WriteResult.Applied {
		t.Error("WriteResult.Applied should be true")
	}
}

func TestDecodeConflict409_NoDriftEntry(t *testing.T) {
	// Body with no data field → drift_refusal.
	body := []byte(`{"error": "drift detected"}`)
	vf, isDriftRefusal, err := decodeConflict409(body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !isDriftRefusal {
		t.Error("expected isDriftRefusal=true for body with no data")
	}
	if vf != nil {
		t.Error("VerifyFailure should be nil for drift_refusal")
	}
}

// Ensure PerSubstrateOp.At parses correctly from test data.
func TestPerSubstrateOpAtParsing(t *testing.T) {
	op := PerSubstrateOp{}
	const atStr = `"2026-05-28T14:06:01Z"`
	if err := op.At.UnmarshalJSON([]byte(atStr)); err != nil {
		t.Fatalf("UnmarshalJSON: %v", err)
	}
	want := time.Date(2026, 5, 28, 14, 6, 1, 0, time.UTC)
	if !op.At.Equal(want) {
		t.Errorf("At = %v, want %v", op.At, want)
	}
}
