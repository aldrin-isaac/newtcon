// Node-inspector, topology proxy, and topology-editor handlers. Each handler
// fetches or mutates one newtron endpoint and returns the decoded "data" field
// as JSON.
//
// newtcon mirrors newtron's path geometry: every network-scoped resource lives
// under /api/networks/{netID}/... — netID is positional, extracted via
// r.PathValue("netID") in each handler. URL families:
//   - /api/networks/{netID}/topology
//   - /api/networks/{netID}/topology/nodes (write endpoints)
//   - /api/networks/{netID}/topology/links (write endpoints)
//   - /api/networks/{netID}/nodes/{device}/...
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
//	GET  /api/networks/{netID}/topology                                — full topology
//	GET  /api/networks/{netID}/nodes/{device}/info                     — device overview
//	GET  /api/networks/{netID}/nodes/{device}/health                   — health check
//	GET  /api/networks/{netID}/nodes/{device}/interfaces               — interface list
//	GET  /api/networks/{netID}/nodes/{device}/interfaces/{name}        — interface detail
//	GET  /api/networks/{netID}/nodes/{device}/interfaces/{name}/binding — bound service
//	GET  /api/networks/{netID}/nodes/{device}/vlans                    — VLANs
//	GET  /api/networks/{netID}/nodes/{device}/vrfs                     — VRFs
//	GET  /api/networks/{netID}/nodes/{device}/acls                     — ACLs
//	GET  /api/networks/{netID}/nodes/{device}/lags                     — LAGs
//	GET  /api/networks/{netID}/nodes/{device}/neighbors                — neighbors
//	GET  /api/networks/{netID}/nodes/{device}/bgp/status               — BGP status
//	GET  /api/networks/{netID}/nodes/{device}/evpn/status              — EVPN status
//	GET  /api/networks/{netID}/nodes/{device}/configdb                 — full CONFIG_DB snapshot
//	GET  /api/networks/{netID}/nodes/{device}/configdb/{table}         — table keys
//	GET  /api/networks/{netID}/nodes/{device}/configdb/{table}/{key}   — entry value
//
// Topology write endpoints (operator-domain names):
//
//	POST   /api/networks/{netID}/topology/nodes                            — add device
//	PUT    /api/networks/{netID}/topology/nodes/{name}                     — update device
//	DELETE /api/networks/{netID}/topology/nodes/{name}                     — remove device
//	POST   /api/networks/{netID}/topology/links                            — add link
//	DELETE /api/networks/{netID}/topology/links/{device}/{interface}       — remove link
//
// Interface binding endpoints:
//
//	POST /api/networks/{netID}/nodes/{device}/interfaces/{name}/bind-service    — bind service
//	POST /api/networks/{netID}/nodes/{device}/interfaces/{name}/unbind-service  — unbind service
//	POST /api/networks/{netID}/nodes/{device}/interfaces/{name}/refresh-service — refresh service
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
			writeUpstreamError(w, cid(ctx), err, endpoint, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}

	// Topology.
	mux.Handle("GET /api/networks/{netID}/topology", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.Topology(ctx, netID)
		}, "/api/networks/"+netID+"/topology")
	}))

	// Node overview.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/info", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeInfo(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/info")
	}))

	// Node health.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/health", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeHealth(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/health")
	}))

	// Interface list.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/interfaces", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeInterfaces(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/interfaces")
	}))

	// Interface detail. The interface name in the URL uses %2F for slashes
	// (e.g., Ethernet0%2F1 → Ethernet0/1), matching newtron's interfaceName()
	// normalisation. We replicate that normalisation here.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/interfaces/{name}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		name := normalizeIfaceName(r.PathValue("name"))
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeInterface(ctx, netID, device, name)
		}, "/api/networks/"+netID+"/nodes/"+device+"/interfaces/"+name)
	}))

	// Interface service binding.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/interfaces/{name}/binding", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		name := normalizeIfaceName(r.PathValue("name"))
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeInterfaceBinding(ctx, netID, device, name)
		}, "/api/networks/"+netID+"/nodes/"+device+"/interfaces/"+name+"/binding")
	}))

	// VLANs.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/vlans", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeVLANs(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/vlans")
	}))

	// VRFs.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/vrfs", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeVRFs(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/vrfs")
	}))

	// ACLs.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/acls", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeACLs(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/acls")
	}))

	// LAGs.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/lags", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeLAGs(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/lags")
	}))

	// Neighbors.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/neighbors", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeNeighbors(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/neighbors")
	}))

	// BGP status.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/bgp/status", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeBGPStatus(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/bgp/status")
	}))

	// EVPN status.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/evpn/status", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeEVPNStatus(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/evpn/status")
	}))

	// CONFIG_DB snapshot.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/configdb", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeConfigDB(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/configdb")
	}))

	// CONFIG_DB table keys.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/configdb/{table}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		table := r.PathValue("table")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeConfigDBTable(ctx, netID, device, table)
		}, "/api/networks/"+netID+"/nodes/"+device+"/configdb/"+table)
	}))

	// CONFIG_DB entry. The key may contain "/" characters; we capture the full
	// remainder after /{table}/ using a wildcard pattern.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/configdb/{table}/{key...}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		table := r.PathValue("table")
		key := r.PathValue("key")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeConfigDBEntry(ctx, netID, device, table, key)
		}, "/api/networks/"+netID+"/nodes/"+device+"/configdb/"+table+"/"+key)
	}))

	// Drift: comparison of intent vs CONFIG_DB reality. Newtron returns the
	// per-table differences; rendering surfaces these to the operator.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/drift", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeDrift(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/drift")
	}))

	// Intent projection: current logical state derived from intents.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/projection", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeProjection(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/projection")
	}))

	// Intent tree: the structured intent record graph.
	mux.Handle("GET /api/networks/{netID}/nodes/{device}/intent-tree", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeIntentTree(ctx, netID, device)
		}, "/api/networks/"+netID+"/nodes/"+device+"/intent-tree")
	}))

	// Reconcile: dry_run=true returns the drift preview; dry_run=false executes
	// the corrective intent push. mode=topology drives full reconcile.
	mux.Handle("POST /api/networks/{netID}/nodes/{device}/reconcile", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		dryRun := r.URL.Query().Get("dry_run") == "true"
		mode := r.URL.Query().Get("mode")
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeReconcile(ctx, netID, device, dryRun, mode)
		}, "/api/networks/"+netID+"/nodes/"+device+"/reconcile")
	}))

	// Generic RPC: forward any node-level newtron action by subpath.
	// Query string is forwarded verbatim so callers can pass newtron options
	// like ?mode=topology and ?execute=false.
	mux.Handle("POST /api/networks/{netID}/nodes/{device}/rpc/{subpath...}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		subpath := r.PathValue("subpath")
		rawQuery := r.URL.RawQuery
		body, _ := io.ReadAll(r.Body)
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.NodeRPC(ctx, netID, device, subpath, rawQuery, body)
		}, "/api/networks/"+netID+"/nodes/"+device+"/rpc/"+subpath)
	}))

	// Generic per-interface RPC.
	mux.Handle("POST /api/networks/{netID}/nodes/{device}/interfaces/{iface}/rpc/{subpath...}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		iface := normalizeIfaceName(r.PathValue("iface"))
		subpath := r.PathValue("subpath")
		rawQuery := r.URL.RawQuery
		body, _ := io.ReadAll(r.Body)
		proxyNode(w, r, func(ctx context.Context) (json.RawMessage, error) {
			return c.InterfaceRPC(ctx, netID, device, iface, subpath, rawQuery, body)
		}, "/api/networks/"+netID+"/nodes/"+device+"/interfaces/"+iface+"/rpc/"+subpath)
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
			writeUpstreamError(w, cid(ctx), err, endpoint, nil)
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

	// POST /api/networks/{netID}/topology/nodes — add a device to the topology.
	// Forwards body {name, device} to newtron's create-node verb.
	mux.Handle("POST /api/networks/{netID}/topology/nodes", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		var body any
		if !readBody(w, r, &body) {
			return
		}
		proxyNodeWrite(w, r, http.StatusCreated, func(ctx context.Context) (json.RawMessage, error) {
			return c.CreateTopologyDevice(ctx, netID, body)
		}, "POST /api/networks/"+netID+"/topology/nodes")
	}))

	// PUT /api/networks/{netID}/topology/nodes/{name} — update a device entry (full replacement).
	mux.Handle("PUT /api/networks/{netID}/topology/nodes/{name}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		name := r.PathValue("name")
		var body any
		if !readBody(w, r, &body) {
			return
		}
		proxyNodeWrite(w, r, http.StatusOK, func(ctx context.Context) (json.RawMessage, error) {
			return c.UpdateTopologyDevice(ctx, netID, name, body)
		}, "PUT /api/networks/"+netID+"/topology/nodes/"+name)
	}))

	// DELETE /api/networks/{netID}/topology/nodes/{name} — remove a device from the topology.
	// Query param ?force=true cascade-deletes referring links.
	mux.Handle("DELETE /api/networks/{netID}/topology/nodes/{name}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		name := r.PathValue("name")
		force := r.URL.Query().Get("force") == "true"
		proxyNodeWrite(w, r, http.StatusOK, func(ctx context.Context) (json.RawMessage, error) {
			return c.DeleteTopologyDevice(ctx, netID, name, force)
		}, "DELETE /api/networks/"+netID+"/topology/nodes/"+name)
	}))

	// POST /api/networks/{netID}/topology/links — add a link between two interfaces.
	// Forwards body {a, z} to newtron's create-link verb.
	mux.Handle("POST /api/networks/{netID}/topology/links", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		var body any
		if !readBody(w, r, &body) {
			return
		}
		proxyNodeWrite(w, r, http.StatusCreated, func(ctx context.Context) (json.RawMessage, error) {
			return c.CreateTopologyLink(ctx, netID, body)
		}, "POST /api/networks/"+netID+"/topology/links")
	}))

	// DELETE /api/networks/{netID}/topology/links/{device}/{interface} — remove the link that
	// includes the given endpoint. Newtron resolves the full link from a single endpoint.
	mux.Handle("DELETE /api/networks/{netID}/topology/links/{device}/{interface}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		iface := normalizeIfaceName(r.PathValue("interface"))
		proxyNodeWrite(w, r, http.StatusOK, func(ctx context.Context) (json.RawMessage, error) {
			return c.DeleteTopologyLink(ctx, netID, device, iface)
		}, "DELETE /api/networks/"+netID+"/topology/links/"+device+"/"+iface)
	}))

	// ============================================================================
	// Interface binding endpoints
	// ============================================================================

	// POST /api/networks/{netID}/nodes/{device}/interfaces/{name}/bind-service
	// Body: { service: string, ip_address?: string, vlan?: int, peer_as?: int, params?: object }
	mux.Handle("POST /api/networks/{netID}/nodes/{device}/interfaces/{name}/bind-service", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		name := normalizeIfaceName(r.PathValue("name"))
		var body any
		if !readBody(w, r, &body) {
			return
		}
		proxyNodeWrite(w, r, http.StatusOK, func(ctx context.Context) (json.RawMessage, error) {
			return c.ApplyService(ctx, netID, device, name, body)
		}, "POST /api/networks/"+netID+"/nodes/"+device+"/interfaces/"+name+"/bind-service")
	}))

	// POST /api/networks/{netID}/nodes/{device}/interfaces/{name}/unbind-service
	mux.Handle("POST /api/networks/{netID}/nodes/{device}/interfaces/{name}/unbind-service", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		name := normalizeIfaceName(r.PathValue("name"))
		proxyNodeWrite(w, r, http.StatusOK, func(ctx context.Context) (json.RawMessage, error) {
			return c.RemoveService(ctx, netID, device, name)
		}, "POST /api/networks/"+netID+"/nodes/"+device+"/interfaces/"+name+"/unbind-service")
	}))

	// POST /api/networks/{netID}/nodes/{device}/interfaces/{name}/refresh-service
	mux.Handle("POST /api/networks/{netID}/nodes/{device}/interfaces/{name}/refresh-service", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netID := r.PathValue("netID")
		device := r.PathValue("device")
		name := normalizeIfaceName(r.PathValue("name"))
		proxyNodeWrite(w, r, http.StatusOK, func(ctx context.Context) (json.RawMessage, error) {
			return c.RefreshService(ctx, netID, device, name)
		}, "POST /api/networks/"+netID+"/nodes/"+device+"/interfaces/"+name+"/refresh-service")
	}))
}

// normalizeIfaceName converts %2F sequences to "/" in interface names from
// URL path values. Matches newtron's interfaceName() normalisation.
func normalizeIfaceName(name string) string {
	return strings.ReplaceAll(name, "%2F", "/")
}

