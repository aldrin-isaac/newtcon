// Package types defines the API DTOs for newtcon-server's HTTP responses.
//
// This file defines the request and response shapes for POST /api/preview,
// matching API_CONTRACT.md §POST /api/preview (lines 1445–1518), §ChangeSet
// (typed) (lines 1519–1666), §Validate (typed) (lines 1667–1797), and
// §Confidence (typed) (lines 1824–1916).
package types

// PreviewRequest is the body of POST /api/preview.
// API_CONTRACT.md §POST /api/preview lines 1450–1468.
type PreviewRequest struct {
	// Operation is the verb. v1 accepts "apply" only; "refresh" and "remove"
	// are rejected with 400 validation_failure (see handler).
	Operation string `json:"operation"`
	// Service is the service spec name (e.g., "transit").
	Service string `json:"service"`
	// Targets lists the (node, interface) pairs to preview.
	// v1 validates len(Targets) == 1.
	Targets []PreviewTarget `json:"targets"`
}

// PreviewTarget is one (node, interface) pair with optional params.
// API_CONTRACT.md §POST /api/preview request shape lines 1454–1462.
type PreviewTarget struct {
	Node      string         `json:"node"`
	Interface string         `json:"interface"`
	Params    map[string]any `json:"params,omitempty"`
}

// PreviewResponse is the body of a successful POST /api/preview.
// API_CONTRACT.md §POST /api/preview response lines 1473–1499.
type PreviewResponse struct {
	// PreviewID is an opaque UUID, valid for 5 minutes per the contract.
	// API_CONTRACT.md line 1476.
	PreviewID string `json:"preview_id"`
	// PerTarget has one entry per requested target.
	PerTarget []PerTargetPreview `json:"per_target"`
	// Aggregate summarises results across all targets.
	Aggregate PreviewAggregate `json:"aggregate"`
}

// PerTargetPreview is the per-target slice of PreviewResponse.
// API_CONTRACT.md §POST /api/preview per_target shape lines 1477–1491.
type PerTargetPreview struct {
	Node      string     `json:"node"`
	Interface string     `json:"interface"`
	Validate  Validate   `json:"validate"`
	ChangeSet ChangeSetDTO `json:"changeset"`
	// ReferenceImpact is structurally present per contract lines 1483–1487.
	// v1 emits honest empty arrays — reference tracking substrate is post-ship.
	// TODO(post-ship): populate when newtron exposes reference counts.
	ReferenceImpact ReferenceImpact `json:"reference_impact"`
	Confidence      Confidence      `json:"confidence"`
	// Reverses is nil for operation:"apply" per API_CONTRACT.md lines 1502–1507.
	// For operation:"remove" it would name the originating intent(s) — not
	// implemented in v1 (remove verb is rejected at request validation).
	Reverses *struct{} `json:"reverses"`
}

// ChangeSetDTO is the canonical ChangeSet object returned on preview and apply.
// API_CONTRACT.md §ChangeSet (typed) lines 1519–1666.
//
// The operator-facing grouping (writes[], deletes[], intent_records[]) is a
// newtcon-side affordance per DESIGN_PRINCIPLES_NEWTRON §46: newtron exposes
// the bare ConfigChange[] substrate; newtcon-server transforms it into the
// operator's mental buckets without losing fidelity.
type ChangeSetDTO struct {
	// Writes contains CONFIG_DB add/modify entries (newtron type ∈ {"add","modify"}).
	// NEWTRON_INTENT table rows are peeled off into IntentRecords instead.
	Writes []ChangeEntry `json:"writes"`
	// Deletes contains CONFIG_DB delete entries (newtron type == "delete").
	Deletes []ChangeEntry `json:"deletes"`
	// IntentRecords contains NEWTRON_INTENT rows peeled from writes.
	// Per API_CONTRACT.md lines 1614–1627: surfaced as a first-class field
	// so the operator can inspect the decision substrate without scanning for
	// table == "NEWTRON_INTENT".
	IntentRecords []ChangeEntry `json:"intent_records"`
	// RationaleRef anchors to the substrate cause and operator-philosophy principle.
	RationaleRef RationaleRef `json:"rationale_ref"`
}

// ChangeEntry is one CONFIG_DB entry in a ChangeSet (writes, deletes, or intent_records).
// API_CONTRACT.md §ChangeSet (typed) lines 1537–1577.
type ChangeEntry struct {
	Table string `json:"table"`
	Key   string `json:"key"`
	// Fields is map[string]any (not map[string]string) because the contract
	// reserves null for a future field-level reset semantic per lines 1598–1601:
	// "consumers MUST tolerate null to be additive-evolution-compatible."
	// For deletes, Fields is nil (whole-row delete) or an array of field names
	// (field-level delete) per lines 1602–1613.
	Fields any `json:"fields"`
}

