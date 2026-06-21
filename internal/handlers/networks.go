// networks.go — list and create newtron networks. Backs the topology-
// switcher UI in newtcon's web frontend.
//
// Routes (registered in cmd/newtcon-server/main.go):
//
//	GET  /api/networks   → proxies newtron GET  /newtron/v1/networks
//	POST /api/networks   → proxies newtron POST /newtron/v1/networks.
//	                       Wire is `{id, description?}` only (newtron
//	                       PRs #245 + #251). Status code is 201 when
//	                       newtron materialised the slot, 200 when the
//	                       id was already registered.
//
// The active network for read/write traffic is positional in the URL
// path (/api/networks/{netID}/..., per PR #135). These two routes are
// the *meta* surface for managing networks themselves; they carry no
// netID segment.

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
	CreateNetwork(ctx context.Context, id, description string) (newtronc.NetworkInfo, bool, error)
}

// NewNetworksHandler registers GET /api/networks and POST /api/networks
// on the supplied mux. correlationID is the same CorrelationIDFromContext
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
			Description string `json:"description,omitempty"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			writeUpstreamError(w, correlationID(r.Context()),
				&newtronc.ValidationError{Body: []byte("invalid JSON: " + err.Error())},
				"POST /api/networks", nil)
			return
		}
		if req.ID == "" {
			writeUpstreamError(w, correlationID(r.Context()),
				&newtronc.ValidationError{Body: []byte("id is required")},
				"POST /api/networks", nil)
			return
		}
		info, existed, err := c.CreateNetwork(r.Context(), req.ID, req.Description)
		if err != nil {
			writeUpstreamError(w, correlationID(r.Context()), err, "POST /api/networks", nil)
			return
		}
		// Propagate the 201-vs-200 distinction so the UI can branch
		// (the "New network" modal renders "name already taken" when
		// the operator picks an existing id).
		status := http.StatusCreated
		if existed {
			status = http.StatusOK
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(info)
	}))
}
