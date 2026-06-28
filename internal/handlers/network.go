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

	// Cross-scope spec inventory (newtron #287): the flat list of every spec
	// definition tagged with scope + scope_instance — backs the Specs list's
	// scope columns. Raw payload forwarded ([{kind,name,scope,scope_instance}]).
	mux.Handle("GET /api/networks/{netID}/spec-instances", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		payload, err := c.SpecInstances(ctx, netID)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err, "/api/networks/"+netID+"/spec-instances", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}))

	// Per-spec detail endpoints. URL pattern: /api/networks/{netID}/{kind}/{name}.
	// {kind} is the same plural form used in the list endpoints; {name} is the
	// spec instance name. Returns the full newtron payload verbatim.
	//
	// upstreamKind is the URL segment newtron itself serves under — usually
	// equal to url, but `profiles` maps to newtron's `nodes/` after
	// newtron PR #206 (2026-06-17). Newtcon-internal callers still address
	// these as "profiles" so the SpecKind enum + frontend tabs don't shift.
	for _, kind := range []struct{ url, newtronKind, upstreamKind string }{
		{"services", "service", "services"},
		{"ipvpns", "ipvpn", "ipvpns"},
		{"macvpns", "macvpn", "macvpns"},
		{"qos-policies", "qos-policy", "qos-policies"},
		{"filters", "filter", "filters"},
		{"prefix-lists", "prefix-list", "prefix-lists"},
		{"route-policies", "route-policy", "route-policies"},
		{"profiles", "profile", "nodes"},
		{"zones", "zone", "zones"},
		{"platforms", "platform", "platforms"},
	} {
		k := kind // capture for closure
		path := "/api/networks/{netID}/" + k.url + "/{name}"
		mux.Handle("GET "+path, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			netID := r.PathValue("netID")
			name := r.PathValue("name")
			payload, err := c.ShowSpec(ctx, netID, k.upstreamKind, name)
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

// registerWriteRoutes adds generic POST / DELETE / PUT handlers that
// resolve the URL slug to a newtron kind via kindResolver at request
// time. The resolver consults newtron's /api/schema first; the
// legacy specKindMap (defined in kind_resolver.go) is the fallback.
//
// Net: when newtron adds a new top-level kind (RegisterSchemaKind),
// it becomes authorable through newtcon-server with no code change.
func registerWriteRoutes(mux *http.ServeMux, c *newtronc.Client, cid func(ctx context.Context) string) {
	// ---- Generic create + delete + update -----------------------------------
	resolver := newKindResolver(c)

	mux.Handle("POST /api/networks/{netID}/{kind}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		slug := r.PathValue("kind")
		entry, ok := resolver.lookup(ctx, slug)
		if !ok {
			types.WriteError(w, http.StatusNotFound, types.KindValidationFailure,
				"unknown spec kind: "+slug, nil)
			return
		}
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
		result, err := c.CreateSpec(ctx, netID, entry.newtronKind, decoded)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err, "POST /api/networks/"+netID+"/"+slug, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(result)
	}))

	mux.Handle("DELETE /api/networks/{netID}/{kind}/{name}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		slug := r.PathValue("kind")
		name := r.PathValue("name")
		entry, ok := resolver.lookup(ctx, slug)
		if !ok {
			types.WriteError(w, http.StatusNotFound, types.KindValidationFailure,
				"unknown spec kind: "+slug, nil)
			return
		}
		// scope/scope_instance (query) target a zone/node override; absent =
		// the network base (newtron #287 + #319 scoped delete).
		scope := r.URL.Query().Get("scope")
		scopeInstance := r.URL.Query().Get("scope_instance")
		if err := c.DeleteSpec(ctx, netID, entry.newtronKind, name, scope, scopeInstance); err != nil {
			writeUpstreamError(w, cid(ctx), err, "DELETE /api/networks/"+netID+"/"+slug+"/"+name, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted", "name": name})
	}))

	mux.Handle("PUT /api/networks/{netID}/{kind}/{name}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		slug := r.PathValue("kind")
		name := r.PathValue("name")
		entry, ok := resolver.lookup(ctx, slug)
		if !ok {
			types.WriteError(w, http.StatusNotFound, types.KindValidationFailure,
				"unknown spec kind: "+slug, nil)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"reading request body: "+err.Error(), nil)
			return
		}
		var decoded map[string]any
		if err := json.Unmarshal(body, &decoded); err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"invalid JSON: "+err.Error(), nil)
			return
		}
		// Identifier comes from the URL — overwrite any client-supplied
		// "name" so the operator can't ask "update foo" while sending
		// {"name":"bar",…}; newtron would 404 silently or update the wrong
		// spec depending on its own validation.
		decoded["name"] = name
		result, err := c.UpdateSpec(ctx, netID, entry.newtronKind, decoded)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err, "PUT /api/networks/"+netID+"/"+slug+"/"+name, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result)
	}))

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

	// ---- Sub-rule UPDATE (slice #173.B) ------------------------------------
	// Per-item in-place edit + reorder for the three sub-rule families
	// with editable non-key fields. Newtron PRs #215/216/217 ship the
	// update-<sub-rule> verbs; these handlers wrap them with a RESTful
	// PUT shape:
	//
	//   PUT /api/networks/{netID}/qos-policies/{name}/queues/{queue_id}
	//   PUT /api/networks/{netID}/filters/{name}/rules/{seq}
	//   PUT /api/networks/{netID}/route-policies/{name}/rules/{seq}
	//
	// Identifier + parent name are taken from the URL path and injected
	// into the body before forwarding to newtron's update-<X> verb,
	// which expects them in the request body. The body may carry a
	// renumber field (new_seq / new_queue_id) — passed through unchanged.
	//
	// Prefix-list entries have no editable fields beyond the key (the
	// prefix itself), so newtron #239 removed update-prefix-list-entry
	// entirely. Renaming a prefix-list entry now compiles to
	// remove-prefix-list-entry + add-prefix-list-entry — there is no
	// PUT entries/{prefix} route on this server.

	mux.Handle("PUT /api/networks/{netID}/qos-policies/{name}/queues/{queue_id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		body := readJSONBodyAsMap(w, r)
		if body == nil {
			return
		}
		body["policy"] = policy
		body["queue_id"] = qid
		result, err := c.UpdateQoSQueue(ctx, netID, body)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err, "PUT /api/networks/"+netID+"/qos-policies/"+policy+"/queues/"+qidStr, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result)
	}))

	mux.Handle("PUT /api/networks/{netID}/filters/{name}/rules/{seq}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		body := readJSONBodyAsMap(w, r)
		if body == nil {
			return
		}
		body["filter"] = filter
		body["seq"] = seq
		result, err := c.UpdateFilterRule(ctx, netID, body)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err, "PUT /api/networks/"+netID+"/filters/"+filter+"/rules/"+seqStr, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result)
	}))

	mux.Handle("PUT /api/networks/{netID}/route-policies/{name}/rules/{seq}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		body := readJSONBodyAsMap(w, r)
		if body == nil {
			return
		}
		body["policy"] = policy
		body["seq"] = seq
		result, err := c.UpdateRoutePolicyRule(ctx, netID, body)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err, "PUT /api/networks/"+netID+"/route-policies/"+policy+"/rules/"+seqStr, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(result)
	}))

}

// readJSONBodyAsMap reads + parses an HTTP request body as a JSON
// object. On error (read failure, malformed JSON, or non-object root)
// it writes a 400 validation_failure response and returns nil so the
// caller can early-return.
func readJSONBodyAsMap(w http.ResponseWriter, r *http.Request) map[string]any {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
			"reading request body: "+err.Error(), nil)
		return nil
	}
	if len(body) == 0 {
		return map[string]any{}
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
			"invalid JSON: "+err.Error(), nil)
		return nil
	}
	return decoded
}
