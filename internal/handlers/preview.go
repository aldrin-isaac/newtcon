// Package handlers contains one file per resource family served by
// newtcon-server.
//
// This file implements POST /api/preview per API_CONTRACT.md §POST /api/preview
// (lines 1445–1518) and §ChangeSet (typed) (lines 1519–1666).
//
// POST /api/preview is operator-philosophy invariant #4 ("Show before do")
// made wire-binding. The endpoint calls newtron's dry-run-apply path and
// returns the typed ChangeSet the operator inspects before committing.
//
// v1 scope (binding per newtcon#81):
//   - operation:"apply" only; "refresh"/"remove" → 400 validation_failure
//   - len(targets) == 1 only; multi-target → 400 validation_failure
//   - JSON response only; Accept:text/event-stream falls through to JSON
//     (no SSE in v1 per operator intervention)
//
// TODO(post-ship): aggregate.confidence reasons (post-ship reference tracking)
// TODO(post-ship): per-target reference_impact (newtron reference API not yet landed)
// TODO(post-ship): reverses for remove verb (not in v1 scope)
// TODO(post-ship): drift_refusal per_target[] full drift entries (Inbox surface work)
package handlers

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

const (
	// defaultNetwork is the v1 hardcoded network name.
	// Future multi-network support would read this from a request parameter.
	defaultNetwork = "default"
)

// previewNewtronClient is the minimal interface the preview handler requires.
// Enables test injection without httptest.Server when a stub is cheaper.
type previewNewtronClient interface {
	DryRunApplyService(ctx context.Context, network, node, iface, service string, params map[string]any) (*newtronc.WriteResult, error)
}

// PreviewDeps carries the dependencies for RegisterPreviewRoutes.
type PreviewDeps struct {
	// Client is the sole newtron-server HTTP client.
	Client previewNewtronClient
	// Store is the shared preview store (also consumed by apply handler).
	Store *PreviewStore
	// Clock is injectable for tests; production passes time.Now.
	Clock func() time.Time
	// NewtronURL is passed through to newtron_unavailable error details.
	NewtronURL string
	// CorrelationID extracts the operator-facing correlation UUID from the
	// request context. Every error envelope must carry this value per
	// API_CONTRACT.md §Error Schema lines 152–155.
	//
	// Set to server.CorrelationIDFromContext in main.go at boot time. Defined
	// as a function field (not a direct import of the server package) to break
	// the server → handlers → server import cycle: if handlers imported server
	// for CorrelationIDFromContext and server imported handlers for route
	// registration, the cycle would be complete. The function-value approach
	// breaks it.
	//
	// If nil, the empty string is used — acceptable for tests that do not
	// exercise the error-envelope correlation_id field.
	CorrelationID func(ctx context.Context) string
}

// RegisterPreviewRoutes wires POST /api/preview into mux.
func RegisterPreviewRoutes(mux *http.ServeMux, deps PreviewDeps) {
	// Normalise: if caller omits CorrelationID (e.g. a test that only exercises
	// the happy path), fall back to a no-op so handler bodies never nil-deref.
	if deps.CorrelationID == nil {
		deps.CorrelationID = func(context.Context) string { return "" }
	}
	mux.Handle("POST /api/preview", newPreviewHandler(deps))
}

