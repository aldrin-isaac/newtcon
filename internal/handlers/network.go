// Network-level spec list, detail, create, delete, and sub-rule handlers.
//
// Read endpoints proxy newtron's GET /network/{netID}/{kind} routes.
// Write endpoints proxy newtron's RPC-style POST routes (create-<kind>,
// delete-<kind>, add-/remove- sub-rules). The HTTP method convention at the
// newtcon API boundary:
//
//	POST   /api/{kind}                    → create spec (body forwarded verbatim)
//	DELETE /api/{kind}/{name}             → delete spec (sends {"name":…} to newtron)
//	POST   /api/{kind}/{name}/rules       → add sub-rule (body forwarded verbatim)
//	DELETE /api/{kind}/{name}/rules/{key} → remove sub-rule
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
	register := func(path string, fn listFn) {
		mux.Handle("GET "+path, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			names, err := fn(ctx, c.Network(ctx))
			if err != nil {
				writeNetworkListUnavailable(w, cid(ctx), err, path)
				return
			}
			sort.Strings(names)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{"names": names})
		}))
	}

	register("/api/ipvpns", c.ListIPVPNs)
	register("/api/macvpns", c.ListMACVPNs)
	register("/api/qos-policies", c.ListQoSPolicies)
	register("/api/filters", c.ListFilters)
	register("/api/prefix-lists", c.ListPrefixLists)
	register("/api/route-policies", c.ListRoutePolicies)
	register("/api/profiles", c.ListProfiles)
	register("/api/zones", c.ListZones)
	register("/api/platforms", c.ListPlatforms)

	// Per-spec detail endpoints. URL pattern: /api/{kind}/{name}.
	// {kind} is the same plural form used in the list endpoints; {name}
	// is the spec instance name. Returns the full newtron payload verbatim.
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
		mux.Handle("GET /api/"+k.url+"/{name}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			name := r.PathValue("name")
			payload, err := c.ShowSpec(ctx, c.Network(ctx), k.newtronKind, name)
			if err != nil {
				if _, ok := err.(*newtronc.NotFoundError); ok {
					types.WriteError(w, http.StatusNotFound, types.KindInternal,
						k.newtronKind+" not found: "+name, map[string]any{"correlation_id": cid(ctx)})
					return
				}
				writeNetworkListUnavailable(w, cid(ctx), err, "/api/"+k.url+"/"+name)
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

		// POST /api/{kind} → create spec
		mux.Handle("POST /api/"+uk, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
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
			result, err := c.CreateSpec(ctx, c.Network(ctx), nk, decoded)
			if err != nil {
				writeNetworkWriteError(w, cid(ctx), err, "POST /api/"+uk)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write(result)
		}))

		// DELETE /api/{kind}/{name} → delete spec
		mux.Handle("DELETE /api/"+uk+"/{name}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			name := r.PathValue("name")
			if err := c.DeleteSpec(ctx, c.Network(ctx), nk, name); err != nil {
				writeNetworkWriteError(w, cid(ctx), err, "DELETE /api/"+uk+"/"+name)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted", "name": name})
		}))
	}

	// ---- Sub-rule: QoS queues ------------------------------------------------
	// POST   /api/qos-policies/{name}/queues    → add-qos-queue
	// DELETE /api/qos-policies/{name}/queues/{queue_id} → remove-qos-queue

	mux.Handle("POST /api/qos-policies/{name}/queues", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
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
		result, err := c.AddQoSQueue(ctx, c.Network(ctx), decoded)
		if err != nil {
			writeNetworkWriteError(w, cid(ctx), err, "POST /api/qos-policies/…/queues")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(result)
	}))

	mux.Handle("DELETE /api/qos-policies/{name}/queues/{queue_id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		policy := r.PathValue("name")
		qidStr := r.PathValue("queue_id")
		qid, err := strconv.Atoi(qidStr)
		if err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"queue_id must be an integer: "+qidStr, nil)
			return
		}
		if err := c.RemoveQoSQueue(ctx, c.Network(ctx), policy, qid); err != nil {
			writeNetworkWriteError(w, cid(ctx), err, "DELETE /api/qos-policies/"+policy+"/queues/"+qidStr)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
	}))

	// ---- Sub-rule: filter rules ---------------------------------------------
	// POST   /api/filters/{name}/rules    → add-filter-rule
	// DELETE /api/filters/{name}/rules/{seq} → remove-filter-rule

	mux.Handle("POST /api/filters/{name}/rules", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
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
		result, err := c.AddFilterRule(ctx, c.Network(ctx), decoded)
		if err != nil {
			writeNetworkWriteError(w, cid(ctx), err, "POST /api/filters/…/rules")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(result)
	}))

	mux.Handle("DELETE /api/filters/{name}/rules/{seq}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		filter := r.PathValue("name")
		seqStr := r.PathValue("seq")
		seq, err := strconv.Atoi(seqStr)
		if err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"seq must be an integer: "+seqStr, nil)
			return
		}
		if err := c.RemoveFilterRule(ctx, c.Network(ctx), filter, seq); err != nil {
			writeNetworkWriteError(w, cid(ctx), err, "DELETE /api/filters/"+filter+"/rules/"+seqStr)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
	}))

	// ---- Sub-rule: prefix list entries --------------------------------------
	// POST   /api/prefix-lists/{name}/entries     → add-prefix-list-entry
	// DELETE /api/prefix-lists/{name}/entries/{prefix} → remove-prefix-list-entry

	mux.Handle("POST /api/prefix-lists/{name}/entries", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
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
		result, err := c.AddPrefixListEntry(ctx, c.Network(ctx), decoded)
		if err != nil {
			writeNetworkWriteError(w, cid(ctx), err, "POST /api/prefix-lists/…/entries")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(result)
	}))

	mux.Handle("DELETE /api/prefix-lists/{name}/entries/{prefix...}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		list := r.PathValue("name")
		prefix := r.PathValue("prefix")
		if err := c.RemovePrefixListEntry(ctx, c.Network(ctx), list, prefix); err != nil {
			writeNetworkWriteError(w, cid(ctx), err, "DELETE /api/prefix-lists/"+list+"/entries/"+prefix)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
	}))

	// ---- Sub-rule: route policy rules ---------------------------------------
	// POST   /api/route-policies/{name}/rules    → add-route-policy-rule
	// DELETE /api/route-policies/{name}/rules/{seq} → remove-route-policy-rule

	mux.Handle("POST /api/route-policies/{name}/rules", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
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
		result, err := c.AddRoutePolicyRule(ctx, c.Network(ctx), decoded)
		if err != nil {
			writeNetworkWriteError(w, cid(ctx), err, "POST /api/route-policies/…/rules")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(result)
	}))

	mux.Handle("DELETE /api/route-policies/{name}/rules/{seq}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		policy := r.PathValue("name")
		seqStr := r.PathValue("seq")
		seq, err := strconv.Atoi(seqStr)
		if err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"seq must be an integer: "+seqStr, nil)
			return
		}
		if err := c.RemoveRoutePolicyRule(ctx, c.Network(ctx), policy, seq); err != nil {
			writeNetworkWriteError(w, cid(ctx), err, "DELETE /api/route-policies/"+policy+"/rules/"+seqStr)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
	}))
}

