// Package types defines the API DTOs for newtcon-server's HTTP responses.
//
// This file defines the HealthResponse shape for GET /api/health, matching
// API_CONTRACT.md §GET /api/health lines 1311–1354.
package types

import "time"

// HealthResponse is the response body for GET /api/health.
// API_CONTRACT.md §GET /api/health (lines 1311–1354).
//
// The endpoint returns 200 in all cases — even when newtron-server is
// unreachable. The newtron.reachable field carries the honest reachability
// verdict (operator-philosophy invariant #9 "Confidence and limits are
// explicit").
type HealthResponse struct {
	Status             string             `json:"status"`
	Version            string             `json:"version"`
	Newtron            NewtronProbe       `json:"newtron"`
	EnginePosture      EnginePosture      `json:"engine_posture"`
	OperationsRetention OperationsRetention `json:"operations_retention"`
}

// NewtronProbe holds the result of the lightweight upstream health probe.
// API_CONTRACT.md §GET /api/health lines 1320–1324.
//
// Version is always "" in v1 because newtron-server exposes no /version
// endpoint. Confirmed by grep against ../newtron/pkg/newtron/api/handler.go
// buildMux(): only GET /network is available at the top level for the probe.
// This is documented as a v1 limitation, not a Gap-Handling-Protocol issue,
// because newtron-version is not load-bearing for Composer v1.
type NewtronProbe struct {
	URL       string `json:"url"`
	Reachable bool   `json:"reachable"`
	Version   string `json:"version"`
}

// OperationsRetention exposes the deployment's configured retention floors
// for the operations store. API_CONTRACT.md §GET /api/health lines 1325–1354.
//
// Per CLAUDE.md §No Hidden State and operator-philosophy invariant #9, the
// operator must be able to ask "how long do my operations stay queryable?"
// and receive a substrate-grounded answer.
//
// PrunerLastRunAt and PrunerNextRunAt are zero-valued (reported as
// "0001-01-01T00:00:00Z") in v1 because the pruner is not yet implemented.
// The fields are structurally present per contract; the zero values are honest
// (the pruner has never run). See issue comment in health.go for the post-ship
// note.
type OperationsRetention struct {
	// Source echoes the source-of-truth decision; currently always
	// "newtcon_operations_store".
	Source string `json:"source"`

	// TerminalFloorSeconds is the configured floor for terminal operations
	// (default 30 days = 2592000 seconds).
	TerminalFloorSeconds int `json:"terminal_floor_seconds"`

	// InFlightFloorSeconds is the configured floor for in-flight operations
	// (default 7 days = 604800 seconds).
	InFlightFloorSeconds int `json:"in_flight_floor_seconds"`

	// PrunerLastRunAt is the timestamp of the most recent pruner run.
	// Zero in v1 — pruner not yet implemented.
	PrunerLastRunAt time.Time `json:"pruner_last_run_at"`

	// PrunerNextRunAt is the scheduled next pruner run.
	// Zero in v1 — pruner not yet implemented.
	PrunerNextRunAt time.Time `json:"pruner_next_run_at"`
}

// EnginePosture reports which optional engine layers are actually present,
// probed live (uplift 6.4, #447). Values are honest tri-states — "unknown"
// when the probe itself failed, never a guess. This is how the console
// surfaces "auth off / audit off" instead of letting operators discover it
// by tripping over 404s.
type EnginePosture struct {
	// AuthSurface: "enabled" (L2c login endpoint answers), "absent"
	// (endpoint 404s — engine runs without auth), or "unknown".
	AuthSurface string `json:"auth_surface"`
	// AuditLog: "enabled", "disabled" (engine reports the L6 audit log
	// disabled), or "unknown" (no network to probe / probe failed).
	AuditLog string `json:"audit_log"`
}
