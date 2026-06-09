// Node-inspector, topology proxy, and topology-editor handlers. Each handler
// fetches or mutates one newtron endpoint and returns the decoded "data" field
// as JSON. URL pattern: /api/topology, /api/topology/nodes, /api/topology/links,
// /api/nodes/{device}/...
//
// All reads and writes are proxied through internal/newtronc/nodes.go; no
// newtron package is imported here (CLAUDE.md §newtron API Consumption Rule).
package handlers

import (
	"context"
	"encoding/json"
	"io"
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

// RegisterNodesRoutes registers the topology, topology-editor, per-device read,
// and interface binding endpoints.
//
// Read endpoints:
//
//	GET  /api/topology                                        — full topology
//	GET  /api/nodes/{device}/info                             — device overview
//	GET  /api/nodes/{device}/health                           — health check
//	GET  /api/nodes/{device}/interfaces                       — interface list
//	GET  /api/nodes/{device}/interfaces/{name}                — interface detail
//	GET  /api/nodes/{device}/interfaces/{name}/binding        — bound service
//	GET  /api/nodes/{device}/vlans                            — VLANs
//	GET  /api/nodes/{device}/vrfs                             — VRFs
//	GET  /api/nodes/{device}/acls                             — ACLs
//	GET  /api/nodes/{device}/lags                             — LAGs
//	GET  /api/nodes/{device}/neighbors                        — neighbors
//	GET  /api/nodes/{device}/bgp/status                       — BGP status
//	GET  /api/nodes/{device}/evpn/status                      — EVPN status
//	GET  /api/nodes/{device}/configdb                         — full CONFIG_DB snapshot
//	GET  /api/nodes/{device}/configdb/{table}                 — table keys
//	GET  /api/nodes/{device}/configdb/{table}/{key}           — entry value
//
// Topology write endpoints (operator-domain names):
//
//	POST   /api/topology/nodes                                — add device
//	PUT    /api/topology/nodes/{name}                         — update device
//	DELETE /api/topology/nodes/{name}                         — remove device
//	POST   /api/topology/links                                — add link
//	DELETE /api/topology/links/{device}/{interface}           — remove link
//
// Interface binding endpoints:
//
//	POST /api/nodes/{device}/interfaces/{name}/bind-service   — bind service
//	POST /api/nodes/{device}/interfaces/{name}/unbind-service — unbind service
//	POST /api/nodes/{device}/interfaces/{name}/refresh-service — refresh service
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

	// Reconcile: dry_run=true returns the drift preview; dry_run=false executes
	// the corrective intent push. mode=topology drives full reconcile.
	mux.Handle("POST /api/nodes/{device}/reconcile", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		dryRun := r.URL.Query().Get("dry_run") == "true"
		mode := r.URL.Query().Get("mode")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeReconcile(ctx, c.Network(ctx), device, dryRun, mode)
		}, "/api/nodes/"+device+"/reconcile")
	}))

	// Generic RPC: forward any node-level newtron action by subpath.
	// Query string is forwarded verbatim so callers can pass newtron options
	// like ?mode=topology and ?execute=false.
	mux.Handle("POST /api/nodes/{device}/rpc/{subpath...}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		subpath := r.PathValue("subpath")
		rawQuery := r.URL.RawQuery
		body, _ := io.ReadAll(r.Body)
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeRPC(ctx, c.Network(ctx), device, subpath, rawQuery, body)
		}, "/api/nodes/"+device+"/rpc/"+subpath)
	}))

	// Generic per-interface RPC.
	mux.Handle("POST /api/nodes/{device}/interfaces/{iface}/rpc/{subpath...}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		iface := normalizeIfaceName(r.PathValue("iface"))
		subpath := r.PathValue("subpath")
		rawQuery := r.URL.RawQuery
		body, _ := io.ReadAll(r.Body)
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.InterfaceRPC(ctx, c.Network(ctx), device, iface, subpath, rawQuery, body)
		}, "/api/nodes/"+device+"/interfaces/"+iface+"/rpc/"+subpath)
	}))

	// ============================================================================
	// Topology write endpoints
	// ============================================================================

	// proxyNodeWrite is the shared helper for write (POST/PUT/DELETE) routes that
	// forward to newtron and return the data field, mapping errors to the standard
	// newtcon envelope.
	proxyNodeWrite := func(
		w http.ResponseWriter,
		r *http.Request,
		statusOnSuccess int,
		writeFn func(ctx context.Context) (json.RawMessage, error),
		endpoint string,
	) {
		ctx := r.Context()
		payload, err := writeFn(ctx)
		if err != nil {
			writeNodeWriteError(w, cid(ctx), err, endpoint)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statusOnSuccess)
		_, _ = w.Write(payload)
	}

	// readBody decodes a JSON request body into the provided pointer.
	// Returns false and writes the error envelope when the body is invalid.
	readBody := func(w http.ResponseWriter, r *http.Request, v any) bool {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"reading request body: "+err.Error(), nil)
			return false
		}
		if err := json.Unmarshal(body, v); err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"invalid JSON: "+err.Error(), nil)
			return false
		}
		return true
	}

	// POST /api/topology/nodes — add a device to the topology.
	// Forwards body {name, device} to newtron's create-node verb.
	// Newtron handler: handler_network.go lines 384-406.
	mux.Handle("POST /api/topology/nodes", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body any
		if !readBody(w, r, &body) {
			return
		}
		proxyNodeWrite(w, r, http.StatusCreated, func(ctx context.Context) (json.RawMessage, error) {
			return c.CreateTopologyDevice(ctx, c.Network(ctx), body)
		}, "POST /api/topology/nodes")
	}))

	// PUT /api/topology/nodes/{name} — update a device entry (full replacement).
	// Forwards body (TopologyDevice) to newtron's PUT topology/node/{name} verb.
	// Newtron handler: handler_network.go lines 435-455.
	mux.Handle("PUT /api/topology/nodes/{name}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		var body any
		if !readBody(w, r, &body) {
			return
		}
		proxyNodeWrite(w, r, http.StatusOK, func(ctx context.Context) (json.RawMessage, error) {
			return c.UpdateTopologyDevice(ctx, c.Network(ctx), name, body)
		}, "PUT /api/topology/nodes/"+name)
	}))

	// DELETE /api/topology/nodes/{name} — remove a device from the topology.
	// Query param ?force=true cascade-deletes referring links.
	// Newtron handler: handler_network.go lines 413-429.
	mux.Handle("DELETE /api/topology/nodes/{name}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		force := r.URL.Query().Get("force") == "true"
		proxyNodeWrite(w, r, http.StatusOK, func(ctx context.Context) (json.RawMessage, error) {
			return c.DeleteTopologyDevice(ctx, c.Network(ctx), name, force)
		}, "DELETE /api/topology/nodes/"+name)
	}))

	// POST /api/topology/links — add a link between two interfaces.
	// Forwards body {a, z} to newtron's create-link verb.
	// Newtron handler: handler_network.go lines 460-478.
	mux.Handle("POST /api/topology/links", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body any
		if !readBody(w, r, &body) {
			return
		}
		proxyNodeWrite(w, r, http.StatusCreated, func(ctx context.Context) (json.RawMessage, error) {
			return c.CreateTopologyLink(ctx, c.Network(ctx), body)
		}, "POST /api/topology/links")
	}))

	// DELETE /api/topology/links/{device}/{interface} — remove the link that
	// includes the given endpoint. Newtron resolves the full link from a single
	// endpoint (handler_network.go lines 484-504).
	mux.Handle("DELETE /api/topology/links/{device}/{interface}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		iface := normalizeIfaceName(r.PathValue("interface"))
		proxyNodeWrite(w, r, http.StatusOK, func(ctx context.Context) (json.RawMessage, error) {
			return c.DeleteTopologyLink(ctx, c.Network(ctx), device, iface)
		}, "DELETE /api/topology/links/"+device+"/"+iface)
	}))

	// ============================================================================
	// Interface binding endpoints
	// ============================================================================

	// POST /api/nodes/{device}/interfaces/{name}/bind-service
	// Forwards body to newtron's apply-service RPC.
	// Newtron handler: handler_interface.go lines 15-48.
	// Body: { service: string, ip_address?: string, vlan?: int, peer_as?: int, params?: object }
	mux.Handle("POST /api/nodes/{device}/interfaces/{name}/bind-service", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		name := normalizeIfaceName(r.PathValue("name"))
		var body any
		if !readBody(w, r, &body) {
			return
		}
		proxyNodeWrite(w, r, http.StatusOK, func(ctx context.Context) (json.RawMessage, error) {
			return c.ApplyService(ctx, c.Network(ctx), device, name, body)
		}, "POST /api/nodes/"+device+"/interfaces/"+name+"/bind-service")
	}))

	// POST /api/nodes/{device}/interfaces/{name}/unbind-service
	// Calls newtron's remove-service RPC (no body required).
	// Newtron handler: handler_interface.go lines 50-69.
	mux.Handle("POST /api/nodes/{device}/interfaces/{name}/unbind-service", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		name := normalizeIfaceName(r.PathValue("name"))
		proxyNodeWrite(w, r, http.StatusOK, func(ctx context.Context) (json.RawMessage, error) {
			return c.RemoveService(ctx, c.Network(ctx), device, name)
		}, "POST /api/nodes/"+device+"/interfaces/"+name+"/unbind-service")
	}))

	// POST /api/nodes/{device}/interfaces/{name}/refresh-service
	// Calls newtron's refresh-service RPC (no body required).
	// Newtron handler: handler_interface.go lines 71-90.
	mux.Handle("POST /api/nodes/{device}/interfaces/{name}/refresh-service", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		device := r.PathValue("device")
		name := normalizeIfaceName(r.PathValue("name"))
		proxyNodeWrite(w, r, http.StatusOK, func(ctx context.Context) (json.RawMessage, error) {
			return c.RefreshService(ctx, c.Network(ctx), device, name)
		}, "POST /api/nodes/"+device+"/interfaces/"+name+"/refresh-service")
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

// writeNodeWriteError maps newtronc write errors to the standard newtcon error
// envelope. Validation failures and conflicts surface operator-domain errors;
// transport failures become newtron_unavailable.
func writeNodeWriteError(w http.ResponseWriter, correlationID string, err error, endpoint string) {
	switch e := err.(type) {
	case *newtronc.ValidationError:
		types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
			"validation failed for "+endpoint+": "+e.Error(),
			map[string]any{"correlation_id": correlationID})
	case *newtronc.NotFoundError:
		types.WriteError(w, http.StatusNotFound, types.KindInternal,
			"not found: "+endpoint,
			map[string]any{"correlation_id": correlationID})
	case *newtronc.ConflictError:
		types.WriteError(w, http.StatusConflict, types.KindDriftRefusal,
			"conflict for "+endpoint+": "+e.Error(),
			map[string]any{"correlation_id": correlationID})
	default:
		writeNodeUnavailable(w, correlationID, err, endpoint)
	}
}
