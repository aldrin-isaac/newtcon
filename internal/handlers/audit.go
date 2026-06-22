// handlers/audit.go — GET /api/networks/{netID}/audit/{events,integrity}
// (slice #175.B). Forwards to newtron's audit endpoints (newtron PR
// #197 closing newtron#196).
//
// Events: query string is forwarded verbatim. Newtron validates filter
// fields (since/until/limit/offset, etc.) and returns 400 with the bad
// field name on malformed input; that maps cleanly to validation_failure
// via the standard error envelope.
//
// Integrity: pure read, no parameters.
//
// 404 from newtron means either the network doesn't exist OR the
// server was started without --audit-log. The renderer disambiguates
// in the UI.
package handlers

import (
	"context"
	"net/http"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
)

type AuditDeps struct {
	Client        *newtronc.Client
	CorrelationID func(context.Context) string
}

func RegisterAuditRoutes(mux *http.ServeMux, deps AuditDeps) {
	cid := deps.CorrelationID
	if cid == nil {
		cid = func(ctx context.Context) string { return "" }
	}

	mux.Handle("GET /api/networks/{netID}/audit/events", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		payload, err := deps.Client.AuditEvents(ctx, netID, r.URL.RawQuery)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err,
				"GET /api/networks/"+netID+"/audit/events", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}))

	// Per-event detail (newtron #276): the heavy fields (request_body +
	// changes) for one event, fetched on row click. Must be registered
	// alongside the list route; ServeMux distinguishes them by the
	// trailing {eventID} segment.
	mux.Handle("GET /api/networks/{netID}/audit/events/{eventID}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		eventID := r.PathValue("eventID")
		payload, err := deps.Client.AuditEvent(ctx, netID, eventID)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err,
				"GET /api/networks/"+netID+"/audit/events/"+eventID, nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}))

	mux.Handle("GET /api/networks/{netID}/audit/integrity", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		netID := r.PathValue("netID")
		payload, err := deps.Client.AuditIntegrity(ctx, netID)
		if err != nil {
			writeUpstreamError(w, cid(ctx), err,
				"GET /api/networks/"+netID+"/audit/integrity", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}))
}
