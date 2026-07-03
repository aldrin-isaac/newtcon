// handlers/ssh_credentials.go — network SSH-login proxy (scoped scalar).
//
//	GET  /api/networks/{netID}/ssh-credentials          → read authored login at a scope
//	POST /api/networks/{netID}/set-ssh-credentials      → upsert login at a scope
//	POST /api/networks/{netID}/clear-ssh-credentials    → clear the override at a scope
//
// Backs the scoped "SSH Login" control (network/zone/node), the scalar mirror of
// the ip-vpn override affordance. ssh_pass flows through the secret store as a
// ${secret:KEY} reference (the frontend uses the masked-input → POST /secrets
// flow), so a plaintext password should never reach here; the request body is not
// logged regardless. Upstream 400 (network-floor) / 403 (spec.author) / 409
// (clear base with overrides present) surface via writeUpstreamError.
package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// SSHCredentialsDeps wires the SSH-login proxy routes.
type SSHCredentialsDeps struct {
	Client        *newtronc.Client
	CorrelationID func(context.Context) string
}

// RegisterSSHCredentialsRoutes installs the network SSH-login proxy.
func RegisterSSHCredentialsRoutes(mux *http.ServeMux, deps SSHCredentialsDeps) {
	cid := deps.CorrelationID
	if cid == nil {
		cid = func(context.Context) string { return "" }
	}

	// GET — the login authored at a scope (query: scope, scope_instance). Masked.
	mux.Handle("GET /api/networks/{netID}/ssh-credentials", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		payload, err := deps.Client.ShowSSHCredentials(ctx, netID, r.URL.RawQuery)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err,
				"GET /api/networks/"+netID+"/ssh-credentials", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}))

	// POST set — upsert. Body forwarded verbatim (and never logged).
	mux.Handle("POST /api/networks/{netID}/set-ssh-credentials", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwardSSHWrite(w, r, cid, "set-ssh-credentials", deps.Client.SetSSHCredentials)
	}))

	// POST clear — remove the override at a scope.
	mux.Handle("POST /api/networks/{netID}/clear-ssh-credentials", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwardSSHWrite(w, r, cid, "clear-ssh-credentials", deps.Client.ClearSSHCredentials)
	}))
}

// forwardSSHWrite reads the request body and forwards it to the given upstream
// call. Shared by set + clear — identical shape, only the verb differs. The body
// is never placed in a log or error label (it may carry a credential reference).
func forwardSSHWrite(
	w http.ResponseWriter, r *http.Request, cid func(context.Context) string, verb string,
	call func(context.Context, string, any) (json.RawMessage, error),
) {
	ctx := r.Context()
	netID := r.PathValue("netID")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
			"reading request body: "+err.Error(), nil)
		return
	}
	payload, err := call(ctx, netID, json.RawMessage(body))
	if err != nil {
		writeUpstreamError(w, cid(ctx), err,
			"POST /api/networks/"+netID+"/"+verb, nil)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload)
}
