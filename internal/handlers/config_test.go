package handlers_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aldrin-isaac/newtcon/internal/handlers"
)

func TestConfig_AuthRequired_True(t *testing.T) {
	h := handlers.NewConfigHandler(true)
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d want 200", w.Code)
	}
	var body handlers.ConfigResponse
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.AuthRequired {
		t.Errorf("AuthRequired=%v want true", body.AuthRequired)
	}
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type=%q want application/json", got)
	}
}

func TestConfig_AuthRequired_False(t *testing.T) {
	h := handlers.NewConfigHandler(false)
	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d want 200", w.Code)
	}
	var body handlers.ConfigResponse
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body.AuthRequired {
		t.Errorf("AuthRequired=%v want false", body.AuthRequired)
	}
}
