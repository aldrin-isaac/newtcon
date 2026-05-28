package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/server"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// stubApplyClient implements applyNewtronClient and lets each test configure
// exact return values.
type stubApplyClient struct {
	wr  *newtronc.WriteResult
	vf  *newtronc.VerifyFailure
	err error
}

func (s *stubApplyClient) ExecuteApplyService(_ context.Context, _, _, _, _ string, _ map[string]any) (*newtronc.WriteResult, *newtronc.VerifyFailure, error) {
	return s.wr, s.vf, s.err
}

// extractKind pulls the "error.kind" field from an ErrorEnvelope body.
func extractKind(t *testing.T, body []byte) string {
	t.Helper()
	var env struct {
		Error struct {
			Kind string `json:"kind"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("extractKind: unmarshal body %q: %v", string(body), err)
	}
	return env.Error.Kind
}

// newTestApplyDeps wires an apply handler with the given stub client, a shared
// preview store, and a fixed clock.
// CorrelationID is set to server.CorrelationIDFromContext to match production
// wiring; doApply injects a test correlation_id via server.WithCorrelationID.
func newTestApplyDeps(client applyNewtronClient, store *PreviewStore) ApplyDeps {
	return ApplyDeps{
		Client:        client,
		Store:         store,
		Clock:         fixedClock(time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)),
		NewtronURL:    "http://newtron-test:21182",
		CorrelationID: server.CorrelationIDFromContext,
	}
}

// seedPreview places a valid preview entry into the store and returns its ID.
func seedPreview(t *testing.T, store *PreviewStore, node, iface, service string) string {
	t.Helper()
	previewID := "test-preview-id-001"
	store.Put(previewID, &PreviewEntry{
		Request: types.PreviewRequest{
			Operation: "apply",
			Service:   service,
			Targets:   []types.PreviewTarget{{Node: node, Interface: iface}},
		},
		WriteResult: &newtronc.WriteResult{Applied: false, ChangeCount: 5},
		IssuedAt:    time.Date(2026, 5, 28, 11, 55, 0, 0, time.UTC),
		ExpiresAt:   time.Date(2026, 5, 28, 12, 5, 0, 0, time.UTC),
	})
	return previewID
}

// doApply fires a POST /api/apply request against the handler and returns the
// recorder.
func doApply(t *testing.T, deps ApplyDeps, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal request body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/apply", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	// Inject correlation ID the same way the middleware does.
	req = req.WithContext(server.WithCorrelationID(context.Background(), "test-corr-apply"))

	rr := httptest.NewRecorder()
	mux := http.NewServeMux()
	RegisterApplyRoutes(mux, deps)
	mux.ServeHTTP(rr, req)
	return rr
}

// happyApplyWriteResult returns a WriteResult that represents a clean apply
// with 1 redis_write, 1 verify_read (passed), and a filled Verification struct.
func happyApplyWriteResult() *newtronc.WriteResult {
	at := time.Date(2026, 5, 28, 12, 0, 1, 0, time.UTC)
	return &newtronc.WriteResult{
		Applied:     true,
		Verified:    true,
		ChangeCount: 1,
		Verification: &newtronc.VerificationResult{
			Passed: 14,
			Failed: 0,
			Errors: []newtronc.VerificationError{},
		},
		PerWrite: []newtronc.PerSubstrateOp{
			{
				Seq:            0,
				Kind:           "redis_write",
				Table:          "BGP_NEIGHBOR",
				Key:            "default|10.1.0.1",
				Fields:         map[string]string{"asn": "65002"},
				Result:         "applied",
				DeviceResponse: "(integer) 1",
				At:             at,
			},
			{
				Seq:            1,
				Kind:           "verify_read",
				Table:          "BGP_NEIGHBOR",
				Key:            "default|10.1.0.1",
				Result:         "applied",
				DeviceResponse: "asn 65002 local_addr 10.1.0.0",
				At:             at,
			},
		},
	}
}

// verifyFailureResult constructs the VerifyFailure that newtronc surfaces when
// newtron returns a 409 VerificationFailedError.  The device_response value
// "local_asn=99999 router_id=10.0.0.1" is the byte-preservation invariant (#7).
func verifyFailureResult() *newtronc.VerifyFailure {
	at := time.Date(2026, 5, 28, 12, 0, 2, 0, time.UTC)
	return &newtronc.VerifyFailure{
		Message: "verification failed on switch1: 1/14",
		WriteResult: &newtronc.WriteResult{
			Applied:     true,
			Verified:    false,
			ChangeCount: 14,
			Verification: &newtronc.VerificationResult{
				Passed: 13,
				Failed: 1,
				Errors: []newtronc.VerificationError{
					{
						Table:          "BGP_NEIGHBOR",
						Key:            "default|10.1.0.1",
						Field:          "asn",
						Expected:       "65002",
						Actual:         "",
						DeviceResponse: "local_asn=99999 router_id=10.0.0.1",
					},
				},
			},
			PerWrite: []newtronc.PerSubstrateOp{
				{
					Seq:            0,
					Kind:           "verify_read",
					Table:          "BGP_NEIGHBOR",
					Key:            "default|10.1.0.1",
					Result:         "rejected",
					DeviceResponse: "local_asn=99999",
					At:             at,
				},
			},
		},
	}
}

// TestApply_Happy verifies the end-to-end success path:
//   - HTTP 200
//   - per_target[0].applied == true
//   - per_write slice populated
//   - verify.state == "complete"
//   - cli_command rendered for redis_write entry
func TestApply_Happy(t *testing.T) {
	store := NewPreviewStore(5*time.Minute, fixedClock(time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)))
	previewID := seedPreview(t, store, "switch1", "Ethernet0", "transit")

	client := &stubApplyClient{wr: happyApplyWriteResult()}
	deps := newTestApplyDeps(client, store)

	rr := doApply(t, deps, map[string]string{"preview_id": previewID})

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var resp types.ApplyResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp.OperationID == "" {
		t.Error("operation_id should not be empty")
	}
	if len(resp.PerTarget) != 1 {
		t.Fatalf("per_target: got %d, want 1", len(resp.PerTarget))
	}
	pt := resp.PerTarget[0]

	if !pt.Applied {
		t.Error("per_target[0].applied should be true")
	}
	if pt.Node != "switch1" {
		t.Errorf("per_target[0].node = %q, want switch1", pt.Node)
	}
	if pt.Interface != "Ethernet0" {
		t.Errorf("per_target[0].interface = %q, want Ethernet0", pt.Interface)
	}

	// verify.state == "complete" on the success path.
	if pt.Verify.State != "complete" {
		t.Errorf("verify.state = %q, want complete", pt.Verify.State)
	}
	if pt.Verify.Kind != "device_io_assertion" {
		t.Errorf("verify.kind = %q, want device_io_assertion", pt.Verify.Kind)
	}
	if pt.Verify.Assertion == nil {
		t.Fatal("verify.assertion should not be nil on success path")
	}
	if pt.Verify.Assertion.Passed != 14 {
		t.Errorf("verify.assertion.passed = %d, want 14", pt.Verify.Assertion.Passed)
	}

	// per_write populated (invariant #1).
	if len(pt.PerWrite) != 2 {
		t.Fatalf("per_write: got %d, want 2", len(pt.PerWrite))
	}

	// CLI command rendered for redis_write entry (invariant #2).
	if pt.PerWrite[0].Kind != "redis_write" {
		t.Fatalf("per_write[0].kind = %q, want redis_write", pt.PerWrite[0].Kind)
	}
	if pt.PerWrite[0].CLICommand == "" {
		t.Error("per_write[0].cli_command should not be empty for redis_write")
	}
	if !stringContains(pt.PerWrite[0].CLICommand, "HSET") {
		t.Errorf("per_write[0].cli_command %q should contain HSET", pt.PerWrite[0].CLICommand)
	}

	// Aggregate.
	if !resp.Aggregate.AllApplied {
		t.Error("aggregate.all_applied should be true")
	}
	if resp.Aggregate.TotalWritesLanded != 1 {
		t.Errorf("aggregate.total_writes_landed = %d, want 1", resp.Aggregate.TotalWritesLanded)
	}
}

// TestApply_VerifyFailure_Returns200WithFailedAssertion is the CONFORMANCE GATE.
//
// When newtron returns 409 VerificationFailedError, newtcon MUST return HTTP 200
// (not 4xx) with verify.state:"failed" and the verbatim device_response byte-
// preserved in verify.assertion.errors[].
//
// This behaviour is mandated by API_CONTRACT.md lines 3519–3539:
//
//	"Verify failure does not produce a 4xx envelope ... The substrate is
//	 surfaced on the 200 response through verify.state == 'failed' and
//	 verify.assertion.errors[]."
//
// Failure of this test = breaking change to the API contract.
func TestApply_VerifyFailure_Returns200WithFailedAssertion(t *testing.T) {
	store := NewPreviewStore(5*time.Minute, fixedClock(time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)))
	previewID := seedPreview(t, store, "switch1", "Ethernet0", "transit")

	client := &stubApplyClient{vf: verifyFailureResult()}
	deps := newTestApplyDeps(client, store)

	rr := doApply(t, deps, map[string]string{"preview_id": previewID})

	// THE CRITICAL ASSERTION: 200, not 4xx.
	if rr.Code != http.StatusOK {
		t.Fatalf("CONFORMANCE VIOLATION: status = %d, want 200 on verify-failure path; body: %s", rr.Code, rr.Body.String())
	}

	var resp types.ApplyResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if len(resp.PerTarget) != 1 {
		t.Fatalf("per_target: got %d, want 1", len(resp.PerTarget))
	}
	pt := resp.PerTarget[0]

	// applied:true — the write LANDED even though verify disagreed.
	if !pt.Applied {
		t.Error("per_target[0].applied should be true (write landed per newtron#21)")
	}

	// verify.state must be "failed".
	if pt.Verify.State != "failed" {
		t.Errorf("verify.state = %q, want failed", pt.Verify.State)
	}

	// Assertion present with failed > 0.
	if pt.Verify.Assertion == nil {
		t.Fatal("verify.assertion must not be nil on verify-failure path")
	}
	if pt.Verify.Assertion.Failed != 1 {
		t.Errorf("verify.assertion.failed = %d, want 1", pt.Verify.Assertion.Failed)
	}
	if pt.Verify.Assertion.Passed != 13 {
		t.Errorf("verify.assertion.passed = %d, want 13", pt.Verify.Assertion.Passed)
	}

	// errors[] populated.
	if len(pt.Verify.Assertion.Errors) != 1 {
		t.Fatalf("verify.assertion.errors: got %d, want 1", len(pt.Verify.Assertion.Errors))
	}

	// THE BYTE-PRESERVATION CHECK (invariant #7).
	gotDR := pt.Verify.Assertion.Errors[0].DeviceResponse
	wantDR := "local_asn=99999 router_id=10.0.0.1"
	if gotDR != wantDR {
		t.Errorf("BYTE-PRESERVATION VIOLATION: device_response = %q, want %q (invariant #7)", gotDR, wantDR)
	}

	// per_write surfaced (invariant #1).
	if len(pt.PerWrite) != 1 {
		t.Fatalf("per_write: got %d, want 1", len(pt.PerWrite))
	}
	if pt.PerWrite[0].Kind != "verify_read" {
		t.Errorf("per_write[0].kind = %q, want verify_read", pt.PerWrite[0].Kind)
	}
	if pt.PerWrite[0].Result != "rejected" {
		t.Errorf("per_write[0].result = %q, want rejected", pt.PerWrite[0].Result)
	}
	// The per-write device_response on the verify_read entry.
	if pt.PerWrite[0].DeviceResponse == "" {
		t.Error("per_write[0].device_response should not be empty for verify_read rejected")
	}
}

// TestApply_StalePreviewID checks that a missing or already-consumed preview_id
// returns HTTP 410 Gone.
func TestApply_StalePreviewID(t *testing.T) {
	store := NewPreviewStore(5*time.Minute, fixedClock(time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)))

	client := &stubApplyClient{wr: happyApplyWriteResult()}
	deps := newTestApplyDeps(client, store)

	// Use an ID that was never stored.
	rr := doApply(t, deps, map[string]string{"preview_id": "nonexistent-preview-id"})

	if rr.Code != http.StatusGone {
		t.Fatalf("status = %d, want 410 Gone; body: %s", rr.Code, rr.Body.String())
	}

	kind := extractKind(t, rr.Body.Bytes())
	if kind != string(types.KindPreconditionFailure) {
		t.Errorf("kind = %q, want precondition_failure", kind)
	}
}

// TestApply_PreviewIDOnlyConsumedOnce enforces single-use semantics:
// the first apply succeeds (200), the second attempt with the same preview_id
// returns 410.
func TestApply_PreviewIDOnlyConsumedOnce(t *testing.T) {
	store := NewPreviewStore(5*time.Minute, fixedClock(time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)))
	previewID := seedPreview(t, store, "switch1", "Ethernet0", "transit")

	client := &stubApplyClient{wr: happyApplyWriteResult()}
	deps := newTestApplyDeps(client, store)

	// First apply consumes the preview_id.
	rr1 := doApply(t, deps, map[string]string{"preview_id": previewID})
	if rr1.Code != http.StatusOK {
		t.Fatalf("first apply: status = %d, want 200; body: %s", rr1.Code, rr1.Body.String())
	}

	// Second apply with same preview_id must return 410.
	rr2 := doApply(t, deps, map[string]string{"preview_id": previewID})
	if rr2.Code != http.StatusGone {
		t.Fatalf("second apply: status = %d, want 410 (single-use consumed); body: %s", rr2.Code, rr2.Body.String())
	}
}

// TestApply_NewtronUnavailable checks that a newtron connection failure
// is surfaced as HTTP 503 with kind:newtron_unavailable.
func TestApply_NewtronUnavailable(t *testing.T) {
	store := NewPreviewStore(5*time.Minute, fixedClock(time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)))
	previewID := seedPreview(t, store, "switch1", "Ethernet0", "transit")

	client := &stubApplyClient{err: &newtronc.UnavailableError{Cause: "connection refused"}}
	deps := newTestApplyDeps(client, store)

	rr := doApply(t, deps, map[string]string{"preview_id": previewID})

	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body: %s", rr.Code, rr.Body.String())
	}
	kind := extractKind(t, rr.Body.Bytes())
	if kind != string(types.KindNewtronUnavailable) {
		t.Errorf("kind = %q, want newtron_unavailable", kind)
	}
}

// TestApply_PerWriteSubstrate verifies operator-philosophy invariant #1:
// the per_write[] array surfaces the full substrate for each operation,
// including cli_command and device_response.
func TestApply_PerWriteSubstrate(t *testing.T) {
	store := NewPreviewStore(5*time.Minute, fixedClock(time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)))
	previewID := seedPreview(t, store, "switch1", "Ethernet0", "transit")

	client := &stubApplyClient{wr: happyApplyWriteResult()}
	deps := newTestApplyDeps(client, store)

	rr := doApply(t, deps, map[string]string{"preview_id": previewID})
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}

	var resp types.ApplyResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	pt := resp.PerTarget[0]
	if len(pt.PerWrite) != 2 {
		t.Fatalf("per_write: got %d, want 2", len(pt.PerWrite))
	}

	// Seq ordering preserved.
	if pt.PerWrite[0].Seq != 0 {
		t.Errorf("per_write[0].seq = %d, want 0", pt.PerWrite[0].Seq)
	}
	if pt.PerWrite[1].Seq != 1 {
		t.Errorf("per_write[1].seq = %d, want 1", pt.PerWrite[1].Seq)
	}

	// redis_write entry has substrate populated.
	pw0 := pt.PerWrite[0]
	if pw0.Substrate == nil {
		t.Fatal("per_write[0].substrate should not be nil for redis_write")
	}
	if pw0.Substrate.Table != "BGP_NEIGHBOR" {
		t.Errorf("per_write[0].substrate.table = %q, want BGP_NEIGHBOR", pw0.Substrate.Table)
	}
	if pw0.Substrate.Key != "default|10.1.0.1" {
		t.Errorf("per_write[0].substrate.key = %q, want default|10.1.0.1", pw0.Substrate.Key)
	}

	// device_response byte-preserved for the redis_write.
	if pw0.DeviceResponse != "(integer) 1" {
		t.Errorf("per_write[0].device_response = %q, want (integer) 1", pw0.DeviceResponse)
	}

	// target triple correct.
	if pw0.Target.Network != "default" {
		t.Errorf("per_write[0].target.network = %q, want default", pw0.Target.Network)
	}
	if pw0.Target.Node != "switch1" {
		t.Errorf("per_write[0].target.node = %q, want switch1", pw0.Target.Node)
	}
	if pw0.Target.Interface != "Ethernet0" {
		t.Errorf("per_write[0].target.interface = %q, want Ethernet0", pw0.Target.Interface)
	}

	// rationale_ref populated.
	if pw0.RationaleRef.Substrate == "" {
		t.Error("per_write[0].rationale_ref.substrate should not be empty")
	}
	if pw0.RationaleRef.Principle == "" {
		t.Error("per_write[0].rationale_ref.principle should not be empty")
	}

	// source is always nil in v1.
	if pw0.Source != nil {
		t.Error("per_write[0].source should be nil in v1")
	}

	// verify_read entry has cli_command rendered.
	pw1 := pt.PerWrite[1]
	if pw1.Kind != "verify_read" {
		t.Fatalf("per_write[1].kind = %q, want verify_read", pw1.Kind)
	}
	if !stringContains(pw1.CLICommand, "HGETALL") {
		t.Errorf("per_write[1].cli_command %q should contain HGETALL for verify_read", pw1.CLICommand)
	}
}

// TestApply_MissingPreviewID verifies 400 when preview_id is absent.
func TestApply_MissingPreviewID(t *testing.T) {
	store := NewPreviewStore(5*time.Minute, fixedClock(time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)))
	client := &stubApplyClient{}
	deps := newTestApplyDeps(client, store)

	// Send a body without preview_id.
	rr := doApply(t, deps, map[string]string{})

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", rr.Code, rr.Body.String())
	}
	kind := extractKind(t, rr.Body.Bytes())
	if kind != string(types.KindValidationFailure) {
		t.Errorf("kind = %q, want validation_failure", kind)
	}
}

// TestApply_DriftRefusalOnApply verifies that a drift-refusal from newtron
// on the execute path surfaces as HTTP 409 with kind:drift_refusal.
func TestApply_DriftRefusalOnApply(t *testing.T) {
	store := NewPreviewStore(5*time.Minute, fixedClock(time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)))
	previewID := seedPreview(t, store, "switch1", "Ethernet0", "transit")

	client := &stubApplyClient{err: &newtronc.ConflictError{Body: []byte(`{"error":"drift detected on switch1"}`)}}
	deps := newTestApplyDeps(client, store)

	rr := doApply(t, deps, map[string]string{"preview_id": previewID})

	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", rr.Code, rr.Body.String())
	}
	kind := extractKind(t, rr.Body.Bytes())
	if kind != string(types.KindDriftRefusal) {
		t.Errorf("kind = %q, want drift_refusal", kind)
	}
}
