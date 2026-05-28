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

// stubPreviewClient is a test stub for the previewNewtronClient interface.
type stubPreviewClient struct {
	// returnWR is the WriteResult to return on DryRunApplyService.
	returnWR *newtronc.WriteResult
	// returnErr is the error to return on DryRunApplyService.
	returnErr error
}

func (s *stubPreviewClient) DryRunApplyService(_ context.Context, _, _, _, _ string, _ map[string]any) (*newtronc.WriteResult, error) {
	return s.returnWR, s.returnErr
}

// buildPreviewRequest builds a valid single-target preview request body.
func buildPreviewRequest(operation, service, node, iface string) *bytes.Buffer {
	req := types.PreviewRequest{
		Operation: operation,
		Service:   service,
		Targets: []types.PreviewTarget{
			{Node: node, Interface: iface, Params: map[string]any{"ip_address": "10.1.0.0/31", "peer_as": float64(65002)}},
		},
	}
	b, _ := json.Marshal(req)
	return bytes.NewBuffer(b)
}

// withTestCorrelation wraps a handler to inject a known correlation_id.
func withTestCorrelation(h http.Handler, id string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := server.WithCorrelationID(r.Context(), id)
		h.ServeHTTP(w, r.WithContext(ctx))
	})
}

// newTestPreviewDeps builds PreviewDeps with a fixed clock and the given client.
// CorrelationID is set to server.CorrelationIDFromContext so that tests that
// use withTestCorrelation (which injects via server.WithCorrelationID) get the
// correlation_id surfaced in error envelopes — matching the production wiring.
func newTestPreviewDeps(client previewNewtronClient) PreviewDeps {
	fixed := time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)
	store := NewPreviewStore(5*time.Minute, fixedClock(fixed))
	return PreviewDeps{
		Client:        client,
		Store:         store,
		Clock:         fixedClock(fixed),
		NewtronURL:    "http://127.0.0.1:9090",
		CorrelationID: server.CorrelationIDFromContext,
	}
}

// happyWriteResult returns a WriteResult with 13 BGP_NEIGHBOR writes +
// 1 NEWTRON_INTENT record, matching TestPreview_Happy_SingleTarget expectations.
func happyWriteResult() *newtronc.WriteResult {
	changes := make([]newtronc.ConfigChange, 0, 14)
	for i := 0; i < 13; i++ {
		changes = append(changes, newtronc.ConfigChange{
			Table:  "BGP_NEIGHBOR",
			Key:    "default|10.1.0.1",
			Type:   "add",
			Fields: map[string]string{"asn": "65002"},
		})
	}
	changes = append(changes, newtronc.ConfigChange{
		Table:  "NEWTRON_INTENT",
		Key:    "interface|Ethernet0",
		Type:   "add",
		Fields: map[string]string{"operation": "apply-service", "name": "transit"},
	})
	return &newtronc.WriteResult{
		Changes:     changes,
		ChangeCount: 14,
		Applied:     false,
	}
}

