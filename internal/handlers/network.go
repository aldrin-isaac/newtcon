// Network-level spec list handlers — one endpoint per spec type the operator
// can author in newtron. Each proxies newtron's GET /network/{netID}/{kind}
// and returns {"names": [...]} on success or the standard error envelope on
// failure.
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"

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
