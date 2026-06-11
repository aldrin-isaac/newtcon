// handlers/auth.go — operator-identity endpoints.
//
//   POST /api/auth/login   — accept username + password JSON body, proxy as
//                            Basic auth to newtron's /auth/login, mint a
//                            newtcon session cookie keyed to the returned
//                            L2c session key. Returns {user, expires_at}.
//   POST /api/auth/logout  — extract the cookie's L2c key from the store,
//                            call newtron's /auth/logout (best effort),
//                            evict locally, clear the cookie. Always 204.
//   GET  /api/auth/whoami  — return {user, expires_at} for the current
//                            session, or 401 if there is none.
//
// CLAUDE.md §1: only internal/newtronc/ can speak to newtron; this file
// goes through deps.Client.Login / Logout for upstream calls. The cookie
// state lives in internal/session/.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/session"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// AuthDeps wires the three /api/auth/* endpoints. CookieSecure controls the
// Set-Cookie Secure attribute — true when newtcon-server is serving HTTPS,
// false when the operator explicitly opted into the dev escape hatch.
type AuthDeps struct {
	Client        *newtronc.Client
	Store         *session.Store
	CookieSecure  bool
	CorrelationID func(context.Context) string
}

// RegisterAuthRoutes installs login / logout / whoami on mux.
func RegisterAuthRoutes(mux *http.ServeMux, deps AuthDeps) {
	mux.Handle("POST /api/auth/login", handleAuthLogin(deps))
	mux.Handle("POST /api/auth/logout", handleAuthLogout(deps))
	mux.Handle("GET /api/auth/whoami", handleAuthWhoami(deps))
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// authResponse is the operator-visible body returned by /login and /whoami.
// Notably absent: the newtron L2c bearer key — it stays server-side.
type authResponse struct {
	User      string    `json:"user"`
	ExpiresAt time.Time `json:"expires_at"`
}

func handleAuthLogin(deps AuthDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		corrID := deps.CorrelationID(ctx)

		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"invalid login body: "+err.Error(),
				map[string]any{"correlation_id": corrID})
			return
		}
		if req.Username == "" || req.Password == "" {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"username and password are required",
				map[string]any{"correlation_id": corrID})
			return
		}

		lr, err := deps.Client.Login(ctx, req.Username, req.Password)
		if err != nil {
			// Distinguish PAM rejection (operator-actionable: bad creds)
			// from upstream failures (write through writeUpstreamError).
			var unauth *newtronc.UnauthenticatedError
			if errors.As(err, &unauth) {
				types.WriteError(w, http.StatusUnauthorized, types.KindAuthenticationFailure,
					"authentication failed",
					map[string]any{
						"correlation_id":           corrID,
						"underlying_error_message": string(unauth.Body),
					})
				return
			}
			writeUpstreamError(w, corrID, err, "POST /api/auth/login", nil)
			return
		}

		token, err := deps.Store.Mint(session.Entry{
			Bearer:    lr.Key,
			User:      lr.User,
			ExpiresAt: lr.ExpiresAt,
		})
		if err != nil {
			types.WriteError(w, http.StatusInternalServerError, types.KindInternal,
				"minting session token: "+err.Error(),
				map[string]any{"correlation_id": corrID})
			return
		}

		session.SetCookie(w, token, lr.ExpiresAt, deps.CookieSecure)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(authResponse{User: lr.User, ExpiresAt: lr.ExpiresAt})
	}
}

func handleAuthLogout(deps AuthDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(session.CookieName)
		if err == nil && c.Value != "" {
			// Best-effort upstream logout: success or failure, the local
			// session is gone after this handler returns.
			if entry, ok := deps.Store.Lookup(c.Value); ok {
				_ = deps.Client.Logout(r.Context(), entry.Bearer)
			}
			deps.Store.Delete(c.Value)
		}
		session.ClearCookie(w, deps.CookieSecure)
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleAuthWhoami(deps AuthDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		corrID := deps.CorrelationID(r.Context())
		c, err := r.Cookie(session.CookieName)
		if err != nil || c.Value == "" {
			types.WriteError(w, http.StatusUnauthorized, types.KindAuthenticationFailure,
				"no session",
				map[string]any{"correlation_id": corrID})
			return
		}
		entry, ok := deps.Store.Lookup(c.Value)
		if !ok {
			// Lookup evicted the entry on expiry; the session middleware
			// will see the 401 going out and clear the cookie.
			types.WriteError(w, http.StatusUnauthorized, types.KindAuthenticationFailure,
				"session expired or unknown",
				map[string]any{"correlation_id": corrID})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(authResponse{User: entry.User, ExpiresAt: entry.ExpiresAt})
	}
}
