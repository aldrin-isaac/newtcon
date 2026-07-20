// Package handlers contains one file per resource family served by
// newtcon-server. CLAUDE.md §File Ownership Map: "one file per resource
// family" — do not consolidate unrelated families.
//
// This file implements GET /api/health per API_CONTRACT.md §GET /api/health
// (lines 1311–1354).
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// newtronHealthProber is the minimal interface the health handler requires from
// the newtron client. Using an interface rather than *newtronc.Client directly
// lets tests inject a stub without an httptest.Server when the stub is cheaper.
type newtronHealthProber interface {
	Health(ctx context.Context) (reachable bool, version string)
	Posture(ctx context.Context) (authSurface, auditLog string)
}

// HealthConfig carries the dependencies for [NewHealthHandler].
type HealthConfig struct {
	// NewtronClient is the newtron-server HTTP client. Must not be nil.
	NewtronClient newtronHealthProber

	// NewtronURL is the configured newtron-server base URL, echoed in the
	// response as newtron.url per API_CONTRACT.md line 1321.
	NewtronURL string
}

// newtconVersion is the newtcon-server build version surfaced in HealthResponse.
// In v1 this is a static string. A future build toolchain integration will
// inject the actual semver via -ldflags.
const newtconVersion = "0.0.0-dev"

// defaultTerminalFloorSeconds is the 30-day retention floor for terminal
// operations. API_CONTRACT.md §GET /api/health line 1350.
const defaultTerminalFloorSeconds = 30 * 24 * 60 * 60 // 2592000

// defaultInFlightFloorSeconds is the 7-day retention floor for in-flight
// operations. API_CONTRACT.md §GET /api/health line 1351.
const defaultInFlightFloorSeconds = 7 * 24 * 60 * 60 // 604800

// NewHealthHandler returns an http.Handler that serves GET /api/health.
//
// The handler:
//  1. Calls newtronc.Client.Health to populate Reachable and Version.
//  2. Emits the HealthResponse JSON per API_CONTRACT.md §GET /api/health.
//  3. Populates operations_retention from deployment defaults (pruner not yet
//     implemented; PrunerLastRunAt / PrunerNextRunAt are zero-valued and
//     serialised as "0001-01-01T00:00:00Z" — honest per CLAUDE.md §No Hidden
//     State).
//  4. Returns HTTP 200 always — even when newtron-server is unreachable.
//     API_CONTRACT.md line 1337: "If newtron-server is unreachable, reachable
//     is false and the endpoint still returns 200 — newtcon-server itself is alive."
//
// Method guard: non-GET requests receive 405 via the Go 1.22 ServeMux pattern
// ("GET /api/health") registered in router.go — this handler only sees GET.
func NewHealthHandler(cfg HealthConfig) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reachable, version := cfg.NewtronClient.Health(r.Context())
		// Posture probes are bounded: a hung engine must not stall /api/health
		// (the shell polls it every 15s).
		pctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		authSurface, auditLog := cfg.NewtronClient.Posture(pctx)
		cancel()

		resp := types.HealthResponse{
			Status:  "ok",
			Version: newtconVersion,
			Newtron: types.NewtronProbe{
				URL:       cfg.NewtronURL,
				Reachable: reachable,
				Version:   version,
			},
			EnginePosture: types.EnginePosture{
				AuthSurface: authSurface,
				AuditLog:    auditLog,
			},
			// pruner not yet implemented; v1 reports configured floor only.
			// PrunerLastRunAt / PrunerNextRunAt are zero-valued ("0001-01-01T00:00:00Z").
			// Per CLAUDE.md §No Hidden State: zero timestamps + this comment is
			// acceptable because the fields are structurally present per contract.
			OperationsRetention: types.OperationsRetention{
				Source:               "newtcon_operations_store",
				TerminalFloorSeconds: defaultTerminalFloorSeconds,
				InFlightFloorSeconds: defaultInFlightFloorSeconds,
				PrunerLastRunAt:      time.Time{},
				PrunerNextRunAt:      time.Time{},
			},
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
	})
}

// newtronClientAdapter is a compile-time assertion that *newtronc.Client
// satisfies the newtronHealthProber interface. If newtronc.Client.Health's
// signature changes, this line fails at build time — catching the mismatch
// before runtime.
var _ newtronHealthProber = (*newtronc.Client)(nil)
