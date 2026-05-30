// Package server — this file implements RegisterStaticAssets, which mounts a
// wrapped http.FileServer at the catch-all "/" pattern for the compiled
// frontend assets produced by `cd web && npm run build`.
//
// Registration is intentionally deferred to after all /api/* routes are
// registered in main.go. http.ServeMux routes more-specific patterns (those
// with a non-empty path segment after the host) before the catch-all "/" so
// /api/* handlers always win over the static file server regardless of
// registration order — but the conventional ordering (API routes first, then
// catch-all) is preserved here for readability.
//
// 404 handling: when the underlying file does not exist, http.FileServer
// returns "404 page not found" as plain text. That is an HTTP-status
// approximation shape — forbidden by CLAUDE.md §Operator-Honest Errors and
// by acceptance criterion 5d of newtcon#104 which requires the JSON error
// envelope from API_CONTRACT.md §Error Schema. staticNotFoundWrapper
// intercepts the 404 write and replaces it with types.WriteError(...,
// KindInternal, ...).
//
// See CLAUDE.md §File Ownership Map: internal/server/ owns HTTP routing and
// middleware. Static-asset serving is routing infrastructure, not a handler
// family; it lives here rather than in a new package.
package server

import (
	"bytes"
	"log"
	"net/http"
	"os"

	"github.com/aldrin-isaac/newtcon/internal/types"
)

// staticNotFoundWriter wraps http.ResponseWriter to intercept 404 responses
// written by http.FileServer and replace them with the JSON error envelope.
//
// http.FileServer signals a missing file by calling WriteHeader(404) and then
// writing the body "404 page not found\n". staticNotFoundWriter holds the
// response in a buffer until WriteHeader is called; if the status is 404 it
// discards the FileServer body and writes the JSON envelope instead.
//
// For all other statuses (200, 301 redirect for clean URLs, 304 etc.) the
// response is passed through to the underlying writer transparently.
type staticNotFoundWriter struct {
	http.ResponseWriter

	// code is set by WriteHeader. Zero means WriteHeader has not been called.
	code int

	// buf accumulates the body bytes written before WriteHeader (rare but
	// possible if a custom FileServer implementation writes body before header).
	buf bytes.Buffer

	// path is the request path, included in the 404 message.
	path string

	// replaced is true once the JSON 404 envelope has been written.
	replaced bool
}

// WriteHeader intercepts the status code. A 404 triggers JSON envelope
// replacement; any other code is passed through unchanged.
func (w *staticNotFoundWriter) WriteHeader(code int) {
	w.code = code
	if code == http.StatusNotFound {
		// Emit the JSON envelope and mark as replaced. Do NOT call
		// w.ResponseWriter.WriteHeader here — types.WriteError does it.
		types.WriteError(
			w.ResponseWriter,
			http.StatusNotFound,
			types.KindInternal,
			"static asset not found: "+w.path,
			nil,
		)
		w.replaced = true
		return
	}
	w.ResponseWriter.WriteHeader(code)
}

// Write forwards the body bytes to the underlying writer, unless a 404
// replacement has already been written (in which case the FileServer's
// "404 page not found" text is silently dropped).
func (w *staticNotFoundWriter) Write(b []byte) (int, error) {
	if w.replaced {
		return len(b), nil
	}
	if w.code == 0 {
		// WriteHeader not yet called — buffer until we know the status.
		return w.buf.Write(b)
	}
	return w.ResponseWriter.Write(b)
}

// fileServerWithJSONNotFound wraps the given http.Handler (expected to be an
// http.FileServer) so that 404 responses carry the JSON error envelope instead
// of the default plaintext body.
type fileServerWithJSONNotFound struct {
	fs http.Handler
}

func (h *fileServerWithJSONNotFound) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	sw := &staticNotFoundWriter{ResponseWriter: w, path: r.URL.Path}
	h.fs.ServeHTTP(sw, r)

	// If WriteHeader was never called by the FileServer (edge case: empty
	// response), flush any buffered bytes with implicit 200.
	if sw.code == 0 && sw.buf.Len() > 0 {
		_, _ = w.Write(sw.buf.Bytes())
	}
}

// RegisterStaticAssets mounts a JSON-404-aware http.FileServer at the
// catch-all pattern "/" on mux, serving files from dir.
//
// Routing precedence: http.ServeMux matches patterns by specificity.
// /api/* patterns registered before this call are more specific than "/" and
// continue to match first. This function only adds the catch-all fallback.
//
// 404 behaviour: when the requested path does not exist under dir, the
// response carries HTTP 404 with a JSON body conforming to the
// API_CONTRACT.md §Error Schema (kind: "internal"). The plaintext
// "404 page not found" response from the underlying http.FileServer is
// intercepted and discarded.
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
	fs := &fileServerWithJSONNotFound{fs: http.FileServer(http.Dir(dir))}
	mux.Handle("/", fs)
	log.Printf("static assets: serving %q at /", dir)
}