func writeNetworkListUnavailable(w http.ResponseWriter, correlationID string, err error, path string) {
	underlyingKind := "http_5xx"
	if unavail, ok := err.(*newtronc.UnavailableError); ok && unavail.StatusCode == 0 {
		underlyingKind = "connection_refused"
	}
	types.WriteError(w, http.StatusServiceUnavailable,
		types.KindNewtronUnavailable,
		"newtron-server unreachable for "+path+": "+err.Error(),
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

// writeNetworkWriteError translates newtronc write errors into operator-honest
// HTTP responses. Validation failures from newtron become 400; conflict/drift
// become 409; unavailability becomes 503.
func writeNetworkWriteError(w http.ResponseWriter, correlationID string, err error, path string) {
	switch e := err.(type) {
	case *newtronc.ValidationError:
		types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
			"validation failed: "+err.Error(),
			map[string]any{"correlation_id": correlationID, "newtron_body": string(e.Body)})
	case *newtronc.NotFoundError:
		types.WriteError(w, http.StatusNotFound, types.KindInternal,
			"not found: "+err.Error(),
			map[string]any{"correlation_id": correlationID})
	case *newtronc.ConflictError:
		types.WriteError(w, http.StatusConflict, types.KindDriftRefusal,
			"conflict: "+err.Error(),
			map[string]any{"correlation_id": correlationID, "newtron_body": string(e.Body)})
	default:
		underlyingKind := "http_5xx"
		if unavail, ok := err.(*newtronc.UnavailableError); ok && unavail.StatusCode == 0 {
			underlyingKind = "connection_refused"
		}
		types.WriteError(w, http.StatusServiceUnavailable, types.KindNewtronUnavailable,
			"newtron-server unreachable for "+path+": "+err.Error(),
			map[string]any{
				"correlation_id":           correlationID,
				"underlying_error":         underlyingKind,
				"underlying_error_message": err.Error(),
			})
	}
}