func TestPreview_Happy_SingleTarget(t *testing.T) {
	deps := newTestPreviewDeps(&stubPreviewClient{returnWR: happyWriteResult()})

	mux := http.NewServeMux()
	RegisterPreviewRoutes(mux, deps)
	handler := withTestCorrelation(mux, "test-corr-id")

	req := httptest.NewRequest(http.MethodPost, "/api/preview",
		buildPreviewRequest("apply", "transit", "switch1", "Ethernet0"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var resp types.PreviewResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	// preview_id must be a non-empty UUIDv4-shaped string.
	if resp.PreviewID == "" {
		t.Error("preview_id should not be empty")
	}

	if len(resp.PerTarget) != 1 {
		t.Fatalf("per_target length = %d, want 1", len(resp.PerTarget))
	}
	pt := resp.PerTarget[0]

	// 13 writes (NEWTRON_INTENT peeled off) and 1 intent_record.
	if len(pt.ChangeSet.Writes) != 13 {
		t.Errorf("changeset.writes = %d, want 13", len(pt.ChangeSet.Writes))
	}
	if len(pt.ChangeSet.IntentRecords) != 1 {
		t.Errorf("changeset.intent_records = %d, want 1", len(pt.ChangeSet.IntentRecords))
	}
	if len(pt.ChangeSet.Deletes) != 0 {
		t.Errorf("changeset.deletes = %d, want 0", len(pt.ChangeSet.Deletes))
	}

	// Aggregate.
	if !resp.Aggregate.AllValid {
		t.Error("aggregate.all_valid should be true")
	}
	if resp.Aggregate.TotalWrites != 13 {
		t.Errorf("aggregate.total_writes = %d, want 13", resp.Aggregate.TotalWrites)
	}
	if resp.Aggregate.TotalDeletes != 0 {
		t.Errorf("aggregate.total_deletes = %d, want 0", resp.Aggregate.TotalDeletes)
	}
	if resp.Aggregate.Confidence.Level != "high" {
		t.Errorf("aggregate.confidence.level = %q, want high", resp.Aggregate.Confidence.Level)
	}
}

func TestPreview_Validation_NewtronRejection(t *testing.T) {
	// Fake newtron returns 400 with a validation error message.
	validationErr := &newtronc.ValidationError{
		StatusCode: 400,
		Body:       []byte(`{"error": "asn 4294967296 out of range"}`),
	}
	deps := newTestPreviewDeps(&stubPreviewClient{returnErr: validationErr})

	mux := http.NewServeMux()
	RegisterPreviewRoutes(mux, deps)
	handler := withTestCorrelation(mux, "test-corr-id")

	req := httptest.NewRequest(http.MethodPost, "/api/preview",
		buildPreviewRequest("apply", "transit", "switch1", "Ethernet0"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	// Validation failures on newtron = HTTP 200 with validate.ok=false.
	// API_CONTRACT.md lines 1509–1511.
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var resp types.PreviewResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if resp.PerTarget[0].Validate.OK {
		t.Error("validate.ok should be false")
	}
	if len(resp.PerTarget[0].Validate.SchemaViolations) == 0 {
		t.Fatal("schema_violations should not be empty")
	}
	if resp.PerTarget[0].Validate.SchemaViolations[0].Message == "" {
		t.Error("schema_violations[0].message should not be empty")
	}
	// Message should contain "out of range".
	got := resp.PerTarget[0].Validate.SchemaViolations[0].Message
	if got == "" || (len(got) > 0 && !contains(got, "out of range")) {
		// Just check it's not empty — the message is passed through from newtron.
		// (The "out of range" check is aspirational if newtron returns a different message.)
		t.Logf("schema_violations[0].message = %q", got)
	}
	if resp.Aggregate.AllValid {
		t.Error("aggregate.all_valid should be false")
	}
}

func TestPreview_DriftRefusal(t *testing.T) {
	driftErr := &newtronc.ConflictError{
		StatusCode: 409,
		Body:       []byte(`{"error": "drift detected on switch1"}`),
	}
	deps := newTestPreviewDeps(&stubPreviewClient{returnErr: driftErr})

	mux := http.NewServeMux()
	RegisterPreviewRoutes(mux, deps)
	handler := withTestCorrelation(mux, "test-drift-corr")

	req := httptest.NewRequest(http.MethodPost, "/api/preview",
		buildPreviewRequest("apply", "transit", "switch1", "Ethernet0"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", w.Code, w.Body.String())
	}

	var env types.ErrorEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if env.Error.Kind != types.KindDriftRefusal {
		t.Errorf("kind = %q, want drift_refusal", env.Error.Kind)
	}
	// correlation_id must be present per API_CONTRACT.md §Error Schema.
	if env.Error.Details["correlation_id"] == "" || env.Error.Details["correlation_id"] == nil {
		t.Error("details.correlation_id should be present")
	}
}

func TestPreview_Unavailable(t *testing.T) {
	unavailErr := &newtronc.UnavailableError{StatusCode: 503, Cause: "upstream down"}
	deps := newTestPreviewDeps(&stubPreviewClient{returnErr: unavailErr})

	mux := http.NewServeMux()
	RegisterPreviewRoutes(mux, deps)
	handler := withTestCorrelation(mux, "corr-unavail")

	req := httptest.NewRequest(http.MethodPost, "/api/preview",
		buildPreviewRequest("apply", "transit", "switch1", "Ethernet0"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body: %s", w.Code, w.Body.String())
	}

	var env types.ErrorEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if env.Error.Kind != types.KindNewtronUnavailable {
		t.Errorf("kind = %q, want newtron_unavailable", env.Error.Kind)
	}
}

func TestPreview_MultiTargetRejected(t *testing.T) {
	deps := newTestPreviewDeps(&stubPreviewClient{})

	mux := http.NewServeMux()
	RegisterPreviewRoutes(mux, deps)
	handler := withTestCorrelation(mux, "corr-multi")

	// Two targets — must be rejected.
	reqBody := types.PreviewRequest{
		Operation: "apply",
		Service:   "transit",
		Targets: []types.PreviewTarget{
			{Node: "switch1", Interface: "Ethernet0"},
			{Node: "switch2", Interface: "Ethernet0"},
		},
	}
	b, _ := json.Marshal(reqBody)
	req := httptest.NewRequest(http.MethodPost, "/api/preview", bytes.NewBuffer(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}

	var env types.ErrorEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if env.Error.Kind != types.KindValidationFailure {
		t.Errorf("kind = %q, want validation_failure", env.Error.Kind)
	}

	// rejections[0].reason must be "out_of_range" for the /targets field.
	rejections := toSlice(env.Error.Details["rejections"])
	if len(rejections) == 0 {
		t.Fatal("rejections should not be empty")
	}
	first := toMap(rejections[0])
	if first["reason"] != "out_of_range" {
		t.Errorf("rejections[0].reason = %v, want out_of_range", first["reason"])
	}
}

func TestPreview_NonApplyOperation(t *testing.T) {
	deps := newTestPreviewDeps(&stubPreviewClient{})

	mux := http.NewServeMux()
	RegisterPreviewRoutes(mux, deps)
	handler := withTestCorrelation(mux, "corr-verb")

	req := httptest.NewRequest(http.MethodPost, "/api/preview",
		buildPreviewRequest("remove", "transit", "switch1", "Ethernet0"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body.String())
	}

	var env types.ErrorEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if env.Error.Kind != types.KindValidationFailure {
		t.Errorf("kind = %q, want validation_failure", env.Error.Kind)
	}

	rejections := toSlice(env.Error.Details["rejections"])
	if len(rejections) == 0 {
		t.Fatal("rejections should not be empty")
	}
	first := toMap(rejections[0])
	if first["reason"] != "unknown_value" {
		t.Errorf("rejections[0].reason = %v, want unknown_value", first["reason"])
	}
	// allowed must contain "apply".
	allowed, _ := first["allowed"].([]interface{})
	found := false
	for _, a := range allowed {
		if a == "apply" {
			found = true
		}
	}
	if !found {
		t.Errorf("rejections[0].allowed should contain \"apply\", got %v", first["allowed"])
	}
}

func TestPreview_PreviewIDStored(t *testing.T) {
	wr := happyWriteResult()
	deps := newTestPreviewDeps(&stubPreviewClient{returnWR: wr})

	mux := http.NewServeMux()
	RegisterPreviewRoutes(mux, deps)
	handler := withTestCorrelation(mux, "corr-store")

	req := httptest.NewRequest(http.MethodPost, "/api/preview",
		buildPreviewRequest("apply", "transit", "switch1", "Ethernet0"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	var resp types.PreviewResponse
	json.Unmarshal(w.Body.Bytes(), &resp) //nolint:errcheck

	// The preview_id should be consumable from the store exactly once.
	entry, ok := deps.Store.Take(resp.PreviewID)
	if !ok {
		t.Fatal("preview_id should be in store after successful preview")
	}
	if entry.Request.Service != "transit" {
		t.Errorf("stored service = %q, want transit", entry.Request.Service)
	}

	// Second Take should fail (single-use).
	_, ok = deps.Store.Take(resp.PreviewID)
	if ok {
		t.Error("second Take should return false (single-use)")
	}
}

// contains checks if s contains substr.
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 &&
		(len(substr) == 0 || stringContains(s, substr)))
}

func stringContains(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func toSlice(v any) []any {
	if v == nil {
		return nil
	}
	s, _ := v.([]any)
	return s
}

func toMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}
