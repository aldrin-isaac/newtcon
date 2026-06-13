// Network-level spec list, detail, create, delete, and sub-rule handlers.
//
// Read endpoints proxy newtron's GET /network/{netID}/{kind} routes.
// Write endpoints proxy newtron's RPC-style POST routes (create-<kind>,
// delete-<kind>, add-/remove- sub-rules).
//
// newtcon mirrors newtron's path geometry: every network-scoped resource lives
// under /api/networks/{netID}/... — the netID is positional, extracted via
// r.PathValue("netID") in each handler. No context-stashing, no ?net= query
// parameter.
//
// The HTTP method convention at the newtcon API boundary:
//
//	POST   /api/networks/{netID}/{kind}                    → create spec
//	DELETE /api/networks/{netID}/{kind}/{name}             → delete spec
//	POST   /api/networks/{netID}/{kind}/{name}/rules       → add sub-rule
//	DELETE /api/networks/{netID}/{kind}/{name}/rules/{key} → remove sub-rule
package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strconv"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// NetworkDeps is the dep set for the network-level spec list handlers.
type NetworkDeps struct {
	Client        *newtronc.Client
	CorrelationID func(ctx context.Context) string
}

// RegisterNetworkRoutes registers GET handlers for every spec-type list
// endpoint newtron exposes at the network level.
func RegisterNetworkRoutes(mux *http.ServeMux, deps NetworkDeps) {
	cid := deps.CorrelationID
	if cid == nil {
		cid = func(ctx context.Context) string { return "" }
	}
	c := deps.Client

	type listFn func(ctx context.Context, network string) ([]string, error)
	register := func(kind string, fn listFn) {
		path := "/api/networks/{netID}/" + kind
		mux.Handle("GET "+path, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			netID := r.PathValue("netID")
			names, err := fn(ctx, netID)
			if err != nil {
				writeUpstreamError(w, cid(ctx), err, path, nil)
				return
			}
			sort.Strings(names)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{"names": names})
		}))
	}

	register("ipvpns", c.ListIPVPNs)
	register("macvpns", c.ListMACVPNs)
	register("qos-policies", c.ListQoSPolicies)
	register("filters", c.ListFilters)
	register("prefix-lists", c.ListPrefixLists)
	register("route-policies", c.ListRoutePolicies)
	register("profiles", c.ListProfiles)
	register("zones", c.ListZones)
	register("platforms", c.ListPlatforms)

	// Per-spec detail endpoints. URL pattern: /api/networks/{netID}/{kind}/{name}.
	// {kind} is the same plural form used in the list endpoints; {name} is the
	// spec instance name. Returns the full newtron payload verbatim.
	for _, kind := range []struct{ url, newtronKind string }{
		{"services", "service"},
		{"ipvpns", "ipvpn"},
		{"macvpns", "macvpn"},
		{"qos-policies", "qos-policy"},
		{"filters", "filter"},
		{"prefix-lists", "prefix-list"},
		{"route-policies", "route-policy"},
		{"profiles", "profile"},
		{"zones", "zone"},
		{"platforms", "platform"},
	} {
		k := kind // capture for closure
		path := "/api/networks/{netID}/" + k.url + "/{name}"
		mux.Handle("GET "+path, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			netID := r.PathValue("netID")
			name := r.PathValue("name")
			// newtron's per-spec detail route is plural (matches the list
			// path one level up: GET /networks/{n}/profiles/{name}, not
			// /profile/{name}). Pass k.url (plural) not k.newtronKind
			// (singular, which is the create-/delete- verb suffix).
			// Pre-PR every detail GET 404'd silently — k.newtronKind
			// produced /newtron/v1/networks/{n}/profile/{name} which
			// newtron's mux doesn't recognise.
			payload, err := c.ShowSpec(ctx, netID, k.url, name)
			if err != nil {
				writeUpstreamError(w, cid(ctx), err,
					k.newtronKind+" "+name+" at /api/networks/"+netID+"/"+k.url+"/"+name, nil)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(payload)
		}))
	}

	// Register write routes (create, delete, sub-rules).
	registerWriteRoutes(mux, c, cid)
}

