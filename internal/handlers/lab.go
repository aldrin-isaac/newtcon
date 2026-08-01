// Lab lifecycle handlers. Each handler forwards one newtlab-server call via
// internal/newtronc/newtlab.go. URL pattern: /api/labs/...
//
// All newtlab HTTP traffic is mediated by internal/newtronc (CLAUDE.md §1).
// No newtlab or newtron Go package is imported here.
//
// Routes registered by RegisterLabRoutes:
//
//	GET  /api/labs
//	GET  /api/labs/{name}/status
//	POST /api/labs/{name}/deploy
//	POST /api/labs/{name}/destroy
//	POST /api/labs/{name}/provision
//	GET  /api/labs/{name}/events      ← SSE passthrough
//	POST /api/labs/{name}/nodes/{node}/start
//	POST /api/labs/{name}/nodes/{node}/stop
package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// LabDeps is the dependency set for lab lifecycle handlers.
type LabDeps struct {
	Client        *newtronc.Client
	CorrelationID func(ctx context.Context) string
}

// RegisterLabRoutes wires the lab lifecycle endpoints into mux.
func RegisterLabRoutes(mux *http.ServeMux, deps LabDeps) {
	cid := deps.CorrelationID
	if cid == nil {
		cid = func(ctx context.Context) string { return "" }
	}
	c := deps.Client

	mux.Handle("GET /api/labs", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := c.LabListLabs(r.Context())
		if err != nil {
			writeLabEngineError(w, cid(r.Context()), err, "GET /api/labs", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))

	mux.Handle("GET /api/labs/{name}/status", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		data, err := c.LabStatus(r.Context(), name)
		if err != nil {
			writeLabEngineError(w, cid(r.Context()), err, fmt.Sprintf("GET /api/labs/%s/status", name), nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))

	mux.Handle("POST /api/labs/{name}/deploy", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")

		var req newtronc.LabDeployRequest
		// Decode optional body; empty body is fine (uses zero-value defaults).
		if r.ContentLength > 0 {
			dec := json.NewDecoder(r.Body)
			if err := dec.Decode(&req); err != nil {
				writeLabValidation(w, cid(r.Context()), fmt.Sprintf("malformed JSON body: %v", err))
				return
			}
		}
		// Query-string fallback — matches newtlab's own handler behaviour.
		if !req.Provision {
			if v := r.URL.Query().Get("provision"); v != "" {
				req.Provision, _ = strconv.ParseBool(v)
			}
		}
		if !req.Force {
			if v := r.URL.Query().Get("force"); v != "" {
				req.Force, _ = strconv.ParseBool(v)
			}
		}

		status, data, err := c.LabDeploy(r.Context(), name, req)
		if err != nil {
			writeLabEngineError(w, cid(r.Context()), err, fmt.Sprintf("POST /api/labs/%s/deploy", name), nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(data)
	}))

	mux.Handle("POST /api/labs/{name}/destroy", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		data, err := c.LabDestroy(r.Context(), name)
		if err != nil {
			writeLabEngineError(w, cid(r.Context()), err, fmt.Sprintf("POST /api/labs/%s/destroy", name), nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))

	mux.Handle("POST /api/labs/{name}/provision", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		parallel := 0
		if v := r.URL.Query().Get("parallel"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				parallel = n
			}
		}
		data, err := c.LabProvision(r.Context(), name, parallel)
		if err != nil {
			writeLabEngineError(w, cid(r.Context()), err, fmt.Sprintf("POST /api/labs/%s/provision", name), nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))

	// SSE passthrough: open a connection to newtlab's events stream and forward
	// each line verbatim to the browser client. The proxy strategy:
	//
	//  1. Open the upstream events stream on newtlab-server with no timeout
	//     (long-lived).
	//  2. Set response headers (text/event-stream, no-cache, no-transform).
	//  3. Flush immediately to send the HTTP headers and open the browser SSE
	//     connection.
	//  4. Read lines from newtlab one at a time; write each line + newline to
	//     the browser and flush.
	//  5. Stop when either end closes (browser disconnect or newtlab closes).
	//
	// This is a transparent byte-level pass-through of the SSE frames
	// newtlab already produces (event:/data:/id: lines). No re-encoding.
	mux.Handle("GET /api/labs/{name}/events", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		upstream, err := c.LabEventsRequest(r.Context(), name)
		if err != nil {
			writeLabEngineError(w, cid(r.Context()), err, fmt.Sprintf("GET /api/labs/%s/events", name), nil)
			return
		}
		defer upstream.Body.Close()

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		scanner := bufio.NewScanner(upstream.Body)
		for scanner.Scan() {
			select {
			case <-r.Context().Done():
				return
			default:
			}
			line := scanner.Text()
			_, werr := fmt.Fprintln(w, line)
			if werr != nil {
				return
			}
			flusher.Flush()
		}
	}))

	mux.Handle("POST /api/labs/{name}/nodes/{node}/start", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		node := r.PathValue("node")
		data, err := c.LabStartNode(r.Context(), name, node)
		if err != nil {
			writeLabEngineError(w, cid(r.Context()), err, fmt.Sprintf("POST /api/labs/%s/nodes/%s/start", name, node), nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))

	mux.Handle("POST /api/labs/{name}/nodes/{node}/stop", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		node := r.PathValue("node")
		data, err := c.LabStopNode(r.Context(), name, node)
		if err != nil {
			writeLabEngineError(w, cid(r.Context()), err, fmt.Sprintf("POST /api/labs/%s/nodes/%s/stop", name, node), nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))
}

// writeLabValidation writes a 400 validation-failure error envelope.
func writeLabValidation(w http.ResponseWriter, corrID, msg string) {
	types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure, msg,
		map[string]any{"correlation_id": corrID})
}

// Compile-time assertion that *newtronc.Client has the lab methods this
// handler uses. If the newtronc.Client API changes, the build breaks here.
var _ interface {
	LabListLabs(context.Context) (json.RawMessage, error)
	LabStatus(context.Context, string) (json.RawMessage, error)
	LabDeploy(context.Context, string, newtronc.LabDeployRequest) (int, json.RawMessage, error)
	LabDestroy(context.Context, string) (json.RawMessage, error)
	LabProvision(context.Context, string, int) (json.RawMessage, error)
	LabEventsRequest(context.Context, string) (*http.Response, error)
	LabStartNode(context.Context, string, string) (json.RawMessage, error)
	LabStopNode(context.Context, string, string) (json.RawMessage, error)
} = (*newtronc.Client)(nil)
