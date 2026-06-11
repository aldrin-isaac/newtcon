// Package session manages operator-identity state for newtcon-server.
//
// The browser sees only an opaque cookie. The newtron L2c session key
// (the bearer that authenticates outbound calls to newtron-server) is
// held server-side in an in-memory [Store] keyed by that cookie. Server
// restart invalidates every session — matching newtron's own L2c
// in-memory store semantics per newtron PR #143.
//
// Three concerns live here:
//
//   - [Store] — the cookie ↔ {bearer, user, expires_at} map. Thread-safe;
//     evicts expired entries on lookup.
//   - cookie helpers — [SetCookie] / [ClearCookie] with the standard
//     Secure / HttpOnly / SameSite=Strict attributes.
//   - [Middleware] — reads the cookie on inbound, resolves the entry, and
//     installs the bearer (for [newtronc] outbound calls) plus the resolved
//     username (for handlers that need it) into the request context. Watches
//     the response status on the way out; on 401 it evicts the entry and
//     clears the cookie automatically.
//
// The newtron bearer never crosses the browser ↔ newtcon-server boundary as
// a header. Only the opaque cookie does.
package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"sync"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

// CookieName is the cookie newtcon-server uses to track an operator session.
// The cookie value is an opaque 256-bit token; the value is meaningful only
// to the in-memory [Store].
const CookieName = "newtcon_session"

// Entry is the per-session record held server-side.
type Entry struct {
	// Bearer is the newtron L2c session key (Authorization: Bearer ...).
	// Never crosses to the browser as a header.
	Bearer string

	// User is the resolved Unix username PAM verified on /auth/login.
	User string

	// ExpiresAt is the absolute expiry returned by newtron on /auth/login.
	// Using the session does NOT extend it (newtron L2c semantics).
	ExpiresAt time.Time
}

// Store is an in-memory cookie ↔ Entry map. Restart invalidates every
// session.
type Store struct {
	mu      sync.Mutex
	entries map[string]Entry
}

// NewStore returns an empty Store.
func NewStore() *Store {
	return &Store{entries: map[string]Entry{}}
}

// Mint generates a fresh opaque cookie token (256-bit URL-safe) and stores
// the entry against it. Returns the token. Caller writes it into Set-Cookie
// via [SetCookie].
func (s *Store) Mint(e Entry) (string, error) {
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries[token] = e
	return token, nil
}

// Lookup returns the entry for token, plus ok=false if missing or expired.
// Expired entries are evicted on lookup.
func (s *Store) Lookup(token string) (Entry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[token]
	if !ok {
		return Entry{}, false
	}
	if time.Now().After(e.ExpiresAt) {
		delete(s.entries, token)
		return Entry{}, false
	}
	return e, true
}

// Delete removes the entry for token. Idempotent.
func (s *Store) Delete(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, token)
}

// Len returns the current number of entries — diagnostic / test use only.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

func randomToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

// SetCookie writes the session cookie. secure controls the Secure attribute:
// in production (newtcon-server serving HTTPS), secure=true; in plain-HTTP dev
// the operator passes the override via main.go's --session-allow-insecure-cookie
// (or equivalent) so the browser will accept and re-send the cookie.
func SetCookie(w http.ResponseWriter, token string, expires time.Time, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   secure,
	})
}

// ClearCookie writes a Max-Age=0 cookie the browser will drop. Used on
// logout, expiry, and any 401 the session middleware intercepts.
func ClearCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   secure,
	})
}

// userCtxKey is the context key under which the resolved Unix username is
// stashed by [Middleware]. Handlers read it via [UserFromContext].
type userCtxKey struct{}

// UserFromContext returns the resolved Unix username for the current
// request, or "" if there is no valid session.
func UserFromContext(ctx context.Context) string {
	s, _ := ctx.Value(userCtxKey{}).(string)
	return s
}

func withUser(ctx context.Context, user string) context.Context {
	return context.WithValue(ctx, userCtxKey{}, user)
}

// Middleware reads the session cookie, looks up the [Store], and on a hit
// installs {bearer, user} on the request context — bearer for the
// [newtronc] transport to find via [newtronc.WithBearer], user for handlers
// via [UserFromContext].
//
// On the way out, if the handler returns 401, the middleware evicts the
// store entry and clears the cookie — the session is dead going forward.
//
// secure threads into the Set-Cookie Secure attribute used when clearing.
func Middleware(store *Store, secure bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := ""
			if c, err := r.Cookie(CookieName); err == nil {
				token = c.Value
			}

			var hadSession bool
			if token != "" {
				if entry, ok := store.Lookup(token); ok {
					hadSession = true
					ctx := r.Context()
					ctx = newtronc.WithBearer(ctx, entry.Bearer)
					ctx = withUser(ctx, entry.User)
					r = r.WithContext(ctx)
				}
			}

			rec := &cookieClearingRecorder{ResponseWriter: w}
			if hadSession {
				rec.onUnauthorized = func() {
					store.Delete(token)
					ClearCookie(w, secure)
				}
			}
			next.ServeHTTP(rec, r)
		})
	}
}

// cookieClearingRecorder wraps http.ResponseWriter so the session middleware
// can invoke onUnauthorized BEFORE the WriteHeader(401) commits the response
// — Set-Cookie headers must be written before WriteHeader.
type cookieClearingRecorder struct {
	http.ResponseWriter
	onUnauthorized func()
	wroteHeader    bool
}

func (c *cookieClearingRecorder) WriteHeader(status int) {
	if !c.wroteHeader {
		c.wroteHeader = true
		if status == http.StatusUnauthorized && c.onUnauthorized != nil {
			c.onUnauthorized()
		}
	}
	c.ResponseWriter.WriteHeader(status)
}

// Flush preserves streaming behaviour for SSE handlers.
func (c *cookieClearingRecorder) Flush() {
	if f, ok := c.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
