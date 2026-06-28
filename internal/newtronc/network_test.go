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

// TestCreateSpec_Success verifies that CreateSpec posts to the correct
// newtron create-<kind> verb and returns the decoded data field.
func TestCreateSpec_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/create-service" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"name":"transit"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.CreateSpec(context.Background(), "default", "service", map[string]string{
		"name": "transit",
		"type": "routed",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("decoding raw: %v", err)
	}
	if got["name"] != "transit" {
		t.Errorf("name: want \"transit\", got %v", got["name"])
	}
}

// TestCreateSpec_ValidationFailure verifies that a 400 from newtron yields
// a *ValidationError.
func TestCreateSpec_ValidationFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.CreateSpec(context.Background(), "default", "service", map[string]string{})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*newtronc.ValidationError); !ok {
		t.Errorf("expected *ValidationError, got %T: %v", err, err)
	}
}

// TestCreateSpec_Conflict verifies that a 409 from newtron yields a *ConflictError.
func TestCreateSpec_Conflict(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"service already exists"}`, http.StatusConflict)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.CreateSpec(context.Background(), "default", "service", map[string]string{"name": "transit"})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*newtronc.ConflictError); !ok {
		t.Errorf("expected *ConflictError, got %T: %v", err, err)
	}
}

// TestDeleteSpec_Success verifies that DeleteSpec posts to the correct
// newtron delete-<kind> verb with {"name": <name>}.
func TestDeleteSpec_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/delete-service" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		var req map[string]string
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decoding body: %v", err)
		}
		if req["name"] != "transit" {
			t.Errorf("name: want \"transit\", got %q", req["name"])
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"deleted"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	if err := c.DeleteSpec(context.Background(), "default", "service", "transit", "", "", false); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestDeleteSpec_NotFound verifies that a 404 from newtron yields a *NotFoundError.
func TestDeleteSpec_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"service not found"}`, http.StatusNotFound)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	err := c.DeleteSpec(context.Background(), "default", "service", "nonexistent", "", "", false)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if _, ok := err.(*newtronc.NotFoundError); !ok {
		t.Errorf("expected *NotFoundError, got %T: %v", err, err)
	}
}

// TestAddQoSQueue_Success verifies that AddQoSQueue posts to add-qos-queue.
func TestAddQoSQueue_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/add-qos-queue" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"queue_id":1},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.AddQoSQueue(context.Background(), "default", map[string]any{
		"policy":   "my-policy",
		"queue_id": 1,
		"name":     "q1",
		"type":     "strict",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil result")
	}
}

// TestRemoveQoSQueue_Success verifies that RemoveQoSQueue posts to
// remove-qos-queue with the correct body shape.
func TestRemoveQoSQueue_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/remove-qos-queue" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decoding body: %v", err)
		}
		if req["policy"] != "my-policy" {
			t.Errorf("policy: want \"my-policy\", got %v", req["policy"])
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"deleted"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	if err := c.RemoveQoSQueue(context.Background(), "default", "my-policy", 1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestAddFilterRule_Success verifies that AddFilterRule posts to add-filter-rule.
func TestAddFilterRule_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/add-filter-rule" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"seq":10},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.AddFilterRule(context.Background(), "default", map[string]any{
		"filter":   "my-filter",
		"seq":      10,
		"action":   "permit",
		"src_ip":   "10.0.0.0/8",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil result")
	}
}

// TestAddPrefixListEntry_Success verifies add-prefix-list-entry posting.
func TestAddPrefixListEntry_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/add-prefix-list-entry" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"prefix":"10.0.0.0/8"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.AddPrefixListEntry(context.Background(), "default", map[string]string{
		"prefix_list": "my-list",
		"prefix":      "10.0.0.0/8",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil result")
	}
}

// TestAddRoutePolicyRule_Success verifies add-route-policy-rule posting.
func TestAddRoutePolicyRule_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/add-route-policy-rule" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"seq":10},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.AddRoutePolicyRule(context.Background(), "default", map[string]any{
		"policy":   "my-policy",
		"seq":      10,
		"action":   "permit",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil result")
	}
}

// TestUpdateSpec_Success verifies UpdateSpec posts to the update-<kind>
// verb with the supplied body and returns the decoded data field.
func TestUpdateSpec_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/update-service" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, `{"data":{"name":"transit"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.UpdateSpec(context.Background(), "default", "service", map[string]string{
		"name":        "transit",
		"description": "updated description",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if raw == nil {
		t.Fatal("expected non-nil result")
	}
}

// TestShowSpec_UsesPluralKindInURL pins the bug fixed in the
// "view profile from Topology" slice: ShowSpec must use the plural form of
// the kind in the URL path ("profiles", not "profile"). Before the fix every
// per-spec detail GET silently 404'd because the handler passed the singular
// create-verb suffix.
func TestShowSpec_UsesPluralKindInURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtron/v1/networks/default/profiles/switch1" {
			t.Errorf("unexpected request: %s %s (expected /newtron/v1/networks/default/profiles/switch1)", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"mgmt_ip":"10.0.0.1","loopback_ip":"127.0.0.1","zone":"amer"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.ShowSpec(context.Background(), "default", "profiles", "switch1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var data struct {
		MgmtIP string `json:"mgmt_ip"`
		Zone   string `json:"zone"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatalf("decoding payload: %v", err)
	}
	if data.MgmtIP != "10.0.0.1" || data.Zone != "amer" {
		t.Errorf("unexpected payload fields: %+v", data)
	}
}
