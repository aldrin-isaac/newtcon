// handlers/config.go — GET /api/config.
//
// Returns a small JSON descriptor of the newtcon-server's deployment posture
// so the frontend can light up the right surfaces. Today it carries one
// field — `auth_required` — but the shape is open for additive evolution
// (per DESIGN_PRINCIPLES_NEWTRON §46): when newtcon-server adds another
// boot-time configuration the frontend cares about, it lands here.
//
// The endpoint is intentionally cheap (no upstream calls, no I/O) so the
// frontend can hit it on every boot without paying a latency tax.
package handlers

import (
	"encoding/json"
	"net/http"
)

// ConfigResponse is the wire shape of GET /api/config.
//
// AuthRequired is true when newtcon-server was started with --auth-required.
// The frontend uses this to decide whether to mount the login-overlay arc
// (auth-gate.ts) — when false, the workspace boots straight in anonymous
// mode. Production deployments MUST set --auth-required=true; the dev
// default is false so a fresh clone reaches the workspace with one
// command and no PAM / TLS configuration first.
type ConfigResponse struct {
	AuthRequired bool `json:"auth_required"`
}

// NewConfigHandler returns the handler for GET /api/config.
func NewConfigHandler(authRequired bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ConfigResponse{AuthRequired: authRequired})
	})
}
