// Lab lifecycle handlers. Each handler forwards one newtlab-server call via
// internal/newtronc/newtlab.go. URL pattern: /api/lab/topologies/...
//
// All newtlab HTTP traffic is mediated by internal/newtronc (CLAUDE.md §1).
// No newtlab or newtron Go package is imported here.
//
// Routes registered by RegisterLabRoutes:
//
//	GET  /api/lab/topologies
//	GET  /api/lab/topologies/{name}/status
//	POST /api/lab/topologies/{name}/deploy
//	POST /api/lab/topologies/{name}/destroy
//	POST /api/lab/topologies/{name}/provision
//	GET  /api/lab/topologies/{name}/events      ← SSE passthrough
//	POST /api/lab/topologies/{name}/nodes/{node}/start
//	POST /api/lab/topologies/{name}/nodes/{node}/stop
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

	mux.Handle("GET /api/lab/topologies", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := c.LabListTopologies(r.Context())
		if err != nil {
			writeLabError(w, cid(r.Context()), err, "GET /api/lab/topologies")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))

	mux.Handle("GET /api/lab/topologies/{name}/status", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		data, err := c.LabTopologyStatus(r.Context(), name)
		if err != nil {
			writeLabError(w, cid(r.Context()), err, fmt.Sprintf("GET /api/lab/topologies/%s/status", name))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))

	mux.Handle("POST /api/lab/topologies/{name}/deploy", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
			writeLabError(w, cid(r.Context()), err, fmt.Sprintf("POST /api/lab/topologies/%s/deploy", name))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(data)
	}))

	mux.Handle("POST /api/lab/topologies/{name}/destroy", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		data, err := c.LabDestroy(r.Context(), name)
		if err != nil {
			writeLabError(w, cid(r.Context()), err, fmt.Sprintf("POST /api/lab/topologies/%s/destroy", name))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))

	mux.Handle("POST /api/lab/topologies/{name}/provision", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		parallel := 0
		if v := r.URL.Query().Get("parallel"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				parallel = n
			}
		}
		data, err := c.LabProvision(r.Context(), name, parallel)
		if err != nil {
			writeLabError(w, cid(r.Context()), err, fmt.Sprintf("POST /api/lab/topologies/%s/provision", name))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))

	// SSE passthrough: open a connection to newtlab's events stream and forward
	// each line verbatim to the browser client. The proxy strategy:
	//
	//  1. Open GET /newtlab/v1/topologies/{name}/events on newtlab-server with
	//     no timeout (long-lived stream).
	//  2. Set response headers (text/event-stream, no-cache, no-transform).
	//  3. Flush immediately to send the HTTP headers and open the browser SSE
	//     connection.
	//  4. Read lines from newtlab one at a time; write each line + newline to
	//     the browser and flush.
	//  5. Stop when either end closes (browser disconnect or newtlab closes).
	//
	// This is a transparent byte-level pass-through of the SSE frames
	// newtlab already produces (event:/data:/id: lines). No re-encoding.
	mux.Handle("GET /api/lab/topologies/{name}/events", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		upstream, err := c.LabEventsRequest(r.Context(), name)
		if err != nil {
			writeLabError(w, cid(r.Context()), err, fmt.Sprintf("GET /api/lab/topologies/%s/events", name))
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

	mux.Handle("POST /api/lab/topologies/{name}/nodes/{node}/start", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		node := r.PathValue("node")
		data, err := c.LabStartNode(r.Context(), name, node)
		if err != nil {
			writeLabError(w, cid(r.Context()), err, fmt.Sprintf("POST /api/lab/topologies/%s/nodes/%s/start", name, node))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))

	mux.Handle("POST /api/lab/topologies/{name}/nodes/{node}/stop", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		node := r.PathValue("node")
		data, err := c.LabStopNode(r.Context(), name, node)
		if err != nil {
			writeLabError(w, cid(r.Context()), err, fmt.Sprintf("POST /api/lab/topologies/%s/nodes/%s/stop", name, node))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}))
}

// writeLabError translates newtronc error types to the newtcon error envelope.
// Mirrors the error-mapping pattern in nodes.go and network.go.
func writeLabError(w http.ResponseWriter, corrID string, err error, endpoint string) {
	switch e := err.(type) {
	case *newtronc.NotFoundError:
		types.WriteError(w, http.StatusNotFound, types.KindPreconditionFailure,
			fmt.Sprintf("%s: not found", endpoint),
			map[string]any{"correlation_id": corrID, "underlying_error_message": string(e.Body)})
	case *newtronc.ConflictError:
		types.WriteError(w, http.StatusConflict, types.KindDriftRefusal,
			fmt.Sprintf("%s: conflict", endpoint),
			map[string]any{"correlation_id": corrID, "underlying_error_message": string(e.Body)})
	case *newtronc.ValidationError:
		types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
			fmt.Sprintf("%s: validation failed", endpoint),
			map[string]any{"correlation_id": corrID, "underlying_error_message": string(e.Body)})
	case *newtronc.UnavailableError:
		types.WriteError(w, http.StatusBadGateway, types.KindNewtronUnavailable,
			fmt.Sprintf("%s: newtlab unreachable", endpoint),
			map[string]any{"correlation_id": corrID, "underlying_error_message": e.Cause})
	default:
		types.WriteError(w, http.StatusInternalServerError, types.KindInternal,
			fmt.Sprintf("%s: internal error", endpoint),
			map[string]any{"correlation_id": corrID, "underlying_error_message": err.Error()})
	}
}

// writeLabValidation writes a 400 validation-failure error envelope.
func writeLabValidation(w http.ResponseWriter, corrID, msg string) {
	types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure, msg,
		map[string]any{"correlation_id": corrID})
}

// Compile-time assertion that *newtronc.Client has the lab methods this
// handler uses. If the newtronc.Client API changes, the build breaks here.
var _ interface {
	LabListTopologies(context.Context) (json.RawMessage, error)
	LabTopologyStatus(context.Context, string) (json.RawMessage, error)
	LabDeploy(context.Context, string, newtronc.LabDeployRequest) (int, json.RawMessage, error)
	LabDestroy(context.Context, string) (json.RawMessage, error)
	LabProvision(context.Context, string, int) (json.RawMessage, error)
	LabEventsRequest(context.Context, string) (*http.Response, error)
	LabStartNode(context.Context, string, string) (json.RawMessage, error)
	LabStopNode(context.Context, string, string) (json.RawMessage, error)
} = (*newtronc.Client)(nil)
