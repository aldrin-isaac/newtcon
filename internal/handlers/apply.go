// Package handlers contains one file per resource family served by
// newtcon-server.
//
// This file implements POST /api/apply per API_CONTRACT.md §POST /api/apply
// (lines 2064–2223) and §Streaming substrate-operation events, PerWrite shape
// (lines 778–971).
//
// POST /api/apply is the operationalization of:
//   - Operator-philosophy invariant #1 ("No black boxes"): operator sees each
//     substrate write as it lands via per_target[].per_write[].
//   - Invariant #4 ("Show before do"): apply requires a prior preview_id;
//     there is no apply-without-preview path.
//   - Invariant #7 ("Errors carry the substrate"): verify failure surfaces the
//     verbatim device_response from the failed verify_read entry.
//   - Concrete success vision points 1–3: operator sees per-write substrate
//     land in real time, sees exactly which write failed, gets copy-paste CLI.
//
// CRITICAL INVARIANT (the most-likely drift point per newtcon#81 Risks resolved):
//
//	When newtron returns 409 VerificationFailedError (the write LANDED but the
//	post-deliver re-read disagreed), the HTTP response from /api/apply is 200,
//	NOT 4xx. The verify failure is surfaced on the 200 path with
//	verify.state:"failed" and verify.assertion.errors[] per
//	API_CONTRACT.md lines 3519–3539:
//
//	  "Verify failure does not produce a 4xx envelope ... The substrate is
//	   surfaced on the 200 response through verify.state == 'failed' and
//	   verify.assertion.errors[], ... Newtron's 409 VerificationFailedError HTTP
//	   envelope is consumed by newtcon-server's internal/newtronc/ and re-shaped
//	   into the same 200-path representation."
//
// Test TestApply_VerifyFailure_Returns200WithFailedAssertion is the
// conformance gate for this invariant.
//
// v1 scope (binding per newtcon#81):
//   - JSON response only (no SSE)
//   - Single-target only (validated by preview_id consuming single-target stores)
//   - operation:"apply" only (inherited from preview_id validation)
//
// TODO(post-ship): per-stage pipeline timestamps (newtron apply does not expose them)
// TODO(post-ship): intent_id populated from newtron (not in apply response today)
// TODO(post-ship): operations endpoint implementation (operation_url is structural)
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/aldrin-isaac/newtcon/internal/newtronc"
	"github.com/aldrin-isaac/newtcon/internal/server"
	"github.com/aldrin-isaac/newtcon/internal/types"
)

// applyNewtronClient is the minimal interface the apply handler requires.
type applyNewtronClient interface {
	ExecuteApplyService(ctx context.Context, network, node, iface, service string, params map[string]any) (*newtronc.WriteResult, *newtronc.VerifyFailure, error)
}

// ApplyDeps carries the dependencies for RegisterApplyRoutes.
type ApplyDeps struct {
	// Client is the sole newtron-server HTTP client.
	Client applyNewtronClient
	// Store is the shared preview store (also used by preview handler).
	Store *PreviewStore
	// Clock is injectable for tests; production passes time.Now.
	Clock func() time.Time
	// NewtronURL is passed through to newtron_unavailable error details.
	NewtronURL string
}

// RegisterApplyRoutes wires POST /api/apply into mux.
func RegisterApplyRoutes(mux *http.ServeMux, deps ApplyDeps) {
	mux.Handle("POST /api/apply", newApplyHandler(deps))
}

