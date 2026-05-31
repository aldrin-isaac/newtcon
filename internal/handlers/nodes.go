// Node-inspector and topology proxy handlers. Each handler fetches one
// newtron endpoint verbatim and returns the decoded "data" field as JSON.
// URL pattern: /api/topology, /api/nodes/{device}/...
//
// All reads are proxied through internal/newtronc/nodes.go; no newtron
// package is imported here (CLAUDE.md §newtron API Consumption Rule).
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// NodesDeps is the dependency set for topology and node-inspector handlers.
type NodesDeps struct {
	Client        *newtronc.Client
	CorrelationID func(ctx context.Context) string
}

// RegisterNodesRoutes registers the topology and per-device read endpoints.
//
// Endpoint list:
//
//	GET /api/topology                                 — full topology
//	GET /api/nodes/{device}/info                      — device overview
//	GET /api/nodes/{device}/health                    — health check
//	GET /api/nodes/{device}/interfaces                — interface list
//	GET /api/nodes/{device}/interfaces/{name}         — interface detail
//	GET /api/nodes/{device}/interfaces/{name}/binding — bound service
//	GET /api/nodes/{device}/vlans                     — VLANs
//	GET /api/nodes/{device}/vrfs                      — VRFs
//	GET /api/nodes/{device}/acls                      — ACLs
//	GET /api/nodes/{device}/lags                      — LAGs
//	GET /api/nodes/{device}/neighbors                 — neighbors
//	GET /api/nodes/{device}/bgp/status                — BGP status
//	GET /api/nodes/{device}/evpn/status               — EVPN status
//	GET /api/nodes/{device}/configdb                  — full CONFIG_DB snapshot
//	GET /api/nodes/{device}/configdb/{table}          — table keys
//	GET /api/nodes/{device}/configdb/{table}/{key}    — entry value
func RegisterNodesRoutes(mux *http.ServeMux, deps NodesDeps) {
	cid := deps.CorrelationID
	if cid == nil {
		cid = func(ctx context.Context) string { return "" }
	}
	c := deps.Client

	// proxyNode is the shared helper: calls fetchFn, writes the raw JSON payload
	// on success, or the standard error envelope on failure.
	proxyNode := func(
		w http.ResponseWriter,
		r *http.Request,
		fetchFn func(ctx context.Context) (json.RawMessage, error),
		endpoint string,
	) {
		ctx := r.Context()
		payload, err := fetchFn(ctx)
		if err != nil {
			if _, ok := err.(*newtronc.NotFoundError); ok {
				types.WriteError(w, http.StatusNotFound, types.KindInternal,
					"not found: "+endpoint,
					map[string]any{"correlation_id": cid(ctx)})
				return
			}
			writeNodeUnavailable(w, cid(ctx), err, endpoint)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}

	// Topology.
	mux.Handle("GET /api/topology", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.Topology(ctx, c.Network(ctx))
		}, "/api/topology")
	}))

	// Node overview.
	mux.Handle("GET /api/nodes/{device}/info", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeInfo(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/info")
	}))

	// Node health.
	mux.Handle("GET /api/nodes/{device}/health", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeHealth(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/health")
	}))

	// Interface list.
	mux.Handle("GET /api/nodes/{device}/interfaces", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeInterfaces(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/interfaces")
	}))

	// Interface detail. The interface name in the URL uses %2F for slashes
	// (e.g., Ethernet0%2F1 → Ethernet0/1), matching newtron's interfaceName()
	// normalisation in handler.go. We replicate that normalisation here.
	mux.Handle("GET /api/nodes/{device}/interfaces/{name}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		name := normalizeIfaceName(r.PathValue("name"))
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeInterface(ctx, c.Network(ctx), device, name)
		}, "/api/nodes/"+device+"/interfaces/"+name)
	}))

	// Interface service binding.
	mux.Handle("GET /api/nodes/{device}/interfaces/{name}/binding", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		name := normalizeIfaceName(r.PathValue("name"))
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeInterfaceBinding(ctx, c.Network(ctx), device, name)
		}, "/api/nodes/"+device+"/interfaces/"+name+"/binding")
	}))

	// VLANs.
	mux.Handle("GET /api/nodes/{device}/vlans", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeVLANs(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/vlans")
	}))

	// VRFs.
	mux.Handle("GET /api/nodes/{device}/vrfs", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeVRFs(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/vrfs")
	}))

	// ACLs.
	mux.Handle("GET /api/nodes/{device}/acls", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeACLs(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/acls")
	}))

	// LAGs.
	mux.Handle("GET /api/nodes/{device}/lags", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeLAGs(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/lags")
	}))

	// Neighbors.
	mux.Handle("GET /api/nodes/{device}/neighbors", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeNeighbors(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/neighbors")
	}))

	// BGP status.
	mux.Handle("GET /api/nodes/{device}/bgp/status", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeBGPStatus(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/bgp/status")
	}))

	// EVPN status.
	mux.Handle("GET /api/nodes/{device}/evpn/status", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeEVPNStatus(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/evpn/status")
	}))

	// CONFIG_DB snapshot.
	mux.Handle("GET /api/nodes/{device}/configdb", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeConfigDB(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/configdb")
	}))

	// CONFIG_DB table keys.
	mux.Handle("GET /api/nodes/{device}/configdb/{table}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		table := r.PathValue("table")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeConfigDBTable(ctx, c.Network(ctx), device, table)
		}, "/api/nodes/"+device+"/configdb/"+table)
	}))

	// CONFIG_DB entry. The key may contain "/" characters; we capture the full
	// remainder after /{table}/ using a wildcard pattern.
	mux.Handle("GET /api/nodes/{device}/configdb/{table}/{key...}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		table := r.PathValue("table")
		key := r.PathValue("key")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeConfigDBEntry(ctx, c.Network(ctx), device, table, key)
		}, "/api/nodes/"+device+"/configdb/"+table+"/"+key)
	}))

	// Drift: comparison of intent vs CONFIG_DB reality. Newtron returns the
	// per-table differences; rendering surfaces these to the operator.
	mux.Handle("GET /api/nodes/{device}/drift", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeDrift(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/drift")
	}))

	// Intent projection: current logical state derived from intents.
	mux.Handle("GET /api/nodes/{device}/projection", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeProjection(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/projection")
	}))

	// Intent tree: the structured intent record graph.
	mux.Handle("GET /api/nodes/{device}/intent-tree", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeIntentTree(ctx, c.Network(ctx), device)
		}, "/api/nodes/"+device+"/intent-tree")
	}))
}

// normalizeIfaceName converts %2F sequences to "/" in interface names from
// URL path values. Matches newtron's interfaceName() normalisation in
// pkg/newtron/api/handler.go line 279.
func normalizeIfaceName(name string) string {
	return strings.ReplaceAll(name, "%2F", "/")
}

// writeNodeUnavailable writes the standard newtron_unavailable error envelope
// for node-level proxy failures.
func writeNodeUnavailable(w http.ResponseWriter, correlationID string, err error, endpoint string) {
	underlyingKind := "http_5xx"
	if unavail, ok := err.(*newtronc.UnavailableError); ok && unavail.StatusCode == 0 {
		underlyingKind = "connection_refused"
	}
	types.WriteError(w, http.StatusServiceUnavailable,
		types.KindNewtronUnavailable,
		"newtron-server unreachable for "+endpoint+": "+err.Error(),
		map[string]any{
			"correlation_id":           correlationID,
			"underlying_error":         underlyingKind,
			"underlying_error_message": err.Error(),
			"next_action_hint": map[string]any{
				"verb":      "check_newtron_health",
				"endpoint":  "/api/health",
				"rationale": "newtron-server is unreachable; verify the daemon is running on the configured --newtron-url",
			},
		},
	)
}