// ============================================================================
// Write routes — create and delete for each spec type, plus sub-rules.
// ============================================================================

// specKindMap maps the plural URL segment used in the newtcon API to the
// singular newtron RPC segment (used in create-<kind> / delete-<kind> URLs).
var specKindMap = map[string]string{
	"services":       "service",
	"ipvpns":         "ipvpn",
	"macvpns":        "macvpn",
	"qos-policies":   "qos-policy",
	"filters":        "filter",
	"prefix-lists":   "prefix-list",
	"route-policies": "route-policy",
	"profiles":       "profile",
	"zones":          "zone",
}

// registerWriteRoutes adds POST (create) and DELETE (delete) for every spec
// type listed in specKindMap, plus sub-rule endpoints for the four types that
// support child rules.
func registerWriteRoutes(mux *http.ServeMux, c *newtronc.Client, cid func(ctx context.Context) string) {
	// ---- Per-kind create + delete -------------------------------------------

	for urlKind, newtronKind := range specKindMap {
		uk := urlKind  // capture for closure
		nk := newtronKind // capture for closure

		// POST /api/networks/{netID}/{kind} → create spec
		mux.Handle("POST /api/networks/{netID}/"+uk, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			netID := r.PathValue("netID")
			body, err := io.ReadAll(r.Body)
			if err != nil {
				types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
					"reading request body: "+err.Error(), nil)
				return
			}
			var decoded any
			if err := json.Unmarshal(body, &decoded); err != nil {
				types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
					"invalid JSON: "+err.Error(), nil)
				return
			}
			result, err := c.CreateSpec(ctx, netID, nk, decoded)
			if err != nil {
				writeUpstreamError(w, cid(ctx), err, "POST /api/networks/"+netID+"/"+uk, nil)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write(result)
		}))

		// DELETE /api/networks/{netID}/{kind}/{name} → delete spec
		mux.Handle("DELETE /api/networks/{netID}/"+uk+"/{name}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			netID := r.PathValue("netID")
			name := r.PathValue("name")
			if err := c.DeleteSpec(ctx, netID, nk, name); err != nil {
				writeUpstreamError(w, cid(ctx), err, "DELETE /api/networks/"+netID+"/"+uk+"/"+name, nil)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted", "name": name})
		}))
	}

	// ---- Sub-rule: QoS queues ------------------------------------------------
	// POST   /api/networks/{netID}/qos-policies/{name}/queues    → add-qos-queue
	// DELETE /api/networks/{netID}/qos-policies/{name}/queues/{queue_id} → remove-qos-queue

	mux.Handle("POST /api/networks/{netID}/qos-policies/{name}/queues", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		body, err := io.ReadAll(r.Body)
		if err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"reading request body: "+err.Error(), nil)
			return
		}
		var decoded any
		if err := json.Unmarshal(body, &decoded); err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"invalid JSON: "+err.Error(), nil)
			return
		}
		result, err := c.AddQoSQueue(ctx, netID, decoded)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err, "POST /api/networks/"+netID+"/qos-policies/…/queues", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(result)
	}))

	mux.Handle("DELETE /api/networks/{netID}/qos-policies/{name}/queues/{queue_id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		policy := r.PathValue("name")
		qidStr := r.PathValue("queue_id")
		qid, err := strconv.Atoi(qidStr)
		if err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"queue_id must be an integer: "+qidStr, nil)
			return
		}
		if err := c.RemoveQoSQueue(ctx, netID, policy, qid); err != nil {
			writeUpstreamError(w, cid(ctx), err, "DELETE /api/networks/"+netID+"/qos-policies/"+policy+"/queues/"+qidStr, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
	}))

	// ---- Sub-rule: filter rules ---------------------------------------------
	// POST   /api/networks/{netID}/filters/{name}/rules    → add-filter-rule
	// DELETE /api/networks/{netID}/filters/{name}/rules/{seq} → remove-filter-rule

	mux.Handle("POST /api/networks/{netID}/filters/{name}/rules", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		body, err := io.ReadAll(r.Body)
		if err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"reading request body: "+err.Error(), nil)
			return
		}
		var decoded any
		if err := json.Unmarshal(body, &decoded); err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"invalid JSON: "+err.Error(), nil)
			return
		}
		result, err := c.AddFilterRule(ctx, netID, decoded)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err, "POST /api/networks/"+netID+"/filters/…/rules", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(result)
	}))

	mux.Handle("DELETE /api/networks/{netID}/filters/{name}/rules/{seq}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		filter := r.PathValue("name")
		seqStr := r.PathValue("seq")
		seq, err := strconv.Atoi(seqStr)
		if err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"seq must be an integer: "+seqStr, nil)
			return
		}
		if err := c.RemoveFilterRule(ctx, netID, filter, seq); err != nil {
			writeUpstreamError(w, cid(ctx), err, "DELETE /api/networks/"+netID+"/filters/"+filter+"/rules/"+seqStr, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
	}))

	// ---- Sub-rule: prefix list entries --------------------------------------
	// POST   /api/networks/{netID}/prefix-lists/{name}/entries     → add-prefix-list-entry
	// DELETE /api/networks/{netID}/prefix-lists/{name}/entries/{prefix} → remove-prefix-list-entry

	mux.Handle("POST /api/networks/{netID}/prefix-lists/{name}/entries", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		body, err := io.ReadAll(r.Body)
		if err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"reading request body: "+err.Error(), nil)
			return
		}
		var decoded any
		if err := json.Unmarshal(body, &decoded); err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"invalid JSON: "+err.Error(), nil)
			return
		}
		result, err := c.AddPrefixListEntry(ctx, netID, decoded)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err, "POST /api/networks/"+netID+"/prefix-lists/…/entries", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(result)
	}))

	mux.Handle("DELETE /api/networks/{netID}/prefix-lists/{name}/entries/{prefix...}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		list := r.PathValue("name")
		prefix := r.PathValue("prefix")
		if err := c.RemovePrefixListEntry(ctx, netID, list, prefix); err != nil {
			writeUpstreamError(w, cid(ctx), err, "DELETE /api/networks/"+netID+"/prefix-lists/"+list+"/entries/"+prefix, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
	}))

	// ---- Sub-rule: route policy rules ---------------------------------------
	// POST   /api/networks/{netID}/route-policies/{name}/rules    → add-route-policy-rule
	// DELETE /api/networks/{netID}/route-policies/{name}/rules/{seq} → remove-route-policy-rule

	mux.Handle("POST /api/networks/{netID}/route-policies/{name}/rules", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		body, err := io.ReadAll(r.Body)
		if err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"reading request body: "+err.Error(), nil)
			return
		}
		var decoded any
		if err := json.Unmarshal(body, &decoded); err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"invalid JSON: "+err.Error(), nil)
			return
		}
		result, err := c.AddRoutePolicyRule(ctx, netID, decoded)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err, "POST /api/networks/"+netID+"/route-policies/…/rules", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(result)
	}))

	mux.Handle("DELETE /api/networks/{netID}/route-policies/{name}/rules/{seq}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		policy := r.PathValue("name")
		seqStr := r.PathValue("seq")
		seq, err := strconv.Atoi(seqStr)
		if err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"seq must be an integer: "+seqStr, nil)
			return
		}
		if err := c.RemoveRoutePolicyRule(ctx, netID, policy, seq); err != nil {
			writeUpstreamError(w, cid(ctx), err, "DELETE /api/networks/"+netID+"/route-policies/"+policy+"/rules/"+seqStr, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
	}))
}