// newApplyHandler returns the http.Handler for POST /api/apply.
func newApplyHandler(deps ApplyDeps) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		correlationID := server.CorrelationIDFromContext(r.Context())

		// Accept:text/event-stream falls through to JSON for v1 (no SSE).

		var req types.ApplyRequest
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

		if req.PreviewID == "" {
			types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
				"preview_id is required",
				map[string]any{
					"correlation_id":   correlationID,
					"validation_stage": "request",
					"rejections": []map[string]any{{
						"locator": map[string]any{
							"kind": "request_field",
							"request_field": map[string]any{
								"json_pointer": "/preview_id",
								"received":     nil,
							},
						},
						"reason":  "missing_required",
						"message": "preview_id is required",
					}},
					"rationale_ref": map[string]any{
						"substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
						"principle": "docs/operator-philosophy.md#4-show-before-do-preview-with-semantics-not-just-diffs",
					},
				},
			)
			return
		}

		// Consume the preview entry (single-use per store semantics).
		// A stale or already-consumed preview_id → 410 per
		// API_CONTRACT.md line 2217.
		entry, ok := deps.Store.Take(req.PreviewID)
		if !ok {
			types.WriteError(w, http.StatusGone, types.KindPreconditionFailure,
				"preview_id has expired or already been consumed; re-preview before applying",
				map[string]any{
					"correlation_id": correlationID,
					"condition":      "preview_id_stale",
					"condition_details": map[string]any{
						"preview_id":   req.PreviewID,
						"preview_kind": "composer_preview",
					},
					"next_action_hint": map[string]any{
						"verb":     "re_preview",
						"endpoint": "/api/preview",
						"rationale": "re-issue the same preview request; the operator's intent did not change, only the TTL expired",
					},
					"rationale_ref": map[string]any{
						"substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
						"principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit",
					},
				},
			)
			return
		}

		target := entry.Request.Targets[0]
		now := deps.Clock()

		// Execute the apply.
		wr, vf, err := deps.Client.ExecuteApplyService(r.Context(), defaultNetwork,
			target.Node, target.Interface, entry.Request.Service, target.Params)

		if err != nil {
			// Log a warning for ValidationError on apply — preview should have
			// caught it. The handler still surfaces it correctly.
			handleApplyError(w, r, deps, target, correlationID, now, err)
			return
		}

		// Mint operation_id.
		operationID := genUUID()

		if vf != nil {
			// CRITICAL: VerificationFailedError → HTTP 200 (NOT 4xx).
			// Per API_CONTRACT.md lines 3519–3539 (quoted in this file's godoc).
			// The write LANDED (applied:true) per newtron#21.
			resp := buildApplyResponseFromVerifyFailure(operationID, target, vf, now)
			respondJSON(w, http.StatusOK, resp)
			return
		}

		// Success path.
		resp := buildApplyResponseFromSuccess(operationID, target, wr, now)
		respondJSON(w, http.StatusOK, resp)
	})
}

// buildApplyResponseFromSuccess constructs the ApplyResponse for a clean apply.
func buildApplyResponseFromSuccess(operationID string, target types.PreviewTarget, wr *newtronc.WriteResult, now time.Time) types.ApplyResponse {
	perWriteDTOs := projectPerWrite(operationID, target, wr.PerWrite, now)

	// Derive verify state.
	verifyAssertion := deriveVerifyAssertion(wr, now)

	// v1 pipeline: all stages complete at apply-return time.
	// TODO(post-ship): populate per-stage timestamps when newtron exposes them.
	pipeline := allCompleteAtPipeline(now)

	// Aggregate counters.
	aggregate := computeAggregate(perWriteDTOs, verifyAssertion)

	return types.ApplyResponse{
		OperationID: operationID,
		PerTarget: []types.PerTargetApply{{
			Node:      target.Node,
			Interface: target.Interface,
			Applied:   wr.Applied,
			// TODO(post-ship): intent_id from newtron (not in apply response today).
			IntentID:     "",
			IntentURL:    "",
			OperationID:  operationID,
			OperationURL: "/api/operations/" + operationID,
			Pipeline:     pipeline,
			Verify:       verifyAssertion,
			PerWrite:     perWriteDTOs,
			Confidence:   types.Confidence{Level: "high", Reasons: []types.ConfidenceReason{}},
		}},
		Aggregate: aggregate,
	}
}