// newPreviewHandler returns the http.Handler for POST /api/preview.
func newPreviewHandler(deps PreviewDeps) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		correlationID := deps.CorrelationID(r.Context())

		// Accept:text/event-stream falls through to JSON for v1.
		// Per newtcon#81 v1 scope: "No SSE. Accept: text/event-stream falls
		// through to JSON for v1 (document in handler godoc)."
		// We do NOT return 406 for text/event-stream in v1 — it degrades to JSON.

		var req types.PreviewRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"request body could not be parsed as JSON",
				map[string]any{
					"correlation_id":   correlationID,
					"validation_stage": "request",
					"rejections": []map[string]any{{
						"locator": map[string]any{
							"kind":          "request_field",
							"request_field": map[string]any{"json_pointer": "/", "received": nil},
						},
						"reason":  "type_mismatch",
						"message": fmt.Sprintf("invalid JSON: %v", err),
					}},
					"rationale_ref": map[string]any{
						"substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#13-prevent-bad-writes-dont-just-detect-them",
						"principle": "docs/operator-philosophy.md#7-errors-carry-the-substrate",
					},
				},
			)
			return
		}

		// Validate: operation must be "apply" (v1 only).
		if req.Operation != "apply" {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				fmt.Sprintf("operation %q is not supported in v1; only \"apply\" is accepted", req.Operation),
				map[string]any{
					"correlation_id":   correlationID,
					"validation_stage": "request",
					"rejections": []map[string]any{{
						"locator": map[string]any{
							"kind": "request_field",
							"request_field": map[string]any{
								"json_pointer": "/operation",
								"received":     req.Operation,
							},
						},
						"reason":  "unknown_value",
						"message": fmt.Sprintf("operation %q is not valid; v1 accepts only \"apply\"", req.Operation),
						"allowed": []string{"apply"},
					}},
					"rationale_ref": map[string]any{
						"substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#16-verb-vocabulary--the-name-is-the-lifecycle-contract",
						"principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit",
					},
				},
			)
			return
		}

		// Validate: service must be non-empty.
		if strings.TrimSpace(req.Service) == "" {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"service is required",
				map[string]any{
					"correlation_id":   correlationID,
					"validation_stage": "request",
					"rejections": []map[string]any{{
						"locator": map[string]any{
							"kind": "request_field",
							"request_field": map[string]any{
								"json_pointer": "/service",
								"received":     nil,
							},
						},
						"reason":  "missing_required",
						"message": "service is required",
					}},
					"rationale_ref": map[string]any{
						"substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#13-prevent-bad-writes-dont-just-detect-them",
						"principle": "docs/operator-philosophy.md#7-errors-carry-the-substrate",
					},
				},
			)
			return
		}

		// Validate: v1 single-target only.
		if len(req.Targets) != 1 {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				fmt.Sprintf("v1 accepts exactly 1 target; got %d", len(req.Targets)),
				map[string]any{
					"correlation_id":   correlationID,
					"validation_stage": "request",
					"rejections": []map[string]any{{
						"locator": map[string]any{
							"kind": "request_field",
							"request_field": map[string]any{
								"json_pointer": "/targets",
								"received":     len(req.Targets),
							},
						},
						"reason":   "out_of_range",
						"message":  fmt.Sprintf("v1 accepts exactly 1 target; got %d", len(req.Targets)),
						"expected": map[string]any{"min": 1, "max": 1},
						"actual":   len(req.Targets),
					}},
					"rationale_ref": map[string]any{
						"substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#13-prevent-bad-writes-dont-just-detect-them",
						"principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit",
					},
				},
			)
			return
		}

		target := req.Targets[0]

		// Validate: node and interface must be non-empty.
		if strings.TrimSpace(target.Node) == "" {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"targets[0].node is required",
				map[string]any{
					"correlation_id":   correlationID,
					"validation_stage": "request",
					"rejections": []map[string]any{{
						"locator": map[string]any{
							"kind": "request_field",
							"request_field": map[string]any{
								"json_pointer": "/targets/0/node",
								"received":     nil,
							},
						},
						"reason":  "missing_required",
						"message": "targets[0].node is required",
					}},
					"rationale_ref": map[string]any{
						"substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#13-prevent-bad-writes-dont-just-detect-them",
						"principle": "docs/operator-philosophy.md#7-errors-carry-the-substrate",
					},
				},
			)
			return
		}
		if strings.TrimSpace(target.Interface) == "" {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"targets[0].interface is required",
				map[string]any{
					"correlation_id":   correlationID,
					"validation_stage": "request",
					"rejections": []map[string]any{{
						"locator": map[string]any{
							"kind": "request_field",
							"request_field": map[string]any{
								"json_pointer": "/targets/0/interface",
								"received":     nil,
							},
						},
						"reason":  "missing_required",
						"message": "targets[0].interface is required",
					}},
					"rationale_ref": map[string]any{
						"substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#13-prevent-bad-writes-dont-just-detect-them",
						"principle": "docs/operator-philosophy.md#7-errors-carry-the-substrate",
					},
				},
			)
			return
		}

		// Call newtron dry-run.
		wr, err := deps.Client.DryRunApplyService(r.Context(), defaultNetwork,
			target.Node, target.Interface, req.Service, target.Params)

		if err != nil {
			handlePreviewError(w, r, deps, target, correlationID, err)
			return
		}

		// Project Changes → ChangeSetDTO.
		cs := newtronc.ProjectChangeSet(wr, defaultNetwork)

		// Validate result: newtron returned 200 on dry-run = validation passed.
		validate := types.Validate{
			OK:               true,
			Preconditions:    []types.ValidationRow{},
			SchemaViolations: []types.ValidationRow{},
		}

		// Mint preview_id and store entry.
		now := deps.Clock()
		previewID := genUUID()
		deps.Store.Put(previewID, &PreviewEntry{
			Request:     req,
			WriteResult: wr,
			ExpiresAt:   now.Add(deps.Store.ttl),
			IssuedAt:    now,
		})

		// Build response.
		perTarget := types.PerTargetPreview{
			Node:      target.Node,
			Interface: target.Interface,
			Validate:  validate,
			ChangeSet: cs,
			// TODO(post-ship): reference_impact requires newtron reference tracking API.
			// v1 emits honest empty arrays per CLAUDE.md §No Hidden State.
			ReferenceImpact: types.ReferenceImpact{
				Created:          []string{},
				Incremented:      []string{},
				GarbageCollected: []string{},
			},
			Confidence: types.Confidence{Level: "high", Reasons: []types.ConfidenceReason{}},
			Reverses:   nil,
		}

		totalWrites := len(cs.Writes)
		totalDeletes := len(cs.Deletes)

		resp := types.PreviewResponse{
			PreviewID: previewID,
			PerTarget: []types.PerTargetPreview{perTarget},
			Aggregate: types.PreviewAggregate{
				AllValid:     true,
				NodeCount:    1,
				TotalWrites:  totalWrites,
				TotalDeletes: totalDeletes,
				// TODO(post-ship): aggregate.confidence reasons when reference
				// tracking substrate is available.
				Confidence: types.Confidence{Level: "high", Reasons: []types.ConfidenceReason{}},
			},
		}
		respondJSON(w, http.StatusOK, resp)
	})
}

