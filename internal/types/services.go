// Package types defines the API DTOs for newtcon-server's HTTP responses.
//
// This file defines the Service Composer DTOs for GET /api/services, matching
// API_CONTRACT.md §GET /api/services (lines 1356–1379).
//
// Type boundary discipline (newtcon#83): this file holds outward newtcon DTOs
// only — the shapes returned to callers of newtcon-server. The internal
// substrate-translation types (NewtronService, NewtronServiceDetail) that
// newtronc uses to decode newtron-server's wire format live in
// internal/newtronc/services.go and must not cross into this package.
package types

import "time"

// Service type constants enumerate the service kinds newtron supports.
// API_CONTRACT.md §GET /api/services line 1379: "type enumerates the service
// kinds newtron supports."
//
// These are untyped string constants — the contract surfaces the bounded set;
// runtime validation lives upstream in newtron (newtcon#80 Scope §types).
//
// Post-ship gap: newtron's substrate also defines "evpn-routed"
// (pkg/newtron/types.go ServiceTypeEVPNRouted) which is not in the contract's
// listed values. Surfaced as Implementer note; no action in this slice.
const (
	ServiceTypeRouted      = "routed"
	ServiceTypeBridged     = "bridged"
	ServiceTypeIRB         = "irb"
	ServiceTypeEVPNBridged = "evpn-bridged"
	ServiceTypeEVPNIRB     = "evpn-irb"
)

// ServiceListResponse is the response body for GET /api/services.
// API_CONTRACT.md §GET /api/services (lines 1356–1379).
type ServiceListResponse struct {
	Services []Service `json:"services"`
}

// Service is one entry in [ServiceListResponse].
//
// The InstanceCount, Health, and LastModified fields are structurally present
// per the contract, but are zero-valued in v1. Newtron's HTTP API does not yet
// expose per-service instance aggregates or health rollups. Per CLAUDE.md
// §No Hidden State: the fields are present (contract honored), the values are
// honest (zero, not fabricated). A future slice will add newtron substrate
// support and populate these fields.
//
// TODO(post-ship): populate InstanceCount, Health, and LastModified once newtron
// exposes per-service aggregate endpoints (see newtcon#80 §Risks resolved, post-ship
// contract pass item).
type Service struct {
	// Name is the service spec name as registered in newtron.
	Name string `json:"name"`

	// Type is the service kind (one of the ServiceType* constants).
	// Populated from newtron's ServiceDetail.service_type field.
	Type string `json:"type"`

	// InstanceCount is the number of active bindings of this service across all
	// nodes and interfaces. Zero in v1 — newtron substrate does not yet expose
	// this aggregate.
	InstanceCount int `json:"instance_count"`

	// Health is the rollup of per-instance health across all active bindings.
	// Zero-valued in v1 — newtron substrate does not yet expose health rollups.
	Health ServiceHealth `json:"health"`

	// LastModified is the timestamp of the most recent spec change for this
	// service. Zero in v1 — newtron substrate does not yet expose modification
	// timestamps.
	LastModified time.Time `json:"last_modified"`
}

// ServiceHealth is the health rollup for a service's active instances.
// API_CONTRACT.md §GET /api/services (lines 1369–1373).
type ServiceHealth struct {
	// Healthy is the count of instances whose config_db, bgp, and dataplane
	// checks are all verified.
	Healthy int `json:"healthy"`

	// Degraded is the count of instances with partial health (e.g., config_db
	// present but bgp not_established).
	Degraded int `json:"degraded"`

	// Failed is the count of instances where a required check is in a failed
	// state.
	Failed int `json:"failed"`
}
