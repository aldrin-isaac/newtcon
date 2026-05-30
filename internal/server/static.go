// Package server — this file implements RegisterStaticAssets, which mounts an
// http.FileServer at the catch-all "/" pattern for the compiled frontend assets
// produced by `cd web && npm run build`.
//
// Registration is intentionally deferred to after all /api/* routes are
// registered in main.go. http.ServeMux routes more-specific patterns (those
// with a non-empty path segment after the host) before the catch-all "/" so
// /api/* handlers always win over the static file server regardless of
// registration order — but the conventional ordering (API routes first, then
// catch-all) is preserved here for readability.
//
// See CLAUDE.md §File Ownership Map: internal/server/ owns HTTP routing and
// middleware. Static-asset serving is routing infrastructure, not a handler
// family; it lives here rather than in a new package.
package server

import (
	"log"
	"net/http"
	"os"
)

// RegisterStaticAssets mounts an http.FileServer at the catch-all pattern "/"
// on mux, serving files from dir.
//
// Routing precedence: http.ServeMux matches patterns by specificity.
// /api/* patterns registered before this call are more specific than "/" and
// continue to match first. This function only adds the catch-all fallback.
//
// Behaviour when dir is empty or does not exist:
//   - Logs a warning at the "warn" level.
//   - Does NOT register the catch-all pattern.
//   - Returns without error; the /api/* handlers remain fully operational.
//
// main.go calls this after registering all /api/* routes and before calling
// ApplyMiddleware.
func RegisterStaticAssets(mux *http.ServeMux, dir string) {
	if dir == "" {
		log.Printf("warn: --web-dir is empty; static asset serving disabled")
		return
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		log.Printf("warn: --web-dir %q does not exist or is not a directory; static asset serving disabled", dir)
		return
	}
	fs := http.FileServer(http.Dir(dir))
	mux.Handle("/", fs)
	log.Printf("static assets: serving %q at /", dir)
}