// handlePreviewError translates newtronc errors to the appropriate API response.
func handlePreviewError(w http.ResponseWriter, r *http.Request, deps PreviewDeps, target types.PreviewTarget, correlationID string, err error) {
	switch e := err.(type) {
	case *newtronc.ValidationError:
		// Newtron 400: surface as 200 with validate.ok=false per
		// API_CONTRACT.md lines 1509–1511: "Validation failures in any
		// target produce a 200 with validate.ok = false."
		msg := extractNewtronErrorMessage(e.Body)
		req := types.PreviewRequest{} // rebuild a minimal request for the helper
		resp := buildPreviewValidationResponse(req, target, msg, correlationID)
		respondJSON(w, http.StatusOK, resp)

	case *newtronc.ConflictError:
		// Newtron 409 drift_refusal → API 409 drift_refusal.
		// v1: per_target[] is populated minimally (empty drift_entries[]).
		// TODO(post-ship): populate full drift entries when Inbox surface
		// provides the drift-detection substrate.
		types.WriteError(w, http.StatusConflict, types.KindDriftRefusal,
			"drift detected; reconcile before proceeding",
			map[string]any{
				"correlation_id": correlationID,
				"guard_mode":     "actuated",
				"per_target": []map[string]any{{
					"network":           defaultNetwork,
					"node":              target.Node,
					"drift_entries":     []any{},
					"drift_entry_count": 0,
					"by_type":           map[string]int{"missing": 0, "extra": 0, "modified": 0},
					"projection_url":    fmt.Sprintf("/api/projection/nodes/%s", target.Node),
				}},
				"aggregate": map[string]any{
					"node_count":          1,
					"total_drift_entries": 0,
				},
				"rationale_ref": map[string]any{
					"substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#drift-guard-actuated-mode",
					"principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object",
				},
			},
		)

	case *newtronc.UnavailableError:
		types.WriteError(w, http.StatusServiceUnavailable, types.KindNewtronUnavailable,
			fmt.Sprintf("newtron-server unreachable: %s", e.Cause),
			map[string]any{
				"correlation_id":           correlationID,
				"newtron_url":              deps.NewtronURL,
				"underlying_error":         classifyUnavailableError(e),
				"underlying_error_message": e.Cause,
				"affected_nodes":           []string{target.Node},
				"last_known":               map[string]any{"kind": "none", "payload": nil},
				"rationale_ref": map[string]any{
					"substrate": "CLAUDE.md#newtron-api-consumption-rule",
					"principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit",
				},
			},
		)

	default:
		types.WriteError(w, http.StatusInternalServerError, types.KindInternal,
			"newtcon-server failed mid-request; quote correlation_id when reporting",
			map[string]any{
				"correlation_id":  correlationID,
				"at":              deps.Clock().UTC().Format(time.RFC3339),
				"phase":           "newtron_call",
				"partial_results": nil,
			},
		)
	}
}