// Validate is the inline validation result per target.
// API_CONTRACT.md §Validate (typed) lines 1667–1797.
//
// Splits newtron's two-kinds-of-refusal (DESIGN_PRINCIPLES_NEWTRON §13)
// into preconditions[] (business-logic refusals) and schema_violations[]
// (data-format refusals) so the operator sees both inline at preview time.
type Validate struct {
	// OK is true if and only if both Preconditions and SchemaViolations are empty.
	// Per API_CONTRACT.md line 1732: "Consumers MUST honor ok; they MUST NOT
	// re-derive it by counting array lengths."
	OK bool `json:"ok"`
	// Preconditions surfaces newtron's business-logic refusals per §13's
	// "Preconditions enforce business logic" — the operation's subject is absent.
	Preconditions []ValidationRow `json:"preconditions"`
	// SchemaViolations surfaces newtron's schema validation refusals per §13's
	// "Schema validation enforces data format."
	SchemaViolations []ValidationRow `json:"schema_violations"`
}

// ValidationRow is one entry in Validate.Preconditions or Validate.SchemaViolations.
// Same row shape as API_CONTRACT.md §validation_failure details.rejections[].
type ValidationRow struct {
	Locator      Locator      `json:"locator"`
	Reason       string       `json:"reason"`
	Message      string       `json:"message"`
	Expected     any          `json:"expected"`
	Actual       any          `json:"actual"`
	Allowed      any          `json:"allowed"`
	RationaleRef RationaleRef `json:"rationale_ref"`
}

// Locator identifies the substrate field that caused a validation failure.
// API_CONTRACT.md §validation_failure details.rejections[].locator.
type Locator struct {
	Kind           string                 `json:"kind"`
	SubstrateField *SubstrateFieldLocator `json:"substrate_field,omitempty"`
	RequestField   *RequestFieldLocator   `json:"request_field,omitempty"`
	Parameter      *ParameterLocator      `json:"parameter,omitempty"`
}

// SubstrateFieldLocator identifies a CONFIG_DB table/key/field.
type SubstrateFieldLocator struct {
	Network string  `json:"network"`
	Node    string  `json:"node"`
	Table   string  `json:"table"`
	Key     string  `json:"key"`
	Field   *string `json:"field"`
}

// RequestFieldLocator identifies a field in the request body.
type RequestFieldLocator struct {
	JSONPointer string `json:"json_pointer"`
	Received    any    `json:"received"`
}

// ParameterLocator identifies a query or header parameter.
type ParameterLocator struct {
	Name string `json:"name"`
	In   string `json:"in"`
}

// Confidence is the operator-facing confidence level for a result.
// API_CONTRACT.md §Confidence (typed) lines 1824–1916.
//
// Invariant #9 ("Confidence and limits are explicit"): "False confidence is
// worse than no confidence because it teaches the operator to over-trust."
// Every response that carries Confidence emits level:"high" for clean paths.
type Confidence struct {
	// Level is "high", "conditional", or "low".
	Level string `json:"level"`
	// Reasons is empty when Level == "high"; non-empty otherwise.
	// Per API_CONTRACT.md line 1865: "Empty when level == 'high'; non-empty otherwise."
	Reasons []ConfidenceReason `json:"reasons"`
}

// ConfidenceReason describes one degradation mode.
// API_CONTRACT.md §Confidence (typed) lines 1866–1898.
type ConfidenceReason struct {
	Code         string       `json:"code"`
	Message      string       `json:"message"`
	GapIssue     *string      `json:"gap_issue,omitempty"`
	RationaleRef RationaleRef `json:"rationale_ref"`
}

// ReferenceImpact describes shared-policy reference changes.
// API_CONTRACT.md §POST /api/preview per_target.reference_impact lines 1483–1487.
// v1 emits honest empty arrays.
// TODO(post-ship): populate when newtron exposes reference tracking surface.
type ReferenceImpact struct {
	Created           []string `json:"created"`
	Incremented       []string `json:"incremented"`
	GarbageCollected  []string `json:"garbage_collected"`
}

// PreviewAggregate is the aggregate summary across all per-target results.
// API_CONTRACT.md §POST /api/preview aggregate shape lines 1493–1498.
type PreviewAggregate struct {
	AllValid    bool       `json:"all_valid"`
	NodeCount   int        `json:"node_count"`
	TotalWrites int        `json:"total_writes"`
	TotalDeletes int       `json:"total_deletes"`
	// TODO(post-ship): aggregate.confidence computation is deferred —
	// per-target confidence reasons require reference tracking substrate.
	// v1 emits level:"high" per CLAUDE.md §No Hidden State (honest structural zero).
	Confidence  Confidence `json:"confidence"`
}

// RationaleRef links to the substrate cause and operator-philosophy principle.
// The typed {substrate, principle} shape used throughout the contract.
// API_CONTRACT.md §Companion fields on every error lines 156–166.
type RationaleRef struct {
	Substrate string `json:"substrate"`
	Principle string `json:"principle"`
}
