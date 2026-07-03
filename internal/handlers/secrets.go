// handlers/secrets.go — network-scoped secret-store proxy.
//
//	GET    /api/networks/{netID}/secrets        → {"keys":[...]} (names only)
//	POST   /api/networks/{netID}/secrets        → set {key, value}
//	DELETE /api/networks/{netID}/secrets/{key}  → delete (idempotent)
//
// Backs operator-provided-credential authoring: the form POSTs a masked value
// here, then references it from a spec field as ${secret:<key>}. Values are
// WRITE-ONLY end to end — no route returns a value, and the POST body's value is
// never logged (we keep it out of the endpoint label passed to
// writeUpstreamError, and newtcon's request logger does not log bodies).
//
// A newtron 403 (missing spec.author on secrets under --enforce-authorization)
// surfaces as 403 authorization_failure via writeUpstreamError, so the operator
// sees the required permission rather than a raw upstream status.
package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// SecretsDeps wires the secret-store proxy routes.
type SecretsDeps struct {
	Client        *newtronc.Client
	CorrelationID func(context.Context) string
}

// RegisterSecretsRoutes installs the network-scoped secret-store proxy.
func RegisterSecretsRoutes(mux *http.ServeMux, deps SecretsDeps) {
	cid := deps.CorrelationID
	if cid == nil {
		cid = func(context.Context) string { return "" }
	}

	// GET — key names only.
	mux.Handle("GET /api/networks/{netID}/secrets", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		keys, err := deps.Client.ListSecrets(ctx, netID)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err,
				"GET /api/networks/"+netID+"/secrets", nil)
			return
		}
		if keys == nil {
			keys = []string{}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(types.SecretsListResponse{Keys: keys})
	}))

	// POST — set {key, value}. The value is never logged.
	mux.Handle("POST /api/networks/{netID}/secrets", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		body, err := io.ReadAll(r.Body)
		if err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"reading request body: "+err.Error(), nil)
			return
		}
		var req types.SetSecretRequest
		if err := json.Unmarshal(body, &req); err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"invalid JSON: "+err.Error(), nil)
			return
		}
		if req.Key == "" || req.Value == "" {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"both 'key' and 'value' are required", nil)
			return
		}
		if err := deps.Client.SetSecret(ctx, netID, req.Key, req.Value); err != nil {
			// Endpoint label carries the key, never the value.
			writeUpstreamError(w, cid(ctx), err,
				"POST /api/networks/"+netID+"/secrets (key="+req.Key+")", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "set", "key": req.Key})
	}))

	// DELETE — idempotent upstream.
	mux.Handle("DELETE /api/networks/{netID}/secrets/{key}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		key := r.PathValue("key")
		if err := deps.Client.DeleteSecret(ctx, netID, key); err != nil {
			writeUpstreamError(w, cid(ctx), err,
				"DELETE /api/networks/"+netID+"/secrets/"+key, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted", "key": key})
	}))
}