// buildPreviewValidationResponse constructs a 200 PreviewResponse where
// validate.ok=false for a newtron 400 rejection.
//
// Per API_CONTRACT.md lines 1509–1511: "Validation failures in any target
// produce a 200 with validate.ok = false for the failing target(s) and
// aggregate.all_valid = false. The preview is still returned for the targets
// that did validate." (Single-target v1: whole preview is the failing target.)
//
// For v1: all newtron 400s land in schema_violations[]. Precondition
// discrimination is a post-ship refinement per the issue's Risks resolved table.
// TODO(post-ship): discriminate newtron 400s into preconditions[] vs
// schema_violations[] when newtron exposes structured error types.
func buildPreviewValidationResponse(req types.PreviewRequest, target types.PreviewTarget, msg, correlationID string) types.PreviewResponse {
	return types.PreviewResponse{
		PreviewID: "", // no preview_id when validation failed
		PerTarget: []types.PerTargetPreview{{
			Node:      target.Node,
			Interface: target.Interface,
			Validate: types.Validate{
				OK:            false,
				Preconditions: []types.ValidationRow{},
				SchemaViolations: []types.ValidationRow{{
					Locator: types.Locator{
						Kind: "substrate_field",
						SubstrateField: &types.SubstrateFieldLocator{
							Network: defaultNetwork,
							Node:    target.Node,
							Table:   "",
							Key:     "",
							Field:   nil,
						},
					},
					Reason:  "unknown_value",
					Message: msg,
					RationaleRef: types.RationaleRef{
						Substrate: "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#13-prevent-bad-writes-dont-just-detect-them",
						Principle: "docs/operator-philosophy.md#7-errors-carry-the-substrate",
					},
				}},
			},
			ChangeSet: types.ChangeSetDTO{
				Writes:        []types.ChangeEntry{},
				Deletes:       []types.ChangeEntry{},
				IntentRecords: []types.ChangeEntry{},
				RationaleRef: types.RationaleRef{
					Substrate: "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#11-the-changeset-is-the-universal-contract",
					Principle: "docs/operator-philosophy.md#1-no-black-boxes",
				},
			},
			ReferenceImpact: types.ReferenceImpact{
				Created:          []string{},
				Incremented:      []string{},
				GarbageCollected: []string{},
			},
			Confidence: types.Confidence{Level: "high", Reasons: []types.ConfidenceReason{}},
			Reverses:   nil,
		}},
		Aggregate: types.PreviewAggregate{
			AllValid:     false,
			NodeCount:    1,
			TotalWrites:  0,
			TotalDeletes: 0,
			Confidence:   types.Confidence{Level: "high", Reasons: []types.ConfidenceReason{}},
		},
	}
}

// extractNewtronErrorMessage decodes the error string from a newtron APIResponse body.
// Falls back to string representation if parsing fails.
func extractNewtronErrorMessage(body []byte) string {
	var envelope struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err == nil && envelope.Error != "" {
		return envelope.Error
	}
	return string(body)
}

// classifyUnavailableError maps a *newtronc.UnavailableError to the bounded
// underlying_error enum from API_CONTRACT.md §newtron_unavailable.
func classifyUnavailableError(e *newtronc.UnavailableError) string {
	if e.StatusCode >= 500 {
		return "http_5xx"
	}
	cause := strings.ToLower(e.Cause)
	switch {
	case strings.Contains(cause, "connection refused"):
		return "connection_refused"
	case strings.Contains(cause, "no such host"), strings.Contains(cause, "dns"):
		return "dns_failure"
	case strings.Contains(cause, "timeout") || strings.Contains(cause, "deadline"):
		return "timeout"
	case strings.Contains(cause, "tls"):
		return "tls_handshake_failure"
	default:
		return "connection_refused"
	}
}

// respondJSON writes a JSON response with the given status code.
func respondJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// genUUID returns a random UUIDv4 string.
// Uses crypto/rand; produces the standard xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx format.
func genUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("newtcon: crypto/rand unavailable: %v", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
