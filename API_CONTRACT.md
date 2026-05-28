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

- All requests and responses are JSON (`Content-Type: application/json`)
  except where an endpoint explicitly admits Server-Sent Events
  (`Content-Type: text/event-stream`) via Accept-header negotiation.
  Endpoints that admit SSE are enumerated in
  §Streaming substrate-operation events; no endpoint streams without
  an explicit `Accept: text/event-stream` request header.
- Timestamps are RFC 3339 UTC strings.
- Resource identifiers are domain names (e.g., service name, node name,
  interface name) — never opaque internal IDs.
- Errors return a structured `Error` object (see §Error Schema) with a
  domain-meaningful message. HTTP status codes follow the standard semantics
  but are secondary to the error body. SSE-streaming endpoints surface
  mid-stream errors per §Streaming substrate-operation events
  ("Mid-stream errors") — the `error` event carries the same typed
  `Error` body as a non-2xx JSON response.
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
top-level `error` envelope. Endpoints that report per-target failures
inside a 200 response (e.g., `POST /api/workbench/{batch_id}/commit`'s
`per_target[*].failure`) MUST use the same five `kind` values and the
matching `details` schemas defined here. A handler that invents a new
`kind` (e.g., `newtron_internal`) for a per-target failure is a contract
violation; the per-target failure has the same shape as the top-level
`error` body.

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

Existing endpoints that return `kind: "validation_failure"` per this
contract — `/api/preview` validate failures, `/api/inbox` unknown
`kind`/verb, `/api/workbench/stage` invalid targets,
`/api/workbench/{batch_id}/commit` with a dry-run `preview_id`,
`/api/workbench/{batch_id}/revert/preview` with invalid handles,
`/api/projection/nodes/{node}` unowned `table` filter,
`/api/rehearsal/walkthroughs` unknown `category` — populate this
schema. Free-form `details.allowed_verbs`,
`details.invalid_targets`, `details.invalid_handles`,
`details.owned_tables`, and `details.invalid_intent_handles` mentioned
in those sections are surfaced inside `rejections[*]` per the schema:
`reason: "unknown_value"` with `allowed`, or `reason: "target_absent"`
with `substrate_field`, etc. The free-form field names in those
sections are descriptive of the operator-visible information; the wire
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
          "inbox_card_url": "/api/inbox/<opaque>",
          "drift_card_id": "<opaque>",
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
        "stage_via": "/api/inbox/<card_id>/action/preview",
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
  operations have one entry; multi-Node operations (Composer apply,
  Workbench commit/dry-run) may have many. A drift refusal with empty
  `per_target[]` is a contract violation — the operator must know
  WHICH Node refused.
- **`drift_entries[]`** uses the `DriftEntry` schema defined by the
  `kind: "drift"` card's `detail.drift_entries[]`
  (§Endpoints — Operator Inbox). Same fields (`table`, `key`, `type`,
  `expected`, `actual`); same semantics. Re-coining a different shape
  here would teach two parallel vocabularies for the same substrate.
