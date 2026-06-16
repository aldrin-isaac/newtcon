// handlers/authorization.go — GET /api/networks/{netID}/authorization.
//
// Read-only inspector pane backing for newtcon's Access/Permissions tab.
// Forwards the upstream payload verbatim — newtron owns the schema and
// the renderer presents shorthand-vs-typed PermissionGrant cases.
//
// Write surfaces (POST /reload after the operator edits network.json) are
// not exposed by newtcon today; they belong to the next slice that lights
// up authoring.
package handlers

import (
	"context"
	"net/http"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// AuthorizationDeps wires the GET endpoint.
type AuthorizationDeps struct {
	Client        *newtronc.Client
	CorrelationID func(context.Context) string
}

// RegisterAuthorizationRoutes installs GET /api/networks/{netID}/authorization.
func RegisterAuthorizationRoutes(mux *http.ServeMux, deps AuthorizationDeps) {
	mux.Handle("GET /api/networks/{netID}/authorization", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		payload, err := deps.Client.GetAuthorization(ctx, netID)
		if err != nil {
			writeUpstreamError(w, deps.CorrelationID(ctx), err,
				"GET /api/networks/"+netID+"/authorization", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}))
}