// buildApplyResponseFromVerifyFailure constructs the ApplyResponse when newtron
// returned a VerificationFailedError (409 on the wire, but 200 to the operator).
//
// Per API_CONTRACT.md lines 3519–3539:
//
//	"Verify failure does not produce a 4xx envelope. ... a verify failure means
//	 the write LANDED (applied: true) but the post-deliver re-read disagreed
//	 with the ChangeSet — newtron's pipeline ran to completion and produced
//	 typed substrate; no refusal happened. The substrate is surfaced on the 200
//	 response through verify.state == 'failed' and verify.assertion.errors[]."
//
// device_response is passed byte-for-byte from the newtron VerificationError —
// no paraphrase, no summarization. This operationalizes operator-philosophy
// invariant #7 ("Errors carry the substrate") on the verify-failure path.
func buildApplyResponseFromVerifyFailure(operationID string, target types.PreviewTarget, vf *newtronc.VerifyFailure, now time.Time) types.ApplyResponse {
	wr := vf.WriteResult
	perWriteDTOs := projectPerWrite(operationID, target, wr.PerWrite, now)

	// Build verify assertion from the VerifyFailure substrate.
	var verificationErrors []types.VerificationErrorRow
	if wr.Verification != nil {
		for _, e := range wr.Verification.Errors {
			verificationErrors = append(verificationErrors, types.VerificationErrorRow{
				Table: e.Table,
				Key:   e.Key,
				Field: e.Field,
				// Expected and Actual are passed byte-for-byte from newtron.
				Expected: e.Expected,
				Actual:   e.Actual,
				// DeviceResponse is VERBATIM from newtron's VerificationError —
				// per API_CONTRACT.md lines 3499–3506 and invariant #7.
				// Do NOT paraphrase, do NOT summarize.
				DeviceResponse: e.DeviceResponse,
			})
		}
	}
	if verificationErrors == nil {
		verificationErrors = []types.VerificationErrorRow{}
	}

	passed, failed := 0, 0
	if wr.Verification != nil {
		passed = wr.Verification.Passed
		failed = wr.Verification.Failed
	}

	verify := types.VerifyAssertion{
		Kind:  "device_io_assertion",
		State: "failed",
		Assertion: &types.VerificationAssertionDTO{
			Passed: passed,
			Failed: failed,
			Errors: verificationErrors,
		},
		// verify.confidence is "high" on a completed-but-failed verify per the
		// issue: "verify completed, just failed — low is reserved for
		// skipped/unknown."
		Confidence: types.Confidence{Level: "high", Reasons: []types.ConfidenceReason{}},
	}

	pipeline := allCompleteAtPipeline(now)

	totalVerifyReadsFailed := 0
	totalWritesLanded := 0
	for _, pw := range perWriteDTOs {
		if pw.Kind == "verify_read" && pw.Result == "rejected" {
			totalVerifyReadsFailed++
		}
		if (pw.Kind == "redis_write" || pw.Kind == "redis_delete") && pw.Result == "applied" {
			totalWritesLanded++
		}
	}

	return types.ApplyResponse{
		OperationID: operationID,
		PerTarget: []types.PerTargetApply{{
			Node:      target.Node,
			Interface: target.Interface,
			// applied:true — the write LANDED per API_CONTRACT.md lines 2194–2215.
			Applied:      true,
			IntentID:     "",
			IntentURL:    "",
			OperationID:  operationID,
			OperationURL: "/api/operations/" + operationID,
			Pipeline:     pipeline,
			Verify:       verify,
			PerWrite:     perWriteDTOs,
			Confidence:   types.Confidence{Level: "high", Reasons: []types.ConfidenceReason{}},
		}},
		Aggregate: types.ApplyAggregate{
			AllApplied:             true,
			VerifyPending:          0,
			TotalWritesLanded:      totalWritesLanded,
			TotalWritesRejected:    0,
			TotalDaemonWaits:       countKind(perWriteDTOs, "daemon_wait"),
			TotalVerifyReadsFailed: totalVerifyReadsFailed,
			Confidence:             types.Confidence{Level: "high", Reasons: []types.ConfidenceReason{}},
		},
	}
}

