// networks.go — list and register newtron networks. Backs the topology-
// switcher UI in newtcon's web frontend.
//
// Routes (registered in cmd/newtcon-server/main.go):
//
//	GET  /api/networks   → proxies newtron GET  /newtron/v1/networks
//	POST /api/networks   → proxies newtron POST /newtron/v1/networks
//	                       (supports scaffold:true to create the spec dir
//	                       and register in one call — newtron PR #110)
//
// The active network for read/write traffic is selected per-request via the
// ?net=<id> query parameter (server.NetworkSelector middleware). These two
// routes are the *meta* surface for managing networks themselves; they
// ignore ?net=.

package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// networksClient is the minimal interface NewNetworksHandler needs.
type networksClient interface {
	ListNetworksDetail(ctx context.Context) ([]newtronc.NetworkInfo, error)
	RegisterNetwork(ctx context.Context, id, specDir string, scaffold bool, description string) (string, error)
}

// NewNetworksHandler registers GET /api/networks and POST /api/networks on
// the supplied mux. correlationID is the same CorrelationIDFromContext
// accessor the other handlers wire so error envelopes carry the request ID.
func NewNetworksHandler(mux *http.ServeMux, c networksClient, correlationID func(context.Context) string) {
	mux.Handle("GET /api/networks", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		infos, err := c.ListNetworksDetail(r.Context())
		if err != nil {
			writeUpstreamError(w, correlationID(r.Context()), err, "GET /api/networks", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"networks": infos})
	}))

	mux.Handle("POST /api/networks", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			ID          string `json:"id"`
			SpecDir     string `json:"spec_dir"`
			Scaffold    bool   `json:"scaffold,omitempty"`
			Description string `json:"description,omitempty"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			writeUpstreamError(w, correlationID(r.Context()),
				&newtronc.ValidationError{Body: []byte("invalid JSON: " + err.Error())},
				"POST /api/networks", nil)
			return
		}
		if req.ID == "" || req.SpecDir == "" {
			writeUpstreamError(w, correlationID(r.Context()),
				&newtronc.ValidationError{Body: []byte("id and spec_dir are required")},
				"POST /api/networks", nil)
			return
		}
		id, err := c.RegisterNetwork(r.Context(), req.ID, req.SpecDir, req.Scaffold, req.Description)
		if err != nil {
			writeUpstreamError(w, correlationID(r.Context()), err, "POST /api/networks", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": id})
	}))
}
