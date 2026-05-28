package newtronc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// serveJSON starts a test server that responds with the given status and body.
func serveJSON(status int, body string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		w.Write([]byte(body)) //nolint:errcheck
	}))
}

func TestDryRunApplyService_Success(t *testing.T) {
	// Fake newtron dry-run response with one BGP_NEIGHBOR change.
	const newtronResp = `{
		"data": {
			"changes": [
				{
					"table": "BGP_NEIGHBOR",
					"key": "default|10.1.0.1",
					"type": "add",
					"fields": {"asn": "65002", "local_addr": "10.1.0.0"}
				}
			],
			"change_count": 1,
			"applied": false,
			"verified": false
		}
	}`

	srv := serveJSON(http.StatusOK, newtronResp)
	defer srv.Close()

	c := New(srv.URL)
	wr, err := c.DryRunApplyService(context.Background(), "default", "switch1", "Ethernet0", "transit", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(wr.Changes) != 1 {
		t.Fatalf("Changes: got %d, want 1", len(wr.Changes))
	}
	if wr.Changes[0].Table != "BGP_NEIGHBOR" {
		t.Errorf("Changes[0].Table = %q, want %q", wr.Changes[0].Table, "BGP_NEIGHBOR")
	}
	if wr.Applied {
		t.Error("Applied should be false on dry-run")
	}
}

func TestDryRunApplyService_ValidationError(t *testing.T) {
	const newtronResp = `{"error": "peer_as out of range"}`

	srv := serveJSON(http.StatusBadRequest, newtronResp)
	defer srv.Close()

	c := New(srv.URL)
	_, err := c.DryRunApplyService(context.Background(), "default", "switch1", "Ethernet0", "transit", nil)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*ValidationError); !ok {
		t.Errorf("expected *ValidationError, got %T: %v", err, err)
	}
}

func TestDryRunApplyService_ConflictIsDriftRefusal(t *testing.T) {
	const newtronResp = `{"error": "drift detected"}`

	srv := serveJSON(http.StatusConflict, newtronResp)
	defer srv.Close()

	c := New(srv.URL)
	_, err := c.DryRunApplyService(context.Background(), "default", "switch1", "Ethernet0", "transit", nil)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*ConflictError); !ok {
		t.Errorf("expected *ConflictError, got %T: %v", err, err)
	}
}

func TestDryRunApplyService_Unavailable(t *testing.T) {
	srv := serveJSON(http.StatusServiceUnavailable, `{"error":"service unavailable"}`)
	defer srv.Close()

	c := New(srv.URL)
	_, err := c.DryRunApplyService(context.Background(), "default", "switch1", "Ethernet0", "transit", nil)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*UnavailableError); !ok {
		t.Errorf("expected *UnavailableError, got %T: %v", err, err)
	}
}

func TestProjectChangeSet_PeelsIntentRecords(t *testing.T) {
	wr := &WriteResult{
		Changes: []ConfigChange{
			{Table: "BGP_NEIGHBOR", Key: "default|10.1.0.1", Type: "add", Fields: map[string]string{"asn": "65002"}},
			{Table: "VRF", Key: "Vrf_TRANSIT", Type: "add", Fields: map[string]string{"vni": "10100"}},
			{Table: "NEWTRON_INTENT", Key: "interface|Ethernet0", Type: "add", Fields: map[string]string{"operation": "apply-service"}},
			{Table: "ACL_RULE", Key: "PROTECT|RULE_10", Type: "delete"},
		},
	}

	cs := ProjectChangeSet(wr, "default")

	if len(cs.Writes) != 2 {
		t.Errorf("Writes: got %d, want 2", len(cs.Writes))
	}
	if len(cs.Deletes) != 1 {
		t.Errorf("Deletes: got %d, want 1", len(cs.Deletes))
	}
	if len(cs.IntentRecords) != 1 {
		t.Errorf("IntentRecords: got %d, want 1", len(cs.IntentRecords))
	}
	if cs.IntentRecords[0].Table != "NEWTRON_INTENT" {
		t.Errorf("IntentRecords[0].Table = %q, want NEWTRON_INTENT", cs.IntentRecords[0].Table)
	}
}

func TestProjectChangeSet_WriteFieldsTypedAsAny(t *testing.T) {
	wr := &WriteResult{
		Changes: []ConfigChange{
			{Table: "BGP_NEIGHBOR", Key: "default|10.1.0.1", Type: "add", Fields: map[string]string{"asn": "65002"}},
		},
	}
	cs := ProjectChangeSet(wr, "default")
	if len(cs.Writes) != 1 {
		t.Fatalf("Writes: got %d, want 1", len(cs.Writes))
	}
	// Ensure Fields is map[string]any (round-trips through JSON properly).
	encoded, err := json.Marshal(cs.Writes[0].Fields)
	if err != nil {
		t.Fatalf("marshal fields: %v", err)
	}
	if string(encoded) == "null" {
		t.Error("Fields should not be null")
	}
}

func TestProjectChangeSet_DeleteHasNilFields(t *testing.T) {
	wr := &WriteResult{
		Changes: []ConfigChange{
			{Table: "ACL_RULE", Key: "PROTECT|RULE_10", Type: "delete"},
		},
	}
	cs := ProjectChangeSet(wr, "default")
	if len(cs.Deletes) != 1 {
		t.Fatalf("Deletes: got %d, want 1", len(cs.Deletes))
	}
	if cs.Deletes[0].Fields != nil {
		t.Errorf("Deletes[0].Fields should be nil for whole-row delete, got %v", cs.Deletes[0].Fields)
	}
}