// projectPerWrite translates []newtronc.PerSubstrateOp → []types.PerWrite.
// Each entry is passed through without summarization per invariant #1.
// cli_command is rendered by newtcon-server per API_CONTRACT.md lines 876–894.
func projectPerWrite(operationID string, target types.PreviewTarget, ops []newtronc.PerSubstrateOp, fallbackAt time.Time) []types.PerWrite {
	result := make([]types.PerWrite, 0, len(ops))
	for _, op := range ops {
		at := op.At
		if at.IsZero() {
			at = fallbackAt
		}

		var substrate *types.PerWriteSubstrate
		if op.Table != "" || op.Key != "" {
			fields := make(map[string]any, len(op.Fields))
			for k, v := range op.Fields {
				fields[k] = v
			}
			var fieldsAny map[string]any
			if len(fields) > 0 {
				fieldsAny = fields
			}
			substrate = &types.PerWriteSubstrate{
				Table:  op.Table,
				Key:    op.Key,
				Fields: fieldsAny,
			}
		}

		cliCmd := renderCLICommand(op)

		// rationale_ref per kind per API_CONTRACT.md lines 918–925.
		rationaleRef := perWriteRationaleRef(op.Kind)

		result = append(result, types.PerWrite{
			Seq:         op.Seq,
			OperationID: operationID,
			Target: types.PerWriteTarget{
				Network:   defaultNetwork,
				Node:      target.Node,
				Interface: target.Interface,
			},
			Kind:           op.Kind,
			Substrate:      substrate,
			Result:         op.Result,
			CLICommand:     cliCmd,
			DeviceResponse: op.DeviceResponse,
			At:             at,
			RationaleRef:   rationaleRef,
			Source:         nil, // always nil in v1 per API_CONTRACT.md lines 929–970
		})
	}
	return result
}

// renderCLICommand produces the exact redis-cli command the operator would
// type against the device to reproduce a substrate operation by hand.
// Operationalizes operator-philosophy invariant #2 (manual-mode parity).
// API_CONTRACT.md lines 876–894.
func renderCLICommand(op newtronc.PerSubstrateOp) string {
	switch op.Kind {
	case "redis_write":
		if op.Table == "" || op.Key == "" {
			return ""
		}
		args := fmt.Sprintf("'%s|%s'", op.Table, op.Key)
		for k, v := range op.Fields {
			args += fmt.Sprintf(" %s %s", k, v)
		}
		return fmt.Sprintf("redis-cli -n 4 HSET %s", args)
	case "redis_delete":
		if op.Table == "" || op.Key == "" {
			return ""
		}
		return fmt.Sprintf("redis-cli -n 4 DEL '%s|%s'", op.Table, op.Key)
	case "verify_read":
		if op.Table == "" || op.Key == "" {
			return ""
		}
		return fmt.Sprintf("redis-cli -n 4 HGETALL '%s|%s'", op.Table, op.Key)
	default:
		// daemon_wait: no CLI command (API_CONTRACT.md line 852: OPTIONAL for daemon_wait).
		return ""
	}
}

// perWriteRationaleRef returns the appropriate rationale_ref for a per-write entry.
// API_CONTRACT.md lines 918–925.
func perWriteRationaleRef(kind string) types.RationaleRef {
	switch kind {
	case "verify_read":
		return types.RationaleRef{
			Substrate: "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
			Principle: "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#14-verify-your-writes-observe-everything-else",
		}
	case "daemon_wait":
		return types.RationaleRef{
			Substrate: "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
			Principle: "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#18-write-ordering-and-daemon-settling",
		}
	default:
		// redis_write, redis_delete
		return types.RationaleRef{
			Substrate: "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
			Principle: "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#11-the-changeset-is-the-universal-contract",
		}
	}
}

// deriveVerifyAssertion derives the VerifyAssertion from a successful WriteResult.
// (The 200-path: if wr.Verification has Failed > 0 on the 200 path, that is
// a defensive case that should not occur per newtron#21.)
func deriveVerifyAssertion(wr *newtronc.WriteResult, now time.Time) types.VerifyAssertion {
	if wr.Verification == nil {
		// Verified == true but no Verification struct: verify ran but newtron
		// did not return a result (e.g., no_save). Treat as skipped.
		return types.VerifyAssertion{
			Kind:       "device_io_assertion",
			State:      "skipped",
			Confidence: types.Confidence{Level: "high", Reasons: []types.ConfidenceReason{}},
		}
	}

	// Defensive: Failed > 0 on 200 path should not occur (newtron returns 409).
	state := "complete"
	if wr.Verification.Failed > 0 {
		state = "failed"
	}

	errs := make([]types.VerificationErrorRow, 0, len(wr.Verification.Errors))
	for _, e := range wr.Verification.Errors {
		errs = append(errs, types.VerificationErrorRow{
			Table:          e.Table,
			Key:            e.Key,
			Field:          e.Field,
			Expected:       e.Expected,
			Actual:         e.Actual,
			DeviceResponse: e.DeviceResponse,
		})
	}

	return types.VerifyAssertion{
		Kind:  "device_io_assertion",
		State: state,
		Assertion: &types.VerificationAssertionDTO{
			Passed: wr.Verification.Passed,
			Failed: wr.Verification.Failed,
			Errors: errs,
		},
		Confidence: types.Confidence{Level: "high", Reasons: []types.ConfidenceReason{}},
	}
}

