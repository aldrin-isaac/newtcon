// Package newtronc — operator-identity surface. newtron L2c (PAM-issued
// session keys) is the identity primitive newtcon adopts: the operator logs
// in once via Basic auth → newtron mints an opaque session key with a bounded
// TTL → every subsequent request from newtcon-server carries it as
// `Authorization: Bearer <key>`.
//
// This file owns:
//
//   - [Client.Login]  / [Client.Logout] — RPCs onto newtron's /auth/login,
//     /auth/logout (newtron PR #143).
//   - [WithBearer]    — stash a bearer key on a request's context.
//   - [bearerInjector] — RoundTripper that reads the context and adds the
//     Authorization header. Wired in by the constructor in client.go.
//
// The bearer never crosses the browser ↔ newtcon-server boundary as a
// header — it is held server-side, keyed by an opaque cookie owned by
// internal/session. The browser sees only the cookie. See
// docs/upstream-newtron-l2c.md for the design rationale.
package newtronc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// LoginResponse mirrors newtron's POST /newtron/v1/auth/login success payload
// per newtron PR #143:
//
//	{"data": {"key": "<43-char URL-safe base64>",
//	          "expires_at": "2026-06-11T08:00:00Z",
//	          "user": "alice"},
//	 "error": ""}
type LoginResponse struct {
	Key       string    `json:"key"`
	ExpiresAt time.Time `json:"expires_at"`
	User      string    `json:"user"`
}

// Login posts Basic auth to newtron's /newtron/v1/auth/login and returns
// the issued session key, absolute expiry, and resolved Unix username.
//
// Error mapping:
//
//	200 with {key, expires_at, user} → *LoginResponse, nil
//	401 (PAM rejected, no service)   → *UnauthenticatedError
//	404 (L2c disabled on server)     → *NotFoundError
//	other                            → typed via classifyResponse
func (c *Client) Login(ctx context.Context, username, password string) (*LoginResponse, error) {
	url := c.newtronBase() + "/auth/login"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.SetBasicAuth(username, password)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("reading response body: %v", err)}
	}

	if err := classifyResponse(resp.StatusCode, body, http.StatusOK); err != nil {
		return nil, err
	}

	// /auth/login returns the LoginResponse inside the standard
	// {data, error} envelope newtron emits everywhere. See
	// docs/upstream-newtron-l2c.md §1 for the wire contract.
	var env newtronAPIResponse
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding response: %v", err)}
	}
	if env.Error != "" {
		return nil, &UnavailableError{Cause: env.Error}
	}
	var data LoginResponse
	if err := json.Unmarshal(env.Data, &data); err != nil {
		return nil, &UnavailableError{Cause: fmt.Sprintf("decoding login response: %v", err)}
	}
	if data.Key == "" {
		return nil, &UnavailableError{Cause: "login response missing key"}
	}
	return &data, nil
}

// Logout posts to newtron's /newtron/v1/auth/logout with the supplied bearer
// key in the Authorization header. newtron PR #143: returns 204 No Content
// idempotently.
//
// Note: this method does NOT consult the context-bound bearer (because the
// caller is logging that bearer out — see internal/handlers/auth.go which
// pulls the key from the server-side session store directly).
func (c *Client) Logout(ctx context.Context, key string) error {
	url := c.newtronBase() + "/auth/logout"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return &UnavailableError{Cause: fmt.Sprintf("building request: %v", err)}
	}
	req.Header.Set("Authorization", "Bearer "+key)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return &UnavailableError{Cause: err.Error()}
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	return classifyResponse(resp.StatusCode, body, http.StatusNoContent)
}

// bearerCtxKey is the context key under which a Bearer key is stashed for the
// outbound transport to find. Unexported — callers use [WithBearer].
type bearerCtxKey struct{}

// WithBearer returns a derived context that carries the supplied L2c session
// key. The newtronc client's outbound transport (installed by [New]) reads
// this and attaches Authorization: Bearer <key> to every request whose ctx
// carries one.
//
// Passing an empty key is a no-op — the returned context is the input.
func WithBearer(ctx context.Context, key string) context.Context {
	if key == "" {
		return ctx
	}
	return context.WithValue(ctx, bearerCtxKey{}, key)
}

// bearerFromContext returns the Bearer key from ctx, or "" if none.
func bearerFromContext(ctx context.Context) string {
	s, _ := ctx.Value(bearerCtxKey{}).(string)
	return s
}

// bearerInjector is the http.RoundTripper that reads a context-bound Bearer
// key (via [WithBearer]) and adds Authorization: Bearer <key> on outbound
// requests. Installed by [New] around the default transport.
//
// A request whose context has no bearer goes out unchanged — anonymous
// traffic is preserved for endpoints that don't require auth (e.g.,
// /newt-server/v1/health) and for the case where newtron-server is running
// without --enforce-authorization.
type bearerInjector struct {
	inner http.RoundTripper
}

// RoundTrip implements http.RoundTripper.
func (b *bearerInjector) RoundTrip(req *http.Request) (*http.Response, error) {
	key := bearerFromContext(req.Context())
	if key == "" {
		return b.inner.RoundTrip(req)
	}
	// Clone to avoid mutating the caller's request — net/http forbids
	// transports from modifying the request they receive.
	clone := req.Clone(req.Context())
	clone.Header.Set("Authorization", "Bearer "+key)
	return b.inner.RoundTrip(clone)
}
