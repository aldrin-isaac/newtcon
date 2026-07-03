package newtronc_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

func TestClient_ListSecrets_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/newtron/v1/networks/n1/secrets" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"keys":["switch1_ssh_pass","switch2_ssh_pass"]},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	keys, err := c.ListSecrets(context.Background(), "n1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(keys) != 2 || keys[0] != "switch1_ssh_pass" || keys[1] != "switch2_ssh_pass" {
		t.Fatalf("unexpected keys: %v", keys)
	}
}

func TestClient_ListSecrets_Empty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, `{"data":{"keys":[]},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	keys, err := c.ListSecrets(context.Background(), "n1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(keys) != 0 {
		t.Fatalf("expected empty, got: %v", keys)
	}
}

func TestClient_SetSecret_ForwardsKeyValue(t *testing.T) {
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/newtron/v1/networks/n1/secrets" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("expected json content-type, got %s", ct)
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"set","key":"leaf1_ssh_pass"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	if err := c.SetSecret(context.Background(), "n1", "leaf1_ssh_pass", "hunter2"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotBody["key"] != "leaf1_ssh_pass" || gotBody["value"] != "hunter2" {
		t.Fatalf("upstream did not receive {key,value}: %v", gotBody)
	}
}

func TestClient_DeleteSecret_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/newtron/v1/networks/n1/secrets/leaf1_ssh_pass" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintln(w, `{"data":{"status":"deleted","key":"leaf1_ssh_pass"},"error":""}`)
	}))
	defer srv.Close()

	c := newtronc.New(srv.URL)
	if err := c.DeleteSecret(context.Background(), "n1", "leaf1_ssh_pass"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
