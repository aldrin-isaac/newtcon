package handlers_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/handlers"
	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// TestCreateSpec_Handler_Success verifies that POST /api/services forwards the
// body to newtron's create-service verb and returns 201 with the newtron data.
func TestCreateSpec_Handler_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/create-service" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"name":"transit"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{
		Client: newtronc.New(upstream.URL),
	})

	body, _ := json.Marshal(map[string]string{"name": "transit", "type": "routed"})
	req := httptest.NewRequest(http.MethodPost, "/api/networks/default/services", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestCreateSpec_Handler_ValidationFailure verifies that a 400 from newtron
// becomes a 400 with kind:validation_failure at the newtcon boundary.
func TestCreateSpec_Handler_ValidationFailure(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{
		Client: newtronc.New(upstream.URL),
	})

	body, _ := json.Marshal(map[string]string{})
	req := httptest.NewRequest(http.MethodPost, "/api/networks/default/ipvpns", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	var env map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decoding error envelope: %v", err)
	}
	errBlock, _ := env["error"].(map[string]any)
	if errBlock == nil {
		t.Fatal("missing error block")
	}
	if kind, _ := errBlock["kind"].(string); kind != "validation_failure" {
		t.Errorf("error.kind: want validation_failure, got %q", kind)
	}
}

// TestDeleteSpec_Handler_Success verifies that DELETE /api/zones/{name} sends
// delete-zone to newtron with {"name":…} and returns 200.
func TestDeleteSpec_Handler_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/delete-zone" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		var req map[string]string
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decoding body: %v", err)
		}
		if req["name"] != "zone-a" {
			t.Errorf("name: want zone-a, got %q", req["name"])
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"deleted"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodDelete, "/api/networks/default/zones/zone-a", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestDeleteSpec_Handler_Conflict verifies that a 409 from newtron becomes
// a 409 with kind:drift_refusal at the newtcon boundary.
func TestDeleteSpec_Handler_Conflict(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"service is in use"}`, http.StatusConflict)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodDelete, "/api/networks/default/services/transit", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", rec.Code, rec.Body.String())
	}
	var env map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
		t.Fatalf("decoding error envelope: %v", err)
	}
	errBlock, _ := env["error"].(map[string]any)
	if errBlock == nil {
		t.Fatal("missing error block")
	}
	if kind, _ := errBlock["kind"].(string); kind != "drift_refusal" {
		t.Errorf("error.kind: want drift_refusal, got %q", kind)
	}
}

// TestAddQoSQueue_Handler_Success verifies POST /api/qos-policies/{name}/queues.
func TestAddQoSQueue_Handler_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/add-qos-queue" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"queue_id":1},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{
		Client: newtronc.New(upstream.URL),
	})

	body, _ := json.Marshal(map[string]any{
		"policy": "my-policy", "queue_id": 1, "name": "q1", "type": "strict",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/networks/default/qos-policies/my-policy/queues", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestRemoveQoSQueue_Handler_Success verifies
// DELETE /api/qos-policies/{name}/queues/{queue_id}.
func TestRemoveQoSQueue_Handler_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/remove-qos-queue" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"deleted"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{
		Client: newtronc.New(upstream.URL),
	})

	req := httptest.NewRequest(http.MethodDelete, "/api/networks/default/qos-policies/my-policy/queues/1", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestAddFilterRule_Handler_Success verifies POST /api/filters/{name}/rules.
func TestAddFilterRule_Handler_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/add-filter-rule" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"seq":10},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{
		Client: newtronc.New(upstream.URL),
	})

	body, _ := json.Marshal(map[string]any{
		"filter": "my-filter", "seq": 10, "action": "permit",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/networks/default/filters/my-filter/rules", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestAddPrefixListEntry_Handler_Success verifies
// POST /api/prefix-lists/{name}/entries.
func TestAddPrefixListEntry_Handler_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/add-prefix-list-entry" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"prefix":"10.0.0.0/8"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{
		Client: newtronc.New(upstream.URL),
	})

	body, _ := json.Marshal(map[string]string{
		"prefix_list": "my-list", "prefix": "10.0.0.0/8",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/networks/default/prefix-lists/my-list/entries", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestAddRoutePolicyRule_Handler_Success verifies
// POST /api/route-policies/{name}/rules.
func TestAddRoutePolicyRule_Handler_Success(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/add-route-policy-rule" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintln(w, `{"data":{"seq":10},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{
		Client: newtronc.New(upstream.URL),
	})

	body, _ := json.Marshal(map[string]any{
		"policy": "my-policy", "seq": 10, "action": "permit",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/networks/default/route-policies/my-policy/rules", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestUpdateSpec_Handler_Success verifies PUT /api/networks/.../{kind}/{name}
// forwards to newtron's update-<kind> and returns the upstream payload.
func TestUpdateSpec_Handler_Success(t *testing.T) {
	var gotBody map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/update-service" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"name":"transit"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{Client: newtronc.New(upstream.URL)})

	body, _ := json.Marshal(map[string]string{"name": "transit", "description": "updated"})
	req := httptest.NewRequest(http.MethodPut, "/api/networks/default/services/transit", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if gotBody["name"] != "transit" {
		t.Errorf("forwarded name=%v want transit", gotBody["name"])
	}
	if gotBody["description"] != "updated" {
		t.Errorf("forwarded description=%v want updated", gotBody["description"])
	}
}

// TestUpdateSpec_Handler_URLNameOverridesBody verifies the handler ignores
// any "name" in the request body and uses the URL path-param instead.
// Pins the safety check: an operator asking to "update foo" while sending
// {"name":"bar",…} must update foo, not bar.
func TestUpdateSpec_Handler_URLNameOverridesBody(t *testing.T) {
	var gotName string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if n, ok := body["name"].(string); ok {
			gotName = n
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"name":"foo"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{Client: newtronc.New(upstream.URL)})

	body, _ := json.Marshal(map[string]string{"name": "bar-attempted-injection", "description": "x"})
	req := httptest.NewRequest(http.MethodPut, "/api/networks/default/services/foo", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if gotName != "foo" {
		t.Errorf("URL-name override failed: upstream got name=%q want foo", gotName)
	}
}

// ----------------------------------------------------------------------
// Per-item sub-rule UPDATE handlers (slice #173.B)
// ----------------------------------------------------------------------

// TestUpdateQoSQueue_Handler verifies PUT /qos-policies/{name}/queues/{queue_id}
// injects {policy, queue_id} from the URL path into newtron's body, forwards
// renumber + field updates verbatim, and returns the upstream payload.
func TestUpdateQoSQueue_Handler(t *testing.T) {
	var seenBody []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/default/update-qos-queue" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		seenBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"queue_id":3},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{Client: newtronc.New(upstream.URL)})

	body, _ := json.Marshal(map[string]any{"name": "q-bulk", "type": "wrr", "weight": 4, "new_queue_id": 3})
	req := httptest.NewRequest(http.MethodPut, "/api/networks/default/qos-policies/voip-qos/queues/2", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(seenBody, []byte(`"policy":"voip-qos"`)) {
		t.Errorf("upstream body missing injected policy: %s", seenBody)
	}
	if !bytes.Contains(seenBody, []byte(`"queue_id":2`)) {
		t.Errorf("upstream body missing injected queue_id from URL: %s", seenBody)
	}
	if !bytes.Contains(seenBody, []byte(`"new_queue_id":3`)) {
		t.Errorf("upstream body missing renumber field from request: %s", seenBody)
	}
}

// TestUpdateFilterRule_Handler verifies PUT /filters/{name}/rules/{seq}.
func TestUpdateFilterRule_Handler(t *testing.T) {
	var seenBody []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtron/v1/networks/default/update-filter-rule" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		seenBody, _ = io.ReadAll(r.Body)
		fmt.Fprintln(w, `{"data":{"seq":5},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{Client: newtronc.New(upstream.URL)})

	body, _ := json.Marshal(map[string]any{"action": "deny", "src_ip": "10.0.0.0/8", "new_seq": 5})
	req := httptest.NewRequest(http.MethodPut, "/api/networks/default/filters/ACL_X/rules/10", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(seenBody, []byte(`"filter":"ACL_X"`)) || !bytes.Contains(seenBody, []byte(`"seq":10`)) {
		t.Errorf("URL identifiers not injected into body: %s", seenBody)
	}
	if !bytes.Contains(seenBody, []byte(`"new_seq":5`)) {
		t.Errorf("renumber field not preserved: %s", seenBody)
	}
}

// TestUpdateRoutePolicyRule_Handler verifies PUT /route-policies/{name}/rules/{seq}.
func TestUpdateRoutePolicyRule_Handler(t *testing.T) {
	var seenBody []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtron/v1/networks/default/update-route-policy-rule" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		seenBody, _ = io.ReadAll(r.Body)
		fmt.Fprintln(w, `{"data":{"seq":20},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{Client: newtronc.New(upstream.URL)})

	body, _ := json.Marshal(map[string]any{"action": "permit", "community": "65000:1"})
	req := httptest.NewRequest(http.MethodPut, "/api/networks/default/route-policies/RP_X/rules/20", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(seenBody, []byte(`"policy":"RP_X"`)) || !bytes.Contains(seenBody, []byte(`"seq":20`)) {
		t.Errorf("URL identifiers not injected: %s", seenBody)
	}
}

// TestUpdatePrefixListEntry_Handler verifies PUT /prefix-lists/{name}/entries/{prefix}.
// new_prefix is required by newtron — the handler passes it through unchanged.
func TestUpdatePrefixListEntry_Handler(t *testing.T) {
	var seenBody []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/newtron/v1/networks/default/update-prefix-list-entry" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		seenBody, _ = io.ReadAll(r.Body)
		fmt.Fprintln(w, `{"data":{"prefix":"10.0.0.0/24"},"error":""}`)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{Client: newtronc.New(upstream.URL)})

	body, _ := json.Marshal(map[string]string{"new_prefix": "10.0.0.0/24"})
	req := httptest.NewRequest(http.MethodPut, "/api/networks/default/prefix-lists/PL_CUST/entries/10.0.0.0/8", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(seenBody, []byte(`"prefix_list":"PL_CUST"`)) {
		t.Errorf("URL prefix_list not injected: %s", seenBody)
	}
	if !bytes.Contains(seenBody, []byte(`"prefix":"10.0.0.0/8"`)) {
		t.Errorf("URL prefix (the identifier) not injected: %s", seenBody)
	}
	if !bytes.Contains(seenBody, []byte(`"new_prefix":"10.0.0.0/24"`)) {
		t.Errorf("renumber field not preserved: %s", seenBody)
	}
}

// TestUpdateFilterRule_Handler_MalformedJSON verifies the read helper
// guards against invalid body bodies without reaching upstream.
func TestUpdateFilterRule_Handler_MalformedJSON(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("upstream should not be called for malformed JSON; got %s %s", r.Method, r.URL.Path)
	}))
	defer upstream.Close()

	mux := http.NewServeMux()
	handlers.RegisterNetworkRoutes(mux, handlers.NetworkDeps{Client: newtronc.New(upstream.URL)})

	req := httptest.NewRequest(http.MethodPut, "/api/networks/default/filters/ACL_X/rules/10", bytes.NewReader([]byte("not-json")))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}