// allCompleteAtPipeline returns a Pipeline with every stage complete at time t.
// v1 limitation: per-stage timestamps not exposed by newtron apply response.
// TODO(post-ship): populate per-stage timestamps when newtron exposes them.
func allCompleteAtPipeline(t time.Time) types.Pipeline {
	s := types.PipelineStage{Stage: "complete", At: t}
	return types.Pipeline{Intent: s, Replay: s, Render: s, Deliver: s}
}

// computeAggregate calculates the aggregate counters from a per-write slice.
func computeAggregate(perWrite []types.PerWrite, verify types.VerifyAssertion) types.ApplyAggregate {
	var totalWritesLanded, totalWritesRejected, totalDaemonWaits, totalVerifyReadsFailed int
	for _, pw := range perWrite {
		switch pw.Kind {
		case "redis_write", "redis_delete":
			if pw.Result == "applied" {
				totalWritesLanded++
			} else if pw.Result == "rejected" {
				totalWritesRejected++
			}
		case "daemon_wait":
			totalDaemonWaits++
		case "verify_read":
			if pw.Result == "rejected" {
				totalVerifyReadsFailed++
			}
		}
	}

	verifyPending := 0
	if verify.State == "in_progress" || verify.State == "pending" {
		verifyPending = 1
	}

	return types.ApplyAggregate{
		AllApplied:             true,
		VerifyPending:          verifyPending,
		TotalWritesLanded:      totalWritesLanded,
		TotalWritesRejected:    totalWritesRejected,
		TotalDaemonWaits:       totalDaemonWaits,
		TotalVerifyReadsFailed: totalVerifyReadsFailed,
		Confidence:             types.Confidence{Level: "high", Reasons: []types.ConfidenceReason{}},
	}
}

// countKind counts per-write entries with a given kind.
func countKind(perWrite []types.PerWrite, kind string) int {
	n := 0
	for _, pw := range perWrite {
		if pw.Kind == kind {
			n++
		}
	}
	return n
}

// handleApplyError translates newtronc errors to API responses for the apply path.
func handleApplyError(w http.ResponseWriter, r *http.Request, deps ApplyDeps, target types.PreviewTarget, correlationID string, now time.Time, err error) {
	switch e := err.(type) {
	case *newtronc.ValidationError:
		// Should be rare on apply (preview should have caught it); log a warning.
		msg := extractNewtronErrorMessage(e.Body)
		types.WriteError(w, http.StatusBadRequest, types.KindValidationFailure,
			fmt.Sprintf("newtron rejected apply: %s", msg),
			map[string]any{
				"correlation_id":   correlationID,
				"validation_stage": "substrate_schema",
				"rejections": []map[string]any{{
					"locator": map[string]any{
						"kind": "substrate_field",
						"substrate_field": map[string]any{
							"network": defaultNetwork,
							"node":    target.Node,
							"table":   "",
							"key":     "",
							"field":   nil,
						},
					},
					"reason":  "unknown_value",
					"message": msg,
				}},
				"rationale_ref": map[string]any{
					"substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#13-prevent-bad-writes-dont-just-detect-them",
					"principle": "docs/operator-philosophy.md#7-errors-carry-the-substrate",
				},
			},
		)

	case *newtronc.ConflictError:
		// drift_refusal on the apply path (same shape as preview).
		// TODO(post-ship): populate full drift entries.
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
				"at":              now.UTC().Format(time.RFC3339),
				"phase":           "newtron_call",
				"partial_results": nil,
			},
		)
	}
}
