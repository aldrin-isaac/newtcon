# newtcon HTTP API Contract

This file defines the binding HTTP API contract between the newtcon server and
its frontend (or any other consumer). Endpoints not defined here do not exist.
Endpoints defined here have the response shapes documented here.

**Stability rule:** changes to this file are a **Contract PR** authored by the
Architect (see [`AGENTS.md`](AGENTS.md) §PR Classes). Implementer PRs that
silently change response shapes are rejected by the Critic.

**Snapshot rule:** CI captures a snapshot of every endpoint's response schema.
Schema-affecting changes require an intentional snapshot update committed in
the same PR as the contract edit.

## Upstream Dependency: newtron HTTP API

newtcon-server is itself an HTTP client of `newtron-server`. The endpoints
below are newtcon's **outward** API (consumed by the frontend); each is
implemented by translating to one or more newtron-server calls inside
`internal/newtronc/`.

newtcon does not own newtron's HTTP API contract — that lives in newtron's
repo. newtcon consumes it. Gaps in newtron's HTTP surface are filed against
newtron, never worked around (see [`CLAUDE.md`](CLAUDE.md) §Gap-Handling
Protocol).

This file documents only the **newtcon-server ↔ frontend** contract.

## Versioning

The API is unversioned until v1. Path prefix is `/api/` (e.g., `/api/services`).
No URL-embedded version (`/v1/`) until the first stable release. Greenfield
applies (see [`CLAUDE.md`](CLAUDE.md) §Greenfield).

## Conventions

- All requests and responses on surviving newtcon-server endpoints are
  JSON (`Content-Type: application/json`). Post-ADR-0001 rebalance,
  no surviving newtcon-server endpoint streams Server-Sent Events
  — SSE substrate for state-changing operator workflows lives on
  newtrun-server's `GET /api/runs/{suite}/events` per newtron#22, not
  on newtcon-server. See §Streaming substrate-operation events (the
  rebalance stub) for the historical surface and the upstream pointer.
- Timestamps are RFC 3339 UTC strings.
- Resource identifiers are domain names (e.g., service name, node name,
  interface name) — never opaque internal IDs.
- Errors return a structured `Error` object (see §Error Schema) with a
  domain-meaningful message. HTTP status codes follow the standard semantics
  but are secondary to the error body.
- Pagination, when needed, is cursor-based (`?cursor=<opaque>&limit=<int>`).
  Endpoints below that omit pagination return the full set.

## Error Schema

Every non-2xx response body:

```json
{
  "error": {
    "kind": "validation_failure | drift_refusal | precondition_failure | newtron_unavailable | internal",
    "message": "human-readable, domain-grounded",
    "details": { /* per-kind typed shape; see below */ }
  }
}
```

`kind` values are bounded; new kinds are a Contract PR.

`message` is the domain-level summary the operator sees first. `details`
is the substrate the operator inspects next (operator-philosophy
invariant #7 "Errors carry the substrate" — a substrate-grounded
explanation MUST be reachable, not summarized away). Each `kind` defines
a typed `details` shape; the shape is binding on consumers and on every
endpoint that returns the kind. Anywhere this contract returns
`kind: "X"`, the `details` body matches the §`X` schema below.

The same shape is used by **nested per-target failures**, not only the
top-level `error` envelope. Endpoints across the rebalance boundary
that report per-target failures inside a 200 response — surviving
newtcon-server endpoints (e.g., a multi-Node Observation History
fan-out where one Node reads succeed and another's 503) AND the
moved orchestration surfaces specified by newtrun-server's contract
per ADR-0001 (Composer apply per-target failure, Workbench commit
per-node failure, etc.) — MUST use the same five `kind` values and
the matching `details` schemas defined here. A handler that invents
a new `kind` (e.g., `newtron_internal`) for a per-target failure is
a contract violation; the per-target failure has the same shape as
the top-level `error` body. The substrate vocabulary is shared
across the rebalance boundary.

### Vocabulary boundaries between kinds

Two pairs of kinds have overlapping conceptual territory; the contract
draws the line as follows so handlers and consumers do not have to
guess:

- **`validation_failure.reason: "target_absent"`** vs
  **`precondition_failure.condition: "node_unknown" | "service_unknown"`**.
  `target_absent` is per-field within a multi-target request whose
  body otherwise parsed (the operator named a VLAN that does not
  exist on switch1 inside one entry of a 4-entry `targets[]`);
  `node_unknown` / `service_unknown` are whole-request preconditions
  on a path parameter (the operator hit `/api/services/legacy/instances`
  for a service that does not exist in the spec). Rule:
  request-cannot-be-attempted-at-all → `precondition_failure`;
  request-attempted-and-one-field-refused → `validation_failure`.
- **`validation_failure` (substrate stages)** vs
  **`drift_refusal`**. Substrate-stage validations
  (`validation_stage: "substrate_precondition" | "substrate_schema"`)
  are refusals grounded in a specific named input being wrong (a VLAN
  ID out of range, a VRF that does not exist on the device). A
  `drift_refusal` is refusal grounded in device CONFIG_DB diverging
  from the projection — no input is "wrong"; the substrate has moved
  since the operator's last visit. Rule: input-is-wrong →
  `validation_failure`; input-was-right-when-you-typed-it-but-the-device-changed
  → `drift_refusal`.

A third boundary, between the §Error Schema vocabulary as a whole
and post-deliver verify failures, is worth naming explicitly even
though it does not name a `kind` value:

- **`verify` failure is NOT one of the five `kind` values.** The
  five kinds describe **refusals** — the write was refused before
  landing, or the request could not be attempted, or the upstream
  was unreachable. A post-deliver verify failure is structurally
  different: the write **landed** on the device (`applied: true`),
  but newtron's `cs.Verify(n)` re-read showed the substrate did
  not match the ChangeSet. Newtron classifies this as a
  `VerificationFailedError` (Go) and emits 409 with the standard
  envelope **plus** the typed `data: *WriteResult` field carrying
  the full `VerificationResult` (with `errors[].device_response`
  verbatim) per the
  [newtron#21](https://github.com/aldrin-isaac/newtron/issues/21)
  envelope fix. Newtcon-server consumes the typed `data` field
  directly and surfaces the substrate through the 200-path
  `verify.assertion.errors[]` shape on the Operations endpoint
  (and via the dedicated
  [`GET /api/operations/{operation_id}/verify`](#get-apioperationsoperation_idverify)),
  with `terminal.outcome == "failure"` per the terminal-state
  derivation rule. Per `DESIGN_PRINCIPLES_NEWTRON.md` §14 ("Verify
  Your Writes; Observe Everything Else"), verify is a Device I/O
  assertion against the device — not a pipeline refusal — and the
  contract honors that classification by surfacing the substrate
  on the 200 path rather than coining a sixth `kind` value. The
  vocabulary boundary is therefore: **refusal-before-landing →
  one of the five kinds**; **landed-but-verify-disagreed →
  `verify.state == "failed"` with substrate-faithful
  `verify.assertion.errors[]` per §14 + §46**. A handler that
  emits `kind: "internal"` for a post-deliver verify failure is a
  contract violation — the failure is classified, not residual.

### Companion fields on every error

Two fields appear on every `details` payload, regardless of `kind`:

- **`correlation_id`** — REQUIRED. Server-assigned UUID per request,
  echoed in newtcon-server logs. The operator quotes this when filing
  ops tickets; the engineer greps logs for it. Present even when other
  fields are sparse (`internal`, in particular, may have little else).
- **`rationale_ref`** — OPTIONAL on `internal` (often unknown);
  REQUIRED on `validation_failure`, `drift_refusal`,
  `precondition_failure`, and `newtron_unavailable`. Same typed shape
  used elsewhere in the contract: object with required `substrate`
  (path-and-anchor into substrate docs) and required `principle`
  (path-and-anchor into `docs/operator-philosophy.md`, `CLAUDE.md`, or
  `DESIGN_PRINCIPLES_NEWTRON.md`). A string-only `rationale_ref` is
  rejected at contract level (matching the convention used by
  `available_actions[*].rationale_ref`,
  `recommended_mode_rationale`, etc., elsewhere in this file).

### `details` for `kind: "validation_failure"`

A `validation_failure` is a refusal that newtcon-server can attribute to
**a specific input that was wrong**. There are three sub-stages a
validation can fail at, and the contract surfaces which one:

- **request** — newtcon-server itself rejected the request before any
  newtron call (malformed body, unknown enum value, missing required
  field, query param out of range, unknown verb, target not in the spec).
- **substrate_precondition** — newtron's `PreconditionError` per
  `DESIGN_PRINCIPLES_NEWTRON` §13 "Two kinds of refusal": the operation's
  subject is absent (VLAN missing, interface missing, VRF never created).
  Distinct from `precondition_failure` (this file's `kind`), which is
  reserved for newtcon-server-side preconditions like
  `preview_id` staleness. Substrate preconditions come from the device.
- **substrate_schema** — newtron's schema validation per
  `DESIGN_PRINCIPLES_NEWTRON` §13 "Schema validation enforces data
  format": the ChangeSet contained an out-of-range value, unknown enum,
  bad pattern, missing required field, or wrote to an unknown table.
  This is the fail-closed schema check that prevents the bad write from
  reaching Redis.

Shape:

```json
{
  "error": {
    "kind": "validation_failure",
    "message": "BGP neighbor 10.1.0.1 rejected: peer_as out of range",
    "details": {
      "correlation_id": "550e8400-e29b-41d4-a716-446655440000",
      "validation_stage": "request | substrate_precondition | substrate_schema",
      "rejections": [
        {
          "locator": {
            "kind": "request_field | substrate_field | parameter",
            "request_field": {
              "json_pointer": "/targets/0/params/peer_as",
              "received": 4294967296
            },
            "substrate_field": {
              "network": "default",
              "node": "switch1",
              "table": "BGP_NEIGHBOR",
              "key": "default|10.1.0.1",
              "field": "asn"
            },
            "parameter": {
              "name": "limit",
              "in": "query"
            }
          },
          "reason": "missing_required | unknown_value | out_of_range | type_mismatch | pattern_mismatch | unknown_table | unknown_field | target_absent | target_in_use | duplicate",
          "message": "peer_as 4294967296 exceeds 32-bit ASN range",
          "expected": { "type": "uint32", "max": 4294967295 },
          "actual": 4294967296,
          "allowed": null
        }
      ],
      "rationale_ref": {
        "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#13-prevent-bad-writes-dont-just-detect-them",
        "principle": "docs/operator-philosophy.md#7-errors-carry-the-substrate"
      }
    }
  }
}
```

Field rules:

- **`validation_stage`** is the discriminator. Exactly one of the three
  `locator.*` sub-objects MUST be populated per rejection, and it MUST
  match the stage: `request` → `request_field` or `parameter`;
  `substrate_precondition` and `substrate_schema` → `substrate_field`.
  An empty `rejections[]` is forbidden — a `validation_failure` without
  a named rejection is opaque to the operator and violates invariant #7.
- **`rejections[]`** is at least one entry. Multiple rejections are
  reported together so the operator fixes a batch in one round-trip
  rather than discovering errors one at a time. Per
  `DESIGN_PRINCIPLES_NEWTRON` §13: "the only reliable solution is to
  prevent the write from reaching the device at all" — the contract
  surfaces every reason the write was refused at once.
- **`reason`** is bounded. `target_absent` corresponds to §13's
  "PreconditionError — the operation's subject is absent";
  `target_in_use` corresponds to §13's "domain error — the resource
  exists but can't be safely modified" (still surfaced as
  `validation_failure` to the operator because it is a refusal grounded
  in a specific input, not a system condition). There is no
  `newtron_owned_table_forbidden` reason in this enum: newtcon does
  not expose a direct CONFIG_DB write endpoint, so there is no place
  in the contract that refuses such a write. The operator who wants
  to write a CONFIG_DB key directly does so via ssh + redis-cli
  against the device themselves; the
  [§Endpoints — Manual-Mode Parity (teaching surface)](#endpoints--manual-mode-parity-teaching-surface)
  surface teaches the command and surfaces the load-bearing caution
  about newtron-owned substrate (drift on the next reconcile),
  honoring operator-philosophy invariants #7 ("errors carry the
  substrate") and #9 ("confidence and limits are explicit") at the
  teach surface rather than at a refusal envelope.
- **`expected` / `actual` / `allowed`** populated per `reason`:
  `out_of_range` → `expected` carries the range, `actual` carries the
  received value; `unknown_value` → `allowed` carries the bounded enum;
  `missing_required` → all three may be `null` (the rejection is that
  no value was received). The frontend renders the populated subset.
- **`message`** in each rejection is short, specific, and substrate-
  grounded (e.g., "peer_as 4294967296 exceeds 32-bit ASN range", not
  "Invalid value for peer_as"). A generic message is a contract smell.

Surviving newtcon-server endpoints that return
`kind: "validation_failure"` per this contract —
`/api/projection/nodes/{node}` unowned `table` filter,
`/api/rehearsal/walkthroughs` unknown `category`,
`/api/manual/services/{service}/instances/.../teach` unknown
service, `/api/manual/configdb/.../teach` unknown table,
`/api/manual/scenarios` unknown `category`,
`/api/report-bug/preview` unknown template, the Observation
History query endpoints with malformed window parameters — populate
this schema. The moved orchestration surfaces' validation_failure
returns (Composer / Inbox / Workbench preview-and-validate) are
specified by newtrun-server's contract per ADR-0001 §What moves
upstream, but they MUST use the same five `kind` values and matching
`details` schemas defined here — the substrate vocabulary is
shared across the rebalance boundary. Free-form `details.*` field
names referenced in surviving sections (`details.owned_tables` on
projection filter, etc.) are surfaced inside `rejections[*]` per
the schema (`reason: "unknown_value"` with `allowed`,
`reason: "target_absent"` with `substrate_field`, etc.); the
free-form names describe the operator-visible information, the wire
shape is the typed `rejections[]`.

### `details` for `kind: "drift_refusal"`

A `drift_refusal` is newtron refusing to compute or apply a ChangeSet
because the device CONFIG_DB has diverged from the projection derived
from its actuated intents (`unified-pipeline-architecture.md` §8 "Drift
Guard"; `DESIGN_PRINCIPLES_NEWTRON` §1, §21). Writing on top of a
drifted foundation is structurally unsafe: preconditions and config
generators reason against the projection, but the device no longer
matches the projection.

Drift refusal carries the full structured drift report so the operator
sees exactly what diverged and can navigate to the existing Inbox drift
card to resolve it. The `DriftEntry` schema is the same one used by the
`kind: "drift"` inbox card's `detail.drift_entries[]` (§Endpoints —
Operator Inbox); it is not re-coined here.

Shape:

```json
{
  "error": {
    "kind": "drift_refusal",
    "message": "drift detected on switch1 (14 entries); reconcile before proceeding",
    "details": {
      "correlation_id": "550e8400-e29b-41d4-a716-446655440000",
      "guard_mode": "actuated",
      "per_target": [
        {
          "network": "default",
          "node": "switch1",
          "intent_count": 47,
          "projection_rebuilt_at": "2026-05-25T14:13:30Z",
          "drift_entries": [
            {
              "table": "VLAN",
              "key": "Vlan100",
              "type": "missing | extra | modified",
              "expected": { "vlanid": "100" },
              "actual": { "vlanid": "100", "mtu": "1500" }
            }
          ],
          "drift_entry_count": 14,
          "by_type": { "missing": 9, "extra": 2, "modified": 3 },
          "browser_card_kind": "drift",
          "browser_card_correlation": { "network": "default", "node": "switch1" },
          "projection_url": "/api/projection/nodes/switch1"
        }
      ],
      "aggregate": {
        "node_count": 1,
        "total_drift_entries": 14
      },
      "resolution_hint": {
        "verb": "reconcile_delta | reconcile_full",
        "rationale": "delta is sufficient when drift_entry_count is small and a config reload is not desired; full is required when drift includes daemon-restart-class changes",
        "stage_via_browser_workflow": "operator-inbox-drift-card",
        "rationale_ref": {
          "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#6-delta-reconcile",
          "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#21-reconstruct-dont-record"
        }
      },
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#drift-guard-actuated-mode",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object"
      }
    }
  }
}
```

Field rules:

- **`per_target[]`** has one entry per Node that drifted. Single-Node
  operations have one entry; multi-Node operator workflows (Composer
  apply across N targets, Workbench commit across N nodes — both
  delivered by the browser frontend over newtrun-server per
  ADR-0001) may produce many. A drift refusal with empty
  `per_target[]` is a contract violation — the operator must know
  WHICH Node refused.
- **`drift_entries[]`** uses the canonical `DriftEntry` substrate
  shape (newtron's `sonic.DriftEntry`, per
  `DESIGN_PRINCIPLES_NEWTRON.md` §46's "one typed diff vocabulary").
  Same fields (`table`, `key`, `type`, `expected`, `actual`); same
  semantics. The shape is also used by the browser frontend's
  Operator Inbox drift cards (delivered by the browser frontend
  composing newtcon-server's Observation History with newtrun-server
  per the §Operator Inbox stub) and by §Observation History's diff
  entries — one substrate vocabulary across the rebalance boundary.
- **`drift_entry_count`** and **`by_type`** are summary counts that
  duplicate information derivable from `drift_entries[]`; they are
  REQUIRED because UI rendering must surface counts without parsing
  the full entries array (the entries array can be large, and the
  operator's first view is the count).
- **`browser_card_kind`** and **`browser_card_correlation`** identify
  the operator-facing browser-frontend card the refusal correlates
  with. The browser frontend's Operator Inbox renders a `drift` card
  (per the §Operator Inbox stub above) keyed on
  `(browser_card_correlation.network, browser_card_correlation.node)`
  — the operator navigates from the refusal to the card and chooses
  a reconciliation verb there (operator-philosophy invariant #5
  "why-mode is always available" — every refusal is one click from
  the operator's action surface). The fields are descriptive
  (kind + correlation tuple) rather than constructing a URL, because
  the browser frontend's URL space is the frontend's concern, not the
  contract's, post-rebalance. When the Observation History layer has
  not yet detected the drift through observed-state diff (e.g., the
  drift was first surfaced at this refusal time), the
  `browser_card_correlation` is still emitted so the frontend can
  surface the card on the operator's next view.
- **`projection_url`** points to the Provenance projection endpoint
  (§Endpoints — Provenance below) for the Node so the operator sees
  what newtron believed the CONFIG_DB should be at refusal time —
  the half of the drift the device cannot show directly.
- **`guard_mode`** is `actuated` for every drift refusal in
  practice; the contract surfaces it because
  `unified-pipeline-architecture.md` §8 makes the mode the cause of
  the refusal ("actuated online: device intents are authoritative —
  the device SHOULD match its own intents"). A `topology` value is
  reserved and not currently emitted; surfacing the enum on the wire
  documents the substrate cause.
- **`resolution_hint`** names a concrete next-action verb in the
  shared operator vocabulary (`reconcile_delta` or `reconcile_full`
  from the operator-Inbox action verb set, which the browser frontend
  surfaces over newtrun-server post-rebalance) AND names the
  browser-frontend workflow where the operator stages it
  (`stage_via_browser_workflow`, e.g.,
  `"operator-inbox-drift-card"`). The hint is NOT prescriptive — the
  operator may choose differently — but it is concrete enough to act
  on without reading another doc (invariant #7's "substrate-grounded
  explanation" is binding even on the refusal).

Surviving newtcon-server endpoints that return
`kind: "drift_refusal"` per this contract — `/api/history/nodes/{node}/diff`
(when drift is observed mid-window), the §Endpoints — Provenance
projection reads when computing projection against a drifted Node —
populate this schema. The moved orchestration surfaces (Composer
preview / apply, Inbox action preview / action, Workbench dry_run /
commit) also produce `kind: "drift_refusal"` from newtrun-server's
runs; the shape is shared per the substrate-vocabulary discipline
above. The previously documented free-form `details.per_target[]`
on workbench dry-run with `DriftEntry[]` is the same shape as
`per_target[*].drift_entries[]` here — one substrate vocabulary.

### `details` for `kind: "precondition_failure"`

A `precondition_failure` is a refusal grounded in **newtcon-server-side
state** that does not satisfy the endpoint's preconditions — the
preview is stale, the batch is in the wrong state, the operation has
been evicted, the addressed substrate no longer exists. This is
distinct from `validation_failure` (which is about specific request
inputs) and from `drift_refusal` (which is about device divergence) and
from `newtron_unavailable` (which is about reachability).

The kind is discriminated by `condition`, a bounded enum. Each
condition defines which optional sub-fields populate `condition_details`.

Shape:

```json
{
  "error": {
    "kind": "precondition_failure",
    "message": "preview_id has expired (5-minute TTL); re-preview before applying",
    "details": {
      "correlation_id": "550e8400-e29b-41d4-a716-446655440000",
      "condition": "preview_id_stale",
      "condition_details": {
        "preview_id": "<opaque>",
        "issued_at": "2026-05-25T14:08:01Z",
        "expired_at": "2026-05-25T14:13:01Z",
        "preview_kind": "report_bug_preview | observation_history_query_preview"
      },
      "next_action_hint": {
        "verb": "re_preview",
        "endpoint": "/api/report-bug/preview",
        "rationale": "re-issue the same preview request; the operator's intent did not change, only the TTL expired"
      },
      "provenance_url": null,
      "gap_issue": null,
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
        "principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit"
      }
    }
  }
}
```

Bounded enum for `condition`:

| `condition` | When | `condition_details` shape |
|-------------|------|---------------------------|
| `preview_id_stale` | TTL elapsed since the preview was issued | `{ preview_id, issued_at, expired_at, preview_kind }` |
| `preview_id_unknown` | `preview_id` never issued by this server (or evicted) | `{ preview_id }` |
| `preview_id_wrong_class` | `preview_id` issued by a different endpoint than the one accepting it (e.g., dry-run preview submitted to `/commit`) | `{ preview_id, received_kind, required_kind }` |
| `preview_id_already_consumed` | `preview_id` valid but already redeemed by a prior call | `{ preview_id, consumed_at }` |
| `batch_state_invalid` | Workbench batch is not in a state that permits the requested operation | `{ batch_id, current_state, allowed_states[] }` |
| `operation_unknown_or_expired` | `operation_id` not currently known | `{ operation_id }` |
| `operation_evicted` | `operation_id` known to have existed but retention expired | `{ operation_id, evicted_at }` |
| `intent_unknown` | `intent_id` never minted | `{ intent_id }` |
| `intent_resolved` | `intent_id` was minted but the underlying intent record no longer exists on the device (reversed by later operation) | `{ intent_id, reversed_by_operation_id, reversed_by_operation_url }` |
| `changeset_unknown` | `changeset_id` never minted | `{ changeset_id }` |
| `stash_unknown_or_expired` | `stash_id` never minted or retention expired | `{ stash_id, expired_at? }` |
| `walkthrough_unknown` | `walkthrough_id` not in the Rehearsal teaching catalog | `{ walkthrough_id }` |
| `scenario_unknown` | `scenario_id` not in the Manual-Mode Parity scenario catalog | `{ scenario_id }` |
| `node_unknown` | `node` path parameter not in the spec | `{ node, network }` |
| `service_unknown` | `service` path parameter not in the spec | `{ service }` |
| `table_unknown` | `table` path parameter not in newtron's known-table catalog (used by the Manual-Mode Parity CONFIG_DB-key teach endpoint) | `{ network, node, table }` |
| `teach_content_unauthored` | the addressed substrate (service / table) is known to newtron but has no teach content authored against it yet in the Manual-Mode Parity catalog | `{ service?, table?, content_version }` |
| `card_signal_resolved` | Inbox `card_id` no longer derivable — signal resolved before operator opened it | `{ card_id, resolved_at }` |
| `newtron_capability_missing` | newtron is reachable but does not expose a capability this endpoint requires; a Gap-Handling-Protocol issue exists | `{ capability, gap_issue_url, expected_shape }` |

Catastrophic mid-sequence failures with partial results captured (e.g.,
the Workbench commit 502 path) are NOT a `precondition_failure`. There
is a single contract home for partial results:
`internal.details.partial_results` (see §`details` for `kind:
"internal"` below). Per-endpoint sections that report partial-results
recovery point at that home; the `precondition_failure` enum does not
duplicate it.

Field rules:

- **`condition`** is REQUIRED and bounded. A new condition is a Contract
  PR.
- **`condition_details`** populates the per-row schema above. Fields
  not in the per-row schema for the named `condition` are absent (not
  `null`).
- **`next_action_hint`** is REQUIRED for every `condition` in the
  enum. `verb` names a concrete operator action (`re_preview`,
  `re_dry_run`, `re_commit_preview`, `stage_reconcile_delta`,
  `inspect_operation`, `inspect_observation_history`,
  `open_inbox_card`, `file_gap_followup`,
  `retry_after_expiry`, etc.); `endpoint` points to where the verb is
  invoked. The hint is not prescriptive but it is concrete — the
  operator does not need to read other docs to know what to do next
  (operator-philosophy invariant #7 plus invariant #9). For
  `operation_evicted` specifically, the hint is
  `verb: "inspect_observation_history"` with `endpoint` pointing at
  the relevant `/api/history/nodes/{node}` window straddling the
  operation's apply time — the per-stage pipeline trace is gone,
  but the substrate diff between adjacent observations may still
  reconstruct what the operation changed (see §Endpoints —
  Operations "Eviction semantics").
- **`provenance_url`** points to the relevant Provenance endpoint
  when applicable: for `intent_resolved`, the reverse operation; for
  `operation_evicted`, `null` (the operation is gone, so there is
  nothing to link — the operator is redirected via
  `next_action_hint` to Observation History instead); for
  `batch_state_invalid`, the batch URL itself.
- **`gap_issue`** is REQUIRED on `newtron_capability_missing` and is
  the URL of the filed Gap-Handling-Protocol issue. Forbidden on
  every other `condition`. The free-form `details.gap_issue` field
  used in earlier draft contracts migrates into this typed shape.

The previously documented free-form `details.reason`, `details.current_state`,
`details.preview_kind`, `details.expired_at`, `details.gap_issue` fields
on existing endpoints map into `condition` + `condition_details` per the
table above. Specifically:
- `details.reason: "operation_unknown_or_expired"` → `condition: "operation_unknown_or_expired"`;
- `details.reason: "signal_resolved"` → `condition: "card_signal_resolved"`;
- `details.reason: "stash_unknown_or_expired"` → `condition: "stash_unknown_or_expired"`;
- `details.reason: "node_unknown"` → `condition: "node_unknown"`;
- `details.reason: "intent_unknown" | "intent_resolved"` → `condition: "intent_unknown" | "intent_resolved"`;
- `details.reason: "changeset_unknown" | "operation_evicted"` → `condition: "changeset_unknown" | "operation_evicted"`;
- `details.reason: "walkthrough_unknown"` → `condition: "walkthrough_unknown"`;
- `details.reason: "newtron_capability_missing"` with `details.gap_issue` →
  `condition: "newtron_capability_missing"`, `condition_details: { capability, gap_issue_url, expected_shape }`;
- `details.current_state` (batch in wrong state) → `condition: "batch_state_invalid"`, `condition_details.current_state`;
- `details.preview_kind` (wrong preview class submitted to `/commit`) →
  `condition: "preview_id_wrong_class"`, `condition_details.{received_kind, required_kind}`;
- `details.expired_at` (stash retention expired) → `condition: "stash_unknown_or_expired"`, `condition_details.expired_at`;
- `details.last_known` on 503 paths → not `precondition_failure`; see
  `newtron_unavailable` below.

### `details` for `kind: "newtron_unavailable"`

A `newtron_unavailable` is newtcon-server's honest acknowledgement that
it cannot reach newtron-server for the requested operation. Per
operator-philosophy invariant #9 ("Confidence and limits are explicit"),
this is surfaced — never silently retried, never papered over with
stale-rendered-as-current.

Shape:

```json
{
  "error": {
    "kind": "newtron_unavailable",
    "message": "newtron-server unreachable: connection refused at http://127.0.0.1:8080 since 2026-05-25T14:14:00Z",
    "details": {
      "correlation_id": "550e8400-e29b-41d4-a716-446655440000",
      "newtron_url": "http://127.0.0.1:8080",
      "last_reachable_at": "2026-05-25T14:13:00Z",
      "last_attempt_at": "2026-05-25T14:14:30Z",
      "underlying_error": "connection_refused | dns_failure | tls_handshake_failure | timeout | http_5xx | upstream_unhealthy",
      "underlying_error_message": "dial tcp 127.0.0.1:8080: connect: connection refused",
      "affected_nodes": ["switch1", "switch2"],
      "last_known": {
        "kind": "operation_pipeline | verify_assertion | intent_record | projection_diff | inbox_cards | none",
        "captured_at": "2026-05-25T14:13:00Z",
        "payload": { /* shape per kind; opaque to this schema */ }
      },
      "next_action_hint": {
        "verb": "check_newtron_health | retry_after | inspect_newtron_logs",
        "endpoint": "/api/health",
        "suggested_after": "PT10S",
        "rationale": "newtcon-server's last successful newtron call was 1 minute 30 seconds ago; the upstream may be restarting"
      },
      "rationale_ref": {
        "substrate": "CLAUDE.md#newtron-api-consumption-rule",
        "principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit"
      }
    }
  }
}
```

Field rules:

- **`newtron_url`** is the configured upstream URL (from
  `--newtron-url`). Surfaced because operators running multi-newtron
  deployments need to know which upstream failed.
- **`last_reachable_at`** is the timestamp of the most recent
  successful newtron-server call from newtcon-server's process
  lifetime, or `null` if newtcon-server has never reached newtron-
  server since startup. NOT a guarantee of newtron's actual
  availability at that moment — only that newtcon-server got a
  response then.
- **`last_attempt_at`** is the timestamp of the most recent failed
  attempt (typically very close to "now").
- **`underlying_error`** is a bounded classification of the failure
  mode. The classification is for the UI to render distinctively
  (a DNS failure surfaces differently from a TLS handshake failure);
  it is NOT a sanitized "friendly" version of the wire error.
- **`underlying_error_message`** carries the raw wire-level error
  string (e.g., a `*net.OpError` `.Error()` value or an HTTP body
  excerpt for `http_5xx`). Per `CLAUDE.md` §Operator-Honest Errors
  and operator-philosophy invariant #7, this is the substrate the
  operator needs to diagnose; it is not paraphrased. Long bodies
  are truncated at 4 KiB with a `...[truncated]` marker.
- **`affected_nodes`** lists the Nodes the failing operation needed
  to read or write. Single-Node operations have one entry; multi-Node
  operator workflows (Composer apply / Workbench commit across N
  nodes, delivered by the browser frontend over newtrun-server per
  ADR-0001) may have many. `null` for endpoints that are not
  Node-scoped (e.g., a bare upstream-reachability surface).
- **`last_known`** is the substrate snapshot newtcon-server has from
  prior successful calls. The `kind` discriminator names what the
  payload is so the consumer parses it correctly. Surviving
  newtcon-server endpoints populate `kind` as follows:
  - `/api/operations/{operation_id}` 503 → `kind: "operation_pipeline"`,
    `payload` is the last-observed pipeline snapshot (from the
    operations-store correlation per §Operations capture-path).
  - `/api/operations/{operation_id}/verify` 503 →
    `kind: "verify_assertion"`, `payload` is the last-observed
    assertion snapshot.
  - `/api/intents/{intent_id}` 503 → `kind: "intent_record"`,
    `payload` is the most recent record snapshot in newtcon-server's
    request-cache window.
  - `/api/projection/nodes/{node}` 503 →
    `kind: "projection_snapshot"`, `payload` is the most recent
    projection snapshot newtcon-server has from the Observation
    History store.
  - `/api/history/nodes/{node}/snapshot` 503 →
    `kind: "observed_snapshot"`, `payload` is the most recent
    observed snapshot.
  - `/api/report-bug/preview` 503 (the bug-report composition could
    not reach newtron for the operation-context block) →
    `kind: "operation_pipeline"`, `payload` is whatever pipeline
    snapshot newtcon-server has cached.
  - All other endpoints → `kind: "none"`, `payload` is `null`. The
    consumer renders an unavailability state without stale
    substrate.
- **`next_action_hint.verb`** is bounded:
  `check_newtron_health` (operator should hit `/api/health` to see
  current upstream status), `retry_after` (the operation may simply
  succeed on retry; `suggested_after` is a duration), or
  `inspect_newtron_logs` (the failure pattern suggests an upstream
  bug, not a transient).

This schema replaces the previously documented free-form
`details.last_known.<key>` shapes (`pipeline`, `record`, `assertion`,
`projection_diff`, `unreachable_nodes`) and the bare
`details.unreachable_nodes[]` field. Surviving newtcon-server
endpoints that emit a `details.unreachable_nodes[]` substrate (the
Observation History per-Node reads when they fan out, the Provenance
projection endpoint when it fans across multiple Nodes) populate
the `affected_nodes` field of this schema (newtron unreachable for
those specific Nodes; the rest of the network may be reachable).
The moved orchestration surfaces' equivalent fan-out failures are
specified by newtrun-server's contract per ADR-0001.

### `details` for `kind: "internal"`

An `internal` error is the residual category — newtcon-server cannot
attribute the failure to a recognized substrate cause. Per operator-
philosophy invariant #7, the substrate cause MUST be exposed when it
exists; `internal` is for the case where it is genuinely unknown to
the server at error-emission time.

This kind is deliberately MINIMAL. It does not leak stack traces,
source file paths, internal type names, or other implementation
substrate that would teach the operator a false model of newtcon's
internals. The only durable handle is the `correlation_id`, which the
operator quotes when filing an ops ticket; the engineer greps logs
for it.

Shape:

```json
{
  "error": {
    "kind": "internal",
    "message": "newtcon-server failed mid-request; quote correlation_id when reporting",
    "details": {
      "correlation_id": "550e8400-e29b-41d4-a716-446655440000",
      "at": "2026-05-25T14:15:32Z",
      "phase": "request_parse | newtron_call | response_render | persistence | session_management | unknown",
      "partial_results": null
    }
  }
}
```

Field rules:

- **`correlation_id`** is REQUIRED and is the ONLY way the operator
  reaches the underlying cause. The server logs every `internal`
  emission against this ID with full diagnostic detail; the wire
  carries only the ID. This is the controlled-leakage boundary:
  internals stay in logs; the operator gets a handle.
- **`at`** is the server-side timestamp of the failure (not "now" on
  read — the original failure time). Operators correlate against
  monitoring dashboards.
- **`phase`** is a coarse hint about where in the request lifecycle
  the failure occurred. Bounded and intentionally vague: this is
  hint-level, not substrate. Operators reading repeated `internal`
  errors with the same `phase` value have a starting hypothesis
  for the ops ticket; the substrate is in logs.
- **`partial_results`** carries any per-target results completed
  before the catastrophic failure. Shape matches the `per_target[]`
  of the originating endpoint's success response. `null` when no
  partial work was completed. On surviving newtcon-server endpoints
  this surfaces, e.g., on a Report Bug compose-and-deliver call that
  partially succeeded against the configured delivery integration;
  the moved orchestration surfaces' equivalent (e.g., the previously
  documented Workbench commit 502 partial path) are specified by
  newtrun-server's contract per ADR-0001 §What moves upstream.
- **No stack trace, no exception type, no file/line.** A
  `details.stack_trace` field is a contract violation; the
  Architecture Reviewer rejects any addition.
- **No `rationale_ref` requirement.** Unlike the other four kinds,
  `internal` does not require a `rationale_ref` because by
  construction the cause is not yet classified. When the cause IS
  known (e.g., a known newtron-server bug class), the failure
  should be re-classified as one of the other four kinds, not
  emitted as `internal` with explanatory `rationale_ref` text.

## Shared substrate shapes

**Promoted from §Endpoints — Service Composer per ADR-0001 rebalance
([`docs/adr/0001-scope-justification-vs-newtrun.md`](docs/adr/0001-scope-justification-vs-newtrun.md))
cross-section cleanup.** The typed substrate shapes — `ChangeSet`,
`Validate`, `Confidence`, `Reverses`, `PerWrite` — were previously
defined under the now-stubbed Composer section but are referenced
from surviving newtcon-server surfaces (§Endpoints — Operations,
§Endpoints — Provenance, §Endpoints — Observation History,
§Endpoints — Report Bug). The canonical definitions live here, in
one place, per `editing-guidelines.md` §4 ("each concept explained
exactly once") and `DESIGN_PRINCIPLES_NEWTRON.md` §46 ("wire shape
mirrors substrate").

### `ChangeSet`

The canonical CONFIG_DB substrate-effect substrate per
`DESIGN_PRINCIPLES_NEWTRON.md` §11 ("The ChangeSet Is the Universal
Contract"). Carries `writes[]`, `deletes[]`, `intent_records[]`, and
`rationale_ref`. The shape mirrors newtron's `ConfigChange[]` typed
array (newtron `api.md` §S11 `WriteResult`, landed via newtron#11):

- **`writes[]`** — each entry is one CONFIG_DB add or modify
  (newtron's `ChangeType: "add" | "modify"`). Fields:
  - `table` — REQUIRED, the CONFIG_DB table name.
  - `key` — REQUIRED, the CONFIG_DB key (post-table-prefix), `|` as
    multi-part separator.
  - `fields` — REQUIRED, object mapping field name to scalar-as-string
    (CONFIG_DB stores all values as strings).
- **`deletes[]`** — each entry is one CONFIG_DB delete (newtron's
  `ChangeType: "delete"`). `table` and `key` REQUIRED;
  `fields` discriminates whole-row delete (`null`) from field-level
  delete (array of field names).
- **`intent_records[]`** — each entry is one NEWTRON_INTENT row the
  ChangeSet prepends per
  `unified-pipeline-architecture.md` §3 ("the intent record IS the
  decision substrate"). Surfaced as a first-class field rather than
  buried in `writes[]` per operator-philosophy invariant #1 (the
  operator needs to inspect the decision substrate without scanning
  for `table == "NEWTRON_INTENT"`).
- **`rationale_ref`** — REQUIRED, the typed
  `{substrate, principle}` shape.

The shape is shared across the rebalance boundary: the moved
orchestration surfaces produce ChangeSets through newtrun-server's
`newtron` action consuming newtron's `WriteResult`; surviving
newtcon-server surfaces (Operations, Provenance changesets,
Observation History composition, Report Bug substrate blocks) consume
the same shape verbatim from newtcon-server's operations store.

### `Validate`

The two-kinds-of-refusal substrate per
`DESIGN_PRINCIPLES_NEWTRON.md` §13. Carries:

- **`ok`** — REQUIRED, `true` iff both `preconditions[]` and
  `schema_violations[]` are empty.
- **`preconditions[]`** — REQUIRED, business-logic refusals (the
  operation's subject is absent or present-but-conflicting).
  Operator affordance: "fix the situation."
- **`schema_violations[]`** — REQUIRED, schema-validation refusals
  (out-of-range value, unknown enum, etc.). Operator affordance:
  "fix the value."

Each row shape matches §Error Schema's
`validation_failure.details.rejections[]` (`locator`, `reason`,
`message`, `expected`, `actual`, `allowed`) plus a per-row
`rationale_ref`. The `reason` enum is the same bounded set as
§Error Schema's.

### `Confidence`

Makes the system's confidence in a per-target result explicit on the
wire, per operator-philosophy invariant #9 ("Confidence and limits
are explicit"). Carries:

- **`level`** — REQUIRED, bounded categorical: `high` |
  `conditional` | `low`.
- **`reasons[]`** — REQUIRED, empty when `level == "high"`. Each
  entry has bounded `code` (e.g., `shared_resource_count_estimated`,
  `verify_pending`, `verify_skipped_by_request`,
  `inbox_signal_stale`, `inbox_signal_unavailable`,
  `newtron_cache_miss_for_last_known`, `precondition_check_partial`),
  required `message` (substrate-grounded short text), optional
  `gap_issue` (only when the reason corresponds to a filed newtron
  gap), and required `rationale_ref`.

**Aggregation rule.** When `aggregate.confidence` is reported, the
aggregate `level` is the WORST level across per-target entries;
aggregate `reasons[]` is the union of unique `code` values. Healthy
cases report `level: "high"` (the schema deliberately surfaces `high`
on healthy responses so the operator learns the vocabulary).

### `Reverses`

Makes `DESIGN_PRINCIPLES_NEWTRON.md` §15 ("Symmetric Operations —
What You Create, You Can Remove") binding on the wire. Appears on
preview-of-remove substrate shapes (delivered by the browser
frontend over newtrun-server per the moved-surface stubs, observed
into newtcon-server's substrate stores). Carries:

- **`reverse_strategy`** — REQUIRED, bounded enum:
  `symmetric_verb | reconcile_delta | reconcile_full`.
- **`originating_intents[]`** — REQUIRED, non-empty. Each entry
  names the originating intent's `intent_id` / `intent_url`,
  `operation`, `resource_key`, `name`, `applied_at`, and the
  `applied_by_operation` block (operation_id + operation_url +
  operator_workflow + operator_identity).
- **`inverse_of_inverse`** — REQUIRED. Names the forward verb that
  would undo this reverse, the browser-frontend workflow at which
  the operator restages the forward verb
  (`stage_via_browser_workflow`), a `stage_via_body_sketch` of the
  forward operation's parameters populated from the original
  intent's `user_params`, and a `rationale` + `rationale_ref` pair.

### `manual_equivalent.newtron_http`

The bounded enum surfacing the operator-philosophy invariant #2
(manual-mode parity) on every endpoint that admits one. The enum
discriminator `status` is bounded by the values
`available | partial_match | pending_newtron_gap | deferred_indefinitely | not_applicable`,
each defining a typed shape:

- **`{ "status": "available", "method", "path", "query"?, "body"? }`**
  — an endpoint that is documented as part of newtron's public HTTP
  API (or newtrun-server's public HTTP API per ADR-0001) AND is
  verified registered in the corresponding `buildMux()` / handler
  registration, and answers the same question with the same
  substrate. Both halves of the check are required: documentation
  alone is insufficient (see the api.md ↔ buildMux drift tracked at
  [newtron#20](https://github.com/aldrin-isaac/newtron/issues/20)),
  and a wired-but-undocumented route is also insufficient (it is not
  yet public surface).
- **`{ "status": "partial_match", "method", "path", "query"?, "body"?, "note": "<rationale>" }`**
  — an endpoint exists that answers a related but not identical
  question; the `note` explains the gap honestly.
- **`{ "status": "pending_newtron_gap", "gap_issue": "<URL>", "expected_shape": { … } }`**
  — no upstream HTTP shape exists today, AND the substrate is filed
  as a gap awaiting upstream delivery on an open timeline; tracked
  under the Gap-Handling Protocol (`CLAUDE.md` §Gap-Handling
  Protocol).
- **`{ "status": "deferred_indefinitely", "gap_issue": "<URL>", "re_evaluation_trigger": { "text": "<verbatim substrate>", "newtcon_context": ["<ref>", ...] } }`**
  — no upstream HTTP shape exists today, AND the upstream lead has
  considered the substrate and indefinitely deferred it. No upstream
  delivery is expected on a defined timeline. Consumers MUST NOT
  surface this as "pending" or "expected"; the operator-facing
  rendering must convey "considered and deferred" honestly.
  `re_evaluation_trigger` is REQUIRED on this shape; its `text`
  subfield is REQUIRED and is byte-for-byte the lead's wording on
  the linked `gap_issue`, and its `newtcon_context` subfield is
  OPTIONAL.
- **`{ "status": "not_applicable", "rationale": "<text>" }`** — no
  upstream HTTP shape applies, by design, because the substrate is
  not addressable in the upstream model.

The shape MUST be one of these five — silently fabricating an
endpoint URL is forbidden. `newtron_cli` (sibling field on every
`manual_equivalent` block) always points to the equivalent CLI
invocation when one exists; it is `null` when no CLI equivalent
applies.

**Semantic distinction — `pending_newtron_gap` vs
`deferred_indefinitely`.** Both shapes name "no upstream HTTP shape
exists today" but they teach different operator-facing models, and
the distinction is binding (operator-philosophy invariant #9, "False
confidence is worse than no confidence"). `pending_newtron_gap`
means the substrate is **filed and tracked with an open expectation
of delivery**: the upstream team is expected to ship it.
`deferred_indefinitely` means the substrate has been **considered
and explicitly deferred**: the gap_issue documents the deferral
verdict, no delivery is on the upstream roadmap, and a consumer that
surfaces it as "pending" lies to the operator. The
`re_evaluation_trigger` makes the deferral's contingency visible:
the deferral is not "wontfix" (that would be a separate verdict),
it is "deferred unless the named condition fires."

**Honest lifecycle.** A given substrate may move through three
honest states over its lifetime:
`deferred_indefinitely → pending_newtron_gap → available`.
Transitions are operator-visible per Contract PR.

Per ADR-0001 rebalance, `manual_equivalent.newtron_http` substrate
on surviving newtcon-server surfaces may target newtrun-server's
HTTP API as the upstream rather than newtron-server's directly; the
enum and shapes are unchanged because newtrun-server is in the same
upstream-substrate position newtron-server was, only one level up.

### `PerWrite`

The per-substrate-operation entry type. Per ADR-0001, the canonical
substrate for `PerWrite` lives **upstream** in newtrun-server's
`EventStepProgress` payload (per newtron#24's `StepProgress`
callback), which embeds the verbatim `sonic.DeviceOp` substrate per
`DESIGN_PRINCIPLES_NEWTRON.md` §46 ("Wire Shape Mirrors Substrate").
The shape carries:

- `seq` — zero-based ordinal per target.
- `operation_id` — newtcon-server's operation ID (correlated against
  newtrun-server's `run_id` + `step_index`).
- `target` — `{network, node, interface?}`.
- `kind` — `redis_write | redis_delete | daemon_wait | verify_read`.
- `substrate` — `{table, key, fields?}`.
- `result` — `applied | rejected | skipped`.
- `cli_command` — the operator's-own-tools command equivalent.
- `device_response` — verbatim wire reply from the device.
- `at` — RFC 3339 timestamp.
- `rationale_ref` — typed `{substrate, principle}`.
- `source` — reserved per newtron#12 deferral
  (REQUIRED key, value REQUIRED to be `null` in v0).

Surviving newtcon-server surfaces that embed `PerWrite` shapes (§Operations
`per_write[]` on observed operations, §Observation History
`change_per_write[]` correlation entries, §Report Bug
`failed_write.substrate.per_write` body section) consume the shape
verbatim from newtrun-server's substrate as observed by
newtcon-server, preserving the §46 wire-shape principle across the
rebalance boundary. The full historical specification of `PerWrite`
lives in newtrun-server's contract (newtron repo); this section
documents the shape because surviving newtcon-server surfaces
reference it.

## Streaming substrate-operation events

**Moved per ADR-0001 rebalance ([`docs/adr/0001-scope-justification-vs-newtrun.md`](docs/adr/0001-scope-justification-vs-newtrun.md)).**
The state-changing endpoints this surface used to wrap — Composer
`POST /api/apply`, Workbench `POST /api/workbench/{batch_id}/commit`,
and Inbox `POST /api/inbox/{card_id}/action` — moved out of
newtcon-server in the rebalance. Per-write substrate streaming for
those workflows is delivered by **newtrun-server**'s
`GET /api/runs/{suite}/events` Server-Sent Events surface, carrying
the `EventStepProgress` wire type whose payload embeds the verbatim
`sonic.DeviceOp` substrate per newtron's
`DESIGN_PRINCIPLES_NEWTRON.md` §46 (Wire Shape Mirrors Substrate).
The browser frontend consumes that SSE stream directly; newtcon-server
is not in the streaming path.

The substrate guarantees the moved surface owned — "no black boxes"
(operator-philosophy invariant #1) made structural through per-write
visibility — are preserved on newtrun-server's substrate. The
landed upstream substrate is newtron#22 (HTTP read surface + SSE,
2026-05-29) and newtron#24 (`StepProgress` callback through
`HTTPReporter`, 2026-05-29). The deferred SSE consumer in newtrun's
`steps_newtron.go` (newtron#28, gated on newtron#19 Phase 2b) is the
final wire-shape question that resolves when those upstream items
land.

The historical contract for this surface — the `PerWrite` shape, the
SSE event grammar, the `apply_complete` terminal event with
`streaming_source` companion, the mid-stream-errors rule, the
content-negotiation rule, the per-Node atomicity honesty clause, the
`cli_command` rendering responsibility, and the
endpoints-that-admit-streaming table — is preserved in git history
at PR #61 (the most recent merged Contract PR that defined the
surface, adapting it to newtron#19's JSON-available, SSE-derived
verdict). Future shape questions for the equivalent newtrun-server
surface route through newtron's HTTP API tracker, not this contract.



## Endpoints — Health

### `GET /api/health`

Liveness probe. No newtron interaction.

**Response 200:**
```json
{
  "status": "ok",
  "version": "<newtcon-version>",
  "newtron": {
    "url": "<configured newtron-server URL>",
    "reachable": true,
    "version": "<reported by newtron-server>"
  },
  "operations_retention": {
    "source": "newtcon_operations_store",
    "terminal_floor_seconds": 2592000,
    "in_flight_floor_seconds": 604800,
    "pruner_last_run_at": "2026-05-26T00:00:00Z",
    "pruner_next_run_at": "2026-05-27T00:00:00Z"
  }
}
```

The `newtron.reachable` field is the result of a lightweight upstream health
probe; `newtron.version` is whatever newtron-server reports on its own health
endpoint. If newtron-server is unreachable, `reachable` is `false` and the
endpoint still returns 200 — newtcon-server itself is alive.

The `operations_retention` companion is REQUIRED. It exposes the
deployment's configured retention floors for the operations store
that backs §Endpoints — Operations. Per
`CLAUDE.md` §No Hidden State and operator-philosophy invariant #9
(Confidence and limits are explicit), the operator must be able to
ask "how long do my operations stay queryable?" and receive a
substrate-grounded answer without consulting deployment docs.
`source` echoes the source-of-truth decision recorded in
§Endpoints — Operations (currently the single value
`"newtcon_operations_store"`); `terminal_floor_seconds` and
`in_flight_floor_seconds` are the contract's binding floors as
configured for this deployment (defaults 30 days and 7 days
respectively per §Endpoints — Operations "Retention window");
`pruner_last_run_at` / `pruner_next_run_at` expose the eviction
schedule so the operator sees when the floor becomes load-bearing.

This endpoint surfaces newtcon-server's own liveness plus its
upstream newtron-server reachability. The browser frontend probes
newtrun-server's liveness independently via `GET /api/health` on
newtrun-server (newtron#22, landed 2026-05-29) — that probe is not
part of newtcon-server's contract.

## Endpoints — Service Composer (first surface)

**Moved per ADR-0001 rebalance ([`docs/adr/0001-scope-justification-vs-newtrun.md`](docs/adr/0001-scope-justification-vs-newtrun.md)).**
The Service Composer operator workflow is delivered by the browser
frontend consuming **newtrun-server**'s orchestration substrate:
`POST /api/runs/inline` (newtron#23, landed 2026-05-29) accepts an
inline scenario YAML that wraps a Composer apply as a
`newtron POST /api/preview` step, an operator-review gate, and a
`newtron POST /api/apply` step; `GET /api/runs/{suite}/events` SSE
(newtron#22, landed 2026-05-29) carries per-write substrate
visibility through `EventStepProgress`. The atomicity model is
unchanged — newtron's `cs.Apply` / `ApplyDrift` / `ReplaceAll` per
[`CLAUDE.md`](CLAUDE.md) §Project Scope remains per-Node atomic,
multi-Node structured best-effort — because the underlying newtron
substrate is unchanged.

The `GET /api/services`, `GET /api/services/{name}/instances`, and
`GET /api/services/{name}/candidates` read endpoints — pure read
surfaces the browser uses to populate the Composer's spec / target
pickers — are the borderline case in the ADR-0001 bucket framing.
Per the operator verdict's "defer the final shape decision until the
unique-bucket implementation sharpens the right call" guidance applied
to this bucket, the final disposition is **deferred**: either kept on
newtcon-server as thin proxies (likely if the Provenance layer
matures into a unified read-only proxy surface), or moved to
newtrun-server (`GET /api/topologies`, `GET /api/suites` per
newtron#22 already expose adjacent read substrate). The browser
frontend should not assume either path is permanent until the
unique-bucket implementation matures. The historical detailed
contract for these reads is preserved in PR #86 (the most recent
merged Contract PR defining `/api/services`).

The historical contract for `POST /api/preview`, `POST /api/apply`,
and the per-target failure semantics is preserved in git history at
PR #43 / PR #61 / PR #70 (the last of which adopted the typed
`VerificationResult` envelope from newtron#21). Future shape
questions for the equivalent newtrun-server surface route through
newtron's HTTP API tracker, not this contract.

## Endpoints — Operator Inbox (second surface)

**Moved per ADR-0001 rebalance ([`docs/adr/0001-scope-justification-vs-newtrun.md`](docs/adr/0001-scope-justification-vs-newtrun.md)).**
The Operator Inbox operator workflow is delivered by the browser
frontend composing two backends: **newtrun-server**'s run history
(`GET /api/runs`, `GET /api/runs/{suite}/events` SSE per newtron#22)
carries the lifecycle substrate for card actions expressed as
scenario runs; **newtcon-server**'s Observation History (§Endpoints
— Observation History below) carries the substrate-change signal
that produces the card kinds in the first place (drift detected via
observed-state diff; convergence-straggler detected via
newtrun-server's still-running run state vs adaptive polling
cadence; out-of-band changes via `source: out_of_band`
classification).

The five card kinds (`drift`, `convergence_straggler`,
`partial_operation`, `reference_warning`, `reconcile_due`) are
preserved as the browser frontend's card vocabulary; the substrate
they derive from is now split between Observation History (the
detection layer newtcon-server uniquely owns per ADR-0001 §Bucket B)
and newtrun-server's run state (the lifecycle layer that produces
`partial_operation` from a failed `EventStepProgress` and
`convergence_straggler` from a run still in `running` past its
expected window).

The card-action endpoints (`POST /api/inbox/{card_id}/action` and
its preview / dismiss counterparts) become inline-scenario runs on
newtrun-server: an "Enforce intent" card-action becomes a one-step
scenario that calls `newtron POST /network/{n}/node/{d}/reconcile`,
with the per-write substrate visible through `EventStepProgress`
exactly as it was visible through the previously-architected SSE
surface. Dismissal semantics are client-side filter state in the
browser frontend per ADR-0001 §Bucket A.4; newtcon-server hosts no
dismissal store.

The historical contract for this surface is preserved in git history
at PR #67 (the most recent merged Contract PR defining Inbox cards
and actions). Future shape questions for the equivalent
newtrun-server surface route through newtron's HTTP API tracker, not
this contract.

## Endpoints — Operations

**Sharpening deferred per ADR-0001 rebalance ([`docs/adr/0001-scope-justification-vs-newtrun.md`](docs/adr/0001-scope-justification-vs-newtrun.md)).**
The Operations log is **uniquely-newtcon** substrate per ADR-0001
§"What stays in newtcon" — the long-lived per-operation history
beyond a single newtrun run, which is what makes `operation_url`
valid across time and is the substrate the Observation History
correlation engine (§Endpoints — Observation History `source`
classification) writes to. The shape documented in this section
(`pipeline` object, `verify` object, `retention` block) is the
canonical operator-facing specification and is preserved verbatim
across the rebalance.

**What did change is provenance of writes to the operations store**:
post-rebalance, the state-changing surfaces that mint operations
(Service Composer apply, Inbox card actions, Change Workbench commit)
moved to newtrun-server per ADR-0001 §Bucket A. newtcon-server now
**observes** those operations via newtrun-server's HTTP read surface
(`GET /api/runs/{suite}` and `GET /api/runs/{suite}/events` SSE per
newtron#22, landed 2026-05-29) and writes them into its own operations
store for long-lived retention plus observation-history correlation.
A future Contract PR may sharpen the surface to add a `source_run_id`
companion pointing into newtrun-server's run state, or to surface
`EventStepProgress` per-run lineage as a first-class field, as the
Observation History correlation engine matures and the right call
sharpens. The operator-facing wire shape is unchanged in this PR;
the substrate underneath shifts.

These endpoints expose the per-operation trace produced by Service
Composer apply, Inbox card actions, and Change Workbench commit
operations the operator initiates through the browser frontend over
newtrun-server (per the moved-surface stubs above). The trace shape
is the same regardless of which operator workflow initiated the
operation — the pipeline is one pipeline
(`unified-pipeline-architecture.md` §2).

The trace separates two concerns that `unified-pipeline-architecture.md`
itself separates:

- **Pipeline stages.** §2 defines the pipeline as
  `Intent → Replay → Render → [Deliver]` — four stages, with `Deliver`
  conditional on whether the caller commits the ChangeSet.
- **Verify.** §7 classifies `cs.Verify(n)` as a **Device I/O operation**,
  not a pipeline stage. It re-reads CONFIG_DB and asserts the ChangeSet
  landed (`DESIGN_PRINCIPLES_NEWTRON` §14). This is a post-deliver
  assertion against the device, not a sibling of the build stages.

The contract reflects that split: a `pipeline` object with four stages
and a separate top-level `verify` object typed as a Device I/O result.

### Retention semantics — source of truth, window, eviction

The operations surface is **served from newtcon-server's own
operations store**. newtcon-server is the authoritative source for
every `operation_id` it has minted; it is the only source. There is
no live-read fallback to newtron for the pipeline trace, the verify
assertion, or any other field in the response.

This is not a design choice between sources; **it is the only source
that exists**. newtron does not expose an HTTP endpoint that reads a
past operation's pipeline trace. The rollback-history substrate
inside newtron (per `DESIGN_PRINCIPLES_NEWTRON.md` §23, the bounded
rolling buffer of `DefaultMaxHistory = 10` completed commits per
Node, stored in CONFIG_DB) exists for newtron's own
rollback-on-crash purpose; the routes that would surface it
(`GET /history`, `POST /rollback-history`) are documented in
`../newtron/docs/newtron/api.md` §11 but **not registered** in
`pkg/newtron/api/handler.go` `buildMux()` and the substrate is not
shaped for the per-operation pipeline trace this surface returns —
it stores per-commit reverse-ChangeSets sized for rollback, not the
multi-stage trace + verify assertion the operator sees. The doc-vs-
implementation drift on those routes is tracked at the newtron
lead's broader doc audit
([newtron#20](https://github.com/aldrin-isaac/newtron/issues/20));
this contract does NOT propose that newtron expose them as a read
endpoint, because doing so would put newtron in violation of its
own §21 ("Reconstruct, Don't Record" — completed operation history
"belongs in structured logging or an external store, not in the
device's configuration database... or in newtron"). Completed
operations are observation history; observation history is
newtcon's domain per `CLAUDE.md` §No Hidden State and §Endpoints —
Observation History "Why this lives in newtcon, not newtron".

**The capture path is observation of newtrun-server's run state.**
Post-rebalance per ADR-0001, the state-changing surfaces that mint
operations (Composer apply, Inbox action, Workbench commit / revert)
moved to newtrun-server's `POST /api/runs/inline` (newtron#23). The
browser frontend initiates each operation as a scenario run against
newtrun-server; newtron-side RPCs are issued by newtrun-server's
`newtron` action, which receives newtron's `WriteResult` (per
`../newtron/docs/newtron/api.md` §15) and surfaces it through
newtrun-server's `EventStepProgress` events (per newtron#24's
`StepProgress` callback). newtcon-server **observes** these events
via newtrun-server's HTTP read surface — subscribing to
`GET /api/runs/{suite}/events` (SSE per newtron#22) for in-flight
operations and polling `GET /api/runs/{suite}` for terminal-state
reconciliation — and writes the full pipeline trace + verify
assertion + initiator metadata into newtcon-server's operations
store. The operation is addressable at
`GET /api/operations/{operation_id}` as soon as the upstream
substrate (newtrun-server's `EventStepProgress` for the terminal
event of the underlying newtron call) is observed and recorded.

Capture cadence is bounded by newtrun-server's `EventStepProgress`
emission rate plus newtcon-server's poll-and-subscribe pipeline; for
in-flight operations the substrate is available with sub-second
freshness via the SSE subscription, for terminal-state
reconciliation a periodic poll closes any missed-event gaps. The
binding guarantee on this surface is that **every operation_id
addressable through this endpoint has its full pipeline trace +
verify assertion captured**; the exact upstream-observation cadence
is an implementation detail of newtcon-server, exposed through
`/api/health` for operator inspection per `CLAUDE.md` §No Hidden
State.

**Storage substrate (informational, not contractual).** v0 uses the
same SQLite store as Observation History (`internal/history/`, per
the v0 storage choice in newtcon#37 and §Endpoints — Observation
History "Storage substrate"). The contract surface is
storage-agnostic; migration to a different store is non-contract-
breaking provided the response shapes and retention guarantees
below are preserved. The store is part of newtcon's persistent
state carved out by `CLAUDE.md` §No Hidden State as observation
history; operations are the newtcon-mediated subset of observation
history and inherit its persistence boundary.

**Retention window (binding).** Every minted `operation_id` is
retained for **at least 30 days** after `terminal.reached == true`
and **at least 7 days** for an in-flight operation that has not
reached terminal state (the longer in-flight floor exists so an
operator who walks away mid-operation can still find the trace on
return). Deployments MAY retain longer; the contract is a floor,
not a ceiling. The actual configured retention floor for the
running newtcon-server is exposed at
[`GET /api/health`](#get-apihealth) under the new
`operations_retention` companion (see that endpoint), so the
operator never has to guess what their deployment's floor is.

Retention is **time-based, not count-based**. There is no rolling
cap on the number of operations retained, because a count-based
cap would silently evict recent operations on a busy Node while
preserving stale operations on a quiet Node — exactly the false-
confidence pattern operator-philosophy invariant #9 rejects. Time-
based retention guarantees an operator looking at any operation
within the window sees the trace, regardless of activity on the
Node.

Pruning is **terminal-only**. In-flight operations are never
pruned; the pruner skips any record whose `terminal.reached` is
false. (This is the correct behavior: a "stuck" in-flight operation
is exactly the substrate the operator most needs to inspect, and
silently evicting it because the clock ran out would be the
hidden-state pattern `CLAUDE.md` §No Hidden State exists to
prevent.) An operation that is structurally stuck — newtron-server
crashed before the synchronous response landed, leaving the trace
in `pipeline.deliver.stage == "in_progress"` indefinitely — is
surfaced as an Operator Inbox card (zombie-intent or convergence-
straggler kind, per §Endpoints — Operator Inbox) for the operator
to resolve; it is never silently aged out.

**Eviction semantics.** When the retention window elapses, the
operations store deletes the record and the `operation_id` becomes
unresolvable. A subsequent
`GET /api/operations/{operation_id}` returns 404 with
`kind: "precondition_failure"` per §Error Schema, using the
existing `condition: "operation_evicted"` enum entry. The error's
`condition_details.evicted_at` carries the eviction timestamp
(known to the second from the pruner's run record).
`next_action_hint.verb` is `inspect_observation_history` and
`next_action_hint.endpoint` is the relevant
`GET /api/history/nodes/{node}` endpoint scoped to the operation's
target Node and `[evicted_at - 1h, evicted_at + 1h]` window — the
substrate effect of the operation may still be reconstructible
from the diff between adjacent observations even though the per-
stage pipeline trace itself is gone.

An `operation_id` that newtcon-server never minted (an operator
who fat-fingered an ID, a stale link from before a newtcon-server
data-loss event) returns the same 404 shape but with
`condition: "operation_unknown_or_expired"` and no `evicted_at`
field (we never knew it). The two `condition` values let the
operator distinguish "newtcon forgot this" from "newtcon never
knew this" — a distinction operator-philosophy invariant #9
makes binding.

**newtron's rolling buffer is NOT a retention concept on this
surface.** newtron's `DefaultMaxHistory = 10` rolling buffer in
CONFIG_DB governs what reverse-ChangeSets newtron retains for its
own rollback purpose — it does not bound what operations newtcon
can return from this endpoint. An operation captured by newtcon
at apply time remains addressable at this endpoint for the full
retention window above, regardless of whether it has been rolled
out of newtron's per-Node rollback buffer. The response carries
`retention.newtron_rollback_buffer_estimated_status` (see field
rules below) as an honest secondary disclosure for the operator
who is reasoning about what newtron-side rollback primitives can
still reach the operation, but this is informational only — it
does not affect whether the operation is returned.

### `GET /api/operations/{operation_id}`

Return the full trace for an operation. Idempotent; safe to poll.
No newtron-side state is mutated; no newtcon-side state is mutated.
Served from newtcon-server's operations store per the retention
contract above; never falls back to newtron.

**Response 200:**
```json
{
  "operation_id": "<opaque>",
  "as_of": "2026-05-25T14:06:30Z",
  "network": "default",
  "node": "switch1",
  "initiator": {
    "operator_workflow": "composer | inbox | workbench",
    "verb": "ApplyService | RemoveService | RefreshService | Reconcile | RollbackZombie | ...",
    "started_at": "2026-05-25T14:06:00Z"
  },
  "intent": {
    "kind": "ApplyService",
    "resource": "Ethernet0",
    "params": { "service": "transit", "ip": "10.1.0.0/31", "peer_as": 65002 },
    "intent_id": "<opaque>",
    "intent_url": "/api/intents/<opaque>"
  },
  "pipeline": {
    "intent": {
      "stage": "complete",
      "started_at": "2026-05-25T14:06:00Z",
      "completed_at": "2026-05-25T14:06:00Z",
      "intent_record": {
        "key": "service|transit|Ethernet0",
        "fields": { /* NEWTRON_INTENT record fields */ }
      }
    },
    "replay": {
      "stage": "complete",
      "started_at": "2026-05-25T14:06:00Z",
      "completed_at": "2026-05-25T14:06:00Z",
      "steps_replayed": 1
    },
    "render": {
      "stage": "complete",
      "started_at": "2026-05-25T14:06:00Z",
      "completed_at": "2026-05-25T14:06:01Z",
      "entries_validated": 14,
      "entries_rejected": 0
    },
    "deliver": {
      "stage": "complete",
      "started_at": "2026-05-25T14:06:01Z",
      "completed_at": "2026-05-25T14:06:02Z",
      "writes_applied": 12,
      "deletes_applied": 2,
      "lock_acquired_at": "2026-05-25T14:06:01Z",
      "lock_released_at": "2026-05-25T14:06:02Z",
      "save_config_done": true
    }
  },
  "verify": {
    "kind": "device_io_assertion",
    "state": "pending | in_progress | complete | failed | skipped",
    "started_at": "2026-05-25T14:06:02Z",
    "completed_at": "2026-05-25T14:06:03Z",
    "skip_reason": null,
    "verify_url": "/api/operations/<opaque>/verify",
    "assertion": {
      "passed": 14,
      "failed": 0,
      "errors": [
        {
          "table": "BGP_NEIGHBOR",
          "key": "default|10.1.0.1",
          "field": "asn",
          "expected": "65002",
          "actual": "",
          "device_response": "local_asn=99999 router_id=10.0.0.1"
        }
      ]
    },
    "confidence": { /* Confidence object — see §Shared substrate shapes "Confidence" */ }
  },
  "terminal": {
    "reached": true,
    "outcome": "success | failure | partial",
    "at": "2026-05-25T14:06:03Z",
    "summary": "applied; verify passed"
  },
  "retention": {
    "source": "newtcon_operations_store",
    "captured_at": "2026-05-25T14:06:03Z",
    "retained_until_at_least": "2026-06-24T14:06:03Z",
    "deployment_floor_seconds": 2592000,
    "newtron_rollback_buffer_estimated_status": "likely_in_buffer | likely_rolled_out | unknown",
    "newtron_rollback_buffer_position_estimate": 3,
    "newtron_rollback_buffer_max_history": 10,
    "rationale_ref": {
      "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#21-reconstruct-dont-record",
      "principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit"
    }
  }
}
```

Field rules:

- **Pipeline stages.** Every entry in `pipeline` has `stage` ∈
  `pending | in_progress | complete | failed | skipped`. `pending` stages
  have null timestamps. The four stages are exactly those of
  `unified-pipeline-architecture.md` §2 (`Intent → Replay → Render →
  [Deliver]`); a `deliver` stage of `skipped` is correct and expected
  for any operation where the caller did not commit the ChangeSet (e.g.,
  Replay-only flows).
- **Verify is a Device I/O operation, not a pipeline stage.** Per
  `unified-pipeline-architecture.md` §7 ("All device interaction is
  layered on top of expected state via a transport connection... Verify
  (`cs.Verify(n)`) … Re-read from Redis, compare against ChangeSet").
  The top-level `verify` object carries `kind: "device_io_assertion"`
  to make the classification load-bearing on the contract.
- **`verify.assertion`** mirrors newtron's `VerificationResult` (`api.md`
  §VerificationResult / §VerificationError, originally §15 Write Result
  Types): `passed`, `failed`, `errors[]`. `errors[]` is absent when all
  entries passed. Present only when `verify.state == "complete"` or
  `verify.state == "failed"`. Per `DESIGN_PRINCIPLES_NEWTRON` §14,
  verify is an assertion against the ChangeSet — newtron knows what it
  wrote — so the shape is `expected/actual` per field, never a
  "verification status" enum that would conflate assertion with
  cross-device observation. Each `errors[]` entry carries `table`,
  `key`, `field`, `expected`, `actual`, and `device_response` — the
  six fields newtron's `sonic.VerificationError` exposes per
  `api.md` §VerificationError after the
  [newtron#21](https://github.com/aldrin-isaac/newtron/issues/21)
  envelope fix (commit `f6b64d8`, 2026-05-27). `device_response` is
  the verbatim device-side reply observed when the mismatch was
  detected (for field mismatches, the full `HGETALL` content as
  sorted `key=value` pairs; for missing-key or still-present cases,
  the Redis-level status string). The substrate-faithful
  pass-through of `device_response` operationalizes §14 ("verify is
  an assertion against the device") and §46 ("wire shape mirrors
  substrate") on the failure path: an operator inspecting a verify
  failure reads what the device actually returned, not a paraphrase.
  The `device_response` field is OPTIONAL only in the sense that
  newtron may omit it when the assertion failure is structural
  rather than field-level (an entry's whole key was missing); when
  present, it is verbatim. The newtcon-server consumes this typed
  substrate from newtron's `VerificationResult` regardless of
  whether newtron emitted it on the 200 path (`WriteResult.
  verification`) or on the 409 path (the typed `data: *WriteResult`
  envelope on `VerificationFailedError`, per newtron#21) — the
  substrate is the same in both delivery shapes, and the contract
  surfaces it once on the 200 path's `verify.assertion.errors[]`
  (see "Verify failure does not produce a 4xx envelope" rule
  below).
- **Verify failure does not produce a 4xx envelope.** The five
  `kind` values in §Error Schema
  (`validation_failure | drift_refusal | precondition_failure |
  newtron_unavailable | internal`) do NOT include a
  `verify_failure` kind, and intentionally so: a verify failure
  means the write **landed** (`applied: true`) but the post-deliver
  re-read disagreed with the ChangeSet — newtron's pipeline ran to
  completion and produced typed substrate; no refusal happened.
  The substrate is surfaced on the 200 response through
  `verify.state == "failed"` and `verify.assertion.errors[]`, with
  the terminal derivation rule below producing
  `terminal.outcome == "failure"`. Newtron's 409
  `VerificationFailedError` HTTP envelope is consumed by
  newtcon-server's `internal/newtronc/` and re-shaped into the
  same 200-path representation — the substrate flows through the
  typed `data: *WriteResult.verification` field per newtron#21
  rather than through string-parsing the legacy `error` field.
  The 409 status on newtron's wire is a delivery-shape choice for
  HTTP semantic alignment; the substrate underneath is the typed
  `VerificationResult`, and the operator-facing contract here
  surfaces the substrate rather than the wire envelope.
- **`verify.skip_reason`** is populated when `verify.state == "skipped"`.
  Verify is skippable for verbs that wrote no ChangeSet (e.g.,
  `acknowledge`, `clear_zombie`) or when the caller explicitly opted out
  (`no_save` / similar newtron flags); operators must be told which.
- **`verify.verify_url`** is the navigation link to the dedicated
  Provenance endpoint
  [`GET /api/operations/{operation_id}/verify`](#get-apioperationsoperation_idverify),
  which returns the full per-entry assertion diff plus
  interpretation hints. UI clients that poll for verify completion
  use the dedicated endpoint instead of re-fetching the full
  operation trace.
- **`intent.intent_record`** exposes the NEWTRON_INTENT record that the
  operation wrote, in the same shape newtron stores it. Per
  `DESIGN_PRINCIPLES_NEWTRON` §1 and §22, the intent record IS the
  decision substrate; the operator must be able to read it directly,
  not via a digest.
- **`terminal.outcome == "partial"`** is reserved for multi-target
  operator workflows (Composer apply across N targets, Workbench
  commit across N nodes — both delivered by the browser frontend
  over newtrun-server per ADR-0001); per-node operation traces use
  `success` or `failure` only. The aggregate "partial" outcome
  lives on the newtrun-server run state (per-step in
  `EventStepProgress`); the newtcon-server operations store
  surfaces the per-node traces it observed.
- **Terminal-state derivation.** `terminal.outcome == "success"` requires
  every `pipeline.*.stage` ∈ `{complete, skipped}` AND `verify.state` ∈
  `{complete, skipped}` AND (when `verify.state == "complete"`)
  `verify.assertion.failed == 0`. Any `failed` stage or non-zero
  `assertion.failed` produces `terminal.outcome == "failure"`.
- **`retention.source`** is REQUIRED and bounded to the single value
  `"newtcon_operations_store"`. The field is load-bearing on the
  contract even though only one value is ever returned: it makes the
  source-of-truth decision explicit on every response so the
  operator never has to consult external documentation to know
  where the trace came from. A future Contract PR that introduced
  a second source (none is presently anticipated; see "Considered
  alternatives" in newtcon#18's PR body) would extend the enum.
- **`retention.captured_at`** is REQUIRED. The timestamp at which
  newtcon-server wrote this operation into its operations store —
  for terminal operations this is approximately
  `terminal.at`; for in-flight operations this is when the
  initiating state-changing endpoint received newtron's first
  response.
- **`retention.retained_until_at_least`** is REQUIRED. The earliest
  timestamp at which the pruner is permitted to evict this record.
  Computed as `captured_at + deployment_floor_seconds` for terminal
  operations; for in-flight operations it is `captured_at + 7 days`
  per the in-flight floor. Deployments MAY retain longer; this
  field is the floor the contract promises, not a prediction of
  actual eviction. The operator who needs to keep a specific trace
  longer than the floor should export it; this contract does not
  provide a per-operation retention extension primitive (a
  count-based per-operation "pin" would be hidden state per
  `CLAUDE.md` §No Hidden State).
- **`retention.deployment_floor_seconds`** is REQUIRED. Echoes the
  configured retention floor for this newtcon-server. Equal to the
  same field on
  [`GET /api/health`](#get-apihealth)'s `operations_retention`
  companion. Surfacing it on every operation response lets the
  operator see the floor at the point of use, not only at the
  health endpoint — invariant #9 (Confidence and limits are
  explicit) made local to the response.
- **`retention.newtron_rollback_buffer_estimated_status`** is
  REQUIRED and bounded by
  `likely_in_buffer | likely_rolled_out | unknown`. This is an
  honest secondary disclosure about whether newtron's per-Node
  rolling rollback buffer (`DefaultMaxHistory = 10` per
  `DESIGN_PRINCIPLES_NEWTRON.md` §23) still holds the reverse-
  ChangeSet for this operation. The status is **estimated**, not
  authoritative — newtron does not expose a read endpoint for its
  rollback buffer (see "Retention semantics" above), so newtcon-
  server estimates the position by counting the number of
  newtcon-mediated terminal operations on the same Node since this
  one. The `unknown` value is correct and expected when out-of-
  band operations on the Node (writes via a non-newtcon newtron
  client, or substrate edits via direct redis-cli) mean newtcon-
  server cannot bound the position. This disclosure is
  informational; it does NOT affect whether the operation is
  returned by this endpoint — the operation remains addressable
  for the full `retained_until_at_least` window regardless.
- **`retention.newtron_rollback_buffer_position_estimate`** is
  REQUIRED when `newtron_rollback_buffer_estimated_status ==
  "likely_in_buffer"`, OPTIONAL otherwise. The estimated 1-based
  position (1 = most recent) of this operation in the per-Node
  buffer, derived from newtcon's own operations-store count of
  later terminal operations on the same Node.
- **`retention.newtron_rollback_buffer_max_history`** is REQUIRED
  and equal to the per-Node `max_history` setting documented in
  newtron's schema (per
  `../newtron/pkg/newtron/device/sonic/schema.go` —
  `intRange(0, 100)`, with `DefaultMaxHistory = 10` per
  `DESIGN_PRINCIPLES_NEWTRON.md` §23). When the per-Node setting
  has been adjusted, newtcon-server reflects the actual configured
  value here; the default-10 is just the typical value.

**Errors:**
- `operation_id` newtcon-server never minted (unknown ID, stale
  link, ID from a prior data-loss event) → 404 with
  `kind: "precondition_failure"` per §Error Schema, with
  `condition: "operation_unknown_or_expired"` and
  `condition_details: { operation_id }`. `next_action_hint.verb` is
  `inspect_observation_history` and
  `next_action_hint.endpoint` is `/api/history/nodes/{node}` for
  the operation's target Node if the operator can supply it; when
  the Node cannot be inferred from the unknown ID, the hint omits
  the Node scope.
- `operation_id` was minted but the retention window has elapsed
  and the pruner has evicted it → 404 with
  `kind: "precondition_failure"` per §Error Schema, with
  `condition: "operation_evicted"` and
  `condition_details: { operation_id, evicted_at }`.
  `next_action_hint.verb` is `inspect_observation_history` and
  `next_action_hint.endpoint` is
  `/api/history/nodes/{node}?from={evicted_at - 1h}&to={evicted_at + 1h}`
  for the operation's target Node — the substrate diff between
  observations spanning the operation's apply time may still
  reconstruct what changed, even though the per-stage pipeline
  trace itself is gone. The `condition_details.evicted_at` is
  known to the second from the pruner's run record.
- newtron-server unreachable while the operation is still in-flight
  (the operation is in newtcon's operations store with non-terminal
  state and newtcon is unable to poll newtron for terminal-state
  signals such as verify completion) → 503 with
  `kind: "newtron_unavailable"` per §Error Schema.
  `details.last_known.kind` is `"operation_pipeline"` and
  `details.last_known.payload` carries the last-observed pipeline
  snapshot from the operations store; `details.affected_nodes[]`
  lists the Node the operation targets. This case is rare — once
  the synchronous state-changing endpoint returned, the full trace
  is captured in newtcon's store and this endpoint serves
  unconditionally; the 503 path applies only to in-flight
  operations whose terminal-state signals (e.g., a verify
  assertion still in `in_progress` that newtcon polls newtron to
  update) are blocked on newtron reachability.

## Endpoints — Change Workbench (third surface)

**Moved per ADR-0001 rebalance ([`docs/adr/0001-scope-justification-vs-newtrun.md`](docs/adr/0001-scope-justification-vs-newtrun.md)).**
The Change Workbench operator workflow is delivered by the browser
frontend over **newtrun-server**'s scenario substrate. Staging is
"compose a YAML scenario in the browser"; dry-run is
`POST /api/runs/inline` with the scenario opted-out of the
`topology-reconcile` gate and bounded to read-only verbs (newtron
preview-only writes via `topologies?dry_run=true` equivalents);
commit is `POST /api/runs/inline` with the same scenario at full
fidelity; stash is "save the scenario YAML" — either to
newtrun-server's suites via `POST /api/suites` (newtron#33, in
flight) or to operator-side storage; revert is a generated
reverse-scenario per newtron's
`DESIGN_PRINCIPLES_NEWTRON.md` §15 operation pairs.

The atomicity model is preserved verbatim. Per-Node atomicity comes
from newtron's `Lock → snapshot → fn → commit-or-restore → Unlock`
cycle around `cs.Apply` / `ApplyDrift` / `ReplaceAll`, which newtrun
mediates without changing — see [`CLAUDE.md`](CLAUDE.md) §Project
Scope. Multi-Node structured best-effort comes from newtrun's
per-step lifecycle; the per-Node outcome surfaces in the
`EventStepComplete` event with the same per-Node trace the
previously-architected `per_target[]` response carried.

The "no multi-batch atomic rollback" non-goal from
[`docs/architecture.md`](docs/architecture.md) §Non-Goals is
preserved as a property of the substrate, not of this contract.
newtrun-server's revert composition is per-batch, per-Node atomic;
multi-batch sequences are operator-orchestrated as a sequence of
inline-scenario runs, per the same rationale.

Scenario CRUD (`GET / PUT / DELETE /api/suites/{suite}/scenarios/{name}`,
`POST /api/suites`) is in flight upstream as **newtron#33**
(explicitly tagged "newtcon prerequisite" by the newtron lead). The
browser frontend's Workbench depends on it for scenario authorship
without filesystem access on the newtrun host.

The historical contract for this surface — the staging endpoints,
the diff endpoint, the dry-run, the commit/preview pair, the
per-Node atomicity table, the revert preview/apply pair, the stash
endpoints — is preserved in git history at PR #69 (the most recent
merged Contract PR adapting Workbench `/diff` to landed
projection-diff substrate). Future shape questions for the
equivalent newtrun-server surface route through newtron's HTTP API
tracker, not this contract.

## Endpoints — Manual-Mode Parity (teaching surface)

The Manual-Mode Parity surface is **the operator's discovery ground
for the device-level equivalent of any newtron-mediated action.** It
is the contract realization of operator-philosophy invariant #2
("Manual-mode parity") as refined in
[`docs/operator-philosophy.md`](docs/operator-philosophy.md):

> Anything the automation can do, the operator can do by hand using
> their existing tools (ssh + redis-cli + vendor CLI + console)
> directly against the device, **without newtron or newtcon in the
> path**. newtcon's contribution to manual-mode parity is to **teach**
> the device-level equivalent of every automated operation and to
> **expose** the substrate (CONFIG_DB tables, keys, fields, device
> addresses, vendor doc links) so the operator can act independently.
>
> newtcon does NOT provide a "manual mode," an "escape hatch," an
> embedded terminal, or any path that mediates device access. It would
> not be parity if the manual path required newtcon, because newtcon
> being unavailable is one of the failure modes parity exists to
> handle. The manual capability must be in the operator's own tools,
> not in newtcon's affordances.

The reframing — and what it means for the contract. The earlier shape
of this surface (PR #33) was a newtcon-mediated set of state-changing
endpoints: `POST /api/intents/preview` + `POST /api/intents` for
operator-authored raw intent submission, `POST /api/configdb/.../write/preview`
+ `POST /api/configdb/.../write` for direct CONFIG_DB writes, and
`GET /api/manual_decomposition/...` for the step-by-step manual
decomposition of an automated action. The operator review filed as
#9 (reopened 2026-05-26) and the refined invariant #2 in #35 rejected
that shape on a non-negotiable invariant: **if the manual path goes
through newtcon, it does not rehearse the case where newtron and
newtcon are themselves the failure mode.** The autopilot's vendor does
not bundle the yoke; the yoke is part of the aircraft, separate from
the autopilot, so that pilots train on it independently and it
remains operable when the autopilot is gone. ssh + redis-cli + the
vendor CLIs are part of SONiC, not part of newtron or newtcon. The
operator's manual capability lives in those tools, used directly
against the device; newtcon's contribution is to **teach** the
device-level equivalent and **expose** the substrate so the operator
can act independently.

The honest realization of invariant #2 is therefore two-sided:

- **newtcon's contribution: teaching.** This surface exposes teaching
  content that is substrate-grounded — for any service instance, any
  CONFIG_DB key, and a catalog of common day-job manual operations,
  it returns the substrate locator (CONFIG_DB table / key / fields),
  the operator's-own-tools CLI commands to inspect / modify / remove
  the substrate manually, and pointers to vendor documentation for
  the daemons that consume the substrate. The teaching content is
  static, authored by the Architect against newtron's documented
  substrate. It is not a sandbox; it is not a runtime; it is not a
  newtcon-mediated execution path.
- **The operator's contribution: own-tools execution.** The teach
  responses point at the operator's-own-tools workflow: the operator
  opens their ssh session to the device, runs the `redis-cli`,
  `vtysh`, `show`, or `config` commands the teaching content names,
  observes the device's response, and proceeds. newtcon is not in
  the execution path. The operator's existing device-credential
  management governs ssh access; newtcon does not mediate it.

This split matches the refined invariant #6 (Rehearsal): newtcon's
contribution to manual-mode readiness is to teach the substrate; the
operator practices on real tools against real (or full-fidelity-
emulated) devices. Where the Rehearsal surface
([§Endpoints — Rehearsal (teaching surface)](#endpoints--rehearsal-teaching-surface))
teaches named **failure scenarios** as ordered walkthroughs (drift
recovery, zombie cleanup, verify-failure triage), this surface
teaches the **day-job manual equivalent** of any newtron-mediated
action — a discovery surface the operator opens when they want to do
something by hand and need to know how. The two surfaces compose; see
the composition section at the end of this section.

The surface is **read-only**. No endpoint mutates newtron state,
device state, or newtcon-server state. There are no sessions, no
preview/apply pairs, no embedded terminals, no escape hatches. Every
endpoint is `GET`. Every response is teaching content addressable by
ID. The operator copies the CLI commands into their own ssh session
and executes against the device themselves.

### What the surface returns

Three endpoint families, each a read-only `GET`:

- **Service-instance teach** — `GET /api/manual/services/{service}/instances/{network}/{node}/{interface}/teach`.
  "I have service X on this node/interface; teach me the substrate
  it produces and the device-level commands to inspect, modify (with
  appropriate caution about newtron ownership), and remove it by
  hand."
- **CONFIG_DB-key teach** — `GET /api/manual/configdb/{network}/{node}/{table}/{key}/teach`.
  "I'm looking at this CONFIG_DB key; teach me what it represents,
  which daemons consume it, the operator's-own-tools commands to
  read it, and the appropriate caution if I want to write it
  directly."
- **Scenario teach** — `GET /api/manual/scenarios` and
  `GET /api/manual/scenarios/{scenario_id}`. A catalog of common
  day-job manual operations (clearing a stale BGP_NEIGHBOR entry,
  inspecting MAC-learning, etc.) as ordered command sequences the
  operator runs on the device themselves.

Each response carries: substrate locators (CONFIG_DB / NEWTRON_INTENT
addresses) in the same `SubstrateLocator` shape defined by
[§Endpoints — Rehearsal §Field shapes — shared types](#field-shapes--shared-types-used-below);
operator's-own-tools commands in the same `CliCommand` shape; pointers
to vendor and newtron documentation; and a load-bearing
`operator_environment_pointers` block naming what the operator needs
in their own environment (ssh access, redis-cli on the device, etc.).

### How this surface differs from per-operation `cli_command` annotations

Every substrate-operation event in the per-write substrate
(`per_write[*].cli_command` in the §Shared substrate shapes
"PerWrite" carried on §Operations responses, on §Observation History
change records, and on §Report Bug body sections; surfaced live on
newtrun-server's `EventStepProgress` SSE per ADR-0001) already
carries the literal `ssh <device>` + `redis-cli` / `redis-del` /
`redis-hgetall` command that reproduces THAT substrate-operation by
hand. That per-substrate-op annotation is the "this is the
device-level command equivalent to THIS specific write" teaching,
surfaced inline at the moment the operation executes.

The Manual-Mode Parity teaching surface is one level up. It is the
operator's **discovery ground** for the device-level equivalent of an
action the operator wants to perform manually, **before any newtron
operation runs and independent of whether one will**:

- "I have service `transit` on switch1 Ethernet0; teach me how to
  inspect it, modify it, and remove it by hand."
- "I am looking at CONFIG_DB key `BGP_NEIGHBOR|default|10.1.0.1`;
  teach me what it represents, how to read it, and what I would have
  to be careful about if I wrote it directly."
- "I want to manually clear a stale BGP_NEIGHBOR entry the daemons
  are still referencing; teach me the day-job procedure."

Both layers exist because both are needed. The per-substrate-op
annotation teaches "when this stream emitted, here is the command-line
equivalent for the write that just happened." The discovery surface
teaches "before any operation runs, how would I do this by hand at
all?" Operator-philosophy invariant #2 (refined) binds: the operator
must be able to act manually independent of newtron and newtcon;
discovery teaching is necessary so the operator can find the
device-level path without a newtcon stream pointing the way.

### Vocabulary

The surface reuses the shared types defined by
[§Endpoints — Rehearsal (teaching surface)](#endpoints--rehearsal-teaching-surface),
§Field shapes — shared types — `SubstrateLocator` and `CliCommand`.
Neither is re-coined here. The vocabulary of the surface adds three
teaching-content types:

- **Teach response** — the JSON object returned by every `GET` on
  this surface. Carries: the substrate the teaching is grounded in
  (one or more `SubstrateLocator` entries), the daemons that consume
  it, the operator's-own-tools inspect / modify / remove command
  sequences (lists of `CliCommand`), pointers to vendor and newtron
  documentation, and the caution notes the operator should read
  before acting.
- **Scenario** — a named, substrate-grounded day-job manual operation
  (e.g., "Manually clear a stale BGP_NEIGHBOR entry that newtron does
  not know about"). Each scenario carries an ordered sequence of
  `CliCommand` steps with substrate locators and rationale. Scenarios
  are addressable by `scenario_id` and are static teaching content,
  not parameterized by live state.
- **Caution note** — a typed warning attached to teaching content
  whose execution can interact with newtron's ownership of the
  substrate (e.g., "writing to BGP_NEIGHBOR directly will land state
  newtron cannot reconstruct via Replay; the next reconcile may
  remove your change"). Caution notes are substrate-grounded; they
  cite the principle that explains the warning.

Newtron's domain vocabulary is reused throughout (`CONFIG_DB`,
`NEWTRON_INTENT`, `Replay`, `Drift Guard`, `Reconcile`,
`ChangeSet`). No new operator-facing terminology is coined.

### Identifiers

- `scenario_id` — opaque-typed stable string, server-assigned at
  scenario authorship. Stable across newtcon-server restarts; bound
  to the scenario catalog, not to an operator session. Example
  shape: `manually-clear-stale-bgp-neighbor`.

Both teach endpoints addressed by domain identifiers
(`service`, `network`, `node`, `interface`, `table`, `key`) use the
substrate's own vocabulary; no surrogate teach-content ID is minted
for them.

### Static content; no `as_of` envelope; `content_version`

Teaching content is authored by the Architect, not derived from
live newtron state. The surface therefore does NOT carry an `as_of`
field — there is no live observation to time-stamp. Each response
carries a `content_version` (the teach catalog version the response
was authored against). When a substrate-evolution Contract PR retires
teaching content or changes a CLI command, the `content_version`
moves; consumers see the new content on next fetch.

This mirrors the Rehearsal teaching surface's static-content
discipline (see §Endpoints — Rehearsal §Static content). An `as_of`
field would imply the teaching is being computed against observed
state, which would imply newtron-mediated inspection, which is
exactly what the refined invariant #2 rejects.

Note one boundary case: the **service-instance** and **CONFIG_DB-key**
teach endpoints address substrate the operator has named at request
time (a service instance on a node, a CONFIG_DB key on a node). The
endpoints validate that the named substrate has a teach-content
mapping defined in the catalog (e.g., the service spec is known, the
CONFIG_DB table is known), but they **do not query newtron for live
state** to compose the response. The teach content is what newtron's
documented substrate says about the named addresses, not what
newtron's projection currently is. If the operator wants the live
state, they read [§Endpoints — Provenance](#endpoints--provenance-why-mode-surface)
or run the inspection `CliCommand` from the teach response in their
own ssh session.

### `GET /api/manual/services/{service}/instances/{network}/{node}/{interface}/teach`

Return teaching content for an instance of a service on one node and
one interface. Idempotent; safe to poll. No newtron-side state is
mutated; no newtron-side state is read at request time.

The endpoint is addressed by the same identifiers the operator uses
elsewhere — `service` is the service-spec name (e.g., `transit`,
`peering`); `network` / `node` / `interface` are the substrate
addresses. The teach content names the CONFIG_DB substrate the
service's `apply-service` verb writes for an instance at this
address, the daemons that consume that substrate, and the
operator's-own-tools commands for inspecting, modifying, and removing
the substrate by hand.

The endpoint does NOT require that the named service instance
currently exist on the device. The teach content is what the
substrate WOULD look like for the named address, derived from the
service spec; the operator may be asking either because the instance
exists and they want to operate on it, or because they want to know
what hand-applying the service would look like without running an
operation. The discriminator is in the operator's intent, not the
contract.

**Path parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `service` | string | Service-spec name. Must be a service in newtcon's spec catalog (the same catalog `GET /api/services` lists). Unknown → 404 `precondition_failure` with `condition: "service_unknown"`. |
| `network` | string | Network name (same value the operator uses elsewhere). Validated against newtron's network catalog. |
| `node` | string | Node name. Validated against newtron's node catalog. |
| `interface` | string | Interface name on the node. URL-encoded; values like `Ethernet0` are unescaped. |

**Response 200:**
```json
{
  "content_version": "2026-05-26.1",
  "service": "transit",
  "network": "default",
  "node": "switch1",
  "interface": "Ethernet0",
  "service_summary": {
    "name": "transit",
    "summary": "BGP transit peering on a single interface with an upstream provider; renders BGP_NEIGHBOR, INTERFACE, ACL, ROUTE_MAP entries; consumed by bgpd and the SONiC swss daemon.",
    "service_spec_doc_url": "newtron/docs/newtron/specs/service-transit.md"
  },
  "substrate_produced_when_applied": [
    {
      "kind": "configdb_key",
      "network": "default",
      "node": "switch1",
      "table": "BGP_NEIGHBOR",
      "key": "default|<peer-address>",
      "fields_authored_by_service": ["asn", "local_addr", "name"],
      "fields_inferred_from_spec": ["holdtime", "keepalive"],
      "consumed_by_daemon": "bgpd",
      "daemon_doc_url": "https://github.com/sonic-net/SONiC/blob/master/doc/quagga/Quagga-Setup.md"
    },
    {
      "kind": "configdb_key",
      "network": "default",
      "node": "switch1",
      "table": "INTERFACE",
      "key": "Ethernet0|<address>/<prefix>",
      "fields_authored_by_service": ["NULL"],
      "fields_inferred_from_spec": [],
      "consumed_by_daemon": "swss",
      "daemon_doc_url": "https://github.com/sonic-net/sonic-swss/blob/master/doc/swss-readme.md"
    },
    {
      "kind": "intent_record",
      "network": "default",
      "node": "switch1",
      "intent_key": "service|transit|Ethernet0",
      "consumed_by_daemon": null,
      "daemon_doc_url": null
    }
  ],
  "manual_inspect": [
    {
      "tool": "ssh_redis_cli",
      "command": "ssh switch1 redis-cli -n 4 HGETALL 'BGP_NEIGHBOR|default|10.1.0.1'",
      "rationale": "Read the BGP_NEIGHBOR entry bgpd consumes. The asn field carries the upstream peer's ASN; local_addr carries this node's address on the peering link. Substitute the peer address into the key.",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#4-sonic-is-a-database--treat-it-as-one"
      }
    },
    {
      "tool": "ssh_redis_cli",
      "command": "ssh switch1 redis-cli -n 4 HGETALL 'NEWTRON_INTENT|service|transit|Ethernet0'",
      "rationale": "Read the NEWTRON_INTENT record newtron writes when apply-service runs. The resolved_params half carries the values newtron will re-assert on next reconcile. The intent record IS the substrate of newtron's decision.",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/intents.md#intent-record-shape",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object"
      }
    },
    {
      "tool": "ssh_vendor_cli",
      "command": "ssh switch1 vtysh -c 'show ip bgp neighbors'",
      "rationale": "Inspect the live BGP session state (peer up/down, prefixes exchanged, hold timer). This is dataplane-side observation; the CONFIG_DB state above is the control-plane side bgpd reads.",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/hld.md#node-as-device",
        "principle": "docs/operator-philosophy.md#3-the-substrate-is-the-teaching-surface"
      }
    }
  ],
  "manual_modify_in_place_caution": {
    "kind": "newtron_owned_substrate_warning",
    "message": "BGP_NEIGHBOR, INTERFACE, ACL, and ROUTE_MAP entries this service writes are newtron-owned substrate. A direct redis-cli HSET against any of these keys will land state newtron cannot reconstruct via Replay (the change has no corresponding NEWTRON_INTENT update). The next reconcile will treat your change as drift and either revert it or surface it on the Inbox drift card. If you intend to modify the service's substrate, the substrate-faithful path is to issue an apply-service or refresh-service through newtron — see manual_remove below for an example of invoking newtron on the device shell directly.",
    "rationale_ref": {
      "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object"
    }
  },
  "manual_remove": [
    {
      "tool": "ssh_vendor_cli",
      "command": "ssh switch1 newtron switch1 interface Ethernet0 remove-service",
      "rationale": "newtron's own CLI, invoked directly on the device (newtron's CLI binary is installed on the switch). This is the device-level equivalent of newtcon's Composer remove — it writes a tombstone intent and renders the reverse ChangeSet. Use this when newtcon is unreachable but newtron-on-the-device is available; the operator drives newtron from the device shell directly.",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#9-symmetric-operations",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
      }
    },
    {
      "tool": "ssh_redis_cli",
      "command": "ssh switch1 'redis-cli -n 4 DEL BGP_NEIGHBOR|default|10.1.0.1 && redis-cli -n 4 DEL INTERFACE|Ethernet0|10.1.0.0/31 && redis-cli -n 4 DEL NEWTRON_INTENT|service|transit|Ethernet0'",
      "rationale": "Substrate-only removal: HDEL the keys this service authored, including the NEWTRON_INTENT record so newtron's projection-on-next-replay no longer asserts the service. Use ONLY when neither newtcon nor newtron-on-the-device is available; this is the foul-weather floor. After running, run the inspect commands above to confirm the daemons have caught up.",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
      }
    }
  ],
  "operator_environment_pointers": {
    "ssh_access": "You will need ssh access to the device. Device-credential management is owned by your existing operator toolchain (typically the same one that manages newtron-server's access to the device); newtcon does not provision or store device credentials.",
    "redis_cli_on_device": "redis-cli ships with SONiC and is present on every device by default at /usr/bin/redis-cli; CONFIG_DB is at -n 4. No additional installation is required.",
    "vendor_cli_on_device": "vtysh ships with the FRR package in SONiC and is invokable as `vtysh`. SONiC's own `show` and `config` commands are at /usr/bin/sonic-cli equivalents.",
    "see_also_lab_setup": {
      "kind": "rehearsal_walkthrough_pointer",
      "rationale": "If you have not practiced on a lab device before, run the most relevant Rehearsal walkthrough (see /api/rehearsal/walkthroughs) on a lab device you own before issuing these commands on a production node. Rehearsal teaches the substrate; this surface teaches the day-job manual equivalent."
    }
  },
  "see_also": [
    {
      "kind": "browser_workflow",
      "name": "Composer apply for service transit",
      "operator_workflow": "service-composer",
      "rationale": "The newtron-mediated path is delivered by the browser frontend over newtrun-server per ADR-0001: stage the service via Composer; the apply produces the NEWTRON_INTENT record and renders the BGP_NEIGHBOR / INTERFACE / etc. ChangeSet."
    },
    {
      "kind": "rehearsal_walkthrough",
      "walkthrough_id": "drift-bgp-asn-modified-recovery",
      "endpoint": "/api/rehearsal/walkthroughs/drift-bgp-asn-modified-recovery",
      "rationale": "Walkthrough teaching how to detect and recover from an externally-modified asn on this service's BGP_NEIGHBOR entry; practice on a lab device before doing it on production."
    },
    {
      "kind": "newtron_principle",
      "name": "DESIGN_PRINCIPLES_NEWTRON.md §1 — The Node = intent and reality in one object",
      "url": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object",
      "rationale": "Substrate basis for the manual_modify_in_place_caution above: direct CONFIG_DB writes to newtron-owned tables break the intent-and-reality invariant the Node depends on."
    }
  ]
}
```

Field rules:

- **`substrate_produced_when_applied[]`** is the canonical list of
  CONFIG_DB substrate the service's `apply-service` verb writes. Each
  entry is a `SubstrateLocator` (see §Endpoints — Rehearsal §Field
  shapes) extended with `fields_authored_by_service[]` (the fields
  the service explicitly sets), `fields_inferred_from_spec[]` (the
  fields newtron's resolver fills from spec defaults), and
  `consumed_by_daemon` + `daemon_doc_url` for the daemon that reads
  the entry on the device. Per operator-philosophy invariant #3 ("the
  substrate is the teaching surface") and #5 ("why-mode is always
  available"), every substrate entry the service produces is named in
  full; collapsing into "BGP and interface configuration" is a
  contract smell.
- **`manual_inspect[]`** is the operator's-own-tools sequence for
  reading the substrate. Every command is a `CliCommand` (see
  §Endpoints — Rehearsal §Field shapes — shared types). Tools are
  `ssh_redis_cli` or `ssh_vendor_cli` exclusively per the same
  binding as Rehearsal's `forward_cli`; the command never references
  `newtron-server`, `newtcon`, or `newtcon-server` as the point of
  execution. Substituting concrete values
  (`10.1.0.1`, `Ethernet0`) into the command for the requested
  service instance is the teach-content author's job; the consumer
  pastes verbatim, then adapts for their own peering addresses if
  needed.
- **`manual_modify_in_place_caution`** is REQUIRED on every service
  instance teach response. The `kind` enumerates the substrate-level
  warning: `newtron_owned_substrate_warning` for tables newtron owns
  (the modification will be treated as drift),
  `daemon_state_warning` for tables whose direct modification can
  desynchronize daemon state without warning, `dataplane_disruption_warning`
  for fields whose modification can cause control- or
  dataplane-disruption. The `message` is the substrate-grounded
  explanation in the operator's domain language; the `rationale_ref`
  cites the principle. Per operator-philosophy invariants #7 ("errors
  carry the substrate") and #9 ("confidence and limits are
  explicit"), the teaching is honest about what going around newtron
  costs.
- **`manual_remove[]`** is the operator's-own-tools sequence for
  tearing down the service substrate by hand. Per
  `DESIGN_PRINCIPLES_NEWTRON.md` §15 (symmetric operations), every
  service that can be applied can be removed; the teaching content
  surfaces the manual symmetric reverse. Each `CliCommand` carries
  the rationale that distinguishes the foul-weather floor
  (substrate-only HDEL) from the substrate-faithful path
  (`newtron <node> ... remove-service` invoked directly on the
  device shell, which still produces a NEWTRON_INTENT tombstone and
  a rendered reverse ChangeSet — newtron's manual lever on the
  device, not newtcon's mediated path).
- **`operator_environment_pointers`** is REQUIRED on every teach
  response. It names what the operator needs in their own
  environment to execute the commands: ssh access, the tools that
  ship by default on SONiC, and a pointer to the Rehearsal surface
  for lab practice. Per the refined invariant #2, the operator's
  capability is in their own tools; the contract acknowledges what
  those tools are and where they live. A teach response that does
  not name the operator's prerequisite environment is treating
  newtcon as the execution venue, which is exactly what the refined
  invariant rejects.
- **`see_also[]`** cross-links to (a) the newtron-mediated surface
  (Composer apply / refresh / remove) so the operator can compare
  the manual path against the automated one; (b) the relevant
  Rehearsal walkthrough so the operator can practice on a lab
  device; (c) the underlying newtron principle so the operator can
  read the substrate basis directly. Per operator-philosophy
  invariant #5, every teach response surfaces the principle it
  operationalizes.
- **`content_version`** is the monotonically-increasing version
  string of the teach catalog. Same shape and discipline as
  Rehearsal's `content_version`. Consumers caching teach responses
  see a changed `content_version` when any teach content is added,
  removed, or modified.

**Errors:**
- Unknown `service` → 404 with `kind: "precondition_failure"`,
  `condition: "service_unknown"`,
  `condition_details: { service }`,
  `next_action_hint: { verb: "list_services", endpoint: "/api/services" }`.
- Unknown `network` or `node` → 404 with
  `kind: "precondition_failure"` and the appropriate `condition`
  per §Error Schema (`node_unknown`).
- The service exists in the catalog but no teach content has been
  authored against it yet → 404 with
  `kind: "precondition_failure"`,
  `condition: "teach_content_unauthored"`,
  `condition_details: { service, content_version }`,
  `next_action_hint: { verb: "consult_service_spec_directly", endpoint: null, rationale: "the substrate the service produces is documented at <service_spec_doc_url>; teach content for this service is on the authoring backlog" }`.
  Per operator-philosophy invariant #9 ("confidence and limits are
  explicit"), the surface is honest about which services it teaches
  and which it does not.

### `GET /api/manual/configdb/{network}/{node}/{table}/{key}/teach`

Return teaching content for one CONFIG_DB key on one node. Idempotent;
safe to poll. No newtron-side state is mutated; no newtron-side state
is read at request time.

The endpoint is the operator's discovery affordance for "I'm looking
at this CONFIG_DB key; teach me what it represents and how to
interact with it manually." The teach content names what the table
and key represent in SONiC, which daemons consume it, what the fields
mean, the operator's-own-tools commands to read and (when
appropriate) write it, and the load-bearing caution about whether the
table is newtron-owned.

**Path parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `network` | string | Network name. |
| `node` | string | Node name. |
| `table` | string | CONFIG_DB table name. Validated against newtron's known-table catalog (the union of newtron-owned tables and the tables newtron's documentation describes as third-party-managed). |
| `key` | string | CONFIG_DB key inside the table. URL-encoded (Redis `\|` separators in keys are `%7C` on the wire). |

**Response 200:**
```json
{
  "content_version": "2026-05-26.1",
  "network": "default",
  "node": "switch1",
  "table": "BGP_NEIGHBOR",
  "key": "default|10.1.0.1",
  "table_summary": {
    "name": "BGP_NEIGHBOR",
    "summary": "Per-peer BGP neighbor configuration consumed by bgpd. Keys are 'vrf|peer-address'; fields include asn (peer AS), local_addr (this node's address on the peering link), name (operator-facing label), holdtime, keepalive.",
    "table_doc_url": "https://github.com/sonic-net/SONiC/blob/master/doc/swss/swss-config.md#bgp_neighbor"
  },
  "fields_typical": [
    { "field": "asn", "type": "string (numeric ASN, 1-4294967295)", "meaning": "Peer ASN." },
    { "field": "local_addr", "type": "string (IPv4 or IPv6)", "meaning": "This node's address on the peering link." },
    { "field": "name", "type": "string", "meaning": "Operator-facing label, surfaced by show ip bgp summary." },
    { "field": "holdtime", "type": "string (seconds)", "meaning": "BGP hold timer; default 180." },
    { "field": "keepalive", "type": "string (seconds)", "meaning": "BGP keepalive timer; default 60." }
  ],
  "consumed_by_daemons": [
    {
      "daemon": "bgpd",
      "daemon_doc_url": "https://github.com/sonic-net/SONiC/blob/master/doc/quagga/Quagga-Setup.md",
      "rationale": "FRR's bgpd reads BGP_NEIGHBOR via the swss orchestrator; changes propagate to the running BGP session within seconds via vtysh-equivalent reconfiguration."
    }
  ],
  "ownership": {
    "newtron_owned": true,
    "owned_when": "When a NEWTRON_INTENT record exists for the key's owning service (e.g., an apply-service intent for an interface address that resolves to this peer-address), the entry is newtron-owned and asserted on every reconcile. When no owning intent exists, the entry may be operator-authored or third-party-authored; newtron treats it as drift relative to its projection (no intent records the entry).",
    "rationale_ref": {
      "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object"
    }
  },
  "manual_inspect": [
    {
      "tool": "ssh_redis_cli",
      "command": "ssh switch1 redis-cli -n 4 HGETALL 'BGP_NEIGHBOR|default|10.1.0.1'",
      "rationale": "Read all fields of this BGP_NEIGHBOR entry.",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#4-sonic-is-a-database--treat-it-as-one"
      }
    },
    {
      "tool": "ssh_redis_cli",
      "command": "ssh switch1 'redis-cli -n 4 KEYS NEWTRON_INTENT* | xargs -I {} redis-cli -n 4 HGET {} resolved_params | grep -l 10.1.0.1'",
      "rationale": "Find the NEWTRON_INTENT record (if any) whose resolved_params claim ownership of this peer address. If a match is found, the entry is newtron-owned; if none, the entry is drift or operator-authored.",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/intents.md#intent-record-shape",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object"
      }
    },
    {
      "tool": "ssh_vendor_cli",
      "command": "ssh switch1 vtysh -c 'show ip bgp neighbors 10.1.0.1'",
      "rationale": "Inspect bgpd's view of the session (peer state, message counters, prefixes received). This is the dataplane-side observation; the CONFIG_DB entry above is the control-plane input.",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/hld.md#node-as-device",
        "principle": "docs/operator-philosophy.md#3-the-substrate-is-the-teaching-surface"
      }
    }
  ],
  "manual_modify_caution": {
    "kind": "newtron_owned_substrate_warning",
    "message": "BGP_NEIGHBOR is a newtron-owned table when an apply-service intent claims the peer. A direct redis-cli HSET against this key bypasses newtron's intent path: no NEWTRON_INTENT update is produced, so Replay cannot reconstruct your change. The next reconcile will treat your change as drift and either revert it (delta reconcile against the intent's resolved asn) or surface it on the Inbox drift card. If you intend to change this peer's parameters, the substrate-faithful path is to issue refresh-service (newtron will re-resolve and re-render) — see manual_write_if_unavoidable below. If you must write directly (e.g., emergency mitigation when newtron is unavailable), expect drift on the next reconcile; the surface acknowledges this honestly.",
    "rationale_ref": {
      "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object"
    }
  },
  "manual_write_if_unavoidable": [
    {
      "tool": "ssh_vendor_cli",
      "command": "ssh switch1 newtron switch1 interface Ethernet0 refresh-service --param asn=65003",
      "rationale": "Substrate-faithful path: invoke newtron's refresh-service on the device shell; newtron re-resolves spec, updates the NEWTRON_INTENT resolved_params, and renders the new ChangeSet (one BGP_NEIGHBOR HSET, the field-level diff). The intent record stays in sync; the next reconcile is a no-op. Use this whenever newtron-on-the-device is reachable.",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#9-symmetric-operations",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object"
      }
    },
    {
      "tool": "ssh_redis_cli",
      "command": "ssh switch1 redis-cli -n 4 HSET 'BGP_NEIGHBOR|default|10.1.0.1' asn 65003",
      "rationale": "Foul-weather direct write: HSET the field. The change lands; bgpd picks it up within seconds; the NEWTRON_INTENT record is now stale (resolved_params still says the old asn). On the next reconcile, newtron treats this as drift; you must follow up with refresh-service (above) once newtron is reachable, or accept the drift card the Inbox will surface. Use ONLY when newtron-on-the-device is unreachable.",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
        "principle": "docs/operator-philosophy.md#2-manual-mode-parity"
      }
    }
  ],
  "manual_delete_if_unavoidable": [
    {
      "tool": "ssh_redis_cli",
      "command": "ssh switch1 redis-cli -n 4 DEL 'BGP_NEIGHBOR|default|10.1.0.1'",
      "rationale": "Delete the entry; bgpd tears down the session within seconds. If a NEWTRON_INTENT record still claims this peer, the next reconcile will recreate the entry. To remove the entry permanently, run the service's remove-service on the device shell (see /api/manual/services/<service>/instances/.../teach for the service-instance teach).",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
      }
    }
  ],
  "operator_environment_pointers": {
    "ssh_access": "You will need ssh access to the device. Device-credential management is owned by your existing operator toolchain; newtcon does not provision or store device credentials.",
    "redis_cli_on_device": "redis-cli ships with SONiC at /usr/bin/redis-cli; CONFIG_DB is at -n 4.",
    "vendor_cli_on_device": "vtysh ships with FRR in SONiC.",
    "see_also_lab_setup": {
      "kind": "rehearsal_walkthrough_pointer",
      "rationale": "If you have not practiced writes to this table on a lab device, run the most relevant Rehearsal walkthrough (see /api/rehearsal/walkthroughs?category=drift) on a lab device you own before writing to this key on a production node."
    }
  },
  "see_also": [
    {
      "kind": "newtcon_surface",
      "name": "Provenance — projection for this node",
      "endpoint": "/api/projection/nodes/switch1",
      "rationale": "Read what newtron's projection says this key SHOULD contain right now (the resolved_params derived from intent replay). Compare against the redis-cli HGETALL output to spot drift."
    },
    {
      "kind": "rehearsal_walkthrough",
      "walkthrough_id": "drift-bgp-asn-modified-recovery",
      "endpoint": "/api/rehearsal/walkthroughs/drift-bgp-asn-modified-recovery",
      "rationale": "Walkthrough teaching the substrate-mechanics of drift on this exact table; practice before writing manually."
    },
    {
      "kind": "newtron_principle",
      "name": "DESIGN_PRINCIPLES_NEWTRON.md §1",
      "url": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object",
      "rationale": "Substrate basis for the manual_modify_caution: the Node holds intent AND reality in one object; a write that bypasses the intent path breaks the invariant."
    }
  ]
}
```

Field rules:

- **`table_summary`** is the substrate-grounded description of what
  the table represents and which daemons consume it. The
  `table_doc_url` points at SONiC's own documentation; the surface
  does not paraphrase what SONiC already documents.
- **`fields_typical[]`** is the catalog-known field shape. Per
  operator-philosophy invariant #1 ("no black boxes"), every field
  the operator might read or write is named. Empty
  `fields_typical[]` is admissible only for opaque tables where the
  field shape is operator-domain-specific (third-party tables
  newtron's catalog does not characterize); in that case
  `fields_typical[]` is omitted entirely and `table_summary.summary`
  acknowledges the gap.
- **`consumed_by_daemons[]`** names every daemon that reads the
  entry, with documentation pointers. Per operator-philosophy
  invariant #3 ("the substrate is the teaching surface"), the
  operator who reads this teach must come away knowing which
  daemons are downstream of a write to this key.
- **`ownership`** is the load-bearing field for the operator's
  decision about how to write. `newtron_owned: true` triggers the
  `manual_modify_caution` (writing directly bypasses the intent
  path); `newtron_owned: false` removes the caution but the surface
  still names the daemon-state warning if appropriate. The
  `owned_when` field is the substrate-grounded explanation of when
  ownership applies (typically: when an intent record claims the
  key).
- **`manual_inspect[]`** mirrors the service-instance teach's
  inspect block: read both the CONFIG_DB entry and (when relevant)
  the corresponding NEWTRON_INTENT record so the operator sees both
  halves of the substrate.
- **`manual_modify_caution`** is REQUIRED on every teach response.
  Its `kind` is one of the bounded enum (`newtron_owned_substrate_warning`,
  `daemon_state_warning`, `dataplane_disruption_warning`,
  `no_warning_applicable`). `no_warning_applicable` is reserved for
  tables newtron neither owns nor reads (operator-side custom
  tables); even then, the rationale documents why no warning
  applies.
- **`manual_write_if_unavoidable[]`** is the two-tier teaching: the
  substrate-faithful path first (`newtron` on the device shell, when
  newtron-on-the-device is available), then the foul-weather direct
  HSET path. The ordering is intentional — operator-philosophy
  invariant #9 ("confidence and limits are explicit") binds: the
  surface teaches the right path first and the floor path second,
  with explicit acknowledgment that the floor produces drift the
  operator must reconcile later.
- **`manual_delete_if_unavoidable[]`** is the symmetric counterpart
  for removal. Notably, the surface does NOT recommend a foul-
  weather direct DEL as the primary delete path — for newtron-owned
  tables, the substrate-faithful delete is the service's
  remove-service (cross-linked); the direct DEL is named because
  the operator needs to know it exists, but the teach steers them to
  the service-instance teach for the canonical removal.
- **`see_also[]`** cross-links to Provenance (so the operator can
  read newtron's projection for the same key), to a relevant
  Rehearsal walkthrough (so the operator can practice writes to
  this table-class on a lab device), and to the substrate principle.

**Errors:**
- Unknown `network` or `node` → 404 with
  `kind: "precondition_failure"` and `condition: "node_unknown"` per
  §Error Schema.
- The table is not in newtron's known-table catalog → 404 with
  `kind: "precondition_failure"`,
  `condition: "table_unknown"`,
  `condition_details: { network, node, table }`,
  `next_action_hint: { verb: "consult_sonic_swss_config_doc", endpoint: null, rationale: "SONiC's swss documentation enumerates CONFIG_DB tables; if the table exists in SONiC but is not in newtron's catalog, teach content for it has not been authored" }`.
  Per operator-philosophy invariant #9, the surface is honest about
  the boundaries of what it teaches.
- The table is known but no teach content has been authored against
  it yet → 404 with
  `kind: "precondition_failure"`,
  `condition: "teach_content_unauthored"`,
  `condition_details: { table, content_version }`,
  `next_action_hint: { verb: "consult_table_documentation_directly", endpoint: null, rationale: "the table is documented in SONiC's swss config doc; teach content for this table is on the authoring backlog" }`.

### `GET /api/manual/scenarios`

List the available manual-operation scenarios. Idempotent; safe to
poll. Returns the catalog summary; per-scenario detail is at
[`GET /api/manual/scenarios/{scenario_id}`](#get-apimanualscenariosscenario_id).

Scenarios cover common day-job manual operations the operator runs
against the device directly — clearing a stale BGP neighbor entry,
inspecting MAC-learning state, force-clearing a daemon's transient
cache, capturing a packet on a transit interface. They are NOT
failure-recovery walkthroughs — those live in
[§Endpoints — Rehearsal](#endpoints--rehearsal-teaching-surface). The
two surfaces compose: Rehearsal teaches failure-scenario walkthroughs
the operator practices on a lab device; this surface teaches day-job
manual operations the operator runs on the device (lab or production)
as part of normal hand-operation.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `category` | string | _omitted_ | Filter to one category. One of `bgp`, `interface`, `vlan`, `vrf`, `mac_learning`, `dataplane_inspection`. Unknown → 400 `validation_failure`. |

**Response 200:**
```json
{
  "content_version": "2026-05-26.1",
  "categories": [
    { "category": "bgp", "name": "BGP manual operations", "scenario_count": 3 },
    { "category": "interface", "name": "Interface manual operations", "scenario_count": 2 },
    { "category": "vlan", "name": "VLAN manual operations", "scenario_count": 1 },
    { "category": "mac_learning", "name": "MAC-learning inspection", "scenario_count": 2 },
    { "category": "dataplane_inspection", "name": "Dataplane inspection", "scenario_count": 2 }
  ],
  "scenarios": [
    {
      "scenario_id": "manually-clear-stale-bgp-neighbor",
      "category": "bgp",
      "name": "Manually clear a stale BGP_NEIGHBOR entry",
      "summary": "A BGP_NEIGHBOR entry persists in CONFIG_DB after the peer is gone (no intent claims it; bgpd is still trying to dial). Inspect, confirm staleness against the intent DB, delete the CONFIG_DB key, confirm bgpd has dropped the peer.",
      "estimated_reading_time": "PT5M",
      "step_count": 4,
      "teaches": [
        "How to identify a CONFIG_DB entry with no owning intent record",
        "How to read bgpd's view of a peer via vtysh",
        "How a DEL on BGP_NEIGHBOR propagates to bgpd's session state"
      ]
    },
    {
      "scenario_id": "manually-inspect-mac-learning",
      "category": "mac_learning",
      "name": "Manually inspect MAC-learning on a VLAN interface",
      "summary": "Read the FDB_TABLE entries for a VLAN; correlate against the operator-facing port for each MAC; confirm the dataplane FDB matches via show mac-address-table.",
      "estimated_reading_time": "PT3M",
      "step_count": 3,
      "teaches": [
        "FDB_TABLE structure and keys",
        "Where MAC-learning lives in the control vs dataplane split"
      ]
    }
  ]
}
```

Field rules:

- **`scenarios[]`** is the scenario catalog. Order is stable within
  category for a given `content_version`. Each scenario carries the
  same summary fields as a Rehearsal walkthrough summary (name,
  summary, estimated_reading_time, step_count, teaches[]).
- **`teaches[]`** is substrate-grounded per operator-philosophy
  invariant #3. Empty or generic `teaches[]` is a contract smell
  rejected by the Architecture Reviewer.

**Errors:**
- Unknown `category` → 400 `validation_failure` with
  `details.rejections[*].reason == "unknown_value"` and
  `details.rejections[*].allowed` carrying the bounded enum.

### `GET /api/manual/scenarios/{scenario_id}`

Return the full scenario teaching content — every step, every CLI
command, the substrate locators. Idempotent; safe to poll. No
newtron-side state is mutated.

**Response 200:**
```json
{
  "content_version": "2026-05-26.1",
  "scenario_id": "manually-clear-stale-bgp-neighbor",
  "category": "bgp",
  "name": "Manually clear a stale BGP_NEIGHBOR entry",
  "summary": "A BGP_NEIGHBOR entry persists in CONFIG_DB after the peer is gone (no intent claims it; bgpd is still trying to dial). Inspect, confirm staleness against the intent DB, delete the CONFIG_DB key, confirm bgpd has dropped the peer.",
  "teaches": [
    "How to identify a CONFIG_DB entry with no owning intent record",
    "How to read bgpd's view of a peer via vtysh",
    "How a DEL on BGP_NEIGHBOR propagates to bgpd's session state"
  ],
  "teaches_rationale_ref": {
    "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
    "principle": "docs/operator-philosophy.md#2-manual-mode-parity"
  },
  "prerequisites": {
    "operator_tooling": [
      "ssh access to the device",
      "redis-cli (default in SONiC)",
      "vtysh (default in SONiC)"
    ],
    "starting_state_description": "Device has at least one BGP_NEIGHBOR entry whose peer is unreachable; bgpd's connection state shows Active or Idle for that peer.",
    "out_of_scope": [
      "Re-establishing the peer (this scenario is about clearing the stale entry, not provisioning a new one — for that, use Composer apply-service)",
      "Multi-Node coordination (this scenario is per-Node manual cleanup)"
    ]
  },
  "operator_environment_pointers": {
    "ssh_access": "You will need ssh access to the device. Device-credential management is owned by your existing operator toolchain.",
    "redis_cli_on_device": "redis-cli ships with SONiC at /usr/bin/redis-cli; CONFIG_DB is at -n 4.",
    "vendor_cli_on_device": "vtysh ships with FRR in SONiC.",
    "newtcon_not_required": "All steps run via ssh + redis-cli or ssh + vtysh against the device directly. newtcon's role in this scenario is to TEACH the steps; the operator EXECUTES them on their own tools."
  },
  "steps": [
    {
      "step_number": 1,
      "name": "Identify the candidate stale entry",
      "purpose": "List BGP_NEIGHBOR entries on the device. Identify the entry whose peer you suspect is stale.",
      "purpose_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#4-sonic-is-a-database--treat-it-as-one"
      },
      "starting_substrate": [
        {
          "kind": "configdb_key",
          "network": "default",
          "node": "switch1",
          "table": "BGP_NEIGHBOR",
          "key": "*"
        }
      ],
      "forward_cli": [
        {
          "tool": "ssh_redis_cli",
          "command": "ssh switch1 redis-cli -n 4 KEYS 'BGP_NEIGHBOR|*'",
          "rationale": "Enumerate the BGP_NEIGHBOR entries; identify the one matching the suspect peer address.",
          "rationale_ref": {
            "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
            "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#4-sonic-is-a-database--treat-it-as-one"
          }
        }
      ],
      "reverse_cli": [],
      "reverse_cli_rationale": "Read-only step; no reverse needed.",
      "verify_step_completion": {
        "what_to_check": "The output lists at least one BGP_NEIGHBOR key. Capture the key for the suspect peer.",
        "if_missing": "If no BGP_NEIGHBOR entries exist, there is no stale entry to clear; the scenario does not apply."
      }
    },
    {
      "step_number": 2,
      "name": "Confirm staleness against the intent DB",
      "purpose": "Check whether a NEWTRON_INTENT record claims this peer. If none does, the entry is stale relative to newtron's authoritative substrate.",
      "purpose_rationale_ref": {
        "substrate": "newtron/docs/newtron/intents.md#intent-record-shape",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object"
      },
      "starting_substrate": [
        {
          "kind": "intent_record",
          "network": "default",
          "node": "switch1",
          "intent_key": "service|*"
        }
      ],
      "forward_cli": [
        {
          "tool": "ssh_redis_cli",
          "command": "ssh switch1 'redis-cli -n 4 KEYS NEWTRON_INTENT* | xargs -I {} redis-cli -n 4 HGET {} resolved_params | grep 10.1.0.1'",
          "rationale": "Search the NEWTRON_INTENT records for any whose resolved_params reference the suspect peer address. If grep returns nothing, no intent claims the peer; the BGP_NEIGHBOR entry is stale.",
          "rationale_ref": {
            "substrate": "newtron/docs/newtron/intents.md#intent-record-shape",
            "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object"
          }
        }
      ],
      "reverse_cli": [],
      "reverse_cli_rationale": "Read-only step; no reverse needed.",
      "verify_step_completion": {
        "what_to_check": "grep returns no matches. If it does, an intent record DOES claim the peer; the entry is not stale, and you should reconsider whether deletion is appropriate (use Composer remove-service instead).",
        "if_missing": "If grep finds a match, halt; the entry is owned. Use the service-instance teach (/api/manual/services/<service>/instances/.../teach) for the substrate-faithful removal path."
      }
    },
    {
      "step_number": 3,
      "name": "Delete the stale entry",
      "purpose": "Remove the CONFIG_DB key. bgpd will drop the peer's session within seconds.",
      "purpose_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
      },
      "starting_substrate": [
        {
          "kind": "configdb_key",
          "network": "default",
          "node": "switch1",
          "table": "BGP_NEIGHBOR",
          "key": "default|10.1.0.1"
        }
      ],
      "forward_cli": [
        {
          "tool": "ssh_redis_cli",
          "command": "ssh switch1 redis-cli -n 4 DEL 'BGP_NEIGHBOR|default|10.1.0.1'",
          "rationale": "Delete the stale entry. bgpd's swss listener sees the deletion and tears down the session.",
          "rationale_ref": {
            "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
            "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
          }
        }
      ],
      "reverse_cli": [
        {
          "tool": "ssh_redis_cli",
          "command": "ssh switch1 redis-cli -n 4 HSET 'BGP_NEIGHBOR|default|10.1.0.1' asn <captured-from-step-1> local_addr <captured-from-step-1> name <captured-from-step-1>",
          "rationale": "Restore the entry from the fields you captured in step 1, if you decide to back out the deletion. Bgpd will re-attempt the peer.",
          "rationale_ref": {
            "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
            "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
          }
        }
      ],
      "reverse_cli_rationale": "Symmetric reverse: the entry can be restored by HSET-ing the captured fields. In production manual operations, the reverse is the safety net for an operator who deletes the wrong key.",
      "verify_step_completion": {
        "what_to_check": "redis-cli HGETALL on the key returns empty. Proceed to step 4.",
        "if_missing": "If the DEL returned an error, redis-cli could not write; diagnose ssh / redis-cli access before continuing."
      }
    },
    {
      "step_number": 4,
      "name": "Confirm bgpd has dropped the peer",
      "purpose": "Verify the session is gone from bgpd's view.",
      "purpose_rationale_ref": {
        "substrate": "newtron/docs/newtron/hld.md#node-as-device",
        "principle": "docs/operator-philosophy.md#3-the-substrate-is-the-teaching-surface"
      },
      "starting_substrate": [
        {
          "kind": "configdb_key",
          "network": "default",
          "node": "switch1",
          "table": "BGP_NEIGHBOR",
          "key": "default|10.1.0.1"
        }
      ],
      "forward_cli": [
        {
          "tool": "ssh_vendor_cli",
          "command": "ssh switch1 vtysh -c 'show ip bgp summary'",
          "rationale": "List bgpd's active peers. The deleted peer should be absent from the summary.",
          "rationale_ref": {
            "substrate": "newtron/docs/newtron/hld.md#node-as-device",
            "principle": "docs/operator-philosophy.md#3-the-substrate-is-the-teaching-surface"
          }
        }
      ],
      "reverse_cli": [],
      "reverse_cli_rationale": "Read-only step; no reverse needed.",
      "verify_step_completion": {
        "what_to_check": "The deleted peer is absent from the summary. The cleanup is complete.",
        "if_missing": "If bgpd still lists the peer, give it 5-10 seconds (swss propagation latency) and retry. If it persists, bgpd may need a restart — escalate per your operator runbook."
      }
    }
  ],
  "step_count": 4,
  "see_also": [
    {
      "kind": "browser_workflow",
      "name": "Composer remove-service",
      "operator_workflow": "service-composer",
      "rationale": "The newtron-mediated path is delivered by the browser frontend over newtrun-server per ADR-0001: when the entry IS owned by an intent, the substrate-faithful removal is remove-service through Composer. Use this scenario only when no intent claims the entry."
    },
    {
      "kind": "rehearsal_walkthrough",
      "walkthrough_id": "zombie-apply-service-crash-recovery",
      "endpoint": "/api/rehearsal/walkthroughs/zombie-apply-service-crash-recovery",
      "rationale": "Adjacent failure scenario: an apply-service crashed mid-Deliver and left a partial substrate. The Rehearsal walkthrough teaches the recovery; practice on a lab device."
    },
    {
      "kind": "newtron_principle",
      "name": "DESIGN_PRINCIPLES_NEWTRON.md §1",
      "url": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object",
      "rationale": "The substrate basis for distinguishing stale (no intent claims it) from owned (an intent does)."
    }
  ]
}
```

Field rules:

- **`steps[]`** uses the same step shape as Rehearsal walkthrough
  steps: `step_number`, `name`, `purpose`, `purpose_rationale_ref`,
  `starting_substrate[]`, `forward_cli[]`, `reverse_cli[]`,
  `reverse_cli_rationale`, `verify_step_completion`. The shapes are
  identical so the frontend reuses Rehearsal's renderers; the
  difference is the surface's intent (day-job manual operation vs
  failure-scenario walkthrough).
- **`forward_cli[*]`** is a `CliCommand` (see §Endpoints — Rehearsal
  §Field shapes). Tools are `ssh_redis_cli` or `ssh_vendor_cli`
  exclusively; commands never reference `newtron-server`, `newtcon`,
  or `newtcon-server` as the point of execution. (Invoking
  `newtron` as a command on the device shell is permitted where
  newtron-on-the-device is the substrate-faithful path — see Hard
  contract guarantees below.)
- **`reverse_cli[]`** is REQUIRED for mutating steps. Read-only steps
  (inspect, confirm) populate an empty `reverse_cli[]` with a
  `reverse_cli_rationale` of "Read-only step; no reverse needed."
- **`operator_environment_pointers`** is REQUIRED. The
  `newtcon_not_required` assertion is load-bearing per the refined
  invariant #2.

**Errors:**
- Unknown `scenario_id` → 404 with
  `kind: "precondition_failure"`,
  `condition: "scenario_unknown"`,
  `condition_details: { scenario_id }`,
  `next_action_hint: { verb: "list_scenarios", endpoint: "/api/manual/scenarios" }`.

### Composes with the Rehearsal teaching surface

The Manual-Mode Parity teaching surface and the Rehearsal teaching
surface are the two halves of how newtcon honors invariants #2 and
#6, and they compose without overlap:

- **The Manual-Mode Parity teaching surface (this section) teaches
  the day-job manual equivalent.** "I need to know how to do X by
  hand right now — teach me the device-level path." The operator
  reads the teach response, then executes on their own tools against
  the device (production or lab).
- **The Rehearsal teaching surface
  ([§Endpoints — Rehearsal](#endpoints--rehearsal-teaching-surface))
  teaches failure-scenario walkthroughs the operator practices on a
  lab device.** "I want to be ready for the next time drift / a
  zombie / a verify failure happens — let me walk through the
  recovery on a lab device first." The operator reads the
  walkthrough, then executes on a lab device they own.

The two surfaces share vocabulary (`SubstrateLocator`, `CliCommand`)
and discipline (static content, `content_version`, no `as_of`, no
state mutation, no embedded terminal, CLI commands target the
operator's own tools). They share cross-references — every teach
response's `see_also[]` may link to a Rehearsal walkthrough, and
every walkthrough's `see_also[]` may link to a manual-mode teach
endpoint. They do not share endpoints, do not share IDs, and do not
share request shapes — the surfaces are different because the
operator's question is different.

Per the refined operator-philosophy invariant #2 (manual-mode parity
lives in the operator's own tools, not in newtcon's affordances) and
the reframed invariant #6 (rehearsal must rehearse the case where
newtron is the failure mode), there is no newtcon-mediated execution
path on either surface. The operator runs commands on their own ssh
session against the device; newtcon teaches.

### What this surface does not do (binding)

The Manual-Mode Parity teaching surface explicitly excludes the
following shapes. They are not deferred-for-later; they are excluded
by the refined invariant #2.

1. **No state-changing endpoints.** Every endpoint is `GET`. There is
   no `POST /api/intents`, no `POST /api/configdb/.../write`, no
   preview/apply pair, no `commit`, no `revert`. The earlier shape
   (PR #33) had these endpoints; they are removed by this rewrite.
   A contributor proposing a state-changing endpoint on this surface
   is making the case for re-introducing the newtcon-mediated manual
   lever; the Architecture Reviewer rejects on principle.
2. **No embedded terminal.** No endpoint streams a shell session,
   accepts shell input, executes shell commands on the operator's
   behalf, or otherwise mediates terminal access to the device.
   newtcon does not provide the terminal because newtcon being
   unavailable is one of the failure modes parity exists to handle.
   The operator's ssh client is the terminal.
3. **No escape hatch.** No flag, no operator-attestation field, no
   "advanced mode" toggle re-enables newtcon-mediated state changes.
   The refined invariant #2 admits no exception: the manual capability
   is in the operator's own tools, end of statement.
4. **No newtcon-mediated decomposition execution.** The earlier shape
   exposed `GET /api/manual_decomposition/...` returning a
   step-by-step decomposition annotated with `newtcon_endpoint`
   pointers ("the operator would issue POST /api/intents/preview for
   each step"). That shape is removed. The teach responses on this
   surface name `CliCommand` steps the operator executes themselves;
   there is no newtcon endpoint in the loop.
5. **No live state in the teach response.** Teach responses do not
   carry an `as_of` field, do not include the current value of any
   CONFIG_DB entry, do not include the current state of any intent
   record, and do not query newtron at request time. The teach is
   what the substrate's documentation says; the live state is at
   [§Endpoints — Provenance](#endpoints--provenance-why-mode-surface)
   or in the operator's own redis-cli output.

### Out of scope for v0 (deferred Contract PRs)

The following extensions are deliberately deferred. They are NOT a
return to the newtcon-mediated manual surface — they are extensions
to the teaching that preserve the read-only, no-newtcon-mediation
discipline.

- **Operator-authored teach content and scenarios.** v0 teach content
  is curated by the Architect. Operator-authored scenarios (saved
  day-job procedures, parameter-templated commands, shareable
  teach libraries) require an authoring surface and are deferred.
  The deferred shape is still read-only on consume; only the
  authoring path differs.
- **Per-table teach catalog coverage.** v0 teaches a starter set of
  CONFIG_DB tables (the ones the curated services produce, plus
  the high-value third-party tables operators commonly encounter).
  Broadening coverage to every CONFIG_DB table SONiC defines is
  authoring work that lands incrementally; the `teach_content_unauthored`
  error is the honest acknowledgment of the coverage frontier.
- **Diff-against-history affordance.** Comparing the live CONFIG_DB
  entry against newtcon's recorded observation history (so the
  operator sees "what changed since last week" while reading the
  teach) is a composition with the
  [§Endpoints — Observation History](#endpoints--observation-history)
  surface; the composition UI is deferred. The two surfaces are
  composable at the client today (the consumer can call both in
  parallel and stitch); a server-side composition affordance is a
  follow-up Contract PR.
- **Inline rehearsal-walkthrough launch.** The teach `see_also[]`
  links to Rehearsal walkthroughs; an inline embedding ("read the
  walkthrough's first step here without leaving this page") is a
  rendering convenience deferred to the frontend, not a contract
  shape.

### Hard contract guarantees (binding)

Every endpoint in this section MUST satisfy:

1. **Read-only.** Every endpoint is `GET`. No endpoint mutates
   newtron state, device state, or newtcon-server state. A
   contributor proposing a `POST` on this surface is making the case
   for re-introducing the newtcon-mediated manual lever; the
   Architecture Reviewer rejects on principle.
2. **Static content, no live observation.** Teach responses do not
   query newtron's live state. No `as_of`, no `intent_count`, no
   `projection_rebuilt_at` on this surface. The catalog is versioned
   by `content_version`.
3. **CLI commands target the operator's own tools, never newtcon.**
   Every `CliCommand` in `manual_inspect[]`, `manual_remove[]`,
   `manual_write_if_unavoidable[]`, `manual_delete_if_unavoidable[]`,
   and `steps[*].forward_cli[]` / `steps[*].reverse_cli[]` uses
   `ssh_redis_cli` or `ssh_vendor_cli` exclusively. The `command`
   string MUST NOT reference `newtron-server`, `newtcon`,
   `newtcon-server`, or any newtcon HTTP endpoint as the point of
   execution. The `command` MAY invoke `newtron` as a command name
   on the device shell when newtron-on-the-device is the
   substrate-faithful path (e.g., `ssh switch1 newtron switch1
   interface Ethernet0 refresh-service`); this is newtron's own
   manual lever, not a newtcon-mediated path. The operator's own ssh
   session is the execution venue; newtcon is the teacher.
4. **Operator-environment pointers on every teach response.**
   `operator_environment_pointers` is REQUIRED. The reframed
   invariant #2 demands the operator's manual capability live in
   their own tools; a teach response that does not name the
   operator's prerequisite environment is implicitly assuming
   newtcon-as-execution, which is exactly what the invariant
   rejects.
5. **Substrate-grounded teaching.** Every teach response's
   `teaches[]` (where applicable), `substrate_produced_when_applied[]`,
   `consumed_by_daemons[]`, `fields_typical[]`, and per-`CliCommand`
   `rationale` is substrate-grounded. `rationale_ref` always points
   at a concrete document section, never at a generic statement. Per
   operator-philosophy invariants #3 ("the substrate is the teaching
   surface") and #5 ("why-mode is always available"), the teaching
   is in the substrate's own vocabulary, not in a parallel
   newtcon-coined abstraction.
6. **Honest caution on writes to newtron-owned substrate.** Every
   teach endpoint that names a `manual_modify_*` or
   `manual_write_if_unavoidable` block MUST include the
   newtron-ownership warning where applicable. Per operator-
   philosophy invariants #7 ("errors carry the substrate") and #9
   ("confidence and limits are explicit"), the teach is honest about
   what bypassing newtron's intent path costs (drift on the next
   reconcile, divergence between intent records and reality). A
   teach response that names a direct write without the warning is
   a contract violation.
7. **Symmetric reverse per §15 on mutating content.** Every
   `manual_remove[]`, `manual_write_if_unavoidable[]`, and
   `steps[*].forward_cli[]` for mutating steps either includes a
   `reverse_cli[]` (or `manual_delete_if_unavoidable[]` /
   equivalent symmetric block) OR includes a
   `reverse_cli_rationale` / equivalent explaining why no reverse
   exists (e.g., baseline operations whose reverse is reconcile per
   `DESIGN_PRINCIPLES_NEWTRON.md` §15). A teach that proposes a
   destructive command without a reverse path is rejected on §15
   grounds.

## Endpoints — Provenance (why-mode surface)

**Sharpening deferred per ADR-0001 rebalance ([`docs/adr/0001-scope-justification-vs-newtrun.md`](docs/adr/0001-scope-justification-vs-newtrun.md)).**
Provenance is the **borderline-bucket** surface from ADR-0001's substrate
analysis: read-only inspection of newtron's intent records, projection,
ChangeSets, and verify assertions, where the newtcon-server contribution is
HTTP-shape ergonomics for a browser. Per the operator verdict, the final
disposition is deferred until the unique-bucket implementation (Observation
History + Report Bug) matures and sharpens the right call: most likely a
thin proxy in front of newtron's intent / projection / changeset reads,
with cross-reference fields (`changeset_url`, `intent_url`,
`operation_url`) and stable retention semantics — but the precise shape
will follow the substrate. The endpoints documented in this section
remain the canonical specification of the operator-facing surface; the
underlying implementation may sharpen to thin-proxy or stay as currently
specified, with no operator-facing change.

The Provenance endpoints expose newtron's **substrate** as a
navigable, queryable surface. Every other endpoint in this contract
returns operator-facing shapes (cards, batches, ChangeSet previews);
this surface returns the underlying intent records, projection
rows, ChangeSet artifacts, and verify assertions that those shapes
are derived from. Operator-philosophy invariants #1 ("no black
boxes") and #5 ("why-mode is always available") make this surface
load-bearing, not optional: without it, every other surface is a
digest the operator cannot click through.

The surface is read-only. No endpoint here mutates newtron state or
newtcon-server state. All endpoints are idempotent and safe to poll.

### Identifiers and resolution

The Provenance surface uses opaque IDs already minted by other
surfaces:

| ID | Minted by | Resolves to (internally, opaque to consumer) |
|----|-----------|---------------------------------------------|
| `intent_id` | Every state-changing operator workflow that writes a NEWTRON_INTENT record — Service Composer apply, Workbench commit, Inbox action (all delivered by the browser frontend over newtrun-server per ADR-0001) — the ID is minted by the underlying newtron RPC and observed by newtcon-server through newtrun-server's run state | `(network, node, resource_key)` — the addressing tuple newtron uses for an intent record |
| `operation_id` | Minted by newtcon-server's operations store (see §Endpoints — Operations capture path) when it records an observed operation from newtrun-server's `EventStepProgress` substrate | `(network, node, operation_sequence)` — the addressing tuple newtcon-server uses for an operation trace |
| `changeset_id` | Per `operation_id`, one or more `changeset_id`s — one per per-Node bundle the operation rendered. Minted by newtcon-server alongside `operation_id` from the observed substrate. | `(operation_id, per_node_sequence)` |

The structure of an ID is an implementation concern of
newtcon-server; consumers MUST treat all IDs as opaque. The mapping
table above is documentation of provenance, not a wire contract.

`intent_id`, `operation_id`, and `changeset_id` are surfaced as link
fields throughout the rest of the contract (`intent_url` on
operation traces, `operation_url` on Observation History changes,
`changeset_url` on Report Bug substrate blocks, etc.). Provenance
endpoints are the targets of those links. Every shape that exposes
one of these IDs MUST also expose its `*_url` companion so the UI
follows-the-link without constructing paths from opaque IDs (the
contract owns URL construction).

### Retention

Provenance retention mirrors operations retention:

- **Intent records** are stored in newtron CONFIG_DB and persist for
  the life of the resource (`DESIGN_PRINCIPLES_NEWTRON.md` §1, §23).
  An `intent_id` that resolves to a since-deleted resource returns
  404 with `details.reason: "intent_resolved"` (the underlying
  intent was reversed; it no longer exists on the device).
  newtcon-server does not cache intent records — every read is a
  fresh newtron call.
- **Projection** is rebuilt fresh per request from current intents
  (`unified-pipeline-architecture.md` §8 "RebuildProjection —
  Projection Freshness"); there is no separate retention.
- **ChangeSets** are captured by newtcon-server at apply time (the
  ChangeSet returned in the preview is the ChangeSet that executes —
  `DESIGN_PRINCIPLES_NEWTRON.md` §11) and retained for the same
  window as the originating operation per the binding contract in
  §Endpoints — Operations "Retention window" (terminal floor 30
  days, in-flight floor 7 days; deployment may extend). The
  operations store is the substrate for ChangeSet retention as well
  as the pipeline trace — they are captured and pruned together.
  A `changeset_id` whose underlying operation has been evicted
  returns 404 with `kind: "precondition_failure"` per §Error Schema,
  using either `condition: "operation_evicted"` (when the operation
  was minted and later pruned, with `evicted_at` populated) or
  `condition: "changeset_unknown"` (when the ID was never minted by
  this newtcon-server).
- **Verify assertions** are captured by newtcon-server alongside the
  ChangeSet at apply time (from
  `WriteResult.verification` returned by newtron — `api.md` §15
  Write Result Types); same retention as the operation.

The retention boundary is the operation's. ChangeSets and verify
assertions outlive their operation only insofar as the operation
itself does.

### `GET /api/intents/{intent_id}`

Return the full NEWTRON_INTENT record for one intent, plus the
intent-DAG context (parents, children, depth) and the navigation
links to the operation that wrote it and the ChangeSet that
delivered it.

The intent record IS the decision substrate per
`DESIGN_PRINCIPLES_NEWTRON.md` §1 ("The Node — Intent and Reality in
One Object") and `unified-pipeline-architecture.md` §1 ("Intent DB
is the decision substrate"). This endpoint exposes it directly —
not a summary, not a friendly digest. Operator-philosophy
invariant #1 is binding: the operator clicks an `intent_url` and
gets the substrate, not a paraphrase.

The endpoint composes two newtron reads
(`GET .../intents` filtered to the resource key, and
`GET .../intent/tree?kind=...&resource=...&ancestors=true` for DAG
context) and joins them with the newtcon-server-side
operation-history mapping.

**Response 200:**
```json
{
  "intent_id": "<echoed>",
  "as_of": "2026-05-25T14:30:00Z",
  "addressing": {
    "network": "default",
    "node": "switch1",
    "resource_key": "interface|Ethernet0"
  },
  "record": {
    "operation": "apply-service",
    "state": "actuated",
    "name": "transit",
    "params": {
      "user": {
        "service": "transit",
        "ip_address": "10.1.0.0/31",
        "peer_as": 65002
      },
      "resolved": {
        "vrf_name": "Vrf_TRANSIT",
        "l3vni": "10100",
        "route_map_in": "TRANSIT_IN_A1B2C3D4",
        "ingress_acl": "PROTECT_RE_IN_1ED5F2C7"
      }
    },
    "dag": {
      "parents": ["vrf|Vrf_TRANSIT", "service|transit"],
      "children": ["interface|Ethernet0|qos", "interface|Ethernet0|acl|in"]
    },
    "timing": {
      "created_at": "2026-05-25T14:06:00Z",
      "applied_at": "2026-05-25T14:06:02Z"
    },
    "holder": "newtcon-server@abcd1234",
    "applied_by": "operator:aldrin"
  },
  "params_split_rationale_ref": {
    "substrate": "newtron/docs/newtron/intents.md#11-identity-fields",
    "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#22-dual-purpose-intent--user-params-and-resolved-params"
  },
  "origin": {
    "kind": "operator_action | service_spec_resolution | reconcile_replay | provisioning_replay",
    "operation_id": "<opaque>",
    "operation_url": "/api/operations/<opaque>",
    "operator_workflow": "composer | inbox | workbench | provisioning",
    "operator_identity": "operator:aldrin",
    "started_at": "2026-05-25T14:06:00Z",
    "origin_rationale_ref": {
      "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#1-the-core-abstraction-intent-db",
      "principle": "docs/operator-philosophy.md#5-why-mode-is-always-available"
    }
  },
  "changesets": [
    {
      "changeset_id": "<opaque>",
      "changeset_url": "/api/changesets/<opaque>",
      "role": "wrote_intent_record",
      "operation_id": "<opaque>",
      "applied_at": "2026-05-25T14:06:02Z"
    }
  ],
  "dag_context": {
    "parents_detail": [
      {
        "resource_key": "vrf|Vrf_TRANSIT",
        "intent_id": "<opaque>",
        "intent_url": "/api/intents/<opaque>",
        "operation": "create-vrf",
        "state": "actuated"
      },
      {
        "resource_key": "service|transit",
        "intent_id": "<opaque>",
        "intent_url": "/api/intents/<opaque>",
        "operation": "apply-service",
        "state": "actuated"
      }
    ],
    "children_detail": [
      {
        "resource_key": "interface|Ethernet0|qos",
        "intent_id": "<opaque>",
        "intent_url": "/api/intents/<opaque>",
        "operation": "apply-qos",
        "state": "actuated"
      }
    ]
  },
  "rebuild_implication": {
    "summary": "Reversing this intent removes 8 projection entries across BGP_NEIGHBOR, INTERFACE, INTERFACE_IP, and decrements references on ACL_TABLE|PROTECT_RE_IN_1ED5F2C7 (becomes orphaned), ROUTE_MAP|TRANSIT_IN_A1B2C3D4 (decremented; 3 consumers remain), VRF|Vrf_TRANSIT (decremented; 1 consumer remains).",
    "deeply_inspectable_via_browser_workflow": "change-workbench (compose a scenario with the symmetric reverse verb in the browser frontend, then dry-run it against newtrun-server per ADR-0001)",
    "rebuild_implication_rationale_ref": {
      "substrate": "newtron/docs/newtron/intents.md#52-content-hashed-naming",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
    }
  },
  "manual_equivalent": {
    "newtron_cli": "newtron switch1 intent list --resource 'interface|Ethernet0' --format full",
    "newtron_http": {
      "status": "available",
      "method": "GET",
      "path": "/network/default/node/switch1/intents",
      "note": "Returns ALL intents on the device; filter client-side to resource_key='interface|Ethernet0' to isolate this record. For DAG context, also call GET /network/default/node/switch1/intent/tree?kind=interface&resource=Ethernet0&ancestors=true."
    }
  }
}
```

Field rules:

- **`record.params.user` vs `record.params.resolved`** is the
  dual-purpose intent split mandated by
  `DESIGN_PRINCIPLES_NEWTRON.md` §22. User params are what the
  operator requested; resolved params are what spec resolution
  computed and what was written to CONFIG_DB. Both are surfaced
  separately because they read differently for reconstruction
  (Snapshot reads user) vs teardown (RemoveService reads resolved);
  the operator MUST be able to see both to understand what was
  recorded and why.
- **`origin.kind`** distinguishes substrate-causes for the intent's
  existence:
  - `operator_action` — the intent was written because the operator
    directly invoked a verb through the browser frontend (Composer
    apply, Inbox action, Workbench commit — all delivered over
    newtrun-server per ADR-0001 §What moves upstream).
    `operation_url` points to the operation trace newtcon-server
    captured by observing newtrun-server's run state.
  - `service_spec_resolution` — the intent was synthesized by a
    parent operation as a derived resource (e.g., a `vrf|*` intent
    created by an `ApplyService` because the service spec required
    a VRF that did not yet exist). `operation_url` points to the
    parent operation; the DAG `parents_detail` walks the
    derivation chain.
  - `reconcile_replay` — the intent was rewritten by a
    `Reconcile`/`ApplyDrift` replay of existing intents
    (`unified-pipeline-architecture.md` §6); the original intent
    pre-existed reconcile but its `applied_at` reflects the most
    recent replay.
  - `provisioning_replay` — the intent was written by a Day-1
    provisioning operation
    (`unified-pipeline-architecture.md` §1 "Topology Mode").
- **`origin.operator_workflow`** is the bounded enum
  `composer | inbox | workbench | provisioning` naming the operator
  workflow the intent was authored through. The workflows are
  browser-frontend surfaces (Composer / Inbox / Workbench delivered
  over newtrun-server per ADR-0001); the enum is preserved as the
  operator-facing vocabulary even though the underlying initiation
  path moved upstream.
- **`changesets[]`** lists every ChangeSet that wrote, modified, or
  deleted this intent record. For the typical case (intent written
  once and currently `actuated`), the list has one entry. For an
  intent that was reapplied (e.g., `RefreshService` with a spec
  change), the list grows; the most recent entry is the one whose
  ChangeSet matches the current `record` state.
- **`dag_context.parents_detail[]` and `children_detail[]`** carry
  per-relationship navigation links so the operator follows the
  intent DAG one click at a time
  (`DESIGN_PRINCIPLES_NEWTRON.md` §43 "Intent DAG"). The list is
  one-hop only; the operator clicks through to walk further.
- **`rebuild_implication`** is a textual summary of what reversing
  the intent would do, plus a `deeply_inspectable_via_browser_workflow`
  pointer naming the browser-frontend workflow that lets the operator
  stage the symmetric reverse and see the full ChangeSet (the Change
  Workbench workflow delivered over newtrun-server per ADR-0001).
  The summary is a hint; the substrate is in the linked browser-
  workflow's dry-run (newtrun-server's
  `POST /api/runs/inline` with the scenario opted-out of the
  topology-reconcile gate), not in the summary itself (operator-
  philosophy invariant #1: counts and summaries do not substitute
  for the substrate).
- **`manual_equivalent.newtron_http.status: "available"`** because
  the substrate IS exposed by existing newtron endpoints; the
  endpoint shape is a composite read with client-side filtering, as
  the `note` explains. The Provenance read in newtcon is a
  convenience composition, not a workaround for a newtron gap.

**Errors:**
- Unknown or expired `intent_id` → 404 with
  `kind: "precondition_failure"` and `details.reason ∈
  {"intent_unknown", "intent_resolved"}`.
  - `intent_unknown` — the ID was never minted by newtcon-server.
  - `intent_resolved` — the ID was minted, but the underlying
    intent record no longer exists on the device (reversed by a
    later operation). The operator is told which.
- newtron-server unreachable → 503 with
  `kind: "newtron_unavailable"` per the typed schema in §Error
  Schema. `details.last_known.kind` is `"intent_record"` and
  `details.last_known.payload` carries the most recent cached record
  snapshot if newtcon-server has one from a prior fetch within the
  request-cache window (`kind: "none"` otherwise).

### `GET /api/projection/nodes/{node}`

Return the current typed projection for one Node — the per-table,
per-key, per-field expected-state derived from intent replay, as
defined in `DESIGN_PRINCIPLES_NEWTRON.md` §1 and
`unified-pipeline-architecture.md` §1.

The projection is **not** the device's actual CONFIG_DB (that is
the drift-source) and **not** the intent records (those are the
inputs to the projection). It is the rendered effect of replaying
every intent on the Node through newtron's config methods. Per
`DESIGN_PRINCIPLES_NEWTRON.md` §1, the projection IS what the
device should look like; reading it is how the operator learns what
newtron believes about the Node.

This is the substrate behind every operator-facing question of the
form "what does newtron think this device is?" — independent of
what the device actually has. The drift card (`kind: "drift"` in
the Inbox surface) renders the diff between this projection and
the device; this endpoint is the half of that diff the operator
otherwise cannot see directly.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `table` | string (repeatable) | unset (all owned tables) | Restrict the response to one or more CONFIG_DB tables. |
| `mode` | string | `"actuated"` | `"actuated"` reads from the device's NEWTRON_INTENT records (the live, on-device intent set); `"topology"` reads from the abstract topology (`topology.json`). The two correspond to the actuated/topology mode split in `unified-pipeline-architecture.md` §3. |

**Response 200:**
```json
{
  "node": "switch1",
  "network": "default",
  "mode": "actuated",
  "as_of": "2026-05-25T14:35:00Z",
  "rebuilt_at": "2026-05-25T14:35:00Z",
  "intent_count": 47,
  "tables": [
    {
      "table": "BGP_NEIGHBOR",
      "entries": [
        {
          "key": "default|10.0.0.1",
          "fields": { "asn": "65001", "local_addr": "10.0.0.0" },
          "owning_intent": {
            "resource_key": "interface|Ethernet0|bgp-peer",
            "intent_id": "<opaque>",
            "intent_url": "/api/intents/<opaque>"
          }
        },
        {
          "key": "default|10.1.0.1",
          "fields": { "asn": "65002", "local_addr": "10.1.0.0" },
          "owning_intent": {
            "resource_key": "interface|Ethernet4|bgp-peer",
            "intent_id": "<opaque>",
            "intent_url": "/api/intents/<opaque>"
          }
        }
      ]
    },
    {
      "table": "VLAN",
      "entries": [
        {
          "key": "Vlan100",
          "fields": { "vlanid": "100" },
          "owning_intent": {
            "resource_key": "vlan|100",
            "intent_id": "<opaque>",
            "intent_url": "/api/intents/<opaque>"
          }
        }
      ]
    }
  ],
  "owned_tables_total": 18,
  "drift": {
    "summary": {
      "entry_count": 0,
      "by_type": { "missing": 0, "extra": 0, "modified": 0 }
    },
    "drift_card_url": null,
    "rationale_ref": {
      "substrate": "newtron/docs/newtron/api.md#11-intent-history-settings-and-drift",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#21-reconstruct-dont-record"
    }
  },
  "manual_equivalent": {
    "newtron_cli": "newtron switch1 intent reconcile  # without -x — emits the projection-as-preview",
    "newtron_http": {
      "status": "available",
      "method": "GET",
      "path": "/network/default/node/switch1/intent/projection",
      "query": { "table": "<repeatable>", "mode": "actuated|topology" },
      "note": "Landed at the `/intent/` group, not at `/node/{d}/projection`. Returns bare `sonic.RawConfigDB` (`map[table]map[key]map[field]string`). The newtcon-facing decorations on this endpoint — `owning_intent`, `drift.summary`, `owned_tables_total`, `as_of`/`rebuilt_at` — are composed by newtcon-server from existing newtron reads (`/intent/tree`, `/intent/drift`, `OwnedTables` enumeration); they are NOT part of the substrate wire shape. The default `mode=intent` corresponds to newtcon's `mode=actuated`."
    }
  }
}
```

**Substrate-vs-decoration boundary (binding).** The newtron substrate
delivered by `GET /network/{n}/node/{d}/intent/projection` is bare
`sonic.RawConfigDB` — a `map[table]map[key]map[field]string` and
nothing more. This is the §46-faithful shape the newtron lead landed
(Phase 1 batch, 2026-05-27; closing comment cites §46 substrate
discipline). Every other field in the newtcon response above is a
newtcon-server-side decoration computed from other newtron reads:

| newtcon response field | Source |
|------------------------|--------|
| `tables[*].entries[*].key`, `tables[*].entries[*].fields` | Bare substrate — `RawConfigDB[table][key][field]`, lifted verbatim from newtron's `/intent/projection` response. |
| `tables[*].entries[*].owning_intent` | Composed by newtcon-server from `GET /network/{n}/node/{d}/intent/tree` (intent DAG attribution). Not in the projection substrate. |
| `drift.summary`, `drift.drift_card_url` | Composed by newtcon-server from `GET /network/{n}/node/{d}/intent/drift`. Companion read, not part of the projection substrate. |
| `owned_tables_total` | Composed by newtcon-server from newtron's owned-tables enumeration. Not part of the projection substrate. |
| `as_of`, `rebuilt_at`, `intent_count` | newtcon-server timestamps and counters. The newtron substrate endpoint does NOT carry a `rebuilt_at` envelope (§46 — bare substrate, no envelope); newtcon-server records the read-completion time and the intent-count from its companion `/intent/tree` read. |
| `manual_equivalent`, `rationale_ref` | newtcon-side metadata per §Manual-Mode Parity. |

This separation is binding per `DESIGN_PRINCIPLES_NEWTRON.md` §46
("Wire Shape Mirrors Substrate"): the substrate is the bare map; any
wrapping envelope or attribution metadata is newtcon's presentation,
not newtron's wire shape. An Implementer slicing this endpoint MUST
NOT request a richer wire shape from newtron — the substrate read is
deliberately bare, and the decorations live in newtcon-server.

Field rules:

- **`as_of` and `rebuilt_at`** are deliberately separate fields.
  `as_of` is when newtcon-server completed the underlying read;
  `rebuilt_at` is newtcon-server's record of when newtron's
  in-memory projection was last rebuilt (derived from the companion
  intent-tree read's freshness signal). On the no-cache path the
  two effectively coincide, but the two-timestamp shape leaves room
  for an explicit cache to be introduced later (Architect-authored)
  per `docs/architecture.md` §Caching. Operator-philosophy
  invariant #9 ("confidence and limits are explicit") is honored by
  surfacing the freshness of the substrate independently of the
  response envelope. **Note:** the newtron substrate endpoint does
  not return a `rebuilt_at` field; newtcon-server computes it from
  the companion intent-tree read.
- **`tables[*].entries[*].owning_intent`** attributes each
  projection entry back to the intent record whose replay produced
  it. Per `unified-pipeline-architecture.md` §4-5, each render step
  is initiated by one config method whose intent is captured on the
  ChangeSet; the projection entry is rendered by exactly one such
  step. Attribution is the bridge that lets the operator click from
  a CONFIG_DB-shaped projection entry to the intent that caused it
  — the why-mode invariant materialized at the projection level.
  **Composed by newtcon-server** from the intent-tree companion
  read; NOT part of newtron's bare substrate response per §46.
- **`drift.summary`** is a lightweight inline counts-only view of
  `GET /network/{n}/node/{d}/intent/drift` for the same Node,
  surfaced so the operator immediately knows whether the projection
  matches reality. The full drift entries are reached via the drift
  card (`drift_card_url` when non-null; null when
  `drift.summary.entry_count == 0`). The projection endpoint is the
  **what newtron believes**; the drift card is the **how reality
  differs**; both are reachable from each other. **Composed by
  newtcon-server** from the drift companion read; NOT part of
  newtron's bare projection substrate response per §46.
- **`owned_tables_total`** carries the cardinality of
  `OwnedTables()` for the Node so the operator can see when a
  `table` filter is restricting the response. **Composed by
  newtcon-server** from newtron's owned-tables enumeration; NOT
  part of newtron's bare projection substrate response per §46.

**Substrate availability (newtron#5 closed).** Phase 1 of the newtron
lead's 2026-05-27 substrate-faithful batch landed this endpoint at
`GET /network/{n}/node/{d}/intent/projection` (under the `/intent/`
group), returning bare `sonic.RawConfigDB` per §46. The closing
comment on [newtron#5](https://github.com/aldrin-isaac/newtron/issues/5)
verbatim: "Closed by Phase 1 batch on main (commits 7f5ed99 /
fba4a61 / a718f8a). See `docs/scoping/` for the substrate-faithful
scope and `docs/newtron/api.md` for the new endpoint + field
documentation." The lead's Phase 1 scoping comment frames the
discipline: "§46 codifies the unifying principle that newtron's HTTP
API exposes its canonical in-memory substrate types directly, not
summaries, opaque handles, or free-text renderings." Implementer
slices for this endpoint may proceed; no `pending_newtron_gap`
remains.

**Errors:**
- Unknown `node` → 404 with `kind: "precondition_failure"` and
  `details.reason: "node_unknown"`.
- `table` filter contains an unowned table → 400 with
  `kind: "validation_failure"` and `details.owned_tables[]`.
- newtron-server unreachable → 503 with
  `kind: "newtron_unavailable"`.

### `GET /api/projection/services/{service}`

Return the projection slice **contributed by one service across
every Node that binds it** — the per-Node projection rows that
exist because of the named service's intent records.

This is the service-first lens on the substrate. The Composer and
Inbox surfaces are service-first per
[`CLAUDE.md`](CLAUDE.md) §Design Principles; the Provenance surface
follows the same vocabulary. Per
`DESIGN_PRINCIPLES_NEWTRON.md` §1 and the `service|*` intent type
(`intents.md` §7.4), a service binding produces a DAG subtree under
`service|{name}` whose leaves are the projection rows the service
owns on each bound Node. This endpoint returns that DAG subtree's
rendered effect, grouped by Node.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `node` | string (repeatable) | unset (all nodes binding the service) | Restrict the response to one or more bound Nodes. |
| `table` | string (repeatable) | unset (all owned tables) | Restrict to specific CONFIG_DB tables. |

**Response 200:**
```json
{
  "service": "transit",
  "as_of": "2026-05-25T14:36:00Z",
  "binding_count": 12,
  "per_node": [
    {
      "node": "switch1",
      "interfaces": ["Ethernet0", "Ethernet4"],
      "intent_count_for_service": 8,
      "rebuilt_at": "2026-05-25T14:36:00Z",
      "tables": [
        {
          "table": "BGP_NEIGHBOR",
          "entries": [
            {
              "key": "default|10.1.0.1",
              "fields": { "asn": "65002", "local_addr": "10.1.0.0" },
              "owning_intent": {
                "resource_key": "interface|Ethernet0|bgp-peer",
                "intent_id": "<opaque>",
                "intent_url": "/api/intents/<opaque>"
              }
            }
          ]
        },
        {
          "table": "ROUTE_MAP",
          "entries": [
            {
              "key": "TRANSIT_IN_A1B2C3D4",
              "fields": { "match_prefix_list": "TRANSIT_PFX_C9E1B7A4" },
              "owning_intent": {
                "resource_key": "service|transit",
                "intent_id": "<opaque>",
                "intent_url": "/api/intents/<opaque>"
              },
              "shared_with_services": []
            }
          ]
        }
      ],
      "signal_unavailable": false
    },
    {
      "node": "switch9",
      "interfaces": ["Ethernet0"],
      "intent_count_for_service": 0,
      "rebuilt_at": null,
      "tables": [],
      "signal_unavailable": true,
      "signal_unavailable_reason": "device unreachable; last successful read was 4 hours ago and is outside the cache window"
    }
  ],
  "aggregate": {
    "node_count": 12,
    "node_count_with_signal": 11,
    "node_count_signal_unavailable": 1,
    "total_intent_count_for_service": 84,
    "total_entries": 156
  },
  "shared_resource_summary": [
    {
      "resource": "ROUTE_MAP|TRANSIT_IN_A1B2C3D4",
      "ref_count_in_service": 12,
      "ref_count_outside_service": 0,
      "decision_on_service_remove": "garbage_collect"
    },
    {
      "resource": "ACL_TABLE|PROTECT_RE_IN_1ED5F2C7",
      "ref_count_in_service": 12,
      "ref_count_outside_service": 3,
      "decision_on_service_remove": "preserve"
    }
  ],
  "shared_resource_summary_rationale_ref": {
    "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#24-policy-vs-infrastructure--shared-objects-have-independent-lifecycles",
    "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
  },
  "manual_equivalent": {
    "newtron_cli": "for each node N binding 'transit': newtron N intent tree --kind service --resource transit --ancestors",
    "newtron_http": {
      "status": "available",
      "method": "GET",
      "path": "/network/default/service/transit/projection",
      "query": { "node": "<repeatable>", "table": "<repeatable>" },
      "note": "Returns `ServiceProjectionResult { service: string, nodes: ServiceProjectionNode[] }` where each `ServiceProjectionNode` carries `{ node: string, diff: sonic.DriftEntry[] }`. The substrate technique is replay-diff: snapshot intent DB → trim the service's intents → rebuild projection → diff. The newtcon-facing per-table grouping (`per_node[*].tables[*].entries[*]`) is computed by newtcon-server from the entry-level `diff[]`; the `owning_intent` URLs, `shared_resource_summary[]`, and `aggregate{}` counters are composed by newtcon-server from existing newtron reads (`/intent/tree`, `/intent/projection`). The `node` and `table` query parameters are applied client-side by newtcon-server against the full `ServiceProjectionResult`."
    }
  }
}
```

**Substrate-vs-decoration boundary (binding).** The newtron substrate
delivered by `GET /network/{n}/service/{name}/projection` is the
`ServiceProjectionResult` envelope shipped by newtron's Phase 3 work
(2026-05-27): a `service` string and a `nodes: []ServiceProjectionNode`
array where each entry is `{ node: string, diff: sonic.DriftEntry[] }`.
The `diff` array is the §46-canonical entry-level delta vocabulary
(`DriftEntry`) — newtron's single typed-diff representation
(`DESIGN_PRINCIPLES_NEWTRON.md` §46 rule 3, "One typed diff
vocabulary"). The lead's closing comment on
[newtron#6](https://github.com/aldrin-isaac/newtron/issues/6)
verbatim: "Per-service projection slice endpoint landed at
`GET /network/{n}/service/{name}/projection` via replay-diff over
each Node's intent DB. Verified end-to-end by
`newtrun/suites/1node-vs-basic/07-service-projection-actuated`
against deployed `1node-vs` (PASS, 38s) — TRANSIT service on
Ethernet0 yields INTERFACE + BGP_NEIGHBOR entries in the per-Node
diff. Operationalizes operator-philosophy invariant #5 (why-mode at
service scope) per §11 + §46."

The substrate carries one shape only — the per-Node `diff[]`. Every
other field in the newtcon response above is a newtcon-server-side
decoration:

| newtcon response field | Source |
|------------------------|--------|
| `per_node[*].node` | Bare substrate — `ServiceProjectionResult.nodes[*].node`. |
| `per_node[*].tables[*].table`, `per_node[*].tables[*].entries[*].key`, `per_node[*].tables[*].entries[*].fields` | **Transformed** by newtcon-server: the per-Node `diff: []DriftEntry` (entry-level, one row per changed key) is re-grouped into the per-table operator-facing shape (`tables[*].entries[*]`). The keys and fields are taken verbatim from `DriftEntry.Expected` (the projection-side state attributable to this service); the table grouping is newtcon's view, not newtron's wire shape. |
| `per_node[*].tables[*].entries[*].owning_intent` | Composed by newtcon-server from `GET /network/{n}/node/{d}/intent/tree?kind=service&resource={svc}` (intent DAG attribution). NOT in the projection substrate. |
| `per_node[*].tables[*].entries[*].shared_with_services` | Composed by newtcon-server from cross-service intent-tree reads. NOT in the projection substrate. |
| `per_node[*].interfaces` | Composed by newtcon-server from the service-binding intent records. NOT in the projection substrate. |
| `per_node[*].intent_count_for_service` | Composed by newtcon-server from the intent-tree companion read. NOT in the projection substrate. |
| `per_node[*].rebuilt_at` | newtcon-server timestamp. The substrate response does NOT carry a `rebuilt_at` field per §46. |
| `per_node[*].signal_unavailable`, `signal_unavailable_reason` | newtcon-server signal-availability classifier (per-Node read may fail; per `CLAUDE.md` §No Hidden State the Node appears with the unavailability flag). NOT in the substrate. |
| `shared_resource_summary[]`, `shared_resource_summary_rationale_ref` | Composed by newtcon-server from cross-service projection reads (per `CLAUDE.md` §Reference-Aware Removals; §24 in newtron principles). NOT in the substrate. |
| `aggregate{}` | newtcon-server-computed counters. NOT in the substrate. |
| `binding_count`, `as_of`, `manual_equivalent` | newtcon-server metadata. |

This separation is binding per `DESIGN_PRINCIPLES_NEWTRON.md` §46:
the substrate is the typed `ServiceProjectionResult` with its
`DriftEntry[]` per Node, and only that. The reference-aware view
(`shared_resource_summary[]`), the cross-Node aggregation, and the
table-grouping presentation are newtcon-server compositions over
that substrate plus existing companion reads. An Implementer
slicing this endpoint MUST NOT request a richer wire shape from
newtron — the substrate read is deliberately bare, and the
decorations live in newtcon-server.

Field rules:

- **`per_node[*].signal_unavailable`** uses the same pattern as the
  browser-frontend Operator Inbox cards (per the §Operator Inbox
  stub above): a Node whose underlying signal is currently
  unreadable is NOT silently dropped (that would violate
  `CLAUDE.md` §No Hidden State). It appears with
  `signal_unavailable: true`, an empty `tables`, and a
  substrate-grounded reason. Aggregate counts split signal-present
  vs signal-unavailable. **Composed by newtcon-server.**
- **`shared_resource_summary[]`** is the reference-aware view of
  the service's shared policy objects. Per
  `CLAUDE.md` §Reference-Aware Removals and
  `DESIGN_PRINCIPLES_NEWTRON.md` §24, removing a service binding
  triggers a domain decision per shared resource (garbage-collect
  vs preserve). The summary surfaces that decision at the
  projection level, so the operator who is reading the service's
  substrate can see — before any remove operation — which shared
  resources are exclusive to this service and which are shared with
  other services. This is the reference-aware lens applied to the
  service-first navigation. **Composed by newtcon-server** from
  cross-service projection reads; NOT in newtron's bare substrate
  response per §46.
- **`shared_resource_summary[*].decision_on_service_remove`** is
  the decision newtron would make IF every binding of this service
  were removed. It is a hypothetical projection, not an action.
  Operator-philosophy invariant #4 ("show before do") is honored
  for the largest possible reverse operation on this service.
- **`per_node[*].rebuilt_at`** is per-Node because the read is
  per-Node; `null` when `signal_unavailable: true`. The top-level
  `as_of` is the timestamp at which newtcon-server completed the
  cross-Node fan-out. **Composed by newtcon-server**; the newtron
  substrate response does NOT carry per-Node `rebuilt_at` fields
  per §46.

**Substrate availability (newtron#6 closed).** Phase 3 of the
newtron lead's 2026-05-27 substrate-faithful batch landed this
endpoint at `GET /network/{n}/service/{name}/projection`, returning
the typed `ServiceProjectionResult` envelope with its `DriftEntry[]`
per Node. The substrate technique (replay-diff per Node — snapshot
intent DB, trim the service's intents, rebuild projection, diff)
operationalizes operator-philosophy invariant #5 (why-mode at
service scope) per §11 and §46 in newtron's principles. Implementer
slices for this endpoint may proceed; no `pending_newtron_gap`
remains.

**Errors:**
- Unknown `service` → 404 with `kind: "precondition_failure"` and
  `details.reason: "service_unknown"`.
- Service known but no bindings → 200 with empty `per_node` and
  `binding_count: 0` (not an error; absence of bindings is a valid
  state and surfacing it as 200 lets the operator see "this service
  is defined but currently unused").
- `node` filter naming a node that does not bind the service → that
  node is omitted from `per_node` (not an error; filter is a
  whitelist).
- `table` filter contains an unowned table → 400 with
  `kind: "validation_failure"`.
- newtron-server unreachable for ALL bound Nodes → 503 with
  `kind: "newtron_unavailable"`.

### `GET /api/changesets/{changeset_id}`

Return the full ChangeSet for one per-Node bundle of one operation,
plus the rationale linking it to the originating intent record and
the operation trace.

Per `DESIGN_PRINCIPLES_NEWTRON.md` §11 ("The ChangeSet Is the
Universal Contract"), the ChangeSet is the one object that is
simultaneously the preview, the execution receipt, and the
verification contract. This endpoint exposes the captured ChangeSet
for a completed operation so the operator can answer:

- "What was written?" — the `writes` and `deletes` arrays.
- "Why was it written?" — the link to the originating intent and
  the rationale block.
- "What was the verify result?" — the link to
  `/api/operations/{operation_id}/verify`.

newtcon-server retains the ChangeSet for the same window as the
parent operation (see §Retention above). This endpoint serves the
captured artifact; newtron itself does not have a "ChangeSet by ID"
read because ChangeSets are per-invocation in newtron's model. The
addressability is a newtcon-server concern that exists because the
operator needs a stable URL to navigate to from elsewhere.

**Response 200:**
```json
{
  "changeset_id": "<echoed>",
  "as_of": "2026-05-25T14:40:00Z",
  "addressing": {
    "operation_id": "<opaque>",
    "operation_url": "/api/operations/<opaque>",
    "network": "default",
    "node": "switch1",
    "per_node_sequence": 1
  },
  "captured_at": "2026-05-25T14:06:02Z",
  "writes": [
    {
      "table": "BGP_NEIGHBOR",
      "key": "default|10.1.0.1",
      "fields": { "asn": "65002", "local_addr": "10.1.0.0", "admin_status": "up" },
      "prior_fields": null
    },
    {
      "table": "NEWTRON_INTENT",
      "key": "interface|Ethernet0",
      "fields": { "operation": "apply-service", "state": "actuated", "name": "transit", "service_name": "transit", "ip_address": "10.1.0.0/31", "_parents": "vrf|Vrf_TRANSIT,service|transit", "_children": "interface|Ethernet0|qos" },
      "prior_fields": null
    }
  ],
  "deletes": [
    {
      "table": "INTERFACE_IP",
      "key": "Ethernet0|10.0.0.5/31",
      "prior_fields": { "scope": "global" }
    }
  ],
  "intent_records_written": [
    {
      "resource_key": "interface|Ethernet0",
      "intent_id": "<opaque>",
      "intent_url": "/api/intents/<opaque>",
      "role": "primary"
    }
  ],
  "render_decisions": [
    {
      "decision": "vrf_creation_required",
      "rationale": "service spec 'transit' declares vrf_name 'Vrf_TRANSIT'; intent DB lookup for vrf|Vrf_TRANSIT returned no record; created VRF intent as parent",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/intents.md#724-applyservice",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
      }
    },
    {
      "decision": "content_hash_route_map",
      "rationale": "route map content for service 'transit' hashed to A1B2C3D4 (8-char SHA256 of CONFIG_DB fields); generated ROUTE_MAP|TRANSIT_IN_A1B2C3D4",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/intents.md#52-content-hashed-naming",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#25-content-hashed-naming--version-shared-objects-by-what-they-write"
      }
    },
    {
      "decision": "shared_acl_increment",
      "rationale": "ACL_TABLE|PROTECT_RE_IN_1ED5F2C7 already exists from prior bindings; incrementing reference count via DAG child registration",
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/intents.md#53-dag-based-reference-counting",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#24-policy-vs-infrastructure--shared-objects-have-independent-lifecycles"
      }
    }
  ],
  "reference_impact": {
    "created": ["ROUTE_MAP|TRANSIT_IN_A1B2C3D4", "PREFIX_SET|TRANSIT_PFX_C9E1B7A4"],
    "incremented": ["ACL_TABLE|PROTECT_RE_IN_1ED5F2C7", "VRF|Vrf_TRANSIT"],
    "decremented": [],
    "garbage_collected": []
  },
  "wire_order": {
    "rationale": "intent records prepended; CONFIG_DB writes interleaved per dependency order; deletes last to avoid daemon thrash",
    "rationale_ref": {
      "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#4-config-methods-intent--entry-generation",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#18-write-ordering-and-daemon-settling"
    }
  },
  "totals": {
    "write_count": 14,
    "delete_count": 1,
    "intent_record_count": 1
  },
  "verify_url": "/api/operations/<opaque>/verify",
  "atomicity": "atomic_via_txpipeline",
  "atomicity_rationale_ref": {
    "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
    "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#11-the-changeset-is-the-universal-contract"
  },
  "manual_equivalent": {
    "newtron_cli": null,
    "newtron_http": {
      "status": "not_applicable",
      "rationale": "ChangeSets in newtron are per-invocation artifacts, not persistent addressable objects. The ChangeSet for this operation was returned in newtron's WriteResult at apply time (the same ChangeSet that previewed was the ChangeSet that executed, per DESIGN_PRINCIPLES_NEWTRON §11); newtcon-server retained it for provenance. To regenerate an equivalent ChangeSet today, an operator would re-run the original verb in dry-run mode against the same Node; this will produce a ChangeSet of the same shape but with current timestamps and fresh resolved-params, not the captured original."
    }
  }
}
```

Field rules:

- **Relationship to §Shared substrate shapes "ChangeSet".** The
  `writes[]`, `deletes[]`, and (here, in flattened form) the
  NEWTRON_INTENT rows that the canonical ChangeSet's
  `intent_records[]` carries are the same per-entry substrate the
  canonical ChangeSet defines. This endpoint extends the canonical
  shape with three
  post-execution additions: `prior_fields` (the snapshot before
  the write, available only post-commit because newtron's
  Lock/snapshot/restore cycle captures it during execution),
  `render_decisions[]` (the non-obvious render-time choices), and
  `intent_records_written[]` (the index from substrate row back to
  intent record with role discrimination). The pre-execution
  ChangeSet (preview-time) does not have access to these three;
  the post-execution ChangeSet (here) does. Consumers that render
  both surfaces share the writes/deletes layout; the post-execution
  additions render in a "what happened during execution"
  sub-section.
- **`writes[*].prior_fields` and `deletes[*].prior_fields`** carry
  the snapshot of the entry's CONFIG_DB state immediately before
  the ChangeSet executed, captured by newtron's
  `Lock → snapshot → fn → commit-or-restore → Unlock` cycle
  (`unified-pipeline-architecture.md` §8). `null` when the write was
  a creation (no prior state) or when newtron does not capture
  prior state for the table. This is the audit-trail substrate that
  lets the operator answer "what was there before?" — invariant #1
  ("no black boxes") applied to a historical ChangeSet.
- **`render_decisions[]`** captures the non-obvious choices the
  Render stage made — VRF/ACL creation-vs-reuse, content-hash
  generation, dependency-ordering. Each decision has a textual
  rationale AND a `rationale_ref` to the substrate-level and
  principle-level documents. This is the why-mode substrate at the
  ChangeSet level: an operator clicking "why was this ChangeSet
  this shape?" gets a per-decision answer, not a paraphrase.
  Implementations populate `render_decisions[]` from newtron's
  render-time logs (today exposed only in process logs; over time
  expected to come through a structured render-decisions field on
  newtron's WriteResult — see Gap-Handling for evolution path).
- **`intent_records_written[*].role`** is one of:
  - `primary` — the intent record the operation was named after
    (e.g., `apply-service` writes `interface|{intf}` as primary).
  - `derived` — an intent created because the primary required it
    as a parent (e.g., `vrf|{name}` created during an apply-service
    because the spec declared a VRF that did not yet exist).
  - `child_registration` — an intent updated only to register a
    new child (DAG `_children` field append; no domain params
    changed).
- **`reference_impact`** mirrors the same field on the preview
  shapes throughout the contract — same enum, same semantics —
  recorded at execution time. The operator who clicks a historical
  ChangeSet sees the SAME reference-impact view they saw at
  preview time, with the actual decisions (e.g., what was actually
  garbage-collected when the ChangeSet ran), not just the
  projected ones.
- **`verify_url`** points to the dedicated verify endpoint for the
  parent operation. The ChangeSet itself does not embed verify
  results inline because verify is a post-deliver Device I/O
  assertion against the ChangeSet
  (`unified-pipeline-architecture.md` §7) — distinct enough to
  warrant its own endpoint, and reachable from here in one click.
- **`manual_equivalent.newtron_http.status: "not_applicable"`** is
  the honest answer (not a gap): newtron does not expose ChangeSets
  as addressable objects because they are per-invocation in
  newtron's model. The captured ChangeSet exposed here is a
  newtcon-server retention artifact, derived from the WriteResult
  newtron returned at apply time. The contract surfaces the
  not-applicable status with its rationale, rather than fabricating
  a `pending_newtron_gap` claim where no gap actually exists
  (operator-philosophy invariant #1: the operator must not be
  taught a false model of where the substrate lives).

**Errors:**
- Unknown `changeset_id` → 404 with
  `kind: "precondition_failure"` and `details.reason ∈
  {"changeset_unknown", "operation_evicted"}`.
  - `changeset_unknown` — the ID was never minted.
  - `operation_evicted` — the parent operation has been evicted
    from newtcon-server's retention window; the ChangeSet is no
    longer available even though it was once minted. The operator
    is told which.

### `GET /api/operations/{operation_id}/verify`

Return the full verify-stage assertion diff for one operation —
the per-entry assertion of "what was written" vs "what re-reading
CONFIG_DB returned" — as captured by `cs.Verify(n)` at apply time.

Per `unified-pipeline-architecture.md` §7 ("Device I/O") and
`DESIGN_PRINCIPLES_NEWTRON.md` §14 ("Verify Your Writes; Observe
Everything Else"), verify is a **Device I/O assertion**: newtron
re-reads every CONFIG_DB entry it just wrote and diffs against the
ChangeSet. The assertion is absolute — newtron knows what it
wrote — and the diff (passed, failed, per-entry errors) is the
substrate-level answer to "did the write actually land on the
device?"

This endpoint is the dedicated polling target for the verify
substrate. The same data is also returned inline in
[`GET /api/operations/{operation_id}`](#get-apioperationsoperation_id)
under the `verify` key, but that endpoint returns the full
operation trace (pipeline, intent, terminal status) and is
heavyweight to poll. UI clients that want only the verify diff —
the typical case for a progress indicator on a long-running verify
— poll this endpoint instead.

Idempotent; safe to poll. No newtron-side state is mutated.

**Response 200:**
```json
{
  "operation_id": "<echoed>",
  "operation_url": "/api/operations/<opaque>",
  "as_of": "2026-05-25T14:41:00Z",
  "kind": "device_io_assertion",
  "kind_rationale_ref": {
    "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
    "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#14-verify-your-writes-observe-everything-else"
  },
  "state": "pending | in_progress | complete | failed | skipped",
  "started_at": "2026-05-25T14:06:02Z",
  "completed_at": "2026-05-25T14:06:03Z",
  "skip_reason": null,
  "asserted_against": {
    "changeset_id": "<opaque>",
    "changeset_url": "/api/changesets/<opaque>",
    "entry_count": 15,
    "delivered_at": "2026-05-25T14:06:02Z"
  },
  "assertion": {
    "passed": 14,
    "failed": 1,
    "entries": [
      {
        "table": "BGP_NEIGHBOR",
        "key": "default|10.1.0.1",
        "outcome": "passed",
        "fields_asserted": ["asn", "local_addr", "admin_status"]
      },
      {
        "table": "BGP_NEIGHBOR",
        "key": "default|10.1.0.5",
        "outcome": "failed",
        "fields_asserted": ["asn", "local_addr", "admin_status"],
        "field_errors": [
          {
            "field": "asn",
            "expected": "65002",
            "actual": "",
            "device_response": "local_addr=10.1.0.0 admin_status=up",
            "interpretation": "field missing on device after delivery; daemon may have rejected the write"
          }
        ]
      }
    ]
  },
  "confidence": { /* Confidence object — see §Shared substrate shapes "Confidence" */ },
  "interpretation": {
    "verdict": "verify_failed_on_subset",
    "verdict_rationale_ref": {
      "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#14-verify-your-writes-observe-everything-else"
    },
    "next_action_hints": [
      {
        "verb": "inspect_daemon_state",
        "rationale": "verify failure on BGP_NEIGHBOR fields suggests bgp daemon may have rejected the write; consider GET /network/{n}/node/{d}/bgp/status",
        "manual_equivalent_newtron_cli": "newtron switch1 bgp status"
      },
      {
        "verb": "stage_reconcile_delta",
        "rationale": "if verify failures correspond to a drift detection signal, a delta reconcile would re-apply the missing entries; stage via the browser-frontend Operator Inbox drift card (delivered over newtrun-server per ADR-0001)",
        "manual_equivalent_newtron_cli": "newtron switch1 intent reconcile -x --mode delta"
      }
    ]
  },
  "manual_equivalent": {
    "newtron_cli": "newtron switch1 verify-committed",
    "newtron_http": {
      "status": "partial_match",
      "method": "POST",
      "path": "/network/default/node/switch1/verify-committed",
      "note": "Re-runs verify against the LAST committed ChangeSet on the device, not the historical ChangeSet for this specific operation_id. The historical assertion captured by newtcon-server at this operation's apply time is the authoritative answer to the substrate question 'did this operation verify?'; the live re-verify answers a different question ('does the device's current state still match the LAST commit?'). The contract surfaces the captured assertion here; an operator who wants a live re-verify stages a fresh operation through the browser-frontend Change Workbench workflow (delivered over newtrun-server per ADR-0001)."
    }
  }
}
```

Field rules:

- **`state`** mirrors the verify state in
  [`GET /api/operations/{operation_id}`](#get-apioperationsoperation_id)
  exactly. A `pending` or `in_progress` state means the assertion
  has not produced a diff yet; `assertion.entries[]` is empty and
  `assertion.passed`/`failed` are both `0`. A `skipped` state
  populates `skip_reason` (e.g., the verb wrote no ChangeSet) and
  empty `assertion.entries[]`.
- **`assertion.entries[]`** is per-entry, not summarized. Each
  entry has an `outcome` (`passed` or `failed`); failed entries
  have `field_errors[]` with the per-field
  `expected`/`actual`/`device_response`/`interpretation`. The
  `expected`, `actual`, and `device_response` triple is the
  substrate-faithful mirror of newtron's `sonic.VerificationError`
  (`api.md` §VerificationError) per the
  [newtron#21](https://github.com/aldrin-isaac/newtron/issues/21)
  envelope fix: `device_response` is the verbatim device-side
  reply newtron observed at re-read time (the full `HGETALL`
  content as sorted `key=value` pairs for field mismatches; the
  Redis-level status for missing-key or still-present cases). Per
  `DESIGN_PRINCIPLES_NEWTRON` §14 ("verify is an assertion against
  the device") and §46 ("wire shape mirrors substrate"), the
  device's verbatim reply MUST be reachable from the per-field
  failure entry — paraphrasing it into the `interpretation` would
  collapse the substrate the operator needs to diagnose. The
  `interpretation` is the additive newtcon-server-side textual
  hint — NOT a verdict on the device; it surfaces likely causes
  (daemon rejection, schema mismatch) so the operator has a
  starting point, not a conclusion. The contract requires both
  the substrate (`device_response`) and the affordance
  (`interpretation`) — the substrate is load-bearing per §14, the
  affordance is operator-facing per `docs/operator-philosophy.md`
  invariant #5 ("why-mode is always available").
- **`asserted_against`** points to the ChangeSet the assertion
  diffed against. Verify is defined as "diff CONFIG_DB re-read
  against THIS ChangeSet" (`DESIGN_PRINCIPLES_NEWTRON.md` §11,
  §14); the contract makes the relationship traversable as a
  hyperlink. An operator clicking "what did this verify check?"
  reaches the captured ChangeSet directly.
- **`interpretation.verdict`** is one of:
  - `verify_passed` — all entries passed.
  - `verify_failed_on_subset` — at least one entry failed; subset
    is in `assertion.entries[]` with `outcome: "failed"`.
  - `verify_pending` — not yet complete.
  - `verify_skipped` — verb wrote no ChangeSet, or caller opted out.
- **`interpretation.next_action_hints[]`** lists per-verdict
  recommendations grounded in newtron substrate operations. Each
  hint carries a `manual_equivalent_newtron_cli` so the operator
  can run the diagnostic by hand — operator-philosophy invariant
  #2 ("manual-mode parity") applied to error response. Hints are
  ordered by relevance; the UI surfaces the top one as the
  default.
- **`manual_equivalent.newtron_http.status: "partial_match"`** is
  used here because an existing newtron endpoint answers a related
  but not identical question; the `note` explains the gap honestly.
  The bounded enum and the per-shape rules are defined canonically
  at §Shared substrate shapes "`manual_equivalent.newtron_http`";
  this site uses one of those shapes, it does not redefine the
  enum.

**Errors:**
- Unknown or evicted `operation_id` → 404 with
  `kind: "precondition_failure"` and `details.reason ∈
  {"operation_unknown_or_expired", "operation_evicted"}` (same
  semantics as the operations endpoint).
- newtron-server unreachable while verify is in-flight → 503 with
  `kind: "newtron_unavailable"` per the typed schema in §Error Schema.
  `details.last_known.kind` is `"verify_assertion"` and
  `details.last_known.payload` carries the most recent assertion
  snapshot newtcon-server has (`kind: "none"` if none captured yet).

## Endpoints — Rehearsal (teaching surface)

The Rehearsal surface is **the operator's library of substrate-grounded
walkthroughs for failure scenarios** (drift recovery, zombie cleanup,
verify-failure recovery, convergence-stuck triage, partial-commit
recovery). Each walkthrough is a teaching scenario the operator reads
to learn the substrate first, then practices on **their own lab device
using their own tools** (ssh + redis-cli + vendor CLI + console). The
surface is the contract realization of operator-philosophy invariant #6
("rehearsal mode is real"), as reframed by the refined operator
philosophy.

The reframing — and what it means for the contract. The earlier shape
of this surface (PR #29) was a newtron-mediated runtime sandbox: a
session-scoped fork of the intent DB, with drill scenarios injected by
newtron and an `automation_comparison` block computed against
newtron's pipeline. The operator review filed as #38 rejected that
shape on a non-negotiable invariant: **if rehearsal goes through
newtron, it does not rehearse the case where newtron is the failure
mode.** Pilot proficiency comes from time on real (or full-fidelity)
controls, not from time on a simulator the autopilot mediates.
Newtron-mediated rehearsal would have been a simulator the autopilot
runs.

The honest realization of invariant #6 is therefore two-sided:

- **newtcon's contribution: teaching.** This surface exposes
  walkthroughs that are substrate-grounded — every step names the
  CONFIG_DB keys, intent records, drift entries, and ChangeSet shapes
  involved, plus the forward and reverse CLI commands the operator
  would run on their own tools. The walkthroughs are static teaching
  content authored against newtron's documented substrate. They are
  not a sandbox.
- **The operator's contribution: real-tool practice.** The walkthroughs
  point at operator-owned lab-device guidance: the operator practices
  these scenarios on a lab device they own, using ssh + redis-cli +
  vendor CLI directly against that device. The practice ground is real
  hardware (or full-fidelity emulation) under the operator's control.
  newtcon does not provide the practice ground because the practice
  ground must not require newtcon — newtcon being unavailable is one
  of the failure modes invariant #6 exists to handle.

This split matches the refined invariant #2 (manual-mode parity):
newtcon's contribution to manual-mode parity is to **teach** the
device-level equivalent of every automated operation and to **expose**
the substrate, so the operator can act independently using their own
tools. The Rehearsal teaching surface is invariant #6's operational
counterpart to invariant #2's parity teaching: where the Manual-Mode
Parity surface teaches the operator what to do hand-to-hand for an
arbitrary action, the Rehearsal surface teaches the operator how to
walk through a named failure scenario step by step, with substrate at
every step.

The surface is **read-only**. No endpoint mutates newtron state or
newtcon-server state. There are no sessions, no preview/apply pairs,
no forks, no drill injection. Every walkthrough is static teaching
content, addressable by ID, returnable from a `GET`.

### Vocabulary

The surface re-uses newtron's substrate vocabulary exactly as the rest
of the contract does. The walkthrough endpoints introduce no new types
beyond what teaching content needs:

- **Walkthrough** — a named, substrate-grounded teaching scenario.
  Addressable by `walkthrough_id`. Composed of an ordered sequence of
  steps. Static teaching content; not parameterized by operator state.
- **Walkthrough step** — one teaching unit inside a walkthrough.
  Carries: the substrate state the step starts from (intent records,
  drift entries, projection rows, zombie markers, verify assertions —
  whichever substrate is load-bearing for this step), the candidate
  change (what the operator should consider doing), the expected
  outcome (what should happen on a properly-behaving device), and two
  CLI command sets — `forward_cli` (the operator's-own-tools way to
  execute this step manually) and `reverse_cli` (how to undo this step
  if the operator decides to back out, per
  `DESIGN_PRINCIPLES_NEWTRON.md` §15's symmetric-operations rule).
- **Walkthrough category** — coarse grouping for indexing: `drift`,
  `zombie`, `verify_failure`, `convergence_stuck`, `partial_commit`,
  `provisioning`. Bounded enum; extension is a Contract PR.
- **Lab-device guidance** — the pointer attached to every walkthrough
  that names what kind of lab device the operator should practice on
  (full-fidelity SONiC switch, VM-based SONiC instance, hardware in a
  lab pod) and the prerequisite topology. The guidance is operator-
  pointed text, not a launch button — newtcon does not provision the
  lab; the operator owns the practice ground.

These terms map to newtron's substrate, not to newtron's runtime. A
walkthrough names CONFIG_DB tables, NEWTRON_INTENT keys, ChangeSet
shapes, drift entries, and projection rows — but it never opens a
newtron-side session, never forks an intent DB, never injects a drill
scenario, and never asks newtron to simulate anything.

### Identifiers

- `walkthrough_id` — opaque-typed stable string, server-assigned at
  walkthrough authorship. Stable across newtcon-server restarts; bound
  to the walkthrough catalog, not to an operator session. Example
  shape: `drift-bgp-asn-modified-recovery`.
- `walkthrough_step_id` — opaque-typed stable string scoped to its
  walkthrough. Stable across catalog updates that do not renumber the
  walkthrough's steps. Example shape: `step-3-stage-reconcile-delta`.

Both IDs are opaque to the client; only the catalog issues them. There
is no session ID, no action ID, no preview ID on this surface.

### Static content; no `as_of` envelope

Walkthroughs are versioned content authored by the Architect, not a
projection of live newtron state. The surface therefore does NOT carry
an `as_of` field — there is no live observation to time-stamp. Instead,
each walkthrough carries a `content_version` (the catalog version the
walkthrough was authored against). When a substrate-evolution Contract
PR retires a walkthrough or changes a step, the `content_version`
moves; consumers see the new content on next fetch.

This is deliberate. An `as_of` field would imply the walkthrough's
substrate is being observed, which would imply newtron-mediated
inspection, which is exactly what the reframe rejects. Static content
is honest: the walkthrough teaches a scenario the operator will then
practice independently on their own lab device.

### Field shapes — shared types used below

Two typed objects recur in walkthrough steps. Both are shape-aligned
with the existing contract vocabulary so the frontend reuses
renderers.

**`SubstrateLocator`** — names a concrete piece of newtron substrate:

```json
{
  "kind": "intent_record | configdb_key | drift_entry | projection_row | changeset_entry | verify_assertion | zombie_intent",
  "network": "default",
  "node": "switch1",
  "table": "BGP_NEIGHBOR",
  "key": "default|10.1.0.1",
  "field": "asn",
  "intent_key": "service|transit|Ethernet0"
}
```

Fields populate per `kind`: a `configdb_key` locator populates
`network`, `node`, `table`, `key`, optionally `field`; an
`intent_record` locator populates `network`, `node`, `intent_key`. The
shape is identical to `rejections[*].locator.substrate_field` used in
the Error Schema and to the locator shape used by the drift Inbox card
and the Provenance surface — one vocabulary, used everywhere a
substrate address is named.

**`CliCommand`** — names a command the operator runs on their own
tools, against either the device directly or against a newtron-managed
device. Two enumerated `tool` values:

```json
{
  "tool": "ssh_redis_cli | ssh_vendor_cli",
  "command": "redis-cli -h switch1 -p 6379 HGETALL 'BGP_NEIGHBOR|default|10.1.0.1'",
  "rationale": "Inspect the BGP_NEIGHBOR entry whose asn field the device's bgpd will read",
  "rationale_ref": {
    "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
    "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#4-sonic-is-a-database--treat-it-as-one"
  }
}
```

Field rules:

- **`tool`** is one of `ssh_redis_cli` (the operator SSHes to the
  device and runs `redis-cli` against CONFIG_DB / STATE_DB / APPL_DB)
  or `ssh_vendor_cli` (the operator SSHes to the device and runs the
  vendor CLI — e.g., `vtysh`, `show ip bgp`, the SONiC `config`
  command). The two-value enum is binding for v0; new tools are a
  Contract PR. Notably absent from the enum: any newtron- or
  newtcon-mediated path. The CliCommand is **the operator's own
  tools**, never newtron's. Per the refined invariant #2, newtcon
  teaches but does not mediate.
- **`command`** is the literal shell-paste-ready command. No
  placeholders that the consumer must rewrite (e.g., `<NODE>`); the
  walkthrough author bakes the example values into the command. The
  operator adapts the values for their own lab device locally; the
  contract does not pretend to know the operator's lab address space.
- **`rationale`** is the substrate-grounded explanation of why this
  command is the right thing to run at this step.
- **`rationale_ref`** is the same typed `{ substrate, principle }`
  object used elsewhere in the contract — `substrate` points at the
  authoritative newtron document; `principle` points at either
  `DESIGN_PRINCIPLES_NEWTRON.md` or `docs/operator-philosophy.md`.

### `GET /api/rehearsal/walkthroughs`

List the available walkthroughs, optionally filtered by category.
Idempotent; safe to poll. Returns the catalog summary; per-walkthrough
detail (steps, CLI commands, lab-device guidance) is at
[`GET /api/rehearsal/walkthroughs/{walkthrough_id}`](#get-apirehearsalwalkthroughswalkthrough_id).

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `category` | string | _omitted_ | Filter to one category. One of `drift`, `zombie`, `verify_failure`, `convergence_stuck`, `partial_commit`, `provisioning`. Unknown category → 400 `validation_failure` with the bounded enum. |

**Response 200:**
```json
{
  "content_version": "2026-05-26.1",
  "categories": [
    {
      "category": "drift",
      "name": "Drift recovery",
      "walkthrough_count": 2,
      "description": "Walkthroughs for diagnosing CONFIG_DB divergence from the intent-projection and choosing between delta and full reconcile."
    },
    {
      "category": "zombie",
      "name": "Zombie intent cleanup",
      "walkthrough_count": 1,
      "description": "Walkthroughs for partial-operation recovery: a NEWTRON_INTENT record exists for an operation whose CONFIG_DB writes did not complete."
    },
    {
      "category": "verify_failure",
      "name": "Verify-failure recovery",
      "walkthrough_count": 1,
      "description": "Walkthroughs for post-Deliver verify-assertion failures: the ChangeSet was written but re-read does not match."
    },
    {
      "category": "convergence_stuck",
      "name": "Convergence triage",
      "walkthrough_count": 1,
      "description": "Walkthroughs for non-terminal verify assertions: verify has been in_progress longer than the convergence budget."
    },
    {
      "category": "partial_commit",
      "name": "Partial Workbench commit recovery",
      "walkthrough_count": 1,
      "description": "Walkthroughs for cross-Node Workbench commits that succeeded on some Nodes and failed on others (the per-Node atomicity model preserved across ADR-0001 — the Workbench workflow is delivered by the browser frontend over newtrun-server post-rebalance, but the atomicity substrate is unchanged because newtron's `cs.Apply` mediation is unchanged)."
    }
  ],
  "walkthroughs": [
    {
      "walkthrough_id": "drift-bgp-asn-modified-recovery",
      "category": "drift",
      "name": "Drift recovery: BGP_NEIGHBOR ASN externally modified",
      "summary": "Someone changed asn on a BGP_NEIGHBOR entry outside of newtron's intent path. Detect the drift; choose between delta reconcile (re-assert the intent's asn) and accepting the external change (record a new intent that matches).",
      "estimated_reading_time": "PT8M",
      "step_count": 6,
      "teaches": [
        "DiffConfigDB compares device CONFIG_DB to the intent-projection",
        "Delta reconcile re-asserts the intent without rebuilding the full projection",
        "Drift Guard blocks new writes until the drift is reconciled or accepted"
      ],
      "teaches_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#6-delta-reconcile",
        "principle": "docs/operator-philosophy.md#6-rehearsal-mode-is-real"
      },
      "lab_device_kind": "full_fidelity_sonic | sonic_vm | hardware_pod"
    },
    {
      "walkthrough_id": "zombie-apply-service-crash-recovery",
      "category": "zombie",
      "name": "Zombie cleanup: ApplyService crashed mid-Deliver",
      "summary": "An ApplyService operation wrote the NEWTRON_INTENT record but crashed before completing its CONFIG_DB writes. Decide between rollback-zombie (synthesize and run the reverse) and clear-zombie (record that you cleaned up by hand).",
      "estimated_reading_time": "PT12M",
      "step_count": 8,
      "teaches": [
        "The NEWTRON_INTENT record IS the substrate of what was partially applied",
        "DESIGN_PRINCIPLES_NEWTRON §15 — what you create, you can remove (rollback path)",
        "The clear-zombie path requires an operator narrative that survives in operation history"
      ],
      "teaches_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#crash-recovery-via-drift-guard--reconcile",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
      },
      "lab_device_kind": "full_fidelity_sonic | sonic_vm | hardware_pod"
    },
    {
      "walkthrough_id": "verify-failure-bgp-neighbor-fields",
      "category": "verify_failure",
      "name": "Verify-failure recovery: BGP_NEIGHBOR fields missing post-Deliver",
      "summary": "Deliver succeeded; the post-Deliver verify assertion finds the asn field missing on one BGP_NEIGHBOR entry. Interpret the field-level diff, isolate device-vs-automation, and choose the next action.",
      "estimated_reading_time": "PT10M",
      "step_count": 7,
      "teaches": [
        "Verify is a Device I/O assertion against the live device, not a pipeline stage",
        "field_errors carry per-field expected/actual; the interpretation is a hint, not a verdict",
        "Manual re-issuance via vtysh isolates the daemon's reaction to the CONFIG_DB write"
      ],
      "teaches_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#14-verify-your-writes-observe-everything-else"
      },
      "lab_device_kind": "full_fidelity_sonic | hardware_pod"
    },
    {
      "walkthrough_id": "convergence-stuck-verify-pending",
      "category": "convergence_stuck",
      "name": "Convergence triage: verify in-progress past the convergence budget",
      "summary": "An apply succeeded; the post-Deliver verify has been in_progress for 4 minutes. Decide between waiting (within budget), recheck (substrate retry), or escalating (outside the tool's competence).",
      "estimated_reading_time": "PT6M",
      "step_count": 5,
      "teaches": [
        "Non-terminal verify is not failure — it is unfinished Device I/O",
        "Recheck is the substrate-level retry; acknowledge is the explicit waiting decision",
        "Operator-philosophy invariant #9 — confidence and limits are explicit"
      ],
      "teaches_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
        "principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit"
      },
      "lab_device_kind": "full_fidelity_sonic | sonic_vm | hardware_pod"
    },
    {
      "walkthrough_id": "partial-commit-cross-node-recovery",
      "category": "partial_commit",
      "name": "Partial Workbench commit recovery (cross-Node)",
      "summary": "A Workbench commit succeeded on switch1 and failed on switch2 (Workbench's per-Node atomicity model). Decide between reverting switch1, retrying switch2, or stashing the remaining intents.",
      "estimated_reading_time": "PT10M",
      "step_count": 7,
      "teaches": [
        "Workbench commits are per-Node atomic, never cross-Node atomic",
        "Reverse synthesis is a domain operation (§15), not a mechanical ChangeSet reversal",
        "The partial_results envelope is the substrate the operator reads to choose next action"
      ],
      "teaches_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
      },
      "lab_device_kind": "hardware_pod"
    }
  ]
}
```

Field rules:

- **`content_version`** is a monotonically-increasing version string
  for the entire walkthrough catalog. Format is opaque to clients; the
  contract guarantees lexicographic ordering. A consumer caching
  walkthroughs sees a changed `content_version` when any walkthrough
  is added, removed, or has any step modified.
- **`categories[]`** is the bounded category enum (six values today),
  each with a `walkthrough_count` derived from the current catalog.
  New categories are a Contract PR. Empty categories are omitted from
  the response.
- **`walkthroughs[]`** is the full catalog or the category-filtered
  subset. Order is stable for a given `content_version`; within a
  category, walkthroughs are ordered from foundational to advanced.
- **`teaches[]`** is the substrate-level lesson list. Per
  operator-philosophy invariant #3 ("the substrate is the teaching
  surface"), every walkthrough declares what substrate it teaches.
  Empty or generic `teaches[]` is a contract smell; the Architecture
  Reviewer rejects new walkthroughs whose lessons are not
  substrate-grounded.
- **`teaches_rationale_ref`** uses the same typed `{ substrate,
  principle }` shape used everywhere else in the contract.
- **`lab_device_kind`** names what kind of practice ground the
  walkthrough requires. Three values: `full_fidelity_sonic` (a real
  or full-fidelity emulated SONiC switch), `sonic_vm` (a VM-based
  SONiC instance suitable for most teaching), `hardware_pod` (a
  multi-device lab pod required for cross-Node walkthroughs).
  Pipe-separated alternatives indicate the walkthrough is practicable
  on any of the listed kinds.

**Errors:**
- Unknown `category` → 400 `validation_failure` with
  `details.rejections[*].reason == "unknown_value"` and
  `details.rejections[*].allowed` carrying the bounded enum.

### `GET /api/rehearsal/walkthroughs/{walkthrough_id}`

Return the full walkthrough — every step, every CLI command, the
lab-device guidance. Idempotent; safe to poll. No newtron-side state
is mutated.

**Response 200:**
```json
{
  "content_version": "2026-05-26.1",
  "walkthrough_id": "drift-bgp-asn-modified-recovery",
  "category": "drift",
  "name": "Drift recovery: BGP_NEIGHBOR ASN externally modified",
  "summary": "Someone changed asn on a BGP_NEIGHBOR entry outside of newtron's intent path. Detect the drift; choose between delta reconcile (re-assert the intent's asn) and accepting the external change (record a new intent that matches).",
  "estimated_reading_time": "PT8M",
  "teaches": [
    "DiffConfigDB compares device CONFIG_DB to the intent-projection",
    "Delta reconcile re-asserts the intent without rebuilding the full projection",
    "Drift Guard blocks new writes until the drift is reconciled or accepted"
  ],
  "teaches_rationale_ref": {
    "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#6-delta-reconcile",
    "principle": "docs/operator-philosophy.md#6-rehearsal-mode-is-real"
  },
  "prerequisites": {
    "lab_device_kind": "full_fidelity_sonic | sonic_vm | hardware_pod",
    "topology": "One SONiC switch with at least one BGP_NEIGHBOR entry whose intent record exists in NEWTRON_INTENT.",
    "operator_tooling": [
      "ssh access to the lab device",
      "redis-cli installed on the device (default in SONiC)",
      "vtysh available on the device (default in SONiC)"
    ],
    "starting_state_description": "The lab device has at least one apply-service intent actuated. NEWTRON_INTENT records exist for the actuated services. BGP_NEIGHBOR records reflect the intent's resolved params.",
    "out_of_scope": [
      "Provisioning the lab device (newtlab handles Day-0; this walkthrough is Day-1+)",
      "Cross-Node drift (multi-Node practice is a separate walkthrough)"
    ]
  },
  "lab_device_guidance": {
    "summary": "Practice this walkthrough on a lab device you own. newtcon does not provide the practice ground because rehearsal must rehearse the case where newtron-and-newtcon are themselves the failure mode.",
    "rationale": "Operator-philosophy invariant #6 (reframed): rehearsal is real-tool rehearsal on operator-owned hardware, not simulated rehearsal inside a tool-mediated sandbox. The pilot proficiency that invariant #6 demands comes from time on real controls, not from time on a simulator the autopilot mediates.",
    "rationale_ref": {
      "substrate": "newtron/docs/newtron/hld.md#node-as-device",
      "principle": "docs/operator-philosophy.md#6-rehearsal-mode-is-real"
    },
    "recommended_setups": [
      {
        "kind": "sonic_vm",
        "description": "A SONiC VM (e.g., from sonic-vs) is sufficient for single-Node walkthroughs (drift, zombie, verify-failure, convergence-stuck). Lower-fidelity than hardware on a few daemon-timing details but adequate for substrate-mechanics teaching."
      },
      {
        "kind": "full_fidelity_sonic",
        "description": "A real or full-fidelity emulated SONiC switch is required for walkthroughs that exercise device-side timing (verify failures rooted in daemon settling, post-Deliver re-read races)."
      },
      {
        "kind": "hardware_pod",
        "description": "A multi-device lab pod (two or more switches with inter-Node links) is required for the partial-commit walkthrough and any cross-Node scenario."
      }
    ],
    "newtcon_not_required": "All forward_cli and reverse_cli commands run via ssh + redis-cli or ssh + vtysh against the operator's lab device directly. newtcon's role in this walkthrough is to TEACH the steps; the operator EXECUTES the steps on their own tools."
  },
  "steps": [
    {
      "walkthrough_step_id": "step-1-inspect-actuated-intent",
      "step_number": 1,
      "name": "Inspect the actuated intent record",
      "purpose": "Read the NEWTRON_INTENT record that asserts the asn value newtron expects. The intent record IS the substrate of newtron's decision — per DESIGN_PRINCIPLES_NEWTRON §1, the intent record is the authority after actuation.",
      "purpose_rationale_ref": {
        "substrate": "newtron/docs/newtron/intents.md#intent-record-shape",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object"
      },
      "starting_substrate": [
        {
          "kind": "intent_record",
          "network": "default",
          "node": "switch1",
          "intent_key": "service|transit|Ethernet0"
        }
      ],
      "candidate_change": null,
      "expected_outcome": "The intent record's resolved_params half contains the asn newtron will assert on next reconcile (e.g., 65002).",
      "forward_cli": [
        {
          "tool": "ssh_redis_cli",
          "command": "redis-cli -h switch1 -p 6379 HGETALL 'NEWTRON_INTENT|service|transit|Ethernet0'",
          "rationale": "Read the actuated intent record. The resolved_params field carries the asn value newtron will re-assert on reconcile.",
          "rationale_ref": {
            "substrate": "newtron/docs/newtron/intents.md#intent-record-shape",
            "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#20-on-device-intent-is-sufficient-for-reconstruction"
          }
        }
      ],
      "reverse_cli": [],
      "reverse_cli_rationale": "Read-only step; no reverse needed.",
      "verify_step_completion": {
        "what_to_check": "The output contains a field named resolved_params (or user_params + a derivable asn) such that the intent's intended asn is visible.",
        "if_missing": "If NEWTRON_INTENT|service|transit|Ethernet0 returns no fields, this intent is not actuated. Pick a different intent for the practice or seed one via the lab-device's own apply path before proceeding."
      }
    },
    {
      "walkthrough_step_id": "step-2-inspect-device-bgp-neighbor",
      "step_number": 2,
      "name": "Inspect the live BGP_NEIGHBOR entry",
      "purpose": "Read the BGP_NEIGHBOR CONFIG_DB entry as it currently exists on the device. The asn field here is what bgpd will read — if it differs from the intent's resolved asn, drift is structural.",
      "purpose_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#4-sonic-is-a-database--treat-it-as-one"
      },
      "starting_substrate": [
        {
          "kind": "configdb_key",
          "network": "default",
          "node": "switch1",
          "table": "BGP_NEIGHBOR",
          "key": "default|10.1.0.1"
        }
      ],
      "candidate_change": null,
      "expected_outcome": "The device CONFIG_DB shows an asn value that differs from the intent's resolved asn — this is the drift the walkthrough is teaching you to detect.",
      "forward_cli": [
        {
          "tool": "ssh_redis_cli",
          "command": "redis-cli -h switch1 -p 6379 HGETALL 'BGP_NEIGHBOR|default|10.1.0.1'",
          "rationale": "Read the CONFIG_DB entry bgpd actually consumes. The asn field here is the device's reality.",
          "rationale_ref": {
            "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
            "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#4-sonic-is-a-database--treat-it-as-one"
          }
        }
      ],
      "reverse_cli": [],
      "reverse_cli_rationale": "Read-only step; no reverse needed.",
      "verify_step_completion": {
        "what_to_check": "The asn field's value is captured. Compare against the intent's resolved asn from step 1. If they differ, the drift is real; proceed to step 3.",
        "if_missing": "If BGP_NEIGHBOR|default|10.1.0.1 is absent, this is not a modification-drift scenario — it is a missing-entry scenario. The walkthrough's diagnosis assumes the entry exists; pick a different practice setup."
      }
    },
    {
      "walkthrough_step_id": "step-3-stage-reconcile-delta",
      "step_number": 3,
      "name": "Stage a delta reconcile against the drift",
      "purpose": "Re-assert the intent's resolved params via a delta reconcile, which rewrites only the drifted fields rather than rebuilding the full projection. This is the symmetric counterpart of the external modification — the intent record is the authority; reconcile makes the device match.",
      "purpose_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#6-delta-reconcile",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#21-reconstruct-dont-record"
      },
      "starting_substrate": [
        {
          "kind": "drift_entry",
          "network": "default",
          "node": "switch1",
          "table": "BGP_NEIGHBOR",
          "key": "default|10.1.0.1",
          "field": "asn"
        }
      ],
      "candidate_change": {
        "kind": "reconcile_delta",
        "rationale": "Delta reconcile re-asserts the intent's resolved fields against the drifted CONFIG_DB entries. The intent record (the substrate of newtron's decision) is the authority; delta reconcile re-projects that authority onto the device.",
        "rationale_ref": {
          "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#6-delta-reconcile",
          "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object"
        }
      },
      "expected_outcome": "The drifted asn field is rewritten on the device. A subsequent HGETALL of BGP_NEIGHBOR|default|10.1.0.1 shows the intent's value, not the externally-injected value.",
      "forward_cli": [
        {
          "tool": "ssh_redis_cli",
          "command": "redis-cli -h switch1 -p 6379 HSET 'BGP_NEIGHBOR|default|10.1.0.1' 'asn' '65002'",
          "rationale": "Manual delta reconcile, executed by hand: re-assert the intent's expected asn on the drifted CONFIG_DB entry. This is what newtron's delta-reconcile path would synthesize internally; doing it by hand teaches the substrate-level effect and isolates the change to one field.",
          "rationale_ref": {
            "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#6-delta-reconcile",
            "principle": "docs/operator-philosophy.md#2-manual-mode-parity"
          }
        }
      ],
      "reverse_cli": [
        {
          "tool": "ssh_redis_cli",
          "command": "redis-cli -h switch1 -p 6379 HSET 'BGP_NEIGHBOR|default|10.1.0.1' 'asn' '<the-value-you-captured-in-step-2>'",
          "rationale": "Restore the pre-reconcile value (the drifted value the device had before this step). Use only if you want to back out the practice — in production, you would not reverse a reconcile.",
          "rationale_ref": {
            "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#6-delta-reconcile",
            "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
          }
        }
      ],
      "reverse_cli_rationale": "Practice walkthroughs are practice; reversal is the safety net that lets the operator restore lab-device state to where it started, so the lab device is reusable for the next practice run.",
      "verify_step_completion": {
        "what_to_check": "Repeat step 2's HGETALL. The asn field now shows the intent's value. The drift is resolved.",
        "if_missing": "If HSET returned an error, redis-cli could not connect, or the field did not change, the lab device's CONFIG_DB write path is broken — diagnose ssh / redis-cli access before continuing."
      }
    }
  ],
  "step_count": 3,
  "out_of_scope": [
    "Issuing the reconcile through newtron's own pipeline. That path exists (newtron's HTTP API `/intent/reconcile` and the equivalent CLI command), and the operator should know it; this walkthrough deliberately practices the hand-equivalent so the operator builds the substrate-level mental model independently of newtron.",
    "Detecting drift via the browser-frontend Operator Inbox card. The Inbox card is delivered by the browser frontend (see §Endpoints — Operator Inbox stub above; the underlying substrate is composed from newtcon-server's Observation History plus newtrun-server's run state per ADR-0001); this walkthrough is for the operator who has decided to diagnose drift without that automation in the path."
  ],
  "see_also": [
    {
      "kind": "browser_workflow",
      "name": "Operator Inbox — drift card",
      "operator_workflow": "operator-inbox",
      "rationale": "The newtron-mediated path is delivered by the browser frontend per ADR-0001: open the operator-inbox drift card, follow the recommended action."
    },
    {
      "kind": "newtron_principle",
      "name": "DESIGN_PRINCIPLES_NEWTRON.md §6 — Delta reconcile",
      "url": "newtron/docs/newtron/unified-pipeline-architecture.md#6-delta-reconcile",
      "rationale": "The substrate description of what delta reconcile does; this walkthrough is its manual equivalent."
    }
  ]
}
```

Field rules:

- **`prerequisites`** describes the lab-device state the operator
  must have before starting the walkthrough. The field is mandatory;
  walkthroughs that do not declare prerequisites are uncalibrated and
  the Architecture Reviewer rejects them.
- **`prerequisites.operator_tooling[]`** names the operator's-own
  tools the walkthrough uses. Every tool named here MUST be a tool
  the operator runs against their own device, never a newtcon or
  newtron command. Per the refined invariant #2, manual-mode parity
  is in the operator's own tools, not in newtcon's affordances.
- **`lab_device_guidance`** is REQUIRED on every walkthrough. It is
  the contract realization of the invariant #6 reframe: the operator
  practices on a lab device they own, not in a tool-mediated sandbox.
  A walkthrough without lab-device guidance is a contract violation.
- **`lab_device_guidance.newtcon_not_required`** is a load-bearing
  assertion. Per the refined invariant #2, the manual capability must
  be in the operator's own tools, not in newtcon's affordances —
  because newtcon being unavailable is one of the failure modes
  invariant #6 exists to handle. Walkthrough steps whose CLI commands
  require newtcon are a contract violation.
- **`steps[]`** is the ordered teaching sequence. Each step is
  addressable by `walkthrough_step_id`; the IDs are stable across
  catalog updates that do not renumber the walkthrough's steps.
- **`steps[*].starting_substrate[]`** is a list of `SubstrateLocator`
  objects (see §Field shapes — shared types) naming the substrate
  the step starts from. Read-only steps populate it with the keys
  the operator inspects; state-changing steps populate it with the
  keys the candidate change would mutate.
- **`steps[*].candidate_change`** is the typed change the step
  proposes. `null` for read-only steps. For mutating steps, the
  `kind` enumerates the substrate-level operation (`reconcile_delta`,
  `reconcile_full`, `apply_service`, `remove_service`,
  `rollback_zombie`, `clear_zombie`, `direct_configdb_write`,
  `direct_configdb_delete`) and the rationale grounds the choice in
  the substrate.
- **`steps[*].expected_outcome`** describes what the operator should
  observe on a properly-behaving lab device after running
  `forward_cli`. The outcome is in substrate terms (a HGETALL output,
  a STATE_DB row, a bgpd `show` line), not in tool-status terms.
- **`steps[*].forward_cli[]`** is the operator's-own-tools command
  sequence for this step. Every command is a `CliCommand` (see §Field
  shapes — shared types). Read-only steps populate `forward_cli` with
  inspection commands; mutating steps populate it with the
  hand-equivalent of the candidate change.
- **`steps[*].reverse_cli[]`** is the operator's-own-tools sequence
  to undo the step, if the operator wants to restore the lab device
  to its pre-step state. Empty for read-only steps (no state changed,
  nothing to reverse). For mutating steps, the reverse is the
  domain-aware reverse per `DESIGN_PRINCIPLES_NEWTRON.md` §15 —
  shared resources are NOT mechanically reverted; the walkthrough
  author either chooses a symmetric reverse verb or names the
  reconcile-style restoration. A mutating step without a `reverse_cli`
  (or without `reverse_cli_rationale` explaining why no reverse
  exists) is a contract violation.
- **`steps[*].reverse_cli_rationale`** explains why the reverse
  sequence is what it is, OR why no reverse exists. For baseline
  operations whose reverse is reconcile per §15, the rationale
  names the reconcile path explicitly.
- **`steps[*].verify_step_completion`** is the operator's
  self-check for finishing the step. `what_to_check` describes the
  substrate observation that confirms the step completed;
  `if_missing` describes what to do if the observation does not
  match (typically: diagnose the lab-device's tooling, since the
  walkthrough is teaching the substrate, not the operator's lab).
- **`see_also[]`** is REQUIRED on every walkthrough. It cross-links
  to the newtron-mediated counterpart (the Inbox card, the
  Composer apply, the Workbench revert, etc.) and to the
  underlying newtron principle. Per operator-philosophy invariant
  #5 ("why-mode is always available"), every walkthrough surfaces
  the principle it operationalizes; per the refined invariant #2,
  it also surfaces the newtron-mediated path so the operator can
  choose which one to use in production.

**Errors:**
- Unknown `walkthrough_id` → 404 with
  `kind: "precondition_failure"`,
  `details.condition: "walkthrough_unknown"`,
  `details.condition_details: { walkthrough_id }`,
  `details.next_action_hint: { verb: "list_walkthroughs", endpoint: "/api/rehearsal/walkthroughs" }`.

### What this surface does not do (binding)

The Rehearsal teaching surface explicitly excludes the following
shapes. They are not deferred-for-later; they are excluded by the
refined invariant #6.

1. **No runtime sandbox.** No session, no forked intent DB, no
   simulated CONFIG_DB. The surface never asks newtron to simulate
   anything. If a contributor proposes adding a session shape "for
   single-step practice without a lab device," the Architecture
   Reviewer rejects on principle: the refined invariant #6 says
   rehearsal must rehearse the case where newtron is the failure
   mode, and a newtron-mediated session does not.
2. **No drill injection.** No endpoint causes newtron to inject a
   drift entry, a zombie record, or a verify-failure primer. If a
   walkthrough needs the operator to start from a specific lab-device
   state, the walkthrough TEACHES the operator how to set up that
   state on their own lab device — it does not inject the state via
   an endpoint.
3. **No automation comparison.** Walkthroughs do not return an
   "automation would have done X" block. They teach the substrate;
   the comparison the operator should do is between their own
   hand-executed step and the actual outcome on their lab device,
   not between their action and an automated proposal. (An operator
   who wants the comparison reads the
   [§Endpoints — Manual-Mode Parity (teaching surface)](#endpoints--manual-mode-parity-teaching-surface)
   teach response for the service-instance or CONFIG_DB key in
   question — that surface names the substrate the automation would
   produce — and compares it against this walkthrough. Two different
   surfaces, two different purposes.)
4. **No state-changing endpoints.** Every endpoint on this surface
   is `GET`. There is no preview-and-apply pair; no `commit`, no
   `revert`, no `stash`. The walkthrough is teaching content; the
   change happens on the operator's lab device, executed by the
   operator on their own tools.
5. **No `as_of` field.** The surface does not observe live newtron
   state. Walkthroughs are static content versioned by
   `content_version`.

### Out of scope for v0 (deferred Contract PRs)

The following extensions are deliberately deferred. They are NOT a
return to the runtime sandbox — they are extensions to the teaching
surface that preserve the read-only, no-newtron-mediation discipline.

- **Operator-authored walkthroughs.** v0 walkthroughs are curated by
  the Architect. Operator-authored walkthroughs (saved scenarios,
  parameter-templated walkthroughs, shareable walkthrough libraries)
  require an authoring surface and are deferred. The deferred shape
  is still read-only on consume; only the authoring path differs.
- **Per-step transcripts.** A way for the operator to record their
  observed outcome at each step (for self-assessment, instructor
  review, or post-practice journaling) is deferred. v0 walkthroughs
  are read-only and stateless; transcripts would add per-operator
  state.
- **Walkthrough-completion records.** A way for the operator to mark
  a walkthrough "completed" against their identity is deferred until
  the auth model lands (auth is itself deferred per CLAUDE.md §Project
  Scope).
- **Embedded lab-device provisioning hints.** v0 names the
  `lab_device_kind` and `recommended_setups[]`; it does not provide
  copy-pasteable provisioning recipes (e.g., a sonic-vs bring-up
  script). Provisioning is newtlab's domain; pointing at newtlab
  recipes by URL is acceptable in v0, but embedding them is deferred
  to keep this surface narrowly about teaching the failure-scenario
  substrate.

### Hard contract guarantees (binding)

Every endpoint in this section MUST satisfy:

1. **Read-only.** Every endpoint is `GET`. No endpoint mutates
   newtron state or newtcon-server state. A contributor who proposes
   a `POST` on this surface is making the case for re-introducing
   the runtime sandbox; the Architecture Reviewer rejects on
   principle.
2. **Static content, no live observation.** Walkthroughs do not
   query newtron's live state. No `as_of`, no `intent_count`, no
   `projection_rebuilt_at` on this surface. The catalog is versioned
   by `content_version`.
3. **CLI commands target the operator's own tools, never newtron or
   newtcon.** `forward_cli` and `reverse_cli` use `ssh_redis_cli` or
   `ssh_vendor_cli` exclusively; a walkthrough step whose CLI
   includes `newtron`, `newtron-server`, `newtcon`, or `newtcon-server`
   commands is a contract violation. (Pointers to newtron-mediated
   paths live in `see_also[]`, separate from the
   operator's-own-tools sequence.)
4. **Every walkthrough names a lab-device practice ground.**
   `lab_device_guidance` is REQUIRED. The reframed invariant #6
   demands real-tool rehearsal on operator-owned hardware; a
   walkthrough that does not point at a practice ground violates the
   invariant the surface exists to honor.
5. **Substrate-grounded teaching.** Every walkthrough's `teaches[]`
   is substrate-grounded; every step's `purpose` and
   `expected_outcome` are in substrate terms. Per operator-philosophy
   invariants #3 ("the substrate is the teaching surface") and #5
   ("why-mode is always available"), every `rationale_ref` points at
   a concrete document section, not at a generic statement.
6. **Symmetric reverse per §15.** Every mutating step has a
   `reverse_cli` (or a `reverse_cli_rationale` explaining why the
   reverse is reconcile, per `DESIGN_PRINCIPLES_NEWTRON.md` §15's
   baseline exception). Walkthroughs that mutate the lab device
   without a reversal path leave the lab device in an unknown state;
   they are rejected on §15 grounds.


## Endpoints — Observation History

The Observation History surface is **newtcon's persistent record of what
the substrate looked like over time, and how it changed**. It is the
contract realization of operator-philosophy invariant #9 ("Confidence
and limits are explicit") layered on top of invariant #1 ("No black
boxes") and invariant #3 ("The substrate is the teaching surface"):
the operator must be able to ask "what did this device's CONFIG_DB
look like at 14:02:11Z yesterday?", "what changed between 14:00 and
15:00?", and "did this change come through newtron or did someone
edit CONFIG_DB directly?" — and receive substrate-grounded answers,
with explicit acknowledgement of the windows during which newtcon
could not observe.

Every other surface in this contract reads live substrate at query
time. Observation History is the **only** newtcon-owned persistent
state, and the boundary is binding per `CLAUDE.md` §No Hidden State:
operational state (intent, projection, ChangeSet, drift detection) is
never cached persistently; observation history is the dedicated
exception, and is exposed honestly with `as_of` timestamps and
`observation_gap` markers wherever polling missed a window.

### Why this lives in newtcon, not newtron

A change-history layer in newtron would violate three newtron principles
the operator's #37 issue identified directly:

- **§1 ("The Node — Intent and Reality in One Object")** designs newtron
  to eliminate the parallel-representations problem by collapsing intent
  and reality into one object. A change-history table would be a third
  representation alongside intent and reality, reintroducing the
  duality §1 exists to prevent.
- **§20 ("On-Device Intent Is Sufficient for Reconstruction")** and §21
  ("Reconstruct, Don't Record") establish that current intent records
  plus current specs are sufficient to reconstruct expected state. §21
  is explicit: "Completed operation history is not intent. It belongs
  in structured logging or an external store, not in the device's
  configuration database." A change history says newtron's own substrate
  isn't sufficient — for newtron's mission (reconstruct expected state,
  detect drift, reverse operations) it IS sufficient; for newtcon's
  operator-facing mission (observation over time, including out-of-band
  changes) it is not, and the gap belongs to newtcon, not newtron.
- **§27 ("Single-Owner CONFIG_DB Tables")** would be violated by an
  on-device change-history table competing with NEWTRON_INTENT for
  who-records-what.

This is binding even though newtron's `docs/newtron/api.md` §11
documents a `GET /network/{netID}/node/{device}/history` endpoint, a
`POST .../rollback-history` endpoint, and a per-Node `max_history`
device setting (schema-registered at `pkg/newtron/device/sonic/schema.go`
as a bounded integer). These are **aspirational stubs** — they are not
registered in `pkg/newtron/api/handler.go` `buildMux()`, the Go
implementation has no history-tracking code in `pkg/newtron/network/`,
and the "rollback N most recent operations" pattern they imply is
exactly the journal-and-replay pattern §21 rejects ("A journal is a
second copy of information that already exists in a more authoritative
form... The reconstruction approach uses current specs by definition —
there is no stale copy to diverge"). The newtron-side gap is not a
gap newtcon should propose to fill, because filling it on the newtron
side would put newtron in violation of its own principles. The history
substrate belongs to newtcon.

Change history is **observation-over-time of newtron's substrate**, and
observation is newtcon's job. newtron has **intent records**
(NEWTRON_INTENT, surfaced via the Provenance endpoints); newtcon adds
**observation history**, which is broader (it covers out-of-band
changes that produce no NEWTRON_INTENT record). The two are not
redundant; they answer different questions over the same substrate.

**Historical changes made via newtcon must be maintained by
newtcon.** When the operator drives a Composer apply, an Inbox
action, or a Workbench commit, newtcon-server IS the agent of the
change. It captures the operation's ChangeSet at apply time (per
`CLAUDE.md` §Preview Before Commit and the Provenance retention
contract); it records the pipeline trace and verify assertion (per
§Endpoints — Operations); it knows the operator identifier and the
originating surface. The historical record of those changes is
therefore newtcon's responsibility by construction — newtron holds
the current intent records and the current device CONFIG_DB, but the
question "what did newtcon do, when, on whose behalf, with what
substrate effect?" is answered from newtcon's own retained operation
history (the `operation_url` / `intent_url` / `changeset_url`
companions surfaced on every change entry). The observation polling
layer is what extends that record to cover the operator's own manual
changes via ssh + redis-cli (taught by the
[§Endpoints — Manual-Mode Parity (teaching surface)](#endpoints--manual-mode-parity-teaching-surface)
but executed on the operator's tools, not via a newtcon endpoint —
so newtcon learns about them through observation, not initiation)
and other out-of-band changes that newtcon did not initiate. The
combined surface — newtcon-mediated changes (authoritative) plus
polled observations (best-effort) — is what this contract section
governs.

### The polling layer (operational model)

The Observation History surface is read-only at the HTTP boundary. The
records it returns are produced by a **newtcon-server-side polling
layer** that periodically reads newtron's existing endpoints and stores
the results in newtcon's local SQLite store. The polling layer is the
substrate of this surface; this contract describes only its outward
shape.

Polling discipline (operator-philosophy invariant #9 made operational):

- **Cadence is minutes, not seconds.** Observation history is for
  operator review and forensics, not real-time monitoring. The default
  per-Node interval is in minutes; the surface exposes the current
  effective interval per Node so the operator sees how often each
  Node is being observed (no hidden cadence).
- **Adaptive frequency.** A Node whose snapshots are stable across
  successive polls polls less frequently; a Node whose recent
  snapshots showed change polls more frequently. The exact algorithm
  is an implementation concern, but the **current effective cadence
  is visible at the contract**.
- **`observation_gap` markers are first-class.** When polling fails
  (newtron-server unreachable, network partition, newtcon-server
  process restart, configured cadence skip), the window is recorded
  as a typed `observation_gap` entry — NOT as missing data. The
  surface is honest about "we did not know during this window";
  operator-philosophy invariant #9 is binding.

### `source` classification — `newtron_mediated` vs `out_of_band`

Every observed change is classified by `source`. The classification
is the operator's first lever for separating "the automation did
this" from "someone bypassed the automation."

- **`newtron_mediated`** — newtcon-server can correlate the observed
  change to a known operation in its operations store (one of: a
  Composer apply, a Workbench commit, an Inbox action, a
  Provisioning operation — all post-rebalance delivered by the
  browser frontend over newtrun-server per ADR-0001, with the
  operations store populated by newtcon-server observing
  newtrun-server's run state per §Operations capture-path) by
  matching the substrate writes the operation produced against the
  diff between the prior and current observation. The
  `operation_url` companion field is populated. The correlation
  composes two substrates: newtcon-server's operations store
  (long-lived per-operation history per ADR-0001 §B.1) and the
  Observation History polling layer's per-Node snapshots; the match
  is the substrate-grounded answer to "which run-mediated
  operation produced this observed change." Notably absent from
  this list: any "newtcon-mediated manual write" source. The
  refined invariant #2 removed that path (see
  [§Endpoints — Manual-Mode Parity (teaching surface)](#endpoints--manual-mode-parity-teaching-surface));
  operator manual writes via ssh + redis-cli are taught by newtcon
  but executed by the operator, so they appear in observation
  history as `out_of_band` (the operator was the agent; neither
  newtcon-server nor newtrun-server was in the path).
- **`out_of_band`** — newtcon observed a substrate change for which
  it cannot find a correlated operation. Either someone wrote
  CONFIG_DB directly via a non-newtcon path (a different newtron
  client, a manual redis-cli session against the device, a
  daemon-driven write), OR an operation completed during an
  `observation_gap` window and newtcon never captured the pre-state
  to correlate against. The classification surfaces honestly which
  of these two sub-cases applies via the `out_of_band_subkind`
  field; an out-of-band change adjacent to a gap is distinguished
  from one observed cleanly.

The classification supports the **Concrete success vision** in
`docs/operator-philosophy.md`: the operator who suspects
device-vs-automation disagreement reads observation history to
identify out-of-band changes, picks the failed write, and runs it
manually against the device using their own tools. The history
surface is the lever that makes that workflow possible.

### Storage substrate (informational, not contractual)

For v0, the polling layer's substrate is **SQLite** in
`internal/history/` (per the operator's choice in newtcon#37).
File-based, single-process, transactional, sufficient for one
operator's scale. The choice is an implementation concern; the
contract surface is storage-agnostic. Migration to a different store
(timeseries DB, embedded KV) is non-contract-breaking provided the
HTTP shapes here are preserved.

### Identifiers and retention

The surface mints opaque IDs:

| ID | Minted by | Resolves to (internally) |
|----|-----------|--------------------------|
| `change_id` | The polling layer, per detected diff between two adjacent observations on one Node | `(node, from_observation_id, to_observation_id)` |
| `observation_id` | The polling layer, per successful snapshot capture | `(node, observed_at)` |
| `gap_id` | The polling layer, per `observation_gap` window | `(node, gap_started_at, gap_ended_at?)` |

All IDs are opaque; consumers MUST pass them back unchanged. The
addressing tuple is documentation, not a wire contract.

Retention for v0 is **not pinned in this contract**. The polling
layer retains history as long as SQLite holds it; pruning policy,
compression, and indexing for time-series queries are out of scope
for newtcon#37 (the operator's issue body explicitly defers these)
and will land in a follow-up Contract PR once the v0 surface is in
use. Endpoints below that take a `?at=` timestamp predating the
earliest retained observation return 404 with
`kind: "precondition_failure"` and `condition: "observation_evicted"`
(a new bounded condition added to the §Error Schema enum below).

### Additions to §Error Schema — `precondition_failure.condition` enum

The Observation History surface adds four entries to the bounded
`precondition_failure.condition` enum defined in §Error Schema
(`details for kind: "precondition_failure"`). These are bounded; new
conditions are a Contract PR.

| `condition` | When | `condition_details` shape |
|-------------|------|---------------------------|
| `observation_evicted` | A timestamp or `change_id` / `observation_id` / `gap_id` was retained at some point but has been pruned per retention policy | `{ id?, requested_at?, earliest_retained_at }` |
| `observation_gap_at_requested_time` | The snapshot endpoint was queried for a timestamp inside an `observation_gap` window AND outside the caller's `tolerance` | `{ requested_at, nearest_observation_at, gap_id, gap_url, gap_started_at, gap_ended_at? }` |
| `change_unknown` | `change_id` was never minted by the polling layer | `{ change_id }` |
| `gap_unknown` | `gap_id` was never minted by the polling layer | `{ gap_id }` |

`condition_details.id` populates when the precondition is on an
opaque ID (`change_id`, `observation_id`, or `gap_id`);
`condition_details.requested_at` populates when the precondition is on
a `?at=` timestamp; `earliest_retained_at` is always populated on
`observation_evicted` so the operator knows the boundary of newtcon's
memory.

The `observation_gap_at_requested_time` condition is surfaced as a
precondition failure rather than as a silent fall-back to the
nearest-prior observation, because the operator's question ("what was
the substrate at time T?") has a substantively different answer when T
falls inside a gap. Returning the nearest-prior observation without
surfacing the gap would teach the operator that newtcon has data it
does not have — exactly the false-confidence pattern invariant #9
rejects.

### `as_of` semantics on this surface

Two timestamps appear on every Observation History response and must
not be conflated:

- **`as_of`** — when newtcon-server completed the read against its
  local SQLite store. Reflects the freshness of the response
  envelope, not the freshness of the underlying observation.
- **`observed_at`** — when the polling layer captured the
  observation from newtron. The substrate the response describes
  was true at `observed_at`, not at `as_of`. The two are typically
  minutes apart.

A response whose `as_of` is recent but whose nearest `observed_at`
is older than the configured cadence interval surfaces the gap via
adjacent `observation_gap` records, not by hiding the staleness.
Operator-philosophy invariant #9 is binding.

### Companion fields and shared types

This surface re-uses substrate vocabulary defined elsewhere in the
contract, never re-coining it:

- **`SubstrateLocator`** — the same `{ kind, network, node, table,
  key, field, intent_key }` shape used by the §Rehearsal and §Error
  Schema sections.
- **`CliCommand`** — the same `{ tool, command, rationale,
  rationale_ref }` shape used by the §Rehearsal `forward_cli` /
  `reverse_cli`. The `tool` enum is the same two values
  (`ssh_redis_cli`, `ssh_vendor_cli`); the `undo_command_sequence`
  returned by this surface is a list of `CliCommand` entries.
- **`DriftEntry`** — the canonical `{ table, key, type, expected,
  actual }` shape used by `kind: "drift"` Inbox cards and by
  `drift_refusal` errors. Diffs between observed snapshots use
  `DriftEntry[]`, not a parallel diff type (per
  `DESIGN_PRINCIPLES_NEWTRON.md` §46 rule 3, "one typed diff
  vocabulary").
- **`rationale_ref`** — the typed `{ substrate, principle }` object
  used everywhere else; string-only `rationale_ref` is rejected at
  contract level.
- **`manual_equivalent`** — the typed `{ newtron_cli, newtron_http
  }` object with `newtron_http.status` bounded by `available |
  partial_match | pending_newtron_gap | deferred_indefinitely |
  not_applicable`. The bounded enum and the per-shape rules
  (including the `re_evaluation_trigger` requirement on
  `deferred_indefinitely`) are defined canonically at
  §Shared substrate shapes "`manual_equivalent.newtron_http`".

### `GET /api/history/nodes/{node}`

List observed changes on one Node, ordered most-recent-first.
Idempotent; safe to poll. No newtron-side state mutated; no
newtcon-server state mutated.

**Path parameters:**

| Param | Description |
|-------|-------------|
| `node` | The Node name (e.g., `switch1`). Unknown Node → 404 `precondition_failure` with `condition: "node_unknown"`. |

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `from` | RFC 3339 timestamp | unset | Lower bound (inclusive) on `observed_at`. |
| `to` | RFC 3339 timestamp | unset | Upper bound (inclusive) on `observed_at`. |
| `source` | string (repeatable) | unset (all sources) | Filter by `source` classification. One of `newtron_mediated`, `out_of_band`. Unknown values → 400 `validation_failure`. |
| `substrate_kind` | string (repeatable) | unset (all substrate kinds) | Filter to changes touching specific substrate kinds. One of `intent_record`, `configdb_key`, `projection_row`. Unknown values → 400 `validation_failure`. |
| `table` | string (repeatable) | unset | Filter to changes touching specific CONFIG_DB tables (e.g., `BGP_NEIGHBOR`). Composes with `substrate_kind`. |
| `include_observation_gaps` | bool | `true` | When `true`, `observation_gap` markers are interleaved with `change` entries in the timeline. When `false`, only `change` entries are returned. |
| `cursor` | string (opaque) | unset | Pagination cursor returned in `next_cursor` of a prior response. |
| `limit` | int | `100` | Page size (max 500). |

A `from > to` request → 400 `validation_failure` with
`rejections[*].reason == "out_of_range"`.

**Response 200:**

```json
{
  "node": "switch1",
  "network": "default",
  "as_of": "2026-05-26T14:15:32Z",
  "window": {
    "from": "2026-05-26T13:00:00Z",
    "to": "2026-05-26T14:15:32Z"
  },
  "poller_state": {
    "current_interval": "PT3M",
    "current_interval_rationale": "stable: last 6 snapshots produced no diff",
    "last_observed_at": "2026-05-26T14:13:00Z",
    "next_scheduled_at": "2026-05-26T14:16:00Z",
    "active_gap": null
  },
  "entries": [
    {
      "entry_kind": "change",
      "change_id": "<opaque>",
      "change_url": "/api/history/changes/<opaque>",
      "observed_at": "2026-05-26T14:13:00Z",
      "from_observation_id": "<opaque>",
      "to_observation_id": "<opaque>",
      "from_observed_at": "2026-05-26T14:10:00Z",
      "to_observed_at": "2026-05-26T14:13:00Z",
      "source": "newtron_mediated",
      "source_rationale_ref": {
        "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object",
        "principle": "docs/operator-philosophy.md#concrete-success-vision-operators-as-participants"
      },
      "operator": "operator:aldrin",
      "operation_url": "/api/operations/<opaque>",
      "operation_verb": "ApplyService",
      "intent_url": "/api/intents/<opaque>",
      "changeset_url": "/api/changesets/<opaque>",
      "out_of_band_subkind": null,
      "diff_summary": {
        "substrate_kinds_touched": ["configdb_key", "intent_record"],
        "tables_touched": ["BGP_NEIGHBOR", "ROUTE_MAP", "NEWTRON_INTENT"],
        "entry_count_total": 14,
        "by_type": { "added": 12, "removed": 0, "modified": 2 }
      }
    },
    {
      "entry_kind": "observation_gap",
      "gap_id": "<opaque>",
      "gap_url": "/api/history/nodes/switch1/observation_gaps/<opaque>",
      "gap_started_at": "2026-05-26T13:42:00Z",
      "gap_ended_at": "2026-05-26T13:54:00Z",
      "duration": "PT12M",
      "cause": {
        "kind": "newtron_unreachable | newtcon_server_restart | scheduled_skip | poller_error",
        "underlying_error": "connection_refused | dns_failure | tls_handshake_failure | timeout | http_5xx | process_lifecycle | unknown",
        "underlying_error_message": "dial tcp 127.0.0.1:8080: connect: connection refused",
        "missed_poll_count": 4,
        "expected_interval_during_gap": "PT3M"
      },
      "diff_across_gap": {
        "any_change_observed_at_resume": true,
        "diff_summary": {
          "substrate_kinds_touched": ["configdb_key"],
          "tables_touched": ["VLAN"],
          "entry_count_total": 1,
          "by_type": { "added": 0, "removed": 0, "modified": 1 }
        },
        "rationale": "the next successful observation at 13:54:00Z differed from the last pre-gap observation at 13:42:00Z; the change is recorded as a separate change entry adjacent to this gap, with source classification influenced by gap-adjacency",
        "adjacent_change_id": "<opaque>",
        "adjacent_change_url": "/api/history/changes/<opaque>"
      },
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
        "principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit"
      }
    }
  ],
  "next_cursor": null,
  "totals_in_window": {
    "change_count": 17,
    "by_source": {
      "newtron_mediated": 15,
      "out_of_band": 2
    },
    "observation_gap_count": 1,
    "observed_at_minimum": "2026-05-26T13:02:00Z",
    "observed_at_maximum": "2026-05-26T14:13:00Z"
  },
  "manual_equivalent": {
    "newtron_cli": null,
    "newtron_http": {
      "status": "not_applicable",
      "rationale": "Observation history is newtcon-owned by design (see §Endpoints — Observation History, 'Why this lives in newtcon, not newtron'). No newtron HTTP endpoint exists or will exist; an operator reproducing this view manually polls newtron's existing substrate reads (the bulk-CONFIG_DB read at `GET /network/{n}/node/{d}/configdb`, the raw intent-table read at `GET /network/{n}/node/{d}/configdb/NEWTRON_INTENT`, and the projection read at `GET /network/{n}/node/{d}/intent/projection`) at the same cadence newtcon does and computes the diffs themselves; per-snapshot the same reads are enumerated on `GET /api/history/nodes/{node}/snapshot` `source_reads[]`. The operator's-tools alternative is to query newtcon's SQLite store directly: `sqlite3 <newtcon-state>/history.db 'SELECT ...'`."
    }
  }
}
```

Field rules:

- **`entries[]`** interleaves `entry_kind: "change"` and
  `entry_kind: "observation_gap"` records ordered by their
  representative timestamp (`observed_at` for changes,
  `gap_started_at` for gaps), most-recent-first. The two kinds
  appear in one timeline because the operator's question is "what
  did newtcon observe (or not observe) over time?" — collapsing
  gaps into a separate stream would teach the operator to read
  history without limits. Per invariant #9, the gap markers are
  shown in-line.
- **`entry_kind: "change"`** is the per-detected-diff record. The
  `from_observation_id` / `to_observation_id` pair identifies the
  two snapshots whose diff produced this change; consumers walk
  from a change entry to its endpoint-snapshots via the snapshot
  endpoint below.
- **`source`** is the bounded classification described above.
  `source_rationale_ref` points at the substrate principle that
  governs the classification (§1) and the operator-philosophy
  section that explains why the classification is binding (the
  Concrete success vision).
- **`operator`** is populated for `newtron_mediated` changes where
  newtcon-server's operation history captured an operator
  identifier (e.g., `operator:aldrin`, or `newtcon-server` when the
  change was synthesized by an automated newtcon flow). For
  `out_of_band` changes, `operator` is `null` (newtcon does not
  know — and per invariant #9, does not pretend to know).
- **`operation_url` / `intent_url` / `changeset_url`** are
  populated for `newtron_mediated` changes whose correlated
  newtcon-server operation is still retained per
  §Endpoints — Operations "Retention window" (terminal floor 30
  days, in-flight floor 7 days; deployment may extend). All three
  are `null` for `out_of_band` changes. For `newtron_mediated`
  changes whose operation has been evicted from operations
  retention, all three are `null` and `out_of_band_subkind` is
  `null` (the source is still `newtron_mediated` — the
  substrate's classification is durable even when the operation
  trace is not). Observation history typically retains longer
  than the operations store (Observation History retention is per
  §Endpoints — Observation History "Identifiers and retention",
  deferred to a follow-up Contract PR), so an observed change
  can outlive its originating operation trace; this is the
  expected case once the operation crosses its retention floor.
- **`out_of_band_subkind`** is populated only on `source:
  "out_of_band"` entries. Bounded:
  - `unmediated_observed` — the change was observed between two
    successful adjacent snapshots; newtcon definitely missed no
    polls. The change happened by a path outside newtcon's
    knowledge (different newtron client, direct redis-cli, daemon
    write). Confidence: high.
  - `gap_adjacent` — the change was observed at the first
    successful snapshot after an `observation_gap`. The change
    MIGHT have been newtron-mediated by an operation newtcon
    missed seeing during the gap; newtcon cannot distinguish.
    Confidence: low; the operator interpretation is the
    authoritative one.
  The discriminator is binding: a UI that renders all
  `out_of_band` entries identically would hide the
  gap-adjacent-vs-clean distinction the operator needs to
  interpret the substrate. Invariant #9 made literal at the per-
  entry level.
- **`diff_summary`** is counts-only at this level; the full
  `DriftEntry[]` diff is reached via
  [`GET /api/history/changes/{change_id}`](#get-apihistorychangeschange_id).
  Per invariant #1 ("no black boxes"), counts and summaries do
  not substitute for the substrate; this endpoint surfaces the
  counts for timeline rendering, and the substrate is one click
  away via `change_url`.
- **`poller_state`** is REQUIRED and substantive. The operator
  must see how often this Node is currently being observed and
  why (`current_interval_rationale`). `active_gap` is non-null
  when there is currently an open `observation_gap` for this Node
  (the last poll failed and the gap is ongoing); the operator
  sees that newtcon does not currently know the Node's substrate.
  Per invariant #9, the operator never has to ask "is the data
  up to date?" — the polling state is on every list response.
- **`window`** echoes the requested `from` / `to` (or the
  defaulted bounds when unset — the earliest retained observation
  and `as_of` respectively). The operator sees the exact window
  the response covered.
- **`totals_in_window`** is computed over the full filtered
  window, not over the returned page. Operators who paginate
  through a multi-page result see the same totals on every page,
  per `CLAUDE.md` §No Hidden State (the count is a property of
  the substrate, not of pagination).

**Errors:**

- Unknown `node` → 404 `precondition_failure` with `condition:
  "node_unknown"`.
- `from > to` → 400 `validation_failure` with
  `rejections[*].reason: "out_of_range"`.
- `from` predating the earliest retained observation → 200 (the
  response covers the retained portion of the requested window;
  `window.from` is clamped to `earliest_retained_at` and
  `totals_in_window` reflects the clamped window). NOT an error —
  retention boundary is a normal condition. The frontend renders
  a "no observation before earliest_retained_at" marker.
- `source` or `substrate_kind` filter with unknown enum value →
  400 `validation_failure` per the typed Error Schema.
- newtron-server unreachable → 200 with the response served from
  newtcon's SQLite store (the polling layer's role is to capture
  state when newtron IS reachable; the read surface does not
  depend on newtron at request time). `poller_state.active_gap`
  reflects the current connectivity reality.

### `GET /api/history/nodes/{node}/snapshot`

Return the observed snapshot for one Node nearest to a requested
timestamp. Idempotent; safe to poll.

**Path parameters:**

| Param | Description |
|-------|-------------|
| `node` | The Node name. Unknown Node → 404 `precondition_failure` with `condition: "node_unknown"`. |

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `at` | RFC 3339 timestamp | REQUIRED | Target timestamp. Returns the nearest-prior observation. |
| `tolerance` | duration | `null` (unbounded) | Maximum delta between `at` and the returned observation's `observed_at`. If the nearest-prior observation is older than `at - tolerance`, return 404 `precondition_failure` with `condition: "observation_gap_at_requested_time"`. |
| `include_configdb` | bool | `true` | Include the captured raw CONFIG_DB snapshot in the response. When `false`, only the addressing + intent-records + projection are returned. |
| `include_intents` | bool | `true` | Include the captured NEWTRON_INTENT records. |
| `include_projection` | bool | `true` | Include the captured projection. |

A timestamp of "now" reads the most-recent observation.

**Response 200:**

```json
{
  "node": "switch1",
  "network": "default",
  "as_of": "2026-05-26T14:15:32Z",
  "requested_at": "2026-05-26T14:00:00Z",
  "observation": {
    "observation_id": "<opaque>",
    "observed_at": "2026-05-26T13:58:00Z",
    "observation_age_at_request": "PT2M",
    "preceded_by_gap_id": null,
    "configdb": {
      "VLAN": {
        "Vlan100": { "vlanid": "100" }
      },
      "BGP_NEIGHBOR": {
        "default|10.0.0.1": { "asn": "65001", "local_addr": "10.0.0.0" }
      }
    },
    "intents": [
      {
        "resource_key": "interface|Ethernet0",
        "fields": { "op": "apply-service", "name": "transit", "state": "actuated" }
      }
    ],
    "projection": {
      "tables": [
        {
          "table": "BGP_NEIGHBOR",
          "entries": [
            {
              "key": "default|10.0.0.1",
              "fields": { "asn": "65001", "local_addr": "10.0.0.0" },
              "owning_intent_resource_key": "interface|Ethernet0"
            }
          ]
        }
      ],
      "intent_count": 47
    },
    "drift_at_observation": {
      "drift_entries": [],
      "summary": {
        "entry_count": 0,
        "by_type": { "missing": 0, "extra": 0, "modified": 0 }
      },
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#drift-guard-actuated-mode",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object"
      }
    },
    "source_reads": [
      {
        "newtron_endpoint": "GET /network/default/node/switch1/configdb?owned_only=true",
        "newtron_endpoint_status": "available",
        "captured_at": "2026-05-26T13:58:00Z"
      },
      {
        "newtron_endpoint": "GET /network/default/node/switch1/configdb/NEWTRON_INTENT",
        "newtron_endpoint_status": "available",
        "captured_at": "2026-05-26T13:58:00Z"
      },
      {
        "newtron_endpoint": "GET /network/default/node/switch1/intent/projection",
        "newtron_endpoint_status": "available",
        "captured_at": "2026-05-26T13:58:00Z"
      }
    ]
  },
  "manual_equivalent": {
    "newtron_cli": null,
    "newtron_http": {
      "status": "available",
      "method": "GET",
      "path": "/network/default/node/switch1/configdb",
      "query": { "table": "<repeatable>", "owned_only": "true" }
    }
  }
}
```

Field rules:

- **`observation.observation_age_at_request`** is the duration
  between `requested_at` and `observed_at`. The operator sees how
  closely newtcon's nearest snapshot matched the requested
  timestamp; per invariant #9, the operator never has to compute
  staleness themselves.
- **`observation.preceded_by_gap_id`** is non-null when this
  observation is the first successful snapshot after an
  `observation_gap`. The operator inspecting a snapshot
  immediately post-gap sees the gap reference inline. The gap's
  full detail is reached via `gap_url` on the
  `observation_gap` entry in the timeline endpoint.
- **`observation.configdb`** is the raw `RawConfigDB`
  (`table → key → field → value`) returned verbatim by newtron's
  `GET /network/{n}/node/{d}/configdb?owned_only=true` substrate
  read (landed Phase 1 of the newtron lead's 2026-05-27
  substrate-faithful batch; closed
  [newtron#17](https://github.com/aldrin-isaac/newtron/issues/17)).
  Per §46, the wire shape mirrors the substrate.
- **`observation.intents[*]`** carries the raw NEWTRON_INTENT
  record fields read from newtron's
  `GET /network/{n}/node/{d}/configdb/NEWTRON_INTENT` substrate
  read — the generic per-table CONFIG_DB read scoped to the
  NEWTRON_INTENT table. Returns the same `RawConfigDB`-shaped
  table (`key → field → value`) the polling layer already decodes
  for `observation.configdb`, with every NEWTRON_INTENT field
  preserved verbatim (`op`, `name`, `state`, `parents`,
  `user_params`, `resolved_params`, `created_at`, `applied_at`).
  newtron's lead closed
  [newtron#18](https://github.com/aldrin-isaac/newtron/issues/18)
  by resolving via this substrate plus the structured
  `GET /network/{n}/node/{d}/intent/tree` view; the polling layer
  reads the raw table form because (i) it is byte-for-byte the
  substrate stored on the device (`/intent/tree` collapses
  intents into TopologyStep records per §46, dropping `state`,
  `parents`, `created_at`, `applied_at`, and the
  `resolved_params` half of dual-purpose intents per newtron's
  intents §22, which the polling layer needs to distinguish
  `newtron_mediated` from `out_of_band` changes); and (ii) it
  reuses the `RawConfigDB` decoder already exercised on
  `observation.configdb` (one decoder for both polled
  substrates, smaller per-poll cost).
- **`observation.projection`** is the projection captured at
  observation time. The polling layer reads newtron's substrate
  endpoint at `GET /network/{n}/node/{d}/intent/projection`
  (landed under
  [newtron#5](https://github.com/aldrin-isaac/newtron/issues/5)
  Phase 1, 2026-05-27; returns bare `sonic.RawConfigDB` per §46)
  and stores the captured `RawConfigDB` map verbatim. The
  per-table grouping (`tables[*].entries[*]`) and the
  `owning_intent_resource_key` attribution are computed by
  newtcon-server at storage time from the substrate plus the
  companion intent-tree capture; this matches the same
  substrate-vs-decoration separation documented on
  `GET /api/projection/nodes/{node}` (the live
  projection-by-Node read).
- **`observation.drift_at_observation`** is the diff between
  `configdb` and `projection` at observation time, captured by
  the polling layer so the operator sees what newtron's drift
  detection would have reported at that moment. NOT computed at
  request time — that would conflate "what newtron's drift
  detection said then" with "what newtron's drift detection says
  now."
- **`source_reads[]`** documents which newtron endpoint produced
  each portion of the observation. Per `CLAUDE.md` §No Hidden
  State, observation history is honest about its inputs. Each
  read carries the same `newtron_endpoint_status` discriminator
  vocabulary as `manual_equivalent.newtron_http.status` (bounded
  enum and per-shape rules defined canonically at
  §Shared substrate shapes "`manual_equivalent.newtron_http`"),
  so the operator knows which newtron capability is currently
  exercised.

**Errors:**

- Unknown `node` → 404 `precondition_failure` with `condition:
  "node_unknown"`.
- Missing `at` → 400 `validation_failure` with
  `rejections[*].reason: "missing_required"`.
- `at` predating the earliest retained observation → 404
  `precondition_failure` with `condition: "observation_evicted"`
  and `condition_details.earliest_retained_at`.
- `at` inside an `observation_gap` window AND beyond `tolerance`
  → 404 `precondition_failure` with `condition:
  "observation_gap_at_requested_time"`.
- `at` after the most recent observation (e.g., querying for a
  time in the future) → 200 returning the most recent
  observation with `observation_age_at_request` negative; NOT an
  error. The operator who queries "now" sees the latest captured
  snapshot.

### `GET /api/history/nodes/{node}/diff`

Return the diff between any two observed snapshots on one Node.
Idempotent; safe to poll.

**Path parameters:**

| Param | Description |
|-------|-------------|
| `node` | The Node name. Unknown Node → 404. |

**Query parameters (exactly one of the two addressing pairings):**

| Param | Type | Description |
|-------|------|-------------|
| `from` | RFC 3339 timestamp | Lower bound; the diff's "before" snapshot is the nearest-prior observation. |
| `to` | RFC 3339 timestamp | Upper bound; the diff's "after" snapshot is the nearest-prior observation. |
| `from_observation_id` | string (opaque) | Alternative addressing: name the "before" snapshot directly. |
| `to_observation_id` | string (opaque) | Alternative addressing: name the "after" snapshot directly. |

Mixing the two addressing modes in one request → 400
`validation_failure`.

Additional query parameters:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `substrate_kind` | string (repeatable) | unset (all kinds) | Restrict the diff to one or more substrate kinds (`intent_record`, `configdb_key`, `projection_row`). |
| `table` | string (repeatable) | unset (all tables) | Restrict CONFIG_DB-key diffs to specific tables. |

**Response 200:**

```json
{
  "node": "switch1",
  "network": "default",
  "as_of": "2026-05-26T14:15:32Z",
  "from": {
    "observation_id": "<opaque>",
    "observed_at": "2026-05-26T13:00:00Z",
    "snapshot_url": "/api/history/nodes/switch1/snapshot?at=2026-05-26T13:00:00Z"
  },
  "to": {
    "observation_id": "<opaque>",
    "observed_at": "2026-05-26T14:13:00Z",
    "snapshot_url": "/api/history/nodes/switch1/snapshot?at=2026-05-26T14:13:00Z"
  },
  "gaps_in_window": [
    {
      "gap_id": "<opaque>",
      "gap_url": "/api/history/nodes/switch1/observation_gaps/<opaque>",
      "gap_started_at": "2026-05-26T13:42:00Z",
      "gap_ended_at": "2026-05-26T13:54:00Z",
      "duration": "PT12M"
    }
  ],
  "changes_in_window": [
    {
      "change_id": "<opaque>",
      "change_url": "/api/history/changes/<opaque>",
      "observed_at": "2026-05-26T14:13:00Z",
      "source": "newtron_mediated",
      "operation_url": "/api/operations/<opaque>"
    }
  ],
  "configdb_diff": [
    {
      "table": "BGP_NEIGHBOR",
      "key": "default|10.1.0.1",
      "type": "missing | extra | modified",
      "expected": { "asn": "65002", "local_addr": "10.1.0.0" },
      "actual": { "asn": "65003", "local_addr": "10.1.0.0" }
    }
  ],
  "intent_diff": [
    {
      "resource_key": "interface|Ethernet0",
      "type": "added | removed | modified",
      "from_fields": null,
      "to_fields": { "op": "apply-service", "name": "transit", "state": "actuated" }
    }
  ],
  "projection_diff": [
    {
      "table": "ROUTE_MAP",
      "key": "TRANSIT_IN_A1B2C3D4",
      "type": "missing | extra | modified",
      "expected": null,
      "actual": { "match_prefix_list": "TRANSIT_PFX_C9E1B7A4" }
    }
  ],
  "summary": {
    "configdb_diff_count": 4,
    "intent_diff_count": 2,
    "projection_diff_count": 3,
    "tables_touched": ["BGP_NEIGHBOR", "ROUTE_MAP", "NEWTRON_INTENT"],
    "by_source_in_window": {
      "newtron_mediated": 1,
      "out_of_band": 0
    }
  },
  "honesty": {
    "spans_observation_gap": true,
    "spans_observation_gap_rationale": "the diff window contains a 12-minute observation_gap during which newtcon did not poll; changes that occurred entirely within the gap are NOT recorded as discrete change_id entries and contribute to the diff only insofar as their effects were observed at the first successful post-gap snapshot. The operator interpreting this diff must account for that limit.",
    "rationale_ref": {
      "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
      "principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit"
    }
  }
}
```

Field rules:

- **`configdb_diff`, `intent_diff`, `projection_diff`** are
  computed at request time from the two captured snapshots
  identified in `from` and `to`. Per `DESIGN_PRINCIPLES_NEWTRON.md`
  §46 rule 3 ("one typed diff vocabulary"), `configdb_diff` and
  `projection_diff` use the `DriftEntry` shape (`table`, `key`,
  `type`, `expected`, `actual`). `intent_diff` uses an analogous
  per-intent shape since intent records are not table+key
  substrate at newtron's vocabulary; the shape is
  `{ resource_key, type, from_fields, to_fields }`. The
  `from_fields` / `to_fields` are the raw NEWTRON_INTENT hashes
  before/after.
- **`gaps_in_window[]`** lists every `observation_gap` whose
  window overlaps `[from.observed_at, to.observed_at]`. The
  operator sees explicitly which gaps the diff straddles before
  interpreting it; per invariant #9, the diff is presented with
  its limits inline.
- **`changes_in_window[]`** lists the discrete change records
  that fall inside the diff's window, ordered by
  `observed_at`. Each change is one observed transition; the
  aggregate diff between `from` and `to` is the composition of
  these changes. The operator who needs the per-change view
  follows `change_url`.
- **`honesty.spans_observation_gap`** is `true` when any entry
  in `gaps_in_window` exists. The `rationale` field is REQUIRED
  when `spans_observation_gap == true` and explains the limit
  to the operator in domain terms; an empty rationale violates
  invariant #9.

**Errors:**

- Unknown `node` → 404 `precondition_failure` with `condition:
  "node_unknown"`.
- Mixed `from` / `to` and `from_observation_id` /
  `to_observation_id` → 400 `validation_failure`.
- Either timestamp or `observation_id` predating earliest
  retention → 404 `precondition_failure` with `condition:
  "observation_evicted"`.
- `from > to` (or `from_observation_id` corresponding to a
  later observation than `to_observation_id`) → 400
  `validation_failure` with `rejections[*].reason:
  "out_of_range"`.

### `GET /api/history/changes/{change_id}`

Return the full substrate-level detail for one observed change,
including the pre- and post-state substrate, the derived undo
command sequence, and the source classification rationale.

Idempotent; safe to poll. No state mutated.

**Path parameters:**

| Param | Description |
|-------|-------------|
| `change_id` | Opaque ID minted by the polling layer. Unknown → 404 `precondition_failure` with `condition: "change_unknown"`. Evicted → 404 `precondition_failure` with `condition: "observation_evicted"`. |

**Response 200:**

```json
{
  "change_id": "<echoed>",
  "node": "switch1",
  "network": "default",
  "as_of": "2026-05-26T14:15:32Z",
  "observed_at": "2026-05-26T14:13:00Z",
  "from_observation_id": "<opaque>",
  "from_observation_url": "/api/history/nodes/switch1/snapshot?at=2026-05-26T14:10:00Z",
  "to_observation_id": "<opaque>",
  "to_observation_url": "/api/history/nodes/switch1/snapshot?at=2026-05-26T14:13:00Z",
  "from_observed_at": "2026-05-26T14:10:00Z",
  "to_observed_at": "2026-05-26T14:13:00Z",
  "source": "newtron_mediated",
  "source_classification": {
    "source": "newtron_mediated",
    "correlation": {
      "operation_id": "<opaque>",
      "operation_url": "/api/operations/<opaque>",
      "operation_verb": "ApplyService",
      "operation_completed_at": "2026-05-26T14:12:50Z",
      "match_method": "changeset_writes_match_observed_diff",
      "match_confidence": "high"
    },
    "rationale": "the operation's captured ChangeSet writes exactly match the observed substrate diff; no out-of-band writes were detected between the two snapshots",
    "rationale_ref": {
      "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
      "principle": "docs/operator-philosophy.md#concrete-success-vision-operators-as-participants"
    }
  },
  "out_of_band_subkind": null,
  "operator": "operator:aldrin",
  "intent_url": "/api/intents/<opaque>",
  "changeset_url": "/api/changesets/<opaque>",
  "substrate_before": {
    "configdb_relevant_subset": {
      "BGP_NEIGHBOR": {}
    },
    "intents_relevant_subset": [],
    "projection_relevant_subset": {
      "tables": []
    }
  },
  "substrate_after": {
    "configdb_relevant_subset": {
      "BGP_NEIGHBOR": {
        "default|10.1.0.1": { "asn": "65002", "local_addr": "10.1.0.0" }
      }
    },
    "intents_relevant_subset": [
      {
        "resource_key": "interface|Ethernet0",
        "fields": { "op": "apply-service", "name": "transit", "state": "actuated" }
      }
    ],
    "projection_relevant_subset": {
      "tables": [
        {
          "table": "BGP_NEIGHBOR",
          "entries": [
            {
              "key": "default|10.1.0.1",
              "fields": { "asn": "65002", "local_addr": "10.1.0.0" },
              "owning_intent_resource_key": "interface|Ethernet0"
            }
          ]
        }
      ]
    }
  },
  "configdb_diff": [
    {
      "table": "BGP_NEIGHBOR",
      "key": "default|10.1.0.1",
      "type": "missing",
      "expected": null,
      "actual": { "asn": "65002", "local_addr": "10.1.0.0" }
    }
  ],
  "intent_diff": [
    {
      "resource_key": "interface|Ethernet0",
      "type": "added",
      "from_fields": null,
      "to_fields": { "op": "apply-service", "name": "transit", "state": "actuated" }
    }
  ],
  "projection_diff": [
    {
      "table": "BGP_NEIGHBOR",
      "key": "default|10.1.0.1",
      "type": "missing",
      "expected": null,
      "actual": { "asn": "65002", "local_addr": "10.1.0.0" }
    }
  ],
  "undo_command_sequence": {
    "kind": "derived_from_pre_change_state",
    "kind_rationale_ref": {
      "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove",
      "principle": "docs/operator-philosophy.md#2-manual-mode-parity"
    },
    "commands": [
      {
        "tool": "ssh_redis_cli",
        "command": "redis-cli -h switch1 -p 6379 DEL 'BGP_NEIGHBOR|default|10.1.0.1'",
        "rationale": "remove the BGP_NEIGHBOR entry added by this change",
        "rationale_ref": {
          "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
          "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#4-sonic-is-a-database--treat-it-as-one"
        }
      },
      {
        "tool": "ssh_redis_cli",
        "command": "redis-cli -h switch1 -p 6379 DEL 'NEWTRON_INTENT|interface|Ethernet0'",
        "rationale": "remove the NEWTRON_INTENT record that was written for this change so newtron's drift detection does not re-attempt the BGP_NEIGHBOR write on the next reconcile",
        "rationale_ref": {
          "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#1-the-node--intent-and-reality-in-one-object",
          "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#27-single-owner-config_db-tables"
        }
      }
    ],
    "honesty": {
      "is_authoritative_reversal": false,
      "is_authoritative_reversal_rationale": "the undo sequence is mechanically derived from the observed diff; it reproduces the pre-change CONFIG_DB and NEWTRON_INTENT state but does NOT re-run newtron's symmetric-reverse pipeline (per DESIGN_PRINCIPLES_NEWTRON §15, the canonical reverse is the inverse operation rendered by newtron, not a mechanical undo). The mechanical undo is correct as a substrate reversal but does not produce a newtron operation trace, an intent record reversal, or a verify assertion. Operators who need the canonical reverse stage it via the browser-frontend Change Workbench workflow using the §15 symmetric-reverse verb (delivered over newtrun-server per ADR-0001); the undo_command_sequence is the manual-mode operator-tools alternative when neither newtcon-server nor newtrun-server is in the path.",
      "rationale_ref": {
        "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove",
        "principle": "docs/operator-philosophy.md#2-manual-mode-parity"
      }
    }
  },
  "manual_equivalent": {
    "newtron_cli": null,
    "newtron_http": {
      "status": "not_applicable",
      "rationale": "Per-change detail is computed by newtcon from its captured observations and the newtcon-server operations log; newtron has no equivalent endpoint because the change-history substrate (observation-over-time) is not newtron's substrate. The operator who reproduces this view manually polls the same underlying newtron substrate reads the polling layer uses — documented on `GET /api/history/nodes/{node}/snapshot` `source_reads[]` — at the same cadence newtcon does, and computes the diff themselves; or, when newtron is unavailable, runs the `undo_command_sequence` above against the device directly."
    }
  }
}
```

Field rules:

- **`substrate_before` / `substrate_after`** are the per-change
  endpoint snapshots, scoped to the substrate the diff touches
  ("relevant_subset"). The full snapshots are reachable via
  `from_observation_url` / `to_observation_url`. Per invariant #1,
  the operator sees the substrate, not a summary; the
  scoping-to-relevant-subset is a rendering accommodation, not a
  substrate elision.
- **`source_classification.match_method`** is bounded:
  - `newtcon_initiated_authoritative` — the operation was authored
    by the operator through a browser-frontend workflow that
    newtcon-server captured into its operations store (Composer
    apply, Inbox action, Workbench commit — all delivered over
    newtrun-server per ADR-0001; newtcon-server observes each
    operation as a run on newtrun-server and writes the
    operation_id + ChangeSet + verify assertion into its store per
    §Operations capture-path). The correlation is not inferential
    against this composed substrate; newtcon-server's operations
    store IS the authoritative record of operator-initiated changes
    in the rebalanced architecture. The observed diff is validated
    against the captured ChangeSet writes for substrate-
    consistency, but the correlation itself is authoritative —
    "historical changes made via newtcon must be maintained by
    newtcon" is operationalized at this level. Confidence: high.
  - `changeset_writes_match_observed_diff` — newtcon's captured
    ChangeSet for the operation exactly matches the observed
    substrate diff. Used when the operation was reported by
    newtron (e.g., a topology-driven provisioning operation
    surfaced via newtron's substrate, OR a newtcon-initiated
    operation whose direct trace was lost and the diff had to be
    correlated against the ChangeSet retention store).
    Confidence: high.
  - `intent_record_addition_matches` — the observed diff added a
    NEWTRON_INTENT record whose `operation` and `resource_key`
    match a newtcon-known operation. Used when only the intent
    record is observable (not the full ChangeSet). Confidence:
    high.
  - `partial_match_with_residual` — the operation's ChangeSet
    overlaps the observed diff but residual substrate writes
    remain unexplained. The change is classified
    `newtron_mediated` with confidence `medium`; the residual is
    surfaced as a separate `out_of_band` change adjacent to this
    one.
  - `temporal_only` — newtcon has no captured ChangeSet for the
    operation (operations retention evicted it) but the
    operation's completion time falls within the diff window.
    Confidence: low; the classification is best-effort.
- **`source_classification.match_confidence`** is bounded:
  `high | medium | low`. Per invariant #9 ("confidence and
  limits are explicit"), the operator sees how strongly the
  classification is supported, not just the verdict.
- **`undo_command_sequence`** is a list of `CliCommand` entries
  (same shape as §Rehearsal). The sequence is mechanically
  derived from the observed `substrate_before` / `substrate_after`
  pair: removed entries get DEL commands; added entries get HSET
  commands restoring the pre-change fields; modified entries get
  HSET commands restoring the prior field values. The sequence is
  ordered for a clean manual replay (NEWTRON_INTENT records
  removed last on additions, restored first on removals, so the
  device's intent-projection coherence is maintained at each step
  if the operator stops mid-sequence).
- **`undo_command_sequence.honesty.is_authoritative_reversal`**
  is `false` for every entry in v0. The honest framing — this
  sequence is a substrate reversal, not a newtron-canonical
  symmetric reverse — is binding per invariant #9 and per
  `DESIGN_PRINCIPLES_NEWTRON.md` §15. An operator who needs the
  canonical reverse uses the browser-frontend Change Workbench
  workflow to stage the symmetric reverse verb (delivered over
  newtrun-server per ADR-0001); the undo command sequence is the
  operator's-own-tools fallback when neither newtcon-server nor
  newtrun-server is in the path. The honest framing is part of
  the contract, not a footnote.
- **`out_of_band_subkind`** is populated only on
  `source: "out_of_band"` entries; same bounded enum as the
  list endpoint.

**Errors:**

- Unknown `change_id` → 404 `precondition_failure` with
  `condition: "change_unknown"`.
- Evicted `change_id` → 404 `precondition_failure` with
  `condition: "observation_evicted"`.

### `GET /api/history/nodes/{node}/observation_gaps`

List `observation_gap` markers for one Node, ordered most-recent
first. Idempotent; safe to poll. The endpoint exists because the
operator must be able to ask the explicit question "what windows
does newtcon not know about?" without inferring it from interleaved
timeline reads (invariant #9 — confidence and limits are explicit
as a first-class surface, not a secondary effect).

**Path parameters:**

| Param | Description |
|-------|-------------|
| `node` | The Node name. Unknown → 404. |

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `from` | RFC 3339 timestamp | unset | Lower bound on `gap_started_at`. |
| `to` | RFC 3339 timestamp | unset | Upper bound on `gap_started_at`. |
| `include_active` | bool | `true` | When `true`, an open gap (one with `gap_ended_at: null`) is returned. When `false`, only closed gaps. |
| `cursor` | string (opaque) | unset | Pagination cursor. |
| `limit` | int | `100` | Page size (max 500). |

**Response 200:**

```json
{
  "node": "switch1",
  "network": "default",
  "as_of": "2026-05-26T14:15:32Z",
  "active_gap": null,
  "gaps": [
    {
      "gap_id": "<opaque>",
      "gap_url": "/api/history/nodes/switch1/observation_gaps/<opaque>",
      "gap_started_at": "2026-05-26T13:42:00Z",
      "gap_ended_at": "2026-05-26T13:54:00Z",
      "duration": "PT12M",
      "cause": {
        "kind": "newtron_unreachable",
        "underlying_error": "connection_refused",
        "underlying_error_message": "dial tcp 127.0.0.1:8080: connect: connection refused",
        "missed_poll_count": 4,
        "expected_interval_during_gap": "PT3M"
      },
      "diff_across_gap": {
        "any_change_observed_at_resume": true,
        "adjacent_change_id": "<opaque>",
        "adjacent_change_url": "/api/history/changes/<opaque>"
      }
    }
  ],
  "next_cursor": null,
  "totals_in_window": {
    "gap_count": 1,
    "total_duration": "PT12M",
    "any_change_observed_at_resume_count": 1,
    "by_cause_kind": { "newtron_unreachable": 1 }
  }
}
```

Field rules:

- **`active_gap`** is non-null when there is currently an open
  gap for this Node. The operator polling this endpoint sees
  whether newtcon knows the Node's state RIGHT NOW. Per
  invariant #9, current observability is on the response, not
  inferred.
- **`gaps[*].diff_across_gap.any_change_observed_at_resume`** is
  the operator's "did anything change while we were not
  looking?" answer. When `true`, the change is recorded as a
  separate `change_id` adjacent to the gap with
  `out_of_band_subkind: "gap_adjacent"` (the change MIGHT have
  been newtron-mediated by an operation newtcon missed during
  the gap; newtcon cannot distinguish, per the list endpoint's
  documentation of the subkind). The classification limit is
  surfaced honestly.

**Errors:**

- Unknown `node` → 404 `precondition_failure` with `condition:
  "node_unknown"`.

### `GET /api/history/nodes/{node}/observation_gaps/{gap_id}`

Return the full detail for one observation gap. Same shape as
the per-entry shape in the list endpoint, with two additions
(`last_observation_before_gap`, `first_observation_after_gap`)
and the REQUIRED `honesty` block.

**Response 200:**

```json
{
  "gap_id": "<echoed>",
  "node": "switch1",
  "network": "default",
  "as_of": "2026-05-26T14:15:32Z",
  "gap_started_at": "2026-05-26T13:42:00Z",
  "gap_ended_at": "2026-05-26T13:54:00Z",
  "duration": "PT12M",
  "cause": {
    "kind": "newtron_unreachable",
    "underlying_error": "connection_refused",
    "underlying_error_message": "dial tcp 127.0.0.1:8080: connect: connection refused",
    "missed_poll_count": 4,
    "expected_interval_during_gap": "PT3M"
  },
  "last_observation_before_gap": {
    "observation_id": "<opaque>",
    "observation_url": "/api/history/nodes/switch1/snapshot?at=2026-05-26T13:42:00Z",
    "observed_at": "2026-05-26T13:42:00Z"
  },
  "first_observation_after_gap": {
    "observation_id": "<opaque>",
    "observation_url": "/api/history/nodes/switch1/snapshot?at=2026-05-26T13:54:00Z",
    "observed_at": "2026-05-26T13:54:00Z"
  },
  "diff_across_gap": {
    "any_change_observed_at_resume": true,
    "adjacent_change_id": "<opaque>",
    "adjacent_change_url": "/api/history/changes/<opaque>",
    "configdb_diff_count": 1,
    "intent_diff_count": 0,
    "projection_diff_count": 1
  },
  "honesty": {
    "what_newtcon_does_not_know": "Any changes that occurred AND were reverted entirely within the gap window are invisible to newtcon. The diff across the gap reflects only the net substrate difference between last_observation_before_gap and first_observation_after_gap; intermediate states are NOT reconstructable from observation history alone. Operators investigating an incident that occurred during the gap should consult newtron's own logs, the device's vendor logs, or any external audit log.",
    "rationale_ref": {
      "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
      "principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit"
    }
  }
}
```

Field rules:

- **`honesty.what_newtcon_does_not_know`** is REQUIRED on every
  gap detail response. The wording is operator-facing and names
  the limit in domain terms — invariant #9 made literal at the
  per-gap level. A generic placeholder like "data unavailable"
  violates the contract.

**Errors:**

- Unknown `node` → 404 `precondition_failure` with `condition:
  "node_unknown"`.
- Unknown `gap_id` → 404 `precondition_failure` with `condition:
  "gap_unknown"`.

### Out of scope for v0 (deferred Contract PRs)

The following extensions are deliberately deferred. They are not
in scope for newtcon#37 (the operator's issue body explicitly
defers indexing strategy, compression/retention, and pruning).

- **Cross-Node aggregate views.** A `GET /api/history` endpoint
  scoped across the entire network ("show me every out-of-band
  change anywhere in the last hour"). Deferred until a concrete
  operator workflow demands it; v0 surfaces are per-Node because
  the operator's mental model in newtron is per-Node
  (`DESIGN_PRINCIPLES_NEWTRON.md` §8, §31).
- **Per-resource (sub-Node) history.** A path like
  `/api/history/nodes/{node}/configdb/{table}/{key}` returning
  the history of one CONFIG_DB key over time, or
  `/api/history/intents/{intent_id}/observed` returning observed
  state per intent. The current per-Node endpoints with `table`
  / `substrate_kind` filters cover the forensic use cases; the
  dedicated per-resource path is a refinement to land once
  operator usage shows the cross-cutting filter is
  insufficient.
- **Push-based change notifications.** Server-Sent Events or
  WebSocket subscriptions for live change feeds. Out of scope
  for v0; observation history is for forensics, not real-time
  monitoring (per the operator's issue: "cadence is minutes,
  not seconds"). A future surface may add live notifications,
  but it does not replace the historical surface.
- **Retention policy contract.** Pruning, compression, indexing
  for time-series queries. The operator's #37 issue defers
  these to a follow-up once v0 is in use. The current contract
  surfaces `observation_evicted` as a precondition failure so
  the surface remains honest about its memory boundary even
  before the retention policy is pinned.
- **Operator-driven snapshots.** A `POST` endpoint for the
  operator to force a snapshot capture out-of-cadence (useful
  before a high-risk change). Deferred; v0's polling cadence is
  sufficient for the operator workflows newtcon#37 names. When
  this lands, it will be a write endpoint (mutating newtcon's
  observation store), and will require the same preview/apply
  pairing as every other state-changing endpoint in this
  contract per `CLAUDE.md` §Preview Before Commit, Always.

### Hard contract guarantees (binding)

Every endpoint in this section MUST satisfy:

1. **Read-only at the HTTP boundary.** Every endpoint is `GET`.
   The polling layer mutates newtcon's SQLite store on a
   background schedule, never in response to a request on this
   surface. A contributor who proposes a `POST` on this surface
   is making the case for an operator-driven snapshot — see Out
   of Scope above; that is a future Contract PR.
2. **`observation_gap` markers are first-class.** No endpoint
   silently fills a polling gap with the nearest-prior
   observation, the nearest-next observation, or extrapolated
   data. Gaps are returned as typed records, named explicitly
   on every response that traverses one, and surfaced via the
   dedicated `/observation_gaps` endpoint. Invariant #9 is
   binding.
3. **`source` classification is present on every change.** No
   change record omits `source`. When the classification is
   uncertain (gap-adjacent, partial-match), the uncertainty is
   typed via `out_of_band_subkind` and `match_confidence`, not
   elided.
4. **Substrate is exposed, not summarized.** Per-change detail
   returns the full `substrate_before` / `substrate_after`
   relevant subsets and the full per-substrate diffs. Counts
   appear alongside the substrate, never instead of it
   (`DESIGN_PRINCIPLES_NEWTRON.md` §46 rule 1).
5. **One typed diff vocabulary.** `configdb_diff` and
   `projection_diff` use the `DriftEntry` shape; `intent_diff`
   uses the per-intent shape defined in this section, not a
   parallel summary type. The list-endpoint `diff_summary`
   counts derive from these typed diffs, not from a separate
   summary computation.
6. **`as_of` and `observed_at` are deliberately separate.**
   `as_of` is when newtcon-server completed the read; the
   captured observation's `observed_at` is when the polling
   layer captured the substrate. Conflating the two would hide
   how stale the underlying observation is at request time.
7. **Honest `manual_equivalent` framing.** Every endpoint
   declares `manual_equivalent.newtron_http.status` as one of
   the bounded values defined canonically at
   §Shared substrate shapes "`manual_equivalent.newtron_http`".
   For observation history,
   the typical answer is `not_applicable` (the substrate is
   newtcon's, not newtron's) — but the rationale field names
   the operator's-tools alternative (poll newtron's reads
   directly, or query newtcon's SQLite store). Operator-
   philosophy invariant #2 is binding: the operator can do this
   without newtcon, and the surface teaches the operator-tools
   path.
8. **Substrate vocabulary, not coined.** This surface uses
   `SubstrateLocator`, `CliCommand`, `DriftEntry`,
   `rationale_ref` as defined elsewhere in this contract. No
   parallel vocabulary is introduced; if a new term seems
   needed, the Architecture Reviewer rejects on principle (per
   `CLAUDE.md` §Design Principles, "Where newtron has a word for
   something, newtcon uses that word").

## Endpoints — Report Bug

The Report Bug surface is the structural infrastructure that closes
the loop from "operator notices a substrate failure" to "operator
participates in fixing the automation." It is the contract realization
of the
[Concrete success vision](docs/operator-philosophy.md#concrete-success-vision-operators-as-participants)
in `docs/operator-philosophy.md` — specifically the fourth bullet
("operator can point at the **exact method in the automation** that
produced the bad config") and the fifth bullet ("the operator **files
a PR** against the automation, not a ticket").

Without this surface, the operator's diagnostic work — copying the
failed `cli_command` into their own ssh session, observing the device
response by hand, comparing it to what newtron attempted, narrowing
the failure to "the automation generated bad config, not the device
rejecting good config" — is wasted effort. There is no structured
path to deliver the diagnosis back to the automation team. Today the
operator opens GitHub manually and writes a free-form issue ("this
didn't work"); the automation team then has to ask back-and-forth for
the substrate, the command attempted, the device response, the
operation context, and the affected Node's recent history. The
operator's per-write granular knowledge is reduced to a ticket-level
symptom report by the act of filing.

This surface inverts that loss. Every failed substrate operation
(`PerWrite` with `result: "rejected"`, verify-stage assertion
failures, mid-stream `error` events) carries enough context for the
operator to file a method-level bug report from inside newtcon, with
the substrate, the attempted command, the verbatim device response,
the operation context, the recent-history context, and (when newtron
verbose-mode call-site provenance is available) the exact newtron Go
method that emitted the failing write — all pre-collected, ready for
operator review, and routable to the correct repository.

The surface is also the structural ground for operator-philosophy
invariant #7 ("Errors carry the substrate") applied to bug-report
authorship: the report body IS the substrate-carrying error report.
A bug report filed through this surface cannot lose substrate by
construction; the contract guarantees the substrate is present.

### How this surface differs from other surfaces

| Surface | What it does | What it does NOT do |
|---------|--------------|---------------------|
| Browser-frontend state-changing operator workflows (Composer apply, Inbox action, Workbench commit — delivered over newtrun-server per ADR-0001) | Execute substrate operations. Stream `EventStepProgress` events from newtrun-server carrying `PerWrite` entries (per §Shared substrate shapes "PerWrite"; the upstream wire substrate is documented in newtrun-server's contract). | Author bug reports. The operator sees the failure; nothing automates the diagnostic-to-report-body translation. |
| `GET /api/operations/{operation_id}` | Inspect a single operation's pipeline trace, verify assertion, terminal state (captured by newtcon-server observing newtrun-server's run state per §Operations capture-path). | Synthesize a bug report from that trace. The data is available to read; the operator must compose the report by hand. |
| `GET /api/intents/{intent_id}` (Provenance) | Inspect an intent record's substrate, DAG context, linked ChangeSets. | Carry call-site provenance for the failing write — that is the role of `PerWrite.source`. The upstream substrate is `deferred_indefinitely` per [newtron#12](https://github.com/aldrin-isaac/newtron/issues/12) (re-evaluation trigger documented at §Streaming substrate-operation events "`source`" stub which points at newtrun-server's `EventStepProgress` substrate); until re-evaluation, `PerWrite.source` is `null` and operators classify the call-site manually. |
| **`POST /api/report-bug/preview` / `POST /api/report-bug`** (this surface) | Collect the substrate + operation context + recent-history context + (when available) call-site, route to the correct repository, render a structured Markdown body, return for operator review, and (on confirmation) deliver the body to a configured integration target. | Auto-file the report without operator review. The operator confirms the rendered body before any external system is touched, per `CLAUDE.md` §Preview Before Commit, Always. |

The surface is read-mostly with respect to upstream substrate (it
reads via `internal/newtronc/` from newtron-server for intent and
projection substrate, and via newtcon-server's operations store
[populated by observing newtrun-server's run state per
§Operations capture-path] for operation context and recent-history
context); the only state-changing effect is the production of an
external artifact (a GitHub issue, or a clipboard payload). That
external mutation is exactly why the preview/apply pairing is
mandatory on this surface — the artifact's shape and content must
be operator-approved before it lands in an external system that the
operator's collaborators will see.

### Honesty about what this surface IS NOT

This surface produces a bug-report body with all the substrate the
operator needs. It does **not**:

- Diagnose the bug. The body is structured raw substrate
  (per-write, operation, recent history, call-site when available)
  plus the operator's free-text narrative. newtcon does not infer
  "this is probably a daemon timing bug" or "this is probably a
  schema mismatch." Operator-philosophy invariant #9 ("Confidence
  and limits are explicit"): newtcon's competence stops at presenting
  the substrate; interpretation is the operator's.
- Propose a fix. No code suggestions, no PR drafts. The operator
  who authors the report may follow up with their own PR (the
  success vision's fifth bullet); newtcon does not pre-empt that
  authorship.
- Replace the operator's per-write inspection. The Report Bug
  affordance is reached AFTER the operator has watched the
  substrate stream and isolated the failing write — it is the
  finishing move, not the diagnostic. The operator who skips
  reading the `PerWrite` entries and clicks Report Bug as a
  reflex will produce a low-information report; the substrate is
  the teaching surface (invariant #3), and this surface relies on
  the operator having actually used it.
- Replace manual classification. Call-site provenance
  ([newtron#12](https://github.com/aldrin-isaac/newtron/issues/12))
  is `deferred_indefinitely` on the upstream side — the operator
  manually classifies newtron-vs-newtcon-vs-unknown via the
  request body. The surface still works without
  auto-classification — the body shape is identical, and the
  routing question is asked of the operator rather than inferred.
  The re-evaluation trigger for the upstream substrate is
  documented canonically at §Streaming substrate-operation events
  "`source`". If the trigger fires and call-site provenance ships
  later, the field becomes auto-populated; the operator may
  still override.

### Identifiers

- `report_id` — opaque, server-assigned on `POST /api/report-bug`
  (the confirm step). Used to address the filed report for status
  lookup via `GET /api/report-bug/{report_id}`. Distinct from
  `preview_id` because the report transitions from a transient
  preview to a durable record on confirm.
- `preview_id` — opaque, returned by `POST /api/report-bug/preview`,
  valid for 5 minutes. Same shape and TTL as elsewhere in the
  contract. REQUIRED by `POST /api/report-bug` per `CLAUDE.md`
  §Preview Before Commit, Always.
- `operation_id` — the operation the report references, as defined
  by §Endpoints — Operations. The Report Bug surface does not
  mint new operation IDs; it consumes existing ones.
- `per_write_seq` — OPTIONAL request input. The `seq` of a specific
  `PerWrite` entry within `operation_id`'s `per_target[*].per_write[]`
  (per §Shared substrate shapes "PerWrite"). When supplied, the
  report is scoped to one substrate operation within the operation;
  when omitted, the report covers the operation as a whole.

### Vocabulary

This surface uses the existing contract vocabulary. No new types are
coined.

- `PerWrite` — defined canonically in §Shared substrate shapes
  "PerWrite". Carries `seq`, `target`, `kind`, `substrate`,
  `result`, `cli_command`, `device_response`, `at`, `rationale_ref`,
  `source`. The Report Bug body embeds these verbatim from
  newtcon-server's operations store (which observes them from
  newtrun-server's `EventStepProgress` substrate per ADR-0001);
  the report is substrate-canonical by construction.
- Operation trace — defined in §Endpoints — Operations.
  Carries the pipeline (`Intent → Replay → Render → Deliver`),
  verify-stage assertion, terminal outcome. Embedded by reference
  (operation URL) and by the substrate fields needed to make the
  report self-contained.
- `rationale_ref` — the typed `{substrate, principle}` shape used
  throughout the contract. Carried on the report body to anchor
  the report in the substrate doc and operator-philosophy
  principle that motivates filing.
- `Error` schema — defined in §Error Schema. All non-2xx responses
  use the typed kinds and per-kind `details`.

### Where the report is rendered

The Markdown body is rendered by **newtcon-server**, not by newtron
and not by the frontend. Rationale:

- The body composes substrate from multiple sources (newtron
  operation, newtcon-server's operation store, newtcon-server's
  recent-operations history, the operator's narrative). Rendering
  in newtcon-server is the natural seam — both the JSON shape and
  the rendered Markdown are part of the same response, available
  to curl-consumers and UI consumers identically.
- Rendering in the frontend would fork the body shape between
  consumers (UI sees one Markdown, scripts see another), violating
  the contract-snapshot test's invariant that the wire shape is
  one shape.
- Rendering in newtron would put operator-presentation concerns
  inside newtron, violating `DESIGN_PRINCIPLES_NEWTRON.md` §46
  ("Wire Shape Mirrors Substrate") — newtron exposes substrate;
  presentation is newtcon's layer.

newtcon-server's rendering is mechanical and templated: the four
report templates (substrate-write-failure, verify-assertion-failure,
drift-mis-classification, mid-stream-abort) each have a known
Markdown skeleton with substrate slots filled from the operation
trace and the optional operator narrative. The template choice is
inferred from the report's scope (`per_write_seq` + the `PerWrite`'s
`kind` and `result`, or the operation's terminal outcome) and
exposed in the preview response so the operator can override.

### Where the report is delivered

The contract is **deliberately open** about the delivery mechanism.
`POST /api/report-bug` accepts a `delivery_mode` request field with
two bounded values:

- `clipboard` — newtcon-server returns the rendered Markdown body
  in the response; the frontend places it on the operator's
  clipboard, and the operator pastes it into GitHub (or their
  bug-tracker of choice) themselves. No external integration
  required. Always available, no configuration prerequisite.
- `direct_file` — newtcon-server is configured to deliver the
  report to an external bug-tracker integration (e.g., a GitHub
  token-authenticated client, a Jira webhook, a Phabricator
  endpoint). The integration is a deployment-time configuration
  concern of newtcon-server, NOT specified by this contract.
  When configured and selected, the response carries the
  external-system URL of the filed artifact. When the operator
  selects `direct_file` and no integration is configured,
  newtcon-server responds 400 with `kind: "precondition_failure"`
  and `details.condition: "delivery_integration_unconfigured"`,
  naming the missing configuration in the message.

The contract does not embed the integration command (`gh issue
create ...`, `curl ...`, etc.) into the response shape. Rationale:
operator-philosophy invariant #8 ("operator-defined automation, not
tool-imposed automation") — the deployment owner chooses the
bug-tracker integration; baking `gh` into the contract would make
GitHub the only first-class target. The contract specifies what
newtcon-server delivers (a structured body, a target classification,
operator confirmation); it does not specify how delivery is wired.

### `GET /api/report-bug/templates`

Return the catalog of bug-report templates newtcon-server can render
from. The catalog is static (versioned with the newtcon-server
binary), small, and bounded. The frontend uses this endpoint to
populate the template-selector UI; scripts use it to enumerate the
fields each template requires.

Idempotent; safe to cache. No newtron interaction.

**Response 200:**
```json
{
  "as_of": "2026-05-26T14:30:00Z",
  "templates": [
    {
      "id": "substrate_write_failure",
      "applies_to": {
        "scope": "per_write",
        "per_write_kind": ["redis_write", "redis_delete"],
        "per_write_result": ["rejected"]
      },
      "title_template": "Substrate write rejected: {table}|{key} on {node}",
      "body_sections": [
        "context",
        "failed_write",
        "what_operator_attempted_manually",
        "operation_context",
        "recent_operations_on_node",
        "call_site_provenance",
        "operator_narrative",
        "rationale"
      ],
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
        "principle": "docs/operator-philosophy.md#concrete-success-vision-operators-as-participants"
      }
    },
    {
      "id": "verify_assertion_failure",
      "applies_to": {
        "scope": "per_write",
        "per_write_kind": ["verify_read"],
        "per_write_result": ["rejected"]
      },
      "title_template": "Verify assertion failed: {table}|{key}.{field} expected={expected} actual={actual} on {node}",
      "body_sections": [
        "context",
        "verify_failure",
        "asserted_changeset",
        "what_operator_attempted_manually",
        "operation_context",
        "recent_operations_on_node",
        "call_site_provenance",
        "operator_narrative",
        "rationale"
      ],
      "rationale_ref": {
        "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#14-verify-your-writes-observe-everything-else",
        "principle": "docs/operator-philosophy.md#7-errors-carry-the-substrate"
      }
    },
    {
      "id": "drift_mis_classification",
      "applies_to": {
        "scope": "operation",
        "terminal_outcome": ["failure", "partial"],
        "error_kind": ["drift_refusal"]
      },
      "title_template": "Drift refusal looks wrong: {node} reported {entry_count} drift entries before {verb}",
      "body_sections": [
        "context",
        "drift_entries_reported",
        "what_operator_attempted_manually",
        "operation_context",
        "recent_operations_on_node",
        "call_site_provenance",
        "operator_narrative",
        "rationale"
      ],
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#5-drift-detection",
        "principle": "docs/operator-philosophy.md#1-no-black-boxes"
      }
    },
    {
      "id": "mid_stream_abort",
      "applies_to": {
        "scope": "operation",
        "terminal_outcome": ["failure"],
        "error_kind": ["internal", "newtron_unavailable"]
      },
      "title_template": "Apply aborted mid-stream on {node}: {kind} after {applied_count}/{total_count} writes",
      "body_sections": [
        "context",
        "abort_event",
        "writes_that_landed_before_abort",
        "operation_context",
        "recent_operations_on_node",
        "call_site_provenance",
        "operator_narrative",
        "rationale"
      ],
      "rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
        "principle": "docs/operator-philosophy.md#1-no-black-boxes"
      }
    }
  ],
  "manual_equivalent": {
    "newtron_cli": null,
    "newtron_http": {
      "status": "not_applicable",
      "rationale": "Bug-report templates are a newtcon presentation concern; no newtron substrate corresponds to them. The operator may instead author a bug report by hand using the operation trace at GET /api/operations/{operation_id} and the per_write[] data from the apply response — that workflow is the manual-mode parity for this surface, exposed via the operation endpoint, not via newtron."
    }
  }
}
```

Field rules:

- **`templates[]`** — the bounded catalog. New template IDs are a
  Contract PR; the four IDs above are the v0 set, scoped to cover
  the failure modes the per-write substrate exposes via
  §Shared substrate shapes "PerWrite" and the upstream
  newtrun-server `EventStepProgress` (per-write rejection,
  verify-assertion failure, drift refusal, mid-stream abort). Other failure modes (e.g.,
  zombie-detected, ref-count-warning-stuck) get templates in
  follow-up Contract PRs; until then, the operator selects the
  closest applicable template and uses the narrative to clarify.
- **`templates[*].applies_to`** — the typed predicate naming when
  this template is the recommended default. The frontend uses this
  to pre-select a template based on the operator's entry point
  (clicked Report Bug on a rejected `PerWrite` → preselect
  `substrate_write_failure`; clicked on an operation that ended in
  `drift_refusal` → preselect `drift_mis_classification`). The
  operator may always override; the predicate is a recommendation,
  not a constraint.
- **`templates[*].body_sections`** — the ordered list of section
  identifiers the rendered Markdown body will contain. These are
  bounded; the rendering logic in newtcon-server has one renderer
  per section ID. Operators reading the preview see the same
  sections enumerated, so the structure of the eventual external
  artifact is visible at preview time (invariant #1: no black
  boxes).
- **`templates[*].rationale_ref`** — the typed `{substrate,
  principle}` anchor naming what substrate the template surfaces
  and what operator-philosophy section motivates that surfacing.
  The UI renders this as a "why this template?" link per invariant
  #5 ("why-mode is always available").
- **`manual_equivalent.newtron_http.status: "not_applicable"`** —
  this is the honest answer. The substrate is newtcon's
  (presentation templates), not newtron's. The rationale field
  names the operator's-tools alternative: read the operation trace
  by hand and author the bug report directly. Per
  operator-philosophy invariant #2 (manual-mode parity), the
  operator can do this without newtcon — the parity contribution
  is exposing the operation trace at
  `GET /api/operations/{operation_id}`, not providing a
  newtcon-mediated bug-tracker.

**Errors:**
- newtron-server unreachable while serving templates → not
  applicable; this endpoint does not call newtron. The catalog is
  static.
- All other failures → 500 with `kind: "internal"` per the typed
  schema in §Error Schema.

### `POST /api/report-bug/preview`

Compute the bug-report body that would be filed for the given
`operation_id` (optionally scoped to `per_write_seq`), with the
chosen template and the operator's optional narrative. **No
external mutation.** Returns the rendered Markdown body, the
target classification, the per-section substrate the body embeds,
and a `preview_id` that REQUIRED by `POST /api/report-bug`. The
operator reviews the body before any external system is touched.

Mandatory before `POST /api/report-bug` per `CLAUDE.md`
§Preview Before Commit, Always — the contract treats production of
an external artifact (a GitHub issue, a Jira ticket) as a
state-changing operation against the operator's external collaborators,
even though no substrate is mutated.

**Request:**
```json
{
  "operation_id": "<opaque, from §Endpoints — Operations>",
  "per_write_seq": 7,
  "per_write_target": { "network": "default", "node": "switch1", "interface": "Ethernet0" },
  "template_id": "substrate_write_failure",
  "target_repository_hint": {
    "kind": "auto | newtron | newtcon | other",
    "other_repository": null
  },
  "operator_narrative": {
    "free_text": "I ran the failed cli_command myself via ssh switch1 → redis-cli -n 4 HSET 'BGP_NEIGHBOR|default|10.1.0.1' asn 65002 and got OK. The same command newtron emitted got rejected. Suspect newtron is sending a stale ASN value from before my last edit.",
    "manual_verification": {
      "performed": true,
      "performed_at": "2026-05-26T14:25:12Z",
      "command_run": "redis-cli -n 4 HSET 'BGP_NEIGHBOR|default|10.1.0.1' asn 65002 local_addr 10.1.0.0 admin_status up",
      "device_response": "(integer) 3"
    }
  }
}
```

Field rules:

- **`operation_id`** — REQUIRED. The operation the report references.
  Validated against newtcon-server's operations store; unknown
  ID → 400 with `kind: "precondition_failure"`,
  `details.condition: "operation_unknown_or_expired"`; ID known
  but evicted → 400 with `kind: "precondition_failure"`,
  `details.condition: "operation_evicted"` (with `evicted_at`
  populated). Operations are retained per the binding contract in
  §Endpoints — Operations "Retention window" (terminal floor 30
  days, in-flight floor 7 days; deployment-configured retention is
  exposed at `GET /api/health`'s `operations_retention`
  companion). A report that references an evicted operation is
  refused because the report body's substrate (pipeline trace,
  ChangeSet, verify assertion) cannot be reconstructed; the
  operator's `next_action_hint` on the error directs them to
  Observation History where the substrate diff for the
  operation's apply-time window may still be queryable.
- **`per_write_seq`** — OPTIONAL. When supplied, the report is
  scoped to one specific substrate operation within the operation.
  When supplied, `per_write_target` is ALSO REQUIRED — `seq` is
  per-target (the per-Node atomicity honesty discipline is
  upstream in newtrun-server's `EventStepProgress` substrate per
  newtron's `DESIGN_PRINCIPLES_NEWTRON.md` §11 / §46, and observed
  into newtcon-server's operations store per §Operations
  capture-path), so `(target, seq)` is the unique identifier. Supplying one without the other → 400
  `validation_failure` with
  `details.rejections[*].reason: "missing_required"`. Unknown
  `(target, seq)` within `operation_id` → 400
  `validation_failure` with
  `details.rejections[*].reason: "target_absent"` and
  `details.rejections[*].locator.substrate_field` naming the
  missing target+seq. When `per_write_seq` is omitted, the report
  covers the operation as a whole.
- **`template_id`** — OPTIONAL. When supplied, must be one of the
  template IDs from
  [`GET /api/report-bug/templates`](#get-apireport-bugtemplates).
  When omitted, newtcon-server selects the template using the
  template catalog's `applies_to` predicates against the operation
  and (when supplied) the `PerWrite` at `per_write_seq`.
  Selection logic is deterministic; the chosen template is named
  in the response (`template_id_resolved`) so the operator can see
  what was chosen and override on a subsequent preview.
- **`target_repository_hint`** — OPTIONAL. Defaults to
  `{ "kind": "auto", "other_repository": null }`.
  - `"auto"` — newtcon-server classifies the target repository
    using the `PerWrite.source` call-site if present; when
    `source` is null (the upstream substrate is
    `deferred_indefinitely` per
    [newtron#12](https://github.com/aldrin-isaac/newtron/issues/12),
    or this operation predates a future verbose-mode capture if
    the re-evaluation trigger fires), `auto` resolves to
    `"unknown"` and the preview response asks the operator to
    classify before confirmation. The classification is
    deterministic: a `source.call_site` matching
    `pkg/newtron/...` → `newtron`; a call-site internal to
    newtcon-server (which newtcon-server knows by construction) →
    `newtcon`; anything else → `unknown`.
  - `"newtron"` / `"newtcon"` — operator explicitly classifies;
    overrides any auto-classification.
  - `"other"` — operator names an external repository in
    `other_repository`. Required when `kind == "other"`.
- **`operator_narrative.free_text`** — OPTIONAL. Operator-supplied
  prose describing what they think is wrong, what they tried, and
  what they expected. The narrative is appended to the rendered
  body as its own section (`operator_narrative`); newtcon does
  not edit or summarize it.
- **`operator_narrative.manual_verification`** — OPTIONAL but
  STRONGLY RECOMMENDED. The operator's "I ran this myself"
  evidence. When `performed: true`, all four subfields
  (`performed_at`, `command_run`, `device_response`,
  `performed: true`) are REQUIRED; partial population → 400
  `validation_failure` with
  `details.rejections[*].reason: "missing_required"` naming the
  absent subfields. The manual verification populates a dedicated
  section in the rendered body that the automation team can
  compare against the `device_response` newtron captured; the
  diff between the two responses is the substrate-grounded
  isolation of device-vs-automation (operator-philosophy success
  vision, third bullet) made first-class on the bug report.

**Response 200:**
```json
{
  "preview_id": "<opaque, valid for 5 minutes>",
  "as_of": "2026-05-26T14:30:15Z",
  "operation_id": "<echoed>",
  "operation_url": "/api/operations/<opaque>",
  "per_write_seq": 7,
  "per_write_url": "/api/operations/<opaque>",
  "template_id_resolved": "substrate_write_failure",
  "template_id_requested": "substrate_write_failure",
  "template_resolution_rationale": "Selected by applies_to predicate match: scope=per_write, per_write.kind=redis_write, per_write.result=rejected.",
  "target_repository_resolved": {
    "kind": "newtron",
    "other_repository": null,
    "resolution_basis": "call_site_provenance | operator_override | unknown",
    "call_site_used": "pkg/newtron/network/node/bgp_ops.go:142 generateBgpNeighbor",
    "operator_action_required": false,
    "operator_action_message": null
  },
  "body_sections": [
    {
      "id": "context",
      "rendered_markdown": "**Operation:** ApplyService on switch1:Ethernet0 (service=transit)\n**Operation ID:** abc-123\n**Started at:** 2026-05-26T14:25:00Z\n**Terminal outcome:** failure (per-target rejected at write seq=7)",
      "substrate": {
        "operation_id": "<opaque>",
        "verb": "ApplyService",
        "target": { "network": "default", "node": "switch1", "interface": "Ethernet0" },
        "params": { "service": "transit", "ip": "10.1.0.0/31", "peer_as": 65002 },
        "started_at": "2026-05-26T14:25:00Z",
        "terminal_outcome": "failure"
      }
    },
    {
      "id": "failed_write",
      "rendered_markdown": "**Substrate:** `BGP_NEIGHBOR|default|10.1.0.1`\n**Fields attempted:**\n```\nasn=65002\nlocal_addr=10.1.0.0\nadmin_status=up\n```\n**CLI equivalent:**\n```\nredis-cli -n 4 HSET 'BGP_NEIGHBOR|default|10.1.0.1' asn 65002 local_addr 10.1.0.0 admin_status up\n```\n**Device response (verbatim):**\n```\nfrrcfgd: rejected BGP_NEIGHBOR|default|10.1.0.1: invalid asn\n```",
      "substrate": {
        "per_write": { /* full PerWrite shape per §Shared substrate shapes "PerWrite" */ }
      }
    },
    {
      "id": "what_operator_attempted_manually",
      "rendered_markdown": "Operator ran the failed CLI equivalent via ssh at 2026-05-26T14:25:12Z:\n```\nredis-cli -n 4 HSET 'BGP_NEIGHBOR|default|10.1.0.1' asn 65002 local_addr 10.1.0.0 admin_status up\n```\nDevice returned:\n```\n(integer) 3\n```\n**Interpretation:** the manual write succeeded; the automation's attempt was rejected. The difference between manual success and automation rejection isolates the failure to the automation layer.",
      "substrate": {
        "manual_verification": { /* echoed operator_narrative.manual_verification */ },
        "newtron_attempt_response": "frrcfgd: rejected BGP_NEIGHBOR|default|10.1.0.1: invalid asn",
        "interpretation_hint": "manual_succeeded_automation_rejected"
      }
    },
    {
      "id": "operation_context",
      "rendered_markdown": "**Pipeline trace:**\n- intent: complete (intent record: `service|transit|Ethernet0`)\n- replay: complete (1 step)\n- render: complete (14 entries validated, 0 rejected)\n- deliver: failed (1 entry rejected at seq=7; per-Node TxPipeline EXEC refused)\n\n**Verify:** skipped (deliver failed before verify could run).",
      "substrate": {
        "pipeline": { /* echoed from /api/operations/{operation_id} */ },
        "verify": { /* echoed */ }
      }
    },
    {
      "id": "recent_operations_on_node",
      "rendered_markdown": "**Last 10 operations on switch1 (most recent first):**\n1. 2026-05-26T14:25:00Z — ApplyService Ethernet0 (this operation; failure)\n2. 2026-05-26T13:42:14Z — RefreshService Ethernet0 (success)\n3. 2026-05-26T12:18:03Z — ApplyService Ethernet5 (success)\n... (7 more)",
      "substrate": {
        "recent_operations": [
          {
            "operation_id": "<opaque>",
            "operation_url": "/api/operations/<opaque>",
            "verb": "ApplyService",
            "interface": "Ethernet0",
            "at": "2026-05-26T14:25:00Z",
            "terminal_outcome": "failure"
          }
        ],
        "recent_operations_source": "newtcon_operations_store",
        "recent_operations_limit": 10,
        "recent_operations_available": 10,
        "recent_operations_window_hint": "operations retained per §Endpoints — Operations retention (terminal floor 30 days, in-flight floor 7 days; deployment may extend, see /api/health.operations_retention); operations older than the configured floor have been evicted"
      }
    },
    {
      "id": "call_site_provenance",
      "rendered_markdown": "**newtron call-site:** `pkg/newtron/network/node/bgp_ops.go:142 generateBgpNeighbor`\n\nThis is the Go method in newtron that emitted the failing CONFIG_DB write.",
      "substrate": {
        "source": null,
        "source_status": "deferred_indefinitely",
        "source_gap_issue": "https://github.com/aldrin-isaac/newtron/issues/12",
        "source_re_evaluation_trigger": {
          "text": "Re-evaluate if the Report Bug surface goes live and operators consistently struggle to identify methods from substrate alone — that pattern, if observed, would make this issue load-bearing.",
          "newtcon_context": ["newtcon#42", "PR #51"]
        }
      }
    },
    {
      "id": "operator_narrative",
      "rendered_markdown": "**Operator narrative:**\n\nI ran the failed cli_command myself via ssh switch1 → redis-cli -n 4 HSET 'BGP_NEIGHBOR|default|10.1.0.1' asn 65002 and got OK. The same command newtron emitted got rejected. Suspect newtron is sending a stale ASN value from before my last edit.",
      "substrate": {
        "free_text": "<echoed from operator_narrative.free_text>"
      }
    },
    {
      "id": "rationale",
      "rendered_markdown": "**Why this report exists:** newtron's automation produced a substrate write that the device rejected, but the operator's manual attempt of the same logical operation succeeded. Per operator-philosophy invariant #7 (errors carry the substrate) and the concrete success vision's third bullet (isolate device-vs-automation), this report exists so the automation team can compare the automation's `device_response` against the operator's manual `device_response` and identify why the automation's input was wrong.",
      "substrate": {
        "rationale_ref": {
          "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
          "principle": "docs/operator-philosophy.md#7-errors-carry-the-substrate"
        }
      }
    }
  ],
  "rendered_body_full": "<the full Markdown body, all sections concatenated in body_sections[] order>",
  "rendered_title": "Substrate write rejected: BGP_NEIGHBOR|default|10.1.0.1 on switch1",
  "delivery_options": [
    {
      "mode": "clipboard",
      "available": true,
      "configuration_status": "always_available",
      "configuration_message": null
    },
    {
      "mode": "direct_file",
      "available": false,
      "configuration_status": "unconfigured",
      "configuration_message": "newtcon-server has no bug-tracker integration configured; only clipboard delivery is available. To enable direct filing, configure a bug-tracker integration at deployment time."
    }
  ],
  "rationale_ref": {
    "substrate": "docs/operator-philosophy.md#concrete-success-vision-operators-as-participants",
    "principle": "docs/operator-philosophy.md#concrete-success-vision-operators-as-participants"
  },
  "manual_equivalent": {
    "newtron_cli": null,
    "newtron_http": {
      "status": "not_applicable",
      "rationale": "Bug-report authorship is a newtcon presentation concern; no newtron substrate corresponds to it. The operator may instead read the operation trace at GET /api/operations/{operation_id} (newtron-mediated via newtron-server's underlying endpoints) and author a bug report by hand in GitHub or the bug-tracker of choice — that workflow is the manual-mode parity for this surface."
    }
  }
}
```

Field rules:

- **`per_write_url`** — points to the operation endpoint (which
  carries the full per-write array); there is no dedicated
  per-PerWrite endpoint. The frontend navigates to the operation
  and scrolls to the named `seq`.
- **`template_id_resolved`** vs **`template_id_requested`** —
  surfaced separately so the operator can see when newtcon
  selected a template they did not request, and on what basis.
  Per invariant #1 (no black boxes): the template-selection
  rationale is exposed verbatim in
  `template_resolution_rationale`.
- **`target_repository_resolved.resolution_basis`** is bounded:
  - `call_site_provenance` — the `PerWrite.source` field was
    populated (a future verbose-mode surface lands after the
    [newtron#12](https://github.com/aldrin-isaac/newtron/issues/12)
    re-evaluation trigger fires, per §Streaming
    substrate-operation events "`source`"), and the
    classification follows from the call-site.
  - `operator_override` — operator supplied
    `target_repository_hint.kind` ∈ `{newtron, newtcon, other}`
    explicitly.
  - `unknown` — `source` is null AND the operator hinted `auto`
    AND newtcon-server cannot classify. In this case
    `operator_action_required: true` and
    `operator_action_message` names what the operator must
    supply (a `target_repository_hint.kind` explicit override)
    before `POST /api/report-bug` will accept the preview.
- **`target_repository_resolved.call_site_used`** is populated
  ONLY when `resolution_basis == "call_site_provenance"`; null
  otherwise.
- **`body_sections[*]`** carries BOTH the rendered Markdown for
  that section AND the typed substrate the section embeds. The
  contract-snapshot test asserts the substrate keys are
  present and well-typed; the rendered Markdown is presentation,
  the substrate is the substrate, and both surfaces are
  contract-bound per `DESIGN_PRINCIPLES_NEWTRON.md` §46 (the wire
  exposes the substrate, not only the presentation).
- **`body_sections[*].id`** values are bounded by the template's
  `body_sections[]` list. An ID not in the template → contract
  violation.
- **`body_sections[*].substrate`** for the `failed_write` section
  embeds the full `PerWrite` shape verbatim (per §Streaming
  substrate-operation events "PerWrite shape"). The bug report
  body MUST carry the full PerWrite — not a summarized form —
  per operator-philosophy invariant #7 ("errors carry the
  substrate") and `DESIGN_PRINCIPLES_NEWTRON.md` §14.
- **`body_sections[*].substrate.recent_operations_source`** is
  REQUIRED. The value `"newtcon_operations_store"` names the
  source-of-truth for the recent-operations list. **Per ADR-0001
  rebalance ([`docs/adr/0001-scope-justification-vs-newtrun.md`](docs/adr/0001-scope-justification-vs-newtrun.md)),
  the operations store the source value references is composed
  from two substrates post-rebalance**: newtcon-server's own
  observation-history records of newtcon-mediated operations (per
  §Endpoints — Operations, retained on newtcon-server) and
  newtrun-server's run state (per newtron#22's
  `GET /api/runs/{suite}`), correlated by Node and time window.
  The single source-value `"newtcon_operations_store"` is
  preserved on the wire as the operator-facing rollup; the
  underlying composition is a newtcon-server implementation
  concern. The field names the limit
  (`recent_operations_limit`, default 10), the actually-available
  count (`recent_operations_available` — may be less than the
  limit if the composed store has not yet retained 10 operations
  on this Node), and a `recent_operations_window_hint` reminding
  the operator that the list is bounded by retention. Newtron
  does not expose an operations-history endpoint and is not part
  of the composition; the substrate is newtcon + newtrun.
- **`call_site_provenance` section's
  `substrate.source_status`** is bounded by `available |
  deferred_indefinitely | not_captured` — the same
  three-state honest-lifecycle vocabulary the canonical
  `manual_equivalent.newtron_http.status` enum applies to
  this substrate (defined at
  §Shared substrate shapes "`manual_equivalent.newtron_http`";
  see also the
  `deferred_indefinitely → pending_newtron_gap → available`
  honest-lifecycle clause there). The `pending_newtron_gap`
  value is intentionally absent on this surface today because
  the upstream substrate is at the deferred-indefinitely state
  of the lifecycle, not the pending state; consumers MUST NOT
  surface a `pending_newtron_gap` rendering for `source_status`
  while
  [newtron#12](https://github.com/aldrin-isaac/newtron/issues/12)
  remains deferred. If the re-evaluation trigger fires and a
  follow-up Contract PR migrates the substrate to
  `pending_newtron_gap`, this enum is extended in the same PR.
  - `"deferred_indefinitely"` (today's default) — `PerWrite.source`
    is null because the upstream substrate has been considered
    by the newtron lead and indefinitely deferred. The section
    renders a note ("call-site provenance is deferred upstream;
    re-evaluation trigger: <`source_re_evaluation_trigger.text`>"). The
    `source_gap_issue` field points to newtron#12 and
    `source_re_evaluation_trigger` is the typed `{ text,
    newtcon_context }` object carrying the lead's verbatim
    wording from the newtron#12 deferral comment in `text` and
    the navigation cross-references (`newtcon#42`, `PR #51`)
    in `newtcon_context`. The shape and verbatim discipline are
    defined canonically at
    §Shared substrate shapes "`manual_equivalent.newtron_http`";
    the consumption site for this specific substrate is
    §Streaming substrate-operation events "`source`" (now the
    moved-stub pointing at newtrun-server's `EventStepProgress`
    substrate per ADR-0001). The body is still useful — the
    automation team can find the call-site by other means (grep
    on the substrate `(table, key)` for the emitting function);
    the report just does not auto-populate the name.
  - `"available"` — `PerWrite.source` is populated (the
    re-evaluation trigger has fired and a future verbose-mode
    surface has shipped); the section renders the call-site and
    function name. `source_gap_issue` and
    `source_re_evaluation_trigger` are `null` for this status.
  - `"not_captured"` — `PerWrite.source` is null for some
    operation-specific reason orthogonal to the upstream
    deferral (e.g., the operation predates the eventual
    verbose-mode capture, or the operator's deployment runs
    newtron without the eventual verbose mode). The section
    renders a note explaining this. `source_re_evaluation_trigger`
    is `null` for this status.
- **`delivery_options[*]`** — REQUIRED on every preview response.
  Each option names its `mode`, whether it is `available` in
  this newtcon-server deployment, the
  `configuration_status` (one of `always_available`,
  `configured`, `unconfigured`,
  `partial_configuration`), and a `configuration_message`
  explaining the status to the operator. Operator-philosophy
  invariant #9 ("Confidence and limits are explicit") is
  binding: the operator MUST be told before confirming whether
  the chosen delivery mode actually works.
- **`rendered_body_full`** and **`rendered_title`** — REQUIRED.
  The body is the concatenation of `body_sections[*].rendered_markdown`
  in order; the title is the template's `title_template` with
  substrate slots filled. Both are what would be sent to the
  external system on `direct_file` and what is placed on the
  clipboard on `clipboard`.
- **`manual_equivalent.newtron_http.status: "not_applicable"`** —
  this is the honest answer. The substrate is newtcon's. The
  rationale field names the operator's-tools alternative: read
  the operation trace and author the bug report by hand. Per
  invariant #2, the operator can do this without newtcon; the
  parity contribution is exposing the operation trace.

**Errors:**
- Unknown `operation_id` → 400 with `kind: "precondition_failure"`
  per §Error Schema, with
  `details.condition: "operation_unknown_or_expired"`.
- Evicted `operation_id` (ID was minted but retention window
  elapsed) → 400 with `kind: "precondition_failure"` per §Error
  Schema, with `details.condition: "operation_evicted"` and
  `details.condition_details.evicted_at` populated. Retention is
  per the binding contract in §Endpoints — Operations "Retention
  window".
- `per_write_seq` supplied without `per_write_target` (or vice
  versa) → 400 `validation_failure` with
  `details.validation_stage: "request"` and
  `details.rejections[*].reason: "missing_required"`.
- `(target, seq)` not present in the operation → 400
  `validation_failure` with
  `details.rejections[*].reason: "target_absent"` and
  `details.rejections[*].locator.substrate_field` naming the
  missing target.
- `template_id` not in the catalog → 400 `validation_failure`
  with `details.rejections[*].reason: "unknown_value"` and
  `details.rejections[*].allowed` listing the catalog.
- `target_repository_hint.kind == "other"` without
  `other_repository` → 400 `validation_failure`,
  `reason: "missing_required"`.
- `operator_narrative.manual_verification.performed == true`
  with one or more sibling fields missing → 400
  `validation_failure`, `reason: "missing_required"` with the
  missing subfields named.
- newtron-server unreachable while loading operation context →
  503 with `kind: "newtron_unavailable"` per §Error Schema.
  The recent-operations context, if it depends on newtron
  reads, also returns this kind; if newtcon's local store is
  sufficient (the typical case), the response succeeds with
  `recent_operations_source: "newtcon_operations_store"`.

### `POST /api/report-bug`

Confirm a previewed bug report and deliver it via the chosen
mode. The preview MUST have been issued within the last 5 minutes;
expired previews → 400 `precondition_failure` with
`details.condition: "preview_expired"`.

This is the state-changing endpoint with respect to the operator's
external collaborators: on `direct_file`, an external system
(GitHub, Jira, etc.) is mutated; on `clipboard`, the operator's
clipboard is populated by the frontend (newtcon-server returns the
body to copy). Either way, a durable record of the report is
created in newtcon-server's report store and assigned a
`report_id`.

**Request:**
```json
{
  "preview_id": "<opaque, from POST /api/report-bug/preview>",
  "delivery_mode": "clipboard | direct_file",
  "operator_confirmation": {
    "body_reviewed": true,
    "target_repository_confirmed": true
  }
}
```

Field rules:

- **`preview_id`** — REQUIRED. Echoed from the preview response.
- **`delivery_mode`** — REQUIRED. One of `clipboard` or
  `direct_file`. When `direct_file` is selected and the
  deployment has no bug-tracker integration configured (the
  preview response's `delivery_options[*].available` for this
  mode was `false`) → 400 `precondition_failure` with
  `details.condition: "delivery_integration_unconfigured"`.
- **`operator_confirmation.body_reviewed`** — REQUIRED, MUST be
  `true`. Operator attesting they read the rendered body. A
  request with `body_reviewed: false` → 400 `precondition_failure`
  with `details.condition: "body_not_reviewed"`. This is not
  enforcement of UI behavior (newtcon-server cannot see what the
  operator looked at); it is the operator's affirmative attestation
  recorded in the report's audit metadata. The frontend MUST
  prompt the operator before setting this true — operator-
  philosophy invariant #4 ("show before do") applied to
  external-artifact creation.
- **`operator_confirmation.target_repository_confirmed`** —
  REQUIRED, MUST be `true` when the preview's
  `target_repository_resolved.kind != "unknown"`. When the
  preview's resolved target was `unknown` (auto-classification
  failed and operator did not explicitly hint), this field MUST
  be `false` AND the confirm request MUST be preceded by a fresh
  preview with `target_repository_hint.kind` set to an explicit
  value. A confirm against an `unknown` target → 400
  `precondition_failure` with
  `details.condition: "target_repository_unresolved"`.

**Response 200:**
```json
{
  "report_id": "<opaque>",
  "as_of": "2026-05-26T14:31:05Z",
  "operation_id": "<echoed>",
  "operation_url": "/api/operations/<opaque>",
  "delivery_mode": "direct_file",
  "delivery_outcome": {
    "status": "delivered | clipboard_returned | failed",
    "external_url": "https://github.com/aldrin-isaac/newtron/issues/47",
    "external_id": "47",
    "external_system": "github",
    "external_repository": "aldrin-isaac/newtron",
    "delivered_at": "2026-05-26T14:31:04Z",
    "failure": null
  },
  "body_returned_for_clipboard": null,
  "title_returned_for_clipboard": null,
  "report_url": "/api/report-bug/<opaque>",
  "rationale_ref": {
    "substrate": "docs/operator-philosophy.md#concrete-success-vision-operators-as-participants",
    "principle": "docs/operator-philosophy.md#5-why-mode-is-always-available"
  }
}
```

Field rules:

- **`delivery_outcome.status`** is bounded:
  - `delivered` — `direct_file` mode succeeded; the external
    system accepted the artifact; `external_url` and
    `external_id` are populated.
  - `clipboard_returned` — `clipboard` mode; the body is
    returned for the frontend to place on the clipboard. In
    this case, `body_returned_for_clipboard` and
    `title_returned_for_clipboard` are populated;
    `external_url` and `external_id` are null.
  - `failed` — `direct_file` mode but the external system
    rejected or was unreachable. `failure` is populated with
    the same per-kind `Error` shape used elsewhere in this
    contract (`kind: "internal" | "newtron_unavailable"` —
    note: `newtron_unavailable` is used for clarity even
    though the unreachable system may be GitHub/Jira/etc.
    rather than newtron, because the failure semantics map
    cleanly; future Contract PR may introduce a dedicated
    `external_integration_unavailable` kind if this proves
    insufficient).
- **`delivery_outcome.external_system`** is informational; the
  contract does not bound it (the integration is configured at
  deployment time and may target any system). Typical values
  are `github`, `gitlab`, `jira`, `phabricator`.
- **`report_url`** — points to the durable record at
  `GET /api/report-bug/{report_id}` (see below). The operator
  can revisit any filed report and see its delivery outcome
  and follow-up status.

**Errors:**
- Expired `preview_id` → 400 `precondition_failure`,
  `details.condition: "preview_expired"`.
- Unknown `preview_id` → 400 `precondition_failure`,
  `details.condition: "preview_unknown"`.
- `delivery_mode == "direct_file"` and no integration
  configured → 400 `precondition_failure`,
  `details.condition: "delivery_integration_unconfigured"`.
- `body_reviewed: false` → 400 `precondition_failure`,
  `details.condition: "body_not_reviewed"`.
- `target_repository_unresolved` (auto-classification failed
  and no explicit hint supplied on a fresh preview) → 400
  `precondition_failure`,
  `details.condition: "target_repository_unresolved"`.
- External system unreachable during `direct_file` → the
  request still returns 200 with `delivery_outcome.status ==
  "failed"` and the typed `failure` body — the report record
  IS still created so the operator can retry; the failure is
  per-delivery, not per-report-authoring. A 5xx response is
  reserved for newtcon-server internal failures while
  attempting delivery.

### `GET /api/report-bug/{report_id}`

Return the durable record for a previously-filed bug report.
Idempotent; safe to poll. The endpoint exists so the operator can
revisit reports they have filed, see whether the external system's
artifact still exists, and follow up on resolution.

The endpoint does NOT proxy the external system's state in real
time (the external system has its own UI for that). It returns
newtcon-server's record of the report as filed, with a navigation
link to the external artifact. Optionally, when configured to do
so, newtcon-server may enrich the response with the
external-system's current state (e.g., GitHub issue open/closed,
last-updated-at) — but the enrichment is best-effort and clearly
labeled; the authoritative source for external state is the
external system.

**Response 200:**
```json
{
  "report_id": "<echoed>",
  "as_of": "2026-05-26T14:35:00Z",
  "filed_at": "2026-05-26T14:31:04Z",
  "operation_id": "<opaque>",
  "operation_url": "/api/operations/<opaque>",
  "per_write_seq": 7,
  "template_id": "substrate_write_failure",
  "target_repository": { "kind": "newtron", "other_repository": null },
  "delivery_mode": "direct_file",
  "delivery_outcome": { /* same shape as POST /api/report-bug delivery_outcome */ },
  "rendered_body_full_at_filing": "<the body as filed>",
  "rendered_title_at_filing": "<the title as filed>",
  "operator_narrative_at_filing": { /* echoed from preview */ },
  "external_state_enrichment": {
    "status": "enriched | not_enriched | enrichment_failed",
    "fetched_at": "2026-05-26T14:34:55Z",
    "state": "open",
    "title": "Substrate write rejected: BGP_NEIGHBOR|default|10.1.0.1 on switch1",
    "last_external_update": "2026-05-26T14:33:01Z",
    "labels": ["bug", "newtron-vs-device", "filed-via-newtcon"],
    "failure": null
  },
  "rationale_ref": {
    "substrate": "docs/operator-philosophy.md#concrete-success-vision-operators-as-participants",
    "principle": "docs/operator-philosophy.md#5-why-mode-is-always-available"
  }
}
```

Field rules:

- **`rendered_body_full_at_filing`** and
  **`rendered_title_at_filing`** — the body and title as
  rendered AT THE TIME of filing. Substrate may have moved
  since (the operation may have been re-run, the device may have
  recovered); the report is a historical record of what was
  filed, NOT a live view of the substrate. Per
  operator-philosophy invariant #1 (no black boxes): the
  operator can see exactly what was sent to the external system
  at the moment of filing.
- **`external_state_enrichment.status`** is bounded:
  - `enriched` — newtcon-server fetched current state from the
    external system; `state`, `title`, `last_external_update`,
    `labels` are populated.
  - `not_enriched` — newtcon-server is not configured to
    enrich, OR the report's `delivery_mode` was `clipboard`
    (no external artifact to enrich). Other enrichment fields
    are null.
  - `enrichment_failed` — newtcon-server attempted enrichment
    and failed; `failure` is populated with a typed `Error`
    body. The operator sees the failure honestly rather than
    silently seeing stale or absent enrichment.
- **`external_state_enrichment.state`** is the external system's
  state vocabulary verbatim (e.g., GitHub's `open` / `closed`);
  newtcon does not normalize across systems. Per `CLAUDE.md`
  §Operator-Honest Errors: the operator sees the external
  system's words, not a paraphrased status.

**Errors:**
- Unknown `report_id` → 404 `precondition_failure`,
  `details.condition: "report_unknown"`.
- newtron-server unreachable while loading the report's
  operation context → the response still succeeds; the report
  is a newtcon-server-owned record and does not depend on
  newtron being reachable. (newtron is only reached for the
  operation_url at navigation time, not for the report record
  itself.)

### `GET /api/report-bug/recent`

Return the operator's recently-filed bug reports, most recent
first. Cursor-paginated per the contract's pagination convention
(see §Conventions). Bounded by newtcon-server's report retention
policy (which is operator-configurable at deployment time and is
NOT specified by this contract; the OS-level filesystem or
sqlite store is the substrate).

The endpoint exists so the operator can see what they have
reported, the resolution state of each, and patterns in their own
filing (e.g., "I filed three reports against newtron's BGP
generation this week, all variations on the same daemon-rejection
pattern — maybe this is one underlying bug").

**Response 200:**
```json
{
  "as_of": "2026-05-26T14:35:30Z",
  "reports": [
    {
      "report_id": "<opaque>",
      "report_url": "/api/report-bug/<opaque>",
      "filed_at": "2026-05-26T14:31:04Z",
      "operation_id": "<opaque>",
      "operation_url": "/api/operations/<opaque>",
      "template_id": "substrate_write_failure",
      "target_repository": { "kind": "newtron", "other_repository": null },
      "delivery_mode": "direct_file",
      "delivery_status": "delivered",
      "external_url": "https://github.com/aldrin-isaac/newtron/issues/47",
      "external_state_enrichment_summary": {
        "status": "enriched",
        "state": "open"
      },
      "title_at_filing": "Substrate write rejected: BGP_NEIGHBOR|default|10.1.0.1 on switch1"
    }
  ],
  "next_cursor": null,
  "rationale_ref": {
    "substrate": "docs/operator-philosophy.md#concrete-success-vision-operators-as-participants",
    "principle": "docs/operator-philosophy.md#5-why-mode-is-always-available"
  }
}
```

Field rules:

- The list returns summary entries; the full record is reached
  via `report_url`. This matches the list-vs-detail pattern used
  across the contract — e.g., `GET /api/history/nodes/{node}`
  (list of changes on a Node) vs
  `GET /api/history/changes/{change_id}` (detail of one observed
  change).
- The retention window is deliberately under-specified in this
  contract; the operator chooses, and the substrate (a sqlite
  store) is documented in `docs/architecture.md`. Reports
  evicted under retention → 404 on
  `GET /api/report-bug/{report_id}` with
  `details.condition: "report_evicted"`.

**Errors:**
- Standard `validation_failure` on pagination params.

### Out of scope for v0 (deferred Contract PRs)

- **Templated repository routing rules.** A configuration surface
  where the operator authors "any failure on call-site
  matching `pkg/newtron/network/node/bgp_*` routes to
  newtron/bgp-issues" routing. Deferred; v0's routing is
  call-site → repo (newtron vs newtcon vs other) and the
  operator overrides per report. A richer rule engine lands when
  v0 usage shows the per-report override is friction.
- **Bug-report-driven follow-up surfaces.** A "track this report
  through to resolution; when the upstream fix lands, replay
  the failed operation" workflow. Deferred; v0 produces the
  report, full stop. The follow-up loop is operator-driven
  outside newtcon (the operator watches the GitHub issue, then
  manually replays).
- **Multi-report bundling.** "I have three related reports;
  file them as one umbrella issue with three sub-reports."
  Deferred; v0 is one report per call.
- **Bug-tracker integration enumeration.** A
  `GET /api/report-bug/integrations` that lists configured
  integration targets. Deferred; the
  `delivery_options[*]` array in the preview response covers
  the at-filing-time disclosure of available delivery modes,
  and the operator does not need a separate enumeration
  endpoint for v0.
- **Cross-operator report visibility.** "Show me reports filed
  by my teammate." Deferred until newtcon has an auth layer
  (`CLAUDE.md` §Project Scope explicitly defers auth/authz).
  v0 reports are visible to whichever operator queries the
  endpoint; this is acceptable for the no-auth deployment
  model.
- **Drift-report variants.** Beyond
  `drift_mis_classification`, a template for "newtron is
  consistently detecting drift on a (table, key) the operator
  has confirmed is correct." Deferred until concrete operator
  experience names the pattern; the v0 `drift_mis_classification`
  template is broad enough.

### Hard contract guarantees (binding)

Every endpoint in this section MUST satisfy:

1. **Substrate is carried, never summarized.** Every section in
   the rendered body has a typed `substrate` companion that
   carries the full data the section embeds. The Markdown is
   presentation; the substrate is the substrate. Per
   `DESIGN_PRINCIPLES_NEWTRON.md` §46 ("HTTP API Boundary —
   Wire Shape Mirrors Substrate") and operator-philosophy
   invariant #7 ("errors carry the substrate"). A section
   whose `substrate` is null or summarized is a contract
   violation.
2. **PerWrite is embedded verbatim.** The `failed_write`
   section embeds the full `PerWrite` shape per
   §Shared substrate shapes "PerWrite". The bug report does not
   re-serialize, re-key, or selectively elide the PerWrite —
   the automation team that reads the report sees the same
   substrate the operator saw at apply time, by construction.
3. **Operator confirmation is binding.** No external artifact
   is produced without
   `operator_confirmation.body_reviewed: true`. The
   preview/apply pairing is mandatory per `CLAUDE.md`
   §Preview Before Commit, Always — applied here to
   external-artifact creation, on the principle that producing
   an artifact in an external system the operator's
   collaborators will see is a state-changing operation.
4. **Manual verification is first-class.** The
   `manual_verification` block in the operator narrative is a
   structured field with strict atomicity (all subfields
   together or none), surfaced as its own body section, with
   an interpretation hint that compares the manual response
   to the automation's response. Per operator-philosophy
   invariant #2 (manual-mode parity refined per PR #44) and
   the success vision's third bullet (isolate
   device-vs-automation): the operator's own ssh-session
   evidence is the diagnostic primary; the report is built
   around it.
5. **Auto-classification is opt-in and always overridable.**
   The operator can always force a target repository, and the
   contract reports the basis of any auto-classification
   transparently
   (`target_repository_resolved.resolution_basis`). When
   auto-classification cannot decide (`source` is null and the
   operator did not hint), the contract refuses to confirm
   silently; it asks the operator to classify. Operator-
   philosophy invariant #9 ("Confidence and limits are
   explicit") is binding.
6. **External-system vocabulary is preserved.** When enriching
   from the external system (`external_state_enrichment`),
   the external system's own state/label vocabulary is
   carried verbatim. newtcon does not normalize "open" to
   "in_progress" or paraphrase labels. Per `CLAUDE.md`
   §Operator-Honest Errors and operator-philosophy invariant
   #1.
7. **Honest `manual_equivalent` framing.** Every endpoint in
   this section declares
   `manual_equivalent.newtron_http.status` as one of the
   bounded values defined canonically at
   §Shared substrate shapes "`manual_equivalent.newtron_http`".
   The typical answer is
   `not_applicable` (bug-report authorship is a newtcon
   presentation concern, not a newtron substrate operation) —
   but the rationale field names the operator's-tools
   alternative: read `GET /api/operations/{operation_id}` and
   author the body by hand against the external system.
   Operator-philosophy invariant #2 is binding: the operator
   can do this without newtcon.
8. **No diagnosis, no fix proposals.** The contract surfaces
   substrate, operation context, recent-history context,
   call-site (when available), and operator narrative. It does
   NOT infer root causes, suggest patches, or recommend
   automation changes. Per operator-philosophy invariant #9
   ("Confidence and limits are explicit"): newtcon's competence
   stops at presenting the substrate.
9. **Report records are durable; external state is best-effort.**
   The `report_id` and the
   `rendered_body_full_at_filing` survive the filing forever
   (or until operator-configured eviction). The
   `external_state_enrichment` is best-effort, clearly labeled
   when not available, and surfaces failures honestly rather
   than silently. The external system, not newtcon, is the
   authority on external state.
10. **Substrate vocabulary, not coined.** This surface uses
    `PerWrite`, operation trace, `rationale_ref`, and the
    `Error` schema as defined elsewhere in this contract. No
    parallel vocabulary is introduced; if a new term seems
    needed, the Architecture Reviewer rejects on principle.