- **`drift_entry_count`** and **`by_type`** are summary counts that
  duplicate information derivable from `drift_entries[]`; they are
  REQUIRED because UI rendering must surface counts without parsing
  the full entries array (the entries array can be large, and the
  operator's first view is the count).
- **`inbox_card_url`** / **`drift_card_id`** point to the existing
  Inbox drift card for the same `(network, node)` tuple, when one
  exists. The operator navigates from the refusal directly to the
  card and chooses a reconciliation verb there (operator-philosophy
  invariant #5 "why-mode is always available" — every refusal is one
  click from the operator's action surface). When no Inbox card has
  been derived yet (e.g., the drift was only observed at refusal
  time and the Inbox derivation has not run), both fields are
  `null`; the operator polls `/api/inbox` and the card will appear
  on the next derivation.
- **`projection_url`** points to the Provenance projection endpoint
  for the Node so the operator sees what newtron believed the
  CONFIG_DB should be at refusal time — the half of the drift the
  device cannot show directly.
- **`guard_mode`** is `actuated` for every drift refusal in
  practice; the contract surfaces it because
  `unified-pipeline-architecture.md` §8 makes the mode the cause of
  the refusal ("actuated online: device intents are authoritative —
  the device SHOULD match its own intents"). A `topology` value is
  reserved and not currently emitted; surfacing the enum on the wire
  documents the substrate cause.
- **`resolution_hint`** names a concrete next-action verb in
  newtcon's vocabulary (`reconcile_delta` or `reconcile_full` from
  the Inbox action verb set) AND links to the preview path that
  stages it. The hint is NOT prescriptive — the operator may
  choose differently — but it is concrete enough to act on without
  reading another doc (invariant #7's "substrate-grounded
  explanation" is binding even on the refusal).

Existing endpoints that return `kind: "drift_refusal"` per this
contract — `/api/preview` and `/api/apply` on Composer,
`/api/inbox/{card_id}/action/preview` and `/api/inbox/{card_id}/action`
on Inbox, `/api/workbench/{batch_id}/dry_run` on Workbench — populate
this schema. The previously documented free-form `details.per_target[]`
on workbench dry-run with `DriftEntry[]` is the same shape as
`per_target[*].drift_entries[]` here.

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
        "preview_kind": "composer_preview | workbench_dry_run | workbench_commit_preview | workbench_revert_preview | workbench_stash_preview | workbench_restore_preview | inbox_dismiss_preview | inbox_action_preview"
      },
      "next_action_hint": {
        "verb": "re_preview",
        "endpoint": "/api/preview",
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
  Composer/Workbench operations may have many. `null` for endpoints
  that are not Node-scoped (e.g., `/api/services` listing).
- **`last_known`** is the substrate snapshot newtcon-server has from
  prior successful calls. The `kind` discriminator names what the
  payload is so the consumer parses it correctly. Today's endpoints
  populate `kind` as follows:
  - `/api/operations/{operation_id}` 503 → `kind: "operation_pipeline"`,
    `payload` is the last-observed pipeline snapshot.
  - `/api/operations/{operation_id}/verify` 503 →
    `kind: "verify_assertion"`, `payload` is the last-observed
    assertion snapshot.
  - `/api/intents/{intent_id}` 503 → `kind: "intent_record"`,
    `payload` is the most recent record snapshot in newtcon-server's
    request-cache window.
  - `/api/workbench/{batch_id}/diff` 503 → `kind: "projection_diff"`,
    `payload` is the most recent successful diff.
  - `/api/inbox` 503 (newtron_reachable false in the body, surfaced
    here when the endpoint chooses to 503 instead of degrading) →
    `kind: "inbox_cards"`, `payload` is the last-observed card set.
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
`details.unreachable_nodes[]` field. Per-endpoint sections that mention
"`details.last_known.<key>`" populate `last_known.payload` per the
discriminator table above. The `details.unreachable_nodes[]` field on
`/api/preview`, `/api/workbench/{batch_id}/dry_run`,
`/api/workbench/{batch_id}/commit/preview`, and
`/api/workbench/{batch_id}/revert/preview` populates the
`affected_nodes` field of this schema (newtron unreachable for those
specific Nodes; the rest of the network may be reachable).

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
  before the catastrophic failure (used by
  `/api/workbench/{batch_id}/commit`'s 502 path). Shape matches the
  `per_target[]` of the originating endpoint's success response.
  `null` when no partial work was completed.
- **No stack trace, no exception type, no file/line.** A
  `details.stack_trace` field is a contract violation; the
  Architecture Reviewer rejects any addition.
- **No `rationale_ref` requirement.** Unlike the other four kinds,
  `internal` does not require a `rationale_ref` because by
  construction the cause is not yet classified. When the cause IS
  known (e.g., a known newtron-server bug class), the failure
  should be re-classified as one of the other four kinds, not
  emitted as `internal` with explanatory `rationale_ref` text.

## Streaming substrate-operation events

Three state-changing endpoints — Composer `POST /api/apply`, Workbench
`POST /api/workbench/{batch_id}/commit`, and Inbox
`POST /api/inbox/{card_id}/action` — execute device-facing writes
through newtron's pipeline and admit a Server-Sent Events streaming
variant. This section defines the shared streaming shape, the
per-substrate-operation entry type (`PerWrite`) those endpoints carry
in both the JSON and SSE variants, and the negotiation rule that picks
between them.

The streaming variant exists for one reason. Operator-philosophy
invariant #1 ("no black boxes") and the concrete success vision in
[`docs/operator-philosophy.md`](docs/operator-philosophy.md#concrete-success-vision-operators-as-participants)
both reject the pattern where the operator initiates a multi-write
operation and the next thing they see is "operation complete." The
operator must watch the substrate flow — each CONFIG_DB write as
newtron commits it, each daemon-settle wait as newtron defers, each
post-deliver verify read as newtron asserts — because watching the
substrate is how the operator learns the substrate
(operator-philosophy invariant #3 "the substrate is the teaching
surface"). Aggregating ten substrate writes into one terminal "applied:
true" produces the autopilot whose pilots cannot fly. The streaming
variant is the structural break of that aggregation.

The per-write granularity is the same structural break expressed in
the terminal payload. Whether the consumer subscribes to the stream or
polls the operation endpoint, the per-substrate-operation entries are
visible at the same granularity: which specific CONFIG_DB write
landed, what the device returned verbatim, which one was rejected and
why. This is what makes the operator capable of isolating
device-vs-automation per the success vision's third point — the
operator copies the rejected `cli_command` into their own ssh session
and tries it by hand, learning whether the device or the automation is
wrong.

### Content negotiation

The variant is selected by the request's `Accept` header. The
endpoint-defined HTTP path is the same in both cases; clients pick the
shape they want:

| Request `Accept` header | Response `Content-Type` | Body |
|-------------------------|--------------------------|------|
| `application/json` (default; omitted Accept; `*/*`) | `application/json` | JSON object with `per_write[]` per target (see "PerWrite shape" below). |
| `text/event-stream` | `text/event-stream` | SSE stream: zero or more `substrate_op` events followed by exactly one `apply_complete` (success) or `error` (mid-stream failure) terminal event. |
| Anything else | — | 406 Not Acceptable with `kind: "validation_failure"`, `validation_stage: "request"`, `rejection.reason: "unknown_value"`, `locator.parameter: { name: "Accept", in: "header" }`, `allowed: ["application/json", "text/event-stream"]`. |

Streaming is opt-in, not default. The rationale: the JSON variant
remains the simplest correct integration for scripts, ops automation,
the contract-snapshot test, and any consumer that does not need
event-by-event visibility. The SSE variant is the operator-UI
affordance. Forcing every consumer to parse SSE to call apply would
trade simplicity for capability that not every consumer needs;
defaulting to SSE would also break the contract-snapshot test's
JSON-only expectation and create a class of contract-shape ambiguity
the §Error Schema vocabulary is explicit about avoiding. Operators
opt in by sending the header the standard SSE-consuming JavaScript
client (`EventSource`) sends by default.

### PerWrite shape

The per-substrate-operation entry type is shared across the three
streaming endpoints and across both variants. Each `PerWrite`
corresponds to one substrate operation newtron performed against the
device — one Redis `HSET`, one Redis `DEL`, one daemon-settle wait,
or one post-deliver verify re-read. These are the Device I/O
Operations defined by
[`unified-pipeline-architecture.md` §7](https://github.com/aldrin-isaac/newtron/blob/main/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation).
The contract surfaces them as the canonical
per-substrate-operation primitive (`DESIGN_PRINCIPLES_NEWTRON` §11
"The ChangeSet Is the Universal Contract", §46 "HTTP API Boundary —
Wire Shape Mirrors Substrate").

Shape:

```json
{
  "seq": 0,
  "operation_id": "<opaque>",
  "target": { "network": "default", "node": "switch1", "interface": "Ethernet0" },
  "kind": "redis_write | redis_delete | daemon_wait | verify_read",
  "substrate": {
    "table": "BGP_NEIGHBOR",
    "key": "default|10.1.0.1",
    "fields": { "asn": "65002", "local_addr": "10.1.0.0", "admin_status": "up" }
  },
  "result": "applied | rejected | skipped",
  "cli_command": "redis-cli -n 4 HSET 'BGP_NEIGHBOR|default|10.1.0.1' asn 65002 local_addr 10.1.0.0 admin_status up",
  "device_response": "(integer) 3",
  "at": "2026-05-25T14:06:01.847Z",
  "rationale_ref": {
    "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#7-device-io-transient-observation",
    "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#11-the-changeset-is-the-universal-contract"
  },
  "source": null
}
```

Field rules:

- **`seq`** — REQUIRED. Zero-based ordinal of this entry within the
  per-target apply sequence. Strictly monotonically increasing per
  target. Operators reading the stream rely on `seq` to detect missing
  events; consumers that buffer-and-reorder use `seq` to recover
  ordering after multiplexing across targets. `seq` is per-target, not
  global across a multi-target operation — see "Per-Node atomicity
  honesty" below for what the ordering means.
- **`operation_id`** — REQUIRED. The newtcon `operation_id` (same
  value surfaced by the JSON variant's `per_target[*].operation_id`
  and by `GET /api/operations/{operation_id}`). The same ID appears on
  every entry that belongs to one per-target apply, so consumers
  multiplexing the stream split by `operation_id`. A `PerWrite` whose
  `operation_id` does not also appear on an `apply_complete` event for
  the same target is a contract violation.
- **`target`** — REQUIRED. Same `{network, node, interface}` triple
  the endpoint's per-target results carry. `interface` is omitted for
  node-scoped verbs (`reconcile_delta`, `reconcile_full`,
  `rollback_zombie` — see §Endpoints — Operator Inbox); `network` and
  `node` are always present.
- **`kind`** — REQUIRED. Bounded enum naming which Device I/O
  Operation produced this entry:

  | `kind` | Substrate operation | When |
  |--------|---------------------|------|
  | `redis_write` | `HSET` on CONFIG_DB (Redis DB 4) | One per CONFIG_DB add or modify the ChangeSet entry produced; corresponds to `ChangeType: "add" \| "modify"`. |
  | `redis_delete` | `DEL` on CONFIG_DB | One per CONFIG_DB delete; corresponds to `ChangeType: "delete"`. RefreshService's `DEL + HSET` per `DESIGN_PRINCIPLES_NEWTRON` §11 surfaces as two consecutive `PerWrite` entries with the same `(table, key)` and different `kind`. |
  | `daemon_wait` | Inter-write settle wait, e.g., between VRF creation and BGP-neighbor creation per `DESIGN_PRINCIPLES_NEWTRON` §18 "Write Ordering and Daemon Settling" | The operator sees the wait happen explicitly; `substrate` carries `{ "table": "<table the wait is gating>", "key": "<key>", "fields": null }`; `device_response` carries the wait outcome (`"settled"` or `"timed_out"` with the elapsed duration). |
  | `verify_read` | `HGETALL` re-read by `cs.Verify(n)` per `unified-pipeline-architecture.md` §7 | One per ChangeSet entry that verify checked. `device_response` carries the re-read fields verbatim; `result: "rejected"` means the re-read disagreed with the ChangeSet (the verify assertion failed for this entry). |

  New `kind` values are a Contract PR. Streaming-only event types
  (e.g., a future `daemon_log_line`) follow the same rule.
- **`substrate`** — REQUIRED for `redis_write`, `redis_delete`,
  `verify_read`; OPTIONAL for `daemon_wait` (the substrate may not
  pin to a single `(table, key)` for cross-table settles, in which
  case `fields` is `null` and `key` carries the operation name being
  waited on, e.g., `"after-create-vrf"`).
- **`result`** — REQUIRED. Bounded enum:
  - `applied` — newtron's per-Node `TxPipeline` committed the
    substrate operation and the device acknowledged it. For
    `redis_write` / `redis_delete`, this is the `EXEC` reply field
    for this command. For `daemon_wait`, this is `"settled"`. For
    `verify_read`, this is "re-read matched the ChangeSet."
  - `rejected` — the substrate operation reached the device and was
    refused. For `redis_write` / `redis_delete`, the Redis client
    surfaced an error (rare; typically schema validation refuses the
    write before `TxPipeline` per `DESIGN_PRINCIPLES_NEWTRON` §13,
    in which case the event is not emitted at all — schema-rejected
    writes appear in the §Error Schema `validation_failure` response,
    not as a streaming `rejected` event). For `verify_read`,
    `"rejected"` means the verify assertion failed for this entry
    (`expected != actual`); the entry's `device_response` carries
    the actual re-read fields. For `daemon_wait`, `"rejected"`
    means the wait timed out.
  - `skipped` — the substrate operation was elided. For
    `verify_read`, `"skipped"` means the operation requested
    `no_save` / verify-off semantics. For `daemon_wait`, the
    settle was deemed unnecessary by newtron at execution time.
- **`cli_command`** — REQUIRED for `redis_write`, `redis_delete`,
  `verify_read`; OPTIONAL for `daemon_wait`. The exact command the
  operator would type against the device themselves to reproduce this
  substrate operation by hand — `ssh <node>` then
  `redis-cli -n 4 HSET '<table>|<key>' <field> <value>` (or `HDEL`,
  `DEL`, `HGETALL`). This is the operationalization of
  operator-philosophy invariant #2 ("manual-mode parity") refined per
  PR #44: newtcon's contribution is to **teach** the device-level
  equivalent of every automated operation. The operator copies this
  string into their own ssh session, runs it, and learns whether the
  device or the automation is wrong.

  Rendered by newtcon-server, not by newtron — see "Where `cli_command`
  is rendered" below. The command targets the device's own Redis
  instance (`-n 4` is CONFIG_DB) reached via the operator's own ssh
  session; `cli_command` does NOT reference newtron, newtron-server,
  newtcon, or newtcon-server. If the command requires shell quoting
  (key contains `|`, fields contain spaces), the single-quoting in the
  example is the canonical form; consumers paste it verbatim.
- **`device_response`** — REQUIRED on every entry. The verbatim wire
  reply from the device, captured by newtron without paraphrase.
  Per operator-philosophy invariant #7 ("errors carry the substrate")
  and `DESIGN_PRINCIPLES_NEWTRON` §14: a friendly summary that loses
  the substrate is a teaching failure. For successful writes, this is
  typically `"(integer) 3"` (number of fields HSET'd) or `"OK"`. For
  rejected writes, this is the daemon/Redis error string verbatim
  (e.g., `"ERR wrong number of arguments for 'hset' command"`,
  `"frrcfgd: rejected BGP_NEIGHBOR|10.1.0.1: invalid asn"`,
  whatever the device offered). Truncation rules match the existing
  §`details` for `kind: "newtron_unavailable"` rule for
  `underlying_error_message`: 4 KiB cap with `...[truncated]` marker
  when exceeded. For `verify_read`, the response is the actual
  re-read fields as `field=value\nfield=value\n` (the wire form
  `HGETALL` returns), so the operator can diff visually against
  `substrate.fields`.
- **`at`** — REQUIRED. RFC 3339 UTC timestamp with millisecond
  precision (operators reading a stream of 14 writes need
  sub-second resolution to see the substrate cadence). The
  timestamp is when newtron emitted the substrate operation, not
  when newtcon-server received it.
- **`rationale_ref`** — REQUIRED. Same typed `{substrate, principle}`
  shape used throughout the contract. For `redis_write` /
  `redis_delete`, both anchors point to
  `unified-pipeline-architecture.md` §7 (Device I/O Operations) and
  `DESIGN_PRINCIPLES_NEWTRON.md` §11 (ChangeSet) by default. For
  `verify_read`, `principle` points to §14 (Verify Your Writes). For
  `daemon_wait`, `principle` points to §18 (Write Ordering and Daemon
  Settling). The frontend renders `rationale_ref` as a "why this
  event?" affordance per operator-philosophy invariant #5 ("why-mode
  is always available").
- **`source`** — REQUIRED key in the schema, value REQUIRED to be
  `null` in v0. Reserved for the call-site provenance shape
  `{ call_site: "<file:line>", function: "<go-method-name>" }`,
  which would expose the newtron Go method that emitted this
  substrate operation. The newtron lead deferred the upstream
  substrate indefinitely on 2026-05-27 — the §46 substrate test
  passes but the operator-value test does not justify the §33
  reconciliation tax of keeping `Source` out of default responses
  (see
  [newtron#12](https://github.com/aldrin-isaac/newtron/issues/12)
  deep-dive comment). The contract reserves the field shape and
  key so the streaming consumer does not need a contract update
  if the upstream substrate is later re-evaluated (additive
  evolution per `DESIGN_PRINCIPLES_NEWTRON` §46's fourth rule).
  The re-evaluation trigger, byte-for-byte from the
  [newtron#12 deferral comment](https://github.com/aldrin-isaac/newtron/issues/12#issuecomment-deferral):

  ```json
  {
    "text": "Re-evaluate if the Report Bug surface goes live and operators consistently struggle to identify methods from substrate alone — that pattern, if observed, would make this issue load-bearing.",
    "newtcon_context": ["newtcon#42", "PR #51"]
  }
  ```

  The `text` subfield is the lead's verbatim wording — the
  trailing "— that pattern, if observed, would make this issue
  load-bearing" clause is load-bearing operator-honesty substance
  (the deferral lifts on *observation* of operators struggling,
  not on speculation that they will), per the verbatim discipline
  on `re_evaluation_trigger.text` defined canonically at §POST
  /api/inbox/{card_id}/action/preview
  "`manual_equivalent.newtron_http`". The `newtcon_context`
  subfield names the newtcon issue that introduced the Report
  Bug surface the trigger contemplates (`newtcon#42`) and the
  PR that landed it (`PR #51`); both are navigation affordances
  for consumers, not substrate, and are kept structurally
  separate from `text` per the canonical field shape.

  Until the trigger fires, consumers receive `null` for
  `source` and MUST tolerate it. The lifecycle's
  `manual_equivalent.newtron_http` state for this substrate is
  `deferred_indefinitely` per the canonical enum; see
  §Endpoints — Report Bug `call_site_provenance` for the
  full per-surface field shape and the `source_status`
  discriminator.

### Per-Node atomicity honesty

The streaming event sequence MUST NOT teach a false model of
newtron's atomicity. Per
[`DESIGN_PRINCIPLES_NEWTRON` §11](../newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#11-the-changeset-is-the-universal-contract)
and `unified-pipeline-architecture.md` §8: every per-Node bundle of
substrate operations is committed atomically via Redis `TxPipeline`
(`MULTI` ... `EXEC`) — within a Node, either every write lands or
none do. The streaming variant surfaces this honestly:

- For one per-Node bundle, every `redis_write` / `redis_delete`
  `PerWrite` event carries `result: "applied"` (the EXEC succeeded)
  OR every such event carries `result: "rejected"` (the EXEC was
  refused before commit, typically by schema validation per
  `DESIGN_PRINCIPLES_NEWTRON` §13). The stream MUST NOT emit a mix
  of `applied` and `rejected` for one Node's CONFIG_DB writes — that
  would teach a non-atomic substrate model the substrate does not
  have.
- The `daemon_wait` and `verify_read` events for one Node are NOT
  part of the `TxPipeline` and may have mixed `result` values. A
  daemon wait may time out (one `rejected`) even when every CONFIG_DB
  write succeeded; a verify re-read may fail (one `rejected`) for
  one CONFIG_DB entry without affecting the others. These post-EXEC
  Device I/O Operations are surfaced honestly per `result`; they do
  not contradict the per-Node atomicity claim because they are not
  part of the atomic commit.
- For multi-Node operations (Composer apply against N nodes,
  Workbench commit against N nodes, Inbox `reconcile_delta` on one
  node), the cross-Node sequence is NOT atomic per
  `DESIGN_PRINCIPLES_NEWTRON` §11. Per-target events MAY interleave
  across nodes in the stream (the per-Node calls run sequentially in
  newtron-server's execution order; events flow as they happen),
  but the `apply_complete` terminal event surfaces the per-Node
  atomicity classification of each Node — same `per_node_atomicity`
  block the JSON variant carries.

The contract's atomicity vocabulary
(`atomic_via_txpipeline`, `cross_node_atomicity.atomic: false`)
is the same in both variants; the streaming variant additionally
makes the per-substrate-operation cadence visible. An operator who
watches one Node's `redis_write` events all land in one
sub-millisecond burst is observing `TxPipeline`'s EXEC; an operator
who watches `daemon_wait` events between writes is observing
write-ordering-and-daemon-settling per §18.

### SSE event grammar

When `Accept: text/event-stream` is sent, the response body is a
Server-Sent Events stream per the W3C SSE spec. The grammar:

```
stream     ::= (substrate_op_event | comment)* terminal_event
terminal_event ::= apply_complete_event | error_event
substrate_op_event ::=
  "event: substrate_op\n"
  "id: <operation_id>:<seq>\n"
  "data: <PerWrite JSON, one line, no newlines in value>\n"
  "\n"
apply_complete_event ::=
  "event: apply_complete\n"
  "data: <apply_complete payload JSON, one line>\n"
  "\n"
error_event ::=
  "event: error\n"
  "data: <Error envelope JSON, one line>\n"
  "\n"
comment    ::= ": <keep-alive text>\n\n"   # heartbeat every 15s
```

The `id:` field on `substrate_op` events lets EventSource consumers
resume via `Last-Event-ID` if the connection drops; the
`<operation_id>:<seq>` form is opaque to the consumer (do not parse
it) and is unique per event in the stream. Consumers that do not
need resume semantics may ignore `id:`.

Heartbeat comments (per SSE spec: lines beginning with `:`) flow
every 15 seconds when the stream is otherwise idle (e.g., during a
long `daemon_wait`) so that intermediary proxies do not close the
connection. Heartbeats carry no data and MUST be ignored by
consumers.

Exactly one terminal event closes the stream. After the terminal
event, newtcon-server closes the response. Consumers MUST treat any
post-terminal bytes as a protocol violation.

### Terminal event: `apply_complete`

Emitted when the per-Node sequence reached terminal status (every
Node has committed, failed, or been recorded as `not_attempted`).
The payload IS the same JSON object the JSON-variant returns plus
one streaming-only `streaming_source` companion field that the JSON
variant does not carry (the JSON variant carries no stream, so the
field has no meaning there). This avoids forking the terminal shape
between variants for substrate fields — consumers using SSE for
live events and JSON for batch snapshots see the same per-target /
per-write / aggregate shape — while honestly disclosing the SSE
variant's derivation mode per §Newtron HTTP API dependency.

```
event: apply_complete
data: { "operation_id": "<opaque>", "per_target": [ { "node": "switch1", ..., "per_write": [ /* PerWrite[] */ ], ... } ], "aggregate": { ... }, "per_node_atomicity": [ /* same shape as JSON variant */ ], "streaming_source": { /* see below; REQUIRED on every derived apply_complete */ } }
```

#### `streaming_source` companion (SSE variant only)

REQUIRED on every `apply_complete` event emitted on the SSE
variant. Absent on the JSON variant (which is not a stream).
Operationalizes operator-philosophy invariant #9 ("confidence and
limits are explicit") for the SSE-vs-JSON timing distinction:
operators MUST be able to read the timing fidelity of the events
they just consumed without inferring it from documentation.

Shape:

```json
{
  "passthrough": false,
  "derived_from_polling_cadence_ms": 250,
  "polls_observed_during_operation": 12,
  "rationale_ref": {
    "substrate": "newtron/docs/scoping/changeset-substrate.md#cluster-b-deep-dive-2026-05-26",
    "principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit"
  }
}
```

Field rules:

- **`passthrough`** — REQUIRED. `false` in v0 (the only supported
  mode today: newtcon-server polls newtron's JSON
  `WriteResult.per_write[]` and emits derived `substrate_op`
  events). `true` would indicate newtron-side SSE passthrough —
  reserved for the contingent re-evaluation path the lead recorded
  on newtron#19 (if newtron-side SSE eventually lands). Consumers
  MUST honor `passthrough` and MUST NOT infer derivation mode from
  any other field.
- **`derived_from_polling_cadence_ms`** — REQUIRED when
  `passthrough: false`; FORBIDDEN when `passthrough: true`. The
  newtcon-server polling cadence (in milliseconds) during the
  operation. The operator reads this to understand that
  `substrate_op` events may have been observed up to this many
  milliseconds after newtron's per-Node `TxPipeline` actually
  emitted them; the cadence is NOT newtron's substrate-emission
  rate.
- **`polls_observed_during_operation`** — REQUIRED when
  `passthrough: false`; FORBIDDEN when `passthrough: true`. The
  number of polls newtcon-server made against newtron's
  `WriteResult` during this operation's lifetime. Operators
  reading the stream see how many sampling points contributed to
  the visible event sequence; a low poll count for a long-running
  operation signals reduced timing fidelity (operators tuning the
  cadence reference this).
- **`rationale_ref`** — REQUIRED. Same typed `{substrate,
  principle}` shape used throughout the contract. Default anchors
  point to newtron's scoping doc (the source of the SSE-deferral
  decision) and to operator-philosophy invariant #9. The frontend
  surfaces `streaming_source` inline on apply-completion as an
  affordance — "this event sequence was polled at 250 ms" — so the
  operator never has to dig to learn fidelity.

### Mid-stream errors

A failure that aborts the apply mid-stream is surfaced as
`event: error` with the existing typed `Error` envelope as the
payload — the same shape a non-2xx JSON response would carry. The
five `kind` values (`validation_failure`, `drift_refusal`,
`precondition_failure`, `newtron_unavailable`, `internal`) and the
matching per-kind `details` schemas (§Error Schema) apply
unchanged. The stream closes after the error event; no
`apply_complete` follows.

```
event: error
data: { "error": { "kind": "drift_refusal", "message": "...", "details": { /* per §Error Schema */ } } }
```

The HTTP status of the SSE response itself is always 200 — SSE
proxies require it. The non-2xx semantics are carried inside the
`error` event's typed envelope, not by the HTTP status. This is
exactly the trade-off W3C SSE documents (the spec does not admit
mid-stream status changes), and the contract preserves substrate
fidelity by placing the typed `Error` body in the event payload
rather than mapping it to a non-2xx HTTP status the SSE consumer
cannot read.

Partial substrate operations completed before the abort appear as
their own `substrate_op` events in normal order (each with its
honest `result`), preceding the `error` event. The operator sees
exactly what landed before the abort — operator-philosophy
invariant #1 ("no black boxes") applied to mid-stream failures.

### Where `cli_command` is rendered

The `cli_command` string is synthesized by **newtcon-server**, not
by newtron. Rationale:

- The string is operator-facing — `redis-cli -n 4 HSET '<key>'
  <field> <value>` is the form the operator types in their own ssh
  session. It is a presentation concern of the operator-UI layer,
  not a substrate fact newtron needs to know about.
- Synthesizing in newtcon-server keeps the substrate event shape
  newtron emits minimal: `{table, key, fields, op_kind}`. newtron's
  HTTP API stays substrate-canonical per
  `DESIGN_PRINCIPLES_NEWTRON` §46 ("Wire Shape Mirrors Substrate");
  the operator-presentation polish is newtcon's job.
- Synthesizing in the frontend (a third candidate location) is
  rejected because the contract-snapshot test depends on
  `cli_command` being part of the API response, not a UI artifact;
  and because curl-against-API consumers (operators inspecting via
  `curl` or scripts) must see the same `cli_command` the UI
  renders.

newtcon-server's rendering is mechanical: take the
`{kind, table, key, fields}` from the substrate event, format as
`redis-cli -n 4 HSET '<table>|<key>' <field1> <value1> ...` (or
`HDEL` for `redis_delete`, `HGETALL` for `verify_read`). Shell
single-quoting is applied to the `<table>|<key>` argument to
preserve the `|` character.

A future newtron capability that exposes a different per-write
substrate (e.g., a non-SONiC device whose substrate is not Redis
hashes) would need a different `cli_command` format. The contract
admits per-device-family rendering as a follow-up Contract PR;
v0 covers SONiC's CONFIG_DB exclusively, matching newtron's
current device support.

### Newtron HTTP API dependency

The streaming variant and the per-write granularity both depend on
newtron-server exposing per-substrate-operation results. The newtron
lead's verdict on the originating gap
([newtron#19](https://github.com/aldrin-isaac/newtron/issues/19))
landed in two parts:

- **JSON variant — AVAILABLE.** Phase 2a (newtron commit `f6b64d8`,
  2026-05-27) shipped the substrate as an additive
  `WriteResult.per_write: PerSubstrateOp[]` field on every endpoint
  in newtron's S8 / S13 / S11 write surface (`/intent/reconcile`,
  `/execute`, `/interface/{name}/apply-service`, etc.) plus inside
  the typed 409 envelope for `VerificationFailedError`
  (newtron#21, same commit). The vocabulary matches this contract
  verbatim: `kind ∈ redis_write | redis_delete | daemon_wait |
  verify_read`, `result ∈ applied | rejected | skipped`,
  `device_response` verbatim, per-Node atomicity honored within one
  Redis `TxPipeline` bundle. See newtron's `docs/newtron/api.md`
  §S11 `WriteResult` and `PerSubstrateOp` for the landed schema.
  newtcon-server consumes the field directly; no reconstruction is
  required.
- **SSE wire variant — DEFERRED INDEFINITELY.** Per the lead's
  [Cluster B deep-dive comment on newtron#19](https://github.com/aldrin-isaac/newtron/issues/19#issuecomment-4551057150):
  *"streaming is operational timing, not substrate per §46 — UX-only
  benefit; polling against the existing/scoped endpoint is
  functional. Substantial newtron infrastructure expansion not
  justified."* newtron will NOT ship an `Accept: text/event-stream`
  variant of its write endpoints in the foreseeable future. The
  re-evaluation trigger the lead recorded is
  evidence-gated: *"Implement when newtcon team's JSON-variant UI
  implementation is in flight AND operator field-use reveals
  polling-derived UX is meaningfully degraded against the Concrete
  success vision."*

The contract continues to expose both variants to newtcon's
consumers because the JSON-vs-SSE split is operator-facing — the
contract-snapshot test consumer wants JSON, the
operator-UI consumer wants SSE — and that split is meaningful
regardless of how the underlying newtron substrate is fetched.
**The SSE variant is now derived by newtcon-server**, not
passed through from newtron:

- newtcon-server polls newtron's per-operation read endpoint at a
  bounded cadence (default 250 ms during in-flight operations;
  exposed at `GET /api/health.operations_retention` for inspection;
  configurable per deployment). Each poll fetches the
  most-recent `WriteResult` snapshot — including every
  `per_write[]` entry newtron has accumulated so far.
- The newtcon-server SSE handler emits one `substrate_op` event per
  newly-observed `PerWrite` entry between polls (deduplication by
  `(operation_id, seq)`), terminated by exactly one
  `apply_complete` event when newtron's underlying operation
  reaches a terminal state. Heartbeats and `Last-Event-ID` resume
  follow the §SSE event grammar unchanged.
- Per operator-philosophy invariant #9 ("confidence and limits are
  explicit"), the contract MUST teach that the derived stream's
  per-event timing is bounded by newtcon's polling cadence — NOT
  by newtron's per-Node `TxPipeline` cadence. An operator who
  watches every `redis_write` event arrive in one sub-second burst
  is observing newtcon-server's first poll *after* the EXEC, NOT
  the EXEC itself. The cadence is honest to the operator via the
  `apply_complete` payload's
  `streaming_source.derived_from_polling_cadence_ms` field
  (additive, REQUIRED on every derived `apply_complete`; absent
  only when a future newtron SSE passthrough lands and
  `streaming_source.passthrough: true` is emitted instead).

This is the operator-honesty boundary. The contract MUST NOT teach
that SSE is forthcoming from newtron when the lead has explicitly
deferred it; the contract MUST NOT silently substitute polling
timing for substrate-emission timing without telling the operator.
Both rules are binding.

The `manual_equivalent.newtron_http.status` block on every
affected endpoint is `"available"` for the JSON variant, with
`note` documenting the polling-derived nature of the SSE variant
and `gap_issue: null` (the JSON variant is the substrate; the SSE
variant is a presentation layer over it, not a separate gap).
Operators reproducing the substrate manually do so against
newtron's JSON variant directly (see each endpoint's
`manual_equivalent.newtron_cli` companion for the exact verb).

### Endpoints that admit streaming

| Endpoint | JSON variant | SSE variant | `per_write` carried | Atomicity surface |
|----------|--------------|-------------|---------------------|-------------------|
| `POST /api/apply` | Yes (default) | Yes (Accept: text/event-stream) | Yes, in `per_target[*].per_write[]` | Per-target (one Node per target) |
| `POST /api/workbench/{batch_id}/commit` | Yes (default) | Yes (Accept: text/event-stream) | Yes, in `per_target[*].per_write[]` | Per-Node via `per_node_atomicity`; cross-Node not atomic |
| `POST /api/inbox/{card_id}/action` (verbs that produce a ChangeSet: `reconcile_delta`, `reconcile_full`, `rollback_zombie`, `retire_policy`) | Yes (default) | Yes (Accept: text/event-stream) | Yes, in `per_write[]` (single-target per call) | Per-Node (the card's Node) |
| `POST /api/inbox/{card_id}/action` (verbs that produce no ChangeSet: `acknowledge`, `clear_zombie`, `recheck`) | Yes (default) | No — these verbs produce no substrate writes; streaming would carry only an immediate `apply_complete`. Sending `Accept: text/event-stream` to these verbs returns 200 with a single-event SSE response (`apply_complete` only) for client-side variant uniformity; consumers may skip SSE on them. | `per_write: []` always | Not applicable |

Endpoints NOT in this table do not stream. `POST /api/preview`,
`POST /api/workbench/{batch_id}/dry_run`,
`POST /api/inbox/{card_id}/action/preview`, and the other preview
endpoints do not deliver substrate operations; they compute
ChangeSets without writing, so there are no Device I/O Operations
to stream. Adding streaming to a preview endpoint would teach a
false model — the operator would see "substrate events" for a
dry-run that touches no device. Stash, restore, revert/preview,
and dismiss/preview likewise produce no Device I/O Operations
and do not stream.

The revert endpoint (`POST /api/workbench/{batch_id}/revert`)
DOES deliver substrate operations and SHOULD admit streaming on
the same principle. v0 of this contract section reserves the SSE
variant for the three endpoints in the table; the revert
streaming variant is a follow-up Contract PR. The follow-up edits
this table; the §Streaming substrate-operation events section is
otherwise unchanged.

## Endpoints — Service Composer (first surface)

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

### `GET /api/services`

List all service specs defined in the network.

**Response 200:**
```json
{
  "services": [
    {
      "name": "transit",
      "type": "routed | bridged | irb | evpn-bridged | evpn-irb",
      "instance_count": 12,
      "health": {
        "healthy": 10,
        "degraded": 1,
        "failed": 1
      },
      "last_modified": "2026-05-01T12:00:00Z"
    }
  ]
}
```

`type` enumerates the service kinds newtron supports.

### `GET /api/services/{name}/instances`

List all active instances of a given service. An instance is one binding of
the service to one interface on one node.

**Response 200:**
```json
{
  "service": "transit",
  "instances": [
    {
      "node": "switch1",
      "interface": "Ethernet0",
      "applied_at": "2026-04-15T08:23:00Z",
      "intent_id": "<opaque>",
      "intent_url": "/api/intents/<opaque>",
      "params": { "ip": "10.1.0.0/31", "peer_as": 65002 },
      "health": {
        "config_db": "present | drifted | absent",
        "bgp": "established | not_established | unknown",
        "dataplane": "verified | unverified | failed"
      }
    }
  ]
}
```

`intent_id` is opaque. `intent_url` is the navigation link to the
Provenance surface at
[`GET /api/intents/{intent_id}`](#get-apiintentsintent_id) for full
substrate inspection.

### `GET /api/services/{name}/candidates`

List all interfaces (across all nodes) where this service could be applied
but currently is not. Used by the Composer to populate the multi-select.

**Response 200:**
```json
{
  "service": "transit",
  "candidates": [
    {
      "node": "switch1",
      "interface": "Ethernet4",
      "current_binding": null,
      "eligibility": {
        "eligible": true,
        "reasons": []
      }
    },
    {
      "node": "switch2",
      "interface": "Ethernet0",
      "current_binding": { "service": "customer-l3vpn" },
      "eligibility": {
        "eligible": false,
        "reasons": ["interface already bound to customer-l3vpn"]
      }
    }
  ]
}
```

### `POST /api/preview`

Generate a ChangeSet preview for a proposed apply, refresh, or remove without
delivering anything to devices. **Mandatory before `POST /api/apply`.**

**Request:**
```json
{
  "operation": "apply | refresh | remove",
  "service": "transit",
  "targets": [
    {
      "node": "switch1",
      "interface": "Ethernet0",
      "params": { "ip": "10.1.0.0/31", "peer_as": 65002 }
    },
    {
      "node": "switch2",
      "interface": "Ethernet0",
      "params": { "ip": "10.1.0.1/31", "peer_as": 65001 }
    }
  ]
}
```

For `remove`, `params` is omitted; newtron resolves the binding by node +
interface + service.

**Response 200:**
```json
{
  "preview_id": "<opaque, valid for 5 minutes>",
  "per_target": [
    {
      "node": "switch1",
      "interface": "Ethernet0",
      "validate": { /* Validate object — see "Validate (typed)" below */ },
      "changeset": { /* ChangeSet object — see "ChangeSet (typed)" below */ },
      "reference_impact": {
        "created": ["ROUTE_MAP_ab12cd34"],
        "incremented": [],
        "garbage_collected": []
      },
      "confidence": { /* Confidence object — see "Confidence (typed)" below */ },
      "reverses": null
    }
  ],
  "aggregate": {
    "all_valid": true,
    "node_count": 2,
    "total_writes": 14,
    "total_deletes": 0,
    "confidence": { /* Aggregated Confidence; see "Confidence (typed)" below */ }
  }
}
```

For `operation == "remove"`, `per_target[*].reverses` is a non-null
**Reverses** object (see "Reverses (typed)" below) naming the
originating intent(s) the remove undoes. For `operation == "apply"`
and `"refresh"`, `reverses` is `null` (those operations do not
reverse a prior operation; refresh tears down + reapplies but the
teardown is the implementation, not the operator's domain intent).

Validation failures in any target produce a 200 with `validate.ok = false` for
the failing target(s) and `aggregate.all_valid = false`. The preview is still
returned for the targets that did validate.

A drift-guard refusal on any target → 409 with `kind: "drift_refusal"`
and `details` per the typed schema in §Error Schema (`per_target[]`
listing the offending Nodes and their `drift_entries[]`, plus a
resolution hint linking to the existing Inbox card). The preview is
not committed.

#### ChangeSet (typed)

The ChangeSet object is the canonical preview-and-execution
substrate, defined first here and reused at every endpoint that
returns a per-target ChangeSet (`/api/preview`, `/api/apply`'s
captured preview pointer, `/api/workbench/{batch_id}/dry_run`,
`/api/workbench/{batch_id}/commit/preview`,
`/api/workbench/{batch_id}/revert/preview`,
`/api/inbox/{card_id}/action/preview`,
`/api/changesets/{changeset_id}`,
`/api/rehearsal/walkthroughs/{walkthrough_id}` Composer-shaped
exhibits). Per `DESIGN_PRINCIPLES_NEWTRON.md` §11 ("The ChangeSet
Is the Universal Contract") and §46 ("HTTP API Boundary — Wire
Shape Mirrors Substrate"): one typed shape, one vocabulary, every
site.

Shape:

```json
{
  "writes": [
    {
      "table": "BGP_NEIGHBOR",
      "key": "default|10.1.0.1",
      "fields": {
        "asn": "65002",
        "local_addr": "10.1.0.0",
        "admin_status": "up"
      }
    }
  ],
  "deletes": [
    {
      "table": "ACL_RULE",
      "key": "PROTECT_RE|RULE_10",
      "fields": null
    },
    {
      "table": "DEVICE_METADATA",
      "key": "localhost",
      "fields": ["bgp_router_id"]
    }
  ],
  "intent_records": [
    {
      "table": "NEWTRON_INTENT",
      "key": "interface|Ethernet0",
      "fields": {
        "operation": "apply-service",
        "name": "transit",
        "state": "actuated",
        "user_params": "{\"service\":\"transit\",\"ip_address\":\"10.1.0.0/31\",\"peer_as\":65002}",
        "resolved_params": "{\"vrf_name\":\"Vrf_TRANSIT\",\"l3vni\":\"10100\"}"
      }
    }
  ],
  "rationale_ref": {
    "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#11-the-changeset-is-the-universal-contract",
    "principle": "docs/operator-philosophy.md#1-no-black-boxes"
  }
}
```

Field rules:

- **`writes[]`** — REQUIRED. Each entry is one CONFIG_DB add or
  modify (newtron's `ChangeType: "add" | "modify"`):
  - `table` — REQUIRED. The CONFIG_DB table name (e.g.,
    `BGP_NEIGHBOR`, `VLAN`, `INTERFACE`). Matches newtron's internal
    `ConfigChange.Table` per `pkg/newtron/device/sonic/types.go`.
  - `key` — REQUIRED. The CONFIG_DB key (post-table-prefix), with `|`
    as the multi-part separator newtron uses internally (e.g.,
    `default|10.1.0.1` for BGP, `Vlan100|Ethernet0` for VLAN_MEMBER).
    The full Redis key the operator would type into `redis-cli` is
    `<table>|<key>`; the contract surfaces the two halves so consumers
    do not have to parse the separator.
  - `fields` — REQUIRED. An object whose keys are CONFIG_DB field
    names and whose values are scalars-as-strings (CONFIG_DB stores
    all values as strings — integers, booleans, IPs all serialize to
    string form). A value of `null` is reserved for a future
    field-level reset semantic and is NOT currently emitted; consumers
    MUST tolerate `null` to be additive-evolution-compatible per
    `DESIGN_PRINCIPLES_NEWTRON.md` §46.
- **`deletes[]`** — REQUIRED (empty array when no deletes). Each entry
  is one CONFIG_DB delete (newtron's `ChangeType: "delete"`):
  - `table`, `key` — REQUIRED, same semantics as `writes[]`.
  - `fields` — discriminates whole-row delete from field-level
    delete. `null` (or absent) means whole-row delete: the entire
    Redis hash at `<table>|<key>` is removed (`redis-cli DEL`). An
    array of field names means field-level delete: only the named
    fields are removed (`redis-cli HDEL <table>|<key> <field>...`),
    leaving the row in place. The field-level path corresponds to
    newtron's internal `applyEntry` merge for tables like
    `DEVICE_METADATA` where partial-row update is the substrate
    semantic.
- **`intent_records[]`** — REQUIRED (empty array when the operation
  writes no NEWTRON_INTENT records, e.g., pure reconcile-delta
  paths). Each entry is one NEWTRON_INTENT row the ChangeSet
  prepends per
  `../newtron/docs/newtron/unified-pipeline-architecture.md` §3 ("the
  intent record IS the decision substrate"). Surfaced as a
  first-class field rather than buried in `writes[]` because the
  operator needs to inspect the decision substrate without scanning
  for `table == "NEWTRON_INTENT"`. Per
  `DESIGN_PRINCIPLES_NEWTRON.md` §1, §22: the intent record's
  `user_params` and `resolved_params` are the operator's
  authorship and newtron's resolution respectively. Both are
  string-encoded per CONFIG_DB; consumers parse them as JSON for
  rendering.
- **`rationale_ref`** — REQUIRED. The same typed
  `{substrate, principle}` shape used throughout the contract.
  Default anchors point to `DESIGN_PRINCIPLES_NEWTRON.md` §11 and
  `docs/operator-philosophy.md` invariant #1.

**Newtron substrate sourcing.** newtron ships the canonical
`ConfigChange[]` substrate directly on every `WriteResult` —
dry-run AND apply — per
[newtron#11](https://github.com/aldrin-isaac/newtron/issues/11)
("structured ChangeSet (ConfigChange[]) in WriteResult"), landed
2026-05-27 in newtron's Phase 1 batch (commits `7f5ed99` /
`fba4a61` / `a718f8a`) and documented in newtron's
[`docs/newtron/api.md` §S11 WriteResult](https://github.com/aldrin-isaac/newtron/blob/main/docs/newtron/api.md).
The wire shape is
`{table, key, type ∈ {"add","modify","delete"}, fields?}`
(`fields` omitted on whole-row delete; present on `add`/`modify`
and on field-level delete). newtcon-server consumes the typed
array directly in `internal/newtronc/` — no string parsing,
no reconstruction. The operator-facing groupings
(`writes[]` for `type ∈ {"add","modify"}`, `deletes[]` for
`type == "delete"`, `intent_records[]` for the
`table == "NEWTRON_INTENT"` rows newtron prepends) are
newtcon-side affordances per
`DESIGN_PRINCIPLES_NEWTRON.md` §46 ("HTTP API Boundary — Wire
Shape Mirrors Substrate"): newtron exposes the bare canonical
substrate; newtcon-server transforms it into the operator's
mental buckets without losing fidelity. The substrate-fidelity
degradation the contract previously surfaced
(`Confidence.reasons[*].code: "changeset_reconstructed_from_string"`)
is therefore obsolete and removed from the §Confidence enum below.

The Workbench `revert/preview` `shared_resource_handling[]` block
remains alongside `ChangeSet` on remove-class previews — it carries
the per-shared-resource domain decision (preserve vs.
garbage-collect) that the raw `deletes[]` does not encode by itself,
per `DESIGN_PRINCIPLES_NEWTRON.md` §15 ("Shared resources make
reversal a domain problem"). The ChangeSet says what will be
deleted; `shared_resource_handling[]` says why.

#### Validate (typed)

The Validate object splits newtron's two-kinds-of-refusal
(`DESIGN_PRINCIPLES_NEWTRON.md` §13: "PreconditionError — the
operation's subject is absent" vs "schema validation enforces data
format") into two arrays on the wire, so the operator sees both
kinds inline at preview time without having to wait for a non-2xx
Error response.

Shape:

```json
{
  "ok": false,
  "preconditions": [
    {
      "locator": {
        "kind": "substrate_field",
        "substrate_field": {
          "network": "default",
          "node": "switch1",
          "table": "VRF",
          "key": "Vrf_TRANSIT",
          "field": null
        }
      },
      "reason": "target_absent",
      "message": "VRF Vrf_TRANSIT is not present on switch1; create-vrf must precede this apply",
      "expected": null,
      "actual": null,
      "allowed": null,
      "rationale_ref": {
        "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#13-prevent-bad-writes-dont-just-detect-them",
        "principle": "docs/operator-philosophy.md#7-errors-carry-the-substrate"
      }
    }
  ],
  "schema_violations": [
    {
      "locator": {
        "kind": "substrate_field",
        "substrate_field": {
          "network": "default",
          "node": "switch1",
          "table": "BGP_NEIGHBOR",
          "key": "default|10.1.0.1",
          "field": "asn"
        }
      },
      "reason": "out_of_range",
      "message": "asn 4294967296 exceeds 32-bit ASN range",
      "expected": { "type": "uint32", "max": 4294967295 },
      "actual": "4294967296",
      "allowed": null,
      "rationale_ref": {
        "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#13-prevent-bad-writes-dont-just-detect-them",
        "principle": "docs/operator-philosophy.md#7-errors-carry-the-substrate"
      }
    }
  ]
}
```

Field rules:

- **`ok`** — REQUIRED. `true` if and only if both `preconditions[]`
  and `schema_violations[]` are empty. Consumers MUST honor `ok`;
  they MUST NOT re-derive it by counting array lengths (a future
  additive field could be a third refusal class).
- **`preconditions[]`** — REQUIRED. Entries surface newtron's
  business-logic refusals per `DESIGN_PRINCIPLES_NEWTRON.md` §13's
  "Preconditions enforce business logic" — the operation's subject
  is absent (`PreconditionError`) or present-but-conflicting (the
  resource exists but cannot be safely modified). Affordance the
  operator gets from this distinction: "fix the situation"
  (create the missing parent; remove the active consumer; complete
  the in-flight operation) rather than "fix the value."
- **`schema_violations[]`** — REQUIRED. Entries surface newtron's
  schema validation refusals per `DESIGN_PRINCIPLES_NEWTRON.md`
  §13's "Schema validation enforces data format" — the ChangeSet
  contained an out-of-range value, unknown enum, bad pattern,
  missing required field, or wrote to an unknown table. The
  affordance: "fix the value" — the input field named in
  `locator.substrate_field` is what changes.
- **Row shape** in both arrays is the **same row shape** used by
  §Error Schema's `validation_failure.details.rejections[]`
  (`locator`, `reason`, `message`, `expected`, `actual`, `allowed`),
  with the addition of a per-row `rationale_ref` so each row carries
  its own substrate/principle anchor (a Validate row may appear
  inline on a 200 response, far from the §Error Schema's
  envelope-level rationale_ref). The `reason` enum is the same
  bounded set as §Error Schema's
  (`missing_required | unknown_value | out_of_range | type_mismatch |
  pattern_mismatch | unknown_table | unknown_field | target_absent |
  target_in_use | duplicate`).
- **No discriminator field** appears on the row — the array the row
  is in IS the discriminator (preconditions[] vs
  schema_violations[]). This mirrors the operator's mental model:
  the two affordances are different, so the buckets are
  load-bearing on the wire. Mixing them into one array with a
  `validation_stage` discriminator was considered and rejected (see
  Considered alternatives in the PR description).
- The `validation_stage` field used by §Error Schema's
  `validation_failure.details` is NOT replicated on each row here —
  inside a Validate object, the array IS the stage. When a Validate
  row corresponds to §Error Schema's `request` stage (newtcon-server
  itself rejected the request before any newtron call), that row
  appears in NEITHER `preconditions[]` NOR `schema_violations[]` —
  request-stage rejections short-circuit to a non-2xx response with
  `kind: "validation_failure"` per §Error Schema and never reach the
  inline Validate object.

**Newtron API survey for this split.** newtron exposes a single
`error: <string>` envelope per `../newtron/docs/newtron/api.md` §1
("Response Envelope") for `ValidationError`, `NotFoundError`, and
the `PreconditionError` referenced by `DESIGN_PRINCIPLES_NEWTRON.md`
§13 — these Go error types are distinguished internally but erased
to plain strings by `writeError` in `pkg/newtron/api/handler.go`.
The wire-level distinction §13 demands does not exist on newtron's
HTTP today for those three error classes, but the discrimination
newtcon needs is already established at the **§Error Schema
level** (PR #32): `validation_failure.details.validation_stage ∈
"request" | "substrate_precondition" | "substrate_schema"` and
`precondition_failure.details.condition` together cover the same
vocabulary. The Validate inline split projects that §Error Schema
discrimination into the 200-response path; the upstream signal
newtcon classifies from is the same set of newtron error strings +
the call site that emitted them, mediated by `internal/newtronc/`.
**No new newtron gap is filed** — the substrate signal is already
reaching newtcon-server today; only the operator-facing surface
needs the inline split.

The fourth Go error type, `VerificationFailedError`, is the
exception: per the
[newtron#21](https://github.com/aldrin-isaac/newtron/issues/21)
envelope fix (commit `f6b64d8`, 2026-05-27), `writeError` detects
this case via `errors.As` and emits the standard envelope **plus**
a typed `data: *WriteResult` field carrying the full
`VerificationResult` (with `errors[].device_response` verbatim
from the device re-read) and the `per_write[]` substrate-operation
sequence. The substrate survives the failure path; no string
parsing is required. newtcon-server's `internal/newtronc/`
consumes the typed `data` field directly and surfaces the
substrate through the 200-path `verify.assertion.errors[]` shape
defined in §Endpoints — Operations (the verify failure is a
post-deliver Device I/O assertion per
`DESIGN_PRINCIPLES_NEWTRON.md` §14, not a refusal of the write
attempt — see "Verify failure does not produce a 4xx envelope"
field rule under [`GET /api/operations/{operation_id}`](#get-apioperationsoperation_id)).

(For the api.md ↔ buildMux divergences encountered during this
survey — several routes registered in `buildMux()` are not
documented in api.md and vice versa — see
[newtron#20](https://github.com/aldrin-isaac/newtron/issues/20)
for the operator's pending doc-wide audit; individual drift
instances are not refiled here.)

#### Confidence (typed)

The Confidence object makes the system's confidence in a per-target
result explicit on the wire, per operator-philosophy invariant #9
("Confidence and limits are explicit"): "False confidence is worse
than no confidence because it teaches the operator to over-trust."
The Confidence object appears on every per-target preview, every
per-target apply, every Inbox card, and on `apply.verify` when verify
is heuristic.

Shape:

```json
{
  "level": "high | conditional | low",
  "reasons": [
    {
      "code": "shared_resource_count_estimated",
      "message": "Reference counts in reference_impact derive from the projection at request time, not a live re-read; concurrent operations may have shifted counts.",
      "rationale_ref": {
        "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#11-the-changeset-is-the-universal-contract",
        "principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit"
      }
    }
  ]
}
```

Field rules:

- **`level`** — REQUIRED. Bounded categorical:
  - `high` — the result is grounded in newtron's canonical
    substrate; no degradation modes are active. `reasons[]` is
    empty.
  - `conditional` — the result is reliable for the typical case
    but one or more degradation modes apply. `reasons[]` names each
    mode with a substrate-grounded explanation. Operators should
    read the reasons before acting.
  - `low` — the result is the best the system can produce but the
    degradation is severe enough that operator judgment is
    REQUIRED. `reasons[]` names each cause.
- **`reasons[]`** — REQUIRED. Empty when `level == "high"`;
  non-empty otherwise. Each entry has:
  - `code` — REQUIRED. Bounded enum (additions are Contract PRs):

    | `code` | When emitted | Typical level |
    |--------|--------------|---------------|
    | `shared_resource_count_estimated` | Reference counts in `reference_impact` derive from the projection at request time, not a live re-read; concurrent operations may have shifted counts | `conditional` |
    | `verify_pending` | `apply.verify.state` is `in_progress` or `pending` at response-render time; the assertion is not yet a known fact | `conditional` |
    | `verify_skipped_by_request` | Caller opted out of verify (`no_save` semantics) — apply landed but newtron did not re-read | `low` |
    | `inbox_signal_stale` | Inbox card's signal source last refreshed > 60s ago | `conditional` |
    | `inbox_signal_unavailable` | Inbox card's signal source returned 503/timeout at this render; card carries last-observed data | `low` |
    | `newtron_cache_miss_for_last_known` | A 503 path's `last_known.payload` is the operator's view but newtcon-server has no captured snapshot to show | `low` |
    | `precondition_check_partial` | Spec-resolution preconditions ran but a dependent newtron read failed mid-flight; the surfaced preconditions[] is a subset of what would have been checked | `conditional` |

  - `message` — REQUIRED. Substrate-grounded short text. Operators
    learn vocabulary from these messages; generic ("results may
    vary") is a contract violation.
  - `gap_issue` — OPTIONAL. Present when the reason corresponds to a
    filed newtron gap (a `code` whose degradation can only be cleared
    by upstream newtron work, with a tracking issue URL in
    `github.com/aldrin-isaac/newtron/issues/<n>`). Forbidden when no
    such gap is filed — intrinsic-limitation codes (e.g.,
    `shared_resource_count_estimated`, `verify_pending`) MUST NOT
    carry `gap_issue`. No currently-defined `code` carries a
    `gap_issue` (the contract previously surfaced
    `changeset_reconstructed_from_string` → newtron#11, both removed
    by this PR after newtron#11 landed). Future degradation codes
    introduced under the Gap-Handling Protocol that depend on a
    pending newtron change populate this field; the field shape is
    reserved here so consumers do not need a contract update when
    that occurs.
  - `rationale_ref` — REQUIRED. Typed `{substrate, principle}` shape
    as elsewhere. Anchors the operator to the substrate cause and
    the operator-philosophy principle being honored.

**Aggregation rule.** When `aggregate.confidence` is reported on
multi-target responses (Composer aggregate, Workbench aggregate,
Inbox totals), the aggregate `level` is the WORST level across
per-target entries (`high > conditional > low`), and aggregate
`reasons[]` is the union of unique `code` values across per-target
entries (each unique `code` appears once, with the message and
gap_issue from the first per-target entry that carried it).
Operators reading the aggregate confidence learn the WORST case
first; they navigate to per-target detail to see WHICH targets
contribute the degradation.

**Healthy cases report `level: "high"`.** The schema deliberately
surfaces `high` on healthy responses (not only on degraded ones) so
the operator learns the confidence vocabulary from successful
operations as well as failures. A response without a
`confidence` block at all is a contract violation; the field is
REQUIRED everywhere the contract surfaces it.

#### Reverses (typed)

The Reverses object makes `DESIGN_PRINCIPLES_NEWTRON.md` §15
("Symmetric Operations — What You Create, You Can Remove") binding
on the wire: every preview of a remove-class operation surfaces the
originating intent(s) it undoes, with operation provenance and a
pointer to the inverse-of-inverse. Per §15: "every forward action
has a reverse, and the operator must see the substrate for what is
being reversed." The Reverses block makes that substrate
inspectable at preview time, before the remove commits.

Appears on:
- `POST /api/preview` per-target when `operation == "remove"`.
- `POST /api/workbench/{batch_id}/revert/preview` per-target
  (every entry — revert is always a remove-class operation).
- `POST /api/inbox/{card_id}/action/preview` per-target when
  `verb ∈ {"rollback_zombie", "retire_policy"}` (the two
  reverse-class Inbox verbs).

`null` on every other preview class (apply, refresh; baseline
verbs whose reverse is `Reconcile` carry the reverse_strategy in
the existing `reverse_strategy` field on Workbench revert and do
NOT populate Reverses with a synthetic originating intent).

Shape:

```json
{
  "reverse_strategy": "symmetric_verb | reconcile_delta | reconcile_full",
  "reverse_strategy_rationale_ref": {
    "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove",
    "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#16-verb-vocabulary--the-name-is-the-lifecycle-contract"
  },
  "originating_intents": [
    {
      "intent_id": "<opaque>",
      "intent_url": "/api/intents/<opaque>",
      "operation": "apply-service",
      "resource_key": "interface|Ethernet0",
      "name": "transit",
      "applied_at": "2026-05-25T11:02:00Z",
      "applied_by_operation": {
        "operation_id": "<opaque>",
        "operation_url": "/api/operations/<opaque>",
        "surface": "composer | inbox | workbench | provisioning | manual_intent",
        "operator_identity": "operator:aldrin"
      }
    }
  ],
  "inverse_of_inverse": {
    "verb": "apply-service",
    "stage_via": "/api/preview",
    "stage_via_body_sketch": {
      "operation": "apply",
      "service": "transit",
      "targets": [
        {
          "node": "switch1",
          "interface": "Ethernet0",
          "params": { "service": "transit", "ip_address": "10.1.0.0/31", "peer_as": 65002 }
        }
      ]
    },
    "rationale": "Per §15 every reverse is itself reversible; the operator who removes this binding can re-apply it by re-issuing the original apply-service with the user_params captured here.",
    "rationale_ref": {
      "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove",
      "principle": "docs/operator-philosophy.md#1-no-black-boxes"
    }
  }
}
```

Field rules:

- **`reverse_strategy`** — REQUIRED. The same enum used by
  Workbench's `revert/preview`
  (`symmetric_verb | reconcile_delta | reconcile_full`). Surfaced
  here so every remove-class preview names its strategy explicitly:
  - `symmetric_verb` — the §15 pair table verb is dispatched
    (e.g., `ApplyService` → `RemoveService`). Domain logic handles
    shared resources.
  - `reconcile_delta` — baseline verb (no individual reverse per
    §15); the reverse is to reconcile back to the intent set with
    the original intent removed.
  - `reconcile_full` — reserved for the case where the original
    commit was itself a full `Reconcile`; the reverse is the
    `Reconcile` against the prior intent snapshot.
- **`originating_intents[]`** — REQUIRED, non-empty. One entry per
  intent record the remove will undo. Multi-intent cases:
  - A single `apply-service` typically maps to one originating
    intent (the `service|*` intent), so the array has one entry.
  - A reconcile-class reverse (`reconcile_delta`/`reconcile_full`)
    may undo many intents at once; each appears as a separate
    entry. The list is the substrate; the operator sees every
    intent record before the reverse runs.
  - Each entry's `intent_id` / `intent_url` resolves via
    [`GET /api/intents/{intent_id}`](#get-apiintentsintent_id) on
    the Provenance surface — the same intent record the original
    apply wrote, surfaced symmetrically per §15.
  - `applied_by_operation` carries the operation that **wrote** the
    intent (not the operation that is now reversing it). The
    operator sees who-applied-when in addition to what-is-being-
    undone. `surface` and `operator_identity` mirror the
    `origin.surface` and `origin.operator_identity` fields the
    Provenance `/api/intents/{id}` endpoint already exposes.
- **`inverse_of_inverse`** — REQUIRED. Per §15: "If newtron can
  create a VRF, it must be able to delete that VRF." The inverse of
  a reverse is the original forward verb; the contract makes that
  navigable so a remove is not a one-way door. Fields:
  - `verb` — the forward verb that would undo this reverse
    (e.g., `apply-service` for a `RemoveService` preview).
  - `stage_via` — the newtcon endpoint at which the operator
    re-stages the forward verb. For Composer-class previews,
    `/api/preview`; for Workbench reverts,
    `/api/workbench/stage`; for Inbox `rollback_zombie`,
    `/api/inbox/{card_id}/action/preview` with the inverse verb
    (which for a rollback is the original `setup-device`-class
    operation — pointed at, not invoked, since baseline operations
    have no individual reverse and rollback is itself the
    baseline-recovery path).
  - `stage_via_body_sketch` — REQUIRED. The request body the
    operator would POST to `stage_via` to re-perform the original
    forward verb. Populated from `originating_intents[*].operation`
    and the captured `user_params` (visible to the operator at the
    Provenance intent endpoint). The body is a sketch (the
    operator may amend params, e.g., change the IP address before
    re-applying); the contract surfaces enough substrate that the
    operator can copy-edit-paste rather than reconstruct from
    memory.
  - `rationale` and `rationale_ref` — REQUIRED. Both anchor the
    operator to §15's symmetric-reversibility property; the
    rationale text explains the local case.

**Newtron API surveyed.** No newtron gap is required for the
Reverses block. The substrate exists today: newtron exposes intent
records via `GET /network/{n}/node/{d}/intents` (per
`../newtron/docs/newtron/api.md` §7) and the intent DAG via
`GET /network/{n}/node/{d}/intent/tree`. newtcon-server's
`internal/newtronc/` composes those reads with the local
operation-history mapping (`/api/intents/{intent_id}`) to populate
`originating_intents[*]`. The Provenance surface
(`GET /api/intents/{intent_id}`'s `origin` and `rebuild_implication`
blocks) is the canonical store; Reverses surfaces the
intent-pointed subset at preview time so the operator does not need
a second navigation step.

### `POST /api/apply`

Apply a previously-generated preview. Atomic across targets where the
underlying newtron API guarantees atomicity; per-target where it doesn't.

This endpoint admits a Server-Sent Events streaming variant per
§Streaming substrate-operation events. The variant is selected by the
request's `Accept` header (`text/event-stream` → SSE; otherwise →
JSON). The JSON variant is documented inline below; the SSE variant
carries the same `PerWrite` and aggregate shapes as documented in
§Streaming substrate-operation events. Both variants surface the
per-substrate-operation `per_write[]` array on every target — the
SSE variant additionally emits each entry as a `substrate_op` event
as newtron commits it.

**Request:**
```json
{
  "preview_id": "<from POST /api/preview>"
}
```

**Response 200 (JSON variant — `Accept: application/json` or default):**
```json
{
  "operation_id": "<opaque>",
  "per_target": [
    {
      "node": "switch1",
      "interface": "Ethernet0",
      "applied": true,
      "intent_id": "<opaque>",
      "intent_url": "/api/intents/<opaque>",
      "operation_id": "<opaque>",
      "operation_url": "/api/operations/<opaque>",
      "pipeline": {
        "intent":  { "stage": "complete", "at": "..." },
        "replay":  { "stage": "complete", "at": "..." },
        "render":  { "stage": "complete", "at": "..." },
        "deliver": { "stage": "complete", "at": "..." }
      },
      "verify": {
        "kind": "device_io_assertion",
        "state": "in_progress",
        "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ }
      },
      "per_write": [ /* PerWrite[], see §Streaming substrate-operation events */ ],
      "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ }
    }
  ],
  "aggregate": {
    "all_applied": true,
    "verify_pending": 1,
    "total_writes_landed": 14,
    "total_writes_rejected": 0,
    "total_daemon_waits": 2,
    "total_verify_reads_failed": 0,
    "confidence": { /* Aggregated Confidence; see §POST /api/preview "Confidence (typed)" */ }
  }
}
```

`pipeline` is the 4-stage trace defined by
`unified-pipeline-architecture.md` §2; `verify` is the Device I/O
assertion defined by §7 and `DESIGN_PRINCIPLES_NEWTRON` §14. Both shapes
match `GET /api/operations/{operation_id}`; this response is the snapshot
at apply-return time, and the operations endpoint is the polling
location for post-deliver verify completion.

**`per_target[*].confidence`** and **`per_target[*].verify.confidence`**
both use the **Confidence** object defined in §POST /api/preview
"Confidence (typed)". The per-target Confidence reflects the apply
result as a whole; the inner `verify.confidence` reflects the verify
assertion specifically. The two MAY carry different
`level`/`reasons[]` — a target where deliver succeeded but verify is
still `in_progress` has per-target `level: "high"` for the apply
itself but `verify.confidence.level: "conditional"` with
`reasons[*].code: "verify_pending"`. Per `DESIGN_PRINCIPLES_NEWTRON`
§14 the verify assertion is what makes "newtron knows what it
wrote" load-bearing; the per-verify Confidence carries that
assertion-class qualifier separately because operator-philosophy
invariant #9 binds at the level the operator is reading
(per-result and per-verify are different reading-levels).

The `verify.state` may transition from `in_progress` to `complete` or
`failed` after the response returns; consumers poll
[`GET /api/operations/{operation_id}`](#get-apioperationsoperation_id) for
the terminal verify state.

**`per_target[*].per_write[]`** is the per-substrate-operation
sequence newtron executed for this target, ordered by `seq`. Each
entry is a `PerWrite` per §Streaming substrate-operation events
(`{seq, operation_id, target, kind, substrate, result, cli_command,
device_response, at, rationale_ref, source}`). Empty `per_write[]`
indicates the target had no Device I/O Operations (e.g., the target
was a dry-run that newtron-server resolved to a no-op ChangeSet —
which the validate stage should have caught at preview time;
receiving an empty `per_write[]` on a target whose `applied == true`
is a signal to file an ops ticket). The per-substrate-operation
surfacing tracked by
[newtron#19](https://github.com/aldrin-isaac/newtron/issues/19)
shipped on 2026-05-27 (Phase 2a, commit `f6b64d8`); since that
landing, `per_write[]` is populated for every target whose newtron
operation performed Device I/O.

Consumers MUST treat `per_write: []` as honest (newtron has nothing
to report), not as missing data; the
`manual_equivalent.newtron_http.status` block on this endpoint is
`"available"` (the JSON variant of §Streaming substrate-operation
events ships the substrate; the SSE variant is derived by
newtcon-server from the JSON substrate per the polling-cadence
rule documented there).

**`aggregate.total_writes_landed`** counts `per_target[*].per_write[]`
entries with `kind ∈ {redis_write, redis_delete}` and
`result == "applied"`, summed across all targets. The four
`aggregate.total_*` counters surface substrate-operation totals at a
glance so the operator's first view is not "applied: true on 3
targets" (an aggregate that hides which writes landed) but "21
substrate writes landed, 2 daemon waits, 14 verify reads passed" (a
substrate-grounded summary that points the operator at the
`per_write[]` arrays for detail). Operator-philosophy invariant #1
("no black boxes") applies to the aggregate as much as to per-target
results.

**Response 200 (SSE variant — `Accept: text/event-stream`):** stream
per §Streaming substrate-operation events. The terminal
`apply_complete` event's data payload is byte-for-byte the same JSON
object documented above for the JSON variant.

**`per_target[*].applied`** is `true` when newtron's
batch-execute returned `applied: true` for this target's per-Node
bundle (the write LANDED in CONFIG_DB). Verify is a post-deliver
Device I/O assertion per `unified-pipeline-architecture.md` §7,
and the target's `verify.state` may be `in_progress`, `complete`,
`failed`, or `skipped` at response-render time. **`applied:
true` does NOT imply verify passed** — a target with `applied:
true` AND `verify.state: "failed"` (newtron returned 409
`VerificationFailedError` with `applied: true, verified: false`)
is a legitimate combination: the write landed, the re-read
disagreed. The substrate is in `verify.assertion.errors[]` (with
`device_response` per
[newtron#21](https://github.com/aldrin-isaac/newtron/issues/21))
once the operator polls
[`GET /api/operations/{operation_id}`](#get-apioperationsoperation_id)
for terminal verify state, and in the per-target `per_write[]`
`verify_read` entries with `result: "rejected"`. `applied: false`
is reserved for refusal-before-landing (schema validation, drift
refusal, deliver-stage error); landed-but-verify-disagreed is
`applied: true` with `verify.state: "failed"`. See "Verify
failure does not produce a 4xx envelope" and the third vocabulary
boundary in §Error Schema for the structural rule.

A stale `preview_id` (expired or already consumed) → 410 Gone with
`kind: "precondition_failure"`. On the SSE variant, this error is
returned as a 410 with the typed `Error` body before any SSE bytes
are written; the stream is not opened. Errors that occur after the
SSE stream is open follow the "Mid-stream errors" rule in
§Streaming substrate-operation events.

## Endpoints — Operator Inbox (second surface)

The Inbox is a **projection of newtron signals**, not its own state machine.
Cards are derived per-request from newtron-server reads (drift detection,
intent history, zombie intents, reference scans, reconcile cadence). newtcon
does not own card lifecycle in a database — it derives the visible set and
applies operator-supplied dismissal state on top.

Every state-changing endpoint in this surface has a `/preview` counterpart
(`CLAUDE.md` §Preview Before Commit, Always). Preview responses surface the
substrate that the action would produce or affect, in newtron's vocabulary
(`ChangeSet`, `Reconcile`, `ApplyDrift`, `DriftEntry`, intent records),
never in summarized "friendly" terms.

### Card kinds

Five kinds are defined. Each is the operator-facing rendering of a specific
newtron signal source.

| Kind | Signal source (newtron) | What it means |
|------|-------------------------|---------------|
| `drift` | `GET /network/{n}/node/{d}/drift` → `DriftEntry[]` non-empty | Device CONFIG_DB diverges from the projection derived from its intents. |
| `convergence_straggler` | `WriteResult.verified == false` after a configured grace window since `WriteResult.applied == true` | An apply landed in CONFIG_DB but `cs.Verify(n)` (or post-deliver verify) has not yet passed. The pipeline is stuck mid-Verify. |
| `partial_operation` | `GET /network/{n}/node/{d}/zombie` → non-null | A previous mutation crashed between intent write and full delivery. A zombie intent record remains, capturing what was partially applied. |
| `reference_warning` | newtcon-side scan of newtron's reference data: a policy object (per `DESIGN_PRINCIPLES_NEWTRON` §24) has a reference count that crossed a configured threshold, or last-consumer status changed. | A shared policy object (ACL_TABLE, ROUTE_MAP, PREFIX_SET — see `DESIGN_PRINCIPLES_NEWTRON` §24, §25) is now sole-referenced, orphaned, or near-orphan. Operator should decide whether to retire it. |
| `reconcile_due` | Time-since-last-`Reconcile` per Node exceeds the per-Node reconcile cadence configured in newtron, OR the Node has accumulated unsaved intents per `unified-pipeline-architecture.md` §3. | A periodic full or delta `Reconcile` is due. Surfaced so the operator initiates it deliberately, not silently. |

Card kind names `drift`, `partial_operation`, `reference_warning`, and
`reconcile_due` track newtron vocabulary directly. `convergence_straggler`
is coined: newtron has `Verify` as a stage name but no single noun for
"applied-but-not-yet-verified" — the noun is needed on the operator surface.

### Card identity

`card_id` is an opaque, deterministic string that newtcon derives from
the (kind, network, device, resource-coordinate) tuple of the underlying
signal. The same drift on the same `(table, key)` on the same device
always produces the same `card_id` across requests. Re-deriving from the
tuple is required so that dismissals (which are stored against `card_id`)
survive newtcon-server restart.

The exact derivation is an implementation detail of `internal/newtronc/`;
consumers MUST treat `card_id` as opaque and pass it back unchanged.

### `GET /api/inbox`

List the current set of inbox cards. Idempotent; safe to poll. No
newtron-side state is mutated.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `kind` | string (repeatable) | unset (all kinds) | Filter to one or more card kinds. Unknown kinds → 400 `validation_failure`. |
| `node` | string (repeatable) | unset | Filter to cards bound to specific nodes. |
| `include_dismissed` | bool | `false` | If `true`, dismissed cards are included with `dismissed.active == true`. |
| `cursor` | string (opaque) | unset | Pagination cursor. |
| `limit` | int | `100` | Page size (max 500). |

**Response 200:**
```json
{
  "as_of": "2026-05-25T14:02:11Z",
  "newtron_reachable": true,
  "cards": [
    {
      "card_id": "<opaque>",
      "kind": "drift | convergence_straggler | partial_operation | reference_warning | reconcile_due",
      "network": "default",
      "node": "switch1",
      "first_observed": "2026-05-25T13:47:02Z",
      "last_observed": "2026-05-25T14:02:11Z",
      "summary": { /* per-kind, see below */ },
      "dismissed": null,
      "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ }
    }
  ],
  "next_cursor": null,
  "totals": {
    "by_kind": {
      "drift": 3,
      "convergence_straggler": 1,
      "partial_operation": 0,
      "reference_warning": 2,
      "reconcile_due": 4
    },
    "confidence": { /* Aggregated Confidence across the cards array; see §POST /api/preview "Confidence (typed)" */ }
  }
}
```

**`cards[*].confidence`** and **`totals.confidence`** use the
**Confidence** object defined in §POST /api/preview "Confidence
(typed)". Per-card confidence reflects the signal underlying that
card: a `drift` card whose source `GET .../drift` read succeeded
within the last 5 seconds carries `level: "high"`; a card whose
signal source was last refreshed > 60s ago carries `level:
"conditional"` with `reasons[*].code: "inbox_signal_stale"`; a card
whose signal source returned 503/timeout at this render carries
`level: "low"` with `reasons[*].code: "inbox_signal_unavailable"`
(replacing the previously-documented free-form
`summary.signal_unavailable: true` flag — the typed Confidence
object subsumes that case under the same aggregation rules used
elsewhere). Per `CLAUDE.md` §No Hidden State and
operator-philosophy invariant #9, the operator must see staleness
explicitly; the contract makes that wire-binding.

`as_of` is the timestamp at which newtcon-server completed the underlying
newtron reads. Required by `CLAUDE.md` §No Hidden State — the operator
sees how fresh the projection is. If `newtron_reachable` is `false`, `cards`
reflects the last successful derivation and `as_of` carries that earlier
timestamp; the operator must not be shown stale data as current.

`dismissed`, when non-null, has the shape:
```json
{
  "active": true,
  "by": "<operator-supplied identifier>",
  "reason": "<operator-supplied free text>",
  "at": "2026-05-25T13:58:00Z",
  "rearm_on": "signal_change | timeout | manual",
  "rearm_at": "2026-05-26T13:58:00Z"
}
```

Per-kind `summary` shapes:

```jsonc
// kind: "drift"
{
  "entry_count": 14,
  "by_type": { "missing": 9, "extra": 2, "modified": 3 },
  "owned_tables": ["VLAN", "BGP_NEIGHBOR", "ROUTE_MAP"],
  "last_intent_write_at": "2026-05-25T11:02:00Z",
  "drift_guard_blocking": true
}

// kind: "convergence_straggler"
{
  "operation_id": "<opaque>",
  "operation_verb": "ApplyService | RemoveService | RefreshService | CreateVLAN | ...",
  "applied_at": "2026-05-25T13:58:01Z",
  "verify_pending_for": "PT4M10S",
  "stage_blocked": "verify",
  "verify_failed_so_far": 0
}

// kind: "partial_operation"
{
  "zombie_intent_kind": "ApplyService",
  "resource": "Ethernet0",
  "crashed_at": "2026-05-25T11:14:32Z",
  "partial_change_count": 6,
  "reverse_available": true
}

// kind: "reference_warning"
{
  "policy_kind": "ACL_TABLE | ROUTE_MAP | PREFIX_SET | COMMUNITY_SET | BGP_PEER_GROUP",
  "policy_name": "PROTECT_RE_IN_1ED5F2C7",
  "content_hash": "1ED5F2C7",
  "ref_count": 1,
  "status": "sole_reference | orphaned | near_orphan",
  "last_consumer": { "service": "transit", "node": "switch1", "interface": "Ethernet0" }
}

// kind: "reconcile_due"
{
  "cadence": "PT24H",
  "last_reconcile_at": "2026-05-24T08:00:00Z",
  "due_since": "PT6H2M",
  "unsaved_intent_count": 0,
  "recommended_mode": "delta | full"
}
```

Card kinds whose underlying signal source becomes unavailable (e.g.,
newtron returns `503` for the per-device drift read) are NOT silently
dropped. They appear with a `summary` carrying a `signal_unavailable: true`
flag and the error message in `summary.message`. Hiding such cards would
violate `CLAUDE.md` §No Hidden State.

### `GET /api/inbox/{card_id}`

Return the full substrate-level detail for one card. Idempotent; safe to
poll. No newtron-side state is mutated.

Each kind exposes the **raw signal** newtron produced, plus the navigation
hooks the UI needs to walk from card → underlying records (intents, prior
operation, reference graph). No summarization. The operator must be able
to read the substrate, not a digest of it (operator-philosophy invariant #3).

**Response 200:**
```json
{
  "card_id": "<opaque>",
  "kind": "drift | convergence_straggler | partial_operation | reference_warning | reconcile_due",
  "network": "default",
  "node": "switch1",
  "first_observed": "2026-05-25T13:47:02Z",
  "last_observed": "2026-05-25T14:02:11Z",
  "as_of": "2026-05-25T14:02:11Z",
  "dismissed": null,
  "summary": { /* same as list */ },
  "detail": { /* per-kind, see below */ },
  "available_actions": [
    {
      "verb": "reconcile_delta | reconcile_full | rollback_zombie | clear_zombie | retire_policy | acknowledge | recheck",
      "label": "Apply intents to device (delta reconcile)",
      "preview_path": "/api/inbox/<card_id>/action/preview",
      "execute_path": "/api/inbox/<card_id>/action",
      "default": true
    }
  ],
  "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ }
}
```

**`confidence`** uses the same **Confidence** object as the list
endpoint's `cards[*].confidence`, carrying the same signal-source
reasons (`inbox_signal_stale`, `inbox_signal_unavailable`, etc.).
The detail endpoint MAY surface additional reasons the list does
not (e.g., a `drift` card detail computes `recommended_resolution`
from a projection rebuild that may have its own staleness; if so,
the detail's Confidence carries that reason in addition to the
list's reasons).

Per-kind `detail` shapes:

```jsonc
// kind: "drift"
{
  "drift_entries": [
    {
      "table": "VLAN",
      "key": "Vlan100",
      "type": "missing | extra | modified",
      "expected": { "vlanid": "100" },
      "actual": { "vlanid": "100", "mtu": "1500" }
    }
  ],
  "expected_source": {
    "kind": "projection_from_intents",
    "intent_count": 47,
    "rebuilt_at": "2026-05-25T14:02:11Z"
  },
  "drift_guard": {
    "mode": "actuated | topology",
    "blocking_writes": true,
    "rationale": "actuated mode; writes refused until reconcile"
  },
  "recommended_resolution": {
    "verb": "reconcile_delta | reconcile_full",
    "rationale_ref": {
      "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#6-delta-reconcile",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#21-reconstruct-dont-record"
    }
  }
}

// kind: "convergence_straggler"
{
  "operation_id": "<opaque>",
  "operation_url": "/api/operations/<opaque>",
  "pipeline": { /* same shape as GET /api/operations/{operation_id}.pipeline (4 stages) */ },
  "verify": { /* same shape as GET /api/operations/{operation_id}.verify (Device I/O assertion) */ },
  "intent": {
    "kind": "ApplyService",
    "resource": "Ethernet0",
    "params": { "service": "transit", "ip": "10.1.0.0/31", "peer_as": 65002 },
    "intent_id": "<opaque>",
    "intent_url": "/api/intents/<opaque>"
  }
}

// kind: "partial_operation"
{
  "zombie": {
    "intent_kind": "ApplyService",
    "resource": "Ethernet0",
    "params": { /* original operation params */ },
    "crashed_at": "2026-05-25T11:14:32Z"
  },
  "partial_changes": {
    "writes_persisted": [ { "table": "VRF", "key": "CUSTOMER", "fields": { "vni": "10100" } } ],
    "writes_not_attempted": [ { "table": "BGP_NEIGHBOR", "key": "default|10.1.0.1" } ]
  },
  "history_pointer": {
    "operation_id": "<opaque>",
    "operation_url": "/api/operations/<opaque>"
  },
  "reverse_op_available": true
}

// kind: "reference_warning"
{
  "policy": {
    "kind": "ACL_TABLE",
    "name": "PROTECT_RE_IN_1ED5F2C7",
    "content_hash": "1ED5F2C7",
    "fields": { /* full CONFIG_DB entry */ }
  },
  "references": [
    {
      "consumer_kind": "service_binding",
      "service": "transit",
      "node": "switch1",
      "interface": "Ethernet0",
      "binding_field": "ingress_acl"
    }
  ],
  "ref_count": 1,
  "history": [
    { "at": "2026-05-20T08:00:00Z", "ref_count": 4, "event": "created" },
    { "at": "2026-05-24T19:00:00Z", "ref_count": 1, "event": "RemoveService on switch2:Ethernet0" }
  ]
}

// kind: "reconcile_due"
{
  "cadence": "PT24H",
  "cadence_source": "newtron node config",
  "last_reconcile": {
    "at": "2026-05-24T08:00:00Z",
    "mode": "full | delta",
    "operation_id": "<opaque>"
  },
  "unsaved_intents": [
    { "kind": "ApplyService", "resource": "Ethernet0", "at": "2026-05-25T11:02:00Z" }
  ],
  "recommended_mode": "delta",
  "recommended_mode_rationale": {
    "text": "no drift detected; delta is sufficient",
    "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#6-delta-reconcile",
    "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove"
  }
}
```

`rationale_ref` and `recommended_mode_rationale` use the same shape
across the contract: an object with required `substrate` (path-and-
anchor into newtron substrate docs OR newtcon `docs/`) and required
`principle` (path-and-anchor into `docs/operator-philosophy.md`,
`CLAUDE.md`, or `DESIGN_PRINCIPLES_NEWTRON.md`). Operator-philosophy
invariant #5 ("why-mode is always available") requires both: the
substrate-level cause AND the governing principle. A string-only
`rationale_ref` is rejected at contract level.

`available_actions[*].verb` is bounded by the card's kind:

| Kind | Allowed verbs |
|------|--------------|
| `drift` | `reconcile_delta`, `reconcile_full`, `acknowledge`, `recheck` |
| `convergence_straggler` | `recheck`, `acknowledge` (no apply — the apply already ran; verify is waiting) |
| `partial_operation` | `rollback_zombie`, `clear_zombie`, `acknowledge` |
| `reference_warning` | `retire_policy`, `acknowledge` |
| `reconcile_due` | `reconcile_delta`, `reconcile_full`, `acknowledge` |

`acknowledge` is offered alongside concrete actions specifically so that
"do nothing for now" is an explicit, recorded operator decision — not a
hidden act of closing the browser tab.

**Errors:**
- `card_id` not currently derivable from the live signal set → 404 with
  `kind: "precondition_failure"` and `details.reason: "signal_resolved"`
  (the card resolved itself before the operator opened it; not an error
  in the system, but the operator should be told).
- newtron-server unreachable → 503 with `kind: "newtron_unavailable"`.

### `POST /api/inbox/{card_id}/dismiss/preview`

Preview the consequences of dismissing a card. **No newtron interaction**
and no newtcon state mutation. Mandatory before `POST .../dismiss` per
`CLAUDE.md` §Preview Before Commit, Always.

A dismissal produces no `ChangeSet` (no device action), but it does
suppress a card from default views and arms a re-emergence rule. The
preview surfaces that consequence in structured form.

**Request:**
```json
{
  "rearm": {
    "on": "signal_change | timeout | manual",
    "after": "PT24H"
  },
  "reason": "<operator-supplied free text, may be empty>"
}
```

`rearm.after` is required when `rearm.on == "timeout"`, forbidden otherwise.
Duration is ISO 8601. Unknown `rearm.on` → 400 `validation_failure`.

**Response 200:**
```json
{
  "preview_id": "<opaque, valid for 5 minutes>",
  "card_id": "<echoed>",
  "consequence": {
    "default_visibility": "hidden",
    "rearm_on": "signal_change",
    "rearm_signal_definition": "drift entry count on (switch1, VLAN, Vlan100) changes from current value 14",
    "rearm_at": null,
    "still_visible_when": ["include_dismissed=true on GET /api/inbox"],
    "no_device_action": true,
    "no_changeset": true
  }
}
```

For `rearm.on == "timeout"`, `rearm_at` is populated and
`rearm_signal_definition` is null. For `rearm.on == "manual"`, both are
null and `still_visible_when` includes the explicit re-enable path.

### `POST /api/inbox/{card_id}/dismiss`

Apply a previously-generated dismiss preview. Records the dismissal
against `card_id` in newtcon-server's dismissal store; does not call
newtron.

**Request:**
```json
{ "preview_id": "<from /dismiss/preview>" }
```

**Response 200:**
```json
{
  "card_id": "<echoed>",
  "dismissed": {
    "active": true,
    "by": "<from request context>",
    "reason": "<from preview>",
    "at": "2026-05-25T14:05:00Z",
    "rearm_on": "signal_change",
    "rearm_at": null
  }
}
```

Stale or already-consumed `preview_id` → 410 Gone with
`kind: "precondition_failure"`.

### `POST /api/inbox/{card_id}/action/preview`

Preview the card's primary or operator-selected action. Returns the
`ChangeSet` (or absence thereof) the action would produce, plus reference
impact. Mandatory before `POST .../action`.

**Request:**
```json
{
  "verb": "reconcile_delta | reconcile_full | rollback_zombie | clear_zombie | retire_policy | acknowledge | recheck",
  "params": { /* verb-specific; see below */ }
}
```

`verb` must be one of `available_actions[*].verb` returned by
`GET /api/inbox/{card_id}`. A `verb` not legal for the card's kind → 400
`validation_failure` with `details.allowed_verbs`.

Per-verb `params`:

| Verb | `params` |
|------|----------|
| `reconcile_delta` | `{}` |
| `reconcile_full` | `{ "confirm_disruptive": true }` (required: full reconcile triggers config reload, which is service-affecting; absence → 400) |
| `rollback_zombie` | `{}` |
| `clear_zombie` | `{ "manual_cleanup": { "confirmed": true, "note": "<required free text describing what was cleaned and how>", "performed_at": "<RFC3339 timestamp of when the operator performed the cleanup>" } }` |
| `retire_policy` | `{}` (the policy named in the card's `detail.policy.name`) |
| `acknowledge` | `{}` |
| `recheck` | `{}` |

**Response 200:**
```json
{
  "preview_id": "<opaque, valid for 5 minutes>",
  "card_id": "<echoed>",
  "verb": "<echoed>",
  "produces_changeset": true,
  "changeset": { /* ChangeSet object — see §POST /api/preview "ChangeSet (typed)" */ },
  "reconcile_mode": "delta | full",
  "drift_resolved_preview": {
    "before": { "missing": 9, "extra": 2, "modified": 3 },
    "after":  { "missing": 0, "extra": 0, "modified": 0 },
    "entries_resolved": [
      {
        "table": "VLAN",
        "key": "Vlan100",
        "type": "missing",
        "expected": { "vlanid": "100" },
        "actual": {}
      },
      {
        "table": "BGP_NEIGHBOR",
        "key": "default|10.1.0.1",
        "type": "modified",
        "expected": { "asn": "65002" },
        "actual": { "asn": "65003" }
      }
    ],
    "entries_unresolved": []
  },
  "reference_impact": {
    "created": [],
    "incremented": [],
    "decremented": ["ROUTE_MAP|TRANSIT_IN_A1B2C3D4"],
    "garbage_collected": ["ACL_TABLE|PROTECT_RE_IN_1ED5F2C7"]
  },
  "validate": { /* Validate object — see §POST /api/preview "Validate (typed)" */ },
  "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ },
  "reverses": null,
  "disruption": {
    "config_reload": true,
    "bgp_restart": false,
    "estimated_data_plane_impact": "service-affecting",
    "rationale": [
      { "input": "config_reload", "value": true,  "contribution": "service-affecting (config_reload restarts SONiC daemons)" },
      { "input": "bgp_restart",   "value": false, "contribution": "none" },
      { "input": "verb",          "value": "reconcile_full", "contribution": "service-affecting (full reconcile triggers config reload)" }
    ]
  },
  "manual_equivalent": {
    "newtron_cli": "newtron switch1 intent reconcile -x --mode delta",
    "newtron_http": {
      "status": "available",
      "method": "POST",
      "path": "/network/default/node/switch1/intent/reconcile",
      "query": { "reconcile": "delta", "dry_run": "false" }
    }
  }
}
```

Field rules:

- `produces_changeset` is `true` for `reconcile_*`, `rollback_zombie`,
  `retire_policy`; `false` for `acknowledge`, `recheck`, `clear_zombie`.
- When `produces_changeset == false`, `changeset`, `validate`,
  `reverses`, `reconcile_mode`, and `drift_resolved_preview` are
  omitted; `consequence` is present instead with the same shape as
  the dismiss preview's `consequence`. `confidence` is still
  present (the verb action itself carries confidence reasons even
  when no ChangeSet is produced — e.g., `recheck` whose underlying
  signal source is stale).
- **`validate`** is the typed **Validate** object defined in §POST
  /api/preview. `validate.preconditions[]` carries the
  domain-level refusals (e.g., a `rollback_zombie` whose zombie
  record was already cleared by a concurrent operator);
  `validate.schema_violations[]` carries any ChangeSet-level
  schema refusals newtron would emit on the about-to-be-rendered
  ChangeSet. Both arrays are populated on the inline 200 path; a
  severe validation failure that prevents preview entirely
  short-circuits to a non-2xx response with
  `kind: "validation_failure"` per §Error Schema, as documented
  below.
- **`reverses`** is the typed **Reverses** object defined in §POST
  /api/preview. Populated when `verb ∈ {"rollback_zombie",
  "retire_policy"}` — both are remove-class. For
  `rollback_zombie`, `originating_intents[]` is the zombie
  intent record(s) the rollback undoes (the partial-operation
  card's `detail.zombie` is the source); the
  `inverse_of_inverse.verb` is the original verb the zombie
  recorded (e.g., `apply-service` if the zombie was a partial
  `ApplyService`). For `retire_policy`,
  `originating_intents[]` is the policy-creation intent(s)
  (typically one); `inverse_of_inverse.verb` is the
  policy-creation verb (e.g., `bind-acl` for an
  `ACL_TABLE`-class retire). `reverses` is `null` for
  `reconcile_*`, `acknowledge`, `clear_zombie`, and `recheck` —
  reconcile is a domain-recovery verb, not a reverse; the others
  produce no ChangeSet.
- **`confidence`** is the typed **Confidence** object defined in
  §POST /api/preview. Reasons specific to this surface include
  `inbox_signal_stale` (the card was derived from a signal source
  that has not refreshed recently — the preview may not reflect
  current substrate), `inbox_signal_unavailable` (the card's
  source returned 503 at preview render), and
  `precondition_check_partial` (a dependent newtron read failed
  mid-flight).
- `drift_resolved_preview` is REQUIRED on `reconcile_delta` and
  `reconcile_full` action previews; OPTIONAL on others.
  `before`/`after` counts (missing/extra/modified) are present for
  summary display; `entries_resolved: DriftEntry[]` and
  `entries_unresolved: DriftEntry[]` are REQUIRED and use the same
  `DriftEntry` schema as `kind: "drift"` card `detail.drift_entries[]`.
  The operator MUST be able to see WHICH drift entries the verb would
  resolve and which would remain (operator-philosophy invariants #1
  "no black boxes" and #4 "show before do" — counts alone do not let
  the operator inspect the substrate at the decision moment). For
  delta reconcile, `entries_unresolved` is empty by construction;
  for partial reconciles or multi-table drift where the operator
  selected a scope subset, it lists the drift entries the action
  leaves in place.
- `manual_equivalent` is REQUIRED on every action preview, including
  no-op verbs. It surfaces the exact newtron CLI and HTTP call the
  operator could issue by hand to achieve the same effect — the
  operator-philosophy invariant #2 (manual-mode parity) is binding,
  not aspirational.
- `manual_equivalent.newtron_http` is an object with one of five
  shapes; `status` is the discriminator and is bounded by the enum
  `available | partial_match | pending_newtron_gap | deferred_indefinitely | not_applicable`:
  (a) `{ "status": "available", "method", "path", "query"?, "body"? }`
  — an endpoint that is documented as part of newtron's public HTTP
  API in `newtron/docs/` (any authoritative newtron doc — e.g.,
  `api.md`, `lld.md`, `hld.md`) AND is verified registered in
  `pkg/newtron/api/handler.go` `buildMux()`, and answers the same
  question with the same substrate. Both halves of the check are
  required: documentation alone is insufficient (see the api.md ↔
  buildMux drift tracked at
  [newtron#20](https://github.com/aldrin-isaac/newtron/issues/20)),
  and a wired-but-undocumented route is also insufficient (it is not
  yet public surface);
  (b) `{ "status": "partial_match", "method", "path", "query"?,
  "body"?, "note": "<rationale>" }` — an endpoint exists that
  answers a related but not identical question; the `note` explains
  the gap honestly (used, e.g., on the Provenance verify endpoint,
  where newtron's `verify-committed` re-verifies the LAST committed
  ChangeSet rather than a specified historical operation);
  (c) `{ "status": "pending_newtron_gap", "gap_issue": "<URL>",
  "expected_shape": { … } }` — no newtron HTTP shape exists today,
  AND the substrate is filed with newtron as a gap awaiting upstream
  delivery on an open timeline; tracked under the Gap-Handling
  Protocol (`CLAUDE.md` §Gap-Handling Protocol). Consumers may
  surface this as "tracked at newtron#X; expected upstream" and may
  set staleness alerts on long-pending items;
  (d) `{ "status": "deferred_indefinitely", "gap_issue": "<URL>",
  "re_evaluation_trigger": { "text": "<verbatim substrate>",
  "newtcon_context": ["<ref>", ...] } }` — no newtron HTTP shape
  exists today, AND the newtron lead has considered the substrate
  and indefinitely deferred it. No upstream delivery is expected on
  a defined timeline. Consumers MUST NOT surface this as "pending"
  or "expected"; the operator-facing rendering must convey
  "considered and deferred" honestly. `re_evaluation_trigger` is
  REQUIRED on this shape; its `text` subfield is REQUIRED and is
  byte-for-byte the lead's wording on the linked `gap_issue`, and
  its `newtcon_context` subfield is OPTIONAL (see field rules
  below). The trigger may never fire;
  (e) `{ "status": "not_applicable", "rationale": "<text>" }` — no
  newtron HTTP shape applies, by design, because the substrate is
  not addressable in newtron's model (used, e.g., on the
  Provenance ChangeSet endpoint, where ChangeSets are
  per-invocation artifacts in newtron and the addressable retention
  is a newtcon-server concern).
  The shape MUST be one of these five — silently fabricating an
  endpoint URL is forbidden. `newtron_cli` always points to the
  equivalent CLI invocation when one exists; it is `null` when no
  CLI equivalent applies (matching `not_applicable` or
  `deferred_indefinitely` when no operator-tool path exists).

  **Semantic distinction — `pending_newtron_gap` vs
  `deferred_indefinitely`.** Both shapes name "no newtron HTTP
  shape exists today" but they teach different operator-facing
  models, and the distinction is binding (operator-philosophy
  invariant #9, "Confidence and limits are explicit"; false
  confidence about upstream arrival is worse than no confidence).
  `pending_newtron_gap` means the substrate is **filed and tracked
  with an open expectation of delivery**: the newtron team is
  expected to ship it, the only open question is when, and a
  consumer may surface the gap_issue as an upstream ticket the
  operator can subscribe to. `deferred_indefinitely` means the
  substrate has been **considered by the newtron lead and explicitly
  deferred**: the gap_issue documents the deferral verdict, no
  delivery is on the lead's roadmap, and a consumer that surfaces it
  as "pending" or "expected" lies to the operator. The
  `re_evaluation_trigger` makes the deferral's contingency visible:
  the deferral is not "wontfix" (that would be a separate verdict),
  it is "deferred unless the named condition fires."

  **Honest lifecycle.** A given substrate may move through three
  honest states over its lifetime:
  `deferred_indefinitely → pending_newtron_gap → available`.
  Transitions are operator-visible:

  - `deferred_indefinitely → pending_newtron_gap` — the
    `re_evaluation_trigger` fired (operator field-experience or
    other named condition supplied the missing justification); a new
    gap is filed with concrete acceptance criteria; the contract is
    updated by Contract PR to switch the shape.
  - `pending_newtron_gap → available` — newtron ships the substrate;
    the contract is updated by Contract PR to switch the shape, name
    the landed path, and remove the `gap_issue` reference.

  Skipping or silently re-purposing a transition is forbidden. A
  `deferred_indefinitely` entry that quietly becomes `available`
  without first transitioning through `pending_newtron_gap` (i.e.,
  without the lead's acceptance-criteria step) is a
  substrate-honesty failure; the operator who watched the deferral
  has no way to reconstruct what changed. Three honest states; no
  silent semantic shifts.

- **`re_evaluation_trigger`** (on shape (d) only) — REQUIRED when
  `status == "deferred_indefinitely"`; MUST be absent for every
  other `status` value. The field is a typed object with two
  subfields:
  - **`text`** (REQUIRED, string) — the condition that would cause
    the deferral to be lifted, prompting a follow-up Contract PR
    to migrate the entry from `deferred_indefinitely` to
    `pending_newtron_gap` (or directly to `available` if the lead
    chooses to ship it immediately on re-evaluation). The string
    is **byte-for-byte** the lead's wording from the substrate
    document linked at `gap_issue` (issue comment, design doc,
    code comment) — paraphrase, polish, or chat-derived rewording
    is forbidden. Verbatim discipline is operator-philosophy
    invariant #7 ("errors carry the substrate") applied to the
    lifecycle of a deferral: the trigger's burden-of-proof
    framing (e.g., a trailing "— that pattern, if observed, would
    make this issue load-bearing" clause encodes the lead's
    discipline that the deferral lifts on observation, not on
    speculation) is load-bearing substance, not formatting, and
    survives the wire. The string MUST name a concrete,
    operator-visible signal, not a vague aspiration ("if
    useful"). Operator-philosophy invariant #1 ("no black boxes")
    is binding: the operator who reads a `deferred_indefinitely`
    entry MUST be able to see WHY the substrate is deferred and
    WHAT would re-open it, without having to read the linked
    newtron issue.
  - **`newtcon_context`** (OPTIONAL, string array, default
    `[]`) — newtcon-side cross-references that contextualize the
    trigger surface (e.g., the newtcon issue that introduced the
    surface the trigger names, the PR that landed it, an ADR that
    documents a related decision). These are navigation
    affordances for consumers, not substrate; they MUST NOT live
    inside `text`. Each entry is a free-form string a consumer
    can resolve in its own deployment context (typically
    `newtcon#NNN`, `PR #NNN`, or `docs/adr/NNNN-title.md`).
    Examples that name a newtron HTTP path, a CONFIG_DB table, or
    other newtron-side substrate belong in `text` (or in a
    different `re_evaluation_trigger` whose substrate is on the
    newtron side), not here. Absent when no context refs apply.

  The field is absent on every other shape because the
  lifecycle's other states have their own honest signals:
  `pending_newtron_gap` is already an open expectation (no
  trigger needed; arrival is expected), `available` has landed
  (no trigger needed; the substrate is on the wire), and
  `not_applicable` is by-design (no trigger needed; the substrate
  does not exist in newtron's model).

  **Illustrative shape** (NOT the canonical newtron#12 trigger;
  for the verbatim newtron#12 trigger see §Streaming
  substrate-operation events "`source`"):
  ```json
  {
    "text": "<the lead's wording, byte-for-byte from gap_issue>",
    "newtcon_context": ["newtcon#NNN", "PR #NNN"]
  }
  ```
- Per-verb `manual_equivalent.newtron_http.status` today:

  | Verb | `status` | Underlying newtron HTTP |
  |------|----------|-------------------------|
  | `reconcile_delta` | `available` | `POST /network/{n}/node/{d}/intent/reconcile?reconcile=delta&dry_run=false` (preview: `dry_run=true`) |
  | `reconcile_full` | `available` | `POST /network/{n}/node/{d}/intent/reconcile?reconcile=full&dry_run=false` (preview: `dry_run=true`; the operator confirms the disruptive `confirm_disruptive: true` `params` at the newtcon layer — newtron's endpoint itself is non-confirming) |
  | `rollback_zombie` | `available` | `POST /network/{n}/node/{d}/rollback-zombie` |
  | `clear_zombie` | `available` | `POST /network/{n}/node/{d}/clear-zombie` |
  | `retire_policy` | `pending_newtron_gap` | depends on policy-kind-specific reverse op exposure; tracked separately when slice lands |
  | `acknowledge` | `available` | not applicable; no newtron call (`newtron_http` is `null` for this verb only) |
  | `recheck` | `available` | re-reads the card's source signals; varies by kind |

- `disruption.estimated_data_plane_impact` is one of `"none"`,
  `"control-plane-only"`, `"service-affecting"`, `"network-affecting"`.
  The verdict is NOT a black box — it MUST be accompanied by a
  `disruption.rationale` array listing the inputs that produced it
  (operator-philosophy invariant #1, "no black boxes"). Each rationale
  entry has the shape:

  ```json
  { "input": "config_reload", "value": true, "contribution": "service-affecting (config_reload restarts SONiC daemons)" }
  ```

  The operator must be able to reconstruct the verdict from the
  rationale array. A rationale array empty of the inputs that justify
  the verdict is a contract violation.

A drift-guard refusal during preview (newtron refuses to compute the
ChangeSet because the device has drifted from its declared intents) →
409 with `kind: "drift_refusal"` and `details` per the typed schema in
§Error Schema. The schema's `per_target[*].drift_entries[]` carries
exactly the `DriftEntry[]` newtron returned, in the same shape as the
Inbox drift card's `detail.drift_entries[]`.

A validation failure (the action would write invalid CONFIG_DB per
`DESIGN_PRINCIPLES_NEWTRON` §13) → 200 with `validate.ok == false`
and `validate.preconditions[]` AND/OR `validate.schema_violations[]`
populated per the typed §POST /api/preview "Validate (typed)"
shape; the preview is returned but `produces_changeset` does not
imply executable. The split between the two arrays matches §13's
two-refusals distinction: `preconditions[]` for "the resource is
absent" / "the resource exists but can't be safely modified"
(operator affordance: fix the situation); `schema_violations[]`
for "the value is out of range / wrong type / unknown field"
(operator affordance: fix the value). When the validation failure
is severe enough that newtcon-server refuses to return a preview
at all (rather than returning it with `validate.ok == false`), the
response is 400 with `kind: "validation_failure"` per the typed
schema in §Error Schema, with `validation_stage: "substrate_schema"`
or `"substrate_precondition"` per `DESIGN_PRINCIPLES_NEWTRON` §13's
two-refusals split. The inline `validate` and the envelope-level
§Error Schema discrimination are two surfaces of the same
substrate vocabulary; consumers reading either learn the same
distinction.

### `POST /api/inbox/{card_id}/action`

Execute a previously-generated action preview. Atomicity follows newtron's
guarantees per verb:

| Verb | Atomicity |
|------|-----------|
| `reconcile_delta` | Atomic per-Node via `ApplyDrift` (TxPipeline; `unified-pipeline-architecture.md` §6 Delta Reconcile). |
| `reconcile_full` | Atomic per-Node via `ReplaceAll` (`unified-pipeline-architecture.md` §6 Reconcile). |
| `rollback_zombie` | Atomic per-Node via newtron `rollback-zombie`. |
| `clear_zombie` | Not atomic against device — clears newtcon-visible zombie record only after newtron acknowledges. |
| `retire_policy` | Atomic per shared-policy GC; reference count must reach 0 in the preview. |
| `acknowledge` | No device action. |
| `recheck` | No device action; re-reads signals. |

This endpoint admits a Server-Sent Events streaming variant per
§Streaming substrate-operation events for the verbs that produce a
ChangeSet (`reconcile_delta`, `reconcile_full`, `rollback_zombie`,
`retire_policy`). The variant is selected by the request's `Accept`
header (`text/event-stream` → SSE; otherwise → JSON). For verbs that
produce no ChangeSet (`acknowledge`, `clear_zombie`, `recheck`), the
SSE variant emits exactly one terminal `apply_complete` event with
the JSON-variant payload and no `substrate_op` events — there is no
Device I/O to stream, but the SSE response is still well-formed for
client-side variant uniformity. Per-Node atomicity honesty
(§Streaming substrate-operation events) applies: this endpoint
always targets exactly one Node (the card's Node), so the whole
substrate sequence is one TxPipeline bundle and every
`redis_write` / `redis_delete` event carries the same `result`.

**Request:**
```json
{ "preview_id": "<from /action/preview>" }
```

**Response 200 (JSON variant — `Accept: application/json` or default):**
```json
{
  "card_id": "<echoed>",
  "verb": "<echoed>",
  "operation_id": "<opaque, present when verb produces a ChangeSet>",
  "operation_url": "/api/operations/<opaque>",
  "intent_id": "<opaque, present when verb mints a single addressable NEWTRON_INTENT record>",
  "intent_url": "/api/intents/<opaque>",
  "executed": true,
  "pipeline": {
    "intent":  { "stage": "complete", "at": "2026-05-25T14:06:01Z" },
    "replay":  { "stage": "complete", "at": "2026-05-25T14:06:01Z" },
    "render":  { "stage": "complete", "at": "2026-05-25T14:06:01Z" },
    "deliver": { "stage": "complete", "at": "2026-05-25T14:06:02Z" }
  },
  "verify": {
    "kind": "device_io_assertion",
    "state": "in_progress",
    "started_at": "2026-05-25T14:06:02Z",
    "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ }
  },
  "per_write": [ /* PerWrite[], see §Streaming substrate-operation events */ ],
  "substrate_summary": {
    "writes_landed": 14,
    "writes_rejected": 0,
    "daemon_waits": 2,
    "verify_reads_failed": 0
  },
  "card_state_after": "resolved | persists | armed_for_recheck",
  "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ }
}
```

`card_state_after`:
- `resolved` — the underlying signal is expected to disappear; the card
  will not be present in the next `GET /api/inbox`.
- `persists` — the action was non-destructive (`acknowledge`, `recheck`,
  partial reconcile of multi-table drift) and the card remains until the
  signal resolves.
- `armed_for_recheck` — `recheck` was issued; next list call will reflect
  fresh signal state.

`per_write[]` is the per-substrate-operation sequence newtron
executed against the card's Node, ordered by `seq`. Each entry is a
`PerWrite` per §Streaming substrate-operation events. Empty
`per_write[]` is honest: the verb produced no ChangeSet
(`acknowledge`, `clear_zombie`, `recheck` — in which case
`substrate_summary` is also all-zero). Per-substrate-operation
surfacing on newtron's write endpoints
([newtron#19](https://github.com/aldrin-isaac/newtron/issues/19)
Phase 2a) shipped on 2026-05-27; for verbs that produce a
ChangeSet, `per_write[]` is non-empty whenever the underlying
operation performed Device I/O.

`substrate_summary.*` are substrate-operation counts derivable from
`per_write[]`. REQUIRED on every response (zeroed for no-ChangeSet
verbs) so the operator's first view shows substrate cadence (14
writes, 2 daemon waits, 0 verify failures), not just the abstract
`executed: true`. Operator-philosophy invariant #1 ("no black
boxes") applies to the action's terminal summary as much as to its
per-write detail.

For verbs that produce no ChangeSet (`acknowledge`, `clear_zombie`,
`recheck`), `operation_id`, `operation_url`, `intent_id`, `intent_url`,
`pipeline`, and `verify` are omitted; `per_write: []` and
`substrate_summary` zeroed.

`intent_id` and `intent_url` address the NEWTRON_INTENT record this
action wrote, per the §Identifiers rule in
[§Provenance "Identifiers and resolution"](#identifiers-and-resolution)
that every shape exposing an `intent_id` MUST expose its `intent_url`
companion. They are present when the verb mints a single addressable
intent record — `rollback_zombie` (the reverse intent that undoes
the zombie) and `retire_policy` (the policy-deletion intent). They
are omitted for `reconcile_delta` and `reconcile_full`: per
`unified-pipeline-architecture.md` §6, reconcile re-renders existing
intents through `ApplyDrift` / `ReplaceAll` rather than minting a new
addressable intent record, and the substrate the operator wants to
inspect is the projection rebuild surfaced by `per_write[]` and
`drift_resolved_preview` (carried through from the preview), not a
single intent_id. Operators who need to navigate the touched intents
from a reconcile use the per-Node Provenance projection at
[`GET /api/projection/nodes/{node}`](#get-apiprojectionnodesnode)
keyed by the operation_id.

**Response 200 (SSE variant — `Accept: text/event-stream`):** stream
per §Streaming substrate-operation events. The terminal
`apply_complete` event's data payload is byte-for-byte the same JSON
object documented above for the JSON variant.

**`executed: true` does NOT imply verify passed.** When newtron's
action returned `applied: true` (the write LANDED) but
post-deliver `cs.Verify(n)` re-read disagreed with the ChangeSet
(`verified: false`, surfaced through newtron's typed 409
`VerificationFailedError` envelope per
[newtron#21](https://github.com/aldrin-isaac/newtron/issues/21)),
the response carries `executed: true` (the action was executed
against the device) with `verify.state: "failed"` and the typed
`verify.assertion.errors[]` (with `device_response` verbatim)
populated. The same `verify_read` substrate appears as `PerWrite`
entries with `result: "rejected"` on `per_write[]`. `executed:
false` is reserved for refusal-before-landing (drift refusal at
execution time, validation rejection); landed-but-verify-disagreed
is `executed: true` with `verify.state: "failed"`. See "Verify
failure does not produce a 4xx envelope" and the third vocabulary
boundary in §Error Schema for the structural rule.

A stale `preview_id` → 410 Gone with `kind: "precondition_failure"`.

A drift-guard refusal at execution time (the device drifted between
preview and action) → 409 with `kind: "drift_refusal"` per the typed
schema in §Error Schema; the operator must re-preview.

A newtron failure mid-pipeline → 502 with `kind: "internal"` per the
typed schema in §Error Schema. `details.partial_results` carries the
partial per-target results completed before the failure (matching the
shape of this endpoint's `per_target[]` success body, including
each target's `per_write[]` of substrate operations that landed
before the abort); the newtron-side error that triggered the
catastrophic failure is logged against `details.correlation_id`, not
surfaced inline — the operator quotes the correlation ID when filing
the ops ticket. (When the mid-pipeline failure CAN be attributed to
a substrate cause, the correct kind is `validation_failure`,
`drift_refusal`, or `newtron_unavailable`, not `internal`;
`internal` is the residual category for unclassified failures.) On
the SSE variant, the catastrophic failure flows as an `error` event
per §Streaming substrate-operation events ("Mid-stream errors").

For `clear_zombie`, the response includes a `manual_cleanup_record`
object echoing the `note` and `performed_at` from the request and adding
`recorded_at` (server-side timestamp when newtcon accepted the clear).
This record is queryable from the operations endpoint for the
operation's retention window — the operator's narrative MUST survive
the action, otherwise `clear_zombie` becomes an undocumented act
violating operator-philosophy invariant #1 and `DESIGN_PRINCIPLES_NEWTRON`
§14's substrate-carrying-errors principle.

```json
{
  "card_id": "<echoed>",
  "verb": "clear_zombie",
  "executed": true,
  "manual_cleanup_record": {
    "note": "<from request>",
    "performed_at": "<from request>",
    "recorded_at": "2026-05-25T14:06:00Z"
  },
  "card_state_after": "resolved"
}
```

## Endpoints — Operations

These endpoints expose the per-operation trace used by Service Composer
apply, Inbox card actions, and (later) Change Workbench commit. The trace
shape is the same regardless of which surface initiated the operation —
the pipeline is one pipeline (`unified-pipeline-architecture.md` §2).

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

The capture path is the synchronous one: every state-changing
endpoint in this contract (`POST /api/apply`,
`POST /api/inbox/{card_id}/action`,
`POST /api/workbench/{batch_id}/commit`,
`POST /api/workbench/{batch_id}/revert`) issues the underlying
newtron RPC, receives newtron's `WriteResult` (per
`../newtron/docs/newtron/api.md` §15), and writes the full pipeline
trace + verify assertion + initiator metadata into newtcon-server's
operations store within the same request. The operation is
addressable at `GET /api/operations/{operation_id}` as soon as the
state-changing endpoint returns. There is no propagation delay and
no separate ingestion path.

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
    "surface": "composer | inbox | workbench",
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
    "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ }
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
  operations initiated by Composer or Workbench; per-node operation
  traces use `success` or `failure` only.
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

The Workbench is a **staging area in newtcon-server** for a set of intents
the operator intends to commit together. It is not a state machine in
newtron; newtron has no "staged batch" concept. The Workbench is to
newtcon what `git add` + `git diff --cached` + `git commit` are to git:
the operator composes a unit of work, inspects its full effect against
the current projection, and commits — or sets it aside and resumes
later.

### The atomicity model — read this first

Every Workbench operation that delivers to one or more devices is
**atomic per-Node, sequential across Nodes**. This is not a workbench
choice; it is a property of newtron. Per
`DESIGN_PRINCIPLES_NEWTRON` §8 ("Scope Boundaries") and §31 ("Node as
Device Isolation Boundary"), newtron operates per-device with one
failure domain per device. The batch-execute endpoint
(`POST /network/{n}/node/{d}/execute`) wraps all operations targeting a
single device in one `Lock → snapshot → fn → commit-or-restore →
Unlock` cycle (`unified-pipeline-architecture.md` §8 "Execute"); within
that cycle, application is atomic via Redis `TxPipeline`. There is no
equivalent cross-device transaction in newtron, and the architecture
explicitly rejects one as multi-device coordination being the
orchestrator's job (`DESIGN_PRINCIPLES_NEWTRON` §11: "deciding whether
to roll back the first is the orchestrator's responsibility").

The Workbench IS that orchestrator. Therefore:

- A Workbench commit that targets one Node is atomic.
- A Workbench commit that targets N Nodes is N per-Node-atomic
  operations executed in a defined order. Any subset may succeed; any
  subset may fail. Each per-Node operation is structurally atomic;
  the batch as a whole is not.
- The contract surfaces this honestly. There is no `aggregate.atomic =
  true` claim. Every commit and revert response carries per-target
  results AND an aggregate that classifies the outcome
  (`all_committed`, `partial`, `none_committed`) with a structured
  `per_node_atomicity` block that names each Node and its inner
  guarantee.

This honesty is binding per `CLAUDE.md` §Operator-Honest Errors and
operator-philosophy invariant #9 ("Confidence and limits are
explicit"). A Workbench surface that lets the operator believe a
20-device commit is one atomic transaction would teach a false model
of newtron — exactly the dependency-creating pattern
`docs/operator-philosophy.md` rejects.

### Lifecycle and state

A batch progresses through a small state machine, all of it owned by
newtcon-server (newtron is unaware):

```
                ┌──── stage ────► drafting ────┐
                │                       │      │
                │                  (append)    │
                │                       │      │
                │                       ▼      │
                │                   drafting   │
                │                       │      │
                │              dry_run / commit/preview
                │                       │      │
                │                       ▼      │
                │                  previewed  ─┤
                │                       │      │
                │                    commit    │
                │                       │      │
                │                       ▼      │
                │                  committed   │
                │                       │      │
                │              revert/preview  │
                │                       │      │
                │                       ▼      │
                │                  revert_previewed
                │                       │      │
                │                    revert    │
                │                       │      │
                │                       ▼      │
                │                  reverted    │
                │                                        ┌──► drafting
                │  stash/preview ─► stash_previewed ─► stashed ─► restore/preview ─► restore_previewed ─► restored ─┘
                │                                              (from any non-terminal state)
                └─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

States: `drafting`, `previewed`, `committed`, `revert_previewed`,
`reverted`, `stash_previewed`, `stashed`, `restore_previewed`,
`restored`. `restored` is a transient state: the act of restore
transitions the batch back to `drafting` with the same `batch_id`.

Terminal states for retention purposes: `committed`, `reverted`,
`stashed`. Other states are working states and are subject to a
session-scoped retention window (see `GET /api/workbench/{batch_id}`).

### Identifiers

- `batch_id` — opaque, server-assigned at stage time. Stable for the
  life of the batch.
- `intent_handle` — opaque, server-assigned per intent appended to a
  batch. Used to address a specific intent within the batch for
  removal or amendment before commit.
- `preview_id` — opaque, returned by every `*/preview` endpoint. Valid
  for 5 minutes. Required by the corresponding non-preview endpoint
  (commit, revert, stash, restore) per `CLAUDE.md` §Preview Before
  Commit, Always.
- `stash_id` — opaque, server-assigned when a batch enters the
  `stashed` state. Used to address the stash for inspection or
  restore. Distinct from `batch_id` because stashes are first-class
  objects with their own retention.

All IDs are opaque to the client; the structure is an implementation
concern of newtcon-server.

### Provenance references

Each intent inside a batch carries the same substrate that
`/api/operations/{operation_id}` exposes per
[§Operations](#endpoints--operations) — intent kind, resource,
user params, and (after commit) the NEWTRON_INTENT record actually
written. Per operator-philosophy invariant #1 ("no black boxes"), every
intent in a batch is fully inspectable, and after commit the contract
exposes a navigation link to the dedicated Provenance surface at
[`GET /api/intents/{intent_id}`](#get-apiintentsintent_id) for full
intent-record substrate (record fields, DAG context, origin, linked
ChangeSets, rebuild implication).

### `POST /api/workbench/stage`

Create a new batch or append intents to an existing one. **Not a
state-changing endpoint against newtron** — staging mutates only
newtcon-server's batch store. No preview pair is required (and none is
defined). Idempotent semantics on the request: re-stage with the same
`(verb, network, node, interface, params)` tuple does not create a
duplicate intent; the existing `intent_handle` is returned.

**Request:**
```json
{
  "batch_id": "<opaque, omit to create a new batch>",
  "label": "<operator-supplied free text, optional>",
  "intents": [
    {
      "verb": "ApplyService | RemoveService | RefreshService | CreateVLAN | DeleteVLAN | CreateVRF | DeleteVRF | BindACL | UnbindACL | AddBGPPeer | RemoveBGPPeer | ApplyQoS | RemoveQoS | Reconcile | ...",
      "network": "default",
      "node": "switch1",
      "interface": "Ethernet0",
      "params": { "service": "transit", "ip": "10.1.0.0/31", "peer_as": 65002 }
    }
  ]
}
```

`verb` enumerates the symmetric verbs from
`DESIGN_PRINCIPLES_NEWTRON` §15-§16. Node-scoped verbs (e.g.,
`CreateVLAN`) omit `interface`; interface-scoped verbs require it.
Unknown verbs → 400 `validation_failure` with
`details.allowed_verbs[]`.

`Reconcile` is admitted as a batchable intent: a Workbench batch may
combine targeted intents on some Nodes with full or delta
`Reconcile` on others (e.g., "apply service to switch1:Ethernet0 AND
reconcile switch3"). The `params` object for `Reconcile` carries
`{ "mode": "delta" | "full", "confirm_disruptive": <bool> }`;
`confirm_disruptive` is required when `mode == "full"`.

**Response 200:**
```json
{
  "batch_id": "<opaque>",
  "label": "<echoed or auto-assigned>",
  "state": "drafting",
  "created_at": "2026-05-25T14:10:00Z",
  "last_modified_at": "2026-05-25T14:10:00Z",
  "intents": [
    {
      "intent_handle": "<opaque>",
      "verb": "ApplyService",
      "network": "default",
      "node": "switch1",
      "interface": "Ethernet0",
      "params": { "service": "transit", "ip": "10.1.0.0/31", "peer_as": 65002 },
      "staged_at": "2026-05-25T14:10:00Z",
      "deduplicated_from_existing": false
    }
  ],
  "node_count": 1,
  "intent_count": 1
}
```

`deduplicated_from_existing` is `true` when an identical intent
already existed in the batch and the existing `intent_handle` was
returned. The operator's UI surfaces this rather than silently
adding-then-collapsing.

**Errors:**
- `batch_id` provided but unknown or in a non-`drafting` state → 409
  `precondition_failure` with `details.current_state`. Append is
  forbidden on `committed`, `reverted`, `stashed`, and the transient
  `*_previewed` states.
- An intent references a node or interface the spec does not declare
  → 400 `validation_failure` with `details.invalid_targets[]`. This
  is a spec-level rejection, not a newtron round-trip; it catches
  typos before the operator wastes a preview cycle.

### `DELETE /api/workbench/{batch_id}/intents/{intent_handle}`

Remove one staged intent from a `drafting` batch. Mirrors the
single-intent shape of `POST .../stage`. No newtron interaction; no
preview required (drafting-state mutation only).

**Response 200:**
```json
{
  "batch_id": "<echoed>",
  "removed_intent_handle": "<echoed>",
  "intent_count_after": 3,
  "node_count_after": 2
}
```

Operating on a non-`drafting` batch → 409 `precondition_failure`.

### `GET /api/workbench/{batch_id}`

Return full batch state, including the most recent preview/dry-run
result (if any) and the current per-Node atomicity classification.
Idempotent; safe to poll.

**Response 200:**
```json
{
  "batch_id": "<opaque>",
  "label": "<operator-supplied>",
  "state": "drafting | previewed | committed | revert_previewed | reverted | stash_previewed | stashed",
  "created_at": "2026-05-25T14:10:00Z",
  "last_modified_at": "2026-05-25T14:12:30Z",
  "as_of": "2026-05-25T14:12:31Z",
  "intent_count": 4,
  "node_count": 2,
  "per_node_atomicity": [
    {
      "node": "switch1",
      "intent_count": 3,
      "atomicity": "atomic_via_txpipeline",
      "atomicity_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#31-node-as-device-isolation-boundary"
      }
    },
    {
      "node": "switch2",
      "intent_count": 1,
      "atomicity": "atomic_via_txpipeline",
      "atomicity_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#31-node-as-device-isolation-boundary"
      }
    }
  ],
  "cross_node_atomicity": {
    "atomic": false,
    "rationale_ref": {
      "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#11-the-changeset-is-the-universal-contract",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#8-scope-boundaries--what-newtron-owns"
    },
    "operator_consequence": "If commit succeeds on switch1 and fails on switch2, switch1 is committed. Use revert to reverse switch1."
  },
  "intents": [
    {
      "intent_handle": "<opaque>",
      "verb": "ApplyService",
      "network": "default",
      "node": "switch1",
      "interface": "Ethernet0",
      "params": { "service": "transit", "ip": "10.1.0.0/31", "peer_as": 65002 },
      "staged_at": "2026-05-25T14:10:00Z",
      "preview_result": {
        "validate": { /* Validate object — see §POST /api/preview "Validate (typed)" */ },
        "changeset": { /* ChangeSet object — see §POST /api/preview "ChangeSet (typed)" */ },
        "reference_impact": {
          "created": ["ROUTE_MAP|TRANSIT_IN_A1B2C3D4"],
          "incremented": [],
          "decremented": [],
          "garbage_collected": []
        },
        "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ },
        "reverses": null
      },
      "commit_result": null,
      "intent_id": null,
      "intent_url": null
    }
  ],
  "aggregate_reference_impact": {
    "created": ["ROUTE_MAP|TRANSIT_IN_A1B2C3D4", "ACL_TABLE|PROTECT_RE_IN_1ED5F2C7"],
    "incremented": [],
    "decremented": [],
    "garbage_collected": []
  },
  "latest_preview_id": "<opaque or null>",
  "latest_dry_run_at": "2026-05-25T14:12:30Z"
}
```

Field rules:

- `per_node_atomicity[*].atomicity` is one of:
  `atomic_via_txpipeline` (the per-Node default — newtron's batch
  execute wraps the per-Node intents in one TxPipeline),
  `atomic_via_replaceall` (when the per-Node bundle reduces to a full
  `Reconcile` with `mode: "full"`; `ReplaceAll` is atomic per
  `unified-pipeline-architecture.md` §6),
  `atomic_via_applydrift` (when the per-Node bundle is a delta
  `Reconcile`; `ApplyDrift` is atomic per the same section), or
  `not_atomic_with_rationale` (reserved for verbs whose newtron HTTP
  shape does not preserve atomicity; today empty, but the enum is
  bounded so any future verb that breaks the per-Node guarantee
  surfaces honestly rather than silently).
- `cross_node_atomicity.atomic` is **always** `false` when
  `node_count > 1`. When `node_count == 1`, the field is omitted
  entirely (no cross-Node coordination question to answer). Setting
  it to `true` is forbidden by the contract.
- `intent.preview_result` is populated only after a successful
  `/dry_run` or `/commit/preview` (whichever ran last); `null` in
  pure-`drafting` state.
- `intent.commit_result` is populated only after a successful
  `/commit`; structure mirrors `per_target` entries of the commit
  response (see below).
- `intent.intent_id` and `intent.intent_url` are populated only
  after commit and point to the dedicated Provenance surface at
  [`GET /api/intents/{intent_id}`](#get-apiintentsintent_id).

**Errors:**
- Unknown `batch_id` → 404 `precondition_failure` with
  `details.reason: "batch_unknown_or_expired"`.

### `GET /api/workbench/{batch_id}/diff`

Return the projection-level effect of the batch: what the
per-Node projection looks like before vs. after the staged intents
would be applied. Mandatory for the operator to read the substrate
prior to commit (operator-philosophy invariant #3 "the substrate is
the teaching surface" — counts and ChangeSets are necessary; the
projection itself is the substrate that makes the device knowable).

The projection is the typed CONFIG_DB tables produced by intent
replay (`DESIGN_PRINCIPLES_NEWTRON` §1, §21). Diff renders the
before-projection (current intent set) and the after-projection (with
the batch's intents replayed on top), per-Node, per-table.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `node` | string (repeatable) | unset (all nodes in batch) | Restrict diff to one or more Nodes. |
| `table` | string (repeatable) | unset (all touched tables) | Restrict diff to one or more CONFIG_DB tables. |

**Response 200:**
```json
{
  "batch_id": "<echoed>",
  "as_of": "2026-05-25T14:13:00Z",
  "per_node_diffs": [
    {
      "node": "switch1",
      "before_projection_intent_count": 47,
      "after_projection_intent_count": 50,
      "table_diffs": [
        {
          "table": "BGP_NEIGHBOR",
          "before_entries": [
            { "key": "default|10.0.0.1", "fields": { "asn": "65001" } }
          ],
          "after_entries": [
            { "key": "default|10.0.0.1", "fields": { "asn": "65001" } },
            { "key": "default|10.1.0.1", "fields": { "asn": "65002" } }
          ],
          "delta": {
            "added": ["default|10.1.0.1"],
            "removed": [],
            "modified": []
          }
        }
      ]
    }
  ],
  "manual_equivalent": {
    "newtron_cli": "newtron switch1 dry-run | jq '.projection.BGP_NEIGHBOR'",
    "newtron_http": {
      "status": "available",
      "method": "POST",
      "path": "/network/default/node/<node>/intent/projection-diff",
      "body": { "operations": [ /* TopologyStep[]: {url, params} per step */ ] },
      "note": "Returns `ProjectionDiffResult { before: RawConfigDB, after: RawConfigDB, diff: sonic.DriftEntry[] }`. The substrate technique is in-memory replay over a snapshotted intent DB: hypothetical operations are applied via `ReplayStep` (with `actuatedIntent` temporarily cleared so the precondition's Lock guard is skipped during reconstruction); the resulting projection is captured; both intent DB and projection are then restored via `RebuildProjectionFromIntents` (Phase 3 primitive). No state mutation survives the call. The newtcon-facing per-Node-per-table grouping (`per_node_diffs[*].table_diffs[*]`) is computed by newtcon-server from the entry-level `diff[]`; one newtron call per Node in the batch (one Node → one projection-diff). The `node` and `table` query parameters are applied client-side by newtcon-server (`node` partitions the per-Node call list; `table` filters the entry-level `diff[]` before regrouping)."
    }
  }
}
```

**Substrate-vs-decoration boundary (binding).** The newtron substrate
delivered by `POST /network/{n}/node/{d}/intent/projection-diff` is
the `ProjectionDiffResult` envelope shipped by newtron's Phase 4 work
(2026-05-27, commit `ecb04c7`): `{ before: RawConfigDB, after:
RawConfigDB, diff: sonic.DriftEntry[] }`. The `diff` array is the
§46-canonical entry-level delta vocabulary (`DriftEntry`) — newtron's
single typed-diff representation
(`DESIGN_PRINCIPLES_NEWTRON.md` §46 rule 3, "One typed diff
vocabulary"). The request body is `{operations: TopologyStep[]}`,
where each `TopologyStep` is `{url, params}` — the same shape
newtron's `/execute` and `/intent/save` consume. The lead's closing
comment on
[newtron#4](https://github.com/aldrin-isaac/newtron/issues/4)
verbatim: "Projection-diff endpoint landed at POST
/network/{n}/node/{d}/intent/projection-diff. Hypothetical operations
are applied in-memory via ReplayStep (with actuatedIntent temporarily
cleared so precondition's Lock guard is skipped during
reconstruction), resulting projection is captured, then both intent
DB and projection are restored via RebuildProjectionFromIntents
(Phase 3 primitive). Returns ProjectionDiffResult{before, after,
diff} with diff in canonical sonic.DriftEntry vocabulary. Verified
end-to-end against deployed 1node-vs
(newtrun/suites/1node-vs-basic/08-projection-diff-actuated, PASS in
1m54s) — confirms diff substrate AND no state leakage (post-call
intent/drift returns clean). Operationalizes operator-philosophy
invariant #4 (show before do) at the substrate level."

The substrate carries three shapes only: `before` (the projection
right now), `after` (the projection that would exist if the
operations were applied), and `diff` (the entry-level delta). Every
other field in the newtcon response above is a newtcon-server-side
decoration:

| newtcon response field | Source |
|------------------------|--------|
| `per_node_diffs[*].node` | Bare substrate — one newtron `/intent/projection-diff` call per Node in the batch; the Node identifier is newtcon's batch context. |
| `per_node_diffs[*].before_projection_intent_count`, `after_projection_intent_count` | Composed by newtcon-server from `GET /network/{n}/node/{d}/intent/tree` (companion read taken before and after the hypothetical operations are reasoned about). NOT in the projection-diff substrate. |
| `per_node_diffs[*].table_diffs[*].table`, `before_entries`, `after_entries` | **Transformed** by newtcon-server: the per-Node `before` / `after` `RawConfigDB` maps (`map[table]map[key]map[field]string`) are walked per-table; per-key entries are projected into the `{key, fields}` shape. The keys and fields are taken verbatim from the substrate; the table grouping is newtcon's view, not newtron's wire shape. |
| `per_node_diffs[*].table_diffs[*].delta.added`, `removed`, `modified` | **Transformed** by newtcon-server from the entry-level `diff: []DriftEntry`: rows with `type: "extra"` become `added[]` keys, rows with `type: "missing"` become `removed[]` keys, rows with `type: "modified"` become `modified[]` keys, all grouped by `table`. The canonical entry-level vocabulary is preserved internally; the per-table per-bucket presentation is the operator-facing view. |
| `batch_id`, `as_of`, `manual_equivalent` | newtcon-server metadata. |

This separation is binding per `DESIGN_PRINCIPLES_NEWTRON.md` §46:
the substrate is the typed `ProjectionDiffResult` with its
`DriftEntry[]`, and only that. The per-Node fanout, the per-table
grouping, the per-bucket (`added`/`removed`/`modified`) presentation,
and the intent-count companions are all newtcon-server compositions
over that substrate plus existing companion reads. An Implementer
slicing this endpoint MUST NOT request a richer wire shape from
newtron — the substrate response is deliberately bare, and the
decorations live in newtcon-server.

The original gap-filing proposed a `scope.tables[]` body field for
server-side table filtering; newtron did not adopt it because the
substrate response carries the full diff cheaply (one per-Node
in-memory replay, restored). The newtcon `?table=` query parameter is
implemented client-side by newtcon-server filtering the entry-level
`diff[]` before regrouping, per the same operator-facing semantics —
the substrate-faithful path remains "fetch all, group as the operator
asked," consistent with §46 rule 1 ("Canonical first, summary
second") and `CLAUDE.md` §No Hidden State (no server-side
silent-omission).

**Symmetric framing.** Per
[`DESIGN_PRINCIPLES_NEWTRON` §15](../newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove),
this surface is symmetric with respect to forward vs reverse verbs in
the batch: a batch composed of `RemoveService` / `UnbindACL` /
`RemoveBGPPeer` (or any §15 reverse) produces a projection-diff in
the same substrate shape — `before` carries the current projection,
`after` carries the projection with the reverse operations replayed
on top, and `diff` carries `missing` entries (deletes) where the
forward equivalent would carry `extra` (adds). The substrate does not
distinguish "create-diff" vs "delete-diff" — the same
`ProjectionDiffResult` shape serves both, per the lead's single-
substrate landing.

**Errors:**
- Unknown `batch_id` → 404 `precondition_failure` per the typed schema
  in §Error Schema.
- newtron unreachable → 503 `newtron_unavailable` per the typed schema
  in §Error Schema. `details.last_known.kind` is `"projection_diff"`
  and `details.last_known.payload` carries the most recent successful
  diff if any (`kind: "none"` if none has been computed).
- newtron returns 400 on the underlying `/intent/projection-diff`
  call (invalid JSON or unknown step URL in `operations[]`) → 422
  `validation_failure` per the typed schema in §Error Schema, with
  `details.per_operation[]` enumerating the rejected step indices and
  newtron's per-step rejection reason. The batch is left unmodified;
  no projection-diff is returned for any Node.
- newtron returns 500 on the underlying call (rebuild failure during
  the `RebuildProjectionFromIntents` restore path) → 502
  `newtron_internal_error` per the typed schema in §Error Schema. The
  newtron-side state has been restored (the substrate guarantees no
  state leakage on the success path; the failure path is a newtron
  internal-error signal, not state-leakage at the operator surface).

### `POST /api/workbench/{batch_id}/dry_run`

Run the full batch as a sandbox replay using newtron's intent
snapshot/restore mechanism. Per `unified-pipeline-architecture.md` §8,
newtron's batch-execute endpoint with `execute: false` performs `Lock
→ snapshot → fn → restore → Unlock` per Node: the intent DB and
projection are mutated through the full Render path, then restored.
Nothing reaches the device.

The dry-run is the single mechanism the operator uses to answer
"what would actually happen if I committed this?" — it exercises
the same Render code path that commit does (the one-code-path
guarantee from `DESIGN_PRINCIPLES_NEWTRON` §2 and the dry-run
guarantee from §12). The per-target preview returned here is what the
`GET /api/workbench/{batch_id}` `preview_result` field reflects until
the next dry-run or commit.

This is a state-changing endpoint **against newtcon-server only** (it
mutates the batch's `latest_preview_id` and `preview_result` fields).
Per `CLAUDE.md` §Preview Before Commit, Always: this endpoint IS the
preview pair for commit. It produces no ChangeSet against any device,
and the contract makes that explicit in the response.

**Request:**
```json
{
  "include_diff": true
}
```

`include_diff` (default `false`): when `true`, the response embeds
the projection diff inline (same shape as `GET .../diff`). When
`false`, the diff is omitted and the operator fetches it separately.
Operators with large diffs prefer the separate endpoint; UIs in
single-screen mode prefer inline.

**Response 200:**
```json
{
  "preview_id": "<opaque, valid for 5 minutes>",
  "batch_id": "<echoed>",
  "ran_at": "2026-05-25T14:13:30Z",
  "no_device_io": true,
  "per_target": [
    {
      "intent_handle": "<opaque>",
      "node": "switch1",
      "interface": "Ethernet0",
      "verb": "ApplyService",
      "validate": { /* Validate object — see §POST /api/preview "Validate (typed)" */ },
      "changeset": { /* ChangeSet object — see §POST /api/preview "ChangeSet (typed)" */ },
      "reference_impact": {
        "created": ["ROUTE_MAP|TRANSIT_IN_A1B2C3D4"],
        "incremented": [],
        "decremented": [],
        "garbage_collected": []
      },
      "intent_record_preview": {
        "key": "service|transit|Ethernet0",
        "fields": { /* NEWTRON_INTENT record fields that would be written */ }
      },
      "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ },
      "reverses": null
    }
  ],
  "per_node_summaries": [
    {
      "node": "switch1",
      "intent_count": 3,
      "all_valid": true,
      "total_writes": 14,
      "total_deletes": 0,
      "atomicity": "atomic_via_txpipeline"
    }
  ],
  "aggregate": {
    "all_valid": true,
    "node_count": 2,
    "intent_count": 4,
    "total_writes": 16,
    "total_deletes": 0,
    "confidence": { /* Aggregated Confidence; see §POST /api/preview "Confidence (typed)" */ }
  },
  "aggregate_reference_impact": {
    "created": ["ROUTE_MAP|TRANSIT_IN_A1B2C3D4"],
    "incremented": [],
    "decremented": [],
    "garbage_collected": []
  },
  "diff": null
}
```

**Schema reuse.** `per_target[*].validate`, `per_target[*].changeset`,
`per_target[*].confidence`, `per_target[*].reverses`, and
`aggregate.confidence` use the typed objects defined in §POST
/api/preview ("Validate (typed)", "ChangeSet (typed)", "Confidence
(typed)", "Reverses (typed)"). `per_target[*].reverses` is non-null
for any batch entry whose `verb` is in §15's remove-class set (e.g.,
a Workbench batch that stages a `RemoveService` carries `reverses`
on that entry); the typical dry-run batch of forward verbs carries
`reverses: null` on every entry.

`diff` carries the projection-diff payload (same shape as `GET
.../diff`) when `include_diff: true`; `null` otherwise.

`no_device_io: true` is a load-bearing assertion, not decoration. Per
operator-philosophy invariant #9 ("Confidence and limits are
explicit"), the contract makes it impossible for the UI to confuse a
dry-run with a commit. Per `unified-pipeline-architecture.md` §8, the
dry-run path goes through Render but not Deliver; the corresponding
pipeline trace fields (which would carry a `deliver` stage) are
deliberately omitted from this response. The Deliver stage is
documented as conditional in §2 of the same document, and a
contract-level omission here matches that conditionality.

Validation failures on any per-target produce a 200 with
`aggregate.all_valid == false` and `per_target[*].validate.ok ==
false` for the failing entries. `validate.preconditions[]` and/or
`validate.schema_violations[]` are populated per the typed §POST
/api/preview "Validate (typed)" split (preconditions are
"fix-the-situation" refusals; schema_violations are "fix-the-value"
refusals). The preview is still returned for the targets that
validated. The operator commits a partial-validity preview at their
own risk: commit will reject if any per-target is invalid (see
commit response).

A drift-guard refusal on any target → 409 with `kind:
"drift_refusal"` and `details` per the typed schema in §Error Schema.
`details.per_target[]` lists the offending Nodes and their
`drift_entries[]` (same `DriftEntry` shape as the Inbox drift card's
`detail.drift_entries[]`). The preview is not returned.

**Errors:**
- Unknown `batch_id` → 404 `precondition_failure`.
- Batch state is `committed` or `reverted` (terminal mutating
  states) → 409 `precondition_failure` with `details.current_state`.
  Dry-run on a stashed batch is allowed (and useful — the operator
  inspects a stashed batch's effect before deciding to restore).
- newtron unreachable for any Node → 503 `newtron_unavailable` per
  the typed schema in §Error Schema. `details.affected_nodes[]` lists
  the unreachable Nodes; `details.last_known.kind` is `"none"` (the
  dry-run is not partially returned — either every Node's sandbox
  replay succeeds or the call fails as a whole).

### `POST /api/workbench/{batch_id}/commit/preview`

Preview the commit: render the per-Node bundles that would actually
be sent to newtron's batch-execute endpoint, in newtron's exact
request shape, alongside the per-target shape the UI displays. This
is the substrate-faithful preview pair that pairs with `/commit`. It
is distinct from `/dry_run`:

- `/dry_run` answers "what would the projection and CONFIG_DB look
  like after this batch?" — the operator-facing semantic preview.
- `/commit/preview` answers "what HTTP calls is newtcon about to
  make to newtron, and what is each call's per-Node atomicity
  class?" — the substrate-faithful execution preview.

Both exist because the operator needs both questions answered before
committing. Collapsing them would force one perspective on the
operator — exactly the dependency-creating pattern
operator-philosophy invariant #1 ("no black boxes") rejects.

The commit-preview response carries a `preview_id` distinct from any
dry-run's `preview_id`. Commit requires the commit-preview's
`preview_id`, not a dry-run's, so that the operator cannot
accidentally commit having only seen the semantic preview.

**Request:**
```json
{}
```

The request body is empty. The commit-preview reads the current
batch state and renders accordingly.

**Response 200:**
```json
{
  "preview_id": "<opaque, valid for 5 minutes>",
  "batch_id": "<echoed>",
  "rendered_at": "2026-05-25T14:14:00Z",
  "per_node_calls": [
    {
      "node": "switch1",
      "atomicity": "atomic_via_txpipeline",
      "atomicity_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#31-node-as-device-isolation-boundary"
      },
      "intent_handles": ["<opaque>", "<opaque>", "<opaque>"],
      "manual_equivalent": {
        "newtron_cli": "newtron switch1 execute -x --file batch.json",
        "newtron_http": {
          "status": "available",
          "method": "POST",
          "path": "/network/default/node/switch1/execute",
          "body": {
            "execute": true,
            "operations": [
              { "action": "apply-service", "interface": "Ethernet0", "params": { "service": "transit", "ip_address": "10.1.0.0/31", "peer_as": 65002 } }
            ]
          }
        }
      }
    }
  ],
  "execution_order": [
    { "step": 1, "node": "switch1", "rationale": "fewest dependents" },
    { "step": 2, "node": "switch2", "rationale": "depends on switch1 BGP peer" }
  ],
  "execution_order_rationale_ref": {
    "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#18-write-ordering-and-daemon-settling",
    "principle": "docs/operator-philosophy.md#9-confidence-and-limits-are-explicit"
  },
  "cross_node_atomicity": {
    "atomic": false,
    "rationale_ref": {
      "substrate": "newtron/docs/newtron/api.md#14-batch-execution",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#8-scope-boundaries--what-newtron-owns"
    },
    "operator_consequence": "If step 1 succeeds and step 2 fails, step 1 is committed. Use POST /api/workbench/{batch_id}/revert to reverse step 1."
  },
  "disruption": {
    "config_reload_nodes": [],
    "bgp_restart_nodes": [],
    "estimated_data_plane_impact": "control-plane-only",
    "rationale": [
      { "input": "verbs", "value": ["ApplyService"], "contribution": "control-plane-only (BGP neighbor add, no reload)" },
      { "input": "reconcile_full_nodes", "value": [], "contribution": "none" },
      { "input": "bgp_restart_inferred", "value": false, "contribution": "none" }
    ]
  },
  "preflight": {
    "all_nodes_reachable": true,
    "unreachable_nodes": [],
    "drift_guard_clean": true,
    "drift_blocked_nodes": []
  },
  "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ }
}
```

`confidence` at the top level of the commit-preview reflects the
whole pre-commit render (per-target ChangeSets, preflight,
cross-Node ordering); reasons include `precondition_check_partial`
when preflight could not fully complete and
`shared_resource_count_estimated` when reference-impact projections
in the underlying per-target dry-run carry that caveat. Per-target
ChangeSet, Validate, and Confidence objects (when the operator
navigates from commit-preview back into the underlying per-target
dry-run) use the typed shapes defined in §POST /api/preview.

Field rules:

- `per_node_calls[*].manual_equivalent.newtron_http.status` is
  `"available"` for every commit preview today: newtron's
  batch-execute endpoint is the underlying call. The
  `manual_equivalent.newtron_http.body` is the **exact** body
  newtcon-server will POST when commit runs; the operator can copy
  it into `curl` and execute the same call by hand. This satisfies
  operator-philosophy invariant #2 ("manual-mode parity") — every
  Workbench commit is exactly reproducible by hand.
- `execution_order` declares the deterministic order in which
  newtcon-server will issue the per-Node calls. The operator sees
  the order before committing. Re-issuing `/commit/preview` after a
  batch edit produces a fresh `execution_order`; the order is not
  inherited from earlier previews.
- `execution_order_rationale_ref` cites why the order was chosen.
  The default ordering policy is fewest-dependents-first; per
  `DESIGN_PRINCIPLES_NEWTRON` §18, write ordering is a load-bearing
  property of the pipeline. The Workbench inherits that
  consideration at the orchestration layer. v0 ordering is
  alphabetic by Node name unless an intent declares a dependency;
  the rationale field carries the chosen rule textually.
- `cross_node_atomicity` MUST be present whenever
  `len(per_node_calls) > 1`, and MUST carry `atomic: false`. The
  contract rejects `atomic: true` for multi-Node commits on
  principle.
- `disruption.rationale[]` follows the same shape as the Inbox
  action-preview's `disruption.rationale[]`: each entry names the
  input, value, and its contribution to the verdict. A rationale
  array empty of the inputs that justify the verdict is a contract
  violation (per the same rule documented in the Inbox section).
- `preflight` is a read-side check (drift guard scan +
  reachability) performed at preview time; it is NOT a commitment
  that the state will hold at commit time. The commit response
  reports the actual outcome per Node.

**Errors:**
- Unknown `batch_id` → 404 `precondition_failure`.
- Batch state not in `{drafting, previewed}` → 409
  `precondition_failure` with `details.current_state`.
- Any per-target failed validation in the most recent
  `/dry_run` → 409 `precondition_failure` with
  `details.invalid_intent_handles[]`. The operator must amend or
  drop the failing intent before commit-preview can be regenerated.
  Rationale: the commit-preview is the contract between the
  operator and the about-to-be-executed plan; rendering a
  commit-preview whose Render stage would reject mid-flight would
  teach a false confidence.
- newtron-server unreachable for any target Node → 503
  `newtron_unavailable` per the typed schema in §Error Schema.
  `details.affected_nodes[]` lists the unreachable Nodes; the preview
  is not partially rendered.

### `POST /api/workbench/{batch_id}/commit`

Execute a previously-rendered commit preview. Issues one newtron
batch-execute call per Node, in the order declared by the
commit-preview's `execution_order`. Each per-Node call is atomic per
the newtron guarantee; the cross-Node sequence is not atomic.

This endpoint admits a Server-Sent Events streaming variant per
§Streaming substrate-operation events. The variant is selected by the
request's `Accept` header (`text/event-stream` → SSE; otherwise →
JSON). The JSON variant is documented inline below; the SSE variant
carries the same `PerWrite` and per-target shapes as documented in
§Streaming substrate-operation events. Both variants surface the
per-substrate-operation `per_write[]` array on every per-Node
batch-execute target — the SSE variant additionally emits each entry
as a `substrate_op` event as newtron commits it. Per-Node atomicity
honesty (§Streaming substrate-operation events) applies: for a given
Node's TxPipeline bundle, every `redis_write` / `redis_delete` event
carries the same `result` (all `applied` or all `rejected`);
cross-Node events may interleave in the stream when the operator
opted into a multi-Node batch.

**Request:**
```json
{
  "preview_id": "<from /commit/preview>",
  "stop_on_first_failure": true
}
```

`stop_on_first_failure` (default `true`): when `true`, a per-Node
failure halts the sequence; remaining Nodes are not attempted and
appear in the response with `status: "not_attempted"`. When `false`,
the sequence continues through all Nodes regardless of per-Node
outcomes. Operators choosing `false` accept the larger blast radius
of a partially-committed multi-Node batch; the contract preserves
their choice rather than imposing a single safe-default policy
(operator-philosophy invariant #8: "Operator-defined automation,
not tool-imposed automation").

**Response 200 (JSON variant — `Accept: application/json` or default):**
```json
{
  "batch_id": "<echoed>",
  "committed_at": "2026-05-25T14:15:00Z",
  "per_target": [
    {
      "intent_handle": "<opaque>",
      "node": "switch1",
      "interface": "Ethernet0",
      "verb": "ApplyService",
      "status": "committed | failed | not_attempted",
      "operation_id": "<opaque, present when status != not_attempted>",
      "operation_url": "/api/operations/<opaque>",
      "intent_id": "<opaque, present when status == committed>",
      "intent_url": "/api/intents/<opaque>",
      "pipeline": {
        "intent":  { "stage": "complete", "at": "2026-05-25T14:15:00Z" },
        "replay":  { "stage": "complete", "at": "2026-05-25T14:15:00Z" },
        "render":  { "stage": "complete", "at": "2026-05-25T14:15:01Z" },
        "deliver": { "stage": "complete", "at": "2026-05-25T14:15:02Z" }
      },
      "verify": {
        "kind": "device_io_assertion",
        "state": "in_progress",
        "started_at": "2026-05-25T14:15:02Z",
        "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ }
      },
      "intent_record": {
        "key": "service|transit|Ethernet0",
        "fields": { /* NEWTRON_INTENT record actually written */ }
      },
      "per_write": [ /* PerWrite[], see §Streaming substrate-operation events */ ],
      "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ },
      "failure": null
    }
  ],
  "per_node_results": [
    {
      "node": "switch1",
      "status": "committed",
      "atomicity": "atomic_via_txpipeline",
      "intent_count": 3,
      "operation_ids": ["<opaque>"],
      "writes_landed": 14,
      "writes_rejected": 0,
      "daemon_waits": 2,
      "verify_reads_failed": 0
    },
    {
      "node": "switch2",
      "status": "not_attempted",
      "atomicity": "atomic_via_txpipeline",
      "intent_count": 1,
      "operation_ids": [],
      "writes_landed": 0,
      "writes_rejected": 0,
      "daemon_waits": 0,
      "verify_reads_failed": 0
    }
  ],
  "aggregate": {
    "outcome": "all_committed | partial | none_committed",
    "node_count_committed": 1,
    "node_count_failed": 0,
    "node_count_not_attempted": 1,
    "verify_pending_targets": 3,
    "stop_on_first_failure_triggered": true,
    "total_writes_landed": 14,
    "total_writes_rejected": 0,
    "total_daemon_waits": 2,
    "total_verify_reads_failed": 0,
    "confidence": { /* Aggregated Confidence; see §POST /api/preview "Confidence (typed)" */ }
  },
  "cross_node_atomicity": {
    "atomic": false,
    "operator_consequence": "switch1 was committed. switch2 was not attempted because stop_on_first_failure=true and a different node failed (see per_node_results). To reverse switch1, POST /api/workbench/{batch_id}/revert.",
    "recovery_hint": {
      "verb": "revert",
      "path": "/api/workbench/<batch_id>/revert/preview"
    }
  }
}
```

Field rules:

- `per_target[*].status`:
  - `committed` — newtron's batch-execute returned `applied: true`
    for this intent's per-Node bundle. The write LANDED in
    CONFIG_DB. Verify is a post-deliver Device I/O assertion per
    `unified-pipeline-architecture.md` §7 and may be `in_progress`,
    `complete`, `failed`, or `skipped` at response-render time.
    **`committed` does NOT imply verify passed** — a target with
    `status: "committed"` AND `verify.state: "failed"` (newtron
    returned 409 `VerificationFailedError` with `applied: true,
    verified: false`) is a legitimate combination: the write
    landed, the re-read disagreed. The substrate is in
    `verify.assertion.errors[]` (with `device_response` per
    [newtron#21](https://github.com/aldrin-isaac/newtron/issues/21))
    and in the per-target `per_write[]` `verify_read` entries with
    `result: "rejected"`. See "Verify failure does not produce a
    4xx envelope" in §Error Schema.
  - `failed` — newtron's batch-execute returned `applied: false`
    for this intent's per-Node bundle (the write did NOT land —
    schema validation, drift refusal, or deliver-stage error). The
    whole per-Node bundle is failed (per-Node atomicity); the
    `failure` object carries the substrate-level error from
    newtron. `failed` is reserved for refusal-before-landing;
    landed-but-verify-disagreed is `committed` with
    `verify.state: "failed"` per the rule above.
  - `not_attempted` — the sequence was halted before this intent's
    Node was reached (only possible when
    `stop_on_first_failure: true`).
- `per_target[*].pipeline` and `per_target[*].verify` mirror the
  shape defined in [§Operations](#endpoints--operations). When
  `status == not_attempted`, `pipeline` and `verify` are omitted.
  When `status == failed`, `pipeline` carries the partial trace up
  to the failed stage with the failed stage in `stage: "failed"`.
- `per_target[*].intent_record` is the NEWTRON_INTENT record
  actually written by the per-Node batch-execute. Per
  `DESIGN_PRINCIPLES_NEWTRON` §1, §22, the intent record IS the
  decision substrate; the commit response surfaces it directly so
  the operator never has to follow a link to read what was
  actually recorded.
- `per_target[*].per_write[]` is the per-substrate-operation sequence
  newtron executed for this target, ordered by `seq`. Each entry is
  a `PerWrite` per §Streaming substrate-operation events. Empty
  `per_write[]` is honest: the target was `not_attempted` (no
  Device I/O happened). Per-substrate-operation surfacing on
  newtron's write endpoints
  ([newtron#19](https://github.com/aldrin-isaac/newtron/issues/19)
  Phase 2a) shipped on 2026-05-27 — `per_write[]` is now populated
  for every attempted target. On `status == "failed"` (the write
  did NOT land — `applied: false` from newtron), `per_write[]`
  carries the substrate operations that landed before the per-Node
  TxPipeline was rejected (typically zero — schema validation per
  `DESIGN_PRINCIPLES_NEWTRON` §13 refuses the bundle before the
  `EXEC`; a daemon-rejection during settle that aborts the bundle
  may produce a non-empty prefix). A post-deliver verify failure
  is structurally **not** a `status == "failed"` outcome: the write
  landed (`applied: true`), only the post-deliver `cs.Verify(n)`
  re-read disagreed. The per-target row surfaces verify failure
  with `status == "committed"` and `verify.state == "failed"`,
  with the typed `verify.assertion.errors[]` (carrying
  `device_response` per
  [newtron#21](https://github.com/aldrin-isaac/newtron/issues/21))
  populated from newtron's `data: *WriteResult.verification` field
  on the 409 `VerificationFailedError` envelope. The same
  per-write `verify_read` substrate (a `PerWrite` with `kind:
  "verify_read"` and `result: "rejected"` plus verbatim
  `device_response`) appears on `per_write[]`; the two surfaces
  are complementary — `verify.assertion.errors[]` aggregates the
  failures at the assertion level (table/key/field) for the
  operator's first view, `per_write[]` exposes them at the
  substrate-operation level for substrate-cadence inspection.
  Both flow from the same newtron `VerificationResult` substrate
  per §46 (wire shape mirrors substrate). See "Verify failure
  does not produce a 4xx envelope" and the third vocabulary
  boundary in §Error Schema for the structural rule.
- `per_node_results[*].{writes_landed, writes_rejected, daemon_waits,
  verify_reads_failed}` are substrate-operation counts derivable
  from the corresponding target's `per_write[]`. They are REQUIRED
  because the operator's first view at the Node summary level must
  show substrate cadence (14 writes, 2 daemon waits, 0 verify
  failures), not just the abstract `status: "committed"`. The
  derivation is mechanical (count `kind`/`result` combinations in
  the Node's targets' `per_write[]` entries) so consumers may
  cross-check.
- `aggregate.total_*` counters sum the corresponding
  `per_node_results[*]` counters across every Node. The operator
  reading the response sees substrate cadence at a glance even
  before drilling into per-target detail. Operator-philosophy
  invariant #1 ("no black boxes") applies to the aggregate
  summary, not just to per-target detail.
- `per_target[*].failure`, when present, has the shape:
  ```json
  {
    "stage": "intent | replay | render | deliver",
    "kind": "validation_failure | drift_refusal | precondition_failure | newtron_unavailable | internal",
    "message": "<newtron's domain-level error>",
    "details": { /* per-kind typed shape; see §Error Schema */ }
  }
  ```
  The `kind` values are the same five values defined in §Error Schema,
  and `details` populates the same per-kind typed shape. A per-target
  failure is structurally identical to a top-level error envelope; the
  only difference is wrapper-level (the per-target failure is one
  element of a 200 response's `per_target[]`, while a top-level error
  is the body of a non-2xx response). `kind` values match newtron's
  substrate-level error classifications, NOT HTTP status codes (per
  `CLAUDE.md` §Operator-Honest Errors). `stage` is in addition to the
  `details.correlation_id` and other companion fields, and names which
  pipeline stage produced the failure (per
  `unified-pipeline-architecture.md` §2). The `stage` enum
  intentionally excludes `verify`: a post-deliver verify failure
  means the write **landed** (`status: "committed"`, `applied:
  true`), and the substrate is surfaced through `per_target[*].
  verify.assertion.errors[]` (with `device_response` per
  newtron#21) rather than through `per_target[*].failure` — see
  the "Verify failure does not produce a 4xx envelope" and
  "`verify` failure is NOT one of the five `kind` values"
  vocabulary boundaries in §Error Schema. A target whose
  `per_target[*].failure.stage == "verify"` is a contract
  violation; the failure must surface through the success-path
  verify substrate.
- `aggregate.outcome`:
  - `all_committed` — every per-Node result is `committed`.
  - `partial` — at least one `committed` and at least one of
    `{failed, not_attempted}`.
  - `none_committed` — no Node committed (first-Node failure with
    `stop_on_first_failure: true`, or every Node failed).
- `cross_node_atomicity` is REQUIRED in every commit response with
  `node_count > 1`, including the all-success case. The operator
  must learn the model from successful commits, not only from
  failures (operator-philosophy invariant #9: "Confidence and
  limits are explicit").
- `recovery_hint` is REQUIRED when `aggregate.outcome == "partial"`
  and the operator has a meaningful next action; absent on
  `all_committed` or `none_committed`.

**Response 200 (SSE variant — `Accept: text/event-stream`):** stream
per §Streaming substrate-operation events. The terminal
`apply_complete` event's data payload is byte-for-byte the same JSON
object documented above for the JSON variant (`batch_id`,
`committed_at`, `per_target[]`, `per_node_results[]`, `aggregate`,
`cross_node_atomicity`). Per-Node `substrate_op` events flow as
newtron commits each Node's TxPipeline. When
`stop_on_first_failure: true` halts the sequence, no further
`substrate_op` events flow after the failed Node's terminal write;
the `apply_complete` payload's `per_node_results[]` carries
`status: "not_attempted"` and zeroed substrate counters for the
unreached Nodes.

**Errors:**
- Stale or already-consumed `preview_id` → 410 Gone with
  `kind: "precondition_failure"`.
- `preview_id` was a dry-run preview, not a commit-preview → 409
  `precondition_failure` per the typed schema in §Error Schema, with
  `condition: "preview_id_wrong_class"` and
  `condition_details: { preview_id, received_kind: "workbench_dry_run", required_kind: "workbench_commit_preview" }`.
  The contract rejects this on principle: the operator must have seen
  the substrate-faithful commit preview before committing. (HTTP 409
  matches the precondition-failure convention used elsewhere in the
  contract for wrong-state preview misuse, replacing the prior 400
  which conflated this with input-validation failures.)
- Batch state is not `previewed` (commit-preview must immediately
  precede commit) → 409 `precondition_failure`.
- Catastrophic newtcon-server failure mid-sequence → 502 with
  `kind: "internal"` per the typed schema in §Error Schema.
  `details.partial_results` carries the per-Node results completed
  before the failure (shape matches this endpoint's success-response
  `per_target[]`, including each target's `per_write[]` of substrate
  operations that landed before the abort). The batch state is left
  at `committed` with the partial results; the operator decides
  recovery via revert. The `details.correlation_id` is the handle
  for the ops ticket. On the SSE variant, the catastrophic failure
  flows as an `error` event per §Streaming substrate-operation
  events ("Mid-stream errors"); the partial substrate operations
  that completed before the abort appear as their own
  `substrate_op` events preceding the `error`.

### `POST /api/workbench/{batch_id}/revert/preview`

Preview the revert: synthesize the reverse intents for every
committed target in the batch and render the per-Node bundles that
would be sent to newtron. Mandatory before `/revert` per
`CLAUDE.md` §Preview Before Commit, Always.

Revert is **not** a mechanical ChangeSet reversal. Per
`DESIGN_PRINCIPLES_NEWTRON` §15 ("Shared resources make reversal a
domain problem"): "mechanical ChangeSet reversal is unsafe ... Every
removal path scans CONFIG_DB for remaining consumers before deleting
shared resources — a domain judgment that no mechanical reversal can
replicate." The Workbench therefore issues the **symmetric verb** for
each committed intent (`ApplyService` → `RemoveService`,
`CreateVLAN` → `DeleteVLAN`, etc., per §15's pair table), letting
newtron's domain logic handle shared-resource reference counting.

For verbs in the `setup-*` and `set-*` families (no individual
reverse per §16), revert is `Reconcile(mode: delta)` on the
affected Node — also per §15's "baseline operations" clause.

**Request:**
```json
{
  "scope": "all_committed | per_target_handles",
  "intent_handles": ["<opaque>", "<opaque>"]
}
```

`scope`:
- `all_committed` — synthesize reverses for every intent in the
  batch with `commit_result.status == "committed"`. The default
  scope.
- `per_target_handles` — restrict revert to a subset of committed
  intents named in `intent_handles[]`. Used when the operator wants
  to reverse some targets but not others (e.g., switch1 deployed
  successfully and the operator wants to keep it; switch2 must be
  reverted because of a downstream issue). `intent_handles[]` is
  required when `scope == "per_target_handles"`.

**Response 200:**
```json
{
  "preview_id": "<opaque, valid for 5 minutes>",
  "batch_id": "<echoed>",
  "rendered_at": "2026-05-25T14:20:00Z",
  "scope": "all_committed",
  "per_target": [
    {
      "original_intent_handle": "<opaque>",
      "original_verb": "ApplyService",
      "reverse_verb": "RemoveService",
      "reverse_strategy": "symmetric_verb | reconcile_delta | reconcile_full",
      "reverse_strategy_rationale_ref": {
        "substrate": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#15-symmetric-operations--what-you-create-you-can-remove",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#16-verb-vocabulary--the-name-is-the-lifecycle-contract"
      },
      "node": "switch1",
      "interface": "Ethernet0",
      "validate": { /* Validate object — see §POST /api/preview "Validate (typed)" */ },
      "changeset": { /* ChangeSet object — see §POST /api/preview "ChangeSet (typed)" */ },
      "reference_impact": {
        "created": [],
        "incremented": [],
        "decremented": ["ROUTE_MAP|TRANSIT_IN_A1B2C3D4"],
        "garbage_collected": ["ACL_TABLE|PROTECT_RE_IN_1ED5F2C7"]
      },
      "shared_resource_handling": [
        {
          "resource": "VRF|CUSTOMER",
          "decision": "preserve",
          "rationale": "still referenced by transit on switch3:Ethernet1"
        },
        {
          "resource": "ACL_TABLE|PROTECT_RE_IN_1ED5F2C7",
          "decision": "garbage_collect",
          "rationale": "reference count reaches 0 after revert"
        }
      ],
      "reverses": { /* Reverses object — see §POST /api/preview "Reverses (typed)" */ },
      "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ }
    }
  ],
  "per_node_calls": [
    {
      "node": "switch1",
      "atomicity": "atomic_via_txpipeline",
      "atomicity_rationale_ref": {
        "substrate": "newtron/docs/newtron/unified-pipeline-architecture.md#8-execute--write-path-with-dry-run-support",
        "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#31-node-as-device-isolation-boundary"
      },
      "manual_equivalent": {
        "newtron_cli": "newtron switch1 execute -x --file revert.json",
        "newtron_http": {
          "status": "available",
          "method": "POST",
          "path": "/network/default/node/switch1/execute",
          "body": {
            "execute": true,
            "operations": [
              { "action": "remove-service", "interface": "Ethernet0", "params": {} }
            ]
          }
        }
      }
    }
  ],
  "execution_order": [
    { "step": 1, "node": "switch1", "rationale": "reverse order of commit (no inter-Node dependency in this batch)" }
  ],
  "cross_node_atomicity": {
    "atomic": false,
    "rationale_ref": {
      "substrate": "newtron/docs/newtron/api.md#14-batch-execution",
      "principle": "newtron/docs/DESIGN_PRINCIPLES_NEWTRON.md#8-scope-boundaries--what-newtron-owns"
    },
    "operator_consequence": "Revert follows the same per-Node atomicity as commit. A partial revert is possible; re-issue revert with scope=per_target_handles on the unreverted subset."
  },
  "disruption": {
    "config_reload_nodes": [],
    "bgp_restart_nodes": [],
    "estimated_data_plane_impact": "service-affecting",
    "rationale": [
      { "input": "verbs", "value": ["RemoveService"], "contribution": "service-affecting (removes BGP neighbor and frees IP from interface)" }
    ]
  },
  "scope_unrevertable": {
    "intent_handles": [],
    "reason_by_handle": {}
  }
}
```

Field rules:

- `per_target[*].reverse_strategy` is one of:
  - `symmetric_verb` — the canonical case. The reverse verb from
    `DESIGN_PRINCIPLES_NEWTRON` §15's pair table is dispatched
    against newtron. Domain logic handles shared resources.
  - `reconcile_delta` — used for baseline verbs (`setup-*`,
    `set-*`) per §15's baseline exception. The reverse is to
    reconcile the Node back to its declared intent set with the
    original intent removed.
  - `reconcile_full` — reserved for the case where the original
    commit was itself a full `Reconcile`; the reverse is the
    `Reconcile` against the prior intent snapshot. This requires
    that newtcon-server captured the prior snapshot at commit
    time; see `scope_unrevertable` below.
- `per_target[*].reverses` is the typed **Reverses** object defined
  in §POST /api/preview. The relationship between Reverses and
  the existing per-target revert fields:
  - `original_intent_handle` is the Workbench batch handle; it
    points back into the staging batch. `reverses.originating_intents[*].intent_id`
    is the newtron-side intent record(s) the reverse undoes —
    typically one per `original_intent_handle`, but
    `reconcile_*`-strategy reverses may map one batch handle to
    many originating intent records.
  - `reverse_strategy` is duplicated at the top level (legacy)
    and inside `reverses.reverse_strategy`; both MUST carry the
    same value. The top-level field is retained because it
    appears on the `revert/preview` response shape without
    requiring consumers to populate the nested Reverses block in
    isolation; future Contract PRs may deprecate the duplication
    after consumers migrate.
  - `reverses.inverse_of_inverse.stage_via` points to
    `/api/workbench/stage` (the operator's redo path is to
    re-stage the forward verb into a new Workbench batch); the
    body sketch is populated from the original intent's
    `user_params` so the operator can copy-edit-paste to
    re-apply.
- `per_target[*].shared_resource_handling[]` enumerates every
  shared resource the reverse touches and the decision newtron's
  domain logic will make (preserve vs. garbage-collect). Per
  operator-philosophy invariant #1 ("no black boxes") and
  `CLAUDE.md` §Reference-Aware Removals, the operator MUST see the
  reference-count decisions before the revert runs.
- `scope_unrevertable.intent_handles[]` lists committed intents
  whose reverse cannot be synthesized (e.g., the original verb has
  no symmetric reverse AND no prior-snapshot was captured). Each
  appears in `reason_by_handle` with a substrate-grounded
  explanation. An operator who wants to reverse those intents must
  do so manually; the `manual_equivalent` field on each entry
  carries the CLI invocation.

**Errors:**
- Unknown `batch_id` → 404 `precondition_failure`.
- Batch state is not `committed` → 409 `precondition_failure`. A
  batch must be committed before it can be reverted.
- `scope == "per_target_handles"` with `intent_handles[]` referring
  to non-committed intents → 400 `validation_failure` with
  `details.invalid_handles[]`.
- newtron-server unreachable for any target Node → 503
  `newtron_unavailable` per the typed schema in §Error Schema.
  `details.affected_nodes[]` lists the unreachable Nodes.

### `POST /api/workbench/{batch_id}/revert`

Execute a previously-rendered revert preview. Same per-Node atomicity
semantics as commit. The batch transitions to `reverted` on
`all_reverted`; on partial revert, the batch remains `committed` with
the per-target `commit_result.status` updated to `reverted` for the
reversed subset.

**Request:**
```json
{
  "preview_id": "<from /revert/preview>",
  "stop_on_first_failure": true
}
```

`stop_on_first_failure` has the same semantics as on commit.

**Response 200:**
```json
{
  "batch_id": "<echoed>",
  "reverted_at": "2026-05-25T14:21:00Z",
  "per_target": [
    {
      "original_intent_handle": "<opaque>",
      "original_verb": "ApplyService",
      "reverse_verb": "RemoveService",
      "node": "switch1",
      "interface": "Ethernet0",
      "status": "reverted | failed | not_attempted",
      "operation_id": "<opaque, present when status != not_attempted>",
      "operation_url": "/api/operations/<opaque>",
      "intent_id": "<opaque, present when status == reverted>",
      "intent_url": "/api/intents/<opaque>",
      "pipeline": {
        "intent":  { "stage": "complete", "at": "2026-05-25T14:21:00Z" },
        "replay":  { "stage": "complete", "at": "2026-05-25T14:21:00Z" },
        "render":  { "stage": "complete", "at": "2026-05-25T14:21:01Z" },
        "deliver": { "stage": "complete", "at": "2026-05-25T14:21:02Z" }
      },
      "verify": {
        "kind": "device_io_assertion",
        "state": "in_progress",
        "started_at": "2026-05-25T14:21:02Z"
      },
      "reverse_intent_record": {
        "key": "remove-service|Ethernet0",
        "fields": { /* NEWTRON_INTENT record for the reverse op */ }
      },
      "shared_resources_garbage_collected": ["ACL_TABLE|PROTECT_RE_IN_1ED5F2C7"],
      "shared_resources_preserved": ["VRF|CUSTOMER"],
      "failure": null
    }
  ],
  "per_node_results": [
    {
      "node": "switch1",
      "status": "reverted",
      "atomicity": "atomic_via_txpipeline",
      "intent_count": 1,
      "operation_ids": ["<opaque>"]
    }
  ],
  "aggregate": {
    "outcome": "all_reverted | partial | none_reverted",
    "node_count_reverted": 1,
    "node_count_failed": 0,
    "node_count_not_attempted": 0,
    "verify_pending_targets": 1
  },
  "batch_state_after": "reverted | committed"
}
```

`batch_state_after` is `reverted` only when every committed intent in
the batch was reverted in this call (or in cumulative prior partial
reverts). Partial revert leaves the batch in `committed` with the
per-target `commit_result.status` reflecting reality.

`per_target[*].intent_id` and `intent_url` address the **reverse**
NEWTRON_INTENT record minted by this revert (the record whose fields
appear inline as `reverse_intent_record`), not the original forward
intent. Per `unified-pipeline-architecture.md` §1, the intent record
IS the decision substrate; per the §Identifiers rule in
[§Provenance "Identifiers and resolution"](#identifiers-and-resolution),
every shape exposing an `intent_id` MUST expose its `intent_url`
companion so the operator follows the link to
[`GET /api/intents/{intent_id}`](#get-apiintentsintent_id) without
constructing paths from opaque IDs. Both are present when
`status == "reverted"` (the reverse intent was actually written);
omitted when `status == "failed"` or `"not_attempted"` (no reverse
intent record exists to address).

Failure semantics, pipeline shapes, and error responses mirror
`/commit` field-for-field. The `per_target[*].failure` object has
the same shape.

### `POST /api/workbench/{batch_id}/stash/preview`

Preview the consequences of stashing the batch. **No newtron
interaction** and no newtron-side state mutation. Mandatory before
`/stash` per `CLAUDE.md` §Preview Before Commit, Always.

Stashing produces no ChangeSet (no device action) but does mutate the
operator-visible state of the Workbench: the batch is removed from
the active list and placed in the stash collection, where it remains
recoverable until the stash retention window expires. The preview
surfaces that consequence in structured form, matching the dismiss
preview pattern used by the Inbox.

**Request:**
```json
{
  "note": "<operator-supplied free text, may be empty>"
}
```

**Response 200:**
```json
{
  "preview_id": "<opaque, valid for 5 minutes>",
  "batch_id": "<echoed>",
  "consequence": {
    "active_visibility": "hidden",
    "stash_visibility": "listed via GET /api/workbench/stashes",
    "retention_window": "P30D",
    "retention_expires_at": "2026-06-24T14:22:00Z",
    "recoverable_until": "2026-06-24T14:22:00Z",
    "no_device_action": true,
    "no_changeset": true,
    "current_state_snapshot": {
      "state": "drafting | previewed",
      "intent_count": 4,
      "node_count": 2
    }
  }
}
```

`retention_window` is a server-side default exposed in the contract
so the operator sees it before stashing. Operators who need a
different retention window for a particular batch raise a Contract PR
to introduce a per-stash retention parameter; v0 has one window.

**Errors:**
- Unknown `batch_id` → 404 `precondition_failure`.
- Batch state is `committed` or `reverted` → 409
  `precondition_failure`. Stash is for in-progress work; terminal
  states are not stashable. (Operators who want to retain a
  committed batch as a reference object use the Provenance surface
  for that; see `intent_url`.)

### `POST /api/workbench/{batch_id}/stash`

Apply a previously-generated stash preview. Records the batch in the
stash collection; the batch is no longer addressable as an active
batch. The returned `stash_id` is the handle the operator uses to
inspect or restore.

**Request:**
```json
{ "preview_id": "<from /stash/preview>" }
```

**Response 200:**
```json
{
  "batch_id": "<echoed>",
  "stash_id": "<opaque>",
  "stashed_at": "2026-05-25T14:22:00Z",
  "retention_expires_at": "2026-06-24T14:22:00Z",
  "note": "<from preview>"
}
```

Stale or already-consumed `preview_id` → 410 Gone with
`kind: "precondition_failure"`.

### `GET /api/workbench/stashes`

List stashed batches. Idempotent; safe to poll.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `cursor` | string (opaque) | unset | Pagination cursor. |
| `limit` | int | `50` | Page size (max 200). |

**Response 200:**
```json
{
  "as_of": "2026-05-25T14:23:00Z",
  "stashes": [
    {
      "stash_id": "<opaque>",
      "batch_id": "<opaque, original batch ID>",
      "label": "<operator-supplied at stage time>",
      "note": "<operator-supplied at stash time>",
      "stashed_at": "2026-05-25T14:22:00Z",
      "retention_expires_at": "2026-06-24T14:22:00Z",
      "intent_count": 4,
      "node_count": 2,
      "had_state_at_stash": "drafting | previewed",
      "summary": {
        "verbs": ["ApplyService", "CreateVLAN"],
        "nodes": ["switch1", "switch2"]
      }
    }
  ],
  "next_cursor": null
}
```

`had_state_at_stash` is preserved so that a restored batch returns to
its prior working state, not unconditionally to `drafting`.

### `GET /api/workbench/stashes/{stash_id}`

Return the full content of a stashed batch — same shape as `GET
/api/workbench/{batch_id}`, with `state: "stashed"` and an additional
`stash` block carrying stash metadata. Idempotent.

**Response 200:**
```json
{
  "batch_id": "<opaque>",
  "label": "<echoed>",
  "state": "stashed",
  "stash": {
    "stash_id": "<opaque>",
    "stashed_at": "2026-05-25T14:22:00Z",
    "retention_expires_at": "2026-06-24T14:22:00Z",
    "note": "<from stash time>",
    "had_state_at_stash": "previewed"
  },
  "intent_count": 4,
  "node_count": 2,
  "per_node_atomicity": [ /* same shape as GET /api/workbench/{batch_id} */ ],
  "cross_node_atomicity": { /* same shape */ },
  "intents": [ /* same shape as GET /api/workbench/{batch_id}.intents */ ],
  "latest_preview_id": null,
  "latest_dry_run_at": "2026-05-25T14:12:30Z"
}
```

`latest_preview_id` is always `null` for a stashed batch — preview
IDs do not survive stash. A restored batch must re-run dry-run /
commit-preview before commit. This is deliberate: a stash is a long-
lived object; the live state of newtron and the network may have
changed since stash, and the commit-preview's freshness is a
load-bearing property (per operator-philosophy invariant #9).

**Errors:**
- Unknown `stash_id` → 404 `precondition_failure` with
  `details.reason: "stash_unknown_or_expired"`.

### `POST /api/workbench/stashes/{stash_id}/restore/preview`

Preview the consequences of restoring a stashed batch to active
state. **No newtron interaction.** Mandatory before `/restore` per
`CLAUDE.md` §Preview Before Commit, Always.

Restore produces no ChangeSet (no device action) but does mutate
operator-visible state: the batch returns to the active list and is
again addressable as `/api/workbench/{batch_id}`. The preview
surfaces that consequence and flags whether the stash is still
internally consistent against the current spec set (a stash whose
referenced services or nodes have since been deleted is restorable
but will fail validation on the next dry-run).

**Request:**
```json
{}
```

**Response 200:**
```json
{
  "preview_id": "<opaque, valid for 5 minutes>",
  "stash_id": "<echoed>",
  "batch_id": "<the active batch_id the restore will produce>",
  "consequence": {
    "active_visibility": "listed",
    "stash_visibility": "removed",
    "restored_to_state": "drafting | previewed",
    "no_device_action": true,
    "no_changeset": true
  },
  "spec_consistency": {
    "all_targets_still_valid": true,
    "invalid_targets": [],
    "missing_services": [],
    "rationale": "all 2 nodes and all 4 intents reference current specs"
  }
}
```

`spec_consistency.all_targets_still_valid: false` is not a block on
restore — it is an operator-facing warning. The operator can still
restore and then amend the batch (drop or edit the invalid intents).
`invalid_targets[]` and `missing_services[]` carry the
substrate-level reasons (e.g., "node switch3 no longer in topology",
"service legacy-l3 removed from spec directory").

**Errors:**
- Unknown `stash_id` → 404 `precondition_failure`.
- Stash retention has expired → 410 Gone with
  `kind: "precondition_failure"` and `details.expired_at`.

### `POST /api/workbench/stashes/{stash_id}/restore`

Apply a previously-generated restore preview. The batch reappears in
the active list under its original `batch_id`, in the state recorded
in `had_state_at_stash`. The stash record is removed.

**Request:**
```json
{ "preview_id": "<from /restore/preview>" }
```

**Response 200:**
```json
{
  "stash_id": "<echoed>",
  "batch_id": "<the restored batch_id>",
  "restored_at": "2026-05-25T14:24:00Z",
  "restored_to_state": "previewed"
}
```

The active batch can now be addressed via `GET
/api/workbench/{batch_id}` for the full detail.

Stale or already-consumed `preview_id` → 410 Gone with
`kind: "precondition_failure"`.

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

Every substrate-operation event in this contract's streaming surface
(`per_write[*].cli_command`, see
[§Streaming substrate-operation events](#streaming-substrate-operation-events))
already carries the literal `ssh <device>` + `redis-cli` /
`redis-del` / `redis-hgetall` command that reproduces THAT
substrate-operation by hand. That per-substrate-op annotation is the
"this is the device-level command equivalent to THIS specific write"
teaching, surfaced inline at the moment the operation executes.

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
      "kind": "newtcon_surface",
      "name": "Composer apply for service transit",
      "endpoint": "/api/preview",
      "rationale": "newtron-mediated path: stage the service via Composer; the apply produces the NEWTRON_INTENT record and renders the BGP_NEIGHBOR / INTERFACE / etc. ChangeSet."
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
      "kind": "newtcon_surface",
      "name": "Composer remove-service",
      "endpoint": "/api/preview",
      "rationale": "newtron-mediated path: when the entry IS owned by an intent, the substrate-faithful removal is remove-service through Composer. Use this scenario only when no intent claims the entry."
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
| `intent_id` | Service Composer apply, Workbench commit, Inbox action — every place a NEWTRON_INTENT record is written | `(network, node, resource_key)` — the addressing tuple newtron uses for an intent record |
| `operation_id` | Every state-changing endpoint (apply, commit, inbox action) | `(network, node, operation_sequence)` — the addressing tuple newtcon-server uses for an operation trace |
| `changeset_id` | Per `operation_id`, one or more `changeset_id`s — one per per-Node bundle the operation rendered | `(operation_id, per_node_sequence)` |

The structure of an ID is an implementation concern of
newtcon-server; consumers MUST treat all IDs as opaque. The mapping
table above is documentation of provenance, not a wire contract.

`intent_id`, `operation_id`, and `changeset_id` are surfaced as link
fields throughout the rest of the contract (`intent_url` on
Workbench commit results, `operation_url` on apply/inbox/commit
responses, etc.). Provenance endpoints are the targets of those
links. Every shape that exposes one of these IDs MUST also expose
its `*_url` companion so the UI follows-the-link without
constructing paths from opaque IDs (the contract owns URL
construction).

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
    "surface": "composer | inbox | workbench | provisioning",
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
    "deeply_inspectable_via": "/api/workbench/stage with the symmetric reverse verb, then /api/workbench/{batch_id}/dry_run",
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
    directly invoked a verb (Composer apply, Inbox action,
    Workbench commit). `operation_url` points to the operation
    trace.
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
  the intent would do, plus a deep-inspect link to the Workbench
  surface that lets the operator stage the symmetric reverse and
  see the full ChangeSet. The summary is a hint; the substrate is
  in the linked Workbench dry-run, not in the summary itself
  (operator-philosophy invariant #1: counts and summaries do not
  substitute for the substrate).
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
  Inbox surface: a Node whose underlying signal is currently
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

- **Relationship to §POST /api/preview "ChangeSet (typed)".** The
  `writes[]`, `deletes[]`, and (here, in flattened form) the
  NEWTRON_INTENT rows that the typed ChangeSet's `intent_records[]`
  carries are the same per-entry substrate the typed ChangeSet
  defines. This endpoint extends the typed shape with three
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
  "confidence": { /* Confidence object — see §POST /api/preview "Confidence (typed)" */ },
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
        "rationale": "if verify failures correspond to a drift detection signal, a delta reconcile would re-apply the missing entries; stage via Workbench",
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
      "note": "Re-runs verify against the LAST committed ChangeSet on the device, not the historical ChangeSet for this specific operation_id. The historical assertion captured by newtcon-server at this operation's apply time is the authoritative answer to the substrate question 'did this operation verify?'; the live re-verify answers a different question ('does the device's current state still match the LAST commit?'). The contract surfaces the captured assertion here; an operator who wants a live re-verify uses Workbench to stage a fresh operation."
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
  at §POST /api/inbox/{card_id}/action/preview "`manual_equivalent.newtron_http`";
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
      "description": "Walkthroughs for cross-Node Workbench commits that succeeded on some Nodes and failed on others (Workbench's per-Node atomicity model)."
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
    "Detecting drift via newtron's Inbox card. The Inbox card exists (see §Endpoints — Operator Inbox); this walkthrough is for the operator who has decided to diagnose drift without newtron's help."
  ],
  "see_also": [
    {
      "kind": "newtcon_surface",
      "name": "Operator Inbox — drift card",
      "endpoint": "/api/inbox",
      "rationale": "newtron-mediated path: read the drift card, follow the recommended action."
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

- **`newtron_mediated`** — newtcon can correlate the observed change
  to a newtcon-known operation (one of: a Composer apply, a
  Workbench commit, an Inbox action, a Provisioning operation
  reported by newtron) by matching the substrate writes the
  operation produced against the diff between the prior and current
  observation. The `operation_url` companion field is populated.
  Notably absent from this list: any "newtcon-mediated manual write"
  source. The refined invariant #2 removed that path (see
  [§Endpoints — Manual-Mode Parity (teaching surface)](#endpoints--manual-mode-parity-teaching-surface));
  operator manual writes via ssh + redis-cli are taught by newtcon
  but executed by the operator, so they appear in observation
  history as `out_of_band` (the operator was the agent; newtcon was
  not in the path).
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
  `deferred_indefinitely`) are defined canonically at §POST
  /api/inbox/{card_id}/action/preview "`manual_equivalent.newtron_http`".

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
  enum and per-shape rules defined canonically at §POST
  /api/inbox/{card_id}/action/preview), so the operator knows which
  newtron capability is currently exercised.

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
      "is_authoritative_reversal_rationale": "the undo sequence is mechanically derived from the observed diff; it reproduces the pre-change CONFIG_DB and NEWTRON_INTENT state but does NOT re-run newtron's symmetric-reverse pipeline (per DESIGN_PRINCIPLES_NEWTRON §15, the canonical reverse is the inverse operation rendered by newtron, not a mechanical undo). The mechanical undo is correct as a substrate reversal but does not produce a newtron operation trace, an intent record reversal, or a verify assertion. Operators who need the canonical reverse stage it via Workbench using the §15 symmetric-reverse verb; the undo_command_sequence is the manual-mode operator-tools alternative when newtron is unavailable.",
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
  - `newtcon_initiated_authoritative` — newtcon-server initiated
    the operation itself (Composer apply, Inbox action, Workbench
    commit). The correlation is not inferential; newtcon was the
    agent of the change and captured the operation_id at apply
    time. The observed diff is validated against the captured
    ChangeSet writes for substrate-consistency, but the
    correlation itself is authoritative — "historical changes made
    via newtcon must be maintained by newtcon" is operationalized
    at this level. Confidence: high.
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
  canonical reverse uses Workbench to stage the symmetric reverse
  verb; the undo command sequence is the operator's-own-tools
  fallback when newtcon or newtron is unavailable. The honest
  framing is part of the contract, not a footnote.
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
   the bounded values defined canonically at §POST
   /api/inbox/{card_id}/action/preview
   "`manual_equivalent.newtron_http`". For observation history,
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
| `POST /api/apply`, `POST /api/workbench/{batch_id}/commit`, `POST /api/inbox/{card_id}/action` | Execute substrate operations. Stream / return `PerWrite` entries (per §Streaming substrate-operation events). | Author bug reports. The operator sees the failure; nothing automates the diagnostic-to-report-body translation. |
| `GET /api/operations/{operation_id}` | Inspect a single operation's pipeline trace, verify assertion, terminal state. | Synthesize a bug report from that trace. The data is available to read; the operator must compose the report by hand. |
| `GET /api/intents/{intent_id}` (Provenance) | Inspect an intent record's substrate, DAG context, linked ChangeSets. | Carry call-site provenance for the failing write — that is the role of `PerWrite.source`. The upstream substrate is `deferred_indefinitely` per [newtron#12](https://github.com/aldrin-isaac/newtron/issues/12) (re-evaluation trigger documented at §Streaming substrate-operation events "`source`"); until re-evaluation, `PerWrite.source` is `null` and operators classify the call-site manually. |
| **`POST /api/report-bug/preview` / `POST /api/report-bug`** (this surface) | Collect the substrate + operation context + recent-history context + (when available) call-site, route to the correct repository, render a structured Markdown body, return for operator review, and (on confirmation) deliver the body to a configured integration target. | Auto-file the report without operator review. The operator confirms the rendered body before any external system is touched, per `CLAUDE.md` §Preview Before Commit, Always. |

The surface is read-mostly with respect to newtron substrate (it
reads from newtron via `internal/newtronc/` to populate operation
context and recent-history context); the only state-changing effect
is the production of an external artifact (a GitHub issue, or a
clipboard payload). That external mutation is exactly why the
preview/apply pairing is mandatory on this surface — the artifact's
shape and content must be operator-approved before it lands in an
external system that the operator's collaborators will see.

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
  (per §Streaming substrate-operation events). When supplied, the
  report is scoped to one substrate operation within the operation;
  when omitted, the report covers the operation as a whole.

### Vocabulary

This surface uses the existing contract vocabulary. No new types are
coined.

- `PerWrite` — defined in §Streaming substrate-operation events.
  Carries `seq`, `target`, `kind`, `substrate`, `result`,
  `cli_command`, `device_response`, `at`, `rationale_ref`,
  `source`. The Report Bug body embeds these verbatim; the report
  is substrate-canonical by construction.
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
  the failure modes the §Streaming substrate-operation events
  contract surfaces (per-write rejection, verify-assertion failure,
  drift refusal, mid-stream abort). Other failure modes (e.g.,
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
  per-target (per §Streaming substrate-operation events
  "Per-Node atomicity honesty"), so `(target, seq)` is the unique
  identifier. Supplying one without the other → 400
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
        "per_write": { /* full PerWrite shape per §Streaming substrate-operation events */ }
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
  REQUIRED. The value `"newtcon_operations_store"` names that the
  recent-operations list is derived from newtcon-server's own
  operations retention (per §Endpoints — Operations), NOT from
  newtron — newtron does not expose an operations-history endpoint
  (the survey in this PR confirms; see Considered alternatives in
  the PR body). The field names the limit
  (`recent_operations_limit`, default 10), the actually-available
  count (`recent_operations_available` — may be less than the
  limit if the operations store has not yet retained 10
  operations on this Node), and a
  `recent_operations_window_hint` reminding the operator that the
  list is bounded by newtcon's retention.
- **`call_site_provenance` section's
  `substrate.source_status`** is bounded by `available |
  deferred_indefinitely | not_captured` — the same
  three-state honest-lifecycle vocabulary the canonical
  `manual_equivalent.newtron_http.status` enum applies to
  this substrate (defined at §POST
  /api/inbox/{card_id}/action/preview
  "`manual_equivalent.newtron_http`"; see also the
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
    defined canonically at §POST
    /api/inbox/{card_id}/action/preview
    "`manual_equivalent.newtron_http`"; the consumption site for
    this specific substrate is §Streaming substrate-operation
    events "`source`". The body is still useful — the
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
  via `report_url`. This matches the pattern in
  `GET /api/inbox` vs `GET /api/inbox/{card_id}` and
  `GET /api/workbench/stashes` vs
  `GET /api/workbench/stashes/{stash_id}`.
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
   section embeds the full `PerWrite` shape per §Streaming
   substrate-operation events. The bug report does not
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
   bounded values defined canonically at §POST
   /api/inbox/{card_id}/action/preview
   "`manual_equivalent.newtron_http`". The typical answer is
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
