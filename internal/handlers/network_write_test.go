package handlers_test

import (
	"bytes"
	"encoding/json"
	"fmt"
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
