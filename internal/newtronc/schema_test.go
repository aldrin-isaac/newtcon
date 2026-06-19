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

// TestFetchSchemaKinds_Success — kinds list returns the data payload
// verbatim with the polymorphic field structure preserved.
func TestFetchSchemaKinds_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtron/v1/schema" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"kinds":[
			{"kind":"IPVPNSpec","label":"IP-VPN","description":"Layer-3 VPN"},
			{"kind":"ServiceSpec","label":"Service","description":"Reusable template"}
		]},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.FetchSchemaKinds(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var parsed struct {
		Kinds []struct {
			Kind  string `json:"kind"`
			Label string `json:"label"`
		} `json:"kinds"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(parsed.Kinds) != 2 || parsed.Kinds[0].Kind != "IPVPNSpec" || parsed.Kinds[1].Label != "Service" {
		t.Errorf("kinds payload not preserved: %s", raw)
	}
}

// TestFetchSchema_Success — per-kind metadata flows through verbatim,
// including the optional fields (enum / item_type / ref_kind) so the
// browser sees newtron's exact shape.
func TestFetchSchema_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtron/v1/schema/IPVPNSpec" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{
			"kind":"IPVPNSpec","label":"IP-VPN","description":"Layer-3 VPN",
			"fields":[
				{"name":"vrf","label":"VRF Name","type":"string","required":true},
				{"name":"l3vni","label":"L3VNI","type":"int","required":true},
				{"name":"route_targets","label":"Route Targets","type":"array","required":true,"item_type":"string"}
			]
		},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	raw, err := c.FetchSchema(context.Background(), "IPVPNSpec")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var parsed struct {
		Kind   string `json:"kind"`
		Fields []struct {
			Name     string `json:"name"`
			Type     string `json:"type"`
			Required bool   `json:"required"`
			ItemType string `json:"item_type,omitempty"`
		} `json:"fields"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if parsed.Kind != "IPVPNSpec" || len(parsed.Fields) != 3 {
		t.Errorf("schema payload not preserved: %s", raw)
	}
	if parsed.Fields[2].ItemType != "string" {
		t.Errorf("optional item_type field dropped: %s", raw)
	}
}

// TestFetchSchema_UnknownKind — 404 surfaces as *NotFoundError so the
// handler can write 404 to the browser.
func TestFetchSchema_UnknownKind(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	_, err := c.FetchSchema(context.Background(), "NoSuchKind")
	if err == nil {
		t.Fatal("expected error for 404")
	}
	var nf *newtronc.NotFoundError
	if !errorIs(err, &nf) {
		t.Errorf("expected *NotFoundError, got %T: %v", err, err)
	}
}
